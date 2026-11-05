import {t} from "i18next";
import React, {useState, useSyncExternalStore} from "react";
import {Button, Dropdown, Flex, InputNumber, MenuProps, Popover, Select, Spin, Switch, Tag, theme, Tooltip} from "antd";
import {ModDescriptionHover} from "@/pages/HomePage/ModDescriptionHover";
import {BgColorsOutlined, CloseCircleFilled, CloudDownloadOutlined, DisconnectOutlined, FolderOpenOutlined, ThunderboltOutlined} from "@ant-design/icons";
import {ModListAppearance, readableTextOn} from "@/services/ModListAppearance";
import {
    ClockCircleOutlined,
    DeleteOutlined,
    DragOutlined,
    EditOutlined,
    ExclamationCircleOutlined,
    ExportOutlined,
    FolderAddOutlined,
    FolderOutlined,
    LinkOutlined,
    LockOutlined,
    PlusCircleOutlined,
    SyncOutlined,
    VerticalAlignTopOutlined,
    VerticalAlignMiddleOutlined,
    ColumnHeightOutlined,
    WarningOutlined,
    PlayCircleOutlined,
    PauseCircleOutlined,
    AimOutlined,
    FileTextOutlined,
} from "@ant-design/icons";
import {folderCounts} from "./FolderOps";
import {open} from "@tauri-apps/plugin-shell";
import {emitEvent, useFilteredEventListener} from "@/events";
import {ModSourceType} from "@/storage/db/Schema.ts";
import {MODCAT_PLATFORM, ModcatApi} from "@/apis/modcat";
import {NEXUSMODS_PLATFORM, NexusModsApi, type NexusModsFile} from "@/apis/nexusmods";
import {HomeViewModel} from "./HomeViewModel.ts";
import { IoC } from "@/core/IoC.ts";
import {ModioApi} from "@/apis/modio";
import {ModUpdateService} from "@/services/ModUpdateService.ts";
import {ModFile} from "@/apis/modio/ModInfo.ts";
import {StorageAPI} from "@/storage";
import StatusBar from "@/components/StatusBar.tsx";
import type {CompleteModData} from "@/storage/dao/ModDAO";
import {TimeUtils} from "@/utils/TimeUtils.ts";
import type {FolderInfo} from "./TreeView";
import {ConflictService, type ModConflictSummary} from "@/services/ConflictService";
import {ModConflictDetails} from "@/components/ConflictDetails";
import {SUMMARY_COLOR} from "@/services/ConflictInsights";
import {TreeViewConverter} from "./TreeViewConverter";
import {useInstallOrder, useShowLocalPaths} from "@/services/ListDisplay";
import {RepositoryUpdates} from "@/services/RepositoryUpdates";
import {logActivity} from "@/services/ActivityLog";
import {ModNotes} from "@/services/ModNotes";
import {ModSupport, nexusDomainOf} from "@/services/ModSupport";
import {editModNote, removeModNote} from "@/dialogs/ModNoteDialog";
import {handleSupportMenu, supportMenuItems} from "@/components/SupportButtons";
import {ModStatusIcons} from "./ModStatusIcons";
import {GameTag, StatusTags, TagList, UploadedDate, useRowInfo} from "./ModInfoColumns";

const {useToken} = theme;

// 模块级别的缓存，用于在虚拟列表滚动时保持 Switch 状态
const pendingEnabledChanges = new Map<number, boolean>();

// 模块级别的版本切换锁定，防止快速重复点击导致下载冲突
// key: modId, value: { isProcessing: boolean, abortController?: AbortController }
const versionSwitchLocks = new Map<number, { isProcessing: boolean; currentVersion?: string }>();

/** Number of mods this one shares files with (null if none); `_version` as for summarizeConflicts */
function conflictCountAt(modId: number, _version: number): number | null {
    return ConflictService.getConflict(modId)?.conflictingMods.length ?? null;
}

/** Conflict summary for a row; `_version` makes conflict data changes a compiler dependency */
function summarizeConflicts(modId: number, order: number[], _version: number): ModConflictSummary {
    return ConflictService.summarize(modId, order);
}

export function getVersionSwitchLock(modId: number): { isProcessing: boolean; currentVersion?: string } {
    return versionSwitchLocks.get(modId) || { isProcessing: false };
}

export function setVersionSwitchLock(modId: number, lock: { isProcessing: boolean; currentVersion?: string }): void {
    versionSwitchLocks.set(modId, lock);
}

export function clearVersionSwitchLock(modId: number): void {
    versionSwitchLocks.delete(modId);
}

export function getPendingEnabled(modId: number, defaultValue: boolean): boolean {
    return pendingEnabledChanges.has(modId)
        ? pendingEnabledChanges.get(modId)!
        : defaultValue;
}

export function setPendingEnabled(modId: number, value: boolean): void {
    pendingEnabledChanges.set(modId, value);
}

export function clearPendingEnabled(modId?: number): void {
    if (modId !== undefined) {
        pendingEnabledChanges.delete(modId);
    } else {
        pendingEnabledChanges.clear();
    }
}

// 模块级别的「待定版本」缓存，用于在滚动后 treeData 未刷新时保持版本选择框显示正确
const pendingUsedVersion = new Map<number, string>();

export function getPendingUsedVersion(modId: number, defaultValue: string): string {
    return pendingUsedVersion.has(modId) ? pendingUsedVersion.get(modId)! : defaultValue;
}

export function setPendingUsedVersion(modId: number, value: string): void {
    pendingUsedVersion.set(modId, value);
}

export function clearPendingUsedVersion(modId?: number): void {
    if (modId !== undefined) {
        pendingUsedVersion.delete(modId);
    } else {
        pendingUsedVersion.clear();
    }
}

// 模块级别的「待定版本锁定」缓存，用于在滚动后 treeData 未刷新时保持锁定图标显示
const pendingVersionLocked = new Map<number, boolean>();

export function getPendingVersionLocked(modId: number, defaultValue: boolean): boolean {
    return pendingVersionLocked.has(modId) ? pendingVersionLocked.get(modId)! : defaultValue;
}

export function setPendingVersionLocked(modId: number, value: boolean): void {
    pendingVersionLocked.set(modId, value);
}

export function clearPendingVersionLocked(modId?: number): void {
    if (modId !== undefined) {
        pendingVersionLocked.delete(modId);
    } else {
        pendingVersionLocked.clear();
    }
}

// 模块级别缓存：警告图标状态（过期/本地缺失/在线不可用/冲突），避免滚动后图标消失或错乱
interface WarningState {
    isExpired: boolean;
    isLocalNoFound: boolean;
    isOnlineUnavailable: boolean;
    hasConflict: boolean;
}
const warningStateCache = new Map<number, WarningState>();
/** The row data each cached state was computed from (see the effect in ModTreeViewWarring) */
const warningBasisCache = new Map<number, string>();

export function getCachedWarningState(modId: number, fallback: WarningState): WarningState {
    return warningStateCache.get(modId) ?? fallback;
}

export function setCachedWarningState(modId: number, state: WarningState): void {
    warningStateCache.set(modId, state);
}

export function clearCachedWarningState(modId?: number): void {
    if (modId !== undefined) {
        warningStateCache.delete(modId);
        warningBasisCache.delete(modId);
    } else {
        warningStateCache.clear();
        warningBasisCache.clear();
    }
}

// 模块级别缓存：下载进度，避免滚动后进度条/百分比消失或回退
const downloadProgressCache = new Map<number, number>();
// 模块级别缓存：解析后的 mod.io platformId，避免同一会话反复 nameId 查询
const resolvedPlatformIdCache = new Map<number, number>();

export function getCachedDownloadProgress(modId: number, defaultValue: number): number {
    return downloadProgressCache.has(modId) ? downloadProgressCache.get(modId)! : defaultValue;
}

export function setCachedDownloadProgress(modId: number, value: number): void {
    downloadProgressCache.set(modId, value);
}

export function clearCachedDownloadProgress(modId?: number): void {
    if (modId !== undefined) {
        downloadProgressCache.delete(modId);
    } else {
        downloadProgressCache.clear();
    }
}

/**
 * Helper method to get a mod from database by ID
 */
async function getModById(modId: number): Promise<CompleteModData | null> {
    const modsApi = await StorageAPI.getMods();
    return await modsApi.getCompleteModData(modId);
}


