/**
 * Which downloaded file belongs to which mod, and whether it's still needed. No file access
 * here (see Downloads.ts), so the rules can be tested on their own.
 *
 * Download folder (mod.io, Nexus, ModCat zips), named "<source>-<id>-<name>-<version>-<hash>.zip":
 *   in use     the file a listed mod deploys from (or the version a profile pinned)
 *   older      another version of a listed mod (left over after an update)
 *   backup     the mod is only in a profile backup
 *   unlisted   the mod is in no profile (or the file's mod isn't known any more)
 *   partial    an unfinished download (.part)
 * Pak Hub downloads (MINTCAT's data folder): the files are the mods themselves, so a listed
 * one is "in use" and can't be deleted from the Downloads page.
 */

export type DownloadState = 'inUse' | 'older' | 'backup' | 'unlisted' | 'partial';
export type DownloadSection = 'downloads' | 'pakhub';

export interface KnownMod {
    modId: number;
    name: string;
    sourceType?: string;
    /** The file it deploys from (download folder) or is (Pak Hub) */
    path: string;
    /** Page to add it from again (mod.io / Nexus / ModCat link) */
    link?: string;
    version?: string;
    /** In at least one profile of any game */
    listed: boolean;
    inBackup: boolean;
}

export interface DownloadFile {
    path: string;
    name: string;
    size: number;
    modifiedAt: number;
}

export interface DownloadEntry extends DownloadFile {
    section: DownloadSection;
    state: DownloadState;
    modId?: number;
    modName?: string;
    version?: string;
    link?: string;
}

/** Our download names start like this; other files in the folder aren't MINTCAT's */
export function downloadPrefix(fileName: string): string | null {
    const name = fileName.toLowerCase();
    const match = /^(modio-[^-]+-|modcat-[^-]+-|nexusmods-[a-z0-9]+-\d+-)/.exec(name);
    return match ? match[1] : null;
}

/** A file in the download folder that MINTCAT made (a mod download or an unfinished one) */
export function isOwnDownload(fileName: string): boolean {
    const name = fileName.toLowerCase();
    if (!downloadPrefix(name)) return false;
    return name.endsWith('.zip') || name.endsWith('.zip.part') || name.endsWith('.part');
}

function normalize(path: string): string {
    return path.replace(/\\/g, '/').replace(/\/+$/, '');
}

/** The version part of a download name ("modio-1-x-1.2.0-ab12cd34ef.zip" → "1.2.0"), when it can be told */
export function versionFromName(fileName: string, mod?: KnownMod): string | undefined {
    if (mod?.version && fileName.toLowerCase().includes(`-${mod.version.toLowerCase()}-`)) return mod.version;
    const match = /-([^-]+)-[0-9a-f]{10}\.zip(\.part)?$/i.exec(fileName);
    return match?.[1];
}

export interface CatalogInput {
    downloads: DownloadFile[];
    pakhub: DownloadFile[];
    mods: KnownMod[];
    /** Download file names profiles pinned (a chosen older version), lower case */
    pinnedNames?: Set<string>;
}

export function catalogDownloads({downloads, pakhub, mods, pinnedNames = new Set()}: CatalogInput): DownloadEntry[] {
    const byPath = new Map<string, KnownMod>();
    const byPrefix = new Map<string, KnownMod[]>();
    for (const mod of mods) {
        if (!mod.path) continue;
        byPath.set(normalize(mod.path), mod);
        const prefix = downloadPrefix(mod.path.split(/[\\/]/).pop() ?? '');
        if (prefix) byPrefix.set(prefix, [...(byPrefix.get(prefix) ?? []), mod]);
    }
    const describe = (mod: KnownMod | undefined) => mod
        ? {modId: mod.modId, modName: mod.name, link: mod.link}
        : {};

    const entries: DownloadEntry[] = [];
    for (const file of downloads) {
        if (!isOwnDownload(file.name)) continue;
        const own = byPath.get(normalize(file.path));
        const prefix = downloadPrefix(file.name)!;
        // several records can share a prefix (e.g. the same mod added twice); a listed one counts
        const related = own ? [own] : (byPrefix.get(prefix) ?? []);
        const mod = related.find(m => m.listed) ?? related.find(m => m.inBackup) ?? related[0];
        let state: DownloadState;
        if (file.name.toLowerCase().endsWith('.part')) state = 'partial';
        else if (!mod) state = 'unlisted';
        else if (own) state = mod.listed ? 'inUse' : mod.inBackup ? 'backup' : 'unlisted';
        else if (mod.listed) state = pinnedNames.has(file.name.toLowerCase()) ? 'inUse' : 'older';
        else state = mod.inBackup ? 'backup' : 'unlisted';
        entries.push({
            ...file, section: 'downloads', state, ...describe(mod),
            version: versionFromName(file.name, own ?? undefined),
        });
    }
    for (const file of pakhub) {
        const mod = byPath.get(normalize(file.path));
        const state: DownloadState = !mod ? 'unlisted' : mod.listed ? 'inUse' : mod.inBackup ? 'backup' : 'unlisted';
        entries.push({...file, section: 'pakhub', state, ...describe(mod)});
    }
    return entries;
}

/** Files that can go without losing anything in use: older versions, removed mods, unfinished downloads */
export function isUnused(entry: DownloadEntry): boolean {
    return entry.state === 'older' || entry.state === 'unlisted' || entry.state === 'partial';
}

/** Pak Hub files of listed mods (or kept for a profile backup) are the mods themselves */
export function canDelete(entry: DownloadEntry): boolean {
    return entry.section === 'downloads' || entry.state === 'unlisted';
}
