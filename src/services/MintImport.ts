/**
 * Import a mod list from mint (drg-mod-integration) — its mod_data.json — into the
 * active MintCat profile: each mint group goes into the folder chosen for it (by default
 * the existing folder with the same name, subfolders included), in mint's order and with
 * mint's enabled/disabled state. Mods already in the list are left as they are.
 *
 * Unlike the full config migration, this never removes or replaces anything.
 */
import {exists, readDir} from "@tauri-apps/plugin-fs";
import {t} from "i18next";
import {StorageAPI} from "@/storage";
import {HomeService} from "@/services/HomeService";
import {ModioApi} from "@/apis/modio";
import {logActivity} from "@/services/ActivityLog";
import {fileNameOf, parentDir} from "@/services/LocalModRelocation";
import type {ProfileFolderData} from "@/storage/dao/ProfileDAO";

export interface MintMod {
    url: string;
    enabled: boolean;
}

export interface MintGroup {
    name: string;
    enabled: boolean;
    mods: MintMod[];
}

export interface MintProfile {
    name: string;
    groups: MintGroup[];
}

export interface MintModData {
    activeProfile: string;
    profiles: MintProfile[];
}

/** Read mint's mod_data.json (format 0.2.x) */
export function parseMintModData(text: string): MintModData {
    const data = JSON.parse(text);
    if (!data || typeof data !== "object" || typeof data.profiles !== "object" || data.profiles === null) {
        throw new Error("not-mint");
    }
    const profiles: MintProfile[] = [];
    for (const [name, raw] of Object.entries<any>(data.profiles)) {
        const entries: any[] = Array.isArray(raw?.mods) ? raw.mods : [];
        const groupsObj: Record<string, any> = raw?.groups && typeof raw.groups === "object" ? raw.groups : {};
        const toMod = (m: any): MintMod | null =>
            typeof m?.spec?.url === "string" && m.spec.url.trim()
                ? {url: m.spec.url.trim(), enabled: m.enabled !== false}
                : null;

        // Group order (and group on/off) comes from the profile's list; mods may also sit
        // directly in that list without a group
        const order: { name: string; enabled: boolean }[] = [];
        const ungrouped: MintMod[] = [];
        for (const entry of entries) {
            if (typeof entry?.group_name === "string") {
                order.push({name: entry.group_name, enabled: entry.enabled !== false});
            } else {
                const mod = toMod(entry);
                if (mod) ungrouped.push(mod);
            }
        }
        for (const groupName of Object.keys(groupsObj)) {
            if (!order.some(o => o.name === groupName)) order.push({name: groupName, enabled: true});
        }
        const groups: MintGroup[] = order.map(o => ({
            name: o.name,
            enabled: o.enabled,
            mods: (Array.isArray(groupsObj[o.name]?.mods) ? groupsObj[o.name].mods : [])
                .map(toMod).filter((m: MintMod | null): m is MintMod => m !== null),
        }));
        if (ungrouped.length > 0) groups.unshift({name: "", enabled: true, mods: ungrouped});
        profiles.push({name, groups});
    }
    if (profiles.length === 0) throw new Error("not-mint");
    const active = typeof data.active_profile === "string" && profiles.some(p => p.name === data.active_profile)
        ? data.active_profile
        : profiles[0].name;
    return {activeProfile: active, profiles};
}

/** "Cosmetics" ≈ "cosmetic", "Custom Icons" ≈ "customicon" */
export function normalizeGroupName(name: string): string {
    return name.toLowerCase().replace(/[^a-z0-9]+/g, "").replace(/s$/, "");
}

export interface FolderChoice {
    id: number;
    name: string;
    /** "Cosmetic / Custom Icons" */
    path: string;
    parentId: number | null;
}

export function describeFolders(folders: ProfileFolderData[]): FolderChoice[] {
    const byId = new Map(folders.filter(f => f.id != null).map(f => [f.id!, f]));
    const pathOf = (f: ProfileFolderData): string => {
        const parts: string[] = [f.name];
        let parent = f.parentFolderId ? byId.get(f.parentFolderId) : undefined;
        let guard = 0;
        while (parent && guard++ < 20) {
            parts.unshift(parent.name);
            parent = parent.parentFolderId ? byId.get(parent.parentFolderId) : undefined;
        }
        return parts.join(" / ");
    };
    return [...byId.values()]
        .map(f => ({id: f.id!, name: f.name, path: pathOf(f), parentId: f.parentFolderId ?? null}))
        .sort((a, b) => a.path.localeCompare(b.path));
}

