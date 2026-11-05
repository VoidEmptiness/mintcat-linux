import React from "react";
import {Menu, MenuProps} from "antd";
import {DownloadOutlined, HomeOutlined, SettingOutlined, ThunderboltOutlined} from "@ant-design/icons";
import {ModioOutlined} from "./SvgIcon.tsx";
import {t} from "i18next";


type MenuItem = Required<MenuProps>['items'][number];

export enum MenuPage {
    Home = 'home',
    Setting = 'setting',
    Modio = 'modio',
    Downloads = 'downloads',
    // Chat = 'chat',
    // Accelerator = 'accelerator',
}

interface MenuBarProps {
    onClick: (key: string) => void;
    activeKey: string;
}

class MenuBar extends React.Component<MenuBarProps, any> {

    private items: MenuItem[] = [
        {
            key: MenuPage.Home,
            icon: <HomeOutlined/>,
            label: t("menu.modList"),
            className: 'tour-step-home',
        },
        {key: MenuPage.Modio, icon: <ModioOutlined/>, label: t("menu.browse"), className: 'tour-step-modio'},
        {key: MenuPage.Downloads, icon: <DownloadOutlined/>, label: t("menu.downloads")},
        // {key: MenuPage.Accelerator, icon: <ThunderboltOutlined/>, label: t('Accelerator')},
        {key: MenuPage.Setting, icon: <SettingOutlined/>, label: t("Settings"), className: 'tour-step-setting'},
    ];

    public constructor(props: any) {
        super(props);
    }

    render() {
        return (
            <Menu
                selectedKeys={[this.props.activeKey]}
                mode="inline"
                // Collapsed: only the icons show, and each one names its page on hover
                inlineCollapsed={true}
                inlineIndent={14}
                items={this.items}
                style={{backgroundColor: 'transparent', height: '100%', width: '100%'}}
                onClick={({key}) => {
                    this.props.onClick(key);
                }}
            />
        );
    }
}

export default MenuBar;
