use crate::asset_diff;
use anyhow::Context;
use mintcat_integrator_api::{
    AssetVersionInfo, ConflictAssetDiff, ConflictAssetDiffRequest, ConflictAssetSummary,
    ConflictAssetsSummaryRequest, ConflictCheckModInfo, ModAssetChanges, ModConflict,
};
use std::collections::{HashMap, HashSet};
use std::fs;
use std::hash::{Hash, Hasher};
use std::io::{BufReader, Cursor, Read};
use std::path::{Path, PathBuf};
use unreal_asset::engine_version::EngineVersion;
use walkdir::WalkDir;

/// Where a mod's file can be read from (to fingerprint it when it conflicts)
#[derive(Debug, Clone)]
enum FileSource {
    Pak { pak: PathBuf, entry: String },
    /// A pak inside a zip: mod.io downloads are kept as the zip mod.io serves
    ZipPak { zip: PathBuf, pak: String, entry: String },
    Disk(PathBuf),
}

type ModFiles = Vec<(String, FileSource)>;

fn normalize_pak_entry(mount_point: &str, entry: &str) -> String {
    // Paths in the index are relative to the mount point ("../../../" or
    // "../../../FSD/" etc.), so join them with a separator before comparing.
    let mount = mount_point.trim_end_matches('/');
    let file = entry.trim_start_matches('/');
    let full_path = if mount.is_empty() {
        file.to_string()
    } else {
        format!("{}/{}", mount, file)
    };
    let mut rel = full_path.as_str();
    while let Some(rest) = rel.strip_prefix("../") {
        rel = rest;
    }
    rel.trim_start_matches('/').to_lowercase()
}

fn open_pak(pak_path: &Path) -> anyhow::Result<(repak::PakReader, BufReader<fs::File>)> {
    let file = fs::File::open(pak_path)
        .with_context(|| format!("Failed to open pak file: {}", pak_path.display()))?;
    let mut reader = BufReader::new(file);
    let pak = repak::PakBuilder::new()
        .reader(&mut reader)
        .with_context(|| format!("Failed to parse pak file: {}", pak_path.display()))?;
    Ok((pak, reader))
}

fn get_pak_files(pak_path: &str) -> anyhow::Result<ModFiles> {
    let path = PathBuf::from(pak_path);
    let (pak, _reader) = open_pak(&path)?;
    let mount_point = pak.mount_point().to_string();
    Ok(pak
        .files()
        .iter()
        .map(|entry| {
            (
                normalize_pak_entry(&mount_point, entry),
                FileSource::Pak { pak: path.clone(), entry: entry.to_string() },
            )
        })
        .collect())
}

/// A zip (mod.io download) rather than a pak: starts with "PK\x03\x04"
fn is_zip(path: &Path) -> bool {
    let mut head = [0u8; 4];
    fs::File::open(path)
        .and_then(|mut f| f.read_exact(&mut head))
        .map(|_| head == [0x50, 0x4B, 0x03, 0x04])
        .unwrap_or(false)
}

/// The pak in a zip that gets installed: like the installer (see common::zip), the first
/// entry in the zip's order whose extension is exactly "pak". Other paks in the zip (variants,
/// options) aren't installed, so they can't conflict.
fn zip_pak_names(zip_path: &Path) -> anyhow::Result<Vec<String>> {
    let file = fs::File::open(zip_path)
        .with_context(|| format!("Failed to open zip: {}", zip_path.display()))?;
    let mut archive = zip::ZipArchive::new(BufReader::new(file))
        .with_context(|| format!("Failed to read zip: {}", zip_path.display()))?;
    for i in 0..archive.len() {
        let Ok(entry) = archive.by_index_raw(i) else { continue };
        let name = entry.name().to_string();
        if Path::new(&name).extension().is_some_and(|ext| ext == "pak") {
            return Ok(vec![name]);
        }
    }
    Ok(Vec::new())
}

fn read_zip_entry(zip_path: &Path, name: &str) -> anyhow::Result<Vec<u8>> {
    let file = fs::File::open(zip_path)
        .with_context(|| format!("Failed to open zip: {}", zip_path.display()))?;
    let mut archive = zip::ZipArchive::new(BufReader::new(file))?;
    let mut entry = archive.by_name(name)?;
    // The size comes from the zip's header: don't trust it for more than a first guess
    let mut data = Vec::with_capacity((entry.size() as usize).min(64 * 1024 * 1024));
    entry.read_to_end(&mut data)?;
    Ok(data)
}

