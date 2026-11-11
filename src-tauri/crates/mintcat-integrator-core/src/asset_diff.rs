//! Compare versions of one game asset part by part: the game's original and each mod's copy.
//!
//! When two mods ship the same asset, the one installed later wins and the other mod's copy
//! is never loaded. Knowing *which parts* each mod changed compared to the game tells whether
//! the losing mod loses something important, and whether the two mods change different
//! parts (they could in principle be combined) or the same parts (a real clash).
//!
//! Parts are: properties of the class defaults and of each component/sub-object, each
//! function's code, each event's code inside the event graph, blueprint variables, data
//! table rows, and anything that couldn't be parsed (compared as raw bytes).

use anyhow::{Context, Result};
use mintcat_integrator_api::{AssetDiffRow, AssetPairChanges, AssetPartValue, ModAssetChanges};
use std::collections::{BTreeMap, HashMap};
use std::hash::{Hash, Hasher};
use std::io::Cursor;
use unreal_asset::engine_version::EngineVersion;
use unreal_asset::exports::{Export, ExportBaseTrait, ExportNormalTrait};
use unreal_asset::kismet::{KismetExpression, KismetExpressionTrait};
use unreal_asset::properties::{Property, PropertyDataTrait};
use unreal_asset::reader::archive_trait::ArchiveTrait;
use unreal_asset::types::PackageIndex;
use unreal_asset::Asset;

/// One comparable part of an asset
#[derive(Debug, Clone)]
pub struct AssetPart {
    pub kind: &'static str,
    pub owner: String,
    pub name: String,
    pub hash: String,
    pub value: Option<String>,
}

pub type PartMap = BTreeMap<String, AssetPart>;

fn hash_str(s: &str) -> String {
    let mut hasher = std::collections::hash_map::DefaultHasher::new();
    s.hash(&mut hasher);
    format!("{:016x}", hasher.finish())
}

pub fn hash_bytes(data: &[u8]) -> String {
    let mut hasher = std::collections::hash_map::DefaultHasher::new();
    data.hash(&mut hasher);
    format!("{:016x}-{}", hasher.finish(), data.len())
}

fn name_of(asset: &Asset<Cursor<Vec<u8>>>, index: PackageIndex) -> String {
    object_path(asset, index, 0)
}

/// Readable path of an import or export ("/Script/FSD.FSDWeapon", "WPN_X_C.FP_Mesh")
fn object_path(asset: &Asset<Cursor<Vec<u8>>>, index: PackageIndex, depth: usize) -> String {
    if index.index == 0 || depth > 16 {
        return "None".to_string();
    }
    if index.index < 0 {
        let Some(import) = asset.imports.get((-index.index - 1) as usize) else {
            return format!("import#{}", index.index);
        };
        let name = import.object_name.get_owned_content();
        if import.outer_index.index == 0 {
            name
        } else {
            format!("{}.{}", object_path(asset, import.outer_index, depth + 1), name)
        }
    } else {
        let Some(export) = asset.asset_data.exports.get((index.index - 1) as usize) else {
            return format!("export#{}", index.index);
        };
        let base = export.get_base_export();
        let name = base.object_name.get_owned_content();
        if base.outer_index.index == 0 {
            name
        } else {
            format!("{}.{}", object_path(asset, base.outer_index, depth + 1), name)
        }
    }
}

/// Debug text with every `PackageIndex { index: N }` replaced by the object's path, so two
/// versions whose import/export tables are ordered differently still compare equal.
fn canonical(asset: &Asset<Cursor<Vec<u8>>>, debug: &str) -> String {
    const NEEDLE: &str = "PackageIndex { index: ";
    let mut out = String::with_capacity(debug.len());
    let mut rest = debug;
    while let Some(pos) = rest.find(NEEDLE) {
        out.push_str(&rest[..pos]);
        let after = &rest[pos + NEEDLE.len()..];
        let end = after.find(" }").unwrap_or(after.len());
        match after[..end].trim().parse::<i32>() {
            Ok(n) => {
                out.push('<');
                out.push_str(&object_path(asset, PackageIndex::new(n), 0));
                out.push('>');
                rest = &after[(end + 2).min(after.len())..];
            }
            Err(_) => {
                out.push_str(NEEDLE);
                rest = after;
            }
        }
    }
    out.push_str(rest);
    out
}

/// Rewrites Debug output as it is written, replacing `PackageIndex { index: N }` with the
/// object's path on the fly (see [canonical]) and passing the text on to `out` without
/// building it whole, which can be tens of megabytes for big particle systems or data arrays.
struct CanonicalSink<'a, O: SinkOut> {
    resolve: &'a dyn Fn(i32) -> String,
    out: O,
    /// Pieces of a possible `PackageIndex { index: N }` seen so far
    pending: Vec<String>,
}

trait SinkOut {
    fn put(&mut self, s: &str);
}

impl SinkOut for std::collections::hash_map::DefaultHasher {
    fn put(&mut self, s: &str) {
        self.write(s.as_bytes());
    }
}

