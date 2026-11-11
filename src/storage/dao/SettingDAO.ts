import {settings} from '@/storage/db/Schema';
import {eq, and, desc, asc} from 'drizzle-orm';
import {getDb} from "@/storage/db/Client.ts";
import {
    DEFAULT_RELEASE_CHANNEL,
    normalizeReleaseChannel,
    type ReleaseChannel,
} from '@/apis/mintcat/releaseChannel';
import {
    NETWORK_MINTCAT_PROXY_MODE_KEY,
    normalizeMintcatProxyMode,
    type MintcatProxyMode,
} from '@/services/network';

const INTEGRATOR_COMPRESS_MOD_PAK_KEY = 'integrator.compressModPak';

/**
 * Settings whose changes go to the Log: "value" shows the old and new value, "changed" only
 * says it changed (long values, or ones that may hold a password like a proxy address).
 * Internal bookkeeping (hashes, caches, links) isn't logged.
 */
const LOGGED_SETTINGS: Record<string, 'value' | 'changed'> = {
    language: 'value',
    guiTheme: 'value',
    cachePath: 'value',
    configPath: 'value',
    clipboardMonitor: 'value',
    releaseChannel: 'value',
    'network.proxy': 'changed',
    'network.server_mode': 'value',
    'network.mintcat_proxy_mode': 'value',
    [INTEGRATOR_COMPRESS_MOD_PAK_KEY]: 'value',
    ue4ss: 'value',
    ue4ssVersion: 'value',
    'ui.showAdvancedSettings': 'value',
    'ui.modDescriptionOnHover': 'value',
    'ui.confirmDelete': 'value',
    'privacy.usageStats': 'value',
    'ui.titleBarLook': 'changed',
    'ui.systemIcon': 'changed',
    customModRepositories: 'changed',
};


export interface SettingData {
    id?: number;
    name: string;
    value?: string;
    createdAt?: Date;
    updatedAt?: Date;
}


export class SettingDAO {

    public async getCachePath(): Promise<string> {
        return this.getValue('cachePath');
    }

    public async setCachePath(value: string): Promise<void> {
        await this.setValue('cachePath', value);
    }

    public async getConfigPath(): Promise<string> {
        return this.getValue("configPath");
    }

    public async setConfigPath(value: string): Promise<void> {
        await this.setValue("configPath", value);
    }

    public async getLanguage(): Promise<string> {
        return this.getValue('language');
    }

    public async setLanguage(value: string): Promise<void> {
        await this.setValue('language', value);
    }

    public async getGuiTheme(): Promise<string> {
        return this.getValue('guiTheme');
    }

    public async setGuiTheme(value: string): Promise<void> {
        await this.setValue('guiTheme', value);
    }

    public async getAppVersion(): Promise<string> {
        return this.getValue('appVersion');
    }

    public async setAppVersion(value: string): Promise<void> {
        await this.setValue('appVersion', value);
    }

    public async getClipboardMonitorEnabled(): Promise<boolean> {
        const value = await this.getValue('clipboardMonitor');
        // 默认启用
        if (value === '') return true;
        return value === 'true';
    }

    public async setClipboardMonitorEnabled(enabled: boolean): Promise<void> {
        await this.setValue('clipboardMonitor', enabled ? 'true' : 'false');
    }

    public async getReleaseChannel(): Promise<ReleaseChannel> {
        const value = await this.getValue('releaseChannel');
        if (value === '') {
            return DEFAULT_RELEASE_CHANNEL;
        }
        return normalizeReleaseChannel(value);
    }

    public async setReleaseChannel(value: ReleaseChannel | string): Promise<void> {
        await this.setValue('releaseChannel', normalizeReleaseChannel(value));
    }

    public async getNetworkProxy(): Promise<string> {
        return this.getValue('network.proxy');
    }

    public async setNetworkProxy(value: string): Promise<void> {
        await this.setValue('network.proxy', value);
    }

    public async getMintcatProxyMode(): Promise<MintcatProxyMode> {
        const value = await this.getValue(NETWORK_MINTCAT_PROXY_MODE_KEY);
        return normalizeMintcatProxyMode(value);
    }

    public async setMintcatProxyMode(value: MintcatProxyMode | string): Promise<void> {
        await this.setValue(NETWORK_MINTCAT_PROXY_MODE_KEY, normalizeMintcatProxyMode(value));
    }

    public async getIntegratorCompressModPak(): Promise<boolean> {
        return await this.getValue(INTEGRATOR_COMPRESS_MOD_PAK_KEY) === 'true';
    }

    public async setIntegratorCompressModPak(enabled: boolean): Promise<void> {
        await this.setValue(INTEGRATOR_COMPRESS_MOD_PAK_KEY, enabled ? 'true' : 'false');
    }

    public async getValue(name: string): Promise<string> {
        try {
            const db = await getDb();
            const result: any[] = await db.select()
                .from(settings)
                .where(eq(settings.name, name))
                .limit(1);

            if (result.length === 0) {
                return "";
            }
            return result[0].value;
        } catch (error) {
            console.error(`根据名称获取设置失败 [名称: ${name}]:`, error);
            throw error;
        }
    }

    /** Names of all settings starting with `prefix` */
    public async namesWithPrefix(prefix: string): Promise<string[]> {
        const db = await getDb();
        const rows: any[] = await db.select({name: settings.name}).from(settings);
        return rows.map(r => String(r.name)).filter(n => n.startsWith(prefix));
    }

    public async deleteValue(name: string): Promise<void> {
        const db = await getDb();
        await db.delete(settings).where(eq(settings.name, name));
    }

    public async setValue(name: string, value: string): Promise<void> {
        const logged = LOGGED_SETTINGS[name];
        const before = logged ? await this.getValue(name).catch(() => "") : "";
        try {
            const db = await getDb();
            await db.insert(settings).values({
                name,
                value,
            }).onConflictDoUpdate({
                target: settings.name,
                set: {
                    value,
                    updatedAt: new Date(),
                }
            });
            if (logged && before !== value) {
                const {logActivity} = await import("@/services/ActivityLog");
                const {t} = await import("i18next");
                await logActivity('info', t("log.settings.changed", {name}),
                    logged === 'value' ? `${before || "—"} → ${value || "—"}` : undefined, 'settings');
            }
        } catch (error) {
            console.error(`设置值失败 [名称: ${name}]:`, error);
            throw error;
        }
    }


}


