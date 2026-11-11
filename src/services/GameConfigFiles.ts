/**
 * The game's own config files (Engine.ini, Game.ini, GameUserSettings.ini, ...): find the folder
 * the game uses (under Proton its prefix, or the game folder), edit them with a copy of every
 * version kept, and mark them read-only so the game doesn't write over hand-made changes.
 *
 * Only *.ini files in those folders are written, and only when the user saves one. Copies go to
 * <app data>/config-backups/<store>/<date>/<file> (store: "prefix"/"game" for Deep Rock
 * Galactic, "<game>-prefix"/"<game>-game" for others); only that folder is ever pruned or deleted.
 */
import {invoke} from "@tauri-apps/api/core";
import {appDataDir, join} from "@tauri-apps/api/path";
import {copyFile, exists, mkdir, readDir, readFile, remove, stat, writeFile} from "@tauri-apps/plugin-fs";
import {StorageAPI} from "@/storage";
import {t} from "i18next";
import {logActivity} from "@/services/ActivityLog";

export type ConfigFolderKind = "prefix" | "game";

export interface ConfigFolder {
    kind: ConfigFolderKind;
    path: string;
    /** Where its earlier versions are kept, below config-backups */
    store: string;
    exists: boolean;
    /** Newest change of an .ini file in it, ms since 1970 (0: none) */
    newest: number;
}

export interface ConfigFile {
    name: string;
    path: string;
    exists: boolean;
    size: number;
    mtime: number;
    readonly: boolean;
}

export interface ConfigBackup {
    path: string;
    /** When it was saved aside, ms since 1970 */
    time: number;
    size: number;
}

export type TextEncoding = "utf8" | "utf8-bom" | "utf16le" | "utf16be";

export interface DecodedText {
    /** With "\n" line ends */
    text: string;
    encoding: TextEncoding;
    eol: "\r\n" | "\n";
}

/** The files the game keeps, shown even before they exist (so they can be created) */
export const STANDARD_FILES = ["Engine.ini", "Game.ini", "GameUserSettings.ini", "Input.ini", "Scalability.ini"];
/** Steam app ids, for the Proton prefix (compatdata/<id>) */
const STEAM_APP_IDS: Record<string, number> = {drg: 548430, rc: 2605790};
const KEEP_PER_FILE = 20;

// ---------------------------------------------------------------------------------------------
// Pure helpers (tested on their own)

/**
 * Where the config folder can be, from the game's main pak (…/<Project>/Content/Paks/x.pak):
 * the game folder's <Project>/Saved/Config/<platform>, and for a Steam game run with Proton
 * the same path below AppData/Local in its prefix (steamapps/compatdata/<app id>/pfx). The
 * platform folder is WindowsNoEditor for Unreal Engine 4 games (FSD-WindowsNoEditor.pak) and
 * Windows for Unreal Engine 5 ones (RogueCore-Windows.pak).
 */
export function configFolderCandidates(pakPath: string, steamAppId?: number): { kind: ConfigFolderKind; path: string }[] {
    const trimmed = pakPath.trim();
    if (!trimmed) return [];
    const windows = /^[a-zA-Z]:[\\/]/.test(trimmed) || (trimmed.includes("\\") && !trimmed.includes("/"));
    const sep = windows ? "\\" : "/";
    const parts = trimmed.split(/[\\/]+/);
    if (parts.length < 5) return [];
    const project = parts.slice(0, -3); // drop Content/Paks/<file>
    const projectName = project[project.length - 1];
    const pakName = parts[parts.length - 1];
    const platform = !/WindowsNoEditor/i.test(pakName) && /Windows/i.test(pakName) ? "Windows" : "WindowsNoEditor";
    const tail = ["Saved", "Config", platform];
    const out: { kind: ConfigFolderKind; path: string }[] = [
        {kind: "game", path: [...project, ...tail].join(sep)},
    ];
    const installRoot = project.slice(0, -1);
    const common = installRoot[installRoot.length - 2];
    if (!windows && steamAppId && common?.toLowerCase() === "common" && installRoot.length >= 3) {
        const steamapps = installRoot.slice(0, -2);
        out.unshift({
            kind: "prefix",
            path: [...steamapps, "compatdata", String(steamAppId), "pfx", "drive_c", "users", "steamuser",
                "AppData", "Local", projectName, ...tail].join(sep),
        });
    }
    return out;
}

