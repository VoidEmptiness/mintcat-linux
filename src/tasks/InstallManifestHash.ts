import { stat } from '@tauri-apps/plugin-fs';
import type { CompleteModData } from '@/storage/dao/ModDAO';
import { md5 } from '@/utils/CryptApi';
import { BackendRuntimeApi } from '@/apis/BackendRuntimeApi';

type FileInfo = Awaited<ReturnType<typeof stat>>;

/** The file's info, or null when there is no path or it can't be read */
async function statOrNull(filePath: string): Promise<FileInfo | null> {
    if (!filePath) return null;
    try {
        return await stat(filePath);
    } catch {
        return null; /* file missing or inaccessible */
    }
}

function sizeAndMtime(info: FileInfo | null): { size: number; mtime: number } {
    return info ? { size: info.size ?? 0, mtime: info.mtime?.getTime() ?? 0 } : { size: 0, mtime: 0 };
}

/** `fn` over `items` with at most `limit` running at once; results in the items' order */
async function mapLimited<T, R>(items: T[], limit: number, fn: (item: T) => Promise<R>): Promise<R[]> {
    const results = new Array<R>(items.length);
    let next = 0;
    const worker = async () => {
        while (next < items.length) {
            const i = next++;
            results[i] = await fn(items[i]);
        }
    };
    await Promise.all(Array.from({ length: Math.min(limit, items.length) }, worker));
    return results;
}

/**
 * Compute a deterministic hash from the full set of install inputs.
 * Any change in the mod list, cache files, UE4SS mode, or asset zips
 * produces a different hash, automatically triggering reinstallation.
 *
 * The list's "unsaved changes" mark runs this after every change, so it reads each mod's file
 * once (it used to ask three times, one mod after another: seconds with a few hundred mods).
 * The result is the same as before, so hashes saved by older builds still match.
 */
export async function computeInstallManifestHash(
    enabledMods: CompleteModData[],
    ue4ssEnabled: boolean,
    compressModPak: boolean = false,
    assetPaths?: { ue4ssZipPath?: string; drgZipPath?: string; rcZipPath?: string } | null
): Promise<string> {
    const modEntries = await mapLimited(enabledMods, 16, async mod => {
        const cachePath = mod.download?.cachePath || "";
        const info = await statOrNull(cachePath);
        const { size, mtime } = sizeAndMtime(info);
        let isUnpacked = false;
        if (info?.isDirectory) {
            try {
                isUnpacked = await BackendRuntimeApi.invoke<boolean>('is_valid_unpacked_mod', { path: cachePath });
            } catch {
                isUnpacked = false;
            }
        }
        return {
            modId: mod.modId,
            nameId: mod.nameId || "",
            cachePath,
            fileSize: size,
            mtime,
            isUnpacked,
        };
    });

    const ue4ssZipPath = ue4ssEnabled ? assetPaths?.ue4ssZipPath || "" : "";
    const [ue4ssStat, drgStat, rcStat] = (await Promise.all([
        statOrNull(ue4ssZipPath),
        statOrNull(assetPaths?.drgZipPath || ""),
        statOrNull(assetPaths?.rcZipPath || ""),
    ])).map(sizeAndMtime);

    const manifest = {
        mods: modEntries,
        ue4ssMode: ue4ssEnabled ? "Enabled" : "Disabled",
        ...(compressModPak ? { compressModPak } : {}),
        ue4ssZip: { path: ue4ssZipPath, ...ue4ssStat },
        drgZip:   { path: assetPaths?.drgZipPath || "",   ...drgStat },
        rcZip:    { path: assetPaths?.rcZipPath || "",     ...rcStat },
    };
    return md5(JSON.stringify(manifest));
}
