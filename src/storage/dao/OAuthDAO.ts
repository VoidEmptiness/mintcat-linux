import {oauths} from '@/storage/db/Schema';
import {eq, and, desc, asc} from 'drizzle-orm';
import {getDb} from "@/storage/db/Client.ts";
import {StorageAPI} from "@/storage";
import {KEYRING_MARKER, SecretStore} from "@/services/SecretStore";

/**
 * OAuth信息数据访问层
 * 负责OAuth认证相关的数据库操作
 *
 * Keys go to the system keyring when there is one; the table then holds KEYRING_MARKER in their
 * place, and every read here fills the real key back in.
 */

export interface OAuthData {
    id?: number;
    uid: number;
    oauth: string;
    platform: string;
    createdAt?: Date;
    updatedAt?: Date;
}

export class OAuthDAO {

    /**
     * 获取所有OAuth记录
     */
    public async getAllOAuths(): Promise<OAuthData[]> {
        try {
            const db = await getDb();
            const result = await db.select().from(oauths).orderBy(desc(oauths.createdAt));
            return await this.revealAll(result.map(this.mapToOAuthData));
        } catch (error) {
            console.error('获取所有OAuth记录失败:', error);
            throw error;
        }
    }

    /**
     * 根据ID获取OAuth记录
     */
    public async getOAuthById(id: number): Promise<OAuthData | null> {
        try {
            const db = await getDb();
            const result = await db.select().from(oauths).where(eq(oauths.id, id)).limit(1);
            return result.length > 0 ? await this.reveal(this.mapToOAuthData(result[0])) : null;
        } catch (error) {
            console.error(`获取OAuth记录失败 [ID: ${id}]:`, error);
            throw error;
        }
    }

    /**
     * 根据UID获取OAuth记录
     */
    public async getOAuthByUid(uid: number): Promise<OAuthData | null> {
        try {
            const db = await getDb();
            const result = await db.select().from(oauths).where(eq(oauths.uid, uid)).limit(1);
            return result.length > 0 ? await this.reveal(this.mapToOAuthData(result[0])) : null;
        } catch (error) {
            console.error(`根据UID获取OAuth记录失败 [UID: ${uid}]:`, error);
            throw error;
        }
    }

    /**
     * 根据平台获取OAuth记录
     */
    public async getOAuthsByPlatform(platform: string): Promise<OAuthData[]> {
        try {
            const db = await getDb();
            const result = await db.select().from(oauths)
                .where(eq(oauths.platform, platform))
                .orderBy(desc(oauths.createdAt));
            return await this.revealAll(result.map(this.mapToOAuthData));
        } catch (error) {
            console.error(`根据平台获取OAuth记录失败 [平台: ${platform}]:`, error);
            throw error;
        }
    }

    /**
     * 根据UID和平台获取OAuth记录
     */
    public async getOAuthByUidAndPlatform(uid: number, platform: string): Promise<OAuthData | null> {
        try {
            const db = await getDb();
            const result = await db.select().from(oauths)
                .where(and(eq(oauths.uid, uid), eq(oauths.platform, platform)))
                .limit(1);
            return result.length > 0 ? await this.reveal(this.mapToOAuthData(result[0])) : null;
        } catch (error) {
            console.error(`根据UID和平台获取OAuth记录失败 [UID: ${uid}, 平台: ${platform}]:`, error);
            throw error;
        }
    }

    /**
     * 创建OAuth记录
     */
    public async createOAuth(oauthData: Omit<OAuthData, 'id' | 'createdAt' | 'updatedAt'>): Promise<OAuthData | null> {
        try {
            const db = await getDb();
            const result = await db.insert(oauths).values({
                uid: oauthData.uid,
                oauth: oauthData.oauth,
                platform: oauthData.platform,
            }).returning();

            return result.length > 0 ? await this.reveal(this.mapToOAuthData(result[0])) : null;
        } catch (error) {
            console.error('创建OAuth记录失败:', error);
            throw error;
        }
    }

