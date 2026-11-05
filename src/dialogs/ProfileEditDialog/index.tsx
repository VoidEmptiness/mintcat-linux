import React from "react";
import {t} from "i18next";
import {Button, Card, Flex, Input, List, message, Modal, Tag, Tooltip, Typography} from "antd";
import {CheckOutlined, CopyOutlined, DeleteOutlined, EditOutlined, PlusCircleOutlined, RollbackOutlined} from "@ant-design/icons";
import {ProfileViewModel} from "@/dialogs/ProfileEditDialog/ProfileViewModel.ts";
import { IoC } from "@/core/IoC.ts";
import {MessageBox} from "@/components/MessageBox";
import {confirmDelete, DeleteConfirm} from "@/services/DeleteConfirm";
import {ProfileBackups, type ProfileBackup} from "@/services/ProfileCleanup";

interface ProfileEditDialogStates {
    isModalOpen?: boolean;
    newProfileName?: string;
    editingKey?: string | null;
    editingValue?: string;
    profileList?: string[];
    backups?: ProfileBackup[];
    /** A backup is being restored or deleted (its buttons are off meanwhile) */
    backupBusy?: string;
    /** The profile in use */
    activeProfile?: string;
}

/** The copy's name, with what copying does */
function CopyNameForm({initial, onChange}: { initial: string; onChange: (value: string) => void }) {
    const [value, setValue] = React.useState(initial);
    return (
        <Flex vertical gap={8} style={{marginTop: 4}}>
            <Typography.Text>{t("profile.copyAsk")}</Typography.Text>
            <Input value={value} maxLength={20} autoFocus autoComplete="off"
                   addonBefore={t("profile.copyNameLabel")}
                   onChange={(e) => {
                       setValue(e.target.value);
                       onChange(e.target.value);
                   }}/>
        </Flex>
    );
}

type InputCallback = (name: string) => void;

class ProfileEditDialog extends React.Component<any, ProfileEditDialogStates> {

    private callback: InputCallback;

    public constructor(props: any) {
        super(props);

        this.state = {
            isModalOpen: false,
            newProfileName: "",
            editingKey: null,
            editingValue: ""
        }

        this.show = this.show.bind(this);
        this.handleOk = this.handleOk.bind(this);
        this.handleCancel = this.handleCancel.bind(this);
        this.handleAdd = this.handleAdd.bind(this);
        this.handleDelete = this.handleDelete.bind(this);
        this.handleRename = this.handleRename.bind(this);
        this.handleCopy = this.handleCopy.bind(this);
        this.handleProfileInputChange = this.handleProfileInputChange.bind(this);
    }

    public setCallback(callback: InputCallback) {
        this.callback = callback;
        return this;
    }

    public show() {
        this.setState({
            isModalOpen: true
        });
        void this.fetchData();
    }

    private async handleOk() {
        this.setState({isModalOpen: false});
        this.callback?.call(this);
    }

    private handleCancel() {
        this.setState({isModalOpen: false});
        this.callback?.call(this);
    }

    private async checkInput(name: string): Promise<boolean> {
        if (name === "") {
            message.error(t("profile.nameEmpty"));
            return false;
        }

        if (name.length > 20) {
            message.error(t("Profile Name Too Long"));
            return false;
        }
        return true;
    }


    private async handleAdd() {
        const name = (this.state.newProfileName ?? "").trim();
        if (!await this.checkInput(name)) {
            return false;
        }
        if (this.state.profileList?.includes(name)) {
            message.error(t("Profile Already Exists"));
            return false;
        }
        const ok = await MessageBox.confirm({
            title: t("profile.addTitle", {name}),
            content: t("profile.addAsk", {active: this.state.activeProfile ?? ""}),
            okText: t("profile.addOk"),
            cancelText: t("Cancel"),
        });
        if (!ok) return false;
        const vm = await IoC.get(ProfileViewModel);
        await vm.addProfile(name);

        await this.fetchData();
        this.setState({
            newProfileName: ""
        });
    }

    /** Asks first (unless "Ask before deleting" is off): delete it, or keep a backup and delete */
    private async handleDelete(key: string) {
        const vm = await IoC.get(ProfileViewModel);
        if ((this.state.profileList?.length ?? 0) <= 1) {
            message.error(t("profile.mustKeepAtLeastOne"));
            return;
        }
        let backup = false;
        if (await DeleteConfirm.enabled()) {
            const choice = await MessageBox.choose({
                title: t("profile.deleteTitle", {name: key}),
                content: t("profile.deleteAsk"),
                width: 540,
            }, [
                {key: "backup", label: t("profile.deleteWithBackup"), primary: true},
                {key: "delete", label: t("profile.deleteNoBackup"), danger: true, primary: true},
            ], t("Cancel"));
            if (!choice) return;
            backup = choice === "backup";
        }
        await vm.removeProfile(key, backup);
        await this.fetchData();
    }

