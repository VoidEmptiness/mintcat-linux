/**
 * Deleting a profile leaves nothing of it behind: its list and folders (the database does
 * that), its settings (install hash, "only these folders on" snapshot), its name in the record
 * of what's deployed, folder colors no other profile uses, and Pak Hub downloads no other
 * profile uses. Optionally a backup of the profile is kept first; backups are listed in the
 * profile editor, where they can be restored or deleted.
 */
import {t} from "i18next";
import {StorageAPI} from "@/storage";
import {logActivity} from "@/services/ActivityLog";
import {DeployLog} from "@/services/DeployLog";
import {Downloads} from "@/services/Downloads";
import {ModListAppearance} from "@/services/ModListAppearance";

const BACKUPS_KEY = "profiles.backups";
const FOLDER_COLOR_PREFIX = "path:";

export interface ProfileBackupFolder {
    id: number;
    parentFolderId: number | null;
    name: string;
    folderType?: string;
    sortOrder: number;
    isExpanded: boolean;
}

export interface ProfileBackupMod {
    modId: number;
    parentFolderId: number | null;
    sortOrder: number;
    isEnabled: boolean;
    usedVersion: string;
}

export interface ProfileBackup {
    id: string;
    name: string;
    /** When the backup was made (ms since 1970) */
    time: number;
    gameId: number;
    userId: number;
    folders: ProfileBackupFolder[];
    mods: ProfileBackupMod[];
}

const listeners = new Set<() => void>();
let version = 0;

function notify() {
    version++;
    listeners.forEach(l => l());
}

async function readBackups(): Promise<ProfileBackup[]> {
    try {
        const raw = await (await StorageAPI.getSettings()).getValue(BACKUPS_KEY);
        const parsed = raw ? JSON.parse(raw) : [];
        return Array.isArray(parsed) ? parsed : [];
    } catch {
        return [];
    }
}

/**
 * Backups are changed one at a time (creating one while another is restored, or a double
 * click on Restore, must not lose a backup or restore one twice)
 */
let queue: Promise<unknown> = Promise.resolve();

function oneAtATime<T>(task: () => Promise<T>): Promise<T> {
    const run = queue.then(task, task);
    queue = run.catch(() => undefined);
    return run;
}

/** Change the list as it is now (read right before writing) */
async function updateBackups(change: (list: ProfileBackup[]) => ProfileBackup[]): Promise<void> {
    const list = change(await readBackups());
    const settings = await StorageAPI.getSettings();
    if (list.length === 0) await settings.deleteValue(BACKUPS_KEY);
    else await settings.setValue(BACKUPS_KEY, JSON.stringify(list));
    notify();
}

/** Name paths ("A/B") of folders, as color keys */
function addFolderColorKeys(keys: Set<string>, folders: { id?: number | null; parentFolderId?: number | null; name: string }[]) {
    const byId = new Map(folders.map(f => [f.id, f]));
    for (const folder of folders) {
        const names: string[] = [];
        let at: typeof folder | undefined = folder;
        let guard = 0;
        while (at && guard++ < 64) {
            names.unshift(at.name);
            at = at.parentFolderId ? byId.get(at.parentFolderId) : undefined;
        }
        keys.add(FOLDER_COLOR_PREFIX + names.join("/"));
    }
}

/** Color keys of every profile's folders and of the backups' folders (restored with their colors) */
async function folderColorKeysInUse(): Promise<Set<string>> {
    const profiles = await StorageAPI.getProfiles();
    const keys = new Set<string>();
    for (const profile of await profiles.getAllProfiles()) {
        if (profile.id == null) continue;
        addFolderColorKeys(keys, await profiles.getProfileFolders(profile.id));
    }
    for (const backup of await readBackups()) addFolderColorKeys(keys, backup.folders);
    return keys;
}

/** Forget colors of folders no profile or backup has (colors under older keys are kept) */
async function pruneFolderColors(): Promise<void> {
    await ModListAppearance.keepOnlyFolderColors(await folderColorKeysInUse(), FOLDER_COLOR_PREFIX);
}

