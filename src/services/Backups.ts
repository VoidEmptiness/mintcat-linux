/**
 * Backups to a folder (for example one that Dropbox, MEGA or Google Drive's desktop app syncs)
 * or to a cloud account through rclone (Google Drive, Dropbox, MEGA or any remote the user
 * set up in rclone). Nothing goes through MINTCAT's servers.
 *
 * A backup is one zip:
 *   manifest.json                what is inside, when it was made
 *   mintcat/mintcat.sqlite       MINTCAT's database (mod lists, profiles, folders, settings)
 *   mod-settings/SaveGames/…     settings files mods keep in the game folder (never the progress save)
 *   local-mods/<n>/<file>.pak    the local .pak files the lists use (optional)
 *
 * Only files named mintcat-backup_*.zip are listed, pruned or deleted.
 */
import {invoke} from "@tauri-apps/api/core";
import {listen} from "@tauri-apps/api/event";
import {appCacheDir, appDataDir, configDir, dirname, join} from "@tauri-apps/api/path";
import {copyFile, exists, mkdir, readDir, remove, stat} from "@tauri-apps/plugin-fs";
import {getVersion} from "@tauri-apps/api/app";
import {StorageAPI} from "@/storage";
import {t} from "i18next";
import {logActivity} from "@/services/ActivityLog";
import {initDb, snapshotDatabase} from "@/storage/db/Client";
import {ModSourceType} from "@/models/mod/types";
import {BuildInfo} from "@/buildInfo";
import {localModPath, fileNameOf} from "@/services/LocalModRelocation";
import {
    applyImport,
    isProtectedSave,
    listFolder,
    planImport,
    settingsFolder,
    type ImportItem,
    type ImportSource,
    type LocalSettingsFile,
    type SettingsFile,
} from "@/services/ModSettingsFiles";

export type BackupDestination = "folder" | "rclone";
export type AutoBackup = "off" | "daily" | "weekly";

export interface BackupConfig {
    destination: BackupDestination;
    /** Folder destination */
    folder: string;
    /** rclone remote name, without the colon */
    remote: string;
    /** Folder inside the remote */
    remotePath: string;
    includeSettings: boolean;
    includeLocalMods: boolean;
    auto: AutoBackup;
    /** How many automatic backups to keep (manual ones are never removed automatically) */
    keepAuto: number;
    lastAuto?: number;
}

export interface BackupEntry {
    name: string;
    size: number;
    /** When the backup was made (from the file name), ms */
    createdAt: number;
    auto: boolean;
    note: string;
}

export interface LocalModEntry {
    /** Name inside the zip */
    entry: string;
    /** Where the file was */
    path: string;
    name: string;
    size: number;
}

export interface BackupManifest {
    kind: "mintcat-backup";
    format: 1;
    createdAt: string;
    app: string;
    note?: string;
    auto?: boolean;
    database?: string;
    counts?: { mods?: number; profiles?: number };
    modSettings?: SettingsFile[];
    localMods?: LocalModEntry[];
}

export interface RestorePlan {
    zipPath: string;
    manifest: BackupManifest;
    hasDatabase: boolean;
    settingsTarget?: string;
    settingsSource?: ImportSource;
    settingsItems: ImportItem[];
    localMods: (LocalModEntry & { present: boolean })[];
}

const CONFIG_KEY = "backup.config";
const NAME_PATTERN = /^mintcat-backup_(\d{4})-(\d\d)-(\d\d)_(\d\d)-(\d\d)-(\d\d)(_auto)?(?:_(.+))?\.zip$/;
const DB_ENTRY = "mintcat/mintcat.sqlite";
const SETTINGS_PREFIX = "mod-settings/SaveGames/";
export const DEFAULT_REMOTE_PATH = "MINTCAT Backups";

const DEFAULT_CONFIG: BackupConfig = {
    destination: "folder",
    folder: "",
    remote: "",
    remotePath: DEFAULT_REMOTE_PATH,
    includeSettings: true,
    includeLocalMods: true,
    auto: "off",
    keepAuto: 5,
};

let config: BackupConfig = {...DEFAULT_CONFIG};
let loaded: Promise<void> | null = null;
let version = 0;
let busy = false;
const listeners = new Set<() => void>();

