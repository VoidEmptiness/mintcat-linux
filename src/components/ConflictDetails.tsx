import React, {useEffect, useMemo, useState, useSyncExternalStore} from "react";
import {t} from "i18next";
import {
    Alert, Button, Checkbox, Collapse, Empty, Flex, Input, message, Segmented, Spin, Table, Tag, Tooltip,
    Typography,
} from "antd";
import {
    ConflictAsset, ConflictPair, ConflictRating, ConflictService, ModConflictSummary,
} from "@/services/ConflictService";
import {
    assetGroup, GroupCount, modEffect, ModEffect, OUTCOME_COLOR, pairRelation, pairVerdict, PairVerdict,
    SuggestedAction, suggestedActions, SUMMARY_COLOR, SUMMARY_ORDER,
} from "@/services/ConflictInsights";
import {ConflictActions} from "@/services/ConflictActions";
import {IoC} from "@/core/IoC.ts";
import {ProfileViewModel} from "@/dialogs/ProfileEditDialog/ProfileViewModel";
import {flattenTreeModIds} from "@/utils/ModDisplayOrder";
import {useInstallOrder} from "@/services/ListDisplay";
import {BackendRuntimeApi} from "@/apis/BackendRuntimeApi";
import {MessageBox} from "@/components/MessageBox";

/** Install order (top wins); the shared store, or read from the profile until the list has set it */
function useOrder(): number[] | null {
    const shared = useInstallOrder();
    const [loaded, setLoaded] = useState<number[] | null>(null);
    useEffect(() => {
        if (shared.length > 0) return;
        let cancelled = false;
        IoC.get(ProfileViewModel)
            .then(vm => vm.getActiveProfileTreeRoot())
            .then(root => flattenTreeModIds(root))
            .catch(() => [] as number[])
            .then(order => {
                if (!cancelled) setLoaded(order);
            });
        return () => {
            cancelled = true;
        };
    }, [shared.length]);
    return shared.length > 0 ? shared : loaded;
}

function useConflictVersion(): number {
    return useSyncExternalStore(ConflictService.subscribe, ConflictService.version);
}

const RATING_COLOR: Record<ConflictRating, string> = {
    harmless: 'green',
    cosmetic: 'gold',
    gameplay: 'volcano',
};

const name = (id: number) => ConflictService.getModName(id);

function positionLabel(order: number[], modId: number): string {
    const index = order.indexOf(modId);
    return index >= 0 ? `#${index + 1}` : "";
}

/** "A", "A and B", "A, B and 3 more" */
function namesList(ids: number[], max = 2): string {
    const names = ids.slice(0, max).map(name);
    const more = ids.length - names.length;
    if (more > 0) return t("conflict.namesMore", {names: names.join(", "), count: more});
    if (names.length === 2) return t("conflict.namesTwo", {a: names[0], b: names[1]});
    return names.join(", ");
}

function groupsText(groups: GroupCount[], max = 3): string {
    return groups.slice(0, max).map(g => `${t(`conflict.group.${g.group}`)} (${g.count})`).join(", ");
}

function Dot({color, size = 8}: { color: string; size?: number }) {
    return <span style={{
        display: "inline-block", width: size, height: size, borderRadius: size / 2, background: color,
        flex: "none",
    }}/>;
}

function RatingTag({rating}: { rating: ConflictRating }) {
    return (
        <Tooltip title={t(`conflict.rating.${rating}Hint`)}>
            <Tag color={RATING_COLOR[rating]} style={{marginInlineEnd: 0}}>{t(`conflict.rating.${rating}`)}</Tag>
        </Tooltip>
    );
}

export function StatusTag({summary}: { summary: ModConflictSummary }) {
    return (
        <Tooltip title={t(`conflict.legend.${summary}`)}>
            <Tag style={{marginInlineEnd: 0, borderColor: SUMMARY_COLOR[summary]}}>
                <Flex gap={6} align="center" style={{display: "inline-flex"}}>
                    <Dot color={SUMMARY_COLOR[summary]}/>
                    {t(`conflict.status.${summary}`)}
                </Flex>
            </Tag>
        </Tooltip>
    );
}

