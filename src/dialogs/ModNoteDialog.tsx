/**
 * Write, change or remove your note on a mod.
 */
import React, {useEffect, useRef, useState} from "react";
import {t} from "i18next";
import {Flex, Input, Typography} from "antd";
import type {TextAreaRef} from "antd/es/input/TextArea";
import {MessageBox} from "@/components/MessageBox";
import {MAX_NOTE_LENGTH, ModNotes} from "@/services/ModNotes";

function NoteForm({initial, onChange}: { initial: string; onChange: (text: string) => void }) {
    const [text, setText] = useState(initial);
    const area = useRef<TextAreaRef>(null);
    useEffect(() => {
        // the dialog opens with an animation; focus once it's there, cursor at the end
        const timer = setTimeout(() => {
            const el = area.current?.resizableTextArea?.textArea;
            el?.focus();
            el?.setSelectionRange(el.value.length, el.value.length);
        }, 120);
        return () => clearTimeout(timer);
    }, []);
    return (
        <Flex vertical gap={6} style={{marginTop: 8}}>
            <Input.TextArea ref={area}
                            value={text}
                            maxLength={MAX_NOTE_LENGTH}
                            autoSize={{minRows: 4, maxRows: 14}}
                            placeholder={t("notes.placeholder")}
                            onChange={(e) => {
                                setText(e.target.value);
                                onChange(e.target.value);
                            }}/>
            <Typography.Text type="secondary" style={{fontSize: 12}}>{t("notes.hint")}</Typography.Text>
        </Flex>
    );
}

/** Opens the note of a mod for editing; saved on OK (an emptied note is removed) */
export async function editModNote(modId: number, modName: string): Promise<void> {
    const initial = await ModNotes.read(modId);
    let text = initial;
    const saved = await new Promise<boolean>((resolve) => {
        let done = false;
        const finish = (value: boolean) => {
            if (done) return;
            done = true;
            instance.destroy();
            resolve(value);
        };
        const instance = MessageBox.api().confirm({
            title: t(initial ? "notes.editTitle" : "notes.addTitle", {name: modName}),
            icon: null,
            width: 480,
            okText: t("notes.save"),
            cancelText: t("Cancel"),
            content: <NoteForm initial={initial} onChange={(value) => (text = value)}/>,
            onOk: () => finish(true),
            onCancel: () => finish(false),
        });
    });
    if (saved && text !== initial) await ModNotes.set(modId, text);
}

/** Removes the note after asking */
export async function removeModNote(modId: number, modName: string): Promise<void> {
    const ok = await MessageBox.confirm({
        title: t("notes.removeTitle", {name: modName}),
        content: t("notes.removeText"),
        okText: t("notes.remove"),
        okButtonProps: {danger: true},
        cancelText: t("Cancel"),
    });
    if (ok) await ModNotes.set(modId, "");
}