function ModTreeViewFolder({nodeData, onMenuClick, folders, onMoveToFolder, expanded, folderPick, onRowClick}: {
    nodeData: any;
    onMenuClick: any;
    folders?: FolderInfo[];
    onMoveToFolder?: (sourceKey: string, targetFolderKey: string) => void;
    /** Whether this folder is open (the menu offers the opposite) */
    expanded?: boolean;
    /** This folder is one of several ticked folders: the menu acts on all of them */
    folderPick?: { count: number; exclude: string[] };
    /** Ctrl/Shift-click ticks the folder (all its mods) */
    onRowClick?: (nodeKey: string, e: React.MouseEvent) => void;
}) {
    const lookVersion = useSyncExternalStore(ModListAppearance.subscribe, ModListAppearance.version);
    const colorKey: string = nodeData.colorKey ?? nodeData.key;
    const folderColor = ModListAppearance.folderColor(colorKey, lookVersion);
    // The tree also puts the folder's name in a title attribute, which the system shows as a
    // tooltip on top of the folder's right-click menu. The name is already on the row.
    const rowRef = React.useRef<HTMLSpanElement>(null);
    React.useLayoutEffect(() => {
        rowRef.current?.closest(".ant-tree-node-content-wrapper")?.removeAttribute("title");
    });
    // 过滤掉当前文件夹，避免移动到自身 (and its subfolders: a folder can't go inside itself)
    const ownSubfolders = new Set<string>();
    const collectSubfolders = (nodes: any[] | undefined) => {
        for (const child of nodes ?? []) {
            if (!child.isLeaf) {
                ownSubfolders.add(String(child.key));
                collectSubfolders(child.children);
            }
        }
    };
    collectSubfolders(nodeData.children);
    const many = folderPick && folderPick.count > 1 ? folderPick.count : 0;
    const excluded = new Set(many ? folderPick!.exclude : []);
    const moveToChildren: MenuProps['items'] = [
        {key: 'move_folders_to:root', label: t('folders.topLevel'), icon: <VerticalAlignTopOutlined />},
        ...(folders
            ?.filter(f => f.key !== nodeData.key && !ownSubfolders.has(String(f.key)) && !excluded.has(String(f.key)))
            .map(f => ({
                // one folder: the existing move (into the top of the folder); several: all at once
                key: many ? `move_folders_to:${f.key}` : `move_to_${f.key}`,
                label: f.title,
                icon: <FolderOutlined />,
            })) ?? []),
    ];

    // How many mods it holds and how many are off; a switch flipped in it updates the count
    const [, recount] = React.useReducer((n: number) => n + 1, 0);
    const modIds = React.useMemo(() => {
        const ids = new Set<number>();
        const walk = (list: any[] | undefined) => {
            for (const child of list ?? []) {
                if (child.isLeaf) ids.add(child.modId);
                else walk(child.children);
            }
        };
        walk(nodeData.children);
        return ids;
    }, [nodeData]);
    useFilteredEventListener('mod-enabled-change', (p) => modIds.has(p.modId), () => recount(), [modIds]);
    useFilteredEventListener('mod-batch-enabled-change', (p) => p.modIds.some(id => modIds.has(id)), () => recount(), [modIds]);
    const counts = folderCounts(nodeData, (m: any) => getPendingEnabled(m.modId, m.enabled !== false));
    // During a search the counts are of the shown mods; the folder's actions still act on all of them
    const filtering = TreeViewConverter.isFiltering();

    const manyMenu: MenuProps['items'] = [
        {type: 'group', label: t('folders.pickedCount', {count: many})},
        {label: t('folders.enableAllMany', {count: many}), key: 'folders_enable', icon: <PlayCircleOutlined />},
        {label: t('folders.disableAllMany', {count: many}), key: 'folders_disable', icon: <PauseCircleOutlined />},
        {label: t('folders.onlyTheseMany'), key: 'folders_only', icon: <AimOutlined />},
        {type: 'divider'},
        {label: t('folders.expandMany', {count: many}), key: 'expand_folder', icon: <ColumnHeightOutlined />},
        {label: t('folders.collapseMany', {count: many}), key: 'collapse_folder', icon: <VerticalAlignMiddleOutlined />},
        {type: 'divider'},
        {label: t('folders.colorMany', {count: many}), key: 'folders_color', icon: <BgColorsOutlined />},
        {label: t('folders.moveMany', {count: many}), key: 'move_to', icon: <DragOutlined />, children: moveToChildren},
        {type: 'divider'},
        {label: t('folders.deleteMany', {count: many}), key: 'delete_group', icon: <DeleteOutlined />, danger: true},
    ];

    const contextMenusGroup: MenuProps['items'] = many ? manyMenu : [
        {label: t('Add Mod'), key: 'add_mod', icon: <PlusCircleOutlined />},
        {label: t('Add New Group'), key: 'add_new_group', icon: <FolderAddOutlined />},
        {label: t('Add Sub Group'), key: 'add_sub_group', icon: <FolderAddOutlined />},
        {label: t('Rename Group'), key: 'rename_group', icon: <EditOutlined />},
        {label: t('folderColor.menu'), key: 'folder_color', icon: <BgColorsOutlined />},
        ...(moveToChildren.length > 0 ? [{
            label: t('Move To'),
            key: 'move_to',
            icon: <DragOutlined />,
            children: moveToChildren,
        }] : []),
        {type: 'divider'},
        {label: t('folders.enableAll'), key: 'folders_enable', icon: <PlayCircleOutlined />, disabled: counts.total === 0 && !filtering},
        {label: t('folders.disableAll'), key: 'folders_disable', icon: <PauseCircleOutlined />, disabled: counts.total === 0 && !filtering},
        {label: t('folders.onlyThis'), key: 'folders_only', icon: <AimOutlined />, disabled: counts.total === 0 && !filtering},
        {type: 'divider'},
        // this folder only (the toolbar button opens or closes all of them)
        expanded
            ? {label: t('folders.collapseOne'), key: 'collapse_folder', icon: <VerticalAlignMiddleOutlined />}
            : {label: t('folders.expandOne'), key: 'expand_folder', icon: <ColumnHeightOutlined />},
        {type: 'divider'},
        {label: t('Delete Group'), key: 'delete_group', icon: <DeleteOutlined />}
    ];
    
    return (
        <Dropdown trigger={['contextMenu']}
                  menu={{
                      items: contextMenusGroup,
                      onClick: (e) => {
                          // The click would reach the tree through the menu (React passes events
                          // up through portals) and count as a plain click on the folder there,
                          // which ends a Ctrl/Shift selection
                          e.domEvent.stopPropagation();
                          // 处理 "移动到" 子菜单点击
                          if (e.key.startsWith('move_to_folder-')) {
                              const targetFolderKey = e.key.replace('move_to_', '');
                              onMoveToFolder?.(nodeData.key, targetFolderKey);
                          } else if (e.key === 'folder_color' && !many) {
                              ModListAppearance.openFolderColor(colorKey, String(nodeData.title ?? ""));
                          } else {
                              onMenuClick(e.key, nodeData.key);
                          }
                      }
                  }}>
                    <span ref={rowRef} style={{
                        width: "100%",
                        display: "block",
                        paddingLeft: "6px",
                        borderRadius: "6px",
                        backgroundColor: folderColor ?? "rgba(238,238,238,0.2)",
                        color: folderColor ? readableTextOn(folderColor) : undefined,
                    }}
                          onClick={(e) => {
                              e.stopPropagation();
                              if (e.ctrlKey || e.metaKey || e.shiftKey) onRowClick?.(String(nodeData.key), e);
                          }}
                          onMouseDown={(e) => e.stopPropagation()}
                          onFocus={(e) => e.stopPropagation()}
                    >
                      <b><FolderOutlined/> {nodeData.title}</b>
                      <span className="folder-counts">
                          {filtering ? ` · ${t('folders.shownCount', {count: counts.total})}` : ` · ${counts.total}`}
                          {counts.off > 0 ? ` · ${t('folders.off', {count: counts.off})}` : ""}
                      </span>
                    </span>
        </Dropdown>
    );
}


