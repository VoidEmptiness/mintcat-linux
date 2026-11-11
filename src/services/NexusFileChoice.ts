/**
 * Which file of a Nexus mod you picked when it has several (e.g. a "No Mini-Icons" version next to
 * the main one). Only picks other than the page's main download are kept; the update check then
 * follows that file's newer uploads instead of the main download's.
 * Kept by Nexus mod ("deeprockgalactic:38") in one setting, so it is the same in every profile.
 */
import {StorageAPI} from "@/storage";
import type {NexusFileChoiceRecord} from "@/apis/nexusmods/files";

export const NEXUS_FILE_CHOICES_KEY = "nexus.chosenFiles";

let choices: Record<string, NexusFileChoiceRecord> = {};
let loaded: Promise<void> | null = null;
let version = 0;
const listeners = new Set<() => void>();

function keyOf(domain: string, modId: number): string {
    return `${domain.toLowerCase()}:${modId}`;
}

function isRecord(value: any): value is NexusFileChoiceRecord {
    return !!value && Number(value.fileId) > 0 && typeof value.name === "string";
}

function load(): Promise<void> {
    if (!loaded) {
        loaded = (async () => {
            try {
                const raw = await (await StorageAPI.getSettings()).getValue(NEXUS_FILE_CHOICES_KEY);
                const parsed = raw ? JSON.parse(raw) : {};
                const next: Record<string, NexusFileChoiceRecord> = {};
                for (const [key, value] of Object.entries(parsed ?? {})) {
                    if (isRecord(value)) next[key] = {fileId: Number(value.fileId), groupId: Number(value.groupId) || 0, name: value.name};
                }
                choices = next;
            } catch (error) {
                console.warn("[NexusFileChoice] not read", error);
                choices = {};
            }
            version++;
            listeners.forEach(l => l());
        })();
    }
    return loaded;
}

export const NexusFileChoice = {
    init: load,
    /** For React (useSyncExternalStore) */
    version(): number {
        return version;
    },
    subscribe(listener: () => void): () => void {
        listeners.add(listener);
        return () => listeners.delete(listener);
    },
    /** What was picked (undefined: the main download, or not loaded yet) */
    peek(domain: string, modId: number): NexusFileChoiceRecord | undefined {
        return choices[keyOf(domain, modId)];
    },
    async get(domain: string, modId: number): Promise<NexusFileChoiceRecord | undefined> {
        await load();
        return choices[keyOf(domain, modId)];
    },
    /** Remember a pick; null: the main download again */
    async set(domain: string, modId: number, choice: NexusFileChoiceRecord | null): Promise<void> {
        await load();
        const key = keyOf(domain, modId);
        const before = choices[key];
        if (!choice && !before) return;
        if (choice && before && before.fileId === choice.fileId && before.groupId === choice.groupId && before.name === choice.name) return;
        const next = {...choices};
        if (choice) next[key] = choice;
        else delete next[key];
        choices = next;
        version++;
        listeners.forEach(l => l());
        await (await StorageAPI.getSettings()).setValue(NEXUS_FILE_CHOICES_KEY, JSON.stringify(next));
    },
};
