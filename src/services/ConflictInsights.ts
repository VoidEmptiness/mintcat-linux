/**
 * Plain-language analysis on top of ConflictService: what kind of relation two conflicting
 * mods have, what a mod loses and keeps, and what the user could do about it.
 */
import {
    AssetOutcome,
    ConflictAsset,
    ConflictPair,
    ConflictService,
    ModConflictSummary,
} from "@/services/ConflictService";

/** Areas of the game, from the asset's folder (DRG's FSD/Content layout) */
export type AssetGroup =
    | 'weapons' | 'ui' | 'gameSystems' | 'player' | 'enemies' | 'caves' | 'levelObjects'
    | 'effects' | 'sounds' | 'coreGame' | 'maps' | 'text' | 'modFiles' | 'other';

const GROUP_BY_FOLDER: Record<string, AssetGroup> = {
    weaponsntools: 'weapons',
    ui: 'ui',
    gameelements: 'gameSystems',
    character: 'player',
    characterstructure: 'player',
    enemies: 'enemies',
    critters: 'enemies',
    landscape: 'caves',
    levelelements: 'levelObjects',
    art: 'effects',
    fx: 'effects',
    particles: 'effects',
    vfx: 'effects',
    audio: 'sounds',
    wwiseaudio: 'sounds',
    game: 'coreGame',
    maps: 'maps',
    internationalization: 'text',
    localization: 'text',
};

/**
 * Which area of the game a file belongs to. `newFile`: the game doesn't have it (added by
 * mods, usually a shared library or framework).
 */