/// Files of every pak in a zip. A pak that can't be read is left out (and reported).
fn get_zip_files(zip_path: &str) -> anyhow::Result<ModFiles> {
    let path = PathBuf::from(zip_path);
    let mut files = Vec::new();
    for name in zip_pak_names(&path)? {
        let parsed = read_zip_entry(&path, &name).and_then(|data| {
            let mut cursor = Cursor::new(data.as_slice());
            let pak = repak::PakBuilder::new()
                .reader(&mut cursor)
                .with_context(|| format!("Failed to parse {} in {}", name, path.display()))?;
            Ok((pak.mount_point().to_string(), pak.files()))
        });
        match parsed {
            Ok((mount_point, entries)) => {
                for entry in entries {
                    files.push((
                        normalize_pak_entry(&mount_point, &entry),
                        FileSource::ZipPak { zip: path.clone(), pak: name.clone(), entry },
                    ));
                }
            }
            Err(error) => eprintln!("Skipping a pak in a mod zip: {:#}", error),
        }
    }
    Ok(files)
}

fn content_prefix_for_game(game_name: Option<&str>) -> &'static str {
    match game_name {
        Some(name) if name.eq_ignore_ascii_case("rc") => "roguecore",
        _ => "fsd",
    }
}

fn get_unpacked_mod_files(dir_path: &str, content_prefix: &str) -> anyhow::Result<ModFiles> {
    let path = Path::new(dir_path);
    let content_path = path.join("Content");

    if !content_path.is_dir() {
        anyhow::bail!("Content directory not found in unpacked mod: {}", dir_path);
    }

    let mut files = Vec::new();

    for entry in WalkDir::new(&content_path)
        .follow_links(true)
        .into_iter()
        .filter_map(|e| e.ok())
    {
        let entry_path = entry.path();
        if entry_path.is_dir() {
            continue;
        }

        if let Ok(relative) = entry_path.strip_prefix(&content_path) {
            let pak_path = format!(
                "{}/content/{}",
                content_prefix.to_lowercase(),
                relative.to_string_lossy().replace('\\', "/").to_lowercase()
            );
            files.push((pak_path, FileSource::Disk(entry_path.to_path_buf())));
        }
    }

    Ok(files)
}

fn get_directory_mod_pak_files(dir_path: &str, content_prefix: &str) -> anyhow::Result<ModFiles> {
    let path = Path::new(dir_path);
    let mut all_files = Vec::new();

    let content_path = path.join("Content");
    if content_path.is_dir() {
        if let Ok(files) = get_unpacked_mod_files(dir_path, content_prefix) {
            all_files.extend(files);
        }
    }

    let pak_dir = path.join("pak");
    if pak_dir.is_dir() {
        if let Ok(entries) = fs::read_dir(&pak_dir) {
            for entry in entries.flatten() {
                let entry_path = entry.path();
                if entry_path.is_file()
                    && entry_path
                        .extension()
                        .and_then(|e| e.to_str())
                        .map_or(false, |e| e.eq_ignore_ascii_case("pak"))
                {
                    if let Some(p) = entry_path.to_str() {
                        if let Ok(files) = get_pak_files(p) {
                            all_files.extend(files);
                        }
                    }
                }
            }
        }
    }

    Ok(all_files)
}

fn fingerprint(data: &[u8]) -> String {
    let mut hasher = std::collections::hash_map::DefaultHasher::new();
    data.hash(&mut hasher);
    format!("{:016x}-{}", hasher.finish(), data.len())
}

/// Fingerprint the given (conflicting) files of one mod, opening each pak once.
fn fingerprint_files(files: &[(&String, &FileSource)]) -> HashMap<String, String> {
    read_sources(files)
        .into_iter()
        .map(|(path, data)| (path, fingerprint(&data)))
        .collect()
}

/// Every file of a mod (normalized path, where to read it)
fn list_mod_files(mod_info: &ConflictCheckModInfo, content_prefix: &str) -> anyhow::Result<ModFiles> {
    if mod_info.is_unpacked {
        get_directory_mod_pak_files(&mod_info.cache_path, content_prefix)
    } else if is_zip(Path::new(&mod_info.cache_path)) {
        // mod.io downloads: these were skipped before (read as a pak, which failed), so
        // conflicts between mod.io mods never showed
        get_zip_files(&mod_info.cache_path)
    } else {
        get_pak_files(&mod_info.cache_path)
    }
}

