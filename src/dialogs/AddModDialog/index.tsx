import React from 'react';
import {t} from "i18next";
import {Button, Flex, Form, message, Select, Tabs, Typography} from 'antd';
import {FolderAddOutlined} from "@ant-design/icons";
import {emitEvent, emitVoidEvent, listenEvent, type UnlistenFn} from "@/events";
import {LocalTab} from "@/dialogs/AddModDialog/LocalTab.tsx";
import {OnlineTab} from "@/dialogs/AddModDialog/OnlineTab.tsx";
import {SubscribedTab} from "@/dialogs/AddModDialog/SubscribedTab.tsx";
import {BasePage} from "@/pages/IBasePage.ts";
import {autoBind} from "@/utils/ReactUtils.ts";
import {DialogProfileService, foldersInTreeOrder, type LabeledFolder} from "@/services/DialogProfileService.ts";
import {askNewFolder} from "@/dialogs/NewFolderPrompt";
import {AppInitializer} from "@/core/AppInitializer";
import {registerIoC} from "@/core/IoCRegistration.ts";
import {mergeLines} from "@/utils/LocalModPaths";
import {
    countElsewhere,
    folderNameTaken,
    type FolderOverrides,
    followNewDefault,
    itemKey,
    type ItemFolders,
    ownFolders,
    type PlannedFolder,
    setItemFolder,
    withPlannedFolders,
} from "@/dialogs/AddModDialog/ItemFolders";

export enum AddModType {
    ONLINE = "online",
    LOCAL = "local",
    SUBSCRIBED = "subscribed"
}

export const LAST_SELECTED_GROUP_KEY = 'add-mod-dialog-last-group-id';

interface AddModDialogStates {
    addModType?: string;
    groupOptions?: any[];
    groupId?: number;
    loading?: boolean;
    text?: string;
    textRevision?: number;
    paths?: string[];
    pathsRevision?: number;
    /** Mods given another folder than the dialog's, by item key */
    folderOverrides?: FolderOverrides;
    /** Each tab's listed mods (item keys), to count those going elsewhere */
    itemKeys?: Record<string, string[]>;
    /** The profile's folders as loaded */
    folderList?: LabeledFolder[];
    /** Folders made here; created on OK (only those mods go to) */
    plannedFolders?: PlannedFolder[];
}

export interface AddModDialogResult {
    addModType?: string;
    groupId?: number;
    list?: string[];
    modInfoList?: any[];
    onlineList?: string[];
    localList?: string[];
    /** Mods going to another folder than groupId: file path / link / mod.io id → folder id */
    localFolders?: Record<string, number>;
    onlineFolders?: Record<string, number>;
    subscribedFolders?: Record<string, number>;
    /** Folders made in the window (negative ids above refer to them) */
    newFolders?: PlannedFolder[];
}

/** Folder choices for the pickers: the profile's folders and the new ones, in list order */
function folderOptions(folderList: LabeledFolder[], planned: PlannedFolder[]): { label: string; value: number }[] {
    return foldersInTreeOrder(withPlannedFolders(folderList, planned) as LabeledFolder[]).map(f => ({
        label: f.id < 0 ? `${f.label} ${t("newFolder.newMark")}` : f.label,
        value: f.id,
    }));
}

export class AddModDialog extends BasePage<any, AddModDialogStates> {
    private dialogProfileService = new DialogProfileService();

    private readonly onlineFormRef: any = React.createRef();
    private readonly localFormRef: any = React.createRef();
    private readonly subscribedFormRef: any = React.createRef();
    private unlistenInitData?: UnlistenFn;

    public constructor(props: any) {
        super(props);

        this.state = {
            addModType: AddModType.LOCAL,
            groupId: 0,
            groupOptions: [],
            folderOverrides: {},
            itemKeys: {},
            folderList: [],
            plannedFolders: [],
        }
    }

    private nextPlannedId = -1;

