import {t} from "i18next";
import {emitVoidEvent, onceEvent} from "@/events";
import {ModioApi} from "@/apis/modio";
import {ModcatApi} from "@/apis/modcat";
import {NexusModsApi} from "@/apis/nexusmods";
import {captureNexusDownloadUrl, isNexusDownloadWindowClosed} from "@/apis/nexusmods/downloadWebview";
import {HomeViewModel} from "@/pages/HomePage/HomeViewModel.ts";
import { IoC } from "@/core/IoC.ts";
import {emitTo} from "@tauri-apps/api/event";
import {WebviewWindow} from "@tauri-apps/api/webviewWindow";
import {ClipboardApi} from "@/apis/ClipboardApi.ts";
import {AddModType} from "@/dialogs/AddModDialog/index.tsx";
import StatusBar from "@/components/StatusBar.tsx";
import {StorageAPI} from "@/storage";
import {asyncPoolAll} from "@/utils/AsyncPool";
import {message} from "antd";
import {frontendRouteUrl} from "@/utils/FrontendUpdateRuntime.ts";
import {ModUpdateService} from "@/services/ModUpdateService.ts";
import type {AddModFromUrlResult} from "@/services/HomeService.ts";
import {exists} from "@tauri-apps/plugin-fs";
import {path as tauriPath} from "@tauri-apps/api";
import {BackendRuntimeApi} from "@/apis/BackendRuntimeApi";
import {isModArchivePath, parseLocalPathLine, splitLines} from "@/utils/LocalModPaths";
import {ActivityLog, logActivity} from "@/services/ActivityLog";
import {DialogProfileService} from "@/services/DialogProfileService.ts";
import {folderFor} from "@/dialogs/AddModDialog/ItemFolders";
import type {ModInfo} from "@/apis/modio/ModInfo.ts";

let windowInstance: WebviewWindow;
/** Stops listening for the open window's OK/Cancel (a closed window must not leave its listeners) */
let stopListening: (() => void) | null = null;

function forgetDialogListeners() {
    stopListening?.();
    stopListening = null;
}

type AddModDialogInitData = {
    text: string;
    groupId: number;
    addModType: string;
    paths?: string[];
    revision?: number;
};

