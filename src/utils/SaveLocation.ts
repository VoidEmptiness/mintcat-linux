import {downloadDir, homeDir, join} from "@tauri-apps/api/path";

/**
 * Full default path for a save dialog. With only a file name the dialog opens in the process's
 * working folder, which for an AppImage is its read-only mount; start in Downloads instead.
 */
export async function defaultSaveLocation(fileName: string): Promise<string> {
    for (const dir of [downloadDir, homeDir]) {
        try {
            const base = await dir();
            if (base) return await join(base, fileName);
        } catch {
            // try the next folder
        }
    }
    return fileName;
}