    /**
     * 更新OAuth记录
     */
    public async updateOAuth(id: number, oauthData: Partial<Omit<OAuthData, 'id' | 'createdAt' | 'updatedAt'>>): Promise<boolean> {
        try {
            const db = await getDb();
            const updateData: any = {};

            if (oauthData.uid !== undefined) updateData.uid = oauthData.uid;
            if (oauthData.platform !== undefined) updateData.platform = oauthData.platform;
            if (oauthData.oauth !== undefined || oauthData.uid !== undefined || oauthData.platform !== undefined) {
                const rows = await db.select().from(oauths).where(eq(oauths.id, id)).limit(1);
                const current = rows[0];
                if (!current) return false;
                const uid = oauthData.uid ?? current.uid;
                const platform = oauthData.platform ?? current.platform;
                const moved = uid !== current.uid || platform !== current.platform;
                let value = oauthData.oauth;
                if (value === undefined && moved) {
                    value = (await this.reveal(this.mapToOAuthData(current))).oauth;
                }
                if (moved && current.oauth === KEYRING_MARKER) {
                    await SecretStore.remove(current.uid, current.platform);
                }
                if (value !== undefined) {
                    updateData.oauth = await this.storeSecret(uid, platform, value);
                }
            }

            updateData.updatedAt = new Date();

            await db.update(oauths)
                .set(updateData)
                .where(eq(oauths.id, id));

            return true;
        } catch (error) {
            console.error(`更新OAuth记录失败 [ID: ${id}]:`, error);
            return false;
        }
    }

    /**
     * 更新或创建OAuth记录（Upsert）
     * 根据 uid + platform 组合进行唯一性判断
     */
    public async upsertOAuth(uid: number, platform: string, oauth: string): Promise<OAuthData | null> {
        try {
            // 查找 (uid, platform) 组合的现有记录
            const existing = await this.getOAuthByUidAndPlatform(uid, platform);

            if (existing) {
                // 更新现有记录
                const success = await this.updateOAuth(existing.id!, {oauth});
                return success ? await this.getOAuthById(existing.id!) : null;
            }

            // 不存在则创建新记录
            // 注意：不再查找相同 uid 或相同 platform 的其他记录进行覆盖
            // 每个 (uid, platform) 组合应该是独立的
            return await this.createOAuth({uid, platform, oauth});
        } catch (error) {
            console.error(`更新或创建OAuth记录失败 [UID: ${uid}, 平台: ${platform}]:`, error);
            return null;
        }
    }

    /**
     * 删除OAuth记录
     */
    public async deleteOAuth(id: number): Promise<boolean> {
        try {
            const db = await getDb();
            await this.forgetSecrets(await db.select().from(oauths).where(eq(oauths.id, id)));
            await db.delete(oauths).where(eq(oauths.id, id));
            return true;
        } catch (error) {
            console.error(`删除OAuth记录失败 [ID: ${id}]:`, error);
            return false;
        }
    }

    /**
     * 根据UID删除OAuth记录
     */
    public async deleteOAuthByUid(uid: number): Promise<boolean> {
        try {
            const db = await getDb();
            await this.forgetSecrets(await db.select().from(oauths).where(eq(oauths.uid, uid)));
            await db.delete(oauths).where(eq(oauths.uid, uid));
            return true;
        } catch (error) {
            console.error(`根据UID删除OAuth记录失败 [UID: ${uid}]:`, error);
            return false;
        }
    }

    /**
     * 根据平台删除OAuth记录
     */
    public async deleteOAuthByPlatform(platform: string): Promise<boolean> {
        try {
            const db = await getDb();
            await this.forgetSecrets(await db.select().from(oauths).where(eq(oauths.platform, platform)));
            await db.delete(oauths).where(eq(oauths.platform, platform));
            return true;
        } catch (error) {
            console.error(`根据平台删除OAuth记录失败 [平台: ${platform}]:`, error);
            return false;
        }
    }

    /**
     * 根据UID和平台删除OAuth记录
     */
    public async deleteOAuthByUidAndPlatform(uid: number, platform: string): Promise<boolean> {
        try {
            const db = await getDb();
            await this.forgetSecrets(await db.select().from(oauths)
                .where(and(eq(oauths.uid, uid), eq(oauths.platform, platform))));
            await db.delete(oauths).where(and(eq(oauths.uid, uid), eq(oauths.platform, platform)));
            return true;
        } catch (error) {
            console.error(`根据UID和平台删除OAuth记录失败 [UID: ${uid}, 平台: ${platform}]:`, error);
            return false;
        }
    }

