/**
 * Activity log shown in the bottom Log panel (main window).
 *
 * Any window can add entries with logActivity(): it goes through an app-wide event,
 * so the Add Mod dialog's messages land in the main window's log too.
 * Status bar messages, install errors and finished tasks are recorded as well.
 */
import {t} from "i18next";
import {emitEvent, listenEvent} from "@/events";
import {saveActivityEntry} from "@/services/AppLogs";

export type ActivityLevel = 'info' | 'success' | 'warning' | 'error';

export interface ActivityEntry {
    id: number;
    time: number;
    level: ActivityLevel;
    message: string;
    /** Secondary text, e.g. the link or file path the message is about */
    detail?: string;
    /** Short tag shown as [source], e.g. "add-mod", "install" */
    source: string;
}

const MAX_ENTRIES = 1000;
/** Where earlier builds remembered the panel's open state; the panel now always starts closed */
const OLD_OPEN_KEY = 'mintcat-log-panel-open';
export const LOG_PANEL_HEIGHT = 180;

const entries: ActivityEntry[] = [];
let nextId = 1;
let unseenProblems = 0;
// Starts closed on every launch (the Log button shows a red count for new errors and warnings)
let panelOpen = false;
forgetOldOpenState();
let initialized = false;
const listeners = new Set<() => void>();
/** Only told about the panel opening/closing (layout), not about new entries */
const openListeners = new Set<() => void>();

function forgetOldOpenState(): void {
    try {
        localStorage.removeItem(OLD_OPEN_KEY);
    } catch {
        // nothing stored
    }
}

export interface ActivitySnapshot {
    entries: readonly ActivityEntry[];
    open: boolean;
    unseenProblems: number;
}

/** Replaced (never mutated) on every change so React sees a new value */
let snapshot: ActivitySnapshot = {entries: [], open: panelOpen, unseenProblems: 0};

function notify() {
    snapshot = {entries: entries.slice(), open: panelOpen, unseenProblems};
    listeners.forEach(listener => {
        try {
            listener();
        } catch (e) {
            console.error('[ActivityLog] listener failed', e);
        }
    });
}

function push(level: ActivityLevel, message: string, detail: string | undefined, source: string) {
    if (!message) return;
    // The same problem reported twice at once (e.g. an install error that is also an app error).
    // Only problems: two quick "Enabled 5 mod(s)" on different mods are two entries
    const last = entries[entries.length - 1];
    const problem = level === 'error' || level === 'warning';
    if (problem && last && last.message === message && last.level === level
        && (last.detail === detail || !last.detail || !detail) && Date.now() - last.time < 3000) return;
    const entry: ActivityEntry = {id: nextId++, time: Date.now(), level, message, detail, source};
    entries.push(entry);
    // kept with this launch's logs (Log panel → earlier launches)
    if (initialized) saveActivityEntry(entry);
    if (entries.length > MAX_ENTRIES) {
        entries.splice(0, entries.length - MAX_ENTRIES);
    }
    if (!panelOpen && (level === 'error' || level === 'warning')) {
        unseenProblems++;
    }
    // Also into MintCat's log file (console output is forwarded there)
    const line = `[activity] [${source}] ${message}${detail ? ` — ${detail}` : ''}`;
    if (level === 'error') console.error(line);
    else if (level === 'warning') console.warn(line);
    else console.info(line);
    notify();
}

/** Same message translation rules as the status bar */
function translateStatusMessage(msg: unknown): { text: string; level: ActivityLevel } {
    let text: string;
    if (typeof msg === 'string') {
        text = (msg.startsWith('backend.') || msg.startsWith('error.')) ? t(msg) : msg;
    } else if (msg && typeof msg === 'object' && 'key' in msg && typeof (msg as { key: unknown }).key === 'string') {
        const {key, ...params} = msg as { key: string; [k: string]: unknown };
        text = t(key, params as Record<string, string>);
    } else {
        const raw = (msg as { message?: string })?.message ?? String(msg ?? '');
        text = (raw.startsWith('backend.') || raw.startsWith('error.')) ? t(raw) : raw;
    }
    const level = (msg && typeof msg === 'object' && 'level' in msg)
        ? (((msg as { level?: ActivityLevel }).level) || 'info')
        : 'info';
    return {text, level};
}

/**
 * Add a log entry from any window.
 */
export async function logActivity(level: ActivityLevel, message: string, detail?: string, source = 'app'): Promise<void> {
    await emitEvent('activity-log', {level, message, detail, source});
}

