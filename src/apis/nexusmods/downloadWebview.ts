import { message } from 'antd';
import { t } from 'i18next';
import { listenEvent, type UnlistenFn } from '@/events';
import { NexusModsApi } from './index';
import type { EventPayload } from '@/events';
import type { NexusModsParsedUrl } from './types';
import { ControlPlaneApi } from '@/apis/ControlPlaneApi';
import { BackendRuntimeApi } from '@/apis/BackendRuntimeApi';

export type NexusDownloadCapturedPayload = EventPayload<'nexus-download-captured'>;

/**
 * Longest wait for a download from the window. The window stays open while the user logs in or
 * picks a file, and closing it ends the wait right away, so this is only a safety net.
 */
const DEFAULT_CAPTURE_TIMEOUT_MS = 20 * 60_000;

/** The user closed the Nexus window before a download started (nothing went wrong) */
export class NexusDownloadWindowClosedError extends Error {
    constructor() {
        super(t('nexusmods.windowClosed'));
        this.name = 'NexusDownloadWindowClosedError';
    }
}

export interface OpenNexusDownloadWebviewOptions {
    profileUrl: string;
    domain: string;
    modId: number;
    fileId?: number;
    /** Nexus's id of the game, when known */
    gameId?: number;
    autoStart?: boolean;
}

export interface CaptureNexusDownloadUrlOptions {
    parsed?: NexusModsParsedUrl;
    /** Nexus's id of the game, when known (the window then needn't search the page for it) */
    gameId?: number;
    timeoutMs?: number;
    showMessage?: boolean;
}

/** Opens (or brings back) the Nexus window for this file; returns the window's label */
export async function openNexusDownloadWebview(options: OpenNexusDownloadWebviewOptions): Promise<string> {
    const request = await BackendRuntimeApi.invoke<Record<string, unknown>>('open_nexus_download_webview', {
        pageUrl: buildNexusModFilesPageUrl(options.domain, options.modId, options.fileId),
        profileUrl: options.profileUrl,
        domain: options.domain,
        modId: options.modId,
        fileId: options.fileId,
        gameId: options.gameId,
        autoStart: options.autoStart ?? true,
    });
    await ControlPlaneApi.invoke('open_managed_webview', request);
    return String(request.label ?? '');
}

/** Same rule as the backend uses for window labels */
function sanitizeLabel(value: string): string {
    return value.replace(/[^A-Za-z0-9_-]/g, '-');
}

export async function captureNexusDownloadUrl(
    url: string,
    options: CaptureNexusDownloadUrlOptions = {},
): Promise<string> {
    const parsed = options.parsed ?? NexusModsApi.parseModLinks(url);
    if (!parsed) {
        throw new Error(t('Invalid Mod Link'));
    }

    const target = await resolveNexusDownloadTarget(parsed);

    return new Promise((resolve, reject) => {
        const unlisteners: UnlistenFn[] = [];
        let completed = false;
        let windowLabel = '';
        const timeoutId = window.setTimeout(() => {
            cleanup();
            reject(new Error(t('nexusmods.captureTimeout')));
        }, options.timeoutMs ?? DEFAULT_CAPTURE_TIMEOUT_MS);

        const cleanup = () => {
            if (completed) {
                return false;
            }
            completed = true;
            window.clearTimeout(timeoutId);
            unlisteners.splice(0).forEach((unlisten) => unlisten());
            return true;
        };

        Promise.all([
            listenEvent('nexus-download-captured', async (payload) => {
                if (!isMatchingNexusDownloadCapture(payload, target)) {
                    return;
                }
                if (cleanup()) {
                    resolve(buildAddModUrlFromCapturedNexusDownload(payload));
                }
            }),
            // The window also closes itself after a capture; that event comes second
            listenEvent('managed-webview-closed', async (payload) => {
                if (!windowLabel || sanitizeLabel(payload.label) !== windowLabel) {
                    return;
                }
                // let a capture sent just before the close be handled first
                window.setTimeout(() => {
                    if (cleanup()) {
                        reject(new NexusDownloadWindowClosedError());
                    }
                }, 300);
            }),
        ]).then(async (listeners) => {
            unlisteners.push(...listeners);
            if (completed) {
                unlisteners.splice(0).forEach((unlisten) => unlisten());
                return;
            }
            windowLabel = sanitizeLabel(await openNexusDownloadWebview({
                profileUrl: url,
                domain: target.domain,
                modId: target.modId,
                fileId: target.fileId,
                gameId: options.gameId,
                autoStart: true,
            }));
            if (options.showMessage ?? true) {
                message.info(t('nexusmods.webviewAutoOpened'));
            }
        }).catch((error) => {
            if (cleanup()) {
                reject(error);
            }
        });
    });
}

export function isNexusDownloadWindowClosed(error: unknown): boolean {
    return error instanceof NexusDownloadWindowClosedError;
}

export function buildAddModUrlFromCapturedNexusDownload(payload: NexusDownloadCapturedPayload): string {
    if (payload.source !== 'cdn') {
        return payload.url;
    }

    try {
        const url = new URL(payload.url);
        const hash = new URLSearchParams(url.hash.replace(/^#/, ''));
        hash.set('mintcat_domain', payload.domain);
        hash.set('mintcat_mod_id', String(payload.modId));
        if (payload.fileId) {
            hash.set('mintcat_file_id', String(payload.fileId));
        }
        hash.set('mintcat_profile_url', payload.profileUrl);
        url.hash = hash.toString();
        return url.toString();
    } catch {
        return payload.url;
    }
}

export function isMatchingNexusDownloadCapture(
    payload: NexusDownloadCapturedPayload,
    parsed: Pick<NexusModsParsedUrl, 'domain' | 'modId' | 'fileId'>,
): boolean {
    if (payload.domain.toLowerCase() !== parsed.domain.toLowerCase()) {
        return false;
    }
    if (payload.modId !== parsed.modId) {
        return false;
    }
    if (parsed.fileId && payload.fileId && payload.fileId !== parsed.fileId) {
        return false;
    }
    return true;
}

export async function resolveNexusDownloadTarget(parsed: NexusModsParsedUrl): Promise<NexusModsParsedUrl> {
    if (parsed.fileId) {
        return parsed;
    }

    try {
        const files = await NexusModsApi.getModFiles(parsed.domain, parsed.modId);
        const file = NexusModsApi.pickDownloadableFile(files);
        const fileId = NexusModsApi.getFileId(file);
        if (fileId) {
            return { ...parsed, fileId };
        }
    } catch (error) {
        console.warn('[NexusModsWebview] Failed to resolve preferred file before opening WebView:', error);
    }

    return parsed;
}

function buildNexusModFilesPageUrl(domain: string, modId: number, fileId?: number): string {
    const url = new URL(NexusModsApi.getModFilesUrl(domain, modId));
    if (fileId) {
        url.searchParams.set('file_id', String(fileId));
    }
    return url.toString();
}