/** What the colors mean, and how the winner of a shared file is decided */
export function ConflictLegend() {
    return (
        <Flex vertical gap={6}>
            {SUMMARY_ORDER.map(summary => (
                <Flex key={summary} gap={8} align="baseline">
                    <span style={{position: "relative", top: 1}}><Dot color={SUMMARY_COLOR[summary]} size={10}/></span>
                    <Typography.Text style={{fontSize: 12}}>
                        <b>{t(`conflict.status.${summary}`)}</b> — {t(`conflict.legend.${summary}`)}
                    </Typography.Text>
                </Flex>
            ))}
            <Typography.Text type="secondary" style={{fontSize: 12}}>{t("conflict.legend.how")}</Typography.Text>
            <Typography.Text type="secondary" style={{fontSize: 12}}>{t("conflict.legend.ratings")}</Typography.Text>
        </Flex>
    );
}

function LegendToggle() {
    return (
        <Collapse size="small" ghost items={[{
            key: "legend",
            label: <Typography.Text type="secondary" style={{fontSize: 12}}>{t("conflict.legend.title")}</Typography.Text>,
            children: <ConflictLegend/>,
        }]}/>
    );
}

function OrderHint() {
    return (
        <Typography.Text type="secondary" style={{fontSize: 12}}>
            {t("conflict.orderHint")}
        </Typography.Text>
    );
}

function actionLabel(action: SuggestedAction): string {
    switch (action.kind) {
        case 'swap':
            return t("conflict.action.swap", {mod: name(action.modId), other: name(action.aboveId)});
        case 'disable':
            return t("conflict.action.disable", {mod: name(action.modId)});
        case 'reveal':
            return t("conflict.action.reveal");
    }
}

function ActionButtons({actions}: { actions: SuggestedAction[] }) {
    const [busy, setBusy] = useState<string | null>(null);
    if (actions.length === 0 || !ConflictActions.available()) return null;
    const run = async (action: SuggestedAction, key: string) => {
        setBusy(key);
        try {
            const ok = await ConflictActions.run(action);
            if (ok && action.kind !== 'reveal') {
                message.success(t(`conflict.action.done.${action.kind}`, {
                    mod: name(action.modId),
                    other: action.kind === 'swap' ? name(action.aboveId) : "",
                }));
            }
        } catch (e) {
            message.error(t("conflict.action.failed", {error: String(e)}));
        } finally {
            setBusy(null);
        }
    };
    return (
        <Flex gap={6} wrap>
            {actions.map((action, i) => {
                const key = `${action.kind}:${action.modId}:${i}`;
                return (
                    <Button key={key} size="small" loading={busy === key} disabled={busy !== null && busy !== key}
                            danger={action.kind === 'disable'}
                            onClick={(e) => {
                                e.stopPropagation();
                                void run(action, key);
                            }}>
                        {actionLabel(action)}
                    </Button>
                );
            })}
        </Flex>
    );
}

function OutcomeTag({asset}: { asset: ConflictAsset }) {
    return (
        <Tooltip title={t(`conflict.outcome.${asset.outcome}Hint`)}>
            <Tag color={OUTCOME_COLOR[asset.outcome]} style={{marginInlineEnd: 0, fontSize: 11, lineHeight: "16px"}}>
                {t(`conflict.outcome.${asset.outcome}`)}
            </Tag>
        </Tooltip>
    );
}

function canCompare(asset: ConflictAsset): boolean {
    return asset.outcome !== 'identical'
        && (asset.extensions.includes('.uasset') || asset.extensions.includes('.umap'))
        && ConflictService.getDiffContext() !== null;
}

