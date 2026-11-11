import { StorageAPI } from "@/storage";
import type { ProfileFolderData } from "@/storage/dao/ProfileDAO";

export type LabeledFolder = ProfileFolderData & { id: number; label: string };

/**
 * Folders in the order the mod list shows them (each folder followed by its subfolders), labelled
 * with their path ("Cosmetics / Custom Icons") so same-named subfolders can be told apart.
 */
export function foldersInTreeOrder(folders: ProfileFolderData[]): LabeledFolder[] {
    const withId = folders.filter((f): f is ProfileFolderData & { id: number } => f.id != null);
    const ids = new Set(withId.map(f => f.id));
    const children = new Map<number | null, (ProfileFolderData & { id: number })[]>();
    for (const folder of withId) {
        const parent = folder.parentFolderId && ids.has(folder.parentFolderId) ? folder.parentFolderId : null;
        const list = children.get(parent) ?? [];
        list.push(folder);
        children.set(parent, list);
    }
    const ordered: LabeledFolder[] = [];
    const seen = new Set<number>();
    const walk = (parent: number | null, path: string[]) => {
        const list = [...(children.get(parent) ?? [])].sort((a, b) => (a.sortOrder ?? 0) - (b.sortOrder ?? 0));
        for (const folder of list) {
            if (seen.has(folder.id)) continue;
            seen.add(folder.id);
            const folderPath = [...path, folder.name];
            ordered.push({...folder, label: folderPath.join(" / ")});
            walk(folder.id, folderPath);
        }
    };
    walk(null, []);
    // folders caught in a parent loop are still offered, at the end
    for (const folder of withId) {
        if (!seen.has(folder.id)) ordered.push({...folder, label: folder.name});
    }
    return ordered;
}

export class DialogProfileService {
    public async getActiveProfileFolders() {
        const profileDAO = await StorageAPI.getProfiles();
        const profileData = await profileDAO.getActiveProfile();
        return await profileDAO.getProfileFolders(profileData.id);
    }

    /** The active profile's folders in mod-list order, with path labels */
    public async getActiveProfileFolderChoices(): Promise<LabeledFolder[]> {
        return foldersInTreeOrder(await this.getActiveProfileFolders());
    }

    /**
     * Make a folder in the active profile, after the folders already in the same place
     * (0: top level). Returns its id.
     */
    public async createFolderAfterSiblings(name: string, parentId: number): Promise<number> {
        const profiles = await StorageAPI.getProfiles();
        const profile = await profiles.getActiveProfile();
        if (!profile?.id) throw new Error("no active profile");
        const siblings = (await profiles.getProfileFolders(profile.id)).filter(f => (f.parentFolderId || 0) === parentId);
        const sortOrder = siblings.reduce((max, f) => Math.max(max, (f.sortOrder ?? 0) + 1), 0);
        const made = await profiles.createFolder({
            profileId: profile.id,
            name,
            parentFolderId: parentId || null,
            folderType: "custom",
            sortOrder,
        });
        if (!made?.id) throw new Error("the folder was not saved");
        return made.id;
    }
}
