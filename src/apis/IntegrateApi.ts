import {t} from "i18next";
import {message} from "antd";
import { emitEvent, onceEvent } from "@/events";
import type { EventPayload } from "@/events";
import {invoke} from '@tauri-apps/api/core';
import {exists} from "@tauri-apps/plugin-fs";
import {StorageAPI} from "@/storage";
import { taskQueueAPI, TaskPriority } from "tauri-plugin-task-queue";
import { BackendRuntimeApi } from "@/apis/BackendRuntimeApi";
import { logActivity, nameList } from "@/services/ActivityLog";
import { DeployLog } from "@/services/DeployLog";

const DEFAULT_STEAM_APP_ID = 548430;
const STEAM_APP_IDS: Record<string, number> = {
    drg: DEFAULT_STEAM_APP_ID,
    rc: 2605790,
};

export class IntegrateApi  {

    /**
     * Install mods to game using async task system
     * @returns Task ID for tracking progress
     *
     * @example
     * ```typescript
     * const taskId = await IntegrateApi.installMods();
     * // UI can listen to task progress via TaskManager.onTaskUpdated()
     * ```
     */
    public static async installMods(): Promise<string> {
        console.log('[IntegrateApi] Submitting mod installation task');

        // Submit install task directly to plugin
        const taskId = await taskQueueAPI.addTask({
            taskType: 'mod_install',
            params: {}, 
            priority: TaskPriority.High
        });

        console.log(`[IntegrateApi] Install task submitted: ${taskId}`);
        return taskId;
    }

    /** Take MINTCAT's mods (and UE4SS) out of the game; true when done */
    public static async uninstallMods(): Promise<boolean> {
        if (!await IntegrateApi.checkGamePath()) {
            await logActivity('error', t("deploy.log.uninstallNoGame"), undefined, 'deploy');
            return false;
        }
        const gameDAO = await StorageAPI.getGames();
        const activeGame = await gameDAO.getActiveGame();
        const drgPakPath = activeGame?.installPath;
        const gameName = activeGame?.name ?? "drg";
        try {
            if (drgPakPath && await IntegrateApi.uninstall(drgPakPath)) {
                const before = await DeployLog.last(gameName);
                await DeployLog.markUninstalled(gameName).catch(() => undefined);
                const removed = before?.mods ?? [];
                await logActivity('success', removed.length
                    ? t("deploy.log.uninstalled", {count: removed.length})
                    : t("deploy.log.uninstalledUnknown"),
                    [removed.length ? nameList(removed.map(m => m.name)) : "", drgPakPath].filter(Boolean).join(" · "), 'deploy');
                if (removed.length) console.info(`[deploy] uninstalled (${removed.length}): ${removed.map(m => m.name).join("; ")}`);
                message.success(t("Uninstall Success"));
                return true;
            }
            await logActivity('error', t("deploy.log.uninstallFailed", {reason: t("deploy.log.uninstallRefused")}), drgPakPath, 'deploy');
            return false;
        } catch (error) {
            const reason = error instanceof Error ? error.message : String(error);
            await logActivity('error', t("deploy.log.uninstallFailed", {reason}), drgPakPath, 'deploy');
            throw error;
        }
    }

    public static async checkGamePath(drgPakPath: string = undefined): Promise<boolean> {
        const gameDAO = await StorageAPI.getGames();
        if (drgPakPath === undefined) {
            drgPakPath = (await gameDAO.getActiveGame())?.installPath;
        }

        try {
            if (!await exists(drgPakPath)) {
                //TODO: auto found or open game path dialog
                await emitEvent("app-error", t("Game Path Not Found"));
                return false;
            }
        } catch (e) {
            await emitEvent("app-error", t("error.noPermissionGamePath"));
            return false;
        }

        return true;
    }