impl SinkOut for String {
    fn put(&mut self, s: &str) {
        self.push_str(s);
    }
}

impl<'a, O: SinkOut> CanonicalSink<'a, O> {
    fn new(resolve: &'a dyn Fn(i32) -> String, out: O) -> Self {
        Self { resolve, out, pending: Vec::new() }
    }

    fn flush_pending(&mut self) {
        for piece in std::mem::take(&mut self.pending) {
            self.out.put(&piece);
        }
    }

    fn into_out(mut self) -> O {
        self.flush_pending();
        self.out
    }
}

impl<O: SinkOut> std::fmt::Write for CanonicalSink<'_, O> {
    // Derived Debug writes a struct as separate pieces: "PackageIndex", " { ", "index",
    // ": ", the number, " }". Anything else is passed straight on.
    fn write_str(&mut self, s: &str) -> std::fmt::Result {
        const EXPECTED: [&str; 4] = ["PackageIndex", " { ", "index", ": "];
        let step = self.pending.len();
        if step < EXPECTED.len() {
            if s == EXPECTED[step] {
                self.pending.push(s.to_string());
                return Ok(());
            }
        } else if step == EXPECTED.len() {
            if s.parse::<i32>().is_ok() {
                self.pending.push(s.to_string());
                return Ok(());
            }
        } else if s == " }" {
            let index: i32 = self.pending[EXPECTED.len()].parse().unwrap_or(0);
            self.pending.clear();
            let path = (self.resolve)(index);
            self.out.put("<");
            self.out.put(&path);
            self.out.put(">");
            return Ok(());
        }
        self.flush_pending();
        if s == EXPECTED[0] {
            self.pending.push(s.to_string());
        } else {
            self.out.put(s);
        }
        Ok(())
    }
}

/// Hash of a value's Debug text with references resolved to names (same text as
/// `canonical(format!("{value:?}"))`, without building the big string)
fn canonical_hash<T: std::fmt::Debug + ?Sized>(asset: &Asset<Cursor<Vec<u8>>>, value: &T) -> String {
    use std::fmt::Write;
    let resolve = |n: i32| object_path(asset, PackageIndex::new(n), 0);
    let mut sink = CanonicalSink::new(&resolve, std::collections::hash_map::DefaultHasher::new());
    let _ = write!(sink, "{value:?}");
    format!("{:016x}", sink.into_out().finish())
}

/// Replace the number after each needle with that number minus `base` (jump targets inside
/// a piece of the event graph, so they don't change when code before that piece grows)
fn rebase_offsets(text: &str, needles: &[&str], base: i64) -> String {
    let mut out = text.to_string();
    for needle in needles {
        let mut result = String::with_capacity(out.len());
        let mut rest = out.as_str();
        while let Some(pos) = rest.find(needle) {
            result.push_str(&rest[..pos + needle.len()]);
            let after = &rest[pos + needle.len()..];
            let digits: String = after.chars().take_while(|c| c.is_ascii_digit()).collect();
            match digits.parse::<i64>() {
                Ok(n) => {
                    result.push_str(&format!("@{}", n - base));
                    rest = &after[digits.len()..];
                }
                Err(_) => rest = after,
            }
        }
        result.push_str(rest);
        out = result;
    }
    out
}

/// Code positions inside the event graph (jumps, switch cases, latent action resume points)
const JUMP_NEEDLES: [&str; 5] = [
    "code_offset: ",
    "pushing_address: ",
    "end_goto_offset: ",
    "next_offset: ",
    "ExSkipOffsetConst { token: ExSkipOffsetConst, value: ",
];

/// The entry offset an event stub passes to the event graph
const ENTRY_NEEDLE: &str = "ExIntConst { token: ExIntConst, value: ";

fn mask_numbers_after(text: &str, needle: &str) -> String {
    let mut result = String::with_capacity(text.len());
    let mut rest = text;
    while let Some(pos) = rest.find(needle) {
        result.push_str(&rest[..pos + needle.len()]);
        let after = &rest[pos + needle.len()..];
        let skip = after.chars().take_while(|c| c.is_ascii_digit() || *c == '-').count();
        result.push('#');
        rest = &after[skip..];
    }
    result.push_str(rest);
    result
}

fn short(text: String) -> String {
    const MAX: usize = 160;
    if text.chars().count() > MAX {
        let cut: String = text.chars().take(MAX - 1).collect();
        format!("{cut}…")
    } else {
        text
    }
}

fn trim_float(v: f64) -> String {
    let s = format!("{v:.4}");
    let s = s.trim_end_matches('0').trim_end_matches('.');
    if s.is_empty() || s == "-" { "0".to_string() } else { s.to_string() }
}

