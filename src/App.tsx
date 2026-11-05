import React from 'react';
import {Layout} from 'antd';
import {Route, Routes, useLocation, useNavigate} from 'react-router-dom';
import {perfMark, perfUntilPainted} from '@/utils/perfTrace';
import {useAppError} from '@/hooks/useAppError';
import {useDeepLinkHandler} from '@/hooks/useDeepLinkHandler';
import {useOAuthCallback} from '@/hooks/useOAuthCallback';

import TitleBar from "@/components/TitleBar.tsx";
import StatusBar from "@/components/StatusBar.tsx";
import LogPanel from "@/components/LogPanel";
import {initActivityLog} from "@/services/ActivityLog";
import {AppLogs} from "@/services/AppLogs";
import {logStartup} from "@/services/StartupLog";
import {RepositoryUpdates} from "@/services/RepositoryUpdates";
import MenuBar, {MenuPage} from "@/components/MenuBar.tsx";
import UpdateDialog from "@/dialogs/UpdateDialog.tsx";
import {initClipboardWatcher} from "@/dialogs/AddModDialog/open.ts";

import {HomePage} from "@/pages/HomePage";
import {SearchPage} from "@/pages/SearchPage";
import {SettingPage} from "@/pages/SettingPage";
import {DownloadsPage} from "@/pages/DownloadsPage";
import {AcceleratorPage} from "@/pages/AcceleratorPage";
import {AppInitializer} from "@/core/AppInitializer";

import './App.css';
import {EmptyPage} from "@/pages/EmptyPage.tsx";
import {ConfigManageDialog} from "@/dialogs/ConfigManageDialog";
import {MintImportDialog} from "@/dialogs/MintImportDialog";
import {useFileDrop} from "@/hooks/useFileDrop";
import {ModDescriptions} from "@/services/ModDescriptions";
import {DeleteConfirm} from "@/services/DeleteConfirm";
import {ModListAppearance} from "@/services/ModListAppearance";
import {FolderColorDialog} from "@/dialogs/FolderColorDialog";
import {IconPickerDialog} from "@/dialogs/IconPickerDialog";
import {Backups} from "@/services/Backups";
import {UsageStats} from "@/services/UsageStats";
import {TitleBarLook} from "@/services/TitleBarLook";
import {SystemIcon} from "@/services/SystemIcon";

import {SelectGameDialog} from "@/dialogs/SelectGameDialog";
import {useKeyboardListener} from "@/hooks/useKeyboardListener.tsx";
import {emitEvent, listenEvent, useEventListener} from "@/events";
import {OnboardingTour} from "@/components/OnboardingTour.tsx";
import {DeviceApi} from "@/apis/DeviceApi.ts";
import {IoC} from "@/core/IoC";
import {AppViewModel} from "@/AppViewModel";

const {
    Header,
    Footer,
    Sider,
    Content
} = Layout;


