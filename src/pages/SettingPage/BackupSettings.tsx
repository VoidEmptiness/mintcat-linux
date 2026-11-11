/**
 * Settings page: "Backups" (to a folder or a cloud account through rclone) and
 * "Mod settings files" (export/import the files mods keep in the game folder).
 */
import React, {useSyncExternalStore} from "react";
import {
    Alert,
    Button,
    Card,
    Checkbox,
    Divider,
    Flex,
    Form,
    Input,
    InputNumber,
    Radio,
    Select,
    Space,
    Table,
    Tag,
    Tooltip,
    Typography,
    message,
} from "antd";
import {
    CloudUploadOutlined,
    DeleteOutlined,
    DownloadOutlined,
    ExportOutlined,
    FolderOpenOutlined,
    ImportOutlined,
    LinkOutlined,
    ReloadOutlined,
    RollbackOutlined,
} from "@ant-design/icons";
import {t} from "i18next";
import {open, save} from "@tauri-apps/plugin-dialog";
import {openPath} from "@tauri-apps/plugin-opener";
import {exists, remove} from "@tauri-apps/plugin-fs";
import {SettingLayout} from "@/pages/SettingPage/Layout.ts";
import {MessageBox} from "@/components/MessageBox";
import {
    Backups,
    DEFAULT_REMOTE_PATH,
    Rclone,
    type BackupEntry,
    type RcloneRemote,
    type RestorePlan,
} from "@/services/Backups";
import {
    exportZip,
    isProtectedSave,
    listFolder,
    planImport,
    readFolderSource,
    readZipSource,
    settingsFolder,
    type ImportItem,
    type ImportSource,
    type LocalSettingsFile,
} from "@/services/ModSettingsFiles";
import {formatBytes} from "@/dialogs/backup/SettingsFilesTable";
import {defaultSaveLocation} from "@/utils/SaveLocation";
import {ModSettingsImportDialog} from "@/dialogs/backup/ModSettingsImportDialog";
import {RestoreBackupDialog} from "@/dialogs/backup/RestoreBackupDialog";
import {ConnectCloudDialog} from "@/dialogs/backup/ConnectCloudDialog";
import {KeptCopies, type CopiesInfo} from "@/services/KeptCopies";
import {confirmDelete} from "@/services/DeleteConfirm";

function errorText(e: unknown): string {
    return e instanceof Error ? e.message : String(e);
}

function stamp(): string {
    const d = new Date();
    const p = (n: number) => String(n).padStart(2, "0");
    return `${d.getFullYear()}-${p(d.getMonth() + 1)}-${p(d.getDate())}`;
}

// ---------------------------------------------------------------------------------------------
// Copies MINTCAT kept of what it replaced (settings files before an import, the database before
// a restore), with a button to delete them

const KEPT = {
    settings: {
        load: () => KeptCopies.settingsCopies(),
        remove: () => KeptCopies.deleteSettingsCopies(),
        label: "keptCopies.settingsLabel", help: "keptCopies.settingsHelp",
        confirmTitle: "keptCopies.settingsConfirmTitle", confirm: "keptCopies.settingsConfirm",
        summary: "keptCopies.settingsSummary", folder: true,
    },
    config: {
        load: () => KeptCopies.configCopies(),
        remove: () => KeptCopies.deleteConfigCopies(),
        label: "keptCopies.configLabel", help: "keptCopies.configHelp",
        confirmTitle: "keptCopies.configConfirmTitle", confirm: "keptCopies.configConfirm",
        summary: "keptCopies.configSummary", folder: true,
    },
    database: {
        load: () => KeptCopies.databaseCopy(),
        remove: () => KeptCopies.deleteDatabaseCopy(),
        label: "keptCopies.databaseLabel", help: "keptCopies.databaseHelp",
        confirmTitle: "keptCopies.databaseConfirmTitle", confirm: "keptCopies.databaseConfirm",
        summary: "", folder: false,
    },
} as const;

