import React, {useEffect, useRef, useState, useSyncExternalStore} from "react";
import {t} from "i18next";
import {Button, Flex, message, Select, theme, Tooltip} from "antd";
import {ClearOutlined, CloseOutlined, CopyOutlined, FileTextOutlined, FolderOpenOutlined} from "@ant-design/icons";
import {appLogDir, join} from "@tauri-apps/api/path";
import {openPath} from "@tauri-apps/plugin-opener";
import {ActivityEntry, ActivityLevel, ActivityLog, formatLogTime, LOG_PANEL_HEIGHT} from "@/services/ActivityLog";
import {AppLogs, LEGACY_STAMP, stampDate, type LogSession} from "@/services/AppLogs";

const CURRENT = "current";

function sessionLabel(session: LogSession): string {
    if (session.stamp === LEGACY_STAMP) return t("log.legacyLaunch");
    const date = stampDate(session.stamp);
    const when = date ? date.toLocaleString(undefined, {dateStyle: "medium", timeStyle: "short"}) : session.stamp;
    return session.current ? t("log.thisLaunchAt", {when}) : when;
}

/**
 * Log state for components. Values come from the store's snapshot (a new object on every
 * change) rather than direct store calls, which the React Compiler would cache forever.
 */
export function useActivityLog() {
    const snap = useSyncExternalStore(ActivityLog.subscribe, ActivityLog.getSnapshot);
    return {
        version: snap,
        entries: snap.entries,
        open: snap.open,
        unseenProblems: snap.unseenProblems,
    };
}

/** Height the open panel takes away from page content (re-renders only on open/close) */
export function useLogPanelOffset(): number {
    return useSyncExternalStore(
        (cb) => ActivityLog.subscribeOpen(cb),
        () => ActivityLog.getPanelOffset()
    );
}

function EntryLine({entry, colors}: { entry: ActivityEntry; colors: Record<ActivityLevel, string | undefined> }) {
    const prefix = entry.level === 'error' ? 'ERROR: ' : entry.level === 'warning' ? 'WARN: ' : '';
    return (
        <div style={{color: colors[entry.level], whiteSpace: "pre-wrap", wordBreak: "break-word"}}>
            [{formatLogTime(entry.time)}] [{entry.source}] {prefix}{entry.message}
            {entry.detail && <span style={{opacity: 0.75}}>{"  "}{entry.detail}</span>}
        </div>
    );
}

/** "● Errors" style filter toggle */
function DotToggle({label, color, count, active, onClick}: {
    label: string; color: string; count: number; active: boolean; onClick: () => void;
}) {
    return (
        <Button size="small" type={active ? "default" : "text"} onClick={onClick}>
            <span style={{
                display: "inline-block", width: 8, height: 8, borderRadius: 4,
                background: color, marginRight: 4, verticalAlign: "middle"
            }}/>
            {label}{count > 0 ? ` (${count})` : ""}
        </Button>
    );
}

/**
 * Bottom log panel (docked above the status bar), styled after Amethyst's log
 */
