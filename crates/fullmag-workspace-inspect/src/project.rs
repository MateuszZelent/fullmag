//! Reading a Fullmag project (`.fms`) for lists and inspectors: the facts the
//! start screen shows without opening the project in a document session.
//!
//! The summary is read from the scene, so it needs no solver and no run. A
//! field the scene does not state is left out, never guessed.

use fullmag_application::{FileProjectRepository, ProjectRepository, ProjectSource};
use fullmag_workspace::ItemStatus;
use serde_json::{json, Map, Value};
use sha2::{Digest, Sha256};
use std::fs;
use std::path::{Path, PathBuf};
use std::time::{SystemTime, UNIX_EPOCH};

/// Archives larger than this are reported unreadable rather than loaded.
pub const MAX_PROJECT_ARCHIVE_BYTES: u64 = 64 * 1024 * 1024;

/// Where a project stores the preview of its last result (design 6.2).
pub const THUMBNAIL_PATH: &str = "project/preview/thumb.png";
/// Previews are inlined as data URIs, so the cap is the design's target size,
/// not its hard limit: a larger preview is left out, never truncated.
pub const MAX_INLINE_THUMBNAIL_BYTES: usize = fullmag_workspace::MAX_THUMBNAIL_BYTES;
pub const PNG_SIGNATURE: [u8; 8] = fullmag_workspace::PNG_SIGNATURE;

pub fn sha256_hex(bytes: &[u8]) -> String {
    format!("{:x}", Sha256::digest(bytes))
}

/// What reading one archive on disk yields, ready for the database. An archive
/// that cannot be read is still a result, as `failed` with the reason, so a
/// corrupt project is visible rather than silently absent.
pub struct ScannedProject {
    pub path: PathBuf,
    pub name: String,
    /// `None` for an archive that could not be read.
    pub project_id: Option<String>,
    pub status: ItemStatus,
    /// Merge patch for the item's `meta`; `null` clears a key.
    pub meta: Value,
    /// The stored preview, when it is a PNG within the inline cap.
    pub thumbnail: Option<Vec<u8>>,
}

pub fn scan_archive(path: &Path) -> ScannedProject {
    let stem = path
        .file_stem()
        .and_then(|s| s.to_str())
        .unwrap_or("project")
        .to_string();
    let file = fs::metadata(path).ok();
    let size = file.as_ref().map(|m| m.len());
    let created = file.as_ref().and_then(|m| m.created().ok());

    let mut meta = Map::new();
    if let Some(created) = created {
        meta.insert("created_at".into(), Value::String(rfc3339_utc(created)));
    }

    let loaded = if size.is_some_and(|s| s > MAX_PROJECT_ARCHIVE_BYTES) {
        Err(format!(
            "archive exceeds {MAX_PROJECT_ARCHIVE_BYTES} byte limit"
        ))
    } else {
        FileProjectRepository::new()
            .open(ProjectSource::Path(path.to_path_buf()))
            .map_err(|error| error.to_string())
    };

    match loaded {
        Ok(opened) => {
            let definition = &opened.envelope.definition;
            meta.insert("revision".into(), json!(definition.revision));
            meta.insert(
                "schema_version".into(),
                Value::String(short_schema_version(&opened.migration.source_schema)),
            );
            meta.insert(
                "solver".into(),
                Value::String(solver_from_scene(definition.scene.value()).to_lowercase()),
            );
            let authors = opened
                .envelope
                .opaque_documents
                .iter()
                .find(|document| document.path() == crate::provenance::PROVENANCE_PATH)
                .and_then(|document| crate::provenance::parse_provenance(document.bytes()).ok())
                .and_then(|value| value.get("authors").and_then(Value::as_array).cloned())
                .unwrap_or_default();
            meta.insert(
                "authors".into(),
                if authors.is_empty() {
                    Value::Null
                } else {
                    Value::Array(authors)
                },
            );
            meta.insert(
                "summary".into(),
                summary_from_scene(definition.scene.value()).unwrap_or(Value::Null),
            );
            meta.insert("last_error".into(), Value::Null);
            let thumbnail = opened
                .envelope
                .opaque_documents
                .iter()
                .find(|document| document.path() == THUMBNAIL_PATH)
                .map(|document| document.bytes().to_vec())
                .filter(|bytes| is_inlinable_png(bytes));
            let status = if opened.read_only_reason.is_some() {
                ItemStatus::Readonly
            } else if opened.migration.source_schema != opened.migration.target_schema {
                ItemStatus::Migrate
            } else {
                ItemStatus::Ready
            };
            if let Some(reason) = opened.read_only_reason {
                meta.insert("mode".into(), Value::String("read_only".into()));
                meta.insert("mode_reason".into(), Value::String(reason));
            } else {
                meta.insert("mode".into(), Value::String("read_write".into()));
                meta.insert("mode_reason".into(), Value::Null);
            }
            ScannedProject {
                path: path.to_path_buf(),
                name: definition.name.clone(),
                project_id: Some(definition.project_id.as_str().to_string()),
                status,
                meta: Value::Object(meta),
                thumbnail,
            }
        }
        Err(reason) => {
            for stale in [
                "revision",
                "schema_version",
                "authors",
                "summary",
                "mode",
                "mode_reason",
            ] {
                meta.insert(stale.into(), Value::Null);
            }
            meta.insert("solver".into(), Value::String("fdm".into()));
            meta.insert("last_error".into(), Value::String(reason));
            ScannedProject {
                path: path.to_path_buf(),
                name: stem,
                project_id: None,
                status: ItemStatus::Failed,
                meta: Value::Object(meta),
                thumbnail: None,
            }
        }
    }
}