export function assetGroup(path: string, newFile = false): AssetGroup {
    const parts = path.toLowerCase().replace(/^(fsd|roguecore)\/content\//, '').split('/');
    const top = parts[0] ?? '';
    if (newFile || top.startsWith('_')) return 'modFiles';
    return GROUP_BY_FOLDER[top] ?? 'other';
}

/** Short readable name of an asset: its file name, and the folder it's in */
export function assetLabel(path: string): { name: string; folder: string } {
    const parts = path.split('/');
    return {name: parts[parts.length - 1] ?? path, folder: parts.slice(0, -1).join('/')};
}

export interface GroupCount {
    group: AssetGroup;
    count: number;
    /** A few asset names in the group */
    names: string[];
}

/** Count assets (or files) per area, biggest first */
export function groupCounts(items: { path: string; newFile?: boolean }[], names = 3): GroupCount[] {
    const map = new Map<AssetGroup, GroupCount>();
    for (const item of items) {
        const group = assetGroup(item.path, item.newFile);
        const entry = map.get(group) ?? {group, count: 0, names: []};
        entry.count++;
        if (entry.names.length < names) entry.names.push(assetLabel(item.path).name);
        map.set(group, entry);
    }
    return Array.from(map.values()).sort((a, b) => b.count - a.count);
}

/** Asset base name of a file path ("x/y.uexp" -> "x/y") */
function baseOf(file: string): string {
    return file.replace(/\.(uasset|uexp|ubulk|umap|uptnl)$/i, '');
}

/** Same as ConflictService's display path: no "fsd/content/" prefix, no extension */
function displayPath(file: string): string {
    return baseOf(file).replace(/^(fsd|roguecore)\/content\//, '');
}

/**
 * How the two mods' file sets relate
 *  - duplicate: they have exactly the same files (two copies or versions of one mod)
 *  - loserInside: every file of the losing mod is also in the winner
 *  - winnerInside: the winner only has some of the loser's files (a patch, add-on or variant)
 *  - library: all shared files are files the game doesn't have (a bundled library/framework)
 *  - partial: they overlap in some files
 */
export type PairRelation = 'duplicate' | 'loserInside' | 'winnerInside' | 'library' | 'partial';

export function pairRelation(pair: ConflictPair): PairRelation {
    const winner = ConflictService.getInfo(pair.winnerId);
    const loser = ConflictService.getInfo(pair.loserId);
    const shared = pair.fileCount;
    const winnerTotal = winner?.totalFiles ?? 0;
    const loserTotal = loser?.totalFiles ?? 0;
    if (winnerTotal > 0 && loserTotal > 0) {
        if (shared >= winnerTotal && shared >= loserTotal) return 'duplicate';
        if (shared >= loserTotal) return 'loserInside';
        if (shared >= winnerTotal) return 'winnerInside';
    }
    const checked = (winner?.gameChecked ?? false) || (loser?.gameChecked ?? false);
    if (checked && pair.assets.length > 0 && pair.assets.every(a => a.newFile)) return 'library';
    return 'partial';
}

export interface OutcomeCounts {
    identical: number;
    sameChanges: number;
    separate: number;
    clash: number;
    unknown: number;
}

export function outcomeCounts(assets: ConflictAsset[]): OutcomeCounts {
    const counts: OutcomeCounts = {identical: 0, sameChanges: 0, separate: 0, clash: 0, unknown: 0};
    for (const asset of assets) counts[asset.outcome]++;
    return counts;
}

/** Assets where the loser actually loses something */
export function lostAssets(pair: ConflictPair): ConflictAsset[] {
    return pair.assets.filter(a => a.outcome !== 'identical' && a.outcome !== 'sameChanges');
}

/**
 * The single most useful thing to tell about a pair
 *  - nothingLost: the loser's versions are identical or the winner makes the same changes
 *  - audio: one is a separate audio pak, the game decides
 *  - copies: same files, different content (two versions of the same mod)
 *  - replacedWhole: the winner has all of the loser's files
 *  - addon: the winner is a small patch/add-on/variant for the loser
 *  - combinable: they change different parts of the same files (could work together)
 *  - clash: they change the same parts differently
 *  - cosmetic: only looks/sounds are replaced
 *  - unclear: gameplay files are replaced but couldn't be compared in detail
 */
export type PairVerdict =
    | 'nothingLost' | 'audio' | 'copies' | 'replacedWhole' | 'addon' | 'combinable' | 'clash'
    | 'cosmetic' | 'unclear';

export function pairVerdict(pair: ConflictPair, relation = pairRelation(pair)): PairVerdict {
    if (pair.orderUncertain) return 'audio';
    if (pair.rating === 'harmless') return 'nothingLost';
    const lost = lostAssets(pair);
    const counts = outcomeCounts(lost);
    // What the contents say beats guesses from which files each mod has
    if (counts.unknown === 0) {
        if (counts.clash > 0) return 'clash';
        if (counts.separate > 0) return 'combinable';
    }
    if (relation === 'duplicate') return 'copies';
    if (relation === 'loserInside') return 'replacedWhole';
    if (counts.clash > 0) return 'clash';
    if (relation === 'winnerInside') return 'addon';
    if (lost.every(a => a.rating === 'cosmetic')) return 'cosmetic';
    if (counts.separate > 0) return 'combinable';
    return 'unclear';
}

/** Things the user can do about a pair, most useful first */
export type SuggestedAction =
    | {kind: 'swap'; modId: number; aboveId: number}   // move modId right above aboveId
    | {kind: 'disable'; modId: number}
    | {kind: 'reveal'; modId: number};

export function suggestedActions(pair: ConflictPair, verdict = pairVerdict(pair)): SuggestedAction[] {
    const swap: SuggestedAction = {kind: 'swap', modId: pair.loserId, aboveId: pair.winnerId};
    const disableLoser: SuggestedAction = {kind: 'disable', modId: pair.loserId};
    const disableWinner: SuggestedAction = {kind: 'disable', modId: pair.winnerId};
    switch (verdict) {
        case 'nothingLost':
            // the lower mod adds nothing the upper one doesn't have: it could go
            return pairRelation(pair) === 'duplicate' || pairRelation(pair) === 'loserInside' ? [disableLoser] : [];
        case 'audio':
            return [disableLoser, disableWinner];
        case 'copies':
            return [disableLoser, swap];
        case 'replacedWhole':
            return [disableLoser, swap];
        case 'addon':
            return [];
        case 'combinable':
        case 'clash':
        case 'cosmetic':
        case 'unclear':
            return [swap, disableLoser];
    }
}

export interface FileLoss {
    /** Display path of the asset */
    path: string;
    /** The mod whose version is used instead (highest in the list) */
    winnerId: number;
    asset: ConflictAsset | null;
    newFile: boolean;
}

/** What a mod keeps and loses, from its own side */
export interface ModEffect {
    modId: number;
    summary: ModConflictSummary;
    totalFiles: number;
    /** Files no other mod has */
    ownFiles: number;
    /** Shared files it wins (it's the highest mod that has them) */
    wonFiles: number;
    /** Shared files a mod above replaces */
    replacedFiles: number;
    /** Replaced assets where something is really lost */
    lost: FileLoss[];
    /** Replaced assets where nothing is lost (identical / same changes) */
    covered: FileLoss[];
    /** Areas of what still works (own + won files) */
    kept: GroupCount[];
    /** Areas of what is lost */
    lostGroups: GroupCount[];
    /** Mods above it that replace some of its files */
    replacedBy: number[];
    /** Mods below it whose files it replaces */
    replaces: number[];
}

/**
 * Per mod: which of its files are used and which are replaced, and by whom. A shared file
 * goes to the highest mod in the list that has it (audio-only paks aside, the game picks).
 */
export function modEffect(modId: number, order: number[]): ModEffect | null {
    const info = ConflictService.getInfo(modId);
    if (!info) return null;
    const position = new Map(order.map((id, i) => [id, i]));
    const pos = (id: number) => position.get(id) ?? Number.MAX_SAFE_INTEGER;
    const mine = pos(modId);

    // Who has each of this mod's shared files
    const owners = new Map<string, number[]>();
    for (const otherId of info.conflictingMods) {
        const other = ConflictService.getInfo(otherId);
        if (!other) continue;
        const files = new Set(other.conflictingFiles);
        for (const file of info.conflictingFiles) {
            if (files.has(file)) owners.set(file, [...(owners.get(file) ?? []), otherId]);
        }
    }

    // Pairs where this mod loses, to know each asset's outcome
    const pairs = ConflictService.getPairs(order, modId);
    const assetIn = (winnerId: number, path: string) =>
        pairs.find(p => p.winnerId === winnerId && p.loserId === modId)?.assets.find(a => a.path === path) ?? null;

    const lostByAsset = new Map<string, FileLoss>();
    const coveredByAsset = new Map<string, FileLoss>();
    const keptItems: { path: string; newFile?: boolean }[] = info.otherFiles.map(f => ({path: displayPath(f)}));
    let wonFiles = 0;
    let replacedFiles = 0;
    const replacedBy = new Set<number>();
    const replaces = new Set<number>();
    const newFiles = new Set(info.newFiles);
    const audio = ConflictService.isAudioOnly(modId);
    for (const file of info.conflictingFiles) {
        const others = (owners.get(file) ?? []).filter(id => !ConflictService.isAudioOnly(id) && !audio);
        const above = others.filter(id => pos(id) < mine).sort((a, b) => pos(a) - pos(b));
        others.filter(id => pos(id) > mine).forEach(id => replaces.add(id));
        const path = displayPath(file);
        if (above.length === 0) {
            wonFiles++;
            keptItems.push({path, newFile: newFiles.has(file)});
            continue;
        }
        replacedFiles++;
        const winnerId = above[0];
        replacedBy.add(winnerId);
        const asset = assetIn(winnerId, path);
        const loss: FileLoss = {path, winnerId, asset, newFile: newFiles.has(file)};
        const nothingLost = asset && (asset.outcome === 'identical' || asset.outcome === 'sameChanges');
        (nothingLost ? coveredByAsset : lostByAsset).set(path, loss);
    }
    // An asset counts once even with several files (.uasset + .uexp)
    const keptUnique = Array.from(new Map(keptItems.map(k => [k.path, k])).values());
    const lost = Array.from(lostByAsset.values());
    const covered = Array.from(coveredByAsset.values()).filter(c => !lostByAsset.has(c.path));
    return {
        modId,
        summary: ConflictService.summarize(modId, order),
        totalFiles: info.totalFiles,
        ownFiles: Math.max(0, info.totalFiles - info.conflictingFiles.length),
        wonFiles,
        replacedFiles,
        lost,
        covered,
        kept: groupCounts(keptUnique),
        lostGroups: groupCounts(lost),
        replacedBy: Array.from(replacedBy).sort((a, b) => pos(a) - pos(b)),
        replaces: Array.from(replaces).sort((a, b) => pos(a) - pos(b)),
    };
}

/** Mods by how badly they're affected (worst first), for the report */
export const SUMMARY_ORDER: ModConflictSummary[] = ['noEffect', 'losesGameplay', 'losesCosmetic', 'redundant', 'winsAll', 'harmless'];

/** Colors for the conflict states (row icons, legend, report) */
export const SUMMARY_COLOR: Record<ModConflictSummary, string> = {
    noEffect: '#ff4d4f',
    losesGameplay: '#fa8c16',
    losesCosmetic: '#fadb14',
    redundant: '#8c8c8c',
    winsAll: '#1677ff',
    harmless: '#52c41a',
};

export const OUTCOME_COLOR: Record<AssetOutcome, string> = {
    identical: 'green',
    sameChanges: 'green',
    separate: 'gold',
    clash: 'red',
    unknown: 'default',
};

/** Readable name for a compared part ("kind|owner|name" from the backend) */
export function partLabel(example: string): { kind: string; owner: string; name: string } {
    const [kind = '', owner = '', name = ''] = example.split('|');
    return {kind, owner, name};
}
