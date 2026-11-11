/**
 * Ask for a new folder's name and where it goes (top level or inside a folder).
 * Used where mods are added, so a mod can go straight into a folder made for it.
 */
import React, {useEffect, useRef, useState} from "react";
import {t} from "i18next";
import {Flex, Input, type InputRef, Select, Typography} from "antd";
import {MessageBox} from "@/components/MessageBox";

export interface NewFolderChoice {
    name: string;
    /** 0: top level */
    parentId: number;
}

export interface FolderPlace {
    value: number;
    label: string;
}

function NewFolderForm({folders, parentId, onChange, onEnter}: {
    folders: FolderPlace[];
    parentId: number;
    onChange: (choice: NewFolderChoice) => void;
    onEnter: () => void;
}) {
    const [name, setName] = useState("");
    const [parent, setParent] = useState(parentId);
    const input = useRef<InputRef>(null);
    useEffect(() => {
        // the dialog opens with an animation; focus once it's there
        const timer = setTimeout(() => input.current?.focus(), 120);
        return () => clearTimeout(timer);
    }, []);
    const update = (nextName: string, nextParent: number) => {
        setName(nextName);
        setParent(nextParent);
        onChange({name: nextName, parentId: nextParent});
    };
    return (
        <Flex vertical gap={10} style={{marginTop: 8}}>
            <Input ref={input}
                   value={name}
                   maxLength={80}
                   placeholder={t("newFolder.namePlaceholder")}
                   onChange={(e) => update(e.target.value, parent)}
                   onPressEnter={onEnter}/>
            <Flex vertical gap={4}>
                <Typography.Text type="secondary" style={{fontSize: 12}}>{t("newFolder.putIn")}</Typography.Text>
                <Select value={parent}
                        showSearch
                        optionFilterProp="label"
                        popupMatchSelectWidth={false}
                        onChange={(value: number) => update(name, value)}
                        options={[{value: 0, label: t("newFolder.topLevel")}, ...folders]}/>
            </Flex>
        </Flex>
    );
}

/**
 * The name and place of a new folder, or null when cancelled. `taken(name, parentId)` tells
 * whether that folder already has a subfolder (or the top level a folder) with this name.
 */
export function askNewFolder(options: {
    folders: FolderPlace[];
    parentId?: number;
    taken?: (name: string, parentId: number) => boolean;
    zIndex?: number;
}): Promise<NewFolderChoice | null> {
    return new Promise((resolve) => {
        let choice: NewFolderChoice = {name: "", parentId: options.parentId ?? 0};
        let done = false;
        const problem = (c: NewFolderChoice): string | null => {
            const name = c.name.trim();
            if (!name) return "";
            if (options.taken?.(name, c.parentId)) return t("newFolder.taken", {name});
            return null;
        };
        const finish = (value: NewFolderChoice | null) => {
            if (done) return;
            done = true;
            instance.destroy();
            resolve(value);
        };
        const tryCreate = () => {
            if (problem(choice) === null) finish({name: choice.name.trim(), parentId: choice.parentId});
        };
        const refresh = () => {
            const issue = problem(choice);
            instance.update({okButtonProps: {disabled: issue !== null}});
            setHint(issue);
        };
        let setHint: (issue: string | null) => void = () => {};
        function Hint() {
            const [issue, set] = useState<string | null>(null);
            setHint = set;
            return issue ? <Typography.Text type="danger" style={{fontSize: 12}}>{issue}</Typography.Text> : null;
        }
        const instance = MessageBox.api().confirm({
            title: t("newFolder.title"),
            icon: null,
            width: 420,
            zIndex: options.zIndex,
            okText: t("newFolder.create"),
            cancelText: t("Cancel"),
            okButtonProps: {disabled: true},
            content: (
                <Flex vertical gap={6}>
                    <NewFolderForm folders={options.folders}
                                   parentId={choice.parentId}
                                   onChange={(c) => {
                                       choice = c;
                                       refresh();
                                   }}
                                   onEnter={tryCreate}/>
                    <Hint/>
                </Flex>
            ),
            onOk: () => {
                tryCreate();
            },
            onCancel: () => finish(null),
        });
    });
}