/**
 * Downloads no profile and no backup uses any more, when "Downloads of removed mods: delete"
 * is chosen (Settings → Downloads)
 */
async function cleanupUnusedMods(modIds: number[]): Promise<void> {
    await Downloads.afterRemove(modIds);
}

export const ProfileBackups = {
    subscribe(listener: () => void): () => void {
        listeners.add(listener);
        return () => listeners.delete(listener);
    },
    version: () => version,

    list: readBackups,

    /** Backups of the active game's profiles (for the profile editor) */
    async listForActiveGame(): Promise<ProfileBackup[]> {
        const list = await readBackups();
        try {
            const active = await (await StorageAPI.getProfiles()).getActiveProfile();
            if (!active) return list;
            return list.filter(b => b.gameId === active.gameId && b.userId === active.userId);
        } catch {
            return list;
        }
    },

    /** Mods any backup refers to (their records and downloads are kept) */
    async modIds(): Promise<Set<number>> {
        const ids = new Set<number>();
        for (const backup of await readBackups()) backup.mods.forEach(m => ids.add(m.modId));
        return ids;
    },

    create(profileId: number): Promise<ProfileBackup | null> {
        return oneAtATime(() => createBackup(profileId));
    },

    /**
     * Make the backup a profile again (named like it, or "name (2)" if taken). Mods whose
     * record is gone meanwhile are left out. The backup is removed once it's restored.
     * Returns the new profile's name; null when the backup is gone (e.g. restored already).
     */
    restore(id: string): Promise<{ name: string; missing: number } | null> {
        return oneAtATime(() => restoreBackup(id));
    },

    /** Delete a backup; downloads only it used go too */
    remove(id: string): Promise<void> {
        return oneAtATime(() => removeBackup(id));
    },

    /** Drop a backup's record only (the profile it was made of wasn't deleted after all) */
    discard(id: string): Promise<void> {
        return oneAtATime(() => updateBackups(list => list.filter(b => b.id !== id)));
    },
};

async function createBackup(profileId: number): Promise<ProfileBackup | null> {
        const profiles = await StorageAPI.getProfiles();
        const profile = await profiles.getProfileById(profileId);
        if (!profile?.id) return null;
        const folders = await profiles.getProfileFolders(profileId);
        const mods = await profiles.getProfileMods(profileId);
        const backup: ProfileBackup = {
            id: `${Date.now()}-${profileId}`,
            // the name shown in the editor (renaming changes only `name`)
            name: profile.name || profile.displayName,
            time: Date.now(),
            gameId: profile.gameId,
            userId: profile.userId,
            folders: folders.map(f => ({
                id: f.id!, parentFolderId: f.parentFolderId ?? null, name: f.name, folderType: f.folderType,
                sortOrder: f.sortOrder ?? 0, isExpanded: f.isExpanded ?? true,
            })),
            mods: mods.map(m => ({
                modId: m.modId, parentFolderId: m.parentFolderId ?? null, sortOrder: m.sortOrder ?? 0,
                isEnabled: m.isEnabled ?? true, usedVersion: m.usedVersion ?? "",
            })),
        };
        await updateBackups(list => [...list, backup]);
        await logActivity('info', t("log.profile.backedUp", {name: backup.name, count: backup.mods.length}), undefined, 'profile');
        return backup;
}