/// Short readable value for the property kinds people care about (numbers, toggles, names)
fn display_value(asset: &Asset<Cursor<Vec<u8>>>, prop: &Property) -> Option<String> {
    use unreal_asset::properties::int_property::BytePropertyValue;
    let text = match prop {
        Property::BoolProperty(p) => p.value.to_string(),
        Property::IntProperty(p) => p.value.to_string(),
        Property::Int8Property(p) => p.value.to_string(),
        Property::Int16Property(p) => p.value.to_string(),
        Property::Int64Property(p) => p.value.to_string(),
        Property::UInt16Property(p) => p.value.to_string(),
        Property::UInt32Property(p) => p.value.to_string(),
        Property::UInt64Property(p) => p.value.to_string(),
        Property::FloatProperty(p) => trim_float(p.value.0 as f64),
        Property::DoubleProperty(p) => trim_float(p.value.0),
        Property::ByteProperty(p) => match &p.value {
            BytePropertyValue::Byte(b) => b.to_string(),
            BytePropertyValue::FName(n) => n.get_owned_content(),
        },
        Property::EnumProperty(p) => p.value.as_ref().map(|v| v.get_owned_content()).unwrap_or_default(),
        Property::NameProperty(p) => p.value.get_owned_content(),
        Property::StrProperty(p) => format!("\"{}\"", p.value.clone().unwrap_or_default()),
        Property::TextProperty(p) => format!("\"{}\"", p.culture_invariant_string.clone().unwrap_or_default()),
        Property::ObjectProperty(p) => {
            let path = name_of(asset, p.value);
            path.rsplit('.').next().unwrap_or(&path).to_string()
        }
        Property::SoftObjectProperty(p) => {
            let debug = format!("{:?}", p.value);
            // "...asset_name: Backed { value: \"WPN_X\" ..." → keep it short and readable
            debug.split("value: \"").nth(2).or_else(|| debug.split("value: \"").nth(1))
                .and_then(|s| s.split('"').next()).unwrap_or("").to_string()
        }
        Property::ArrayProperty(p) => {
            // The count first: when the items are long, that's what tells versions apart
            let items: Vec<String> = p.value.iter().take(6).filter_map(|v| display_value(asset, v)).collect();
            if !p.value.is_empty() && p.value.len() <= 6 && items.len() == p.value.len() {
                format!("{} item(s): [{}]", p.value.len(), items.join(", "))
            } else {
                format!("{} item(s)", p.value.len())
            }
        }
        Property::LinearColorProperty(p) => format!(
            "rgba({}, {}, {}, {})",
            trim_float(p.color.r.0 as f64), trim_float(p.color.g.0 as f64),
            trim_float(p.color.b.0 as f64), trim_float(p.color.a.0 as f64)
        ),
        // FColor is read as one little-endian ARGB int, so the fields hold A, R, G, B
        Property::ColorProperty(p) => {
            let (a, r, g, b) = (p.color.r, p.color.g, p.color.b, p.color.a);
            if a == 0xff { format!("#{r:02x}{g:02x}{b:02x}") } else { format!("#{r:02x}{g:02x}{b:02x}{a:02x}") }
        }
        Property::StructProperty(p) if p.value.len() == 1 => return display_value(asset, &p.value[0]),
        Property::StructProperty(p) => {
            // Small structs of simple values (e.g. a min/max pair) are shown inline
            if p.value.len() <= 4 {
                let inner: Vec<String> = p.value.iter()
                    .filter_map(|v| display_value(asset, v).map(|t| format!("{}={}", v.get_name().get_owned_content(), t)))
                    .collect();
                if inner.len() == p.value.len() && !inner.is_empty() {
                    format!("{{{}}}", inner.join(", "))
                } else {
                    return None;
                }
            } else {
                return None;
            }
        }
        Property::VectorProperty(p) => format!("({}, {}, {})", trim_float(p.value.x.0), trim_float(p.value.y.0), trim_float(p.value.z.0)),
        Property::RotatorProperty(p) => format!("({}, {}, {})", trim_float(p.value.x.0), trim_float(p.value.y.0), trim_float(p.value.z.0)),
        _ => return None,
    };
    Some(short(text))
}

fn prop_key_name(prop: &Property) -> String {
    let name = prop.get_name().get_owned_content();
    let dup = prop.get_duplication_index();
    if dup > 0 { format!("{name}[{dup}]") } else { name }
}

fn is_ubergraph(name: &str) -> bool {
    name.starts_with("ExecuteUbergraph_")
}

/// Calls into the event graph made by an event stub: (event graph export, entry offset)
fn ubergraph_entries(code: &[KismetExpression]) -> Vec<(PackageIndex, i64)> {
    let mut out = Vec::new();
    for ex in code {
        let (node, params) = match ex {
            KismetExpression::ExLocalFinalFunction(f) => (f.stack_node, &f.parameters),
            KismetExpression::ExFinalFunction(f) => (f.stack_node, &f.parameters),
            _ => continue,
        };
        if let Some(KismetExpression::ExIntConst(entry)) = params.first() {
            out.push((node, entry.value as i64));
        }
    }
    out
}

fn expression_size(asset: &Asset<Cursor<Vec<u8>>>, ex: &KismetExpression) -> Option<usize> {
    let mut buf = Cursor::new(vec![]);
    let mut writer = unreal_asset::reader::raw_writer::RawWriter::new(
        &mut buf,
        asset.get_object_version(),
        asset.get_object_version_ue5(),
        false,
        unreal_asset::containers::NameMap::new(),
    );
    ex.write(&mut writer).ok().map(|n| n + 1)
}