/** The existing folder a mint group should go into, if one has the same name */
export function matchFolder(groupName: string, folders: FolderChoice[]): FolderChoice | undefined {
    const key = normalizeGroupName(groupName);
    if (!key) return undefined;
    const matches = folders.filter(f => normalizeGroupName(f.name) === key);
    // Prefer an exact name, then the shallowest folder
    return matches.find(f => f.name === groupName)
        ?? matches.sort((a, b) => a.path.split(" / ").length - b.path.split(" / ").length)[0];
}

export interface GroupPlan {
    group: MintGroup;
    /** existing folder id, or null to create a new top-level folder named after the group */
    folderId: number | null;
}

export interface MintImportResult {
    added: number;
    alreadyInList: number;
    movedFiles: { from: string; to: string }[];
    missingFiles: string[];
    brokenLinks: string[];
    failed: { item: string; reason: string }[];
    stopped: boolean;
}

export type ImportProgress = (done: number, total: number, label: string) => void;

const MAX_RETRIES = 3;

function isRateLimited(reason: string): boolean {
    return /\b429\b|too many requests|rate limit/i.test(reason) || reason.includes(t("mod.io Too Many Requests"));
}

/** Stop after this many failures in a row with the same reason (e.g. logged out mid-way) */
const MAX_SAME_ERRORS = 5;

const sleep = (ms: number) => new Promise(resolve => setTimeout(resolve, ms));

/**
 * Files that moved: look for the same file name in the folder the file used to be in
 * (and its subfolders, a few levels deep).
 */
class FileFinder {
    private indexes = new Map<string, Promise<Map<string, string[]>>>();

    async find(missingPath: string): Promise<string | undefined> {
        const name = fileNameOf(missingPath).toLowerCase();
        let dir = parentDir(missingPath);
        // Start from the nearest folder that still exists
        for (let i = 0; i < 3 && dir && !(await exists(dir)); i++) dir = parentDir(dir);
        if (!dir || !(await exists(dir))) return undefined;
        const index = await this.index(dir);
        const hits = index.get(name) ?? [];
        return hits.length === 1 ? hits[0] : undefined;
    }

    private index(root: string): Promise<Map<string, string[]>> {
        let pending = this.indexes.get(root);
        if (!pending) {
            pending = this.build(root);
            this.indexes.set(root, pending);
        }
        return pending;
    }

    private async build(root: string): Promise<Map<string, string[]>> {
        const index = new Map<string, string[]>();
        let seen = 0;
        const walk = async (dir: string, depth: number) => {
            if (depth > 3 || seen > 5000) return;
            let entries;
            try {
                entries = await readDir(dir);
            } catch {
                return;
            }
            for (const entry of entries) {
                seen++;
                const full = `${dir}/${entry.name}`;
                if (entry.isDirectory) {
                    await walk(full, depth + 1);
                } else if (entry.isFile) {
                    const key = entry.name.toLowerCase();
                    index.set(key, [...(index.get(key) ?? []), full]);
                }
            }
        };
        await walk(root, 0);
        return index;
    }
}

/**
 * Add the planned groups' mods to the active profile. Runs one mod at a time so each
 * folder keeps mint's order.
 */
