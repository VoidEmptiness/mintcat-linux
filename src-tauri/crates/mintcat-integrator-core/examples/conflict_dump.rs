//! Dev tool: run the conflict check and the part-by-part summary like the app does and print
//! both as JSON ({"conflicts": [...], "summaries": [...]}), for analysing a real list.
//! usage: conflict_dump <mods.json: [{modId, cachePath, isUnpacked}]> [game pak]
use mintcat_integrator_api::{ConflictAssetsSummaryRequest, ConflictCheckModInfo, SharedAssetRef};
use mintcat_integrator_core::{check_mod_conflicts_with_game, conflict_assets_summary};
use std::collections::{BTreeMap, BTreeSet};

#[derive(serde::Deserialize)]
#[serde(rename_all = "camelCase")]
struct Entry {
    mod_id: i64,
    cache_path: String,
    is_unpacked: bool,
}

fn main() {
    let args: Vec<String> = std::env::args().collect();
    let entries: Vec<Entry> = serde_json::from_str(&std::fs::read_to_string(&args[1]).unwrap()).unwrap();
    let game = args.get(2).cloned();
    let infos: Vec<ConflictCheckModInfo> = entries
        .iter()
        .map(|e| ConflictCheckModInfo { mod_id: e.mod_id, cache_path: e.cache_path.clone(), is_unpacked: e.is_unpacked })
        .collect();
    let conflicts = check_mod_conflicts_with_game(&serde_json::to_string(&infos).unwrap(), None, game.as_deref()).unwrap();
    // same as sharedAssets() in ModConflictCheckTask.ts
    let mut by_asset: BTreeMap<String, BTreeSet<i64>> = BTreeMap::new();
    for c in &conflicts {
        for f in &c.conflicting_files {
            let lower = f.to_lowercase();
            if let Some(base) = lower.strip_suffix(".uasset").or_else(|| lower.strip_suffix(".umap")) {
                by_asset.entry(f[..base.len()].to_string()).or_default().insert(c.mod_id);
            }
        }
    }
    let conflicting: BTreeSet<i64> = conflicts.iter().map(|c| c.mod_id).collect();
    let assets: Vec<SharedAssetRef> = by_asset
        .into_iter()
        .filter(|(_, m)| m.len() > 1)
        .map(|(a, m)| SharedAssetRef { asset_path: a, mod_ids: m.into_iter().collect() })
        .collect();
    let summaries = conflict_assets_summary(ConflictAssetsSummaryRequest {
        game_name: None,
        game_pak_path: game.clone(),
        mods: infos.iter().filter(|i| conflicting.contains(&i.mod_id)).map(|i| ConflictCheckModInfo {
            mod_id: i.mod_id, cache_path: i.cache_path.clone(), is_unpacked: i.is_unpacked,
        }).collect(),
        assets,
    })
    .unwrap();
    println!("{}", serde_json::json!({ "conflicts": conflicts, "summaries": summaries }));
}