/// Parse an asset (uasset + uexp) and list its parts
pub fn asset_parts(uasset: Vec<u8>, uexp: Option<Vec<u8>>, version: EngineVersion) -> Result<PartMap> {
    let asset = Asset::new(Cursor::new(uasset), uexp.map(Cursor::new), version, None, false)
        .context("couldn't read the asset")?;
    let mut parts = PartMap::new();
    let mut add = |key: String, part: AssetPart| {
        parts.insert(key, part);
    };

    // Event stubs: which event starts where in each event graph
    let mut entries: HashMap<PackageIndex, Vec<(i64, String)>> = HashMap::new();
    for export in &asset.asset_data.exports {
        if let Export::FunctionExport(f) = export {
            let name = f.get_base_export().object_name.get_owned_content();
            if is_ubergraph(&name) {
                continue;
            }
            if let Some(code) = &f.struct_export.script_bytecode {
                for (node, offset) in ubergraph_entries(code) {
                    if node.index > 0 {
                        entries.entry(node).or_default().push((offset, name.clone()));
                    }
                }
            }
        }
    }

    for (i, export) in asset.asset_data.exports.iter().enumerate() {
        let index = PackageIndex::new(i as i32 + 1);
        let path = name_of(&asset, index);
        let base = export.get_base_export();
        let object_name = base.object_name.get_owned_content();
        let class = name_of(&asset, base.class_index);
        let class_short = class.rsplit('.').next().unwrap_or(&class).to_string();

        match export {
            Export::FunctionExport(f) => {
                let code = &f.struct_export.script_bytecode;
                if is_ubergraph(&object_name) {
                    if let Some(code) = code {
                        add_event_graph_parts(&asset, index, &object_name, code, entries.get(&index), &mut add);
                    }
                    continue;
                }
                let signature = canonical_hash(&asset, &f.struct_export.loaded_properties);
                let body = match code {
                    // An event stub only says "run the event graph from offset N"; N moves
                    // whenever the graph changes, so it's not a change of the stub
                    Some(code) if ubergraph_entries(code).iter().any(|(node, _)| node.index > 0) => {
                        hash_str(&mask_numbers_after(&canonical(&asset, &format!("{code:?}")), ENTRY_NEEDLE))
                    }
                    Some(code) => canonical_hash(&asset, code),
                    None => hash_bytes(f.struct_export.script_bytecode_raw.as_deref().unwrap_or(&[])),
                };
                let flags = format!("{:?}", f.function_flags);
                add(format!("fn:{path}"), AssetPart {
                    kind: "function",
                    owner: outer_name(&asset, base.outer_index),
                    name: object_name.clone(),
                    hash: hash_str(&format!("{signature}|{flags}|{body}")),
                    value: None,
                });
            }
            Export::ClassExport(c) => {
                for prop in &c.struct_export.loaded_properties {
                    let generic = crate::uasset_utils::splice::get_generic_property(prop);
                    let name = generic.name.get_owned_content();
                    add(format!("var:{path}:{name}"), AssetPart {
                        kind: "variable",
                        owner: object_name.clone(),
                        name,
                        hash: canonical_hash(&asset, prop),
                        value: Some(short(format!("{:?}", prop).split('(').next().unwrap_or("").to_string()))
                            .filter(|s| !s.is_empty()),
                    });
                }
                let parent = name_of(&asset, c.struct_export.super_struct);
                let interfaces: Vec<String> = c.interfaces.iter().map(|i| name_of(&asset, i.class)).collect();
                add(format!("class:{path}"), AssetPart {
                    kind: "class",
                    owner: object_name.clone(),
                    name: object_name.clone(),
                    hash: hash_str(&format!("{parent}|{interfaces:?}|{:?}", c.class_flags)),
                    value: Some(short(parent.rsplit('.').next().unwrap_or(&parent).to_string())),
                });
            }
            Export::DataTableExport(d) => {
                for (n, row) in d.table.data.iter().enumerate() {
                    let row_name = row.name.get_owned_content();
                    add(format!("row:{path}:{row_name}#{n}"), AssetPart {
                        kind: "row",
                        owner: object_name.clone(),
                        name: row_name,
                        hash: canonical_hash(&asset, &row.value),
                        value: None,
                    });
                }
            }
            Export::RawExport(r) => {
                add(format!("raw:{path}"), AssetPart {
                    kind: "data",
                    owner: object_name.clone(),
                    name: object_name.clone(),
                    hash: hash_bytes(&r.data),
                    value: None,
                });
            }
            _ => {}
        }

        // Every object exists (or not) in a version: catches added/removed components
        if !matches!(export, Export::FunctionExport(_)) {
            add(format!("export:{path}"), AssetPart {
                kind: "export",
                owner: object_name.clone(),
                name: object_name.clone(),
                hash: hash_str(&format!("{class}|{}", name_of(&asset, base.template_index))),
                value: Some(class_short.clone()),
            });
        }

        if let Some(normal) = export.get_normal_export() {
            let kind = if object_name.starts_with("Default__") { "property" } else { "component" };
            for prop in &normal.properties {
                let name = prop_key_name(prop);
                add(format!("prop:{path}:{name}"), AssetPart {
                    kind,
                    owner: object_name.clone(),
                    name,
                    hash: canonical_hash(&asset, prop),
                    value: display_value(&asset, prop),
                });
            }
            if !normal.extras.is_empty() && !matches!(export, Export::FunctionExport(_) | Export::ClassExport(_)) {
                add(format!("extra:{path}"), AssetPart {
                    kind: "data",
                    owner: object_name.clone(),
                    name: format!("{object_name} ({class_short} data)"),
                    hash: hash_bytes(&normal.extras),
                    value: None,
                });
            }
        }
    }
    Ok(parts)
}

