import {InstallOrder} from "@/services/ListDisplay";
import React from "react";
import {flushSync} from "react-dom";
import {Tree, TreeProps} from 'antd';
import type {CompleteModData} from "@/storage/dao/ModDAO";
import {StorageAPI} from "@/storage";
import {autoBind} from "@/utils/ReactUtils";
import {TreeViewModel} from "./TreeViewModel";
import {FOLDER_COLOR_PREFIX, TreeViewConverter} from "./TreeViewConverter";
import {ModListAppearance} from "@/services/ModListAppearance";
import {ProfileViewModel} from "@/dialogs/ProfileEditDialog/ProfileViewModel.ts";
import {TreeViewItem} from "./TreeViewItem";
import {dragAndDrop} from "./DragAndDropTree";
import {DragAutoScroll} from "./DragAutoScroll";
import {gatherAround, groupSpread, leavesInOrder, moveGroupToPosition, moveToPosition} from "./TreeMoves";
import {dissolveFolders, folderKeysInOrder, folderPath, moveFoldersInto, pickedFolders, topmost, withSubfolders} from "./FolderOps";
import {askBeforeMoving} from "@/dialogs/MoveConfirmDialog";
import {movedLines, placesOf} from "./MoveSummary";
import {logActivity, nameList} from "@/services/ActivityLog";
import {t} from "i18next";
import { IoC } from "@/core/IoC";
import type {ProfileModData} from "@/storage/dao/ProfileDAO";

/**
 * The active profile's per-mod settings (on/off, chosen version): a tree built without them
 * saves every mod's chosen version as "none"
 */
async function activeProfileMods(): Promise<ProfileModData[]> {
    try {
        const profiles = await StorageAPI.getProfiles();
        const profile = await profiles.getActiveProfile();
        return profile?.id ? await profiles.getProfileMods(profile.id) : [];
    } catch {
        return [];
    }
}

/** A folder's "Parent/Child" path in a tree, as folder colors are keyed (null when not a folder there) */
function folderPathOf(nodes: any[] | undefined, key: string, path: string[] = []): string | null {
    for (const node of nodes ?? []) {
        if (node.isLeaf) continue;
        const here = node.key === 'root' ? path : [...path, String(node.title ?? "")];
        if (node.key === key) return here.join("/");
        const found = folderPathOf(node.children, key, here);
        if (found) return found;
    }
    return null;
}

/** A node's name for the Log */
function titleOf(nodes: any[] | undefined, key: string): string {
    for (const node of nodes ?? []) {
        if (String(node.key) === key) return String(node.title ?? key);
        const found = titleOf(node.children, key);
        if (found !== key) return found;
    }
    return key;
}

/** Where a node ended up, for the Log: its install position (mods) and its folder */
async function logMove(treeAfter: any[], key: string, group: string[] | null, how: string): Promise<void> {
    try {
        const isMod = key.startsWith("mod-");
        const raw = isMod ? folderOfLeaf(treeAfter, key) : (folderPathOf(treeAfter, key) ?? "").split("/").slice(0, -1).join("/");
        const folder = raw === "\u0000" ? "" : raw;
        const where = folder || t("log.list.topLevel");
        if (group && group.length > 1) {
            const order = leavesInOrder(treeAfter).map(l => String(l.node.key));
            const position = order.indexOf(group[0]) + 1;
            await logActivity('info', t("log.list.movedGroup", {count: group.length, position, folder: where, how}),
                nameList(group.map(k => titleOf(treeAfter, k))), 'list');
        } else if (isMod) {
            const position = leavesInOrder(treeAfter).findIndex(l => String(l.node.key) === key) + 1;
            await logActivity('info', t("log.list.moved", {name: titleOf(treeAfter, key), position, folder: where, how}), undefined, 'list');
        } else {
            await logActivity('info', t("log.list.folderMoved", {name: titleOf(treeAfter, key), folder: where, how}), undefined, 'list');
        }
    } catch (e) {
        console.warn("[TreeView] could not log the move", e);
    }
}