    private async handleRestoreBackup(backup: ProfileBackup) {
        if (this.state.backupBusy) return;
        this.setState({backupBusy: backup.id});
        try {
            const result = await ProfileBackups.restore(backup.id);
            if (!result) {
                message.error(t("profile.restoreFailed"));
                return;
            }
            message.success(t("profile.restored", {name: result.name}));
            if (result.missing > 0) message.warning(t("profile.restoredMissing", {count: result.missing}));
        } catch (error) {
            console.error('[profiles] restore failed', error);
            message.error(t("profile.restoreFailed"));
        } finally {
            this.setState({backupBusy: undefined});
            await this.fetchData();
        }
    }

    private async handleDeleteBackup(backup: ProfileBackup) {
        if (this.state.backupBusy) return;
        const ok = await confirmDelete({
            title: t("profile.backupDeleteTitle"),
            content: t("profile.backupDeleteAsk", {name: backup.name}),
        });
        if (!ok) return;
        this.setState({backupBusy: backup.id});
        try {
            await ProfileBackups.remove(backup.id);
        } finally {
            this.setState({backupBusy: undefined});
            await this.fetchData();
        }
    }

    private async handleRename(key: string, newName: string) {
        newName = newName.trim();
        if (newName === key) {
            // nothing changed
            this.setState({editingKey: null, editingValue: ""});
            return false;
        }
        if (!await this.checkInput(newName)) {
            return false;
        }
        if (this.state.profileList?.includes(newName)) {
            message.error(t("Profile Already Exists"));
            return false;
        }
        const ok = await MessageBox.confirm({
            title: t("profile.renameTitle", {from: key, to: newName}),
            content: t("profile.renameAsk"),
            okText: t("profile.renameOk"),
            cancelText: t("Cancel"),
        });
        if (!ok) return false;

        const vm = await IoC.get(ProfileViewModel);
        await vm.renameProfile(key, newName);
        await this.fetchData();
        this.setState({
            editingKey: null,
            editingValue: ""
        });
    }

    /** A free name for a copy: "default copy", "default copy 2"… (within the 20 characters) */
    private copyName(key: string): string {
        const taken = new Set(this.state.profileList ?? []);
        for (let n = 1; n < 100; n++) {
            const suffix = n === 1 ? " copy" : ` copy ${n}`;
            const name = key.slice(0, Math.max(1, 20 - suffix.length)) + suffix;
            if (!taken.has(name)) return name;
        }
        return key.slice(0, 14) + "_" + Date.now().toString(36).slice(-5);
    }

    private async handleCopy(key: string) {
        let name = this.copyName(key);
        const ok = await MessageBox.confirm({
            title: t("profile.copyTitle", {name: key}),
            content: <CopyNameForm initial={name} onChange={(value) => (name = value)}/>,
            okText: t("profile.copyOk"),
            cancelText: t("Cancel"),
            width: 520,
        });
        if (!ok) return;
        name = name.trim();
        if (!await this.checkInput(name)) return;
        if (this.state.profileList?.includes(name)) {
            message.error(t("Profile Already Exists"));
            return;
        }
        const vm = await IoC.get(ProfileViewModel);
        await vm.copyProfile(key, name);
        await this.fetchData();
        this.setState({
            newProfileName: ""
        });
    }

    private handleProfileInputChange(e: React.ChangeEvent<HTMLInputElement>) {
        this.setState({newProfileName: e.target.value})
    }

    private async fetchData() {
        const vm = await IoC.get(ProfileViewModel);
        const profileList = await vm.getProfileList();
        const backups = await ProfileBackups.listForActiveGame();
        const activeProfile = await vm.getActiveProfileName().catch(() => undefined);
        this.setState({
            profileList: profileList,
            backups,
            activeProfile,
        })
    }

    componentDidMount() {
        this.fetchData().then();
    }