async function restoreBackup(id: string): Promise<{ name: string; missing: number } | null> {
        const backup = (await readBackups()).find(b => b.id === id);
        if (!backup) return null;
        const profiles = await StorageAPI.getProfiles();
        const taken = new Set((await profiles.getAllProfiles()).map(p => p.name));
        let name = backup.name;
        for (let n = 2; taken.has(name); n++) name = `${backup.name} (${n})`;
        const created = await profiles.createProfile({
            name, displayName: name, gameId: backup.gameId, userId: backup.userId, isActive: false,
        });
        if (!created?.id) return null;
        // folders first (parents fixed in a second pass), then the mods
        const idMap = new Map<number, number>();
        for (const folder of backup.folders) {
            const made = await profiles.createFolder({
                profileId: created.id, parentFolderId: null, name: folder.name,
                folderType: folder.folderType || 'custom', sortOrder: folder.sortOrder, isExpanded: folder.isExpanded,
            });
            if (made?.id) idMap.set(folder.id, made.id);
        }
        for (const folder of backup.folders) {
            const madeId = idMap.get(folder.id);
            const parentId = folder.parentFolderId != null ? idMap.get(folder.parentFolderId) : undefined;
            if (madeId && parentId) await profiles.updateFolder(madeId, {parentFolderId: parentId});
        }
        const mods = await StorageAPI.getMods();
        const rows = [];
        let missing = 0;
        for (const mod of backup.mods) {
            if (!(await mods.getModById(mod.modId))) {
                missing++;
                continue;
            }
            rows.push({
                profileId: created.id, modId: mod.modId,
                parentFolderId: mod.parentFolderId != null ? (idMap.get(mod.parentFolderId) ?? null) : null,
                sortOrder: mod.sortOrder, isEnabled: mod.isEnabled, usedVersion: mod.usedVersion,
            });
        }
        await profiles.addModsToProfile(rows);
        await updateBackups(list => list.filter(b => b.id !== id));
        await logActivity('info', t("log.profile.restored", {name, count: rows.length}), undefined, 'profile');
        return {name, missing};
}

async function removeBackup(id: string): Promise<void> {
        const backup = (await readBackups()).find(b => b.id === id);
        if (!backup) return;
        await updateBackups(list => list.filter(b => b.id !== id));
        await cleanupUnusedMods(backup.mods.map(m => m.modId));
        await pruneFolderColors();
        await logActivity('info', t("log.profile.backupDeleted", {name: backup.name}), undefined, 'profile');
}

/** Settings of a profile, by id */
function profileSettingPrefixes(profileId: number): string[] {
    return [`profile_${profileId}_`, `folders.solo.${profileId}`];
}

/**
 * After a profile was deleted: remove what's left of it. `modIds`: the mods it had (taken
 * before the delete), for the downloads no one else uses.
 */
export async function cleanupDeletedProfile(profile: { id: number; name: string; gameId?: number }, modIds: number[]): Promise<void> {
    const settings = await StorageAPI.getSettings();
    for (const prefix of profileSettingPrefixes(profile.id)) {
        for (const name of await settings.namesWithPrefix(prefix)) {
            // "folders.solo.1" must not match "folders.solo.12"
            if (prefix.endsWith("_") || name === prefix) await settings.deleteValue(name);
        }
    }
    let gameName: string | undefined;
    try {
        gameName = profile.gameId != null ? (await (await StorageAPI.getGames()).getGameById(profile.gameId))?.name : undefined;
    } catch {
        gameName = undefined;
    }
    await DeployLog.forgetProfile(profile.id, profile.name, gameName);
    await pruneFolderColors();
    await cleanupUnusedMods(modIds);
}

/** Settings left by profiles deleted with earlier versions (their ids no longer exist) */
export async function removeProfileLeftovers(): Promise<number> {
    const settings = await StorageAPI.getSettings();
    // names first: a profile made in between (and its first setting) must not look left over
    const names = [...await settings.namesWithPrefix("profile_"), ...await settings.namesWithPrefix("folders.solo.")];
    if (names.length === 0) return 0;
    const profiles = await StorageAPI.getProfiles();
    const ids = new Set((await profiles.getAllProfiles()).map(p => p.id));
    let removed = 0;
    for (const name of names) {
        const match = /^profile_(\d+)_/.exec(name) ?? /^folders\.solo\.(\d+)$/.exec(name);
        if (!match || ids.has(Number(match[1]))) continue;
        await settings.deleteValue(name);
        removed++;
    }
    if (removed > 0) console.info(`[profiles] removed ${removed} setting(s) left by deleted profiles`);
    return removed;
}