/** The folder path a mod is in ("" at the top level) */
function folderOfLeaf(nodes: any[] | undefined, key: string, path: string[] = []): string {
    for (const node of nodes ?? []) {
        if (node.isLeaf) {
            if (String(node.key) === key) return path.join("/");
            continue;
        }
        const here = node.key === 'root' ? path : [...path, String(node.title ?? "")];
        const found = folderOfLeaf(node.children, key, here);
        if (found !== "\u0000") return found;
    }
    return "\u0000";
}

/** A moved folder keeps its color (and its subfolders' colors) at its new place */
async function carryFolderColors(key: string, before: string | null, treeAfter: any[]): Promise<void> {
    if (!before) return;
    const after = folderPathOf(treeAfter, key);
    if (after && after !== before) {
        await ModListAppearance.renameFolderKey(FOLDER_COLOR_PREFIX + before, FOLDER_COLOR_PREFIX + after);
    }
}


export interface FolderInfo {
    key: string;
    title: string;
}

export interface TreeViewProps {
    treeData?: TreeProps['treeData'];
    isMultiSelect?: boolean;
    expandedKeys?: any[];
    selectedKeys?: any[];
    checkedKeys?: any[];
    virtual?: boolean;
    height?: number;
    onMenuClick: (key: string, nodeKey: string) => void;
    onUpdateTreeView?: () => void;
    onCountLabelUpdate?: () => Promise<void>;
    onTreeNodeSelect?: (keys: any, info?: any) => void;
    onTreeNodeCheck?: (checkedKeys: any) => void;
    onTreeNodeExpand?: (keys: any) => void;
    onTreeRightClick?: (info: any) => void;
    onTreeRowClick?: (nodeKey: string, e: React.MouseEvent) => void;
    onVirtualStateChange?: (virtual: boolean) => void;
    onModListChange?: () => void;
}

export class TreeView extends React.Component<TreeViewProps> {
    private folderItemOrderMap = new Map<string, number>();
    /** treeData the folder list / per-folder numbers below were computed from */
    private derivedFrom: unknown = null;
    private folderListCache: FolderInfo[] = [];

    private readonly wrapperRef = React.createRef<HTMLDivElement>();
    private readonly treeRef = React.createRef<any>();
    private readonly autoScroll = new DragAutoScroll(
        () => this.wrapperRef.current?.querySelector<HTMLElement>(".ant-tree-list-holder") ?? null,
        top => flushSync(() => this.treeRef.current?.scrollTo?.(top)));

    componentWillUnmount() {
        this.autoScroll.stop();
    }

    private pickedCache: { treeData: unknown; checked: unknown; multi: boolean; keys: string[]; modIds: Map<string, number> } | null = null;

    /** Mods picked with Ctrl/Shift-click or checkboxes that the list shows, in list order */
    private pickedMods(): { keys: string[]; modIds: Map<string, number> } {
        const {treeData, checkedKeys, isMultiSelect} = this.props;
        const c = this.pickedCache;
        if (c && c.treeData === treeData && c.checked === checkedKeys && c.multi === !!isMultiSelect) return c;
        const raw: any = checkedKeys;
        const list: unknown[] = Array.isArray(raw) ? raw : (raw?.checked ?? []);
        const keys: string[] = [];
        const modIds = new Map<string, number>();
        if (isMultiSelect && list.length > 1) {
            const picked = new Set(list.map(String));
            for (const leaf of leavesInOrder(treeData as any[])) {
                const key = String(leaf.node.key);
                if (picked.has(key)) {
                    keys.push(key);
                    modIds.set(key, leaf.node.modId);
                }
            }
        }
        this.pickedCache = {treeData, checked: checkedKeys, multi: !!isMultiSelect, keys, modIds};
        return this.pickedCache;
    }

    /** The picked mods (in list order) when `key` is one of several, else null: they move together */
    private groupOf(key: string): string[] | null {
        const {keys} = this.pickedMods();
        return keys.length > 1 && keys.includes(key) ? keys : null;
    }