    /**
     * Make a folder (named and placed in a small dialog) and put the dialog's mods there, or
     * only the mod with this key
     */
    @autoBind
    private async newFolder(forKey?: string) {
        const folderList = this.state.folderList ?? [];
        const planned = this.state.plannedFolders ?? [];
        const choice = await askNewFolder({
            folders: this.state.groupOptions ?? [],
            taken: (name, parentId) => folderNameTaken(folderList, planned, name, parentId),
        });
        if (!choice) return;
        const folder: PlannedFolder = {id: this.nextPlannedId--, name: choice.name, parentId: choice.parentId};
        const nextPlanned = [...(this.state.plannedFolders ?? []), folder];
        this.setState({
            plannedFolders: nextPlanned,
            groupOptions: folderOptions(this.state.folderList ?? [], nextPlanned),
        }, () => {
            if (forKey) this.setItemFolder(forKey, folder.id);
            else this.onSelectGroupChange(folder.id);
        });
    }

    @autoBind
    private setItemFolder(key: string, folderId: number) {
        this.setState(prev => ({
            folderOverrides: setItemFolder(prev.folderOverrides ?? {}, key, folderId, prev.groupId ?? 0),
        }));
    }

    @autoBind
    private reportItems(prefix: string, keys: string[]) {
        this.setState(prev => {
            const current = prev.itemKeys?.[prefix] ?? [];
            if (current.length === keys.length && current.every((k, i) => k === keys[i])) return null;
            return {itemKeys: {...(prev.itemKeys ?? {}), [prefix]: keys}};
        });
    }

    /** Listed mods of the tabs OK would add from */
    private submittedKeys(): string[] {
        const keys = this.state.itemKeys ?? {};
        return this.state.addModType === AddModType.SUBSCRIBED
            ? keys.modio ?? []
            : [...(keys.local ?? []), ...(keys.link ?? [])];
    }

    @autoBind
    private putAllInDialogFolder() {
        this.setState({folderOverrides: {}});
    }

    private itemFolders(): ItemFolders {
        return {
            options: this.state.groupOptions ?? [],
            defaultId: this.state.groupId ?? 0,
            overrides: this.state.folderOverrides ?? {},
            set: this.setItemFolder,
            report: this.reportItems,
            newFolder: this.newFolder,
        };
    }


    @autoBind
    private async handleOk() {
        let list: string[] = [];
        let modInfoList: any[] | undefined;
        // Links and local files can be gathered in both tabs; add all of them
        const onlineList: string[] = this.onlineFormRef.current?.submit() ?? [];
        const localList: string[] = this.localFormRef.current?.submit() ?? [];

        switch (this.state.addModType) {
            case AddModType.ONLINE: {
                list = onlineList;
                break;
            }
            case AddModType.LOCAL: {
                list = localList;
                break;
            }
            case AddModType.SUBSCRIBED: {
                const selected = this.subscribedFormRef.current?.submit() ?? [];
                modInfoList = selected;
                list = selected.map((m: any) => m.profile_url);
                break;
            }
            default:
                break;
        }

        const isFileOrLinkTab = this.state.addModType !== AddModType.SUBSCRIBED;
        const nothingGathered = isFileOrLinkTab
            ? onlineList.length === 0 && localList.length === 0
            : list.length === 0 && (!modInfoList || modInfoList.length === 0);
        if (nothingGathered) {
            message.warning(t("Please input mod"));
            return;
        }

        const overrides = this.state.folderOverrides ?? {};
        const groupId = this.state.groupId!;
        await emitEvent('add-mod-dialog-ok', {
            groupId,
            newFolders: this.state.plannedFolders ?? [],
            addModType: this.state.addModType!,
            list: list,
            modInfoList: modInfoList,
            ...(isFileOrLinkTab ? {
                onlineList,
                localList,
                localFolders: ownFolders(localList, itemKey.local, overrides, groupId),
                onlineFolders: ownFolders(onlineList, itemKey.link, overrides, groupId),
            } : {
                subscribedFolders: ownFolders((modInfoList ?? []).map((m: any) => String(m.id)), itemKey.modio, overrides, groupId),
            }),
        });
    }

    @autoBind
    private async handleCancel() {
        await emitVoidEvent('add-mod-dialog-close');
    }