function ModTreeViewSwitch({nodeData, onCountLabelUpdate}) {
    // 使用模块级别缓存获取初始状态（同步，不会因滚动丢失）
    const [checked, setChecked] = useState(() =>
        getPendingEnabled(nodeData.modId, nodeData.enabled)
    );

    // 同步外部 prop 变化（当 Tree 完整刷新时）
    React.useEffect(() => {
        const cachedValue = getPendingEnabled(nodeData.modId, nodeData.enabled);
        setChecked(cachedValue);

        // 当数据库值与缓存值同步后，清除缓存
        if (nodeData.enabled === cachedValue) {
            clearPendingEnabled(nodeData.modId);
        }
    }, [nodeData.enabled, nodeData.modId]);

    // 监听批量启用/禁用事件
    useFilteredEventListener(
        'mod-batch-enabled-change',
        (payload) => payload.modIds.includes(nodeData.modId),
        (payload) => {
            setChecked(payload.enabled);
            setPendingEnabled(nodeData.modId, payload.enabled);
        },
        [nodeData.modId]
    );

    const onSwitchChange = async (newChecked: boolean) => {
        // 1. 立即更新本地状态和模块缓存（乐观更新）
        setChecked(newChecked);
        setPendingEnabled(nodeData.modId, newChecked);

        // 2. 先更新数据库与 editTime（profile 配置变更），再发事件
        // 顺序重要：HomePage 监听 mod-enabled-change 后执行 refreshUnsavedState()，若先发事件则 editTime 尚未更新，第一次点击不会显示「未保存」
        const viewModel = await IoC.get(HomeViewModel);
        await viewModel.setModEnabled(nodeData.modId, newChecked, nodeData.profileModId);

        await emitEvent("mod-enabled-change", {
            modId: nodeData.modId,
            enabled: newChecked
        });

        // 3. 只更新计数标签
        if (onCountLabelUpdate) {
            await onCountLabelUpdate();
        }
    };

    return (
        <Switch checked={checked}
                size={"small"}
                onChange={(checked) => onSwitchChange(checked)}
                style={{marginRight: "8px", marginTop: "-3px"}}
        />
    );
}


function buildNexusmodsFileUrl(domain: string, modId: number, fileId: number): string {
    const url = new URL(NexusModsApi.getModFilesUrl(domain, modId));
    url.searchParams.set("file_id", String(fileId));
    return url.toString();
}

function getNexusmodsFileLabel(file: NexusModsFile, modVersion?: string, latestFileId?: number): string {
    const fileId = NexusModsApi.getFileId(file);
    if (file.version) {
        return file.version;
    }
    if (modVersion && latestFileId && fileId === latestFileId) {
        return modVersion;
    }
    return file.name || file.file_name || (fileId ? `#${fileId}` : "-");
}

