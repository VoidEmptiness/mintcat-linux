/**
 * Connect Google Drive, Dropbox or MEGA through rclone. Google Drive and Dropbox sign in in the
 * browser (rclone waits for it); MEGA takes the email and password. The account is saved in
 * rclone's own config file, not in MINTCAT.
 */
import React from "react";
import {Alert, Button, Flex, Form, Input, Modal, Radio, Typography, message} from "antd";
import {t} from "i18next";
import {open as openUrl} from "@tauri-apps/plugin-shell";
import {Rclone, type CloudProvider, type RcloneRemote} from "@/services/Backups";

const DEFAULT_NAMES: Record<CloudProvider, string> = {drive: "gdrive", dropbox: "dropbox", mega: "mega"};

function freeName(base: string, existing: RcloneRemote[]): string {
    const taken = new Set(existing.map(r => r.name));
    if (!taken.has(base)) return base;
    for (let i = 2; ; i++) if (!taken.has(`${base}${i}`)) return `${base}${i}`;
}

export function ConnectCloudDialog({existing, onClose}: {
    existing: RcloneRemote[];
    onClose: (connected?: string) => void;
}) {
    const [provider, setProvider] = React.useState<CloudProvider>("drive");
    const [name, setName] = React.useState(freeName(DEFAULT_NAMES.drive, existing));
    const [user, setUser] = React.useState("");
    const [pass, setPass] = React.useState("");
    const [working, setWorking] = React.useState(false);
    const [link, setLink] = React.useState<string>();
    const [error, setError] = React.useState<string>();
    const runId = React.useRef(`connect-${Date.now()}`);
    const stopped = React.useRef(false);

    const pick = (value: CloudProvider) => {
        setProvider(value);
        setName(freeName(DEFAULT_NAMES[value], existing));
        setError(undefined);
    };

    const nameOk = /^[\w][\w\- .]*$/.test(name) && !existing.some(r => r.name === name);
    const ready = nameOk && (provider !== "mega" || (user.includes("@") && pass.length > 0));

    const connect = async () => {
        setWorking(true);
        setError(undefined);
        setLink(undefined);
        stopped.current = false;
        runId.current = `connect-${Date.now()}`;
        try {
            await Rclone.connect(provider, name, {user, pass}, setLink, runId.current);
            message.success(t("backup.connect.done", {name}));
            onClose(name);
        } catch (e) {
            // Stopped by the user: no error to show
            if (!stopped.current) setError(e instanceof Error ? e.message : String(e));
        } finally {
            setWorking(false);
            setLink(undefined);
        }
    };

    const cancel = async () => {
        if (working) {
            stopped.current = true;
            await Rclone.cancel(runId.current);
        } else {
            onClose();
        }
    };

    return (
        <Modal open
               width={560}
               title={t("backup.connect.title")}
               maskClosable={false}
               onCancel={cancel}
               footer={[
                   <Button key="cancel" onClick={cancel}>{working ? t("backup.connect.stop") : t("Cancel")}</Button>,
                   <Button key="ok" type="primary" loading={working} disabled={!ready} onClick={connect}>
                       {t("backup.connect.button")}
                   </Button>,
               ]}>
            <Form layout="vertical" disabled={working}>
                <Form.Item label={t("backup.connect.service")}>
                    <Radio.Group value={provider} onChange={e => pick(e.target.value)} optionType="button" options={[
                        {value: "drive", label: "Google Drive"},
                        {value: "dropbox", label: "Dropbox"},
                        {value: "mega", label: "MEGA"},
                    ]}/>
                </Form.Item>
                <Typography.Paragraph type="secondary" style={{fontSize: 12, marginTop: -8}}>
                    {t(`backup.connect.about.${provider}`)}
                </Typography.Paragraph>
                {provider === "mega" && (
                    <>
                        <Form.Item label={t("backup.connect.email")}>
                            <Input value={user} onChange={e => setUser(e.target.value)} autoComplete="off"/>
                        </Form.Item>
                        <Form.Item label={t("backup.connect.password")}>
                            <Input.Password value={pass} onChange={e => setPass(e.target.value)} autoComplete="off"/>
                        </Form.Item>
                    </>
                )}
                <Form.Item label={t("backup.connect.name")}
                           help={!nameOk ? t("backup.connect.nameTaken") : t("backup.connect.nameHelp")}
                           validateStatus={nameOk ? undefined : "error"}>
                    <Input value={name} onChange={e => setName(e.target.value.trim())} style={{maxWidth: 220}}/>
                </Form.Item>
            </Form>
            {working && provider !== "mega" && (
                <Alert type="info" showIcon
                       message={t("backup.connect.waiting")}
                       description={link ? (
                           <Flex vertical gap={6}>
                               <span>{t("backup.connect.noBrowser")}</span>
                               <Flex gap={8} align="center" wrap>
                                   <Button size="small" type="primary" onClick={() => void openUrl(link)}>
                                       {t("backup.connect.openPage")}
                                   </Button>
                                   <Typography.Text copyable={{text: link}} style={{fontSize: 12}}>{link}</Typography.Text>
                               </Flex>
                           </Flex>
                       ) : t("backup.connect.starting")}/>
            )}
            {working && provider === "mega" && <Alert type="info" showIcon message={t("backup.connect.checking")}/>}
            {error && <Alert type="error" showIcon message={t("backup.connect.failed")}
                             description={<span style={{whiteSpace: "pre-wrap"}}>{error}</span>}/>}
        </Modal>
    );
}