    /**
     * Picked mods from several folders moving together: a note when it's many of them or some
     * can't be seen (e.g. after Ctrl+A), as they all end up in one place and there is no undo
     */
    private groupMoveWarning(group: string[] | null): string | null {
        if (!group) return null;
        const {folders, hidden} = groupSpread(this.props.treeData as any[], group, this.props.expandedKeys ?? []);
        if (folders < 2 || (group.length <= 20 && hidden === 0)) return null;
        return hidden > 0
            ? t("list.moveGroupConfirmHidden", {count: group.length, folders, hidden})
            : t("list.moveGroupConfirm", {count: group.length, folders});
    }

    /**
     * Before saving a move: "Ask before moving" (Settings) shows where each goes; without it only
     * a big group move asks. `before` is where they were, `treeAfter` the tree after the move.
     */
    private async askMove(before: ReturnType<typeof placesOf>, treeAfter: any[], group: string[] | null): Promise<boolean> {
        const lines = movedLines(before, placesOf(treeAfter, [...before.keys()]));
        return askBeforeMoving(lines, this.groupMoveWarning(group),
            group ? t("list.moveGroupConfirmTitle", {count: group.length}) : undefined);
    }

    /** Dragging one of several picked mods: show how many go along */
    private setGroupDragImage(info: any) {
        const node = info?.node;
        const group = node?.isLeaf ? this.groupOf(String(node.key)) : null;
        const dataTransfer: DataTransfer | undefined = info?.event?.dataTransfer;
        if (!group || !dataTransfer?.setDragImage) return;
        const el = document.createElement("div");
        el.textContent = t("list.dragGroup", {count: group.length});
        el.style.cssText = "position:fixed;top:-1000px;left:0;padding:4px 12px;border-radius:6px;"
            + "background:#d4800f;color:#000;font:600 13px sans-serif;white-space:nowrap;";
        document.body.appendChild(el);
        try {
            dataTransfer.setDragImage(el, 14, 14);
        } finally {
            setTimeout(() => el.remove(), 0);
        }
    }

    shouldComponentUpdate(nextProps: TreeViewProps) {
        return (
            nextProps.treeData !== this.props.treeData ||
            nextProps.expandedKeys !== this.props.expandedKeys ||
            nextProps.selectedKeys !== this.props.selectedKeys ||
            nextProps.checkedKeys !== this.props.checkedKeys ||
            nextProps.isMultiSelect !== this.props.isMultiSelect ||
            nextProps.virtual !== this.props.virtual ||
            nextProps.height !== this.props.height
        );
    }

    /**
     * 从 treeData 中提取所有文件夹信息
     */
    private getFolderList(): FolderInfo[] {
        // Called for every row; the list only changes with treeData (also keeps the array
        // identity stable so memoized rows don't re-render)
        this.refreshDerived();
        return this.folderListCache;
    }

    /** Recompute the folder list and per-folder numbers when treeData changed */
    private refreshDerived(): void {
        if (this.derivedFrom === this.props.treeData) return;
        this.derivedFrom = this.props.treeData;
        this.folderListCache = this.collectFolderList();
        this.buildFolderItemOrderMap();
    }

    private collectFolderList(): FolderInfo[] {
        const folders: FolderInfo[] = [];
        
        // Subfolders are shown with their path ("Cosmetics / Custom Icons")
        const collectFolders = (nodes: any[], path: string[]) => {
            for (const node of nodes) {
                const isFolder = !node.isLeaf && node.key !== 'root';
                const nodePath = isFolder ? [...path, String(node.title ?? "")] : path;
                if (isFolder) {
                    folders.push({
                        key: node.key,
                        title: nodePath.join(" / ")
                    });
                }
                if (node.children) {
                    collectFolders(node.children, nodePath);
                }
            }
        };

        if (this.props.treeData) {
            collectFolders(this.props.treeData as any[], []);
        }

        return folders;
    }

