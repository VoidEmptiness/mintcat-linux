/**
 * The "Files:" line of a Browse Mods card, shown only when a mod has more than one file to choose
 * from: a Nexus mod with several files on its Files tab (e.g. a version without mini-icons next to
 * the main one), a Pak Hub post with several uploads. Clicking a file adds that one.
 */
import React, {useState, useSyncExternalStore} from "react";
import {Flex, Radio, Tag, Tooltip, Typography} from "antd";
import {CheckCircleFilled} from "@ant-design/icons";
import {t} from "i18next";
import {SearchSource, type SearchResultItem} from "@/apis/search";
import type {NexusModsModNode} from "@/apis/nexusmods/types";
import {currentFiles, isChosenFile, type NexusFileChoiceRecord, type NexusFileInfo} from "@/apis/nexusmods/files";
import {NexusModsApi} from "@/apis/nexusmods";
import {NexusFileChoice} from "@/services/NexusFileChoice";
import type {ListedState} from "@/services/ListedMods";
import {safeModFileName, type RepositoryFile, type RepositoryModDetail} from "@/apis/repositories";
import {MessageBox} from "@/components/MessageBox";

/** A file picked on the card */
export interface FilePick {
    nexusFileId?: number;
    repoFileUrl?: string;
}

/** Files shown before "+N more" */
const SHOWN = 4;

const stop = (e: React.SyntheticEvent) => e.stopPropagation();

function formatSize(bytes: number): string {
    if (!bytes) return "";
    if (bytes < 1024) return `${bytes} B`;
    if (bytes < 1024 * 1024) return `${(bytes / 1024).toFixed(1)} KB`;
    return `${(bytes / 1024 / 1024).toFixed(1)} MB`;
}

function formatTime(ms: number): string {
    return Number.isFinite(ms) && ms > 0 ? new Date(ms).toLocaleDateString() : "";
}

const CATEGORY_LABEL: Record<string, string> = {
    MAIN: "files.main",
    UPDATE: "files.update",
    OPTIONAL: "files.optional",
    MISCELLANEOUS: "files.misc",
};

/** "v1.2", but "S06.05.02" as it is */
function versionText(version: string): string {
    return /^\d/.test(version) ? `v${version}` : version;
}

function categoryText(file: NexusFileInfo): string {
    return file.primary ? t("files.mainDownload") : t(CATEGORY_LABEL[file.category] ?? "files.main");
}

/** The Nexus files to show (none when there is only one) */
export function nexusFilesOf(item: SearchResultItem): NexusFileInfo[] {
    if (item.source !== SearchSource.NEXUSMODS) return [];
    const files = currentFiles((item.rawData as NexusModsModNode | undefined)?.files);
    return files.length > 1 ? files : [];
}

/** The Pak Hub uploads to show (none when there is only one) */
export function repoFilesOf(detail: RepositoryModDetail | undefined): RepositoryFile[] {
    const files = (detail?.files ?? []).filter(f => safeModFileName(f.filename));
    return files.length > 1 ? files : [];
}

/** The Nexus mod a card is for */
function nexusIdOf(item: SearchResultItem): { domain: string; modId: number } | null {
    const parsed = NexusModsApi.parseModLinks(item.profileUrl);
    return parsed ? {domain: parsed.domain, modId: parsed.modId} : null;
}

/**
 * What was picked before for this Nexus mod (undefined: its main download). Components pass
 * NexusFileChoice.version() as `_version`, so the compiler reads it again after a pick.
 */
export function nexusChoiceOf(item: SearchResultItem, _version?: number): NexusFileChoiceRecord | undefined {
    const id = nexusIdOf(item);
    return id ? NexusFileChoice.peek(id.domain, id.modId) : undefined;
}

function NexusFileTip({file, state}: { file: NexusFileInfo; state: "inUse" | "switch" | "add" }) {
    const facts = [file.version ? versionText(file.version) : "", categoryText(file), formatSize(file.sizeBytes), formatTime(file.date * 1000)]
        .filter(Boolean).join(" · ");
    return (
        <div className="search-result-file-tip">
            <div><b>{file.name}</b></div>
            <div>{facts}</div>
            {file.description && <div className="search-result-file-tip-text">{file.description}</div>}
            <div className="search-result-file-tip-hint">{t(state === "inUse" ? "files.inUseTip" : state === "switch" ? "files.switchTip" : "files.addTip")}</div>
        </div>
    );
}

function RepoFileTip({file}: { file: RepositoryFile }) {
    const posted = Date.parse(file.postedAt);
    const facts = [file.latest ? t("repo.latest") : t("repo.olderUpload"), formatSize(file.sizeBytes),
        Number.isFinite(posted) ? new Date(posted).toLocaleString() : "", file.fromThread ? t("repo.inThread") : ""].filter(Boolean).join(" · ");
    return (
        <div className="search-result-file-tip">
            <div><b>{file.filename}</b></div>
            <div>{facts}</div>
            {file.postText?.trim() && <div className="search-result-file-tip-text">{file.postText.trim()}</div>}
            <div className="search-result-file-tip-hint">{t("files.repoTip")}</div>
        </div>
    );
}

