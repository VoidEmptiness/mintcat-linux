/**
 * Fixes offered in the conflict details (move a mod above another, turn one off, show it in
 * the list). The mod list page registers how to do them; the conflict views only ask.
 */
import type {SuggestedAction} from "@/services/ConflictInsights";

export type ConflictActionHandler = (action: SuggestedAction) => Promise<boolean>;

let handler: ConflictActionHandler | null = null;
const closers = new Set<() => void>();

export const ConflictActions = {
    setHandler(next: ConflictActionHandler | null) {
        handler = next;
    },
    available(): boolean {
        return handler !== null;
    },
    /** Run an action; false if nothing can run it or it failed */
    async run(action: SuggestedAction): Promise<boolean> {
        if (!handler) return false;
        const ok = await handler(action);
        // Showing a mod in the list needs the dialogs out of the way
        if (ok && action.kind === 'reveal') closers.forEach(close => close());
        return ok;
    },
    /** Register a dialog to close when the user jumps to the list */
    onReveal(close: () => void): () => void {
        closers.add(close);
        return () => closers.delete(close);
    },
};
