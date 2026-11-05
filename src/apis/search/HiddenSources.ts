/**
 * Built-in Browse Mods sources (mod.io, ModCat, Nexus Mods) the user removed from the source
 * list. Only the list changes: mods already added from them keep working and updating, and the
 * repository manager can add them back.
 */
import {StorageAPI} from '@/storage';
import {SearchSource} from './types';

const SETTINGS_KEY = 'browseHiddenSources';

export const BUILT_IN_SOURCES: SearchSource[] = [SearchSource.MODIO, SearchSource.MODCAT, SearchSource.NEXUSMODS];

export const BUILT_IN_SOURCE_NAMES: Record<string, string> = {
    [SearchSource.MODIO]: 'mod.io',
    [SearchSource.MODCAT]: 'ModCat',
    [SearchSource.NEXUSMODS]: 'Nexus Mods',
};

let cache: Set<string> | null = null;

async function save(hidden: Set<string>): Promise<void> {
    const settings = await StorageAPI.getSettings();
    await settings.setValue(SETTINGS_KEY, JSON.stringify([...hidden]));
    cache = hidden;
}

export const HiddenSources = {
    isBuiltIn(source: string): boolean {
        return (BUILT_IN_SOURCES as string[]).includes(source);
    },

    async list(): Promise<Set<string>> {
        if (cache) return cache;
        try {
            const raw = await (await StorageAPI.getSettings()).getValue(SETTINGS_KEY);
            const parsed = raw ? JSON.parse(raw) : [];
            cache = new Set(Array.isArray(parsed) ? parsed.filter((s: unknown) => typeof s === 'string') : []);
        } catch {
            cache = new Set();
        }
        return cache;
    },

    async hide(source: string): Promise<void> {
        if (!HiddenSources.isBuiltIn(source)) return;
        const hidden = new Set(await HiddenSources.list());
        hidden.add(source);
        await save(hidden);
    },

    async show(source: string): Promise<void> {
        const hidden = new Set(await HiddenSources.list());
        if (hidden.delete(source)) await save(hidden);
    },
};
