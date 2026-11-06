import {t} from "i18next";
import {openMintImport} from "@/dialogs/MintImportDialog";
import {ModDescriptions} from "@/services/ModDescriptions";
import {COLOR_PRESETS, ModListAppearance} from "@/services/ModListAppearance";
import {TitleBarLook} from "@/services/TitleBarLook";
import {USAGE_STATS_DEFAULT, UsageStats} from "@/services/UsageStats";
import {useAdvancedShown} from "@/pages/SettingPage/AdvancedSettingsCard";
import {CloudDownloadOutlined, DisconnectOutlined, LinkOutlined, ThunderboltOutlined, UserOutlined} from "@ant-design/icons";
import React from "react";
import {openPath} from "@tauri-apps/plugin-opener";
import {open} from "@tauri-apps/plugin-dialog";
import i18n from "@/locales/i18n.ts";
import {IntegrateApi} from "@/apis/IntegrateApi.ts";
import {CacheApi} from "@/apis/CacheApi.ts";
import {DEFAULT_RELEASE_CHANNEL, RELEASE_CHANNELS, type ReleaseChannel} from "@/apis/mintcat";
import {StorageAPI} from "@/storage";
import {Button, Card, ColorPicker, Flex, Form, Input, InputNumber, message, Modal, Select, Switch, Typography} from "antd";
import {AppLogs, DEFAULT_KEEP, MAX_KEEP} from "@/services/AppLogs";
import {appLogDir} from "@tauri-apps/api/path";
import {ExclamationCircleFilled} from "@ant-design/icons";
import {FolderAddOutlined} from "@ant-design/icons";
import {ClipboardApi} from "@/apis/ClipboardApi.ts";
import Search from "antd/es/input/Search";
import {ButtonLayout, SettingLayout} from "@/pages/SettingPage/Layout.ts";
import {emitEvent, emitVoidEvent, useEventListener} from "@/events";
import {
    normalizeUe4ssSetting,
    UE4SS_SETTING_DISABLED,
    UE4SS_SETTING_ENABLED,
    type Ue4ssSetting,
} from "@/utils/Ue4ssSetting.ts";
import {confirmDelete, DeleteConfirm} from "@/services/DeleteConfirm";