/// Read the given files from wherever they are (paks are opened once each)
fn read_sources(files: &[(&String, &FileSource)]) -> HashMap<String, Vec<u8>> {
    let mut out = HashMap::new();
    let mut by_pak: HashMap<&PathBuf, Vec<(&String, &String)>> = HashMap::new();
    let mut by_zip_pak: HashMap<(&PathBuf, &String), Vec<(&String, &String)>> = HashMap::new();
    for (path, source) in files {
        match source {
            FileSource::Disk(disk) => {
                if let Ok(data) = fs::read(disk) {
                    out.insert((*path).clone(), data);
                }
            }
            FileSource::Pak { pak, entry } => by_pak.entry(pak).or_default().push((path, entry)),
            FileSource::ZipPak { zip, pak, entry } => by_zip_pak.entry((zip, pak)).or_default().push((path, entry)),
        }
    }
    for ((zip_path, pak_name), entries) in by_zip_pak {
        let Ok(data) = read_zip_entry(zip_path, pak_name) else { continue };
        let mut cursor = Cursor::new(data.as_slice());
        let Ok(pak) = repak::PakBuilder::new().reader(&mut cursor) else { continue };
        for (path, entry) in entries {
            if let Ok(bytes) = pak.get(entry, &mut cursor) {
                out.insert(path.clone(), bytes);
            }
        }
    }
    for (pak_path, entries) in by_pak {
        let Ok((pak, mut reader)) = open_pak(pak_path) else { continue };
        for (path, entry) in entries {
            if let Ok(data) = pak.get(entry, &mut reader) {
                out.insert(path.clone(), data);
            }
        }
    }
    out
}

/// The game's own pak index (normalized path -> entry). Read per request, not kept: the
/// backend library may be unloaded between calls, and a cache in it would leak.
struct GameIndex {
    path: PathBuf,
    pak: repak::PakReader,
    entries: HashMap<String, String>,
}

fn game_index(pak_path: &str) -> Option<GameIndex> {
    if pak_path.trim().is_empty() {
        return None;
    }
    let path = PathBuf::from(pak_path);
    if !path.is_file() {
        return None;
    }
    let (pak, _reader) = match open_pak(&path) {
        Ok(opened) => opened,
        Err(error) => {
            eprintln!("Couldn't read the game's pak for the conflict check: {:#}", error);
            return None;
        }
    };
    let mount = pak.mount_point().to_string();
    let entries = pak
        .files()
        .into_iter()
        .map(|entry| (normalize_pak_entry(&mount, &entry), entry))
        .collect();
    Some(GameIndex { path, pak, entries })
}

fn read_game_files(index: &GameIndex, wanted: &[String]) -> HashMap<String, Vec<u8>> {
    let mut out = HashMap::new();
    let Ok(file) = fs::File::open(&index.path) else { return out };
    let mut reader = BufReader::new(file);
    for path in wanted {
        if let Some(entry) = index.entries.get(path) {
            if let Ok(data) = index.pak.get(entry, &mut reader) {
                out.insert(path.clone(), data);
            }
        }
    }
    out
}

/// Extensions of the files that make up one asset
const ASSET_PART_EXTENSIONS: [&str; 5] = [".uasset", ".uexp", ".umap", ".ubulk", ".uptnl"];

fn files_of_asset(base: &str) -> Vec<String> {
    ASSET_PART_EXTENSIONS.iter().map(|ext| format!("{base}{ext}")).collect()
}

/// The files of one asset (by extension) out of a set of files read by path
fn asset_input(base: &str, files: &HashMap<String, Vec<u8>>) -> asset_diff::VersionInput {
    asset_diff::VersionInput {
        files: ASSET_PART_EXTENSIONS
            .iter()
            .filter_map(|ext| files.get(&format!("{base}{ext}")).map(|d| (ext.to_string(), d.clone())))
            .collect(),
    }
}

fn version_info(v: &asset_diff::VersionParts) -> AssetVersionInfo {
    AssetVersionInfo {
        found: v.file_hash.is_some(),
        error: v.error.clone(),
        parts: v.parts.as_ref().map_or(0, |p| p.len()),
        file_hash: v.file_hash.clone(),
        shallow: v.shallow,
    }
}

/// Read the given assets' files from each mod (each mod opened once) and from the game
struct AssetSources {
    mods: HashMap<i64, HashMap<String, Vec<u8>>>,
    game: Option<HashMap<String, Vec<u8>>>,
}

