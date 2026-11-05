/**
 * Remove a mod repository (after asking). Mods added from it stay in the lists with their files;
 * their links stay too, so adding the same site again picks them up again.
 */
import {t} from "i18next";
import {RepositoryStore, type ModRepository} from "@/apis/repositories";
import {RepositoryUpdates} from "@/services/RepositoryUpdates";
import {logActivity} from "@/services/ActivityLog";
import {confirmDelete} from "@/services/DeleteConfirm";

/** True when it was removed */
export async function removeRepository(repo: ModRepository, options: { zIndex?: number } = {}): Promise<boolean> {
    const linked = await RepositoryUpdates.linkCount(repo.id).catch(() => 0);
    const content = [
        t("deleteConfirm.repository", {name: repo.name}),
        linked > 0 ? t("repo.removeLinkedNote", {count: linked}) : "",
    ].filter(Boolean).join("\n\n");
    if (!(await confirmDelete({
        title: t("repo.removeTitle", {name: repo.name}),
        content: <span style={{whiteSpace: "pre-line"}}>{content}</span>,
        okText: t("repo.remove"),
        zIndex: options.zIndex,
    }))) return false;
    await RepositoryStore.remove(repo.id);
    await logActivity('info', t("repo.removed", {name: repo.name}), repo.baseUrl, 'repository');
    return true;
}
