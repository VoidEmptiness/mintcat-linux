/**
 * Small shared stores for the mod list:
 *  - InstallOrder: every mod's position in install order (top of the list = 1 = wins conflicts)
 *  - ListDisplayOptions: viewer preferences such as showing local mods' file paths
 */
import {useSyncExternalStore} from "react";

type Listener = () => void;

function createSignal() {
    const listeners = new Set<Listener>();
    let version = 0;
    return {
        notify() {
            version++;
            listeners.forEach(l => {
                try {
                    l();
                } catch (e) {
                    console.error('[ListDisplay] listener failed', e);
                }
            });
        },
        subscribe(l: Listener) {
            listeners.add(l);
            return () => listeners.delete(l);
        },
        version: () => version,
    };
}

const orderSignal = createSignal();
let order: number[] = [];
let positions = new Map<number, number>();

export const InstallOrder = {
    /** Mod ids in the order they install (see utils/ModDisplayOrder) */
    set(ids: number[]) {
        const same = ids.length === order.length && ids.every((id, i) => order[i] === id);
        if (same) return;
        order = [...ids];
        positions = new Map(order.map((id, i) => [id, i + 1]));
        orderSignal.notify();
    },
    get(): number[] {
        return order;
    },
    /** 1-based install position, or undefined if unknown */
    position(modId: number): number | undefined {
        return positions.get(modId);
    },
    subscribe: orderSignal.subscribe,
};

export function useInstallOrderVersion(): number {
    return useSyncExternalStore(orderSignal.subscribe, orderSignal.version);
}

/** The install order array (a new array whenever the order changes) */
export function useInstallOrder(): number[] {
    return useSyncExternalStore(orderSignal.subscribe, () => order);
}

const SHOW_PATHS_KEY = 'mintcat-show-local-paths';
const displaySignal = createSignal();
let showLocalPaths = (() => {
    try {
        return localStorage.getItem(SHOW_PATHS_KEY) === '1';
    } catch {
        return false;
    }
})();

export const ListDisplayOptions = {
    showLocalPaths(): boolean {
        return showLocalPaths;
    },
    setShowLocalPaths(value: boolean) {
        if (value === showLocalPaths) return;
        showLocalPaths = value;
        try {
            localStorage.setItem(SHOW_PATHS_KEY, value ? '1' : '0');
        } catch {
            // remembered for this session only
        }
        displaySignal.notify();
    },
    subscribe: displaySignal.subscribe,
};

export function useShowLocalPaths(): boolean {
    return useSyncExternalStore(displaySignal.subscribe, () => showLocalPaths);
}

// ---------- newest game version among the list's mod.io mods ----------

const gameVersionSignal = createSignal();
let latestGameVersion: string | undefined;

/** "1.39" < "1.40" < "1.40.1" (numbers compared part by part) */
export function compareGameVersions(a: string, b: string): number {
    const pa = a.replace(/^v/i, "").split(".").map(Number);
    const pb = b.replace(/^v/i, "").split(".").map(Number);
    for (let i = 0; i < Math.max(pa.length, pb.length); i++) {
        const d = (pa[i] || 0) - (pb[i] || 0);
        if (d !== 0) return d;
    }
    return 0;
}

/** The newest of these versions (undefined for none) */
export function newestGameVersion(versions: string[]): string | undefined {
    let newest: string | undefined;
    for (const v of versions) {
        if (!/^v?\d+(\.\d+)+$/i.test(v.trim())) continue;
        if (!newest || compareGameVersions(v.trim(), newest) > 0) newest = v.trim();
    }
    return newest;
}

/**
 * mod.io tags Deep Rock mods with the game versions they're made for. The newest of those among
 * your mod.io mods counts as the current game version (instead of a number written into the app).
 */
export const GameVersions = {
    setLatest(value: string | undefined) {
        if (value === latestGameVersion) return;
        latestGameVersion = value;
        gameVersionSignal.notify();
    },
    latest(_version?: number): string | undefined {
        return latestGameVersion;
    },
    subscribe: gameVersionSignal.subscribe,
    version: gameVersionSignal.version,
};