fn read_asset_sources(
    mods: &[ConflictCheckModInfo],
    assets: &[(String, Vec<i64>)],
    content_prefix: &str,
    game_pak_path: Option<&str>,
) -> AssetSources {
    let mut mod_files = HashMap::new();
    for mod_info in mods {
        let wanted: HashSet<String> = assets
            .iter()
            .filter(|(_, ids)| ids.contains(&mod_info.mod_id))
            .flat_map(|(base, _)| files_of_asset(base))
            .collect();
        if wanted.is_empty() {
            continue;
        }
        let files = list_mod_files(mod_info, content_prefix)
            .map(|files| {
                let picked: Vec<(&String, &FileSource)> =
                    files.iter().filter(|(p, _)| wanted.contains(p)).map(|(p, s)| (p, s)).collect();
                read_sources(&picked)
            })
            .unwrap_or_default();
        mod_files.insert(mod_info.mod_id, files);
    }
    let game = game_pak_path.and_then(game_index).map(|index| {
        let wanted: Vec<String> = assets.iter().flat_map(|(base, _)| files_of_asset(base)).collect();
        read_game_files(&index, &wanted)
    });
    AssetSources { mods: mod_files, game }
}

/// Every version of one asset, read the same way so their parts can be compared:
/// (the game's, if the game was read), and each mod's
fn read_asset_versions(
    sources: &AssetSources,
    base: &str,
    ids: &[i64],
) -> (Option<asset_diff::VersionParts>, Vec<(i64, asset_diff::VersionParts)>) {
    let version = EngineVersion::VER_UE4_27;
    let empty = HashMap::new();
    let game_input = sources.game.as_ref().map(|files| asset_input(base, files));
    let mod_inputs: Vec<asset_diff::VersionInput> =
        ids.iter().map(|id| asset_input(base, sources.mods.get(id).unwrap_or(&empty))).collect();
    let mut inputs: Vec<&asset_diff::VersionInput> = Vec::new();
    if let Some(game) = &game_input {
        inputs.push(game);
    }
    inputs.extend(mod_inputs.iter());
    let mut read = asset_diff::read_versions(&inputs, version).into_iter();
    let game = game_input.as_ref().and_then(|_| read.next());
    let mods = ids.iter().copied().zip(read).collect();
    (game, mods)
}

/// Compare one shared asset across the given mods and the game's original, part by part
pub fn conflict_asset_diff(request: ConflictAssetDiffRequest) -> anyhow::Result<ConflictAssetDiff> {
    let content_prefix = content_prefix_for_game(request.game_name.as_deref());
    let base = request.asset_path.trim().to_lowercase();
    let ids: Vec<i64> = request.mods.iter().map(|m| m.mod_id).collect();
    let assets = vec![(base.clone(), ids.clone())];
    let sources = read_asset_sources(&request.mods, &assets, content_prefix, request.game_pak_path.as_deref());
    let (game, versions) = read_asset_versions(&sources, &base, &ids);

    let mut result = ConflictAssetDiff { asset_path: base.clone(), ..Default::default() };
    if let Some(game) = &game {
        result.game = version_info(game);
    }
    for (id, v) in &versions {
        result.mods.insert(*id, version_info(v));
    }
    let game_parts = game.as_ref().filter(|g| g.file_hash.is_some()).and_then(|g| g.parts.as_ref());
    let mod_parts: Vec<(i64, Option<&asset_diff::PartMap>)> =
        versions.iter().map(|(id, v)| (*id, v.parts.as_ref())).collect();
    result.rows = asset_diff::diff_rows(game_parts, &mod_parts);
    Ok(result)
}

/// For many shared assets at once: what each mod changes compared to the game, and how
/// each pair of mods sharing an asset relates. Each mod and the game are opened once.
pub fn conflict_assets_summary(request: ConflictAssetsSummaryRequest) -> anyhow::Result<Vec<ConflictAssetSummary>> {
    let content_prefix = content_prefix_for_game(request.game_name.as_deref());
    let assets: Vec<(String, Vec<i64>)> = request
        .assets
        .iter()
        .map(|a| (a.asset_path.trim().to_lowercase(), a.mod_ids.clone()))
        .collect();
    let timing = std::env::var_os("MINTCAT_CONFLICT_TIMING").is_some();
    let started = std::time::Instant::now();
    let sources = read_asset_sources(&request.mods, &assets, content_prefix, request.game_pak_path.as_deref());
    if timing {
        eprintln!("  files read at {:?}", started.elapsed());
    }

    let mut out = Vec::new();
    for (base, ids) in &assets {
        let one = std::time::Instant::now();
        let (game, versions) = read_asset_versions(&sources, base, ids);
        let in_game = game.as_ref().is_some_and(|g| g.file_hash.is_some());
        let game_parts = game.as_ref().filter(|_| in_game).and_then(|g| g.parts.as_ref());
        let parts: Vec<(i64, Option<&asset_diff::PartMap>)> =
            versions.iter().map(|(id, v)| (*id, v.parts.as_ref())).collect();
        let (mut mods, pairs) = asset_diff::summarize(game_parts, &parts);
        for (id, v) in &versions {
            let entry = mods.entry(*id).or_insert_with(ModAssetChanges::default);
            entry.found = v.file_hash.is_some();
            entry.error = v.error.clone();
            entry.shallow = v.shallow;
        }
        if timing && one.elapsed().as_millis() > 200 {
            eprintln!("  slow: {base} {:?}", one.elapsed());
        }
        out.push(ConflictAssetSummary {
            asset_path: base.clone(),
            in_game,
            game_error: game.as_ref().and_then(|g| g.error.clone()),
            mods,
            pairs,
        });
    }
    if timing {
        eprintln!("  compared at {:?}", started.elapsed());
    }
    Ok(out)
}

