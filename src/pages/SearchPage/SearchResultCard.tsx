import React, {memo, useCallback, useState} from 'react';
import {ContextMenu} from "@/components/ContextMenu";
import {Avatar, Button, Space, Skeleton, Tag, Tooltip} from 'antd';
import {CalendarOutlined, CheckCircleFilled, DownloadOutlined, FileOutlined, LikeOutlined, PlusCircleOutlined, StarFilled, UserOutlined} from '@ant-design/icons';
import type {ListedIndex, ListedState} from '@/services/ListedMods';
import {CardRequirements, useRequirementPlan} from './CardRequirements';
import {CardFiles, type FilePick} from './CardFiles';
import {ModioSupportButtons, NexusSupportButtons} from '@/components/SupportButtons';
import {nexusDomainOf} from '@/services/ModSupport';
import type {NexusModsModNode} from '@/apis/nexusmods/types';
import {t} from 'i18next';
import {open} from '@tauri-apps/plugin-shell';
import type {MenuProps} from 'antd';
import {SearchResultItem, SearchSource, isRepositorySource, type RepositoryResultData} from '@/apis/search';
import {repositoryDescription, repositoryTitleFromFiles, useRepositoryDetail} from '@/apis/repositories/details';

interface SearchResultCardProps {
    item: SearchResultItem;
    /** In your lists already (undefined: not, or not known) */
    listed?: ListedState;
    /** Your lists, to mark requirements that are in them */
    index: ListedIndex;
    /** `pick`: a file clicked on the card (mods with more than one) */
    onAdd: (item: SearchResultItem, pick?: FilePick) => void;
    onTranslate: (itemId: string) => void;
    onRestore: (itemId: string) => void;
}

/**
 * 搜索结果卡片组件
 * 使用 memo 优化渲染性能
 */
export const SearchResultCard = memo<SearchResultCardProps>(({
    item,
    listed,
    index,
    onAdd,
    onTranslate,
    onRestore,
}) => {
    const [imageLoaded, setImageLoaded] = useState(false);
    const [avatarLoaded, setAvatarLoaded] = useState(false);
    const [thumbnailCacheFailed, setThumbnailCacheFailed] = useState(false);
    const [avatarCacheFailed, setAvatarCacheFailed] = useState(false);

    // 右键菜单项
    const contextMenuItems: MenuProps['items'] = [
        {label: t('action.translateToCurrentLanguage'), key: 'translate'},
        {label: t('Restore'), key: 'restore'},
    ];

    // 处理菜单点击
    const handleMenuClick = useCallback(
        (e: {key: string}) => {
            if (e.key === 'translate') {
                onTranslate(item.id);
            } else if (e.key === 'restore') {
                onRestore(item.id);
            }
        },
        [item.id, onTranslate, onRestore]
    );

    // 处理添加点击
    const handleAddClick = useCallback(() => {
        onAdd(item);
    }, [item, onAdd]);
    const handlePick = useCallback((pick: FilePick) => {
        onAdd(item, pick);
    }, [item, onAdd]);

    // 处理标题点击
    const handleTitleClick = useCallback(async () => {
        await open(item.profileUrl);
    }, [item.profileUrl]);

    // 优先使用缓存图片；如果缓存文件加载失败，回退到远端 URL，避免坏缓存导致图片闪现后消失。
    const displayThumbnail = !thumbnailCacheFailed && item.cachedThumbnailUrl
        ? item.cachedThumbnailUrl
        : item.thumbnailUrl;
    const displayAvatar = !avatarCacheFailed && item.author.cachedAvatarUrl
        ? item.author.cachedAvatarUrl
        : item.author.avatarUrl;

    // User-added repositories have no images or download counts
    const isRepo = isRepositorySource(item.source);
    const repoData = isRepo ? item.rawData as RepositoryResultData | undefined : undefined;
    // Pak Hub style lists only carry the first line of the post; the post itself has the
    // full text and the file names, which make a better title ("AlwaysSprint")
    const repoDetail = useRepositoryDetail(repoData?.baseUrl, repoData?.slug);
    const repoTitle = repositoryTitleFromFiles(repoDetail);
    const repoText = repositoryDescription(repoDetail);
    const plan = useRequirementPlan(item, index, repoDetail);

    // 显示的名称和摘要
    const displayName = item.nameTrans || repoTitle || item.name;
    const displaySummary = item.summaryTrans || repoText || item.summary;
    const repoDate = repoData?.postedAt && Number.isFinite(Date.parse(repoData.postedAt))
        ? new Date(repoData.postedAt).toLocaleDateString()
        : '';

    return (
        <ContextMenu
            menu={{
                items: contextMenuItems,
                onClick: handleMenuClick,
            }}
        >
            <div className="search-result-card">
                <div className="search-result-card-content">
                    <div className="search-result-card-avatar">
                        {isRepo && <Avatar size={48} icon={<FileOutlined/>}/>}
                        {!isRepo && (!displayAvatar || !avatarLoaded) && (
                            <Skeleton.Avatar active size={48} />
                        )}
                        {displayAvatar && (
                            <Avatar
                                style={{
                                    width: 60,
                                    height: 60,
                                    display: avatarLoaded ? 'block' : 'none',
                                }}
                                src={
                                    <img
                                        src={displayAvatar}
                                        alt={item.author.name}
                                        onLoad={() => setAvatarLoaded(true)}
                                        onError={() => {
                                            if (displayAvatar === item.author.cachedAvatarUrl && item.author.avatarUrl) {
                                                setAvatarCacheFailed(true);
                                                setAvatarLoaded(false);
                                                return;
                                            }
                                            setAvatarLoaded(true);
                                        }}
                                    />
                                }
                            />
                        )}
                    </div>

                    <div className="search-result-card-info">
                        <div className="search-result-card-title">
                            <a onClick={handleTitleClick} className="search-result-card-name">
                                {displayName}
                            </a>
                            <Tooltip title={listed?.inActiveProfile ? t('browse.addAgainTip') : t('browse.addTip')}>
                                <Button
                                    type="text"
                                    size="small"
                                    icon={<PlusCircleOutlined />}
                                    onClick={handleAddClick}
                                    className="search-result-card-add-btn"
                                />
                            </Tooltip>
                            <ListedTag listed={listed}/>
                        </div>

                        <div className="search-result-card-description">
                            {displaySummary}
                        </div>

                        <CardRequirements plan={plan}/>

                        <CardFiles item={item} listed={listed} repoDetail={repoDetail} onPick={handlePick}/>

                        <div className="search-result-card-stats">
                            <Space size="middle">
                                {isRepo ? (
                                    <>
                                        <span className="search-result-card-stat">
                                            <FileOutlined /> {t('repo.fileCount', {count: repoData?.fileCount ?? 0})}
                                        </span>
                                        {repoDate && (
                                            <span className="search-result-card-stat">
                                                <CalendarOutlined /> {repoDate}
                                            </span>
                                        )}
                                    </>
                                ) : (
                                    <>
                                        <span className="search-result-card-stat">
                                            <DownloadOutlined /> {formatNumber(item.stats.downloads)}
                                        </span>
                                        <span className="search-result-card-stat">
                                            <LikeOutlined /> {formatNumber(item.stats.subscribers)}
                                        </span>
                                    </>
                                )}
                                {item.stats.rating != null && item.stats.rating > 0 && (
                                    <span className="search-result-card-stat search-result-card-rating">
                                        <StarFilled /> {formatRating(item.stats.rating)}
                                    </span>
                                )}
                                {item.author.name && item.author.name !== 'Unknown' && (
                                    <span className="search-result-card-stat">
                                        <UserOutlined /> {item.author.name}
                                    </span>
                                )}
                            </Space>
                            {item.source === SearchSource.NEXUSMODS && item.platformId && (
                                <NexusSupportButtons domain={nexusDomainOf(item.profileUrl)}
                                                     modId={item.platformId}
                                                     name={displayName}
                                                     modVersion={(item.rawData as NexusModsModNode | undefined)?.version}/>
                            )}
                            {item.source === SearchSource.MODIO && item.platformId && (
                                <ModioSupportButtons modId={item.platformId} name={displayName}/>
                            )}
                        </div>
                    </div>

                    {!isRepo && <div className="search-result-card-thumbnail">
                        {(!displayThumbnail || !imageLoaded) && (
                            <Skeleton.Image
                                active
                                style={{width: 160, height: 90}}
                            />
                        )}
                        {displayThumbnail && (
                            <img
                                src={displayThumbnail}
                                alt={item.name}
                                style={{
                                    width: 160,
                                    height: 90,
                                    borderRadius: 4,
                                    objectFit: 'cover',
                                    display: imageLoaded ? 'block' : 'none',
                                }}
                                onLoad={() => setImageLoaded(true)}
                                onError={() => {
                                    if (displayThumbnail === item.cachedThumbnailUrl && item.thumbnailUrl) {
                                        setThumbnailCacheFailed(true);
                                        setImageLoaded(false);
                                        return;
                                    }
                                    setImageLoaded(true);
                                }}
                            />
                        )}
                    </div>}
                </div>
            </div>
        </ContextMenu>
    );
});