/** Names for a log line: the first few, then how many more */
export function nameList(names: string[], max = 12): string {
    if (names.length <= max) return names.join(", ");
    return `${names.slice(0, max).join(", ")} ${t("log.andMore", {count: names.length - max})}`;
}

/** Local timestamp as YYYY-MM-DD HH:MM:SS */
export function formatLogTime(time: number): string {
    const d = new Date(time);
    const p = (n: number) => String(n).padStart(2, '0');
    return `${d.getFullYear()}-${p(d.getMonth() + 1)}-${p(d.getDate())} ${p(d.getHours())}:${p(d.getMinutes())}:${p(d.getSeconds())}`;
}

export const ActivityLog = {
    /** Current state for useSyncExternalStore (a new object after every change) */
    getSnapshot(): ActivitySnapshot {
        return snapshot;
    },

    getEntries(): readonly ActivityEntry[] {
        return entries;
    },

    getUnseenProblems(): number {
        return unseenProblems;
    },

    isOpen(): boolean {
        return panelOpen;
    },

    /** Height the panel takes from page content (0 when closed) */
    getPanelOffset(): number {
        return panelOpen ? LOG_PANEL_HEIGHT : 0;
    },

    setOpen(open: boolean) {
        if (panelOpen === open) return;
        panelOpen = open;
        if (open) unseenProblems = 0;
        notify();
        openListeners.forEach(listener => {
            try {
                listener();
            } catch (e) {
                console.error('[ActivityLog] open listener failed', e);
            }
        });
        // Pages that size themselves from the window height recalculate on resize
        window.dispatchEvent(new Event('resize'));
    },

    /** Layout listeners: called only when the panel opens or closes */
    subscribeOpen(listener: () => void): () => void {
        openListeners.add(listener);
        return () => openListeners.delete(listener);
    },

    toggle() {
        this.setOpen(!panelOpen);
    },

    clear() {
        entries.length = 0;
        unseenProblems = 0;
        notify();
    },

    subscribe(listener: () => void): () => void {
        listeners.add(listener);
        return () => listeners.delete(listener);
    },

    /** Record a finished background task's last message */
    recordTaskFinished(message: string | undefined, failed: boolean) {
        if (!message) return;
        push(failed ? 'error' : 'info', message, undefined, 'task');
    },

    asText(): string {
        return entries.map(e => {
            const level = e.level === 'error' ? 'ERROR: ' : e.level === 'warning' ? 'WARN: ' : '';
            return `[${formatLogTime(e.time)}] [${e.source}] ${level}${e.message}${e.detail ? ` — ${e.detail}` : ''}`;
        }).join('\n');
    },
};

/**
 * Start collecting. Call once in the main window.
 */
export async function initActivityLog(): Promise<void> {
    if (initialized) return;
    initialized = true;

    await listenEvent('activity-log', (payload) => {
        push(payload.level ?? 'info', payload.message, payload.detail, payload.source || 'app');
    });

    await listenEvent('status-bar-log', (msg) => {
        // progress steps only show in the status bar
        if (msg && typeof msg === 'object' && (msg as { transient?: boolean }).transient) return;
        const {text, level} = translateStatusMessage(msg);
        push(level, text, undefined, 'status');
    });

    await listenEvent('install-error', (msg) => {
        const {text} = translateStatusMessage(msg);
        push('error', text, undefined, 'install');
    });

    await listenEvent('app-error', (msg) => {
        const {text} = translateStatusMessage(msg);
        push('error', text, undefined, 'app');
    });

    // Errors nothing else caught: what went wrong, and where (the first line of the stack)
    const where = (stack: unknown): string | undefined =>
        typeof stack === 'string' ? stack.split('\n').map(l => l.trim()).find(l => l.startsWith('at ') || l.includes('@')) : undefined;
    const benign = (text: string) => /ResizeObserver loop|Script error\.?$/i.test(text);
    window.addEventListener('error', (event) => {
        const text = event.error instanceof Error ? event.error.message : String(event.message ?? '');
        if (!text || benign(text)) return;
        push('error', t("log.app.uncaught", {message: text}), where(event.error?.stack), 'app');
    });
    window.addEventListener('unhandledrejection', (event) => {
        const reason = event.reason;
        const text = reason instanceof Error ? reason.message : typeof reason === 'string' ? reason : JSON.stringify(reason ?? '');
        if (!text || benign(text)) return;
        push('error', t("log.app.uncaught", {message: text}), where(reason?.stack), 'app');
    });
}
