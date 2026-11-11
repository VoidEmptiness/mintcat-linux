/**
 * The information shown at the right of a mod row, by source:
 *   Version  the mod's own version (mod.io, Nexus, ModCat: the version picker), or for Pak Hub
 *            mods the date of the upload you have
 *   Game     mod.io only: the game version the mod is tagged for, orange when it's older than
 *            the newest one among your mod.io mods
 *   Status   mod.io only: Verified / Approved / Sandbox; plus who has to have the mod (mod.io's
 *            "RequiredByAll", or what a Pak Hub post says: host only, client side, everyone)
 *   Tags     mod.io tags, ModCat types, the Nexus category
 * Nexus and ModCat have no game-version tags or approval, so those stay empty for them (they
 * used to show their own version as an outdated game version and an "A").
 */
import React, {useSyncExternalStore} from "react";
import {Tag, Tooltip} from "antd";
import {TeamOutlined} from "@ant-design/icons";
import {t} from "i18next";
import {ModSourceType} from "@/models/mod/types";
import {compareGameVersions, GameVersions, newestGameVersion} from "@/services/ListDisplay";
import {PostFacts} from "@/services/PostFacts";
import type {RepositoryLink} from "@/services/RepositoryUpdates";
import type {WhoNeedsIt} from "@/services/ModRequirements";

const WHO_LABEL: Record<WhoNeedsIt, string> = {host: 'req.hostOnly', client: 'req.clientSide', everyone: 'req.everyone'};

export interface RowInfo {
    /** mod.io: the newest game version it's tagged for */
    game?: string;
    /** Older than the newest among your mod.io mods */
    gameOlder?: boolean;
    /** The newest game version among your mod.io mods */
    latest?: string;
    approval?: { color: string; short: string; label: string };
    who?: { who: WhoNeedsIt; tip: string };
    /** Pak Hub: the upload you have */
    uploaded?: { date: string; tip: string };
    tags: string[];
}

/** Everything the row shows besides its name (hooks: re-reads when the stores change) */
export function useRowInfo(nodeData: any, repoLink: RepositoryLink | undefined): RowInfo {
    const gameVersion = useSyncExternalStore(GameVersions.subscribe, GameVersions.version);
    const factsVersion = useSyncExternalStore(PostFacts.subscribe, PostFacts.version);
    const isModio = nodeData.sourceType === ModSourceType.Modio;

    let game: string | undefined;
    let gameOlder = false;
    const latest = GameVersions.latest(gameVersion);
    if (isModio) {
        game = newestGameVersion(nodeData.versions ?? []);
        gameOlder = !!game && !!latest && compareGameVersions(game, latest) < 0;
    }

    const approval = !isModio ? undefined
        : nodeData.approval === "Verified" ? {color: "blue", short: "V", label: t("Verified")}
            : nodeData.approval === "Approved" ? {color: "green", short: "A", label: t("Approved")}
                : nodeData.approval === "Sandbox" ? {color: "orange", short: "S", label: t("Sandbox")} : undefined;

    let who: RowInfo["who"];
    if (nodeData.required === true) {
        who = {who: 'everyone', tip: t('cols.requiredByAllTip')};
    } else if (repoLink) {
        const fact = PostFacts.get({repoId: repoLink.repoId, slug: repoLink.slug}, factsVersion);
        if (fact?.who) who = {who: fact.who, tip: t('cols.postSaysTip', {sentence: fact.sentence ?? ''})};
    }

    let uploaded: RowInfo["uploaded"];
    if (repoLink?.postedAt && Number.isFinite(Date.parse(repoLink.postedAt))) {
        const date = new Date(repoLink.postedAt).toLocaleDateString();
        uploaded = {date, tip: t('cols.uploadedTip', {date, file: repoLink.filename})};
    }

    return {game, gameOlder, latest, approval, who, uploaded, tags: nodeData.tags ?? []};
}

export function GameTag({info, compact}: { info: RowInfo; compact?: boolean }) {
    if (!info.game) return null;
    // compact view: only the outdated ones (as before), so the row stays short
    if (compact && !info.gameOlder) return null;
    return (
        <Tooltip title={info.gameOlder ? t('cols.gameOlderTip', {version: info.game, latest: info.latest}) : t('cols.gameTip', {version: info.game})}>
            <Tag color={info.gameOlder ? "orange" : undefined} className="mod-col-tag">{info.game}</Tag>
        </Tooltip>
    );
}

export function StatusTags({info, compact}: { info: RowInfo; compact?: boolean }) {
    return (
        <>
            {info.approval && (
                <Tooltip title={t('cols.approvalTip', {status: info.approval.label})}>
                    <Tag color={info.approval.color} className="mod-col-tag">{compact ? info.approval.short : info.approval.label}</Tag>
                </Tooltip>
            )}
            {info.who && (
                <Tooltip title={`${t(WHO_LABEL[info.who.who])}. ${info.who.tip}`}>
                    <Tag color={info.who.who === 'everyone' ? "orange" : undefined} icon={<TeamOutlined/>} className="mod-col-tag">
                        {compact || info.approval ? null : t(`cols.who.${info.who.who}`)}
                    </Tag>
                </Tooltip>
            )}
        </>
    );
}

export function TagList({info}: { info: RowInfo }) {
    return (
        <>
            {info.tags.map(tag => <Tag key={tag} className="mod-col-tag">{tag}</Tag>)}
        </>
    );
}

export function UploadedDate({info}: { info: RowInfo }) {
    if (!info.uploaded) return null;
    return (
        <Tooltip title={info.uploaded.tip}>
            <span className="mod-col-date">{info.uploaded.date}</span>
        </Tooltip>
    );
}
