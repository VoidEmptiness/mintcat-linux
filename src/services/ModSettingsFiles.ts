/**
 * Mod settings files: what mods save in the game's FSD/Saved/SaveGames folder (their options,
 * presets, …). They can be exported to a zip and imported from a zip or a folder; an import is
 * previewed file by file, the files it replaces are copied aside first, and the game's own
 * progress save (<SteamID>_Player.sav and its backups) is never exported or replaced.
 */
import {invoke} from "@tauri-apps/api/core";
import {appDataDir, dirname, join} from "@tauri-apps/api/path";
import {copyFile, exists, mkdir, readDir, stat} from "@tauri-apps/plugin-fs";
import {StorageAPI} from "@/storage";
import {t} from "i18next";
import {logActivity, nameList} from "@/services/ActivityLog";

export interface SettingsFile {
    /** Path below SaveGames, forward slashes */
    rel: string;
    size: number;
    /** Last modified, ms since 1970 (0 when unknown) */
    mtime: number;
}

export interface LocalSettingsFile extends SettingsFile {
    path: string;
}

export type ImportStatus = "new" | "same" | "newer" | "older" | "changed" | "protected";

export interface ImportItem {
    rel: string;
    incoming: SettingsFile;
    existing?: LocalSettingsFile;
    status: ImportStatus;
}

/** Where an import comes from: a zip (entries under a prefix) or a folder */
export type ImportSource =
    | { kind: "zip"; path: string; prefix: string; files: SettingsFile[] }
    | { kind: "folder"; path: string; files: (SettingsFile & { path: string })[] };

const MAX_DEPTH = 5;
const MAX_FILES = 5000;
export const SETTINGS_ZIP_PREFIX = "SaveGames/";

/** The game's own progress saves: never exported, imported or replaced */
export function isProtectedSave(rel: string): boolean {
    const name = rel.split("/").pop() ?? rel;
    // <SteamID>_Player.sav, its backups (…_Player.sav.bak, …_Player_Backup.sav) and anything
    // else named after a Steam ID; mod files such as MyMod_PlayerHUD.sav are not caught
    return /_player(?![a-z])/i.test(name) || /^player(?![a-z])/i.test(name) || /^\d{15,20}[_.]/.test(name);
}

/** <DRG>/FSD/Saved/SaveGames, from the game path MINTCAT knows (…/FSD/Content/Paks/FSD-*.pak) */
export async function settingsFolder(): Promise<string | undefined> {
    const game = await (await StorageAPI.getGames()).getActiveGame();
    const pak = game?.installPath?.trim();
    if (!pak) return undefined;
    const fsd = await dirname(await dirname(await dirname(pak)));
    return await join(fsd, "Saved", "SaveGames");
}

/** Every file in a folder (a few levels deep), with sizes and dates */
export async function listFolder(root: string): Promise<LocalSettingsFile[]> {
    const out: LocalSettingsFile[] = [];
    if (!(await exists(root))) return out;
    const walk = async (dir: string, rel: string, depth: number) => {
        if (depth > MAX_DEPTH || out.length >= MAX_FILES) return;
        for (const entry of await readDir(dir)) {
            const path = await join(dir, entry.name);
            const childRel = rel ? `${rel}/${entry.name}` : entry.name;
            if (entry.isDirectory) {
                await walk(path, childRel, depth + 1);
            } else if (entry.isFile) {
                try {
                    const info = await stat(path);
                    out.push({rel: childRel, path, size: info.size, mtime: info.mtime?.getTime() ?? 0});
                } catch {
                    // unreadable: skip
                }
            }
        }
    };
    await walk(root, "", 0);
    return out.sort((a, b) => a.rel.localeCompare(b.rel));
}

interface ZipItem {
    name: string;
    size: number;
    isDir: boolean;
}

interface SettingsManifest {
    kind?: string;
    /** Mod settings export */
    files?: SettingsFile[];
    /** Full MINTCAT backup */
    modSettings?: SettingsFile[];
}

