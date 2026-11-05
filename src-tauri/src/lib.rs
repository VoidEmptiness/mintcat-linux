pub mod app;
pub mod backup;
pub mod clipboard_watch;
pub mod control_plane;
pub mod download;
pub mod frontend;
pub mod hot_update;
pub mod integrator;
pub mod network;
pub mod system_icon;
pub mod system_info;
pub mod webview_host;
pub mod secret_store;

pub fn run() {
    app::run()
}
