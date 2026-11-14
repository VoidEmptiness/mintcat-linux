import React, {useSyncExternalStore} from "react";
import {Tooltip} from "antd";
import {BellFilled, DislikeFilled, EyeFilled, LikeFilled} from "@ant-design/icons";
import {t} from "i18next";
import {ModSupport, nexusDomainOf} from "@/services/ModSupport";
import {NEXUSMODS_PLATFORM} from "@/apis/nexusmods/types";
import {ModSourceType} from "@/models/mod/types";

const stop = (e: React.SyntheticEvent) => e.stopPropagation();

export function ModStatusIcons({nodeData}: { nodeData: any }) {
    const version = useSyncExternalStore(ModSupport.subscribe, ModSupport.version);
    if (!ModSupport.anyAccount(version)) return null;

    const isNexus = !!(nodeData.sourceType === NEXUSMODS_PLATFORM && nodeData.platformId);
    const isModio = !!(nodeData.sourceType === ModSourceType.Modio && nodeData.platformId);
    if (!isNexus && !isModio) return null;

    const nexus = isNexus ? ModSupport.nexusState(nexusDomainOf(nodeData.url), nodeData.platformId, version) : undefined;
    const modio = isModio ? ModSupport.modioState(nodeData.platformId, version) : undefined;

    let liked: React.ReactNode = null;
    let following: React.ReactNode = null;
    if (nexus?.endorsement === 'Endorsed') {
        liked = <Tooltip title={t('support.isEndorsed')}><LikeFilled className="mod-status-icon mod-status-on"/></Tooltip>;
    }
    if (nexus?.tracked) {
        following = <Tooltip title={t('support.isTracked')}><EyeFilled className="mod-status-icon mod-status-on"/></Tooltip>;
    }
    if (modio?.rating === 1) {
        liked = <Tooltip title={t('support.isLiked')}><LikeFilled className="mod-status-icon mod-status-on"/></Tooltip>;
    } else if (modio?.rating === -1) {
        liked = <Tooltip title={t('support.isDisliked')}><DislikeFilled className="mod-status-icon mod-status-down"/></Tooltip>;
    }
    if (modio?.subscribed) {
        following = <Tooltip title={t('support.isSubscribed')}><BellFilled className="mod-status-icon mod-status-on"/></Tooltip>;
    }

    if (!liked && !following) return null;
    return (
        <span className="mod-status-inline" onMouseDown={stop} onClick={stop} onDoubleClick={stop}>
            {liked}{following}
        </span>
    );
}