pub fn check_mod_conflicts_from_json(
    mod_list_json: &str,
    game_name: Option<&str>,
) -> Result<Vec<ModConflict>, String> {
    let mods: Vec<ConflictCheckModInfo> = serde_json::from_str(mod_list_json)
        .map_err(|_| "backend.error.parse_mod_list".to_string())?;

    Ok(check_mod_conflicts(&mods, game_name))
}

/// Same as [check_mod_conflicts], also telling which shared files the game itself has
pub fn check_mod_conflicts_with_game(
    mod_list_json: &str,
    game_name: Option<&str>,
    game_pak_path: Option<&str>,
) -> Result<Vec<ModConflict>, String> {
    let mods: Vec<ConflictCheckModInfo> = serde_json::from_str(mod_list_json)
        .map_err(|_| "backend.error.parse_mod_list".to_string())?;
    let mut conflicts = check_mod_conflicts(&mods, game_name);
    if let Some(index) = game_pak_path.and_then(game_index) {
        for conflict in &mut conflicts {
            conflict.new_files = conflict
                .conflicting_files
                .iter()
                .filter(|f| !index.entries.contains_key(*f))
                .cloned()
                .collect();
            conflict.game_checked = true;
        }
    }
    Ok(conflicts)
}

/// How many of a mod's own (unshared) files are listed, to keep the answer small
const OTHER_FILES_LIMIT: usize = 3000;

pub fn check_mod_conflicts(
    mods: &[ConflictCheckModInfo],
    game_name: Option<&str>,
) -> Vec<ModConflict> {
    let content_prefix = content_prefix_for_game(game_name);
    let mut file_to_mods: HashMap<String, Vec<i64>> = HashMap::new();
    // mod id -> (normalized path -> where to read it)
    let mut sources: HashMap<i64, HashMap<String, FileSource>> = HashMap::new();

    for mod_info in mods {
        let files = list_mod_files(mod_info, content_prefix);

        match files {
            Ok(file_list) => {
                let mod_sources = sources.entry(mod_info.mod_id).or_default();
                for (file_path, source) in file_list {
                    // The installer never writes these from mods (see pak_integrator),
                    // so they can't conflict in practice.
                    if file_path.ends_with("assetregistry.bin")
                        || file_path.ends_with(".ushaderbytecode")
                    {
                        continue;
                    }
                    let ids = file_to_mods.entry(file_path.clone()).or_default();
                    // A mod with several paks can list a path twice; that's not a conflict
                    if !ids.contains(&mod_info.mod_id) {
                        ids.push(mod_info.mod_id);
                        mod_sources.insert(file_path, source);
                    }
                }
            }
            Err(error) => {
                eprintln!("Failed to read mod {}: {:#}", mod_info.mod_id, error);
            }
        }
    }

    let mut mod_conflicts: HashMap<i64, (Vec<i64>, Vec<String>)> = HashMap::new();

    for (file_path, mod_ids) in file_to_mods {
        if mod_ids.len() > 1 {
            for &mod_id in &mod_ids {
                let entry = mod_conflicts
                    .entry(mod_id)
                    .or_insert_with(|| (Vec::new(), Vec::new()));

                for &other_mod_id in &mod_ids {
                    if other_mod_id != mod_id && !entry.0.contains(&other_mod_id) {
                        entry.0.push(other_mod_id);
                    }
                }

                // each path comes up once (map keys are unique)
                entry.1.push(file_path.clone());
            }
        }
    }

    mod_conflicts
        .into_iter()
        .map(|(mod_id, (conflicting_mods, conflicting_files))| {
            let file_hashes = sources
                .get(&mod_id)
                .map(|mod_sources| {
                    let wanted: Vec<(&String, &FileSource)> = conflicting_files
                        .iter()
                        .filter_map(|f| mod_sources.get(f).map(|s| (f, s)))
                        .collect();
                    fingerprint_files(&wanted)
                })
                .unwrap_or_default();
            let total_files = sources.get(&mod_id).map_or(0, |m| m.len());
            let shared: HashSet<&String> = conflicting_files.iter().collect();
            let mut other_files: Vec<String> = sources
                .get(&mod_id)
                .map(|m| m.keys().filter(|f| !shared.contains(f)).cloned().collect())
                .unwrap_or_default();
            other_files.sort();
            other_files.truncate(OTHER_FILES_LIMIT);
            ModConflict {
                mod_id,
                conflicting_mods,
                conflicting_files,
                file_hashes,
                total_files,
                other_files,
                new_files: Vec::new(),
                game_checked: false,
            }
        })
        .collect()
}

