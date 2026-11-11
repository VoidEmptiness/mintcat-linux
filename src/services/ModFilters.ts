/**
 * The mod list's search box filters.
 *
 * A filter is one string in TreeViewConverter.filterList: either a choice picked from the box's
 * list ("source:Modio", "tag:QoL", "attn:update"…) or a word typed into it. Choices from one
 * group widen the result (Local or mod.io); different groups and typed words narrow it
 * (mod.io and On and "unified"). A typed word is looked for in the name, the mod.io name id,
 * the tags, the mod.io status and your note.
 *
 * The box only offers choices that find something in the profile, with how many mods each
 * finds. Facts kept outside a mod's own record (your notes, Nexus Mods / mod.io marks,
 * conflicts, Pak Hub links) come from a FilterProbe, so this file holds no stores itself.
 */
import type {CompleteModData} from "@/storage/dao/ModDAO";
import {compareGameVersions, newestGameVersion} from "@/services/ListDisplay";
import {TimeUtils} from "@/utils/TimeUtils";

/** One mod of the profile as the filters see it */
export interface FilterEntry {
    mod: CompleteModData;
    enabled: boolean;
    /** The version picked for this profile ("" = always the newest) */
    usedVersion?: string;
}

/** Lookups in the app's stores (the mod list passes the live ones; tests pass fakes) */
export interface FilterProbe {
    /** Your note on the mod ("" = none) */
    note(modId: number): string;
    nexus(mod: CompleteModData): { endorsed: boolean; tracked: boolean };
    /** rating: 1 liked, -1 disliked, 0 neither */
    modio(mod: CompleteModData): { rating: number; subscribed: boolean };
    conflict(modId: number): boolean;
    /** Linked to a Pak Hub (repository) post */
    pakHub(mod: CompleteModData): boolean;
    /** Its Pak Hub post has a newer upload than the one you have */
    pakHubUpdate(modId: number): boolean;
    /** The newest game version among your mod.io mods */
    latestGameVersion(): string | undefined;
}

export const NO_PROBE: FilterProbe = {
    note: () => "",
    nexus: () => ({endorsed: false, tracked: false}),
    modio: () => ({rating: 0, subscribed: false}),
    conflict: () => false,
    pakHub: () => false,
    pakHubUpdate: () => false,
    latestGameVersion: () => undefined,
};

const ONLINE_SOURCES = new Set(["Modio", "modcat", "nexusmods"]);
export const TAG_PREFIX = "tag:";
/** mod.io's mark that everyone in the lobby needs the mod: a choice of its own, not a tag */
const REQUIRED_BY_ALL = "RequiredByAll";

/** Stored version lists are arrays, but older records may hold the JSON text */
export function versionList(value: unknown): string[] {
    if (Array.isArray(value)) return value.map(String);
    if (typeof value === "string" && value.trim().startsWith("[")) {
        try {
            const parsed = JSON.parse(value);
            return Array.isArray(parsed) ? parsed.map(String) : [];
        } catch {
            return [];
        }
    }
    return [];
}

function hasTag(mod: CompleteModData, tag: string): boolean {
    const want = tag.toLocaleLowerCase();
    return (mod.tags ?? []).some(t => String(t).toLocaleLowerCase() === want);
}

/** A newer version online (and you didn't pick a version), or a newer upload in its Pak Hub post */
function hasUpdate(e: FilterEntry, probe: FilterProbe): boolean {
    const mod = e.mod;
    if (ONLINE_SOURCES.has(mod.sourceType)) {
        const progress = mod.download?.downloadProgress || 100;
        if (progress === 100 && !e.usedVersion
            && TimeUtils.hasUpdate(mod.status?.onlineUpdateDate || 0, mod.status?.lastUpdateDate || 0)) {
            return true;
        }
    }
    return mod.modId != null && probe.pakHubUpdate(mod.modId);
}

/** Tagged on mod.io for an older game version than the newest among your mod.io mods */
function olderGameVersion(e: FilterEntry, probe: FilterProbe): boolean {
    if (e.mod.sourceType !== "Modio") return false;
    const game = newestGameVersion(versionList(e.mod.version?.availableVersions));
    const latest = probe.latestGameVersion();
    return !!game && !!latest && compareGameVersions(game, latest) < 0;
}

/**
 * mod.io's review status. Only mod.io has one: older Nexus Mods / ModCat records can hold an
 * "Approved" they never had (the Status column doesn't show it for them either).
 */
function modioApproval(mod: CompleteModData): string {
    return mod.sourceType === "Modio" ? mod.approvalStatus || "" : "";
}

