/**
 * Preview of a mod settings import (from a zip or a folder): pick the files to copy into the
 * game's SaveGames folder. Files that get replaced are copied aside first.
 */
import React from "react";
import {Alert, Button, Flex, Modal, Typography, message} from "antd";
import {t} from "i18next";
import {IntegrateApi} from "@/apis/IntegrateApi";
import {
    applyImport,
    defaultSelection,
    type ImportItem,
    type ImportSource,
} from "@/services/ModSettingsFiles";
import {SettingsFilesTable} from "@/dialogs/backup/SettingsFilesTable";

export async function gameIsRunning(): Promise<boolean> {
    try {
        return await IntegrateApi.checkSteamGame();
    } catch {
        return false;
    }
}

export function ModSettingsImportDialog({source, target, items, onClose}: {
    source: ImportSource;
    target: string;
    items: ImportItem[];
    onClose: (imported: boolean) => void;
}) {
    const [selected, setSelected] = React.useState<string[]>(() => defaultSelection(items));
    const [working, setWorking] = React.useState(false);
    const replacing = items.filter(i => selected.includes(i.rel) && i.existing).length;
    const protectedCount = items.filter(i => i.status === "protected").length;

    const run = async () => {
        if (await gameIsRunning()) {
            message.warning(t("modSettings.closeGame"));
            return;
        }
        setWorking(true);
        try {
            const result = await applyImport(source, target, selected);
            message.success(t("modSettings.imported", {count: result.count}));
            if (result.savedTo) {
                message.info(t("modSettings.replacedSaved", {path: result.savedTo}), 8);
            }
            onClose(true);
        } catch (e) {
            console.error("[ModSettings] import failed", e);
            message.error(`${t("modSettings.importFailed")}: ${e instanceof Error ? e.message : String(e)}`);
        } finally {
            setWorking(false);
        }
    };

    return (
        <Modal open
               width={860}
               title={t("modSettings.importTitle")}
               onCancel={() => !working && onClose(false)}
               footer={
                   <Flex justify="space-between" align="center">
                       <Typography.Text type="secondary">
                           {t("modSettings.selectedSummary", {count: selected.length, replacing})}
                       </Typography.Text>
                       <Flex gap={8}>
                           <Button onClick={() => onClose(false)} disabled={working}>{t("Cancel")}</Button>
                           <Button type="primary" loading={working} disabled={selected.length === 0} onClick={run}>
                               {t("modSettings.importButton", {count: selected.length})}
                           </Button>
                       </Flex>
                   </Flex>
               }>
            <Flex vertical gap={10}>
                <Typography.Text type="secondary" style={{wordBreak: "break-all"}}>
                    {t("modSettings.from")}: {source.path}
                    <br/>
                    {t("modSettings.to")}: {target}
                </Typography.Text>
                {protectedCount > 0 && (
                    <Alert type="info" showIcon message={t("modSettings.protectedNote", {count: protectedCount})}/>
                )}
                {items.length === 0
                    ? <Alert type="warning" showIcon message={t("modSettings.nothingFound")}/>
                    : <SettingsFilesTable items={items}
                                          selected={selected}
                                          onChange={setSelected}
                                          incomingLabel={t("modSettings.col.incoming")}/>}
                <Typography.Text type="secondary" style={{fontSize: 12}}>{t("modSettings.defaultPickHint")}</Typography.Text>
            </Flex>
        </Modal>
    );
}