    /**
     * 为每个文件夹下的叶子节点生成从 1 开始的序号
     */
    private buildFolderItemOrderMap(): void {
        this.folderItemOrderMap.clear();

        const assignOrder = (nodes: any[]) => {
            let currentIndex = 1;

            for (const node of nodes) {
                if (node.isLeaf) {
                    this.folderItemOrderMap.set(node.key, currentIndex);
                    currentIndex += 1;
                } else if (node.children) {
                    assignOrder(node.children);
                }
            }
        };

        if (this.props.treeData) {
            assignOrder(this.props.treeData as any[]);
        }
    }

    private getItemOrder(nodeKey: string): number | undefined {
        return this.folderItemOrderMap.get(nodeKey);
    }

    /**
     * 移动节点到指定文件夹（复用拖放逻辑）
     */
    @autoBind
    private async onMoveToFolder(sourceKey: string, targetFolderKey: string) {
        await IoC.get(TreeViewModel);
        const profileVM = await IoC.get(ProfileViewModel);
        const activeRoot = await profileVM.getActiveProfileTreeRoot();
        const modList = await this.getAllModsAsList();
        const converter = new TreeViewConverter(modList, await activeProfileMods());

        const filterList = TreeViewConverter.filterList;
        TreeViewConverter.filterList = [];
        const treeData = converter.convertToFromRoot(activeRoot);
        TreeViewConverter.filterList = filterList;

        // 查找源节点和目标文件夹节点
        const findNode = (nodes: any[], key: string): any | null => {
            for (const node of nodes) {
                if (node.key === key) {
                    return node;
                }
                if (node.children) {
                    const found = findNode(node.children, key);
                    if (found) return found;
                }
            }
            return null;
        };

        const targetNode = findNode(treeData, targetFolderKey);
        if (!targetNode) {
            console.error(`[TreeView] Target folder not found: ${targetFolderKey}`);
            return;
        }
        // A folder can't go into its own subfolder: taking it out would take the target with it,
        // and the folder and everything in it would drop out of the list
        const sourceNode = findNode(treeData, sourceKey);
        if (sourceNode?.children && findNode(sourceNode.children, targetFolderKey)) {
            console.warn(`[TreeView] Not moving ${sourceKey} into its own subfolder ${targetFolderKey}`);
            return;
        }

        // 构造一个模拟的拖放事件信息
        const mockInfo = {
            node: {
                key: targetFolderKey,
                pos: '0-0', // 简化的位置
                isLeaf: false
            },
            dragNode: {
                key: sourceKey
            },
            dropToGap: false, // 拖入文件夹内部
            dropPosition: 0
        };

        const pathBefore = folderPathOf(treeData, sourceKey);
        const placesBefore = placesOf(treeData, [sourceKey]);
        const dragTreeData = dragAndDrop(mockInfo, treeData);
        if (!(await this.askMove(placesBefore, dragTreeData, null))) return;

        try {
            const profileTreeItem = converter.convertFrom(dragTreeData);

            if (!profileTreeItem || profileTreeItem.children.length === 0) {
                return;
            }

            await profileVM.saveProfileTreeToDatabase(profileTreeItem);
            await carryFolderColors(sourceKey, pathBefore, dragTreeData);
            await logMove(dragTreeData, sourceKey, null, t("log.list.howMenu"));

            // rebuilding the list checks the Deploy button too; only without it ask for that alone
            if (this.props.onUpdateTreeView) await this.props.onUpdateTreeView();
            else this.props.onModListChange?.();
        } catch (error) {
            console.error(`[TreeView] Error during move to folder:`, error);
        }
    }

