import {GameVersions, newestGameVersion} from "@/services/ListDisplay";
import {ModSourceType} from "@/models/mod/types";
import {TreeProps} from "antd";
import {ProfileTreeItem, ProfileTreeType} from "@/storage/db/Schema.ts";
import type {CompleteModData} from "@/storage/dao/ModDAO";
import type {ProfileModData} from "@/storage/dao/ProfileDAO";
import {activeFilters, type FilterEntry, type FilterProbe, matchesFilters, NO_PROBE, versionList} from "@/services/ModFilters";

/**
 * TreeViewConverter
 *
 * 职责：UI 数据格式转换
 * - 将 ProfileTreeItem (Domain Model) 转换为 AntD TreeView 格式
 * - 将 AntD TreeView 格式转换回 ProfileTreeItem
 * - 处理 UI 过滤逻辑
 *
 * Note: 这是一个纯粹的数据转换器，不包含业务逻辑
 */
export const FOLDER_COLOR_PREFIX = "path:";

export class TreeViewConverter {

    public static filterList?: string[] = [];

    /** Where the filters look up notes, marks, conflicts and Pak Hub posts (set by the search box) */
    public static probe: FilterProbe = NO_PROBE;

    /** Every mod of the profile in the last list built, filtered or not (the search box counts them) */
    public static profileEntries: FilterEntry[] = [];

    /** A search or filter is hiding part of the list */
    public static isFiltering(): boolean {
        return activeFilters(TreeViewConverter.filterList).length > 0;
    }

    /** Folder key ("folder-<id>") → folder color key, from the last list built */
    public static folderColorKeys: Record<string, string> = {};

    public treeData?: TreeProps['treeData'] = []
    public expandedKeys?: TreeProps['expandedKeys'] = [];
    private modList?: CompleteModData[];
    private profileModList?: ProfileModData[];

    public constructor(modList: CompleteModData[], profileModList?: ProfileModData[]) {
        this.modList = modList;
        this.profileModList = profileModList;
        // every list build (refresh, search, moves) knows the newest game version mod.io mods are tagged for
        const tagged = modList
            .filter(m => m.sourceType === ModSourceType.Modio)
            .flatMap(m => versionList(m.version?.availableVersions));
        const latest = newestGameVersion(tagged);
        if (latest !== GameVersions.latest()) {
            console.info(`[GameVersions] newest game version among mod.io mods: ${latest ?? 'none'} (${tagged.length} tags)`);
        }
        GameVersions.setLatest(latest);
    }

    // ====================================
    // 过滤逻辑
    // ====================================

    /**
     * Whether a mod is shown with the search box's filters (see services/ModFilters): picks from
     * the same group (e.g. Local + mod.io) widen the result; different groups and typed words
     * narrow it, so "mod.io" + "On" + "unified" finds enabled mod.io mods whose name contains
     * "unified". A typed word matches the name, the mod.io name id, a tag, the approval status
     * or your note (case-insensitive).
     */
    public static filter(modItem: CompleteModData, isEnabled: boolean, usedVersion?: string): boolean {
        return matchesFilters(TreeViewConverter.filterList, {mod: modItem, enabled: isEnabled, usedVersion}, TreeViewConverter.probe);
    }

    // ====================================
    // ProfileTreeItem -> AntD TreeView
    // ====================================

    /**
     * 将 ProfileTreeItem root 转换为 AntD TreeView 格式
     */
    public convertToFromRoot(root: ProfileTreeItem): TreeProps['treeData'] {
        TreeViewConverter.folderColorKeys = {};
        TreeViewConverter.profileEntries = [];
        const treeRoot = {
            key: "root",
            isLeaf: false,
            children: [],
        }
        this.buildTreeNode(treeRoot, root);
        this.treeData = treeRoot.children;
        return this.treeData;
    }

    /**
     * 递归构建 TreeView 节点
     */
    private buildTreeNode(parent: any, root: ProfileTreeItem, folderPath: string[] = []): void {
        for (const item of root.children) {
            if (item.type === ProfileTreeType.ITEM) {
                this.buildModNode(parent, item, folderPath);
            } else if (item.type === ProfileTreeType.FOLDER) {
                this.buildFolderNode(parent, item, folderPath);
            }
        }
    }

