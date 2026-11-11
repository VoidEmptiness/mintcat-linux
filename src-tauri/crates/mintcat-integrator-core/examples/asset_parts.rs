//! Dev tool: list the parts of an asset, or diff versions of one.
//! usage: asset_parts <base path without extension> [more versions...]
use mintcat_integrator_core::asset_diff::{diff_rows, read_versions, VersionInput};
use std::collections::HashMap;
use unreal_asset::engine_version::EngineVersion;

fn load(base: &str) -> VersionInput {
    let mut files = HashMap::new();
    for ext in [".uasset", ".uexp", ".umap", ".ubulk"] {
        if let Ok(data) = std::fs::read(format!("{base}{ext}")) {
            files.insert(ext.to_string(), data);
        }
    }
    VersionInput { files }
}

fn main() {
    let args: Vec<String> = std::env::args().skip(1).collect();
    let inputs: Vec<VersionInput> = args.iter().map(|a| load(a)).collect();
    let refs: Vec<&VersionInput> = inputs.iter().collect();
    let versions = read_versions(&refs, EngineVersion::VER_UE4_27);
    for (a, v) in args.iter().zip(&versions) {
        eprintln!("{a}: parts={:?} error={:?} shallow={}", v.parts.as_ref().map(|p| p.len()), v.error, v.shallow);
    }
    if args.len() == 1 {
        if let Some(parts) = &versions[0].parts {
            for (k, p) in parts {
                println!("{k}\t{}\t{}\t{}\t{:?}", p.kind, p.owner, p.name, p.value);
            }
        }
        return;
    }
    let game = versions[0].parts.as_ref();
    let mods: Vec<(i64, Option<&_>)> = versions[1..].iter().enumerate().map(|(i, v)| (i as i64 + 1, v.parts.as_ref())).collect();
    for row in diff_rows(game, &mods) {
        let fmt = |v: &Option<mintcat_integrator_api::AssetPartValue>| match v {
            None => "—".to_string(),
            Some(v) => format!("{}{}", &v.hash[..6], v.value.as_ref().map(|s| format!("={s}")).unwrap_or_default()),
        };
        let mut cols = vec![fmt(&row.game)];
        for i in 1..versions.len() {
            cols.push(fmt(row.mods.get(&(i as i64)).unwrap_or(&None)));
        }
        println!("{:<10} {:<40} {:<40} {}", row.kind, row.owner, row.name, cols.join(" | "));
    }
}
