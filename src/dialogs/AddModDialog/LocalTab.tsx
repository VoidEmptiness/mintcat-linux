import {open} from "@tauri-apps/plugin-dialog";
import {exists, stat} from "@tauri-apps/plugin-fs";
import {path} from "@tauri-apps/api";
import {useEventListener} from "@/events";
import {getCurrentWindow} from "@tauri-apps/api/window";
import React, {useEffect, useState} from "react";
import {Button, Flex, Form, Input, List, message, Tag, Tooltip} from "antd";
import {t} from "i18next";
import {CloseOutlined, FilePptOutlined, FileZipOutlined, FolderOutlined, FolderOpenOutlined, InboxOutlined} from "@ant-design/icons";
import {BackendRuntimeApi} from "@/apis/BackendRuntimeApi";
import {isModArchivePath, parseLocalPathLine, splitLines} from "@/utils/LocalModPaths";
import {logActivity} from "@/services/ActivityLog";
import {itemKey, type ItemFolders} from "@/dialogs/AddModDialog/ItemFolders";
import {ItemFolderSelect} from "@/dialogs/AddModDialog/ItemFolderSelect";


interface FileItem {
    name: string;
    path: string;
    type: string;  // "folder" | ".pak" | ".zip"
    isUnpackedMod?: boolean;  // true if folder is a valid unpacked mod directory
    missing?: boolean;  // nothing exists at this path (copied/pasted path to a moved or deleted file)
}

/**
 * Check if a directory is a valid unpacked mod directory
 * A valid unpacked mod directory contains a Content folder with uasset/uexp files
 */
async function isValidUnpackedMod(dirPath: string): Promise<boolean> {
    try {
        return await BackendRuntimeApi.invoke<boolean>('is_valid_unpacked_mod', { path: dirPath });
    } catch (e) {
        console.error('Failed to check unpacked mod:', e);
        return false;
    }
}

async function makeFileItem(filePath: string): Promise<FileItem> {
    const fileInfo = await stat(filePath);
    const fileName = await path.basename(filePath);

    if (fileInfo.isDirectory) {
        // Check if it's a valid unpacked mod directory
        const isUnpacked = await isValidUnpackedMod(filePath);
        return {
            path: filePath,
            name: fileName,
            type: "folder",
            isUnpackedMod: isUnpacked
        };
    }

    return {
        path: filePath,
        name: fileName,
        type: await path.extname(filePath)
    };
}

