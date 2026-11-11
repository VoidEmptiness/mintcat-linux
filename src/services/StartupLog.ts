/**
 * The first Log entry of every run: which build is running on what system, with which game,
 * game folder and profile. Bug reports start from that.
 */
import {invoke} from "@tauri-apps/api/core";
import {getVersion} from "@tauri-apps/api/app";
import {t} from "i18next";
import {StorageAPI} from "@/storage";
import {BuildInfo} from "@/buildInfo";
import {logActivity} from "@/services/ActivityLog";

export async function logStartup(): Promise<void> {
    try {
        const version = BuildInfo.customVersion ?? `v${await getVersion().catch(() => "?")}`;
        const system = await invoke<string>("session_summary").catch(() => navigator.userAgent);
        await logActivity('info', t("log.app.started", {name: BuildInfo.windowTitle ?? "MINTCAT", version}), system, 'app');

        const game = await (await StorageAPI.getGames()).getActiveGame();
        const profilesApi = await StorageAPI.getProfiles();
        const profile = await profilesApi.getActiveProfile();
        const mods = profile?.id ? await profilesApi.getProfileMods(profile.id) : [];
        const enabled = mods.filter(m => m.isEnabled).length;
        await logActivity('info', t("log.app.state", {
            game: game?.displayName ?? game?.name ?? "—",
            profile: profile?.displayName || profile?.name || "—",
            enabled,
            total: mods.length,
        }), game?.installPath || t("log.app.noGamePath"), 'app');
    } catch (e) {
        console.warn("[StartupLog] failed", e);
    }
}
