/**
 * Working on several folders at once (picked with Ctrl-click or the checkboxes): which folders
 * are picked, what is inside them, and the moves and deletes done on the list's tree data.
 * Pure functions on the tree (nodes with key, isLeaf, children), tested on their own.
 */

interface TreeNode {
    key: unknown;
    title?: unknown;
    isLeaf?: boolean;
    children?: TreeNode[];
    modId?: number;
    enabled?: boolean;
}

const isFolder = (node: TreeNode) => !node.isLeaf && String(node.key).startsWith("folder-");

/** Folder keys in list order */
export function folderKeysInOrder(nodes: TreeNode[] | undefined, out: string[] = []): string[] {
    for (const node of nodes ?? []) {
        if (!isFolder(node)) continue;
        out.push(String(node.key));
        folderKeysInOrder(node.children, out);
    }
    return out;
}

/**
 * The ticked folders, in list order. A folder counts when it is ticked itself, or when every mod
 * in it (subfolders included) is ticked, as Ctrl-click on a folder ticks its mods.
 */
export function pickedFolders(nodes: TreeNode[] | undefined, checkedKeys: unknown[] | undefined): string[] {
    const checked = new Set((checkedKeys ?? []).map(String));
    if (checked.size === 0) return [];
    const out: string[] = [];
    // returns whether every mod below is ticked, and whether there is any
    const walk = (list: TreeNode[] | undefined): { all: boolean; any: boolean } => {
        let all = true;
        let any = false;
        for (const node of list ?? []) {
            if (node.isLeaf) {
                any = true;
                if (!checked.has(String(node.key))) all = false;
            } else if (isFolder(node)) {
                const at = out.length;
                const inner = walk(node.children);
                if (checked.has(String(node.key)) || (inner.any && inner.all)) out.splice(at, 0, String(node.key));
                any ||= inner.any;
                if (!inner.all) all = false;
            }
        }
        return {all, any};
    };
    walk(nodes);
    return out;
}

/** Parent folder key of every folder (null: top level) */
function parentsOf(nodes: TreeNode[] | undefined, parent: string | null = null, out = new Map<string, string | null>()) {
    for (const node of nodes ?? []) {
        if (!isFolder(node)) continue;
        out.set(String(node.key), parent);
        parentsOf(node.children, String(node.key), out);
    }
    return out;
}

/** Of these folders, the ones not inside another of them (in list order) */
export function topmost(nodes: TreeNode[] | undefined, keys: string[]): string[] {
    const set = new Set(keys);
    const parents = parentsOf(nodes);
    const inside = (key: string): boolean => {
        for (let p = parents.get(key) ?? null; p; p = parents.get(p) ?? null) {
            if (set.has(p)) return true;
        }
        return false;
    };
    return folderKeysInOrder(nodes).filter(k => set.has(k) && !inside(k));
}

export function findNode(nodes: TreeNode[] | undefined, key: string): TreeNode | null {
    for (const node of nodes ?? []) {
        if (String(node.key) === key) return node;
        const found = findNode(node.children, key);
        if (found) return found;
    }
    return null;
}

/** These folders and every folder inside them */
export function withSubfolders(nodes: TreeNode[] | undefined, keys: string[]): string[] {
    const out = new Set<string>();
    for (const key of keys) {
        const node = findNode(nodes, key);
        if (!node) continue;
        out.add(key);
        for (const sub of folderKeysInOrder(node.children)) out.add(sub);
    }
    return folderKeysInOrder(nodes).filter(k => out.has(k));
}

/** The mods in these folders and their subfolders, in list order, each once */
export function modsWithin(nodes: TreeNode[] | undefined, keys: string[]): TreeNode[] {
    const out: TreeNode[] = [];
    const seen = new Set<string>();
    const walk = (list: TreeNode[] | undefined) => {
        for (const node of list ?? []) {
            if (node.isLeaf) {
                if (!seen.has(String(node.key))) {
                    seen.add(String(node.key));
                    out.push(node);
                }
            } else {
                walk(node.children);
            }
        }
    };
    for (const key of topmost(nodes, keys)) walk(findNode(nodes, key)?.children);
    return out;
}

