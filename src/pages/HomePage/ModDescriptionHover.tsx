/**
 * Wraps a mod row's name: when "Show mod descriptions on hover" is on, hovering the name shows
 * the mod's description (see ModDescriptions). With the setting off it renders the name as is.
 */
import React, {useSyncExternalStore} from "react";
import {Spin, theme, Tooltip, Typography} from "antd";
import {t} from "i18next";
import {DescribedMod, ModDescriptions} from "@/services/ModDescriptions";
import {RepositoryUpdates} from "@/services/RepositoryUpdates";

function DescriptionContent({mod}: { mod: DescribedMod }) {
    const {token} = theme.useToken();
    const version = useSyncExternalStore(ModDescriptions.subscribe, ModDescriptions.version);
    const entry = ModDescriptions.get(mod, version);

    React.useEffect(() => {
        ModDescriptions.request(mod);
        // eslint-disable-next-line react-hooks/exhaustive-deps
    }, [mod.modId, mod.platformId, mod.nameId, mod.url]);

    if (!entry || entry.state === "loading") {
        return <span><Spin size="small"/> <span style={{marginLeft: 6}}>{t("modDescription.loading")}</span></span>;
    }
    if (entry.state === "error") {
        return <span>{t("modDescription.failed", {reason: entry.error ?? ""})}</span>;
    }
    if (!entry.summary && !entry.details) {
        return <span style={{opacity: 0.8}}>{t("modDescription.none")}</span>;
    }
    return (
        <div style={{maxHeight: 320, overflow: "hidden"}}>
            {entry.summary &&
                <Typography.Paragraph style={{margin: 0, color: "inherit", whiteSpace: "pre-line"}}>
                    {entry.summary}
                </Typography.Paragraph>}
            {entry.details &&
                <Typography.Paragraph style={{
                    margin: entry.summary ? "8px 0 0" : 0,
                    color: "inherit",
                    opacity: 0.75,
                    fontSize: token.fontSizeSM,
                    whiteSpace: "pre-line",
                }}>
                    {entry.details}
                </Typography.Paragraph>}
        </div>
    );
}

export function ModDescriptionHover({mod, children}: { mod: DescribedMod; children: React.ReactNode }) {
    const enabled = useSyncExternalStore(ModDescriptions.subscribe, ModDescriptions.isEnabled);
    // A local mod gets a description once it is linked to a repository post
    const repoVersion = useSyncExternalStore(RepositoryUpdates.subscribe, RepositoryUpdates.version);
    const show = enabled && ModDescriptions.describable(mod, repoVersion);
    const ref = React.useRef<HTMLSpanElement>(null);
    const [open, setOpen] = React.useState(false);
    // Right-click (row menu) or a click hides the description until the mouse leaves the name,
    // so it never covers the menu
    const suppressed = React.useRef(false);
    const hide = () => {
        suppressed.current = true;
        setOpen(false);
    };

    // The tree puts the mod's name in a title attribute on the row, which the system shows as a
    // second tooltip on top of the description. React only rewrites it when the name changes.
    React.useLayoutEffect(() => {
        if (show) ref.current?.closest(".ant-tree-node-content-wrapper")?.removeAttribute("title");
    });

    if (!show) {
        return <>{children}</>;
    }
    return (
        <Tooltip title={<DescriptionContent mod={mod}/>}
                 open={open}
                 onOpenChange={(next) => setOpen(next && !suppressed.current)}
                 placement="bottomLeft"
                 mouseEnterDelay={0.5}
                 destroyOnHidden
                 styles={{root: {maxWidth: 480}}}>
            {/* the tooltip needs one element that takes mouse events */}
            <span ref={ref}
                  style={{display: "inline-flex", minWidth: 0}}
                  onContextMenu={hide}
                  onMouseDown={hide}
                  onMouseLeave={() => {
                      suppressed.current = false;
                  }}>{children}</span>
        </Tooltip>
    );
}
