/**
 * "Ask before moving" (Settings → Mod list, off by default): moving mods or folders (dragging,
 * Move to, Move to position, Pin to Top, Move above from the conflict details) first shows where they go
 * and waits for OK.
 */
import {StorageAPI} from "@/storage";

export const CONFIRM_MOVE_KEY = "ui.confirmMoves";

let enabled = false;
let loaded = false;
const listeners = new Set<() => void>();

function notify() {
    listeners.forEach(listener => listener());
}

async function load(): Promise<boolean> {
    if (loaded) return enabled;
    try {
        const value = await (await StorageAPI.getSettings()).getValue(CONFIRM_MOVE_KEY);
        enabled = value === "true";
    } catch {
        enabled = false;
    }
    loaded = true;
    notify();
    return enabled;
}

export const MoveConfirm = {
    init: load,
    /** Current value for React (useSyncExternalStore) */
    isEnabled(): boolean {
        return enabled;
    },
    subscribe(listener: () => void): () => void {
        listeners.add(listener);
        return () => listeners.delete(listener);
    },
    async enabled(): Promise<boolean> {
        return load();
    },
    async setEnabled(value: boolean): Promise<void> {
        enabled = value;
        loaded = true;
        notify();
        await (await StorageAPI.getSettings()).setValue(CONFIRM_MOVE_KEY, value ? "true" : "false");
    },
};