    public static async install(
        gamePath: string,
        modListJson: string,
        skipUe4ss: boolean = false,
        ue4ssZipPath?: string,
        drgZipPath?: string,
        rcZipPath?: string,
        compressModPak: boolean = false
    ) {
        // Listen before starting: the backend can report a failure (e.g. a game pak it can't
        // read) before the call returns, and a missed event left the deploy waiting forever
        let settled = false;
        const unlisteners: (() => void)[] = [];
        const finish = () => {
            settled = true;
            unlisteners.splice(0).forEach(unlisten => {
                try {
                    unlisten();
                } catch {
                    // already gone
                }
            });
        };
        return new Promise<boolean>((resolve, reject) => {
            (async () => {
                unlisteners.push(await onceEvent('install-success', async () => {
                    if (settled) return;
                    finish();
                    resolve(true);
                }));
                unlisteners.push(await onceEvent('install-error', async (errorMsg) => {
                    if (settled) return;
                    finish();
                    await emitEvent("status-bar-percent", 0);
                    const payload = errorMsg ?? "Unknown error";
                    await emitEvent("app-error", payload as EventPayload<'app-error'>);
                    let normalized: string;
                    if (typeof payload === 'string') {
                        const raw = payload === 'Load failed' ? 'error.release_check_network' : payload;
                        const translated = t(raw);
                        normalized = translated !== raw ? translated : raw;
                    } else {
                        const { key, ...params } = payload;
                        const translated = t(key, params as Record<string, unknown>);
                        normalized = translated !== key ? translated : key;
                    }
                    reject(new Error(normalized));
                }));
                await BackendRuntimeApi.invoke('install_mods', {
                    gamePath: gamePath,
                    modListJson: modListJson,
                    skipUe4ss: skipUe4ss,
                    ue4ssZipPath: ue4ssZipPath ?? null,
                    drgZipPath: drgZipPath ?? null,
                    rcZipPath: rcZipPath ?? null,
                    compressModPak,
                });
            })().catch((error) => {
                if (settled) return;
                finish();
                reject(error);
            });
        });
    }

    public static async uninstall(gamePath: string, isDeleteUe4ss: boolean = true) {
        return await BackendRuntimeApi.invoke<boolean>('uninstall_mods', {
            gamePath: gamePath,
            isDeleteUe4ss: isDeleteUe4ss,
        });
    }

    public static async findGamePak(gameName?: string): Promise<string> {
        return await BackendRuntimeApi.invoke<string>('find_game_pak', { gameName: gameName ?? null });
    }

    /**
     * Check if game Paks directory contains .pak files that are neither game nor MintCat-generated.
     * @returns { hasForeign: boolean, fileNames: string[] } fileNames are the foreign .pak base names.
     */
    public static async checkForeignPaksInPaksDir(gamePath: string): Promise<{ hasForeign: boolean; fileNames: string[] }> {
        const fileNames = await BackendRuntimeApi.invoke<string[]>('check_foreign_paks_in_paks_dir', { gamePath });
        return { hasForeign: fileNames.length > 0, fileNames };
    }

    public static async launchGame() {
        const gameDAO = await StorageAPI.getGames();
        const activeGame = await gameDAO.getActiveGame();
        const gameName = activeGame?.name?.toLowerCase();
        const steamAppId = gameName ? STEAM_APP_IDS[gameName] ?? DEFAULT_STEAM_APP_ID : DEFAULT_STEAM_APP_ID;
        try {
            const ok = await BackendRuntimeApi.invoke<boolean>('launch_steam_game', { steamAppId });
            await logActivity(ok === false ? 'warning' : 'info', ok === false
                ? t("log.game.launchFailed", {name: activeGame?.displayName ?? "", reason: "Steam"})
                : t("log.game.launched", {name: activeGame?.displayName ?? "", id: steamAppId}), undefined, 'game');
            return ok;
        } catch (error) {
            await logActivity('error', t("log.game.launchFailed", {name: activeGame?.displayName ?? "",
                reason: error instanceof Error ? error.message : String(error)}), undefined, 'game');
            throw error;
        }
    }

    public static async checkSteamGame() {
        return await BackendRuntimeApi.invoke<boolean>('check_steam_game', {
            exeName: "FSD.exe"
        });
    }

    public static async checkInstalled(gamePath: string, installTime: number): Promise<string> {
        return await BackendRuntimeApi.invoke<string>('check_installed', {
            gamePath: gamePath,
            installTime: installTime,
        });
    }

    public static async validateZipFile(path: string): Promise<boolean> {
        return await BackendRuntimeApi.invoke<boolean>('validate_zip_file', { path });
    }

    public static async openDevTools() {
        return await invoke('open_devtools');
    }

}