fn outer_name(asset: &Asset<Cursor<Vec<u8>>>, outer: PackageIndex) -> String {
    let path = name_of(asset, outer);
    path.rsplit('.').next().unwrap_or(&path).to_string()
}

/// Split the event graph into one part per event (code from its entry point up to the next
/// event's), so a mod that changes one event doesn't look like it changed all of them.
fn add_event_graph_parts(
    asset: &Asset<Cursor<Vec<u8>>>,
    index: PackageIndex,
    graph_name: &str,
    code: &[KismetExpression],
    entries: Option<&Vec<(i64, String)>>,
    add: &mut impl FnMut(String, AssetPart),
) {
    let mut starts: Vec<(i64, String)> = entries.cloned().unwrap_or_default();
    starts.sort();
    starts.dedup_by(|a, b| a.0 == b.0);
    let mut offset: i64 = 0;
    let mut pieces: BTreeMap<usize, (String, i64, String)> = BTreeMap::new();
    let mut sizes_ok = true;
    for ex in code {
        // Which event this statement belongs to: the last entry point at or before it
        let slot = starts.iter().rposition(|(start, _)| *start <= offset);
        let (key, name, base) = match slot {
            Some(n) => (n + 1, starts[n].1.clone(), starts[n].0),
            None => (0, "(shared code)".to_string(), 0),
        };
        let text = rebase_offsets(&canonical(asset, &format!("{ex:?}")), &JUMP_NEEDLES, base);
        let entry = pieces.entry(key).or_insert_with(|| (name, base, String::new()));
        entry.2.push_str(&text);
        entry.2.push('\n');
        match expression_size(asset, ex) {
            Some(size) => offset += size as i64,
            None => {
                sizes_ok = false;
                break;
            }
        }
    }
    let path = name_of(asset, index);
    if !sizes_ok || starts.is_empty() {
        // Can't split it: one part for the whole graph
        add(format!("graph:{path}"), AssetPart {
            kind: "event",
            owner: graph_name.to_string(),
            name: "(event graph)".to_string(),
            hash: canonical_hash(asset, code),
            value: None,
        });
        return;
    }
    for (_, (name, _, text)) in pieces {
        add(format!("graph:{path}:{name}"), AssetPart {
            kind: "event",
            owner: graph_name.to_string(),
            name,
            hash: hash_str(&text),
            value: None,
        });
    }
}

/// One version of the asset to compare. `files` maps extension (".uasset", ".uexp",
/// ".umap"...) to the file's bytes.
pub struct VersionInput {
    pub files: HashMap<String, Vec<u8>>,
}

pub struct VersionParts {
    pub parts: Option<PartMap>,
    pub error: Option<String>,
    pub file_hash: Option<String>,
    /// Compared object by object only (the file couldn't be read in detail)
    pub shallow: bool,
}

/// Classes whose files the asset reader can't read in detail (and can take seconds and
/// gigabytes of memory trying): particle systems
fn is_shallow_class(class: &str) -> bool {
    class.contains("Niagara")
}

/// Object-by-object comparison from the file's table of contents: each object's stored
/// bytes are compared as a whole (no property detail).
fn object_parts(uasset: &[u8], uexp: Option<&[u8]>, version: EngineVersion) -> Result<PartMap> {
    let asset = Asset::new(Cursor::new(uasset.to_vec()), uexp.map(|d| Cursor::new(d.to_vec())), version, None, true)
        .context("couldn't read the asset's table of contents")?;
    let mut combined = uasset.to_vec();
    if let Some(uexp) = uexp {
        combined.extend_from_slice(uexp);
    }
    let mut parts = PartMap::new();
    for (i, export) in asset.asset_data.exports.iter().enumerate() {
        let base = export.get_base_export();
        let path = name_of(&asset, PackageIndex::new(i as i32 + 1));
        let class = name_of(&asset, base.class_index);
        let start = base.serial_offset.max(0) as usize;
        let end = start.saturating_add(base.serial_size.max(0) as usize);
        let data = combined.get(start..end).unwrap_or(&[]);
        parts.insert(format!("obj:{path}"), AssetPart {
            kind: "object",
            owner: outer_name(&asset, base.outer_index),
            name: base.object_name.get_owned_content(),
            hash: hash_bytes(data),
            value: Some(class.rsplit('.').next().unwrap_or(&class).to_string()),
        });
    }
    Ok(parts)
}

