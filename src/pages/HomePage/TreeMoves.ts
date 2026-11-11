/**
 * Moving a mod to another install position in the tree data the list shows (folders with
 * children, mods as leaves). Pure functions, so they can be tested without the app.
 */

/** Leaf keys in tree order, with the folder keys above each */
export function leavesInOrder(nodes: any[] | undefined, path: string[] = [], out: { node: any; folders: string[] }[] = []) {
    for (const node of nodes ?? []) {
        if (node.isLeaf) {
            out.push({node, folders: path});
        } else {
            leavesInOrder(node.children, node.key === 'root' ? path : [...path, String(node.key)], out);
        }
    }
    return out;
}

/** Remove `node` from the tree; returns where it was (to put it back), or null when not found */
export function detach(nodes: any[] | undefined, node: any): { list: any[]; index: number } | null {
    if (!nodes) return null;
    const index = nodes.indexOf(node);
    if (index >= 0) {
        nodes.splice(index, 1);
        return {list: nodes, index};
    }
    for (const child of nodes) {
        const found = detach(child.children, node);
        if (found) return found;
    }
    return null;
}

/** Put `node` right before/after `anchor`, in the anchor's folder; true when the anchor was found */
export function placeNextTo(nodes: any[] | undefined, anchor: any, node: any, after: boolean): boolean {
    if (!nodes) return false;
    const index = nodes.indexOf(anchor);
    if (index >= 0) {
        nodes.splice(after ? index + 1 : index, 0, node);
        return true;
    }
    return nodes.some(child => placeNextTo(child.children, anchor, node, after));
}

/**
 * Move the mod with key `sourceKey` so it becomes number `position` (1-based) in `order` (mod
 * ids in install order): right before the mod now at that number when moving up, right after
 * it when moving down, in that mod's folder. Changes `treeData` in place. Returns the folder
 * keys above its new place, or null when nothing moved.
 */
export function moveToPosition(treeData: any[], order: number[], sourceKey: string, position: number): string[] | null {
    if (!Number.isFinite(position)) return null;
    const leaves = leavesInOrder(treeData);
    const source = leaves.find(l => String(l.node.key) === sourceKey);
    if (!source) return null;
    const from = order.indexOf(source.node.modId);
    const to = Math.min(Math.max(Math.round(position), 1), order.length) - 1;
    if (from < 0 || to < 0 || to === from) return null;
    const anchor = leaves.find(l => l.node.modId === order[to]);
    if (!anchor || anchor.node === source.node) return null;
    const was = detach(treeData, source.node);
    if (!was) return null;
    if (!placeNextTo(treeData, anchor.node, source.node, to > from)) {
        // put it back where it was rather than lose it
        was.list.splice(was.index, 0, source.node);
        return null;
    }
    return anchor.folders;
}

/**
 * Move several mods (keys in any order) together: in their install order, the first becomes
 * number `position` and the others follow it, all in the folder of the place they go to
 * (right before the mod now at that number when moving up, right after the one before it when
 * moving down). One mod is the same as `moveToPosition`. Changes `treeData` in place. Returns
 * the folder keys above the new place, or null when nothing moved.
 */
export function moveGroupToPosition(treeData: any[], order: number[], keys: string[], position: number): string[] | null {
    if (!Number.isFinite(position)) return null;
    const wanted = new Set(keys.map(String));
    const leaves = leavesInOrder(treeData);
    const rank = (modId: number) => {
        const i = order.indexOf(modId);
        return i < 0 ? Number.MAX_SAFE_INTEGER : i;
    };
    const group = leaves.filter(l => wanted.has(String(l.node.key)))
        .sort((a, b) => rank(a.node.modId) - rank(b.node.modId));
    if (group.length === 0) return null;
    if (group.length === 1) return moveToPosition(treeData, order, String(group[0].node.key), position);

    const groupIds = new Set(group.map(g => g.node.modId));
    const rest = order.filter(id => !groupIds.has(id));
    const target = Math.min(Math.max(Math.round(position), 1), rest.length + 1) - 1;
    const from = rank(group[0].node.modId);
    // already together at that place: nothing to do
    const together = group.every((g, i) => rank(g.node.modId) === from + i);
    if (together && from === target) return null;

    const byId = new Map(leaves.map(l => [l.node.modId, l]));
    const before = target < rest.length ? byId.get(rest[target]) : undefined;
    const after = target > 0 ? byId.get(rest[target - 1]) : undefined;
    // moving up: in the folder of the mod now at that number; moving down (or past the end):
    // in the folder of the one before it
    const goBefore = before && (from > target || !after);
    const anchor = goBefore ? before : after;
    if (!anchor) return null;

    const removed: { node: any; was: { list: any[]; index: number } }[] = [];
    for (const g of group) {
        const was = detach(treeData, g.node);
        if (was) removed.push({node: g.node, was});
    }
    let ok = placeNextTo(treeData, anchor.node, group[0].node, !goBefore);
    for (let i = 1; ok && i < group.length; i++) ok = placeNextTo(treeData, group[i - 1].node, group[i].node, true);
    if (!ok) {
        // put everything back where it was rather than lose mods
        for (const g of group) detach(treeData, g.node);
        for (let i = removed.length - 1; i >= 0; i--) removed[i].was.list.splice(removed[i].was.index, 0, removed[i].node);
        return null;
    }
    return anchor.folders;
}

/**
 * After `centerKey` was dropped somewhere, bring the other mods of `keysInOrder` (the dragged
 * group, in install order) next to it: those that came before it right before it, the rest
 * right after it, so the group keeps its order in the dragged mod's new folder. Changes
 * `treeData` in place; false when the dragged mod isn't in it.
 */
export function gatherAround(treeData: any[], keysInOrder: string[], centerKey: string): boolean {
    const byKey = new Map(leavesInOrder(treeData).map(l => [String(l.node.key), l.node]));
    const center = byKey.get(centerKey);
    const at = keysInOrder.indexOf(centerKey);
    if (!center || at < 0) return false;
    const nodes = (list: string[]) => list.map(k => byKey.get(k)).filter(n => n && n !== center);
    const above = nodes(keysInOrder.slice(0, at));
    const below = nodes(keysInOrder.slice(at + 1));
    for (const n of [...above, ...below]) detach(treeData, n);
    let prev = center;
    for (let i = above.length - 1; i >= 0; i--) {
        placeNextTo(treeData, prev, above[i], false);
        prev = above[i];
    }
    prev = center;
    for (const n of below) {
        placeNextTo(treeData, prev, n, true);
        prev = n;
    }
    return true;
}

/**
 * How spread out picked mods are: how many folders they are in (the top level counts as one)
 * and how many are inside a closed folder, where they can't be seen
 */
export function groupSpread(treeData: any[] | undefined, keys: string[], openKeys: unknown[]): { folders: number; hidden: number } {
    const picked = new Set(keys);
    const open = new Set(openKeys.map(String));
    const folders = new Set<string>();
    let hidden = 0;
    for (const leaf of leavesInOrder(treeData)) {
        if (!picked.has(String(leaf.node.key))) continue;
        folders.add(leaf.folders.join("/"));
        if (leaf.folders.some(f => !open.has(f))) hidden++;
    }
    return {folders: folders.size, hidden};
}
