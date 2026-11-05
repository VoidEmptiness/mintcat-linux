/**
 * Small fixed columns at the right of each mod row, so the marks line up instead of piling
 * up next to the tags:
 *   note      your note on the mod (click to edit, hover to read)
 *   liked     endorsed on Nexus Mods / liked or disliked on mod.io
 *   following tracked on Nexus Mods / subscribed on mod.io
 * A column is only there when something can show in it (any note saved; a Nexus key or a
 * mod.io token saved), and a row's cell stays empty when it doesn't apply.
 */
import React, {useSyncExternalStore} from "react";
import {Tooltip} from "antd";
import {BellFilled, DislikeFilled, EyeFilled, FileTextFilled, LikeFilled} from "@ant-design/icons";
import {t} from "i18next";
import {ModNotes} from "@/services/ModNotes";
import {ModSupport, nexusDomainOf} from "@/services/ModSupport";
import {NEXUSMODS_PLATFORM} from "@/apis/nexusmods/types";
import {ModSourceType} from "@/models/mod/types";
import {editModNote} from "@/dialogs/ModNoteDialog";

const stop = (e: React.SyntheticEvent) => e.stopPropagation();

function Cell({children}: { children?: React.ReactNode }) {
    return <span className="mod-status-cell" onMouseDown={stop} onDoubleClick={stop}>{children}</span>;
}

export function ModStatusIcons({nodeData}: { nodeData: any }) {
    useSyncExternalStore(ModNotes.subscribe, ModNotes.version);
    useSyncExternalStore(ModSupport.subscribe, ModSupport.version);
    const showNotes = ModNotes.hasAny();
    const showSupport = ModSupport.anyAccount();
    if (!showNotes && !showSupport) return null;

    const name = nodeData.title || nodeData.nameId || "";
    const note = ModNotes.get(nodeData.modId);
    const isNexus = nodeData.sourceType === NEXUSMODS_PLATFORM && nodeData.platformId;
    const isModio = nodeData.sourceType === ModSourceType.Modio && nodeData.platformId;
    const nexus = isNexus ? ModSupport.nexusState(nexusDomainOf(nodeData.url), nodeData.platformId) : undefined;
    const modio = isModio ? ModSupport.modioState(nodeData.platformId) : undefined;

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

    return (
        <span className="mod-status-columns">
            {showNotes && (
                <Cell>
                    {note && (
                        <Tooltip title={<div className="mod-note-tooltip">{note}</div>}
                                 styles={{root: {maxWidth: 420}}}>
                            <FileTextFilled className="mod-status-icon mod-status-note"
                                            role="button"
                                            aria-label={t('notes.editMenu')}
                                            onClick={(e) => {
                                                e.stopPropagation();
                                                void editModNote(nodeData.modId, name);
                                            }}/>
                        </Tooltip>
                    )}
                </Cell>
            )}
            {showSupport && <Cell>{liked}</Cell>}
            {showSupport && <Cell>{following}</Cell>}
        </span>
    );
}
