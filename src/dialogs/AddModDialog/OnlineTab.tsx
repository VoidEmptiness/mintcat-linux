import React, {useState, useEffect} from "react";
import {Flex, Form, Spin, Tooltip, Typography} from "antd";
import {t} from "i18next";
import TextArea from "antd/es/input/TextArea";
import {CheckCircleFilled, CloseCircleFilled, InfoCircleOutlined, WarningFilled} from "@ant-design/icons";
import {ModioApi} from "@/apis/modio";
import {ModcatApi} from "@/apis/modcat";
import {NexusModsApi} from "@/apis/nexusmods";
import {splitLines} from "@/utils/LocalModPaths";
import {itemKey, type ItemFolders} from "@/dialogs/AddModDialog/ItemFolders";
import {ItemFolderSelect} from "@/dialogs/AddModDialog/ItemFolderSelect";

type LinkStatus =
    | { state: 'checking' }
    | { state: 'found'; name: string }
    | { state: 'notFound' }
    | { state: 'invalid' }
    | { state: 'error'; message: string }
    | { state: 'unchecked' };

/** Results survive closing/reopening the dialog for this session */
const linkCache = new Map<string, LinkStatus>();
const CHECK_DELAY_MS = 500;
const MAX_PARALLEL = 3;

async function checkLink(link: string): Promise<LinkStatus> {
    if (ModioApi.parseModLinks(link)) {
        const r = await ModioApi.lookupModLink(link);
        if (r.status === 'found') return {state: 'found', name: r.name};
        if (r.status === 'notFound') return {state: 'notFound'};
        if (r.status === 'invalid') return {state: 'invalid'};
        return {state: 'error', message: r.message};
    }
    // Nexus and ModCat: their names, so you can tell which mod a link is (they're checked
    // fully when you press OK; a failed name lookup doesn't stop that)
    const lookup = NexusModsApi.isNexusModsLink(link) ? NexusModsApi.lookupModLink(link)
        : ModcatApi.isModcatLink(link) ? ModcatApi.lookupModLink(link) : null;
    if (!lookup) return {state: 'invalid'};
    const r = await lookup;
    if (r.status === 'found') return {state: 'found', name: r.name};
    if (r.status === 'invalid') return {state: 'invalid'};
    // not in the public list (e.g. a Nexus mod hidden from searches without a login) or no
    // answer: the full check when you press OK decides
    return {state: 'unchecked'};
}

function StatusRow({link, status, folders}: { link: string; status: LinkStatus; folders?: ItemFolders }) {
    let icon: React.ReactNode;
    let label: React.ReactNode;
    switch (status.state) {
        case 'checking':
            icon = <Spin size="small"/>;
            label = <Typography.Text type="secondary">{t("linkCheck.checking")}</Typography.Text>;
            break;
        case 'found':
            icon = <CheckCircleFilled style={{color: '#52c41a'}}/>;
            label = <Typography.Text strong>{status.name}</Typography.Text>;
            break;
        case 'notFound':
            icon = <CloseCircleFilled style={{color: '#ff4d4f'}}/>;
            label = <Typography.Text type="danger">{t("linkCheck.notFound")}</Typography.Text>;
            break;
        case 'invalid':
            icon = <CloseCircleFilled style={{color: '#ff4d4f'}}/>;
            label = <Typography.Text type="danger">{t("linkCheck.invalid")}</Typography.Text>;
            break;
        case 'error':
            icon = <WarningFilled style={{color: '#faad14'}}/>;
            // Keep it to one line; the full reason (e.g. mod.io login) is on hover
            label = (
                <Tooltip title={status.message}>
                    <Typography.Text type="warning" style={{cursor: "help"}}>{t("linkCheck.errorShort")}</Typography.Text>
                </Tooltip>
            );
            break;
        default:
            icon = <InfoCircleOutlined style={{opacity: 0.6}}/>;
            label = <Typography.Text type="secondary">{t("linkCheck.unchecked")}</Typography.Text>;
    }
    return (
        <Flex gap={6} align="baseline" style={{fontSize: 12, lineHeight: 1.5}}>
            <span style={{flexShrink: 0, width: 14}}>{icon}</span>
            <Flex vertical style={{minWidth: 0, flex: 1}}>
                {label}
                <Typography.Text type="secondary"
                                 style={{fontSize: 11, fontFamily: "monospace", whiteSpace: "nowrap", overflow: "hidden", textOverflow: "ellipsis"}}
                                 title={link}>
                    {link}
                </Typography.Text>
            </Flex>
            {/* nothing to place for a link that can't be added */}
            {status.state !== 'invalid' && status.state !== 'notFound' &&
                <span style={{alignSelf: "center"}}>
                    <ItemFolderSelect folders={folders} itemKey={itemKey.link(link)}/>
                </span>}
        </Flex>
    );
}

