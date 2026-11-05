//! API keys and login tokens in the system keyring (the Secret Service: KWallet on KDE,
//! GNOME Keyring, KeePassXC, ...), so they aren't kept as plain text in MINTCAT's database.
//! The keyring keeps them encrypted on disk and unlocks with your login.
//!
//! Entries carry the attributes `application = com.mint.cat` and `account = <uid>:<platform>`.
//! When no keyring answers, the frontend keeps the key in the database as before.

#[cfg(target_os = "linux")]
mod linux {
    use anyhow::{anyhow, bail, Context, Result};
    use std::collections::HashMap;
    use std::sync::{mpsc, Mutex, OnceLock};
    use std::time::Duration;
    use zbus::blocking::{connection, Connection, Proxy};
    use zbus::zvariant::{OwnedObjectPath, OwnedValue, Value};

    const BUS: &str = "org.freedesktop.secrets";
    const SERVICE_PATH: &str = "/org/freedesktop/secrets";
    const SERVICE: &str = "org.freedesktop.Secret.Service";
    const COLLECTION: &str = "org.freedesktop.Secret.Collection";
    const ITEM: &str = "org.freedesktop.Secret.Item";
    const PROMPT: &str = "org.freedesktop.Secret.Prompt";
    const APPLICATION: &str = "com.mint.cat";
    const CALL_TIMEOUT: Duration = Duration::from_secs(10);
    /// How long the keyring's own unlock dialog may take
    const PROMPT_TIMEOUT: Duration = Duration::from_secs(120);

    /// (session, parameters, value, content type)
    type Secret = (OwnedObjectPath, Vec<u8>, Vec<u8>, String);

    struct Keyring {
        conn: Connection,
        session: OwnedObjectPath,
    }

    fn attributes(account: &str) -> HashMap<&str, &str> {
        HashMap::from([("application", APPLICATION), ("account", account)])
    }

    impl Keyring {
        fn open() -> Result<Self> {
            let conn = connection::Builder::session()?
                .method_timeout(CALL_TIMEOUT)
                .build()
                .context("no session bus")?;
            let service = Proxy::new(&conn, BUS, SERVICE_PATH, SERVICE)?;
            // "plain": the secret travels over the local session bus only (the bus is per user)
            let (_, session): (OwnedValue, OwnedObjectPath) = service
                .call("OpenSession", &("plain", Value::from("")))
                .context("no keyring service answered")?;
            Ok(Self { conn, session })
        }

        fn service(&self) -> Result<Proxy<'_>> {
            Ok(Proxy::new(&self.conn, BUS, SERVICE_PATH, SERVICE)?)
        }