fn export_classes(uasset: &[u8], uexp: Option<&[u8]>, version: EngineVersion) -> Option<Vec<String>> {
    let asset = Asset::new(Cursor::new(uasset.to_vec()), uexp.map(|d| Cursor::new(d.to_vec())), version, None, true).ok()?;
    Some(asset.asset_data.exports.iter().map(|e| name_of(&asset, e.get_base_export().class_index)).collect())
}

/// Read one version's parts. `force_shallow` compares object by object (used for every
/// version of an asset as soon as one of them can only be read that way, so keys match).
pub fn read_version(input: &VersionInput, version: EngineVersion, force_shallow: bool) -> VersionParts {
    let main = input.files.get(".uasset").or_else(|| input.files.get(".umap"));
    let mut whole = Vec::new();
    let mut exts: Vec<&String> = input.files.keys().collect();
    exts.sort();
    for ext in exts {
        whole.extend_from_slice(ext.as_bytes());
        whole.extend_from_slice(&input.files[ext]);
    }
    let file_hash = (!input.files.is_empty()).then(|| hash_bytes(&whole));
    let Some(main) = main else {
        return VersionParts { parts: None, error: None, file_hash, shallow: false };
    };
    let uexp = input.files.get(".uexp").map(|v| v.as_slice());
    // A bug in the asset reader must not take the whole app down
    let shallow = |error: Option<String>| {
        match std::panic::catch_unwind(|| object_parts(main, uexp, version)) {
            Ok(Ok(parts)) => VersionParts { parts: Some(parts), error, file_hash: file_hash.clone(), shallow: true },
            Ok(Err(e)) => VersionParts { parts: None, error: Some(format!("{e:#}")), file_hash: file_hash.clone(), shallow: true },
            Err(_) => VersionParts { parts: None, error: Some("the asset reader crashed on this file".into()), file_hash: file_hash.clone(), shallow: true },
        }
    };
    if force_shallow {
        return shallow(None);
    }
    let classes = std::panic::catch_unwind(|| export_classes(main, uexp, version)).ok().flatten();
    if classes.as_ref().is_some_and(|c| c.iter().any(|class| is_shallow_class(class))) {
        return shallow(None);
    }
    let parsed = std::panic::catch_unwind(|| asset_parts(main.clone(), uexp.map(|d| d.to_vec()), version));
    match parsed {
        Ok(Ok(parts)) => VersionParts { parts: Some(parts), error: None, file_hash, shallow: false },
        Ok(Err(error)) => shallow(Some(format!("{error:#}"))),
        Err(_) => shallow(Some("the asset reader crashed on this file".into())),
    }
}

/// Read every version of one asset so they can be compared: if any of them can only be
/// read object by object, all of them are read that way.
pub fn read_versions(inputs: &[&VersionInput], version: EngineVersion) -> Vec<VersionParts> {
    let first: Vec<VersionParts> = inputs.iter().map(|i| read_version(i, version, false)).collect();
    if first.iter().any(|v| v.shallow) && first.iter().any(|v| !v.shallow && v.parts.is_some()) {
        inputs.iter().map(|i| read_version(i, version, true)).collect()
    } else {
        first
    }
}

fn to_value(part: &AssetPart) -> AssetPartValue {
    AssetPartValue { hash: part.hash.clone(), value: part.value.clone() }
}

/// Rows for every part that isn't identical in all versions (game included when present)
pub fn diff_rows(game: Option<&PartMap>, mods: &[(i64, Option<&PartMap>)]) -> Vec<AssetDiffRow> {
    let mut keys: BTreeMap<&String, &AssetPart> = BTreeMap::new();
    if let Some(game) = game {
        for (k, p) in game {
            keys.insert(k, p);
        }
    }
    for (_, parts) in mods {
        if let Some(parts) = parts {
            for (k, p) in parts.iter() {
                keys.entry(k).or_insert(p);
            }
        }
    }
    let mut rows = Vec::new();
    for (key, sample) in keys {
        let game_value = game.and_then(|g| g.get(key)).map(to_value);
        let mut values = HashMap::new();
        let mut all_same = true;
        let mut first: Option<Option<AssetPartValue>> = game.map(|_| game_value.clone());
        for (mod_id, parts) in mods {
            let Some(parts) = parts else { continue };
            let value = parts.get(key).map(to_value);
            match &first {
                None => first = Some(value.clone()),
                Some(f) => {
                    if f.as_ref().map(|v| &v.hash) != value.as_ref().map(|v| &v.hash) {
                        all_same = false;
                    }
                }
            }
            values.insert(*mod_id, value);
        }
        if all_same {
            continue;
        }
        rows.push(AssetDiffRow {
            key: key.clone(),
            kind: sample.kind.to_string(),
            owner: sample.owner.clone(),
            name: sample.name.clone(),
            game: game_value,
            mods: values,
        });
    }
    rows
}

