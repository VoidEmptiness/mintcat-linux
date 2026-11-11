/**
 * A right-click menu that closes the way menus in other apps do. antd's Dropdown with the
 * contextMenu trigger stays open when you left-click the thing you right-clicked (the row
 * itself counts as "inside" it), when you click into another window, and while you scroll the
 * list under it. This one also closes:
 *   - on a left/middle click anywhere that isn't the menu (or one of its submenus)
 *   - when the window loses focus
 *   - when something under it scrolls
 * Only one is open at a time.
 */
import React, {useEffect, useRef, useState} from "react";
import {Dropdown, type DropdownProps} from "antd";

type Props = Omit<DropdownProps, 'trigger' | 'open' | 'onOpenChange'> & {
    onOpenChange?: (open: boolean) => void;
};

let closeOpenMenu: (() => void) | null = null;

/** Inside an antd menu popup (the menu or a submenu) */
function inMenuPopup(target: EventTarget | null): boolean {
    return target instanceof Element && !!target.closest('.ant-dropdown, .ant-dropdown-menu-submenu-popup, .ant-dropdown-menu-submenu');
}

export function ContextMenu({onOpenChange, children, ...props}: Props) {
    const [open, setOpen] = useState(false);
    const openedAt = useRef(0);

    const change = (next: boolean) => {
        if (next) {
            // a menu of another row closes first
            if (closeOpenMenu) closeOpenMenu();
            openedAt.current = Date.now();
        }
        setOpen(next);
        onOpenChange?.(next);
    };

    useEffect(() => {
        if (!open) return;
        const close = () => change(false);
        closeOpenMenu = close;
        const onDown = (e: MouseEvent) => {
            // the right-click that opened it, or a right-click elsewhere (antd moves it there)
            if (e.button === 2) return;
            if (inMenuPopup(e.target)) return;
            close();
        };
        const onScroll = (e: Event) => {
            if (inMenuPopup(e.target)) return;
            // the opening right-click can scroll a row into view: give it a moment
            if (Date.now() - openedAt.current < 250) return;
            close();
        };
        const onKey = (e: KeyboardEvent) => {
            if (e.key === 'Escape') close();
        };
        window.addEventListener('mousedown', onDown, true);
        window.addEventListener('blur', close);
        window.addEventListener('scroll', onScroll, true);
        window.addEventListener('wheel', onScroll, {capture: true, passive: true});
        window.addEventListener('keydown', onKey, true);
        return () => {
            if (closeOpenMenu === close) closeOpenMenu = null;
            window.removeEventListener('mousedown', onDown, true);
            window.removeEventListener('blur', close);
            window.removeEventListener('scroll', onScroll, true);
            window.removeEventListener('wheel', onScroll, true);
            window.removeEventListener('keydown', onKey, true);
        };
        // eslint-disable-next-line react-hooks/exhaustive-deps
    }, [open]);

    return (
        <Dropdown {...props} trigger={['contextMenu']} open={open} onOpenChange={change}>
            {children}
        </Dropdown>
    );
}