export interface FilterChoice {
    value: string;
    /** i18n key of its label */
    labelKey: string;
    /** i18n key of what it finds, shown when you point at it */
    tipKey?: string;
    /** Other words that find it when typed into the box */
    also?: string;
    test(e: FilterEntry, probe: FilterProbe): boolean;
}

export interface FilterGroup {
    key: string;
    labelKey: string;
    choices: FilterChoice[];
    /** Offered even when a choice finds nothing */
    always?: boolean;
    /** Listed on its own, without a group title (a single choice) */
    flat?: boolean;
}

/**
 * The fixed groups, in the order the box lists them, following the columns (Status, then Tags).
 * The tags of the mods themselves come right after Required by All.
 */
export const FILTER_GROUPS: FilterGroup[] = [
    {
        key: "source", labelKey: "Source", choices: [
            {value: "source:Local", labelKey: "Local", tipKey: "filter.tip.local", test: e => e.mod.sourceType === "Local"},
            {value: "source:Modio", labelKey: "Modio", also: "modio mod.io", test: e => e.mod.sourceType === "Modio"},
            {value: "source:nexusmods", labelKey: "Nexus Mods", also: "nexus", test: e => e.mod.sourceType === "nexusmods"},
            {value: "source:modcat", labelKey: "ModCat", test: e => e.mod.sourceType === "modcat"},
            {
                value: "source:pakhub", labelKey: "filter.pakHub", tipKey: "filter.tip.pakHub", also: "pak hub repository",
                test: (e, p) => p.pakHub(e.mod),
            },
        ],
    },
    {
        key: "enabled", labelKey: "filter.group.state", always: true, choices: [
            {value: "enabled:true", labelKey: "filter.enabled", also: "on", test: e => e.enabled},
            {value: "enabled:false", labelKey: "filter.disabled", also: "off", test: e => !e.enabled},
        ],
    },
    {
        key: "approval", labelKey: "filter.group.status", choices: [
            // bare values: what the box used before, and what a typed "verified" means too
            {value: "Verified", labelKey: "Verified", tipKey: "filter.tip.verified", also: "mod.io", test: e => modioApproval(e.mod) === "Verified"},
            {value: "Approved", labelKey: "Approved", tipKey: "filter.tip.approved", also: "mod.io", test: e => modioApproval(e.mod) === "Approved"},
            {value: "Sandbox", labelKey: "Sandbox", tipKey: "filter.tip.sandbox", also: "mod.io", test: e => modioApproval(e.mod) === "Sandbox"},
        ],
    },
    {
        key: "required", labelKey: "RequiredByAll", flat: true, choices: [
            {
                value: "required:all", labelKey: "RequiredByAll", tipKey: "filter.tip.required", also: "RequiredByAll required everyone",
                test: e => hasTag(e.mod, REQUIRED_BY_ALL),
            },
        ],
    },
    {
        key: "update", labelKey: "filter.update", flat: true, choices: [
            {value: "attn:update", labelKey: "filter.update", tipKey: "filter.tip.update", also: "update newer", test: hasUpdate},
        ],
    },
    {
        key: "game", labelKey: "filter.oldGame", flat: true, choices: [
            {value: "attn:oldgame", labelKey: "filter.oldGame", tipKey: "filter.tip.oldGame", also: "outdated game version", test: olderGameVersion},
        ],
    },
    {
        key: "problems", labelKey: "filter.group.problems", choices: [
            {
                value: "attn:conflict", labelKey: "filter.conflict", tipKey: "filter.tip.conflict", also: "conflict",
                test: (e, p) => e.mod.modId != null && p.conflict(e.mod.modId),
            },
            {value: "attn:missing", labelKey: "filter.missing", tipKey: "filter.tip.missing", also: "missing not found", test: e => e.mod.status?.isLocalNotFound === true},
            {
                value: "attn:gone", labelKey: "filter.gone", tipKey: "filter.tip.gone", also: "removed unavailable",
                test: e => ONLINE_SOURCES.has(e.mod.sourceType) && e.mod.status?.isOnlineAvailable === false,
            },
        ],
    },
    {
        key: "marks", labelKey: "filter.group.marks", choices: [
            {
                value: "mark:note", labelKey: "filter.hasNote", tipKey: "filter.tip.note", also: "note",
                test: (e, p) => e.mod.modId != null && !!p.note(e.mod.modId).trim(),
            },
            {
                value: "mark:liked", labelKey: "filter.liked", tipKey: "filter.tip.liked", also: "endorsed liked",
                test: (e, p) => p.nexus(e.mod).endorsed || p.modio(e.mod).rating === 1,
            },
            {value: "mark:disliked", labelKey: "filter.disliked", tipKey: "filter.tip.disliked", also: "disliked", test: (e, p) => p.modio(e.mod).rating === -1},
            {
                value: "mark:followed", labelKey: "filter.followed", tipKey: "filter.tip.followed", also: "tracked subscribed",
                test: (e, p) => p.nexus(e.mod).tracked || p.modio(e.mod).subscribed,
            },
        ],
    },
];

