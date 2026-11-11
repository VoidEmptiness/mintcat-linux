/**
 * "Ask before moving" (Settings → Mod list): shows where each mod or folder goes before a move
 * is saved. With the setting off, only the old check for big group moves still asks.
 */
import React from "react";
import {t} from "i18next";
import {Typography} from "antd";
import {ArrowRightOutlined} from "@ant-design/icons";
import {MessageBox} from "@/components/MessageBox";
import {MoveConfirm} from "@/services/MoveConfirm";
import type {MoveLine, Place} from "@/pages/HomePage/MoveSummary";

const SHOWN = 8;

function placeText(place: Place): string {
    const folder = place.folder;
    if (place.isMod && place.position !== undefined) {
        return folder
            ? t("moveConfirm.modPlace", {position: place.position, folder})
            : t("moveConfirm.modPlaceTop", {position: place.position});
    }
    return folder ? t("moveConfirm.inFolder", {folder}) : t("moveConfirm.topLevel");
}

function titleFor(lines: MoveLine[]): string {
    if (lines.length === 1) {
        return t(lines[0].isMod ? "moveConfirm.titleMod" : "moveConfirm.titleFolder", {name: lines[0].name});
    }
    return lines.every(l => l.isMod)
        ? t("moveConfirm.titleMods", {count: lines.length})
        : lines.every(l => !l.isMod)
            ? t("moveConfirm.titleFolders", {count: lines.length})
            : t("moveConfirm.titleItems", {count: lines.length});
}

/**
 * Before saving a move: true to go ahead. `warning` is the extra note for a big group move
 * (many mods, or some in folders that are closed); `fallbackTitle` titles that note when the
 * setting is off and only the note asks.
 */
export async function askBeforeMoving(lines: MoveLine[], warning?: string | null, fallbackTitle?: string): Promise<boolean> {
    if (!(await MoveConfirm.enabled())) {
        if (!warning) return true;
        return MessageBox.confirm({
            title: fallbackTitle,
            content: warning,
            okText: t("list.moveGroupConfirmOk"),
        });
    }
    // nothing would change
    if (lines.length === 0) return true;
    const shown = lines.slice(0, SHOWN);
    const content = (
        <div>
            {shown.map(line => (
                <div key={line.key} style={{marginBottom: 4, wordBreak: "break-word"}}>
                    {lines.length > 1 && <Typography.Text strong>{line.name}: </Typography.Text>}
                    <span>{placeText(line.from)}</span>
                    <ArrowRightOutlined style={{margin: "0 8px", opacity: 0.7}}/>
                    <Typography.Text strong>{placeText(line.to)}</Typography.Text>
                </div>
            ))}
            {lines.length > SHOWN && (
                <Typography.Text type="secondary">{t("moveConfirm.andMore", {count: lines.length - SHOWN})}</Typography.Text>
            )}
            {warning && <div style={{marginTop: 10}}>{warning}</div>}
            <div style={{marginTop: 10}}>
                <Typography.Text type="secondary" style={{fontSize: 12}}>{t("moveConfirm.hint")}</Typography.Text>
            </div>
        </div>
    );
    return MessageBox.confirm({
        title: titleFor(lines),
        content,
        width: 520,
        okText: t("moveConfirm.ok"),
        cancelText: t("Cancel"),
    });
}