export async function openWindow(addModType: string = AddModType.LOCAL,
                                 groupId: number = 0,
                                 text: string = "",
                                 onUpdated?: () => Promise<void>,
                                 paths: string[] = []): Promise<void> {

    const vm = await IoC.get(HomeViewModel);

    // If the dialog is already open, it appends this text/paths instead of replacing
    const initData: AddModDialogInitData = {
        text,
        groupId,
        addModType,
        paths,
        revision: Date.now(),
    };

    const setInitData = (data: AddModDialogInitData) => {
        localStorage.setItem('add-mod-dialog-init-data', JSON.stringify(data));
    };

    const sendInitData = async () => {
        await emitTo('add-mod-dialog', "add-mod-dialog-init-data", initData);
    }

    setInitData(initData);

    if (windowInstance) {
        await sendInitData();
        await windowInstance.show();
        return;
    }

    windowInstance = new WebviewWindow('add-mod-dialog', {
        url: frontendRouteUrl(`/add_mod_dialog?init=${encodeURIComponent(JSON.stringify(initData))}`),
        width: 480,
        height: 640,
        title: t("Add Mod"),
        dragDropEnabled: true,
    });

    windowInstance.once('tauri://destroyed', () => {
        windowInstance = null;
        // closed with the window's X (or after OK/Cancel): the next window listens anew
        forgetDialogListeners();
    }).then();

    // listeners of an earlier window that never answered (shouldn't happen, but never twice)
    forgetDialogListeners();
    let unlistenClose: (() => void) | undefined;
    // ✅ 使用 onceEvent 自动管理类型安全
    const unlistenOk = await onceEvent('add-mod-dialog-ok', async (result) => {
        unlistenClose?.();
        // result.list 去重
        result.list = [...new Set(result.list)];
        let addProblems = 0;
        let addExists = 0;
        let addTotal = 0;
        // Each mod goes to the folder picked for it, else the dialog's folder
        const folders = await folderLabels();
        const validIds = new Set(folders.keys());
        // what the list had before, to tell mods this add brought in as another mod's dependency
        const before = await listedModIds();
        const place = (own: Record<string, number> | undefined) => (item: string): Placed => {
            const folderId = folderFor(own, item, result.groupId, validIds);
            return {folderId, folderName: folders.get(folderId)};
        };

        switch (result.addModType) {
            case AddModType.SUBSCRIBED: {
                const modInfoList: ModInfo[] = result.modInfoList ?? [];
                if (modInfoList.length > 0) {
                    const folderOf = place(result.subscribedFolders);
                    // one batch: every chosen mod goes in (to its folder) before any dependency
                    const {existsCount, errorCount} = await vm.addModsFromSubscribed(
                        modInfoList, result.groupId, m => folderOf(String(m.id)).folderId);
                    if (existsCount > 0) {
                        message.warning(t("Mod Already Exists") + ` (${existsCount} ${t("in current list")})`);
                    }
                    if (errorCount > 0) {
                        message.warning(t("mod.someFailedToAdd") + `: ${errorCount}/${modInfoList.length}`);
                    }
                }
                break;
            }
            case AddModType.ONLINE:
            case AddModType.LOCAL: {
                // Add everything gathered in both tabs (copied files and links can pile up together)
                const localList = [...new Set(result.localList
                    ?? (result.addModType === AddModType.LOCAL ? result.list : []))];
                const onlineList = [...new Set(result.onlineList
                    ?? (result.addModType === AddModType.ONLINE ? result.list : []))];

                const outcomes: AddOutcome[] = [];
                if (localList.length > 0) {
                    outcomes.push(await addLocalMods(vm, localList, place(result.localFolders)));
                }
                if (onlineList.length > 0) {
                    outcomes.push(await addOnlineMods(vm, onlineList, place(result.onlineFolders), before));
                }
                addProblems = outcomes.reduce((n, o) => n + o.problems, 0);
                addExists = outcomes.reduce((n, o) => n + o.exists, 0);
                addTotal = localList.length + onlineList.length;
            }
                break;
            default:
                break;
        }

        if (addProblems > 0) {
            // Say how many failed and show the Log with the exact links/files
            message.error(t("addMod.someFailed", {count: addProblems, total: addTotal}));
            ActivityLog.setOpen(true);
            await StatusBar.warning(t("addMod.finishedWithProblems", {count: addProblems}));
        } else {
            await StatusBar.success(t("Add Complete"));
        }
        if (addExists > 0) {
            message.warning(t("Mod Already Exists") + ` (${addExists} ${t("in current list")})`);
        }
        await emitVoidEvent('mods-added');
        if (onUpdated) {
            await onUpdated();
        }

        // (already gone if closed with its X while adding)
        await windowInstance?.close();
        windowInstance = null;
    });

    unlistenClose = await onceEvent('add-mod-dialog-close', async () => {
        unlistenOk();
        await windowInstance?.close();
        windowInstance = null;
    });
    stopListening = () => {
        unlistenOk();
        unlistenClose?.();
    };

}

type AddOutcome = { problems: number; exists: number };

/** Where one mod goes */
type Placed = { folderId: number; folderName?: string };

/** The active profile's folders: id → name as the folder lists show it ("Core / Sub") */
async function folderLabels(): Promise<Map<number, string>> {
    try {
        const choices = await new DialogProfileService().getActiveProfileFolderChoices();
        return new Map(choices.map(f => [f.id, f.label]));
    } catch (error) {
        console.warn('[AddModDialog] Could not read the folders', error);
        return new Map();
    }
}