    /**
     * Move a mod so it gets install position `position` (1 = top of the whole list): it goes right
     * before the mod now at that position (moving up) or right after it (moving down), in that
     * mod's folder.
     */
    @autoBind
    private async onMoveToPosition(sourceKey: string, position: number, single = false, how?: string): Promise<boolean> {
        const order = InstallOrder.get();
        await IoC.get(TreeViewModel);
        const profileVM = await IoC.get(ProfileViewModel);
        const activeRoot = await profileVM.getActiveProfileTreeRoot();
        const converter = new TreeViewConverter(await this.getAllModsAsList(), await activeProfileMods());
        // Work on the whole list, not only what the search shows
        const filterList = TreeViewConverter.filterList;
        TreeViewConverter.filterList = [];
        const treeData = (converter.convertToFromRoot(activeRoot) ?? []) as any[];
        TreeViewConverter.filterList = filterList;

        // one of several picked mods: they all go, in their order
        const group = single ? null : this.groupOf(sourceKey);
        const placesBefore = placesOf(treeData, group ?? [sourceKey]);
        const folders = group
            ? moveGroupToPosition(treeData, order, group, position)
            : moveToPosition(treeData, order, sourceKey, position);
        if (!folders) return false;
        if (!(await this.askMove(placesBefore, treeData, group))) return false;
        const shownKey = group ? group[0] : sourceKey;

        try {
            const profileTreeItem = converter.convertFrom(treeData);
            if (!profileTreeItem || profileTreeItem.children.length === 0) return false;
            // open the folders it lands in, so it stays in view
            const expanded = (this.props.expandedKeys ?? []).map(String);
            const missing = folders.filter(k => !expanded.includes(k));
            if (missing.length > 0) this.props.onTreeNodeExpand?.([...expanded, ...missing]);

            await profileVM.saveProfileTreeToDatabase(profileTreeItem);
            await logMove(treeData, sourceKey, group, how ?? t("log.list.howNumber"));
            // rebuilding the list checks the Deploy button too; only without it ask for that alone
            if (this.props.onUpdateTreeView) await this.props.onUpdateTreeView();
            else this.props.onModListChange?.();
            // Highlight it, unless mods are being picked with checkboxes: a plain select would
            // end that and drop the picked mods
            if (!this.props.isMultiSelect) this.props.onTreeNodeSelect?.([sourceKey]);
            requestAnimationFrame(() => this.treeRef.current?.scrollTo?.({key: shownKey, align: "auto"}));
            return true;
        } catch (error) {
            console.error(`[TreeView] Error moving ${sourceKey} to position ${position}:`, error);
            return false;
        }
    }

    /** Move one mod right above another, so it wins the files they share; false if it couldn't */
    public async moveModAbove(modId: number, aboveId: number): Promise<boolean> {
        const order = InstallOrder.get();
        const from = order.indexOf(modId);
        const target = order.indexOf(aboveId);
        if (from < 0 || target < 0) return false;
        if (from < target) return true;
        const {treeData} = await this.fullTree();
        const leaf = leavesInOrder(treeData).find(l => l.node.modId === modId);
        if (!leaf) return false;
        return this.onMoveToPosition(String(leaf.node.key), target + 1, true, t("log.list.howConflict"));
    }

    /** Open the folders a mod is in, select it and scroll to it */
    public async revealMod(modId: number): Promise<boolean> {
        const {treeData} = await this.fullTree();
        const leaf = leavesInOrder(treeData).find(l => l.node.modId === modId);
        if (!leaf) return false;
        const key = String(leaf.node.key);
        const expanded = (this.props.expandedKeys ?? []).map(String);
        const missing = leaf.folders.filter(k => !expanded.includes(k));
        if (missing.length > 0) this.props.onTreeNodeExpand?.([...expanded, ...missing]);
        if (!this.props.isMultiSelect) this.props.onTreeNodeSelect?.([key]);
        // after the folders have opened
        requestAnimationFrame(() => requestAnimationFrame(() =>
            this.treeRef.current?.scrollTo?.({key, align: "auto"})));
        return true;
    }