export function LogPanel() {
    const {token} = theme.useToken();
    const {entries: liveEntries, open, version} = useActivityLog();
    // an earlier launch's entries instead of this launch's
    const [viewing, setViewing] = useState<string>(CURRENT);
    const [sessions, setSessions] = useState<LogSession[]>([]);
    const [pastEntries, setPastEntries] = useState<ActivityEntry[]>([]);
    const viewingSession = viewing === CURRENT ? undefined : sessions.find(s => s.stamp === viewing);
    const entries: readonly ActivityEntry[] = viewing === CURRENT ? liveEntries : pastEntries;
    const loadSessions = async () => {
        try {
            setSessions(await AppLogs.sessions());
        } catch (error) {
            console.warn('[LogPanel] earlier logs not listed', error);
        }
    };
    const showSession = async (stamp: string) => {
        setViewing(stamp);
        stickToBottom.current = true;
        if (stamp === CURRENT) return;
        const session = sessions.find(s => s.stamp === stamp);
        try {
            setPastEntries(session ? await AppLogs.readActivity(session) : []);
        } catch (error) {
            setPastEntries([]);
            message.error(`${t("log.readFailed")}: ${error}`);
        }
    };
    // the list of earlier launches is ready when the picker opens
    useEffect(() => {
        if (open) void loadSessions();
    }, [open]);
    const [showErrors, setShowErrors] = useState(false);
    const [showWarnings, setShowWarnings] = useState(false);
    const bodyRef = useRef<HTMLDivElement>(null);
    const stickToBottom = useRef(true);

    const colors: Record<ActivityLevel, string | undefined> = {
        info: undefined,
        success: token.colorSuccess,
        warning: token.colorWarning,
        error: token.colorError,
    };

    const errorCount = entries.filter(e => e.level === 'error').length;
    const warningCount = entries.filter(e => e.level === 'warning').length;
    // Neither toggle on = everything; otherwise only the toggled levels
    const visible = (showErrors || showWarnings)
        ? entries.filter(e => (showErrors && e.level === 'error') || (showWarnings && e.level === 'warning'))
        : entries;

    useEffect(() => {
        const el = bodyRef.current;
        if (el && stickToBottom.current) {
            el.scrollTop = el.scrollHeight;
        }
    }, [version, showErrors, showWarnings, open, viewing, pastEntries]);

    if (!open) {
        return null;
    }

    const onScroll = () => {
        const el = bodyRef.current;
        if (el) {
            stickToBottom.current = el.scrollHeight - el.scrollTop - el.clientHeight < 24;
        }
    };

    const onCopy = async () => {
        try {
            await navigator.clipboard.writeText(viewing === CURRENT ? ActivityLog.asText() : visible.map(e =>
                `[${formatLogTime(e.time)}] [${e.source}] ${e.level === 'error' ? 'ERROR: ' : e.level === 'warning' ? 'WARN: ' : ''}${e.message}${e.detail ? ` — ${e.detail}` : ''}`).join('\n'));
            message.success(t("log.copied"));
        } catch {
            message.error(t("log.copyFailed"));
        }
    };

    // the full log file of the launch shown (the panel only has the summary)
    const onOpenFullLog = async () => {
        try {
            const list = viewingSession ? [viewingSession] : (await AppLogs.sessions()).filter(s => s.current);
            const file = list[0]?.files.find(f => f.kind === 'log');
            if (!file) {
                message.info(t("log.noFullLog"));
                return;
            }
            await openPath(await join(await appLogDir(), file.name));
        } catch (e) {
            message.error(`${t("log.openFolderFailed")}: ${e}`);
        }
    };

    const onOpenFolder = async () => {
        try {
            await openPath(await appLogDir());
        } catch (e) {
            message.error(`${t("log.openFolderFailed")}: ${e}`);
        }
    };

    return (
        <div className="log-panel" style={{
            height: LOG_PANEL_HEIGHT,
            display: "flex",
            flexDirection: "column",
            borderTop: `1px solid ${token.colorBorderSecondary}`,
            background: token.colorBgContainer,
            position: "relative",
            zIndex: 5,
        }}>
            <div ref={bodyRef}
                 onScroll={onScroll}
                 style={{
                     flex: 1,
                     overflowY: "auto",
                     padding: "4px 8px",
                     fontFamily: "ui-monospace, 'DejaVu Sans Mono', 'Noto Sans Mono', monospace",
                     fontSize: 12,
                     lineHeight: 1.45,
                 }}>
                {visible.length === 0
                    ? <div style={{opacity: 0.6}}>
                        {viewingSession && !viewingSession.files.some(f => f.kind === 'activity')
                            ? t(viewingSession.stamp === LEGACY_STAMP ? "log.legacyOnlyFullLog" : "log.onlyFullLog")
                            : t((showErrors || showWarnings) ? "log.noProblems" : "log.empty")}
                    </div>
                    : visible.map(entry => <EntryLine key={entry.id} entry={entry} colors={colors}/>)}
            </div>
            <Flex align="center" gap={2} style={{padding: "2px 6px", borderTop: `1px solid ${token.colorBorderSecondary}`}}>
                <Tooltip title={t("log.launchTip")} mouseEnterDelay={0.5}>
                    <Select size="small"
                            value={viewing}
                            title=""
                            style={{width: 210}}
                            popupMatchSelectWidth={false}
                            onOpenChange={(isOpen) => {
                                if (isOpen) void loadSessions();
                            }}
                            onChange={(value: string) => void showSession(value)}
                            options={[
                                // labels as elements: no native tooltip repeating the text
                                {value: CURRENT, label: <span>{t("log.thisLaunch")}</span>},
                                ...sessions.filter(s => !s.current).map(s => ({value: s.stamp, label: <span>{sessionLabel(s)}</span>})),
                            ]}/>
                </Tooltip>
                <DotToggle label={t("log.errors")} color={token.colorError} count={errorCount}
                           active={showErrors} onClick={() => setShowErrors(!showErrors)}/>
                <DotToggle label={t("log.warnings")} color={token.colorWarning} count={warningCount}
                           active={showWarnings} onClick={() => setShowWarnings(!showWarnings)}/>
                <Button size="small" type="text" icon={<CopyOutlined/>} onClick={onCopy}>{t("log.copy")}</Button>
                <Button size="small" type="text" icon={<ClearOutlined/>} disabled={viewing !== CURRENT}
                        onClick={() => ActivityLog.clear()}>{t("log.clear")}</Button>
                <Button size="small" type="text" icon={<FileTextOutlined/>} onClick={onOpenFullLog}>{t("log.openFullLog")}</Button>
                <Button size="small" type="text" icon={<FolderOpenOutlined/>} onClick={onOpenFolder}>{t("log.openFolder")}</Button>
                <span style={{flex: 1}}/>
                <Tooltip title={t("log.close")}>
                    <Button size="small" type="text" icon={<CloseOutlined/>} onClick={() => ActivityLog.setOpen(false)}/>
                </Tooltip>
            </Flex>
        </div>
    );
}

/**
 * Toggle button for the status bar; shows a count of new problems while closed
 */
export function LogToggleButton() {
    const {open, unseenProblems} = useActivityLog();
    const {token} = theme.useToken();
    return (
        <Button size="small"
                type={open ? "default" : "text"}
                onClick={() => ActivityLog.toggle()}
                style={{marginLeft: 6}}>
            {t("log.title")}
            {!open && unseenProblems > 0 &&
                <span style={{
                    marginLeft: 6,
                    background: token.colorError,
                    color: "#fff",
                    borderRadius: 8,
                    padding: "0 6px",
                    fontSize: 11,
                    lineHeight: "16px",
                }}>{unseenProblems}</span>}
        </Button>
    );
}

export default React.memo(LogPanel);
