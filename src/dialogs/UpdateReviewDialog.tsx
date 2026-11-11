/**
 * Review of local mods that have a newer file on Pak Hub (or another repository). Nothing is
 * replaced until the user ticks it: each mod shows the file it has now and every candidate,
 * with where it was posted, by whom, when, how big, and the change notes posted with it.
 */
import React from "react";
import {Alert, Button, Checkbox, Collapse, Flex, Modal, Radio, Tag, Tooltip, Typography, message} from "antd";
import {ExportOutlined, WarningOutlined} from "@ant-design/icons";
import {t} from "i18next";
import {open as openUrl} from "@tauri-apps/plugin-shell";
import {RepositoryUpdates, type UpdateCandidate, type UpdateReview} from "@/services/RepositoryUpdates";
import {formatBytes} from "@/dialogs/backup/SettingsFilesTable";

function when(value?: string | number): string {
    if (!value) return "";
    const d = typeof value === "number" ? new Date(value) : new Date(value);
    return Number.isNaN(d.getTime()) ? "" : d.toLocaleString();
}

function CandidateInfo({candidate, review}: { candidate: UpdateCandidate; review: UpdateReview }) {
    const {upload} = candidate;
    const sizeChange = review.current.size !== undefined ? upload.sizeBytes - review.current.size : undefined;
    return (
        <Flex vertical gap={4} style={{minWidth: 0}}>
            <Flex gap={6} wrap align="center">
                <Typography.Text strong>{upload.filename}</Typography.Text>
                <Typography.Text type="secondary" style={{fontSize: 12}}>
                    {formatBytes(upload.sizeBytes)}
                    {sizeChange !== undefined && sizeChange !== 0 && ` (${sizeChange > 0 ? "+" : "−"}${formatBytes(Math.abs(sizeChange))})`}
                    {" · "}{t("updateReview.postedBy", {date: when(upload.postedAt), name: upload.postedBy})}
                </Typography.Text>
            </Flex>
            <Flex gap={4} wrap>
                {candidate.samePost
                    ? <Tooltip title={t("updateReview.samePostHelp")}><Tag color="green">{t("updateReview.samePost")}</Tag></Tooltip>
                    : <Tooltip title={t("updateReview.otherPostHelp")}><Tag color="orange" icon={<WarningOutlined/>}>{t("updateReview.otherPost")}</Tag></Tooltip>}
                {candidate.sameUploader
                    ? <Tag color="green">{t("updateReview.sameUploader")}</Tag>
                    : <Tooltip title={t("updateReview.otherUploaderHelp")}><Tag color="orange">{t("updateReview.otherUploader")}</Tag></Tooltip>}
                {candidate.renamed
                    ? <Tooltip title={t("updateReview.renamedHelp")}><Tag color="blue">{t("updateReview.renamed")}</Tag></Tooltip>
                    : <Tag>{t("updateReview.sameName")}</Tag>}
                {upload.fromThread && <Tag>{t("updateReview.inThread")}</Tag>}
            </Flex>
            <Typography.Text type="secondary" style={{fontSize: 12}}>
                {t("updateReview.post")}: <Typography.Link onClick={() => void openUrl(candidate.postUrl)}>
                {candidate.postTitle} <ExportOutlined/>
            </Typography.Link>
            </Typography.Text>
            {candidate.notes.length > 0 && (
                <Collapse size="small" ghost items={[{
                    key: "notes",
                    label: t("updateReview.notes", {count: candidate.notes.length}),
                    children: (
                        <Flex vertical gap={8}>
                            {candidate.notes.map(note => (
                                <div key={`${note.postedAt}-${note.filename}`}>
                                    <Typography.Text type="secondary" style={{fontSize: 12}}>
                                        {when(note.postedAt)} · {note.postedBy} · {note.filename}
                                    </Typography.Text>
                                    <Typography.Paragraph style={{whiteSpace: "pre-wrap", margin: 0, fontSize: 13}}
                                                          ellipsis={{rows: 6, expandable: true}}>
                                        {note.text}
                                    </Typography.Paragraph>
                                </div>
                            ))}
                        </Flex>
                    ),
                }]}/>
            )}
        </Flex>
    );
}