pub fn is_inlinable_png(bytes: &[u8]) -> bool {
    bytes.len() <= MAX_INLINE_THUMBNAIL_BYTES && bytes.starts_with(&PNG_SIGNATURE)
}

/// `"1.2.0"` and `"project/1.2"` both read as `1.2`, the schema's pattern.
pub fn short_schema_version(version: &str) -> String {
    let digits: String = version
        .chars()
        .skip_while(|c| !c.is_ascii_digit())
        .collect();
    let mut parts = digits.split('.').take(2);
    match (parts.next(), parts.next()) {
        (Some(major), Some(minor)) if !major.is_empty() && !minor.is_empty() => {
            format!("{major}.{minor}")
        }
        _ => version.to_string(),
    }
}

/// The requested discretisation lives in the scene's `study`, not in the
/// project definition. `study.backend` (the resolved choice) wins over
/// `study.requested_backend`; `auto` says nothing, so it falls through to the
/// first `backend`-like string elsewhere and finally to FDM, which is what a
/// new empty problem is.
pub fn solver_from_scene(scene: &Value) -> &'static str {
    fn classify(text: &str) -> Option<&'static str> {
        let lower = text.to_ascii_lowercase();
        if lower.starts_with("fem") {
            Some("FEM")
        } else if lower.starts_with("fdm") {
            Some("FDM")
        } else {
            None
        }
    }
    fn walk(value: &Value, depth: usize) -> Option<&'static str> {
        if depth > 6 {
            return None;
        }
        match value {
            Value::Object(map) => {
                for key in ["requested_backend", "backend", "discretization", "solver"] {
                    if let Some(found) = map.get(key).and_then(Value::as_str).and_then(classify) {
                        return Some(found);
                    }
                }
                map.values().find_map(|child| walk(child, depth + 1))
            }
            Value::Array(items) => items.iter().find_map(|child| walk(child, depth + 1)),
            _ => None,
        }
    }
    if let Some(study) = scene.get("study") {
        for key in ["backend", "requested_backend"] {
            if let Some(found) = study.get(key).and_then(Value::as_str).and_then(classify) {
                return found;
            }
        }
    }
    walk(scene, 0).unwrap_or("FDM")
}

