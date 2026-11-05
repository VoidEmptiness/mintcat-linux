/**
 * What a mod needs (or what its author says about load order and conflicts), for Browse Mods.
 *
 * - Nexus Mods lists requirements on the mod page: other Nexus mods, outside tools (with a
 *   link) and DLC. Those are reliable.
 * - Pak Hub posts are free text from Discord. The sentences about requirements, load order
 *   and conflicts are picked out and the mods they link or name are offered as suggestions,
 *   ticked only when the sentence clearly says "requires"/"needs". Sentences that look like
 *   requirements but aren't ("Required by all" = everyone in the lobby needs it, "Based on …",
 *   "Doesn't need the original mod") don't tick anything.
 *
 * No network or storage here, so the rules can be tested on their own.
 */
import type {NexusModsModNode} from "@/apis/nexusmods/types";
import {resolveRequirements} from "@/apis/nexusmods/requirements";

export type RequirementSource = 'nexus' | 'modio' | 'pakhub' | 'external' | 'dlc' | 'named';

export interface Requirement {
    key: string;
    name: string;
    source: RequirementSource;
    /** Page to add it from (Nexus / mod.io), or the outside page to open */
    link?: string;
    /** MINTCAT can add it */
    addable: boolean;
    notes?: string;
    /** Ticked by default: the mod clearly needs it */
    likely: boolean;
    nexusModId?: number;
    modioSlug?: string;
    modioId?: number;
    /** A Pak Hub post: message id of the Discord post it came from (to find it) */
    discordMessageId?: string;
    /** The sentence it was found in (Pak Hub) */
    sentence?: string;
}

export interface OrderHint {
    direction: 'above' | 'below';
    /** As written: "CAO", "CD2", "Customizable Ally Outlines" */
    target: string;
    sentence: string;
}

export interface PostAnalysis {
    /** Sentences about requirements, load order, conflicts or who needs the mod */
    notes: string[];
    requirements: Requirement[];
    orderHints: OrderHint[];
}

// ---------- Nexus ----------

export function nexusRequirements(node: NexusModsModNode, domain: string): Requirement[] {
    const requirements = node.modRequirements;
    const result: Requirement[] = resolveRequirements(requirements?.nexusRequirements?.nodes, domain,
        node.gameId != null ? Number(node.gameId) : undefined)
        .filter(req => req.kind === 'nexus' ? req.modId !== node.modId : true)
        .map(req => req.kind === 'nexus'
            ? {
                key: `nexus:${req.modId}`, name: req.name, source: 'nexus' as const, notes: req.notes || undefined,
                likely: true, addable: true, nexusModId: req.modId, link: req.url,
            }
            : {
                key: `ext:${req.url || req.name}`.toLowerCase(), name: req.name, source: 'external' as const,
                link: req.url || undefined, notes: req.notes || undefined, addable: false, likely: true,
            });
    for (const dlc of requirements?.dlcRequirements ?? []) {
        const name = dlc.gameExpansion?.name || "DLC";
        if (result.some(r => r.key === `dlc:${name}`)) continue;
        result.push({key: `dlc:${name}`, name, source: 'dlc', addable: false, likely: true, notes: dlc.notes ?? undefined});
    }
    return result;
}

// ---------- Pak Hub post text ----------