export const OnlineTab = React.forwardRef(({text, revision, folders}: {
    text?: string;
    revision?: number;
    folders?: ItemFolders;
}, ref) => {

    const [url, setUrl] = useState<string>(text ?? "");
    const [statuses, setStatuses] = useState<Record<string, LinkStatus>>({});

    // 当 text prop 变化时更新 url state (the dialog already merged new links into it)
    useEffect(() => {
        if (text !== undefined) {
            setUrl(text);
        }
    }, [text, revision]);

    const links = [...new Set(splitLines(url))];

    // tell the dialog which mods are listed (for "N mod(s) go to another folder")
    const report = folders?.report;
    useEffect(() => {
        report?.("link", links.map(itemKey.link));
    }, [links.join("\n"), report]);

    // Check each link shortly after typing stops
    useEffect(() => {
        let cancelled = false;
        const timer = setTimeout(async () => {
            const initial: Record<string, LinkStatus> = {};
            const pending: string[] = [];
            for (const link of links) {
                const cached = linkCache.get(link);
                if (cached) {
                    initial[link] = cached;
                } else {
                    initial[link] = {state: 'checking'};
                    pending.push(link);
                }
            }
            if (!cancelled) setStatuses(initial);

            let next = 0;
            const worker = async () => {
                while (!cancelled && next < pending.length) {
                    const link = pending[next++];
                    let status: LinkStatus;
                    try {
                        status = await checkLink(link);
                    } catch (e) {
                        status = {state: 'error', message: String(e)};
                    }
                    // Don't cache errors (e.g. offline) so they're retried
                    if (status.state !== 'error') linkCache.set(link, status);
                    if (!cancelled) setStatuses(prev => ({...prev, [link]: status}));
                }
            };
            await Promise.all(Array.from({length: Math.min(MAX_PARALLEL, pending.length)}, worker));
        }, CHECK_DELAY_MS);
        return () => {
            cancelled = true;
            clearTimeout(timer);
        };
    }, [links.join("\n")]);

    React.useImperativeHandle(ref, () => ({
        getText: () => url,
        submit: () => {
            const result: string[] = [];
            if (!url) {
                return result;
            }

            const mods = url.trim();
            const list = mods.split("\n");
            for (const item of list) {
                const trimmedItem = item.trim();
                if (trimmedItem && result.indexOf(trimmedItem) === -1) {
                    result.push(trimmedItem);
                }
            }
            return result;
        }
    }));

    const onTextChange = (e) => {
        setUrl(e.target.value);
    }

    const problems = links.filter(l => ['notFound', 'invalid'].includes(statuses[l]?.state ?? '')).length;

    return (
        <Form layout="vertical">
            <Form.Item name="modLinks"
                       label={t("Mod Links")}
                       rules={[{required: true}]}
            >
                <Flex vertical gap={6}>
                    <TextArea value={url}
                              onChange={onTextChange}
                              placeholder="https://mod.io/g/drg/m/xxx&#10;https://www.nexusmods.com/xxxx/mods/1&#10;https://modcat.top/#/modDetail?ModId=xxx&#10;"
                              rows={5}
                    />
                    {links.length > 0 &&
                        <Flex vertical gap={4} style={{maxHeight: 190, overflowY: "auto", paddingRight: 4}}>
                            {problems > 0 &&
                                <Typography.Text type="danger" style={{fontSize: 12}}>
                                    {t("linkCheck.problems", {count: problems})}
                                </Typography.Text>}
                            {links.map(link => (
                                <StatusRow key={link} link={link} status={statuses[link] ?? {state: 'checking'}} folders={folders}/>
                            ))}
                        </Flex>}
                </Flex>
            </Form.Item>
        </Form>
    )
});