/** The active profile's listed mod ids */
async function listedModIds(): Promise<{ profileId: number; ids: Set<number> } | null> {
    try {
        const profiles = await StorageAPI.getProfiles();
        const profile = await profiles.getActiveProfile();
        if (!profile?.id) return null;
        return {profileId: profile.id, ids: new Set((await profiles.getProfileMods(profile.id)).map(m => m.modId))};
    } catch {
        return null;
    }
}

/**
 * A link found "already in the list" although it wasn't before this add: another mod of the
 * same add brought it in as a dependency, into that mod's folder. Put it where it was meant to go.
 * True when the link's mod came in with this add.
 */
async function claimBroughtInMod(url: string, placed: Placed,
                                 before: { profileId: number; ids: Set<number> } | null): Promise<boolean> {
    if (!before) return false;
    try {
        const modsApi = await StorageAPI.getMods();
        const nameId = ModioApi.parseModLinks(url);
        const mod = (nameId ? await modsApi.getModByNameId(nameId, "Modio") : null) ?? await modsApi.getModByUrl(url);
        if (!mod?.modId || before.ids.has(mod.modId)) return false;
        const profiles = await StorageAPI.getProfiles();
        const listed = await profiles.getProfileMod(before.profileId, mod.modId);
        if (!listed?.id) return false;
        if (listed.parentFolderId !== placed.folderId) {
            await profiles.updateProfileMod(listed.id, {parentFolderId: placed.folderId});
        }
        return true;
    } catch (error) {
        console.warn('[AddModDialog] could not check where a dependency went', url, error);
        return false;
    }
}

function addedText(name: string, placed: Placed): string {
    return placed.folderName
        ? t("addMod.log.addedTo", {name, folder: placed.folderName})
        : t("addMod.log.added", {name});
}

type NexusModsParsedUrl = NonNullable<ReturnType<typeof NexusModsApi.parseModLinks>>;

function errorText(error: unknown): string {
    if (error instanceof Error) return error.message;
    if (typeof error === 'string') return error;
    try {
        return JSON.stringify(error);
    } catch {
        return String(error);
    }
}

function fileNameOf(p: string): string {
    const parts = p.split(/[\\/]/);
    return parts[parts.length - 1] || p;
}

/**
 * Add local files one by one, logging each outcome.
 * @returns how many could not be added / were already listed
 */
async function addLocalMods(vm: HomeViewModel, list: string[], placeOf: (item: string) => Placed): Promise<AddOutcome> {
    let problems = 0;
    let exists = 0;
    for (const item of list) {
        try {
            const placed = placeOf(item);
            const r = await vm.addModFromPath(item, placed.folderId);
            if (r.status === "added") {
                await logActivity('success', addedText(fileNameOf(item), placed), item, 'add-mod');
            } else if (r.status === "exists") {
                exists++;
                await logActivity('info', t("addMod.log.alreadyInList", {name: fileNameOf(item)}), item, 'add-mod');
            } else {
                problems++;
                await logActivity('error', t("addMod.log.fileNotFound"), item, 'add-mod');
            }
        } catch (error) {
            problems++;
            console.error('[AddModDialog] Failed to add local mod:', item, error);
            await logActivity('error', t("addMod.log.failed", {reason: errorText(error)}), item, 'add-mod');
        }
    }
    return {problems, exists};
}

async function logLinkResult(url: string, r: AddModFromUrlResult | undefined, placed: Placed,
                             before: { profileId: number; ids: Set<number> } | null = null): Promise<'added' | 'exists' | 'problem'> {
    const name = r?.modName || r?.mod?.displayName;
    if (r?.status === "added" || (r?.status === "exists" && await claimBroughtInMod(url, placed, before))) {
        await logActivity('success', addedText(name || url, placed), url, 'add-mod');
        return 'added';
    }
    if (r?.status === "exists") {
        await logActivity('info', t("addMod.log.alreadyInList", {name: name || url}), url, 'add-mod');
        return 'exists';
    }
    // The lookup itself failed (network, mod.io login...): say why instead of blaming the link
    if (r?.error) {
        await logActivity('error', t("addMod.log.failed", {reason: r.error}), url, 'add-mod');
        return 'problem';
    }
    // "invalid": the link isn't a mod link we understand, or no mod exists at it
    if (!isModLink(url)) {
        await logActivity('error', t("addMod.log.notAModLink"), url, 'add-mod');
    } else {
        await logActivity('error', t("addMod.log.modNotFound"), url, 'add-mod');
    }
    return 'problem';
}