    /**
     * 解析 groupId：优先使用传入的 groupId（如果在文件夹列表中存在），
     * 否则使用缓存的上次选择，最后回退到第一个文件夹
     */
    private resolveGroupId(groupId: number | undefined, folders: any[]): number {
        // 1. 如果传入了有效的 groupId 且在当前文件夹列表中存在，直接使用
        if (groupId && folders?.some(f => f.id === groupId)) {
            return groupId;
        }

        // 2. 尝试使用缓存的上次选择
        const cachedId = parseInt(localStorage.getItem(LAST_SELECTED_GROUP_KEY) || '0');
        if (cachedId && folders?.some(f => f.id === cachedId)) {
            return cachedId;
        }

        // 3. 回退到第一个文件夹
        if (folders && folders.length > 0) {
            return folders[0].id;
        }

        return 0;
    }

    @autoBind
    private handleTabChange(key: string) {
        this.setState({
            addModType: key
        });
    }

    @autoBind
    private onSelectGroupChange(value: number) {
        // mods given the newly chosen folder simply follow it now
        this.setState(prev => ({
            groupId: value,
            folderOverrides: followNewDefault(prev.folderOverrides ?? {}, value),
        }));
        // 缓存用户选择的文件夹 (a new folder is remembered once it's created)
        if (value > 0) localStorage.setItem(LAST_SELECTED_GROUP_KEY, String(value));
    }

    @autoBind
    private async loadGroupOptions() {
        // in mod-list order, subfolders labelled with their path
        const profileFolderList = await this.dialogProfileService.getActiveProfileFolderChoices();

        this.setState(prev => {
            const planned = prev.plannedFolders ?? [];
            const ids = new Set([...profileFolderList.map(f => f.id), ...planned.map(p => p.id)]);
            // folders deleted meanwhile: their mods go to the dialog's folder again
            const overrides = prev.folderOverrides ?? {};
            const kept = Object.fromEntries(Object.entries(overrides).filter(([, id]) => ids.has(id)));
            return {
                folderList: profileFolderList,
                groupOptions: folderOptions(profileFolderList, planned),
                ...(Object.keys(kept).length !== Object.keys(overrides).length ? {folderOverrides: kept} : {}),
            };
        });

        // Return the folder list for immediate use (since setState is async)
        return profileFolderList;
    }

    private getInitDataFromUrl() {
        try {
            const queryIndex = window.location.hash.indexOf('?');
            if (queryIndex < 0) return null;

            const params = new URLSearchParams(window.location.hash.slice(queryIndex + 1));
            const init = params.get('init');
            return init ? JSON.parse(init) : null;
        } catch (error) {
            console.warn('[AddModDialog] Failed to parse init data from URL:', error);
            return null;
        }
    }

    private getInitDataFromStorage() {
        try {
            const initDataStr = localStorage.getItem('add-mod-dialog-init-data');
            return initDataStr ? JSON.parse(initDataStr) : null;
        } catch (error) {
            console.warn('[AddModDialog] Failed to parse init data from storage:', error);
            return null;
        }
    }

    async componentDidMount(): Promise<void> {
        // Ensure core is initialized (multi-window support)
        // Register ViewModels if not already registered
        registerIoC();

        if (!AppInitializer.isCoreReady()) {
            console.log('[AddModDialog] Core not ready, initializing...');
            await AppInitializer.initializeCore();
        }

        this.hookWindowResized();

        // Load group options and get the folder list immediately
        const groupFolders = await this.loadGroupOptions();

        // Load dialog data
        const initData = this.getInitDataFromUrl()
            ?? this.getInitDataFromStorage()
            ?? {addModType: AddModType.LOCAL, groupId: 0, text: ""};

        // Resolve groupId: use provided groupId > cached last selection > first folder
        const resolvedGroupId = this.resolveGroupId(initData.groupId, groupFolders);

        this.setState({
            addModType: initData.addModType,
            groupId: resolvedGroupId,
            text: initData.text,
            textRevision: initData.revision ?? 0,
            paths: initData.paths ?? [],
            pathsRevision: initData.revision ?? 0,
        });

        // ✅ Listen for dialog data updates (when window is reused)
        this.unlistenInitData = await listenEvent("add-mod-dialog-init-data", async (payload) => {
            console.log("AddModDialog init event", {
                ...payload,
                text: sanitizeDownloadTextForLog(payload.text),
            });
            // Reload group options to ensure they're up-to-date
            const groupFolders = await this.loadGroupOptions();

            // Dialog already open: keep the chosen group unless a specific one was requested
            const resolvedGroupId = payload.groupId
                ? this.resolveGroupId(payload.groupId, groupFolders)
                : (this.state.groupId || this.resolveGroupId(0, groupFolders));

            // Append new links/paths to what is already gathered instead of replacing it
            const revision = payload.revision ?? Date.now();
            const update: AddModDialogStates = {
                addModType: payload.addModType,
                groupId: resolvedGroupId,
            };
            if (payload.text) {
                const currentText: string = this.onlineFormRef.current?.getText?.() ?? this.state.text ?? "";
                update.text = mergeLines(currentText, payload.text);
                update.textRevision = revision;
            }
            if (payload.paths && payload.paths.length > 0) {
                update.paths = payload.paths;
                update.pathsRevision = revision;
            }
            this.setState(update);
        });
    }

