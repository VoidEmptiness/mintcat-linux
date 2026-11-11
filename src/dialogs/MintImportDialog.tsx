/**
 * "Import from mint": pick (or drop) mint's mod_data.json, check which folder each mint group
 * goes into, then add everything to the active profile. Mounted once in App; opened with
 * openMintImport() from the mod list toolbar, Settings, Configuration management or a file drop.
 */
import {useRef, useState} from "react";
import {t} from "i18next";
import {Alert, Button, Checkbox, Flex, Modal, Progress, Select, Typography} from "antd";
import {FileSearchOutlined} from "@ant-design/icons";
import {open as openFileDialog} from "@tauri-apps/plugin-dialog";
import {exists, readTextFile} from "@tauri-apps/plugin-fs";
import {configDir, join} from "@tauri-apps/api/path";
import {DialogProfileService} from "@/services/DialogProfileService";
import {
    describeFolders,
    FolderChoice,
    GroupPlan,
    matchFolder,
    MintImportResult,
    MintModData,
    parseMintModData,
    runMintImport,
} from "@/services/MintImport";
import {emitEvent, emitVoidEvent, useEventListener} from "@/events";
import {logActivity} from "@/services/ActivityLog";

const NEW_FOLDER = -1;

/** Opens the import dialog; pass the file when it was already picked or dropped. */
export async function openMintImport(file?: { path?: string; text?: string }) {
    await emitEvent('mint-import-open', file ?? {});
}

async function defaultMintFolder(): Promise<string | undefined> {
    try {
        const dir = await join(await configDir(), "drg-mod-integration", "config");
        return (await exists(dir)) ? dir : undefined;
    } catch {
        return undefined;
    }
}

function ResultList({title, items, type}: { title: string; items: string[]; type: "danger" | "warning" | "secondary" }) {
    if (items.length === 0) return null;
    return (
        <Flex vertical gap={2}>
            <Typography.Text strong type={type === "secondary" ? undefined : type}>{title}</Typography.Text>
            <div style={{maxHeight: 140, overflowY: "auto", fontFamily: "monospace", fontSize: 12, paddingLeft: 8}}>
                {items.map((item, i) => <div key={i} style={{wordBreak: "break-all"}}>{item}</div>)}
            </div>
        </Flex>
    );
}

