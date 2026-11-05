import {message} from "antd";
import {t} from "i18next";
import {emitEvent} from "@/events";
import type {CompleteModData} from "@/storage/dao/ModDAO";
import {UserInfo} from "@/apis/modio/UserInfo.ts";
import {EventInfo} from "@/apis/modio/EventInfo.ts";
import {CacheApi} from "@/apis/CacheApi.ts";
import {DownloadApi} from "@/apis/DownloadApi.ts";
import {NetworkApi} from "@/apis/NetworkApi.ts";
import {IntegrateApi} from "@/apis/IntegrateApi.ts";
import {ModFile, ModInfo, Tags} from "@/apis/modio/ModInfo.ts";
import {TimeUtils} from "@/utils/TimeUtils.ts";
import {AuthResolver} from "@/services/network";

//const MODIO_API_URL = "https://api.mod.io/v1";
const MODIO_GAME_ID = 2475;
const MODIO_UID = "13595141";
const authResolver = new AuthResolver();

/** mod.io didn't take a change: readOnly (token without write access, or expired), inactive account, tooMany, other */
export class ModioWriteError extends Error {
    constructor(public readonly kind: 'readOnly' | 'inactive' | 'tooMany' | 'other', detail: string) {
        super(detail);
        this.name = 'ModioWriteError';
    }
}

export class ModioApi {
    private static platformIdByNameIdCache = new Map<string, number>();
    private static platformIdByNameIdInFlight = new Map<string, Promise<number>>();

    private static async getHost() {
        const modioUid = await authResolver.getModioUid(MODIO_UID);
        return `https://u-${modioUid}.modapi.io/v1`;
    }

    private static async getRequest(path: string) {
        let host = await ModioApi.getHost();
        let url = host + path;

        let resp = (await NetworkApi.request<Response>({
            service: 'modio.request',
            url,
            method: 'GET',
            authPolicy: 'modioToken',
            proxyPolicy: 'mintcatProxyFallback',
            parseAs: 'response',
        })).response;

        switch (resp.status) {
            case 200:
                return await resp.json();
            case 401:
                throw Error(`${t("mod.io Unauthorized")}`);
            case 404:
                throw Error(`${t("mod.io Not Found")}`);
            case 422:
                throw Error(`${t("mod.io Request Parameter Error")}: ${url}`);
            case 429:
                throw Error(`${t("mod.io Too Many Requests")}`);
            default:
                throw Error(`${t("mod.io Error")}: ${resp.status}`);
        }
    }

    /**
     * A change on mod.io for the signed-in account (subscribe, rate). Needs a token with write
     * access: a read-only token gets ModioWriteError('readOnly').
     */
    private static async writeRequest(method: 'POST' | 'DELETE', path: string, form: Record<string, string> = {}) {
        const url = (await ModioApi.getHost()) + path;
        const resp = (await NetworkApi.request<Response>({
            service: 'modio.write',
            url,
            method,
            authPolicy: 'modioToken',
            proxyPolicy: 'mintcatProxyFallback',
            headers: {'Content-Type': 'application/x-www-form-urlencoded', Accept: 'application/json'},
            body: new URLSearchParams(form).toString(),
            parseAs: 'response',
        })).response;
        if (resp.ok) return;
        let errorRef = 0;
        let detail = '';
        try {
            const data = await resp.json();
            errorRef = Number(data?.error?.error_ref ?? 0);
            detail = String(data?.error?.message ?? '');
        } catch {
            // no body
        }
        // already done: rated the same way / subscribed / nothing to take back
        if (errorRef === 15028 || errorRef === 15043) return;
        if (resp.status === 401) throw new ModioWriteError('readOnly', detail || `mod.io ${resp.status}`);
        if (resp.status === 403 && errorRef === 11006) throw new ModioWriteError('inactive', detail);
        if (resp.status === 429) throw new ModioWriteError('tooMany', detail);
        throw new ModioWriteError('other', detail || `mod.io ${resp.status}`);
    }

