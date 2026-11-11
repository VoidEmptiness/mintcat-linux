import React from "react";
import {BasePage} from "../IBasePage.ts";
import {MintCatSettings} from "@/pages/SettingPage/MintCatSettings.tsx";
import {NetworkSettings} from "@/pages/SettingPage/NetworkSettings.tsx";
import {CloudBackupSettings} from "@/pages/SettingPage/CloudBackupSettings.tsx";
import {BackupSettings} from "@/pages/SettingPage/BackupSettings.tsx";
import {GameConfigCard} from "@/pages/SettingPage/GameConfigSettings.tsx";
import {AdvancedSettingsCard, useAdvancedShown, useMintcatSupporter} from "@/pages/SettingPage/AdvancedSettingsCard.tsx";

/** Network settings only show with "Show advanced settings" */
function AdvancedOnly({children}: { children: React.ReactNode }) {
    return useAdvancedShown() ? <>{children}</> : null;
}

/** The MINTCAT supporters' cloud backup: shown with advanced settings, or always for supporters */
function MintcatCloudBackup() {
    const advanced = useAdvancedShown();
    const supporter = useMintcatSupporter();
    return advanced || supporter ? <CloudBackupSettings/> : null;
}


export class SettingPage extends BasePage<any, any> {

    public constructor(props: any) {
        super(props);
    }

    componentDidMount(): void {
        this.hookWindowResized();
        this.hookLogPanel();
    }

    componentWillUnmount(): void {
        this.unhookLogPanel();
        this.unhookWindowResized();
    }

    render() {
        return (
            <div
                id="scrollableDiv"
                className="scrollable-div"
                style={{ height: window.innerHeight - 81 - this.logPanelOffset }}>
                <MintCatSettings/>
                <BackupSettings/>
                <GameConfigCard/>
                <MintcatCloudBackup/>
                <AdvancedOnly>
                    <NetworkSettings/>
                </AdvancedOnly>
                <AdvancedSettingsCard/>
            </div>
        );
    }
}
