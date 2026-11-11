//! Dev tool: show every differing part of some shared assets (each mod's value and the game's).
//! usage: conflict_detail <mods.json: [{modId, cachePath, isUnpacked, name}]> <game pak> <asset path>:<id>,<id>...
use mintcat_integrator_api::{ConflictAssetDiffRequest, ConflictCheckModInfo};
use mintcat_integrator_core::conflict_asset_diff;
use std::collections::HashMap;

#[derive(serde::Deserialize)]
#[serde(rename_all = "camelCase")]
struct Entry {
    mod_id: i64,
    cache_path: String,
    is_unpacked: bool,
    name: String,
}

fn main() {
    let args: Vec<String> = std::env::args().collect();
    let entries: Vec<Entry> = serde_json::from_str(&std::fs::read_to_string(&args[1]).unwrap()).unwrap();
    let by_id: HashMap<i64, &Entry> = entries.iter().map(|e| (e.mod_id, e)).collect();
    for spec in &args[3..] {
        let (asset, ids) = spec.rsplit_once(':').unwrap();
        let ids: Vec<i64> = ids.split(',').map(|s| s.parse().unwrap()).collect();
        let diff = conflict_asset_diff(ConflictAssetDiffRequest {
            game_name: None,
            game_pak_path: Some(args[2].clone()),
            asset_path: asset.to_string(),
            mods: ids.iter().map(|id| {
                let e = by_id[id];
                ConflictCheckModInfo { mod_id: e.mod_id, cache_path: e.cache_path.clone(), is_unpacked: e.is_unpacked }
            }).collect(),
        })
        .unwrap();
        println!("### {asset} (game found={}, {} differing parts)", diff.game.found, diff.rows.len());
        for id in &ids {
            if let Some(err) = diff.mods.get(id).and_then(|m| m.error.clone()) {
                println!("  ! {}: {err}", by_id[id].name);
            }
        }
        let show = |v: Option<&mintcat_integrator_api::AssetPartValue>| match v {
            None => "(absent)".to_string(),
            Some(v) => v.value.clone().unwrap_or_else(|| format!("<{}>", &v.hash[..8])),
        };
        // ONLY=<mod id>: just the rows where that mod differs from the game
        let only: Option<i64> = std::env::var("ONLY").ok().and_then(|v| v.parse().ok());
        let rows: Vec<_> = diff.rows.iter().filter(|row| match only {
            None => true,
            Some(id) => row.mods.get(&id).cloned().flatten().map(|v| v.hash) != row.game.as_ref().map(|g| g.hash.clone()),
        }).collect();
        println!("  ({} rows shown)", rows.len().min(40));
        for row in rows.into_iter().take(40) {
            println!("  [{}] {} / {}", row.kind, row.owner, row.name);
            println!("      game: {}", show(row.game.as_ref()));
            for id in &ids {
                println!("      {}: {}", by_id[id].name, show(row.mods.get(id).and_then(|v| v.as_ref())));
            }
        }
    }
}