    /** All pages of a /me list for this game */
    private static async getAllOfMine<T>(path: string): Promise<T[]> {
        const result: T[] = [];
        for (let offset = 0; offset < 5000; offset += 100) {
            const data = await ModioApi.getRequest(`${path}${path.includes('?') ? '&' : '?'}game_id=${MODIO_GAME_ID}&_limit=100&_offset=${offset}`);
            const page = (data?.data ?? []) as T[];
            result.push(...page);
            if (page.length < 100 || result.length >= Number(data?.result_total ?? 0)) break;
        }
        return result;
    }

    /** Ids of this game's mods the account is subscribed to */
    public static async getMySubscribedIds(): Promise<number[]> {
        const mods = await ModioApi.getAllOfMine<{ id?: number; game_id?: number }>('/me/subscribed');
        return mods.filter(m => m.game_id == null || m.game_id === MODIO_GAME_ID).map(m => Number(m.id)).filter(id => id > 0);
    }

    /** The account's ratings of this game's mods: mod id → 1 (like) / -1 (dislike) */
    public static async getMyRatings(): Promise<Map<number, number>> {
        const ratings = await ModioApi.getAllOfMine<{ mod_id?: number; game_id?: number; rating?: number }>('/me/ratings');
        return new Map(ratings
            .filter(r => (r.game_id == null || r.game_id === MODIO_GAME_ID) && Number(r.mod_id) > 0 && r.rating)
            .map(r => [Number(r.mod_id), Number(r.rating)]));
    }

    public static async setSubscribed(modId: number, subscribed: boolean): Promise<void> {
        await ModioApi.writeRequest(subscribed ? 'POST' : 'DELETE', `/games/${MODIO_GAME_ID}/mods/${modId}/subscribe`);
    }

    /** 1 like, -1 dislike, 0 take the rating back */
    public static async setRating(modId: number, rating: 1 | -1 | 0): Promise<void> {
        await ModioApi.writeRequest('POST', `/games/${MODIO_GAME_ID}/mods/${modId}/ratings`, {rating: String(rating)});
    }

    /** What a mod needs, without messages (Browse Mods cards) */
    public static async getDependenciesQuiet(modId: number): Promise<{ id: number; name: string; nameId: string }[]> {
        const data = await ModioApi.getRequest(`/games/${MODIO_GAME_ID}/mods/${modId}/dependencies`);
        return ((data?.data ?? []) as any[])
            .map(d => ({id: Number(d.mod_id ?? d.id), name: String(d.name ?? ''), nameId: String(d.name_id ?? '')}))
            .filter(d => d.id > 0);
    }

    public static parseModLinks(link: string) {
        let regex = new RegExp('^https://mod\.io/g/drg/m/([^/#]+)');
        let match = link.match(regex);
        if (match !== null) {
            return match[1];
        }
    }

    /**
     * Resolve a mod.io link to its mod without showing any messages
     * (used to check links in the Add Mod box as they're typed).
     */
    public static async lookupModLink(url: string): Promise<
        | { status: 'found'; name: string }
        | { status: 'notFound' }
        | { status: 'invalid' }
        | { status: 'error'; message: string }
    > {
        const nameId = ModioApi.parseModLinks(url.trim());
        if (!nameId) {
            return {status: 'invalid'};
        }
        try {
            const data = await ModioApi.getRequest(`/games/${MODIO_GAME_ID}/mods?name_id=${encodeURIComponent(nameId)}`);
            const mod = data?.data?.[0];
            return mod ? {status: 'found', name: String(mod.name ?? nameId)} : {status: 'notFound'};
        } catch (e) {
            return {status: 'error', message: e instanceof Error ? e.message : String(e)};
        }
    }

    public static async getModInfoByLink(url: string): Promise<ModInfo> {
        const nameId = ModioApi.parseModLinks(url);
        if (nameId === undefined) {
            message.error(`${t("Invalid Mod Link")}: ${url}`);
            return;
        }
        const modData = await ModioApi.getModInfoByName(nameId);
        if (modData === undefined) {
            message.error(`${t("Mod Not Existed")}: ${url}`);
            return;
        }
        return modData;
    }