function AssetList({pair}: { pair: ConflictPair }) {
    return (
        <div style={{maxHeight: 260, overflowY: "auto", fontSize: 12, lineHeight: 1.6}}>
            {pair.assets.map(asset => {
                const lost = asset.loserOnly ?? 0;
                const clashes = asset.clashes ?? 0;
                return (
                    <Flex key={asset.path} gap={6} align="center" wrap style={{padding: "1px 0"}}>
                        <Dot color={asset.rating === 'gameplay' ? '#fa541c' : asset.rating === 'cosmetic' ? '#fadb14' : '#52c41a'}/>
                        <Tooltip title={`${t(`conflict.group.${assetGroup(asset.path, asset.newFile)}`)} · ${t(`conflict.rating.${asset.rating}`)}`}>
                            <span style={{fontFamily: "monospace", wordBreak: "break-all"}}>{asset.path}</span>
                        </Tooltip>
                        {asset.extensions.length > 0 &&
                            <Typography.Text type="secondary" style={{fontSize: 11}}>{asset.extensions.join(" ")}</Typography.Text>}
                        <OutcomeTag asset={asset}/>
                        {(lost > 0 || clashes > 0) &&
                            <Typography.Text type="secondary" style={{fontSize: 11}}>
                                {[
                                    lost > 0 ? t("conflict.asset.lostParts", {count: lost}) : null,
                                    clashes > 0 ? t("conflict.asset.clashParts", {count: clashes}) : null,
                                    lost > 0 && asset.loserValuesOnly ? t("conflict.asset.valuesOnly") : null,
                                ].filter(Boolean).join(" · ")}
                            </Typography.Text>}
                        {canCompare(asset) &&
                            <Button size="small" type="link" style={{padding: 0, height: "auto", fontSize: 12}}
                                    onClick={(e) => {
                                        e.stopPropagation();
                                        openAssetDiff(asset, pair.winnerId, pair.loserId);
                                    }}>
                                {t("conflict.action.compare")}
                            </Button>}
                    </Flex>
                );
            })}
        </div>
    );
}

const VERDICT_COLOR: Record<PairVerdict, string> = {
    nothingLost: 'green',
    audio: 'orange',
    copies: 'purple',
    replacedWhole: 'red',
    addon: 'blue',
    combinable: 'gold',
    clash: 'red',
    cosmetic: 'gold',
    unclear: 'volcano',
};

function VerdictTag({verdict}: { verdict: PairVerdict }) {
    return <Tag color={VERDICT_COLOR[verdict]} style={{marginInlineEnd: 0}}>{t(`conflict.verdictTag.${verdict}`)}</Tag>;
}

/** Explanation, what to do, and the shared files of one pair */
function PairBody({pair}: { pair: ConflictPair }) {
    const relation = pairRelation(pair);
    const verdict = pairVerdict(pair, relation);
    const names = {winner: name(pair.winnerId), loser: name(pair.loserId)};
    const counts = {identical: 0, sameChanges: 0, separate: 0, clash: 0, unknown: 0};
    pair.assets.forEach(a => counts[a.outcome]++);
    return (
        <Flex vertical gap={8}>
            <Typography.Text style={{fontSize: 13}}>{t(`conflict.verdict.${verdict}`, names)}</Typography.Text>
            <Flex gap={6} wrap align="center">
                <Tooltip title={t(`conflict.relation.${relation}Hint`, names)}>
                    <Tag style={{marginInlineEnd: 0}}>{t(`conflict.relation.${relation}`)}</Tag>
                </Tooltip>
                {(Object.keys(counts) as (keyof typeof counts)[]).filter(k => counts[k] > 0).map(k => (
                    <Tooltip key={k} title={t(`conflict.outcome.${k}Hint`)}>
                        <Tag color={OUTCOME_COLOR[k]} style={{marginInlineEnd: 0}}>
                            {t(`conflict.outcome.${k}`)}: {counts[k]}
                        </Tag>
                    </Tooltip>
                ))}
            </Flex>
            <ActionButtons actions={suggestedActions(pair, verdict)}/>
            <AssetList pair={pair}/>
        </Flex>
    );
}

function effectSentence(effect: ModEffect): string {
    const winners = namesList(effect.replacedBy);
    const losers = namesList(effect.replaces);
    switch (effect.summary) {
        case 'noEffect':
            return t("conflict.short.noEffect", {total: effect.totalFiles, winners});
        case 'redundant':
            return t("conflict.short.redundant", {winners});
        case 'losesGameplay':
            return t("conflict.short.losesGameplay", {count: effect.lost.length, winners, groups: groupsText(effect.lostGroups)});
        case 'losesCosmetic':
            return t("conflict.short.losesCosmetic", {winners, groups: groupsText(effect.lostGroups)});
        case 'winsAll':
            return effect.replaces.length > 0 ? t("conflict.short.winsAll", {losers}) : t("conflict.short.harmless");
        case 'harmless':
            return t("conflict.short.harmless");
    }
}

