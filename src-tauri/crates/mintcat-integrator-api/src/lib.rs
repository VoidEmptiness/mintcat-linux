use serde::{Deserialize, Serialize};
use serde_json::Value;
use std::path::PathBuf;

#[derive(Debug, PartialEq, Serialize, Deserialize)]
pub struct ModInfo {
    pub modio_id: Option<u32>,
    pub name: String,
    pub pak_path: String,
    #[serde(default)]
    pub is_unpacked: bool,
    #[serde(default)]
    pub is_audio_only: bool,
}

#[derive(Debug, Clone, Copy, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "snake_case")]
pub enum GameKind {
    Drg,
    RogueCore,
}

impl GameKind {
    pub fn from_game_pak_path(game_path: &str) -> Self {
        if game_path.ends_with("RogueCore-Windows.pak") {
            Self::RogueCore
        } else {
            Self::Drg
        }
    }
}

#[derive(Debug, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct InstallRequest {
    pub game_path: String,
    pub game_kind: GameKind,
    pub mods: Vec<ModInfo>,
    #[serde(default)]
    pub skip_ue4ss: bool,
    #[serde(default)]
    pub ue4ss_zip_path: Option<PathBuf>,
    #[serde(default)]
    pub drg_zip_path: Option<PathBuf>,
    #[serde(default)]
    pub rc_zip_path: Option<PathBuf>,
    #[serde(default)]
    pub compress_mod_pak: bool,
}

impl InstallRequest {
    pub fn new(
        game_path: String,
        mods: Vec<ModInfo>,
        skip_ue4ss: bool,
        ue4ss_zip_path: Option<String>,
        drg_zip_path: Option<String>,
        rc_zip_path: Option<String>,
        compress_mod_pak: bool,
    ) -> Self {
        let game_kind = GameKind::from_game_pak_path(&game_path);
        Self {
            game_path,
            game_kind,
            mods,
            skip_ue4ss,
            ue4ss_zip_path: ue4ss_zip_path.map(PathBuf::from),
            drg_zip_path: drg_zip_path.map(PathBuf::from),
            rc_zip_path: rc_zip_path.map(PathBuf::from),
            compress_mod_pak,
        }
    }
}

#[derive(Debug, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct InstallResult {
    pub mod_pak_timestamp: u64,
}

#[derive(Debug, Clone, Serialize, Deserialize)]
#[serde(tag = "type", content = "payload", rename_all = "snake_case")]
pub enum InstallEvent {
    StatusLog(Value),
    Percent(f32),
    Success(u64),
    Error(Value),
}

pub trait InstallProgress: Send + Sync {
    fn emit(&self, event: InstallEvent) -> anyhow::Result<()>;
}

pub fn text(value: impl Into<String>) -> Value {
    Value::String(value.into())
}

pub fn json_value(value: impl Serialize) -> Value {
    serde_json::to_value(value).unwrap_or_else(|_| Value::Null)
}

#[derive(Debug, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct UninstallModsRequest {
    pub game_path: String,
    pub is_delete_ue4ss: bool,
}

#[derive(Debug, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct CheckInstalledRequest {
    pub game_path: String,
    pub install_time: u64,
}

#[derive(Debug, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct FindGamePakRequest {
    pub game_name: Option<String>,
}

#[derive(Debug, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct CheckForeignPaksRequest {
    pub game_path: String,
}

#[derive(Debug, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct PathRequest {
    pub path: String,
}

#[derive(Debug, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct CheckModConflictsRequest {
    pub mod_list_json: String,
    pub game_name: Option<String>,
    /// The game's own pak, to tell files that replace game files from files mods add
    #[serde(default)]
    pub game_pak_path: Option<String>,
}

/// Compare one shared asset across mods (and the game's original) part by part
#[derive(Debug, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct ConflictAssetDiffRequest {
    pub game_name: Option<String>,
    #[serde(default)]
    pub game_pak_path: Option<String>,
    /// Normalized path without extension, e.g. "fsd/content/weaponsntools/revolver/wpn_revolver"
    pub asset_path: String,
    pub mods: Vec<ConflictCheckModInfo>,
}

/// One version's value of a part (property, function, ...); same `hash` = same content
#[derive(Debug, Clone, Serialize, Deserialize, PartialEq)]
#[serde(rename_all = "camelCase")]
pub struct AssetPartValue {
    pub hash: String,
    /// Short readable value for simple properties (numbers, names, booleans...)
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub value: Option<String>,
}

/// A part that isn't the same in every version
#[derive(Debug, Clone, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct AssetDiffRow {
    pub key: String,
    /// property, component, function, event, variable, class, row, export, data
    pub kind: String,
    /// The object the part belongs to (class defaults, a component, the class itself...)
    pub owner: String,
    pub name: String,
    /// The game's version; None = the game doesn't have this part (or the original wasn't read)
    #[serde(default)]
    pub game: Option<AssetPartValue>,
    /// mod id -> that mod's version; missing/None = the mod doesn't have it
    #[serde(default)]
    pub mods: std::collections::HashMap<i64, Option<AssetPartValue>>,
}

#[derive(Debug, Clone, Default, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct AssetVersionInfo {
    /// The file was found (in the mod / in the game)
    pub found: bool,
    /// Couldn't be read part by part (then only whole-file comparison is possible)
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub error: Option<String>,
    /// Number of parts read
    pub parts: usize,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub file_hash: Option<String>,
    /// Compared object by object only (no property detail)
    #[serde(default)]
    pub shallow: bool,
}