    public static async getUserInfo() {
        try {
            if (!(await authResolver.getModioToken())) {
                return undefined;
            }
            const path = "/me";
            const data = await ModioApi.getRequest(path);
            return data as UserInfo;
        } catch (e) {
            const msg = `${t("Fetch User Info Error")}: ${e}`;
            await emitEvent("modio-unauthorized", msg);
        }
    }

    public static async ping() {
        try {
            const path = "/ping";
            const data = await ModioApi.getRequest(path);
            if (data.code === 200)
                return true;
        } catch (_) {
        }
        return false;
    }

    public static async getModInfoByName(nameId: string): Promise<ModInfo> {
        try {
            const path = `/games/${MODIO_GAME_ID}/mods?name_id=${nameId}`;
            const data = await ModioApi.getRequest(path);
            if (data["data"].length === 0)
                return;
            else {
                return data["data"][0];
            }
        } catch (e) {
            message.error(`${t("Fetch Mod Info Error")}: ${e}`);
            throw e;
        }
    }

    /**
     * 通过 nameId 解析 mod.io 平台 ID，并对结果做缓存和并发去重。
     */
    public static async resolvePlatformIdByNameId(nameId: string): Promise<number> {
        const normalized = nameId?.trim();
        if (!normalized) return 0;

        const cached = this.platformIdByNameIdCache.get(normalized);
        if (cached && cached > 0) {
            return cached;
        }

        const inFlight = this.platformIdByNameIdInFlight.get(normalized);
        if (inFlight) {
            return await inFlight;
        }

        const request = (async () => {
            const modInfo = await ModioApi.getModInfoByName(normalized);
            const platformId = modInfo?.id || 0;
            if (platformId > 0) {
                this.platformIdByNameIdCache.set(normalized, platformId);
            }
            return platformId;
        })();

        this.platformIdByNameIdInFlight.set(normalized, request);
        try {
            return await request;
        } finally {
            this.platformIdByNameIdInFlight.delete(normalized);
        }
    }

    public static async getModInfoByNameList(
        nameIds: string[],
        batchSize: number = 20
    ): Promise<ModInfo[]> {
        try {
            const normalized = nameIds.filter(Boolean);
            if (normalized.length === 0) {
                return [];
            }

            const results: ModInfo[] = [];

            // 分批处理，避免 URL 过长和 API 限制
            for (let i = 0; i < normalized.length; i += batchSize) {
                const batch = normalized.slice(i, i + batchSize);
                const path = `/games/${MODIO_GAME_ID}/mods?name_id-in=${encodeURIComponent(batch.join(","))}`;
                const data = await ModioApi.getRequest(path);
                results.push(...(data.data as ModInfo[]));
            }

            return results;
        } catch (e) {
            message.error(`${t("Fetch Mod Info Error")}: ${e}`);
            throw e;
        }
    }

    /**
     * 通过 platformId（mod.io 的 id）批量获取 mod 信息
     * @param modIds mod.io 平台 ID 列表
     * @param batchSize 每批数量，默认 20
     */
    public static async getModInfoByIdList(
        modIds: number[],
        batchSize: number = 20
    ): Promise<ModInfo[]> {
        try {
            if (modIds.length === 0) {
                return [];
            }

            const results: ModInfo[] = [];

            // 分批处理，避免 URL 过长和 API 限制
            for (let i = 0; i < modIds.length; i += batchSize) {
                const batch = modIds.slice(i, i + batchSize);
                const path = `/games/${MODIO_GAME_ID}/mods?id-in=${batch.join(",")}`;
                const data = await ModioApi.getRequest(path);
                results.push(...(data.data as ModInfo[]));
            }

            return results;
        } catch (e) {
            message.error(`${t("Fetch Mod Info Error")}: ${e}`);
            throw e;
        }
    }

    /**
     * Mod infos for these mod.io ids, 100 per request. Errors go to the caller without a toast
     * (used for background work such as hover descriptions).
     */
    public static async getModInfoByIdListQuiet(modIds: number[]): Promise<ModInfo[]> {
        const results: ModInfo[] = [];
        for (let i = 0; i < modIds.length; i += 100) {
            const batch = modIds.slice(i, i + 100);
            const data = await ModioApi.getRequest(`/games/${MODIO_GAME_ID}/mods?id-in=${batch.join(",")}&_limit=100`);
            results.push(...((data?.data ?? []) as ModInfo[]));
        }
        return results;
    }

