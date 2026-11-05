/**
 * Showing support for mods on their sites, only when you click it: track / endorse on Nexus Mods
 * (with your API key) and subscribe / like / dislike on mod.io (with your mod.io token).
 * Adding a mod to MINTCAT never does any of this.
 *
 * What your accounts already track, endorsed, subscribed to or rated is read once (lists of
 * your account, a few requests) and kept for the session, so Browse Mods and the mod list can
 * show it. The lists are read again after 10 minutes or when the key / token changes.
 */
import {message} from "antd";
import {MessageBox} from "@/components/MessageBox";
import {t} from "i18next";
import {NexusModsApi, NexusModsEndorseError} from "@/apis/nexusmods";
import {ModioApi, ModioWriteError} from "@/apis/modio";
import {AuthResolver} from "@/services/network";

const REFRESH_MS = 10 * 60_000;
const auth = new AuthResolver();

export type NexusEndorsement = 'Endorsed' | 'Abstained' | 'Undecided';

interface NexusLists {
    key: string;
    at: number;
    tracked: Set<string>;
    endorsements: Map<string, string>;
}

interface ModioLists {
    token: string;
    at: number;
    subscribed: Set<number>;
    ratings: Map<number, number>;
}

let nexus: NexusLists | null = null;
let modio: ModioLists | null = null;
let nexusLoading: Promise<void> | null = null;
let modioLoading: Promise<void> | null = null;
/** Something is being sent for this mod ("nexus:drg:12", "modio:34") */
const busy = new Set<string>();
let version = 0;
const listeners = new Set<() => void>();

function notify() {
    version++;
    for (const listener of listeners) listener();
}

const nexusKey = (domain: string, modId: number) => `${domain.toLowerCase()}:${modId}`;

export interface NexusSupportState {
    /** The account's lists have been read */
    known: boolean;
    /** An API key is saved */
    available: boolean;
    tracked: boolean;
    endorsement?: string;
    busy: boolean;
}

export interface ModioSupportState {
    known: boolean;
    /** A mod.io token is saved */
    available: boolean;
    subscribed: boolean;
    /** 1 like, -1 dislike, 0 none */
    rating: number;
    busy: boolean;
}

let nexusKeySaved = false;
let lastRefresh = 0;
let refreshing: Promise<void> | null = null;
let modioTokenSaved = false;

async function loadNexus(force: boolean): Promise<void> {
    const key = await NexusModsApi.getApiKey();
    nexusKeySaved = !!key;
    if (!key) {
        if (nexus) {
            nexus = null;
            notify();
        }
        return;
    }
    if (!force && nexus && nexus.key === key && Date.now() - nexus.at < REFRESH_MS) return;
    if (nexusLoading) return nexusLoading;
    nexusLoading = (async () => {
        try {
            const [tracked, endorsements] = await Promise.all([
                NexusModsApi.getTrackedMods(),
                NexusModsApi.getEndorsements(),
            ]);
            nexus = {
                key, at: Date.now(),
                tracked: new Set(tracked.map(m => nexusKey(m.domain, m.modId))),
                endorsements: new Map(endorsements.map(m => [nexusKey(m.domain, m.modId), m.status])),
            };
        } catch (error) {
            console.warn('[ModSupport] Nexus lists not readable:', error instanceof Error ? error.message : error);
        } finally {
            nexusLoading = null;
            notify();
        }
    })();
    return nexusLoading;
}

async function loadModio(force: boolean): Promise<void> {
    const token = await auth.getModioToken();
    modioTokenSaved = !!token;
    if (!token) {
        if (modio) {
            modio = null;
            notify();
        }
        return;
    }
    if (!force && modio && modio.token === token && Date.now() - modio.at < REFRESH_MS) return;
    if (modioLoading) return modioLoading;
    modioLoading = (async () => {
        try {
            const [subscribed, ratings] = await Promise.all([
                ModioApi.getMySubscribedIds(),
                ModioApi.getMyRatings(),
            ]);
            modio = {token, at: Date.now(), subscribed: new Set(subscribed), ratings};
        } catch (error) {
            console.warn('[ModSupport] mod.io lists not readable:', error instanceof Error ? error.message : error);
        } finally {
            modioLoading = null;
            notify();
        }
    })();
    return modioLoading;
}

function nexusErrorText(error: unknown): string {
    if (error instanceof NexusModsEndorseError) {
        switch (error.code) {
            case 'NOT_DOWNLOADED_MOD':
                return t('support.nexusNotDownloaded');
            case 'TOO_SOON_AFTER_DOWNLOAD':
                return t('support.nexusTooSoon');
            case 'IS_OWN_MOD':
                return t('support.nexusOwnMod');
        }
    }
    if (NexusModsApi.isAuthenticationRequiredError(error)) return t('support.nexusKeyRejected');
    const text = error instanceof Error ? error.message : String(error);
    // "Nexus Mods API 403: {"code":403,"message":"..."}" → the message
    const inner = /"message"\s*:\s*"([^"]+)"/.exec(text)?.[1];
    return inner || text;
}

function modioErrorText(error: unknown): string {
    if (error instanceof ModioWriteError) {
        switch (error.kind) {
            case 'readOnly':
                return t('support.modioReadOnly');
            case 'inactive':
                return t('support.modioInactive');
            case 'tooMany':
                return t('support.modioTooMany');
        }
        return error.message;
    }
    return error instanceof Error ? error.message : String(error);
}

