import { ITask, ITaskContext, Task } from 'tauri-plugin-task-queue';
import { ProfileViewModel } from '@/dialogs/ProfileEditDialog/ProfileViewModel';
import { IoC } from '@/core/IoC.ts';
import { StorageAPI } from '@/storage';
import { exists, stat } from '@tauri-apps/plugin-fs';
import { t } from 'i18next';
import { ConflictService, ConflictModMeta, ModConflictResponse, ConflictAssetSummary } from '@/services/ConflictService';
import { flattenTreeModIds, sortByDisplayOrder } from '@/utils/ModDisplayOrder';
import { emitEvent } from '@/events';
import { BackendRuntimeApi } from '@/apis/BackendRuntimeApi';
import { loadCompleteMods } from '@/services/ModBatchLoad';

/**
 * Check if a path is a valid unpacked mod directory
 */
async function isValidUnpackedMod(dirPath: string): Promise<boolean> {
    try {
        const fileInfo = await stat(dirPath);
        if (!fileInfo.isDirectory) {
            return false;
        }
        return await BackendRuntimeApi.invoke<boolean>('is_valid_unpacked_mod', { path: dirPath });
    } catch (e) {
        return false;
    }
}

/** Assets (.uasset/.umap based) shared by two or more mods, for the part-by-part comparison */
function sharedAssets(conflicts: ModConflictResponse[]): { assetPath: string; modIds: number[] }[] {
    const byAsset = new Map<string, Set<number>>();
    for (const conflict of conflicts) {
        for (const file of conflict.conflicting_files) {
            const match = /^(.*)\.(uasset|umap)$/i.exec(file);
            if (!match) continue;
            const set = byAsset.get(match[1]) ?? new Set<number>();
            set.add(conflict.mod_id);
            byAsset.set(match[1], set);
        }
    }
    return Array.from(byAsset.entries())
        .filter(([, mods]) => mods.size > 1)
        .map(([assetPath, mods]) => ({assetPath, modIds: Array.from(mods)}));
}

/**
 * Input structure for conflict check API
 */
interface ConflictCheckModInfo {
    mod_id: number;
    cache_path: string;
    is_unpacked: boolean;
}

/**
 * Task: Check mod file conflicts
 * 
 * This task detects file path conflicts between enabled mods in the current profile.
 * A conflict occurs when multiple mods contain files with the same path.
 * 
 * Steps:
 * 1. Load enabled mod list from current profile
 * 2. Filter mods that have valid cache paths
 * 3. Call backend to analyze pak files
 * 4. Store and display conflict results
 */
