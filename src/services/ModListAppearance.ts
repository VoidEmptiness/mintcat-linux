/**
 * How the mod list looks: folder colors (right-click a folder → Folder color, like separator
 * colors in Amethyst), a color for local mods linked to a repository post automatically, and
 * icons that show how a local mod is linked. Saved in the settings table.
 */
import {StorageAPI} from "@/storage";

const SETTINGS_KEY = "ui.modListAppearance";

/** Columns of the columns view whose width can be dragged */
export type ModListColumn = 'version' | 'game' | 'status' | 'tags';

export const COLUMN_DEFAULT_WIDTH: Record<ModListColumn, number> = {version: 88, game: 46, status: 96, tags: 150};
export const COLUMN_MIN_WIDTH = 30;
export const COLUMN_MAX_WIDTH = 600;

export function clampColumnWidth(width: number): number {
    return Math.round(Math.min(COLUMN_MAX_WIDTH, Math.max(COLUMN_MIN_WIDTH, width)));
}

function cleanWidths(value: unknown): Partial<Record<ModListColumn, number>> {
    const result: Partial<Record<ModListColumn, number>> = {};
    if (!value || typeof value !== 'object') return result;
    for (const key of Object.keys(COLUMN_DEFAULT_WIDTH) as ModListColumn[]) {
        const n = Number((value as Record<string, unknown>)[key]);
        if (Number.isFinite(n) && n > 0) result[key] = clampColumnWidth(n);
    }
    return result;
}

/** The width a column shows at (dragged or default) */
export function columnWidth(widths: Partial<Record<ModListColumn, number>>, column: ModListColumn): number {
    return widths[column] ?? COLUMN_DEFAULT_WIDTH[column];
}

/**
 * Column widths are CSS variables on the page (`--mod-col-version-w`…), so dragging a column
 * only changes a style and no row has to be drawn again.
 */
export function applyColumnWidths(widths: Partial<Record<ModListColumn, number>>): void {
    if (typeof document === 'undefined') return;
    for (const column of Object.keys(COLUMN_DEFAULT_WIDTH) as ModListColumn[]) {
        document.documentElement.style.setProperty(`--mod-col-${column}-w`, `${columnWidth(widths, column)}px`);
    }
}

export interface ModListLook {
    /** Color the names of local mods that were linked to a repository post automatically */
    autoLinkColorEnabled: boolean;
    autoLinkColor: string;
    /** Icons in front of local mods: linked automatically / downloaded from / linked by you / not linked */
    linkIcons: boolean;
    /** Columns view: a header over the list, tags and flags (note, endorsed/liked, tracked/subscribed) in aligned columns */
    columns: boolean;
    /** Widths you dragged the columns to (px); missing ones use their default */
    columnWidths: Partial<Record<ModListColumn, number>>;
    /** Folder key ("folder-12") → color */
    folderColors: Record<string, string>;
}

export const DEFAULT_AUTO_LINK_COLOR = "#36cfc9";

/** Swatches offered for folders and the auto-link color */
export const COLOR_PRESETS = [
    "#f5222d", "#fa541c", "#fa8c16", "#faad14", "#fadb14", "#a0d911",
    "#52c41a", "#13c2c2", "#36cfc9", "#1677ff", "#2f54eb", "#722ed1",
    "#eb2f96", "#8c8c8c",
];

let look: ModListLook = {
    autoLinkColorEnabled: false,
    autoLinkColor: DEFAULT_AUTO_LINK_COLOR,
    linkIcons: false,
    columns: true,
    columnWidths: {},
    folderColors: {},
};
let version = 0;
const listeners = new Set<() => void>();
let editingFolder: { key: string; name: string; keys?: string[]; names?: string[] } | null = null;

function notify() {
    version++;
    listeners.forEach(l => l());
}

async function persist() {
    try {
        const settings = await StorageAPI.getSettings();
        await settings.setValue(SETTINGS_KEY, JSON.stringify(look));
    } catch (e) {
        console.error("[ModListAppearance] could not save", e);
    }
}

function isColor(value: unknown): value is string {
    return typeof value === "string" && /^#[0-9a-f]{6}([0-9a-f]{2})?$/i.test(value);
}

/** Black or white text for a background color */
export function readableTextOn(color: string): string {
    const hex = color.replace("#", "").slice(0, 6);
    const [r, g, b] = [0, 2, 4].map(i => parseInt(hex.slice(i, i + 2), 16) / 255)
        .map(c => (c <= 0.03928 ? c / 12.92 : ((c + 0.055) / 1.055) ** 2.4));
    const luminance = 0.2126 * r + 0.7152 * g + 0.0722 * b;
    return luminance > 0.4 ? "#141414" : "#ffffff";
}

