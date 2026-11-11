import {readText} from "@tauri-apps/plugin-clipboard-manager";
import {invoke} from "@tauri-apps/api/core";

/**
 * @param again the text is the same as before, but it was copied again (seen through the
 *   system's clipboard notifications, where available)
 */
export type ClipboardWatcherCallback = (text: string, again: boolean) => void;

export class ClipboardApi {

    private static isHook = false;

    private static lastClipboardText = "";

    private static intervalId: ReturnType<typeof setInterval> | null = null;

    private static watcherCallback: ClipboardWatcherCallback | null = null;

    private static isWriting = false;

    /** How many times the system says the clipboard was set (null: it can't tell) */
    private static lastChangeCount: number | null = null;

    /** When MINTCAT itself last wrote to the clipboard */
    private static writtenAt = 0;

    private static async changeCount(): Promise<number | null> {
        try {
            return await invoke<number | null>("clipboard_change_count");
        } catch {
            return null;
        }
    }

    /**
     * 安全读取剪切板文本，当剪切板为空或内容非文本格式时返回空字符串而不抛异常
     */
    private static async safeReadText(): Promise<string> {
        try {
            return await readText();
        } catch {
            // 剪切板为空或内容非文本格式（如图片），属于正常情况，静默处理
            return "";
        }
    }

    public static setLastClipboardText(text: string) {
        this.lastClipboardText = text;
    }

    /**
     * 写入剪贴板并同步 lastClipboardText，写入期间抑制监听器以避免竞态触发
     */
    public static async writeText(text: string) {
        this.isWriting = true;
        this.writtenAt = Date.now();
        this.lastClipboardText = text;
        try {
            await navigator.clipboard.writeText(text);
            const readBack = await this.safeReadText();
            if (readBack) {
                this.lastClipboardText = readBack;
            }
        } finally {
            this.writtenAt = Date.now();
            this.isWriting = false;
        }
    }

    public static async setClipboardWatcher(callback: ClipboardWatcherCallback) {
        this.watcherCallback = callback;

        if (this.isHook) {
            return;
        }
        this.isHook = true;

        this.lastClipboardText = await this.safeReadText();
        this.lastChangeCount = await this.changeCount();
        this.intervalId = setInterval(async () => {
            if (this.isWriting) return;
            const count = await this.changeCount();
            const text = await this.safeReadText();
            if (this.isWriting) return;
            const copiedAgain = count !== null && this.lastChangeCount !== null && count !== this.lastChangeCount;
            this.lastChangeCount = count;
            if (Date.now() - this.writtenAt < 1500) {
                // MINTCAT's own copy (e.g. Copy List)
                this.lastClipboardText = text || this.lastClipboardText;
                return;
            }
            if (text && text !== this.lastClipboardText) {
                this.lastClipboardText = text;
                callback(text, false);
            } else if (text && copiedAgain) {
                callback(text, true);
            }
        }, 1000);
    }

    public static stopClipboardWatcher() {
        if (this.intervalId !== null) {
            clearInterval(this.intervalId);
            this.intervalId = null;
        }
        this.isHook = false;
    }

    public static async restartClipboardWatcher() {
        if (this.watcherCallback) {
            await this.setClipboardWatcher(this.watcherCallback);
        }
    }

}