    @autoBind
    private async onDrop(info: any) {
        this.autoScroll.stop();
        await IoC.get(TreeViewModel);
        const profileVM = await IoC.get(ProfileViewModel);
        const activeRoot = await profileVM.getActiveProfileTreeRoot();
        const modList = await this.getAllModsAsList();
        const converter = new TreeViewConverter(modList, await activeProfileMods());

        const filterList = TreeViewConverter.filterList;
        TreeViewConverter.filterList = [];
        const treeData = converter.convertToFromRoot(activeRoot);
        TreeViewConverter.filterList = filterList;

        // 修复：对于第一个文件夹的特殊处理
        // 当目标是文件夹（非叶子节点）且拖放到间隙但位置是0时，
        // 如果该节点是其父级中的第一个节点，应该视为拖入文件夹内部
        const dropNode = info.node;
        const dropPos = dropNode.pos.split('-');
        const nodeIndex = Number(dropPos[dropPos.length - 1]);
        
        // 如果目标是文件夹，且是第一个节点，且 dropPosition 在节点上方（0）
        // 则修正 dropToGap 为 false，视为拖入文件夹内部
        if (dropNode.isLeaf === false && 
            nodeIndex === 0 && 
            info.dropToGap && 
            info.dropPosition === 0) {
            // 创建修正后的 info 对象
            info = {
                ...info,
                dropToGap: false,
            };
        }

        const dragKey = String(info.dragNode?.key ?? "");
        const pathBefore = folderPathOf(treeData, dragKey);
        // one of several picked mods was dragged: the others come along, keeping their order
        const group = info.dragNode?.isLeaf ? this.groupOf(dragKey) : null;
        const placesBefore = placesOf(treeData, group ?? [dragKey]);
        const dragTreeData = dragAndDrop(info, treeData);
        if (group) gatherAround(dragTreeData, group, dragKey);
        if (!(await this.askMove(placesBefore, dragTreeData, group))) return;

        try {
            const profileTreeItem = converter.convertFrom(dragTreeData);

            if (!profileTreeItem || profileTreeItem.children.length === 0) {
                return;
            }

            const profileVM = await IoC.get(ProfileViewModel);
            await profileVM.saveProfileTreeToDatabase(profileTreeItem);
            await carryFolderColors(dragKey, pathBefore, dragTreeData);
            await logMove(dragTreeData, dragKey, group, t("log.list.howDrag"));

            // rebuilding the list checks the Deploy button too; only without it ask for that alone
            if (this.props.onUpdateTreeView) await this.props.onUpdateTreeView();
            else this.props.onModListChange?.();
        } catch (error) {
            console.error(`[TreeView] Error during drag and drop:`, error);
        }
    }

    @autoBind
    private onTreeNodeSelect(keys: any, info?: any) {
        if (this.props.onTreeNodeSelect) {
            this.props.onTreeNodeSelect(keys, info);
        }
    }

    @autoBind
    private onTreeNodeCheck(checkedKeys: any) {
        if (this.props.onTreeNodeCheck) {
            this.props.onTreeNodeCheck(checkedKeys);
        }
    }

    @autoBind
    private onTreeNodeExpand(keys: any) {
        if (this.props.onTreeNodeExpand) {
            this.props.onTreeNodeExpand(keys);
        }
    }

    @autoBind
    private onTreeRightClick(info: any) {
        if (this.props.onTreeRightClick) {
            this.props.onTreeRightClick(info);
        }
    }

    /** For a folder's menu: how many folders it acts on, and where they can't be moved */
    private folderPickFor(key: string): { count: number; exclude: string[] } | undefined {
        const {picked, top, exclude} = this.folderPick();
        // several folders (a folder ticked with its subfolders is still one)
        return top.length > 1 && picked.includes(key) ? {count: top.length, exclude} : undefined;
    }

    private folderPickCache: { treeData: unknown; checked: unknown; multi: boolean; picked: string[]; top: string[]; exclude: string[] } | null = null;

