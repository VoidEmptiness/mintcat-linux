/**
 * Add a mod from a user-added repository: pick its file(s) and a folder in the mod list,
 * download the files into MintCat's own data folder and add them to the list.
 */
import React, {useState} from "react";
import {t} from "i18next";
import {Button, Checkbox, Flex, message, Select, Tag, Typography} from "antd";
import {FolderAddOutlined} from "@ant-design/icons";
import {askNewFolder} from "@/dialogs/NewFolderPrompt";
import {appDataDir, join} from "@tauri-apps/api/path";
import {mkdir} from "@tauri-apps/plugin-fs";
import {RepositoryApi, RepositoryFile, RepositoryStore, safeModFileName} from "@/apis/repositories";
import type {RepositoryResultData, SearchResultItem} from "@/apis/search";
import {DownloadApi} from "@/apis/DownloadApi";
import {MessageBox} from "@/components/MessageBox";
import StatusBar from "@/components/StatusBar";
import {logActivity} from "@/services/ActivityLog";
import {RepositoryUpdates} from "@/services/RepositoryUpdates";
import {HomeService} from "@/services/HomeService";
import {DialogProfileService} from "@/services/DialogProfileService";
import {emitVoidEvent} from "@/events";

/** Shared with the Add Mod window, so both remember the same folder */
const LAST_SELECTED_GROUP_KEY = 'add-mod-dialog-last-group-id';

interface FolderOption {
    id: number;
    name: string;
    parentId?: number;
}

/** A folder made in the add dialog: created (after its siblings) only when the mod is added */
interface NewFolder {
    name: string;
    parentId: number;
}

const NEW_FOLDER_ID = -1;

function initialFolder(folders: FolderOption[]): number {
    let cached = 0;
    try {
        cached = parseInt(localStorage.getItem(LAST_SELECTED_GROUP_KEY) || '0');
    } catch {
        // no stored choice
    }
    if (cached && folders.some(f => f.id === cached)) return cached;
    return folders[0]?.id ?? 0;
}

function formatSize(bytes: number): string {
    if (!bytes) return "";
    if (bytes < 1024) return `${bytes} B`;
    if (bytes < 1024 * 1024) return `${(bytes / 1024).toFixed(1)} KB`;
    return `${(bytes / 1024 / 1024).toFixed(1)} MB`;
}

function formatDate(iso: string): string {
    const time = Date.parse(iso);
    return Number.isFinite(time) ? new Date(time).toLocaleString() : "";
}

