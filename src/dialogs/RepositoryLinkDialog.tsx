import React, {useEffect, useState} from "react";
import {t} from "i18next";
import {Button, Empty, Flex, Input, List, message, Modal, Radio, Select, Spin, Tag, Typography} from "antd";
import {stat} from "@tauri-apps/plugin-fs";
import {
    ModRepository,
    RepositoryApi,
    RepositoryFile,
    RepositoryModDetail,
    RepositoryModSummary,
    RepositoryStore,
    safeModFileName,
} from "@/apis/repositories";
import {StorageAPI} from "@/storage";
import type {CompleteModData} from "@/storage/dao/ModDAO";
import {RepositoryUpdates} from "@/services/RepositoryUpdates";
import {logActivity} from "@/services/ActivityLog";

interface Props {
    mod: CompleteModData | null;
    onClose: () => void;
}

function formatSize(bytes: number): string {
    if (!bytes) return "";
    if (bytes < 1024 * 1024) return `${(bytes / 1024).toFixed(1)} KB`;
    return `${(bytes / 1024 / 1024).toFixed(1)} MB`;
}

function formatDate(iso: string): string {
    const time = Date.parse(iso);
    return Number.isFinite(time) ? new Date(time).toLocaleString() : "";
}

function searchTextFor(mod: CompleteModData): string {
    const name = mod.displayName || mod.originalName || "";
    return name.replace(/\.(pak|zip)$/i, "").replace(/_P$/i, "").replace(/[_-]+/g, " ").trim();
}

/** Distinct file names in a post with their uploads (newest first) */
function fileGroups(files: RepositoryFile[]): Array<{ filename: string; uploads: RepositoryFile[] }> {
    const groups = new Map<string, RepositoryFile[]>();
    for (const file of files) {
        if (!safeModFileName(file.filename)) continue;
        const key = file.filename.toLowerCase();
        if (!groups.has(key)) groups.set(key, []);
        groups.get(key)!.push(file);
    }
    return Array.from(groups.values()).map(uploads => ({filename: uploads[0].filename, uploads}));
}

