/**
 * The search box filters' lookups in the app's stores: your notes, Nexus Mods / mod.io marks,
 * file conflicts and Pak Hub links, updates and posts (see services/ModFilters).
 */
import type {FilterProbe} from "@/services/ModFilters";
import {ModNotes} from "@/services/ModNotes";
import {ModSupport, nexusDomainOf} from "@/services/ModSupport";
import {ConflictService} from "@/services/ConflictService";
import {RepositoryUpdates} from "@/services/RepositoryUpdates";
import {PostFacts} from "@/services/PostFacts";
import {GameVersions} from "@/services/ListDisplay";
import {NEXUSMODS_PLATFORM} from "@/apis/nexusmods/types";
import {ModSourceType} from "@/models/mod/types";

export const liveFilterProbe: FilterProbe = {
    note: (modId) => ModNotes.get(modId),
    nexus: (mod) => {
        if (mod.sourceType !== NEXUSMODS_PLATFORM || !mod.platformId) return {endorsed: false, tracked: false};
        const state = ModSupport.nexusState(nexusDomainOf(mod.url), mod.platformId);
        return {endorsed: state.endorsement === 'Endorsed', tracked: state.tracked};
    },
    modio: (mod) => {
        if (mod.sourceType !== ModSourceType.Modio || !mod.platformId) return {rating: 0, subscribed: false};
        const state = ModSupport.modioState(mod.platformId);
        return {rating: state.rating, subscribed: state.subscribed};
    },
    conflict: (modId) => ConflictService.hasConflict(modId),
    pakHub: (mod) => !!RepositoryUpdates.linkForModSync(mod),
    pakHubUpdate: (modId) => RepositoryUpdates.updateState(modId)?.kind === 'newer',
    postWho: (mod) => {
        const link = RepositoryUpdates.linkForModSync(mod);
        return link ? PostFacts.peek({repoId: link.repoId, slug: link.slug})?.who : undefined;
    },
    latestGameVersion: () => GameVersions.latest(),
};

/** Changes whenever one of those stores does (part of the list's rebuild check while filtering) */
export function filterStoresStamp(): string {
    return [ModNotes.version(), ModSupport.version(), ConflictService.version(), RepositoryUpdates.version(),
        PostFacts.version(), GameVersions.version()].join(".");
}
