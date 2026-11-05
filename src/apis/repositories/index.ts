/**
 * User-added mod repositories (Pak Hub style sites, e.g. https://pak-hub.pages.dev).
 *
 * A repository exposes:
 *   GET <base>/api/mods?sort=newest&page=1&q=...  -> { mods: [...], total, page, pageSize }
 *   GET <base>/api/mods/<slug>                    -> { mod, initialPost, threadPosts }
 * where each post has files: [{ filename, sizeBytes, downloadUrl }].
 *
 * Requests go through the backend (fetch_repository_json) because these sites
 * don't send CORS headers for the app's webview.
 */
import {invoke} from '@tauri-apps/api/core';
import {StorageAPI} from '@/storage';

export type RepositoryGame = 'drg' | 'rc';

export interface ModRepository {
    id: string;
    name: string;
    baseUrl: string;
    game: RepositoryGame;
    type: 'pakhub';
}

export interface RepositoryModSummary {
    slug: string;
    name: string;
    summary: string;
    postedBy: string;
    postedAt: string;
    fileCount: number;
    threadFileCount: number;
}

export interface RepositoryModList {
    mods: RepositoryModSummary[];
    total: number;
    page: number;
    pageSize: number;
}

export interface RepositoryFile {
    filename: string;
    sizeBytes: number;
    downloadUrl: string;
    postedAt: string;
    postedBy: string;
    /** Posted in a follow-up thread message rather than the original post */
    fromThread: boolean;
    /** Newest upload of a file with this name in the post */
    latest: boolean;
    /** Text of the message the file was posted with (often change notes for a new version) */
    postText?: string;
}

export interface RepositoryModDetail {
    name: string;
    content: string;
    files: RepositoryFile[];
}

export type RepositorySort = 'newest' | 'oldest' | 'name' | 'name-desc' | 'most-files' | 'fewest-files';

const SETTINGS_KEY = 'customModRepositories';
/** Ids of removed repositories by address, so adding one again links its mods again */
const REMOVED_KEY = 'customModRepositoriesRemoved';

function str(value: unknown, fallback = ''): string {
    return typeof value === 'string' ? value : value == null ? fallback : String(value);
}

function num(value: unknown): number {
    const n = Number(value);
    return Number.isFinite(n) ? n : 0;
}

