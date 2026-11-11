/**
 * The mod list's search box: type to search names, tags and notes, or pick filters from its
 * list (see services/ModFilters). The list only offers filters that find something in this
 * profile, with how many mods each finds, and typing narrows it ("vis" → the Visual tag).
 *
 * Clicking back into the box brings the word you typed back as text, selected, like a browser's
 * address bar: type to replace it, Backspace to clear it, or click again to edit it. Picked
 * filters stay chips. Ctrl+F jumps to the box.
 */
import React, {useSyncExternalStore} from "react";
import {Select, SelectProps} from "antd";
import {SearchOutlined} from "@ant-design/icons";
import {useTranslation} from "react-i18next";
import {TreeViewConverter} from "@/pages/HomePage/TreeViewConverter.ts";
import {choiceCounts, FILTER_GROUPS, filterChoice, filterGroupOf, TAG_PREFIX, TAGS_AFTER_GROUP, tagCounts} from "@/services/ModFilters";
import {liveFilterProbe} from "@/services/ModFilterProbe";
import {ModNotes} from "@/services/ModNotes";
import {ModSupport} from "@/services/ModSupport";
import {ConflictService} from "@/services/ConflictService";
import {RepositoryUpdates} from "@/services/RepositoryUpdates";

// the list's filters look up notes, marks, conflicts and Pak Hub links in the app's stores
TreeViewConverter.probe = liveFilterProbe;

type FilterOptionGroup = NonNullable<SelectProps["options"]>;

interface FilterOption {
    value: string;
    label: string;
    /** How many mods of the profile it finds (not for typed words) */
    count?: number;
    /** A word you typed (searched for in names, tags and notes) */
    typed?: boolean;
    /** What typing finds it by */
    search: string;
    /** What it finds (shown when you point at it) */
    title?: string;
}

type Translate = (key: string, options?: Record<string, unknown>) => unknown;

/** The text of a chip / choice */
function filterLabel(value: string, t: Translate): string {
    if (value.startsWith(TAG_PREFIX)) return value.slice(TAG_PREFIX.length);
    const choice = filterChoice(value);
    return choice ? String(t(choice.labelKey)) : value;
}

/**
 * The choices of the box: the fixed groups and the tags of the profile's mods, only those that
 * find something (and the ones picked, so their chips keep their names)
 */
function buildFilterOptions(t: Translate, picked: string[]): FilterOptionGroup {
    const entries = TreeViewConverter.profileEntries;
    const counts = choiceCounts(entries, TreeViewConverter.probe);
    const pickedSet = new Set(picked);
    const list: FilterOptionGroup = [];
    for (const group of FILTER_GROUPS) {
        const options: FilterOption[] = group.choices
            .filter(c => group.always || (counts.get(c.value) ?? 0) > 0 || pickedSet.has(c.value))
            .map(c => {
                const label = String(t(c.labelKey));
                const tip = c.tipKey ? String(t(c.tipKey)) : label;
                return {value: c.value, label, title: tip, count: counts.get(c.value) ?? 0, search: `${label} ${c.also ?? ""}`};
            });
        if (options.length) {
            if (group.flat) {
                list.push(...options);
            } else {
                const label = String(t(group.labelKey));
                list.push({label, title: label, search: label, options});
            }
        }
        if (group.key === TAGS_AFTER_GROUP) list.push(...tagGroup(t, entries, picked));
    }
    return list;
}

/** The tags of the profile's mods, as in the Tags column (and picked ones no mod has any more) */
function tagGroup(t: Translate, entries: typeof TreeViewConverter.profileEntries, picked: string[]): FilterOptionGroup {
    const tags = tagCounts(entries);
    const options: FilterOption[] = tags.map(({tag, count}) => ({value: TAG_PREFIX + tag, label: tag, title: tag, count, search: tag}));
    for (const value of picked) {
        if (value.startsWith(TAG_PREFIX) && !options.some(o => o.value === value)) {
            const tag = value.slice(TAG_PREFIX.length);
            options.push({value, label: tag, title: tag, count: 0, search: tag});
        }
    }
    if (options.length === 0) return [];
    const label = String(t("Tags"));
    return [{label, title: label, search: label, options}];
}

/** Words typed (not picked filters) shown as choices at the top, so their chips have names */
function typedOptions(values: string[]): FilterOption[] {
    return Array.from(new Set(values))
        .filter(v => !filterGroupOf(v))
        .map(v => ({value: v, label: v, typed: true, search: v}));
}

/** Keeps choices whose name (or their group's) has the typed text */
function filterByText(input: string, option?: { search?: string; label?: unknown }): boolean {
    const text = String(option?.search ?? option?.label ?? "").toLocaleLowerCase();
    return text.includes(input.trim().toLocaleLowerCase());
}

