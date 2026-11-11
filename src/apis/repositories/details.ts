/**
 * Post details (full text and files) for repository browse results, loaded lazily per
 * card with a small number of requests at a time and cached for the session.
 */
import {useEffect, useState} from "react";
import {RepositoryApi, type ModRepository, type RepositoryModDetail, type RepositoryModSummary} from "./index";

const MAX_PARALLEL = 4;
const pending = new Map<string, Promise<RepositoryModDetail>>();
const loaded = new Map<string, RepositoryModDetail>();
const queue: (() => void)[] = [];
let running = 0;

function runLimited<T>(task: () => Promise<T>): Promise<T> {
    return new Promise<T>((resolve, reject) => {
        const start = () => {
            running++;
            task().then(resolve, reject).finally(() => {
                running--;
                queue.shift()?.();
            });
        };
        if (running < MAX_PARALLEL) start();
        else queue.push(start);
    });
}

function keyOf(baseUrl: string, slug: string): string {
    return `${baseUrl}|${slug}`;
}

export function loadRepositoryDetail(baseUrl: string, slug: string): Promise<RepositoryModDetail> {
    const key = keyOf(baseUrl, slug);
    const existing = pending.get(key);
    if (existing) return existing;
    const repo = {baseUrl} as ModRepository;
    const promise = runLimited(() => RepositoryApi.getMod(repo, slug));
    pending.set(key, promise);
    promise.then(
        (detail) => loaded.set(key, detail),
        () => pending.delete(key), // let a later card retry
    );
    return promise;
}

export function useRepositoryDetail(baseUrl?: string, slug?: string): RepositoryModDetail | undefined {
    const key = baseUrl && slug ? keyOf(baseUrl, slug) : "";
    const [detail, setDetail] = useState<RepositoryModDetail | undefined>(() => (key ? loaded.get(key) : undefined));
    useEffect(() => {
        if (!baseUrl || !slug) return;
        const cached = loaded.get(keyOf(baseUrl, slug));
        if (cached) {
            setDetail(cached);
            return;
        }
        let alive = true;
        loadRepositoryDetail(baseUrl, slug)
            .then((d) => alive && setDetail(d))
            .catch(() => {
                // the card keeps the short post title
            });
        return () => {
            alive = false;
        };
    }, [baseUrl, slug]);
    return detail;
}

/** "CustomColorEverything.pak" -> "CustomColorEverything"; several files -> "A, B +2" */
export function repositoryTitleFromFiles(detail: RepositoryModDetail | undefined): string | undefined {
    if (!detail) return undefined;
    const names: string[] = [];
    for (const file of detail.files) {
        if (!file.latest) continue;
        const stem = file.filename.replace(/\.(pak|zip)$/i, "");
        if (stem && !names.includes(stem)) names.push(stem);
    }
    if (names.length === 0) return undefined;
    const shown = names.slice(0, 2).join(", ");
    return names.length > 2 ? `${shown} +${names.length - 2}` : shown;
}

/** The post's text as one paragraph (line breaks and repeated spaces collapsed) */
export function repositoryDescription(detail: RepositoryModDetail | undefined): string | undefined {
    const text = detail?.content
        // Discord codes: custom emoji "<:engihead:9633…>" → ":engihead:", mentions → "@"
        ?.replace(/<a?:(\w+):\d+>/g, ":$1:")
        .replace(/<@[!&]?\d+>/g, "@")
        .replace(/<#\d+>/g, "#")
        .replace(/\s+/g, " ").trim();
    return text || undefined;
}

// ---------- finding a post from its Discord message ----------

/**
 * Pak Hub post slugs end with the Discord message id in base 36
 * ("egg-and-caretaker-desync-fixer-bwhxa3mmu7qo" ← message 1566656219777867952), so a Discord
 * link in a post can be matched to the post taken from that message. The repository's list is
 * read once per session for this (48 posts a page, up to 25 pages).
 */
export function messageIdSuffix(messageId: string): string {
    try {
        return BigInt(messageId).toString(36);
    } catch {
        return "";
    }
}

export function slugSuffix(slug: string): string {
    return slug.split("-").pop()?.toLowerCase() ?? "";
}

const MAX_INDEX_PAGES = 25;
/** Read again after this long, so posts added meanwhile are found too */
const INDEX_TTL_MS = 15 * 60_000;
const postIndexes = new Map<string, Promise<Map<string, RepositoryModSummary>>>();
const postIndexAt = new Map<string, number>();

function postIndex(baseUrl: string): Promise<Map<string, RepositoryModSummary>> {
    const existing = postIndexes.get(baseUrl);
    if (existing && Date.now() - (postIndexAt.get(baseUrl) ?? 0) < INDEX_TTL_MS) return existing;
    postIndexAt.set(baseUrl, Date.now());
    const promise = (async () => {
        const repo = {baseUrl} as ModRepository;
        const index = new Map<string, RepositoryModSummary>();
        for (let page = 1; page <= MAX_INDEX_PAGES; page++) {
            const list = await runLimited(() => RepositoryApi.listMods(repo, {page, sort: 'newest'}));
            for (const mod of list.mods) index.set(slugSuffix(mod.slug), mod);
            if (list.mods.length === 0 || page * (list.pageSize || 48) >= list.total) break;
        }
        return index;
    })();
    postIndexes.set(baseUrl, promise);
    promise.catch(() => postIndexes.delete(baseUrl));
    return promise;
}

/** The posts of this repository taken from these Discord messages (message id → post) */
export async function findPostsByMessageIds(baseUrl: string, messageIds: string[]): Promise<Map<string, RepositoryModSummary>> {
    const result = new Map<string, RepositoryModSummary>();
    if (messageIds.length === 0) return result;
    const index = await postIndex(baseUrl);
    for (const id of messageIds) {
        const post = index.get(messageIdSuffix(id));
        if (post) result.set(id, post);
    }
    return result;
}

/** Already loaded post details (no request) */
export function loadedRepositoryDetail(baseUrl: string, slug: string): RepositoryModDetail | undefined {
    return loaded.get(keyOf(baseUrl, slug));
}