@Task({
    type: 'mod_conflict_check',
    name: t('Mod conflict check'),
    description: t('conflict.detectBetweenMods'),
    schema: null,
    estimatedDuration: 30
})
export class ModConflictCheckTask implements ITask {
    async run(context: ITaskContext): Promise<void> {
        const TOTAL_STEPS = 4;

        // Step 1: Load enabled mod list
        await context.setStep(t('Load mod list'), 1, TOTAL_STEPS);
        await context.setMessage(t('Loading mod list...'));

        const profileVM = await IoC.get(ProfileViewModel);
        const profilesDAO = await StorageAPI.getProfiles();
        const gameDAO = await StorageAPI.getGames();

        const activeProfileData = await profileVM.getActiveProfileData();
        if (!activeProfileData || !activeProfileData.id) {
            throw new Error(t('No active profile'));
        }

        const activeGame = await gameDAO.getGameById(activeProfileData.gameId);
        const gameName = activeGame?.name ?? undefined;
        // The game's own pak: tells files that replace game files from files mods add, and
        // lets each mod's version of a shared file be compared with the game's original
        const gamePakPath = activeGame?.installPath || undefined;

        // Get enabled mods from profile
        const profileMods = await profilesDAO.getProfileMods(activeProfileData.id);
        const displayOrder = flattenTreeModIds(await profileVM.getActiveProfileTreeRoot());
        const enabledProfileMods = sortByDisplayOrder(
            profileMods.filter(pm => pm.isEnabled),
            displayOrder,
            pm => pm.modId
        );

        if (enabledProfileMods.length === 0) {
            await context.setMessage(t('No enabled mods'));
            ConflictService.clearAll();
            await context.updateProgress(100);
            return;
        }

        await context.setMessage(`${t('Found')} ${enabledProfileMods.length} ${t('enabled mods')}`);
        await context.updateProgress(20);

        // Step 2: Prepare mod info for conflict check
        await context.setStep(t('Prepare mod data'), 2, TOTAL_STEPS);
        
        const modInfoList: ConflictCheckModInfo[] = [];
        const modMeta = new Map<number, ConflictModMeta>();
        // Same rule as ModInstallTask: big Audio-tagged paks are copied as their own pak
        const AUDIO_TAG = 'Audio';
        const AUDIO_DIRECT_COPY_MIN_SIZE = 10 * 1024 * 1024;
        
        // all at once (4 queries instead of 4 per mod)
        const loaded = new Map((await loadCompleteMods(enabledProfileMods.map(pm => pm.modId))).map(m => [m.modId, m]));
        for (let i = 0; i < enabledProfileMods.length; i++) {
            if (context.checkCancelled()) {
                throw new Error('Task cancelled');
            }

            const pm = enabledProfileMods[i];
            const modData = loaded.get(pm.modId);
            
            if (!modData) {
                continue;
            }

            const cachePath = modData.download?.cachePath || '';
            
            // Skip mods without cache path
            if (!cachePath) {
                continue;
            }

            // Check if path exists
            const pathExists = await exists(cachePath);
            if (!pathExists) {
                continue;
            }

            // Check if it's an unpacked mod
            const isUnpacked = await isValidUnpackedMod(cachePath);

            modInfoList.push({
                mod_id: modData.modId!,
                cache_path: cachePath,
                is_unpacked: isUnpacked,
            });
            modMeta.set(modData.modId!, {
                name: modData.displayName || modData.nameId || `#${modData.modId}`,
                audioOnly: !isUnpacked
                    && (modData.tags?.includes(AUDIO_TAG) ?? false)
                    && (modData.download?.fileSize ?? 0) >= AUDIO_DIRECT_COPY_MIN_SIZE,
            });

            await context.setMessage(`${t('Preparing')} (${i + 1}/${enabledProfileMods.length}): ${modData.displayName}`);
        }

        if (modInfoList.length < 2) {
            await context.setMessage(t('conflict.notEnoughMods'));
            ConflictService.clearAll();
            await context.updateProgress(100);
            return;
        }

        await context.updateProgress(40);

        // Step 3: Call backend to check conflicts
        await context.setStep(t('Check file conflicts'), 3, TOTAL_STEPS);
        await context.setMessage(`${t('Analyzing')} ${modInfoList.length} ${t('mods')}...`);

        try {
            const conflicts = await BackendRuntimeApi.invoke<ModConflictResponse[]>('check_mod_conflicts', {
                modListJson: JSON.stringify(modInfoList),
                gameName: gameName ?? null,
                gamePakPath: gamePakPath ?? null,
            });

            await context.updateProgress(80);

            // Step 4: Process results
            await context.setStep(t('Process results'), 4, TOTAL_STEPS);

            if (conflicts.length === 0) {
                await context.setMessage(t('No conflicts detected'));
                ConflictService.clearAll();
            } else {
                // Store conflicts in service
                ConflictService.setConflicts(conflicts, modMeta);
                const conflicting = new Set(conflicts.map(c => c.mod_id));
                ConflictService.setDiffContext({
                    gameName,
                    gamePakPath,
                    mods: modInfoList.filter(m => conflicting.has(m.mod_id)),
                });

                // What each mod changes in the shared assets, compared to the game: tells
                // copies that make the same changes from ones that change different parts
                // (could work together) or the same parts (a real clash)
                await context.setMessage(t('conflict.comparingChanges'));
                const assets = sharedAssets(conflicts);
                if (assets.length > 0) {
                    try {
                        const summaries = await BackendRuntimeApi.invoke<ConflictAssetSummary[]>('conflict_assets_summary', {
                            gameName: gameName ?? null,
                            gamePakPath: gamePakPath ?? null,
                            mods: modInfoList.filter(m => conflicting.has(m.mod_id))
                                .map(m => ({modId: m.mod_id, cachePath: m.cache_path, isUnpacked: m.is_unpacked})),
                            assets,
                        });
                        ConflictService.setAssetSummaries(summaries);
                    } catch (error) {
                        // Only the extra detail is missing; the file-level results stand
                        console.warn('Comparing shared assets failed:', error);
                    }
                }
                
                const conflictCount = conflicts.length;
                await context.setMessage(`${t('Detected')} ${conflictCount} ${t('mods with conflicts')}`);
                
                // Emit global event to refresh UI
                emitEvent('mod-conflict-check-complete', { 
                    hasConflicts: true, 
                    count: conflictCount 
                });
            }

        } catch (error) {
            console.error('Conflict check failed:', error);
            throw new Error(`${t('Conflict check failed')}: ${error}`);
        }

        await context.updateProgress(100);
    }
}
