import {message} from "antd";
import {t} from "i18next";
import StatusBar from "@/components/StatusBar.tsx";
import {TreeViewModel} from "./TreeViewModel.ts";
import { IoC } from "@/core/IoC.ts";
import {BaseViewModel} from "@/core/BaseViewModel";
import {ProfileService} from "@/services/ProfileService.ts";
import {ClipboardApi} from "@/apis/ClipboardApi.ts";
import {
    HomeService,
    LastGroupCannotDeleteError,
    type AddModFromUrlResult,
    type AddModFromPathResult,
    type BatchAddModResult,
} from "@/services/HomeService.ts";
import type {ModInfo} from "@/apis/modio/ModInfo.ts";
import {NexusModsApi, showNexusModsApiKeyRequiredMessage} from "@/apis/nexusmods";
import {Downloads} from "@/services/Downloads";
import {logActivity, nameList} from "@/services/ActivityLog";
import {StorageAPI} from "@/storage";

/**
 * HomeViewModel handles mod operations and business logic
 * Manages mod adding, removing, updating, and dependency resolution
 */
export class HomeViewModel extends BaseViewModel {
    private homeService = new HomeService();

    constructor() {
        super();
    }

    /** A mod's name for the Log */
    private async modName(modId: number): Promise<string> {
        try {
            const mod = await (await StorageAPI.getMods()).getModById(modId);
            return mod?.displayName || mod?.originalName || `#${modId}`;
        } catch {
            return `#${modId}`;
        }
    }

    public async addModFromUrl(url: string, groupId: number): Promise<AddModFromUrlResult> {
        await StatusBar.log(t("Fetch Mod Info"), 'info');
        try {
            return await this.homeService.addModFromUrl(url, groupId);
        } catch (error) {
            console.error('Failed to add mod from URL:', error);
            const reason = error instanceof Error ? error.message : String(error);
            if (NexusModsApi.isAuthenticationRequiredError(error)) {
                showNexusModsApiKeyRequiredMessage();
                return { status: "invalid", error: reason };
            }
            message.error(t("error.addModToDatabase"));
            return { status: "invalid", error: reason };
        }
    }

    public async addModFromPath(modPath: string, groupId: number): Promise<AddModFromPathResult> {
        console.log(`[addModFromPath] Adding local mod: ${modPath}, groupId: ${groupId}`);
        try {
            const result = await this.homeService.addModFromPath(modPath, groupId);
            if (result.status === "missing") {
                console.log(`[addModFromPath] File does not exist: ${modPath}`);
                message.warning(t("Mod Path No Exists") + ": " + modPath);
            }
            return result;
        } catch (error) {
            console.error(`[addModFromPath] error.addModToDatabase: ${modPath}`, error);
            message.error(t("error.addModToDatabase"));
            return { status: "missing", modPath };
        }
    }

    public async addModsFromSubscribed(modInfos: ModInfo[], groupId: number,
                                       folderOf?: (modInfo: ModInfo) => number): Promise<BatchAddModResult> {
        await StatusBar.log(t("Fetch Mod Info"), 'info');
        try {
            return await this.homeService.addModsFromSubscribed(modInfos, groupId, folderOf);
        } catch (error) {
            console.error('Failed to batch add subscribed mods:', error);
            message.error(t("error.addModToDatabase"));
            return { addedCount: 0, existsCount: 0, errorCount: modInfos.length };
        }
    }

    public async removeMod(id: number): Promise<void> {
        const name = await this.modName(id);
        await this.homeService.removeModFromActiveProfile(id);
        await logActivity('info', t("log.list.removed", {name}), undefined, 'list');
        // its downloads go too when "Downloads of removed mods: delete" is chosen
        await Downloads.afterRemove([id]);
    }

    /** Remove several mods with one Log line (names looked up in one go) */
    public async removeMods(ids: number[]): Promise<void> {
        if (ids.length === 0) return;
        if (ids.length === 1) return this.removeMod(ids[0]);
        const names = await this.modNames(ids);
        await this.homeService.removeModsFromActiveProfile(ids);
        // their downloads go too when "Downloads of removed mods: delete" is chosen
        await Downloads.afterRemove(ids);
        await logActivity('info', t("log.list.removedMany", {count: ids.length}), nameList(names), 'list');
    }

