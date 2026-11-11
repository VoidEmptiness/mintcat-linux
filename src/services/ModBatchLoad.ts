/**
 * Load many mods' full data with the batch query (4 queries in all instead of 4 per mod).
 * Any mod the batch didn't return (it gives back nothing at all when it fails) is loaded on
 * its own, so the result is never smaller than loading them one by one.
 */
import {StorageAPI} from "@/storage";
import type {CompleteModData} from "@/storage/dao/ModDAO";

/** The mods with these ids, in the same order (ids with no mod record are left out) */
export async function loadCompleteMods(modIds: number[]): Promise<CompleteModData[]> {
    if (modIds.length === 0) return [];
    const modsDAO = await StorageAPI.getMods();
    const loaded = await modsDAO.getBatchCompleteModDataOptimized([...new Set(modIds)]);
    const byId = new Map(loaded.map(m => [m.modId, m]));
    const result: CompleteModData[] = [];
    for (const id of modIds) {
        const mod = byId.get(id) ?? await modsDAO.getCompleteModData(id);
        if (mod) result.push(mod);
    }
    return result;
}