#[cfg(test)]
mod tests {
    use super::*;

    fn write_pak(path: &std::path::Path, files: &[&str]) {
        write_pak_mounted(path, "../../../", files);
    }

    fn write_pak_mounted(path: &std::path::Path, mount: &str, files: &[&str]) {
        let file = fs::File::create(path).unwrap();
        let mut writer = repak::PakBuilder::new().writer(
            std::io::BufWriter::new(file),
            repak::Version::V11,
            mount.to_string(),
            None,
        );
        for f in files {
            writer.write_file(f, false, b"data".to_vec()).unwrap();
        }
        writer.write_index().unwrap();
    }

    fn write_pak_with(path: &std::path::Path, files: &[(&str, &[u8])]) {
        let file = fs::File::create(path).unwrap();
        let mut writer = repak::PakBuilder::new().writer(
            std::io::BufWriter::new(file),
            repak::Version::V11,
            "../../../".to_string(),
            None,
        );
        for (name, data) in files {
            writer.write_file(name, false, data.to_vec()).unwrap();
        }
        writer.write_index().unwrap();
    }

    fn info(id: i64, path: &std::path::Path) -> ConflictCheckModInfo {
        serde_json::from_value(serde_json::json!({
            "mod_id": id,
            "cache_path": path.to_str().unwrap(),
            "is_unpacked": false,
        }))
        .unwrap()
    }

    #[test]
    fn reports_real_overlaps_and_ignores_files_the_installer_skips() {
        let dir = tempfile::tempdir().unwrap();
        let a = dir.path().join("a.pak");
        let b = dir.path().join("b.pak");
        let c = dir.path().join("c.pak");
        write_pak(&a, &["FSD/Content/Gun.uasset", "FSD/Content/Gun.uexp", "FSD/AssetRegistry.bin"]);
        write_pak(&b, &["FSD/Content/Gun.uasset", "FSD/Content/Gun.uexp", "FSD/AssetRegistry.bin"]);
        // Shares only skipped files with the others: must not be a conflict
        write_pak(&c, &["FSD/Content/Other.uasset", "FSD/AssetRegistry.bin", "FSD/Content/S.ushaderbytecode"]);

        let mut result = check_mod_conflicts(&[info(1, &a), info(2, &b), info(3, &c)], None);
        result.sort_by_key(|m| m.mod_id);

        assert_eq!(result.len(), 2, "only mods 1 and 2 conflict: {:?}", result.iter().map(|m| m.mod_id).collect::<Vec<_>>());
        assert_eq!(result[0].mod_id, 1);
        assert_eq!(result[0].conflicting_mods, vec![2]);
        let mut files = result[0].conflicting_files.clone();
        files.sort();
        assert_eq!(files, vec!["fsd/content/gun.uasset", "fsd/content/gun.uexp"]);
    }

    #[test]
    fn detects_conflicts_across_different_mount_points() {
        let dir = tempfile::tempdir().unwrap();
        let a = dir.path().join("a.pak");
        let d = dir.path().join("d.pak");
        write_pak(&a, &["FSD/Content/Gun.uasset"]);
        write_pak_mounted(&d, "../../../FSD/", &["Content/Gun.uasset"]);

        let result = check_mod_conflicts(&[info(1, &a), info(4, &d)], None);
        assert_eq!(result.len(), 2);
        for m in &result {
            assert_eq!(m.conflicting_files, vec!["fsd/content/gun.uasset"]);
        }
    }