    render() {
        return (
            <Modal title={t("Edit Profile")}
                   open={this.state.isModalOpen}
                   onOk={this.handleOk}
                   onCancel={this.handleCancel}
                   styles={{
                       header: {
                           borderBottom: "none",
                           marginBottom: 0
                       },
                       footer: {
                           borderTop: "none",
                           marginTop: 0
                       }
                   }}
            >
                <Card size={"small"}>
                    <List size="small"
                          dataSource={this.state.profileList}
                          header={
                              <Flex>
                                  <Input size="small"
                                         type={"text"}
                                         value={this.state.newProfileName}
                                         placeholder={t("Input New Profile")}
                                         onChange={this.handleProfileInputChange}
                                         onPressEnter={this.handleAdd}
                                         autoComplete={"off"}
                                  />
                                  <Tooltip title={t("profile.addTip")}>
                                      <Button type={"text"}
                                              className="ml-8 mr-20"
                                              onClick={this.handleAdd}
                                              aria-label={t("profile.addTip")}
                                              icon={<PlusCircleOutlined/>}
                                      />
                                  </Tooltip>
                              </Flex>
                          }
                          renderItem={
                              item =>
                                  <List.Item>
                                      <Flex className="full-width-block">
                                            <span className="lh-32">
                                                {this.state.editingKey === item ? (
                                                    <Input
                                                        size="small"
                                                        value={this.state.editingValue}
                                                        onChange={(e) => this.setState({editingValue: e.target.value})}
                                                        onPressEnter={() => this.handleRename(item, this.state.editingValue)}
                                                        className="w-200"
                                                        autoFocus
                                                        autoComplete={"off"}
                                                    />
                                                ) : (
                                                    <span>
                                                        {item}
                                                        {item === this.state.activeProfile && (
                                                            <Tooltip title={t("profile.inUseTip")}>
                                                                <Tag color="processing" style={{marginInlineStart: 8}}>{t("profile.inUse")}</Tag>
                                                            </Tooltip>
                                                        )}
                                                    </span>
                                                )}
                                            </span>
                                          <Tooltip title={(this.state.profileList?.length ?? 0) <= 1 ? t("profile.mustKeepAtLeastOne") : t("profile.deleteTip")}>
                                              <Button type={"text"}
                                                      className="float-right"
                                                      onClick={() => this.handleDelete(item)}
                                                      aria-label={t("profile.deleteTip")}
                                                      icon={<DeleteOutlined/>}
                                              />
                                          </Tooltip>
                                          <Tooltip title={t("profile.copyTip")}>
                                              <Button type={"text"}
                                                      className="float-right"
                                                      onClick={() => this.handleCopy(item)}
                                                      aria-label={t("profile.copyTip")}
                                                      icon={<CopyOutlined/>}
                                              />
                                          </Tooltip>
                                          <Tooltip title={this.state.editingKey === item ? t("profile.renameSaveTip") : t("profile.renameTip")}>
                                          <Button
                                              type={"text"}
                                              aria-label={t("profile.renameTip")}
                                              className="float-right"
                                              onClick={async () => {
                                                  if (this.state.editingKey === item) {
                                                      await this.handleRename(item, this.state.editingValue);
                                                  } else {
                                                      this.setState({
                                                          editingKey: item,
                                                          editingValue: item
                                                      });
                                                  }
                                              }}
                                              icon={this.state.editingKey === item ? <CheckOutlined/> : <EditOutlined/>}
                                          />
                                          </Tooltip>
                                      </Flex>
                                  </List.Item>
                          }
                    />
                </Card>
                {(this.state.backups?.length ?? 0) > 0 &&
                    <Card size={"small"} style={{marginTop: 8}}
                          title={<Tooltip title={t("profile.backupsHelp")}>{t("profile.backupsTitle")}</Tooltip>}>
                        <List size="small"
                              dataSource={this.state.backups}
                              renderItem={backup => (
                                  <List.Item actions={[
                                      <Tooltip key="restore" title={t("profile.restoreBackup")}>
                                          <Button type="text" size="small" icon={<RollbackOutlined/>}
                                                  disabled={!!this.state.backupBusy}
                                                  loading={this.state.backupBusy === backup.id}
                                                  onClick={() => void this.handleRestoreBackup(backup)}/>
                                      </Tooltip>,
                                      <Tooltip key="delete" title={t("Delete")}>
                                          <Button type="text" size="small" danger icon={<DeleteOutlined/>}
                                                  disabled={!!this.state.backupBusy}
                                                  onClick={() => void this.handleDeleteBackup(backup)}/>
                                      </Tooltip>,
                                  ]}>
                                      <Flex vertical>
                                          <span>{backup.name}</span>
                                          <Typography.Text type="secondary" style={{fontSize: 12}}>
                                              {t("profile.backupInfo", {count: backup.mods.length, when: new Date(backup.time).toLocaleString()})}
                                          </Typography.Text>
                                      </Flex>
                                  </List.Item>
                              )}/>
                    </Card>}
            </Modal>
        );
    }
}


export default ProfileEditDialog;