export function UpdateReviewDialog({reviews, onClose}: {
    reviews: UpdateReview[];
    onClose: (applied: number) => void;
}) {
    // mod id → chosen candidate key ("" = keep my file)
    const [choice, setChoice] = React.useState<Record<number, string>>(() => {
        const initial: Record<number, string> = {};
        for (const review of reviews) {
            const recommended = review.candidates.find(c => c.recommended);
            initial[review.mod.modId!] = recommended?.key ?? "";
        }
        return initial;
    });
    const [working, setWorking] = React.useState(false);
    const [progress, setProgress] = React.useState(0);

    const chosen = reviews.filter(r => choice[r.mod.modId!]);

    const run = async () => {
        setWorking(true);
        let applied = 0;
        let i = 0;
        for (const review of chosen) {
            const candidate = review.candidates.find(c => c.key === choice[review.mod.modId!]);
            setProgress(++i);
            if (!candidate) continue;
            try {
                await RepositoryUpdates.applyCandidate(review, candidate);
                applied++;
            } catch (e) {
                message.error(t("repoUpdate.failed", {name: RepositoryUpdates.modName(review.mod), reason: String(e)}));
            }
        }
        setWorking(false);
        if (applied) message.success(t("updateReview.applied", {count: applied}));
        onClose(applied);
    };

    const setAll = (on: boolean) => {
        const next: Record<number, string> = {};
        for (const review of reviews) {
            next[review.mod.modId!] = on ? (review.candidates.find(c => c.recommended) ?? review.candidates[0]).key : "";
        }
        setChoice(next);
    };

    return (
        <Modal open
               width={920}
               title={t("updateReview.title", {count: reviews.length})}
               maskClosable={false}
               onCancel={() => !working && onClose(0)}
               footer={
                   <Flex justify="space-between" align="center">
                       <Flex gap={8}>
                           <Button size="small" onClick={() => setAll(true)} disabled={working}>{t("updateReview.pickAll")}</Button>
                           <Button size="small" onClick={() => setAll(false)} disabled={working}>{t("updateReview.pickNone")}</Button>
                       </Flex>
                       <Flex gap={8}>
                           <Button onClick={() => onClose(0)} disabled={working}>{t("updateReview.notNow")}</Button>
                           <Button type="primary" loading={working} disabled={chosen.length === 0} onClick={run}>
                               {working
                                   ? t("updateReview.working", {done: progress, count: chosen.length})
                                   : t("updateReview.replace", {count: chosen.length})}
                           </Button>
                       </Flex>
                   </Flex>
               }>
            <Flex vertical gap={10}>
                <Typography.Text type="secondary">{t("updateReview.intro")}</Typography.Text>
                <div style={{maxHeight: "58vh", overflowY: "auto", paddingRight: 4}}>
                    <Flex vertical gap={10}>
                        {reviews.map(review => {
                            const id = review.mod.modId!;
                            const picked = choice[id] ?? "";
                            return (
                                <div key={id} style={{
                                    border: "1px solid rgba(128,128,128,0.3)",
                                    borderRadius: 8,
                                    padding: "8px 12px",
                                }}>
                                    <Flex justify="space-between" align="center" gap={8}>
                                        <Checkbox checked={!!picked}
                                                  disabled={working}
                                                  onChange={e => setChoice({
                                                      ...choice,
                                                      [id]: e.target.checked
                                                          ? (review.candidates.find(c => c.recommended) ?? review.candidates[0]).key
                                                          : "",
                                                  })}>
                                            <Typography.Text strong style={{fontSize: 15}}>
                                                {RepositoryUpdates.modName(review.mod)}
                                            </Typography.Text>
                                        </Checkbox>
                                        {!review.versionKnown && (
                                            <Tooltip title={t("updateReview.unknownVersionHelp")}>
                                                <Tag color="gold">{t("updateReview.unknownVersion")}</Tag>
                                            </Tooltip>
                                        )}
                                    </Flex>
                                    <Typography.Text type="secondary" style={{fontSize: 12, display: "block", margin: "2px 0 6px 24px"}}>
                                        {t("updateReview.current")}: {review.current.filename}
                                        {review.current.size !== undefined && ` · ${formatBytes(review.current.size)}`}
                                        {review.current.postedAt
                                            ? ` · ${t("updateReview.postedBy", {date: when(review.current.postedAt), name: review.current.postedBy ?? "?"})}`
                                            : review.current.modifiedAt ? ` · ${t("updateReview.modified", {date: when(review.current.modifiedAt)})}` : ""}
                                    </Typography.Text>
                                    <div style={{marginLeft: 24}}>
                                        {review.candidates.length === 1 ? (
                                            <CandidateInfo candidate={review.candidates[0]} review={review}/>
                                        ) : (
                                            <Radio.Group value={picked || undefined}
                                                         disabled={working}
                                                         onChange={e => setChoice({...choice, [id]: e.target.value})}>
                                                <Flex vertical gap={10}>
                                                    {review.candidates.map(candidate => (
                                                        <Radio key={candidate.key} value={candidate.key} style={{alignItems: "flex-start"}}>
                                                            <CandidateInfo candidate={candidate} review={review}/>
                                                        </Radio>
                                                    ))}
                                                </Flex>
                                            </Radio.Group>
                                        )}
                                    </div>
                                </div>
                            );
                        })}
                    </Flex>
                </div>
                <Alert type="info" showIcon style={{fontSize: 12}} message={t("updateReview.safety")}/>
            </Flex>
        </Modal>
    );
}