/** What a mod keeps and loses: files, areas of the game, and who replaces them */
function EffectSummary({effect}: { effect: ModEffect }) {
    return (
        <Flex vertical gap={4} style={{fontSize: 12}}>
            <Typography.Text type="secondary" style={{fontSize: 12}}>
                {t("conflict.effect.files", {
                    total: effect.totalFiles, own: effect.ownFiles, won: effect.wonFiles, replaced: effect.replacedFiles,
                })}
            </Typography.Text>
            {effect.lostGroups.length > 0 &&
                <div>
                    <Typography.Text strong style={{fontSize: 12}}>{t("conflict.effect.lostHeader")}</Typography.Text>
                    {effect.lostGroups.map(g => (
                        <div key={g.group} style={{paddingLeft: 12}}>
                            {t(`conflict.group.${g.group}`)} ({g.count}): <Typography.Text type="secondary" style={{fontSize: 12}}>
                            {g.names.join(", ")}{g.count > g.names.length ? ", …" : ""}</Typography.Text>
                        </div>
                    ))}
                </div>}
            {effect.covered.length > 0 &&
                <Typography.Text type="secondary" style={{fontSize: 12}}>
                    {t("conflict.effect.covered", {count: effect.covered.length})}
                </Typography.Text>}
            {effect.kept.length > 0 &&
                <div>
                    <Typography.Text strong style={{fontSize: 12}}>{t("conflict.effect.keptHeader")}</Typography.Text>{" "}
                    <Typography.Text style={{fontSize: 12}}>{groupsText(effect.kept, 5)}</Typography.Text>
                </div>}
        </Flex>
    );
}

/**
 * Conflicts of a single mod, from that mod's point of view.
 * `embedded`: shown inside the report (no own header, no width limit)
 */
export function ModConflictDetails({modId, embedded = false}: { modId: number; embedded?: boolean }) {
    const order = useOrder();
    const version = useConflictVersion();
    const data = useMemo(() => {
        if (!order) return null;
        return {pairs: ConflictService.getPairs(order, modId), effect: modEffect(modId, order)};
        // version: conflict data changed
        // eslint-disable-next-line react-hooks/exhaustive-deps
    }, [order, modId, version]);

    if (!order || !data) {
        return <Spin size="small"/>;
    }
    const {pairs, effect} = data;
    if (pairs.length === 0 || !effect) {
        return <Empty image={Empty.PRESENTED_IMAGE_SIMPLE} description={t("No conflicts detected")}/>;
    }

    const items = pairs.map(pair => {
        const otherId = pair.winnerId === modId ? pair.loserId : pair.winnerId;
        const thisWins = pair.winnerId === modId;
        const verdict = pairVerdict(pair);
        return {
            key: `${pair.winnerId}:${pair.loserId}`,
            label: (
                <Flex gap={6} wrap align="center">
                    <Typography.Text strong>{name(otherId)}</Typography.Text>
                    <Typography.Text type="secondary" style={{fontSize: 12}}>{positionLabel(order, otherId)}</Typography.Text>
                    {pair.orderUncertain
                        ? <Tag color="orange" style={{marginInlineEnd: 0}}>{t("conflict.audioUncertain")}</Tag>
                        : thisWins
                            ? <Tag color="blue" style={{marginInlineEnd: 0}}>{t("conflict.thisWins")}</Tag>
                            : <Tag color="red" style={{marginInlineEnd: 0}}>{t("conflict.thisLoses")}</Tag>}
                    <VerdictTag verdict={verdict}/>
                    <RatingTag rating={pair.rating}/>
                    <Typography.Text type="secondary" style={{fontSize: 12}}>
                        {t("conflict.assetCount", {count: pair.assets.length})}
                    </Typography.Text>
                </Flex>
            ),
            children: <PairBody pair={pair}/>,
        };
    });

    return (
        <Flex vertical gap={8} style={embedded ? undefined : {width: 560, maxWidth: "90vw"}}>
            {!embedded &&
                <Flex gap={6} align="center" wrap>
                    <Typography.Text strong>{name(modId)}</Typography.Text>
                    <Typography.Text type="secondary">{positionLabel(order, modId)}</Typography.Text>
                    <StatusTag summary={effect.summary}/>
                </Flex>}
            <Alert type={effect.summary === 'noEffect' ? 'error' : effect.summary === 'losesGameplay' ? 'warning'
                : effect.summary === 'losesCosmetic' ? 'warning' : 'info'}
                   showIcon
                   title={effectSentence(effect)}
                   description={<EffectSummary effect={effect}/>}/>
            <Typography.Text type="secondary" style={{fontSize: 12}}>{t("conflict.effect.sharesWith")}</Typography.Text>
            <div style={embedded ? undefined : {maxHeight: "45vh", overflowY: "auto"}}>
                <Collapse size="small" items={items}/>
            </div>
            {embedded && ConflictActions.available() &&
                <div><ActionButtons actions={[{kind: 'reveal', modId}]}/></div>}
            {!embedded && <LegendToggle/>}
            {!embedded && <OrderHint/>}
        </Flex>
    );
}

