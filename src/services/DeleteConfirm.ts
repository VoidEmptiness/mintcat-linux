/**
 * "Ask before deleting" (Settings, on by default): every delete in the app asks first, unless
 * the user turned that off, then deletes happen right away.
 */
import type {ModalFuncProps} from "antd/es/modal/interface";
import {t} from "i18next";
import {StorageAPI} from "@/storage";
import {MessageBox} from "@/components/MessageBox";

export const CONFIRM_DELETE_KEY = "ui.confirmDelete";

let enabled = true;
let loaded = false;
const listeners = new Set<() => void>();

function notify() {
    listeners.forEach(listener => listener());
}

async function load(): Promise<boolean> {
    if (loaded) return enabled;
    try {
        const value = await (await StorageAPI.getSettings()).getValue(CONFIRM_DELETE_KEY);
        enabled = value !== "false";
    } catch {
        enabled = true;
    }
    loaded = true;
    notify();
    return enabled;
}

export const DeleteConfirm = {
    init: load,
    /** Current value for React (useSyncExternalStore) */
    isEnabled(): boolean {
        return enabled;
    },
    subscribe(listener: () => void): () => void {
        listeners.add(listener);
        return () => listeners.delete(listener);
    },
    async enabled(): Promise<boolean> {
        return load();
    },
    async setEnabled(value: boolean): Promise<void> {
        enabled = value;
        loaded = true;
        notify();
        await (await StorageAPI.getSettings()).setValue(CONFIRM_DELETE_KEY, value ? "true" : "false");
    },
};

/**
 * Ask before deleting; true right away when the user turned confirmations off.
 * Defaults to a red "Delete" button.
 */
export async function confirmDelete(props: ModalFuncProps): Promise<boolean> {
    if (!(await DeleteConfirm.enabled())) return true;
    return MessageBox.confirm({
        okText: t("Delete"),
        cancelText: t("Cancel"),
        ...props,
        okButtonProps: {danger: true, ...(props.okButtonProps ?? {})},
    });
}
