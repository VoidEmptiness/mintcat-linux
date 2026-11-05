/**
 * Update checks for local mods that come from a Pak Hub style repository.
 *
 * A local mod is "linked" to a repository post + file name. Links are made when a mod is
 * added from a repository, automatically by matching the mod's file name (in the background
 * when the list loads, and on the Update button), or by hand (right-click → Link to Pak Hub
 * post…, which also covers renamed files).
 *
 * Updating downloads the newest upload of that file into MintCat's data folder and points
 * the mod at it; a file of the user's own (outside that folder) is never modified.
 */
import {t} from "i18next";
import {appDataDir, join} from "@tauri-apps/api/path";
import {exists, mkdir, remove, rename, stat} from "@tauri-apps/plugin-fs";
import {
    ModRepository,
    RepositoryApi,
    RepositoryFile,
    RepositoryStore,
    safeModFileName,
} from "@/apis/repositories";
import {DownloadApi} from "@/apis/DownloadApi";
import {StorageAPI} from "@/storage";
import type {CompleteModData} from "@/storage/dao/ModDAO";
import {ModSourceType} from "@/models/mod/types";
import {emitEvent} from "@/events";
import {logActivity} from "@/services/ActivityLog";
import {loadRepositoryDetail} from "@/apis/repositories/details";

export interface RepositoryLink {
    repoId: string;
    slug: string;
    /** File name of the upload this mod corresponds to (as named on the repository) */
    filename: string;
    /** Upload the user has, when known */
    postedAt?: string;
    sizeBytes?: number;
    /** How the link was made */
    via: 'added' | 'auto' | 'manual';
}

export type RepositoryUpdateState =
    | { kind: 'upToDate' }
    | { kind: 'newer'; latest: RepositoryFile }      // a newer upload than the one you have
    | { kind: 'differs'; latest: RepositoryFile };   // your file matches no upload; latest may differ

interface LinkStoreData {
    byMod: Record<string, RepositoryLink>;
    /** Links for freshly downloaded files whose mod id isn't known yet */
    byPath: Record<string, RepositoryLink>;
    /** When a mod was last searched for without a match (to avoid searching every time) */
    noMatch: Record<string, number>;
    /** Version of the matching rules the noMatch entries were made with */
    matcher?: number;
    /** Mods the user unlinked by hand: never linked automatically again */
    unlinked?: Record<string, true>;
}

/** Bump when matching finds more, so mods that didn't match before are searched again */
const MATCHER_VERSION = 2;

const SETTINGS_KEY = 'repositoryModLinks';
const NO_MATCH_RECHECK_MS = 7 * 24 * 3600 * 1000;
const PARALLEL = 3;

let data: LinkStoreData | null = null;
const updates = new Map<number, RepositoryUpdateState>();
const listeners = new Set<() => void>();
let version = 0;

function notify() {
    version++;
    listeners.forEach(l => {
        try {
            l();
        } catch (e) {
            console.error('[RepositoryUpdates] listener failed', e);
        }
    });
}

async function load(): Promise<LinkStoreData> {
    if (data) return data;
    try {
        const settings = await StorageAPI.getSettings();
        const raw = await settings.getValue(SETTINGS_KEY);
        const parsed = raw ? JSON.parse(raw) : {};
        const current = (parsed.matcher ?? 1) >= MATCHER_VERSION;
        data = {
            byMod: parsed.byMod ?? {},
            byPath: parsed.byPath ?? {},
            noMatch: current ? parsed.noMatch ?? {} : {},
            matcher: MATCHER_VERSION,
            unlinked: parsed.unlinked ?? {},
        };
    } catch {
        data = {byMod: {}, byPath: {}, noMatch: {}, matcher: MATCHER_VERSION, unlinked: {}};
    }
    return data;
}

async function save(): Promise<void> {
    if (!data) return;
    const settings = await StorageAPI.getSettings();
    await settings.setValue(SETTINGS_KEY, JSON.stringify(data));
    notify();
}

function fileNameOf(p: string): string {
    return p.split(/[\\/]/).pop() || p;
}

function modPath(mod: CompleteModData): string {
    return mod.download?.cachePath || mod.url || "";
}

