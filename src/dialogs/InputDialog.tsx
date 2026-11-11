import React from 'react';
import {Form, Input, Modal, type InputRef} from 'antd';
import {t} from "i18next";

interface InputDialogStates {
    isModalOpen?: boolean;
    title?: string;
    defaultValue?: any;
}

type InputCallback = (name: string) => void;


export class InputDialog extends React.Component<any, InputDialogStates> {

    private readonly localFormRef: any = React.createRef();
    private readonly inputRef = React.createRef<InputRef>();

    private callback: InputCallback;

    public constructor(props: any) {
        super(props);

        this.state = {
            isModalOpen: false
        }

        this.show = this.show.bind(this);
        this.handleOk = this.handleOk.bind(this);
        this.handleCancel = this.handleCancel.bind(this);
        this.setCallback = this.setCallback.bind(this);
    }

    public show() {
        this.setState({
            isModalOpen: true
        });
    }

    public setCallback(title: string, defaultValue: string, callback: InputCallback) {
        this.callback = callback;
        this.localFormRef.current?.setFieldsValue({
            text: defaultValue
        })
        this.setState({
            title,
            defaultValue
        })
        return this;
    }

    private async handleOk() {
        // an empty or blank name is not accepted (the field shows why)
        let values: { text?: string };
        try {
            values = await this.localFormRef.current.validateFields();
        } catch {
            return;
        }
        const text = String(values.text ?? "").trim();
        if (!text) return;
        this.callback?.call(this, text);
        this.setState({isModalOpen: false});
    }

    private handleCancel() {
        this.setState({isModalOpen: false});
    }

    render() {
        return (
            <Modal title={this.state.title}
                   open={this.state.isModalOpen}
                   onOk={this.handleOk}
                   onCancel={this.handleCancel}
                   afterOpenChange={(open) => {
                       if (open) this.inputRef.current?.focus({cursor: "all"});
                   }}
            >
                <Form ref={this.localFormRef} layout="vertical"
                      initialValues={{
                          text: this.state.defaultValue,
                      }}>
                    <Form.Item name="text" label={t("Please Input Name")}
                               rules={[{required: true, whitespace: true, message: t("Please Input Name")}]}>
                        <Input autoComplete={"off"}
                               ref={this.inputRef}
                               onPressEnter={this.handleOk}
                               allowClear/>
                    </Form.Item>
                </Form>
            </Modal>
        );
    }
}

