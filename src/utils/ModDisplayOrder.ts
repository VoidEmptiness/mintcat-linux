import { ProfileTreeItem } from '@/models/profile/ProfileTreeItem';
import { ProfileTreeType } from '@/models/profile/types';

/**
 * Mod ids in the exact order the home page list shows them
 * (depth-first through folders, matching ProfileTreeService.loadProfileTreeRoot).
 *
 * The stored sortOrder restarts at 0 inside every folder, so sorting all mods by
 * sortOrder alone interleaves folders. Install priority and conflict "winner"
 * must follow this list instead: the mod nearer the top of the list wins.
 */
export function flattenTreeModIds(root: ProfileTreeItem): number[] {
    const result: number[] = [];
    const walk = (node: ProfileTreeItem) => {
        for (const child of node.children) {
            if (child.type === ProfileTreeType.FOLDER) {
                walk(child);
            } else if (!result.includes(child.id)) {
                result.push(child.id);
            }
        }
    };
    walk(root);
    return result;
}

/**
 * Stable sort of items by display order. Items not present in the tree keep
 * their original relative order and go after the listed ones.
 */
export function sortByDisplayOrder<T>(items: T[], order: number[], getModId: (item: T) => number): T[] {
    const position = new Map<number, number>();
    order.forEach((id, index) => position.set(id, index));
    return items
        .map((item, index) => ({ item, index }))
        .sort((a, b) => {
            const pa = position.get(getModId(a.item)) ?? Number.MAX_SAFE_INTEGER;
            const pb = position.get(getModId(b.item)) ?? Number.MAX_SAFE_INTEGER;
            return pa !== pb ? pa - pb : a.index - b.index;
        })
        .map(entry => entry.item);
}