    /** Folders ticked as a whole (when several are), and those with their subfolders */
    private folderPick(): { picked: string[]; top: string[]; exclude: string[] } {
        const {treeData, checkedKeys, isMultiSelect} = this.props;
        const c = this.folderPickCache;
        if (c && c.treeData === treeData && c.checked === checkedKeys && c.multi === !!isMultiSelect) return c;
        const raw: any = checkedKeys;
        // not while a search hides part of the list (see HomePage.pickedFolderKeys)
        const picked = isMultiSelect && !TreeViewConverter.isFiltering()
            ? pickedFolders(treeData as any[], Array.isArray(raw) ? raw : (raw?.checked ?? [])) : [];
        const top = topmost(treeData as any[], picked);
        const exclude = top.length > 1 ? withSubfolders(treeData as any[], picked) : [];
        this.folderPickCache = {treeData, checked: checkedKeys, multi: !!isMultiSelect, picked, top, exclude};
        return this.folderPickCache;
    }

    /** The whole list as tree data (not only what the search shows) */
    public async fullTree(): Promise<{ treeData: any[]; converter: TreeViewConverter }> {
        await IoC.get(TreeViewModel);
        const profileVM = await IoC.get(ProfileViewModel);
        const activeRoot = await profileVM.getActiveProfileTreeRoot();
        const converter = new TreeViewConverter(await this.getAllModsAsList(), await activeProfileMods());
        const filterList = TreeViewConverter.filterList;
        TreeViewConverter.filterList = [];
        try {
            return {treeData: (converter.convertToFromRoot(activeRoot) ?? []) as any[], converter};
        } finally {
            TreeViewConverter.filterList = filterList;
        }
    }

    /** Save a changed tree; folders whose name path changed keep their colors */
    private async saveTree(treeData: any[], converter: TreeViewConverter, pathsBefore: Map<string, string>): Promise<boolean> {
        const profileTreeItem = converter.convertFrom(treeData);
        if (!profileTreeItem || profileTreeItem.children.length === 0) return false;
        const profileVM = await IoC.get(ProfileViewModel);
        await profileVM.saveProfileTreeToDatabase(profileTreeItem);
        // outer folders first: renaming a color key moves its subfolders' keys along
        const renamed: string[] = [];
        for (const key of folderKeysInOrder(treeData)) {
            const before = pathsBefore.get(key);
            const after = folderPath(treeData, key);
            if (!before || !after || before === after) continue;
            if (renamed.some(r => before.startsWith(r + "/"))) continue;
            await ModListAppearance.renameFolderKey(FOLDER_COLOR_PREFIX + before, FOLDER_COLOR_PREFIX + after);
            renamed.push(before);
        }
        // rebuilding the list checks the Deploy button too; only without it ask for that alone
        if (this.props.onUpdateTreeView) await this.props.onUpdateTreeView();
        else this.props.onModListChange?.();
        return true;
    }

    private static pathsOf(treeData: any[]): Map<string, string> {
        const out = new Map<string, string>();
        for (const key of folderKeysInOrder(treeData)) {
            const path = folderPath(treeData, key);
            if (path) out.set(key, path);
        }
        return out;
    }

    /**
     * Move folders into another folder (or to the top level: `target` null), with everything in
     * them. False when that's not possible (the target is one of them or inside one).
     */
    public async moveFolders(keys: string[], target: string | null): Promise<boolean | 'cancelled'> {
        const {treeData, converter} = await this.fullTree();
        const titles = new Map(keys.map(k => [k, titleOf(treeData, k)]));
        const before = TreeView.pathsOf(treeData);
        const placesBefore = placesOf(treeData, keys);
        const moved = moveFoldersInto(treeData, keys, target);
        if (!moved) return false;
        if (moved.length === 0) return true;
        if (!(await this.askMove(placesBefore, treeData, null))) return 'cancelled';
        if (!(await this.saveTree(treeData, converter, before))) return false;
        // the folders that moved (their subfolders went along)
        await logActivity('info', t("log.list.foldersMoved", {count: moved.length, folder: target ? titleOf(treeData, target) : t("log.list.topLevel")}),
            nameList(moved.map(k => titles.get(k) ?? k)), 'list');
        return true;
    }