    /** Display names of several mods in one query */
    private async modNames(ids: number[]): Promise<string[]> {
        try {
            const mods = await (await StorageAPI.getMods()).getBatchCompleteModDataOptimized(ids);
            const byId = new Map(mods.map(m => [m.modId, m.displayName || m.originalName || `#${m.modId}`]));
            return ids.map(id => byId.get(id) ?? `#${id}`);
        } catch {
            return ids.map(id => `#${id}`);
        }
    }

    public async setDisplayName(id: number, name: string): Promise<void> {
        const before = await this.modName(id);
        await this.homeService.updateModDisplayName(id, name);
        await logActivity('info', t("log.list.renamed", {from: before, to: name}), undefined, 'list');
    }
    /**
     * 设置 mod 启用状态
     * @param modId mod 的 ID
     * @param enable 是否启用
     * @param profileModId 可选的 profile_mods 表主键 ID，用于避免切换 profile 时的竞态条件
     */
    public async setModEnabled(modId: number, enable: boolean, profileModId?: number): Promise<void> {
        await this.homeService.setModEnabled(modId, enable, profileModId);
        await logActivity('info', t(enable ? "log.list.enabled" : "log.list.disabled", {name: await this.modName(modId)}), undefined, 'list');
    }

    /**
     * 批量设置 mod 启用状态（单条 SQL）
     */
    /** @param log false when the caller writes its own Log line */
    public async batchSetModEnabled(modIds: number[], enable: boolean, log = true): Promise<void> {
        await this.homeService.batchSetModEnabled(modIds, enable);
        if (!log || modIds.length === 0) return;
        // The Log line in the background: the list shouldn't wait for the name lookup
        void this.modNames(modIds)
            .then(names => logActivity('info', t(enable ? "log.list.enabledMany" : "log.list.disabledMany", {count: modIds.length}), nameList(names), 'list'))
            .catch(() => undefined);
    }

    public async setModUsedVersion(profileModId: number, version: string): Promise<void> {
        await this.homeService.setModUsedVersion(profileModId, version);
    }

    public async setGroupName(id: number, name: string): Promise<void> {
        const treeViewModel = await IoC.get(TreeViewModel);
        // the old name, before it changes
        const before = await treeViewModel.getGroupName(id).catch(() => undefined);
        await treeViewModel.setGroupName(id, name);
        await logActivity('info', t("log.list.folderRenamed", {from: before ?? "", to: name}), undefined, 'list');
    }

    public async getGroupName(id: number): Promise<string | undefined> {
        const treeViewModel = await IoC.get(TreeViewModel);
        return treeViewModel.getGroupName(id);
    }

    public async addGroup(parentGroupId: number, groupName: string): Promise<void> {
        await this.homeService.addGroup(parentGroupId, groupName);
        const parent = parentGroupId ? await this.getGroupName(parentGroupId) : undefined;
        await logActivity('info', parent ? t("log.list.subfolderAdded", {name: groupName, parent}) : t("log.list.folderAdded", {name: groupName}), undefined, 'list');
    }

    public async removeGroup(groupId: number): Promise<void> {
        console.log(`[HomeViewModel] removeGroup called with groupId=${groupId}`);


        const name = await this.getGroupName(groupId).catch(() => undefined);
        try {
            await this.homeService.removeGroup(groupId);
            await logActivity('info', t("log.list.folderDeleted", {name: name ?? `#${groupId}`}), undefined, 'list');
        } catch (error) {
            if (error instanceof LastGroupCannotDeleteError) {
                throw error;
            }
            console.error(`[HomeViewModel] Error removing group ${groupId}:`, error);
            throw error;
        }
    }

    /**
     * 清理本地文件不存在的 Local 类型 mod
     * @returns 清理的 mod 数量
     */
    public async cleanMissingLocalMods(): Promise<number> {
        const count = await this.homeService.cleanMissingLocalMods();
        await logActivity('info', t("log.list.cleanedMissing", {count}), undefined, 'list');
        return count;
    }

    /**
     * 导出当前 profile 的 mod.io URL 列表到剪贴板
     * @returns 是否成功导出
     */
    public async exportModioUrlsToClipboard(): Promise<boolean> {
        const profileService = await IoC.get(ProfileService);
        const urls = await profileService.getActiveProfileModioUrls();

        if (urls.length === 0) {
            message.warning(t("modio.noModsInCurrentProfile"));
            return false;
        }

        const list = urls.join("\n") + "\n";

        await ClipboardApi.writeText(list);
        message.success(t("Copied To Clipboard"));

        return true;
    }

    /**
     * Initialize HomeViewModel
     * No specific initialization needed for now
     */
    async initialize(): Promise<void> {
        this.initialized = true;
    }

}