export function RepositoryLinkDialog({mod, onClose}: Props) {
    const [repos, setRepos] = useState<ModRepository[]>([]);
    const [repoId, setRepoId] = useState<string>();
    const [query, setQuery] = useState("");
    const [results, setResults] = useState<RepositoryModSummary[] | null>(null);
    const [searching, setSearching] = useState(false);
    const [selected, setSelected] = useState<RepositoryModSummary | null>(null);
    const [detail, setDetail] = useState<RepositoryModDetail | null>(null);
    const [loadingDetail, setLoadingDetail] = useState(false);
    const [chosenFile, setChosenFile] = useState<string>();
    const [localSize, setLocalSize] = useState<number>();
    const [saving, setSaving] = useState(false);

    const open = !!mod;
    const repo = repos.find(r => r.id === repoId);

    useEffect(() => {
        if (!mod) return;
        setResults(null);
        setSelected(null);
        setDetail(null);
        setQuery(searchTextFor(mod));
        (async () => {
            const games = await StorageAPI.getGames();
            const game = (await games.getActiveGame())?.name?.toLowerCase();
            const list = (await RepositoryStore.list()).filter(r => !game || r.game === game);
            setRepos(list);
            const existing = RepositoryUpdates.linkForModSync(mod);
            setRepoId(existing?.repoId && list.some(r => r.id === existing.repoId) ? existing.repoId : list[0]?.id);
            try {
                setLocalSize((await stat(mod.download?.cachePath || mod.url || "")).size);
            } catch {
                setLocalSize(undefined);
            }
        })();
    }, [mod?.modId]);

    const runSearch = async () => {
        if (!repo) return;
        setSearching(true);
        setSelected(null);
        setDetail(null);
        try {
            setResults((await RepositoryApi.listMods(repo, {query, page: 1})).mods);
        } catch (e) {
            message.error(t("repo.loadFailed", {name: repo.name, reason: String(e)}));
            setResults([]);
        } finally {
            setSearching(false);
        }
    };

    // Search as soon as the dialog has its repository
    useEffect(() => {
        if (open && repo && results === null) runSearch();
    }, [open, repoId]);

    const pickPost = async (post: RepositoryModSummary) => {
        if (!repo) return;
        setSelected(post);
        setDetail(null);
        setLoadingDetail(true);
        try {
            const d = await RepositoryApi.getMod(repo, post.slug);
            setDetail(d);
            const groups = fileGroups(d.files);
            // Prefer the file whose upload matches this mod's size, then its file name
            const ownName = (mod?.download?.cachePath || mod?.url || "").split(/[\\/]/).pop()?.toLowerCase();
            const bySize = groups.find(g => g.uploads.some(u => u.sizeBytes === localSize));
            const byName = groups.find(g => g.filename.toLowerCase() === ownName);
            setChosenFile((bySize ?? byName ?? groups[0])?.filename);
        } catch (e) {
            message.error(t("repo.loadPostFailed", {name: post.name, reason: String(e)}));
        } finally {
            setLoadingDetail(false);
        }
    };

    const onLink = async () => {
        if (!mod?.modId || !repo || !selected || !detail || !chosenFile) return;
        setSaving(true);
        try {
            const uploads = fileGroups(detail.files).find(g => g.filename === chosenFile)?.uploads ?? [];
            const mine = uploads.find(u => u.sizeBytes === localSize);
            const link = {
                repoId: repo.id,
                slug: selected.slug,
                filename: chosenFile,
                postedAt: mine?.postedAt,
                sizeBytes: mine?.sizeBytes,
                via: 'manual' as const,
            };
            await RepositoryUpdates.setLink(mod.modId, link);
            const state = await RepositoryUpdates.check(mod, link);
            await logActivity('info', t("repoLink.linkedLog", {name: mod.displayName, post: selected.name}),
                RepositoryApi.modPageUrl(repo, selected.slug), 'repository');
            message.success(state.kind === 'upToDate' ? t("repoLink.linkedUpToDate") : t("repoLink.linkedUpdate"));
            onClose();
        } catch (e) {
            message.error(String(e));
        } finally {
            setSaving(false);
        }
    };

    return (
        <Modal open={open}
               title={t("repoLink.title", {name: mod?.displayName ?? ""})}
               onCancel={onClose}
               width={640}
               destroyOnHidden
               okText={t("repoLink.link")}
               okButtonProps={{disabled: !chosenFile || !detail, loading: saving}}
               onOk={onLink}>
            {repos.length === 0 ? (
                <Empty image={Empty.PRESENTED_IMAGE_SIMPLE} description={t("repoLink.noRepositories")}/>
            ) : (
                <Flex vertical gap={10}>
                    <Flex gap={8}>
                        {repos.length > 1 &&
                            <Select value={repoId} onChange={(v) => {
                                setRepoId(v);
                                setResults(null);
                            }} style={{width: 160}}
                                    options={repos.map(r => ({value: r.id, label: r.name}))}/>}
                        <Input.Search value={query}
                                      onChange={(e) => setQuery(e.target.value)}
                                      onSearch={runSearch}
                                      loading={searching}
                                      placeholder={t("repo.searchPlaceholder", {name: repo?.name ?? ""})}/>
                    </Flex>

                    <div style={{maxHeight: 220, overflowY: "auto"}}>
                        {results === null || searching ? <Spin/> :
                            results.length === 0 ? <Empty image={Empty.PRESENTED_IMAGE_SIMPLE} description={t("No results found")}/> :
                                <List size="small"
                                      dataSource={results}
                                      renderItem={(post) => (
                                          <List.Item onClick={() => pickPost(post)}
                                                     style={{
                                                         cursor: "pointer",
                                                         background: selected?.slug === post.slug ? "rgba(22,119,255,0.08)" : undefined,
                                                     }}>
                                              <Flex vertical style={{minWidth: 0}}>
                                                  <Typography.Text strong ellipsis>{post.name}</Typography.Text>
                                                  <Typography.Text type="secondary" style={{fontSize: 12}}>
                                                      {post.postedBy} · {formatDate(post.postedAt)} · {t("repo.fileCount", {count: post.fileCount + post.threadFileCount})}
                                                  </Typography.Text>
                                              </Flex>
                                          </List.Item>
                                      )}/>}
                    </div>

                    {loadingDetail && <Spin/>}
                    {detail && (
                        <Flex vertical gap={6}>
                            <Typography.Text>{t("repoLink.whichFile")}</Typography.Text>
                            <Radio.Group value={chosenFile} onChange={(e) => setChosenFile(e.target.value)}>
                                <Flex vertical gap={6}>
                                    {fileGroups(detail.files).map(group => {
                                        const mine = group.uploads.find(u => u.sizeBytes === localSize);
                                        const latest = group.uploads[0];
                                        return (
                                            <Radio key={group.filename} value={group.filename}>
                                                <span style={{wordBreak: "break-all"}}>{group.filename}</span>
                                                <Typography.Text type="secondary" style={{fontSize: 12, marginLeft: 6}}>
                                                    {t("repoLink.newestUpload", {date: formatDate(latest.postedAt), size: formatSize(latest.sizeBytes)})}
                                                </Typography.Text>
                                                {mine
                                                    ? <Tag color={mine === latest ? "green" : "orange"} style={{marginLeft: 6}}>
                                                        {mine === latest ? t("repoLink.matchesLatest") : t("repoLink.matchesOlder", {date: formatDate(mine.postedAt)})}
                                                    </Tag>
                                                    : null}
                                            </Radio>
                                        );
                                    })}
                                </Flex>
                            </Radio.Group>
                            {chosenFile && !fileGroups(detail.files).find(g => g.filename === chosenFile)?.uploads.some(u => u.sizeBytes === localSize) &&
                                <Typography.Text type="secondary" style={{fontSize: 12}}>{t("repoLink.noSizeMatch")}</Typography.Text>}
                        </Flex>
                    )}
                </Flex>
            )}
        </Modal>
    );
}
