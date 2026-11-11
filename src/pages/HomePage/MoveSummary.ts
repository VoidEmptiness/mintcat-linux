/**
 * Where mods and folders are before and after a move, for "Ask before moving" (Settings →
 * Mod list): a mod by its install position and folder, a folder by the folder it is in.
 * Pure functions over the list's tree data, so they can be tested without the app.
 */
import {leavesInOrder} from "./TreeMoves";

export interface Place {
    name: string;
    isMod: boolean;
    /** Install position, 1 = top of the whole list (mods) */
    position?: number;
    /** The folders it is in ("Cosmetic / Custom Icons"); "" = top level */
    folder: string;
}

export interface MoveLine {
    key: string;
    name: string;
    isMod: boolean;
    from: Place;
    to: Place;
}

function walk(nodes: any[] | undefined, names: string[], visit: (node: any, names: string[]) => void) {
    for (const node of nodes ?? []) {
        visit(node, names);
        if (!node.isLeaf) walk(node.children, node.key === 'root' ? names : [...names, String(node.title ?? "")], visit);
    }
}

/** Where each of `keys` is in a tree (keys not found are left out) */
export function placesOf(tree: any[] | undefined, keys: readonly string[]): Map<string, Place> {
    const want = new Set(keys.map(String));
    const positions = new Map(leavesInOrder(tree).map((leaf, i) => [String(leaf.node.key), i + 1]));
    const out = new Map<string, Place>();
    walk(tree, [], (node, names) => {
        const key = String(node.key);
        if (!want.has(key) || out.has(key)) return;
        out.set(key, {
            name: String(node.title ?? key),
            isMod: !!node.isLeaf,
            position: node.isLeaf ? positions.get(key) : undefined,
            folder: names.join(" / "),
        });
    });
    return out;
}

/** The ones whose place changed (in the order of `before`); nothing when the move changes nothing */
export function movedLines(before: Map<string, Place>, after: Map<string, Place>): MoveLine[] {
    const lines: MoveLine[] = [];
    for (const [key, from] of before) {
        const to = after.get(key);
        if (!to) continue;
        if (from.folder === to.folder && from.position === to.position) continue;
        lines.push({key, name: from.name, isMod: from.isMod, from, to});
    }
    return lines;
}
