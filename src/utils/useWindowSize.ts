import {useSyncExternalStore} from "react";

/**
 * window.innerHeight as a hook value, so function components re-render when the page
 * really changes size (Tauri's resize event can arrive before the web view resized).
 */
function subscribe(onChange: () => void): () => void {
    window.addEventListener('resize', onChange);
    return () => window.removeEventListener('resize', onChange);
}

export function useWindowHeight(): number {
    return useSyncExternalStore(subscribe, () => window.innerHeight);
}
