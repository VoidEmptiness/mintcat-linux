/**
 * Performance tracing for test builds only (VITE_PERF_TRACE=1). Writes "[perf]" lines to
 * the log: main-thread stalls (gaps between animation frames), backend calls per command,
 * and named marks. Does nothing in normal builds.
 */
const enabled = import.meta.env.VITE_PERF_TRACE === "1";

type Counts = Record<string, number>;
let invokeCounts: Counts = {};
let stalls: number[] = [];
let frames = 0;
let lastFrame = 0;
let rawLog: ((...args: unknown[]) => void) | null = null;

function emit(line: string) {
    // console.log is forwarded to the log file by LogApi
    (rawLog ?? console.log)(`[perf] ${line}`);
}

export function perfMark(name: string, detail?: string) {
    if (!enabled) return;
    emit(`mark ${name} t=${performance.now().toFixed(0)}${detail ? " " + detail : ""}`);
}

/** Log how long until the next two frames have been painted (≈ when the change is visible) */
export function perfUntilPainted(name: string) {
    if (!enabled) return;
    const start = performance.now();
    requestAnimationFrame(() => requestAnimationFrame(() => {
        emit(`painted ${name} ${(performance.now() - start).toFixed(0)}ms t=${performance.now().toFixed(0)}`);
    }));
}

/** Count backend calls. `invoke` is read-only, so put a counting layer in front of the bridge. */
function countInvokes() {
    const w = window as any;
    const internals = w.__TAURI_INTERNALS__;
    if (!internals?.invoke) return;
    const original = internals.invoke.bind(internals);
    const counting = (cmd: string, ...rest: unknown[]) => {
        if (cmd !== "plugin:log|log") invokeCounts[cmd] = (invokeCounts[cmd] ?? 0) + 1;
        return original(cmd, ...rest);
    };
    const layer = Object.create(internals);
    Object.defineProperty(layer, "invoke", {value: counting, writable: true, configurable: true});
    const desc = Object.getOwnPropertyDescriptor(w, "__TAURI_INTERNALS__");
    if (desc && !desc.writable && !desc.configurable) {
        emit("invoke counting unavailable: bridge is locked");
        return;
    }
    Object.defineProperty(w, "__TAURI_INTERNALS__", {value: layer, writable: true, configurable: true});
}

export function initPerfTrace() {
    if (!enabled) return;
    try {
        startTrace();
    } catch (e) {
        console.warn("[perf] trace failed to start", e);
    }
}

function startTrace() {
    rawLog = console.log.bind(console);
    try {
        countInvokes();
    } catch (e) {
        emit(`invoke counting unavailable: ${e}`);
    }
    const loop = (t: number) => {
        if (lastFrame) {
            const gap = t - lastFrame;
            if (gap > 50) stalls.push(gap);
        }
        lastFrame = t;
        frames++;
        requestAnimationFrame(loop);
    };
    requestAnimationFrame(loop);
    setInterval(() => {
        const calls = Object.entries(invokeCounts).sort((a, b) => b[1] - a[1]);
        const total = calls.reduce((n, [, v]) => n + v, 0);
        if (total === 0 && stalls.length === 0) {
            frames = 0;
            return;
        }
        const top = calls.slice(0, 6).map(([k, v]) => `${k.replace(/^plugin:/, "")}=${v}`).join(" ");
        const stallSum = stalls.reduce((a, b) => a + b, 0);
        emit(`window frames=${frames} stalls=${stalls.length} stallMs=${stallSum.toFixed(0)} maxStall=${(stalls.length ? Math.max(...stalls) : 0).toFixed(0)} invokes=${total} ${top}`);
        invokeCounts = {};
        stalls = [];
        frames = 0;
    }, 2000);
    emit("trace on");
}
