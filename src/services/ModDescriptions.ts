/**
 * Mod descriptions shown when hovering a mod in the list (Settings → "Show mod descriptions on
 * hover"). mod.io mods use the mod's summary plus the start of its description, fetched 100 at a
 * time; local mods linked to a repository post (Pak Hub) use the post text. Results are kept for a
 * few days in browser storage so hovering again needs no network.
 */
import {ModioApi} from "@/apis/modio";
import type {ModInfo} from "@/apis/modio/ModInfo";
import {StorageAPI} from "@/storage";
import {RepositoryStore} from "@/apis/repositories";
import {loadRepositoryDetail, repositoryDescription} from "@/apis/repositories/details";
import {RepositoryUpdates} from "@/services/RepositoryUpdates";

export const MOD_DESCRIPTION_HOVER_KEY = "ui.modDescriptionOnHover";

const CACHE_KEY = "mod-descriptions-v1";
const CACHE_TTL_MS = 3 * 24 * 60 * 60 * 1000;
const DETAILS_MAX_CHARS = 600;

export interface ModDescription {
    state: "loading" | "ready" | "error";
    summary?: string;
    details?: string;
    error?: string;
}

/** What the list row knows about a mod (TreeViewConverter node) */
export interface DescribedMod {
    modId: number;
    platformId?: number;
    nameId?: string;
    sourceType?: string;
    url?: string;
}

interface Cached {
    summary?: string;
    details?: string;
    at: number;
}

let enabled = false;
let version = 0;
const listeners = new Set<() => void>();
const entries = new Map<string, ModDescription>();
let stored: Record<string, Cached> | null = null;

function notify() {
    version++;
    listeners.forEach(l => l());
}

function readStored(): Record<string, Cached> {
    if (stored) return stored;
    try {
        stored = JSON.parse(localStorage.getItem(CACHE_KEY) || "{}") || {};
    } catch {
        stored = {};
    }
    return stored!;
}

function writeStored() {
    try {
        const now = Date.now();
        const all = readStored();
        for (const [k, v] of Object.entries(all)) {
            if (now - v.at > CACHE_TTL_MS) delete all[k];
        }
        localStorage.setItem(CACHE_KEY, JSON.stringify(all));
    } catch {
        // storage full or unavailable: descriptions are fetched again next time
    }
}

function clean(text?: string): string | undefined {
    const t = text?.replace(/\r/g, "").replace(/[ \t]+/g, " ").replace(/\n{3,}/g, "\n\n").trim();
    return t || undefined;
}

function fromModInfo(info: ModInfo): Cached {
    const summary = clean(info.summary);
    let details = clean(info.description_plaintext);
    if (details && summary && details.replace(/\s+/g, " ").startsWith(summary.replace(/\s+/g, " "))) {
        details = clean(details.replace(/\s+/g, " ").slice(summary.replace(/\s+/g, " ").length));
    }
    if (details && details.length > DETAILS_MAX_CHARS) {
        details = details.slice(0, DETAILS_MAX_CHARS).replace(/\s+\S*$/, "") + " …";
    }
    return {summary, details, at: Date.now()};
}

function isModio(mod: DescribedMod): boolean {
    return mod.sourceType === "Modio";
}

function keyFor(mod: DescribedMod): string | undefined {
    if (isModio(mod)) {
        if ((mod.platformId ?? 0) > 0) return `modio:${mod.platformId}`;
        if (mod.nameId) return `modio-name:${mod.nameId}`;
        return undefined;
    }
    const link = RepositoryUpdates.linkForModSync({modId: mod.modId, url: mod.url});
    return link ? `repo:${link.repoId}|${link.slug}` : undefined;
}

function setEntry(key: string, entry: ModDescription, persist?: Cached) {
    entries.set(key, entry);
    if (persist) {
        readStored()[key] = persist;
        writeStored();
    }
    notify();
}

// mod.io ids requested within a short moment are fetched together
let pendingIds = new Set<number>();
let pendingTimer: ReturnType<typeof setTimeout> | undefined;

