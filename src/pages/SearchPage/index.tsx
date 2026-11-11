import {useLogPanelOffset} from "@/components/LogPanel";
import React, {useEffect, useCallback, useState, useMemo, useRef} from 'react';
import {
    Button,
    Flex,
    Skeleton,
    Select,
    Empty,
    Spin,
    message,
} from 'antd';
import {DeleteOutlined, HomeOutlined, ReloadOutlined} from '@ant-design/icons';
import InfiniteScroll from 'react-infinite-scroll-component';
import Search from 'antd/es/input/Search';
import {t} from 'i18next';
import {getCurrentWindow} from '@tauri-apps/api/window';
import {SearchResultCard} from './SearchResultCard';
import {askNexusFiles, nexusChoiceOf, nexusFilesInUse, nexusFilesOf, nexusOwnFileName, type FilePick} from './CardFiles';
import {MessageBox} from '@/components/MessageBox';
import {isChosenFile} from '@/apis/nexusmods/files';
import {useSearchViewModel} from './useSearchViewModel';
import type {SearchSortBy, SearchSortOrder} from './SearchViewModel';
import {
    SearchSource,
    SearchProviderRegistry,
    initializeSearchProviders,
    isRepositorySource,
    syncRepositoryProviders,
    repositorySourceLabel,
    repositorySourceKey,
    type SearchResultItem,
    type SearchSourceKey,
} from '@/apis/search';
import {RepositoryManagerDialog} from '@/dialogs/RepositoryManagerDialog';
import {addRepositoryMod} from '@/services/RepositoryModInstaller';
import {hideBuiltInSource, removeRepository} from '@/services/RepositoryRemoval';
import {RepositoryStore} from '@/apis/repositories';
import {getSearchViewModel} from './SearchViewModel';
import type {ModRepository} from '@/apis/repositories';
import {AddModType} from '@/dialogs/AddModDialog';
import {openWindow} from '@/dialogs/AddModDialog/open';
import {NexusModsApi} from '@/apis/nexusmods';
import {captureNexusDownloadUrl, isNexusDownloadWindowClosed} from '@/apis/nexusmods/downloadWebview';
import type {NexusModsModNode} from '@/apis/nexusmods/types';
import {buildListedIndex, ListedIndex, type ListedKey} from '@/services/ListedMods';
import {listenEvent} from '@/events';
import type {RepositoryResultData} from '@/apis/search';
import {loadRepositoryDetail, repositoryTitleFromFiles} from '@/apis/repositories/details';
import type {RepositoryModDetail} from '@/apis/repositories';
import {planFor, worthAsking, type RequirementPlan, type ResolvedRequirement} from '@/services/BrowseRequirements';
import {askRequirements} from '@/dialogs/RequirementsPrompt';
import './styles.css';

interface SortOption {
    value: string;
    sortBy: SearchSortBy;
    sortOrder: SearchSortOrder;
    labelKey: string;
}

const sortOption = (sortBy: SearchSortBy, sortOrder: SearchSortOrder, labelKey: string): SortOption =>
    ({value: `${sortBy}_${sortOrder}`, sortBy, sortOrder, labelKey});

/**
 * How each source can sort (what its site's API offers). The first one is the default.
 * Pak Hub-style repositories only know post dates, names and file counts (no downloads or likes).
 */
const SORT_OPTIONS: Partial<Record<string, SortOption[]>> = {
    [SearchSource.MODIO]: [
        sortOption('date', 'desc', 'sort.recentlyUpdated'),
        sortOption('created', 'desc', 'sort.newest'),
        sortOption('downloads', 'desc', 'sort.mostDownloaded'),
        sortOption('subscribers', 'desc', 'sort.mostSubscribed'),
        sortOption('rating', 'desc', 'sort.topRated'),
        sortOption('name', 'asc', 'sort.nameAZ'),
        sortOption('name', 'desc', 'sort.nameZA'),
    ],
    [SearchSource.NEXUSMODS]: [
        sortOption('date', 'desc', 'sort.recentlyUpdated'),
        sortOption('created', 'desc', 'sort.newest'),
        sortOption('downloads', 'desc', 'sort.mostDownloaded'),
        sortOption('rating', 'desc', 'sort.mostEndorsed'),
        sortOption('name', 'asc', 'sort.nameAZ'),
        sortOption('name', 'desc', 'sort.nameZA'),
    ],
    repository: [
        sortOption('date', 'desc', 'sort.newestPosts'),
        sortOption('date', 'asc', 'sort.oldestPosts'),
        sortOption('name', 'asc', 'sort.nameAZ'),
        sortOption('name', 'desc', 'sort.nameZA'),
        sortOption('files', 'desc', 'sort.mostFiles'),
        sortOption('files', 'asc', 'sort.fewestFiles'),
    ],
};