/** Reads a zip made by MINTCAT (mod settings export or full backup) or any zip of SaveGames files */
export async function readZipSource(path: string): Promise<ImportSource> {
    const items = (await invoke<ZipItem[]>("zip_list", {path})).filter(i => !i.isDir);
    let manifest: SettingsManifest = {};
    try {
        manifest = JSON.parse(await invoke<string>("zip_read_text", {path, name: "manifest.json"}));
    } catch {
        // a zip without a manifest: dates unknown
    }
    // MINTCAT backups keep settings under mod-settings/SaveGames/, exports under SaveGames/
    const prefixes = ["mod-settings/" + SETTINGS_ZIP_PREFIX, SETTINGS_ZIP_PREFIX, ""];
    const prefix = prefixes.find(p => p === "" || items.some(i => i.name.startsWith(p))) ?? "";
    const dates = new Map((manifest.files ?? manifest.modSettings ?? []).map(f => [f.rel, f.mtime]));
    const files = items
        .filter(i => i.name.startsWith(prefix) && i.name !== "manifest.json")
        .map(i => {
            const rel = i.name.slice(prefix.length);
            return {rel, size: i.size, mtime: dates.get(rel) ?? 0};
        })
        .filter(f => f.rel && !(prefix === "" && /^(mintcat|local-mods)\//.test(f.rel)));
    return {kind: "zip", path, prefix, files};
}

export async function readFolderSource(path: string): Promise<ImportSource> {
    // A game folder, an FSD/Saved folder or a SaveGames folder: use the SaveGames part
    for (const sub of [["FSD", "Saved", "SaveGames"], ["Saved", "SaveGames"], ["SaveGames"]]) {
        const candidate = await join(path, ...sub);
        if (await exists(candidate)) {
            path = candidate;
            break;
        }
    }
    return {kind: "folder", path, files: await listFolder(path)};
}

/** Compare what would be imported with what is there now */
export function planImport(source: ImportSource, local: LocalSettingsFile[]): ImportItem[] {
    const byRel = new Map(local.map(f => [f.rel.toLowerCase(), f]));
    return source.files.map(incoming => {
        const existing = byRel.get(incoming.rel.toLowerCase());
        let status: ImportStatus;
        if (isProtectedSave(incoming.rel)) status = "protected";
        else if (!existing) status = "new";
        else if (existing.size === incoming.size && (!incoming.mtime || !existing.mtime
            || Math.abs(existing.mtime - incoming.mtime) < 2000)) status = "same";
        else if (incoming.mtime && existing.mtime) status = incoming.mtime > existing.mtime ? "newer" : "older";
        else status = "changed";
        return {rel: incoming.rel, incoming, existing, status};
    }).sort((a, b) => a.rel.localeCompare(b.rel));
}

/**
 * Files that an import picks by default: new ones and newer ones. "Different" files whose dates
 * can't be compared are left for the user to tick, so an old copy never silently wins.
 */
export function defaultSelection(items: ImportItem[]): string[] {
    return items.filter(i => i.status === "new" || i.status === "newer").map(i => i.rel);
}

function stamp(): string {
    const d = new Date();
    const p = (n: number) => String(n).padStart(2, "0");
    return `${d.getFullYear()}-${p(d.getMonth() + 1)}-${p(d.getDate())}_${p(d.getHours())}-${p(d.getMinutes())}-${p(d.getSeconds())}`;
}

/** Folder where files are copied before an import replaces them */
export async function replacedFilesFolder(): Promise<string> {
    return await join(await appDataDir(), "mod-settings-backups");
}

/**
 * Copy the chosen files into the settings folder. Files that would be replaced are copied to
 * <app data>/mod-settings-backups/<date>/ first. Returns where those copies went (if any).
 */
export async function applyImport(source: ImportSource, target: string, rels: string[]): Promise<{ count: number; savedTo?: string }> {
    const chosen = new Set(rels.filter(r => !isProtectedSave(r)));
    if (chosen.size === 0) return {count: 0};
    await mkdir(target, {recursive: true});

    let savedTo: string | undefined;
    for (const rel of chosen) {
        const dest = await join(target, ...rel.split("/"));
        if (await exists(dest)) {
            savedTo ??= await join(await replacedFilesFolder(), stamp());
            const copy = await join(savedTo, ...rel.split("/"));
            await mkdir(await dirname(copy), {recursive: true});
            await copyFile(dest, copy);
        }
    }

    const copied: { dest: string; mtime: number }[] = [];
    if (source.kind === "zip") {
        const pairs: [string, string][] = [];
        for (const file of source.files) {
            if (!chosen.has(file.rel)) continue;
            const dest = await join(target, ...file.rel.split("/"));
            pairs.push([source.prefix + file.rel, dest]);
            copied.push({dest, mtime: file.mtime});
        }
        await invoke<number>("zip_extract", {path: source.path, files: pairs});
    } else {
        for (const file of source.files) {
            if (!chosen.has(file.rel)) continue;
            const dest = await join(target, ...file.rel.split("/"));
            await mkdir(await dirname(dest), {recursive: true});
            await copyFile(file.path, dest);
            copied.push({dest, mtime: file.mtime});
        }
    }
    // Keep each file's own date, so a later import still compares newer/older correctly
    for (const {dest, mtime} of copied) {
        if (mtime > 0) await invoke("file_set_mtime", {path: dest, mtimeMs: Math.round(mtime)}).catch(() => undefined);
    }
    await logActivity('success', t("log.settings.imported", {count: chosen.size, from: source.path}), nameList([...chosen]), 'settings-files');
    if (savedTo) await logActivity('info', t("log.settings.replacedKept"), savedTo, 'settings-files');
    return {count: chosen.size, savedTo};
}

/** Export the settings files (everything but the progress saves) to a zip */
export async function exportZip(dest: string, files: LocalSettingsFile[]): Promise<number> {
    const kept = files.filter(f => !isProtectedSave(f.rel));
    const manifest = {
        kind: "mintcat-mod-settings",
        createdAt: new Date().toISOString(),
        files: kept.map(({rel, size, mtime}) => ({rel, size, mtime})),
    };
    await invoke<number>("zip_create", {
        dest,
        entries: [
            {name: "manifest.json", content: JSON.stringify(manifest, null, 1)},
            ...kept.map(f => ({name: SETTINGS_ZIP_PREFIX + f.rel, source: f.path})),
        ],
    });
    await logActivity('success', t("log.settings.exported", {count: kept.length}), dest, 'settings-files');
    return kept.length;
}
