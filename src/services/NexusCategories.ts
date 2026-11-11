/**
 * Nexus Mods mods show their Nexus category as their tag. Mods added before MINTCAT read the
 * category get it once (a few small requests, only for Nexus mods without a tag).
 */
import {StorageAPI} from "@/storage";
import {NEXUSMODS_PLATFORM, NexusModsApi} from "@/apis/nexusmods";

let ran = false;

/** How many mods got a category */
export async function backfillNexusCategories(): Promise<number> {
    if (ran) return 0;
    ran = true;
    const modsApi = await StorageAPI.getMods();
    const mods = (await modsApi.getAllMods())
        .filter(m => m.sourceType === NEXUSMODS_PLATFORM && m.modId != null && !(m.tags?.length));
    let filled = 0;
    for (const mod of mods) {
        const parsed = NexusModsApi.parseModLinks(mod.url || "");
        if (!parsed) continue;
        const category = await NexusModsApi.getModCategory(parsed.domain, parsed.modId);
        if (!category) continue;
        await modsApi.updateMod(mod.modId!, {tags: [category]});
        filled++;
    }
    return filled;
}
