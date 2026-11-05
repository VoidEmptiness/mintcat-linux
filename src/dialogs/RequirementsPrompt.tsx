/**
 * Asked when adding a mod from Browse Mods that needs other mods (Nexus Mods requirements), or
 * whose Pak Hub post names mods, load order or conflicts: which of those to add as well.
 * Mods it clearly needs are ticked; ones the author only mentions aren't.
 */
import React, {useState} from "react";
import {t} from "i18next";
import {Button, Checkbox, Flex, Tag, Typography} from "antd";
import {CheckCircleFilled, ExportOutlined, OrderedListOutlined, WarningOutlined} from "@ant-design/icons";
import {open} from "@tauri-apps/plugin-shell";
import {MessageBox} from "@/components/MessageBox";
import type {RequirementPlan, ResolvedRequirement} from "@/services/BrowseRequirements";
import {listedText, orderHintText, sourceLabel} from "@/pages/SearchPage/CardRequirements";

/** Can be ticked: MINTCAT can add it and it isn't in this profile yet */
export function canPick(req: ResolvedRequirement): boolean {
    return req.addable && !req.listed?.inActiveProfile;
}

function RequirementRow({req, checked, onToggle}: { req: ResolvedRequirement; checked: boolean; onToggle: (on: boolean) => void }) {
    const pickable = canPick(req);
    const state = listedText(req);
    return (
        <Flex gap={8} align="flex-start" className="req-prompt-row">
            <Checkbox checked={pickable && checked} disabled={!pickable} onChange={(e) => onToggle(e.target.checked)}
                      style={{marginTop: 2}}/>
            <Flex vertical gap={2} style={{minWidth: 0, flex: 1}}>
                <Flex gap={6} align="center" wrap>
                    <Typography.Text strong ellipsis style={{maxWidth: 300}}>{req.name}</Typography.Text>
                    <Tag style={{marginInlineEnd: 0, fontSize: 11}}>{sourceLabel(req)}</Tag>
                    {req.listed?.inActiveProfile && (
                        <Tag color="success" icon={<CheckCircleFilled/>} style={{marginInlineEnd: 0, fontSize: 11}}>{t('browse.inYourList')}</Tag>
                    )}
                    {req.listed && !req.listed.inActiveProfile && (
                        <Tag color="processing" style={{marginInlineEnd: 0, fontSize: 11}}>{t('req.otherProfileOnly')}</Tag>
                    )}
                    {!req.likely && <Tag style={{marginInlineEnd: 0, fontSize: 11}}>{t('req.mentionedOnly')}</Tag>}
                    {req.link && (
                        <Button size="small" type="link" icon={<ExportOutlined/>} style={{padding: 0, height: 'auto'}}
                                onClick={() => open(req.link!)}>{t('req.openPage')}</Button>
                    )}
                </Flex>
                {(state || (!req.addable && req.source !== 'dlc')) && (
                    <Typography.Text type="secondary" style={{fontSize: 12}}>
                        {state ?? (req.source === 'named' ? t('req.namedHint')
                            : req.source === 'pakhub' ? t('req.discordHint') : t('req.externalHint'))}
                    </Typography.Text>
                )}
                {req.notes && <Typography.Text type="secondary" style={{fontSize: 12}}>{req.notes}</Typography.Text>}
                {req.sentence && <Typography.Text type="secondary" italic style={{fontSize: 12}}>“{req.sentence}”</Typography.Text>}
            </Flex>
        </Flex>
    );
}