    /**
     * 构建 Mod 节点
     */
    private buildModNode(parent: any, item: ProfileTreeItem, folderPath: string[] = []): void {
        const modItem = this.modList?.find(m => m.modId === item.id);
        if (!modItem) {
            console.warn(`[TreeViewConverter] Mod item not found for id=${item.id}`);
            return;
        }

        // Find profile-specific data (enabled status, used version)
        const profileMod = this.profileModList?.find(pm => pm.modId === modItem.modId);
        const isEnabled = profileMod?.isEnabled ?? item.enabled;
        TreeViewConverter.profileEntries.push({mod: modItem, enabled: isEnabled, usedVersion: profileMod?.usedVersion || ""});

        if (!TreeViewConverter.filter(modItem, isEnabled, profileMod?.usedVersion || "")) {
            return; // 不满足过滤条件，跳过
        }

        const title = modItem.displayName || modItem.originalName || modItem.url || modItem.nameId || "Unknown";
        const key = `mod-${item.id}`;

        parent.children.push({
            key,
            modId: modItem.modId,
            platformId: modItem.platformId,  // Add platformId for mod.io API calls
            nameId: modItem.nameId || "",  // Add nameId for ModCat API calls
            profileModId: profileMod?.id,  // Add profile_mods.id for updates
            isLeaf: true,
            title,
            url: modItem.url || "",
            tags: (modItem.tags || []).filter(t => t !== 'RequiredByAll'),
            required: modItem.tags?.includes('RequiredByAll') || false,
            enabled: isEnabled,
            sourceType: modItem.sourceType,
            approval: modItem.approvalStatus,
            versions: versionList(modItem.version?.availableVersions),
            fileVersion: modItem.version?.currentVersion || "-",
            usedVersion: profileMod?.usedVersion || "",  // Use profile-specific used version
            downloadProgress: modItem.download?.downloadProgress || 100,
            lastUpdateDate: modItem.status?.lastUpdateDate || 0,
            onlineUpdateDate: modItem.status?.onlineUpdateDate || 0,
            onlineAvailable: modItem.status?.isOnlineAvailable ?? true,
            localNoFound: modItem.status?.isLocalNotFound ?? false,
            // Color keys of the folders this mod is in, outermost first (for folder colors)
            folderPath,
        });
    }

    /**
     * 构建文件夹节点
     */
    private buildFolderNode(parent: any, item: ProfileTreeItem, folderPath: string[] = []): void {
        const key = `folder-${item.id}`;
        this.expandedKeys.push(key);

        // Folder colors are stored by the folder's name path ("Cosmetics/Custom Icons"): saving
        // the list re-creates folders with new ids, so ids can't be used
        const parentPath = folderPath.length ? folderPath[folderPath.length - 1].slice(FOLDER_COLOR_PREFIX.length) : "";
        const colorKey = FOLDER_COLOR_PREFIX + (parentPath ? `${parentPath}/${item.name}` : item.name);
        TreeViewConverter.folderColorKeys[key] = colorKey;

        const node = {
            key,
            title: item.name,
            isLeaf: false,
            colorKey,
            children: [],
        }

        parent.children.push(node);
        this.buildTreeNode(node, item, [...folderPath, colorKey]); // 递归处理子节点
    }

    // ====================================
    // AntD TreeView -> ProfileTreeItem
    // ====================================

    /**
     * 将 AntD TreeView 数据转换回 ProfileTreeItem root
     */
    public convertFrom(treeData: any): ProfileTreeItem {
        const rootTreeData = {
            key: "root",
            isLeaf: false,
            children: treeData,
        }
        const rootProfile = new ProfileTreeItem(0, ProfileTreeType.FOLDER, "root");

        this.buildProfileTree(rootTreeData, rootProfile);
        return rootProfile;
    }

    /**
     * 递归构建 ProfileTree
     */
    private buildProfileTree(parent: any, root: ProfileTreeItem): void {
        if (!parent || !parent.children) {
            return;
        }

        for (const item of parent.children) {
            const id = this.extractIdFromKey(item.key);

            // 跳过无效的 ID
            if (id === 0 || isNaN(id)) {
                console.warn(`[TreeViewConverter] Skipping item with invalid ID:`, { key: item.key, title: item.title });
                continue;
            }

            if (item.isLeaf === true) {
                // Mod 节点，保留 enabled 状态和使用版本
                const isEnabled = item.enabled ?? true;
                const usedVersion = item.usedVersion ?? "";
                const newItem = new ProfileTreeItem(id, ProfileTreeType.ITEM, "", isEnabled, usedVersion);
                root.children.push(newItem);
            } else {
                // 文件夹节点
                const folder = new ProfileTreeItem(id, ProfileTreeType.FOLDER, item.title);
                root.children.push(folder);

                // 递归处理子项
                if (item.children && item.children.length > 0) {
                    this.buildProfileTree(item, folder);
                }
            }
        }
    }

    /**
     * 从 key 中提取 ID
     * 支持格式：
     * - "mod-123" -> 123
     * - "folder-456" -> 456
     * - "123" -> 123
     */
    private extractIdFromKey(key: string | number): number {
        if (typeof key === 'number') {
            return key;
        }

        if (typeof key === 'string') {
            const keyParts = key.split('-');
            if (keyParts.length > 1) {
                // 带前缀的 key: "mod-123" or "folder-456"
                const parsedId = parseInt(keyParts[1]);
                return isNaN(parsedId) ? 0 : parsedId;
            } else {
                // 无前缀的 key: "123"
                const parsedId = parseInt(key);
                return isNaN(parsedId) ? 0 : parsedId;
            }
        }

        return 0;
    }
}
