/**
 * Which folders are open, kept across rebuilds of the list. Saving the list re-creates folders
 * with new ids, so open folders are remembered by their path of names (Parent, Child), with the
 * 2nd, 3rd, ... of same-named folders side by side told apart by their count. A folder that moved
 * keeps its open state when its name is unique in the list.
 */

/** Between the names in a path: a character no folder name has ("/" can be in a name) */
const SEP = "\u001f";
/** Before the count of a same-named folder ("New Group", "New Group" + MARK + "2") */
const MARK = "\u001e";

/** The folder's own name from a path's last part */
function nameOf(path: string): string {
    return (path.split(SEP).pop() ?? path).split(MARK)[0];
}

interface FolderNode {
    key: unknown;
    title?: unknown;
    isLeaf?: boolean;
    children?: FolderNode[];
}

/** Folder key -> path of names, in list order */
export function folderPaths(nodes: FolderNode[] | undefined, rename?: { key: string; name: string }): Map<string, string> {
    const out = new Map<string, string>();
    const walk = (list: FolderNode[] | undefined, parent: string) => {
        const seen = new Map<string, number>();
        for (const node of list ?? []) {
            const key = String(node.key);
            if (node.isLeaf || !key.startsWith("folder-")) continue;
            const name = rename?.key === key ? rename.name : String(node.title ?? "");
            const count = (seen.get(name) ?? 0) + 1;
            seen.set(name, count);
            const part = count === 1 ? name : `${name}${MARK}${count}`;
            const path = parent ? `${parent}${SEP}${part}` : part;
            out.set(key, path);
            walk(node.children, path);
        }
    };
    walk(nodes, "");
    return out;
}

/** Paths of the open folders (a folder being renamed counts under its new name) */
export function rememberOpen(nodes: FolderNode[] | undefined, openKeys: unknown[], rename?: { key: string; name: string }): string[] {
    const paths = folderPaths(nodes, rename);
    const out: string[] = [];
    for (const key of openKeys) {
        const path = paths.get(String(key));
        if (path !== undefined) out.push(path);
    }
    return out;
}

/** Keys of the remembered folders in a rebuilt list; a path that's gone matches the one folder with that name, if only one has it */
export function restoreOpen(nodes: FolderNode[] | undefined, paths: string[]): string[] {
    const byPath = new Map<string, string>();
    const byName = new Map<string, string[]>();
    for (const [key, path] of folderPaths(nodes)) {
        byPath.set(path, key);
        const name = nameOf(path);
        byName.set(name, [...(byName.get(name) ?? []), key]);
    }
    const out = new Set<string>();
    for (const path of paths) {
        const key = byPath.get(path);
        if (key) {
            out.add(key);
            continue;
        }
        // (not for the 2nd, 3rd, ... of same-named folders: the one left isn't that one)
        if (path.split(SEP).pop()?.includes(MARK)) continue;
        const same = byName.get(nameOf(path));
        if (same?.length === 1) out.add(same[0]);
    }
    return [...out];
}
