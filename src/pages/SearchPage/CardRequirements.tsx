/**
 * The "Needs:" line of a Browse Mods card: what the mod requires (marked when it's already in
 * your lists), the author's load-order hints and, for Pak Hub posts, the author's notes.
 */
import React, {useEffect, useState} from "react";
import {Popover, Tag, Tooltip, Typography} from "antd";
import {CheckCircleFilled, ExportOutlined, OrderedListOutlined, ProfileOutlined, TeamOutlined, WarningOutlined} from "@ant-design/icons";
import {t} from "i18next";
import {open} from "@tauri-apps/plugin-shell";
import type {SearchResultItem} from "@/apis/search";
import type {RepositoryModDetail} from "@/apis/repositories";
import type {ListedIndex} from "@/services/ListedMods";
import {planFor, type RequirementPlan, type ResolvedOrderHint, type ResolvedRequirement} from "@/services/BrowseRequirements";
import {whoNeedsIt} from "@/services/ModRequirements";

const stop = (e: React.SyntheticEvent) => e.stopPropagation();

/** Labels for who has to have a mod */
export const WHO_LABEL = {host: 'req.hostOnly', client: 'req.clientSide', everyone: 'req.everyone'} as const;

export function useRequirementPlan(item: SearchResultItem, index: ListedIndex, detail?: RepositoryModDetail): RequirementPlan | null {
    const [plan, setPlan] = useState<RequirementPlan | null>(null);
    useEffect(() => {
        let alive = true;
        planFor(item, index, detail, 'likely')
            .then(result => alive && setPlan(result))
            .catch(() => alive && setPlan(null));
        return () => {
            alive = false;
        };
    }, [item, index, detail]);
    return plan;
}

export function listedText(req: ResolvedRequirement): string | undefined {
    const listed = req.listed;
    if (!listed) return undefined;
    if (req.matchedName) return t('req.inYourListAs', {name: req.matchedName});
    if (listed.inActiveProfile) {
        return listed.folder ? t('browse.inYourListFolderTip', {folder: listed.folder}) : t('browse.inYourListTip');
    }
    return t('browse.inOtherProfilesTip', {names: listed.otherProfiles.join(', ')});
}

export function sourceLabel(req: ResolvedRequirement): string {
    switch (req.source) {
        case 'nexus':
            return 'Nexus Mods';
        case 'modio':
            return 'mod.io';
        case 'pakhub':
            return req.repoPost ? t('req.pakhubPost') : t('req.discordPost');
        case 'dlc':
            return t('req.dlc');
        case 'external':
            return t('req.external');
        default:
            return t('req.namedOnly');
    }
}

function RequirementTag({req}: { req: ResolvedRequirement }) {
    const here = req.listed?.inActiveProfile;
    const tip = [
        sourceLabel(req),
        listedText(req) ?? (req.addable ? t('req.notInList') : undefined),
        req.notes,
        req.sentence ? `“${req.sentence}”` : undefined,
    ].filter(Boolean).join(" · ");
    const clickable = !!req.link;
    return (
        <Tooltip title={tip}>
            <Tag color={here ? 'success' : req.listed ? 'processing' : undefined}
                 icon={here ? <CheckCircleFilled/> : !req.addable && req.link ? <ExportOutlined/> : undefined}
                 className={`search-result-req${clickable ? ' search-result-req-link' : ''}`}
                 onClick={clickable ? (e) => {
                     e.stopPropagation();
                     void open(req.link!);
                 } : undefined}>
                {req.name}
            </Tag>
        </Tooltip>
    );
}

export function orderHintText(hint: ResolvedOrderHint): string {
    const target = hint.match ?? hint.target;
    return hint.direction === 'above' ? t('req.loadAbove', {name: target}) : t('req.loadBelow', {name: target});
}

export function CardRequirements({plan}: { plan: RequirementPlan | null }) {
    if (!plan) return null;
    const needs = plan.requirements.filter(r => r.likely || plan.source !== 'pakhub');
    const conflicts = plan.notes.filter(n => /\b(not compatible|incompatible|conflicts?|disable)\b/i.test(n));
    const who = whoNeedsIt(plan.notes);
    if (needs.length === 0 && plan.orderHints.length === 0 && plan.notes.length === 0) return null;
    return (
        <div className="search-result-card-extra" onClick={stop} onContextMenu={stop}>
            {needs.length > 0 && (
                <>
                    <Tooltip title={plan.source === 'modio' ? t('req.modioAutoTip') : plan.source === 'pakhub' ? t('req.pakhubTip') : t('req.nexusTip')}>
                        <Typography.Text type="secondary">{t('req.needs')}</Typography.Text>
                    </Tooltip>
                    {needs.map(req => <RequirementTag key={req.key} req={req}/>)}
                </>
            )}
            {plan.orderHints.map(hint => (
                <Tooltip key={`${hint.direction}:${hint.target}`} title={`“${hint.sentence}”`}>
                    <Tag icon={<OrderedListOutlined/>} color={hint.match ? 'gold' : undefined}>{orderHintText(hint)}</Tag>
                </Tooltip>
            ))}
            {who && (
                <Tooltip title={`“${who.sentence}”`}>
                    <Tag icon={<TeamOutlined/>}>{t(WHO_LABEL[who.who])}</Tag>
                </Tooltip>
            )}
            {conflicts.length > 0 && (
                <Tooltip title={conflicts.map(c => `“${c}”`).join("\n")}>
                    <Tag icon={<WarningOutlined/>} color="warning">{t('req.conflictNote')}</Tag>
                </Tooltip>
            )}
            {plan.notes.length > 0 && (
                <Popover title={t('req.authorNotesTitle')}
                         content={<div className="search-result-notes">
                             {plan.notes.map((note, i) => <div key={i}>“{note}”</div>)}
                             {plan.requirements.filter(r => !r.likely).length > 0 && (
                                 <div className="search-result-notes-mentions">
                                     <Typography.Text type="secondary">{t('req.mentions')}</Typography.Text>
                                     {plan.requirements.filter(r => !r.likely).map(req => <RequirementTag key={req.key} req={req}/>)}
                                 </div>
                             )}
                         </div>}>
                    <Typography.Link className="search-result-notes-link">
                        <ProfileOutlined/> {t('req.authorNotes', {count: plan.notes.length})}
                    </Typography.Link>
                </Popover>
            )}
        </div>
    );
}
