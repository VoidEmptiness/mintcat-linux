/**
 * Files MINTCAT downloaded: the download folder (set in Settings; mod.io, Nexus and ModCat zips)
 * and Pak Hub downloads in MINTCAT's data folder. Lists them with what they're for, deletes the
 * ones asked for, and applies the "keep downloads" settings after updates and removals.
 *
 * Only MINTCAT's own files are ever deleted: in the download folder, files named like its
 * downloads ("modio-…", "nexusmods-…", "modcat-…"); Pak Hub files only inside repository-mods.
 */
import {t} from "i18next";
import {join} from "@tauri-apps/api/path";
import {exists, readDir, remove, stat} from "@tauri-apps/plugin-fs";
import {StorageAPI} from "@/storage";
import {CacheApi} from "@/apis/CacheApi";
import {ModSourceType} from "@/models/mod/types";
import {loadCompleteMods} from "@/services/ModBatchLoad";
import {logActivity} from "@/services/ActivityLog";
import {localModPath} from "@/services/LocalModRelocation";
import {
    cleanupRemovedRepositoryMod,
    deleteRepositoryFile,
    isRepositoryDownload,
    repositoryDownloadRoot,
} from "@/services/RepositoryModCleanup";
import {
    canDelete,
    catalogDownloads,
    downloadPrefix,
    type DownloadEntry,
    type DownloadFile,
    isOwnDownload,
    type KnownMod,
} from "@/services/DownloadsCatalog";

export type KeepChoice = 'keep' | 'delete';

const KEEP_OLD_KEY = 'downloads.afterUpdate';
/** Folders in the download folder with cached pictures (re-downloaded when needed) */
const IMAGE_DIRS = ["images", "avatars"];
const KEEP_REMOVED_KEY = 'downloads.afterRemove';

function normalize(path: string): string {
    return path.replace(/\\/g, "/").replace(/\/+$/, "");
}

type FileFilter = (name: string, path: string) => boolean;

async function filesIn(dir: string, recursive: boolean, filter?: FileFilter): Promise<DownloadFile[]> {
    const result: DownloadFile[] = [];
    if (!dir || !await exists(dir)) return result;
    for (const entry of await readDir(dir)) {
        if (entry.isSymlink || !entry.name) continue;
        const path = await join(dir, entry.name);
        if (entry.isDirectory) {
            if (recursive) result.push(...await filesIn(path, true, filter));
            continue;
        }
        if (!entry.isFile || (filter && !filter(entry.name, path))) continue;
        try {
            const info = await stat(path);
            result.push({path, name: entry.name, size: info.size, modifiedAt: info.mtime ? new Date(info.mtime).getTime() : 0});
        } catch {
            // gone meanwhile
        }
    }
    return result;
}

function sourceBase(mod: { platformId?: number; nameId?: string; displayName?: string }): string {
    return `modio-${mod.platformId || mod.nameId}-${mod.nameId || mod.displayName}`;
}

/** Everything the catalog needs to know about the mods MINTCAT has records of */
async function knownMods(): Promise<{ mods: KnownMod[]; pinnedNames: Set<string> }> {
    const profiles = await StorageAPI.getProfiles();
    const listed = new Set<number>();
    const pins: { modId: number; version: string }[] = [];
    for (const profile of await profiles.getAllProfiles()) {
        if (profile.id == null) continue;
        for (const m of await profiles.getProfileMods(profile.id)) {
            listed.add(m.modId);
            if (m.usedVersion) pins.push({modId: m.modId, version: m.usedVersion});
        }
    }
    let inBackups = new Set<number>();
    try {
        const {ProfileBackups} = await import("@/services/ProfileCleanup");
        inBackups = await ProfileBackups.modIds();
    } catch {
        // no backups readable
    }
    const modsDao = await StorageAPI.getMods();
    const all = await modsDao.getAllMods();
    const complete = await loadCompleteMods(all.map(m => m.modId!).filter(id => id != null));
    const byId = new Map(complete.map(m => [m.modId!, m]));
    const mods: KnownMod[] = complete.map(m => ({
        modId: m.modId!,
        name: m.displayName || m.originalName || m.nameId || "",
        sourceType: m.sourceType,
        path: m.sourceType === ModSourceType.Local ? localModPath(m) : (m.download?.cachePath || ""),
        link: m.sourceType === ModSourceType.Local ? undefined : (m.url || undefined),
        version: m.version?.currentVersion,
        listed: listed.has(m.modId!),
        inBackup: inBackups.has(m.modId!),
    }));
    const pinnedNames = new Set<string>();
    for (const pin of pins) {
        const mod = byId.get(pin.modId);
        if (!mod || mod.sourceType === ModSourceType.Local) continue;
        pinnedNames.add(CacheApi.modCacheFileName(sourceBase(mod), pin.version).toLowerCase());
    }
    return {mods, pinnedNames};
}

export interface DownloadsOverview {
    folder: string;
    pakhubFolder: string;
    entries: DownloadEntry[];
}

