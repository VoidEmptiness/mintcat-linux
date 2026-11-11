import React, {useEffect, useState} from "react";
import {Button, Checkbox, Flex, List, Spin} from "antd";
import {t} from "i18next";
import {ModioApi} from "@/apis/modio";
import type {ModInfo} from "@/apis/modio/ModInfo.ts";
import {ReloadOutlined} from "@ant-design/icons";
import {itemKey, type ItemFolders} from "@/dialogs/AddModDialog/ItemFolders";
import {ItemFolderSelect} from "@/dialogs/AddModDialog/ItemFolderSelect";

const PAGE_SIZE = 100;

export const SubscribedTab = React.forwardRef(({folders}: { folders?: ItemFolders }, ref) => {
    const [loading, setLoading] = useState(false);
    const [mods, setMods] = useState<ModInfo[]>([]);
    const [selectedIds, setSelectedIds] = useState<Set<number>>(new Set());

    // tell the dialog which mods will be added (for "N mod(s) go to another folder")
    const report = folders?.report;
    const selectedKeys = mods.filter(m => selectedIds.has(m.id)).map(m => itemKey.modio(m.id));
    useEffect(() => {
        report?.("modio", selectedKeys);
    }, [selectedKeys.join("\n"), report]);

    const loadSubscribed = async () => {
        setLoading(true);
        try {
            const list: ModInfo[] = [];
            let page = 0;
            let hasMore = true;
            while (hasMore) {
                const chunk = await ModioApi.getSubscribedMods(page, PAGE_SIZE);
                list.push(...chunk);
                hasMore = chunk.length >= PAGE_SIZE;
                page++;
            }
            setMods(list);
            setSelectedIds(new Set(list.map(m => m.id)));
        } finally {
            setLoading(false);
        }
    };

    useEffect(() => {
        loadSubscribed();
    }, []);

    React.useImperativeHandle(ref, () => ({
        submit: (): ModInfo[] => {
            return mods.filter(m => selectedIds.has(m.id));
        }
    }));

    const toggleOne = (id: number) => {
        setSelectedIds(prev => {
            const next = new Set(prev);
            if (next.has(id)) next.delete(id);
            else next.add(id);
            return next;
        });
    };

    const selectAll = () => setSelectedIds(new Set(mods.map(m => m.id)));
    const deselectAll = () => setSelectedIds(new Set());

    if (loading && mods.length === 0) {
        return (
            <div style={{padding: 24, textAlign: "center"}}>
                <Spin size="large"/>
                <p style={{marginTop: 12}}>{t("Loading subscribed mods...")}</p>
            </div>
        );
    }

    if (!loading && mods.length === 0) {
        return (
            <div style={{padding: 24, textAlign: "center"}}>
                <p>{t("modio.noSubscribedModsHint")}</p>
                <Button type="primary" icon={<ReloadOutlined/>} onClick={loadSubscribed} style={{marginTop: 12}}>
                    {t("Retry")}
                </Button>
            </div>
        );
    }

    return (
        <div>
            <div style={{marginBottom: 12, display: "flex", gap: 8, alignItems: "center"}}>
                <Button size="small" onClick={selectAll}>{t("Select All")}</Button>
                <Button size="small" onClick={deselectAll}>{t("Deselect All")}</Button>
                <Button size="small" icon={<ReloadOutlined/>} onClick={loadSubscribed} loading={loading}>
                    {t("Refresh")}
                </Button>
                <span style={{color: "#666", fontSize: 12}}>
                    {t("Selected")}: {selectedIds.size} / {mods.length}
                </span>
            </div>
            <List
                size="small"
                dataSource={mods}
                style={{maxHeight: window.innerHeight - 380, overflow: "auto"}}
                renderItem={(item) => (
                    <List.Item>
                        <Flex justify="space-between" align="center" gap="small" style={{width: "100%"}}>
                            <Checkbox
                                checked={selectedIds.has(item.id)}
                                onChange={() => toggleOne(item.id)}
                                style={{minWidth: 0}}
                            >
                                <span title={item.profile_url}>{item.name}</span>
                            </Checkbox>
                            {selectedIds.has(item.id) &&
                                <ItemFolderSelect folders={folders} itemKey={itemKey.modio(item.id)}/>}
                        </Flex>
                    </List.Item>
                )}
            />
        </div>
    );
});
