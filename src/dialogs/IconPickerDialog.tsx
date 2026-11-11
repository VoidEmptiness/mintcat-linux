/**
 * Pick the title bar's app icon or profile picture: the default, a built-in icon or any image
 * file. Mounted once; opened with TitleBarLook.openPicker("logo" | "avatar").
 */
import React, {useSyncExternalStore} from "react";
import {Avatar, Button, Checkbox, Flex, Modal, Tooltip, Typography, message} from "antd";
import {PictureOutlined, UserOutlined} from "@ant-design/icons";
import {t} from "i18next";
import {open} from "@tauri-apps/plugin-dialog";
import {BUILTIN_ICONS, imageFileToDataUrl, TitleBarLook, type IconChoice} from "@/services/TitleBarLook";
import {SystemIcon, type SystemIconStatus} from "@/services/SystemIcon";

const DEFAULT_LOGO = "icon.ico";

function Preview({target, src}: { target: "logo" | "avatar"; src?: string }) {
    if (target === "avatar") {
        return <Avatar size={64} src={src} icon={src ? undefined : <UserOutlined/>}/>;
    }
    return <img src={src ?? DEFAULT_LOGO} alt="" width={64} height={64} style={{objectFit: "contain", borderRadius: 8}}/>;
}

export function IconPickerDialog() {
    const version = useSyncExternalStore(TitleBarLook.subscribe, TitleBarLook.version);
    const target = TitleBarLook.editing(version);
    const current = target ? TitleBarLook.choice(target, version) : undefined;
    const [picked, setPicked] = React.useState<IconChoice | null>(null);
    // The app icon can also become the icon of MINTCAT's app menu / taskbar entry (Linux AppImage)
    const [menuStatus, setMenuStatus] = React.useState<SystemIconStatus | null>(null);
    const [menuEntry, setMenuEntry] = React.useState(true);
    const [applying, setApplying] = React.useState(false);

    React.useEffect(() => {
        setPicked(current ?? null);
        if (target === "logo") {
            void SystemIcon.status().then(setMenuStatus);
            void SystemIcon.menuEntryEnabled().then(setMenuEntry);
        }
        // eslint-disable-next-line react-hooks/exhaustive-deps
    }, [target]);

    if (!target) return null;

    const srcOf = (choice: IconChoice | null) => {
        if (!choice) return undefined;
        if (choice.kind === "image") return choice.dataUrl;
        return BUILTIN_ICONS.find(i => i.id === choice.id)?.src;
    };

    const chooseFile = async () => {
        const file = await open({
            multiple: false,
            filters: [{name: t("iconPicker.images"), extensions: ["png", "jpg", "jpeg", "webp", "gif", "svg", "bmp", "ico"]}],
        });
        if (!file || Array.isArray(file)) return;
        try {
            const dataUrl = await imageFileToDataUrl(file);
            setPicked({kind: "image", dataUrl, name: file.split(/[\\/]/).pop()});
        } catch (e) {
            console.warn("[IconPicker] could not read the image", e);
            message.error(t("iconPicker.notImage"));
        }
    };

    const apply = async () => {
        setApplying(true);
        try {
            await TitleBarLook.set(target, picked);
            if (target === "logo") {
                if (menuStatus && menuStatus.entries.length > 0) await SystemIcon.setMenuEntryEnabled(menuEntry);
                try {
                    await SystemIcon.apply(srcOf(picked));
                } catch (e) {
                    message.warning(t("iconPicker.menuEntryFailed", {reason: String(e)}));
                }
            }
        } finally {
            setApplying(false);
        }
        TitleBarLook.closePicker();
    };

    const isPicked = (id: string) => picked?.kind === "builtin" && picked.id === id;
    const tile = (selected: boolean): React.CSSProperties => ({
        width: 52,
        height: 52,
        padding: 2,
        borderRadius: target === "avatar" ? "50%" : 10,
        cursor: "pointer",
        background: "transparent",
        border: selected ? "2px solid #fa8c16" : "2px solid transparent",
        display: "flex",
        alignItems: "center",
        justifyContent: "center",
    });

    return (
        <Modal open
               width={520}
               zIndex={1300}
               title={t(target === "logo" ? "iconPicker.titleLogo" : "iconPicker.titleAvatar")}
               onCancel={() => TitleBarLook.closePicker()}
               footer={
                   <Flex justify="space-between">
                       <Button onClick={() => setPicked(null)} disabled={!picked}>{t("iconPicker.useDefault")}</Button>
                       <Flex gap={8}>
                           <Button onClick={() => TitleBarLook.closePicker()}>{t("Cancel")}</Button>
                           <Button type="primary" loading={applying} onClick={apply}>{t("iconPicker.apply")}</Button>
                       </Flex>
                   </Flex>
               }>
            <Flex vertical gap={14}>
                <Flex align="center" gap={14}>
                    <Preview target={target} src={srcOf(picked)}/>
                    <Typography.Text type="secondary">
                        {picked?.kind === "image"
                            ? t("iconPicker.customName", {name: picked.name ?? ""})
                            : picked ? BUILTIN_ICONS.find(i => i.id === picked.id)?.label : t("iconPicker.default")}
                    </Typography.Text>
                </Flex>
                <Flex wrap gap={6}>
                    <Tooltip title={t("iconPicker.default")}>
                        <button type="button" style={tile(!picked)} onClick={() => setPicked(null)}>
                            {target === "avatar"
                                ? <Avatar size={44} icon={<UserOutlined/>}/>
                                : <img src={DEFAULT_LOGO} alt="" width={44} height={44}/>}
                        </button>
                    </Tooltip>
                    {BUILTIN_ICONS.map(icon => (
                        <Tooltip key={icon.id} title={icon.label}>
                            <button type="button" style={tile(isPicked(icon.id))}
                                    onClick={() => setPicked({kind: "builtin", id: icon.id})}>
                                <img src={icon.src} alt={icon.label} width={44} height={44}
                                     style={{borderRadius: target === "avatar" ? "50%" : 8}}/>
                            </button>
                        </Tooltip>
                    ))}
                </Flex>
                <Flex align="center" gap={10} wrap>
                    <Button icon={<PictureOutlined/>} onClick={chooseFile}>{t("iconPicker.chooseImage")}</Button>
                    <Typography.Text type="secondary" style={{fontSize: 12}}>{t("iconPicker.imageHint")}</Typography.Text>
                </Flex>
                {target === "logo" && menuStatus && (menuStatus.entries.length > 0 ? (
                    <Flex vertical gap={2}>
                        <Checkbox checked={menuEntry} onChange={(e) => setMenuEntry(e.target.checked)}>
                            {t("iconPicker.menuEntry")}
                        </Checkbox>
                        <Typography.Text type="secondary" style={{fontSize: 12, paddingLeft: 24}}>
                            {t("iconPicker.menuEntryHint", {file: menuStatus.entries.map(e => e.split("/").pop()).join(", ")})}
                        </Typography.Text>
                    </Flex>
                ) : (
                    <Typography.Text type="secondary" style={{fontSize: 12}}>{t("iconPicker.noMenuEntry")}</Typography.Text>
                ))}
            </Flex>
        </Modal>
    );
}

/** Profile picture that follows the picked picture (falls back to `fallback`), click to change */
export function ProfilePicture({size, fallback, className}: { size: number; fallback?: string; className?: string }) {
    const version = useSyncExternalStore(TitleBarLook.subscribe, TitleBarLook.version);
    React.useEffect(() => {
        void TitleBarLook.init();
    }, []);
    return (
        <Tooltip title={t("iconPicker.changeAvatar")}>
            <Avatar size={size}
                    className={className}
                    icon={<UserOutlined/>}
                    src={TitleBarLook.src("avatar", version) ?? fallback}
                    style={{cursor: "pointer", flexShrink: 0}}
                    onClick={() => TitleBarLook.openPicker("avatar")}/>
        </Tooltip>
    );
}
