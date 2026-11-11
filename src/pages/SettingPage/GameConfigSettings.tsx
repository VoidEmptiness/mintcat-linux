/**
 * Settings page: "Game config files" — edit the game's Engine.ini, Game.ini, GameUserSettings.ini
 * and the rest where the game keeps them (under Proton: in its prefix), with every earlier version
 * kept and a read-only switch so the game doesn't write over hand-made changes.
 */
import React from "react";
import {Alert, Button, Card, Flex, Form, Input, Modal, Select, Space, Switch, Table, Tag, Tooltip, Typography, message} from "antd";
import {EditOutlined, FileAddOutlined, FolderOpenOutlined, LockOutlined, ReloadOutlined} from "@ant-design/icons";
import {t} from "i18next";
import {openPath} from "@tauri-apps/plugin-opener";
import {exists, readFile} from "@tauri-apps/plugin-fs";
import {SettingLayout} from "@/pages/SettingPage/Layout.ts";
import {KeptCopiesRow} from "@/pages/SettingPage/BackupSettings";
import {MessageBox} from "@/components/MessageBox";
import {formatBytes} from "@/dialogs/backup/SettingsFilesTable";
import {
    decodeConfig,
    GameConfigFiles,
    type ConfigBackup,
    type ConfigFile,
    type ConfigFolder,
    type DecodedText,
} from "@/services/GameConfigFiles";

function errorText(e: unknown): string {
    return e instanceof Error ? e.message : String(e);
}

function when(ms: number): string {
    return ms ? new Date(ms).toLocaleString() : "";
}

/** Text editor for one config file */
function ConfigEditor({folder, file, onClose}: {
    folder: ConfigFolder;
    file: ConfigFile;
    onClose: (saved: boolean) => void;
}) {
    const [loaded, setLoaded] = React.useState<DecodedText>();
    const [text, setText] = React.useState("");
    const [error, setError] = React.useState<string>();
    const [saving, setSaving] = React.useState(false);
    const [backups, setBackups] = React.useState<ConfigBackup[]>([]);
    /** The file as it was when opened, to notice when the game (or anything else) changed it since */
    const openedAs = React.useRef<{ size: number; mtime: number } | null>(null);
    const dirty = loaded !== undefined && text !== loaded.text;

    React.useEffect(() => {
        let gone = false;
        (async () => {
            try {
                const before = await GameConfigFiles.version(file.path);
                const read = await GameConfigFiles.read(file.path);
                if (gone) return;
                openedAs.current = before;
                setLoaded(read);
                setText(read.text);
                setBackups(await GameConfigFiles.backups(folder.store, file.name));
            } catch (e) {
                if (!gone) setError(errorText(e));
            }
        })();
        return () => {
            gone = true;
        };
    }, [file.path, file.name, folder.store]);

    const save = async () => {
        if (!loaded || saving) return;
        setSaving(true);
        try {
            const now = await GameConfigFiles.version(file.path);
            const was = openedAs.current;
            const changed = was === null ? now !== null : now === null || now.mtime !== was.mtime || now.size !== was.size;
            if (changed) {
                const ok = await MessageBox.confirm({
                    title: t("gameConfig.changedTitle"),
                    content: t("gameConfig.changedSinceOpened", {name: file.name}),
                    okText: t("gameConfig.overwrite"),
                });
                if (!ok) return;
            }
            await GameConfigFiles.save(folder.store, file, text, loaded);
            message.success(t("gameConfig.saved", {name: file.name}));
            onClose(true);
        } catch (e) {
            message.error(`${t("gameConfig.saveFailed")}: ${errorText(e)}`);
        } finally {
            setSaving(false);
        }
    };

    const close = async () => {
        if (dirty) {
            const ok = await MessageBox.confirm({
                title: t("gameConfig.discardTitle"),
                content: t("gameConfig.discard", {name: file.name}),
                okText: t("gameConfig.discardOk"),
            });
            if (!ok) return;
        }
        onClose(false);
    };

    const loadBackup = async (path: string) => {
        try {
            setText(decodeConfig(await readFile(path)).text);
            message.info(t("gameConfig.backupLoaded"));
        } catch (e) {
            message.error(errorText(e));
        }
    };

    return (
        <Modal open
               width={900}
               title={<Space>{file.name}{file.readonly && <Tag icon={<LockOutlined/>}>{t("gameConfig.readOnly")}</Tag>}</Space>}
               onCancel={() => void close()}
               maskClosable={false}
               footer={
                   <Flex justify="space-between" align="center" wrap gap={8}>
                       <Select size="small"
                               style={{minWidth: 260}}
                               placeholder={backups.length ? t("gameConfig.earlier", {count: backups.length}) : t("gameConfig.noEarlier")}
                               disabled={!backups.length}
                               value={null}
                               options={backups.map(b => ({value: b.path, label: `${when(b.time)} · ${formatBytes(b.size)}`}))}
                               onChange={(v) => v && void loadBackup(v)}/>
                       <Space>
                           <Button onClick={() => void close()}>{t("gameConfig.cancel")}</Button>
                           <Button type="primary" loading={saving} disabled={!loaded || (!dirty && file.exists)} onClick={() => void save()}>
                               {file.exists ? t("gameConfig.save") : t("gameConfig.create")}
                           </Button>
                       </Space>
                   </Flex>
               }>
            <Alert type="info" showIcon style={{marginBottom: 8}} message={t("gameConfig.editorNote")}/>
            {error ? (
                <Alert type="error" showIcon message={`${t("gameConfig.readFailed")}: ${error}`}/>
            ) : (
                <Input.TextArea value={text}
                                disabled={!loaded}
                                spellCheck={false}
                                onChange={(e) => setText(e.target.value)}
                                onKeyDown={(e) => {
                                    if ((e.ctrlKey || e.metaKey) && e.key.toLowerCase() === "s") {
                                        e.preventDefault();
                                        if (dirty || !file.exists) void save();
                                    }
                                }}
                                style={{
                                    height: "55vh",
                                    fontFamily: "ui-monospace, 'JetBrains Mono', 'DejaVu Sans Mono', monospace",
                                    fontSize: 13,
                                    whiteSpace: "pre",
                                    overflowWrap: "normal",
                                    overflowX: "auto",
                                }}/>
            )}
            <Typography.Text type="secondary" style={{display: "block", marginTop: 6, fontSize: 12, wordBreak: "break-all"}}>
                {file.path}
            </Typography.Text>
        </Modal>
    );
}

