/**
 * Which mods from mod.io, Nexus Mods, ModCat and Pak Hub-style repositories are already in
 * your lists, so Browse Mods can mark them ("In your list · Folder", "In profile X").
 */
import {StorageAPI} from "@/storage";
import {foldersInTreeOrder} from "@/services/DialogProfileService";
import {ModSourceType} from "@/models/mod/types";
import {NEXUSMODS_PLATFORM} from "@/apis/nexusmods/types";
import {MODCAT_PLATFORM} from "@/apis/modcat";

export interface ListedState {
    /** In the active profile */
    inActiveProfile: boolean;
    /** Its folder there (path), when it's in one */
    folder?: string;
    /** Other profiles of the same game that have it */
    otherProfiles: string[];
    modId: number;
}

export type ListedKey =
    | { source: 'modio'; id: number }
    /** mod.io mods by their link name ("custom-vanity-framework"), for links in post texts */
    | { source: 'modioSlug'; id: string }
    | { source: 'nexus'; id: number }
    | { source: 'modcat'; id: string }
    | { source: 'repo'; repoId: string; slug: string };

function keyText(key: ListedKey): string {
    switch (key.source) {
        case 'repo':
            return `repo:${key.repoId}:${key.slug}`;
        default:
            return `${key.source}:${String(key.id).toLowerCase()}`;
    }
}

export class ListedIndex {
    constructor(private readonly states: Map<string, ListedState>,
                /** Names of the active profile's mods (for matching names in post texts) */
                public readonly activeModNames: { modId: number; name: string }[]) {
    }

    get(key: ListedKey | undefined): ListedState | undefined {
        return key ? this.states.get(keyText(key)) : undefined;
    }

    static empty(): ListedIndex {
        return new ListedIndex(new Map(), []);
    }
}

export async function buildListedIndex(): Promise<ListedIndex> {
    const profiles = await StorageAPI.getProfiles();
    const active = await profiles.getActiveProfile();
    if (!active?.id) return ListedIndex.empty();
    const sameGame = (await profiles.getAllProfiles()).filter(p => p.id != null && p.gameId === active.gameId);

    const folderNames = new Map(foldersInTreeOrder(await profiles.getProfileFolders(active.id)).map(f => [f.id, f.label]));
    const inActive = new Map<number, string | undefined>();
    const others = new Map<number, string[]>();
    for (const profile of sameGame) {
        for (const m of await profiles.getProfileMods(profile.id!)) {
            if (profile.id === active.id) {
                inActive.set(m.modId, m.parentFolderId ? folderNames.get(m.parentFolderId) : undefined);
            } else {
                others.set(m.modId, [...(others.get(m.modId) ?? []), profile.displayName || profile.name]);
            }
        }
    }

    const states = new Map<string, ListedState>();
    const stateOf = (modId: number): ListedState | undefined => {
        const listedHere = inActive.has(modId);
        const elsewhere = others.get(modId) ?? [];
        if (!listedHere && elsewhere.length === 0) return undefined;
        return {inActiveProfile: listedHere, folder: inActive.get(modId), otherProfiles: [...new Set(elsewhere)], modId};
    };
    const put = (key: ListedKey, state: ListedState | undefined) => {
        if (!state) return;
        const text = keyText(key);
        const current = states.get(text);
        // the same mod recorded twice: the record in the active profile counts
        if (!current || (!current.inActiveProfile && state.inActiveProfile)) states.set(text, state);
    };

    const activeModNames: { modId: number; name: string }[] = [];
    const mods = await (await StorageAPI.getMods()).getAllMods();
    for (const mod of mods) {
        if (mod.modId == null) continue;
        const state = stateOf(mod.modId);
        if (!state) continue;
        if (state.inActiveProfile) activeModNames.push({modId: mod.modId, name: mod.displayName || mod.originalName || mod.nameId});
        if (mod.gameId !== active.gameId && mod.sourceType !== ModSourceType.Local) continue;
        if (mod.sourceType === ModSourceType.Modio && mod.platformId) put({source: 'modio', id: mod.platformId}, state);
        if (mod.sourceType === ModSourceType.Modio && mod.nameId) put({source: 'modioSlug', id: mod.nameId}, state);
        else if (mod.sourceType === NEXUSMODS_PLATFORM && mod.platformId) put({source: 'nexus', id: mod.platformId}, state);
        else if (mod.sourceType === MODCAT_PLATFORM && mod.nameId) put({source: 'modcat', id: mod.nameId}, state);
    }
    try {
        const {RepositoryUpdates} = await import("@/services/RepositoryUpdates");
        for (const [modId, link] of await RepositoryUpdates.linksForMods(mods)) {
            put({source: 'repo', repoId: link.repoId, slug: link.slug}, stateOf(modId));
        }
    } catch (error) {
        console.warn('[ListedMods] repository links not readable', error);
    }
    return new ListedIndex(states, activeModNames);
}