export const LocalTab = React.forwardRef(({paths, revision, folders}: {
    paths?: string[];
    revision?: number;
    folders?: ItemFolders;
}, ref) => {

    const [fileList, setFileList] = useState<FileItem[]>([]);
    const [pasteText, setPasteText] = useState<string>("");

    // tell the dialog which mods are listed (for "N mod(s) go to another folder")
    const report = folders?.report;
    const listedKeys = fileList.map(f => itemKey.local(f.path));
    useEffect(() => {
        report?.("local", listedKeys);
    }, [listedKeys.join("\n"), report]);

    React.useImperativeHandle(ref, () => ({
        submit: () => {
            return fileList.map(file => file.path);
        }
    }));


    /**
     * Add a path to the list.
     * With allowMissing, a .pak/.zip path with nothing at it is still listed (marked "Not found")
     * so you can see it; adding it later logs it as an error.
     */
    const addFileList = async (filePath: string, allowMissing = false): Promise<'added' | 'missing' | 'rejected'> => {
        let present = false;
        try {
            present = await exists(filePath);
        } catch {
            present = false;
        }

        if (!present) {
            if (!allowMissing || !isModArchivePath(filePath)) {
                return 'rejected';
            }
            const name = filePath.split(/[\\/]/).pop() || filePath;
            const ext = (name.match(/\.(pak|zip)$/i)?.[0] || ".pak").toLowerCase();
            setFileList(prevList => prevList.find(file => file.path === filePath)
                ? prevList
                : [...prevList, {path: filePath, name, type: ext, missing: true}]);
            return 'missing';
        }

        const fileInfo = await stat(filePath);
        const fileItem = await makeFileItem(filePath);

        // Accept: .pak files, .zip files, or valid unpacked mod directories
        if (fileInfo.isDirectory) {
            // For directories, only accept if it's a valid unpacked mod
            if (!fileItem.isUnpackedMod) {
                return 'rejected';
            }
        } else {
            // For files, only accept .pak or .zip
            if (!/\.(zip|pak)$/i.test(filePath)) {
                return 'rejected';
            }
        }

        setFileList(prevList => {
            if (prevList.find(file => file.path === filePath)) {
                return prevList;
            }
            return [...prevList, fileItem];
        });
        return 'added';
    }

    /** Add every path in pasted text (plain paths, quoted paths or file:// URIs) */
    const addPastedText = async (text: string) => {
        let homeDir: string | undefined;
        try {
            homeDir = await path.homeDir();
        } catch {
            homeDir = undefined;
        }
        let skipped = 0;
        let missing = 0;
        for (const line of splitLines(text)) {
            const localPath = parseLocalPathLine(line, homeDir);
            const result = localPath ? await addFileList(localPath, true) : 'rejected';
            if (result === 'missing') {
                missing++;
            } else if (result === 'rejected') {
                skipped++;
                await logActivity('warning', t("localMods.lineSkipped"), line, 'add-mod');
            }
        }
        if (missing > 0) {
            message.warning(t("localMods.someMissing", {count: missing}));
        }
        if (skipped > 0) {
            message.warning(t("localMods.someNotAdded", {count: skipped}));
        }
    }

    const onPaste = async (e: React.ClipboardEvent<HTMLInputElement>) => {
        // Files copied in a file manager arrive as text/uri-list; plain text otherwise
        const text = e.clipboardData.getData("text/uri-list") || e.clipboardData.getData("text/plain");
        if (!text) {
            return;
        }
        e.preventDefault();
        setPasteText("");
        await addPastedText(text);
    }

    const onPasteEnter = async () => {
        const text = pasteText;
        setPasteText("");
        if (text.trim()) {
            await addPastedText(text);
        }
    }

    // Paths sent by the clipboard watcher (merged into the list, never replacing it)
    useEffect(() => {
        if (!paths || paths.length === 0) {
            return;
        }
        (async () => {
            let missing = 0;
            for (const p of paths) {
                if (await addFileList(p, true) === 'missing') missing++;
            }
            if (missing > 0) {
                message.warning(t("localMods.someMissing", {count: missing}));
            }
        })();
    }, [paths, revision]);

    const onSelectPathClick = async () => {
        const results = await open({
            directory: true,
            multiple: true,
        });

        if (results) {
            for (let result of results) {
                await addFileList(result);
            }
        }
    }

    const onSelectFileClick = async () => {
        const results = await open({
            filters: [{
                name: '*',
                extensions: ['pak', 'zip'],
            }],
            multiple: true,
        });

        if (results) {
            for (let result of results) {
                await addFileList(result);
            }
        }
    }

    const registerDragDropEvent = () => {
        getCurrentWindow().onDragDropEvent(
            async (event) => {
                if (event.payload.type === 'drop') {
                    for (let path of event.payload.paths) {
                        await addFileList(path);
                    }
                }
            }
        ).then();
    }

    // ✅ 使用 useEventListener 监听 Tauri 文件拖放事件
    useEventListener('tauri://file-drop', async (event) => {
        // EventRegistry 中的 payload 结构是 { paths, position }，没有 type 字段
        for (let path of event.paths) {
            await addFileList(path);
        }
    });

    const onDeleteClick = (item) => {
        setFileList(fileList.filter(file => file.path !== item.path));
    }

    useEffect(() => {
        registerDragDropEvent();
        return () => {
        }
    }, []);

    return (
        <Form layout="vertical">
            <Flex gap={"small"}>
                <div className={"ant-upload-drag"}
                     style={{flex: 1}}
                     onClick={onSelectPathClick}
                >
                    <p className="app-drag-icon">
                        <FolderOutlined/>
                    </p>
                    <p className="app-drag-hint">
                        {t("Select Folder")}
                    </p>
                </div>
                <div className={"ant-upload-drag"}
                     style={{flex: 1}}
                     onClick={onSelectFileClick}
                >
                    <p className="app-drag-icon">
                        <InboxOutlined/>
                    </p>
                    <p className="app-drag-hint">
                        {t("Select File")}
                    </p>
                </div>
            </Flex>
            <Input style={{marginTop: 8}}
                   value={pasteText}
                   allowClear
                   placeholder={t("localMods.pastePlaceholder")}
                   onChange={(e) => setPasteText(e.target.value)}
                   onPaste={onPaste}
                   onPressEnter={onPasteEnter}
            />
            <br/>
            <Form.Item label={`${t("Selected Files")} ${fileList.length}`}>
                <div className={"app-drag-list"}
                     style={{
                         height: window.innerHeight - 440,
                     }}>
                    <List size={"small"}
                          dataSource={fileList}
                          style={{
                              height: window.innerHeight - 440,
                          }}
                          renderItem={item => (
                              <List.Item className={"app-drag-list-item"}>
                                  <Flex justify={"space-between"}
                                        align={"center"}
                                        gap={"small"}
                                        style={{width: "100%"}}
                                  >
                                      <Flex gap={"small"} style={{minWidth: 0, flex: 1}}>
                                          {
                                              item.type === "folder" ? (
                                                  item.isUnpackedMod ? <FolderOpenOutlined style={{color: '#52c41a'}}/> : <FolderOutlined/>
                                              ) :
                                              item.type === ".pak" ? <FilePptOutlined/> : <FileZipOutlined/>
                                          }
                                          <span title={item.missing ? undefined : item.path}
                                                style={{
                                                    minWidth: 0, overflow: "hidden", textOverflow: "ellipsis", whiteSpace: "nowrap",
                                                    ...(item.missing ? {color: '#ff4d4f'} : {}),
                                                }}>
                                              {item.name}
                                              {item.isUnpackedMod && <span style={{color: '#52c41a', marginLeft: 8, fontSize: 12}}>(Unpacked)</span>}
                                              {item.missing &&
                                                  <Tooltip title={<span>{t("localMods.notFoundHint")}<br/>
                                                      <span style={{fontFamily: "monospace", fontSize: 12, wordBreak: "break-all"}}>{item.path}</span></span>}>
                                                      <Tag color="red" style={{marginLeft: 8}}>{t("localMods.notFound")}</Tag>
                                                  </Tooltip>}
                                          </span>
                                      </Flex>
                                      <ItemFolderSelect folders={folders} itemKey={itemKey.local(item.path)}/>
                                      <Button variant={"text"}
                                              size={"small"}
                                              color={"red"}
                                              icon={<CloseOutlined/>}
                                              onClick={() => onDeleteClick(item)}
                                      />
                                  </Flex>
                              </List.Item>
                          )}
                    />
                </div>
            </Form.Item>
        </Form>
    )

});