/**
 * Add links, logging each outcome (added mod's name, already listed, not found, error).
 * @returns how many could not be added / were already listed
 */
async function addOnlineMods(vm: HomeViewModel, list: string[], placeOf: (item: string) => Placed,
                             before: { profileId: number; ids: Set<number> } | null): Promise<AddOutcome> {
    const directAddList: string[] = [];
    const nexusWebviewList: Array<{ url: string; parsed: NexusModsParsedUrl }> = [];

    for (const item of list) {
        const parsed = NexusModsApi.parseModLinks(item);
        // premium accounts download through the API: no Nexus window needed
        if (parsed && !await NexusModsApi.canDownloadWithoutVisit(item)) {
            nexusWebviewList.push({ url: item, parsed });
        } else {
            directAddList.push(item);
        }
    }

    const results: AddModFromUrlResult[] = [];
    let problems = 0;
    let exists = 0;
    const count = (outcome: 'added' | 'exists' | 'problem') => {
        if (outcome === 'problem') problems++;
        if (outcome === 'exists') exists++;
    };

    if (directAddList.length > 0) {
        const directResult = await asyncPoolAll(
            directAddList,
            async (item) => {
                try {
                    const placed = placeOf(item);
                    const r = await vm.addModFromUrl(item, placed.folderId);
                    count(await logLinkResult(item, r, placed, before));
                    return r;
                } catch (error) {
                    problems++;
                    await logActivity('error', t("addMod.log.failed", {reason: errorText(error)}), item, 'add-mod');
                    throw error;
                }
            },
            5
        );
        results.push(...directResult.results.filter(Boolean));
    }

    for (const item of nexusWebviewList) {
        try {
            const addModUrl = await captureNexusDownloadUrl(item.url, { parsed: item.parsed });
            // the folder picked for the link the user gave, not the download link found for it
            const placed = placeOf(item.url);
            const r = await vm.addModFromUrl(addModUrl, placed.folderId);
            count(await logLinkResult(item.url, r, placed, before));
            results.push(r);
        } catch (error) {
            if (isNexusDownloadWindowClosed(error)) {
                await logActivity('info', t("nexusmods.windowClosed"), item.url, 'add-mod');
                continue;
            }
            problems++;
            console.error('[AddModDialog] Failed to capture Nexus Mods download URL:', error);
            await logActivity('error', t("addMod.log.failed", {reason: errorText(error)}), item.url, 'add-mod');
        }
    }

    await downloadNexusModsAfterAdd(results);
    return {problems, exists};
}

async function downloadNexusModsAfterAdd(results: AddModFromUrlResult[]): Promise<void> {
    const nexusDownloadMods = results
        .filter((r) => r?.downloadAfterAdd && r.mod)
        .map((r) => r.mod!);
    if (nexusDownloadMods.length === 0) {
        return;
    }

    const { errors: downloadErrors } = await asyncPoolAll(
        nexusDownloadMods,
        async (mod) => {
            if (await ModUpdateService.needsOnlineModDownload(mod)) {
                await StatusBar.info(t("Batch downloading mod", { name: mod.displayName }));
                await ModUpdateService.updateModFile(mod);
            }
        },
        2
    );
    if (downloadErrors.length > 0) {
        message.warning(t("mod.someFailedToAdd") + `: ${downloadErrors.length}/${nexusDownloadMods.length}`);
    }
}

function isModLink(link: string): boolean {
    return !!ModioApi.parseModLinks(link)
        || ModcatApi.isModcatLink(link)
        || NexusModsApi.isNexusModsLink(link);
}