function ModTreeViewVersionSelect({nodeData}) {

    const [fetching, setFetching] = useState(false);
    const [options, setOptions] = useState<any[]>([]);
    // 计算当前应显示的版本：usedVersion 非空时用 usedVersion，否则用 fileVersion
    const resolveDisplayVersion = (usedVer: string, fileVer: string) => {
        if (usedVer && usedVer !== "") return usedVer;
        if (fileVer && fileVer !== "" && fileVer !== "-") return fileVer;
        return "-";
    };
    // 使用本地状态 + 模块级待定版本缓存，解决切换版本后滚动导致显示回退的问题
    const [selectedVersion, setSelectedVersion] = useState<string>(() =>
        getPendingUsedVersion(nodeData.modId, resolveDisplayVersion(nodeData.usedVersion, nodeData.fileVersion))
    );
    // 追踪是否正在处理版本切换（下载中）
    const [isProcessing, setIsProcessing] = useState(() => getVersionSwitchLock(nodeData.modId).isProcessing);
    // 追踪版本是否被锁定（用户手动选择了非最新版本）；使用缓存避免滚动后图标消失
    const [isVersionLocked, setIsVersionLocked] = useState<boolean>(() =>
        getPendingVersionLocked(nodeData.modId, !!(nodeData.usedVersion && nodeData.usedVersion !== ""))
    );
    // 存储最新版本号，用于判断用户选择的是否为最新版本
    const latestVersionRef = React.useRef<string>("");

    // 同步外部 prop 变化（当 Tree 完整刷新时）；优先使用待定版本/锁定缓存，避免滚动时被旧 nodeData 覆盖
    React.useEffect(() => {
        const fromProps = resolveDisplayVersion(nodeData.usedVersion, nodeData.fileVersion);
        const displayVersion = getPendingUsedVersion(nodeData.modId, fromProps);
        const lockedFromProps = !!(nodeData.usedVersion && nodeData.usedVersion !== "");
        const displayLocked = getPendingVersionLocked(nodeData.modId, lockedFromProps);
        setSelectedVersion(displayVersion);
        setIsVersionLocked(displayLocked);
        // 当 tree 数据与当前显示一致时清除待定缓存（避免长期占用）
        if (displayVersion === fromProps) {
            clearPendingUsedVersion(nodeData.modId);
            clearPendingVersionLocked(nodeData.modId);
        }
        if ((nodeData.platformId || 0) > 0) {
            resolvedPlatformIdCache.set(nodeData.modId, nodeData.platformId);
        }
    }, [nodeData.usedVersion, nodeData.fileVersion, nodeData.platformId, nodeData.modId]);

    // 同步锁定状态
    React.useEffect(() => {
        const lock = getVersionSwitchLock(nodeData.modId);
        setIsProcessing(lock.isProcessing);
    }, [nodeData.modId]);

    // 监听 mod-treeview-update 事件，当 mod 下载/更新完成后同步版本显示
    // 这解决了 mod 添加后版本数据异步更新导致显示为空的问题
    useFilteredEventListener(
        'mod-treeview-update',
        (payload) => payload.modId === nodeData.modId,
        (payload) => {
            const updatedVersion = payload.data.version?.currentVersion;
            if (updatedVersion && updatedVersion !== "-" && !isVersionLocked) {
                setSelectedVersion(updatedVersion);
            }
            if ((payload.data.platformId || 0) > 0) {
                resolvedPlatformIdCache.set(nodeData.modId, payload.data.platformId);
            }
        },
        [nodeData.modId, isVersionLocked]
    );

    const onDropdownVisibleChange = async (visible: boolean) => {
        if (visible) {
            setFetching(true);
            try {
                const optionList = [];

                if (nodeData.sourceType === MODCAT_PLATFORM) {
                    // ModCat: 通过 getModDetail 获取版本信息
                    const modDetail = await ModcatApi.getModDetail(nodeData.nameId);
                    if (modDetail?.ModVersionEntities) {
                        const modcatVersions = modDetail.ModVersionEntities
                            .filter(v => v.FilesId) // 只要有文件 ID 就可以
                            .sort((a, b) => {
                                const dateA = new Date(a.CreatedAt || 0).getTime();
                                const dateB = new Date(b.CreatedAt || 0).getTime();
                                return dateB - dateA; // 最新版本在前
                            });

                        for (const version of modcatVersions) {
                            optionList.push({
                                value: JSON.stringify(version),
                                label: version.VersionNumber || version.VersionId
                            });
                        }
                    }
                } else if (nodeData.sourceType === NEXUSMODS_PLATFORM) {
                    const parsed = NexusModsApi.parseModLinks(nodeData.url);
                    if (!parsed) {
                        await StatusBar.error(`${t("Fetch Mod Info Error")}: ${nodeData.title}`);
                        setOptions([]);
                        return;
                    }

                    const [modInfo, rawNexusFiles] = await Promise.all([
                        NexusModsApi.getModInfo(parsed.domain, parsed.modId).catch(() => undefined),
                        NexusModsApi.getModFiles(parsed.domain, parsed.modId),
                    ]);
                    const nexusFiles = (rawNexusFiles || [])
                        .filter(file => NexusModsApi.getFileId(file) > 0)
                        .sort((a, b) => (b.uploaded_timestamp ?? 0) - (a.uploaded_timestamp ?? 0));
                    const latestFileId = NexusModsApi.getFileId(nexusFiles[0]);

                    for (const file of nexusFiles) {
                        const fileId = NexusModsApi.getFileId(file);
                        const label = getNexusmodsFileLabel(file, modInfo?.version, latestFileId);
                        optionList.push({
                            value: JSON.stringify({
                                ...file,
                                fileId,
                                resolvedVersion: label,
                                downloadUrl: buildNexusmodsFileUrl(parsed.domain, parsed.modId, fileId),
                                fileSize: NexusModsApi.getFileSizeBytes(file),
                            }),
                            label
                        });
                    }
                } else {
                    // mod.io: 使用 platformId 获取版本信息（兼容 v2 导入后的 platformId=0）
                    let platformId = resolvedPlatformIdCache.get(nodeData.modId) || nodeData.platformId || 0;
                    if (platformId <= 0 && nodeData.nameId) {
                        const resolvedPlatformId = await ModioApi.resolvePlatformIdByNameId(nodeData.nameId);
                        if (resolvedPlatformId > 0) {
                            platformId = resolvedPlatformId;
                            resolvedPlatformIdCache.set(nodeData.modId, platformId);
                            // 回填到数据库，避免后续继续使用无效 platformId
                            const modsApi = await StorageAPI.getMods();
                            await modsApi.updateMod(nodeData.modId, { platformId });
                            const refreshed = await modsApi.getCompleteModData(nodeData.modId);
                            if (refreshed) {
                                await emitEvent("mod-treeview-update", {
                                    modId: refreshed.modId!,
                                    data: refreshed
                                });
                            }
                        }
                    }

                    if (platformId <= 0) {
                        await StatusBar.error(`${t("Fetch Mod Info Error")}: ${nodeData.title}`);
                        setOptions([]);
                        return;
                    }

                    const fileInfos: ModFile[] = await ModioApi.getModFiles(platformId) || [];
                    for (const fileInfo of fileInfos) {
                        optionList.push({
                            value: JSON.stringify(fileInfo),
                            label: fileInfo.version ? fileInfo.version : fileInfo.filename
                        });
                    }
                    optionList.reverse();
                }

                // 记录最新版本号（列表中第一个即为最新）
                if (optionList.length > 0) {
                    latestVersionRef.current = optionList[0].label;
                }

                setOptions(optionList);
            } finally {
                setFetching(false);
            }
        }
    }

    const onChange = async (value: string) => {
        const parsedValue = JSON.parse(value);
        
        // 根据 sourceType 提取版本号
        const isModcat = nodeData.sourceType === MODCAT_PLATFORM;
        const isNexusmods = nodeData.sourceType === NEXUSMODS_PLATFORM;
        const newVersion = isModcat 
            ? (parsedValue.VersionNumber || parsedValue.VersionId)
            : isNexusmods
                ? (parsedValue.resolvedVersion || parsedValue.version || parsedValue.name || parsedValue.file_name || String(parsedValue.fileId || "-"))
            : (parsedValue.version || parsedValue.filename);
        
        // 检查是否有正在进行的版本切换
        const currentLock = getVersionSwitchLock(nodeData.modId);
        if (currentLock.isProcessing) {
            // 如果选择的版本与正在处理的版本相同，忽略此次点击
            if (currentLock.currentVersion === newVersion) {
                return;
            }
            // 如果选择了不同的版本，仍然阻止，但更新显示
            await StatusBar.warning(`${t("Version switch in progress")}: ${nodeData.title}`);
            return;
        }
        
        // 设置锁定状态
        setVersionSwitchLock(nodeData.modId, { isProcessing: true, currentVersion: newVersion });
        setIsProcessing(true);
        
        // 判断用户选择的是否为最新版本
        const isLatestVersion = latestVersionRef.current !== "" && newVersion === latestVersionRef.current;
        
        // 立即更新本地状态与待定版本/锁定缓存（乐观更新），避免滚动后显示被旧 treeData 覆盖
        setSelectedVersion(newVersion);
        setPendingUsedVersion(nodeData.modId, newVersion);
        setPendingVersionLocked(nodeData.modId, !isLatestVersion);
        setIsVersionLocked(!isLatestVersion);
        
        await StatusBar.info(`${t("Switch Version")}: ${nodeData.title} ${newVersion}`);

        try {
            const viewModel = await IoC.get(HomeViewModel);
            // Use profileModId (profile_mods.id) instead of key
            // 选择最新版本时清空 usedVersion（解锁），否则设置为选定版本（锁定）
            if (nodeData.profileModId) {
                await viewModel.setModUsedVersion(
                    nodeData.profileModId,
                    isLatestVersion ? "" : newVersion
                );
                await logActivity('info', isLatestVersion
                    ? t("log.list.versionNewest", {name: String(nodeData.title ?? ""), version: newVersion})
                    : t("log.list.versionPinned", {name: String(nodeData.title ?? ""), version: newVersion}), undefined, 'list');
            }

            const modItem = await getModById(nodeData.modId);
            if (!modItem) {
                clearVersionSwitchLock(nodeData.modId);
                setIsProcessing(false);
                return;
            }

            // 根据 sourceType 构建下载 URL 和文件大小
            let downloadUrl: string;
            let fileSize: number;
            
            if (isModcat) {
                // ModCat: 使用 FilesId 构建下载 URL
                downloadUrl = parsedValue.FilesId 
                    ? `https://modcat.top:8089/api/Files/DownloadFileGet?FileId=${encodeURIComponent(parsedValue.FilesId)}&NoCount=true`
                    : "";
                fileSize = parseInt(parsedValue.Files?.Size || "0", 10);
            } else if (isNexusmods) {
                // Nexus Mods: 使用 file_id 指定版本；需要网页捕获下载凭据时也会打开对应文件页
                downloadUrl = parsedValue.downloadUrl || (
                    parsedValue.fileId
                        ? buildNexusmodsFileUrl(
                            NexusModsApi.parseModLinks(nodeData.url)?.domain || "",
                            nodeData.platformId || Number(nodeData.nameId),
                            parsedValue.fileId
                        )
                        : ""
                );
                fileSize = parsedValue.fileSize || NexusModsApi.getFileSizeBytes(parsedValue);
            } else {
                // mod.io: 使用原有的下载信息
                downloadUrl = parsedValue.download?.binary_url || "";
                fileSize = parsedValue.filesize || 0;
            }

            // Update modItem with new version and download info
            const updatedModItem: CompleteModData = {
                ...modItem,
                version: {
                    ...modItem.version!,
                    currentVersion: newVersion
                },
                download: {
                    ...modItem.download!,
                    downloadUrl: downloadUrl,
                    downloadProgress: 0,
                    fileSize: fileSize,
                }
            };

            await emitEvent("mod-treeview-update", {
                modId: updatedModItem.modId!,
                data: updatedModItem
            });

            // 通知 HomePage 标记未保存变更，让保存按钮高亮
            await emitEvent("mod-enabled-change", {
                modId: nodeData.modId,
                enabled: getPendingEnabled(nodeData.modId, nodeData.enabled)
            });

            await ModUpdateService.updateModFile(updatedModItem);
        } catch (error) {
            console.error("版本切换失败:", error);
            await StatusBar.error(`${t("Version switch failed")}: ${nodeData.title}`);
            clearPendingUsedVersion(nodeData.modId);
            clearPendingVersionLocked(nodeData.modId);
        } finally {
            // 清除锁定状态
            clearVersionSwitchLock(nodeData.modId);
            setIsProcessing(false);
        }
    }

    const {token} = useToken();

    return (
        <Tooltip title={isVersionLocked ? t("mod.versionLockedUnlockLatest") : ""}>
            <Select size={"small"}
                    suffixIcon={isVersionLocked
                        ? <LockOutlined style={{color: token.colorWarning, fontSize: "10px"}}/>
                        : null}
                    popupMatchSelectWidth={false}
                    variant="filled"
                    style={{
                        marginRight: "4px",
                        maxWidth: "80px",
                        fontSize: "12px",
                        color: token.colorTextSecondary,
                    }}
                    value={selectedVersion}
                    notFoundContent={fetching ? <Spin size="small"/> : null}
                    options={options}
                    onChange={onChange}
                    onOpenChange={onDropdownVisibleChange}
                    disabled={isProcessing}
                    loading={isProcessing}
            />
        </Tooltip>
    );
}


