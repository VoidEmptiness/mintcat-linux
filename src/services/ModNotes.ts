/**
 * Your own notes on mods ("put above CAO", "turn off for Haz 5 runs"), one per mod, kept in
 * MINTCAT's settings. A mod in several profiles has the same note in each.
 */
import {StorageAPI} from "@/storage";

const SETTINGS_KEY = 'modNotes';
/** Long enough for real notes, short enough to keep the settings row small */
export const MAX_NOTE_LENGTH = 4000;

let notes: Record<string, string> | null = null;
let loading: Promise<Record<string, string>> | null = null;
let version = 0;
const listeners = new Set<() => void>();

function notify() {
    version++;
    for (const listener of listeners) listener();
}

async function load(): Promise<Record<string, string>> {
    if (notes) return notes;
    if (loading) return loading;
    loading = (async () => {
        try {
            const settings = await StorageAPI.getSettings();
            const raw = await settings.getValue(SETTINGS_KEY);
            const parsed = raw ? JSON.parse(raw) : {};
            notes = {};
            for (const [modId, text] of Object.entries(parsed ?? {})) {
                if (typeof text === 'string' && text.trim()) notes[modId] = text;
            }
        } catch {
            notes = {};
        } finally {
            loading = null;
        }
        notify();
        return notes!;
    })();
    return loading;
}

async function save(): Promise<void> {
    const settings = await StorageAPI.getSettings();
    await settings.setValue(SETTINGS_KEY, JSON.stringify(notes ?? {}));
    notify();
}

export const ModNotes = {
    subscribe(listener: () => void): () => void {
        listeners.add(listener);
        if (!notes) void load();
        return () => listeners.delete(listener);
    },

    version(): number {
        return version;
    },

    /**
     * Any mod has a note (the mod list then shows the notes column). `_version` (from
     * useSyncExternalStore) makes React Compiler-memoized callers read it again after changes.
     */
    hasAny(_version?: number): boolean {
        return !!notes && Object.keys(notes).length > 0;
    },

    /** The note of a mod (after load; empty while loading); `_version` as for hasAny */
    get(modId: number | undefined, _version?: number): string {
        if (modId == null) return '';
        return notes?.[String(modId)] ?? '';
    },

    async read(modId: number): Promise<string> {
        return (await load())[String(modId)] ?? '';
    },

    /** Save a note; an empty one removes it */
    async set(modId: number, text: string): Promise<void> {
        const all = await load();
        const value = text.replace(/\r\n/g, '\n').slice(0, MAX_NOTE_LENGTH);
        if (value.trim()) all[String(modId)] = value;
        else delete all[String(modId)];
        await save();
    },

    /** Notes of mods that no longer exist go with them */
    async forget(modIds: number[]): Promise<void> {
        const all = await load();
        let changed = false;
        for (const id of modIds) {
            if (all[String(id)] != null) {
                delete all[String(id)];
                changed = true;
            }
        }
        if (changed) await save();
    },
};
