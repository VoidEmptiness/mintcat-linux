/**
 * Remove a mod repository (after asking). Mods added from it stay in the lists with their files;
 * their links stay too, so adding the same site again picks them up again.
 */
import {t} from "i18next";
import {RepositoryStore, type ModRepository} from "@/apis/repositories";
import {RepositoryUpdates} from "@/services/RepositoryUpdates";
import {logActivity} from "@/services/ActivityLog";
import {confirmDelete} from "@/services/DeleteConfirm";
import {BUILT_IN_SOURCE_NAMES, HiddenSources} from "@/apis/search/HiddenSources";

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

/**
 * Remove a built-in source (mod.io, ModCat, Nexus Mods) from the Browse Mods list, after asking.
 * True when it was removed.
 */
export async function hideBuiltInSource(source: string, options: { zIndex?: number } = {}): Promise<boolean> {
    const name = BUILT_IN_SOURCE_NAMES[source] ?? source;
    if (!(await confirmDelete({
        title: t("repo.removeTitle", {name}),
        content: t("repo.hideBuiltInConfirm", {name}),
        okText: t("repo.remove"),
        zIndex: options.zIndex,
    }))) return false;
    await HiddenSources.hide(source);
    await logActivity('info', t("repo.hiddenBuiltIn", {name}), undefined, 'repository');
    return true;
}

export async function showBuiltInSource(source: string): Promise<void> {
    await HiddenSources.show(source);
    await logActivity('info', t("repo.shownBuiltIn", {name: BUILT_IN_SOURCE_NAMES[source] ?? source}), undefined, 'repository');
}