export async function runMintImport(
    plans: GroupPlan[],
    options: { keepEnabled: boolean },
    onProgress: ImportProgress,
    shouldStop: () => boolean,
): Promise<MintImportResult> {
    const result: MintImportResult = {
        added: 0, alreadyInList: 0, movedFiles: [], missingFiles: [], brokenLinks: [], failed: [], stopped: false,
    };
    const home = new HomeService();
    const modsApi = await StorageAPI.getMods();
    const profiles = await StorageAPI.getProfiles();
    const active = await profiles.getActiveProfile();
    if (!active?.id) throw new Error("no active profile");
    const finder = new FileFinder();

    // Make sure mod.io answers (login, network) before adding anything
    const firstLink = plans.flatMap(p => p.group.mods).find(m => ModioApi.parseModLinks(m.url));
    if (firstLink) {
        const probe = await ModioApi.lookupModLink(firstLink.url.replace(/#.*$/, ""));
        if (probe.status === "error") {
            throw new Error(t("mintImport.modioUnavailable", {reason: probe.message}));
        }
    }

    // Create the folders that don't exist yet (top level, after the existing ones)
    const folderIds = new Map<GroupPlan, number>();
    let existingFolders = await profiles.getProfileFolders(active.id);
    for (const plan of plans) {
        if (plan.folderId != null) {
            folderIds.set(plan, plan.folderId);
            continue;
        }
        const name = plan.group.name || "mint";
        const topLevel = existingFolders.filter(f => !f.parentFolderId);
        const created = await profiles.createFolder({
            profileId: active.id,
            name,
            parentFolderId: undefined,
            folderType: "custom",
            sortOrder: topLevel.reduce((max, f) => Math.max(max, f.sortOrder ?? 0), -1) + 1,
            isExpanded: true,
        });
        if (!created?.id) throw new Error(`could not create folder "${name}"`);
        existingFolders = [...existingFolders, created];
        folderIds.set(plan, created.id);
        await logActivity('info', t("mintImport.folderCreated", {name}), undefined, 'import');
    }

    const total = plans.reduce((n, p) => n + p.group.mods.length, 0);
    let done = 0;
    let lastError = "";
    let sameErrors = 0;
    const noteError = (reason: string): boolean => {
        sameErrors = reason === lastError ? sameErrors + 1 : 1;
        lastError = reason;
        return sameErrors >= MAX_SAME_ERRORS;
    };

    for (const plan of plans) {
        const folderId = folderIds.get(plan)!;
        for (const mod of plan.group.mods) {
            if (shouldStop()) {
                result.stopped = true;
                return result;
            }
            const wantEnabled = !options.keepEnabled || (plan.group.enabled && mod.enabled);
            const isLink = /^https?:\/\//i.test(mod.url);
            onProgress(done, total, isLink ? mod.url.replace(/^https?:\/\/(www\.)?/, "").replace(/#.*$/, "") : fileNameOf(mod.url));

            try {
                if (isLink) {
                    // mint pins a file with "#<id>"; MintCat follows the newest file
                    const link = mod.url.replace(/#.*$/, "");
                    let attempt = 0;
                    for (; ;) {
                        let error: string | undefined;
                        let status: string;
                        try {
                            const r = await home.addModFromUrl(link, folderId);
                            status = r.status;
                            error = r.error;
                        } catch (e) {
                            status = "error";
                            error = e instanceof Error ? e.message : String(e);
                        }
                        if (status === "error" && error && isRateLimited(error) && attempt < MAX_RETRIES) {
                            attempt++;
                            onProgress(done, total, t("mintImport.waiting"));
                            await sleep(20000 * attempt);
                            continue;
                        }
                        if (status === "added") {
                            result.added++;
                            if (!wantEnabled) {
                                const nameId = ModioApi.parseModLinks(link);
                                const added = nameId ? await modsApi.getModByNameId(nameId, "Modio") : null;
                                if (added?.modId != null) await profiles.setModEnabled(active.id, added.modId, false);
                            }
                            await logActivity('success', t("mintImport.added", {name: link}), plan.group.name, 'import');
                        } else if (status === "exists") {
                            result.alreadyInList++;
                        } else if (status === "error") {
                            result.failed.push({item: link, reason: error ?? ""});
                            await logActivity('error', t("mintImport.failed", {reason: error ?? ""}), link, 'import');
                            if (noteError(error ?? "")) {
                                result.stopped = true;
                                return result;
                            }
                        } else {
                            result.brokenLinks.push(link);
                            await logActivity('error', t("mintImport.brokenLink"), link, 'import');
                        }
                        break;
                    }
                } else {
                    let path = mod.url;
                    if (!(await exists(path))) {
                        const found = await finder.find(path);
                        if (!found) {
                            result.missingFiles.push(path);
                            await logActivity('error', t("mintImport.missingFile"), path, 'import');
                            done++;
                            continue;
                        }
                        result.movedFiles.push({from: path, to: found});
                        await logActivity('warning', t("mintImport.movedFile", {name: fileNameOf(found)}), found, 'import');
                        path = found;
                    }
                    const r = await home.addModFromPath(path, folderId);
                    if (r.status === "added") {
                        result.added++;
                        if (!wantEnabled) {
                            const added = await modsApi.getModByUrl(path);
                            if (added?.modId != null) await profiles.setModEnabled(active.id, added.modId, false);
                        }
                        await logActivity('success', t("mintImport.added", {name: fileNameOf(path)}), path, 'import');
                    } else if (r.status === "exists") {
                        result.alreadyInList++;
                    } else {
                        result.missingFiles.push(path);
                        await logActivity('error', t("mintImport.missingFile"), path, 'import');
                    }
                }
            } catch (e) {
                const reason = e instanceof Error ? e.message : String(e);
                result.failed.push({item: mod.url, reason});
                await logActivity('error', t("mintImport.failed", {reason}), mod.url, 'import');
            }
            done++;
        }
    }
    onProgress(total, total, "");
    return result;
}