export function KeptCopiesRow({kind, refreshKey}: { kind: keyof typeof KEPT; refreshKey?: number }) {
    const [info, setInfo] = React.useState<CopiesInfo | null>();
    const [deleting, setDeleting] = React.useState(false);
    const k = KEPT[kind];

    const load = React.useCallback(async () => {
        try {
            setInfo(await KEPT[kind].load());
        } catch (e) {
            console.warn("[KeptCopies] could not read", e);
            setInfo(null);
        }
    }, [kind]);

    React.useEffect(() => {
        void load();
    }, [load, refreshKey]);

    const empty = !info || info.files === 0;
    const size = info ? formatBytes(info.bytes) : "";

    const onDelete = async () => {
        if (!info || empty) return;
        const ok = await confirmDelete({
            title: t(k.confirmTitle),
            content: t(k.confirm, {files: info.files, size}),
            okText: t("keptCopies.delete"),
        });
        if (!ok) return;
        setDeleting(true);
        try {
            await k.remove();
            message.success(t("keptCopies.deleted", {size}));
        } catch (e) {
            message.error(`${t("keptCopies.deleteFailed")}: ${errorText(e)}`);
        } finally {
            setDeleting(false);
            void load();
        }
    };

    return (
        <Form.Item label={t(k.label)} tooltip={t(k.help)}>
            <Flex align="center" gap={8} wrap>
                <Typography.Text type={empty ? "secondary" : undefined}>
                    {info === undefined ? "…"
                        : empty ? t("keptCopies.none")
                            : k.summary ? t(k.summary, {count: info!.count, files: info!.files, size})
                                : size}
                </Typography.Text>
                {k.folder && !empty && (
                    <Tooltip title={t("keptCopies.openFolder")}>
                        <Button size="small" icon={<FolderOpenOutlined/>}
                                onClick={() => void openPath(info!.path).catch(e => message.error(errorText(e)))}/>
                    </Tooltip>
                )}
                <Button size="small" danger icon={<DeleteOutlined/>} disabled={empty} loading={deleting} onClick={onDelete}>
                    {t("keptCopies.delete")}
                </Button>
            </Flex>
        </Form.Item>
    );
}

// ---------------------------------------------------------------------------------------------
// Mod settings files

export function ModSettingsCard() {
    const [folder, setFolder] = React.useState<string | undefined>();
    const [files, setFiles] = React.useState<LocalSettingsFile[]>([]);
    const [loading, setLoading] = React.useState(true);
    const [importing, setImporting] = React.useState<{ source: ImportSource; target: string; items: ImportItem[] }>();
    const [copiesVersion, setCopiesVersion] = React.useState(0);

    const refresh = React.useCallback(async () => {
        setLoading(true);
        try {
            const target = await settingsFolder();
            setFolder(target);
            setFiles(target ? await listFolder(target) : []);
        } catch (e) {
            console.warn("[ModSettings] could not read the folder", e);
            setFiles([]);
        } finally {
            setLoading(false);
        }
    }, []);

    React.useEffect(() => {
        void refresh();
    }, [refresh]);

    const exportable = files.filter(f => !isProtectedSave(f.rel));
    const totalSize = exportable.reduce((s, f) => s + f.size, 0);

    const onExport = async () => {
        const dest = await save({
            defaultPath: await defaultSaveLocation(`drg-mod-settings_${stamp()}.zip`),
            filters: [{name: "Zip", extensions: ["zip"]}],
        });
        if (!dest) return;
        try {
            const count = await exportZip(dest, files);
            message.success(t("modSettings.exported", {count}));
        } catch (e) {
            message.error(`${t("modSettings.exportFailed")}: ${errorText(e)}`);
        }
    };

    const preview = async (source: ImportSource) => {
        if (!folder) return;
        const local = await listFolder(folder);
        setImporting({source, target: folder, items: planImport(source, local)});
    };

    const onImportZip = async () => {
        const picked = await open({multiple: false, filters: [{name: "Zip", extensions: ["zip"]}]});
        if (!picked || Array.isArray(picked)) return;
        try {
            await preview(await readZipSource(picked));
        } catch (e) {
            message.error(`${t("modSettings.readFailed")}: ${errorText(e)}`);
        }
    };

    const onImportFolder = async () => {
        const picked = await open({directory: true, multiple: false});
        if (!picked || Array.isArray(picked)) return;
        try {
            const source = await readFolderSource(picked);
            if (folder && source.path.replace(/\/+$/, "") === folder.replace(/\/+$/, "")) {
                message.info(t("modSettings.sameFolder"));
                return;
            }
            await preview(source);
        } catch (e) {
            message.error(`${t("modSettings.readFailed")}: ${errorText(e)}`);
        }
    };

    return (
        <Card title={t("modSettings.title")} style={{marginBottom: "10px"}}>
            <Typography.Paragraph type="secondary" style={{marginTop: 0}}>
                {t("modSettings.help")}
            </Typography.Paragraph>
            <Form {...SettingLayout}>
                <Form.Item label={t("modSettings.folder")} tooltip={t("modSettings.folderHelp")}>
                    {folder ? (
                        <Space.Compact style={{width: "100%"}}>
                            <Input value={folder} readOnly/>
                            <Tooltip title={t("modSettings.openFolder")}>
                                <Button icon={<FolderOpenOutlined/>}
                                        disabled={loading || !files.length}
                                        onClick={async () => {
                                            if (await exists(folder)) await openPath(folder);
                                            else message.info(t("modSettings.folderMissing"));
                                        }}/>
                            </Tooltip>
                        </Space.Compact>
                    ) : (
                        <Alert type="warning" showIcon message={t("modSettings.noGamePath")}/>
                    )}
                </Form.Item>
                {folder && (
                    <Form.Item label={t("modSettings.files")}>
                        <Flex align="center" gap={8}>
                            <Typography.Text>
                                {loading ? "…" : t("modSettings.filesCount", {count: exportable.length, size: formatBytes(totalSize)})}
                            </Typography.Text>
                            {files.length > exportable.length && (
                                <Tooltip title={t("modSettings.protectedHint")}>
                                    <Tag>{t("modSettings.progressSkipped", {count: files.length - exportable.length})}</Tag>
                                </Tooltip>
                            )}
                            <Button size="small" type="text" icon={<ReloadOutlined/>} onClick={() => void refresh()}/>
                        </Flex>
                    </Form.Item>
                )}
                <Form.Item label={" "} colon={false}>
                    <Flex gap={8} wrap>
                        <Button icon={<ExportOutlined/>} disabled={!folder || !exportable.length} onClick={onExport}>
                            {t("modSettings.export")}
                        </Button>
                        <Button icon={<ImportOutlined/>} disabled={!folder} onClick={onImportZip}>
                            {t("modSettings.importZip")}
                        </Button>
                        <Button icon={<ImportOutlined/>} disabled={!folder} onClick={onImportFolder}>
                            {t("modSettings.importFolder")}
                        </Button>
                    </Flex>
                </Form.Item>
                <KeptCopiesRow kind="settings" refreshKey={copiesVersion}/>
            </Form>
            {importing && (
                <ModSettingsImportDialog {...importing}
                                         onClose={(imported) => {
                                             setImporting(undefined);
                                             if (imported) {
                                                 void refresh();
                                                 setCopiesVersion(v => v + 1);
                                             }
                                         }}/>
            )}
        </Card>
    );
}

