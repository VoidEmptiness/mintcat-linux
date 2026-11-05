import { App, Button, Modal } from "antd";
import type { ModalFuncProps } from "antd/es/modal/interface";
import React from "react";

/** 由 MessageBoxThemeBridge 注入，用于在 ConfigProvider/App 上下文中弹出确认框以跟随主题 */
let themedModal: ReturnType<typeof App.useApp>["modal"] | null = null;

export function setMessageBoxThemedModal(modal: ReturnType<typeof App.useApp>["modal"] | null) {
    themedModal = modal;
}

export class MessageBox {

    /** The themed modal API (for dialogs that update their own buttons) */
    static api(): Pick<typeof Modal, "confirm"> {
        return themedModal ?? Modal;
    }

    /** Themed information dialog (closes with OK); returns a handle to close it from code */
    static info(props: ModalFuncProps): { destroy: () => void } {
        return (themedModal ?? Modal).info(props);
    }

    static async confirm(props: ModalFuncProps): Promise<boolean> {
        return new Promise((resolve) => {
            const run = (api: { confirm: (p: ModalFuncProps) => ReturnType<typeof Modal.confirm> }) => {
                api.confirm({
                    ...props,
                    onOk: () => {
                        props.onOk?.();
                        resolve(true);
                    },
                    onCancel: () => {
                        props.onCancel?.();
                        resolve(false);
                    },
                });
            };
            if (themedModal) {
                run(themedModal);
            } else {
                run(Modal);
            }
        });
    }


    /**
     * Themed question with several answers: resolves with the key of the button clicked, or
     * null when closed or cancelled
     */
    static async choose(props: ModalFuncProps, choices: { key: string; label: string; danger?: boolean; primary?: boolean }[],
                        cancelText: string): Promise<string | null> {
        return new Promise((resolve) => {
            let done = false;
            let instance: { destroy: () => void } | null = null;
            const finish = (value: string | null) => {
                if (done) return;
                done = true;
                resolve(value);
                instance?.destroy();
            };
            const footer = React.createElement("div", {style: {display: "flex", justifyContent: "flex-end", gap: 8, flexWrap: "wrap", marginTop: 16}},
                React.createElement(Button, {key: "cancel", onClick: () => finish(null)}, cancelText),
                ...choices.map(c => React.createElement(Button, {
                    key: c.key,
                    type: c.primary ? "primary" : "default",
                    danger: c.danger,
                    onClick: () => finish(c.key),
                }, c.label)));
            instance = (themedModal ?? Modal).confirm({
                ...props,
                footer,
                onCancel: () => finish(null),
            });
        });
    }

}

/** 在 App 内挂载一次，使 MessageBox.confirm 使用 AntdApp 的 modal，从而跟随 ConfigProvider 主题 */
export function MessageBoxThemeBridge() {
    const { modal } = App.useApp();
    React.useEffect(() => {
        setMessageBoxThemedModal(modal);
        return () => setMessageBoxThemedModal(null);
    }, [modal]);
    return null;
}


