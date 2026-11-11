import React from "react";
import {getCurrentWindow} from "@tauri-apps/api/window";
import {ActivityLog} from "@/services/ActivityLog";

/** Re-render checks after Tauri reports a resize, in case the web view resizes later */
const RESIZE_FOLLOW_UPS_MS = [120, 400, 1000];

export abstract class BasePage<P, S> extends React.Component<P, S> {
    private isHooked: boolean = false;
    private unsubscribeLogPanel?: () => void;
    private unlistenTauriResize?: () => void;
    private resizeFrame = 0;
    private resizeTimers: ReturnType<typeof setTimeout>[] = [];
    private lastRenderedSize = "";

    /** Re-render once per frame when the page's size really changed */
    private readonly onViewportResize = () => {
        if (!this.isHooked || this.resizeFrame) return;
        this.resizeFrame = requestAnimationFrame(() => {
            this.resizeFrame = 0;
            if (!this.isHooked) return;
            const size = `${window.innerWidth}x${window.innerHeight}`;
            if (size === this.lastRenderedSize) return;
            this.lastRenderedSize = size;
            this.forceUpdate();
        });
    };

    protected hookWindowResized() {
        if (this.isHooked) {
            return;
        }
        this.isHooked = true;
        this.lastRenderedSize = `${window.innerWidth}x${window.innerHeight}`;

        // Pages size themselves from window.innerHeight. Tauri's resize event can arrive before
        // the web view has its new size (seen on Linux when maximizing or going fullscreen),
        // which left the old height in place until something else redrew the page. The page's
        // own resize event fires once the new size is in effect, so listen to both.
        window.addEventListener('resize', this.onViewportResize);
        try {
            getCurrentWindow().onResized(() => {
                this.onViewportResize();
                this.resizeTimers.forEach(clearTimeout);
                this.resizeTimers = RESIZE_FOLLOW_UPS_MS.map(ms => setTimeout(this.onViewportResize, ms));
            }).then(unlisten => {
                if (this.isHooked) this.unlistenTauriResize = unlisten;
                else unlisten();
            }).catch(() => {
            });
        } catch (e) {
            // not running inside Tauri (tests); the DOM listener still works
        }
    }

    protected unhookWindowResized() {
        this.isHooked = false;
        window.removeEventListener('resize', this.onViewportResize);
        this.unlistenTauriResize?.();
        this.unlistenTauriResize = undefined;
        this.resizeTimers.forEach(clearTimeout);
        this.resizeTimers = [];
        if (this.resizeFrame) cancelAnimationFrame(this.resizeFrame);
        this.resizeFrame = 0;
    }

    /** Re-render when the bottom Log panel opens/closes (it takes height from the page) */
    protected hookLogPanel() {
        if (this.unsubscribeLogPanel) {
            return;
        }
        this.unsubscribeLogPanel = ActivityLog.subscribeOpen(() => this.forceUpdate());
    }

    protected unhookLogPanel() {
        this.unsubscribeLogPanel?.();
        this.unsubscribeLogPanel = undefined;
    }

    /** Height taken by the open Log panel */
    protected get logPanelOffset(): number {
        return ActivityLog.getPanelOffset();
    }
}