export const Downloads = {
    /** All downloads, or only those `filter` lets through (checked before reading their size) */
    async scan(filter?: FileFilter): Promise<DownloadsOverview> {
        const folder = await CacheApi.getCacheDir();
        const pakhubFolder = await repositoryDownloadRoot();
        const [downloads, pakhub, known] = await Promise.all([
            filesIn(folder, false, (name, path) => isOwnDownload(name) && (!filter || filter(name, path))),
            filesIn(pakhubFolder, true, filter),
            knownMods(),
        ]);
        return {
            folder,
            pakhubFolder,
            entries: catalogDownloads({downloads, pakhub, mods: known.mods, pinnedNames: known.pinnedNames}),
        };
    },

    /**
     * Delete these files (each checked again to be MINTCAT's own). A removed Pak Hub mod's
     * record and links go with its file. Returns how many were deleted and the freed bytes.
     */
    async delete(entries: DownloadEntry[]): Promise<{ deleted: number; failed: number; bytes: number }> {
        const folder = normalize(await CacheApi.getCacheDir());
        let deleted = 0, failed = 0, bytes = 0;
        for (const entry of entries) {
            if (!canDelete(entry)) continue;
            try {
                if (entry.section === 'downloads') {
                    const path = normalize(entry.path);
                    const inFolder = path.startsWith(folder + "/") && !path.slice(folder.length + 1).includes("/");
                    if (!inFolder || !isOwnDownload(entry.name)) throw new Error("not a MINTCAT download");
                    if (await exists(entry.path)) await remove(entry.path);
                } else {
                    if (!await isRepositoryDownload(entry.path)) throw new Error("not a Pak Hub download");
                    // its mod record goes too when no profile or backup has it
                    if (!(entry.modId != null && await cleanupRemovedRepositoryMod(entry.modId))) {
                        await deleteRepositoryFile(entry.path);
                    }
                }
                deleted++;
                bytes += entry.size;
            } catch (error) {
                failed++;
                console.warn('[Downloads] could not delete', entry.path, error);
            }
        }
        if (deleted > 0) {
            await logActivity('info', t("downloads.log.deleted", {count: deleted, size: formatBytes(bytes)}),
                entries.slice(0, 5).map(e => e.name).join(", ") + (entries.length > 5 ? ", …" : ""), 'files');
        }
        return {deleted, failed, bytes};
    },

    /** Thumbnails and avatars MINTCAT keeps in the download folder (shown in Browse Mods) */
    async imageCache(): Promise<{ files: number; bytes: number }> {
        const folder = await CacheApi.getCacheDir();
        let files = 0, bytes = 0;
        for (const name of IMAGE_DIRS) {
            for (const file of await filesIn(await join(folder, name), true)) {
                files++;
                bytes += file.size;
            }
        }
        return {files, bytes};
    },

    async clearImageCache(): Promise<void> {
        const folder = await CacheApi.getCacheDir();
        for (const name of IMAGE_DIRS) {
            const dir = await join(folder, name);
            if (await exists(dir)) await remove(dir, {recursive: true});
        }
        await logActivity('info', t("downloads.log.imagesCleared"), folder, 'files');
    },

    async keepOldVersions(): Promise<KeepChoice> {
        return await readChoice(KEEP_OLD_KEY);
    },

    async keepRemoved(): Promise<KeepChoice> {
        return await readChoice(KEEP_REMOVED_KEY);
    },

    async setKeepOldVersions(choice: KeepChoice): Promise<void> {
        await (await StorageAPI.getSettings()).setValue(KEEP_OLD_KEY, choice);
    },

    async setKeepRemoved(choice: KeepChoice): Promise<void> {
        await (await StorageAPI.getSettings()).setValue(KEEP_REMOVED_KEY, choice);
    },

    /**
     * A mod was updated from `oldPath` to `newPath`: with "delete old versions" on, the old
     * file goes unless a profile pinned that version.
     */
    async afterUpdate(modId: number, oldPath: string | undefined, newPath: string): Promise<void> {
        try {
            if (!oldPath || normalize(oldPath) === normalize(newPath)) return;
            if (await Downloads.keepOldVersions() === 'keep') return;
            const overview = await Downloads.scan((_name, path) => normalize(path) === normalize(oldPath));
            const old = overview.entries.find(e => e.section === 'downloads' && normalize(e.path) === normalize(oldPath));
            if (!old || old.state === 'inUse' || old.state === 'backup') return;
            await Downloads.delete([old]);
        } catch (error) {
            console.warn('[Downloads] could not tidy up after the update of', modId, error);
        }
    },

    /**
     * Mods were removed from a profile: with "delete downloads of removed mods" on, the files
     * of those no profile (or backup) has any more go.
     */
    async afterRemove(modIds: number[]): Promise<void> {
        if (modIds.length === 0) return;
        try {
            if (await Downloads.keepRemoved() === 'keep') return;
            const ids = new Set(modIds);
            // only the removed mods' files (their downloads by name, their Pak Hub files by path)
            const removed = await loadCompleteMods(modIds);
            const prefixes = new Set(removed
                .map(m => downloadPrefix((m.download?.cachePath || "").split(/[\\/]/).pop() ?? ""))
                .filter((p): p is string => !!p));
            const paths = new Set(removed.map(m => normalize(localModPath(m))).filter(Boolean));
            const overview = await Downloads.scan((name, path) =>
                paths.has(normalize(path)) || [...prefixes].some(p => name.toLowerCase().startsWith(p)));
            const gone = overview.entries.filter(e => e.modId != null && ids.has(e.modId) && e.state === 'unlisted');
            if (gone.length > 0) await Downloads.delete(gone);
        } catch (error) {
            console.warn('[Downloads] could not tidy up after removing mods', error);
        }
    },
};

async function readChoice(key: string): Promise<KeepChoice> {
    try {
        const value = await (await StorageAPI.getSettings()).getValue(key);
        return value === 'delete' ? 'delete' : 'keep';
    } catch {
        return 'keep';
    }
}

export function formatBytes(bytes: number): string {
    if (bytes < 1024) return `${bytes} B`;
    if (bytes < 1024 * 1024) return `${(bytes / 1024).toFixed(1)} KB`;
    if (bytes < 1024 * 1024 * 1024) return `${(bytes / 1024 / 1024).toFixed(1)} MB`;
    return `${(bytes / 1024 / 1024 / 1024).toFixed(2)} GB`;
}
