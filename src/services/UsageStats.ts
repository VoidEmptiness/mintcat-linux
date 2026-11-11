/**
 * Upstream MINTCAT loads umami.is page-view statistics (app starts and pages opened, with the
 * screen size, language, system and country umami records). It's a setting now: on by default
 * in upstream builds, off in builds with an edition label. A change applies at the next start
 * (a loaded tracker can't be unloaded).
 */
import {StorageAPI} from "@/storage";
import {BuildInfo} from "@/buildInfo";

const KEY = "privacy.usageStats";
const SCRIPT_SRC = "https://cloud.umami.is/script.js";
const WEBSITE_ID = "9aec0f7e-1022-4d9a-80fb-c02d758f1b3c";
export const USAGE_STATS_DEFAULT = !BuildInfo.edition;

export const UsageStats = {
    async isEnabled(): Promise<boolean> {
        try {
            const value = await (await StorageAPI.getSettings()).getValue(KEY);
            return value ? value === "true" : USAGE_STATS_DEFAULT;
        } catch {
            return USAGE_STATS_DEFAULT;
        }
    },

    async setEnabled(enabled: boolean): Promise<void> {
        await (await StorageAPI.getSettings()).setValue(KEY, enabled ? "true" : "false");
    },

    /** Add the tracker when the setting allows it (once, at start) */
    async start(): Promise<void> {
        if (!(await UsageStats.isEnabled())) return;
        if (document.querySelector(`script[src="${SCRIPT_SRC}"]`)) return;
        const script = document.createElement("script");
        script.defer = true;
        script.src = SCRIPT_SRC;
        script.dataset.websiteId = WEBSITE_ID;
        document.body.appendChild(script);
    },
};