async function run(key: string, task: () => Promise<void>, failTitle: string, errorText: (e: unknown) => string): Promise<boolean> {
    if (busy.has(key)) return false;
    busy.add(key);
    notify();
    try {
        await task();
        // lists that were being read meanwhile may predate the change: read them again after
        const loading = key.startsWith('nexus:') ? nexusLoading : modioLoading;
        if (loading) {
            void loading.then(() => key.startsWith('nexus:') ? loadNexus(true) : loadModio(true));
        }
        return true;
    } catch (error) {
        console.warn('[ModSupport]', failTitle, error instanceof Error ? error.message : error);
        MessageBox.info({title: failTitle, content: errorText(error)});
        return false;
    } finally {
        busy.delete(key);
        notify();
    }
}

export const ModSupport = {
    subscribe(listener: () => void): () => void {
        listeners.add(listener);
        return () => listeners.delete(listener);
    },

    version(): number {
        return version;
    },

    /** A Nexus API key or mod.io token is saved (the mod list then shows the support columns) */
    anyAccount(_version?: number): boolean {
        return nexusKeySaved || modioTokenSaved;
    },

    /**
     * Read the account lists if they're missing or old (no-op without key / token). Every card
     * and row asks; the key / token is only looked up again after a few seconds.
     */
    async refresh(force = false): Promise<void> {
        if (!force && refreshing) return refreshing;
        if (!force && Date.now() - lastRefresh < 5000) return;
        lastRefresh = Date.now();
        refreshing = Promise.all([loadNexus(force), loadModio(force)]).then(() => undefined).finally(() => {
            refreshing = null;
        });
        return refreshing;
    },

    /** `_version` (useSyncExternalStore) makes React Compiler-memoized callers read it again */
    nexusState(domain: string, modId: number, _version?: number): NexusSupportState {
        const key = nexusKey(domain, modId);
        return {
            known: !!nexus,
            available: nexusKeySaved,
            tracked: nexus?.tracked.has(key) ?? false,
            endorsement: nexus?.endorsements.get(key),
            busy: busy.has(`nexus:${key}`),
        };
    },

    modioState(modId: number, _version?: number): ModioSupportState {
        return {
            known: !!modio,
            available: modioTokenSaved,
            subscribed: modio?.subscribed.has(modId) ?? false,
            rating: modio?.ratings.get(modId) ?? 0,
            busy: busy.has(`modio:${modId}`),
        };
    },

    async setNexusTracked(domain: string, modId: number, tracked: boolean, name: string): Promise<void> {
        if (!await ModSupport.ensureNexusKey()) return;
        const key = nexusKey(domain, modId);
        const done = await run(`nexus:${key}`, async () => {
            await NexusModsApi.setTracked(domain, modId, tracked);
            if (nexus) {
                if (tracked) nexus.tracked.add(key);
                else nexus.tracked.delete(key);
            }
        }, t(tracked ? 'support.trackFailed' : 'support.untrackFailed', {name}), nexusErrorText);
        if (done) message.success(t(tracked ? 'support.tracked' : 'support.untracked', {name}));
    },

    async setNexusEndorsed(domain: string, modId: number, endorse: boolean, name: string, modVersion?: string): Promise<void> {
        if (!await ModSupport.ensureNexusKey()) return;
        const key = nexusKey(domain, modId);
        const done = await run(`nexus:${key}`, async () => {
            const status = await NexusModsApi.setEndorsed(domain, modId, endorse, modVersion);
            nexus?.endorsements.set(key, status || (endorse ? 'Endorsed' : 'Abstained'));
        }, t(endorse ? 'support.endorseFailed' : 'support.abstainFailed', {name}), nexusErrorText);
        if (done) message.success(t(endorse ? 'support.endorsed' : 'support.abstained', {name}));
    },

    async setModioSubscribed(modId: number, subscribed: boolean, name: string): Promise<void> {
        if (!await ModSupport.ensureModioToken()) return;
        const done = await run(`modio:${modId}`, async () => {
            await ModioApi.setSubscribed(modId, subscribed);
            if (modio) {
                if (subscribed) modio.subscribed.add(modId);
                else modio.subscribed.delete(modId);
            }
        }, t(subscribed ? 'support.subscribeFailed' : 'support.unsubscribeFailed', {name}), modioErrorText);
        if (done) message.success(t(subscribed ? 'support.subscribed' : 'support.unsubscribed', {name}));
    },

    async setModioRating(modId: number, rating: 1 | -1 | 0, name: string): Promise<void> {
        if (!await ModSupport.ensureModioToken()) return;
        const done = await run(`modio:${modId}`, async () => {
            await ModioApi.setRating(modId, rating);
            if (modio) {
                if (rating) modio.ratings.set(modId, rating);
                else modio.ratings.delete(modId);
            }
        }, t('support.rateFailed', {name}), modioErrorText);
        if (done) message.success(t(rating === 1 ? 'support.liked' : rating === -1 ? 'support.disliked' : 'support.unrated', {name}));
    },

    async ensureNexusKey(): Promise<boolean> {
        if (await NexusModsApi.getApiKey()) {
            void loadNexus(false);
            return true;
        }
        nexusKeySaved = false;
        MessageBox.info({title: t('support.needNexusKeyTitle'), content: t('support.needNexusKey')});
        return false;
    },

    async ensureModioToken(): Promise<boolean> {
        if (await auth.getModioToken()) {
            void loadModio(false);
            return true;
        }
        modioTokenSaved = false;
        MessageBox.info({title: t('support.needModioTokenTitle'), content: t('support.needModioToken')});
        return false;
    },
};

/** "https://www.nexusmods.com/deeprockgalactic/mods/12" → "deeprockgalactic" (else the default) */
export function nexusDomainOf(url: string | undefined, fallback = 'deeprockgalactic'): string {
    return (url && NexusModsApi.parseModLinks(url)?.domain) || fallback;
}