function ModTreeViewWarring({nodeData, onLocate}: { nodeData: any; onLocate?: () => void }) {
    // 使用 ref 存储 nodeData 以便在回调中访问最新值
    const nodeDataRef = React.useRef(nodeData);
    nodeDataRef.current = nodeData;

    const checkExpired = () => {
        const data = nodeDataRef.current;
        // 支持在线 mod 来源
        if (data.sourceType !== ModSourceType.Modio && data.sourceType !== MODCAT_PLATFORM && data.sourceType !== NEXUSMODS_PLATFORM) {
            return false;
        }

        if (data.downloadProgress !== 100) {
            return false;
        }

        // 如果用户手动选择了版本（usedVersion 不为空），则不提示更新
        // 因为用户可能故意选择了旧版本
        if (data.usedVersion && data.usedVersion !== "") {
            return false;
        }

        // 只有在用户没有手动选择版本时，才检查在线是否有新版本
        // 如果 lastUpdateDate 为 0，说明是旧数据或初始化数据，不应该显示警告
        const hasNewerOnlineVersion = TimeUtils.hasUpdate(
            data.onlineUpdateDate,
            data.lastUpdateDate
        );

        return hasNewerOnlineVersion;
    }

    const checkLocalNoFound = () => {
        const data = nodeDataRef.current;
        // Tree nodes carry `localNoFound`; live updates carry full mod data with `status.isLocalNotFound`
        return data.localNoFound === true || data.status?.isLocalNotFound === true;
    }

    const checkOnlineUnavailable = () => {
        const data = nodeDataRef.current;
        // 支持在线 mod 来源
        return (data.sourceType === ModSourceType.Modio || data.sourceType === MODCAT_PLATFORM || data.sourceType === NEXUSMODS_PLATFORM) &&
            data.onlineAvailable === false;
    }

    const checkConflict = () => {
        return ConflictService.hasConflict(nodeDataRef.current.modId);
    }

    const fallbackWarning: WarningState = {
        isExpired: checkExpired(),
        isLocalNoFound: checkLocalNoFound(),
        isOnlineUnavailable: checkOnlineUnavailable(),
        hasConflict: checkConflict(),
    };
    const [warningState, setWarningState] = useState<WarningState>(() =>
        getCachedWarningState(nodeData.modId, fallbackWarning)
    );
    const { isExpired, isLocalNoFound, isOnlineUnavailable, hasConflict } = warningState;

    // 同步外部 nodeData 变化（滚动后重挂载时可能带旧数据，优先用缓存）
    React.useEffect(() => {
        nodeDataRef.current = nodeData;
        const fallback: WarningState = {
            isExpired: checkExpired(),
            isLocalNoFound: checkLocalNoFound(),
            isOnlineUnavailable: checkOnlineUnavailable(),
            hasConflict: checkConflict(),
        };
        // The cache covers remounts that carry old row data (e.g. after scrolling); when the
        // row data itself changed since the cached state was made, the fresh data wins.
        const basis = JSON.stringify([nodeData.downloadProgress, nodeData.lastUpdateDate, nodeData.onlineUpdateDate,
            nodeData.onlineAvailable, nodeData.localNoFound]);
        if (!warningStateCache.has(nodeData.modId) || warningBasisCache.get(nodeData.modId) !== basis) {
            setCachedWarningState(nodeData.modId, fallback);
            warningBasisCache.set(nodeData.modId, basis);
        }
        const cached = getCachedWarningState(nodeData.modId, fallback);
        setWarningState(cached);
    }, [nodeData.modId, nodeData.downloadProgress, nodeData.lastUpdateDate, nodeData.onlineUpdateDate, nodeData.onlineAvailable, nodeData.localNoFound]);

    // ✅ 使用 useFilteredEventListener 自动清理监听器
    useFilteredEventListener(
        'mod-treeview-update',
        (payload) => payload.modId === nodeData.modId,
        (payload) => {
            nodeDataRef.current = payload.data;
            const next: WarningState = {
                isExpired: checkExpired(),
                isLocalNoFound: checkLocalNoFound(),
                isOnlineUnavailable: checkOnlineUnavailable(),
                hasConflict: checkConflict(),
            };
            setWarningState((prev) => {
                const s = { ...prev, ...next };
                setCachedWarningState(nodeData.modId, s);
                return s;
            });
        },
        [nodeData.modId]
    );

    // 监听冲突更新事件
    useFilteredEventListener(
        'mod-conflict-update',
        (payload) => payload.modId === nodeData.modId,
        () => {
            const nextConflict = checkConflict();
            setWarningState((prev) => {
                const s = { ...prev, hasConflict: nextConflict };
                setCachedWarningState(nodeData.modId, s);
                return s;
            });
        },
        [nodeData.modId]
    );

    // Inputs from the stores as hook values, so the React Compiler recomputes when they change
    const installOrder = useInstallOrder();
    const conflictVersion = useSyncExternalStore(ConflictService.subscribe, ConflictService.version);
    const repoVersion = useSyncExternalStore(RepositoryUpdates.subscribe, RepositoryUpdates.version);
    const repoUpdate = RepositoryUpdates.updateStateAt(nodeData.modId, repoVersion);
    const conflictSummary = hasConflict
        ? summarizeConflicts(nodeData.modId, installOrder, conflictVersion)
        : 'harmless';
    const conflictColor: Record<ModConflictSummary, string> = SUMMARY_COLOR;

    // 生成冲突提示信息
    const conflictModCount = conflictCountAt(nodeData.modId, conflictVersion);
    const getConflictTooltip = () => {
        if (conflictModCount === null) return t("conflict.withOtherMods");
        return t(`conflict.summary.${conflictSummary}`, {mods: conflictModCount});
    };

    return (
        <>
            {
                hasConflict &&
                <Popover trigger="click"
                         placement="bottomLeft"
                         destroyOnHidden
                         title={t("File conflict")}
                         content={
                             // Portal clicks bubble to the tree row in React; keep them here
                             <div onClick={(e) => e.stopPropagation()}
                                  onDoubleClick={(e) => e.stopPropagation()}
                                  onMouseDown={(e) => e.stopPropagation()}
                                  onContextMenu={(e) => e.stopPropagation()}>
                                 <ModConflictDetails modId={nodeData.modId}/>
                             </div>
                         }>
                    <Tooltip title={`${getConflictTooltip()} — ${t("conflict.clickForDetails")}`}>
                                <span style={{color: conflictColor[conflictSummary], marginRight: "4px", cursor: "pointer"}}
                                      onClick={(e) => e.stopPropagation()}
                                      onMouseDown={(e) => e.stopPropagation()}>
                                    <WarningOutlined/>
                                </span>
                    </Tooltip>
                </Popover>
            }

            {
                repoUpdate && repoUpdate.kind !== 'upToDate' &&
                <Tooltip title={t(repoUpdate.kind === 'newer' ? "repoUpdate.iconNewer" : "repoUpdate.iconDiffers",
                    {date: new Date(repoUpdate.latest.postedAt).toLocaleString()})}>
                                <span style={{color: "orange", marginRight: "4px"}}>
                                    <ClockCircleOutlined/>
                                </span>
                </Tooltip>
            }

            {
                isExpired &&
                <Tooltip title={t("Discovered New Version")}>
                                <span style={{color: "orange", marginRight: "4px"}}>
                                    <ClockCircleOutlined/>
                                </span>
                </Tooltip>
            }

            {
                isOnlineUnavailable &&
                <Tooltip title={t("mod.unavailableOrDeletedByAuthor")}>
                                <span className="text-red mr-4">
                                    <ExclamationCircleOutlined/>
                                </span>
                </Tooltip>
            }

            {
                isLocalNoFound &&
                <Tooltip title={
                    <span>
                        {t("mod.localFileMissing")}
                        <br/>
                        <span style={{fontFamily: "monospace", fontSize: 12, wordBreak: "break-all"}}>
                            {nodeDataRef.current.url || nodeDataRef.current.download?.cachePath || nodeData.url}
                        </span>
                        {onLocate && <><br/><i>{t("localMods.clickToLocate")}</i></>}
                    </span>
                }>
                                <span className="text-red mr-4"
                                      style={{cursor: onLocate ? "pointer" : undefined}}
                                      onClick={(e) => {
                                          e.stopPropagation();
                                          onLocate?.();
                                      }}
                                      onMouseDown={(e) => e.stopPropagation()}>
                                    <CloseCircleFilled/>
                                </span>
                </Tooltip>
            }

        </>
    )
}