/// `value` with an SI prefix and three significant digits: `1.4e5` A/m reads
/// `140 kA/m`. Zero and non-finite values have no sensible prefix.
pub fn si_value(value: f64, unit: &str) -> String {
    const PREFIXES: [(f64, &str); 9] = [
        (1e9, "G"),
        (1e6, "M"),
        (1e3, "k"),
        (1.0, ""),
        (1e-3, "m"),
        (1e-6, "\u{b5}"),
        (1e-9, "n"),
        (1e-12, "p"),
        (1e-15, "f"),
    ];
    if value == 0.0 || !value.is_finite() {
        return format!("{value} {unit}");
    }
    let magnitude = value.abs();
    let (scale, prefix) = PREFIXES
        .iter()
        .find(|(scale, _)| magnitude >= *scale * 0.9995)
        .copied()
        .unwrap_or(PREFIXES[PREFIXES.len() - 1]);
    format!("{} {prefix}{unit}", trim_significant(value / scale, 3))
}

fn trim_significant(value: f64, digits: usize) -> String {
    let magnitude = value.abs();
    let before_point = if magnitude >= 1.0 {
        magnitude.log10().floor() as usize + 1
    } else {
        1
    };
    let decimals = digits.saturating_sub(before_point);
    let text = format!("{value:.decimals$}");
    if text.contains('.') {
        text.trim_end_matches('0').trim_end_matches('.').to_string()
    } else {
        text
    }
}

/// The damping constant is dimensionless: plain at 0.01 and above, exponent
/// form below, as it is written in papers.
fn format_alpha(alpha: f64) -> String {
    if alpha != 0.0 && alpha.abs() < 0.01 {
        format!("{alpha:.1e}")
    } else {
        trim_significant(alpha, 3)
    }
}

fn triple(value: Option<&Value>) -> Option<[f64; 3]> {
    let items = value?.as_array()?;
    if items.len() != 3 {
        return None;
    }
    Some([items[0].as_f64()?, items[1].as_f64()?, items[2].as_f64()?])
}