type ReportView = 'mods' | 'pairs';

/**
 * Every conflict in the profile: by mod (what each one keeps and loses) or by pair.
 */
export function ConflictReport() {
    const order = useOrder();
    const version = useConflictVersion();
    const [view, setView] = useState<ReportView>('mods');
    const [search, setSearch] = useState("");
    const [hideHarmless, setHideHarmless] = useState(false);

    const data = useMemo(() => {
        if (!order) return null;
        const pairs = ConflictService.getPairs(order);
        const modIds = Array.from(new Set(pairs.flatMap(p => [p.winnerId, p.loserId])));
        const effects = new Map(modIds.map(id => [id, modEffect(id, order)]));
        return {pairs, modIds, effects};
        // eslint-disable-next-line react-hooks/exhaustive-deps
    }, [order, version]);

    if (!order || !data) {
        return <Spin/>;
    }
    const {pairs, modIds, effects} = data;
    if (pairs.length === 0) {
        return <Empty image={Empty.PRESENTED_IMAGE_SIMPLE} description={t("No conflicts detected")}/>;
    }

    const needle = search.trim().toLowerCase();
    const matches = (id: number) => !needle || name(id).toLowerCase().includes(needle);
    const summaryOf = (id: number) => effects.get(id)?.summary ?? 'harmless';
    const countOf = (s: ModConflictSummary) => modIds.filter(id => summaryOf(id) === s).length;

    const sortedMods = [...modIds]
        .filter(id => matches(id))
        .filter(id => !hideHarmless || (summaryOf(id) !== 'harmless' && summaryOf(id) !== 'redundant'))
        .sort((a, b) => SUMMARY_ORDER.indexOf(summaryOf(a)) - SUMMARY_ORDER.indexOf(summaryOf(b))
            || order.indexOf(a) - order.indexOf(b));

    const modItems = sortedMods.map(id => {
        const effect = effects.get(id);
        return {
            key: String(id),
            label: (
                <Flex vertical gap={2}>
                    <Flex gap={6} align="center" wrap>
                        <Dot color={SUMMARY_COLOR[summaryOf(id)]} size={10}/>
                        <Typography.Text strong>{name(id)}</Typography.Text>
                        <Typography.Text type="secondary" style={{fontSize: 12}}>{positionLabel(order, id)}</Typography.Text>
                        <StatusTag summary={summaryOf(id)}/>
                    </Flex>
                    {effect &&
                        <Typography.Text type="secondary" style={{fontSize: 12, paddingLeft: 16}}>
                            {effectSentence(effect)}
                        </Typography.Text>}
                </Flex>
            ),
            children: <ModConflictDetails modId={id} embedded/>,
        };
    });

    const shownPairs = pairs
        .filter(p => matches(p.winnerId) || matches(p.loserId))
        .filter(p => !hideHarmless || p.rating !== 'harmless');
    const pairItems = shownPairs.map(pair => ({
        key: `${pair.winnerId}:${pair.loserId}`,
        label: (
            <Flex gap={6} wrap align="center">
                <Typography.Text type="secondary" style={{fontSize: 12}}>{positionLabel(order, pair.winnerId)}</Typography.Text>
                <Typography.Text strong>{name(pair.winnerId)}</Typography.Text>
                <Typography.Text type="secondary">{pair.orderUncertain ? "⇄" : t("conflict.overrides")}</Typography.Text>
                <Typography.Text type="secondary" style={{fontSize: 12}}>{positionLabel(order, pair.loserId)}</Typography.Text>
                <Typography.Text strong>{name(pair.loserId)}</Typography.Text>
                <VerdictTag verdict={pairVerdict(pair)}/>
                <RatingTag rating={pair.rating}/>
                <Typography.Text type="secondary" style={{fontSize: 12}}>
                    {t("conflict.assetCount", {count: pair.assets.length})}
                </Typography.Text>
            </Flex>
        ),
        children: <PairBody pair={pair}/>,
    }));

    const compared = ConflictService.gameWasRead();
    return (
        <Flex vertical gap={8}>
            <Typography.Text>
                {t("conflict.report.modsSummary", {
                    mods: modIds.length, pairs: pairs.length,
                    noEffect: countOf('noEffect'), gameplay: countOf('losesGameplay'),
                    cosmetic: countOf('losesCosmetic'), redundant: countOf('redundant'),
                })}
            </Typography.Text>
            <Flex gap={6} wrap>
                {SUMMARY_ORDER.map(s => countOf(s) > 0 && (
                    <Tooltip key={s} title={t(`conflict.legend.${s}`)}>
                        <Tag style={{marginInlineEnd: 0}}>
                            <Flex gap={6} align="center" style={{display: "inline-flex"}}>
                                <Dot color={SUMMARY_COLOR[s]}/>{t(`conflict.status.${s}`)}: {countOf(s)}
                            </Flex>
                        </Tag>
                    </Tooltip>
                ))}
            </Flex>
            {!compared &&
                <Alert type="info" showIcon title={t("conflict.report.notCompared")}/>}
            <LegendToggle/>
            <Flex gap={8} wrap align="center">
                <Segmented<ReportView> size="small" value={view} onChange={setView} options={[
                    {value: 'mods', label: t("conflict.report.byMod")},
                    {value: 'pairs', label: t("conflict.report.byPair")},
                ]}/>
                <Input size="small" allowClear placeholder={t("conflict.report.search")} value={search}
                       onChange={e => setSearch(e.target.value)} style={{width: 200}}/>
                <Checkbox checked={hideHarmless} onChange={e => setHideHarmless(e.target.checked)}>
                    {t("conflict.report.hideHarmless")}
                </Checkbox>
            </Flex>
            <div style={{maxHeight: "55vh", overflowY: "auto"}}>
                {(view === 'mods' ? modItems : pairItems).length === 0
                    ? <Empty image={Empty.PRESENTED_IMAGE_SIMPLE} description={t("conflict.report.empty")}/>
                    : <Collapse size="small" items={view === 'mods' ? modItems : pairItems}/>}
            </div>
            <OrderHint/>
        </Flex>
    );
}

