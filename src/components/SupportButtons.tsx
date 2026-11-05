/**
 * Track / endorse (Nexus Mods) and subscribe / like / dislike (mod.io) buttons for Browse Mods
 * cards, and the same as right-click menu entries for the mod list. Nothing happens unless
 * one is clicked.
 */
import React, {useEffect, useSyncExternalStore} from "react";
import {Button, Space, Tooltip} from "antd";
import type {MenuProps} from "antd";
import {
    BellFilled,
    BellOutlined,
    DislikeFilled,
    DislikeOutlined,
    EyeFilled,
    EyeOutlined,
    HeartOutlined,
    LikeFilled,
    LikeOutlined,
} from "@ant-design/icons";
import {t} from "i18next";
import {ModSupport} from "@/services/ModSupport";

export function useModSupport(): number {
    const version = useSyncExternalStore(ModSupport.subscribe, ModSupport.version);
    useEffect(() => {
        void ModSupport.refresh();
    }, []);
    return version;
}

const stop = (e: React.SyntheticEvent) => e.stopPropagation();

export function NexusSupportButtons({domain, modId, name, modVersion}: {
    domain: string;
    modId: number;
    name: string;
    modVersion?: string;
}) {
    const version = useModSupport();
    const state = ModSupport.nexusState(domain, modId, version);
    const endorsed = state.endorsement === 'Endorsed';
    const needKey = !state.available ? ` ${t('support.needNexusKeyShort')}` : '';
    return (
        <Space size={0} onClick={stop} onContextMenu={stop} className="support-buttons">
            <Tooltip title={(state.tracked ? t('support.untrackTip') : t('support.trackTip')) + needKey}>
                <Button type="text" size="small" loading={state.busy}
                        aria-label={state.tracked ? t('support.untrack') : t('support.track')}
                        className={state.tracked ? 'support-on' : undefined}
                        icon={state.tracked ? <EyeFilled/> : <EyeOutlined/>}
                        onClick={() => ModSupport.setNexusTracked(domain, modId, !state.tracked, name)}/>
            </Tooltip>
            <Tooltip title={(endorsed ? t('support.abstainTip') : t('support.endorseTip')) + needKey}>
                <Button type="text" size="small" disabled={state.busy}
                        aria-label={endorsed ? t('support.abstain') : t('support.endorse')}
                        className={endorsed ? 'support-on' : undefined}
                        icon={endorsed ? <LikeFilled/> : <LikeOutlined/>}
                        onClick={() => ModSupport.setNexusEndorsed(domain, modId, !endorsed, name, modVersion)}/>
            </Tooltip>
        </Space>
    );
}

export function ModioSupportButtons({modId, name}: { modId: number; name: string }) {
    const version = useModSupport();
    const state = ModSupport.modioState(modId, version);
    const needToken = !state.available ? ` ${t('support.needModioTokenShort')}` : '';
    return (
        <Space size={0} onClick={stop} onContextMenu={stop} className="support-buttons">
            <Tooltip title={(state.subscribed ? t('support.unsubscribeTip') : t('support.subscribeTip')) + needToken}>
                <Button type="text" size="small" loading={state.busy}
                        aria-label={state.subscribed ? t('support.unsubscribe') : t('support.subscribe')}
                        className={state.subscribed ? 'support-on' : undefined}
                        icon={state.subscribed ? <BellFilled/> : <BellOutlined/>}
                        onClick={() => ModSupport.setModioSubscribed(modId, !state.subscribed, name)}/>
            </Tooltip>
            <Tooltip title={(state.rating === 1 ? t('support.unlikeTip') : t('support.likeTip')) + needToken}>
                <Button type="text" size="small" disabled={state.busy}
                        aria-label={state.rating === 1 ? t('support.unlike') : t('support.like')}
                        className={state.rating === 1 ? 'support-on' : undefined}
                        icon={state.rating === 1 ? <LikeFilled/> : <LikeOutlined/>}
                        onClick={() => ModSupport.setModioRating(modId, state.rating === 1 ? 0 : 1, name)}/>
            </Tooltip>
            <Tooltip title={(state.rating === -1 ? t('support.undislikeTip') : t('support.dislikeTip')) + needToken}>
                <Button type="text" size="small" disabled={state.busy}
                        aria-label={state.rating === -1 ? t('support.undislike') : t('support.dislike')}
                        className={state.rating === -1 ? 'support-on support-down' : undefined}
                        icon={state.rating === -1 ? <DislikeFilled/> : <DislikeOutlined/>}
                        onClick={() => ModSupport.setModioRating(modId, state.rating === -1 ? 0 : -1, name)}/>
            </Tooltip>
        </Space>
    );
}