/// Denormalised model facts for the inspector, read from the scene so it can
/// render without opening the archive. Only what the scene actually states is
/// emitted: a missing field is left out, never guessed, and a scene with
/// nothing to say yields no summary at all.
pub fn summary_from_scene(scene: &Value) -> Option<Value> {
    let mut summary = Map::new();
    let study = scene.get("study");
    let fdm = study.and_then(|s| s.get("fdm"));

    if let Some(cell) = triple(fdm.and_then(|f| f.get("default_cell"))) {
        let nm: Vec<String> = cell.iter().map(|v| trim_significant(v * 1e9, 3)).collect();
        summary.insert(
            "cell_size".into(),
            Value::String(format!("{} nm", nm.join(" \u{d7} "))),
        );
        if let Some(size) = triple(scene.get("universe").and_then(|u| u.get("size"))) {
            let cells: Vec<String> = size
                .iter()
                .zip(cell.iter())
                .filter(|(_, c)| **c > 0.0)
                .map(|(s, c)| format!("{}", (s / c).round() as i64))
                .collect();
            if cells.len() == 3 {
                summary.insert(
                    "discretisation".into(),
                    Value::String(cells.join(" \u{d7} ")),
                );
            }
        }
    }

    if let Some(materials) = scene.get("materials").and_then(Value::as_array) {
        let names: Vec<Value> = materials
            .iter()
            .filter_map(|m| m.get("name").and_then(Value::as_str))
            .map(|n| Value::String(n.to_string()))
            .collect();
        if !names.is_empty() {
            summary.insert("materials".into(), Value::Array(names));
        }
        // One material states its constants; with several there is no single Ms.
        if materials.len() == 1 {
            if let Some(props) = materials[0].get("properties") {
                if let Some(ms) = props.get("Ms").and_then(Value::as_f64) {
                    summary.insert("ms".into(), Value::String(si_value(ms, "A/m")));
                }
                if let Some(aex) = props.get("Aex").and_then(Value::as_f64) {
                    summary.insert("aex".into(), Value::String(si_value(aex, "J/m")));
                }
                if let Some(alpha) = props.get("alpha").and_then(Value::as_f64) {
                    summary.insert("alpha".into(), Value::String(format_alpha(alpha)));
                }
            }
        }
    }

    let mut interactions: Vec<String> = Vec::new();
    let mut add = |name: &str| {
        if !interactions.iter().any(|existing| existing == name) {
            interactions.push(name.to_string());
        }
    };
    if study
        .and_then(|s| s.get("exchange_enabled"))
        .and_then(Value::as_bool)
        == Some(true)
    {
        add("exchange");
    }
    if study
        .and_then(|s| s.get("demag_enabled"))
        .and_then(Value::as_bool)
        == Some(true)
    {
        add("demag");
    }
    for object in scene
        .get("objects")
        .and_then(Value::as_array)
        .into_iter()
        .flatten()
    {
        for entry in object
            .get("physics_stack")
            .and_then(Value::as_array)
            .into_iter()
            .flatten()
        {
            if entry.get("enabled").and_then(Value::as_bool) == Some(false) {
                continue;
            }
            if let Some(kind) = entry.get("kind").and_then(Value::as_str) {
                add(&kind.replace('_', " "));
            }
        }
    }
    if !interactions.is_empty() {
        summary.insert(
            "interactions".into(),
            Value::Array(interactions.into_iter().map(Value::String).collect()),
        );
    }

    if let Some(solver) = study.and_then(|s| s.get("solver")) {
        if let Some(integrator) = solver.get("integrator").and_then(Value::as_str) {
            if !integrator.is_empty() {
                summary.insert(
                    "integrator".into(),
                    Value::String(integrator.to_uppercase()),
                );
            }
        }
        if let Some(max_err) = solver.get("max_err").and_then(Value::as_str) {
            if !max_err.trim().is_empty() {
                summary.insert(
                    "tolerance".into(),
                    Value::String(max_err.trim().to_string()),
                );
            }
        }
    }

    if summary.is_empty() {
        None
    } else {
        Some(Value::Object(summary))
    }
}

/// RFC 3339 in UTC, to the second. Days-from-civil arithmetic keeps the host
/// free of a date dependency for the one place that formats a timestamp.
pub fn rfc3339_utc(time: SystemTime) -> String {
    let seconds = time
        .duration_since(UNIX_EPOCH)
        .map(|d| d.as_secs() as i64)
        .unwrap_or(0);
    let days = seconds.div_euclid(86_400);
    let rem = seconds.rem_euclid(86_400);
    let (year, month, day) = civil_from_days(days);
    format!(
        "{year:04}-{month:02}-{day:02}T{:02}:{:02}:{:02}Z",
        rem / 3600,
        (rem % 3600) / 60,
        rem % 60
    )
}

fn civil_from_days(days: i64) -> (i64, u32, u32) {
    let z = days + 719_468;
    let era = z.div_euclid(146_097);
    let doe = z.rem_euclid(146_097);
    let yoe = (doe - doe / 1460 + doe / 36_524 - doe / 146_096) / 365;
    let year = yoe + era * 400;
    let doy = doe - (365 * yoe + yoe / 4 - yoe / 100);
    let mp = (5 * doy + 2) / 153;
    let day = (doy - (153 * mp + 2) / 5 + 1) as u32;
    let month = if mp < 10 { mp + 3 } else { mp - 9 } as u32;
    (if month <= 2 { year + 1 } else { year }, month, day)
}

#[cfg(test)]
mod tests {
    use super::*;
    use std::time::Duration;

    fn at(seconds: u64) -> SystemTime {
        UNIX_EPOCH + Duration::from_secs(seconds)
    }