async function isUnpackedModDir(dirPath: string): Promise<boolean> {
    try {
        return await BackendRuntimeApi.invoke<boolean>('is_valid_unpacked_mod', {path: dirPath});
    } catch {
        return false;
    }
}

/**
 * Whether every copied link and file is already in the active profile's list. A link or file
 * MINTCAT doesn't know counts as not in it.
 */
async function allInList(links: string[], paths: string[]): Promise<boolean> {
    try {
        const profile = await (await StorageAPI.getProfiles()).getActiveProfile();
        if (!profile?.id) return false;
        const modsApi = await StorageAPI.getMods();
        const profiles = await StorageAPI.getProfiles();
        const inList = async (mod: { modId?: number } | null) =>
            !!mod?.modId && !!(await profiles.getProfileMod(profile.id!, mod.modId));
        for (const link of links) {
            const nameId = ModioApi.parseModLinks(link);
            const mod = (nameId ? await modsApi.getModByNameId(nameId, "Modio") : null)
                ?? await modsApi.getModByUrl(link);
            if (!(await inList(mod))) return false;
        }
        for (const p of paths) {
            if (!(await inList(await modsApi.getModByUrl(p)))) return false;
        }
        return true;
    } catch (error) {
        console.warn("[Clipboard] could not check the list", error);
        return false;
    }
}

/**
 * @param again the same text was copied again: only worth showing when something in it isn't
 *   in the list (e.g. the mod was removed since), not when a clipboard manager put it back
 */
async function onClipboardChange(text: string, again: boolean = false) {
    if (!text) {
        return;
    }
    const lines = splitLines(text);
    if (lines.length === 0) {
        return;
    }

    let homeDir: string | undefined;
    try {
        homeDir = await tauriPath.homeDir();
    } catch {
        homeDir = undefined;
    }

    // Every line must be a mod link or an existing local mod (.pak/.zip/unpacked folder);
    // anything else means the user copied something unrelated, so ignore it.
    const links: string[] = [];
    const paths: string[] = [];
    for (const line of lines) {
        if (isModLink(line)) {
            links.push(line);
            continue;
        }
        const localPath = parseLocalPathLine(line, homeDir);
        if (!localPath) {
            return;
        }
        // The game's own paks (copied when setting the game path) are not mods
        const normalized = localPath.replace(/\\/g, "/").toLowerCase();
        if (normalized.endsWith("/fsd-windowsnoeditor.pak")
            || normalized.includes("/fsd/content/paks/")
            || normalized.includes("/roguecore/content/paks/")) {
            return;
        }
        let present = false;
        try {
            present = await exists(localPath);
        } catch {
            present = false;
        }
        // A .pak/.zip path is taken even when nothing is there, so the dialog can show it as "Not found";
        // a folder must be an existing unpacked mod (otherwise this is unrelated clipboard text)
        if (!isModArchivePath(localPath) && !(present && await isUnpackedModDir(localPath))) {
            return;
        }
        paths.push(localPath);
    }

    if (links.length === 0 && paths.length === 0) {
        return;
    }
    if (again && await allInList(links, paths)) {
        console.info("[Clipboard] copied again, but already in the list:", text);
        return;
    }
    await logActivity('info', t(again ? "log.clipboard.copiedAgain" : "log.clipboard.copied", {count: links.length + paths.length}),
        [...links, ...paths].join(" · "), 'clipboard');

    const addModType = links.length > 0 ? AddModType.ONLINE : AddModType.LOCAL;
    openWindow(addModType, 0, links.join("\n"), undefined, paths).then();
}


export async function initClipboardWatcher() {
    const settings = await StorageAPI.getSettings();
    const enabled = await settings.getClipboardMonitorEnabled();
    if (enabled) {
        await ClipboardApi.setClipboardWatcher(onClipboardChange);
    } else {
        // 仍然注册回调，但不启动监控
        ClipboardApi.setClipboardWatcher(onClipboardChange).then(() => {
            ClipboardApi.stopClipboardWatcher();
        });
    }
}
