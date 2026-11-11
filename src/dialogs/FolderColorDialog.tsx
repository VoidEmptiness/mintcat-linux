/**
 * Right-click a folder → Folder color: pick a swatch or any color; the folder bar takes the
 * color and the mods inside get a stripe of it. Mounted once with the mod list.
 */
import React, {useSyncExternalStore} from "react";
import {Button, ColorPicker, Flex, Modal, Typography} from "antd";
import {FolderOutlined} from "@ant-design/icons";
import {t} from "i18next";
import {COLOR_PRESETS, ModListAppearance, readableTextOn} from "@/services/ModListAppearance";
import {logActivity} from "@/services/ActivityLog";

export function FolderColorDialog() {
    const version = useSyncExternalStore(ModListAppearance.subscribe, ModListAppearance.version);
    const editing = ModListAppearance.editing(version);
    const keys = editing?.keys ?? (editing ? [editing.key] : []);
    const names = editing?.names ?? (editing ? [editing.name] : []);
    // several folders: their color when they all have the same one
    const colors = new Set(keys.map(k => ModListAppearance.folderColor(k, version)));
    const current = colors.size === 1 ? [...colors][0] : undefined;
    const [color, setColor] = React.useState<string | undefined>(current);

    React.useEffect(() => {
        setColor(current);
        // eslint-disable-next-line react-hooks/exhaustive-deps
    }, [editing?.key, keys.length]);

    if (!editing) return null;

    const apply = async (value: string | null) => {
        await ModListAppearance.setFolderColors(keys, value);
        if (names.length > 1) {
            await logActivity('info', value ? t("log.list.foldersColor", {count: names.length, color: value}) : t("log.list.foldersColorRemoved", {count: names.length}),
                names.join(", "), 'list');
        } else {
            const name = names[0] ?? "";
            await logActivity('info', value ? t("log.list.folderColor", {name, color: value}) : t("log.list.folderColorRemoved", {name}), undefined, 'list');
        }
        ModListAppearance.closeFolderColor();
    };

    return (
        <Modal open
               title={keys.length > 1 ? t("folderColor.titleMany", {count: keys.length}) : t("folderColor.title", {name: editing.name})}
               width={420}
               onCancel={() => ModListAppearance.closeFolderColor()}
               footer={
                   <Flex justify="space-between">
                       <Button onClick={() => apply(null)} disabled={!keys.some(k => ModListAppearance.folderColor(k, version)) && !color}>
                           {t("folderColor.remove")}
                       </Button>
                       <Flex gap={8}>
                           <Button onClick={() => ModListAppearance.closeFolderColor()}>{t("Cancel")}</Button>
                           <Button type="primary" disabled={!color} onClick={() => apply(color ?? null)}>
                               {t("folderColor.apply")}
                           </Button>
                       </Flex>
                   </Flex>
               }>
            <Flex vertical gap={14}>
                {/* Preview of the folder bar */}
                <Flex vertical gap={4}>
                    {names.slice(0, 6).map((name, i) => (
                        <span key={i} style={{
                            display: "block",
                            padding: "2px 8px",
                            borderRadius: 6,
                            backgroundColor: color ?? "rgba(238,238,238,0.2)",
                            color: color ? readableTextOn(color) : undefined,
                        }}>
                            <b><FolderOutlined/> {name}</b>
                        </span>
                    ))}
                    {names.length > 6 && <Typography.Text type="secondary">{t("log.andMore", {count: names.length - 6})}</Typography.Text>}
                </Flex>
                <Flex wrap gap={8}>
                    {COLOR_PRESETS.map(preset => (
                        <button key={preset}
                                type="button"
                                aria-label={preset}
                                onClick={() => setColor(preset)}
                                style={{
                                    width: 28,
                                    height: 28,
                                    borderRadius: 6,
                                    cursor: "pointer",
                                    background: preset,
                                    border: color === preset ? "2px solid #fff" : "2px solid transparent",
                                    outline: color === preset ? `2px solid ${preset}` : "none",
                                }}/>
                    ))}
                </Flex>
                <Flex align="center" gap={8}>
                    <Typography.Text type="secondary">{t("folderColor.custom")}</Typography.Text>
                    <ColorPicker value={color ?? COLOR_PRESETS[9]}
                                 disabledAlpha
                                 showText
                                 onChangeComplete={(c) => setColor(c.toHexString())}/>
                </Flex>
            </Flex>
        </Modal>
    );
}