/// Kinds of parts that are plain values (could be copied from one version into another)
fn is_value_kind(kind: &str) -> bool {
    matches!(kind, "property" | "component")
}

fn example_name(part: &AssetPart) -> String {
    format!("{}|{}|{}", part.kind, part.owner, part.name)
}

/// What each mod changes and how each pair of mods relates. With the game's parts, a mod's
/// changes are the parts that differ from the game; without them (a file mods added, or the
/// game's copy couldn't be read) mods are compared with each other only.
pub fn summarize(
    game: Option<&PartMap>,
    mods: &[(i64, Option<&PartMap>)],
) -> (HashMap<i64, ModAssetChanges>, Vec<AssetPairChanges>) {
    const EXAMPLES: usize = 6;
    let changed_keys = |parts: &PartMap| -> Vec<String> {
        match game {
            Some(game) => {
                let mut keys: Vec<String> = parts
                    .iter()
                    .filter(|(k, p)| game.get(*k).map(|g| &g.hash) != Some(&p.hash))
                    .map(|(k, _)| k.clone())
                    .collect();
                keys.extend(game.keys().filter(|k| !parts.contains_key(*k)).cloned());
                keys.sort();
                keys
            }
            None => parts.keys().cloned().collect(),
        }
    };
    let part_of = |parts: &PartMap, key: &str| -> Option<AssetPart> {
        parts.get(key).cloned().or_else(|| game.and_then(|g| g.get(key).cloned()))
    };

    let mut per_mod = HashMap::new();
    let mut changes: HashMap<i64, Vec<String>> = HashMap::new();
    for (id, parts) in mods {
        let Some(parts) = parts else { continue };
        let keys = changed_keys(parts);
        let mut summary = ModAssetChanges { found: true, changed: keys.len(), ..Default::default() };
        for key in &keys {
            if let Some(part) = part_of(parts, key) {
                *summary.kinds.entry(part.kind.to_string()).or_default() += 1;
                if summary.examples.len() < EXAMPLES {
                    summary.examples.push(example_name(&part));
                }
            }
        }
        per_mod.insert(*id, summary);
        changes.insert(*id, keys);
    }

    let mut pairs = Vec::new();
    for (i, (a, pa)) in mods.iter().enumerate() {
        for (b, pb) in mods.iter().skip(i + 1) {
            let (Some(pa), Some(pb)) = (pa, pb) else { continue };
            let mut pair = AssetPairChanges { a: *a, b: *b, only_a_values: true, only_b_values: true, ..Default::default() };
            if game.is_some() {
                let ca: std::collections::HashSet<&String> = changes[a].iter().collect();
                let cb: std::collections::HashSet<&String> = changes[b].iter().collect();
                for key in ca.union(&cb) {
                    let (in_a, in_b) = (ca.contains(key), cb.contains(key));
                    let same = pa.get(*key).map(|p| &p.hash) == pb.get(*key).map(|p| &p.hash);
                    let kind = part_of(pa, key).or_else(|| part_of(pb, key)).map(|p| p.kind).unwrap_or("data");
                    if in_a && in_b {
                        if same {
                            pair.same += 1;
                        } else {
                            pair.clash += 1;
                            if pair.clash_examples.len() < EXAMPLES {
                                if let Some(part) = part_of(pa, key).or_else(|| part_of(pb, key)) {
                                    pair.clash_examples.push(example_name(&part));
                                }
                            }
                        }
                    } else if in_a {
                        pair.only_a += 1;
                        pair.only_a_values &= is_value_kind(kind);
                    } else {
                        pair.only_b += 1;
                        pair.only_b_values &= is_value_kind(kind);
                    }
                }
            } else {
                // Compared with each other only: equal parts are "same", differing ones clash
                let keys: std::collections::BTreeSet<&String> = pa.keys().chain(pb.keys()).collect();
                for key in keys {
                    match (pa.get(key), pb.get(key)) {
                        (Some(x), Some(y)) if x.hash == y.hash => pair.same += 1,
                        (Some(x), Some(_)) => {
                            pair.clash += 1;
                            if pair.clash_examples.len() < EXAMPLES {
                                pair.clash_examples.push(example_name(x));
                            }
                        }
                        (Some(x), None) => {
                            pair.only_a += 1;
                            pair.only_a_values &= is_value_kind(x.kind);
                        }
                        (None, Some(y)) => {
                            pair.only_b += 1;
                            pair.only_b_values &= is_value_kind(y.kind);
                        }
                        (None, None) => {}
                    }
                }
            }
            pairs.push(pair);
        }
    }
    (per_mod, pairs)
}

#[cfg(test)]
mod tests {
    use super::*;

    fn part(kind: &'static str, name: &str, hash: &str) -> AssetPart {
        AssetPart { kind, owner: "Default__X_C".into(), name: name.into(), hash: hash.into(), value: None }
    }