    /** Delete folders but keep their mods: what was in each folder takes its place */
    public async dissolveFolders(keys: string[]): Promise<boolean> {
        const {treeData, converter} = await this.fullTree();
        const titles = new Map(keys.map(k => [k, titleOf(treeData, k)]));
        const before = TreeView.pathsOf(treeData);
        const gone = dissolveFolders(treeData, keys);
        if (gone.length === 0) return true;
        if (!(await this.saveTree(treeData, converter, before))) return false;
        await logActivity('info', t("log.list.foldersDissolved", {count: gone.length}), nameList(gone.map(k => titles.get(k) ?? k)), 'list');
        return true;
    }

    @autoBind
    private onCustomTitleRender(nodeData: any) {
        const folders = this.getFolderList();
        // Global install position (top of the whole list = 1 = wins conflicts); per-folder number as fallback
        const itemOrder = nodeData.isLeaf
            ? (InstallOrder.position(nodeData.modId) ?? this.getItemOrder(nodeData.key))
            : undefined;
        const group = nodeData.isLeaf ? this.groupOf(String(nodeData.key)) : null;
        const groupFirst = group ? InstallOrder.position(this.pickedMods().modIds.get(group[0]) ?? -1) : undefined;
        // 必须用 JSX 挂载子组件，不能 TreeViewItem(...) 函数调用，否则 Hooks 会在 antd Tree 内部 memo/effect 中执行，触发 “Do not call Hooks inside useEffect”
        return (
            <TreeViewItem
                nodeData={nodeData}
                onMenuClick={this.props.onMenuClick}
                onCountLabelUpdate={this.props.onCountLabelUpdate}
                folders={folders}
                onMoveToFolder={this.onMoveToFolder}
                onMoveToPosition={InstallOrder.position(nodeData.modId) !== undefined ? this.onMoveToPosition : undefined}
                itemOrder={itemOrder}
                groupSize={group?.length ?? 0}
                groupFirst={groupFirst}
                onRowClick={this.props.onTreeRowClick}
                expanded={nodeData.isLeaf ? undefined : (this.props.expandedKeys ?? []).map(String).includes(String(nodeData.key))}
                folderPick={nodeData.isLeaf ? undefined : this.folderPickFor(String(nodeData.key))}
            />
        );
    }
    /**
     * Helper method to get all mods from database as CompleteModData array
     */
    private async getAllModsAsList(): Promise<CompleteModData[]> {
        const modsApi = await StorageAPI.getMods();
        const allMods = await modsApi.getAllMods();
        const modIds = allMods.map(m => m.modId!);
        return await modsApi.getBatchCompleteModDataOptimized(modIds);
    }

    render() {
        this.refreshDerived();

        return (
            <div ref={this.wrapperRef}>
            <Tree
                ref={this.treeRef}
                className="ant-tree-content"
                blockNode
                draggable
                focusable={false}
                tabIndex={-1}
                // Stays virtual while dragging: turning it off (the old workaround for
                // ant-design#54610) rendered every row at drag start and on every drop-position
                // change, which made dragging stutter on long lists. DragAutoScroll scrolls the
                // list during a drag.
                virtual
                height={this.props.height ?? window.innerHeight - 145}
                checkable={this.props.isMultiSelect}
                expandedKeys={this.props.expandedKeys}
                selectedKeys={this.props.selectedKeys}
                checkedKeys={this.props.isMultiSelect ? this.props.checkedKeys : undefined}
                treeData={this.props.treeData}
                onCheck={this.onTreeNodeCheck}
                onSelect={this.onTreeNodeSelect}
                onRightClick={this.onTreeRightClick}
                onExpand={this.onTreeNodeExpand}
                onDrop={this.onDrop}
                onDragStart={info => {
                    this.autoScroll.start(info.event.target);
                    this.setGroupDragImage(info);
                }}
                titleRender={this.onCustomTitleRender}
            />
            </div>
        );
    }
}