function notify() {
    version++;
    listeners.forEach(l => l());
}

function pad(n: number): string {
    return String(n).padStart(2, "0");
}

function stampOf(d: Date): string {
    return `${d.getFullYear()}-${pad(d.getMonth() + 1)}-${pad(d.getDate())}_${pad(d.getHours())}-${pad(d.getMinutes())}-${pad(d.getSeconds())}`;
}

function slug(note: string): string {
    const s = note.normalize("NFKD").replace(/[^\w\- ]+/g, "").trim().replace(/\s+/g, "-").slice(0, 40);
    return s.toLowerCase() === "auto" ? "auto-note" : s;
}

export function parseBackupName(name: string, size = 0): BackupEntry | null {
    const m = NAME_PATTERN.exec(name);
    if (!m) return null;
    const createdAt = new Date(+m[1], +m[2] - 1, +m[3], +m[4], +m[5], +m[6]).getTime();
    return {name, size, createdAt, auto: !!m[7], note: (m[8] ?? "").replace(/-/g, " ")};
}

function errorText(e: unknown): string {
    return e instanceof Error ? e.message : String(e);
}

// ----- rclone -----

export interface RcloneResult {
    code: number | null;
    stdout: string;
    stderr: string;
    timedOut: boolean;
}

export class RcloneMissingError extends Error {
    constructor() {
        super("rclone-not-found");
    }
}

async function rclone(args: string[], timeoutSecs = 600, runId?: string): Promise<RcloneResult> {
    try {
        return await invoke<RcloneResult>("rclone_run", {args, timeoutSecs, runId: runId ?? null});
    } catch (e) {
        if (errorText(e).includes("rclone-not-found")) throw new RcloneMissingError();
        throw e;
    }
}