/** A dialog is open (Ctrl+F then belongs to it) */
function dialogOpen(): boolean {
    return Array.from(document.querySelectorAll<HTMLElement>('.ant-modal-wrap'))
        .some(el => getComputedStyle(el).display !== 'none');
}

interface SearchBoxProps {
    onUpdateTreeView: () => void;
}

export const SearchBox = ({onUpdateTreeView}: SearchBoxProps) => {
    const {t} = useTranslation();
    const [searchKeyword, setSearchKeyword] = React.useState("");
    const [searchValue, setSearchValueState] = React.useState<string[] | undefined>(() => {
        const list = TreeViewConverter.filterList;
        return list?.length ? list : undefined;
    });
    /**
     * The chips as of the last change. rc-select can call onSearch right after onChange in the
     * same event (the clear button does), before a render gives the handlers the new chips.
     */
    const chipsRef = React.useRef<string[]>(searchValue ?? []);
    const setSearchValue = (value: string[] | undefined) => {
        chipsRef.current = value ?? [];
        setSearchValueState(value);
    };
    const [open, setOpen] = React.useState(false);
    /** Counted again each time the list opens */
    const [openCount, setOpenCount] = React.useState(0);
    const rootRef = React.useRef<HTMLSpanElement>(null);
    const selectRef = React.useRef<any>(null);
    /** Bumped when the typed word comes back into the box, to select it */
    const [selectWord, setSelectWord] = React.useState(0);
    /** The word came back into the box and hasn't been edited: the list shows every choice */
    const [restored, setRestored] = React.useState(false);
    /** The box is being focused by a click on a chip's ✕ or the clear button: leave the chips as they are */
    const keepChips = React.useRef(false);
    /** The clear button was pressed: the change that follows empties everything, typed text too */
    const clearing = React.useRef(false);

    // the counts follow notes, marks, conflicts and Pak Hub updates while the list is open
    const notesVersion = useSyncExternalStore(ModNotes.subscribe, ModNotes.version);
    const supportVersion = useSyncExternalStore(ModSupport.subscribe, ModSupport.version);
    const conflictVersion = useSyncExternalStore(ConflictService.subscribe, ConflictService.version);
    const repoVersion = useSyncExternalStore(RepositoryUpdates.subscribe, RepositoryUpdates.version);

    // counted when the list opens and when those stores change, not on every key
    const fixedOptions = React.useMemo<FilterOptionGroup>(() => {
        const picked = searchValue ?? [];
        return open || picked.length ? buildFilterOptions(t, picked) : [];
        // eslint-disable-next-line react-hooks/exhaustive-deps
    }, [t, searchValue, open, openCount, notesVersion, supportVersion, conflictVersion, repoVersion]);
    const searchOptions = React.useMemo<FilterOptionGroup>(() => {
        const typed = typedOptions([...(searchValue ?? []), ...(searchKeyword.trim() ? [searchKeyword.trim()] : [])]);
        return typed.length ? [...typed, ...fixedOptions] : fixedOptions;
    }, [fixedOptions, searchKeyword, searchValue]);

    // Typing filters as you go (shortly after the last key), together with the chips already picked
    const typingTimer = React.useRef<ReturnType<typeof setTimeout> | undefined>(undefined);
    React.useEffect(() => () => clearTimeout(typingTimer.current), []);

    const onSearch = (newValue: string) => {
        setSearchKeyword(newValue);
        setRestored(false);
        const keyword = newValue.trim();
        TreeViewConverter.filterList = [...chipsRef.current, ...(keyword ? [keyword] : [])];
        clearTimeout(typingTimer.current);
        typingTimer.current = setTimeout(() => onUpdateTreeView(), 200);
    }

    const onSearchSelectChange = (picked: string[]) => {
        const keyword = clearing.current ? "" : searchKeyword.trim();
        clearing.current = false;
        const added = picked.filter(v => !chipsRef.current.includes(v));
        clearTimeout(typingTimer.current);
        if (keyword && added.length === 0 && !picked.includes(keyword)) {
            // a chip was removed while typing: the typed text stays (as text and as a filter)
            TreeViewConverter.filterList = [...picked, keyword];
            setSearchValue(picked.length ? picked : undefined);
            onUpdateTreeView();
            return;
        }
        // Picking a filter clears the typed text; keep it as a filter of its own, unless it was
        // typed to find that choice (e.g. "vis" → Visual)
        let value = picked;
        if (keyword && !value.includes(keyword)) {
            const lower = keyword.toLocaleLowerCase();
            const typedForChoice = added.some(v =>
                v.toLocaleLowerCase().includes(lower) || filterLabel(v, t).toLocaleLowerCase().includes(lower)
                || (filterChoice(v)?.also ?? "").toLocaleLowerCase().includes(lower));
            if (added.length > 0 && !typedForChoice) {
                value = [keyword, ...value];
            }
        }
        const nextValue = value.length ? value : undefined;
        TreeViewConverter.filterList = nextValue ?? [];
        setRestored(false);
        setSearchKeyword("");
        setSearchValue(nextValue);
        onUpdateTreeView();
    }

    // Esc clears the typed text in the box; drop its filter too so the list matches what's shown
    const onKeyDown = (e: React.KeyboardEvent) => {
        if (e.key !== "Escape" || !searchKeyword) return;
        clearTimeout(typingTimer.current);
        setSearchKeyword("");
        TreeViewConverter.filterList = [...chipsRef.current];
        onUpdateTreeView();
    }

    // Back in the box: the last word you typed comes back as text, selected (the list doesn't change)
    const onFocus = () => {
        if (keepChips.current) {
            keepChips.current = false;
            return;
        }
        if (searchKeyword) return;
        const chips = chipsRef.current;
        for (let i = chips.length - 1; i >= 0; i--) {
            if (filterGroupOf(chips[i])) continue;
            const rest = chips.filter((_, j) => j !== i);
            setSearchValue(rest.length ? rest : undefined);
            setSearchKeyword(chips[i]);
            setRestored(true);
            setSelectWord(n => n + 1);
            // the box only shows typed text while its list is open (Ctrl+F doesn't open it)
            onOpenChange(true);
            return;
        }
    }

    React.useEffect(() => {
        if (!selectWord) return;
        const frame = requestAnimationFrame(() => rootRef.current?.querySelector('input')?.select());
        return () => cancelAnimationFrame(frame);
    }, [selectWord]);

    const onBlur = () => {
        const filterList = TreeViewConverter.filterList;
        setRestored(false);
        setSearchKeyword("");
        setSearchValue(filterList?.length ? filterList : undefined);
    }

    const onOpenChange = (next: boolean) => {
        setOpen(next);
        if (next) {
            setOpenCount(n => n + 1);
            // Nexus Mods / mod.io marks for "Your marks" (nothing happens without a key or token)
            void ModSupport.refresh();
        }
    }

    // Ctrl+F: to the search box (when the mod list is on screen and no dialog is open)
    React.useEffect(() => {
        const onKey = (e: KeyboardEvent) => {
            if (!(e.ctrlKey || e.metaKey) || e.altKey || e.shiftKey || e.key.toLocaleLowerCase() !== 'f') return;
            if (!rootRef.current || rootRef.current.offsetParent === null || dialogOpen()) return;
            e.preventDefault();
            selectRef.current?.focus();
            onOpenChange(true);
        };
        window.addEventListener('keydown', onKey);
        return () => window.removeEventListener('keydown', onKey);
    }, []);

    return (
        <span ref={rootRef} className="mod-search-box"
              onMouseDownCapture={(e) => {
                  // removing a chip or clearing the box: don't turn the typed word back into text first
                  const target = e.target instanceof Element ? e.target : null;
                  if (target?.closest('.ant-select-selection-item-remove, .ant-select-clear')) {
                      keepChips.current = true;
                      setTimeout(() => keepChips.current = false, 0);
                  }
              }}>
            <Select ref={selectRef}
                    size={"small"}
                    value={searchValue}
                    options={searchOptions}
                    onChange={onSearchSelectChange}
                    onFocus={onFocus}
                    onBlur={onBlur}
                    onKeyDown={onKeyDown}
                    onClear={() => {
                        clearing.current = true;
                    }}
                    open={open}
                    onOpenChange={onOpenChange}
                    className="w-300"
                    placeholder={t("modSearch.placeholder")}
                    suffixIcon={<SearchOutlined/>}
                    notFoundContent={null}
                    defaultActiveFirstOption={false}
                    // the typed text is kept here so Esc really empties the box (the Select's own copy
                    // stayed hidden and the next letters were added to it)
                    showSearch={{searchValue: searchKeyword, onSearch, filterOption: restored ? false : filterByText}}
                    allowClear={true}
                    mode={"multiple"}
                    maxTagCount="responsive"
                    listHeight={360}
                    popupMatchSelectWidth={320}
                    classNames={{popup: {root: "mod-filter-popup"}}}
                    optionRender={(option) => {
                        const data = option.data as FilterOption;
                        if (data.typed) {
                            return (
                                <span className="mod-filter-option mod-filter-typed">
                                    <SearchOutlined/>
                                    <span className="mod-filter-label">{t("filter.searchFor", {text: data.label})}</span>
                                </span>
                            );
                        }
                        return (
                            <span className="mod-filter-option">
                                <span className="mod-filter-label">{data.label}</span>
                                {data.count != null && <span className="mod-filter-count">{data.count}</span>}
                            </span>
                        );
                    }}
                    popupRender={(menu) => (
                        <>
                            {menu}
                            <div className="mod-filter-hint">{t("filter.hint")}</div>
                        </>
                    )}
            />
        </span>
    )
}