const REQUIRES = /\b(requires?|required|requirements?|needs?|depends? on|dependenc(y|ies)|you('ll)? need|must have|install .{0,20}first|works? only with|only works with)\b/i;
const NOT_A_REQUIREMENT = /\b(does(n'?t| not)|do(n'?t| not)|no longer|without)\s+(need|require)|\bnot (needed|required)\b|\bno (need|requirements?)\b|\bbased on\b|\binspired\b|\boriginal\b|\bedited version\b|\bversion of\b/i;
/** "Required by all", "only the host needs this", "needs to be installed by everyone": who needs it, not what */
const WHO_NEEDS_IT = /\brequired by (all|everyone|every ?one|host|clients?)\b|\b(only )?(the )?(host|clients?|everyone|all players?)( only)? (needs?|requires?)\b|\bneeds? (to be )?(installed )?(by|on|for) (all|everyone|the host|host|clients?|every)\b|\bclient[ -]?side\b|\bhost[ -]?only\b|\bclient[ -]?only\b/i;
const CONFLICT = /\b(not compatible|incompatible|conflicts? with|disable the original|disable .{0,30}original|turn off|don'?t use (it |this )?(with|together)|can'?t be used (with|together))\b/i;
const RECOMMENDED = /\b(recommended|recommend|works (well|great|best) with|use(d)? (it )?(together|alongside) with|pairs? (well )?with)\b/i;
const ORDER = /\b(?:put|load|place|keep|move|install|order)\w*\b[^.\n]{0,25}?\b(above|below|higher than|lower than|before|after|over|under)\b\s+([^.,;!?\n]{2,60})/i;
const PRIORITY = /\b(higher|lower) (priority|in (the )?(load )?order)\b/i;

const MODIO_LINK = /https?:\/\/(?:www\.)?mod\.io\/g\/drg\/m\/([a-z0-9-]+)/gi;
const NEXUS_LINK = /https?:\/\/(?:www\.)?nexusmods\.com\/([a-z0-9]+)\/mods\/(\d+)/gi;
const DISCORD_LINK = /https?:\/\/(?:www\.)?discord(?:app)?\.com\/channels\/\d+\/\d+\/(\d+)/gi;

/** "custom-vanity-framework" → "Custom Vanity Framework" */
export function nameFromSlug(slug: string): string {
    return slug.split("-").filter(Boolean).map(w => w.charAt(0).toUpperCase() + w.slice(1)).join(" ");
}

/** Discord text into sentences (lines, and sentences within lines), without emoji and mention codes */
export function postSentences(text: string): string[] {
    const cleaned = text
        .replace(/<a?:\w+:\d+>/g, " ")        // custom emoji
        .replace(/<[@#][!&]?\d+>/g, " ")      // mentions
        .replace(/\*\*|__|~~|`+/g, "")
        .replace(/\r/g, "");
    const result: string[] = [];
    for (const line of cleaned.split(/\n+/)) {
        const plain = line.replace(/^\s*(?:[-*>•]|\d+\.)\s*/, "").trim();
        if (!plain) continue;
        // split at sentence ends, but not inside links ("mod.io/…") or version numbers ("1.2")
        for (const part of plain.split(/(?<=[.!?])\s+(?=[A-Z(])/)) {
            const sentence = part.replace(/\s+/g, " ").trim();
            if (sentence.length > 1) result.push(sentence);
        }
    }
    return result;
}

/** Names right after "needs"/"requires" with no link: "Needs UUI/ModHub" → ["UUI", "ModHub"] */
function namedAfterKeyword(sentence: string): string[] {
    const match = /\b(?:requires?|needs?|depends on|required:?)\s+(?:the\s+|a\s+|an\s+)?(.+)$/i.exec(sentence);
    if (!match) return [];
    let rest = match[1]
        .replace(/https?:\/\/\S+/g, " ")
        .replace(/\(.*?\)/g, " ")
        .split(/[.;:!?]|\bto (work|run|function)\b|\bfor\b|\bin order\b/i)[0];
    const names: string[] = [];
    for (const piece of rest.split(/\s*(?:\/|,|\band\b|&|\bor\b|\+)\s*/i)) {
        const name = piece.replace(/\b(mod|mods|installed|enabled|too|also|as well|first)\b/gi, " ").replace(/\s+/g, " ").trim();
        if (!name || name.length > 40) continue;
        // a name starts with a capital or a digit ("UUI", "ModHub", "CD2"), not "this", "to be"
        if (!/^[A-Z0-9]/.test(name)) continue;
        if (/^(this|it|that|them|you|all|every|everyone|host|clients?|players?)$/i.test(name)) continue;
        names.push(name);
    }
    return names;
}

export function analyzePostText(text: string): PostAnalysis {
    const notes: string[] = [];
    const requirements: Requirement[] = [];
    const orderHints: OrderHint[] = [];
    const seen = new Set<string>();
    const add = (req: Requirement) => {
        const existing = requirements.find(r => r.key === req.key);
        if (existing) {
            existing.likely = existing.likely || req.likely;
            return;
        }
        requirements.push(req);
    };

    for (const sentence of postSentences(text)) {
        const who = WHO_NEEDS_IT.test(sentence);
        const conflict = CONFLICT.test(sentence) || /\bneeds? to (disable|remove|turn off|uninstall)\b/i.test(sentence);
        const requires = REQUIRES.test(sentence) && !NOT_A_REQUIREMENT.test(sentence) && !who && !conflict;
        const recommended = RECOMMENDED.test(sentence);
        const order = ORDER.exec(sentence);
        const relevant = REQUIRES.test(sentence) || who || conflict || recommended || !!order || PRIORITY.test(sentence);
        if (relevant && !seen.has(sentence.toLowerCase())) {
            seen.add(sentence.toLowerCase());
            notes.push(sentence);
        }
        if (order) {
            const target = order[2]
                .replace(/\b(in (the )?(mint|mintcat|list|load order|mod list|mod manager)|with higher priority|priority|mod)\b.*$/i, "")
                .replace(/[/\\].*$/, "")
                .trim();
            const direction = /below|lower|after|under/i.test(order[1]) ? 'below' : 'above';
            if (target && target.length <= 40) orderHints.push({direction, target, sentence});
        }

        for (const link of sentence.matchAll(MODIO_LINK)) {
            const slug = link[1].toLowerCase();
            add({
                key: `modio:${slug}`, name: nameFromSlug(slug), source: 'modio', addable: true,
                likely: requires, modioSlug: slug, link: `https://mod.io/g/drg/m/${slug}`, sentence,
            });
        }
        for (const link of sentence.matchAll(NEXUS_LINK)) {
            const modId = Number(link[2]);
            add({
                key: `nexus:${modId}`, name: `Nexus Mods #${modId}`, source: 'nexus', addable: true,
                likely: requires, nexusModId: modId, link: `https://www.nexusmods.com/${link[1].toLowerCase()}/mods/${modId}`, sentence,
            });
        }
        for (const link of sentence.matchAll(DISCORD_LINK)) {
            add({
                key: `discord:${link[1]}`, name: "Discord post", source: 'pakhub', addable: false,
                likely: requires, discordMessageId: link[1], link: link[0], sentence,
            });
        }
        if (requires) {
            for (const name of namedAfterKeyword(sentence)) {
                add({key: `named:${name.toLowerCase()}`, name, source: 'named', addable: false, likely: true, sentence});
            }
        }
    }
    return {notes, requirements, orderHints};
}

// ---------- who has to have it ----------

export type WhoNeedsIt = 'host' | 'client' | 'everyone';

/** "Host only." / "client side" / "Required by all": who has to have the mod, from the author's sentences */
export function whoNeedsIt(notes: string[]): { who: WhoNeedsIt; sentence: string } | undefined {
    for (const sentence of notes) {
        if (/\bhost[ -]?only\b|\bonly (the )?host\b/i.test(sentence)) return {who: 'host', sentence};
        if (/\bclient[ -]?(side|only)\b|\bonly (the )?clients?\b/i.test(sentence)) return {who: 'client', sentence};
        if (/\brequired by (all|everyone)\b|\b(everyone|all players) (needs?|must have)\b|\bneeds? to be installed by (all|everyone)\b/i.test(sentence)) {
            return {who: 'everyone', sentence};
        }
    }
    return undefined;
}

// ---------- matching names to the mods in a list ----------

/** "Customizable Ally Outlines" → "cao", "Custom Difficulty 2" → "cd2", "Unified UI" → "uui" */
export function initialsOf(name: string): string {
    const words = name
        .replace(/\.(pak|zip)$/i, "")
        .replace(/([a-z])([A-Z])/g, "$1 $2")
        .split(/[^A-Za-z0-9]+/)
        .filter(Boolean);
    return words.map(w => (/^\d+$/.test(w) || (w.length > 1 && w === w.toUpperCase()) ? w : w[0])).join("").toLowerCase();
}

function squash(name: string): string {
    return name.toLowerCase().replace(/\.(pak|zip)$/i, "").replace(/[^a-z0-9]/g, "");
}

/** The mod in the list a written name means ("CAO", "ModHub", "custom difficulty"), if one clearly fits */
export function findModByName<T extends { name: string }>(written: string, mods: T[]): T | undefined {
    const target = squash(written);
    if (target.length < 2) return undefined;
    const exact = mods.filter(m => squash(m.name) === target);
    if (exact.length === 1) return exact[0];
    if (target.length <= 6 && /^[A-Z0-9]+$/.test(written.replace(/\s/g, ""))) {
        const byInitials = mods.filter(m => initialsOf(m.name) === target);
        if (byInitials.length === 1) return byInitials[0];
    }
    if (target.length >= 5) {
        const starting = mods.filter(m => squash(m.name).startsWith(target));
        if (starting.length === 1) return starting[0];
    }
    return undefined;
}