/// Summarize, for many shared assets at once, what each mod changes compared to the game
#[derive(Debug, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct ConflictAssetsSummaryRequest {
    pub game_name: Option<String>,
    #[serde(default)]
    pub game_pak_path: Option<String>,
    pub mods: Vec<ConflictCheckModInfo>,
    pub assets: Vec<SharedAssetRef>,
}

#[derive(Debug, Clone, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct SharedAssetRef {
    /// Normalized path without extension
    pub asset_path: String,
    pub mod_ids: Vec<i64>,
}

/// What one mod changes in one asset
#[derive(Debug, Clone, Default, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct ModAssetChanges {
    pub found: bool,
    /// Couldn't be read part by part
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub error: Option<String>,
    /// Parts that differ from the game (or, when the game has no such file, all parts)
    pub changed: usize,
    /// changed parts per kind (property, component, function, event, variable, export, ...)
    pub kinds: std::collections::BTreeMap<String, usize>,
    /// Names of a few changed parts, for a quick description
    pub examples: Vec<String>,
    /// Compared object by object only (no property detail)
    #[serde(default)]
    pub shallow: bool,
}

/// How two mods' versions of one asset relate
#[derive(Debug, Clone, Default, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct AssetPairChanges {
    pub a: i64,
    pub b: i64,
    /// Parts both change in the same way
    pub same: usize,
    /// Parts both change, differently (a real clash)
    pub clash: usize,
    /// Parts only a changes / only b changes
    pub only_a: usize,
    pub only_b: usize,
    /// a's changes that b doesn't have are all plain values (properties) — could be copied over
    pub only_a_values: bool,
    pub only_b_values: bool,
    /// Names of a few clashing parts
    pub clash_examples: Vec<String>,
}

#[derive(Debug, Clone, Default, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct ConflictAssetSummary {
    pub asset_path: String,
    /// The game has this asset (otherwise mods added it and are compared to each other)
    pub in_game: bool,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub game_error: Option<String>,
    pub mods: std::collections::HashMap<i64, ModAssetChanges>,
    pub pairs: Vec<AssetPairChanges>,
}

#[derive(Debug, Clone, Default, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct ConflictAssetDiff {
    pub asset_path: String,
    pub game: AssetVersionInfo,
    pub mods: std::collections::HashMap<i64, AssetVersionInfo>,
    pub rows: Vec<AssetDiffRow>,
}

#[derive(Debug, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct ConflictCheckModInfo {
    #[serde(alias = "mod_id")]
    pub mod_id: i64,
    #[serde(alias = "cache_path")]
    pub cache_path: String,
    #[serde(alias = "is_unpacked")]
    pub is_unpacked: bool,
}

#[derive(Debug, Serialize, Deserialize)]
#[serde(rename_all = "snake_case")]
pub struct ModConflict {
    pub mod_id: i64,
    pub conflicting_mods: Vec<i64>,
    pub conflicting_files: Vec<String>,
    /// Content fingerprint of each conflicting file in this mod (same value in two
    /// mods = byte-identical file, so that overlap is harmless). Missing if unreadable.
    #[serde(default)]
    pub file_hashes: std::collections::HashMap<String, String>,
    /// How many files the mod has in total (to tell when every one is overridden)
    #[serde(default)]
    pub total_files: usize,
    /// The mod's files that no other mod has (always used), up to a limit
    #[serde(default)]
    pub other_files: Vec<String>,
    /// Conflicting files that aren't in the game (added by mods, e.g. a shared library),
    /// only filled when the game's pak could be read (see `game_checked`)
    #[serde(default)]
    pub new_files: Vec<String>,
    #[serde(default)]
    pub game_checked: bool,
}

#[cfg(test)]
mod tests {
    use super::{ConflictCheckModInfo, ModConflict};

    #[test]
    fn conflict_check_mod_info_accepts_snake_case_frontend_payload() {
        let mods: Vec<ConflictCheckModInfo> = serde_json::from_str(
            r#"[{"mod_id":1,"cache_path":"C:/mods/a.pak","is_unpacked":false}]"#,
        )
        .expect("snake_case conflict mod info should parse");

        assert_eq!(mods[0].mod_id, 1);
        assert_eq!(mods[0].cache_path, "C:/mods/a.pak");
        assert!(!mods[0].is_unpacked);
    }

    #[test]
    fn conflict_check_mod_info_still_accepts_camel_case_payload() {
        let mods: Vec<ConflictCheckModInfo> =
            serde_json::from_str(r#"[{"modId":1,"cachePath":"C:/mods/a.pak","isUnpacked":false}]"#)
                .expect("camelCase conflict mod info should parse");

        assert_eq!(mods[0].mod_id, 1);
        assert_eq!(mods[0].cache_path, "C:/mods/a.pak");
        assert!(!mods[0].is_unpacked);
    }

    #[test]
    fn mod_conflict_serializes_for_existing_frontend_contract() {
        let value = serde_json::to_value(ModConflict {
            mod_id: 1,
            conflicting_mods: vec![2],
            conflicting_files: vec!["fsd/content/a.uasset".to_string()],
            file_hashes: Default::default(),
            total_files: 1,
            other_files: vec![],
            new_files: vec![],
            game_checked: false,
        })
        .expect("mod conflict should serialize");

        assert!(value.get("mod_id").is_some());
        assert!(value.get("conflicting_mods").is_some());
        assert!(value.get("conflicting_files").is_some());
    }
}