        fn proxy<'p>(&'p self, path: &'p OwnedObjectPath, interface: &'static str) -> Result<Proxy<'p>> {
            Ok(Proxy::new(&self.conn, BUS, path.as_str(), interface)?)
        }

        fn search(&self, account: &str) -> Result<(Vec<OwnedObjectPath>, Vec<OwnedObjectPath>)> {
            Ok(self.service()?.call("SearchItems", &(attributes(account),))?)
        }

        /// Run a prompt the keyring asked for (e.g. its unlock dialog); "/" means none needed
        fn prompt(&self, prompt: &OwnedObjectPath) -> Result<Option<OwnedValue>> {
            if prompt.as_str() == "/" {
                return Ok(None);
            }
            let proxy = self.proxy(prompt, PROMPT)?;
            let mut signals = proxy.receive_signal("Completed")?;
            proxy.call::<_, _, ()>("Prompt", &("",))?;
            let (tx, rx) = mpsc::channel();
            std::thread::spawn(move || {
                let _ = tx.send(signals.next());
            });
            match rx.recv_timeout(PROMPT_TIMEOUT) {
                Ok(Some(message)) => {
                    let (dismissed, result): (bool, OwnedValue) = message.body().deserialize()?;
                    if dismissed {
                        bail!("the keyring dialog was closed");
                    }
                    Ok(Some(result))
                }
                Ok(None) => bail!("the keyring dialog ended without an answer"),
                Err(_) => {
                    let _ = proxy.call::<_, _, ()>("Dismiss", &());
                    bail!("the keyring dialog timed out")
                }
            }
        }

        fn unlock(&self, objects: &[OwnedObjectPath]) -> Result<()> {
            if objects.is_empty() {
                return Ok(());
            }
            let (_, prompt): (Vec<OwnedObjectPath>, OwnedObjectPath) =
                self.service()?.call("Unlock", &(objects,))?;
            self.prompt(&prompt)?;
            Ok(())
        }

        /// The collection new entries go to: the "default" alias (KWallet's kdewallet, GNOME's
        /// login keyring), else the first one there is, else one the keyring creates (it asks)
        fn default_collection(&self) -> Result<OwnedObjectPath> {
            let service = self.service()?;
            let alias: OwnedObjectPath = service.call("ReadAlias", &("default",))?;
            if alias.as_str() != "/" {
                return Ok(alias);
            }
            if let Ok(collections) = service.get_property::<Vec<OwnedObjectPath>>("Collections") {
                let login = collections
                    .iter()
                    .find(|c| c.as_str().ends_with("/collection/login"))
                    .or_else(|| collections.iter().find(|c| !c.as_str().ends_with("/collection/session")));
                if let Some(collection) = login {
                    return Ok(collection.clone());
                }
            }
            let properties = HashMap::from([(
                "org.freedesktop.Secret.Collection.Label",
                Value::from("Default keyring"),
            )]);
            let (collection, prompt): (OwnedObjectPath, OwnedObjectPath) =
                service.call("CreateCollection", &(properties, "default"))?;
            if collection.as_str() != "/" {
                return Ok(collection);
            }
            let created = self
                .prompt(&prompt)?
                .ok_or_else(|| anyhow!("the keyring did not create a collection"))?;
            OwnedObjectPath::try_from(created).map_err(|e| anyhow!("unexpected keyring answer: {e}"))
        }

        fn get(&self, account: &str) -> Result<Option<String>> {
            let (unlocked, locked) = self.search(account)?;
            let item = match unlocked.first() {
                Some(item) => item.clone(),
                None => match locked.first() {
                    Some(item) => {
                        self.unlock(&locked)?;
                        item.clone()
                    }
                    None => return Ok(None),
                },
            };
            let secret: Secret = self.proxy(&item, ITEM)?.call("GetSecret", &(&self.session,))?;
            Ok(Some(String::from_utf8(secret.2).context("the stored key isn't text")?))
        }

        fn set(&self, account: &str, label: &str, value: &str) -> Result<()> {
            let collection = self.default_collection()?;
            let proxy = self.proxy(&collection, COLLECTION)?;
            if proxy.get_property::<bool>("Locked").unwrap_or(false) {
                self.unlock(std::slice::from_ref(&collection))?;
            }
            let properties = HashMap::from([
                ("org.freedesktop.Secret.Item.Label", Value::from(label)),
                ("org.freedesktop.Secret.Item.Attributes", Value::from(attributes(account))),
            ]);
            let secret: Secret = (
                self.session.clone(),
                Vec::new(),
                value.as_bytes().to_vec(),
                "text/plain".to_string(),
            );
            let (_, prompt): (OwnedObjectPath, OwnedObjectPath) =
                proxy.call("CreateItem", &(properties, &secret, true))?;
            self.prompt(&prompt)?;
            // Read it back: some keyrings accept an item they then don't keep
            match self.get(account)? {
                Some(stored) if stored == value => Ok(()),
                _ => bail!("the keyring did not keep the key"),
            }
        }

        fn delete(&self, account: &str) -> Result<()> {
            let (unlocked, locked) = self.search(account)?;
            self.unlock(&locked)?;
            for item in unlocked.iter().chain(locked.iter()) {
                let prompt: OwnedObjectPath = self.proxy(item, ITEM)?.call("Delete", &())?;
                self.prompt(&prompt)?;
            }
            Ok(())
        }
    }

    /// One connection for all calls; opened again after an error (e.g. the keyring restarted)
    fn with_keyring<T>(f: impl Fn(&Keyring) -> Result<T>) -> Result<T> {
        static KEYRING: OnceLock<Mutex<Option<Keyring>>> = OnceLock::new();
        let lock = KEYRING.get_or_init(|| Mutex::new(None));
        let mut guard = lock.lock().unwrap_or_else(|poisoned| poisoned.into_inner());
        for attempt in 0..2 {
            if guard.is_none() {
                *guard = Some(Keyring::open()?);
            }
            match f(guard.as_ref().expect("opened above")) {
                Ok(value) => return Ok(value),
                Err(error) if attempt == 0 && is_connection_error(&error) => {
                    *guard = None;
                }
                Err(error) => return Err(error),
            }
        }
        unreachable!("the second attempt returns")
    }

    fn is_connection_error(error: &anyhow::Error) -> bool {
        error.chain().any(|cause| {
            matches!(
                cause.downcast_ref::<zbus::Error>(),
                Some(zbus::Error::InputOutput(_))
                    | Some(zbus::Error::MethodError(..))
                    | Some(zbus::Error::FDO(_))
            )
        })
    }

    pub fn get(account: &str) -> Result<Option<String>> {
        with_keyring(|k| k.get(account))
    }

    pub fn set(account: &str, label: &str, value: &str) -> Result<()> {
        with_keyring(|k| k.set(account, label, value))
    }

    pub fn delete(account: &str) -> Result<()> {
        with_keyring(|k| k.delete(account))
    }

    /// Whether a keyring answers (without creating anything or asking to unlock)
    pub fn available() -> bool {
        with_keyring(|k| {
            k.service()?.call::<_, _, OwnedObjectPath>("ReadAlias", &("default",))?;
            Ok(())
        })
        .is_ok()
    }
}