function PromptBody({plan, initial, onChange}: {
    plan: RequirementPlan;
    initial: Set<string>;
    onChange: (keys: Set<string>) => void;
}) {
    const [picked, setPicked] = useState(initial);
    const toggle = (key: string, on: boolean) => {
        const next = new Set(picked);
        if (on) next.add(key);
        else next.delete(key);
        setPicked(next);
        onChange(next);
    };
    const needed = plan.requirements.filter(r => r.likely);
    const mentioned = plan.requirements.filter(r => !r.likely);
    const conflicts = plan.notes.filter(n => /\b(not compatible|incompatible|conflicts?|disable)\b/i.test(n));
    const otherNotes = plan.notes.filter(n => !conflicts.includes(n));
    return (
        <Flex vertical gap={12} style={{marginTop: 8, maxHeight: '60vh', overflow: 'auto', paddingRight: 4}}>
            {needed.length > 0 && (
                <Flex vertical gap={8}>
                    <Typography.Text type="secondary">{plan.source === 'pakhub' ? t('req.authorNeeds') : t('req.pageNeeds')}</Typography.Text>
                    {needed.map(req => <RequirementRow key={req.key} req={req} checked={picked.has(req.key)}
                                                       onToggle={(on) => toggle(req.key, on)}/>)}
                </Flex>
            )}
            {mentioned.length > 0 && (
                <Flex vertical gap={8}>
                    <Typography.Text type="secondary">{t('req.authorMentions')}</Typography.Text>
                    {mentioned.map(req => <RequirementRow key={req.key} req={req} checked={picked.has(req.key)}
                                                          onToggle={(on) => toggle(req.key, on)}/>)}
                </Flex>
            )}
            {plan.orderHints.length > 0 && (
                <Flex vertical gap={4}>
                    <Typography.Text type="secondary"><OrderedListOutlined/> {t('req.loadOrder')}</Typography.Text>
                    {plan.orderHints.map(hint => (
                        <Typography.Text key={`${hint.direction}:${hint.target}`} style={{fontSize: 13}}>
                            {orderHintText(hint)}
                            {hint.match ? ` · ${t('req.inYourListShort')}` : ''}
                            <Typography.Text type="secondary" italic style={{fontSize: 12}}> “{hint.sentence}”</Typography.Text>
                        </Typography.Text>
                    ))}
                </Flex>
            )}
            {conflicts.length > 0 && (
                <Flex vertical gap={4}>
                    <Typography.Text type="warning"><WarningOutlined/> {t('req.conflicts')}</Typography.Text>
                    {conflicts.map((note, i) => <Typography.Text key={i} italic style={{fontSize: 12}}>“{note}”</Typography.Text>)}
                </Flex>
            )}
            {otherNotes.length > 0 && plan.source === 'pakhub' && (
                <Flex vertical gap={4}>
                    <Typography.Text type="secondary">{t('req.authorNotesTitle')}</Typography.Text>
                    {otherNotes.map((note, i) => <Typography.Text key={i} type="secondary" italic style={{fontSize: 12}}>“{note}”</Typography.Text>)}
                </Flex>
            )}
        </Flex>
    );
}

/**
 * Which requirements to add along with the mod: an empty list to add only the mod, or null when
 * cancelled.
 */
export async function askRequirements(modName: string, plan: RequirementPlan): Promise<ResolvedRequirement[] | null> {
    let picked = new Set(plan.requirements.filter(r => r.likely && canPick(r)).map(r => r.key));
    const anyPickable = plan.requirements.some(canPick);
    let setCount: (n: number) => void = () => {};
    function AddButton({onClick}: { onClick: () => void }) {
        const [count, set] = useState(picked.size);
        setCount = set;
        return <Button type="primary" onClick={onClick}>
            {count > 0 ? t('req.addWith', {count}) : t('req.addOnly')}
        </Button>;
    }
    return new Promise((resolve) => {
        let done = false;
        const finish = (value: ResolvedRequirement[] | null) => {
            if (done) return;
            done = true;
            instance.destroy();
            resolve(value);
        };
        const footer = (
            <Flex justify="flex-end" gap={8} wrap style={{marginTop: 16}}>
                <Button onClick={() => finish(null)}>{t('Cancel')}</Button>
                {anyPickable && <Button onClick={() => finish([])}>{t('req.addOnly')}</Button>}
                <AddButton onClick={() => finish(plan.requirements.filter(r => canPick(r) && picked.has(r.key)))}/>
            </Flex>
        );
        const instance = MessageBox.api().confirm({
            title: plan.source === 'pakhub' ? t('req.promptTitlePakhub', {name: modName}) : t('req.promptTitle', {name: modName}),
            icon: null,
            width: 560,
            content: <PromptBody plan={plan} initial={picked} onChange={(keys) => {
                picked = keys;
                setCount(keys.size);
            }}/>,
            footer,
            onCancel: () => finish(null),
        });
    });
}
