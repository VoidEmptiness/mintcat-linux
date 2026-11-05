import {t} from 'i18next';
import {message} from 'antd';
import {ISearchProvider} from './ISearchProvider';
import {RepositorySourceKey, SearchParams, SearchProviderStatus, SearchResult, SearchResultItem} from './types';
import {ModRepository, RepositoryApi, RepositoryModSummary, RepositorySort} from '@/apis/repositories';

export function repositorySourceKey(repo: ModRepository): RepositorySourceKey {
    return `repo:${repo.id}`;
}

/** Extra data kept on repository search results */
export interface RepositoryResultData {
    repositoryId: string;
    /** Site address, so cards can load the post's text and file names */
    baseUrl: string;
    slug: string;
    postedAt: string;
    fileCount: number;
}

/**
 * Browse/search a user-added Pak Hub style repository.
 */
export class RepositorySearchProvider implements ISearchProvider {
    public readonly source: RepositorySourceKey;
    public readonly displayName: string;

    constructor(public readonly repository: ModRepository) {
        this.source = repositorySourceKey(repository);
        this.displayName = repository.name;
    }

    public async checkStatus(): Promise<SearchProviderStatus> {
        try {
            await RepositoryApi.listMods(this.repository, {page: 1});
            return {available: true, requiresAuth: false, authenticated: true};
        } catch (error) {
            return {available: false, requiresAuth: false, authenticated: false, error: String(error)};
        }
    }

    public async search(params: SearchParams): Promise<SearchResult> {
        const {query, page, pageSize, sortBy, sortOrder} = params;
        let sort: RepositorySort = 'newest';
        if (sortBy === 'name') sort = sortOrder === 'desc' ? 'name-desc' : 'name';
        else if ((sortBy === 'date' || sortBy === 'created') && sortOrder === 'asc') sort = 'oldest';
        else if (sortBy === 'files') sort = sortOrder === 'asc' ? 'fewest-files' : 'most-files';

        try {
            // The app pages from 0; repositories page from 1 with their own page size
            const result = await RepositoryApi.listMods(this.repository, {query, page: page + 1, sort});
            return {
                items: result.mods.map(mod => this.toItem(mod)),
                total: result.total,
                page,
                pageSize,
                hasMore: (page + 1) * result.pageSize < result.total,
                source: this.source,
            };
        } catch (error) {
            console.error(`[RepositorySearchProvider] ${this.repository.baseUrl}:`, error);
            message.error(t('repo.loadFailed', {name: this.repository.name, reason: String(error)}));
            return {items: [], total: 0, page, pageSize, hasMore: false, source: this.source};
        }
    }

    public getSearchPlaceholder(): string {
        return t('repo.searchPlaceholder', {name: this.repository.name});
    }

    private toItem(mod: RepositoryModSummary): SearchResultItem {
        const raw: RepositoryResultData = {
            repositoryId: this.repository.id,
            baseUrl: this.repository.baseUrl,
            slug: mod.slug,
            postedAt: mod.postedAt,
            fileCount: mod.fileCount + mod.threadFileCount,
        };
        return {
            id: `${this.source}:${mod.slug}`,
            nameId: mod.slug,
            name: mod.name,
            summary: mod.summary,
            profileUrl: RepositoryApi.modPageUrl(this.repository, mod.slug),
            thumbnailUrl: '',
            author: {id: 0, name: mod.postedBy, avatarUrl: ''},
            stats: {downloads: 0, subscribers: 0},
            tags: [],
            source: this.source,
            rawData: raw,
        };
    }
}