fn check_account(account: &str) -> Result<(), String> {
    let ok = !account.is_empty()
        && account.len() <= 128
        && account
            .chars()
            .all(|c| c.is_ascii_alphanumeric() || matches!(c, ':' | '.' | '-' | '_'));
    if ok {
        Ok(())
    } else {
        Err("invalid keyring account name".to_string())
    }
}

async fn blocking<T: Send + 'static>(
    f: impl FnOnce() -> anyhow::Result<T> + Send + 'static,
) -> Result<T, String> {
    tauri::async_runtime::spawn_blocking(f)
        .await
        .map_err(|e| e.to_string())?
        .map_err(|e| format!("{e:#}"))
}

#[tauri::command]
pub async fn secret_store_get(account: String) -> Result<Option<String>, String> {
    check_account(&account)?;
    #[cfg(target_os = "linux")]
    return blocking(move || linux::get(&account)).await;
    #[cfg(not(target_os = "linux"))]
    return Err("no keyring support on this system".to_string());
}

#[tauri::command]
pub async fn secret_store_set(account: String, label: String, secret: String) -> Result<(), String> {
    check_account(&account)?;
    #[cfg(target_os = "linux")]
    return blocking(move || linux::set(&account, &label, &secret)).await;
    #[cfg(not(target_os = "linux"))]
    {
        let _ = (label, secret);
        return Err("no keyring support on this system".to_string());
    }
}

#[tauri::command]
pub async fn secret_store_delete(account: String) -> Result<(), String> {
    check_account(&account)?;
    #[cfg(target_os = "linux")]
    return blocking(move || linux::delete(&account)).await;
    #[cfg(not(target_os = "linux"))]
    return Err("no keyring support on this system".to_string());
}

#[tauri::command]
pub async fn secret_store_available() -> Result<bool, String> {
    #[cfg(target_os = "linux")]
    return blocking(|| Ok(linux::available())).await;
    #[cfg(not(target_os = "linux"))]
    return Ok(false);
}

/// Only your account may open MINTCAT's own folders (they hold its database, the web views'
/// cookies and logs). Folders owned by someone else are left alone.
pub fn restrict_app_folders(app: &tauri::AppHandle) {
    #[cfg(unix)]
    {
        use std::os::unix::fs::{MetadataExt, PermissionsExt};
        use tauri::Manager;
        let path = app.path();
        let folders = [
            path.app_config_dir(),
            path.app_data_dir(),
            path.app_local_data_dir(),
            path.app_cache_dir(),
            path.app_log_dir(),
        ];
        let me = std::fs::metadata(std::env::var_os("HOME").unwrap_or_default())
            .map(|m| m.uid())
            .ok();
        let mut seen = std::collections::HashSet::new();
        for folder in folders.into_iter().flatten() {
            if !seen.insert(folder.clone()) {
                continue;
            }
            let Ok(meta) = std::fs::symlink_metadata(&folder) else { continue };
            if !meta.is_dir() || Some(meta.uid()) != me {
                continue;
            }
            let mode = meta.permissions().mode() & 0o777;
            if mode & 0o077 != 0 {
                match std::fs::set_permissions(&folder, std::fs::Permissions::from_mode(0o700)) {
                    Ok(()) => log::info!("[Security] {} is now private (was {:o})", folder.display(), mode),
                    Err(e) => log::warn!("[Security] could not make {} private: {}", folder.display(), e),
                }
            }
        }
    }
    #[cfg(not(unix))]
    let _ = app;
}

#[cfg(test)]
mod tests {
    use super::check_account;

    /// Run with a keyring: `dbus-run-session -- sh -c 'echo -n pw | gnome-keyring-daemon --unlock
    /// --components=secrets; cargo test secret_store -- --ignored'`
    #[cfg(target_os = "linux")]
    #[test]
    #[ignore = "needs a running keyring (Secret Service)"]
    fn keyring_round_trip() {
        use super::linux;
        let account = "0:mintcat-test";
        assert!(linux::available());
        linux::set(account, "MINTCAT test", "secret-value-123").unwrap();
        assert_eq!(linux::get(account).unwrap().as_deref(), Some("secret-value-123"));
        linux::set(account, "MINTCAT test", "changed").unwrap();
        assert_eq!(linux::get(account).unwrap().as_deref(), Some("changed"));
        assert_eq!(linux::get("0:mintcat-other").unwrap(), None);
        linux::delete(account).unwrap();
        assert_eq!(linux::get(account).unwrap(), None);
    }

    #[test]
    fn account_names() {
        assert!(check_account("1:nexusmods").is_ok());
        assert!(check_account("12:mod.io").is_ok());
        assert!(check_account("").is_err());
        assert!(check_account("1:nexus mods").is_err());
        assert!(check_account("a/b").is_err());
    }
}