SearchResultCard.displayName = 'SearchResultCard';

/** "In your list · Folder" (green) or "In profile X" (blue) next to the title */
function ListedTag({listed}: { listed?: ListedState }) {
    if (!listed) return null;
    if (listed.inActiveProfile) {
        const others = listed.otherProfiles.length > 0 ? ` ${t('browse.alsoIn', {names: listed.otherProfiles.join(', ')})}` : '';
        return (
            <Tooltip title={(listed.folder ? t('browse.inYourListFolderTip', {folder: listed.folder}) : t('browse.inYourListTip')) + others}>
                <Tag color="success" icon={<CheckCircleFilled/>} className="search-result-card-listed">
                    {listed.folder ? t('browse.inYourListFolder', {folder: listed.folder.split(' / ').pop()}) : t('browse.inYourList')}
                </Tag>
            </Tooltip>
        );
    }
    return (
        <Tooltip title={t('browse.inOtherProfilesTip', {names: listed.otherProfiles.join(', ')})}>
            <Tag color="processing" className="search-result-card-listed">
                {listed.otherProfiles.length === 1
                    ? t('browse.inProfile', {name: listed.otherProfiles[0]})
                    : t('browse.inProfiles', {count: listed.otherProfiles.length})}
            </Tag>
        </Tooltip>
    );
}

/**
 * 格式化数字（如 1234 -> 1.2K）
 */
function formatNumber(num: number): string {
    if (num >= 1000000) {
        return (num / 1000000).toFixed(1) + 'M';
    }
    if (num >= 1000) {
        return (num / 1000).toFixed(1) + 'K';
    }
    return num.toString();
}

/**
 * 格式化评分（百分比转 5 分制显示）
 * rating 存储为百分比 (0-100)，显示为 X.X/5
 */
function formatRating(rating: number): string {
    const score = rating / 20;
    return score % 1 === 0 ? `${score}/5` : `${score.toFixed(1)}/5`;
}
