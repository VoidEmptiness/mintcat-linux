/**
 * The marks of a mod row: your note (click to edit, hover to read), endorsed on Nexus Mods /
 * liked or disliked on mod.io, tracked on Nexus Mods / subscribed on mod.io.
 *
 * Columns view (Settings → Mod list): fixed cells at the right of each row under a "Flags"
 * header, so the marks line up; a cell stays empty when it doesn't apply. The note cell is
 * there once any mod has a note, the other two when a Nexus key or mod.io token is saved.
 * Compact view: only the marks a mod has, right after its tags.
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
import {ModListAppearance} from "@/services/ModListAppearance";

const stop = (e: React.SyntheticEvent) => e.stopPropagation();

/** Which flag cells the columns view shows (the same for every row and the header) */
export function useFlagColumns(): { notes: boolean; support: boolean; columns: boolean } {
    useSyncExternalStore(ModNotes.subscribe, ModNotes.version);
    useSyncExternalStore(ModSupport.subscribe, ModSupport.version);
    const look = ModListAppearance.get(useSyncExternalStore(ModListAppearance.subscribe, ModListAppearance.version));
    return {notes: ModNotes.hasAny(), support: ModSupport.anyAccount(), columns: look.columns};
}

export function ModStatusIcons({nodeData}: { nodeData: any }) {
    const {notes: showNotes, support: showSupport, columns} = useFlagColumns();
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
    const noteIcon = note ? (
        <Tooltip title={<div className="mod-note-tooltip">{note}</div>} styles={{root: {maxWidth: 420}}}>
            <FileTextFilled className="mod-status-icon mod-status-note"
                            role="button"
                            aria-label={t('notes.editMenu')}
                            onClick={(e) => {
                                e.stopPropagation();
                                void editModNote(nodeData.modId, name);
                            }}/>
        </Tooltip>
    ) : null;

    if (!columns) {
        if (!noteIcon && !liked && !following) return null;
        return (
            <span className="mod-status-inline" onMouseDown={stop} onDoubleClick={stop}>
                {noteIcon}{liked}{following}
            </span>
        );
    }
    return (
        <span className="mod-status-columns" onMouseDown={stop} onDoubleClick={stop}>
            {showNotes && <span className="mod-status-cell">{noteIcon}</span>}
            {showSupport && <span className="mod-status-cell">{liked}</span>}
            {showSupport && <span className="mod-status-cell">{following}</span>}
        </span>
    );
}

/** Column titles over the list (columns view only) */
export function ModListColumnsHeader() {
    const {notes, support, columns} = useFlagColumns();
    if (!columns) return null;
    const flagCells = (notes ? 1 : 0) + (support ? 2 : 0);
    return (
        <div className="mod-list-header" role="row">
            <span className="mod-list-header-name">{t('modList.colMod')}</span>
            <span className="mod-list-header-tags">{t('modList.colTags')}</span>
            {flagCells > 0 && (
                <Tooltip title={[notes ? t('modList.colNoteTip') : '', support ? t('modList.colSupportTip') : ''].filter(Boolean).join(' ')}>
                    <span className="mod-list-header-flags" style={{width: flagCells * 20 - 2}}>{t('modList.colFlags')}</span>
                </Tooltip>
            )}
        </div>
    );
}
