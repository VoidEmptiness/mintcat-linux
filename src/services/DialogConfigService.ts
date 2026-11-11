import { remove } from "@tauri-apps/plugin-fs";
import { openPath } from "@tauri-apps/plugin-opener";
import { MigrationBase } from "@/storage/migration";
import { ConfigMigrationV2 } from "@/storage/migration/ConfigMigrationV2";
import { ConfigMigrationV3 } from "@/storage/migration/ConfigMigrationV3";
import { ConfigMigrationV4 } from "@/storage/migration/ConfigMigrationV4";
import type { ConfigDataType } from "@/storage/DataType";
import { getDb } from "@/storage/db/Client";
import { profiles, profileFolders, profileMods } from "@/storage/db/Schema";
import { eq, inArray, ne } from "drizzle-orm";

export class DialogConfigService {
    public async getExistingConfigList() {
        return await MigrationBase.getExistingConfigList();
    }

    public async deleteConfigPath(path: string): Promise<void> {
        await remove(path, { recursive: true });
    }

    public async openPath(path: string): Promise<void> {
        await openPath(path);
    }

    public async importConfig(config: ConfigDataType): Promise<boolean> {
        if (!config) 
            return false;
        
        let success = false;
        // Remember what existed before, so a failed import only undoes its own additions
        const before = await this.snapshotProfiles();
        
        try {
            if (config.version === "0.4") {
                const v4 = new ConfigMigrationV4();
                success = await v4.migrate();
            } else if (config.version === "0.3") {
                const v3 = new ConfigMigrationV3();
                success = await v3.migrate();
            } else if (config.version === "0.2") {
                const v2 = new ConfigMigrationV2();
                success = await v2.migrate();
            } else {
                success = await MigrationBase.migrateConfig();
            }
        } catch (error) {
            console.error('[DialogConfigService] 导入配置时发生错误:', error);
            success = false;
        }
        
        // 如果导入失败，清理本次导入新建的配置方案，避免出现不完整的分组
        if (!success && before) {
            console.log('[DialogConfigService] 导入失败，清理部分数据...');
            await this.cleanupPartialData(before);
        }
        
        return success;
    }

    private async snapshotProfiles(): Promise<{ ids: number[]; activeId?: number } | null> {
        try {
            const db = await getDb();
            const rows = await db.select({id: profiles.id, isActive: profiles.isActive}).from(profiles);
            return {ids: rows.map(r => r.id), activeId: rows.find(r => r.isActive)?.id};
        } catch (error) {
            console.error('[DialogConfigService] could not read profiles before import:', error);
            return null;
        }
    }

    /**
     * After a failed import, remove only the profiles it created (with their folders and mod
     * links) and switch back to the profile that was active before. Profiles, mods and logins
     * that existed before the import are left alone.
     */
    private async cleanupPartialData(before: { ids: number[]; activeId?: number }): Promise<void> {
        try {
            const db = await getDb();
            const now = await db.select({id: profiles.id}).from(profiles);
            const created = now.map(r => r.id).filter(id => !before.ids.includes(id));
            if (created.length > 0) {
                await db.delete(profileMods).where(inArray(profileMods.profileId, created));
                await db.delete(profileFolders).where(inArray(profileFolders.profileId, created));
                await db.delete(profiles).where(inArray(profiles.id, created));
                console.log(`[DialogConfigService] removed ${created.length} profile(s) from the failed import`);
            }
            if (before.activeId != null) {
                await db.update(profiles).set({isActive: false}).where(ne(profiles.id, before.activeId));
                await db.update(profiles).set({isActive: true}).where(eq(profiles.id, before.activeId));
            }
        } catch (error) {
            console.error('[DialogConfigService] 清理部分数据失败:', error);
        }
    }
}