function modName(mod: CompleteModData): string {
    return mod.displayName || mod.originalName || fileNameOf(modPath(mod));
}

async function localSize(path: string): Promise<number | undefined> {
    try {
        return (await stat(path)).size;
    } catch {
        return undefined;
    }
}

async function runPool<T>(items: T[], worker: (item: T) => Promise<void>): Promise<void> {
    let next = 0;
    await Promise.all(Array.from({length: Math.min(PARALLEL, items.length)}, async () => {
        while (next < items.length) {
            await worker(items[next++]);
        }
    }));
}

/** Uploads of one file name in a post, newest first */
function uploadsOf(files: RepositoryFile[], filename: string): RepositoryFile[] {
    const key = filename.toLowerCase();
    return files.filter(f => f.filename.toLowerCase() === key);
}

/** Discord (where most repository posts come from) turns spaces in file names into underscores */
function looseName(filename: string): string {
    return filename.toLowerCase().replace(/[\s_]+/g, "_");
}

/**
 * Uploads in a post that are this file: the same name (any case), or the same name apart from
 * spaces/underscores when the size is identical too.
 */
function matchingUploads(files: RepositoryFile[], filename: string, size: number | undefined): RepositoryFile[] {
    const exact = uploadsOf(files, filename);
    if (exact.length > 0) return exact;
    if (size === undefined) return [];
    const loose = looseName(filename);
    const same = files.filter(f => looseName(f.filename) === loose);
    return same.some(f => f.sizeBytes === size) ? same : [];
}

/**
 * A file name without its version marker, to spot new versions uploaded under a new name:
 * "Anti-Asthma_v6.pak" → "anti-asthma", "DRAKIndicator_v0.1.1S.pak" → "drakindicator".
 * With `loose`, trailing digits count as a version too ("BetterTerminal3" → "betterterminal");
 * that is only used inside the post the mod is linked to.
 */
export function versionStem(filename: string, loose = false): string {
    let stem = filename.toLowerCase().replace(/\.(pak|zip|7z|rar)$/i, "");
    stem = stem.replace(/[\s_\-.]*\(?v(?:er(?:sion)?)?[\s_.]?\d+(?:[._]\d+)*[a-z]?\)?$/, "");
    stem = stem.replace(/^v\d+(?:[._]\d+)*[\s_\-]+/, "");
    stem = stem.replace(/[\s_\-]+\d+(?:[._]\d+)+$/, "");
    if (loose) stem = stem.replace(/[\s_\-]*\d+$/, "");
    return stem.replace(/[\s_\-]+/g, "_").replace(/^_+|_+$/g, "");
}

function postedTime(upload: { postedAt?: string }): number {
    return Date.parse(upload.postedAt ?? "") || 0;
}

/** One upload that could replace a local mod's file */
export interface UpdateCandidate {
    key: string;
    repoId: string;
    slug: string;
    postTitle: string;
    postUrl: string;
    upload: RepositoryFile;
    /** Same file name as the mod's file, or a new name that looks like a new version of it */
    renamed: boolean;
    /** In the post the mod is linked to, or found in another post */
    samePost: boolean;
    /** Uploaded by the same person as the version the user has (or the post's author) */
    sameUploader: boolean;
    /** Messages posted with this and the in-between versions, newest first */
    notes: { postedAt: string; postedBy: string; filename: string; text: string }[];
    /** Picked by default in the review */
    recommended: boolean;
}

export interface UpdateReview {
    mod: CompleteModData;
    link: RepositoryLink;
    current: {
        path: string;
        filename: string;
        size?: number;
        modifiedAt?: number;
        /** The upload the user has, when known */
        postedAt?: string;
        postedBy?: string;
    };
    /** Whether we know which upload the user has (otherwise the file just differs) */
    versionKnown: boolean;
    candidates: UpdateCandidate[];
}

const MAX_OTHER_POSTS = 4;

let autoLinkTimer: ReturnType<typeof setTimeout> | undefined;
let autoLinkRunning = false;
let autoLinkQueued: CompleteModData[] | null = null;

