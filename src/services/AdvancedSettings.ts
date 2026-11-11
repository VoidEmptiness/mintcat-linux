/**
 * "Show advanced settings" (Settings page; off by default in builds with an edition label): settings most people never need
 * (release channel, dev tools, network, the MINTCAT supporters' cloud backup) stay hidden
 * until it is turned on.
 */
import {StorageAPI} from "@/storage";
import {BuildInfo} from "@/buildInfo";

const KEY = "ui.showAdvancedSettings";
/** Upstream builds keep showing everything; builds with an edition label start with it hidden */
const DEFAULT_SHOWN = !BuildInfo.edition;
let shown = DEFAULT_SHOWN;
let loaded = false;
const listeners = new Set<() => void>();

function notify() {
    listeners.forEach(l => l());
}

export const AdvancedSettings = {
    subscribe(listener: () => void): () => void {
        listeners.add(listener);
        return () => listeners.delete(listener);
    },
    isShown(): boolean {
        return shown;
    },
    async load(): Promise<void> {
        if (loaded) return;
        loaded = true;
        try {
            const value = await (await StorageAPI.getSettings()).getValue(KEY);
            shown = value ? value === "true" : DEFAULT_SHOWN;
            notify();
        } catch {
            // stays hidden
        }
    },
    async setShown(value: boolean): Promise<void> {
        shown = value;
        notify();
        await (await StorageAPI.getSettings()).setValue(KEY, value ? "true" : "false");
    },
};
