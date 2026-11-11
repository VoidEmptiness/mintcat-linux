/**
 * File-by-file preview of a mod settings import or restore: what each file is, whether it is
 * new / newer / older than the one in the game folder, and a checkbox to pick it.
 */
import {Table, Tag, Tooltip, Typography} from "antd";
import {t} from "i18next";
import type {ImportItem, ImportStatus, SettingsFile} from "@/services/ModSettingsFiles";

export function formatBytes(bytes?: number): string {
    if (bytes === undefined || Number.isNaN(bytes)) return "-";
    if (bytes < 1024) return `${bytes} B`;
    const units = ["KB", "MB", "GB"];
    let value = bytes / 1024;
    let i = 0;
    while (value >= 1024 && i < units.length - 1) {
        value /= 1024;
        i++;
    }
    return `${value.toFixed(value < 10 ? 1 : 0)} ${units[i]}`;
}

export function formatDate(ms?: number): string {
    if (!ms) return "";
    return new Date(ms).toLocaleString();
}

const STATUS_COLOR: Record<ImportStatus, string> = {
    new: "green",
    newer: "blue",
    older: "orange",
    changed: "gold",
    same: "default",
    protected: "red",
};

export function StatusTag({status}: { status: ImportStatus }) {
    return (
        <Tooltip title={t(`modSettings.statusHelp.${status}`)}>
            <Tag color={STATUS_COLOR[status]} style={{marginInlineEnd: 0}}>{t(`modSettings.status.${status}`)}</Tag>
        </Tooltip>
    );
}

function FileInfo({file}: { file?: SettingsFile }) {
    if (!file) return <Typography.Text type="secondary">—</Typography.Text>;
    return (
        <Typography.Text style={{fontSize: 12}}>
            {formatBytes(file.size)}
            {file.mtime ? <><br/><Typography.Text type="secondary" style={{fontSize: 12}}>{formatDate(file.mtime)}</Typography.Text></> : null}
        </Typography.Text>
    );
}

export function SettingsFilesTable({items, selected, onChange, incomingLabel, height = 300}: {
    items: ImportItem[];
    selected: string[];
    onChange: (rels: string[]) => void;
    incomingLabel: string;
    height?: number;
}) {
    return (
        <Table<ImportItem>
            size="small"
            rowKey="rel"
            dataSource={items}
            pagination={false}
            scroll={{y: height}}
            rowSelection={{
                selectedRowKeys: selected,
                onChange: (keys) => onChange(keys as string[]),
                getCheckboxProps: (item) => ({disabled: item.status === "protected"}),
            }}
            columns={[
                {
                    title: t("modSettings.col.file"),
                    dataIndex: "rel",
                    ellipsis: {showTitle: true},
                },
                {
                    title: t("modSettings.col.status"),
                    width: 170,
                    render: (_, item) => <StatusTag status={item.status}/>,
                },
                {
                    title: t("modSettings.col.yours"),
                    width: 160,
                    render: (_, item) => <FileInfo file={item.existing}/>,
                },
                {
                    title: incomingLabel,
                    width: 160,
                    render: (_, item) => <FileInfo file={item.incoming}/>,
                },
            ]}
        />
    );
}
