// 类型导出
export type {
    SearchResultItem,
    SearchParams,
    SearchResult,
    SearchProviderStatus,
} from './types';

export {SearchSource, isRepositorySource} from './types';
export type {SearchSourceKey, RepositorySourceKey} from './types';

// 接口导出
export type {ISearchProvider} from './ISearchProvider';
export {SearchProviderRegistry} from './ISearchProvider';

// 提供者实现导出
export {ModioSearchProvider, getModioSearchProvider} from './ModioSearchProvider';
export {ModcatSearchProvider, getModcatSearchProvider} from './ModcatSearchProvider';
export {NexusModsSearchProvider, getNexusModsSearchProvider} from './NexusModsSearchProvider';
export {RepositorySearchProvider, repositorySourceKey} from './RepositorySearchProvider';
export type {RepositoryResultData} from './RepositorySearchProvider';

// 初始化搜索提供者注册
import {SearchProviderRegistry} from './ISearchProvider';
import {getModioSearchProvider} from './ModioSearchProvider';
import {getModcatSearchProvider} from './ModcatSearchProvider';
import {getNexusModsSearchProvider} from './NexusModsSearchProvider';
import {RepositorySearchProvider, repositorySourceKey} from './RepositorySearchProvider';
import {isRepositorySource} from './types';
import {RepositoryStore} from '@/apis/repositories';

/**
 * 初始化并注册所有搜索提供者
 */
export function initializeSearchProviders(): void {
    const registry = SearchProviderRegistry.getInstance();
    
    // 注册 mod.io 搜索提供者
    registry.register(getModioSearchProvider());
    
    // 注册 ModCat 搜索提供者
    registry.register(getModcatSearchProvider());

    // 注册 Nexus Mods 搜索提供者
    registry.register(getNexusModsSearchProvider());

    // 未来可以在这里添加更多搜索提供者
    // registry.register(getThunderstoreSearchProvider());
}

/**
 * Register one provider per user-added repository (replacing previous ones).
 */
export async function syncRepositoryProviders(): Promise<void> {
    // Read the list first, then swap providers without awaiting in between: the source
    // dropdown looks names up in the registry and showed the raw "repo:..." key when it
    // rendered while the providers were briefly unregistered.
    const repos = await RepositoryStore.list();
    const registry = SearchProviderRegistry.getInstance();
    const wanted = new Set(repos.map(repo => repositorySourceKey(repo)));
    for (const source of registry.getSources()) {
        if (isRepositorySource(source) && !wanted.has(source)) registry.unregister(source);
    }
    for (const repo of repos) {
        const existing = registry.get(repositorySourceKey(repo));
        const same = existing instanceof RepositorySearchProvider
            && existing.repository.name === repo.name
            && existing.repository.baseUrl === repo.baseUrl
            && existing.repository.game === repo.game;
        if (!same) {
            if (existing) registry.unregister(repositorySourceKey(repo));
            registry.register(new RepositorySearchProvider(repo));
        }
    }
}

/** Display name for a "repo:<id>" source even before the providers are registered */
export function repositorySourceLabel(source: string): string {
    const provider = SearchProviderRegistry.getInstance().get(source as never);
    if (provider?.displayName) return provider.displayName;
    const id = source.replace(/^repo:/, '');
    return RepositoryStore.peekName(id)
        ?? id.split(/[-_]+/).filter(Boolean).map(w => w.charAt(0).toUpperCase() + w.slice(1)).join(' ');
}
