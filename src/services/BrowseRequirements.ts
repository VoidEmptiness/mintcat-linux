/**
 * Requirements of a Browse Mods result, with what's already in your lists:
 *   Nexus Mods  the mod page's requirements (other Nexus mods, outside tools, DLC)
 *   mod.io      the mod's dependencies (MINTCAT adds these along with the mod anyway)
 *   Pak Hub     what the author wrote: linked mod.io / Nexus mods and Pak Hub posts (Discord
 *               links), mods named after "needs"/"requires", load order and conflicts
 */
import {isRepositorySource, SearchSource, type RepositoryResultData, type SearchResultItem} from "@/apis/search";
import type {NexusModsModNode} from "@/apis/nexusmods/types";
import type {RepositoryModDetail} from "@/apis/repositories";
import {findPostsByMessageIds, loadRepositoryDetail, repositoryTitleFromFiles, slugSuffix, messageIdSuffix} from "@/apis/repositories/details";
import {ModioApi} from "@/apis/modio";
import {analyzePostText, findModByName, nexusRequirements, type OrderHint, type Requirement} from "@/services/ModRequirements";
import type {ListedIndex, ListedKey, ListedState} from "@/services/ListedMods";
import {nexusDomainOf} from "@/services/ModSupport";

export interface ResolvedRequirement extends Requirement {
    /** Already in your lists */
    listed?: ListedState;
    /** Named only ("Needs UUI"): the mod of your list it means */
    matchedName?: string;
    /** A Pak Hub post (from a Discord link) */
    repoPost?: { repositoryId: string; baseUrl: string; slug: string };
}

export interface ResolvedOrderHint extends OrderHint {
    /** The mod of your list it means ("CAO" → "Customizable Ally Outlines") */
    match?: string;
}

export interface RequirementPlan {
    source: 'nexus' | 'modio' | 'pakhub';
    requirements: ResolvedRequirement[];
    /** The author's sentences about requirements, load order, conflicts, who needs it (Pak Hub) */
    notes: string[];
    orderHints: ResolvedOrderHint[];
}

// ---------- mod.io dependencies (session cache, a few requests at a time) ----------

const modioDeps = new Map<number, Promise<Requirement[]>>();
let modioRunning = 0;
const modioQueue: (() => void)[] = [];

function limited<T>(task: () => Promise<T>): Promise<T> {
    return new Promise<T>((resolve, reject) => {
        const start = () => {
            modioRunning++;
            task().then(resolve, reject).finally(() => {
                modioRunning--;
                modioQueue.shift()?.();
            });
        };
        if (modioRunning < 3) start();
        else modioQueue.push(start);
    });
}

export function modioDependencies(modId: number): Promise<Requirement[]> {
    const existing = modioDeps.get(modId);
    if (existing) return existing;
    const promise = limited(() => ModioApi.getDependenciesQuiet(modId)).then(deps => deps.map(dep => ({
        key: `modio:${dep.nameId || dep.id}`,
        name: dep.name || dep.nameId || `#${dep.id}`,
        source: 'modio' as const,
        addable: true,
        likely: true,
        modioSlug: dep.nameId || undefined,
        modioId: dep.id,
        link: dep.nameId ? `https://mod.io/g/drg/m/${dep.nameId}` : undefined,
    })));
    modioDeps.set(modId, promise);
    promise.catch(() => modioDeps.delete(modId));
    return promise;
}

// ---------- marking what's in your lists ----------

function listedKeyOfRequirement(req: ResolvedRequirement): ListedKey | undefined {
    if (req.source === 'nexus' && req.nexusModId) return {source: 'nexus', id: req.nexusModId};
    if (req.source === 'modio' && req.modioId) return {source: 'modio', id: req.modioId};
    if (req.source === 'modio' && req.modioSlug) return {source: 'modioSlug', id: req.modioSlug};
    if (req.repoPost) return {source: 'repo', repoId: req.repoPost.repositoryId, slug: req.repoPost.slug};
    return undefined;
}

function markListed(reqs: ResolvedRequirement[], index: ListedIndex): ResolvedRequirement[] {
    return reqs.map(req => {
        const listed = index.get(listedKeyOfRequirement(req))
            ?? (req.source === 'modio' && req.modioSlug ? index.get({source: 'modioSlug', id: req.modioSlug}) : undefined);
        if (listed) return {...req, listed};
        if (req.source === 'named') {
            const match = findModByName(req.name, index.activeModNames);
            if (match) return {...req, matchedName: match.name, listed: {inActiveProfile: true, otherProfiles: [], modId: match.modId}};
        }
        return req;
    });
}