/** How many mods a folder holds (subfolders included) and how many of them are off */
export function folderCounts(node: TreeNode, enabled: (mod: TreeNode) => boolean = m => m.enabled !== false): { total: number; off: number } {
    let total = 0;
    let off = 0;
    const walk = (list: TreeNode[] | undefined) => {
        for (const child of list ?? []) {
            if (child.isLeaf) {
                total++;
                if (!enabled(child)) off++;
            } else {
                walk(child.children);
            }
        }
    };
    walk(node.children);
    return {total, off};
}

/** The list (top level or a folder's children) holding `key`, and where in it */
function locate(nodes: TreeNode[], key: string): { list: TreeNode[]; index: number } | null {
    const index = nodes.findIndex(n => String(n.key) === key);
    if (index >= 0) return {list: nodes, index};
    for (const node of nodes) {
        if (!node.children) continue;
        const found = locate(node.children, key);
        if (found) return found;
    }
    return null;
}

/**
 * Delete folders but keep what's in them: each folder is replaced by its contents, where it
 * was. Picked subfolders go the same way; other subfolders stay, one level up.
 * @returns the folders that are gone
 */
export function dissolveFolders(nodes: TreeNode[], keys: string[]): string[] {
    const gone: string[] = [];
    // innermost first, so a picked subfolder's contents end up in the right place
    for (const key of [...folderKeysInOrder(nodes).filter(k => keys.includes(k))].reverse()) {
        const at = locate(nodes, key);
        if (!at) continue;
        const contents = at.list[at.index].children ?? [];
        at.list.splice(at.index, 1, ...contents);
        gone.push(key);
    }
    return gone;
}

/**
 * Move folders (with everything in them) into another folder, after what's there, or to the
 * end of the top level (`target` null). Folders inside a moved folder go along with it.
 * @returns the folders moved, or null when the target is one of them or inside one
 */
export function moveFoldersInto(nodes: TreeNode[], keys: string[], target: string | null): string[] | null {
    const moving = topmost(nodes, keys);
    if (moving.length === 0) return [];
    if (target !== null) {
        if (!findNode(nodes, target)) return null;
        for (const key of moving) {
            const node = findNode(nodes, key);
            if (key === target || (node && findNode(node.children, target))) return null;
        }
    }
    if (target === null) {
        // To the top level: folders already there stay put; others go right after the
        // top-level folder they were in, so the install order changes as little as possible
        const moved: string[] = [];
        for (const key of moving) {
            if (nodes.some(n => String(n.key) === key)) continue;
            const ancestor = nodes.find(n => !n.isLeaf && findNode(n.children, key));
            const at = locate(nodes, key);
            if (!at || !ancestor) continue;
            const [node] = at.list.splice(at.index, 1);
            // after the ancestor and any folders already moved out of it
            let index = nodes.indexOf(ancestor) + 1;
            while (index < nodes.length && moved.includes(String(nodes[index].key))) index++;
            nodes.splice(index, 0, node);
            moved.push(key);
        }
        return moved;
    }
    const taken: TreeNode[] = [];
    for (const key of moving) {
        const at = locate(nodes, key);
        if (!at) continue;
        taken.push(...at.list.splice(at.index, 1));
    }
    // to the top of the folder, like moving one folder (or a mod) into a folder
    (findNode(nodes, target)!.children ??= []).unshift(...taken);
    return taken.map(n => String(n.key));
}

/** "Parent/Child" name path of a folder (for folder colors), or null */
export function folderPath(nodes: TreeNode[] | undefined, key: string, path: string[] = []): string | null {
    for (const node of nodes ?? []) {
        if (node.isLeaf) continue;
        const here = [...path, String(node.title ?? "")];
        if (String(node.key) === key) return here.join("/");
        const found = folderPath(node.children, key, here);
        if (found) return found;
    }
    return null;
}

/**
 * "Only these folders' mods on": which mods to switch on and off. Mods in the kept folders go
 * back to how they were before the first such run (`wasOn`; mods switched off then stay off),
 * every other mod goes off. Only mods whose state changes are listed.
 */
export function soloPlan(mods: { modId?: number; enabled?: boolean }[], keep: Set<number>, wasOn: Set<number>): { on: number[]; off: number[] } {
    const on: number[] = [];
    const off: number[] = [];
    for (const mod of mods) {
        if (mod.modId == null) continue;
        const enabled = mod.enabled !== false;
        const wanted = keep.has(mod.modId) && wasOn.has(mod.modId);
        if (wanted && !enabled) on.push(mod.modId);
        if (!wanted && enabled) off.push(mod.modId);
    }
    return {on, off};
}
