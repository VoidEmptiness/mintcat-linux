/**
 * Pointing a local mod at a new file, e.g. after the .pak was moved or renamed on disk.
 */
import {exists, stat} from "@tauri-apps/plugin-fs";
import {StorageAPI} from "@/storage";
import type {CompleteModData} from "@/storage/dao/ModDAO";
import {ModSourceType} from "@/models/mod/types";
import {emitEvent} from "@/events";

export type RelocateResult =
    | { status: 'ok'; mod: CompleteModData }
    | { status: 'missing' }
    | { status: 'inUse'; otherName: string }
    | { status: 'notLocal' };

/** Folder part of a path (handles / and \) */
export function parentDir(filePath: string): string {
    const i = Math.max(filePath.lastIndexOf('/'), filePath.lastIndexOf('\\'));
    return i > 0 ? filePath.slice(0, i) : "";
}

/** File name part of a path (handles / and \) */
export function fileNameOf(filePath: string): string {
    const i = Math.max(filePath.lastIndexOf('/'), filePath.lastIndexOf('\\'));
    return i >= 0 ? filePath.slice(i + 1) : filePath;
}

function joinPath(dir: string, name: string): string {
    const sep = dir.includes('\\') && !dir.includes('/') ? '\\' : '/';
    return dir.endsWith(sep) ? dir + name : dir + sep + name;
}

/**
 * Mod ids in the active profile, i.e. the mods shown in the list. Deleting a mod from the
 * list only removes it from the profile; its record stays in the database, so checks over
 * all records must not report those. Returns null when the profile can't be read.
 */
export async function activeProfileModIds(): Promise<Set<number> | null> {
    try {
        const profiles = await StorageAPI.getProfiles();
        const active = await profiles.getActiveProfile();
        if (!active?.id) return null;
        const mods = await profiles.getProfileMods(active.id);
        return new Set(mods.map(m => m.modId!).filter(id => id != null));
    } catch (e) {
        console.warn('[LocalModRelocation] could not read the active profile', e);
        return null;
    }
}

export function localModPath(mod: CompleteModData): string {
    return mod.download?.cachePath || mod.url || "";
}

/**
 * Point a local mod at `newPath`. The mod keeps its place, folder, enabled state and
 * any custom name; a name that was just the old file name follows the new file name.
 */
export async function relocateLocalMod(mod: CompleteModData, newPath: string): Promise<RelocateResult> {
    if (mod.sourceType !== ModSourceType.Local || mod.modId == null) return {status: 'notLocal'};
    if (!await exists(newPath)) return {status: 'missing'};

    const modsApi = await StorageAPI.getMods();
    const other = await modsApi.getModByUrl(newPath);
    if (other && other.modId !== mod.modId) {
        return {status: 'inUse', otherName: other.displayName || fileNameOf(newPath)};
    }

    const oldName = fileNameOf(localModPath(mod));
    const newName = fileNameOf(newPath);
    const info = await stat(newPath);

    const changes: { url: string; displayName?: string } = {url: newPath};
    if (!mod.displayName || mod.displayName === oldName) changes.displayName = newName;
    await modsApi.updateMod(mod.modId, changes);
    await modsApi.upsertModDownload({
        modId: mod.modId,
        cachePath: newPath,
        fileSize: info.size,
        downloadProgress: 100,
    });
    await modsApi.upsertModStatus({
        modId: mod.modId,
        lastUpdateDate: info.mtime?.getTime() ?? Date.now(),
        isLocalNotFound: false,
    });

    const updated = await modsApi.getCompleteModData(mod.modId);
    if (updated) {
        await emitEvent("mod-treeview-update", {modId: mod.modId, data: updated});
    }
    return {status: 'ok', mod: updated ?? mod};
}

/**
 * Other local mods whose file is missing, used to live in `oldDir`, and whose file name
 * now exists in `newDir` — typically the rest of a folder that was moved.
 */
export async function findMovedSiblings(oldDir: string, newDir: string, excludeModId?: number)
    : Promise<{ mod: CompleteModData; newPath: string }[]> {
    if (!oldDir || !newDir || oldDir === newDir) return [];
    const modsApi = await StorageAPI.getMods();
    const all = await modsApi.getAllCompleteModData();
    const inList = await activeProfileModIds();
    const found: { mod: CompleteModData; newPath: string }[] = [];
    for (const mod of all) {
        if (mod.sourceType !== ModSourceType.Local || mod.modId == null || mod.modId === excludeModId) continue;
        if (inList && !inList.has(mod.modId)) continue;
        const current = localModPath(mod);
        if (!current || parentDir(current) !== oldDir) continue;
        if (await exists(current)) continue;
        const candidate = joinPath(newDir, fileNameOf(current));
        if (await exists(candidate)) found.push({mod, newPath: candidate});
    }
    return found;
}
