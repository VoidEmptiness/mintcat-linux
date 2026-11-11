/**
 * Restore a backup: shows what is inside and lets the user pick the parts to put back.
 */
import React from "react";
import {Alert, Button, Checkbox, Descriptions, Flex, Modal, Typography, message} from "antd";
import {t} from "i18next";
import {relaunch} from "@tauri-apps/plugin-process";
import {Backups, type RestorePlan} from "@/services/Backups";
import {defaultSelection} from "@/services/ModSettingsFiles";
import {formatBytes, SettingsFilesTable} from "@/dialogs/backup/SettingsFilesTable";
import {gameIsRunning} from "@/dialogs/backup/ModSettingsImportDialog";
import {MessageBox} from "@/components/MessageBox";

export function RestoreBackupDialog({plan, title, onClose}: {
    plan: RestorePlan;
    title: string;
    onClose: () => void;
}) {
    const {manifest} = plan;
    const [database, setDatabase] = React.useState(plan.hasDatabase);
    const [settings, setSettings] = React.useState<string[]>(() => plan.settingsTarget ? defaultSelection(plan.settingsItems) : []);
    const [localMods, setLocalMods] = React.useState(plan.localMods.some(m => !m.present));
    const [working, setWorking] = React.useState(false);

    const missingMods = plan.localMods.filter(m => !m.present);
    const presentMods = plan.localMods.length - missingMods.length;
    const nothing = !database && settings.length === 0 && !(localMods && missingMods.length);

    const run = async () => {
        if (settings.length && await gameIsRunning()) {
            message.warning(t("modSettings.closeGame"));
            return;
        }
        setWorking(true);
        try {
            const result = await Backups.applyRestore(plan, {database, settingsRels: settings, localMods});
            if (result.settings) message.success(t("modSettings.imported", {count: result.settings}));
            if (result.settingsSavedTo) message.info(t("modSettings.replacedSaved", {path: result.settingsSavedTo}), 8);
            if (result.localMods) message.success(t("backup.restore.modsDone", {count: result.localMods}));
            if (result.elsewhere) message.warning(t("backup.restore.modsElsewhere", {path: result.elsewhere}), 12);
            onClose();
            if (result.database) {
                const restart = await MessageBox.confirm({
                    title: t("backup.restore.restartTitle"),
                    content: t("backup.restore.restartText"),
                    okText: t("backup.restore.restartNow"),
                    cancelText: t("backup.restore.restartLater"),
                });
                if (restart) await relaunch();
            }
        } catch (e) {
            console.error("[Backups] restore failed", e);
            message.error(`${t("backup.restore.failed")}: ${e instanceof Error ? e.message : String(e)}`);
        } finally {
            setWorking(false);
        }
    };

    const counts = manifest.counts;
    return (
        <Modal open
               width={880}
               title={title}
               onCancel={() => !working && onClose()}
               footer={[
                   <Button key="cancel" onClick={onClose} disabled={working}>{t("Cancel")}</Button>,
                   <Button key="ok" type="primary" loading={working} disabled={nothing} onClick={run}>
                       {t("backup.restore.button")}
                   </Button>,
               ]}>
            <Flex vertical gap={14}>
                <Descriptions size="small" column={2} bordered items={[
                    {label: t("backup.restore.made"), children: new Date(manifest.createdAt).toLocaleString()},
                    {label: t("backup.restore.by"), children: manifest.app},
                    ...(manifest.note ? [{label: t("backup.note"), children: manifest.note, span: 2}] : []),
                    ...(counts ? [{
                        label: t("backup.restore.contains"), span: 2,
                        children: t("backup.restore.containsText", {
                            mods: counts.mods ?? 0, profiles: counts.profiles ?? 0,
                            settings: manifest.modSettings?.length ?? 0, paks: manifest.localMods?.length ?? 0,
                        }),
                    }] : []),
                ]}/>

                {plan.hasDatabase && (
                    <div>
                        <Checkbox checked={database} onChange={e => setDatabase(e.target.checked)}>
                            <b>{t("backup.restore.database")}</b>
                        </Checkbox>
                        <Typography.Paragraph type="secondary" style={{margin: "2px 0 0 24px", fontSize: 12}}>
                            {t("backup.restore.databaseHelp")}
                        </Typography.Paragraph>
                    </div>
                )}

                {plan.settingsItems.length > 0 && (
                    <div>
                        <Checkbox checked={settings.length > 0}
                                  indeterminate={settings.length > 0 && settings.length < plan.settingsItems.filter(i => i.status !== "protected").length}
                                  disabled={!plan.settingsTarget}
                                  onChange={e => setSettings(e.target.checked ? defaultSelection(plan.settingsItems) : [])}>
                            <b>{t("backup.restore.settings", {count: settings.length, total: plan.settingsItems.length})}</b>
                        </Checkbox>
                        {!plan.settingsTarget
                            ? <Alert style={{marginTop: 6}} type="warning" showIcon message={t("modSettings.noGamePath")}/>
                            : <div style={{marginTop: 6}}>
                                <SettingsFilesTable items={plan.settingsItems}
                                                    selected={settings}
                                                    onChange={setSettings}
                                                    incomingLabel={t("modSettings.col.inBackup")}
                                                    height={200}/>
                            </div>}
                    </div>
                )}

                {plan.localMods.length > 0 && (
                    <div>
                        <Checkbox checked={localMods && missingMods.length > 0}
                                  disabled={missingMods.length === 0}
                                  onChange={e => setLocalMods(e.target.checked)}>
                            <b>{t("backup.restore.localMods")}</b>
                        </Checkbox>
                        <Typography.Paragraph type="secondary" style={{margin: "2px 0 0 24px", fontSize: 12}}>
                            {t("backup.restore.localModsHelp", {
                                missing: missingMods.length,
                                present: presentMods,
                                size: formatBytes(missingMods.reduce((s, m) => s + m.size, 0)),
                            })}
                        </Typography.Paragraph>
                    </div>
                )}
            </Flex>
        </Modal>
    );
}