export function CardFiles({item, listed, repoDetail, onPick}: {
    item: SearchResultItem;
    listed?: ListedState;
    repoDetail?: RepositoryModDetail;
    onPick: (pick: FilePick) => void;
}) {
    const [expanded, setExpanded] = useState(false);
    // which file is in use changes when one is picked
    const choiceVersion = useSyncExternalStore(NexusFileChoice.subscribe, NexusFileChoice.version);
    const nexusFiles = nexusFilesOf(item);
    const repoFiles = nexusFiles.length > 0 ? [] : repoFilesOf(repoDetail);
    const count = nexusFiles.length || repoFiles.length;
    if (count === 0) return null;

    const inList = !!listed?.inActiveProfile;
    const choice = nexusChoiceOf(item, choiceVersion);
    const visible = expanded ? count : Math.min(count, SHOWN);

    return (
        <div className="search-result-card-extra" onClick={stop} onContextMenu={stop}>
            <Tooltip title={t("files.labelTip")}>
                <Typography.Text type="secondary">{t("files.label")}</Typography.Text>
            </Tooltip>
            {nexusFiles.slice(0, visible).map(file => {
                const inUse = inList && isChosenFile(file, choice);
                return (
                    <Tooltip key={file.fileId} title={<NexusFileTip file={file} state={inUse ? "inUse" : inList ? "switch" : "add"}/>}>
                        <Tag color={inUse ? "success" : undefined}
                             icon={inUse ? <CheckCircleFilled/> : undefined}
                             className="search-result-req search-result-req-link search-result-file"
                             onClick={() => onPick({nexusFileId: file.fileId})}>
                            {file.name}
                            {file.version && <span className="search-result-file-meta"> {versionText(file.version)}</span>}
                            {!file.primary && file.category !== "MAIN" &&
                                <span className="search-result-file-meta"> · {categoryText(file)}</span>}
                        </Tag>
                    </Tooltip>
                );
            })}
            {repoFiles.slice(0, visible).map(file => (
                <Tooltip key={file.downloadUrl} title={<RepoFileTip file={file}/>}>
                    <Tag className="search-result-req search-result-req-link search-result-file"
                         onClick={() => onPick({repoFileUrl: file.downloadUrl})}>
                        {file.filename}
                        {!file.latest && <span className="search-result-file-meta"> · {t("files.olderOn", {date: formatTime(Date.parse(file.postedAt))})}</span>}
                    </Tag>
                </Tooltip>
            ))}
            {count > SHOWN && (
                <Typography.Link className="search-result-notes-link" onClick={() => setExpanded(!expanded)}>
                    {expanded ? t("files.less") : t("files.more", {count: count - SHOWN})}
                </Typography.Link>
            )}
        </div>
    );
}

function NexusFileChoices({files, initial, onChange}: {
    files: NexusFileInfo[];
    initial: number;
    onChange: (fileId: number) => void;
}) {
    const [value, setValue] = useState(initial);
    return (
        <Flex vertical gap={6} style={{marginTop: 8}}>
            <Typography.Text type="secondary" style={{fontSize: 12}}>{t("files.chooseHint")}</Typography.Text>
            <Radio.Group value={value}
                         onChange={(e) => {
                             setValue(e.target.value);
                             onChange(e.target.value);
                         }}
                         style={{display: "flex", flexDirection: "column", gap: 8, maxHeight: 360, overflowY: "auto"}}>
                {files.map(file => (
                    <Radio key={file.fileId} value={file.fileId}>
                        <span style={{wordBreak: "break-word"}}>{file.name}</span>
                        <Tag color={file.primary ? "green" : undefined} style={{marginInlineStart: 6}}>{categoryText(file)}</Tag>
                        <Typography.Text type="secondary" style={{fontSize: 12}}>
                            {[file.version ? versionText(file.version) : "", formatSize(file.sizeBytes), formatTime(file.date * 1000)].filter(Boolean).join(" · ")}
                        </Typography.Text>
                        {file.description && (
                            <div className="search-result-file-choice-text">{file.description}</div>
                        )}
                    </Radio>
                ))}
            </Radio.Group>
        </Flex>
    );
}

/** Ask which file of a Nexus mod to add; null when cancelled */
export async function askNexusFile(modName: string, files: NexusFileInfo[], initial: number): Promise<number | null> {
    let picked = initial;
    const ok = await MessageBox.confirm({
        title: t("files.chooseTitle", {name: modName}),
        icon: null,
        width: 560,
        okText: t("files.chooseOk"),
        content: <NexusFileChoices files={files} initial={initial} onChange={(id) => (picked = id)}/>,
    });
    return ok ? picked : null;
}