    #[test]
    fn fingerprints_tell_identical_files_from_different_ones() {
        let dir = tempfile::tempdir().unwrap();
        let a = dir.path().join("a.pak");
        let b = dir.path().join("b.pak");
        write_pak_with(&a, &[("FSD/Content/Shared.uasset", b"same bytes"), ("FSD/Content/Gun.uasset", b"gun A")]);
        write_pak_with(&b, &[("FSD/Content/Shared.uasset", b"same bytes"), ("FSD/Content/Gun.uasset", b"gun B")]);

        // An unpacked folder mod with the same shared file
        let unpacked = dir.path().join("unpacked");
        fs::create_dir_all(unpacked.join("Content")).unwrap();
        fs::write(unpacked.join("Content").join("Shared.uasset"), b"same bytes").unwrap();
        let unpacked_info: ConflictCheckModInfo = serde_json::from_value(serde_json::json!({
            "mod_id": 3, "cache_path": unpacked.to_str().unwrap(), "is_unpacked": true,
        })).unwrap();

        let result = check_mod_conflicts(&[info(1, &a), info(2, &b), unpacked_info], None);
        let by_id: HashMap<i64, &ModConflict> = result.iter().map(|m| (m.mod_id, m)).collect();
        let h = |id: i64, f: &str| by_id[&id].file_hashes.get(f).cloned();

        assert!(h(1, "fsd/content/shared.uasset").is_some());
        assert_eq!(h(1, "fsd/content/shared.uasset"), h(2, "fsd/content/shared.uasset"));
        assert_eq!(h(1, "fsd/content/shared.uasset"), h(3, "fsd/content/shared.uasset"));
        assert_ne!(h(1, "fsd/content/gun.uasset"), h(2, "fsd/content/gun.uasset"));
        assert!(h(3, "fsd/content/gun.uasset").is_none(), "mod 3 doesn't have the gun");
        assert_eq!((by_id[&1].total_files, by_id[&3].total_files), (2, 1));
    }

    /// A mod.io download: the zip mod.io serves, with the pak inside (maybe in a folder)
    fn write_zip_with_paks(path: &std::path::Path, paks: &[(&str, &std::path::Path)]) {
        use std::io::Write;
        let file = fs::File::create(path).unwrap();
        let mut zip = zip::ZipWriter::new(file);
        let options: zip::write::SimpleFileOptions = zip::write::SimpleFileOptions::default()
            .compression_method(zip::CompressionMethod::Deflated);
        zip.start_file("readme.txt", options).unwrap();
        zip.write_all(b"not a pak").unwrap();
        for (name, pak) in paks {
            zip.start_file(*name, options).unwrap();
            zip.write_all(&fs::read(pak).unwrap()).unwrap();
        }
        zip.finish().unwrap();
    }

    #[test]
    fn mod_io_zips_are_checked_too() {
        let dir = tempfile::tempdir().unwrap();
        // two versions of the same icon mod, as mod.io zips, and a plain local pak
        let icons = dir.path().join("icons.pak");
        let sticky = dir.path().join("sticky.pak");
        let local = dir.path().join("local.pak");
        write_pak_with(&icons, &[("FSD/Content/UI/Icon_Stasis.uasset", b"icon"), ("FSD/Content/UI/Icon_Snow.uasset", b"snow v1")]);
        write_pak_with(&sticky, &[("FSD/Content/UI/Icon_Stasis.uasset", b"icon"), ("FSD/Content/UI/Icon_Snow.uasset", b"snow v2"),
            ("FSD/Content/UI/Icon_Sticky.uasset", b"sticky")]);
        write_pak_with(&local, &[("FSD/Content/UI/Icon_Sticky.uasset", b"sticky")]);
        let zip_a = dir.path().join("modio-1-icons.zip");
        let zip_b = dir.path().join("modio-2-sticky.zip");
        write_zip_with_paks(&zip_a, &[("icons.pak", &icons)]);
        write_zip_with_paks(&zip_b, &[("folder/sticky.pak", &sticky)]);

        let result = check_mod_conflicts(&[info(1, &zip_a), info(2, &zip_b), info(3, &local)], None);
        let by_id: HashMap<i64, &ModConflict> = result.iter().map(|m| (m.mod_id, m)).collect();
        let mut files_1 = by_id[&1].conflicting_files.clone();
        files_1.sort();
        assert_eq!(files_1, vec!["fsd/content/ui/icon_snow.uasset", "fsd/content/ui/icon_stasis.uasset"]);
        let mut others_2 = by_id[&2].conflicting_mods.clone();
        others_2.sort();
        assert_eq!(others_2, vec![1, 3]);
        assert_eq!(by_id[&3].conflicting_mods, vec![2]);
        assert_eq!((by_id[&1].total_files, by_id[&2].total_files), (2, 3));

        // fingerprints read from inside the zips: same bytes match, different don't, also vs a plain pak
        let h = |id: i64, f: &str| by_id[&id].file_hashes.get(f).cloned();
        assert!(h(1, "fsd/content/ui/icon_stasis.uasset").is_some());
        assert_eq!(h(1, "fsd/content/ui/icon_stasis.uasset"), h(2, "fsd/content/ui/icon_stasis.uasset"));
        assert_ne!(h(1, "fsd/content/ui/icon_snow.uasset"), h(2, "fsd/content/ui/icon_snow.uasset"));
        assert_eq!(h(2, "fsd/content/ui/icon_sticky.uasset"), h(3, "fsd/content/ui/icon_sticky.uasset"));
    }

