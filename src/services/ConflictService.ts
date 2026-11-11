/**
 * Mod Conflict Service
 * 
 * Manages conflict detection state for mods in memory.
 * Conflicts are determined by detecting files with the same path across multiple mods.
 */

import { emitEvent } from "@/events";

/**
 * Conflict information for a single mod
 */
export interface ConflictInfo {
    /** The mod ID that has conflicts */
    modId: number;
    /** List of mod IDs that conflict with this mod */
    conflictingMods: number[];
    /** List of file paths that are in conflict */
    conflictingFiles: string[];
    /** Content fingerprint per conflicting file (equal in two mods = identical file) */
    fileHashes: Record<string, string>;
    /** All files in the mod (0 if unknown) */
    totalFiles: number;
    /** The mod's files no other mod has (always used); may be cut short for huge mods */
    otherFiles: string[];
    /** Conflicting files the game itself doesn't have (added by mods); see gameChecked */
    newFiles: string[];
    /** The game's own file list was read, so newFiles is meaningful */
    gameChecked: boolean;
}

/**
 * Backend response structure for conflict check
 */
export interface ModConflictResponse {
    mod_id: number;
    conflicting_mods: number[];
    conflicting_files: string[];
    file_hashes?: Record<string, string>;
    total_files?: number;
    other_files?: string[];
    new_files?: string[];
    game_checked?: boolean;
}

/** What one mod changes in one asset compared to the game (backend: ModAssetChanges) */
export interface ModAssetChanges {
    found: boolean;
    error?: string;
    changed: number;
    kinds: Record<string, number>;
    examples: string[];
    shallow?: boolean;
}

/** How two mods' versions of one asset relate (backend: AssetPairChanges) */
export interface AssetPairChanges {
    a: number;
    b: number;
    same: number;
    clash: number;
    onlyA: number;
    onlyB: number;
    onlyAValues: boolean;
    onlyBValues: boolean;
    clashExamples: string[];
}

/** Part-by-part comparison of one shared asset (backend: ConflictAssetSummary) */
export interface ConflictAssetSummary {
    assetPath: string;
    inGame: boolean;
    gameError?: string;
    mods: Record<string, ModAssetChanges>;
    pairs: AssetPairChanges[];
}

/** What's needed to compare an asset in detail later (see ConflictDetails' diff view) */
export interface ConflictDiffContext {
    gameName?: string;
    gamePakPath?: string;
    mods: { mod_id: number; cache_path: string; is_unpacked: boolean }[];
}

// Module-level state storage for conflict information
const conflictMap = new Map<number, ConflictInfo>();
/** Shared file → mods having it, built once per change of the results (every row asks for it) */
let fileIndexCache: Map<string, number[]> | null = null;
// Bumped on every change so components can depend on it (see useConflictVersion)
let conflictVersion = 0;
const conflictListeners = new Set<() => void>();
function bumpConflictVersion() {
    conflictVersion++;
    conflictListeners.forEach(l => l());
}

/**
 * Extra info captured by the conflict check so the UI can name mods
 */
export interface ConflictModMeta {
    name: string;
    /** Big Audio-tagged paks are copied as their own pak, so list order does not decide them */
    audioOnly: boolean;
}

const modMetaMap = new Map<number, ConflictModMeta>();
const assetSummaries = new Map<string, ConflictAssetSummary>();
let diffContext: ConflictDiffContext | null = null;

/**
 * How much a conflict matters:
 *  - harmless: both mods ship the exact same file (verified by content)
 *  - cosmetic: textures, materials, meshes, sounds, effects... only the winner's look/sound is used
 *  - gameplay: blueprints, data assets, maps, or anything unrecognized; the losing mod's
 *    changes to it are lost, so it may not work (fully or partly)
 */
export type ConflictRating = 'harmless' | 'cosmetic' | 'gameplay';

const RATING_RANK: Record<ConflictRating, number> = {harmless: 0, cosmetic: 1, gameplay: 2};

export function worseRating(a: ConflictRating, b: ConflictRating): ConflictRating {
    return RATING_RANK[a] >= RATING_RANK[b] ? a : b;
}

/**
 * Files shared by one pair of mods. `winnerId` is the mod higher in the list.
 */
export interface ConflictPair {
    winnerId: number;
    loserId: number;
    /** Shared files grouped per asset (e.g. .uasset + .uexp shown once) */
    assets: ConflictAsset[];
    /** True if either mod is installed as a separate audio pak (winner not decided by list order) */
    orderUncertain: boolean;
    /** Worst rating among the shared assets */
    rating: ConflictRating;
    /** Number of shared files (not assets) */
    fileCount: number;
}

