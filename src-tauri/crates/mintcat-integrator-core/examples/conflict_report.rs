//! Dev tool: run the conflict check and the part-by-part comparison of every shared asset
//! on a real mod list, and summarize what the comparison finds.
//! usage: conflict_report <mods.json: [{modId, cachePath, isUnpacked, name}]> <game pak>
use mintcat_integrator_api::{ConflictAssetDiffRequest, ConflictAssetsSummaryRequest, ConflictCheckModInfo, SharedAssetRef};
use mintcat_integrator_core::{check_mod_conflicts_with_game, conflict_asset_diff, conflict_assets_summary};
use std::collections::{BTreeMap, HashMap};
use std::time::Instant;

#[derive(serde::Deserialize)]
#[serde(rename_all = "camelCase")]
struct Entry {
    mod_id: i64,
    cache_path: String,
    is_unpacked: bool,
    name: String,
}

fn base_of(file: &str) -> String {
    for ext in [".uasset", ".uexp", ".ubulk", ".umap", ".uptnl"] {
        if let Some(b) = file.strip_suffix(ext) {
            return b.to_string();
        }
    }
    file.to_string()
}

fn main() {
    let args: Vec<String> = std::env::args().collect();
    let entries: Vec<Entry> = serde_json::from_str(&std::fs::read_to_string(&args[1]).unwrap()).unwrap();
    let game = args.get(2).cloned();
    let names: HashMap<i64, String> = entries.iter().map(|e| (e.mod_id, e.name.clone())).collect();
    let infos: Vec<ConflictCheckModInfo> = entries
        .iter()
        .map(|e| ConflictCheckModInfo { mod_id: e.mod_id, cache_path: e.cache_path.clone(), is_unpacked: e.is_unpacked })
        .collect();
    let t = Instant::now();
    let conflicts = check_mod_conflicts_with_game(&serde_json::to_string(&infos).unwrap(), None, game.as_deref()).unwrap();
    eprintln!("check: {} mods with conflicts in {:?}", conflicts.len(), t.elapsed());
    let game_checked = conflicts.iter().all(|c| c.game_checked);
    let new_files: usize = conflicts.iter().map(|c| c.new_files.len()).sum();
    eprintln!("game checked: {game_checked}; new (mod-added) shared files listed: {new_files}");

    // asset -> mods sharing it
    let mut assets: BTreeMap<String, Vec<i64>> = BTreeMap::new();
    for c in &conflicts {
        for f in &c.conflicting_files {
            let list = assets.entry(base_of(f)).or_default();
            if !list.contains(&c.mod_id) {
                list.push(c.mod_id);
            }
        }
    }
    eprintln!("shared assets: {}", assets.len());
    if std::env::var("SUMMARY").is_ok() {
        let t = Instant::now();
        let summary = conflict_assets_summary(ConflictAssetsSummaryRequest {
            game_name: None,
            game_pak_path: game.clone(),
            mods: infos.iter().map(|i| ConflictCheckModInfo { mod_id: i.mod_id, cache_path: i.cache_path.clone(), is_unpacked: i.is_unpacked }).collect(),
            assets: assets.iter().map(|(a, ids)| SharedAssetRef { asset_path: a.clone(), mod_ids: ids.clone() }).collect(),
        }).unwrap();
        eprintln!("summary of {} assets in {:?}", summary.len(), t.elapsed());
        let json = serde_json::to_string(&summary).unwrap();
        eprintln!("summary json: {} bytes", json.len());
        for s in &summary {
            for p in &s.pairs {
                println!("{}\tin_game={}\t{} vs {}\tsame {} clash {} only {}/{} values {}/{}\t{:?}",
                    s.asset_path, s.in_game, names[&p.a], names[&p.b], p.same, p.clash, p.only_a, p.only_b, p.only_a_values, p.only_b_values, p.clash_examples);
            }
            for (id, m) in &s.mods {
                if m.error.is_some() || !m.found {
                    println!("{}\t{}\tfound={} error={:?}", s.asset_path, names[id], m.found, m.error);
                }
            }
        }
        return;
    }
    let by_id: HashMap<i64, &ConflictCheckModInfo> = infos.iter().map(|i| (i.mod_id, i)).collect();
    let t = Instant::now();
    let (mut parsed, mut failed, mut no_game, mut identical_changes, mut separate, mut clash, mut opaque) = (0, 0, 0, 0, 0, 0, 0);
    for (asset, mods) in &assets {
        let request = ConflictAssetDiffRequest {
            game_name: None,
            game_pak_path: game.clone(),
            asset_path: asset.clone(),
            mods: mods.iter().map(|id| {
                let i = by_id[id];
                ConflictCheckModInfo { mod_id: i.mod_id, cache_path: i.cache_path.clone(), is_unpacked: i.is_unpacked }
            }).collect(),
        };
        let t1 = Instant::now();
        let diff = conflict_asset_diff(request).unwrap();
        let took = t1.elapsed();
        let errors: Vec<String> = diff.mods.iter().filter_map(|(id, v)| v.error.as_ref().map(|e| format!("{}: {}", names[id], e))).collect();
        if !errors.is_empty() || diff.game.error.is_some() {
            failed += 1;
        } else {
            parsed += 1;
        }
        if !diff.game.found {
            no_game += 1;
        }
        // Per mod: keys it changes vs the game
        let changed = |id: i64| -> Vec<&str> {
            diff.rows.iter().filter(|r| r.mods.get(&id).cloned().flatten().map(|v| v.hash) != r.game.as_ref().map(|g| g.hash.clone())).map(|r| r.key.as_str()).collect()
        };
        let mut verdict = String::new();
        if mods.len() >= 2 {
            let (a, b) = (mods[0], mods[1]);
            let (ca, cb) = (changed(a), changed(b));
            let both: Vec<&&str> = ca.iter().filter(|k| cb.contains(k)).collect();
            let same: Vec<&&&str> = both.iter().filter(|k| {
                let r = diff.rows.iter().find(|r| r.key == ***k).unwrap();
                r.mods.get(&a).cloned().flatten().map(|v| v.hash) == r.mods.get(&b).cloned().flatten().map(|v| v.hash)
            }).collect();
            let unparsed = diff.mods.values().any(|v| v.error.is_some()) || !diff.game.found || diff.game.error.is_some();
            verdict = if unparsed {
                opaque += 1;
                "can't tell".into()
            } else if both.is_empty() {
                separate += 1;
                "different parts".into()
            } else if same.len() == both.len() && ca.len() == cb.len() && ca.len() == both.len() {
                identical_changes += 1;
                "same changes".into()
            } else if same.len() == both.len() {
                separate += 1;
                "same where both change, rest different".into()
            } else {
                clash += 1;
                format!("clash on {}", both.len() - same.len())
            };
            println!(
                "{asset}\t{}\t{} vs {}\tchanges {}/{}\toverlap {} (same {})\trows {}\t{:?}{}",
                verdict,
                names[&a], names[&b], ca.len(), cb.len(), both.len(), same.len(), diff.rows.len(), took,
                if errors.is_empty() { String::new() } else { format!("\terrors: {}", errors.join("; ")) }
            );
        }
        let _ = verdict;
        if let Ok(filter) = std::env::var("DETAIL") {
            if asset.contains(&filter) {
                eprintln!("--- {asset}: game found={} err={:?}", diff.game.found, diff.game.error);
                for row in &diff.rows {
                    let fmt = |v: Option<&mintcat_integrator_api::AssetPartValue>| match v {
                        None => "—".to_string(),
                        Some(v) => format!("{}{}", &v.hash[..6], v.value.as_ref().map(|s| format!("={s}")).unwrap_or_default()),
                    };
                    let cols: Vec<String> = mods.iter().map(|id| format!("{}: {}", names[id], fmt(row.mods.get(id).and_then(|v| v.as_ref())))).collect();
                    eprintln!("  {:<9} {:<36} {:<36} game {} | {}", row.kind, row.owner, row.name, fmt(row.game.as_ref()), cols.join(" | "));
                }
            }
        }
    }
    eprintln!(
        "diffs in {:?}: parsed {parsed}, failed {failed}, not in game {no_game}; same changes {identical_changes}, different parts {separate}, clash {clash}, can't tell {opaque}",
        t.elapsed()
    );
}
