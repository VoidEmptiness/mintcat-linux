/**
 * While a mod or folder is dragged, scroll the list when the pointer is near (or past) its top or
 * bottom edge. The list doesn't scroll by itself during a drag, so rows further away couldn't be
 * reached. After each step a dragover is sent at the pointer, so the tree's drop target follows
 * the rows that moved under it even when the pointer stands still.
 */
export class DragAutoScroll {
    /** Distance from the edge (px) where scrolling starts */
    private static readonly ZONE = 72;
    /** Speeds are in px per 1/60 s, so a faster screen doesn't scroll faster */
    private static readonly MIN_SPEED = 2;
    private static readonly MAX_SPEED = 30;
    private static readonly MAX_SPEED_OUTSIDE = 70;
    /** Holding at an edge speeds it up: after this long (ms)... */
    private static readonly ACCEL_AFTER = 500;
    /** ...up to this many times as fast, reached this much later (ms) */
    private static readonly ACCEL_MAX = 2.5;
    private static readonly ACCEL_RAMP = 2000;
    /** Never faster than this (px per 1/60 s) */
    private static readonly TOP_SPEED = 120;
    private static readonly FRAME_MS = 1000 / 60;

    private active = false;
    private speed = 0;
    private frame = 0;
    private lastTime = 0;
    /** When scrolling in the current direction began (0: not scrolling) */
    private heldSince = 0;
    /** Where the list is being scrolled to (fractional; the list itself keeps whole pixels) */
    private pos: number | null = null;
    private x = 0;
    private y = 0;
    private lastTarget: Element | null = null;
    /** The last dragenter WebKit sent: a dragleave right after it at the same spot is part of it */
    private lastEnter: { x: number; y: number; time: number } | null = null;
    /** The dragged row's element */
    private source: EventTarget | null = null;

    /**
     * @param holder the list's scrolling element
     * @param scrollTo scrolls the list through its own state, and renders before returning, so
     *   the rows under the pointer are current when the tree is told about them. Writing the
     *   element's scrollTop instead races the list's own scroll handling and stutters.
     */
    constructor(private readonly holder: () => HTMLElement | null,
                private readonly scrollTo: (top: number) => void) {}

    /** @param source the element being dragged */
    start(source?: EventTarget | null) {
        // still running: the end of the last drag was missed, so start over for this one
        if (this.active) this.stop();
        this.active = true;
        this.heldSince = 0;
        // Once the dragged row has scrolled out of the list it is removed from the page, and its
        // dragend no longer reaches the document; it still reaches the element itself
        this.source = source ?? null;
        this.source?.addEventListener("dragend", this.stop);
        this.speed = 0;
        this.pos = null;
        this.lastTarget = null;
        this.lastEnter = null;
        // WebKit sends dragenter instead of dragover when the pointer reaches another element
        document.addEventListener("dragenter", this.onDragOver, true);
        document.addEventListener("dragover", this.onDragOver, true);
        document.addEventListener("dragleave", this.onDragLeave, true);
        document.addEventListener("drop", this.stop, true);
        document.addEventListener("dragend", this.stop, true);
        // Mouse events don't say whether the drag is over: on KDE Plasma (Wayland) the page gets
        // mouseout/mousemove with no button pressed while dragging and before the drop
    }

    stop = (e?: Event) => {
        if (!this.active) return;
        this.active = false;
        this.halt();
        const source = this.source;
        this.source = null;
        source?.removeEventListener("dragend", this.stop);
        document.removeEventListener("dragenter", this.onDragOver, true);
        document.removeEventListener("dragover", this.onDragOver, true);
        document.removeEventListener("dragleave", this.onDragLeave, true);
        document.removeEventListener("drop", this.stop, true);
        document.removeEventListener("dragend", this.stop, true);
        // The dragend reached only the removed row: the tree didn't see it either
        const missedDragEnd = !!e && e.type === "dragend" && e.currentTarget === source
            && !(source as Node | null)?.isConnected;
        if (missedDragEnd) {
            // The tree didn't see the drag end either and would keep the row marked as dragged;
            // it listens for this on the window
            window.dispatchEvent(new Event("dragend"));
        }
    };

    /** Stop scrolling until the next dragover near an edge */
    private halt() {
        this.speed = 0;
        this.heldSince = 0;
        if (this.frame) cancelAnimationFrame(this.frame);
        this.frame = 0;
    }

    /** Speed for a pointer at (x, y): negative scrolls up, 0 outside the edge zones */
    static speedFor(rect: { left: number; right: number; top: number; bottom: number; height: number }, x: number, y: number): number {
        if (x < rect.left - 80 || x > rect.right + 80) return 0;
        const zone = Math.min(DragAutoScroll.ZONE, rect.height / 4);
        if (zone <= 0) return 0;
        const {MIN_SPEED, MAX_SPEED, MAX_SPEED_OUTSIDE} = DragAutoScroll;
        const ramp = (depth: number) => depth > zone
            // past the edge: faster the further out, up to the outside maximum
            ? Math.min(MAX_SPEED_OUTSIDE, MAX_SPEED + (depth - zone) / 2)
            : Math.max(MIN_SPEED, Math.round(MAX_SPEED * depth / zone));
        if (y < rect.top + zone) return -ramp(rect.top + zone - y);
        if (y > rect.bottom - zone) return ramp(y - (rect.bottom - zone));
        return 0;
    }