export const RepositoryUpdates = {
    /** Load links (call once at startup so menus know which mods are linked) */
    async init(): Promise<void> {
        await load();
        notify();
    },

    subscribe(listener: () => void): () => void {
        listeners.add(listener);
        return () => listeners.delete(listener);
    },

    version(): number {
        return version;
    },

    /** Synchronous lookup for menus/icons (after init) */
    linkForModSync(mod: { modId?: number; url?: string; download?: { cachePath?: string } }): RepositoryLink | undefined {
        if (!data) return undefined;
        return (mod.modId != null ? data.byMod[String(mod.modId)] : undefined)
            ?? data.byPath[mod.download?.cachePath || mod.url || ""];
    },

    updateState(modId: number): RepositoryUpdateState | undefined {
        return updates.get(modId);
    },

    /**
     * For components: pass the version from useSyncExternalStore so the React Compiler
     * recomputes when links/updates change (it caches calls whose inputs didn't change).
     */
    updateStateAt(modId: number, _version: number): RepositoryUpdateState | undefined {
        return updates.get(modId);
    },

    linkForModAt(mod: { modId?: number; url?: string; download?: { cachePath?: string } }, _version: number): RepositoryLink | undefined {
        return this.linkForModSync(mod);
    },

    async getLink(mod: CompleteModData): Promise<RepositoryLink | undefined> {
        const store = await load();
        const byMod = store.byMod[String(mod.modId)];
        if (byMod) return byMod;
        // A file downloaded from a repository before its mod existed: attach the link to the mod now
        const path = modPath(mod);
        const byPath = store.byPath[path];
        if (byPath && mod.modId != null) {
            store.byMod[String(mod.modId)] = byPath;
            delete store.byPath[path];
            await save();
        }
        return byPath;
    },

    /** Remember the repository post a freshly downloaded file came from */
    async rememberDownloadedFile(path: string, link: RepositoryLink): Promise<void> {
        const store = await load();
        store.byPath[path] = link;
        await save();
    },

    async setLink(modId: number, link: RepositoryLink): Promise<void> {
        const store = await load();
        store.byMod[String(modId)] = link;
        delete store.noMatch[String(modId)];
        delete store.unlinked?.[String(modId)];
        updates.delete(modId);
        await save();
    },

    /** How many mods are linked to posts of this repository (or were downloaded from it) */
    async linkCount(repoId: string): Promise<number> {
        const store = await load();
        return [...Object.values(store.byMod), ...Object.values(store.byPath)]
            .filter(link => link.repoId === repoId).length;
    },

    async removeLink(modId: number): Promise<void> {
        const store = await load();
        delete store.byMod[String(modId)];
        (store.unlinked ??= {})[String(modId)] = true;
        updates.delete(modId);
        await save();
    },

    /** Forget a downloaded file that was never added (or was deleted) */
    async forgetPath(path: string): Promise<void> {
        const store = await load();
        if (store.byPath[path]) {
            delete store.byPath[path];
            await save();
        }
    },

    /**
     * Find the post a local mod's file came from by its file name (see matchingUploads).
     * Returns the link, 'ambiguous' when several posts could be it, or undefined.
     */
    async autoMatch(mod: CompleteModData, repos: ModRepository[]): Promise<RepositoryLink | 'ambiguous' | undefined> {
        const filename = fileNameOf(modPath(mod));
        if (!safeModFileName(filename)) return undefined;
        const size = await localSize(modPath(mod));

        const candidates: Array<{ repo: ModRepository; slug: string; uploads: RepositoryFile[]; fileCount: number }> = [];
        for (const repo of repos) {
            const queries = [filename];
            if (/\s/.test(filename)) queries.push(filename.replace(/\s+/g, "_"));
            const seen = new Set<string>();
            for (const query of queries) {
                let list;
                try {
                    list = await RepositoryApi.listMods(repo, {query, page: 1});
                } catch {
                    continue;
                }
                for (const summary of list.mods.slice(0, 5)) {
                    if (seen.has(summary.slug)) continue;
                    seen.add(summary.slug);
                    try {
                        const detail = await loadRepositoryDetail(repo.baseUrl, summary.slug);
                        const uploads = matchingUploads(detail.files, filename, size);
                        if (uploads.length > 0) {
                            candidates.push({repo, slug: summary.slug, uploads, fileCount: detail.files.length});
                        }
                    } catch {
                        // skip unreadable posts
                    }
                }
                if (candidates.length > 0) break;
            }
        }
        if (candidates.length === 0) return undefined;

        const sizeMatches = (c: typeof candidates[number]) => size !== undefined && c.uploads.some(u => u.sizeBytes === size);
        let chosen = candidates.length === 1 ? candidates[0] : undefined;
        if (!chosen) {
            const exact = candidates.filter(sizeMatches);
            if (exact.length === 1) {
                chosen = exact[0];
            } else if (exact.length > 1) {
                // The same file in a post of its own and in a bundle post: the post of its own
                const fewest = Math.min(...exact.map(c => c.fileCount));
                const dedicated = exact.filter(c => c.fileCount === fewest);
                if (dedicated.length === 1) chosen = dedicated[0];
            }
            if (!chosen) return 'ambiguous';
        }
        const mine = size !== undefined ? chosen.uploads.find(u => u.sizeBytes === size) : undefined;
        return {
            repoId: chosen.repo.id,
            slug: chosen.slug,
            filename: (mine ?? chosen.uploads[0]).filename,
            postedAt: mine?.postedAt,
            sizeBytes: mine?.sizeBytes,
            via: 'auto',
        };
    },

    /**
     * Link the list's local mods to repository posts in the background (no downloads). Runs a
     * few seconds after the last call; mods searched without a match wait a week (or until the
     * matching rules improve) before being searched again.
     */
    scheduleAutoLink(mods: CompleteModData[]): void {
        autoLinkQueued = mods;
        clearTimeout(autoLinkTimer);
        autoLinkTimer = setTimeout(() => void this.runAutoLink(), 4000);
    },

    async runAutoLink(): Promise<number> {
        if (autoLinkRunning || !autoLinkQueued) return 0;
        const mods = autoLinkQueued;
        autoLinkQueued = null;
        autoLinkRunning = true;
        let linked = 0;
        try {
            const repos = await RepositoryStore.list();
            if (repos.length === 0) return 0;
            const store = await load();
            const todo = mods.filter(m => m.sourceType === ModSourceType.Local && m.modId != null
                && !store.byMod[String(m.modId)]
                && !store.unlinked?.[String(m.modId)]
                && Date.now() - (store.noMatch[String(m.modId)] ?? 0) >= NO_MATCH_RECHECK_MS);
            if (todo.length === 0) return 0;
            await runPool(todo, async (mod) => {
                try {
                    if (!(await exists(modPath(mod)))) return;
                    if (await this.getLink(mod)) return;
                    const match = await this.autoMatch(mod, repos);
                    if (!match || match === 'ambiguous') {
                        store.noMatch[String(mod.modId)] = Date.now();
                        if (match === 'ambiguous') {
                            await logActivity('info', t("repoUpdate.ambiguous", {name: modName(mod)}), modPath(mod), 'repository');
                        }
                        return;
                    }
                    await this.setLink(mod.modId!, match);
                    linked++;
                    await logActivity('info', t("repoUpdate.linked", {name: modName(mod)}),
                        RepositoryApi.modPageUrl(repos.find(r => r.id === match.repoId)!, match.slug), 'repository');
                } catch (error) {
                    console.warn('[RepositoryUpdates] auto link failed', error);
                }
            });
            await save();
            if (linked > 0) {
                await logActivity('success', t("repoUpdate.autoLinked", {count: linked}), undefined, 'repository');
            }
        } finally {
            autoLinkRunning = false;
            if (autoLinkQueued) this.scheduleAutoLink(autoLinkQueued);
        }
        return linked;
    },

    /** Compare the mod's file with the newest upload of its file on the repository */
    async check(mod: CompleteModData, link: RepositoryLink): Promise<RepositoryUpdateState> {
        const repo = await RepositoryStore.get(link.repoId);
        if (!repo) throw new Error(t("repo.notFound"));
        const detail = await RepositoryApi.getMod(repo, link.slug);
        const uploads = uploadsOf(detail.files, link.filename);
        if (uploads.length === 0) return {kind: 'upToDate'};
        const latest = uploads[0];
        const size = await localSize(modPath(mod));

        // Learn which upload the user has when the file matches one exactly
        if (!link.postedAt && size !== undefined) {
            const mine = uploads.find(u => u.sizeBytes === size);
            if (mine && mod.modId != null) {
                link.postedAt = mine.postedAt;
                link.sizeBytes = mine.sizeBytes;
                await this.setLink(mod.modId, link);
            }
        }

        let state: RepositoryUpdateState;
        if (link.postedAt) {
            const newer = (Date.parse(latest.postedAt) || 0) > (Date.parse(link.postedAt) || 0);
            state = newer ? {kind: 'newer', latest} : {kind: 'upToDate'};
        } else {
            state = size === latest.sizeBytes ? {kind: 'upToDate'} : {kind: 'differs', latest};
        }
        if (mod.modId != null) {
            if (state.kind === 'upToDate') updates.delete(mod.modId);
            else updates.set(mod.modId, state);
            notify();
        }
        return state;
    },

    /**
     * Download the given upload into MintCat's data folder and point the mod at it.
     */
    async apply(mod: CompleteModData, link: RepositoryLink, upload: RepositoryFile): Promise<void> {
        const name = safeModFileName(upload.filename);
        if (!name || mod.modId == null) throw new Error("invalid file");
        const dir = await join(await appDataDir(), "repository-mods", link.repoId, link.slug);
        await mkdir(dir, {recursive: true});
        const target = await join(dir, name);
        const temp = `${target}.download`;
        if (await exists(temp)) await remove(temp);
        // Download next to the target first, so a failed download never breaks the current file
        await DownloadApi.downloadFile(upload.downloadUrl, temp, {resume: false, retryCount: 2});
        await rename(temp, target);

        const info = await stat(target);
        const modsApi = await StorageAPI.getMods();
        const previousPath = modPath(mod);
        const changes: { url: string; displayName?: string } = {url: target};
        // A name that was just the old file name follows the new file name
        if (!mod.displayName || mod.displayName === fileNameOf(previousPath)) changes.displayName = name;
        await modsApi.updateMod(mod.modId, changes);
        await modsApi.upsertModDownload({modId: mod.modId, cachePath: target, fileSize: info.size, downloadProgress: 100});
        await modsApi.upsertModStatus({modId: mod.modId, lastUpdateDate: info.mtime?.getTime() ?? Date.now(), isLocalNotFound: false});

        await this.setLink(mod.modId, {...link, postedAt: upload.postedAt, sizeBytes: upload.sizeBytes});
        updates.delete(mod.modId);
        notify();

        // An earlier download with a different file name is no longer used
        if (previousPath && previousPath !== target && !(await modsApi.getModByUrl(previousPath))) {
            const {deleteRepositoryFile} = await import("@/services/RepositoryModCleanup");
            await deleteRepositoryFile(previousPath).catch(() => false);
        }

        const updated = await modsApi.getCompleteModData(mod.modId);
        if (updated) await emitEvent("mod-treeview-update", {modId: mod.modId, data: updated});
        await logActivity('success', t("repoUpdate.updated", {name: modName(mod), date: new Date(upload.postedAt).toLocaleString()}), target, 'repository');
    },

    /**
     * Everything that could replace a linked local mod's file: newer uploads of the same file in
     * its post, files in that post that look like a new version under a new name
     * (Anti-Asthma.pak → Anti-Asthma_v6.pak), and the same in other posts found by searching
     * the repository (only offered, never picked by default). Nothing is downloaded here.
     */
    async review(mod: CompleteModData, link: RepositoryLink, options: { searchOtherPosts?: boolean } = {}): Promise<UpdateReview | null> {
        const repo = await RepositoryStore.get(link.repoId);
        if (!repo) throw new Error(t("repo.notFound"));
        const path = modPath(mod);
        let size: number | undefined;
        let modifiedAt: number | undefined;
        try {
            const info = await stat(path);
            size = info.size;
            modifiedAt = info.mtime?.getTime();
        } catch {
            // file missing: still offer the upload
        }

        const detail = await RepositoryApi.getMod(repo, link.slug);
        const sameName = uploadsOf(detail.files, link.filename);

        // Learn which upload the user has when the file matches one exactly
        if (!link.postedAt && size !== undefined) {
            const mine = sameName.find(u => u.sizeBytes === size);
            if (mine && mod.modId != null) {
                link = {...link, postedAt: mine.postedAt, sizeBytes: mine.sizeBytes};
                await this.setLink(mod.modId, link);
            }
        }
        const mineUpload = link.postedAt
            ? sameName.find(u => u.postedAt === link.postedAt && (link.sizeBytes === undefined || u.sizeBytes === link.sizeBytes))
            : undefined;
        const myTime = link.postedAt ? postedTime(link) : 0;
        const originalUploader = (mineUpload ?? detail.files[detail.files.length - 1])?.postedBy ?? "";
        const strictStem = versionStem(link.filename);
        const looseStem = versionStem(link.filename, true);
        const versionKnown = !!link.postedAt;

        const review: UpdateReview = {
            mod,
            link,
            current: {path, filename: fileNameOf(path), size, modifiedAt, postedAt: link.postedAt, postedBy: mineUpload?.postedBy},
            versionKnown,
            candidates: [],
        };

        const notesFor = (uploads: RepositoryFile[]) => uploads
            .filter(u => u.postText && u.postText.trim())
            .map(u => ({postedAt: u.postedAt, postedBy: u.postedBy, filename: u.filename, text: u.postText!.trim()}))
            .filter((n, i, all) => all.findIndex(o => o.postedAt === n.postedAt && o.text === n.text) === i);

        const addFromPost = (slug: string, title: string, files: RepositoryFile[], samePost: boolean) => {
            const stemOf = (f: RepositoryFile) => samePost ? versionStem(f.filename, true) : versionStem(f.filename);
            const wanted = samePost ? looseStem : strictStem;
            if (!wanted) return;
            // Uploads of this mod in the post: same name, or same name apart from the version
            const related = files.filter(f => f.filename.toLowerCase() === link.filename.toLowerCase() || stemOf(f) === wanted);
            const newer = related.filter(f => versionKnown ? postedTime(f) > myTime : true);
            if (newer.length === 0) return;
            const best = newer[0]; // newest first
            if (!versionKnown && size !== undefined && best.sizeBytes === size) return; // same as the user's file
            // Another post with a file of exactly the user's size is almost always the same file
            // posted again (e.g. in a bundle post), not a new version
            if (!samePost && size !== undefined && best.sizeBytes === size) return;
            if (!versionKnown && samePost && best.filename.toLowerCase() !== link.filename.toLowerCase() && size !== undefined
                && related.some(f => f.sizeBytes === size && postedTime(f) >= postedTime(best))) return;
            const renamed = best.filename.toLowerCase() !== link.filename.toLowerCase();
            const sameUploader = !!originalUploader && best.postedBy === originalUploader;
            review.candidates.push({
                key: `${repo.id}|${slug}|${best.filename}|${best.postedAt}`,
                repoId: repo.id,
                slug,
                postTitle: title,
                postUrl: RepositoryApi.modPageUrl(repo, slug),
                upload: best,
                renamed,
                samePost,
                sameUploader,
                notes: notesFor(newer),
                recommended: samePost && versionKnown && (!renamed || sameUploader),
            });
        };

        addFromPost(link.slug, detail.name, detail.files, true);

        if (options.searchOtherPosts && strictStem.length >= 4) {
            try {
                const query = fileNameOf(link.filename).replace(/\.[^.]+$/, "").replace(/[\s_\-.]*\(?v\d+(?:[._]\d+)*[a-z]?\)?$/i, "");
                const list = await RepositoryApi.listMods(repo, {query, page: 1});
                const others = list.mods
                    .filter(m => m.slug !== link.slug)
                    // a post started before the user's version can only matter through later thread uploads
                    .filter(m => !versionKnown || postedTime(m) > myTime || m.threadFileCount > 0)
                    .slice(0, MAX_OTHER_POSTS);
                for (const other of others) {
                    try {
                        const otherDetail = await loadRepositoryDetail(repo.baseUrl, other.slug);
                        addFromPost(other.slug, otherDetail.name || other.name, otherDetail.files, false);
                    } catch {
                        // skip unreadable posts
                    }
                }
            } catch (error) {
                console.warn('[RepositoryUpdates] search for other posts failed', error);
            }
        }

        // Keep the newest per file name across posts; the linked post first
        review.candidates.sort((a, b) => Number(b.samePost) - Number(a.samePost) || postedTime(b.upload) - postedTime(a.upload));

        if (mod.modId != null) {
            // The list's update icon only for the linked post; other posts are only offered here
            const best = review.candidates.find(c => c.samePost);
            if (best) updates.set(mod.modId, versionKnown ? {kind: 'newer', latest: best.upload} : {kind: 'differs', latest: best.upload});
            else updates.delete(mod.modId);
            notify();
        }
        return review.candidates.length > 0 ? review : null;
    },

    /** Replace the mod's file with the chosen upload (the link follows it to its post/name) */
    async applyCandidate(review: UpdateReview, candidate: UpdateCandidate): Promise<void> {
        const link: RepositoryLink = {
            ...review.link,
            repoId: candidate.repoId,
            slug: candidate.slug,
            filename: candidate.upload.filename,
        };
        await this.apply(review.mod, link, candidate.upload);
    },

    /**
     * Update button: link unlinked local mods when possible and collect what could be updated.
     * Nothing is replaced here: the caller shows the review and applies what the user picks.
     */
    async checkAll(mods: CompleteModData[]): Promise<{ reviews: UpdateReview[]; linked: number; failed: number }> {
        const repos = await RepositoryStore.list();
        const result = {reviews: [] as UpdateReview[], linked: 0, failed: 0};
        if (repos.length === 0) return result;

        const store = await load();
        const localMods = mods.filter(m => m.sourceType === ModSourceType.Local && m.modId != null);

        await runPool(localMods, async (mod) => {
            try {
                if (!(await exists(modPath(mod)))) return;
                let link = await this.getLink(mod);
                if (!link) {
                    if (store.unlinked?.[String(mod.modId)]) return;
                    const lastMiss = store.noMatch[String(mod.modId)] ?? 0;
                    if (Date.now() - lastMiss < NO_MATCH_RECHECK_MS) return;
                    const match = await this.autoMatch(mod, repos);
                    if (match === 'ambiguous') {
                        await logActivity('info', t("repoUpdate.ambiguous", {name: modName(mod)}), modPath(mod), 'repository');
                        store.noMatch[String(mod.modId)] = Date.now();
                        return;
                    }
                    if (!match) {
                        store.noMatch[String(mod.modId)] = Date.now();
                        return;
                    }
                    link = match;
                    await this.setLink(mod.modId!, link);
                    result.linked++;
                    await logActivity('info', t("repoUpdate.linked", {name: modName(mod)}), RepositoryApi.modPageUrl(repos.find(r => r.id === link!.repoId)!, link.slug), 'repository');
                }
                const review = await this.review(mod, link, {searchOtherPosts: true});
                if (review) result.reviews.push(review);
            } catch (error) {
                result.failed++;
                await logActivity('error', t("repoUpdate.failed", {name: modName(mod), reason: String(error)}), modPath(mod), 'repository');
            }
        });
        await save();
        result.reviews.sort((a, b) => modName(a.mod).localeCompare(modName(b.mod)));
        return result;
    },

    /** Right-click → Update on a local mod: what could replace it (shown in the review) */
    async reviewOne(mod: CompleteModData): Promise<UpdateReview | 'upToDate' | 'notLinked'> {
        let link = await this.getLink(mod);
        if (!link) {
            const match = await this.autoMatch(mod, await RepositoryStore.list());
            if (!match || match === 'ambiguous') return 'notLinked';
            link = match;
            await this.setLink(mod.modId!, link);
        }
        return (await this.review(mod, link, {searchOtherPosts: true})) ?? 'upToDate';
    },

    modName(mod: CompleteModData): string {
        return modName(mod);
    },
};
