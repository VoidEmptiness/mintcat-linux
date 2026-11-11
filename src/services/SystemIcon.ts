/**
 * The picked app icon outside MINTCAT's own title bar: the window icon (used by window lists on
 * X11, Windows and others) and, on Linux, the icon of the menu entry an AppImage manager such as
 * Shelly made for this AppImage (KDE Plasma on Wayland takes the taskbar icon from that entry).
 * See src-tauri/src/system_icon.rs for what is changed in the entry and how it is undone.
 *
 * Applied when the icon is picked and again at every start, so an entry the AppImage manager
 * wrote again (e.g. after an update) gets the picked icon back. Can be turned off in the picker.
 */
import {invoke} from "@tauri-apps/api/core";
import {platform} from "@tauri-apps/plugin-os";
import {StorageAPI} from "@/storage";

const KEY = "ui.systemIcon";
const MENU_ICON_SIZE = 256;
const WINDOW_ICON_SIZE = 64;

export interface SystemIconStatus {
    entries: string[];
    custom: number;
}

function isLinux(): boolean {
    try {
        return platform() === "linux";
    } catch {
        return false;
    }
}

/** Draw a picture (data URL, SVG or PNG) centered on a transparent square */
async function drawSquare(src: string, size: number): Promise<HTMLCanvasElement> {
    const img = new Image();
    await new Promise<void>((resolve, reject) => {
        img.onload = () => resolve();
        img.onerror = () => reject(new Error("icon could not be drawn"));
        img.src = src;
    });
    const canvas = document.createElement("canvas");
    canvas.width = size;
    canvas.height = size;
    const ctx = canvas.getContext("2d");
    if (!ctx) throw new Error("icon could not be drawn");
    const w = img.naturalWidth || size;
    const h = img.naturalHeight || size;
    const scale = Math.min(size / w, size / h);
    const dw = w * scale;
    const dh = h * scale;
    ctx.imageSmoothingQuality = "high";
    ctx.drawImage(img, (size - dw) / 2, (size - dh) / 2, dw, dh);
    return canvas;
}

async function pngBytes(src: string, size: number): Promise<number[]> {
    const canvas = await drawSquare(src, size);
    const blob = await new Promise<Blob | null>((resolve) => canvas.toBlob(resolve, "image/png"));
    if (!blob) throw new Error("icon could not be drawn");
    return Array.from(new Uint8Array(await blob.arrayBuffer()));
}

export const SystemIcon = {
    /** Whether the menu entry should follow the picked icon (on unless turned off) */
    async menuEntryEnabled(): Promise<boolean> {
        try {
            return (await (await StorageAPI.getSettings()).getValue(KEY)) !== "off";
        } catch {
            return true;
        }
    },

    async setMenuEntryEnabled(enabled: boolean): Promise<void> {
        await (await StorageAPI.getSettings()).setValue(KEY, enabled ? "on" : "off");
    },

    /** Menu entries found for this AppImage (Linux, started as an AppImage), else null */
    async status(): Promise<SystemIconStatus | null> {
        if (!isLinux()) return null;
        try {
            return await invoke<SystemIconStatus>("system_icon_status");
        } catch (e) {
            console.warn("[SystemIcon] status failed", e);
            return null;
        }
    },

    /**
     * Use `src` (undefined = MINTCAT's own icon) for the window and, when allowed, the menu entry.
     * Returns the menu entry status, or throws with the reason when changing the entry failed.
     */
    async apply(src: string | undefined): Promise<SystemIconStatus | null> {
        try {
            if (src) {
                const canvas = await drawSquare(src, WINDOW_ICON_SIZE);
                const pixels = canvas.getContext("2d")!.getImageData(0, 0, WINDOW_ICON_SIZE, WINDOW_ICON_SIZE).data;
                await invoke("set_window_icon", {rgba: Array.from(pixels), width: WINDOW_ICON_SIZE, height: WINDOW_ICON_SIZE});
            } else {
                await invoke("set_window_icon", {rgba: [], width: 0, height: 0});
            }
        } catch (e) {
            console.warn("[SystemIcon] window icon not changed", e);
        }

        if (!isLinux()) return null;
        if (src && await SystemIcon.menuEntryEnabled()) {
            return await invoke<SystemIconStatus>("system_icon_apply", {png: await pngBytes(src, MENU_ICON_SIZE)});
        }
        return await invoke<SystemIconStatus>("system_icon_restore");
    },

    /** At start: put the picked icon (back) on the window and the menu entry */
    async syncAtStart(src: string | undefined): Promise<void> {
        if (!src) {
            // nothing picked: only undo an entry left changed (e.g. the setting was reset)
            const status = await SystemIcon.status();
            if (status && status.custom > 0) {
                await invoke("system_icon_restore").catch(e => console.warn("[SystemIcon] restore failed", e));
            }
            return;
        }
        await SystemIcon.apply(src).catch(e => console.warn("[SystemIcon] could not apply the app icon", e));
    },
};
