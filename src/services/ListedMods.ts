/**
 * Which mods from mod.io, Nexus Mods, ModCat and Pak Hub-style repositories are already in
 * your lists, so Browse Mods can mark them ("In your list · Folder", "In profile X").
 */
import {StorageAPI} from "@/storage";
import {foldersInTreeOrder} from "@/services/DialogProfileService";
import {ModSourceType} from "@/models/mod/types";
import {NEXUSMODS_DRG_DOMAIN, NEXUSMODS_PLATFORM, NEXUSMODS_ROGUE_CORE_DOMAIN} from "@/apis/nexusmods/types";
import {fileIdOfDownload} from "@/apis/nexusmods/files";
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
    /** A Nexus mod's file that has an entry of its own ("<modId>-<fileId>") */
    | { source: 'nexusFile'; id: string }
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

    // Nexus mods are told apart by their page's game ("deeprockgalacticroguecore"): mods added
    // before build 35 were all saved as Deep Rock Galactic ones
    const activeGame = await (await StorageAPI.getGames()).getGameById(active.gameId).catch(() => null);
    const nexusDomain = activeGame?.name === 'rc' ? NEXUSMODS_ROGUE_CORE_DOMAIN : NEXUSMODS_DRG_DOMAIN;

    const activeModNames: { modId: number; name: string }[] = [];
    const modsApi = await StorageAPI.getMods();
    const mods = await modsApi.getAllMods();
    // the files listed Nexus mods downloaded, in one read
    const nexusListed = mods.filter(m => m.modId != null && m.sourceType === NEXUSMODS_PLATFORM && (inActive.has(m.modId) || others.has(m.modId)));
    const downloads = new Map<number, string>();
    if (nexusListed.length > 0) {
        try {
            for (const full of await modsApi.getBatchCompleteModDataOptimized(nexusListed.map(m => m.modId!))) {
                if (full.modId != null && full.download?.cachePath) downloads.set(full.modId, full.download.cachePath);
            }
        } catch (error) {
            console.warn('[ListedMods] downloads not readable', error);
        }
    }
    for (const mod of mods) {
        if (mod.modId == null) continue;
        const state = stateOf(mod.modId);
        if (!state) continue;
        if (state.inActiveProfile) activeModNames.push({modId: mod.modId, name: mod.displayName || mod.originalName || mod.nameId});
        if (mod.sourceType === NEXUSMODS_PLATFORM) {
            const page = nexusPage(mod.url);
            if (!page || page.domain !== nexusDomain) continue;
            if (page.fileId) put({source: 'nexusFile', id: `${page.modId}-${page.fileId}`}, state);
            else {
                put({source: 'nexus', id: page.modId}, state);
                // the file the mod's entry downloaded (marked on Browse cards)
                const downloaded = fileIdOfDownload(downloads.get(mod.modId), page.domain, page.modId);
                if (downloaded) put({source: 'nexusFile', id: `${page.modId}-${downloaded}`}, state);
            }
            continue;
        }
        if (mod.gameId !== active.gameId && mod.sourceType !== ModSourceType.Local) continue;
        if (mod.sourceType === ModSourceType.Modio && mod.platformId) put({source: 'modio', id: mod.platformId}, state);
        if (mod.sourceType === ModSourceType.Modio && mod.nameId) put({source: 'modioSlug', id: mod.nameId}, state);
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

/** A Nexus mod page link: its game, mod and (for an entry of one file) file */
function nexusPage(url: string | undefined): { domain: string; modId: number; fileId?: number } | undefined {
    const m = /nexusmods\.com\/(?:games\/)?([^/?#]+)\/mods\/(\d+)/i.exec(url ?? '');
    if (!m) return undefined;
    const fileId = Number(/[?&]file_id=(\d+)/.exec(url ?? '')?.[1]) || undefined;
    return {domain: m[1].toLowerCase(), modId: Number(m[2]), fileId};
}