let reportHandle: { destroy: () => void } | null = null;

/** Open the report (one at a time); it closes itself when the user jumps to a mod in the list */
export function openConflictReport() {
    reportHandle?.destroy();
    let stop: () => void = () => undefined;
    const handle = MessageBox.info({
        title: t("conflict.reportTitle"),
        icon: null,
        width: 760,
        maskClosable: true,
        content: <ConflictReport/>,
        afterClose: () => {
            stop();
            if (reportHandle === handle) reportHandle = null;
        },
    });
    reportHandle = handle;
    stop = ConflictActions.onReveal(() => handle.destroy());
}

// ----- Part-by-part comparison of one asset -----

interface PartValue {
    hash: string;
    value?: string;
}

interface DiffRow {
    key: string;
    kind: string;
    owner: string;
    name: string;
    game?: PartValue | null;
    mods: Record<string, PartValue | null>;
}

interface VersionInfo {
    found: boolean;
    error?: string;
    parts: number;
    shallow?: boolean;
}

interface AssetDiff {
    assetPath: string;
    game: VersionInfo;
    mods: Record<string, VersionInfo>;
    rows: DiffRow[];
}

type RowResult = 'clash' | 'lost' | 'kept' | 'same';
const RESULT_RANK: Record<RowResult, number> = {clash: 0, lost: 1, kept: 2, same: 3};
const RESULT_COLOR: Record<RowResult, string> = {clash: 'red', lost: 'orange', kept: 'blue', same: 'green'};

