import {t} from "i18next";
import {join} from "@tauri-apps/api/path";
import {exists, readDir, remove, stat} from "@tauri-apps/plugin-fs";
import {StorageAPI} from "@/storage";
import {CacheApi} from "@/apis/CacheApi";
import StatusBar from "@/components/StatusBar";
import {ModSourceType} from "@/models/mod/types";
import {
    catalogDownloads,
    downloadPrefix,
    type DownloadEntry,
    type DownloadFile,
    isOwnDownload,
    type KnownMod,
} from "@/services/DownloadsCatalog";

export type KeepChoice = 'keep' | 'delete';

const KEEP_OLD_KEY = 'downloads.afterUpdate';
const KEEP_REMOVED_KEY = 'downloads.afterRemove';
const IMAGE_DIRS = ["images", "avatars"];

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
        }
    }
    return result;
}

async function knownMods(): Promise<{ mods: KnownMod[]; pinnedVersions: Map<number, Set<string>> }> {
    const profiles = await StorageAPI.getProfiles();
    const listed = new Set<number>();
    const pins: { modId: number; version: string }[] = [];
    for (const profile of await profiles.getAllProfiles()) {
        if (profile.id == null) continue;
        for (const m of await profiles.getProfileMods(profile.id)) {
            listed.add(m.modId);
            if (m.usedVersion && m.usedVersion !== "-") pins.push({modId: m.modId, version: m.usedVersion});
        }
    }
    const modsDao = await StorageAPI.getMods();
    const ids = (await modsDao.getAllMods()).map(m => m.modId!).filter(id => id != null);
    const complete = await modsDao.getBatchCompleteModDataOptimized(ids);
    const byId = new Map(complete.map(m => [m.modId!, m]));
    const mods: KnownMod[] = complete.map(m => ({
        modId: m.modId!,
        name: m.displayName || m.originalName || m.nameId || "",
        path: m.sourceType === ModSourceType.Local
            ? (m.url || m.download?.cachePath || "")
            : (m.download?.cachePath || ""),
        link: m.sourceType === ModSourceType.Local ? undefined : (m.url || undefined),
        version: m.version?.currentVersion,
        listed: listed.has(m.modId!),
    }));
    const pinnedVersions = new Map<number, Set<string>>();
    for (const pin of pins) {
        const mod = byId.get(pin.modId);
        if (!mod || mod.sourceType === ModSourceType.Local) continue;
        const versions = pinnedVersions.get(pin.modId) ?? new Set<string>();
        versions.add(pin.version.toLowerCase());
        pinnedVersions.set(pin.modId, versions);
    }
    return {mods, pinnedVersions};
}

export interface DownloadsOverview {
    folder: string;
    entries: DownloadEntry[];
}

export const Downloads = {
    async scan(filter?: FileFilter): Promise<DownloadsOverview> {
        const folder = await CacheApi.getCacheDir();
        const [downloads, known] = await Promise.all([
            filesIn(folder, false, (name, path) => isOwnDownload(name) && (!filter || filter(name, path))),
            knownMods(),
        ]);
        return {
            folder,
            entries: catalogDownloads({downloads, mods: known.mods, pinnedVersions: known.pinnedVersions}),
        };
    },

    async delete(entries: DownloadEntry[]): Promise<{ deleted: number; failed: number; bytes: number }> {
        const folder = normalize(await CacheApi.getCacheDir());
        let deleted = 0, failed = 0, bytes = 0;
        for (const entry of entries) {
            try {
                const path = normalize(entry.path);
                const inFolder = path.startsWith(folder + "/") && !path.slice(folder.length + 1).includes("/");
                if (!inFolder || !isOwnDownload(entry.name)) throw new Error("not a MINTCAT download");
                if (await exists(entry.path)) await remove(entry.path);
                deleted++;
                bytes += entry.size;
            } catch (error) {
                failed++;
                console.warn('[Downloads] could not delete', entry.path, error);
            }
        }
        if (deleted > 0) {
            await StatusBar.log(t("downloads.log.deleted", {count: deleted, size: formatBytes(bytes)}), 'info');
        }
        return {deleted, failed, bytes};
    },

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
        await StatusBar.log(t("downloads.log.imagesCleared"), 'info');
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

    async afterUpdate(modId: number, oldPath: string | undefined, newPath: string): Promise<void> {
        try {
            if (!oldPath || normalize(oldPath) === normalize(newPath)) return;
            if (await Downloads.keepOldVersions() === 'keep') return;
            const overview = await Downloads.scan((_name, path) => normalize(path) === normalize(oldPath));
            const old = overview.entries.find(e => normalize(e.path) === normalize(oldPath));
            if (!old || old.state === 'inUse') return;
            await Downloads.delete([old]);
        } catch (error) {
            console.warn('[Downloads] could not tidy up after the update of', modId, error);
        }
    },

    async afterRemove(modIds: number[]): Promise<void> {
        if (modIds.length === 0) return;
        try {
            if (await Downloads.keepRemoved() === 'keep') return;
            const ids = new Set(modIds);
            const removed = await (await StorageAPI.getMods()).getBatchCompleteModDataOptimized(modIds);
            const prefixes = new Set(removed
                .map(m => downloadPrefix((m.download?.cachePath || "").split(/[\\/]/).pop() ?? ""))
                .filter((p): p is string => !!p));
            const paths = new Set(removed
                .filter(m => m.sourceType === ModSourceType.Local)
                .map(m => normalize(m.url || m.download?.cachePath || ""))
                .filter(Boolean));
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