function ModTreeViewProgressBackground({nodeData, children, onRowClick, ref: outerRef, ...restProps}: any) {
    // Mods in a colored folder (or a subfolder of one) get a stripe of its color
    const lookVersion = useSyncExternalStore(ModListAppearance.subscribe, ModListAppearance.version);
    const folderColor = ModListAppearance.colorForPath(nodeData.folderPath, lookVersion);
    const [downloadProgress, setDownloadProgress] = useState(() =>
        getCachedDownloadProgress(nodeData.modId, nodeData.downloadProgress)
    );

    React.useEffect(() => {
        const v = getCachedDownloadProgress(nodeData.modId, nodeData.downloadProgress);
        setDownloadProgress(v);
    }, [nodeData.modId, nodeData.downloadProgress]);

    useFilteredEventListener(
        'mod-treeview-update',
        (payload) => payload.modId === nodeData.modId,
        (payload) => {
            const v = payload.data.download?.downloadProgress ?? 100;
            setCachedDownloadProgress(nodeData.modId, v);
            setDownloadProgress(v);
        },
        [nodeData.modId]
    );

    const isDownloading = downloadProgress !== 100;

    // The tree repeats the mod's name in a title attribute on the row, which the system shows as
    // a second tooltip over the row's own tooltips and menu
    const rowRef = React.useRef<HTMLDivElement | null>(null);
    React.useLayoutEffect(() => {
        rowRef.current?.closest(".ant-tree-node-content-wrapper")?.removeAttribute("title");
    });
    // the row menu (Dropdown) may pass its own ref, which has to reach the element too
    const setRowRef = (el: HTMLDivElement | null) => {
        rowRef.current = el;
        if (typeof outerRef === "function") outerRef(el);
        else if (outerRef) outerRef.current = el;
    };

    // 渐变背景样式：从左到右的进度色块
    const progressStyle: React.CSSProperties = isDownloading ? {
        background: `linear-gradient(
            90deg,
            rgba(22, 119, 255, 0.35) 0%,
            rgba(22, 119, 255, 0.2) ${downloadProgress * 0.8}%,
            rgba(22, 119, 255, 0.05) ${downloadProgress}%,
            transparent ${downloadProgress}%
        )`,
    } : {};

    const stopBubble = (e: React.SyntheticEvent) => e.stopPropagation();
    // Clicks don't reach the tree (see stopBubble); Ctrl/Shift-clicks select mods through onRowClick
    const onClick = (e: React.MouseEvent) => {
        e.stopPropagation();
        onRowClick?.(nodeData.key, e);
    };
    const onMouseDown = (e: React.MouseEvent) => {
        e.stopPropagation();
        // Shift/Ctrl-click would otherwise select the rows' text
        if (e.shiftKey || e.ctrlKey || e.metaKey) e.preventDefault();
    };

    return (
        <div ref={setRowRef} style={{
            width: "100%",
            boxSizing: "border-box",
            display: "flex",
            alignItems: "center",
            borderRadius: "4px",
            padding: "2px 4px",
            transition: "background 0.3s ease",
            ...(folderColor ? {boxShadow: `inset 3px 0 0 ${folderColor}`} : {}),
            ...progressStyle
        }} {...restProps}
            onClick={onClick}
            onMouseDown={onMouseDown}
            onFocus={stopBubble}
        >
            {children}
        </div>
    );
}


function ModTreeViewProgressPercent({nodeData}) {
    const [downloadProgress, setDownloadProgress] = useState(() =>
        getCachedDownloadProgress(nodeData.modId, nodeData.downloadProgress)
    );

    React.useEffect(() => {
        const v = getCachedDownloadProgress(nodeData.modId, nodeData.downloadProgress);
        setDownloadProgress(v);
    }, [nodeData.modId, nodeData.downloadProgress]);

    useFilteredEventListener(
        'mod-treeview-update',
        (payload) => payload.modId === nodeData.modId,
        (payload) => {
            const v = payload.data.download?.downloadProgress ?? 100;
            setCachedDownloadProgress(nodeData.modId, v);
            setDownloadProgress(v);
        },
        [nodeData.modId]
    );

    if (downloadProgress === 100) return null;

    return (
        <Tag color="blue">{downloadProgress.toFixed(2)}%</Tag>
    );
}


function ModTreeViewLocalTitle({nodeData}) {
    const {token} = useToken();
    // 使用模块级别缓存获取初始 enabled 状态，与 Switch 保持同步
    const [enabled, setEnabled] = useState(() =>
        getPendingEnabled(nodeData.modId, nodeData.enabled)
    );

    // 同步外部 prop 变化（当 Tree 完整刷新时）
    React.useEffect(() => {
        const cachedValue = getPendingEnabled(nodeData.modId, nodeData.enabled);
        setEnabled(cachedValue);
    }, [nodeData.enabled, nodeData.modId]);

    // 监听单个 enabled 状态变化事件
    useFilteredEventListener(
        'mod-enabled-change',
        (payload) => payload.modId === nodeData.modId,
        (payload) => {
            setEnabled(payload.enabled);
        },
        [nodeData.modId]
    );

    // 监听批量 enabled 状态变化事件
    useFilteredEventListener(
        'mod-batch-enabled-change',
        (payload) => payload.modIds.includes(nodeData.modId),
        (payload) => {
            setEnabled(payload.enabled);
        },
        [nodeData.modId]
    );

    const showPath = useShowLocalPaths();
    const filePath: string = nodeData.url || "";

    // How the mod is linked to a repository post (Pak Hub): its own color and icon when turned on
    const repoVersion = useSyncExternalStore(RepositoryUpdates.subscribe, RepositoryUpdates.version);
    const lookVersion = useSyncExternalStore(ModListAppearance.subscribe, ModListAppearance.version);
    const link = RepositoryUpdates.linkForModAt({modId: nodeData.modId, url: nodeData.url}, repoVersion);
    const look = ModListAppearance.get(lookVersion);
    const autoColor = link?.via === 'auto' && look.autoLinkColorEnabled ? look.autoLinkColor : undefined;
    const nameStyle: React.CSSProperties = autoColor
        ? {color: autoColor, opacity: enabled ? 1 : 0.55}
        : {color: enabled ? token.colorText : token.colorTextSecondary};
    const linkIcon = look.linkIcons ? (
        <Tooltip mouseEnterDelay={0.3} title={
            !link ? t("linkIcon.none")
                : link.via === 'auto' ? t("linkIcon.auto")
                    : link.via === 'added' ? t("linkIcon.added")
                        : t("linkIcon.manual")
        }>
            <span style={{
                marginRight: 6,
                flexShrink: 0,
                // linked ones stand out from the grey "not linked" icon (a grey chain looked the same)
                color: !link ? token.colorTextQuaternary
                    : link.via === 'auto' ? (look.autoLinkColor || token.colorInfo)
                        : token.colorLink,
            }}>
                {!link ? <DisconnectOutlined/>
                    : link.via === 'auto' ? <ThunderboltOutlined/>
                        : link.via === 'added' ? <CloudDownloadOutlined/>
                            : <LinkOutlined/>}
            </span>
        </Tooltip>
    ) : null;

    if (!showPath || !filePath) {
        return (
            <span style={{display: "inline-flex", alignItems: "center", minWidth: 0}}>
                {linkIcon}
                <span style={nameStyle}>{nodeData.title}</span>
            </span>
        );
    }
    return (
        <span style={{display: "inline-flex", flexDirection: "column", minWidth: 0, lineHeight: 1.25, padding: "1px 0"}}>
            <span style={{display: "inline-flex", alignItems: "center", minWidth: 0}}>
                {linkIcon}
                <span style={nameStyle}>{nodeData.title}</span>
            </span>
            <span title={filePath}
                  style={{
                      color: token.colorTextTertiary,
                      fontSize: 11,
                      fontFamily: "monospace",
                      whiteSpace: "nowrap",
                      overflow: "hidden",
                      textOverflow: "ellipsis",
                      maxWidth: "60vw",
                  }}>
                {filePath}
            </span>
        </span>
    );
}