    #[test]
    fn formats_timestamps_in_utc() {
        assert_eq!(rfc3339_utc(UNIX_EPOCH), "1970-01-01T00:00:00Z");
        // 2026-10-03T12:34:56Z
        assert_eq!(rfc3339_utc(at(1_791_030_896)), "2026-10-03T12:34:56Z");
        // A leap day.
        assert_eq!(rfc3339_utc(at(1_709_208_000)), "2024-02-29T12:00:00Z");
    }

    #[test]
    fn solver_is_read_from_the_scene_and_defaults_to_fdm() {
        assert_eq!(
            solver_from_scene(&json!({"study": {"backend": "fem"}})),
            "FEM"
        );
        assert_eq!(
            solver_from_scene(&json!({"requested_backend": "FDM"})),
            "FDM"
        );
        assert_eq!(solver_from_scene(&json!({"unrelated": 1})), "FDM");
    }

    #[test]
    fn solver_prefers_the_study_over_unrelated_keys() {
        let scene = json!({
            "objects": [{"backend": "fem"}],
            "study": {"requested_backend": "auto", "backend": "fdm"}
        });
        assert_eq!(solver_from_scene(&scene), "FDM");
    }

    #[test]
    fn si_values_get_a_prefix_and_three_significant_digits() {
        assert_eq!(si_value(1.4e5, "A/m"), "140 kA/m");
        assert_eq!(si_value(3.65e-12, "J/m"), "3.65 pJ/m");
        assert_eq!(si_value(2.0e-9, "m"), "2 nm");
        assert_eq!(si_value(0.0, "A/m"), "0 A/m");
        assert_eq!(format_alpha(2.0e-4), "2.0e-4");
        assert_eq!(format_alpha(0.5), "0.5");
    }

    #[test]
    fn summary_reports_only_what_the_scene_states() {
        let scene = json!({
            "universe": {"mode": "manual", "size": [1.024e-6, 1.024e-6, 4.0e-8]},
            "materials": [{"name": "YIG", "properties": {"Ms": 1.4e5, "Aex": 3.65e-12, "alpha": 2.0e-4}}],
            "objects": [{"physics_stack": [
                {"kind": "interfacial_dmi", "enabled": true},
                {"kind": "bulk_dmi", "enabled": false}
            ]}],
            "study": {
                "exchange_enabled": true, "demag_enabled": true,
                "fdm": {"default_cell": [2.0e-9, 2.0e-9, 5.0e-9]},
                "solver": {"integrator": "rk45", "max_err": "1e-6"}
            }
        });
        let summary = summary_from_scene(&scene).unwrap();
        assert_eq!(summary["cell_size"], "2 \u{d7} 2 \u{d7} 5 nm");
        assert_eq!(summary["discretisation"], "512 \u{d7} 512 \u{d7} 8");
        assert_eq!(summary["materials"], json!(["YIG"]));
        assert_eq!(summary["ms"], "140 kA/m");
        assert_eq!(summary["aex"], "3.65 pJ/m");
        assert_eq!(summary["alpha"], "2.0e-4");
        assert_eq!(
            summary["interactions"],
            json!(["exchange", "demag", "interfacial dmi"])
        );
        assert_eq!(summary["integrator"], "RK45");
        assert_eq!(summary["tolerance"], "1e-6");
        assert!(summary.get("periodicity").is_none());
    }

    #[test]
    fn several_materials_state_no_single_set_of_constants() {
        let scene = json!({"materials": [
            {"name": "A", "properties": {"Ms": 1.0, "alpha": 0.01}},
            {"name": "B", "properties": {"Ms": 2.0, "alpha": 0.02}}
        ]});
        let summary = summary_from_scene(&scene).unwrap();
        assert_eq!(summary["materials"], json!(["A", "B"]));
        assert!(summary.get("ms").is_none());
    }

    #[test]
    fn an_empty_scene_has_no_summary() {
        assert!(summary_from_scene(&json!({})).is_none());
    }
}