export function GameConfigCard() {
    const [folders, setFolders] = React.useState<ConfigFolder[]>();
    const [chosen, setChosen] = React.useState<string>();
    const [files, setFiles] = React.useState<ConfigFile[]>([]);
    const [loading, setLoading] = React.useState(false);
    const [editing, setEditing] = React.useState<ConfigFile>();
    const [copiesVersion, setCopiesVersion] = React.useState(0);

    const folder = folders?.find(f => f.path === chosen) ?? folders?.[0];

    const loadFiles = React.useCallback(async (path?: string) => {
        if (!path) {
            setFiles([]);
            return;
        }
        setLoading(true);
        try {
            setFiles(await GameConfigFiles.files(path));
        } catch (e) {
            console.warn("[GameConfig] could not list", e);
            setFiles([]);
        } finally {
            setLoading(false);
        }
    }, []);

    const refresh = React.useCallback(async () => {
        try {
            const found = await GameConfigFiles.folders();
            setFolders(found);
            const keep = found.find(f => f.path === chosen) ?? found[0];
            setChosen(keep?.path);
            await loadFiles(keep?.path);
        } catch (e) {
            console.warn("[GameConfig] could not find the folder", e);
            setFolders([]);
        }
    }, [chosen, loadFiles]);

    React.useEffect(() => {
        void refresh();
        // only on mount
        // eslint-disable-next-line react-hooks/exhaustive-deps
    }, []);

    const setReadOnly = async (file: ConfigFile, readonly: boolean) => {
        try {
            await GameConfigFiles.setReadOnly(file.path, readonly, true);
            message.success(t(readonly ? "gameConfig.lockedNow" : "gameConfig.unlockedNow", {name: file.name}));
        } catch (e) {
            message.error(errorText(e));
        }
        await loadFiles(folder?.path);
    };

    const kindLabel = (f: ConfigFolder) => t(f.kind === "prefix" ? "gameConfig.inPrefix" : "gameConfig.inGameFolder");

    return (
        <Card title={t("gameConfig.title")} style={{marginBottom: "10px"}}>
            <Typography.Paragraph type="secondary" style={{marginTop: 0}}>
                {t("gameConfig.help")}
            </Typography.Paragraph>
            <Form {...SettingLayout} style={{...SettingLayout.style, maxWidth: 900}}>
                <Form.Item label={t("gameConfig.folder")} tooltip={t("gameConfig.folderHelp")}>
                    {folders === undefined ? "…" : !folder ? (
                        <Alert type="warning" showIcon message={t("gameConfig.noGamePath")}/>
                    ) : (
                        <Space.Compact style={{width: "100%"}}>
                            {folders.length > 1 ? (
                                <Select value={folder.path}
                                        style={{width: "100%"}}
                                        onChange={(v) => {
                                            setChosen(v);
                                            void loadFiles(v);
                                        }}
                                        options={folders.map(f => ({
                                            value: f.path,
                                            label: `${kindLabel(f)}${f.exists ? "" : ` (${t("gameConfig.notThere")})`}: ${f.path}`,
                                        }))}/>
                            ) : (
                                <Input value={folder.path} readOnly/>
                            )}
                            <Tooltip title={t("gameConfig.openFolder")}>
                                <Button icon={<FolderOpenOutlined/>}
                                        onClick={async () => {
                                            if (await exists(folder.path)) await openPath(folder.path);
                                            else message.info(t("gameConfig.folderMissing"));
                                        }}/>
                            </Tooltip>
                            <Tooltip title={t("gameConfig.reload")}>
                                <Button icon={<ReloadOutlined/>} onClick={() => void refresh()}/>
                            </Tooltip>
                        </Space.Compact>
                    )}
                </Form.Item>
            </Form>
            {folder && (
                <>
                    {!folder.exists && (
                        <Alert type="warning" showIcon style={{marginBottom: 8}} message={t("gameConfig.folderNotCreated")}/>
                    )}
                    <Table<ConfigFile>
                        size="small"
                        rowKey="path"
                        loading={loading}
                        pagination={false}
                        dataSource={files}
                        columns={[
                            {
                                title: t("gameConfig.file"),
                                dataIndex: "name",
                                render: (name: string, f) => (
                                    <Typography.Text type={f.exists ? undefined : "secondary"}>{name}</Typography.Text>
                                ),
                            },
                            {
                                title: t("gameConfig.changed"),
                                dataIndex: "mtime",
                                render: (ms: number, f) => f.exists ? when(ms) : t("gameConfig.notCreated"),
                            },
                            {
                                title: t("gameConfig.size"),
                                dataIndex: "size",
                                render: (size: number, f) => f.exists ? formatBytes(size) : "",
                            },
                            {
                                title: (
                                    <Tooltip title={t("gameConfig.readOnlyHelp")}>
                                        <span>{t("gameConfig.readOnly")}</span>
                                    </Tooltip>
                                ),
                                dataIndex: "readonly",
                                render: (ro: boolean, f) => (
                                    <Switch size="small" checked={ro} disabled={!f.exists}
                                            onChange={(on) => void setReadOnly(f, on)}/>
                                ),
                            },
                            {
                                title: "",
                                key: "edit",
                                align: "right",
                                render: (_: unknown, f) => (
                                    <Button size="small"
                                            icon={f.exists ? <EditOutlined/> : <FileAddOutlined/>}
                                            onClick={() => setEditing(f)}>
                                        {f.exists ? t("gameConfig.edit") : t("gameConfig.create")}
                                    </Button>
                                ),
                            },
                        ]}/>
                </>
            )}
            <Form {...SettingLayout} style={{...SettingLayout.style, marginTop: 12}}>
                <KeptCopiesRow kind="config" refreshKey={copiesVersion}/>
            </Form>
            {editing && folder && (
                <ConfigEditor folder={folder} file={editing}
                              onClose={(saved) => {
                                  setEditing(undefined);
                                  if (saved) {
                                      void loadFiles(folder.path);
                                      setCopiesVersion(v => v + 1);
                                  }
                              }}/>
            )}
        </Card>
    );
}
