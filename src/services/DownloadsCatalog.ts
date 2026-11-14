export type DownloadState = 'inUse' | 'older' | 'unlisted' | 'partial';

export interface KnownMod {
    modId: number;
    name: string;
    path: string;
    link?: string;
    version?: string;
    listed: boolean;
}

export interface DownloadFile {
    path: string;
    name: string;
    size: number;
    modifiedAt: number;
}

export interface DownloadEntry extends DownloadFile {
    state: DownloadState;
    modId?: number;
    modName?: string;
    version?: string;
    link?: string;
}

export function downloadPrefix(fileName: string): string | null {
    const name = fileName.toLowerCase();
    const match = /^(modio-[^-]+-|modcat-[^-]+-|nexusmods-[a-z0-9]+-\d+-)/.exec(name);
    return match ? match[1] : null;
}

export function isOwnDownload(fileName: string): boolean {
    const name = fileName.toLowerCase();
    if (!downloadPrefix(name)) return false;
    return name.endsWith('.zip') || name.endsWith('.zip.part') || name.endsWith('.part');
}

function normalize(path: string): string {
    return path.replace(/\\/g, '/').replace(/\/+$/, '');
}

export function versionFromName(fileName: string, mod?: KnownMod): string | undefined {
    if (mod?.version && fileName.toLowerCase().includes(`-${mod.version.toLowerCase()}-`)) return mod.version;
    const match = /-([^-]+)-[0-9a-f]{10}\.zip(\.part)?$/i.exec(fileName);
    return match?.[1];
}

export interface CatalogInput {
    downloads: DownloadFile[];
    mods: KnownMod[];
    pinnedVersions?: Map<number, Set<string>>;
}

export function isPinnedVersion(fileName: string, versions?: Iterable<string>): boolean {
    if (!versions) return false;
    const name = fileName.toLowerCase();
    for (const version of versions) {
        const marker = version.toLowerCase().replace(/[\\/:*?"<>|\u0000-\u001f]/g, "_");
        if (marker && name.includes(`-${marker}-`)) return true;
    }
    return false;
}

export function catalogDownloads({downloads, mods, pinnedVersions = new Map()}: CatalogInput): DownloadEntry[] {
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
        const related = own ? [own] : (byPrefix.get(prefix) ?? []);
        const mod = related.find(m => m.listed) ?? related[0];
        let state: DownloadState;
        if (file.name.toLowerCase().endsWith('.part')) state = 'partial';
        else if (!mod) state = 'unlisted';
        else if (own) state = mod.listed ? 'inUse' : 'unlisted';
        else if (mod.listed) state = isPinnedVersion(file.name, pinnedVersions.get(mod.modId)) ? 'inUse' : 'older';
        else state = 'unlisted';
        entries.push({
            ...file, state, ...describe(mod),
            version: versionFromName(file.name, own),
        });
    }
    return entries;
}

export function isUnused(entry: DownloadEntry): boolean {
    return entry.state === 'older' || entry.state === 'unlisted' || entry.state === 'partial';
}