function rowResult(row: DiffRow, winnerId: number, loserId: number, gameKnown: boolean): RowResult {
    const h = (v: PartValue | null | undefined) => v?.hash ?? null;
    const w = h(row.mods[String(winnerId)]);
    const l = h(row.mods[String(loserId)]);
    if (gameKnown) {
        const g = h(row.game);
        const lChanged = l !== g;
        const wChanged = w !== g;
        if (lChanged && wChanged) return l === w ? 'same' : 'clash';
        if (lChanged) return 'lost';
        if (wChanged) return 'kept';
        return 'same';
    }
    if (l === w) return 'same';
    if (l !== null && w === null) return 'lost';
    if (l === null && w !== null) return 'kept';
    return 'clash';
}

function ownerLabel(row: DiffRow): string {
    if (row.kind === 'function') return t("conflict.diff.kind.function");
    if (row.kind === 'event') return t("conflict.diff.eventGraph");
    if (row.owner.startsWith('Default__')) return t("conflict.diff.defaults");
    return row.owner;
}

function cellText(value: PartValue | null | undefined, game: PartValue | null | undefined, gameKnown: boolean): string {
    if (!value) return t("conflict.diff.absent");
    if (value.value !== undefined && value.value !== null) return value.value;
    if (gameKnown && game && game.hash === value.hash) return t("conflict.diff.asGame");
    return t("conflict.diff.changed");
}