    #[test]
    fn only_the_installed_pak_of_a_zip_counts() {
        let dir = tempfile::tempdir().unwrap();
        let option_a = dir.path().join("a.pak");
        let option_b = dir.path().join("b.pak");
        let other = dir.path().join("other.pak");
        write_pak_with(&option_a, &[("FSD/Content/UI/A.uasset", b"a")]);
        write_pak_with(&option_b, &[("FSD/Content/UI/B.uasset", b"b")]);
        write_pak_with(&other, &[("FSD/Content/UI/B.uasset", b"b2"), ("FSD/Content/UI/A.uasset", b"a2")]);
        let zip = dir.path().join("modio-9-options.zip");
        // the installer takes the first ".pak" in the zip; ".PAK" isn't picked up at all
        write_zip_with_paks(&zip, &[("Option A/a.pak", &option_a), ("Option B/b.pak", &option_b)]);
        let result = check_mod_conflicts(&[info(1, &zip), info(2, &other)], None);
        let one = result.iter().find(|m| m.mod_id == 1).unwrap();
        assert_eq!(one.conflicting_files, vec!["fsd/content/ui/a.uasset"]);
        assert_eq!(one.total_files, 1);
        let two = result.iter().find(|m| m.mod_id == 2).unwrap();
        assert_eq!(two.other_files, vec!["fsd/content/ui/b.uasset"]);
    }

    #[test]
    fn shared_files_the_game_lacks_are_listed_as_new() {
        let dir = tempfile::tempdir().unwrap();
        let game = dir.path().join("FSD-WindowsNoEditor.pak");
        write_pak_with(&game, &[("FSD/Content/WeaponsNTools/Gun.uasset", b"game gun")]);
        let a = dir.path().join("a.pak");
        let b = dir.path().join("b.pak");
        write_pak_with(&a, &[("FSD/Content/WeaponsNTools/Gun.uasset", b"gun a"), ("FSD/Content/_Lib/Helper.uasset", b"lib")]);
        write_pak_with(&b, &[("FSD/Content/WeaponsNTools/Gun.uasset", b"gun b"), ("FSD/Content/_Lib/Helper.uasset", b"lib")]);
        let list = serde_json::to_string(&[info(1, &a), info(2, &b)]).unwrap();
        let result = check_mod_conflicts_with_game(&list, None, game.to_str()).unwrap();
        for conflict in &result {
            assert!(conflict.game_checked);
            assert_eq!(conflict.new_files, vec!["fsd/content/_lib/helper.uasset"]);
        }
        // Without the game: nothing is claimed
        let result = check_mod_conflicts_with_game(&list, None, Some("/nonexistent/x.pak")).unwrap();
        assert!(result.iter().all(|c| !c.game_checked && c.new_files.is_empty()));

        // Comparing the shared assets doesn't fail on files that aren't real assets
        let summary = conflict_assets_summary(mintcat_integrator_api::ConflictAssetsSummaryRequest {
            game_name: None,
            game_pak_path: game.to_str().map(String::from),
            mods: vec![info(1, &a), info(2, &b)],
            assets: vec![mintcat_integrator_api::SharedAssetRef {
                asset_path: "fsd/content/weaponsntools/gun".into(),
                mod_ids: vec![1, 2],
            }],
        })
        .unwrap();
        assert_eq!(summary.len(), 1);
        assert!(summary[0].in_game);
        assert!(summary[0].mods.values().all(|m| m.found && m.error.is_some()));
        let diff = conflict_asset_diff(mintcat_integrator_api::ConflictAssetDiffRequest {
            game_name: None,
            game_pak_path: game.to_str().map(String::from),
            asset_path: "FSD/Content/WeaponsNTools/Gun".into(),
            mods: vec![info(1, &a), info(2, &b)],
        })
        .unwrap();
        assert!(diff.game.found);
        assert_ne!(diff.mods[&1].file_hash, diff.mods[&2].file_hash);
    }

    #[test]
    fn a_broken_zip_is_left_out() {
        let dir = tempfile::tempdir().unwrap();
        let bad = dir.path().join("bad.zip");
        fs::write(&bad, b"PK\x03\x04 not really a zip").unwrap();
        let a = dir.path().join("a.pak");
        write_pak_with(&a, &[("FSD/Content/X.uasset", b"x")]);
        assert!(check_mod_conflicts(&[info(1, &bad), info(2, &a)], None).is_empty());
    }
}