/** Where the tags go among the groups: right after this one */
export const TAGS_AFTER_GROUP = "required";

const CHOICES = new Map<string, { group: string; choice: FilterChoice }>();
for (const group of FILTER_GROUPS) {
    for (const choice of group.choices) CHOICES.set(choice.value, {group: group.key, choice});
}

/** The fixed choice behind a value, if it is one */
export function filterChoice(value: string): FilterChoice | undefined {
    return CHOICES.get(value)?.choice;
}

/** The group a filter value belongs to, or undefined for a typed word */
export function filterGroupOf(value: string): string | undefined {
    if (value.startsWith(TAG_PREFIX) && value.length > TAG_PREFIX.length) return "tags";
    return CHOICES.get(value)?.group;
}

/** Whether one filter value (a choice) finds this mod */
function choiceMatches(value: string, e: FilterEntry, probe: FilterProbe): boolean {
    if (value.startsWith(TAG_PREFIX)) return hasTag(e.mod, value.slice(TAG_PREFIX.length));
    return CHOICES.get(value)?.choice.test(e, probe) ?? false;
}

/** The active filters ("All" and blanks are none) */
export function activeFilters(filters: readonly (string | undefined)[] | undefined): string[] {
    return (filters ?? []).filter((f): f is string => !!f && !!f.trim() && f !== "All");
}

/** Whether a mod is shown with these filters */
export function matchesFilters(filters: readonly (string | undefined)[] | undefined, e: FilterEntry, probe: FilterProbe = NO_PROBE): boolean {
    const active = activeFilters(filters);
    if (active.length === 0) return true;

    const groups = new Map<string, string[]>();
    const words: string[] = [];
    for (const value of active) {
        const group = filterGroupOf(value);
        if (group) groups.set(group, [...(groups.get(group) ?? []), value]);
        else words.push(value);
    }
    // within a group any choice will do; every group has to find the mod
    for (const values of groups.values()) {
        if (!values.some(v => choiceMatches(v, e, probe))) return false;
    }
    if (words.length === 0) return true;

    const mod = e.mod;
    const name = (mod.displayName || mod.originalName || "").toLocaleLowerCase();
    const nameId = (mod.nameId || "").toLocaleLowerCase();
    const tags = (mod.tags || []).map(tag => String(tag).toLocaleLowerCase());
    const approval = modioApproval(mod).toLocaleLowerCase();
    let note: string | undefined;
    return words.every(word => {
        const w = word.trim().toLocaleLowerCase();
        if (!w || name.includes(w) || nameId.includes(w) || tags.includes(w) || approval === w) return true;
        note ??= mod.modId != null ? probe.note(mod.modId).toLocaleLowerCase() : "";
        return note.includes(w);
    });
}

/** The tags of these mods (first spelling seen), with how many mods have each, by name */
export function tagCounts(entries: readonly FilterEntry[]): { tag: string; count: number }[] {
    const byKey = new Map<string, { tag: string; count: number }>();
    for (const e of entries) {
        const seen = new Set<string>();
        for (const raw of e.mod.tags ?? []) {
            const tag = String(raw).trim();
            const key = tag.toLocaleLowerCase();
            if (!tag || tag === REQUIRED_BY_ALL || seen.has(key)) continue;
            seen.add(key);
            const item = byKey.get(key);
            if (item) item.count++;
            else byKey.set(key, {tag, count: 1});
        }
    }
    return [...byKey.values()].sort((a, b) => a.tag.localeCompare(b.tag, undefined, {sensitivity: 'base'}));
}

/** How many of these mods each fixed choice finds (value → count) */
export function choiceCounts(entries: readonly FilterEntry[], probe: FilterProbe = NO_PROBE): Map<string, number> {
    const counts = new Map<string, number>();
    for (const group of FILTER_GROUPS) {
        for (const choice of group.choices) {
            let n = 0;
            for (const e of entries) {
                if (choice.test(e, probe)) n++;
            }
            counts.set(choice.value, n);
        }
    }
    return counts;
}