// ---------------------------------------------------------------------------------------------
// Backups

export function BackupsCard() {
    const version = useSyncExternalStore(Backups.subscribe, Backups.version);
    const cfg = Backups.config(version);
    const busy = Backups.isBusy(version);

    const [rcloneVersion, setRcloneVersion] = React.useState<string | null | undefined>(undefined);
    const [remotes, setRemotes] = React.useState<RcloneRemote[]>([]);
    const [connecting, setConnecting] = React.useState(false);
    const [list, setList] = React.useState<BackupEntry[]>([]);
    const [listError, setListError] = React.useState<string>();
    const [listing, setListing] = React.useState(false);
    const [note, setNote] = React.useState("");
    const [restore, setRestore] = React.useState<{ plan: RestorePlan; title: string; temp?: string }>();
    const [opening, setOpening] = React.useState<string>();
    const [counts, setCounts] = React.useState<{ settings: number; paks: number; pakSize: number }>();
    const [remotePath, setRemotePath] = React.useState(cfg.remotePath);

    React.useEffect(() => {
        void Backups.load();
    }, []);

    React.useEffect(() => {
        setRemotePath(cfg.remotePath);
    }, [cfg.remotePath]);

    const checkRclone = React.useCallback(async () => {
        try {
            const v = await Rclone.version();
            setRcloneVersion(v);
            if (v) setRemotes(await Rclone.remotes());
        } catch (e) {
            console.warn("[Backups] rclone check failed", e);
            setRcloneVersion(null);
        }
    }, []);

    React.useEffect(() => {
        if (cfg.destination === "rclone" && rcloneVersion === undefined) void checkRclone();
    }, [cfg.destination, rcloneVersion, checkRclone]);

    React.useEffect(() => {
        void (async () => {
            const settings = await Backups.settingsFiles().then(r => r.files.length).catch(() => 0);
            const paks = await Backups.localModFiles().catch(() => []);
            let pakSize = 0;
            for (const pak of paks) pakSize += pak.size;
            setCounts({settings, paks: paks.length, pakSize});
        })();
        // counted again after each backup (files may have changed meanwhile)
    }, [busy]);

    const destinationKey = `${cfg.destination}|${cfg.folder}|${cfg.remote}|${cfg.remotePath}`;
    const refreshList = React.useCallback(async () => {
        if (!Backups.isReady(Backups.config())) {
            setList([]);
            setListError(undefined);
            return;
        }
        setListing(true);
        try {
            setList(await Backups.list());
            setListError(undefined);
        } catch (e) {
            setList([]);
            setListError(errorText(e));
        } finally {
            setListing(false);
        }
    }, []);

    // also after each backup, wherever it was started (e.g. the title bar's backup button)
    React.useEffect(() => {
        if (!busy) void refreshList();
    }, [destinationKey, refreshList, busy]);

    const onBrowseFolder = async () => {
        const picked = await open({directory: true, multiple: false, defaultPath: cfg.folder || undefined});
        if (picked && !Array.isArray(picked)) await Backups.update({folder: picked});
    };

    const onBackupNow = async () => {
        try {
            const entry = await Backups.create({note: note.trim() || undefined});
            message.success(t("backup.created", {size: formatBytes(entry.size)}));
            setNote("");
            await refreshList();
        } catch (e) {
            console.error("[Backups] backup failed", e);
            message.error(`${t("backup.failed")}: ${errorText(e)}`);
        }
    };

    const openRestore = async (zipPath: string, title: string, temp?: string) => {
        const plan = await Backups.planRestore(zipPath);
        setRestore({plan, title, temp});
    };

    const onRestoreEntry = async (entry: BackupEntry) => {
        setOpening(entry.name);
        try {
            const {path, temporary} = await Backups.fetch(entry);
            await openRestore(path, t("backup.restore.title", {date: new Date(entry.createdAt).toLocaleString()}),
                temporary ? path : undefined);
        } catch (e) {
            message.error(`${t("backup.restore.readFailed")}: ${errorText(e)}`);
        } finally {
            setOpening(undefined);
        }
    };

    const onRestoreFile = async () => {
        const picked = await open({multiple: false, filters: [{name: "Zip", extensions: ["zip"]}]});
        if (!picked || Array.isArray(picked)) return;
        try {
            await openRestore(picked, t("backup.restore.titleFile"));
        } catch (e) {
            message.error(`${t("backup.restore.readFailed")}: ${errorText(e)}`);
        }
    };

    const onSaveCopy = async (entry: BackupEntry) => {
        const target = await save({defaultPath: await defaultSaveLocation(entry.name), filters: [{name: "Zip", extensions: ["zip"]}]});
        if (!target) return;
        setOpening(entry.name);
        try {
            await Backups.saveCopy(entry, target);
            message.success(t("backup.saved"));
        } catch (e) {
            message.error(errorText(e));
        } finally {
            setOpening(undefined);
        }
    };

    const onDelete = async (entry: BackupEntry) => {
        const ok = await confirmDelete({
            title: t("Delete"),
            content: t("backup.deleteConfirm", {name: entry.name}),
        });
        if (!ok) return;
        try {
            await Backups.delete(entry);
            await refreshList();
        } catch (e) {
            message.error(errorText(e));
        }
    };

    const onSaveToFile = async () => {
        const target = await save({defaultPath: await defaultSaveLocation(Backups.newBackupName(note.trim() || undefined)), filters: [{name: "Zip", extensions: ["zip"]}]});
        if (!target) return;
        try {
            const size = await Backups.writeZip(target, {note: note.trim() || undefined});
            message.success(t("backup.created", {size: formatBytes(size)}));
        } catch (e) {
            message.error(`${t("backup.failed")}: ${errorText(e)}`);
        }
    };

    const ready = Backups.isReady(cfg);

    return (
        <Card title={t("backup.title")} style={{marginBottom: "10px"}}>
            <Typography.Paragraph type="secondary" style={{marginTop: 0}}>
                {t("backup.help")}
            </Typography.Paragraph>
            <Form {...SettingLayout}>
                <Form.Item label={t("backup.saveTo")}>
                    <Radio.Group value={cfg.destination}
                                 onChange={e => void Backups.update({destination: e.target.value})}
                                 options={[
                                     {value: "folder", label: t("backup.dest.folder")},
                                     {value: "rclone", label: t("backup.dest.cloud")},
                                 ]}/>
                </Form.Item>

                {cfg.destination === "folder" ? (
                    <Form.Item label={t("backup.folder")} tooltip={t("backup.folderHelp")}>
                        <Space.Compact style={{width: "100%"}}>
                            <Input value={cfg.folder} readOnly placeholder={t("backup.folderPlaceholder")}/>
                            <Button icon={<FolderOpenOutlined/>} onClick={onBrowseFolder}>{t("backup.browse")}</Button>
                        </Space.Compact>
                    </Form.Item>
                ) : (
                    <>
                        {rcloneVersion === null && (
                            <Form.Item label={" "} colon={false}>
                                <Alert type="warning" showIcon
                                       message={t("backup.rclone.missing")}
                                       description={
                                           <Flex vertical gap={6}>
                                               <span>{t("backup.rclone.install")}</span>
                                               <Typography.Text code copyable>sudo pacman -S rclone</Typography.Text>
                                               <span>{t("backup.rclone.installOther")}</span>
                                               <Button size="small" style={{alignSelf: "flex-start"}} icon={<ReloadOutlined/>}
                                                       onClick={() => {
                                                           setRcloneVersion(undefined);
                                                           void checkRclone();
                                                       }}>
                                                   {t("backup.rclone.checkAgain")}
                                               </Button>
                                           </Flex>
                                       }/>
                            </Form.Item>
                        )}
                        {rcloneVersion && (
                            <>
                                <Form.Item label={t("backup.account")} tooltip={t("backup.accountHelp")}>
                                    <Flex gap={8}>
                                        <Select style={{flex: 1}}
                                                value={cfg.remote || undefined}
                                                placeholder={t("backup.accountPlaceholder")}
                                                onChange={value => void Backups.update({remote: value})}
                                                options={remotes.map(r => ({value: r.name, label: `${r.name} (${r.type})`}))}
                                                notFoundContent={t("backup.noAccounts")}/>
                                        <Button icon={<LinkOutlined/>} onClick={() => setConnecting(true)}>
                                            {t("backup.connectAccount")}
                                        </Button>
                                        <Tooltip title={t("backup.rclone.reload")}>
                                            <Button icon={<ReloadOutlined/>} onClick={() => void checkRclone()}/>
                                        </Tooltip>
                                    </Flex>
                                </Form.Item>
                                <Form.Item label={t("backup.remotePath")}>
                                    <Input value={remotePath}
                                           placeholder={DEFAULT_REMOTE_PATH}
                                           onChange={e => setRemotePath(e.target.value)}
                                           onBlur={() => void Backups.update({remotePath: remotePath.trim() || DEFAULT_REMOTE_PATH})}/>
                                </Form.Item>
                            </>
                        )}
                        {rcloneVersion === undefined && (
                            <Form.Item label={" "} colon={false}>
                                <Typography.Text type="secondary">{t("backup.rclone.checking")}</Typography.Text>
                            </Form.Item>
                        )}
                    </>
                )}

                <Form.Item label={t("backup.include")}>
                    <Flex vertical gap={2}>
                        <Checkbox checked disabled>{t("backup.includeDatabase")}</Checkbox>
                        <Checkbox checked={cfg.includeSettings}
                                  onChange={e => void Backups.update({includeSettings: e.target.checked})}>
                            {t("backup.includeSettings", {count: counts?.settings ?? 0})}
                        </Checkbox>
                        <Checkbox checked={cfg.includeLocalMods}
                                  onChange={e => void Backups.update({includeLocalMods: e.target.checked})}>
                            {t("backup.includeLocalMods", {count: counts?.paks ?? 0, size: formatBytes(counts?.pakSize ?? 0)})}
                        </Checkbox>
                    </Flex>
                </Form.Item>

                <Form.Item label={t("backup.auto")} tooltip={t("backup.autoHelp")}>
                    <Flex gap={8} align="center" wrap>
                        <Select style={{width: 140}}
                                value={cfg.auto}
                                onChange={value => void Backups.update({auto: value})}
                                options={[
                                    {value: "off", label: t("backup.autoOff")},
                                    {value: "daily", label: t("backup.autoDaily")},
                                    {value: "weekly", label: t("backup.autoWeekly")},
                                ]}/>
                        {cfg.auto !== "off" && (
                            <>
                                <Typography.Text>{t("backup.keep")}</Typography.Text>
                                <InputNumber min={1} max={100} style={{width: 70}}
                                             value={cfg.keepAuto}
                                             onChange={value => value && void Backups.update({keepAuto: value})}/>
                            </>
                        )}
                    </Flex>
                </Form.Item>

                <Form.Item label={t("backup.now")}>
                    <Space.Compact style={{width: "100%"}}>
                        <Input value={note}
                               onChange={e => setNote(e.target.value)}
                               placeholder={t("backup.optionalNote")}
                               maxLength={60}/>
                        <Button type="primary" icon={<CloudUploadOutlined/>} loading={busy} disabled={!ready}
                                onClick={onBackupNow}>
                            {t("backup.backUp")}
                        </Button>
                    </Space.Compact>
                </Form.Item>

                <Form.Item label={t("backup.files")}>
                    <Flex gap={8} wrap>
                        <Button icon={<DownloadOutlined/>} onClick={onSaveToFile}>{t("backup.saveToFile")}</Button>
                        <Button icon={<RollbackOutlined/>} onClick={onRestoreFile}>{t("backup.restoreFromFile")}</Button>
                    </Flex>
                </Form.Item>
                <KeptCopiesRow kind="database"/>
            </Form>

            <Divider style={{margin: "8px 0 12px"}}/>
            <Flex justify="space-between" align="center" style={{marginBottom: 8}}>
                <Typography.Text strong>
                    {t("backup.list")}
                    {ready && <Typography.Text type="secondary" style={{fontWeight: "normal"}}> · {Backups.describeDestination(cfg)}</Typography.Text>}
                </Typography.Text>
                <Button size="small" icon={<ReloadOutlined/>} loading={listing} disabled={!ready} onClick={() => void refreshList()}>
                    {t("Refresh")}
                </Button>
            </Flex>
            {listError && <Alert type="error" showIcon style={{marginBottom: 8}} message={t("backup.listFailed")}
                                 description={<span style={{whiteSpace: "pre-wrap"}}>{listError}</span>}/>}
            <Table<BackupEntry>
                size="small"
                rowKey="name"
                loading={listing}
                dataSource={list}
                pagination={list.length > 10 ? {pageSize: 10, size: "small"} : false}
                locale={{emptyText: ready ? t("backup.empty") : t("backup.chooseFirst")}}
                columns={[
                    {
                        title: t("backup.col.date"),
                        render: (_, entry) => (
                            <Flex gap={6} align="center">
                                <span>{new Date(entry.createdAt).toLocaleString()}</span>
                                {entry.auto && <Tag>{t("backup.autoTag")}</Tag>}
                            </Flex>
                        ),
                    },
                    {title: t("backup.note"), dataIndex: "note", ellipsis: true},
                    {title: t("backup.col.size"), width: 90, render: (_, entry) => formatBytes(entry.size)},
                    {
                        title: t("backup.col.actions"),
                        width: 230,
                        render: (_, entry) => (
                            <Flex gap={4}>
                                <Button size="small" icon={<RollbackOutlined/>}
                                        loading={opening === entry.name}
                                        onClick={() => void onRestoreEntry(entry)}>
                                    {t("backup.restoreButton")}
                                </Button>
                                {cfg.destination === "rclone" && (
                                    <Tooltip title={t("backup.saveCopy")}>
                                        <Button size="small" icon={<DownloadOutlined/>} onClick={() => void onSaveCopy(entry)}/>
                                    </Tooltip>
                                )}
                                <Tooltip title={t("Delete")}>
                                    <Button size="small" danger icon={<DeleteOutlined/>} onClick={() => void onDelete(entry)}/>
                                </Tooltip>
                            </Flex>
                        ),
                    },
                ]}/>

            {connecting && (
                <ConnectCloudDialog existing={remotes}
                                    onClose={async (name) => {
                                        setConnecting(false);
                                        if (name) {
                                            await checkRclone();
                                            await Backups.update({remote: name});
                                        }
                                    }}/>
            )}
            {restore && (
                <RestoreBackupDialog plan={restore.plan}
                                     title={restore.title}
                                     onClose={() => {
                                         const temp = restore.temp;
                                         setRestore(undefined);
                                         if (temp) void remove(temp).catch(() => undefined);
                                     }}/>
            )}
        </Card>
    );
}

export function BackupSettings() {
    return (
        <>
            <BackupsCard/>
            <ModSettingsCard/>
        </>
    );
}