    /** Like getModInfoByName, without a toast on errors */
    public static async getModInfoByNameQuiet(nameId: string): Promise<ModInfo | undefined> {
        const data = await ModioApi.getRequest(`/games/${MODIO_GAME_ID}/mods?name_id=${encodeURIComponent(nameId)}`);
        return (data?.data ?? [])[0];
    }

    /**
     * 获取单个 mod 的标签（Get Mod Tags）
     * 列表接口可能不返回 tags，一键更新时需单独拉取以刷新标签
     * @see https://docs.mod.io/restapi/docs/get-mod-tags
     */
    public static async getModTags(platformModId: number): Promise<Tags[]> {
        try {
            const path = `/games/${MODIO_GAME_ID}/mods/${platformModId}/tags`;
            const data = await ModioApi.getRequest(path);
            const list = data?.data ?? [];
            if (!Array.isArray(list)) return [];
            return list.map((t: any) => ({
                name: t.name ?? "",
                name_localized: t.name_localized ?? t.name ?? "",
                date_added: t.date_added ?? 0
            }));
        } catch (e) {
            console.warn("[ModioApi] getModTags failed for mod", platformModId, e);
            return [];
        }
    }

    /**
     * 将 sortBy + sortOrder 映射为 mod.io Get Mods 的 _sort 值
     * @see https://docs.mod.io/restapiref/#get-mods
     */
    private static getModListSortParam(
        sortBy?: 'downloads' | 'subscribers' | 'rating' | 'date' | 'created' | 'name' | 'files',
        sortOrder?: 'asc' | 'desc'
    ): string | undefined {
        if (!sortBy || !sortOrder) return undefined;
        const desc = sortOrder === 'desc';
        const map: Record<string, string> = {
            date: desc ? '-date_updated' : 'date_updated',
            created: desc ? '-date_live' : 'date_live',
            downloads: desc ? '-downloads_total' : 'downloads_total',
            subscribers: desc ? '-subscribers_total' : 'subscribers_total',
            rating: desc ? '-ratings_weighted_aggregate' : 'ratings_weighted_aggregate',
            name: desc ? '-name' : 'name',
        };
        // a sort mod.io doesn't have (e.g. kept from another source): its default, recently updated
        return map[sortBy] ?? map.date;
    }

    public static async getModList(
        pageNo: number = 0,
        pageSize: number = 20,
        name: string = undefined,
        sortBy?: 'downloads' | 'subscribers' | 'rating' | 'date' | 'created' | 'name' | 'files',
        sortOrder?: 'asc' | 'desc'
    ): Promise<ModInfo[]> {
        try {
            const params = new URLSearchParams();
            params.set('_limit', String(pageSize));
            params.set('_offset', String(pageSize * pageNo));
            if (name) {
                params.set('name-lk', `*${name}*`);
            }
            const sortParam = ModioApi.getModListSortParam(sortBy, sortOrder);
            if (sortParam) {
                params.set('_sort', sortParam);
            }
            const path = `/games/${MODIO_GAME_ID}/mods?${params.toString()}`;
            const data = await ModioApi.getRequest(path);
            return data.data as ModInfo[];
        } catch (e) {
            message.error(`${t("Fetch Mod Info Error")}: ${e}`);
            return [];
        }
    }

    /** 获取当前用户订阅的 mod 列表（需已登录 mod.io） */
    public static async getSubscribedMods(pageNo: number = 0, pageSize: number = 100): Promise<ModInfo[]> {
        try {
            const path = `/me/subscribed?game_id=${MODIO_GAME_ID}&_limit=${pageSize}&_offset=${pageSize * pageNo}`;
            const data = await ModioApi.getRequest(path);
            return (data.data ?? data) as ModInfo[];
        } catch (e) {
            message.error(`${t("Fetch Subscribed Mods Error")}: ${e}`);
            return [];
        }
    }