function ModTreeViewTitle({nodeData}) {

    const [downloadProgress, setDownloadProgress] = useState(() =>
        getCachedDownloadProgress(nodeData.modId, nodeData.downloadProgress)
    );
    const [enabled, setEnabled] = useState(() =>
        getPendingEnabled(nodeData.modId, nodeData.enabled)
    );
    const {token} = useToken();

    React.useEffect(() => {
        setDownloadProgress(getCachedDownloadProgress(nodeData.modId, nodeData.downloadProgress));
        setEnabled(getPendingEnabled(nodeData.modId, nodeData.enabled));
    }, [nodeData.modId, nodeData.downloadProgress, nodeData.enabled]);

    useFilteredEventListener(
        'mod-treeview-update',
        (payload) => payload.modId === nodeData.modId,
        (payload) => {
            const v = payload.data.download?.downloadProgress ?? 100;
            setCachedDownloadProgress(nodeData.modId, v);
            setDownloadProgress(v);
        },
        [nodeData.modId]
    );

    // 监听单个 enabled 状态变化事件
    useFilteredEventListener(
        'mod-enabled-change',
        (payload) => payload.modId === nodeData.modId,
        (payload) => {
            setEnabled(payload.enabled);
        },
        [nodeData.modId]
    );

    // 监听批量 enabled 状态变化事件
    useFilteredEventListener(
        'mod-batch-enabled-change',
        (payload) => payload.modIds.includes(nodeData.modId),
        (payload) => {
            setEnabled(payload.enabled);
        },
        [nodeData.modId]
    );

    return (
        <a style={{
            color: enabled &&
            downloadProgress === 100 ? token.colorPrimary : token.colorTextDisabled
        }}
           onClick={async (e) => {
               // Ctrl/Shift-click selects the mod instead (handled by the row)
               if (e.ctrlKey || e.metaKey || e.shiftKey) return;
               await open(nodeData.url);
           }}
        >
            {nodeData.title}
        </a>
    )

}


/**
 * The install position number in front of a mod. Clicking it asks for another position and moves
 * the mod there (see TreeView.onMoveToPosition).
 */
function PositionBadge({nodeKey, position, enabled, onMove, groupSize = 0, groupFirst}: {
    nodeKey: string;
    position: number;
    enabled: boolean;
    onMove?: (sourceKey: string, position: number) => unknown;
    /** How many picked mods move together with this one (0: only this one) */
    groupSize?: number;
    /** Number of the first of them */
    groupFirst?: number;
}) {
    const inGroup = groupSize > 1;
    const startAt = inGroup ? (groupFirst ?? position) : position;
    const {token} = useToken();
    const total = useInstallOrder().length;
    const [open, setOpen] = useState(false);
    const [value, setValue] = useState<number | null>(position);
    const [moving, setMoving] = useState(false);
    const inputRef = React.useRef<any>(null);

    React.useEffect(() => {
        if (open) {
            setValue(startAt);
            // select the number so typing replaces it
            setTimeout(() => inputRef.current?.select?.(), 30);
        }
    }, [open, startAt]);

    const target = value == null ? null : Math.min(Math.max(Math.round(value), 1), Math.max(total, 1));
    // a group may also be pulled together at its own number
    const canMove = !!onMove && target != null && (inGroup || target !== position) && !moving;

    const move = async () => {
        if (!canMove || target == null) return;
        setMoving(true);
        try {
            await onMove!(nodeKey, target);
        } finally {
            setMoving(false);
            setOpen(false);
        }
    };

    // clicks and presses on the badge belong to it, not to the row (select) or the tree (drag)
    const stop = (e: React.SyntheticEvent) => e.stopPropagation();

    const badge = (
        <span onClick={(e) => {
                  stop(e);
                  if (onMove && !e.ctrlKey && !e.shiftKey && !e.metaKey) setOpen(true);
              }}
              onMouseDown={stop}
              onDoubleClick={stop}
              style={{
                  display: "inline-flex",
                  alignItems: "center",
                  justifyContent: "center",
                  minWidth: "40px",
                  height: "18px",
                  borderRadius: "9px",
                  backgroundColor: enabled ? token.colorPrimaryBg : token.colorBgTextHover,
                  color: enabled ? token.colorPrimary : token.colorTextDisabled,
                  fontSize: "11px",
                  fontWeight: 600,
                  marginRight: "6px",
                  padding: "0 5px",
                  lineHeight: 1,
                  fontVariantNumeric: "tabular-nums",
                  flexShrink: 0,
                  cursor: onMove ? "pointer" : undefined,
                  outline: open ? `1px solid ${token.colorPrimary}` : undefined,
              }}>
            {position}
        </span>
    );

    if (!onMove) {
        return (
            <Tooltip title={t("list.installPositionHint", {position})} mouseEnterDelay={0.6}>
                {badge}
            </Tooltip>
        );
    }
    return (
        <Popover open={open}
                 onOpenChange={(next) => {
                     if (!moving) setOpen(next);
                 }}
                 trigger="click"
                 placement="bottomLeft"
                 destroyOnHidden
                 title={inGroup ? t("list.moveGroupTitle", {count: groupSize}) : t("list.moveToPositionTitle")}
                 content={
                     <div onClick={stop} onMouseDown={stop} onKeyDown={(e) => {
                         e.stopPropagation();
                         if (e.key === "Escape") setOpen(false);
                     }}>
                         <Flex gap={8} align="center">
                             <InputNumber ref={inputRef}
                                          autoFocus
                                          size="small"
                                          min={1}
                                          max={Math.max(total, 1)}
                                          precision={0}
                                          value={value}
                                          onChange={(v) => setValue(typeof v === "number" ? v : null)}
                                          onPressEnter={() => void move()}
                                          style={{width: 90}}/>
                             <Button size="small" type="primary" loading={moving} disabled={!canMove} onClick={() => void move()}>
                                 {t("list.moveToPositionOk")}
                             </Button>
                         </Flex>
                         <div style={{fontSize: 12, opacity: 0.65, marginTop: 6, maxWidth: 260}}>
                             {inGroup
                                 ? t("list.moveGroupHint", {first: startAt, total})
                                 : t("list.moveToPositionHint", {position, total})}
                         </div>
                     </div>
                 }>
            <Tooltip title={open ? undefined : t("list.installPositionClickHint", {position})} mouseEnterDelay={0.6}>
                {badge}
            </Tooltip>
        </Popover>
    );
}

export interface TreeViewItemProps {
    nodeData: any;
    onMenuClick: any;
    onCountLabelUpdate?: () => Promise<void>;
    folders?: FolderInfo[];
    onMoveToFolder?: (sourceKey: string, targetFolderKey: string) => void;
    /** Move a mod to another install position (1 = top); only when its position is known */
    onMoveToPosition?: (sourceKey: string, position: number) => unknown;
    itemOrder?: number;
    /** Picked mods that move with this one (0 when it isn't one of several picked) */
    groupSize?: number;
    /** Install number of the first picked mod */
    groupFirst?: number;
    /** Click on a mod row (Ctrl/Shift-clicks select mods) */
    onRowClick?: (nodeKey: string, e: React.MouseEvent) => void;
    /** A folder: whether it is open */
    expanded?: boolean;
    /** A folder that is one of several ticked folders */
    folderPick?: { count: number; exclude: string[] };
}

/**
 * The tree calls titleRender for every visible row whenever it re-renders (each scroll
 * step, selection, right-click). Rows only depend on their own props and the stores they
 * subscribe to, so skip re-rendering when the props are unchanged.
 */
export const TreeViewItem = React.memo(TreeViewItemInner);