/** Text of a config file, keeping how it was stored (BOM, UTF-16, line ends) to write it back alike */
export function decodeConfig(bytes: Uint8Array): DecodedText {
    let encoding: TextEncoding = "utf8";
    let text: string;
    if (bytes.length >= 3 && bytes[0] === 0xef && bytes[1] === 0xbb && bytes[2] === 0xbf) {
        encoding = "utf8-bom";
        text = new TextDecoder("utf-8").decode(bytes.subarray(3));
    } else if (bytes.length >= 2 && bytes[0] === 0xff && bytes[1] === 0xfe) {
        encoding = "utf16le";
        text = new TextDecoder("utf-16le").decode(bytes.subarray(2));
    } else if (bytes.length >= 2 && bytes[0] === 0xfe && bytes[1] === 0xff) {
        encoding = "utf16be";
        const swapped = new Uint8Array(bytes.length - 2);
        for (let i = 2; i + 1 < bytes.length; i += 2) {
            swapped[i - 2] = bytes[i + 1];
            swapped[i - 1] = bytes[i];
        }
        text = new TextDecoder("utf-16le").decode(swapped);
    } else {
        text = new TextDecoder("utf-8").decode(bytes);
    }
    const eol = text.includes("\r\n") ? "\r\n" : "\n";
    return {text: text.replace(/\r\n/g, "\n"), encoding, eol};
}

/** Bytes for `text` ("\n" line ends) stored the way `like` was */
export function encodeConfig(text: string, like: { encoding: TextEncoding; eol: "\r\n" | "\n" }): Uint8Array {
    const body = like.eol === "\r\n" ? text.replace(/\r?\n/g, "\r\n") : text.replace(/\r\n/g, "\n");
    if (like.encoding === "utf16le" || like.encoding === "utf16be") {
        const out = new Uint8Array(2 + body.length * 2);
        const be = like.encoding === "utf16be";
        out[0] = be ? 0xfe : 0xff;
        out[1] = be ? 0xff : 0xfe;
        for (let i = 0; i < body.length; i++) {
            const c = body.charCodeAt(i);
            out[2 + i * 2 + (be ? 1 : 0)] = c & 0xff;
            out[2 + i * 2 + (be ? 0 : 1)] = c >> 8;
        }
        return out;
    }
    const utf8 = new TextEncoder().encode(body);
    if (like.encoding === "utf8") return utf8;
    const out = new Uint8Array(utf8.length + 3);
    out.set([0xef, 0xbb, 0xbf]);
    out.set(utf8, 3);
    return out;
}

/** Sortable time stamp for a backup folder (local time, to the millisecond) */
export function backupStamp(d = new Date()): string {
    const p = (n: number, w = 2) => String(n).padStart(w, "0");
    return `${d.getFullYear()}-${p(d.getMonth() + 1)}-${p(d.getDate())}_${p(d.getHours())}-${p(d.getMinutes())}-${p(d.getSeconds())}-${p(d.getMilliseconds(), 3)}`;
}

/** The time a backup folder name stands for (0 when it isn't one) */
export function parseBackupStamp(name: string): number {
    const m = /^(\d{4})-(\d{2})-(\d{2})_(\d{2})-(\d{2})-(\d{2})-(\d{3})$/.exec(name);
    if (!m) return 0;
    const [, y, mo, d, h, mi, s, ms] = m.map(Number);
    return new Date(y, mo - 1, d, h, mi, s, ms).getTime();
}

/** The backup folder for a game's config folder (Deep Rock Galactic keeps the plain names it had first) */
export function configStore(game: string, kind: ConfigFolderKind): string {
    const id = game.toLowerCase().replace(/[^a-z0-9]+/g, "") || "drg";
    return id === "drg" ? kind : `${id}-${kind}`;
}

/** Only plain .ini file names (no folders, no path tricks) are read or written */
export function isConfigFileName(name: string): boolean {
    return /^[^\\/]+\.ini$/i.test(name) && name !== "." && name !== "..";
}

// ---------------------------------------------------------------------------------------------
// Files

async function backupsRoot(): Promise<string> {
    return await join(await appDataDir(), "config-backups");
}