    /** How much faster after holding at an edge for `heldMs` */
    static acceleration(heldMs: number): number {
        const {ACCEL_AFTER, ACCEL_MAX, ACCEL_RAMP} = DragAutoScroll;
        if (heldMs <= ACCEL_AFTER) return 1;
        return 1 + (ACCEL_MAX - 1) * Math.min(1, (heldMs - ACCEL_AFTER) / ACCEL_RAMP);
    }

    /**
     * Next scroll position: `speed` px per 1/60 s over `elapsed` ms (capped, so a stalled frame
     * doesn't jump), kept within 0..max
     */
    static nextPosition(pos: number, speed: number, elapsed: number, max: number): number {
        const frames = Math.min(Math.max(elapsed, 0), 3 * DragAutoScroll.FRAME_MS) / DragAutoScroll.FRAME_MS;
        return Math.min(Math.max(pos + speed * frames, 0), Math.max(max, 0));
    }

    private onDragOver = (e: DragEvent) => {
        // The list's own edge scrolling (rc-virtual-list) leaves alone events a nested list has
        // taken over. Take them all, so the two don't scroll at once.
        (e as DragEvent & { _virtualHandled?: boolean })._virtualHandled = true;
        if (!e.isTrusted) return; // our own synthetic dragover below
        if (e.type === "dragenter") this.lastEnter = {x: e.clientX, y: e.clientY, time: performance.now()};
        // WebKitGTK's first dragenter of a drag has no position (0, 0)
        if (e.clientX === 0 && e.clientY === 0) return;
        const holder = this.holder();
        if (!holder) return;
        this.x = e.clientX;
        this.y = e.clientY;
        const speed = DragAutoScroll.speedFor(holder.getBoundingClientRect(), e.clientX, e.clientY);
        // turning around starts the speed-up again
        if (Math.sign(speed) !== Math.sign(this.speed)) this.heldSince = 0;
        this.speed = speed;
        if (this.speed === 0) {
            this.halt();
        } else if (!this.frame) {
            this.lastTime = 0;
            this.pos = null;
            this.frame = requestAnimationFrame(this.step);
        }
    };

    private onDragLeave = (e: DragEvent) => {
        if (!e.isTrusted) return;
        // WebKit sends dragenter on the new element and then dragleave on the old one, both at
        // the pointer. A dragleave on its own means the drag left the window or was cancelled.
        const enter = this.lastEnter;
        const partOfMove = !!enter && enter.x === e.clientX && enter.y === e.clientY
            && performance.now() - enter.time < 100;
        if (!partOfMove) {
            this.halt();
            return;
        }
        // Every dragleave has a null relatedTarget in WebKit, also when the pointer only moved
        // from one part of a row to another (the name, the switch, the number). The tree takes
        // that for leaving the row and forgets where the drop would go, so the drop line
        // vanished and letting go there did nothing. While the pointer is over the list, the
        // dragenter just before has already told the tree where it is.
        const holder = this.holder();
        if (holder && DragAutoScroll.inside(holder.getBoundingClientRect(), e.clientX, e.clientY)) {
            e.stopPropagation();
        }
    };

    static inside(rect: { left: number; right: number; top: number; bottom: number }, x: number, y: number): boolean {
        return x >= rect.left && x < rect.right && y >= rect.top && y < rect.bottom;
    }

    private step = (now: number) => {
        this.frame = 0;
        const holder = this.holder();
        if (!this.active || !holder || this.speed === 0) return;
        const elapsed = this.lastTime ? now - this.lastTime : DragAutoScroll.FRAME_MS;
        this.lastTime = now;
        const actual = holder.scrollTop;
        // start from where the list is, also when something else scrolled it meanwhile
        if (this.pos === null || Math.abs(actual - this.pos) > 3 * DragAutoScroll.ACCEL_MAX * Math.abs(this.speed) + 32) this.pos = actual;
        const max = holder.scrollHeight - holder.clientHeight;
        if (!this.heldSince) this.heldSince = now;
        const speed = Math.sign(this.speed) * Math.min(DragAutoScroll.TOP_SPEED,
            Math.abs(this.speed) * DragAutoScroll.acceleration(now - this.heldSince));
        const next = DragAutoScroll.nextPosition(this.pos, speed, elapsed, max);
        if (Math.round(next) === Math.round(this.pos) && (next <= 0 || next >= max)) {
            // at the top or bottom: tell the tree about the last rows, then wait for the next
            // dragover to start again
            this.pos = next;
            this.heldSince = 0;
            this.pokeTree();
            return;
        }
        this.pos = next;
        this.scrollTo(Math.round(next));
        this.pokeTree();
        this.frame = requestAnimationFrame(this.step);
    };

    /** Tell the tree the pointer is now over whatever row scrolled under it */
    private pokeTree() {
        const target = document.elementFromPoint(this.x, this.y);
        if (!target || !this.holder()?.contains(target)) return;
        const init = {bubbles: true, cancelable: true, clientX: this.x, clientY: this.y};
        const make = (type: string): Event => {
            try {
                return new DragEvent(type, init);
            } catch {
                return new MouseEvent(type, init);
            }
        };
        if (target !== this.lastTarget) {
            this.lastTarget = target;
            target.dispatchEvent(make("dragenter"));
        }
        target.dispatchEvent(make("dragover"));
    }
}