function rcloneError(result: RcloneResult): Error {
    if (result.timedOut) return new Error("rclone took too long and was stopped");
    const lines = result.stderr.split("\n").map(l => l.replace(/^\d{4}\/\d\d\/\d\d \d\d:\d\d:\d\d /, "").trim()).filter(Boolean);
    const important = lines.filter(l => /error|failed|denied|not found|couldn't/i.test(l));
    return new Error((important.length ? important : lines).slice(-3).join("\n") || `rclone exited with code ${result.code}`);
}

async function rcloneOk(args: string[], timeoutSecs?: number): Promise<RcloneResult> {
    const result = await rclone(args, timeoutSecs);
    if (result.code !== 0) throw rcloneError(result);
    return result;
}

function remoteDir(cfg: BackupConfig): string {
    const path = cfg.remotePath.trim().replace(/^\/+|\/+$/g, "");
    return `${cfg.remote}:${path}`;
}

function remoteFile(cfg: BackupConfig, name: string): string {
    const dir = remoteDir(cfg);
    return dir.endsWith(":") ? dir + name : `${dir}/${name}`;
}

export interface RcloneRemote {
    name: string;
    type: string;
}

export type CloudProvider = "drive" | "dropbox" | "mega";

export const Rclone = {
    /** rclone's version line, or null when rclone isn't installed */
    async version(): Promise<string | null> {
        try {
            const result = await rclone(["version"], 20);
            return result.stdout.split("\n")[0]?.trim() || "rclone";
        } catch (e) {
            if (e instanceof RcloneMissingError) return null;
            throw e;
        }
    },

    async remotes(): Promise<RcloneRemote[]> {
        const result = await rcloneOk(["listremotes", "--long"], 30);
        return result.stdout.split("\n").map(l => l.trim()).filter(Boolean).map(line => {
            const i = line.indexOf(":");
            return {name: line.slice(0, i), type: line.slice(i + 1).trim()};
        });
    },

    /**
     * Add an account. Google Drive and Dropbox open a sign-in page (rclone waits for it and
     * prints the link, which `onLink` receives in case the browser didn't open by itself);
     * MEGA uses the email and password. Google Drive is limited to files rclone creates.
     */
    async connect(provider: CloudProvider, name: string, opts: { user?: string; pass?: string },
                  onLink: (url: string) => void, runId: string): Promise<void> {
        const args = ["config", "create", name];
        if (provider === "drive") args.push("drive", "scope=drive.file");
        else if (provider === "dropbox") args.push("dropbox");
        else args.push("mega", `user=${opts.user ?? ""}`, `pass=${opts.pass ?? ""}`, "--obscure");

        const unlisten = await listen<{ runId: string; line: string }>("rclone-output", (event) => {
            if (event.payload.runId !== runId) return;
            const link = /https?:\/\/(?:127\.0\.0\.1|localhost):\d+\/auth\?state=[\w-]+/.exec(event.payload.line);
            if (link) onLink(link[0]);
        });
        let result: RcloneResult;
        try {
            result = await rclone(args, 600, runId);
        } finally {
            unlisten();
        }
        const forget = () => rclone(["config", "delete", name], 30).catch(() => undefined);
        if (result.code !== 0) {
            // a cancelled or failed sign-in leaves a half-made remote behind
            await forget();
            await logActivity('warning', t("log.backup.connectFailed", {provider, reason: rcloneError(result).message}), undefined, 'backup');
            if (/couldn't find backend/i.test(result.stderr)) {
                throw new Error(`This rclone has no ${provider} support. Install the full rclone (rclone.org/install) or use a synced folder.`);
            }
            throw rcloneError(result);
        }
        // Check that the account can actually be reached (wrong MEGA password, unfinished sign-in…)
        const check = await rclone(["lsjson", `${name}:`, "--dirs-only", "--max-depth", "1"], 90);
        if (check.code !== 0) {
            await forget();
            await logActivity('error', t("log.backup.connectFailed", {provider, reason: rcloneError(check).message}), undefined, 'backup');
            throw rcloneError(check);
        }
        await logActivity('success', t("log.backup.connected", {provider, name}), undefined, 'backup');
    },

    async cancel(runId: string): Promise<void> {
        await invoke("rclone_cancel", {runId}).catch(() => undefined);
    },
};

// ----- config -----

export const Backups = {
    subscribe(listener: () => void): () => void {
        listeners.add(listener);
        return () => listeners.delete(listener);
    },

    version(): number {
        return version;
    },

    isBusy(_version?: number): boolean {
        return busy;
    },

    config(_version?: number): BackupConfig {
        return config;
    },

    async load(): Promise<void> {
        loaded ??= (async () => {
            try {
                const raw = await (await StorageAPI.getSettings()).getValue(CONFIG_KEY);
                if (raw) config = {...DEFAULT_CONFIG, ...JSON.parse(raw)};
            } catch (e) {
                console.warn("[Backups] could not read the backup settings", e);
            }
            notify();
        })();
        await loaded;
    },

    async update(changes: Partial<BackupConfig>): Promise<void> {
        await Backups.load();
        config = {...config, ...changes};
        notify();
        await (await StorageAPI.getSettings()).setValue(CONFIG_KEY, JSON.stringify(config));
    },

    /** Whether the destination is set up enough to use */
    isReady(cfg: BackupConfig = config): boolean {
        return cfg.destination === "folder" ? !!cfg.folder.trim() : !!cfg.remote.trim();
    },

    describeDestination(cfg: BackupConfig = config): string {
        return cfg.destination === "folder" ? cfg.folder : remoteDir(cfg);
    },

    // ----- making a backup -----

    /** Local .pak files used by any profile (deduplicated, existing files only) */
    async localModFiles(): Promise<{ path: string; name: string; size: number }[]> {
        const mods = await (await StorageAPI.getMods()).getAllCompleteModData();
        const seen = new Set<string>();
        const files: { path: string; name: string; size: number }[] = [];
        for (const mod of mods) {
            if (mod.sourceType !== ModSourceType.Local) continue;
            const path = localModPath(mod);
            if (!path || seen.has(path)) continue;
            seen.add(path);
            try {
                const info = await stat(path);
                if (info.isFile) files.push({path, name: fileNameOf(path), size: info.size});
            } catch {
                // missing file: nothing to back up
            }
        }
        return files;
    },

    /** Settings files that would go into a backup */
    async settingsFiles(): Promise<{ folder?: string; files: LocalSettingsFile[] }> {
        const folder = await settingsFolder();
        if (!folder) return {files: []};
        const files = (await listFolder(folder)).filter(f => !isProtectedSave(f.rel));
        return {folder, files};
    },

    /** Write a backup zip to `dest` (a full path) */
    async writeZip(dest: string, opts: { note?: string; auto?: boolean; cfg?: BackupConfig } = {}): Promise<number> {
        const cfg = opts.cfg ?? config;
        const work = await join(await appCacheDir(), "backup-work");
        await mkdir(work, {recursive: true});
        const snapshot = await join(work, `db-${Date.now()}.sqlite`);
        await snapshotDatabase(snapshot);
        const db = await initDb();

        try {
            const manifest: BackupManifest = {
                kind: "mintcat-backup",
                format: 1,
                createdAt: new Date().toISOString(),
                app: BuildInfo.windowTitle && BuildInfo.customVersion
                    ? `${BuildInfo.windowTitle} ${BuildInfo.customVersion}`
                    : `MINTCAT ${await getVersion()}`,
                note: opts.note || undefined,
                auto: opts.auto || undefined,
                database: DB_ENTRY,
            };
            try {
                const rows = await db.select<{ mods: number; profiles: number }[]>(
                    "SELECT (SELECT count(*) FROM mods) AS mods, (SELECT count(*) FROM profiles) AS profiles");
                manifest.counts = rows[0];
            } catch {
                // counts are only for display
            }
            const entries: { name: string; source?: string; content?: string }[] = [
                {name: DB_ENTRY, source: snapshot},
            ];
            if (cfg.includeSettings) {
                const {files} = await Backups.settingsFiles();
                manifest.modSettings = files.map(({rel, size, mtime}) => ({rel, size, mtime}));
                entries.push(...files.map(f => ({name: SETTINGS_PREFIX + f.rel, source: f.path})));
            }
            if (cfg.includeLocalMods) {
                const files = await Backups.localModFiles();
                manifest.localMods = files.map((f, i) => ({
                    entry: `local-mods/${i + 1}/${f.name}`, path: f.path, name: f.name, size: f.size,
                }));
                entries.push(...manifest.localMods.map(m => ({name: m.entry, source: m.path})));
            }
            entries.unshift({name: "manifest.json", content: JSON.stringify(manifest, null, 1)});
            return await invoke<number>("zip_create", {dest, entries});
        } finally {
            for (const suffix of ["", "-wal", "-shm"]) await remove(snapshot + suffix).catch(() => undefined);
        }
    },

    newBackupName(note?: string, auto?: boolean): string {
        const s = note ? slug(note) : "";
        return `mintcat-backup_${stampOf(new Date())}${auto ? "_auto" : ""}${s ? `_${s}` : ""}.zip`;
    },

    /** Make a backup at the chosen destination */
    async create(opts: { note?: string; auto?: boolean } = {}): Promise<BackupEntry> {
        await Backups.load();
        const cfg = config;
        if (!Backups.isReady(cfg)) throw new Error("Choose where to save backups first.");
        if (busy) throw new Error("A backup is already running.");
        busy = true;
        notify();
        const where = cfg.destination === "folder" ? cfg.folder : `rclone ${cfg.remote}`;
        try {
            const name = Backups.newBackupName(opts.note, opts.auto);
            let size: number;
            if (cfg.destination === "folder") {
                size = await Backups.writeZip(await join(cfg.folder, name), {...opts, cfg});
            } else {
                const local = await join(await appCacheDir(), "backup-work", name);
                size = await Backups.writeZip(local, {...opts, cfg});
                try {
                    await rcloneOk(["copyto", local, remoteFile(cfg, name)], 1800);
                } finally {
                    await remove(local).catch(() => undefined);
                }
            }
            await logActivity('success', t(opts.auto ? "log.backup.createdAuto" : "log.backup.created",
                {name, size: `${(size / 1048576).toFixed(1)} MB`}), where, 'backup');
            return parseBackupName(name, size)!;
        } catch (error) {
            await logActivity('error', t("log.backup.createFailed", {reason: error instanceof Error ? error.message : String(error)}), where, 'backup');
            throw error;
        } finally {
            busy = false;
            notify();
        }
    },

    // ----- listing, getting, deleting -----

    async list(): Promise<BackupEntry[]> {
        await Backups.load();
        const cfg = config;
        if (!Backups.isReady(cfg)) return [];
        const out: BackupEntry[] = [];
        if (cfg.destination === "folder") {
            if (!(await exists(cfg.folder))) return [];
            for (const entry of await readDir(cfg.folder)) {
                if (!entry.isFile) continue;
                const parsed = parseBackupName(entry.name);
                if (!parsed) continue;
                try {
                    parsed.size = (await stat(await join(cfg.folder, entry.name))).size;
                } catch {
                    // keep 0
                }
                out.push(parsed);
            }
        } else {
            const result = await rclone(["lsjson", remoteDir(cfg), "--files-only"], 120);
            if (result.code !== 0) {
                if (/directory not found|not found/i.test(result.stderr)) return [];
                throw rcloneError(result);
            }
            for (const item of JSON.parse(result.stdout || "[]") as { Name: string; Size: number }[]) {
                const parsed = parseBackupName(item.Name, item.Size);
                if (parsed) out.push(parsed);
            }
        }
        return out.sort((a, b) => b.createdAt - a.createdAt);
    },

    /** A local path to the backup's zip (downloaded first for rclone destinations) */
    async fetch(entry: BackupEntry): Promise<{ path: string; temporary: boolean }> {
        const cfg = config;
        if (!parseBackupName(entry.name)) throw new Error("Not a MINTCAT backup");
        if (cfg.destination === "folder") return {path: await join(cfg.folder, entry.name), temporary: false};
        const local = await join(await appCacheDir(), "backup-work", entry.name);
        await mkdir(await dirname(local), {recursive: true});
        await rcloneOk(["copyto", remoteFile(cfg, entry.name), local], 1800);
        return {path: local, temporary: true};
    },

    /** Copy a backup to a file the user picked */
    async saveCopy(entry: BackupEntry, target: string): Promise<void> {
        const cfg = config;
        if (cfg.destination === "folder") {
            await copyFile(await join(cfg.folder, entry.name), target);
        } else {
            await rcloneOk(["copyto", remoteFile(cfg, entry.name), target], 1800);
        }
    },

    async delete(entry: BackupEntry): Promise<void> {
        const cfg = config;
        if (!parseBackupName(entry.name)) throw new Error("Not a MINTCAT backup");
        if (cfg.destination === "folder") {
            await remove(await join(cfg.folder, entry.name));
        } else {
            await rcloneOk(["deletefile", remoteFile(cfg, entry.name)], 120);
        }
        await logActivity('info', t("log.backup.deleted", {name: entry.name}), undefined, 'backup');
    },

    /** Remove automatic backups beyond the newest `keepAuto` (manual backups are kept) */
    async prune(): Promise<number> {
        const keep = Math.max(1, config.keepAuto || 1);
        const autos = (await Backups.list()).filter(b => b.auto);
        let removed = 0;
        for (const entry of autos.slice(keep)) {
            try {
                await Backups.delete(entry);
                removed++;
            } catch (e) {
                console.warn("[Backups] could not remove an old automatic backup", entry.name, e);
            }
        }
        if (removed) await logActivity('info', t("log.backup.pruned", {count: removed, keep}), undefined, 'backup');
        return removed;
    },

    // ----- restoring -----

    async readManifest(zipPath: string): Promise<BackupManifest> {
        let manifest: BackupManifest;
        let text: string;
        try {
            text = await invoke<string>("zip_read_text", {path: zipPath, name: "manifest.json"});
        } catch (e) {
            // a readable zip without a manifest vs. a file that can't be opened as a zip
            if (/not found in archive/i.test(errorText(e))) throw new Error("This zip isn't a MINTCAT backup (no manifest.json).");
            throw new Error(errorText(e));
        }
        try {
            manifest = JSON.parse(text);
        } catch {
            throw new Error("This zip isn't a MINTCAT backup (its manifest.json can't be read).");
        }
        if (manifest.kind !== "mintcat-backup") throw new Error("This zip isn't a MINTCAT backup.");
        return manifest;
    },

    async planRestore(zipPath: string): Promise<RestorePlan> {
        const manifest = await Backups.readManifest(zipPath);
        const plan: RestorePlan = {
            zipPath,
            manifest,
            hasDatabase: !!manifest.database,
            settingsItems: [],
            localMods: [],
        };
        if (manifest.modSettings?.length) {
            plan.settingsTarget = await settingsFolder();
            plan.settingsSource = {kind: "zip", path: zipPath, prefix: SETTINGS_PREFIX, files: manifest.modSettings};
            const local = plan.settingsTarget ? await listFolder(plan.settingsTarget) : [];
            plan.settingsItems = planImport(plan.settingsSource, local);
        }
        for (const mod of manifest.localMods ?? []) {
            plan.localMods.push({...mod, present: await exists(mod.path).catch(() => false)});
        }
        return plan;
    },

    /**
     * Restore what the user chose. Settings files and missing local .pak files are put back
     * right away (existing .pak files are never overwritten; one whose folder can't be made
     * goes to <app data>/restored-local-mods). The database is put in place the next time
     * MINTCAT starts, so the caller should offer to restart.
     */
    async applyRestore(plan: RestorePlan, choice: { database: boolean; settingsRels: string[]; localMods: boolean })
        : Promise<{ settings: number; settingsSavedTo?: string; localMods: number; elsewhere?: string; database: boolean }> {
        const result: { settings: number; settingsSavedTo?: string; localMods: number; elsewhere?: string; database: boolean } =
            {settings: 0, localMods: 0, database: false};

        if (choice.settingsRels.length && plan.settingsSource && plan.settingsTarget) {
            const applied = await applyImport(plan.settingsSource, plan.settingsTarget, choice.settingsRels);
            result.settings = applied.count;
            result.settingsSavedTo = applied.savedTo;
        }

        if (choice.localMods) {
            const fallback = await join(await appDataDir(), "restored-local-mods");
            for (const mod of plan.localMods) {
                if (mod.present || await exists(mod.path).catch(() => false)) continue;
                try {
                    await mkdir(await dirname(mod.path), {recursive: true});
                    await invoke<number>("zip_extract", {path: plan.zipPath, files: [[mod.entry, mod.path]]});
                } catch {
                    const dest = await join(fallback, mod.name);
                    if (await exists(dest)) continue;
                    await mkdir(fallback, {recursive: true});
                    await invoke<number>("zip_extract", {path: plan.zipPath, files: [[mod.entry, dest]]});
                    result.elsewhere = fallback;
                }
                result.localMods++;
            }
        }

        if (choice.database && plan.hasDatabase) {
            const dbPath = await join(await configDir(), "com.mint.cat", "mintcat.sqlite");
            await invoke<number>("zip_extract", {path: plan.zipPath, files: [[plan.manifest.database!, `${dbPath}.restore`]]});
            try {
                // Fold the WAL into the main file now, so the copy kept as .bak is complete
                await (await initDb()).execute("PRAGMA wal_checkpoint(TRUNCATE)");
            } catch {
                // the startup step keeps the WAL with the .bak copy anyway
            }
            result.database = true;
        }
        await logActivity('success', t("log.backup.restored", {
            name: plan.zipPath.split(/[\\/]/).pop() ?? plan.zipPath,
            what: [
                result.database ? t("log.backup.restoredDatabase") : "",
                result.settings ? t("log.backup.restoredSettings", {count: result.settings}) : "",
                result.localMods ? t("log.backup.restoredMods", {count: result.localMods}) : "",
            ].filter(Boolean).join(", ") || "—",
        }), result.elsewhere, 'backup');
        return result;
    },

    // ----- automatic backups -----

    async runAutoIfDue(): Promise<void> {
        await Backups.load();
        const cfg = config;
        if (cfg.auto === "off" || !Backups.isReady(cfg) || busy) return;
        const interval = (cfg.auto === "weekly" ? 7 : 1) * 24 * 3600 * 1000;
        if (cfg.lastAuto && Date.now() - cfg.lastAuto < interval) return;
        try {
            await Backups.create({auto: true});
            await Backups.update({lastAuto: Date.now()});
            await Backups.prune();
            console.log("[Backups] automatic backup done");
        } catch (e) {
            console.warn("[Backups] automatic backup failed", e);
            // try again in an hour rather than at every check
            await Backups.update({lastAuto: Date.now() - interval + 3600 * 1000});
        }
    },

    /** Check for a due automatic backup a minute after start and then every 30 minutes */
    startAuto(): void {
        setTimeout(() => {
            void Backups.runAutoIfDue();
            setInterval(() => void Backups.runAutoIfDue(), 30 * 60 * 1000);
        }, 60 * 1000);
    },
};