export const GameConfigFiles = {
    /** Possible config folders for the active game, the one changed last first */
    async folders(): Promise<ConfigFolder[]> {
        const game = await (await StorageAPI.getGames()).getActiveGame();
        const pak = game?.installPath?.trim();
        if (!pak) return [];
        const name = (game?.name ?? "drg").toLowerCase();
        const out: ConfigFolder[] = [];
        for (const c of configFolderCandidates(pak, STEAM_APP_IDS[name])) {
            const there = await exists(c.path).catch(() => false);
            let newest = 0;
            if (there) {
                for (const f of await GameConfigFiles.files(c.path)) newest = Math.max(newest, f.exists ? f.mtime : 0);
            }
            out.push({...c, store: configStore(name, c.kind), exists: there, newest});
        }
        // the folder the game wrote to last is the one it uses
        return out.sort((a, b) => Number(b.exists) - Number(a.exists) || b.newest - a.newest);
    },

    /** The standard files (also when missing) and any other .ini in the folder */
    async files(folder: string): Promise<ConfigFile[]> {
        const names = new Set(STANDARD_FILES);
        if (await exists(folder).catch(() => false)) {
            for (const e of await readDir(folder)) {
                if (e.isFile && isConfigFileName(e.name)) names.add(e.name);
            }
        }
        const out: ConfigFile[] = [];
        for (const name of names) {
            const path = await join(folder, name);
            try {
                const info = await stat(path);
                out.push({name, path, exists: true, size: info.size, mtime: info.mtime?.getTime() ?? 0, readonly: !!info.readonly});
            } catch {
                out.push({name, path, exists: false, size: 0, mtime: 0, readonly: false});
            }
        }
        const rank = (n: string) => {
            const i = STANDARD_FILES.indexOf(n);
            return i < 0 ? STANDARD_FILES.length : i;
        };
        return out.sort((a, b) => rank(a.name) - rank(b.name) || a.name.localeCompare(b.name));
    },

    /** Size and time of a file as it is now (null: not there), to see whether something else changed it */
    async version(path: string): Promise<{ size: number; mtime: number } | null> {
        try {
            const info = await stat(path);
            return {size: info.size, mtime: info.mtime?.getTime() ?? 0};
        } catch {
            return null;
        }
    },

    async read(path: string): Promise<DecodedText> {
        if (!(await exists(path))) return {text: "", encoding: "utf8", eol: "\r\n"};
        return decodeConfig(await readFile(path));
    },

    /**
     * Save `text` to `file`, stored like `like` (the version that was opened). The file as it
     * was is copied aside first. A read-only file stays read-only (that is for the game).
     */
    async save(store: string, file: ConfigFile, text: string, like: { encoding: TextEncoding; eol: "\r\n" | "\n" }): Promise<void> {
        if (!isConfigFileName(file.name)) throw new Error(`not a config file: ${file.name}`);
        const there = await exists(file.path);
        let readonly = false;
        if (there) {
            readonly = !!(await stat(file.path)).readonly;
            const dir = await join(await backupsRoot(), store, backupStamp());
            await mkdir(dir, {recursive: true});
            await copyFile(file.path, await join(dir, file.name));
        } else {
            const folder = file.path.slice(0, file.path.length - file.name.length).replace(/[\\/]+$/, "");
            await mkdir(folder, {recursive: true});
        }
        if (readonly) await GameConfigFiles.setReadOnly(file.path, false);
        try {
            await writeFile(file.path, encodeConfig(text, like));
        } catch (error) {
            await logActivity('error', t("log.config.saveFailed", {name: file.name, reason: error instanceof Error ? error.message : String(error)}), file.path, 'config');
            throw error;
        } finally {
            if (readonly) await GameConfigFiles.setReadOnly(file.path, true);
        }
        await logActivity('success', t(there ? "log.config.saved" : "log.config.created", {name: file.name}), file.path, 'config');
        await GameConfigFiles.prune(store, file.name).catch(e => console.warn("[GameConfig] prune failed", e));
    },

    async setReadOnly(path: string, readonly: boolean, log = false): Promise<void> {
        await invoke("file_set_readonly", {path, readonly});
        if (log) await logActivity('info', t(readonly ? "log.config.locked" : "log.config.unlocked", {name: path.split(/[\\/]/).pop() ?? path}), path, 'config');
    },

    /** Earlier versions of a file, newest first */
    async backups(store: string, name: string): Promise<ConfigBackup[]> {
        const root = await join(await backupsRoot(), store);
        if (!(await exists(root))) return [];
        const out: ConfigBackup[] = [];
        for (const e of await readDir(root)) {
            const time = parseBackupStamp(e.name);
            if (!e.isDirectory || !time) continue;
            const path = await join(root, e.name, name);
            try {
                out.push({path, time, size: (await stat(path)).size});
            } catch {
                // this save was of another file
            }
        }
        return out.sort((a, b) => b.time - a.time);
    },

    /** Keep the newest copies of a file; empty backup folders go too */
    async prune(store: string, name: string): Promise<void> {
        const root = await join(await backupsRoot(), store);
        for (const old of (await GameConfigFiles.backups(store, name)).slice(KEEP_PER_FILE)) {
            await remove(old.path);
            const dir = old.path.slice(0, old.path.length - name.length).replace(/[\\/]+$/, "");
            if (dir.startsWith(root) && dir !== root && (await readDir(dir)).length === 0) await remove(dir, {recursive: true});
        }
    },

    backupsFolder: backupsRoot,
};