export function AssetDiffView({asset, winnerId, loserId}: { asset: ConflictAsset; winnerId: number; loserId: number }) {
    const [state, setState] = useState<{ diff: AssetDiff | null; error: string | null }>({diff: null, error: null});
    const [showAll, setShowAll] = useState(false);
    useEffect(() => {
        let cancelled = false;
        const context = ConflictService.getDiffContext();
        if (!context) {
            setState({diff: null, error: t("conflict.diff.noContext")});
            return;
        }
        const mods = context.mods.filter(m => m.mod_id === winnerId || m.mod_id === loserId)
            .map(m => ({modId: m.mod_id, cachePath: m.cache_path, isUnpacked: m.is_unpacked}));
        BackendRuntimeApi.invoke<AssetDiff>('conflict_asset_diff', {
            gameName: context.gameName ?? null,
            gamePakPath: context.gamePakPath ?? null,
            assetPath: asset.base,
            mods,
        }).then(diff => {
            if (!cancelled) setState({diff, error: null});
        }).catch(e => {
            if (!cancelled) setState({diff: null, error: String(e)});
        });
        return () => {
            cancelled = true;
        };
    }, [asset.base, winnerId, loserId]);

    if (state.error) return <Alert type="error" showIcon title={state.error}/>;
    if (!state.diff) return <Flex gap={8} align="center"><Spin size="small"/>{t("conflict.diff.loading")}</Flex>;

    const diff = state.diff;
    const gameKnown = diff.game.found && !diff.game.error;
    const names = {winner: name(winnerId), loser: name(loserId)};
    const results = diff.rows.map(row => ({row, result: rowResult(row, winnerId, loserId, gameKnown)}))
        .filter(r => r.result !== 'same' || !gameKnown)
        .sort((a, b) => RESULT_RANK[a.result] - RESULT_RANK[b.result]
            || ownerLabel(a.row).localeCompare(ownerLabel(b.row)) || a.row.name.localeCompare(b.row.name));
    const count = (r: RowResult) => results.filter(x => x.result === r).length;
    const changesOf = (id: number) => diff.rows.filter(row => {
        const v = row.mods[String(id)]?.hash ?? null;
        return gameKnown ? v !== (row.game?.hash ?? null) : true;
    }).length;
    const errors = [winnerId, loserId]
        .map(id => ({id, info: diff.mods[String(id)]}))
        .filter(x => x.info?.error);
    const shallow = Object.values(diff.mods).some(m => m.shallow) || diff.game.shallow;
    const LIMIT = 150;
    const shown = showAll ? results : results.slice(0, LIMIT);

    return (
        <Flex vertical gap={8}>
            {!diff.game.found && <Alert type="info" showIcon title={t("conflict.diff.notInGame")}/>}
            {diff.game.found && diff.game.error && <Alert type="warning" showIcon title={t("conflict.diff.noGame")}/>}
            {shallow && <Alert type="info" showIcon title={t("conflict.diff.shallow")}/>}
            {errors.map(({id, info}) => (
                <Alert key={id} type="warning" showIcon title={t("conflict.diff.error", {mod: name(id), error: info!.error})}/>
            ))}
            {gameKnown &&
                <Typography.Text>
                    {t("conflict.diff.summary", {...names, winnerCount: changesOf(winnerId), loserCount: changesOf(loserId)})}
                </Typography.Text>}
            <Typography.Text strong>
                {count('lost') + count('clash') === 0
                    ? t("conflict.diff.noneLost", names)
                    : count('clash') > 0
                        ? t("conflict.diff.lostSummaryClash", {...names, count: count('lost') + count('clash'), clash: count('clash')})
                        : t("conflict.diff.lostSummary", {...names, count: count('lost')})}
            </Typography.Text>
            {count('lost') > 0 && count('clash') === 0 &&
                <Typography.Text type="secondary" style={{fontSize: 12}}>{t("conflict.diff.separateHint", names)}</Typography.Text>}
            <Table<{ row: DiffRow; result: RowResult }>
                size="small"
                pagination={false}
                scroll={{y: "45vh"}}
                rowKey={r => r.row.key}
                dataSource={shown}
                columns={[
                    {
                        title: t("conflict.diff.col.part"),
                        key: "part",
                        width: "32%",
                        render: (_, {row}) => (
                            <Flex vertical>
                                <span style={{wordBreak: "break-all"}}>
                                    <Typography.Text type="secondary" style={{fontSize: 11}}>
                                        {t(`conflict.diff.kind.${row.kind}`, {defaultValue: row.kind})}:{" "}
                                    </Typography.Text>
                                    {row.name}
                                </span>
                                <Typography.Text type="secondary" style={{fontSize: 11, wordBreak: "break-all"}}>
                                    {ownerLabel(row)}
                                </Typography.Text>
                            </Flex>
                        ),
                    },
                    ...(gameKnown ? [{
                        title: t("conflict.diff.col.game"),
                        key: "game",
                        render: (_: unknown, {row}: { row: DiffRow; result: RowResult }) =>
                            <span style={{fontSize: 12, wordBreak: "break-all"}}>{cellText(row.game, row.game, false)}</span>,
                    }] : []),
                    {
                        title: <span>{names.winner} <Tag color="blue" style={{marginInlineEnd: 0}}>{t("conflict.diff.used")}</Tag></span>,
                        key: "winner",
                        render: (_: unknown, {row}: { row: DiffRow; result: RowResult }) =>
                            <span style={{fontSize: 12, wordBreak: "break-all"}}>{cellText(row.mods[String(winnerId)], row.game, gameKnown)}</span>,
                    },
                    {
                        title: names.loser,
                        key: "loser",
                        render: (_: unknown, {row}: { row: DiffRow; result: RowResult }) =>
                            <span style={{fontSize: 12, wordBreak: "break-all"}}>{cellText(row.mods[String(loserId)], row.game, gameKnown)}</span>,
                    },
                    {
                        title: t("conflict.diff.col.result"),
                        key: "result",
                        width: 130,
                        render: (_: unknown, {result}: { row: DiffRow; result: RowResult }) => (
                            <Tooltip title={t(`conflict.diff.resultHint.${result}`, names)}>
                                <Tag color={RESULT_COLOR[result]} style={{marginInlineEnd: 0}}>
                                    {t(`conflict.diff.result.${result}`, names)}
                                </Tag>
                            </Tooltip>
                        ),
                    },
                ]}
            />
            {results.length > LIMIT && !showAll &&
                <Button size="small" onClick={() => setShowAll(true)}>{t("conflict.diff.more", {count: results.length})}</Button>}
        </Flex>
    );
}

/** Open the part-by-part comparison of one shared asset */
export function openAssetDiff(asset: ConflictAsset, winnerId: number, loserId: number) {
    MessageBox.info({
        title: t("conflict.diff.title", {asset: asset.path.split('/').pop() ?? asset.path}),
        icon: null,
        width: 960,
        maskClosable: true,
        content: (
            <Flex vertical gap={4}>
                <Typography.Text type="secondary" style={{fontSize: 12, fontFamily: "monospace", wordBreak: "break-all"}}>
                    {asset.path}
                </Typography.Text>
                <AssetDiffView asset={asset} winnerId={winnerId} loserId={loserId}/>
            </Flex>
        ),
    });
}
