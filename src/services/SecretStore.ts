/**
 * API keys and login tokens in the system keyring (KWallet, GNOME Keyring, KeePassXC... through
 * the Secret Service), so MINTCAT's database only holds a marker for them.
 *
 * When no keyring answers, callers keep the key in the database as before (`put` returns false).
 * Keys read once are kept in memory for this session, so requests don't ask the keyring each time.
 */
import {invoke} from "@tauri-apps/api/core";

/** What the database holds instead of a key that is in the keyring */
export const KEYRING_MARKER = "@keyring:v1";

/** Pause after a keyring error before asking it again (so a closed unlock dialog isn't reopened at once) */
const RETRY_AFTER_ERROR_MS = 60_000;

const cache = new Map<string, string>();
const pendingReads = new Map<string, Promise<string | null>>();
let lastError: { at: number; message: string } | null = null;

export function keyringAccount(uid: number, platform: string): string {
    return `${uid}:${platform}`.replace(/[^A-Za-z0-9:._-]/g, "_");
}

function label(platform: string): string {
    const names: Record<string, string> = {
        nexusmods: "Nexus Mods API key",
        "mod.io": "mod.io access token",
        mintcat: "MINTCAT access key",
        modcat: "ModCat access key",
    };
    return `MINTCAT – ${names[platform] ?? platform}`;
}

function remember(error: unknown) {
    lastError = {at: Date.now(), message: error instanceof Error ? error.message : String(error)};
    console.warn("[SecretStore] keyring not usable:", lastError.message);
}

function coolingDown(): boolean {
    return !!lastError && Date.now() - lastError.at < RETRY_AFTER_ERROR_MS;
}

export const SecretStore = {
    /** The key, or null when there's none in the keyring (or it can't be reached right now) */
    async get(uid: number, platform: string): Promise<string | null> {
        const account = keyringAccount(uid, platform);
        if (cache.has(account)) return cache.get(account)!;
        if (coolingDown()) return null;
        const pending = pendingReads.get(account);
        if (pending) return pending;
        const read = invoke<string | null>("secret_store_get", {account})
            .then((value) => {
                if (value != null) cache.set(account, value);
                return value ?? null;
            })
            .catch((error) => {
                remember(error);
                return null;
            })
            .finally(() => pendingReads.delete(account));
        pendingReads.set(account, read);
        return read;
    },

    /** Store a key; false when no keyring took it (the caller keeps it elsewhere) */
    async put(uid: number, platform: string, value: string): Promise<boolean> {
        const account = keyringAccount(uid, platform);
        // just failed (e.g. its unlock dialog was closed): don't ask again on every keystroke
        if (coolingDown()) return false;
        try {
            await invoke("secret_store_set", {account, label: label(platform), secret: value});
            cache.set(account, value);
            lastError = null;
            return true;
        } catch (error) {
            remember(error);
            cache.delete(account);
            return false;
        }
    },

    async remove(uid: number, platform: string): Promise<void> {
        const account = keyringAccount(uid, platform);
        cache.delete(account);
        try {
            await invoke("secret_store_delete", {account});
        } catch (error) {
            remember(error);
        }
    },

    /** Whether a keyring answers right now */
    async available(): Promise<boolean> {
        try {
            return await invoke<boolean>("secret_store_available");
        } catch {
            return false;
        }
    },

    /** The last keyring problem (for the settings dialog), if recent */
    lastProblem(): string | null {
        return coolingDown() ? lastError!.message : null;
    },
};