/** Turn "pak-hub.pages.dev/" or "https://x/index.html" into "https://x" */
export function normalizeRepositoryUrl(input: string): string {
    let value = input.trim();
    if (!value) throw new Error('empty');
    if (!/^https?:\/\//i.test(value)) value = `https://${value}`;
    const url = new URL(value);
    if (url.protocol !== 'https:' && url.protocol !== 'http:') throw new Error('protocol');
    let path = url.pathname.replace(/\/index\.html?$/i, '').replace(/\/api\/mods\/?$/i, '').replace(/\/+$/, '');
    return `${url.protocol}//${url.host}${path}`;
}

/** Keep only a plain file name; reject anything that isn't a .pak/.zip */
export function safeModFileName(filename: string): string | null {
    const base = filename.split(/[\\/]/).pop()?.trim() ?? '';
    const cleaned = base.replace(/[\u0000-\u001f<>:"|?*]/g, '_');
    if (!cleaned || cleaned === '.' || cleaned === '..') return null;
    return /\.(pak|zip)$/i.test(cleaned) ? cleaned : null;
}

async function fetchJson(url: string): Promise<any> {
    return await invoke('fetch_repository_json', {url});
}

function normalizeSummary(mod: any): RepositoryModSummary {
    return {
        slug: str(mod?.slug),
        name: str(mod?.name, 'Untitled'),
        summary: str(mod?.summary),
        postedBy: str(mod?.postedBy ?? mod?.posted_by, 'Unknown'),
        postedAt: str(mod?.postedAt ?? mod?.posted_at),
        fileCount: num(mod?.fileCount ?? mod?.file_count),
        threadFileCount: num(mod?.threadFileCount ?? mod?.thread_file_count),
    };
}

export const RepositoryApi = {
    async listMods(repo: ModRepository, options: { query?: string; page?: number; sort?: RepositorySort } = {}): Promise<RepositoryModList> {
        const params = new URLSearchParams({sort: options.sort ?? 'newest', page: String(options.page ?? 1)});
        const q = options.query?.trim();
        if (q) params.set('q', q);
        const data = await fetchJson(`${repo.baseUrl}/api/mods?${params}`);
        if (!data || !Array.isArray(data.mods)) {
            throw new Error('not-a-repository');
        }
        return {
            mods: data.mods.map(normalizeSummary).filter((m: RepositoryModSummary) => m.slug),
            total: num(data.total),
            page: num(data.page) || (options.page ?? 1),
            pageSize: num(data.pageSize) || 48,
        };
    },

    async getMod(repo: ModRepository, slug: string): Promise<RepositoryModDetail> {
        const data = await fetchJson(`${repo.baseUrl}/api/mods/${encodeURIComponent(slug)}`);
        const posts: Array<{ post: any; fromThread: boolean }> = [];
        if (data?.initialPost) posts.push({post: data.initialPost, fromThread: false});
        for (const post of Array.isArray(data?.threadPosts) ? data.threadPosts : []) {
            posts.push({post, fromThread: true});
        }

        const files: RepositoryFile[] = [];
        for (const {post, fromThread} of posts) {
            for (const file of Array.isArray(post?.files) ? post.files : []) {
                const downloadUrl = str(file?.downloadUrl);
                if (!/^https?:\/\//i.test(downloadUrl)) continue;
                files.push({
                    filename: str(file?.filename, 'mod.pak'),
                    sizeBytes: num(file?.sizeBytes),
                    downloadUrl,
                    postedAt: str(post?.postedAt),
                    postedBy: str(post?.postedBy, 'Unknown'),
                    fromThread,
                    latest: false,
                    postText: str(post?.content).slice(0, 2000),
                });
            }
        }
        // Newest first; mark the newest upload of each file name
        files.sort((a, b) => (Date.parse(b.postedAt) || 0) - (Date.parse(a.postedAt) || 0));
        const seen = new Set<string>();
        for (const file of files) {
            const key = file.filename.toLowerCase();
            if (!seen.has(key)) {
                file.latest = true;
                seen.add(key);
            }
        }
        return {
            name: str(data?.mod?.name, slug),
            content: str(data?.initialPost?.content),
            files,
        };
    },

    modPageUrl(repo: ModRepository, slug: string): string {
        return `${repo.baseUrl}/?mod=${encodeURIComponent(slug)}`;
    },
};

const listeners = new Set<() => void>();
let cache: ModRepository[] | null = null;

/** Sites offered as one-click adds in the repository manager */
export const SUGGESTED_REPOSITORIES: { name: string; url: string; game: RepositoryGame }[] = [
    {name: 'Pak Hub', url: 'https://pak-hub.pages.dev', game: 'drg'},
];

/** "https://pak-hub.pages.dev" -> "Pak Hub" (used when no name is typed) */
export function friendlyRepositoryName(baseUrl: string): string {
    try {
        const label = new URL(baseUrl).hostname.split('.')[0] ?? '';
        const words = label.split(/[-_]+/).filter(Boolean);
        if (words.length === 0) return new URL(baseUrl).host;
        return words.map(w => w.charAt(0).toUpperCase() + w.slice(1)).join(' ');
    } catch {
        return baseUrl;
    }
}

function slugify(value: string): string {
    return value.toLowerCase().replace(/[^a-z0-9]+/g, '-').replace(/^-+|-+$/g, '') || 'repo';
}

async function readRemoved(): Promise<Record<string, string>> {
    try {
        const raw = await (await StorageAPI.getSettings()).getValue(REMOVED_KEY);
        const parsed = raw ? JSON.parse(raw) : {};
        return parsed && typeof parsed === 'object' && !Array.isArray(parsed) ? parsed : {};
    } catch {
        return {};
    }
}

async function save(list: ModRepository[]): Promise<void> {
    const settings = await StorageAPI.getSettings();
    await settings.setValue(SETTINGS_KEY, JSON.stringify(list));
    cache = list;
    listeners.forEach(l => l());
}

export const RepositoryStore = {
    async list(): Promise<ModRepository[]> {
        if (cache) return cache;
        try {
            const settings = await StorageAPI.getSettings();
            const raw = await settings.getValue(SETTINGS_KEY);
            const parsed = raw ? JSON.parse(raw) : [];
            cache = Array.isArray(parsed)
                ? parsed.filter((r: any) => r && typeof r.id === 'string' && typeof r.baseUrl === 'string')
                    .map((r: any) => ({
                        id: r.id,
                        name: str(r.name, r.baseUrl),
                        baseUrl: r.baseUrl,
                        game: r.game === 'rc' ? 'rc' : 'drg',
                        type: 'pakhub',
                    } as ModRepository))
                : [];
        } catch (e) {
            console.warn('[RepositoryStore] could not read repositories', e);
            cache = [];
        }
        return cache;
    },

    /**
     * Validate (by loading its first page) and save a repository.
     */
    async add(input: { name: string; url: string; game: RepositoryGame }): Promise<ModRepository> {
        const baseUrl = normalizeRepositoryUrl(input.url);
        const list = await this.list();
        if (list.some(r => r.baseUrl.toLowerCase() === baseUrl.toLowerCase())) {
            throw new Error('duplicate');
        }
        const name = input.name.trim() || friendlyRepositoryName(baseUrl);
        // Added before: take its old id again (mods remember their repository by id)
        const removed = await readRemoved();
        const oldId = removed[baseUrl.toLowerCase()];
        let id = oldId && !list.some(r => r.id === oldId) ? oldId : slugify(name);
        let n = 2;
        while (list.some(r => r.id === id)) id = `${slugify(name)}-${n++}`;
        const repo: ModRepository = {id, name, baseUrl, game: input.game, type: 'pakhub'};
        await RepositoryApi.listMods(repo, {page: 1});
        await save([...list, repo]);
        return repo;
    },

    async remove(id: string): Promise<void> {
        const list = await this.list();
        const repo = list.find(r => r.id === id);
        if (repo) {
            const removed = await readRemoved();
            removed[repo.baseUrl.toLowerCase()] = repo.id;
            const settings = await StorageAPI.getSettings();
            await settings.setValue(REMOVED_KEY, JSON.stringify(removed));
        }
        await save(list.filter(r => r.id !== id));
    },

    /** Name of a repository from the already-loaded list (no waiting) */
    peekName(id: string): string | undefined {
        return cache?.find(r => r.id === id)?.name;
    },

    async get(id: string): Promise<ModRepository | undefined> {
        return (await this.list()).find(r => r.id === id);
    },

    subscribe(listener: () => void): () => void {
        listeners.add(listener);
        return () => listeners.delete(listener);
    },
};