function sortOptionsFor(source: string | undefined): SortOption[] {
    if (!source) return [];
    return SORT_OPTIONS[isRepositorySource(source) ? 'repository' : source] ?? [];
}

/** How a result is found among the mods in your lists */
function listedKeyOf(item: SearchResultItem): ListedKey | undefined {
    if (isRepositorySource(item.source)) {
        const raw = item.rawData as RepositoryResultData | undefined;
        return raw ? {source: 'repo', repoId: raw.repositoryId, slug: raw.slug} : undefined;
    }
    switch (item.source) {
        case SearchSource.MODIO:
            return item.platformId ? {source: 'modio', id: item.platformId} : undefined;
        case SearchSource.NEXUSMODS:
            return item.platformId ? {source: 'nexus', id: item.platformId} : undefined;
        case SearchSource.MODCAT:
            return item.nameId ? {source: 'modcat', id: item.nameId} : undefined;
        default:
            return undefined;
    }
}

/** A Pak Hub post found from a requirement, as a result to add */
function repositoryItem(req: ResolvedRequirement): SearchResultItem {
    const post = req.repoPost!;
    const raw: RepositoryResultData = {repositoryId: post.repositoryId, baseUrl: post.baseUrl, slug: post.slug, postedAt: '', fileCount: 0};
    return {
        id: `repo:${post.repositoryId}:${post.slug}`,
        nameId: post.slug,
        name: req.name,
        summary: '',
        profileUrl: `${post.baseUrl}/?mod=${encodeURIComponent(post.slug)}`,
        thumbnailUrl: '',
        author: {id: 0, name: '', avatarUrl: ''},
        stats: {downloads: 0, subscribers: 0},
        source: `repo:${post.repositoryId}` as SearchSourceKey,
        rawData: raw,
    };
}

/** Dropdown entry that opens the repository manager instead of switching source */
const MANAGE_REPOSITORIES = '__manage_repositories__';

// 搜索源显示名称映射
const sourceDisplayNames: Record<SearchSource, string> = {
    [SearchSource.MODIO]: 'mod.io',
    [SearchSource.MODCAT]: 'ModCat',
    [SearchSource.NEXUSMODS]: 'Nexus Mods',
    [SearchSource.THUNDERSTORE]: 'Thunderstore',
    [SearchSource.LOCAL]: 'Local',
};

/**
 * 搜索页面组件
 * 支持多搜索源的 mod 搜索和浏览
 */