    #[test]
    fn summary_tells_separate_changes_from_clashes() {
        let mut game = PartMap::new();
        game.insert("prop:rate".into(), part("property", "Rate", "g1"));
        game.insert("prop:anims".into(), part("property", "Anims", "g2"));
        game.insert("fn:fire".into(), part("function", "Fire", "g3"));
        // a: adds a setting (like AutoFireTrigger's HasAutomaticFire)
        let mut a = game.clone();
        a.insert("prop:auto".into(), part("property", "Auto", "a1"));
        // b: changes another setting (like Random Weapon Inspect's animation list)
        let mut b = game.clone();
        b.insert("prop:anims".into(), part("property", "Anims", "b1"));
        let (mods, pairs) = summarize(Some(&game), &[(1, Some(&a)), (2, Some(&b))]);
        assert_eq!(mods[&1].changed, 1);
        assert_eq!(mods[&2].changed, 1);
        assert_eq!(pairs.len(), 1);
        let p = &pairs[0];
        assert_eq!((p.same, p.clash, p.only_a, p.only_b), (0, 0, 1, 1));
        assert!(p.only_a_values && p.only_b_values);

        // c: changes the same setting as b, differently, and edits code
        let mut c = game.clone();
        c.insert("prop:anims".into(), part("property", "Anims", "c1"));
        c.insert("fn:fire".into(), part("function", "Fire", "c2"));
        let (_, pairs) = summarize(Some(&game), &[(2, Some(&b)), (3, Some(&c))]);
        let p = &pairs[0];
        assert_eq!((p.same, p.clash, p.only_a, p.only_b), (0, 1, 0, 1));
        assert!(!p.only_b_values);
        assert_eq!(p.clash_examples, vec!["property|Default__X_C|Anims".to_string()]);
    }

    #[test]
    fn summary_without_the_game_compares_mods_directly() {
        let mut a = PartMap::new();
        a.insert("prop:icon".into(), part("component", "Icon", "1"));
        let b = a.clone();
        let (_, pairs) = summarize(None, &[(1, Some(&a)), (2, Some(&b))]);
        assert_eq!((pairs[0].same, pairs[0].clash), (1, 0));
    }

    #[test]
    fn streaming_hash_matches_text_substitution() {
        #[derive(Debug)]
        #[allow(dead_code)]
        struct Holder { a: PackageIndex, list: Vec<PackageIndex>, n: i32 }
        // No asset needed for index 0 ("None")
        let value = Holder { a: PackageIndex::new(0), list: vec![PackageIndex::new(0)], n: 7 };
        let text = format!("{value:?}");
        assert!(text.contains("PackageIndex { index: 0 }"));
        let expected = text.replace("PackageIndex { index: 0 }", "<None>");
        let resolve = |n: i32| if n == 0 { "None".to_string() } else { format!("obj{n}") };
        let mut sink = CanonicalSink::new(&resolve, String::new());
        use std::fmt::Write;
        write!(sink, "{value:?}").unwrap();
        assert_eq!(sink.into_out(), expected);
        // A lone "PackageIndex" text that isn't the struct is kept as is
        let mut sink = CanonicalSink::new(&resolve, String::new());
        write!(sink, "{:?}", ("PackageIndex", 5)).unwrap();
        assert_eq!(sink.into_out(), format!("{:?}", ("PackageIndex", 5)));
    }

    #[test]
    fn rebasing_keeps_relative_jumps() {
        let a = rebase_offsets("ExJump { code_offset: 120 }", &JUMP_NEEDLES, 100);
        let b = rebase_offsets("ExJump { code_offset: 220 }", &JUMP_NEEDLES, 200);
        assert_eq!(a, b);
        assert_eq!(a, "ExJump { code_offset: @20 }");
    }

    #[test]
    fn rows_only_for_parts_that_differ() {
        let part = |hash: &str| AssetPart { kind: "property", owner: "Default__X".into(), name: "Rate".into(), hash: hash.into(), value: None };
        let mut game = PartMap::new();
        game.insert("prop:a".into(), part("1"));
        game.insert("prop:b".into(), part("1"));
        let mut one = game.clone();
        one.insert("prop:a".into(), part("2"));
        let mut two = game.clone();
        two.insert("prop:c".into(), part("3"));
        let rows = diff_rows(Some(&game), &[(1, Some(&one)), (2, Some(&two))]);
        let keys: Vec<&str> = rows.iter().map(|r| r.key.as_str()).collect();
        assert_eq!(keys, vec!["prop:a", "prop:c"]);
        assert_eq!(rows[1].game, None);
        assert_eq!(rows[1].mods[&1], None);
        assert!(rows[1].mods[&2].is_some());
    }

    #[test]
    fn without_the_game_mods_are_compared_to_each_other() {
        let part = |hash: &str| AssetPart { kind: "function", owner: "X".into(), name: "F".into(), hash: hash.into(), value: None };
        let mut one = PartMap::new();
        one.insert("fn:a".into(), part("1"));
        one.insert("fn:b".into(), part("1"));
        let mut two = one.clone();
        two.insert("fn:b".into(), part("2"));
        let rows = diff_rows(None, &[(1, Some(&one)), (2, Some(&two))]);
        assert_eq!(rows.len(), 1);
        assert_eq!(rows[0].key, "fn:b");
    }
}
