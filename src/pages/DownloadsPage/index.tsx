/**
 * Downloads: every file MINTCAT downloaded, what it's for, and cleaning up.
 * - Download folder (Settings → Download folder): mod.io, Nexus and ModCat files
 * - Pak Hub downloads (MINTCAT's data folder)
 * - MINTCAT cache: pictures and the copies it keeps of replaced files
 * plus when downloads are deleted by themselves (after updates, after removing mods).
 */
import React, {useCallback, useEffect, useMemo, useState} from "react";
import {t} from "i18next";
import {Button, Card, Empty, Flex, Input, message, Segmented, Select, Spin, Table, Tag, Tooltip, Typography} from "antd";
import type {ColumnsType} from "antd/es/table";
import {DeleteOutlined, FolderOpenOutlined, PlusOutlined, ReloadOutlined} from "@ant-design/icons";
import {openPath} from "@tauri-apps/plugin-opener";
import {useLogPanelOffset} from "@/components/LogPanel";
import {useWindowHeight} from "@/utils/useWindowSize";
import {Downloads, type DownloadsOverview, formatBytes, type KeepChoice} from "@/services/Downloads";
import {canDelete, type DownloadEntry, type DownloadSection, type DownloadState, isUnused} from "@/services/DownloadsCatalog";
import {confirmDelete} from "@/services/DeleteConfirm";
import {KeptCopiesRow} from "@/pages/SettingPage/BackupSettings";
import {AddModType} from "@/dialogs/AddModDialog";
import {openWindow} from "@/dialogs/AddModDialog/open";

const {Text, Title} = Typography;

type Filter = 'all' | 'unused' | DownloadState;

const STATE_TAG: Record<DownloadState, { color?: string; label: string; tip: string }> = {
    inUse: {color: "green", label: "downloads.state.inUse", tip: "downloads.state.inUseTip"},
    older: {color: "gold", label: "downloads.state.older", tip: "downloads.state.olderTip"},
    backup: {color: "blue", label: "downloads.state.backup", tip: "downloads.state.backupTip"},
    unlisted: {label: "downloads.state.unlisted", tip: "downloads.state.unlistedTip"},
    partial: {color: "red", label: "downloads.state.partial", tip: "downloads.state.partialTip"},
};

function formatDate(ms: number): string {
    return ms ? new Date(ms).toLocaleDateString() : "";
}

function matches(entry: DownloadEntry, filter: Filter, query: string): boolean {
    if (filter === 'unused' && !isUnused(entry)) return false;
    if (filter !== 'all' && filter !== 'unused' && entry.state !== filter) return false;
    if (!query) return true;
    const q = query.toLowerCase();
    return entry.name.toLowerCase().includes(q) || (entry.modName ?? "").toLowerCase().includes(q);
}

function SectionHeader({title, hint, folder, entries, selected}: {
    title: string;
    hint: string;
    folder: string;
    entries: DownloadEntry[];
    selected: Set<string>;
}) {
    const total = entries.reduce((n, e) => n + e.size, 0);
    const unused = entries.filter(isUnused).reduce((n, e) => n + e.size, 0);
    const chosen = entries.filter(e => selected.has(e.path)).length;
    return (
        <Flex justify="space-between" align="center" wrap gap={8} style={{marginBottom: 8}}>
            <Flex vertical>
                <Title level={5} style={{margin: 0}}>{title}</Title>
                <Text type="secondary" style={{fontSize: 12}}>{hint}</Text>
                <Text type="secondary" style={{fontSize: 12}}>
                    {t("downloads.sectionSummary", {count: entries.length, size: formatBytes(total), unused: formatBytes(unused)})}
                    {chosen > 0 ? ` · ${t("downloads.selectedCount", {count: chosen})}` : ""}
                </Text>
            </Flex>
            {folder &&
                <Tooltip title={folder}>
                    <Button size="small" icon={<FolderOpenOutlined/>} onClick={() => openPath(folder).catch(console.error)}>
                        {t("downloads.openFolder")}
                    </Button>
                </Tooltip>}
        </Flex>
    );
}