export function MintCatSettings() {

    const languageOptions = [
        {value: 'en', label: t("English")},
        {value: 'zh', label: t('Chinese')},
    ];

    const themeOptions = [
        {value: 'Light', label: t('Light')},
        {value: 'Blue', label: t('Blue')},
        {value: 'Dark', label: t('Dark')},
        {value: 'Pink', label: t('Pink')},
    ];

    const [language, setLanguage] = React.useState<string>("en");
    const [theme, setTheme] = React.useState<string>("Light");
    const [configDirectory, setConfigDirectory] = React.useState<string>("");
    const [cacheDirectory, setCacheDirectory] = React.useState<string>("");
    const [ue4ss, setUe4ss] = React.useState<Ue4ssSetting>(UE4SS_SETTING_ENABLED);
    const [releaseChannel, setReleaseChannel] = React.useState<ReleaseChannel>(DEFAULT_RELEASE_CHANNEL);
    const descriptionHover = React.useSyncExternalStore(ModDescriptions.subscribe, ModDescriptions.isEnabled);
    const askBeforeDeleting = React.useSyncExternalStore(DeleteConfirm.subscribe, DeleteConfirm.isEnabled);
    const lookVersion = React.useSyncExternalStore(ModListAppearance.subscribe, ModListAppearance.version);
    const advanced = useAdvancedShown();
    const look = ModListAppearance.get(lookVersion);
    const titleLookVersion = React.useSyncExternalStore(TitleBarLook.subscribe, TitleBarLook.version);
    const [usageStats, setUsageStats] = React.useState(USAGE_STATS_DEFAULT);
    React.useEffect(() => {
        void UsageStats.isEnabled().then(setUsageStats);
    }, []);
    React.useEffect(() => {
        void TitleBarLook.init();
    }, []);
    const [clipboardMonitor, setClipboardMonitor] = React.useState<boolean>(true);
    const [compressModPak, setCompressModPak] = React.useState<boolean>(false);

    const releaseChannelOptions = RELEASE_CHANNELS.map((value) => ({
        value,
        label: t(`Release channel option ${value}`),
    }));

    const onOpenConfigDirClick = async () => {
        const settings = await StorageAPI.getSettings();
        await openPath(await settings.getConfigPath());
    }

    const onOpenCacheDirClick = async () => {
        await openPath(cacheDirectory);
    }

    const onSelectCacheDirClick = async () => {
        const result = await open({
            directory: true
        });
        if (result) {
            // 检查是否与当前缓存目录相同
            const settings = await StorageAPI.getSettings();
            const currentCachePath = await settings.getCachePath();
            
            if (result === currentCachePath) {
                message.info(t("cache.sameAsCurrent"));
                return;
            }
            
            // 显示确认对话框
            Modal.confirm({
                title: t("Change Cache Directory"),
                icon: <ExclamationCircleFilled />,
                content: t("cache.changeDirectoryConfirm"),
                okText: t("Confirm"),
                cancelText: t("Cancel"),
                onOk: async () => {
                    try {
                        // 更新设置
                        setCacheDirectory(result);
                        await settings.setCachePath(result);
                        
                        // 清除内存缓存
                        CacheApi.clearCache();
                        
                        // 清除所有 Modio mod 的缓存路径
                        const modsDAO = await StorageAPI.getMods();
                        await modsDAO.clearAllModioCachePaths();
                        
                        message.success(t("cache.directoryChangedSuccess"));
                    } catch (error) {
                        console.error("error.changeCacheDirectory:", error);
                        message.error(t("error.changeCacheDirectory"));
                    }
                }
            });
        }
    }

    const onLanguageChange = async (value: string) => {
        setLanguage(value);
        await i18n.changeLanguage(value);
        const settings = await StorageAPI.getSettings();
        await settings.setLanguage(value);
        window.location.reload();
    }

    const onThemeChange = async (value: string) => {
        setTheme(value);
        const settings = await StorageAPI.getSettings();
        await settings.setGuiTheme(value);
        localStorage.setItem('theme', value);
        await emitEvent("theme-change", value);
    }

    const onReleaseChannelChange = async (value: ReleaseChannel) => {
        setReleaseChannel(value);
        const settings = await StorageAPI.getSettings();
        await settings.setReleaseChannel(value);
        message.success(t("Release channel saved"));
    };

    const onUe4ssChange = async (value: Ue4ssSetting) => {
        setUe4ss(value);
        const settings = await StorageAPI.getSettings();
        await settings.setValue('ue4ss', value);
    }

    const onClipboardMonitorChange = async (checked: boolean) => {
        setClipboardMonitor(checked);
        const settings = await StorageAPI.getSettings();
        await settings.setClipboardMonitorEnabled(checked);
        if (checked) {
            await ClipboardApi.restartClipboardWatcher();
        } else {
            ClipboardApi.stopClipboardWatcher();
        }
    }

    const onCompressModPakChange = async (checked: boolean) => {
        setCompressModPak(checked);
        const settings = await StorageAPI.getSettings();
        await settings.setIntegratorCompressModPak(checked);
    }

    const onDevToolsClick = async () => {
        await IntegrateApi.openDevTools();
    }

    const onClearCacheClick = async () => {
        const ok = await confirmDelete({
            title: t("Clear Current Cache"),
            content: t("Clear Cache Warning"),
            okText: t("Clean"),
        });
        if (!ok) return;
        if (await CacheApi.cleanCurrentCache()) {
            message.success(t("Clean Cache Success"));
        } else {
            message.error(t("Clean Cache Failed"));
        }
    }

    const onImportConfigClick = async () => {
        await emitVoidEvent("config-manage-dialog-open");
    }

    // ✅ 使用 useEventListener 自动管理清理
    useEventListener("theme-change", (theme) => {
        setTheme(theme);
    });

    const fetchSettings = React.useCallback(async () => {
        const settings = await StorageAPI.getSettings();
        setLanguage(await settings.getLanguage());
        setTheme(await settings.getGuiTheme());
        setConfigDirectory(await settings.getConfigPath());
        setCacheDirectory(await settings.getCachePath());
        const ue4ssValue = await settings.getValue('ue4ss');
        setUe4ss(normalizeUe4ssSetting(ue4ssValue));
        setReleaseChannel(await settings.getReleaseChannel());
        setClipboardMonitor(await settings.getClipboardMonitorEnabled());
        setCompressModPak(await settings.getIntegratorCompressModPak());
    }, []);

    React.useEffect(() => {
        fetchSettings().then();
    }, [fetchSettings]);

    useEventListener("config-imported", () => {
        fetchSettings().then();
    });

    return (
        <>
            <Card title={t("MintCat Settings")}
                  style={{marginBottom: "10px"}}
            >
                <Form {...SettingLayout}
                >
                    <Form.Item label={t("Language")} name="language">
                        <Flex>
                            <Select value={language}
                                    options={languageOptions}
                                    onChange={onLanguageChange}
                            />
                        </Flex>
                    </Form.Item>
                    <Form.Item label={t("Theme")} name="theme">
                        <Flex>
                            <Select value={theme}
                                    options={themeOptions}
                                    onChange={onThemeChange}/>
                        </Flex>
                    </Form.Item>
                    <Form.Item label={t("iconPicker.settingLabel")} tooltip={t("help.titleBarIcons")}>
                        <Flex gap={16} align="center" wrap>
                            <Button icon={<img src={TitleBarLook.src("logo", titleLookVersion) ?? "icon.ico"} alt="" width={18} height={18} style={{borderRadius: 4, objectFit: "contain"}}/>}
                                    onClick={() => TitleBarLook.openPicker("logo")}>
                                {t("iconPicker.appIcon")}
                            </Button>
                            <Button icon={TitleBarLook.src("avatar", titleLookVersion)
                                        ? <img src={TitleBarLook.src("avatar", titleLookVersion)} alt="" width={18} height={18} style={{borderRadius: "50%", objectFit: "cover"}}/>
                                        : <UserOutlined/>}
                                    onClick={() => TitleBarLook.openPicker("avatar")}>
                                {t("iconPicker.profilePicture")}
                            </Button>
                        </Flex>
                    </Form.Item>
                    <Form.Item label={t("Config Directory")} tooltip={t("help.configDir")}>
                        <Flex>
                            <Input value={configDirectory}
                                   disabled/>
                            <Button type="default"
                                    onClick={onOpenConfigDirClick}
                            >
                                {t("Open")}
                            </Button>
                        </Flex>
                    </Form.Item>
                    <Form.Item label={t("Import Config")} tooltip={t("help.importConfig")}>
                        <Button type="dashed"
                                {...ButtonLayout}
                                onClick={onImportConfigClick}>
                            {t("Open")}
                        </Button>
                    </Form.Item>
                    <Form.Item label={t("mintImport.settingsLabel")} tooltip={t("help.mintImport")}>
                        <Button type="dashed"
                                {...ButtonLayout}
                                onClick={() => openMintImport()}>
                            {t("mintImport.choose")}
                        </Button>
                    </Form.Item>
                    <Form.Item label={t("Cache Directory")} tooltip={t("help.cacheDir")}>
                        <Flex>
                            <Search value={cacheDirectory}
                                    enterButton={<FolderAddOutlined/>}
                                    onSearch={onSelectCacheDirClick}
                            />
                            <Button type="default"
                                    onClick={onOpenCacheDirClick}
                            >
                                {t("Open")}
                            </Button>
                        </Flex>
                    </Form.Item>
                    <Form.Item label={t("Clear Current Cache")} tooltip={t("help.clearCache")}>
                        <Button type="dashed"
                                danger
                                {...ButtonLayout}
                                onClick={onClearCacheClick}>
                            {t("Clean")}
                        </Button>
                    </Form.Item>
                    <Form.Item label={t("Clipboard Monitor")} tooltip={t("help.clipboard")}>
                        <Switch checked={clipboardMonitor}
                                onChange={onClipboardMonitorChange}
                        />
                    </Form.Item>
                    <Form.Item label={t("logs.keepLabel")} tooltip={t("help.logsKeep")}>
                        <LogsKeptSetting/>
                    </Form.Item>
                    <Form.Item label={t("usageStats.label")} tooltip={t("help.usageStats")}>
                        <Flex gap={8} align="center">
                            <Switch checked={usageStats}
                                    onChange={(checked) => {
                                        setUsageStats(checked);
                                        void UsageStats.setEnabled(checked);
                                    }}/>
                            <Typography.Text type="secondary" style={{fontSize: 12}}>{t("usageStats.restart")}</Typography.Text>
                        </Flex>
                    </Form.Item>
                </Form>
            </Card>
            <Card title={t("modList.settingsTitle")}
                  style={{marginBottom: "10px"}}
            >
                <Form {...SettingLayout}>
                    <Form.Item label={t("deleteConfirm.setting")} tooltip={t("help.confirmDelete")}>
                        <Switch checked={askBeforeDeleting}
                                onChange={(checked) => void DeleteConfirm.setEnabled(checked)}/>
                    </Form.Item>
                    <Form.Item label={t("modDescription.setting")} tooltip={t("help.descriptionHover")}>
                        <Switch checked={descriptionHover}
                                onChange={(checked) => {
                                    void ModDescriptions.setEnabled(checked);
                                }}
                        />
                    </Form.Item>
                    <Form.Item label={t("modList.autoLinkColor")} tooltip={t("help.autoLinkColor")}>
                        <Flex gap={12} align="center">
                            <Switch checked={look.autoLinkColorEnabled}
                                    onChange={(checked) => void ModListAppearance.update({autoLinkColorEnabled: checked})}/>
                            <ColorPicker value={look.autoLinkColor}
                                         disabled={!look.autoLinkColorEnabled}
                                         disabledAlpha
                                         showText
                                         presets={[{label: t("modList.presets"), colors: COLOR_PRESETS}]}
                                         onChangeComplete={(c) => void ModListAppearance.update({autoLinkColor: c.toHexString()})}/>
                        </Flex>
                    </Form.Item>
                    <Form.Item label={t("modList.linkIcons")} tooltip={t("help.linkIcons")}>
                        <Flex gap={12} align="center" wrap>
                            <Switch checked={look.linkIcons}
                                    onChange={(checked) => void ModListAppearance.update({linkIcons: checked})}/>
                            <Typography.Text type="secondary" style={{fontSize: 12}}>
                                <ThunderboltOutlined/> {t("modList.iconAuto")}
                                &nbsp;&nbsp;<CloudDownloadOutlined/> {t("modList.iconAdded")}
                                &nbsp;&nbsp;<LinkOutlined/> {t("modList.iconManual")}
                                &nbsp;&nbsp;<DisconnectOutlined/> {t("modList.iconNone")}
                            </Typography.Text>
                        </Flex>
                    </Form.Item>
                    <Form.Item label={t("modList.columnsView")} tooltip={t("help.columnsView")}>
                        <Switch checked={look.columns}
                                onChange={(checked) => void ModListAppearance.update({columns: checked})}/>
                    </Form.Item>
                    <Form.Item label={t("modList.folderColors")} tooltip={t("help.folderColors")}>
                        <Flex gap={12} align="center">
                            <Typography.Text type="secondary">{t("modList.folderColorsHint")}</Typography.Text>
                            {Object.keys(look.folderColors).length > 0 &&
                                <Button size="small" onClick={() => void ModListAppearance.clearFolderColors()}>
                                    {t("modList.clearFolderColors")}
                                </Button>}
                        </Flex>
                    </Form.Item>
                </Form>
            </Card>
            <Card title={t("Framework Settings")}
                  style={{marginBottom: "10px"}}
            >
                <Form {...SettingLayout}>
                    {advanced &&
                    <Form.Item label={t("Release channel")} tooltip={t("help.releaseChannel")}>
                        <Flex>
                            <Select value={releaseChannel}
                                    options={releaseChannelOptions}
                                    onChange={onReleaseChannelChange}
                            />
                        </Flex>
                    </Form.Item>}
                    <Form.Item label={t("UE4SS")} tooltip={t("help.ue4ss")}>
                        <Select<Ue4ssSetting> onChange={onUe4ssChange}
                                value={ue4ss}
                                options={[
                                    {
                                        value: UE4SS_SETTING_ENABLED,
                                        label: t("Enable"),
                                    },
                                    {
                                        value: UE4SS_SETTING_DISABLED,
                                        label: t("Disable"),
                                    },
                                ]}/>
                    </Form.Item>
                    {advanced &&
                    <Form.Item label={t("Compress Mod Pak")} tooltip={t("help.compress")}>
                        <Switch checked={compressModPak}
                                onChange={onCompressModPakChange}
                        />
                    </Form.Item>}
                    {advanced &&
                    <Form.Item label={t("Dev Tools")} tooltip={t("help.devTools")}>
                        <Button type="dashed"
                                {...ButtonLayout}
                                onClick={onDevToolsClick}>
                            {t("Open Dev Tools")}
                        </Button>
                    </Form.Item>}
                </Form>
            </Card>
        </>
    )
}

