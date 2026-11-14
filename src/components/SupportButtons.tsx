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
