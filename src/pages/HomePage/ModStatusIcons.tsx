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
import {ContextMenu} from "@/components/ContextMenu";
import {Tooltip} from "antd";
import {BellFilled, DislikeFilled, EyeFilled, FileTextFilled, LikeFilled} from "@ant-design/icons";
import {t} from "i18next";
import {ModNotes} from "@/services/ModNotes";
import {ModSupport, nexusDomainOf} from "@/services/ModSupport";
import {NEXUSMODS_PLATFORM} from "@/apis/nexusmods/types";
import {ModSourceType} from "@/models/mod/types";
import {editModNote} from "@/dialogs/ModNoteDialog";
import {clampColumnWidth, columnWidth, ModListAppearance, type ModListColumn} from "@/services/ModListAppearance";

const stop = (e: React.SyntheticEvent) => e.stopPropagation();

/** Which flag cells the columns view shows (the same for every row and the header) */
export function useFlagColumns(): { notes: boolean; support: boolean; columns: boolean; notesVersion: number; supportVersion: number } {
    // the versions go into every read, or React Compiler would keep the first answer
    const notesVersion = useSyncExternalStore(ModNotes.subscribe, ModNotes.version);
    const supportVersion = useSyncExternalStore(ModSupport.subscribe, ModSupport.version);
    const look = ModListAppearance.get(useSyncExternalStore(ModListAppearance.subscribe, ModListAppearance.version));
    return {
        notes: ModNotes.hasAny(notesVersion), support: ModSupport.anyAccount(supportVersion), columns: look.columns,
        notesVersion, supportVersion,
    };
}

export function ModStatusIcons({nodeData}: { nodeData: any }) {
    const {notes: showNotes, support: showSupport, columns, notesVersion, supportVersion} = useFlagColumns();
    if (!showNotes && !showSupport) return null;

    const name = nodeData.title || nodeData.nameId || "";
    const note = ModNotes.get(nodeData.modId, notesVersion);
    const isNexus = nodeData.sourceType === NEXUSMODS_PLATFORM && nodeData.platformId;
    const isModio = nodeData.sourceType === ModSourceType.Modio && nodeData.platformId;
    const nexus = isNexus ? ModSupport.nexusState(nexusDomainOf(nodeData.url), nodeData.platformId, supportVersion) : undefined;
    const modio = isModio ? ModSupport.modioState(nodeData.platformId, supportVersion) : undefined;

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

/** Column titles over the list (columns view only); drag a column's left edge to resize it */
export function ModListColumnsHeader() {
    const {notes, support, columns} = useFlagColumns();
    if (!columns) return null;
    const flagCells = (notes ? 1 : 0) + (support ? 2 : 0);
    const title = (column: ModListColumn, label: string, tip: string) => (
        <span className={`mod-col mod-col-${column} mod-list-header-col`}>
            <ColumnResizer column={column}/>
            <Tooltip title={tip} mouseEnterDelay={0.4}>
                <span className="mod-list-header-label">{label}</span>
            </Tooltip>
        </span>
    );
    return (
        <ContextMenu
                  menu={{
                      items: [{key: 'reset', label: t('cols.resetWidths')}],
                      onClick: () => void ModListAppearance.resetColumnWidth(),
                  }}>
            <div className="mod-list-header" role="row">
                <span className="mod-list-header-name">{t('modList.colMod')}</span>
                {title('version', t('cols.version'), t('cols.versionHeaderTip'))}
                {title('game', t('cols.game'), t('cols.gameHeaderTip'))}
                {title('status', t('cols.status'), t('cols.statusHeaderTip'))}
                {title('tags', t('modList.colTags'), t('cols.tagsHeaderTip'))}
                {flagCells > 0 && (
                    <Tooltip title={[notes ? t('modList.colNoteTip') : '', support ? t('modList.colSupportTip') : ''].filter(Boolean).join(' ')}>
                        <span className="mod-list-header-flags" style={{width: flagCells * 20 - 2}}>{t('modList.colFlags')}</span>
                    </Tooltip>
                )}
            </div>
        </ContextMenu>
    );
}

/** How wide a column's content is in the rows on screen (double-click on its edge fits to it) */
function contentWidth(column: ModListColumn): number | undefined {
    let widest = 0;
    document.querySelectorAll<HTMLElement>(`.ant-tree .mod-col-${column}`).forEach(cell => {
        const select = cell.querySelector<HTMLElement>('.ant-select');
        if (select) {
            // the version picker's text is cut inside the select; measure the text itself
            const text = select.querySelector<HTMLElement>('.ant-select-selection-item, .ant-select-content-value, .ant-select-content');
            widest = Math.max(widest, (text?.scrollWidth ?? 40) + 34);
            return;
        }
        // the tags etc. as laid out in a row: from the cell's left edge to the last one's right edge
        const left = cell.getBoundingClientRect().left;
        let right = left;
        for (const child of Array.from(cell.children)) {
            right = Math.max(right, child.getBoundingClientRect().right);
        }
        widest = Math.max(widest, right - left);
    });
    return widest > 0 ? widest + 6 : undefined;
}

/**
 * The draggable edge at the left of a column title. Columns are lined up from the right, so
 * dragging left makes the column wider (the mod names give up the room). Double-click: fit the
 * column to what the rows on screen show.
 */
function ColumnResizer({column}: { column: ModListColumn }) {
    const look = ModListAppearance.get(useSyncExternalStore(ModListAppearance.subscribe, ModListAppearance.version));
    const onPointerDown = (e: React.PointerEvent<HTMLSpanElement>) => {
        if (e.button !== 0) return;
        e.preventDefault();
        e.stopPropagation();
        const handle = e.currentTarget;
        handle.setPointerCapture(e.pointerId);
        const startX = e.clientX;
        const startWidth = columnWidth(look.columnWidths, column);
        let width = startWidth;
        document.body.classList.add('mod-col-resizing');
        const move = (ev: PointerEvent) => {
            width = clampColumnWidth(startWidth + (startX - ev.clientX));
            ModListAppearance.previewColumnWidth(column, width);
        };
        const up = () => {
            handle.removeEventListener('pointermove', move);
            handle.removeEventListener('pointerup', up);
            handle.removeEventListener('pointercancel', up);
            document.body.classList.remove('mod-col-resizing');
            if (width !== startWidth) void ModListAppearance.saveColumnWidth(column, width);
        };
        handle.addEventListener('pointermove', move);
        handle.addEventListener('pointerup', up);
        handle.addEventListener('pointercancel', up);
    };
    return (
        <Tooltip title={t('cols.resizeTip')} mouseEnterDelay={0.8}>
            <span className="mod-col-resizer"
                  role="separator"
                  aria-orientation="vertical"
                  aria-label={t('cols.resizeTip')}
                  onPointerDown={onPointerDown}
                  onClick={(e) => e.stopPropagation()}
                  onDoubleClick={(e) => {
                      e.stopPropagation();
                      const fit = contentWidth(column);
                      if (fit) void ModListAppearance.saveColumnWidth(column, fit);
                      else void ModListAppearance.resetColumnWidth(column);
                  }}/>
        </Tooltip>
    );
}