export interface ConflictAsset {
    /** Path without the extension, minus the "fsd/content/" prefix */
    path: string;
    /** Full normalized path without the extension (key of the part-by-part comparison) */
    base: string;
    extensions: string[];
    rating: ConflictRating;
    /** What the loser loses in this asset (see AssetOutcome) */
    outcome: AssetOutcome;
    /** The game doesn't have this file: mods added it (e.g. a shared library) */
    newFile: boolean;
    /** Parts only the loser changes (lost), parts both change differently, parts both change the same */
    loserOnly?: number;
    clashes?: number;
    sameParts?: number;
    /** The loser's lost changes are all plain values (settings), not code */
    loserValuesOnly?: boolean;
    /** Names of a few clashing parts ("kind|owner|name") */
    clashExamples?: string[];
}

/**
 * What happens to the losing mod's version of one shared asset:
 *  - identical: the files are byte-for-byte the same
 *  - sameChanges: the winner's version has every change the loser makes (nothing is lost)
 *  - separate: they change different parts; the loser's changes are lost but don't clash
 *    with the winner's (both could work if the file were combined)
 *  - clash: both change the same parts differently
 *  - unknown: not compared part by part (not an asset, couldn't be read, or not checked)
 */
export type AssetOutcome = 'identical' | 'sameChanges' | 'separate' | 'clash' | 'unknown';

/** Overall state of one mod's conflicts, from that mod's side */
export type ModConflictSummary =
    | 'noEffect'       // every file it has is replaced by mods above it, and something is lost
    | 'redundant'      // every file is replaced, but the mods above do exactly what it does
    | 'losesGameplay'  // a mod above it replaces some of its gameplay files
    | 'losesCosmetic'  // a mod above it replaces only some of its looks/sounds
    | 'harmless'       // it only shares identical files (or files with the same changes)
    | 'winsAll';       // it's above every mod it shares files with

// Unreal / DRG naming conventions for assets that only affect looks or sound
const COSMETIC_PREFIXES = [
    't_', 'tx_', 'tex_', 'm_', 'mi_', 'mf_', 'mat_', 'sm_', 'sk_', 'skel_', 'phys_', 'pa_',
    'a_', 'am_', 'anim_', 'ns_', 'ps_', 'p_', 'fx_', 'vfx_', 'sc_', 'sw_', 'snd_', 'sfx_',
    'mus_', 'vo_', 'font_', 'icon_', 'img_',
];
const GAMEPLAY_PREFIXES = ['bp_', 'abp_', 'wbp_', 'id_', 'dt_', 'da_', 'gm_', 'pc_', 'gd_'];
const COSMETIC_FOLDERS = [
    'textures', 'texture', 'materials', 'material', 'meshes', 'mesh', 'audio', 'sound', 'sounds',
    'music', 'vfx', 'fx', 'particles', 'animations', 'animation', 'fonts', 'localization',
];
const COSMETIC_EXTENSIONS = ['.wem', '.bnk', '.ufont', '.locres', '.png', '.jpg', '.bk2', '.bik', '.mp4'];

/** Best guess from the asset's name and folder; unknown counts as gameplay to be safe */
export function classifyAsset(path: string, extensions: string[]): 'cosmetic' | 'gameplay' {
    const lower = path.toLowerCase();
    const parts = lower.split('/');
    const base = parts[parts.length - 1];
    if (extensions.includes('.umap')) return 'gameplay';
    if (GAMEPLAY_PREFIXES.some(prefix => base.startsWith(prefix))) return 'gameplay';
    if (extensions.length > 0 && extensions.every(ext => COSMETIC_EXTENSIONS.includes(ext))) return 'cosmetic';
    if (COSMETIC_PREFIXES.some(prefix => base.startsWith(prefix))) return 'cosmetic';
    if (parts.slice(0, -1).some(folder => COSMETIC_FOLDERS.includes(folder))) return 'cosmetic';
    return 'gameplay';
}

const ASSET_EXTENSIONS = ['.uasset', '.uexp', '.ubulk', '.umap', '.uptnl'];

function splitAsset(file: string): { base: string; ext: string } {
    for (const candidate of ASSET_EXTENSIONS) {
        if (file.endsWith(candidate)) {
            return {base: file.slice(0, -candidate.length), ext: candidate};
        }
    }
    const dot = file.lastIndexOf('.');
    const slash = file.lastIndexOf('/');
    return dot > slash ? {base: file.slice(0, dot), ext: file.slice(dot)} : {base: file, ext: ''};
}