function resolveOrderHints(hints: OrderHint[], index: ListedIndex): ResolvedOrderHint[] {
    const seen = new Set<string>();
    return hints
        .map(hint => ({...hint, match: findModByName(hint.target, index.activeModNames)?.name}))
        .filter(hint => {
            const key = `${hint.direction}:${(hint.match ?? hint.target).toLowerCase()}`;
            if (seen.has(key)) return false;
            seen.add(key);
            return true;
        });
}

// ---------- plans ----------

export function nexusPlan(item: SearchResultItem, index: ListedIndex): RequirementPlan | null {
    const node = item.rawData as NexusModsModNode | undefined;
    if (!node?.modRequirements) return null;
    const requirements = nexusRequirements(node, nexusDomainOf(item.profileUrl));
    if (requirements.length === 0) return null;
    return {source: 'nexus', requirements: markListed(requirements, index), notes: [], orderHints: []};
}

export async function modioPlan(item: SearchResultItem, index: ListedIndex): Promise<RequirementPlan | null> {
    const raw = item.rawData as { dependencies?: boolean } | undefined;
    if (!raw?.dependencies || !item.platformId) return null;
    const requirements = await modioDependencies(item.platformId);
    if (requirements.length === 0) return null;
    return {source: 'modio', requirements: markListed(requirements, index), notes: [], orderHints: []};
}

/** The author's text of a post: the post and the author's later messages in its thread */
export function authorText(detail: RepositoryModDetail): string {
    return [detail.content, ...(detail.authorPosts ?? [])].filter(Boolean).join("\n");
}

/**
 * Pak Hub post. With `findLinkedPosts`, Discord links are looked up among the repository's
 * posts (reads its post list once per session) so they can be added too.
 */
export async function pakhubPlan(item: SearchResultItem, detail: RepositoryModDetail, index: ListedIndex,
                                 findLinkedPosts: boolean): Promise<RequirementPlan | null> {
    const raw = item.rawData as RepositoryResultData | undefined;
    if (!raw) return null;
    const analysis = analyzePostText(authorText(detail));
    const ownSuffix = slugSuffix(raw.slug);
    let requirements: ResolvedRequirement[] = analysis.requirements
        // a link to the post's own message
        .filter(req => !(req.discordMessageId && messageIdSuffix(req.discordMessageId) === ownSuffix));

    const discordIds = requirements.filter(r => r.discordMessageId).map(r => r.discordMessageId!);
    if (findLinkedPosts && discordIds.length > 0) {
        try {
            const posts = await findPostsByMessageIds(raw.baseUrl, discordIds);
            requirements = await Promise.all(requirements.map(async req => {
                const post = req.discordMessageId ? posts.get(req.discordMessageId) : undefined;
                if (!post) return req;
                let name = post.name;
                try {
                    name = repositoryTitleFromFiles(await loadRepositoryDetail(raw.baseUrl, post.slug)) || post.name;
                } catch {
                    // the post's first line then
                }
                return {
                    ...req, name, addable: true, key: `repo:${post.slug}`,
                    repoPost: {repositoryId: raw.repositoryId, baseUrl: raw.baseUrl, slug: post.slug},
                };
            }));
        } catch (error) {
            console.warn('[BrowseRequirements] could not look up linked posts', error);
        }
    }
    if (requirements.length === 0 && analysis.orderHints.length === 0 && analysis.notes.length === 0) return null;
    return {
        source: 'pakhub',
        requirements: markListed(requirements, index),
        notes: analysis.notes,
        orderHints: resolveOrderHints(analysis.orderHints, index),
    };
}

/** What a result needs (for the card); Pak Hub posts need their detail */
export async function planFor(item: SearchResultItem, index: ListedIndex, detail?: RepositoryModDetail,
                              findLinkedPosts = false): Promise<RequirementPlan | null> {
    if (isRepositorySource(item.source)) return detail ? pakhubPlan(item, detail, index, findLinkedPosts) : null;
    if (item.source === SearchSource.NEXUSMODS) return nexusPlan(item, index);
    if (item.source === SearchSource.MODIO) return modioPlan(item, index);
    return null;
}

/** Worth asking before adding: something it needs (or the author suggests) isn't in your list, or load order / conflicts */
export function worthAsking(plan: RequirementPlan | null): boolean {
    if (!plan || plan.source === 'modio') return false;
    const missing = plan.requirements.some(r => !r.listed?.inActiveProfile && (r.likely || r.addable));
    return missing || plan.orderHints.length > 0 || plan.notes.some(n => /\b(not compatible|incompatible|conflict|disable)\b/i.test(n));
}
