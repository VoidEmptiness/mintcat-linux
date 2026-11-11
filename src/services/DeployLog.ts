/**
 * What was last deployed (installed) into each game, so the Log can say what a deploy added,
 * removed or reordered, and the toolbar can say when the game last got the list.
 * Kept in the settings table as deploy.last.<game>.
 */
import {StorageAPI} from "@/storage";

export interface DeployedMod {
    id: number;
    name: string;
}

export interface DeployRecord {
    /** ms since 1970 */
    time: number;
    /** Name of the profile when it was deployed (for the Log) */
    profile: string;
    /** Id of that profile (names can change); missing in records from older versions */
    profileId?: number;
    /** That profile has since been deleted (its name is no longer kept) */
    profileDeleted?: boolean;
    /** In install order (none after an uninstall) */
    mods: DeployedMod[];
    /** The mods were uninstalled from the game at `time` */
    uninstalled?: boolean;
}

export interface DeployDiff {
    added: string[];
    removed: string[];
    /** Mods in both whose order changed */
    reordered: boolean;
}

/** What changed between two deploys (by mod id; names from the newer one) */
export function diffDeployed(before: DeployedMod[], after: DeployedMod[]): DeployDiff {
    const beforeIds = new Set(before.map(m => m.id));
    const afterIds = new Set(after.map(m => m.id));
    const added = after.filter(m => !beforeIds.has(m.id)).map(m => m.name);
    const removed = before.filter(m => !afterIds.has(m.id)).map(m => m.name);
    const keptBefore = before.filter(m => afterIds.has(m.id)).map(m => m.id);
    const keptAfter = after.filter(m => beforeIds.has(m.id)).map(m => m.id);
    const reordered = keptBefore.some((id, i) => keptAfter[i] !== id);
    return {added, removed, reordered};
}

/** "a, b, c and 4 more" */
export function shortList(names: string[], max = 10, more = (n: number) => `+${n}`): string {
    if (names.length <= max) return names.join(", ");
    return `${names.slice(0, max).join(", ")} ${more(names.length - max)}`;
}

function key(game: string): string {
    return `deploy.last.${(game || "drg").toLowerCase()}`;
}

export const DeployLog = {
    async last(game: string): Promise<DeployRecord | null> {
        try {
            const raw = await (await StorageAPI.getSettings()).getValue(key(game));
            if (!raw) return null;
            const parsed = JSON.parse(raw);
            return parsed && Array.isArray(parsed.mods) ? parsed as DeployRecord : null;
        } catch {
            return null;
        }
    },

    async record(game: string, record: DeployRecord): Promise<void> {
        await (await StorageAPI.getSettings()).setValue(key(game), JSON.stringify(record));
    },

    /**
     * A profile was deleted: the record of what's in the game stays (the mods are still
     * there until the next deploy or uninstall), but no longer names that profile
     */
    async forgetProfile(profileId: number, name: string, game?: string): Promise<void> {
        const settings = await StorageAPI.getSettings();
        for (const setting of await settings.namesWithPrefix("deploy.last.")) {
            try {
                const record = JSON.parse(await settings.getValue(setting)) as DeployRecord;
                // records from older builds have only the name: same name in the same game
                const matches = record.profileId !== undefined
                    ? record.profileId === profileId
                    : record.profile === name && (game === undefined || setting === key(game));
                if (!matches || record.uninstalled) continue;
                await settings.setValue(setting, JSON.stringify({...record, profile: "", profileId: undefined, profileDeleted: true}));
            } catch {
                // unreadable record: nothing to forget
            }
        }
    },

    /** The mods were taken out of the game (remembered, so the toolbar can say when) */
    async markUninstalled(game: string): Promise<void> {
        await DeployLog.record(game, {time: Date.now(), profile: "", mods: [], uninstalled: true});
    },
};
