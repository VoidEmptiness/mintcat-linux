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
import {choiceCounts, FILTER_GROUPS, filterChoice, filterGroupOf, TAG_PREFIX, tagCounts} from "@/services/ModFilters";
import {liveFilterProbe} from "@/services/ModFilterProbe";
import {ModNotes} from "@/services/ModNotes";
import {ModSupport} from "@/services/ModSupport";
import {ConflictService} from "@/services/ConflictService";
import {RepositoryUpdates} from "@/services/RepositoryUpdates";
import {PostFacts} from "@/services/PostFacts";

// the list's filters look up notes, marks, conflicts and Pak Hub posts in the app's stores
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
    const groups: FilterOptionGroup = [];
    for (const group of FILTER_GROUPS) {
        const options: FilterOption[] = group.choices
            .filter(c => group.always || (counts.get(c.value) ?? 0) > 0 || pickedSet.has(c.value))
            .map(c => {
                const label = String(t(c.labelKey));
                return {value: c.value, label, count: counts.get(c.value) ?? 0, search: `${label} ${c.also ?? ""}`};
            });
        if (options.length) {
            const label = String(t(group.labelKey));
            groups.push({label, title: label, search: label, options});
        }
    }
    const tags = tagCounts(entries);
    const tagOptions: FilterOption[] = tags.map(({tag, count}) => ({value: TAG_PREFIX + tag, label: tag, count, search: tag}));
    for (const value of picked) {
        if (value.startsWith(TAG_PREFIX) && !tagOptions.some(o => o.value === value)) {
            tagOptions.push({value, label: value.slice(TAG_PREFIX.length), count: 0, search: value.slice(TAG_PREFIX.length)});
        }
    }
    if (tagOptions.length) {
        const label = String(t("Tags"));
        groups.push({label, title: label, search: label, options: tagOptions});
    }
    return groups;
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
    const [searchValue, setSearchValue] = React.useState<string[] | undefined>(() => {
        const list = TreeViewConverter.filterList;
        return list?.length ? list : undefined;
    });
    const [open, setOpen] = React.useState(false);
    /** Counted again each time the list opens */
    const [openCount, setOpenCount] = React.useState(0);
    const rootRef = React.useRef<HTMLSpanElement>(null);
    const selectRef = React.useRef<any>(null);
    /** Bumped when the typed word comes back into the box, to select it */
    const [selectWord, setSelectWord] = React.useState(0);

    // the counts follow notes, marks, conflicts and Pak Hub posts while the list is open
    const notesVersion = useSyncExternalStore(ModNotes.subscribe, ModNotes.version);
    const supportVersion = useSyncExternalStore(ModSupport.subscribe, ModSupport.version);
    const conflictVersion = useSyncExternalStore(ConflictService.subscribe, ConflictService.version);
    const repoVersion = useSyncExternalStore(RepositoryUpdates.subscribe, RepositoryUpdates.version);
    const factsVersion = useSyncExternalStore(PostFacts.subscribe, PostFacts.version);

    // counted when the list opens and when those stores change, not on every key
    const fixedOptions = React.useMemo<FilterOptionGroup>(() => {
        const picked = searchValue ?? [];
        return open || picked.length ? buildFilterOptions(t, picked) : [];
        // eslint-disable-next-line react-hooks/exhaustive-deps
    }, [t, searchValue, open, openCount, notesVersion, supportVersion, conflictVersion, repoVersion, factsVersion]);
    const searchOptions = React.useMemo<FilterOptionGroup>(() => {
        const typed = typedOptions([...(searchValue ?? []), ...(searchKeyword.trim() ? [searchKeyword.trim()] : [])]);
        return typed.length ? [...typed, ...fixedOptions] : fixedOptions;
    }, [fixedOptions, searchKeyword, searchValue]);

    // Typing filters as you go (shortly after the last key), together with the chips already picked
    const typingTimer = React.useRef<ReturnType<typeof setTimeout> | undefined>(undefined);
    React.useEffect(() => () => clearTimeout(typingTimer.current), []);

    const onSearch = (newValue: string) => {
        setSearchKeyword(newValue);
        const keyword = newValue.trim();
        TreeViewConverter.filterList = [...(searchValue ?? []), ...(keyword ? [keyword] : [])];
        clearTimeout(typingTimer.current);
        typingTimer.current = setTimeout(() => onUpdateTreeView(), 200);
    }

    const onSearchSelectChange = (picked: string[]) => {
        // Picking a filter clears the typed text; keep it as a filter of its own, unless it was
        // typed to find that choice (e.g. "vis" → Visual)
        let value = picked;
        const keyword = searchKeyword.trim();
        if (keyword && !value.includes(keyword)) {
            const added = value.filter(v => !(searchValue ?? []).includes(v));
            const lower = keyword.toLocaleLowerCase();
            const typedForChoice = added.some(v =>
                v.toLocaleLowerCase().includes(lower) || filterLabel(v, t).toLocaleLowerCase().includes(lower)
                || (filterChoice(v)?.also ?? "").toLocaleLowerCase().includes(lower));
            if (added.length > 0 && !typedForChoice) {
                value = [keyword, ...value];
            }
        }
        const nextValue = value.length ? value : undefined;
        clearTimeout(typingTimer.current);
        TreeViewConverter.filterList = nextValue ?? [];
        setSearchKeyword("");
        setSearchValue(nextValue);
        onUpdateTreeView();
    }

    // Esc clears the typed text in the box; drop its filter too so the list matches what's shown
    const onKeyDown = (e: React.KeyboardEvent) => {
        if (e.key !== "Escape" || !searchKeyword) return;
        clearTimeout(typingTimer.current);
        setSearchKeyword("");
        TreeViewConverter.filterList = [...(searchValue ?? [])];
        onUpdateTreeView();
    }

    // Back in the box: the last word you typed comes back as text, selected (the list doesn't change)
    const onFocus = () => {
        if (searchKeyword) return;
        const chips = searchValue ?? [];
        for (let i = chips.length - 1; i >= 0; i--) {
            if (filterGroupOf(chips[i])) continue;
            const rest = chips.filter((_, j) => j !== i);
            setSearchValue(rest.length ? rest : undefined);
            setSearchKeyword(chips[i]);
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
        <span ref={rootRef} className="mod-search-box">
            <Select ref={selectRef}
                    size={"small"}
                    value={searchValue}
                    options={searchOptions}
                    onChange={onSearchSelectChange}
                    onFocus={onFocus}
                    onBlur={onBlur}
                    onKeyDown={onKeyDown}
                    open={open}
                    onOpenChange={onOpenChange}
                    className="w-300"
                    placeholder={t("modSearch.placeholder")}
                    suffixIcon={<SearchOutlined/>}
                    notFoundContent={null}
                    defaultActiveFirstOption={false}
                    // the typed text is kept here so Esc really empties the box (the Select's own copy
                    // stayed hidden and the next letters were added to it)
                    showSearch={{searchValue: searchKeyword, onSearch, filterOption: filterByText}}
                    allowClear={true}
                    mode={"multiple"}
                    maxTagCount="responsive"
                    listHeight={360}
                    popupMatchSelectWidth={320}
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