function AddForm({files, initial, folders, initialFolderId, onChange, clicked = false}: {
    files: RepositoryFile[];
    initial: number[];
    /** A file was clicked on the Browse Mods card (only it is ticked) */
    clicked?: boolean;
    folders: FolderOption[];
    initialFolderId: number;
    onChange: (indexes: number[], folderId: number, newFolder: NewFolder | null) => void;
}) {
    const [selected, setSelected] = useState<number[]>(initial);
    const [folderId, setFolderId] = useState<number>(initialFolderId);
    const [newFolder, setNewFolder] = useState<NewFolder | null>(null);
    const update = (next: number[], nextFolder = folderId, nextNew = newFolder) => {
        setSelected(next);
        setFolderId(nextFolder);
        setNewFolder(nextNew);
        onChange(next, nextFolder, nextNew);
    };
    const options = [
        ...folders.map(f => ({value: f.id, label: f.name})),
        ...(newFolder ? [{value: NEW_FOLDER_ID, label: `${newFolder.name} ${t("newFolder.newMark")}`}] : []),
    ];
    const makeFolder = async () => {
        const choice = await askNewFolder({
            folders: folders.map(f => ({value: f.id, label: f.name})),
            zIndex: 1300, // above this dialog
            taken: (name, parentId) => folders.some(f => (f.parentId ?? 0) === parentId
                && f.name.split(" / ").pop()!.trim().toLowerCase() === name.trim().toLowerCase()),
        });
        if (choice) update(selected, NEW_FOLDER_ID, choice);
    };
    return (
        <Flex vertical gap={10} style={{marginTop: 8}}>
            <Flex vertical gap={4}>
                <Typography.Text type="secondary" style={{fontSize: 12}}>{t("repo.addToFolder")}</Typography.Text>
                <Flex gap={8}>
                    {options.length > 0 &&
                        <Select value={folderId}
                                style={{flex: 1, minWidth: 0}}
                                showSearch
                                optionFilterProp="label"
                                onChange={(v) => update(selected, v)}
                                options={options}/>}
                    <Button icon={<FolderAddOutlined/>} onClick={makeFolder}>{t("newFolder.button")}</Button>
                </Flex>
            </Flex>
            {files.length > 1
                ? <Flex vertical gap={6} style={{maxHeight: 320, overflowY: "auto"}}>
                    <Typography.Text type="secondary" style={{fontSize: 12}}>{t(clicked ? "repo.chooseFilesHintClicked" : "repo.chooseFilesHint")}</Typography.Text>
                    {files.map((file, index) => (
                        <Checkbox key={index}
                                  checked={selected.includes(index)}
                                  onChange={(e) => update(e.target.checked
                                      ? [...selected, index]
                                      : selected.filter(i => i !== index))}>
                            <span style={{wordBreak: "break-all"}}>{file.filename}</span>
                            {file.latest
                                ? <Tag color="green" style={{marginInlineStart: 6}}>{t("repo.latest")}</Tag>
                                : <Tag style={{marginInlineStart: 6}}>{t("repo.olderUpload")}</Tag>}
                            <Typography.Text type="secondary" style={{fontSize: 12}}>
                                {[formatSize(file.sizeBytes), formatDate(file.postedAt), file.fromThread ? t("repo.inThread") : ""]
                                    .filter(Boolean).join(" · ")}
                            </Typography.Text>
                        </Checkbox>
                    ))}
                </Flex>
                : <Typography.Text>
                    <span style={{wordBreak: "break-all"}}>{files[0]?.filename}</span>
                    <Typography.Text type="secondary" style={{fontSize: 12, marginInlineStart: 6}}>
                        {[formatSize(files[0]?.sizeBytes ?? 0), formatDate(files[0]?.postedAt ?? "")].filter(Boolean).join(" · ")}
                    </Typography.Text>
                </Typography.Text>}
            <Typography.Text type="secondary" style={{fontSize: 12}}>{t("repo.storedHint")}</Typography.Text>
        </Flex>
    );
}

/** Ask which file(s) to add and into which folder of the mod list */
async function chooseFilesAndFolder(modName: string, files: RepositoryFile[], folders: FolderOption[], onlyFileUrl?: string)
    : Promise<{ files: RepositoryFile[]; folderId: number; newFolder: NewFolder | null } | null> {
    // a file clicked on the Browse Mods card: just that one ticked
    const clicked = onlyFileUrl ? files.findIndex(f => f.downloadUrl === onlyFileUrl) : -1;
    const initial = clicked >= 0 ? [clicked]
        : files.length === 1 ? [0] : files.map((f, i) => (f.latest ? i : -1)).filter(i => i >= 0);
    let selection = initial;
    let folderId = initialFolder(folders);
    let newFolder: NewFolder | null = null;
    const ok = await MessageBox.confirm({
        title: t("repo.addTitleFor", {name: modName}),
        icon: null,
        width: 560,
        okText: t("repo.addToList"),
        content: <AddForm files={files} initial={initial} folders={folders} initialFolderId={folderId} clicked={clicked >= 0}
                          onChange={(s, f, n) => {
                              selection = s;
                              folderId = f;
                              newFolder = n;
                          }}/>,
    });
    if (!ok) return null;
    try {
        if (folderId > 0) localStorage.setItem(LAST_SELECTED_GROUP_KEY, String(folderId));
    } catch {
        // not remembered
    }
    return {
        files: [...selection].sort((a, b) => a - b).map(i => files[i]),
        folderId,
        newFolder: folderId === NEW_FOLDER_ID ? newFolder : null,
    };
}