/** How many launches' logs are kept; the oldest are deleted as new launches start */
function LogsKeptSetting() {
    const [keep, setKeep] = React.useState<number>(DEFAULT_KEEP);
    const [stats, setStats] = React.useState<{ launches: number; bytes: number } | null>(null);
    const refresh = React.useCallback(async () => {
        try {
            const sessions = await AppLogs.sessions();
            setStats({launches: sessions.length, bytes: sessions.reduce((n, s) => n + s.files.reduce((m, f) => m + f.size, 0), 0)});
        } catch {
            setStats(null);
        }
    }, []);
    React.useEffect(() => {
        void AppLogs.keepCount().then(setKeep);
        void refresh();
    }, [refresh]);
    const save = async (value: number | null) => {
        if (value == null) return;
        try {
            const result = await AppLogs.setKeepCount(value);
            setKeep(result);
            await refresh();
        } catch (error) {
            message.error(String(error));
        }
    };
    const mb = stats ? (stats.bytes / 1024 / 1024).toFixed(stats.bytes < 10 * 1024 * 1024 ? 1 : 0) : "";
    return (
        <Flex gap={8} align="center" wrap>
            <InputNumber min={1} max={MAX_KEEP} value={keep} style={{width: 90}}
                         onChange={(value) => value != null && setKeep(value)}
                         onBlur={() => void save(keep)}
                         onPressEnter={() => void save(keep)}/>
            <Typography.Text type="secondary" style={{fontSize: 12}}>
                {t("logs.launches", {count: keep})}{stats ? ` · ${t("logs.now", {count: stats.launches, size: mb})}` : ""}
            </Typography.Text>
            <Button size="small" onClick={() => void appLogDir().then(openPath).catch((e) => message.error(String(e)))}>
                {t("log.openFolder")}
            </Button>
        </Flex>
    );
}
