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
import {removeRepository} from '@/services/RepositoryRemoval';
import {RepositoryStore} from '@/apis/repositories';
import {getSearchViewModel} from './SearchViewModel';
import type {ModRepository} from '@/apis/repositories';
import {AddModType} from '@/dialogs/AddModDialog';
import {openWindow} from '@/dialogs/AddModDialog/open';
import {NexusModsApi} from '@/apis/nexusmods';
import {captureNexusDownloadUrl, isNexusDownloadWindowClosed} from '@/apis/nexusmods/downloadWebview';
import type {NexusModsModNode} from '@/apis/nexusmods/types';
import './styles.css';

// mod.io 排序选项：value 为 sortBy_sortOrder，便于与 state 同步
const MODIO_SORT_OPTIONS: { value: string; sortBy: SearchSortBy; sortOrder: SearchSortOrder }[] = [
    { value: 'date_desc', sortBy: 'date', sortOrder: 'desc' },
    { value: 'downloads_desc', sortBy: 'downloads', sortOrder: 'desc' },
    { value: 'rating_desc', sortBy: 'rating', sortOrder: 'desc' },
    { value: 'name_asc', sortBy: 'name', sortOrder: 'asc' },
    { value: 'name_desc', sortBy: 'name', sortOrder: 'desc' },
];

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
            switchSource(value);
        },
        [switchSource]
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

    // Remove a repository from the source dropdown (same as in "Add or remove repositories…")
    const handleRemoveRepository = useCallback(async (source: string) => {
        const repo = await RepositoryStore.get(source.replace(/^repo:/, ''));
        if (!repo) return;
        if (await removeRepository(repo)) await handleRepositoriesChanged();
    }, [handleRepositoriesChanged]);

    // 处理 mod.io 排序变更
    const handleSortChange = useCallback(
        (value: string) => {
            const option = MODIO_SORT_OPTIONS.find((o) => o.value === value);
            if (option) setSort(option.sortBy, option.sortOrder);
        },
        [setSort]
    );

    // 处理添加 mod
    const handleAdd = useCallback(async (item: SearchResultItem) => {
        try {
            if (isRepositorySource(item.source)) {
                await addRepositoryMod(item);
                return;
            }
            if (item.source === SearchSource.NEXUSMODS) {
                const parsed = NexusModsApi.parseModLinks(item.profileUrl);
                if (!parsed) {
                    message.error(t('Invalid Mod Link'));
                    return;
                }
                // Premium: the API gives the file, no Nexus page needed
                if (await NexusModsApi.canDownloadThroughApi()) {
                    await openWindow(AddModType.ONLINE, 0, item.profileUrl);
                    return;
                }
                const node = item.rawData as NexusModsModNode | undefined;
                const gameId = node?.gameId || Number(node?.game?.id) || undefined;
                const addModUrl = await captureNexusDownloadUrl(item.profileUrl, { parsed, gameId });
                await openWindow(AddModType.ONLINE, 0, addModUrl);
                return;
            }

            await openWindow(AddModType.ONLINE, 0, item.profileUrl);
        } catch (error) {
            if (isNexusDownloadWindowClosed(error)) {
                message.info(t('nexusmods.windowClosed'));
                return;
            }
            console.error('Failed to open add mod dialog:', error instanceof Error ? error.message : error);
            message.error(`${t('Add Mod Error')}: ${error instanceof Error ? error.message : String(error)}`);
        }
    }, []);

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
                        options={sourceOptions}
                        onChange={handleSourceChange}
                        disabled={isLoading}
                        style={{width: 140}}
                        popupMatchSelectWidth={false}
                        optionRender={(option) => {
                            const source = String(option.value ?? '');
                            if (!isRepositorySource(source)) return option.label;
                            // repositories can be removed right here
                            return (
                                <Flex align="center" justify="space-between" gap={12}>
                                    <span>{option.label}</span>
                                    <Button size="small" type="text" danger
                                            className="search-source-remove"
                                            icon={<DeleteOutlined/>}
                                            title={t('repo.removeTitle', {name: String(option.label ?? '')})}
                                            aria-label={t('repo.removeTitle', {name: String(option.label ?? '')})}
                                            onMouseDown={(e) => {
                                                e.preventDefault();
                                                e.stopPropagation();
                                            }}
                                            onClick={(e) => {
                                                e.preventDefault();
                                                e.stopPropagation();
                                                void handleRemoveRepository(source);
                                            }}/>
                                </Flex>
                            );
                        }}
                    />

                    {/* mod.io 排序（仅当前源为 mod.io 时显示） */}
                    {state?.currentSource === SearchSource.MODIO && (
                        <Select
                            value={`${state?.sortBy ?? 'date'}_${state?.sortOrder ?? 'desc'}`}
                            options={MODIO_SORT_OPTIONS.map((o) => ({
                                value: o.value,
                                label: t(
                                    o.value === 'date_desc'
                                        ? 'Latest'
                                        : o.value === 'downloads_desc'
                                          ? 'Popular'
                                          : o.value === 'rating_desc'
                                            ? 'Top Rated'
                                            : o.value === 'name_asc'
                                              ? 'Name A–Z'
                                              : 'Name Z–A'
                                ),
                            }))}
                            onChange={handleSortChange}
                            disabled={isLoading}
                            style={{width: 120}}
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