export function MintImportDialog() {
    const [open, setOpen] = useState(false);
    const [filePath, setFilePath] = useState("");
    const [data, setData] = useState<MintModData | null>(null);
    const [profileName, setProfileName] = useState("");
    const [folders, setFolders] = useState<FolderChoice[]>([]);
    const [targets, setTargets] = useState<Record<string, number>>({});
    const [keepEnabled, setKeepEnabled] = useState(true);
    const [error, setError] = useState("");
    const [running, setRunning] = useState(false);
    const [progress, setProgress] = useState({done: 0, total: 0, label: ""});
    const [result, setResult] = useState<MintImportResult | null>(null);
    const stopRef = useRef(false);

    const profile = data?.profiles.find(p => p.name === profileName);

    const mapGroups = (d: MintModData, name: string, list: FolderChoice[]) => {
        const next: Record<string, number> = {};
        for (const group of d.profiles.find(p => p.name === name)?.groups ?? []) {
            next[group.name] = matchFolder(group.name, list)?.id ?? NEW_FOLDER;
        }
        setTargets(next);
    };

    const loadFile = async (path: string, text?: string) => {
        setError("");
        setResult(null);
        setFilePath(path);
        try {
            const parsed = parseMintModData(text ?? await readTextFile(path));
            const list = describeFolders(await new DialogProfileService().getActiveProfileFolders());
            setData(parsed);
            setFolders(list);
            setProfileName(parsed.activeProfile);
            mapGroups(parsed, parsed.activeProfile, list);
        } catch (e) {
            setData(null);
            setError(String(e).includes("not-mint") ? t("mintImport.notMint") : t("mintImport.readFailed", {reason: String(e)}));
        }
    };

    const chooseFile = async () => {
        const picked = await openFileDialog({
            title: t("mintImport.chooseTitle"),
            multiple: false,
            directory: false,
            defaultPath: await defaultMintFolder(),
            filters: [{name: "mod_data.json", extensions: ["json"]}],
        });
        if (!picked || Array.isArray(picked)) return;
        await loadFile(picked);
    };

    useEventListener('mint-import-open', async (file) => {
        if (running) {
            setOpen(true);
            return;
        }
        setFilePath("");
        setData(null);
        setError("");
        setResult(null);
        setOpen(true);
        if (file?.text != null || file?.path) {
            await loadFile(file.path ?? "", file.text);
        }
    });

    const onClose = () => setOpen(false);

    const start = async () => {
        if (!profile) return;
        const plans: GroupPlan[] = profile.groups
            .filter(g => g.mods.length > 0)
            .map(g => ({group: g, folderId: targets[g.name] === NEW_FOLDER || targets[g.name] == null ? null : targets[g.name]}));
        stopRef.current = false;
        setRunning(true);
        setResult(null);
        await logActivity('info', t("mintImport.started", {profile: profile.name}), filePath, 'import');
        try {
            const r = await runMintImport(plans, {keepEnabled},
                (done, total, label) => setProgress({done, total, label}),
                () => stopRef.current);
            setResult(r);
            await logActivity(r.brokenLinks.length + r.missingFiles.length + r.failed.length > 0 ? 'warning' : 'success',
                t("mintImport.summary", {
                    added: r.added, existing: r.alreadyInList,
                    problems: r.brokenLinks.length + r.missingFiles.length + r.failed.length,
                }), undefined, 'import');
        } catch (e) {
            const message = e instanceof Error ? e.message : String(e);
            setError(message);
            await logActivity('error', message, undefined, 'import');
        } finally {
            setRunning(false);
            await emitVoidEvent('mods-added');
        }
    };

    const close = () => {
        if (running) {
            stopRef.current = true;
            return;
        }
        onClose();
    };

    const folderOptions = (groupName: string) => [
        ...folders.map(f => ({value: f.id, label: f.path})),
        {value: NEW_FOLDER, label: t("mintImport.newFolder", {name: groupName || "mint"})},
    ];

    const totalMods = profile?.groups.reduce((n, g) => n + g.mods.length, 0) ?? 0;

    return (
        <Modal open={open}
               title={t("mintImport.title")}
               width={640}
               onCancel={close}
               maskClosable={false}
               destroyOnHidden
               footer={result
                   ? <Button type="primary" onClick={onClose}>{t("log.close")}</Button>
                   : running
                       ? <Button danger onClick={() => (stopRef.current = true)}>{t("mintImport.stop")}</Button>
                       : <Flex gap={8} justify="flex-end">
                           <Button onClick={onClose}>{t("Cancel")}</Button>
                           <Button type="primary" disabled={!profile || totalMods === 0} onClick={start}>
                               {t("mintImport.import", {count: totalMods})}
                           </Button>
                       </Flex>}>
            <Flex vertical gap={12}>
                <Typography.Paragraph type="secondary" style={{fontSize: 13, marginBottom: 0}}>
                    {t("mintImport.hint")}
                </Typography.Paragraph>

                <Flex gap={8} align="center">
                    <Button icon={<FileSearchOutlined/>} onClick={chooseFile} disabled={running}>
                        {t(filePath ? "mintImport.chooseOther" : "mintImport.choose")}
                    </Button>
                    {filePath && <Typography.Text type="secondary" style={{fontSize: 12, wordBreak: "break-all"}}>{filePath}</Typography.Text>}
                </Flex>
                {error && <Alert type="error" showIcon message={error}/>}

                {data && !result && (
                    <>
                        {data.profiles.length > 1 &&
                            <Flex gap={8} align="center">
                                <Typography.Text>{t("mintImport.profile")}</Typography.Text>
                                <Select value={profileName} style={{flex: 1}} disabled={running}
                                        onChange={(v) => {
                                            setProfileName(v);
                                            mapGroups(data, v, folders);
                                        }}
                                        options={data.profiles.map(p => ({
                                            value: p.name,
                                            label: `${p.name} (${p.groups.reduce((n, g) => n + g.mods.length, 0)})`,
                                        }))}/>
                            </Flex>}

                        <Flex vertical gap={6} style={{maxHeight: 300, overflowY: "auto", paddingRight: 4}}>
                            <Typography.Text type="secondary" style={{fontSize: 12}}>{t("mintImport.mapping")}</Typography.Text>
                            {profile?.groups.filter(g => g.mods.length > 0).map(group => (
                                <Flex key={group.name} gap={8} align="center">
                                    <Typography.Text style={{width: 220, flexShrink: 0}} ellipsis={{tooltip: group.name}}>
                                        {group.name || t("mintImport.ungrouped")} <Typography.Text type="secondary">({group.mods.length})</Typography.Text>
                                    </Typography.Text>
                                    <Typography.Text type="secondary">→</Typography.Text>
                                    <Select size="small" style={{flex: 1}} disabled={running}
                                            value={targets[group.name] ?? NEW_FOLDER}
                                            onChange={(v) => setTargets(prev => ({...prev, [group.name]: v}))}
                                            options={folderOptions(group.name)}/>
                                </Flex>
                            ))}
                        </Flex>

                        <Checkbox checked={keepEnabled} disabled={running} onChange={(e) => setKeepEnabled(e.target.checked)}>
                            {t("mintImport.keepEnabled")}
                        </Checkbox>
                    </>
                )}

                {running && (
                    <Flex vertical gap={4}>
                        <Progress percent={progress.total ? Math.round(progress.done / progress.total * 100) : 0}
                                  format={() => `${progress.done} / ${progress.total}`}/>
                        <Typography.Text type="secondary" style={{fontSize: 12}} ellipsis>{progress.label}</Typography.Text>
                    </Flex>
                )}

                {result && (
                    <Flex vertical gap={10}>
                        <Alert type={result.brokenLinks.length + result.missingFiles.length + result.failed.length ? "warning" : "success"}
                               showIcon
                               message={t("mintImport.summary", {
                                   added: result.added, existing: result.alreadyInList,
                                   problems: result.brokenLinks.length + result.missingFiles.length + result.failed.length,
                               })}
                               description={result.stopped ? t("mintImport.stopped") : undefined}/>
                        <ResultList title={t("mintImport.brokenLinks", {count: result.brokenLinks.length})}
                                    items={result.brokenLinks} type="danger"/>
                        <ResultList title={t("mintImport.missingFiles", {count: result.missingFiles.length})}
                                    items={result.missingFiles} type="danger"/>
                        <ResultList title={t("mintImport.failedItems", {count: result.failed.length})}
                                    items={result.failed.map(f => `${f.item} — ${f.reason}`)} type="danger"/>
                        <ResultList title={t("mintImport.movedFiles", {count: result.movedFiles.length})}
                                    items={result.movedFiles.map(m => `${m.from} → ${m.to}`)} type="warning"/>
                    </Flex>
                )}
            </Flex>
        </Modal>
    );
}