export const ModListAppearance = {
    subscribe(listener: () => void): () => void {
        listeners.add(listener);
        return () => listeners.delete(listener);
    },

    version(): number {
        return version;
    },

    async init(): Promise<void> {
        try {
            const settings = await StorageAPI.getSettings();
            const raw = await settings.getValue(SETTINGS_KEY);
            const parsed = raw ? JSON.parse(raw) : {};
            const folderColors: Record<string, string> = {};
            for (const [k, v] of Object.entries(parsed.folderColors ?? {})) {
                if (isColor(v)) folderColors[k] = v;
            }
            look = {
                autoLinkColorEnabled: parsed.autoLinkColorEnabled === true,
                autoLinkColor: isColor(parsed.autoLinkColor) ? parsed.autoLinkColor : DEFAULT_AUTO_LINK_COLOR,
                linkIcons: parsed.linkIcons === true,
                columns: parsed.columns !== false,
                columnWidths: cleanWidths(parsed.columnWidths),
                folderColors,
            };
            applyColumnWidths(look.columnWidths);
            notify();
        } catch (e) {
            console.warn("[ModListAppearance] could not load", e);
        }
    },

    /** Current settings; `_version` only makes callers re-read when they change */
    get(_version: number): ModListLook {
        return look;
    },

    async update(changes: Partial<Omit<ModListLook, "folderColors">>): Promise<void> {
        look = {...look, ...changes};
        if (changes.columnWidths) applyColumnWidths(look.columnWidths);
        notify();
        await persist();
    },

    /** While dragging: shown at once, saved by saveColumnWidth when the drag ends */
    previewColumnWidth(column: ModListColumn, width: number): void {
        applyColumnWidths({...look.columnWidths, [column]: clampColumnWidth(width)});
    },

    async saveColumnWidth(column: ModListColumn, width: number): Promise<void> {
        await ModListAppearance.update({columnWidths: {...look.columnWidths, [column]: clampColumnWidth(width)}});
    },

    /** Back to the default width (or all columns when none is given) */
    async resetColumnWidth(column?: ModListColumn): Promise<void> {
        const widths = {...look.columnWidths};
        if (column) delete widths[column];
        await ModListAppearance.update({columnWidths: column ? widths : {}});
    },

    folderColor(folderKey: string, _version: number): string | undefined {
        return look.folderColors[folderKey];
    },

    /** Color of the nearest colored folder in a path of folder keys (outermost first) */
    colorForPath(folderKeys: string[] | undefined, _version: number): string | undefined {
        for (let i = (folderKeys?.length ?? 0) - 1; i >= 0; i--) {
            const color = look.folderColors[folderKeys![i]];
            if (color) return color;
        }
        return undefined;
    },

    async setFolderColor(folderKey: string, color: string | null): Promise<void> {
        await ModListAppearance.setFolderColors([folderKey], color);
    },

    /** The same color (or none) for several folders, saved once */
    async setFolderColors(folderKeys: string[], color: string | null): Promise<void> {
        const folderColors = {...look.folderColors};
        for (const folderKey of folderKeys) {
            if (color && isColor(color)) folderColors[folderKey] = color;
            else delete folderColors[folderKey];
        }
        look = {...look, folderColors};
        notify();
        await persist();
    },

    /**
     * Colors saved by older builds under the folder id ("folder-12") move to the folder's name
     * path, using the ids of the list as it is now (ids change whenever the list is saved).
     */
    async migrateLegacyKeys(idToPath: Record<string, string>): Promise<void> {
        const folderColors = {...look.folderColors};
        let changed = false;
        for (const [key, color] of Object.entries(look.folderColors)) {
            if (!key.startsWith("folder-")) continue;
            const path = idToPath[key];
            if (!path) continue;
            if (!folderColors[path]) folderColors[path] = color;
            delete folderColors[key];
            changed = true;
        }
        if (!changed) return;
        look = {...look, folderColors};
        notify();
        await persist();
    },

    /** A folder was renamed: its color (and its subfolders' colors) follow the new name */
    async renameFolderKey(oldKey: string, newKey: string): Promise<void> {
        if (!oldKey || oldKey === newKey) return;
        const folderColors: Record<string, string> = {};
        let changed = false;
        for (const [key, color] of Object.entries(look.folderColors)) {
            if (key === oldKey || key.startsWith(oldKey + "/")) {
                folderColors[newKey + key.slice(oldKey.length)] = color;
                changed = true;
            } else {
                folderColors[key] ??= color;
            }
        }
        if (!changed) return;
        look = {...look, folderColors};
        notify();
        await persist();
    },

    /**
     * Forget colors of folders no profile has any more (`keep`: color keys still in use).
     * With `prefix`, only keys starting with it are looked at (others, e.g. colors saved by
     * older builds under "folder-12", are kept).
     */
    async keepOnlyFolderColors(keep: Set<string>, prefix?: string): Promise<number> {
        const folderColors: Record<string, string> = {};
        let removed = 0;
        for (const [key, color] of Object.entries(look.folderColors)) {
            if (keep.has(key) || (prefix && !key.startsWith(prefix))) folderColors[key] = color;
            else removed++;
        }
        if (removed === 0) return 0;
        look = {...look, folderColors};
        notify();
        await persist();
        return removed;
    },

    async clearFolderColors(): Promise<void> {
        look = {...look, folderColors: {}};
        notify();
        await persist();
    },

    /** Folder(s) whose color is being chosen (the Folder color dialog shows while set) */
    editing(_version: number): { key: string; name: string; keys?: string[]; names?: string[] } | null {
        return editingFolder;
    },

    /** Choose one color for several folders */
    openFolderColors(folders: { key: string; name: string }[]): void {
        if (folders.length === 0) return;
        editingFolder = {key: folders[0].key, name: folders[0].name, keys: folders.map(f => f.key), names: folders.map(f => f.name)};
        notify();
    },

    openFolderColor(key: string, name: string): void {
        editingFolder = {key, name};
        notify();
    },

    closeFolderColor(): void {
        editingFolder = null;
        notify();
    },
};
