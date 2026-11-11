import packageJson from "../package.json";

/**
 * Optional edition label for custom builds, set at build time:
 *   VITE_APP_EDITION="Linux+" VITE_APP_BUILD="4" pnpm tauri build
 * Without them the title bar shows the upstream name and version.
 */
const edition = (import.meta.env.VITE_APP_EDITION as string | undefined)?.trim() || "";
const build = (import.meta.env.VITE_APP_BUILD as string | undefined)?.trim() || "";

export const BuildInfo = {
    /** Shown after "MINTCAT", e.g. "Linux+" (empty for upstream builds) */
    edition,
    /** e.g. "v0.6.0 · build 4"; undefined means use the upstream channel format */
    customVersion: build ? `v${packageJson.version} · build ${build}` : undefined,
    /** Window title for custom builds, e.g. "MINTCAT Linux+" */
    windowTitle: edition ? `MINTCAT ${edition}` : undefined,
};
