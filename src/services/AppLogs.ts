/**
 * Logs of earlier launches (see src-tauri/src/app_logs.rs): each launch gets its own log file
 * and a copy of what the Log panel showed. Settings → Logs says how many launches are kept;
 * the oldest go when a new launch starts (or when the number is lowered).
 */
import {invoke} from "@tauri-apps/api/core";
import {StorageAPI} from "@/storage";
import type {ActivityEntry, ActivityLevel} from "@/services/ActivityLog";

const KEEP_KEY = "logs.keepLaunches";
export const DEFAULT_KEEP = 10;
export const MAX_KEEP = 200;

export interface LogFileInfo {
    name: string;
    kind: "log" | "activity";
    size: number;
}

export interface LogSession {
    /** "2026-11-05_12-57-03"; "0000-00-00_00-00-00" is the single log of earlier builds */
    stamp: string;
    current: boolean;
    modifiedMs: number;
    files: LogFileInfo[];
}

export const LEGACY_STAMP = "0000-00-00_00-00-00";

/** "2026-11-05_12-57-03" → a Date (local time) */
export function stampDate(stamp: string): Date | null {
    const m = /^(\d{4})-(\d{2})-(\d{2})_(\d{2})-(\d{2})-(\d{2})$/.exec(stamp);
    if (!m || stamp === LEGACY_STAMP) return null;
    return new Date(Number(m[1]), Number(m[2]) - 1, Number(m[3]), Number(m[4]), Number(m[5]), Number(m[6]));
}

/** Keys and signatures in download links don't go into saved logs */
export function redactForLog(text: string | undefined): string | undefined {
    if (!text) return text;
    return text.replace(/([?&](?:key|expires|user_id|md5|token|access_token|apikey|api_key)=)[^&#\s]+/gi, "$1[REDACTED]");
}

function clampKeep(value: unknown): number {
    const n = Math.round(Number(value));
    return Number.isFinite(n) && n >= 1 ? Math.min(n, MAX_KEEP) : DEFAULT_KEEP;
}

export const AppLogs = {
    async keepCount(): Promise<number> {
        try {
            const settings = await StorageAPI.getSettings();
            const raw = await settings.getValue(KEEP_KEY);
            return raw == null || raw === "" ? DEFAULT_KEEP : clampKeep(raw);
        } catch {
            return DEFAULT_KEEP;
        }
    },

    async setKeepCount(value: number): Promise<number> {
        const keep = clampKeep(value);
        const settings = await StorageAPI.getSettings();
        await settings.setValue(KEEP_KEY, String(keep));
        await AppLogs.prune(keep);
        return keep;
    },

    /** Delete the logs of launches beyond the number kept */
    async prune(keep?: number): Promise<{ removedFiles: number; removedBytes: number }> {
        const count = keep ?? await AppLogs.keepCount();
        return await invoke("prune_app_logs", {keep: count});
    },

    async sessions(): Promise<LogSession[]> {
        return await invoke<LogSession[]>("list_app_logs");
    },

    async readText(name: string): Promise<string> {
        return await invoke<string>("read_app_log", {name});
    },

    /** The Log panel entries saved for an earlier launch */
    async readActivity(session: LogSession): Promise<ActivityEntry[]> {
        const file = session.files.find(f => f.kind === "activity");
        if (!file) return [];
        const text = await AppLogs.readText(file.name);
        const entries: ActivityEntry[] = [];
        let id = 1;
        for (const line of text.split("\n")) {
            if (!line.trim()) continue;
            try {
                const e = JSON.parse(line);
                if (typeof e?.message !== "string") continue;
                const level: ActivityLevel = ["info", "success", "warning", "error"].includes(e.level) ? e.level : "info";
                entries.push({
                    id: id++, time: Number(e.time) || 0, level, message: e.message,
                    detail: typeof e.detail === "string" ? e.detail : undefined,
                    source: typeof e.source === "string" ? e.source : "app",
                });
            } catch {
                // a line cut off when the app was closed
            }
        }
        return entries;
    },
};

// ---------- saving this launch's Log panel entries ----------

let pending: string[] = [];
let flushTimer: ReturnType<typeof setTimeout> | null = null;

async function flush(): Promise<void> {
    flushTimer = null;
    if (pending.length === 0) return;
    const lines = pending.join("\n");
    pending = [];
    try {
        if (flushTimer) {
            clearTimeout(flushTimer);
            flushTimer = null;
        }
        await invoke("append_activity_log", {lines});
    } catch (error) {
        console.warn("[AppLogs] could not save log entries", error);
    }
}

/** Called for every Log panel entry; written a moment later in one go */
export function saveActivityEntry(entry: ActivityEntry): void {
    pending.push(JSON.stringify({
        time: entry.time,
        level: entry.level,
        source: entry.source,
        message: redactForLog(entry.message),
        detail: redactForLog(entry.detail),
    }));
    // problems are written straight away (the app may be about to go down)
    if (pending.length > 500 || entry.level === "error") {
        void flush();
        return;
    }
    if (!flushTimer) flushTimer = setTimeout(() => void flush(), 1500);
}

if (typeof window !== "undefined") {
    window.addEventListener("beforeunload", () => void flush());
}