const AppContent = () => {


    const [isAppViewModelReady, setIsAppViewModelReady] = React.useState(false);
    const [initError, setInitError] = React.useState<Error | null>(null);
    const [showOnboarding, setShowOnboarding] = React.useState(false);
    const onboardingOpenedByUserRef = React.useRef(false);
    const navigate = useNavigate();
    const location = useLocation();

    const clickMenu = React.useCallback((key: string) => {
        perfMark(`nav ${key}`);
        if (key === MenuPage.Home) {
            navigate('/home');
            return;
        }
        navigate(`/home/${key}`);
    }, [navigate]);

    const activeMenuKey = React.useMemo<MenuPage>(() => {
        const trimmed = location.pathname.replace(/^\/home\/?/, '');
        const segment = trimmed.split('/')[0];
        if (!segment) {
            return MenuPage.Home;
        }
        if (Object.values(MenuPage).includes(segment as MenuPage)) {
            return segment as MenuPage;
        }
        return MenuPage.Home;
    }, [location.pathname]);
    React.useEffect(() => {
        perfUntilPainted(`route ${location.pathname}`);
    }, [location.pathname]);
    // Every route that isn't one of the other pages shows the mod list
    const isHomeRoute = !OTHER_PAGE_ROUTES.some((route) => location.pathname.startsWith(route));

    useAppError();
    useDeepLinkHandler(isAppViewModelReady);
    useOAuthCallback();
    useFileDrop();
    // 配置导入成功后刷新主题和语言，使界面立即反映迁移后的设置
    useEventListener('config-imported', async () => {
        try {
            const vm = await IoC.get(AppViewModel);
            await vm.loadUserGuiTheme();
            await vm.loadUserLanguages();
        } catch (e) {
            console.warn('[App] config-imported refresh theme/language failed', e);
        }
    });
    useKeyboardListener((event) => {
        if (event.ctrlKey && event.key === 'f') {
            event.preventDefault();
        }
    });

    React.useEffect(() => {
        console.log('App 组件加载...');

        // Initialize core (database + AppViewModel)
        setInitError(null);
        AppInitializer.initializeCore()
            .then(async () => {
                console.log('[App] Core initialization complete');
                logStartup().catch(console.error);
                ModDescriptions.init().catch(console.error);
                DeleteConfirm.init().catch(console.error);
                ModListAppearance.init().catch(console.error);
                // logs of launches beyond the number kept (Settings) go now
                AppLogs.prune().catch(e => console.warn('[App] old logs not pruned', e));
                Backups.startAuto();
                UsageStats.start().catch(console.error);
                // the picked app icon on the window and the app menu entry (again after an update)
                TitleBarLook.init()
                    .then(() => SystemIcon.syncAtStart(TitleBarLook.src("logo")))
                    .catch(console.error);
                setInitError(null);
                setIsAppViewModelReady(true);
                const completed = await DeviceApi.getOnboardingCompleted();
                if (!completed) {
                    // 首次启动：触发新手指引（欢迎 → 配置导入 → 游戏选择 → 用户设置 → 其余步骤）
                    requestAnimationFrame(() => {
                        setTimeout(() => setShowOnboarding(true), 100);
                    });
                }
            })
            .catch((error) => {
                console.error('[App] Core initialization failed:', error);
                setInitError(error instanceof Error ? error : new Error(String(error)));
                emitEvent('app-error', error.message || 'error.applicationInitFailed').catch(console.error);
            });

        initClipboardWatcher();
        initActivityLog().catch(console.error);
        RepositoryUpdates.init().catch(console.error);

    }, []);

    React.useEffect(() => {
        let unlisten: (() => void) | undefined;
        listenEvent('start-onboarding', () => {
            onboardingOpenedByUserRef.current = true;
            requestAnimationFrame(() => setTimeout(() => setShowOnboarding(true), 100));
        }).then((fn) => { unlisten = fn; });
        return () => { unlisten?.(); };
    }, []);

    const handleOnboardingComplete = React.useCallback(async () => {
        setShowOnboarding(false);
        if (!onboardingOpenedByUserRef.current) {
            await DeviceApi.setOnboardingCompleted();
        }
        onboardingOpenedByUserRef.current = false;
    }, []);

    return (
        <Layout className={"app"}>
            <OnboardingTour open={showOnboarding} onComplete={handleOnboardingComplete}/>
            <UpdateDialog/>
            <ConfigManageDialog/>
            <MintImportDialog/>
            <FolderColorDialog/>
            <IconPickerDialog/>
            <SelectGameDialog/>
            <Header className={"app-header"}>
                <TitleBar/>
            </Header>
            <Layout>
                <Sider width="50px">
                    <MenuBar onClick={clickMenu} activeKey={activeMenuKey}/>
                </Sider>
                <Content>
                    {initError != null && (
                        <EmptyPage initError={initError} onRetry={() => {
                            setInitError(null);
                            AppInitializer.resetForRetry();
                            AppInitializer.initializeCore()
                                .then(async () => {
                                    setInitError(null);
                                    setIsAppViewModelReady(true);
                                    const completed = await DeviceApi.getOnboardingCompleted();
                                    if (!completed) {
                                        requestAnimationFrame(() => {
                                            setTimeout(() => setShowOnboarding(true), 100);
                                        });
                                    }
                                })
                                .catch((err) => {
                                    setInitError(err instanceof Error ? err : new Error(String(err)));
                                    emitEvent('app-error', err.message || 'error.applicationInitFailed').catch(console.error);
                                });
                        }}/>
                    )}
                    {initError == null && !isAppViewModelReady && <EmptyPage/>}
                    {initError == null && isAppViewModelReady && (
                        <>
                            {/* The mod list stays mounted while other pages are open: rebuilding it
                                (database reads, ~200 rows) on every return made switching pages slow */}
                            <div style={isHomeRoute ? undefined : {display: "none"}}>
                                <HomePage active={isHomeRoute}/>
                            </div>
                            <Routes>
                                <Route path="/home" element={null}/>
                                <Route path="/home/modio" element={<SearchPage/>}/>
                                <Route path="/home/downloads" element={<DownloadsPage/>}/>
                                <Route path="/home/accelerator" element={<AcceleratorPage/>}/>
                                <Route path="/home/setting" element={<SettingPage/>}/>
                                <Route path="*" element={null}/>
                            </Routes>
                        </>
                    )}
                </Content>
            </Layout>
            <LogPanel/>
            <Footer className="app-footer" style={{height: "30px", position: "relative", zIndex: 5}}>
                <StatusBar/>
            </Footer>
        </Layout>
    );
};

/** Routes with their own page; everything else shows the mod list */
const OTHER_PAGE_ROUTES = ['/home/modio', '/home/downloads', '/home/accelerator', '/home/setting'];

function App() {
    return (
        <AppContent/>
    );
}


export default App;