function flushModioBatch() {
    const ids = [...pendingIds];
    pendingIds = new Set();
    pendingTimer = undefined;
    if (ids.length === 0) return;
    ModioApi.getModInfoByIdListQuiet(ids).then(
        (infos) => {
            const found = new Set<number>();
            for (const info of infos) {
                found.add(info.id);
                const cached = fromModInfo(info);
                setEntry(`modio:${info.id}`, {state: "ready", summary: cached.summary, details: cached.details}, cached);
            }
            for (const id of ids) {
                if (!found.has(id)) setEntry(`modio:${id}`, {state: "ready"});
            }
        },
        (e) => {
            for (const id of ids) setEntry(`modio:${id}`, {state: "error", error: String(e?.message ?? e)});
        },
    );
}

function fetchFor(mod: DescribedMod, key: string) {
    entries.set(key, {state: "loading"});
    if (key.startsWith("modio:")) {
        pendingIds.add(mod.platformId!);
        if (!pendingTimer) pendingTimer = setTimeout(flushModioBatch, 40);
        return;
    }
    if (key.startsWith("modio-name:")) {
        ModioApi.getModInfoByNameQuiet(mod.nameId!).then(
            (info) => {
                const cached = info ? fromModInfo(info) : {at: Date.now()};
                setEntry(key, {state: "ready", summary: cached.summary, details: cached.details}, cached);
            },
            (e) => setEntry(key, {state: "error", error: String(e?.message ?? e)}),
        );
        return;
    }
    // repo:<repoId>|<slug>
    const [repoId, slug] = key.slice(5).split("|");
    RepositoryStore.get(repoId)
        .then(async (repo) => {
            if (!repo) return setEntry(key, {state: "ready"});
            const detail = await loadRepositoryDetail(repo.baseUrl, slug);
            let summary = clean(repositoryDescription(detail));
            if (summary && summary.length > DETAILS_MAX_CHARS) {
                summary = summary.slice(0, DETAILS_MAX_CHARS).replace(/\s+\S*$/, "") + " …";
            }
            const cached = {summary, at: Date.now()};
            setEntry(key, {state: "ready", summary}, cached);
        })
        .catch((e) => setEntry(key, {state: "error", error: String(e?.message ?? e)}));
}

export const ModDescriptions = {
    subscribe(listener: () => void): () => void {
        listeners.add(listener);
        return () => listeners.delete(listener);
    },

    version(): number {
        return version;
    },

    isEnabled(): boolean {
        return enabled;
    },

    async init(): Promise<void> {
        try {
            const settings = await StorageAPI.getSettings();
            enabled = (await settings.getValue(MOD_DESCRIPTION_HOVER_KEY)) === "true";
            notify();
        } catch {
            // keep the default (off)
        }
    },

    async setEnabled(value: boolean): Promise<void> {
        enabled = value;
        notify();
        const settings = await StorageAPI.getSettings();
        await settings.setValue(MOD_DESCRIPTION_HOVER_KEY, value ? "true" : "false");
    },

    /** Whether this mod can have a description (mod.io, or a local mod linked to a repository post) */
    describable(mod: DescribedMod, _repoLinksVersion: number): boolean {
        return !!keyFor(mod);
    },

    /** Current description; `_version` only makes callers re-read when the store changes */
    get(mod: DescribedMod, _version: number): ModDescription | undefined {
        const key = keyFor(mod);
        if (!key) return undefined;
        const live = entries.get(key);
        if (live) return live;
        const cached = readStored()[key];
        if (cached && Date.now() - cached.at <= CACHE_TTL_MS) {
            const entry: ModDescription = {state: "ready", summary: cached.summary, details: cached.details};
            entries.set(key, entry);
            return entry;
        }
        return undefined;
    },

    /** Loads the description unless it is known or already loading (errors are retried) */
    request(mod: DescribedMod): void {
        const key = keyFor(mod);
        if (!key) return;
        const current = ModDescriptions.get(mod, version);
        if (current && current.state !== "error") return;
        fetchFor(mod, key);
    },

    /** Loads descriptions for every mod.io mod in the list that isn't cached yet (a few requests) */
    prefetch(mods: DescribedMod[]): void {
        if (!enabled) return;
        for (const mod of mods) {
            if (isModio(mod) && (mod.platformId ?? 0) > 0) ModDescriptions.request(mod);
        }
    },
};
