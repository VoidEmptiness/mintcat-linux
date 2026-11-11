/**
 * The separate downloads on a Nexus mod page (Files tab): main files, optional files, updates.
 * Read from Nexus's public GraphQL API (`modFiles`), which also says which uploads are the same
 * file over time (`groupId`), so a picked file can be followed to its newer uploads.
 * Pure functions here; the requests are in NexusModsApi.
 */

export interface NexusFileInfo {
    fileId: number;
    name: string;
    version: string;
    /** MAIN, UPDATE, OPTIONAL, MISCELLANEOUS (shown on the page); OLD_VERSION, ARCHIVED, REMOVED (not) */
    category: string;
    /** The file the page's big Download button gives */
    primary: boolean;
    /** Upload time, seconds */
    date: number;
    sizeBytes: number;
    /** Plain text */
    description: string;
    /** Shared by the uploads of the same file over time (0: not known) */
    groupId: number;
}

/** What is remembered when a file other than the main download is picked */
export interface NexusFileChoiceRecord {
    fileId: number;
    groupId: number;
    name: string;
}

/** The categories listed on a mod's Files tab, in the page's order */
export const CURRENT_FILE_CATEGORIES = ['MAIN', 'UPDATE', 'OPTIONAL', 'MISCELLANEOUS'] as const;

/** The fields asked for each file */
export const NEXUS_FILE_FIELDS = 'fileId name version category primary date sizeInBytes description groupId';

/** "Line one<br />Line two &amp; more" -> "Line one\nLine two & more" */
export function plainDescription(html: string | null | undefined): string {
    return (html ?? '')
        .replace(/<br\s*\/?>/gi, '\n')
        .replace(/<\/(p|div|li)>/gi, '\n')
        .replace(/<[^>]*>/g, '')
        .replace(/&nbsp;/g, ' ')
        .replace(/&quot;/g, '"')
        .replace(/&#0?39;/g, "'")
        .replace(/&lt;/g, '<')
        .replace(/&gt;/g, '>')
        .replace(/&amp;/g, '&')
        .replace(/\n{3,}/g, '\n\n')
        .trim();
}

/** One file as the GraphQL API gives it */
export function toFileInfo(raw: any): NexusFileInfo | null {
    const fileId = Number(raw?.fileId);
    if (!Number.isFinite(fileId) || fileId <= 0) return null;
    return {
        fileId,
        name: String(raw?.name ?? '').trim() || `#${fileId}`,
        version: String(raw?.version ?? '').trim(),
        category: String(raw?.category ?? '').toUpperCase(),
        primary: Number(raw?.primary) === 1 || raw?.primary === true,
        date: Number(raw?.date) || 0,
        sizeBytes: Number(raw?.sizeInBytes) || 0,
        description: plainDescription(raw?.description),
        groupId: Number(raw?.groupId) || 0,
    };
}

function categoryRank(category: string): number {
    const index = (CURRENT_FILE_CATEGORIES as readonly string[]).indexOf(category);
    return index < 0 ? CURRENT_FILE_CATEGORIES.length : index;
}

function isCurrent(file: NexusFileInfo): boolean {
    return (CURRENT_FILE_CATEGORIES as readonly string[]).includes(file.category);
}

/**
 * The files the mod's page lists now, one per file (the newest upload when an older one is
 * still listed too): the main download first, then main, update, optional and other files,
 * newest first within each.
 */
export function currentFiles(files: readonly NexusFileInfo[] | undefined): NexusFileInfo[] {
    const newestPerGroup = new Map<string, NexusFileInfo>();
    for (const file of files ?? []) {
        if (!isCurrent(file)) continue;
        const key = file.groupId ? `g${file.groupId}` : `f${file.fileId}`;
        const seen = newestPerGroup.get(key);
        if (!seen || file.date > seen.date || (file.date === seen.date && file.fileId > seen.fileId)) {
            newestPerGroup.set(key, file);
        }
    }
    return [...newestPerGroup.values()].sort((a, b) =>
        (Number(b.primary) - Number(a.primary))
        || (categoryRank(a.category) - categoryRank(b.category))
        || (b.date - a.date)
        || (b.fileId - a.fileId));
}

/** More than one file to choose from (most mods have just one) */
export function hasSeparateFiles(files: readonly NexusFileInfo[] | undefined): boolean {
    return currentFiles(files).length > 1;
}

/**
 * The upload to use now for a picked file: its newest upload still listed, else a listed file
 * with the same name, else the picked upload itself (when it can still be downloaded at all).
 */
export function followChoice(files: readonly NexusFileInfo[] | undefined, choice: NexusFileChoiceRecord): NexusFileInfo | undefined {
    const all = files ?? [];
    const current = currentFiles(all);
    if (choice.groupId) {
        const sameGroup = current.find(f => f.groupId === choice.groupId);
        if (sameGroup) return sameGroup;
    }
    const name = choice.name.trim().toLowerCase();
    if (name) {
        const sameName = current.find(f => f.name.trim().toLowerCase() === name);
        if (sameName) return sameName;
    }
    return all.find(f => f.fileId === choice.fileId && f.category !== 'REMOVED');
}

/** The record to keep for a picked file: none when it is the page's main download */
export function choiceFor(files: readonly NexusFileInfo[] | undefined, fileId: number | undefined): NexusFileChoiceRecord | null {
    if (!fileId) return null;
    const file = (files ?? []).find(f => f.fileId === fileId);
    if (!file || file.primary) return null;
    return {fileId: file.fileId, groupId: file.groupId, name: file.name};
}

/** Whether `file` is the one in use, given what was picked (nothing picked: the main download) */
export function isChosenFile(file: NexusFileInfo, choice: NexusFileChoiceRecord | undefined): boolean {
    if (!choice) return file.primary;
    if (choice.groupId && file.groupId) return choice.groupId === file.groupId;
    return choice.fileId === file.fileId;
}