    componentWillUnmount(): void {
        this.unhookWindowResized();
        // ✅ 清理监听器
        if (this.unlistenInitData) {
            this.unlistenInitData();
        }
    }

    render() {
        const folders = this.itemFolders();
        const elsewhere = countElsewhere(folders.overrides, this.submittedKeys(), folders.defaultId);
        const canPick = folders.options.length > 1;
        return (
            <div className="add-mod-dialog"
                 style={{
                     height: window.innerHeight - 40
                 }}>
                <Tabs activeKey={this.state.addModType}
                      onChange={this.handleTabChange}
                      items={
                          [
                              {
                                  key: AddModType.LOCAL,
                                  label: t("Local"),
                                  // Keep mounted so gathered files are submitted from any tab
                                  forceRender: true,
                                  children: <LocalTab ref={this.localFormRef}
                                                      paths={this.state.paths}
                                                      revision={this.state.pathsRevision}
                                                      folders={folders}/>,
                              },
                              {
                                  key: AddModType.ONLINE,
                                  label: t("Online"),
                                  forceRender: true,
                                  children: <OnlineTab ref={this.onlineFormRef}
                                                       text={this.state.text}
                                                       revision={this.state.textRevision}
                                                       folders={folders}/>,
                              },
                              {
                                  key: AddModType.SUBSCRIBED,
                                  label: t("mod.io Subscribed"),
                                  children: <SubscribedTab ref={this.subscribedFormRef} folders={folders}/>,
                              }
                          ]
                      }>
                </Tabs>
                <Form layout="vertical">
                    <Form.Item name="groupId"
                               label={t("addMod.folder")}
                               rules={[{required: true}]}
                               extra={canPick
                                   ? (elsewhere > 0
                                       ? <span>
                                           {t("addMod.otherFolders", {count: elsewhere})}{" "}
                                           <Typography.Link onClick={this.putAllInDialogFolder}>{t("addMod.allHere")}</Typography.Link>
                                       </span>
                                       : t("addMod.folderHint"))
                                   : undefined}>
                        <Flex gap={8}>
                            <Select value={this.state.groupId}
                                    options={this.state.groupOptions}
                                    onChange={this.onSelectGroupChange}
                                    showSearch
                                    optionFilterProp="label"
                                    style={{flex: 1, minWidth: 0}}
                            />
                            <Button icon={<FolderAddOutlined/>}
                                    title={t("newFolder.buttonTip")}
                                    onClick={() => this.newFolder()}>
                                {t("newFolder.button")}
                            </Button>
                        </Flex>
                    </Form.Item>
                </Form>
                <Flex gap={"large"}
                      style={{
                          alignItems: "center",
                          alignContent: "center",
                          justifyContent: "center",
                      }}
                >
                    <Button type={"primary"}
                            style={{width: 100}}
                            onClick={this.handleOk}
                    >
                        OK
                    </Button>
                    <Button style={{width: 100}}
                            onClick={this.handleCancel}
                    >
                        Cancel
                    </Button>
                </Flex>
            </div>
        );
    }
}

function sanitizeDownloadTextForLog(text: string | undefined): string {
    if (!text) return "";
    return text.replace(/([?&](?:key|expires|user_id|md5)=)[^&#\s]+/gi, '$1[REDACTED]');
}