    public static async getDependencies(modId: number) {
        try {
            const path = `/games/${MODIO_GAME_ID}/mods/${modId}/dependencies`;
            const data = await ModioApi.getRequest(path);
            return data.data as ModInfo[];
        } catch (e) {
            message.error(`${t("Fetch Dependence Error")}: ${e}`);
        }
    }

    public static async getEvents(dateAdded: number, modIds: string) {
        try {
            // 如果时间小 10 分钟，不请求
            if (TimeUtils.nowSeconds() - dateAdded < 10 * 60) {
                return [];
            }

            const event_type = ["MODFILE_CHANGED", "MOD_UNAVAILABLE", "MOD_DELETED"];
            const path = `/games/${MODIO_GAME_ID}/mods/events?mod_id-in=${modIds}&date_added-min=${dateAdded}&event_type-in=${event_type.join(",")}`;
            const data = await ModioApi.getRequest(path);
            return data.data as EventInfo[];
        } catch (e) {
            message.error(`${t("Fetch Events Error")}: ${e}`);
            return [];
        }
    }

    public static async getModFiles(modId: number) {
        try {
            const path = `/games/${MODIO_GAME_ID}/mods/${modId}/files`;
            const data = await ModioApi.getRequest(path);
            return data.data as ModFile[];
        } catch (e) {
            message.error(`${t("Fetch Events Error")}: ${e}`);
        }
    }

    /**
     * 下载 mod 文件。先用数据库中的下载地址尝试，失败（如链接过期）后再拉取最新 binary_url 重试一次。
     */
    public static async downloadModFile(modInfo: CompleteModData,
                                        onProgress?: (loaded: number, total: number) => void) {
        const fileName = `modio-${modInfo.platformId || modInfo.nameId}-${modInfo.nameId || modInfo.displayName}`;
        const version = modInfo.version?.currentVersion || "-";
        let fileSize = modInfo.download?.fileSize || 0;
        let downloadUrl = modInfo.download?.downloadUrl || "";

        // 数据库没有链接时必须先拉取一次
        if (!downloadUrl) {
            const freshInfo = await ModioApi.getModInfoByName(modInfo.nameId);
            if (freshInfo?.modfile?.download?.binary_url) {
                downloadUrl = freshInfo.modfile.download.binary_url;
                if (freshInfo.modfile.filesize) fileSize = freshInfo.modfile.filesize;
            } else {
                throw new Error(t("Fetch Mod Info Error") || "无法获取模组信息，请检查模组链接或网络");
            }
        }

        if (await CacheApi.checkCacheFile(fileName, version, fileSize)) {
            const cachePath = await CacheApi.getModCachePath(fileName, version);
            onProgress?.(fileSize, fileSize);
            return { ...modInfo, download: { ...modInfo.download!, cachePath, downloadProgress: 100 } };
        }

        const cachePath = await CacheApi.getModCachePath(fileName, version);
        // mod 文件可能较大或网络较慢，使用 15 分钟超时，减少 Download timeout
        const doDownload = (url: string) =>
            DownloadApi.downloadFile(
                url,
                cachePath,
                { resume: true, retryCount: 3, timeoutSecs: 900 },
                (downloaded, total) => onProgress?.(downloaded, total)
            );

        try {
            await doDownload(downloadUrl);
        } catch (firstError) {
            // 先用数据库地址试一次，失败后再获取最新链接重试（mod.io binary_url 会过期）
            const freshInfo = await ModioApi.getModInfoByName(modInfo.nameId);
            const freshUrl = freshInfo?.modfile?.download?.binary_url;
            if (freshUrl) {
                if (freshInfo.modfile.filesize) fileSize = freshInfo.modfile.filesize;
                await doDownload(freshUrl);
            } else {
                throw firstError;
            }
        }

        // Validate downloaded ZIP integrity
        if (!await IntegrateApi.validateZipFile(cachePath)) {
            const { remove } = await import('@tauri-apps/plugin-fs');
            try { await remove(cachePath); } catch (_) { /* best effort */ }
            throw new Error(`${t("Downloaded file is corrupted")}: ${modInfo.displayName}`);
        }

        onProgress?.(fileSize, fileSize);
        return { ...modInfo, download: { ...modInfo.download!, cachePath, downloadProgress: 100 } };
    }

}
