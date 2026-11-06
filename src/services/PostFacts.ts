/**
 * What the mod list shows about Pak Hub mods from their posts: who has to have the mod
 * ("Host only", "Client side", "Everyone needs it"), from the author's words. Read once per post
 * (2 posts at a time, in the background) and kept in MINTCAT's settings, refreshed after a week.
 */
import {StorageAPI} from "@/storage";
import {RepositoryStore} from "@/apis/repositories";
import {loadRepositoryDetail} from "@/apis/repositories/details";
import {analyzePostText, whoNeedsIt, type WhoNeedsIt} from "@/services/ModRequirements";
import {authorText} from "@/services/BrowseRequirements";

const SETTINGS_KEY = "repositoryPostFacts";
const REFRESH_MS = 7 * 24 * 60 * 60_000;
const PARALLEL = 2;

export interface PostFact {
    who?: WhoNeedsIt;
    /** The sentence it came from */
    sentence?: string;
    /** When it was read */
    at: number;
}

interface PostRef {
    repoId: string;
    slug: string;
}

let facts: Record<string, PostFact> | null = null;
let loading: Promise<void> | null = null;
const requested = new Set<string>();
const queue: PostRef[] = [];
let running = 0;
let saveTimer: ReturnType<typeof setTimeout> | null = null;
let version = 0;
const listeners = new Set<() => void>();

const keyOf = (ref: PostRef) => `${ref.repoId}:${ref.slug}`;

function notify() {
    version++;
    for (const listener of listeners) listener();
}

async function load(): Promise<void> {
    if (facts) return;
    if (loading) return loading;
    loading = (async () => {
        try {
            const settings = await StorageAPI.getSettings();
            const raw = await settings.getValue(SETTINGS_KEY);
            facts = raw ? JSON.parse(raw) : {};
        } catch {
            facts = {};
        }
        notify();
    })();
    return loading;
}

function scheduleSave() {
    if (saveTimer) return;
    saveTimer = setTimeout(async () => {
        saveTimer = null;
        try {
            const settings = await StorageAPI.getSettings();
            await settings.setValue(SETTINGS_KEY, JSON.stringify(facts ?? {}));
        } catch (error) {
            console.warn("[PostFacts] not saved", error);
        }
    }, 2000);
}

async function read(ref: PostRef): Promise<void> {
    const repo = await RepositoryStore.get(ref.repoId);
    if (!repo) return;
    const detail = await loadRepositoryDetail(repo.baseUrl, ref.slug);
    const who = whoNeedsIt(analyzePostText(authorText(detail)).notes);
    facts![keyOf(ref)] = {who: who?.who, sentence: who?.sentence, at: Date.now()};
    scheduleSave();
    notify();
}

function pump() {
    while (running < PARALLEL && queue.length > 0) {
        const ref = queue.shift()!;
        running++;
        read(ref)
            .catch(() => {
                // offline or the post is gone: asked again next launch
            })
            .finally(() => {
                running--;
                pump();
            });
    }
}

export const PostFacts = {
    subscribe(listener: () => void): () => void {
        listeners.add(listener);
        if (!facts) void load();
        return () => listeners.delete(listener);
    },

    version(): number {
        return version;
    },

    /**
     * What's known about a post (`_version` from useSyncExternalStore, so React Compiler-memoized
     * callers read it again). A post not read yet (or read over a week ago) is queued.
     */
    get(ref: PostRef | undefined, _version?: number): PostFact | undefined {
        if (!ref || !facts) return undefined;
        const key = keyOf(ref);
        const fact = facts[key];
        if ((!fact || Date.now() - fact.at > REFRESH_MS) && !requested.has(key)) {
            requested.add(key);
            queue.push(ref);
            // after the list has drawn
            setTimeout(pump, 1500);
        }
        return fact;
    },

    /** What's known about a post, without asking for it (the search box's counts look at every mod) */
    peek(ref: PostRef | undefined): PostFact | undefined {
        return ref && facts ? facts[keyOf(ref)] : undefined;
    },
};