/** Right-click menu entries for a mod of the list (none for other sources) */
export function supportMenuItems(kind: 'nexus' | 'modio' | undefined, domain: string, modId: number | undefined,
                                 version: number): MenuProps['items'] {
    if (!kind || !modId) return [];
    if (kind === 'nexus') {
        const state = ModSupport.nexusState(domain, modId, version);
        const endorsed = state.endorsement === 'Endorsed';
        return [{
            key: 'support_menu', label: t('support.nexusMenu'), icon: <HeartOutlined/>,
            children: [
                {key: state.tracked ? 'support_nexus_untrack' : 'support_nexus_track',
                    label: state.tracked ? t('support.untrack') : t('support.track'),
                    icon: state.tracked ? <EyeFilled/> : <EyeOutlined/>, disabled: state.busy},
                {key: endorsed ? 'support_nexus_abstain' : 'support_nexus_endorse',
                    label: endorsed ? t('support.abstain') : t('support.endorse'),
                    icon: endorsed ? <LikeFilled/> : <LikeOutlined/>, disabled: state.busy},
            ],
        }];
    }
    const state = ModSupport.modioState(modId, version);
    return [{
        key: 'support_menu', label: t('support.modioMenu'), icon: <LikeOutlined/>,
        children: [
            {key: state.subscribed ? 'support_modio_unsubscribe' : 'support_modio_subscribe',
                label: state.subscribed ? t('support.unsubscribe') : t('support.subscribe'),
                icon: state.subscribed ? <BellFilled/> : <BellOutlined/>, disabled: state.busy},
            {key: state.rating === 1 ? 'support_modio_unrate' : 'support_modio_like',
                label: state.rating === 1 ? t('support.unlike') : t('support.like'),
                icon: state.rating === 1 ? <LikeFilled/> : <LikeOutlined/>, disabled: state.busy},
            {key: state.rating === -1 ? 'support_modio_unrate_down' : 'support_modio_dislike',
                label: state.rating === -1 ? t('support.undislike') : t('support.dislike'),
                icon: state.rating === -1 ? <DislikeFilled/> : <DislikeOutlined/>, disabled: state.busy},
        ],
    }];
}

/** Handles a key from supportMenuItems; false when it wasn't one */
export function handleSupportMenu(key: string, domain: string, modId: number | undefined, name: string, modVersion?: string): boolean {
    if (!key.startsWith('support_') || !modId) return false;
    switch (key) {
        case 'support_nexus_track':
            void ModSupport.setNexusTracked(domain, modId, true, name);
            break;
        case 'support_nexus_untrack':
            void ModSupport.setNexusTracked(domain, modId, false, name);
            break;
        case 'support_nexus_endorse':
            void ModSupport.setNexusEndorsed(domain, modId, true, name, modVersion);
            break;
        case 'support_nexus_abstain':
            void ModSupport.setNexusEndorsed(domain, modId, false, name, modVersion);
            break;
        case 'support_modio_subscribe':
            void ModSupport.setModioSubscribed(modId, true, name);
            break;
        case 'support_modio_unsubscribe':
            void ModSupport.setModioSubscribed(modId, false, name);
            break;
        case 'support_modio_like':
            void ModSupport.setModioRating(modId, 1, name);
            break;
        case 'support_modio_dislike':
            void ModSupport.setModioRating(modId, -1, name);
            break;
        case 'support_modio_unrate':
        case 'support_modio_unrate_down':
            void ModSupport.setModioRating(modId, 0, name);
            break;
    }
    return true;
}