function displayAssetPath(base: string): string {
    return base.replace(/^(fsd|roguecore)\/content\//, '');
}

/** Files that make up assets the backend can compare part by part */
function isComparableAsset(extensions: string[]): boolean {
    return extensions.includes('.uasset') || extensions.includes('.umap');
}

/**
 * What the loser loses in one asset, from the part-by-part comparison (if there is one)
 */
function assetOutcome(base: string, winnerId: number, loserId: number, allIdentical: boolean):
    Pick<ConflictAsset, 'outcome' | 'loserOnly' | 'clashes' | 'sameParts' | 'loserValuesOnly' | 'clashExamples'> {
    if (allIdentical) return {outcome: 'identical'};
    const summary = assetSummaries.get(base);
    const pair = summary?.pairs.find(p => (p.a === winnerId && p.b === loserId) || (p.a === loserId && p.b === winnerId));
    if (!summary || !pair) return {outcome: 'unknown'};
    const loserIsA = pair.a === loserId;
    const loserOnly = loserIsA ? pair.onlyA : pair.onlyB;
    const loserValuesOnly = loserIsA ? pair.onlyAValues : pair.onlyBValues;
    const outcome: AssetOutcome = pair.clash > 0 ? 'clash' : loserOnly > 0 ? 'separate' : 'sameChanges';
    return {outcome, loserOnly, clashes: pair.clash, sameParts: pair.same, loserValuesOnly, clashExamples: pair.clashExamples};
}

/**
 * Group shared files into assets and rate each one.
 * @param identical files whose content is the same in both mods
 */
function groupFilesByAsset(files: string[], identical: Set<string> | undefined, winnerId: number, loserId: number, newFiles: Set<string>): ConflictAsset[] {
    const groups = new Map<string, { exts: Set<string>; files: string[]; base: string }>();
    for (const file of files) {
        const {base, ext} = splitAsset(file);
        const display = displayAssetPath(base);
        if (!groups.has(display)) groups.set(display, {exts: new Set(), files: [], base});
        const group = groups.get(display)!;
        if (ext) group.exts.add(ext);
        group.files.push(file);
    }
    return Array.from(groups.entries())
        .map(([path, group]) => {
            const extensions = Array.from(group.exts).sort();
            const allIdentical = !!identical && group.files.every(f => identical.has(f));
            const result = assetOutcome(group.base, winnerId, loserId, allIdentical);
            const nothingLost = result.outcome === 'identical' || result.outcome === 'sameChanges';
            const rating: ConflictRating = nothingLost ? 'harmless' : classifyAsset(path, extensions);
            return {
                path, base: group.base, extensions, rating, ...result,
                newFile: group.files.every(f => newFiles.has(f)),
            };
        })
        .sort((a, b) => RATING_RANK[b.rating] - RATING_RANK[a.rating] || a.path.localeCompare(b.path));
}

/**
 * ConflictService - Static service for managing mod conflict state
 */
export class ConflictService {
    /**
     * Set conflicts from backend response
     * Converts snake_case response to camelCase and stores in memory
     */
    static setConflicts(conflicts: ModConflictResponse[], meta?: Map<number, ConflictModMeta>): void {
        const previousModIds = Array.from(conflictMap.keys());
        // Clear existing conflicts
        conflictMap.clear();
        assetSummaries.clear();
        if (meta) {
            modMetaMap.clear();
            meta.forEach((value, key) => modMetaMap.set(key, value));
        }
        
        // Store new conflicts
        for (const conflict of conflicts) {
            const info: ConflictInfo = {
                modId: conflict.mod_id,
                conflictingMods: conflict.conflicting_mods,
                conflictingFiles: conflict.conflicting_files,
                fileHashes: conflict.file_hashes ?? {},
                totalFiles: conflict.total_files ?? 0,
                otherFiles: conflict.other_files ?? [],
                newFiles: conflict.new_files ?? [],
                gameChecked: conflict.game_checked === true,
            };
            conflictMap.set(info.modId, info);
        }
        fileIndexCache = null;

        bumpConflictVersion();
        // Emit event to notify UI components about conflict updates
        // Emit for all mods that might need to update their display
        this.emitUpdateEvents();
        // Mods that no longer conflict lose their warning icon
        for (const modId of previousModIds) {
            if (!conflictMap.has(modId)) {
                emitEvent('mod-conflict-update', { modId, hasConflict: false });
            }
        }
    }
    
    /**
     * Get conflict information for a specific mod
     * @param modId The mod ID to check
     * @returns ConflictInfo if the mod has conflicts, null otherwise
     */
    static getConflict(modId: number): ConflictInfo | null {
        return conflictMap.get(modId) || null;
    }
    
    /**
     * Check if a mod has any conflicts
     * @param modId The mod ID to check
     * @returns true if the mod has conflicts with other mods
     */
    static hasConflict(modId: number): boolean {
        return conflictMap.has(modId);
    }
    
    /**
     * Get all mods that have conflicts
     * @returns Array of mod IDs that have conflicts
     */
    static getConflictingModIds(): number[] {
        return Array.from(conflictMap.keys());
    }
    
    /**
     * Get all conflict information
     * @returns Array of all ConflictInfo objects
     */
    static getAllConflicts(): ConflictInfo[] {
        return Array.from(conflictMap.values());
    }
    
    static subscribe(listener: () => void): () => void {
        conflictListeners.add(listener);
        return () => conflictListeners.delete(listener);
    }

    static version(): number {
        return conflictVersion;
    }

    static getModName(modId: number): string {
        return modMetaMap.get(modId)?.name || `#${modId}`;
    }

    static isAudioOnly(modId: number): boolean {
        return modMetaMap.get(modId)?.audioOnly === true;
    }

    /**
     * Map of file path -> every mod (in the last check) containing it, for shared files only.
     * Rebuilt from the per-mod results, which list every shared file of that mod.
     */
    private static buildFileIndex(): Map<string, number[]> {
        if (fileIndexCache) return fileIndexCache;
        const index = new Map<string, number[]>();
        for (const info of conflictMap.values()) {
            for (const file of info.conflictingFiles) {
                const list = index.get(file) ?? [];
                if (!list.includes(info.modId)) list.push(info.modId);
                index.set(file, list);
            }
        }
        fileIndexCache = index;
        return index;
    }

    /**
     * Every pair of mods sharing files. The pair's winner is whichever mod is
     * higher in the install order (top of the list wins).
     * @param order mod ids in install order (see utils/ModDisplayOrder)
     * @param onlyModId restrict to pairs involving this mod
     */
    static getPairs(order: number[], onlyModId?: number): ConflictPair[] {
        const position = new Map<number, number>();
        order.forEach((id, i) => position.set(id, i));
        const pos = (id: number) => position.get(id) ?? Number.MAX_SAFE_INTEGER;

        const pairFiles = new Map<string, { a: number; b: number; files: string[] }>();
        for (const [file, mods] of this.buildFileIndex()) {
            for (let i = 0; i < mods.length; i++) {
                for (let j = i + 1; j < mods.length; j++) {
                    const a = Math.min(mods[i], mods[j]);
                    const b = Math.max(mods[i], mods[j]);
                    if (onlyModId !== undefined && a !== onlyModId && b !== onlyModId) continue;
                    const key = `${a}:${b}`;
                    const entry = pairFiles.get(key) ?? { a, b, files: [] };
                    entry.files.push(file);
                    pairFiles.set(key, entry);
                }
            }
        }

        const pairs: ConflictPair[] = [];
        for (const { a, b, files } of pairFiles.values()) {
            const [winnerId, loserId] = pos(a) <= pos(b) ? [a, b] : [b, a];
            const hashesA = conflictMap.get(a)?.fileHashes ?? {};
            const hashesB = conflictMap.get(b)?.fileHashes ?? {};
            const identical = new Set(files.filter(f => hashesA[f] && hashesA[f] === hashesB[f]));
            const newFiles = new Set([...(conflictMap.get(a)?.newFiles ?? []), ...(conflictMap.get(b)?.newFiles ?? [])]);
            const assets = groupFilesByAsset(files, identical, winnerId, loserId, newFiles);
            pairs.push({
                winnerId,
                loserId,
                assets,
                orderUncertain: this.isAudioOnly(a) || this.isAudioOnly(b),
                rating: assets.reduce<ConflictRating>((r, asset) => worseRating(r, asset.rating), 'harmless'),
                fileCount: files.length,
            });
        }
        // Worth-worrying-about first, then by list position
        return pairs.sort((x, y) =>
            RATING_RANK[y.rating] - RATING_RANK[x.rating] ||
            pos(x.winnerId) - pos(y.winnerId) || pos(x.loserId) - pos(y.loserId)
        );
    }

    /**
     * True when every file of the mod is also in a mod above it, so none of its files are used.
     */
    static hasNoEffect(modId: number, order: number[]): boolean {
        const info = conflictMap.get(modId);
        if (!info || info.totalFiles === 0 || this.isAudioOnly(modId)) return false;
        if (info.conflictingFiles.length < info.totalFiles) return false;
        const position = new Map<number, number>();
        order.forEach((id, i) => position.set(id, i));
        const mine = position.get(modId);
        if (mine === undefined) return false;
        const index = this.buildFileIndex();
        return info.conflictingFiles.every(file =>
            (index.get(file) ?? []).some(other => other !== modId && !this.isAudioOnly(other) &&
                (position.get(other) ?? Number.MAX_SAFE_INTEGER) < mine));
    }

    /** One-word state of a mod's conflicts, from its own side */
    static summarize(modId: number, order: number[]): ModConflictSummary {
        if (this.hasNoEffect(modId, order)) {
            // Replaced entirely, but if every mod above does exactly what it does, nothing is lost
            const losing = this.getPairs(order, modId).filter(p => p.loserId === modId && !p.orderUncertain);
            return losing.length > 0 && losing.every(p => p.rating === 'harmless') ? 'redundant' : 'noEffect';
        }
        let worst: ConflictRating | null = null;
        let anyShared = false;
        for (const pair of this.getPairs(order, modId)) {
            anyShared = true;
            if (pair.loserId !== modId || pair.orderUncertain) continue;
            worst = worst ? worseRating(worst, pair.rating) : pair.rating;
        }
        if (worst === 'gameplay') return 'losesGameplay';
        if (worst === 'cosmetic') return 'losesCosmetic';
        if (worst === 'harmless') return 'harmless';
        return anyShared ? 'winsAll' : 'harmless';
    }

    /** Part-by-part comparisons of the shared assets (from the last check) */
    static setAssetSummaries(summaries: ConflictAssetSummary[]): void {
        assetSummaries.clear();
        for (const summary of summaries) assetSummaries.set(summary.assetPath, summary);
        bumpConflictVersion();
    }

    static getAssetSummary(base: string): ConflictAssetSummary | null {
        return assetSummaries.get(base) ?? null;
    }

    static hasAssetSummaries(): boolean {
        return assetSummaries.size > 0;
    }

    /** The game's own files could be read in the last check (else mods are only compared with each other) */
    static gameWasRead(): boolean {
        return Array.from(conflictMap.values()).some(info => info.gameChecked);
    }

    static setDiffContext(context: ConflictDiffContext | null): void {
        diffContext = context;
    }

    static getDiffContext(): ConflictDiffContext | null {
        return diffContext;
    }

    /** Everything the last check found about a mod (for the report) */
    static getInfo(modId: number): ConflictInfo | null {
        return conflictMap.get(modId) ?? null;
    }

    /**
     * Drop a mod from the results (it was turned off or removed), so the list and the report
     * update right away instead of waiting for the next check
     */
    static forgetMod(modId: number): void {
        if (!conflictMap.has(modId)) return;
        conflictMap.delete(modId);
        fileIndexCache = null;
        const index = this.buildFileIndex();
        for (const info of conflictMap.values()) {
            info.conflictingMods = info.conflictingMods.filter(id => id !== modId);
            info.conflictingFiles = info.conflictingFiles.filter(f => (index.get(f)?.length ?? 0) > 1);
        }
        const gone = [modId];
        for (const [id, info] of Array.from(conflictMap.entries())) {
            if (info.conflictingMods.length === 0 || info.conflictingFiles.length === 0) {
                conflictMap.delete(id);
                gone.push(id);
            }
        }
        fileIndexCache = null;
        bumpConflictVersion();
        this.emitUpdateEvents();
        for (const id of gone) emitEvent('mod-conflict-update', {modId: id, hasConflict: false});
    }

    /**
     * Clear all conflict data
     */
    static clearAll(): void {
        const previousModIds = Array.from(conflictMap.keys());
        conflictMap.clear();
        fileIndexCache = null;
        assetSummaries.clear();
        bumpConflictVersion();
        
        // Emit update events for previously conflicting mods
        for (const modId of previousModIds) {
            emitEvent('mod-conflict-update', { modId, hasConflict: false });
        }
    }
    
    /**
     * Emit update events for all mods in the conflict map
     */
    private static emitUpdateEvents(): void {
        for (const [modId, _] of conflictMap) {
            emitEvent('mod-conflict-update', { modId, hasConflict: true });
        }
    }
    
    /**
     * Get a formatted string describing conflicts for a mod
     * @param modId The mod ID to get description for
     * @returns Human-readable conflict description or empty string
     */
    static getConflictDescription(modId: number): string {
        const conflict = this.getConflict(modId);
        if (!conflict) return '';
        
        const fileCount = conflict.conflictingFiles.length;
        const modCount = conflict.conflictingMods.length;
        
        return `${fileCount} file(s) conflict with ${modCount} other mod(s)`;
    }
}
