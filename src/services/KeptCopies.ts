/**
 * Copies MINTCAT keeps of things it replaced, so they can be looked at or deleted to free space:
 * - mod settings files an import replaced: <app data>/mod-settings-backups/<date>/...
 * - the database a restore replaced: mintcat.sqlite.bak (+ -wal/-shm) in the config folder.
 * - earlier versions of game config files edited in MINTCAT: <app data>/config-backups/...
 * Only those exact places are ever deleted here.
 */
import {join} from "@tauri-apps/api/path";
import {exists, readDir, remove, stat} from "@tauri-apps/plugin-fs";
import {replacedFilesFolder} from "@/services/ModSettingsFiles";
import {getBackupPath} from "@/apis/mintcat/cloudBackup";
import {GameConfigFiles} from "@/services/GameConfigFiles";
import {t} from "i18next";
import {logActivity} from "@/services/ActivityLog";

export interface CopiesInfo {
    /** Folder (settings copies) or file (database copy) */
    path: string;
    /** Imports with copies (settings) or 1 when there is a database copy */
    count: number;
    files: number;
    bytes: number;
}

const DB_SUFFIXES = ["", "-wal", "-shm"];

async function measure(dir: string): Promise<{ files: number; bytes: number }> {
    let files = 0;
    let bytes = 0;
    for (const entry of await readDir(dir)) {
        if (entry.isSymlink) continue;
        const path = await join(dir, entry.name);
        if (entry.isDirectory) {
            const inner = await measure(path);
            files += inner.files;
            bytes += inner.bytes;
        } else if (entry.isFile) {
            files++;
            try {
                bytes += (await stat(path)).size;
            } catch {
                // gone meanwhile
            }
        }
    }
    return {files, bytes};
}

export const KeptCopies = {
    /** Copies of mod settings files that imports replaced (one folder per import) */
    async settingsCopies(): Promise<CopiesInfo> {
        const dir = await replacedFilesFolder();
        if (!(await exists(dir))) return {path: dir, count: 0, files: 0, bytes: 0};
        const entries = await readDir(dir);
        const {files, bytes} = await measure(dir);
        return {path: dir, count: entries.filter(e => e.isDirectory && !e.isSymlink).length, files, bytes};
    },

    /** Earlier versions of edited game config files (one file per save) */
    async configCopies(): Promise<CopiesInfo> {
        const dir = await GameConfigFiles.backupsFolder();
        if (!(await exists(dir))) return {path: dir, count: 0, files: 0, bytes: 0};
        const {files, bytes} = await measure(dir);
        return {path: dir, count: files, files, bytes};
    },

    async deleteConfigCopies(): Promise<void> {
        const dir = await GameConfigFiles.backupsFolder();
        if (!dir.replace(/[\\/]+$/, "").endsWith("config-backups")) throw new Error(`unexpected folder ${dir}`);
        if (await exists(dir)) await remove(dir, {recursive: true});
        await logActivity('info', t("log.kept.deletedConfig"), dir, 'files');
    },

    async deleteSettingsCopies(): Promise<void> {
        const dir = await replacedFilesFolder();
        if (!dir.replace(/[\\/]+$/, "").endsWith("mod-settings-backups")) throw new Error(`unexpected folder ${dir}`);
        if (await exists(dir)) await remove(dir, {recursive: true});
        await logActivity('info', t("log.kept.deletedSettings"), dir, 'files');
    },

    /** The database the last restore replaced */
    async databaseCopy(): Promise<CopiesInfo> {
        const base = await getBackupPath();
        let files = 0;
        let bytes = 0;
        for (const suffix of DB_SUFFIXES) {
            const path = base + suffix;
            if (!(await exists(path))) continue;
            files++;
            try {
                bytes += (await stat(path)).size;
            } catch {
                // gone meanwhile
            }
        }
        return {path: base, count: (await exists(base)) ? 1 : 0, files, bytes};
    },

    async deleteDatabaseCopy(): Promise<void> {
        const base = await getBackupPath();
        if (!base.endsWith(".sqlite.bak")) throw new Error(`unexpected file ${base}`);
        for (const suffix of DB_SUFFIXES) {
            if (await exists(base + suffix)) await remove(base + suffix);
        }
        await logActivity('info', t("log.kept.deletedDatabase"), base, 'files');
    },
};