    /**
     * 验证OAuth令牌是否有效（基本检查）
     */
    public async isOAuthValid(oauth: string): Promise<boolean> {
        try {
            // 确保返回的是布尔值
            return Boolean(oauth && oauth.trim().length > 0);
        } catch (error) {
            console.error('验证OAuth令牌失败:', error);
            return false;
        }
    }

    /**
     * 获取当前活跃用户指定平台的 OAuth 记录
     * @param platform 平台名称 (如 'mod.io', 'mintcat' 等)
     */
    public async getActiveUserOAuthByPlatform(platform: string): Promise<OAuthData | null> {
        try {
            const userDAO = await StorageAPI.getUsers();
            const activeUserData = await userDAO.getActiveUser();
            if (!activeUserData?.id) {
                return null;
            }

            const db = await getDb();
            const result = await db.select()
                .from(oauths)
                .where(and(eq(oauths.platform, platform), eq(oauths.uid, activeUserData.id)))
                .limit(1);

            return result.length > 0 ? await this.reveal(this.mapToOAuthData(result[0])) : null;
        } catch (error) {
            console.error(`获取当前活跃用户的 ${platform} OAuth记录失败:`, error);
            return null;
        }
    }

    /**
     * 获取OAuth统计信息
     */
    public async getOAuthStats(): Promise<{ total: number, byPlatform: Record<string, number> }> {
        try {
            const db = await getDb();
            const all = await db.select().from(oauths);

            const byPlatform: Record<string, number> = {};
            all.forEach(record => {
                byPlatform[record.platform] = (byPlatform[record.platform] || 0) + 1;
            });

            return {
                total: all.length,
                byPlatform
            };
        } catch (error) {
            console.error('获取OAuth统计信息失败:', error);
            return {total: 0, byPlatform: {}};
        }
    }

    /**
     * Move keys still kept as plain text in the table into the keyring (once per start; keys
     * stay where they are when there's no keyring). Returns how many were moved.
     */
    public async moveKeysToKeyring(): Promise<number> {
        const db = await getDb();
        const rows = await db.select().from(oauths);
        let moved = 0;
        for (const row of rows) {
            const value = row.oauth ?? '';
            if (!value.trim() || value === KEYRING_MARKER) continue;
            if (!await SecretStore.put(row.uid, row.platform, value)) break; // no keyring: try next start
            await db.update(oauths).set({oauth: KEYRING_MARKER}).where(eq(oauths.id, row.id));
            moved++;
        }
        return moved;
    }

    /** What to keep in the table for this key: the marker once the keyring has it, else the key */
    private async storeSecret(uid: number, platform: string, value: string): Promise<string> {
        if (!value || !value.trim()) {
            await SecretStore.remove(uid, platform);
            return '';
        }
        return await SecretStore.put(uid, platform, value) ? KEYRING_MARKER : value;
    }

    private async reveal(data: OAuthData): Promise<OAuthData> {
        if (data.oauth !== KEYRING_MARKER) return data;
        return {...data, oauth: (await SecretStore.get(data.uid, data.platform)) ?? ''};
    }

    private async revealAll(list: OAuthData[]): Promise<OAuthData[]> {
        return await Promise.all(list.map((data) => this.reveal(data)));
    }

    private async forgetSecrets(rows: { uid: number; platform: string; oauth: string | null }[]): Promise<void> {
        for (const row of rows) {
            if (row.oauth === KEYRING_MARKER) await SecretStore.remove(row.uid, row.platform);
        }
    }

    /**
     * 将数据库记录映射为OAuthData对象
     */
    private mapToOAuthData(record: any): OAuthData {
        return {
            id: record.id,
            uid: record.uid,
            oauth: record.oauth,
            platform: record.platform,
            createdAt: record.createdAt,
            updatedAt: record.updatedAt,
        };
    }
}