/** `onlyFileUrl`: a file clicked on the Browse Mods card (only that one is ticked at first) */
export async function addRepositoryMod(item: SearchResultItem, onlyFileUrl?: string): Promise<boolean> {
    const raw = item.rawData as RepositoryResultData | undefined;
    const repo = raw ? await RepositoryStore.get(raw.repositoryId) : undefined;
    if (!raw || !repo) {
        message.error(t("repo.notFound"));
        return false;
    }

    let detail;
    try {
        detail = await RepositoryApi.getMod(repo, raw.slug);
    } catch (error) {
        await logActivity('error', t("repo.loadPostFailed", {name: item.name, reason: String(error)}), item.profileUrl, 'repository');
        message.error(t("repo.loadPostFailed", {name: item.name, reason: String(error)}));
        return false;
    }

    const files = detail.files.filter(f => safeModFileName(f.filename));
    if (files.length === 0) {
        await logActivity('error', t("repo.noModFiles", {name: item.name}), item.profileUrl, 'repository');
        message.error(t("repo.noModFiles", {name: item.name}));
        return false;
    }

    let folders: FolderOption[] = [];
    try {
        // in mod-list order, subfolders labelled with their path
        folders = (await new DialogProfileService().getActiveProfileFolderChoices())
            .map(f => ({id: f.id, name: f.label, parentId: f.parentFolderId ?? 0}));
    } catch (error) {
        console.warn('[RepositoryModInstaller] could not read folders', error);
    }

    const title = files.filter(f => f.latest).map(f => f.filename).join(", ") || item.name;
    const choice = await chooseFilesAndFolder(title, files, folders, onlyFileUrl);
    if (!choice || choice.files.length === 0) {
        return false;
    }
    const chosen = choice.files;
    let folderName = folders.find(f => f.id === choice.folderId)?.name ?? "";
    if (choice.newFolder) {
        // the folder made in the dialog is created now that the mod is being added
        try {
            choice.folderId = await new DialogProfileService().createFolderAfterSiblings(choice.newFolder.name, choice.newFolder.parentId);
            folderName = choice.newFolder.name;
            localStorage.setItem(LAST_SELECTED_GROUP_KEY, String(choice.folderId));
            await logActivity('success', t("newFolder.created", {name: folderName}), undefined, 'repository');
        } catch (error) {
            const reason = error instanceof Error ? error.message : String(error);
            await logActivity('error', t("newFolder.failed", {reason}), choice.newFolder.name, 'repository');
            message.error(t("newFolder.failed", {reason}));
            return false;
        }
    }

    // ~/.local/share/com.mint.cat/repository-mods/<repo>/<post>/<file>
    const baseDir = await join(await appDataDir(), "repository-mods", repo.id, raw.slug);
    const usedNames = new Map<string, number>();
    const downloaded: string[] = [];

    for (const file of chosen) {
        const name = safeModFileName(file.filename)!;
        const count = usedNames.get(name.toLowerCase()) ?? 0;
        usedNames.set(name.toLowerCase(), count + 1);
        // Two uploads with the same name (e.g. an older version too) go in separate folders
        const dir = count === 0 ? baseDir : await join(baseDir, `older-${count}`);
        try {
            await mkdir(dir, {recursive: true});
            const target = await join(dir, name);
            await StatusBar.info(t("repo.downloading", {name}));
            await DownloadApi.downloadFile(file.downloadUrl, target, {resume: false, retryCount: 2});
            downloaded.push(target);
            // So the Update button can find newer uploads of this file later
            await RepositoryUpdates.rememberDownloadedFile(target, {
                repoId: repo.id,
                slug: raw.slug,
                filename: file.filename,
                postedAt: file.postedAt,
                sizeBytes: file.sizeBytes,
                via: 'added',
            });
            await logActivity('success', t("repo.downloaded", {name, repo: repo.name}), file.downloadUrl, 'repository');
        } catch (error) {
            await logActivity('error', t("repo.downloadFailed", {name, reason: String(error)}), file.downloadUrl, 'repository');
            message.error(t("repo.downloadFailed", {name, reason: String(error)}));
        }
    }

    if (downloaded.length === 0) return false;

    // Straight into the mod list (no extra Add Mod window to confirm)
    const homeService = new HomeService();
    let added = 0;
    let already = 0;
    for (const target of downloaded) {
        const name = target.split(/[\\/]/).pop() || target;
        try {
            const result = await homeService.addModFromPath(target, choice.folderId);
            if (result.status === "added") {
                added++;
                await logActivity('success', t("repo.addedToFolder", {name, folder: folderName}), target, 'repository');
            } else if (result.status === "exists") {
                already++;
                await logActivity('info', t("addMod.log.alreadyInList", {name}), target, 'repository');
            } else {
                await logActivity('error', t("addMod.log.fileNotFound"), target, 'repository');
            }
        } catch (error) {
            await logActivity('error', t("addMod.log.failed", {reason: String(error)}), target, 'repository');
        }
    }
    if (added > 0) {
        message.success(t("repo.addedToListToast", {count: added, folder: folderName}));
        await StatusBar.success(t("repo.addedToListToast", {count: added, folder: folderName}));
    } else if (already > 0) {
        message.info(t("Mod Already Exists"));
    }
    await emitVoidEvent('mods-added');
    return true;
}