export function SearchPage() {
    const {
        state,
        isInitialized,
        search,
        searchImmediate,
        loadInitial,
        resumeOrLoad,
        loadMore,
        refresh,
        reset,
        switchSource,
        setSort,
        translateItem,
        restoreItem,
        getSearchPlaceholder,
        refreshAvailableSources,
    } = useSearchViewModel();

    // Reopened page: show the query the kept results belong to
    const [searchValue, setSearchValue] = useState(() => getSearchViewModel().getState().query || '');
    const [windowContentHeight, setContainerHeight] = useState(window.innerHeight - 81);
    const logPanelOffset = useLogPanelOffset();
    const containerHeight = windowContentHeight - logPanelOffset;
    const containerRef = useRef<HTMLDivElement>(null);

    // Mods already in your lists, to mark them on the cards (rebuilt when mods are added)
    const [listed, setListed] = useState<ListedIndex>(() => ListedIndex.empty());
    const refreshListed = useCallback(async () => {
        try {
            setListed(await buildListedIndex());
        } catch (error) {
            console.warn('[SearchPage] could not read the lists', error);
        }
    }, []);
    useEffect(() => {
        void refreshListed();
        let unlisten: (() => void) | undefined;
        let alive = true;
        listenEvent('mods-added', () => refreshListed()).then((fn) => {
            if (alive) unlisten = fn;
            else fn();
        });
        return () => {
            alive = false;
            unlisten?.();
        };
    }, [refreshListed]);

    // 初始化搜索提供者，并按当前游戏刷新可用源后再做首次加载（避免 RC 时仍用 mod.io）
    useEffect(() => {
        initializeSearchProviders();
        let cancelled = false;
        Promise.resolve(refreshAvailableSources()).then(() => {
            if (!cancelled) resumeOrLoad();
        });
        return () => {
            cancelled = true;
        };
    }, [refreshAvailableSources, resumeOrLoad]);

    // Go back to where the result list was scrolled to (kept by onScroll below) when reopened.
    // The cards render a moment after mounting, so retry for a few frames until it sticks.
    useEffect(() => {
        const saved = getSearchViewModel().scrollTop;
        if (saved <= 0) return;
        let frames = 0;
        let handle = 0;
        const restore = () => {
            const el = containerRef.current;
            if (!el) return;
            el.scrollTop = saved;
            if (Math.abs(el.scrollTop - saved) > 2 && ++frames < 30) {
                handle = requestAnimationFrame(restore);
            }
        };
        handle = requestAnimationFrame(restore);
        return () => cancelAnimationFrame(handle);
    }, []);

    // 监听窗口大小变化
    useEffect(() => {
        const handleResize = () => {
            setContainerHeight(window.innerHeight - 81);
        };

        // 使用 Tauri 的窗口事件
        let unlisten: (() => void) | undefined;
        getCurrentWindow()
            .onResized(() => {
                handleResize();
            })
            .then((fn) => {
                unlisten = fn;
            });

        // 同时监听浏览器 resize 事件作为备选
        window.addEventListener('resize', handleResize);

        return () => {
            unlisten?.();
            window.removeEventListener('resize', handleResize);
        };
    }, []);

    // 处理搜索
    const handleSearch = useCallback(
        (value: string) => {
            setSearchValue(value);
            searchImmediate(value);
        },
        [searchImmediate]
    );

    // 处理输入变化
    const handleSearchInputChange = useCallback(
        (e: React.ChangeEvent<HTMLInputElement>) => {
            const value = e.target.value;
            setSearchValue(value);
            search(value);
        },
        [search]
    );

    // 处理重置（点击首页按钮）
    const handleReset = useCallback(async () => {
        setSearchValue('');
        await reset();
    }, [reset]);

    // 处理刷新
    const handleRefresh = useCallback(async () => {
        await refresh();
    }, [refresh]);

    const [repoDialogOpen, setRepoDialogOpen] = useState(false);

    // 处理搜索源切换
    const handleSourceChange = useCallback(
        (value: SearchSourceKey | typeof MANAGE_REPOSITORIES) => {
            if (value === MANAGE_REPOSITORIES) {
                setRepoDialogOpen(true);
                return;
            }
            // keep the sort when the new source has it, else use that source's default
            const options = sortOptionsFor(value);
            const keeps = options.some(o => o.sortBy === state?.sortBy && o.sortOrder === state?.sortOrder);
            const fallback = options[0] ?? sortOption('date', 'desc', '');
            switchSource(value, keeps ? undefined : {sortBy: fallback.sortBy, sortOrder: fallback.sortOrder});
        },
        [switchSource, state?.sortBy, state?.sortOrder]
    );

    // Repositories added/removed: refresh the source list (and jump to a newly added one)
    const handleRepositoriesChanged = useCallback(async (added?: ModRepository) => {
        await syncRepositoryProviders();
        await refreshAvailableSources();
        if (added) {
            setRepoDialogOpen(false);
            await switchSource(repositorySourceKey(added));
        }
    }, [refreshAvailableSources, switchSource]);

    // Remove a source from the dropdown (same as in "Add or remove sources…")
    const handleRemoveSource = useCallback(async (source: string) => {
        if ((state?.availableSources?.length ?? 0) <= 1) return;
        if (isRepositorySource(source)) {
            const repo = await RepositoryStore.get(source.replace(/^repo:/, ''));
            if (repo && await removeRepository(repo)) await handleRepositoriesChanged();
            return;
        }
        if (await hideBuiltInSource(source)) await handleRepositoriesChanged();
    }, [handleRepositoriesChanged, state?.availableSources?.length]);

    // Sort of the current source
    const handleSortChange = useCallback(
        (value: string) => {
            const option = sortOptionsFor(state?.currentSource).find((o) => o.value === value);
            if (option) setSort(option.sortBy, option.sortOrder);
        },
        [setSort, state?.currentSource]
    );

    // 处理添加 mod
    // The Add Mod window's link for a Nexus mod page: the page itself for Premium, else the file
    // link from the Nexus window (null when that window was closed)
    const nexusAddLink = useCallback(async (pageUrl: string, gameId?: number): Promise<string | null> => {
        const parsed = NexusModsApi.parseModLinks(pageUrl);
        if (!parsed) throw new Error(t('Invalid Mod Link'));
        if (await NexusModsApi.canDownloadThroughApi()) return pageUrl;
        try {
            return await captureNexusDownloadUrl(pageUrl, {parsed, gameId});
        } catch (error) {
            if (isNexusDownloadWindowClosed(error)) return null;
            throw error;
        }
    }, []);

    const handleAdd = useCallback(async (item: SearchResultItem, pick?: FilePick) => {
        try {
            // A Nexus mod with more than one file: which one(s). The first becomes the mod's entry;
            // more (add-ons) become entries of their own, as does a file added to a mod already in the list
            const listedNow = await buildListedIndex();
            let nexusPicks: { fileId: number; separate: boolean }[] = [];
            if (item.source === SearchSource.NEXUSMODS) {
                const files = nexusFilesOf(item);
                const inList = !!listedNow.get(listedKeyOf(item))?.inActiveProfile;
                const choice = nexusChoiceOf(item);
                const inUse = [...nexusFilesInUse(item, files, listedNow, inList, choice)];
                const name = item.nameTrans || item.name;
                if (pick?.nexusFileId) {
                    const file = files.find(f => f.fileId === pick.nexusFileId);
                    if (file && inList && !inUse.includes(file.fileId)) {
                        const current = nexusOwnFileName(item, listedNow)
                            ?? (files.find(f => inUse.includes(f.fileId)) ?? files.find(f => isChosenFile(f, choice)))?.name;
                        const answer = await MessageBox.choose({
                            title: t("files.inListTitle", {name}),
                            content: current
                                ? t("files.inListText", {file: file.name, current})
                                : t("files.inListTextUnknown", {file: file.name}),
                            width: 560,
                        }, [
                            // an optional / update / other file is usually an add-on; a main file a variant
                            {key: 'separate', label: t("files.addSeparate"), primary: file.category !== 'MAIN'},
                            {key: 'replace', label: t("files.useInstead"), primary: file.category === 'MAIN'},
                        ], t("Cancel"));
                        if (!answer) return;
                        nexusPicks = [{fileId: file.fileId, separate: answer === 'separate'}];
                    } else {
                        // in use already: added again the same way (the list says it's there)
                        const ownEntry = !!listedNow.get({source: 'nexusFile', id: `${item.platformId}-${pick.nexusFileId}`})?.inActiveProfile
                            && !files.some(f => f.fileId === pick.nexusFileId && isChosenFile(f, choice));
                        nexusPicks = [{fileId: pick.nexusFileId, separate: ownEntry}];
                    }
                } else if (files.length > 0) {
                    const initial = inList ? [] : [(files.find(f => isChosenFile(f, choice)) ?? files[0]).fileId];
                    const answer = await askNexusFiles(name, files, initial, inUse, inList);
                    if (answer === null) return;
                    if (answer.length === 0) {
                        message.info(t("files.nothingPicked"));
                        return;
                    }
                    nexusPicks = answer.map((fileId, i) => ({fileId, separate: inList || i > 0}));
                }
            }

            // Mods it needs (Nexus page requirements; what a Pak Hub post names): ask which to add too
            let extras: ResolvedRequirement[] = [];
            let plan: RequirementPlan | null = null;
            let detailForName: RepositoryModDetail | undefined;
            try {
                const detail = isRepositorySource(item.source)
                    ? await (async () => {
                        const raw = item.rawData as RepositoryResultData | undefined;
                        return raw ? await loadRepositoryDetail(raw.baseUrl, raw.slug) : undefined;
                    })()
                    : undefined;
                detailForName = detail;
                plan = await planFor(item, listedNow, detail, 'all');
            } catch (error) {
                console.warn('[SearchPage] requirements not checked', error);
            }
            if (worthAsking(plan)) {
                // the card's title: a Pak Hub post's file names when it has them
                const shownName = item.nameTrans || (isRepositorySource(item.source) && detailForName
                    ? repositoryTitleFromFiles(detailForName) : undefined) || item.name;
                const answer = await askRequirements(shownName, plan!);
                if (answer === null) return;
                extras = answer;
            }

            const links: string[] = [];
            if (isRepositorySource(item.source)) {
                // its files chosen and added first; cancelled there: nothing else is added either
                if (!await addRepositoryMod(item, pick?.repoFileUrl)) return;
            } else if (item.source === SearchSource.NEXUSMODS) {
                const node = item.rawData as NexusModsModNode | undefined;
                const gameId = node?.gameId || Number(node?.game?.id) || undefined;
                const parsed = NexusModsApi.parseModLinks(item.profileUrl);
                const pages = nexusPicks.length > 0 && parsed
                    ? nexusPicks.map(p => NexusModsApi.getModFileUrl(parsed.domain, parsed.modId, p.fileId, p.separate))
                    : [item.profileUrl];
                for (const pageUrl of pages) {
                    const link = await nexusAddLink(pageUrl, gameId);
                    if (!link) {
                        message.info(t('nexusmods.windowClosed'));
                        if (links.length === 0) return;
                        break;
                    }
                    links.push(link);
                }
            } else {
                links.push(item.profileUrl);
            }

            // the ticked requirements: Nexus / mod.io ones go to the Add Mod window with the mod,
            // Pak Hub posts are added one after the other
            const posts: ResolvedRequirement[] = [];
            for (const req of extras) {
                if (req.repoPost) {
                    posts.push(req);
                } else if (req.source === 'nexus' && req.link) {
                    const node = item.rawData as NexusModsModNode | undefined;
                    const link = await nexusAddLink(req.link, node?.gameId || undefined).catch(() => null);
                    if (link) links.push(link);
                    else message.info(t('req.skipped', {name: req.name}));
                } else if (req.link) {
                    links.push(req.link);
                }
            }
            if (links.length > 0) {
                await openWindow(AddModType.ONLINE, 0, links.join('\n'));
            }
            for (const req of posts) {
                await addRepositoryMod(repositoryItem(req));
            }
        } catch (error) {
            if (isNexusDownloadWindowClosed(error)) {
                message.info(t('nexusmods.windowClosed'));
                return;
            }
            console.error('Failed to open add mod dialog:', error instanceof Error ? error.message : error);
            message.error(`${t('Add Mod Error')}: ${error instanceof Error ? error.message : String(error)}`);
        }
    }, [nexusAddLink]);

    // 处理翻译
    const handleTranslate = useCallback(
        (itemId: string) => {
            translateItem(itemId);
        },
        [translateItem]
    );

    // 处理恢复原文
    const handleRestore = useCallback(
        (itemId: string) => {
            restoreItem(itemId);
        },
        [restoreItem]
    );

    // 搜索源选项（用于下拉框）
    const sourceOptions = useMemo(() => {
        const sources = [...(state?.availableSources || [SearchSource.MODIO])];
        // A remembered repository source can be selected before the list has loaded
        if (state?.currentSource && isRepositorySource(state.currentSource) && !sources.includes(state.currentSource)) {
            sources.push(state.currentSource);
        }
        const options: { value: string; label: string }[] = sources.map((source) => ({
            value: source,
            label: isRepositorySource(source)
                ? repositorySourceLabel(source)
                : (sourceDisplayNames[source as SearchSource] || source),
        }));
        options.push({value: MANAGE_REPOSITORIES, label: t('repo.manageOption')});
        return options;
    }, [state?.availableSources, state?.currentSource]);

    const currentSortOptions = useMemo(() => sortOptionsFor(state?.currentSource), [state?.currentSource]);

    // 搜索占位符
    const placeholder = useMemo(() => {
        return getSearchPlaceholder();
    }, [getSearchPlaceholder, state?.currentSource]);

    // 加载状态
    const isLoading = state?.loading ?? true;
    const items = state?.items ?? [];
    const hasMore = state?.hasMore ?? false;

    // 渲染加载骨架屏
    const renderSkeleton = () => (
        <div style={{padding: '16px'}}>
            {[1, 2, 3].map((i) => (
                <div key={i} style={{marginBottom: 16}}>
                    <Skeleton avatar paragraph={{rows: 2}} active />
                </div>
            ))}
        </div>
    );

    // 渲染空状态
    const renderEmpty = () => (
        <Empty
            description={t('No results found')}
            style={{marginTop: 60}}
        />
    );

    return (
        <>
        <RepositoryManagerDialog open={repoDialogOpen}
                                 onClose={() => setRepoDialogOpen(false)}
                                 visibleSources={state?.availableSources ?? []}
                                 onChanged={handleRepositoriesChanged}/>
        <div
            ref={containerRef}
            id="searchScrollableDiv"
            onScroll={(e) => {
                getSearchViewModel().scrollTop = e.currentTarget.scrollTop;
            }}
            className="search-page-container"
            style={{height: containerHeight}}
        >
            <Flex vertical gap={12}>
                {/* 搜索栏 */}
                <Flex gap={8} align="center" className="search-page-header">
                    <Button
                        type="text"
                        icon={<HomeOutlined />}
                        disabled={isLoading}
                        onClick={handleReset}
                        title={t('Home')}
                    />

                    {/* 网站选择下拉框 */}
                    <Select
                        value={state?.currentSource}
                        title=""
                        options={sourceOptions}
                        onChange={handleSourceChange}
                        disabled={isLoading}
                        style={{width: 140}}
                        popupMatchSelectWidth={false}
                        optionRender={(option) => {
                            const source = String(option.value ?? '');
                            if (source === MANAGE_REPOSITORIES) return option.label;
                            // any source can be removed right here (built-in ones can be added back
                            // in the repository manager); the last one stays
                            const last = (state?.availableSources?.length ?? 0) <= 1;
                            const title = last ? t('repo.cantRemoveLast') : t('repo.removeTitle', {name: String(option.label ?? '')});
                            return (
                                <Flex align="center" justify="space-between" gap={12}>
                                    <span>{option.label}</span>
                                    <Button size="small" type="text" danger
                                            className="search-source-remove"
                                            icon={<DeleteOutlined/>}
                                            disabled={last}
                                            title={title}
                                            aria-label={title}
                                            onMouseDown={(e) => {
                                                e.preventDefault();
                                                e.stopPropagation();
                                            }}
                                            onClick={(e) => {
                                                e.preventDefault();
                                                e.stopPropagation();
                                                void handleRemoveSource(source);
                                            }}/>
                                </Flex>
                            );
                        }}
                    />

                    {/* Sort, for sources that can sort (not ModCat) */}
                    {currentSortOptions.length > 0 && (
                        <Select
                            value={currentSortOptions.find(o => o.sortBy === state?.sortBy && o.sortOrder === state?.sortOrder)?.value
                                ?? currentSortOptions[0].value}
                            options={currentSortOptions.map((o) => ({value: o.value, label: t(o.labelKey)}))}
                            onChange={handleSortChange}
                            title=""
                            disabled={isLoading}
                            aria-label={t('sort.title')}
                            style={{width: 172}}
                            popupMatchSelectWidth={false}
                        />
                    )}

                    <Search
                        placeholder={placeholder}
                        value={searchValue}
                        onChange={handleSearchInputChange}
                        onSearch={handleSearch}
                        loading={isLoading}
                        allowClear
                        style={{flex: 1}}
                    />

                    <Button
                        type="text"
                        icon={<ReloadOutlined spin={isLoading} />}
                        disabled={isLoading}
                        onClick={handleRefresh}
                        title={t('Refresh')}
                    />
                </Flex>

                {/* 搜索结果列表 */}
                {!isInitialized ? (
                    renderSkeleton()
                ) : items.length === 0 && !isLoading ? (
                    renderEmpty()
                ) : (
                    <InfiniteScroll
                        scrollableTarget="searchScrollableDiv"
                        dataLength={items.length}
                        hasMore={hasMore}
                        loader={
                            <div style={{textAlign: 'center', padding: '20px'}}>
                                <Spin />
                            </div>
                        }
                        endMessage={
                            items.length > 0 ? (
                                <div
                                    style={{
                                        textAlign: 'center',
                                        padding: '20px',
                                        color: '#999',
                                    }}
                                >
                                    {t('No more results')}
                                </div>
                            ) : null
                        }
                        next={loadMore}
                    >
                        <div className="search-result-list">
                            {items.map((item) => (
                                <SearchResultCard
                                    key={item.id}
                                    item={item}
                                    listed={listed.get(listedKeyOf(item))}
                                    index={listed}
                                    onAdd={handleAdd}
                                    onTranslate={handleTranslate}
                                    onRestore={handleRestore}
                                />
                            ))}
                        </div>
                    </InfiniteScroll>
                )}

                {/* 初始加载指示器 */}
                {isLoading && items.length === 0 && isInitialized && renderSkeleton()}
            </Flex>
        </div>
        </>
    );
}

// 导出用于向后兼容的类组件包装器
export class ModioPage extends React.Component {
    render() {
        return <SearchPage />;
    }
}

export default SearchPage;