/** 必须用 JSX `<TreeViewItem />` 渲染，勿当作普通函数调用，否则会违反 Hooks 规则（见 TreeView titleRender）。 */
function TreeViewItemInner({
    nodeData,
    onMenuClick,
    onCountLabelUpdate,
    folders,
    onMoveToFolder,
    onMoveToPosition,
    itemOrder,
    groupSize,
    groupFirst,
    onRowClick,
    expanded,
    folderPick,
}: TreeViewItemProps) {
    const {token} = useToken();
    const describedMod = React.useMemo(() => ({
        modId: nodeData.modId,
        platformId: nodeData.platformId,
        nameId: nodeData.nameId,
        sourceType: nodeData.sourceType,
        url: nodeData.url,
    }), [nodeData.modId, nodeData.platformId, nodeData.nameId, nodeData.sourceType, nodeData.url]);
    // Menu shows Link/Unlink depending on the mod's repository link
    const repoLinkVersion = useSyncExternalStore(RepositoryUpdates.subscribe, RepositoryUpdates.version);
    // Note / support entries follow the saved note and the accounts' lists
    // (the versions go into the reads, or React Compiler would keep the first answer)
    const notesVersion = useSyncExternalStore(ModNotes.subscribe, ModNotes.version);
    const supportVersion = useSyncExternalStore(ModSupport.subscribe, ModSupport.version);
    const columnsView = ModListAppearance.get(useSyncExternalStore(ModListAppearance.subscribe, ModListAppearance.version)).columns;

    const hasNote = !!ModNotes.get(nodeData.modId, notesVersion);
    const supportKind = nodeData.platformId
        ? nodeData.sourceType === NEXUSMODS_PLATFORM ? 'nexus' as const
            : nodeData.sourceType === ModSourceType.Modio ? 'modio' as const : undefined
        : undefined;
    const nexusDomain = supportKind === 'nexus' ? nexusDomainOf(nodeData.url) : '';
    const repoLink = RepositoryUpdates.linkForModAt(nodeData, repoLinkVersion);
    // version / game version / status / tags (see ModInfoColumns)
    const rowInfo = useRowInfo(nodeData, repoLink);

    const [enabled, setEnabled] = useState(() =>
        getPendingEnabled(nodeData.modId, nodeData.enabled)
    );
    React.useEffect(() => {
        setEnabled(getPendingEnabled(nodeData.modId, nodeData.enabled));
    }, [nodeData.enabled, nodeData.modId]);
    useFilteredEventListener(
        'mod-enabled-change',
        (payload) => payload.modId === nodeData.modId,
        (payload) => { setEnabled(payload.enabled); },
        [nodeData.modId]
    );
    useFilteredEventListener(
        'mod-batch-enabled-change',
        (payload) => payload.modIds.includes(nodeData.modId),
        (payload) => { setEnabled(payload.enabled); },
        [nodeData.modId]
    );

    // 构建"移动到"子菜单
    const moveToChildren: MenuProps['items'] = folders
        ?.map(f => ({
            key: `move_to_${f.key}`,
            label: f.title,
            icon: <FolderOutlined />,
        })) || [];

    const contextMenus: MenuProps['items'] = [
        {label: t('Add New Group'), key: 'add_new_group', icon: <FolderAddOutlined />},
        {label: t('Rename'), key: 'rename', icon: <EditOutlined />},
        {label: t('Update'), key: 'update', icon: <SyncOutlined />},
        {label: t('Pin to Top'), key: 'pin_to_top', icon: <VerticalAlignTopOutlined />},
        ...(moveToChildren.length > 0 ? [{
            label: t('Move To'),
            key: 'move_to',
            icon: <DragOutlined />,
            children: moveToChildren,
        }] : []),
        {label: t('Delete'), key: 'delete', icon: <DeleteOutlined />},
        {label: t('Copy Link'), key: 'copy_link', icon: <LinkOutlined />},
        {label: t('Export'), key: 'export', icon: <ExportOutlined />},
        {type: 'divider' as const},
        {label: t(hasNote ? 'notes.editMenu' : 'notes.addMenu'), key: 'note_edit', icon: <FileTextOutlined />},
        ...(hasNote ? [{label: t('notes.removeMenu'), key: 'note_remove', icon: <DeleteOutlined />}] : []),
        ...(supportMenuItems(supportKind, nexusDomain, nodeData.platformId, supportVersion) ?? []),
        ...(nodeData.sourceType === ModSourceType.Local ? [
            {type: 'divider' as const},
            {
                label: t((nodeData.localNoFound || nodeData.status?.isLocalNotFound) ? 'localMods.locateMissingMenu' : 'localMods.locateMenu'),
                key: 'relocate',
                icon: <FolderOpenOutlined />,
            },
            {
                label: t(repoLink ? 'repoLink.changeMenu' : 'repoLink.menu'),
                key: 'repo_link',
                icon: <LinkOutlined />,
            },
            ...(repoLink
                ? [{label: t('repoLink.unlinkMenu'), key: 'repo_unlink', icon: <DisconnectOutlined />}]
                : []),
        ] : []),
    ];

    if (nodeData.isLeaf) {
        const hasProgress = nodeData.sourceType === ModSourceType.Modio || nodeData.sourceType === MODCAT_PLATFORM || nodeData.sourceType === NEXUSMODS_PLATFORM;
        const hasVersions = hasProgress;
        const tagTitles = rowInfo.tags;
        return (
            <Dropdown trigger={['contextMenu']}
                      menu={{
                          items: contextMenus,
                          onClick: (e) => {
                              // 处理 "移动到" 子菜单点击
                              if (e.key.startsWith('move_to_folder-')) {
                                  const targetFolderKey = e.key.replace('move_to_', '');
                                  onMoveToFolder?.(nodeData.key, targetFolderKey);
                              } else if (e.key === 'note_edit') {
                                  void editModNote(nodeData.modId, nodeData.title || nodeData.nameId || '');
                              } else if (e.key === 'note_remove') {
                                  void removeModNote(nodeData.modId, nodeData.title || nodeData.nameId || '');
                              } else if (handleSupportMenu(e.key, nexusDomain, nodeData.platformId,
                                  nodeData.title || nodeData.nameId || '', nodeData.usedVersion || undefined)) {
                                  // sent to Nexus Mods / mod.io
                              } else {
                                  onMenuClick(e.key, nodeData.key);
                              }
                          }
                      }}>
                <ModTreeViewProgressBackground nodeData={nodeData} onRowClick={onRowClick}>
  
                <PositionBadge nodeKey={String(nodeData.key)}
                               position={itemOrder ?? 1}
                               enabled={enabled}
                               onMove={onMoveToPosition}
                               groupSize={groupSize}
                               groupFirst={groupFirst}/>

                    <ModTreeViewSwitch nodeData={nodeData} onCountLabelUpdate={onCountLabelUpdate}/>

                    {/* columns view: the version picker sits in the Version column instead */}
                    {!columnsView && hasVersions && <ModTreeViewVersionSelect nodeData={nodeData}/>}

                    {
                        (nodeData.sourceType === ModSourceType.Modio || nodeData.sourceType === MODCAT_PLATFORM || nodeData.sourceType === NEXUSMODS_PLATFORM) &&
                        <ModDescriptionHover mod={describedMod}>
                            <ModTreeViewTitle nodeData={nodeData}/>
                        </ModDescriptionHover>
                    }

                    {
                        //nodeData.sourceType === ModSourceType.Modio &&
                        <ModTreeViewWarring nodeData={nodeData}
                                            onLocate={nodeData.sourceType === ModSourceType.Local
                                                ? () => onMenuClick('relocate', nodeData.key)
                                                : undefined}/>
                    }

                    {
                        nodeData.sourceType === ModSourceType.Local &&
                        <ModDescriptionHover mod={describedMod}>
                            <ModTreeViewLocalTitle nodeData={nodeData} />
                        </ModDescriptionHover>
                    }

                    {/* 右侧区域：tags 靠右 (columns view: tags and flags in fixed-width columns) */}
                    <span style={{ marginLeft: "auto", display: "flex", alignItems: "center", gap: "4px" }}>
                        {columnsView ? (
                            <>
                                {hasProgress && <ModTreeViewProgressPercent nodeData={nodeData}/>}
                                <span className="mod-col mod-col-version">
                                    {hasVersions ? <ModTreeViewVersionSelect nodeData={nodeData}/> : <UploadedDate info={rowInfo}/>}
                                </span>
                                <span className="mod-col mod-col-game"><GameTag info={rowInfo}/></span>
                                <span className="mod-col mod-col-status"><StatusTags info={rowInfo}/></span>
                                <Tooltip title={tagTitles.length > 1 ? tagTitles.join(" · ") : undefined} mouseEnterDelay={0.5}>
                                    <span className="mod-col mod-col-tags"><TagList info={rowInfo}/></span>
                                </Tooltip>
                            </>
                        ) : (
                            <>
                                <TagList info={rowInfo}/>
                                <StatusTags info={rowInfo} compact/>
                                <GameTag info={rowInfo} compact/>
                                {hasProgress && <ModTreeViewProgressPercent nodeData={nodeData}/>}
                            </>
                        )}

                        <ModStatusIcons nodeData={nodeData}/>
                    </span>
                </ModTreeViewProgressBackground>
            </Dropdown>
        );
    } else {
        return (
            <ModTreeViewFolder 
                nodeData={nodeData} 
                onMenuClick={onMenuClick}
                folders={folders}
                onMoveToFolder={onMoveToFolder}
                expanded={expanded}
                folderPick={folderPick}
                onRowClick={onRowClick}
            />
        );
    }
}
