/**
 * What a Nexus Mods mod needs, from its "Requirements" (the modRequirements of the GraphQL
 * search): other Nexus mods of the same game MINTCAT can add, or things elsewhere (ReShade,
 * another game's mod…) it can only link to.
 *
 * Older mods often list a Nexus mod as an "off-site" requirement with a broken link
 * ("https://www.nexusmods.com//mods/1&amp;game_id=3671"): those are read as the Nexus mod.
 */

export interface NexusRequirementNode {
    modId?: string | number | null;
    modName?: string | null;
    url?: string | null;
    notes?: string | null;
    externalRequirement?: boolean | null;
    gameId?: string | number | null;
}

export interface ModRequirement {
    /** 'nexus': a mod of the same game MINTCAT can add; 'external': only a link */
    kind: 'nexus' | 'external';
    name: string;
    /** Nexus mod id (kind 'nexus') */
    modId?: number;
    /** Its page */
    url: string;
    /** What the mod's author wrote about it ("Will not work without this.") */
    notes: string;
}

function decodeEntities(value: string): string {
    return value
        .replace(/&amp;/gi, "&")
        .replace(/&lt;/gi, "<")
        .replace(/&gt;/gi, ">")
        .replace(/&quot;/gi, '"')
        .replace(/&#0?39;/g, "'");
}

/**
 * A Nexus mod in a requirement link: "/<domain>/mods/12", "/mods/12?game_id=3671" or the broken
 * "//mods/12&game_id=3671"
 */
export function nexusModFromUrl(url: string): { domain?: string; modId: number; gameId?: number } | null {
    const value = decodeEntities(url.trim());
    const match = /^https?:\/\/(?:www\.)?nexusmods\.com\/+(?:([a-z0-9]+)\/+)?mods\/(\d+)(.*)$/i.exec(value);
    if (!match) return null;
    const [, domain, id, rest] = match;
    const gameId = /[?&]game_id=(\d+)/i.exec(rest)?.[1];
    const modId = Number(id);
    if (!Number.isFinite(modId) || modId <= 0) return null;
    return {
        domain: domain && domain.toLowerCase() !== "games" ? domain.toLowerCase() : undefined,
        modId,
        gameId: gameId ? Number(gameId) : undefined,
    };
}

/**
 * The requirements of a mod of game `gameId` (Nexus's id) on `domain` ("deeprockgalactic").
 * The same mod listed twice counts once.
 */
export function resolveRequirements(nodes: NexusRequirementNode[] | null | undefined, domain: string,
                                    gameId: number | undefined): ModRequirement[] {
    const result: ModRequirement[] = [];
    const seen = new Set<string>();
    const sameGame = (id: unknown) => gameId == null || id == null || id === "" || Number(id) === gameId;
    for (const node of nodes ?? []) {
        const name = decodeEntities(String(node.modName ?? "").trim()).replace(/[.\s]+$/, "") || "?";
        const notes = decodeEntities(String(node.notes ?? "").trim());
        const rawUrl = decodeEntities(String(node.url ?? "").trim());
        const id = Number(node.modId ?? 0);
        let requirement: ModRequirement;
        if (!node.externalRequirement && id > 0 && sameGame(node.gameId)) {
            requirement = {kind: 'nexus', name, modId: id, url: `https://www.nexusmods.com/${domain}/mods/${id}`, notes};
        } else {
            const linked = rawUrl ? nexusModFromUrl(rawUrl) : null;
            const linkedSameGame = linked && (linked.domain ? linked.domain === domain : sameGame(linked.gameId));
            if (linked && linkedSameGame) {
                requirement = {
                    kind: 'nexus', name, modId: linked.modId,
                    url: `https://www.nexusmods.com/${domain}/mods/${linked.modId}`, notes,
                };
            } else {
                requirement = {kind: 'external', name, url: rawUrl, notes};
            }
        }
        const key = requirement.kind === 'nexus' ? `nexus:${requirement.modId}` : `ext:${requirement.url || requirement.name}`.toLowerCase();
        if (seen.has(key)) continue;
        seen.add(key);
        result.push(requirement);
    }
    return result;
}