export function DownloadsPage() {
    const height = useWindowHeight() - 81 - useLogPanelOffset();
    const [overview, setOverview] = useState<DownloadsOverview | null>(null);
    const [loading, setLoading] = useState(false);
    const [selected, setSelected] = useState<Set<string>>(new Set());
    const [filter, setFilter] = useState<Filter>('all');
    const [query, setQuery] = useState("");
    const [deleting, setDeleting] = useState(false);
    const [keepOld, setKeepOld] = useState<KeepChoice>('keep');
    const [keepRemoved, setKeepRemoved] = useState<KeepChoice>('keep');
    const [images, setImages] = useState<{ files: number; bytes: number } | null>(null);
    const [cacheRefresh, setCacheRefresh] = useState(0);

    const load = useCallback(async () => {
        setLoading(true);
        try {
            const next = await Downloads.scan();
            setOverview(next);
            // keep only choices that are still there
            setSelected(prev => new Set([...prev].filter(p => next.entries.some(e => e.path === p && canDelete(e)))));
            setImages(await Downloads.imageCache().catch(() => null));
            setCacheRefresh(n => n + 1);
        } catch (error) {
            console.error('[Downloads] scan failed', error);
            message.error(`${t("downloads.scanFailed")}: ${error instanceof Error ? error.message : String(error)}`);
        } finally {
            setLoading(false);
        }
    }, []);

    useEffect(() => {
        void load();
        Downloads.keepOldVersions().then(setKeepOld).catch(() => undefined);
        Downloads.keepRemoved().then(setKeepRemoved).catch(() => undefined);
    }, [load]);

    const entries = overview?.entries ?? [];
    const visible = useMemo(() => entries.filter(e => matches(e, filter, query.trim())), [entries, filter, query]);
    const bySection = (section: DownloadSection) => visible.filter(e => e.section === section);
    const chosen = entries.filter(e => selected.has(e.path));
    const chosenBytes = chosen.reduce((n, e) => n + e.size, 0);

    const selectUnused = () => setSelected(new Set(visible.filter(e => isUnused(e) && canDelete(e)).map(e => e.path)));

    const deleteChosen = async () => {
        if (chosen.length === 0) return;
        const inUse = chosen.filter(e => e.state === 'inUse' || e.state === 'backup').length;
        const ok = await confirmDelete({
            title: t("downloads.deleteTitle", {count: chosen.length}),
            content: <span style={{whiteSpace: "pre-line"}}>
                {[t("downloads.deleteConfirm", {count: chosen.length, size: formatBytes(chosenBytes)}),
                    inUse > 0 ? t("downloads.deleteInUseWarning", {count: inUse}) : ""].filter(Boolean).join("\n\n")}
            </span>,
        });
        if (!ok) return;
        setDeleting(true);
        try {
            const result = await Downloads.delete(chosen);
            if (result.failed > 0) message.warning(t("downloads.deletedSome", {count: result.deleted, failed: result.failed}));
            else message.success(t("downloads.deleted", {count: result.deleted, size: formatBytes(result.bytes)}));
            setSelected(new Set());
            await load();
        } finally {
            setDeleting(false);
        }
    };

    const addBack = async (entry: DownloadEntry) => {
        if (entry.section === 'pakhub') {
            await openWindow(AddModType.LOCAL, 0, "", load, [entry.path]);
        } else if (entry.link) {
            await openWindow(AddModType.ONLINE, 0, entry.link, load);
        }
    };

    const columns: ColumnsType<DownloadEntry> = [
        {
            title: t("downloads.col.file"),
            dataIndex: "name",
            sorter: (a, b) => a.name.localeCompare(b.name),
            render: (_v, entry) => (
                <Flex vertical style={{minWidth: 0}}>
                    <Text style={{wordBreak: "break-all"}}>{entry.modName || entry.name}</Text>
                    {entry.modName &&
                        <Text type="secondary" style={{fontSize: 11, wordBreak: "break-all"}}>{entry.name}</Text>}
                </Flex>
            ),
        },
        {
            title: t("downloads.col.state"),
            dataIndex: "state",
            width: 150,
            filters: (Object.keys(STATE_TAG) as DownloadState[]).map(s => ({text: t(STATE_TAG[s].label), value: s})),
            onFilter: (value, entry) => entry.state === value,
            render: (state: DownloadState, entry) => (
                <Tooltip title={t(STATE_TAG[state].tip)}>
                    <Tag color={STATE_TAG[state].color}>{t(STATE_TAG[state].label)}</Tag>
                    {entry.version && entry.state !== 'inUse' &&
                        <Text type="secondary" style={{fontSize: 11}}>{entry.version}</Text>}
                </Tooltip>
            ),
        },
        {
            title: t("downloads.col.size"),
            dataIndex: "size",
            width: 100,
            align: "right",
            sorter: (a, b) => a.size - b.size,
            render: (size: number) => formatBytes(size),
        },
        {
            title: t("downloads.col.date"),
            dataIndex: "modifiedAt",
            width: 110,
            align: "right",
            sorter: (a, b) => a.modifiedAt - b.modifiedAt,
            defaultSortOrder: "descend",
            render: (ms: number) => formatDate(ms),
        },
        {
            title: "",
            key: "action",
            width: 120,
            render: (_v, entry) => entry.state === 'unlisted' && (entry.link || entry.section === 'pakhub')
                ? <Tooltip title={t("downloads.addBackTip")}>
                    <Button size="small" icon={<PlusOutlined/>} onClick={() => addBack(entry)}>{t("downloads.addBack")}</Button>
                </Tooltip>
                : null,
        },
    ];

    const table = (rows: DownloadEntry[]) => (
        <Table<DownloadEntry>
            size="small"
            rowKey="path"
            columns={columns}
            dataSource={rows}
            pagination={false}
            locale={{emptyText: <Empty image={Empty.PRESENTED_IMAGE_SIMPLE} description={t("downloads.none")}/>}}
            rowSelection={{
                selectedRowKeys: rows.filter(r => selected.has(r.path)).map(r => r.path),
                getCheckboxProps: (entry) => ({
                    disabled: !canDelete(entry),
                    title: canDelete(entry) ? undefined : t("downloads.cantDeleteListed"),
                }),
                onChange: (keys) => {
                    const sectionPaths = new Set(rows.map(r => r.path));
                    setSelected(prev => {
                        const next = new Set([...prev].filter(p => !sectionPaths.has(p)));
                        keys.forEach(k => next.add(String(k)));
                        return next;
                    });
                },
            }}
        />
    );

    const totalBytes = entries.reduce((n, e) => n + e.size, 0);
    const unusedBytes = entries.filter(isUnused).reduce((n, e) => n + e.size, 0);

    return (
        <div className="scrollable-div" style={{height, overflowY: "auto", padding: "12px 16px"}}>
            <Flex vertical gap={12}>
                <Flex justify="space-between" align="center" wrap gap={8}>
                    <Flex vertical>
                        <Title level={4} style={{margin: 0}}>{t("downloads.title")}</Title>
                        <Text type="secondary" style={{fontSize: 12}}>
                            {overview ? t("downloads.summary", {count: entries.length, size: formatBytes(totalBytes), unused: formatBytes(unusedBytes)}) : ""}
                        </Text>
                    </Flex>
                    <Flex gap={8} wrap align="center">
                        <Input.Search allowClear placeholder={t("downloads.search")} style={{width: 220}}
                                      value={query} onChange={(e) => setQuery(e.target.value)}/>
                        <Segmented<Filter> value={filter} onChange={setFilter} options={[
                            {value: 'all', label: t("downloads.filter.all")},
                            {value: 'unused', label: t("downloads.filter.unused")},
                            {value: 'inUse', label: t("downloads.state.inUse")},
                        ]}/>
                        <Button icon={<ReloadOutlined/>} loading={loading} onClick={load}>{t("downloads.refresh")}</Button>
                        <Button onClick={selectUnused} disabled={!overview}>{t("downloads.selectUnused")}</Button>
                        <Button danger type="primary" icon={<DeleteOutlined/>} loading={deleting}
                                disabled={chosen.length === 0} onClick={deleteChosen}>
                            {chosen.length > 0
                                ? t("downloads.deleteSelectedCount", {count: chosen.length, size: formatBytes(chosenBytes)})
                                : t("downloads.deleteSelected")}
                        </Button>
                    </Flex>
                </Flex>

                <Card size="small" title={t("downloads.keepTitle")}>
                    <Flex vertical gap={8}>
                        <Flex align="center" gap={12} wrap>
                            <Text style={{minWidth: 300}}>{t("downloads.keepOldLabel")}</Text>
                            <Select<KeepChoice> value={keepOld} style={{width: 330}}
                                                onChange={async (v) => {
                                                    setKeepOld(v);
                                                    await Downloads.setKeepOldVersions(v);
                                                }}
                                                options={[
                                                    {value: 'keep', label: t("downloads.keepOldKeep")},
                                                    {value: 'delete', label: t("downloads.keepOldDelete")},
                                                ]}/>
                        </Flex>
                        <Flex align="center" gap={12} wrap>
                            <Text style={{minWidth: 300}}>{t("downloads.keepRemovedLabel")}</Text>
                            <Select<KeepChoice> value={keepRemoved} style={{width: 330}}
                                                onChange={async (v) => {
                                                    setKeepRemoved(v);
                                                    await Downloads.setKeepRemoved(v);
                                                }}
                                                options={[
                                                    {value: 'keep', label: t("downloads.keepRemovedKeep")},
                                                    {value: 'delete', label: t("downloads.keepRemovedDelete")},
                                                ]}/>
                        </Flex>
                        <Text type="secondary" style={{fontSize: 12}}>{t("downloads.keepHint")}</Text>
                    </Flex>
                </Card>

                {!overview
                    ? <Flex justify="center" style={{padding: 40}}><Spin/></Flex>
                    : <>
                        <Card size="small">
                            <SectionHeader title={t("downloads.folderTitle")} hint={t("downloads.folderHint")}
                                           folder={overview.folder} entries={bySection('downloads')} selected={selected}/>
                            {table(bySection('downloads'))}
                        </Card>
                        <Card size="small">
                            <SectionHeader title={t("downloads.pakhubTitle")} hint={t("downloads.pakhubHint")}
                                           folder={overview.pakhubFolder} entries={bySection('pakhub')} selected={selected}/>
                            {table(bySection('pakhub'))}
                        </Card>
                    </>}

                <Card size="small" title={t("downloads.cacheTitle")}>
                    <Flex vertical gap={10}>
                        <Flex justify="space-between" align="center" wrap gap={8}>
                            <Flex vertical>
                                <Text>{t("downloads.imagesLabel")}</Text>
                                <Text type="secondary" style={{fontSize: 12}}>
                                    {images ? t("downloads.imagesSummary", {count: images.files, size: formatBytes(images.bytes)}) : ""}
                                </Text>
                            </Flex>
                            <Button size="small" danger disabled={!images || images.files === 0}
                                    onClick={async () => {
                                        if (!(await confirmDelete({title: t("downloads.imagesClearTitle"), content: t("downloads.imagesClearConfirm")}))) return;
                                        await Downloads.clearImageCache();
                                        setImages(await Downloads.imageCache().catch(() => null));
                                    }}>
                                {t("downloads.clear")}
                            </Button>
                        </Flex>
                        <KeptCopiesRow kind="settings" refreshKey={cacheRefresh}/>
                        <KeptCopiesRow kind="config" refreshKey={cacheRefresh}/>
                        <KeptCopiesRow kind="database" refreshKey={cacheRefresh}/>
                    </Flex>
                </Card>
            </Flex>
        </div>
    );
}
