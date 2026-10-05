//! Recognising and reading a Fullmag results folder.
//!
//! Layout (written by `fullmag-cli` and `fullmag-runner`):
//!
//! ```text
//! <name>.zarr/                       results folder (Zarr v2 group; `.results` for HDF5)
//!   .zgroup  .zattrs                 {"fullmag_schema": "fullmag.script_results.v1", ...}
//!                                    or {"schema_version": "fullmag.project_results.v1"}
//!   output-storage.json              fullmag.output_storage.resolved.v1 (run id, format)
//!   fullmag-run.json                 fullmag.run_manifest.v1 (this crate)
//!   sequence_manifest.json           optional: stages of a flat sequence
//!   artifacts/                       final stage: metadata.json, scalars.csv, m_final.json,
//!                                    <target>.autosave.json, <target>.zarr/stages/stage_0000_*/
//!   stages/stage_NN_<kind>/          earlier stages, same contents as artifacts/
//! ```
//!
//! Only metadata is read: JSON documents of bounded size, the header and last
//! line of `scalars.csv`. Array chunks and field files are never opened.

use std::io::{Read, Seek, SeekFrom};
use std::path::{Path, PathBuf};
use std::time::{Duration, Instant, SystemTime};

use fullmag_workspace::rfc3339_millis;
use serde_json::Value;

use crate::detail::{ResultDetail, ResultGrid};
use crate::manifest::{
    collect_outputs, manifest_path, read_run_manifest, RunSource, StageSummary,
};

const MAX_JSON_BYTES: u64 = 8 * 1024 * 1024;
const CSV_TAIL_BYTES: u64 = 8 * 1024;
const CSV_HEADER_BYTES: u64 = 64 * 1024;
const MAX_WALK_ENTRIES: usize = 50_000;
const WALK_BUDGET: Duration = Duration::from_secs(2);

/// Does `dir` look like a Fullmag results folder? Cheap: a few `stat` calls
/// and at most two small reads, no recursion.
pub fn is_result_dir(dir: &Path) -> bool {
    if !dir.is_dir() {
        return false;
    }
    if manifest_path(dir).is_file() {
        return true;
    }
    if let Some(receipt) = read_small_json(&dir.join("output-storage.json")) {
        let schema = receipt.get("schema").and_then(Value::as_str).unwrap_or("");
        if schema.starts_with("fullmag.output_storage") {
            return true;
        }
    }
    if let Some(attrs) = read_small_json(&dir.join(".zattrs")) {
        let marker = |key: &str| {
            attrs
                .get(key)
                .and_then(Value::as_str)
                .is_some_and(|text| text.starts_with("fullmag."))
        };
        if marker("fullmag_schema") || marker("schema_version") {
            return true;
        }
    }
    if let Ok(read) = std::fs::read_dir(dir) {
        for entry in read.flatten().take(256) {
            let name = entry.file_name().to_string_lossy().to_ascii_lowercase();
            if name.ends_with(".autosave.json") {
                return true;
            }
        }
    }
    // A bare Zarr store with stage groups: `stages/stage_NNNN_*/manifest.json`.
    if let Ok(read) = std::fs::read_dir(dir.join("stages")) {
        for entry in read.flatten().take(64) {
            let name = entry.file_name().to_string_lossy().to_string();
            if name.starts_with("stage_") && entry.path().join("manifest.json").is_file() {
                return true;
            }
        }
    }
    false
}

/// Read the results folder at `dir`. Never fails: problems land in `read_error`.
pub fn inspect_result(dir: &Path) -> ResultDetail {
    let mut detail = ResultDetail {
        read_error: None,
        format: None,
        has_manifest: false,
        run_id: None,
        status: None,
        source: None,
        started_at: None,
        finished_at: None,
        stages: Vec::new(),
        quantities: Vec::new(),
        grid: None,
        frames: None,
        frames_index: None,
        total_bytes: None,
        total_bytes_truncated: false,
        modified_at: None,
        outputs: Vec::new(),
    };
    let dir_meta = match std::fs::metadata(dir) {
        Ok(meta) if meta.is_dir() => meta,
        Ok(_) => {
            detail.read_error = Some("the path is not a folder".into());
            return detail;
        }
        Err(error) => {
            detail.read_error = Some(format!("cannot read the results folder: {error}"));
            return detail;
        }
    };

    let mut modified = dir_meta.modified().ok();
    match read_run_manifest(dir) {
        Ok(Some(manifest)) => {
            detail.has_manifest = true;
            detail.run_id = Some(manifest.run_id);
            detail.status = Some(manifest.status);
            detail.source = Some(manifest.source);
            detail.started_at = Some(manifest.started_at);
            detail.finished_at = manifest.finished_at;
            detail.stages = manifest.stages;
            detail.outputs = manifest.outputs;
            if let Ok(time) =
                std::fs::metadata(manifest_path(dir)).and_then(|meta| meta.modified())
            {
                modified = modified.max(Some(time));
            }
        }
        Ok(None) => {}
        // The rest of the folder is still readable; say why the manifest is not.
        Err(message) => detail.read_error = Some(message),
    }

    let storage = read_small_json(&dir.join("output-storage.json"));
    if detail.run_id.is_none() {
        detail.run_id = storage
            .as_ref()
            .and_then(|receipt| receipt.pointer("/resolved/run_id"))
            .and_then(Value::as_str)
            .map(str::to_string);
    }
    let attrs = read_small_json(&dir.join(".zattrs"));
    if detail.source.is_none() {
        detail.source = attrs
            .as_ref()
            .and_then(|attrs| attrs.get("script_path"))
            .and_then(Value::as_str)
            .map(|path| RunSource {
                kind: "script".into(),
                path: display_path(path),
                sha256: None,
                project_id: None,
                revision: None,
            });
    }
    detail.format = Some(detect_format(dir, storage.as_ref()));

    let layout = read_layout(dir);
    if detail.stages.is_empty() {
        detail.stages = layout.stages;
    }
    detail.quantities = layout.quantities;
    detail.frames = layout.frames;
    detail.grid = layout.grid;
    detail.frames_index = crate::frames::read_frames(dir).map(|frames| frames.summary());
    if detail.status.is_none() {
        detail.status = layout.status.or_else(|| {
            storage
                .as_ref()
                .and_then(|receipt| receipt.get("state"))
                .and_then(Value::as_str)
                .map(str::to_string)
        });
    }
    if detail.outputs.is_empty() {
        detail.outputs = collect_outputs(dir);
    }

    let (bytes, truncated, newest) = folder_size(dir);
    detail.total_bytes = Some(bytes);
    detail.total_bytes_truncated = truncated;
    detail.modified_at = modified.max(newest).map(rfc3339_millis);
    detail
}

fn detect_format(dir: &Path, storage: Option<&Value>) -> String {
    if let Some(format) = storage
        .and_then(|receipt| receipt.pointer("/resolved/data_format"))
        .and_then(Value::as_str)
    {
        return format.to_ascii_lowercase();
    }
    if dir.join(".zgroup").is_file() {
        return "zarr".into();
    }
    if let Ok(read) = std::fs::read_dir(dir) {
        for entry in read.flatten().take(256) {
            let name = entry.file_name().to_string_lossy().to_ascii_lowercase();
            if name.ends_with(".zarr") {
                return "zarr".into();
            }
            if name.ends_with(".h5") || name.ends_with(".hdf5") {
                return "hdf5".into();
            }
        }
    }
    if dir
        .extension()
        .is_some_and(|ext| ext.eq_ignore_ascii_case("results"))
    {
        return "hdf5".into();
    }
    "unknown".into()
}

// ── stages, quantities, grid ───────────────────────────────────────────────

/// What the stage directories say, independent of the manifest.
#[derive(Debug, Default)]
pub struct Layout {
    pub stages: Vec<StageSummary>,
    pub quantities: Vec<String>,
    pub frames: Option<u64>,
    pub grid: Option<ResultGrid>,
    pub status: Option<String>,
}

#[derive(Debug, Default)]
struct StageFacts {
    steps: Option<u64>,
    time_s: Option<f64>,
    quantities: Vec<String>,
    frames: Option<u64>,
    grid: Option<ResultGrid>,
    status: Option<String>,
}

/// Read stage facts from the directories of a results folder.
pub fn read_layout(dir: &Path) -> Layout {
    let sequence = read_small_json(&dir.join("sequence_manifest.json"));
    let candidates = stage_candidates(dir, &sequence);

    let mut layout = Layout::default();
    let mut frames_total = 0_u64;
    let mut have_frames = false;
    for (id, kind, path) in candidates {
        let facts = read_stage_facts(&path);
        let time_s = facts.time_s.or_else(|| declared_until(&sequence, kind.as_deref()));
        layout.stages.push(StageSummary {
            id,
            kind,
            steps: facts.steps,
            time_s,
        });
        for quantity in facts.quantities {
            if !layout.quantities.contains(&quantity) {
                layout.quantities.push(quantity);
            }
        }
        if let Some(frames) = facts.frames {
            frames_total += frames;
            have_frames = true;
        }
        if facts.grid.is_some() {
            layout.grid = facts.grid;
        }
        if facts.status.is_some() {
            layout.status = facts.status;
        }
    }
    if have_frames {
        layout.frames = Some(frames_total);
    }
    layout
}

/// Stage directories of a results folder as `(id, kind, path)`: the numbered
/// `stages/stage_*` groups, then `artifacts/` (id `final`), else the folder itself.
pub(crate) fn stage_candidates(
    dir: &Path,
    sequence: &Option<Value>,
) -> Vec<(String, Option<String>, PathBuf)> {
    let mut candidates: Vec<(String, Option<String>, PathBuf)> = Vec::new();
    if let Ok(read) = std::fs::read_dir(dir.join("stages")) {
        let mut names: Vec<String> = read
            .flatten()
            .filter(|entry| entry.file_type().is_ok_and(|t| t.is_dir()))
            .map(|entry| entry.file_name().to_string_lossy().into_owned())
            .filter(|name| name.starts_with("stage_"))
            .collect();
        names.sort();
        for name in names {
            let kind = stage_kind(&name);
            candidates.push((name.clone(), kind, dir.join("stages").join(name)));
        }
    }
    let final_dir = dir.join("artifacts");
    if final_dir.is_dir() {
        let kind = sequence
            .as_ref()
            .and_then(|sequence| sequence.get("stages"))
            .and_then(Value::as_array)
            .and_then(|stages| stages.last())
            .and_then(|stage| stage.get("entrypoint_kind"))
            .and_then(Value::as_str)
            .map(str::to_string);
        candidates.push(("final".to_string(), kind, final_dir));
    }
    if candidates.is_empty() {
        let name = dir
            .file_name()
            .and_then(|name| name.to_str())
            .unwrap_or("stage")
            .to_string();
        candidates.push((name, None, dir.to_path_buf()));
    }
    candidates
}

fn stage_kind(directory_name: &str) -> Option<String> {
    // `stage_00_relax` -> `relax`
    let rest = directory_name.strip_prefix("stage_")?;
    let (index, kind) = rest.split_once('_')?;
    if index.chars().all(|c| c.is_ascii_digit()) && !kind.is_empty() {
        Some(kind.to_string())
    } else {
        None
    }
}

fn declared_until(sequence: &Option<Value>, kind: Option<&str>) -> Option<f64> {
    let kind = kind?;
    sequence
        .as_ref()?
        .get("stages")?
        .as_array()?
        .iter()
        .find(|stage| stage.get("entrypoint_kind").and_then(Value::as_str) == Some(kind))?
        .get("until_seconds")?
        .as_f64()
}

fn read_stage_facts(dir: &Path) -> StageFacts {
    let mut facts = StageFacts::default();

    if let Some(csv) = read_scalars_csv(&dir.join("scalars.csv")) {
        facts.steps = csv.last_step;
        facts.time_s = csv.last_time;
        facts.quantities = csv.quantities;
    }

    if let Some(metadata) = read_json_bounded(&dir.join("metadata.json"), MAX_JSON_BYTES) {
        facts.status = metadata
            .get("status")
            .and_then(Value::as_str)
            .map(str::to_string);
        if facts.steps.is_none() {
            facts.steps = metadata.get("scalar_rows").and_then(Value::as_u64);
        }
        facts.frames = metadata.get("field_snapshots").and_then(Value::as_u64);
        facts.grid = metadata.get("artifact_layout").and_then(grid_of);
    }

    // A stage group of a Zarr store carries its own manifest.
    if let Some(manifest) = read_json_bounded(&dir.join("manifest.json"), MAX_JSON_BYTES)
        .filter(|manifest| manifest.get("stage_id").is_some())
    {
        let (mut rows, mut frames) = (0_u64, 0_u64);
        absorb_autosave_stage(&manifest, &mut facts.quantities, &mut rows, &mut frames);
        if facts.steps.is_none() && rows > 0 {
            facts.steps = Some(rows);
        }
        if facts.frames.is_none() {
            facts.frames = Some(frames);
        }
    }

    // Autosave manifests: `<target>.autosave.json` next to the stage files.
    let mut autosave_table_rows = 0_u64;
    let mut autosave_frames = 0_u64;
    let mut autosave_seen = false;
    let mut stores: Vec<PathBuf> = Vec::new();
    if let Ok(read) = std::fs::read_dir(dir) {
        for entry in read.flatten().take(256) {
            let name = entry.file_name().to_string_lossy().to_ascii_lowercase();
            let path = entry.path();
            if name.ends_with(".autosave.json") {
                if let Some(manifest) = read_json_bounded(&path, MAX_JSON_BYTES) {
                    for stage in manifest
                        .get("stages")
                        .and_then(Value::as_array)
                        .into_iter()
                        .flatten()
                    {
                        autosave_seen = true;
                        absorb_autosave_stage(
                            stage,
                            &mut facts.quantities,
                            &mut autosave_table_rows,
                            &mut autosave_frames,
                        );
                    }
                }
            } else if name.ends_with(".zarr") && path.join("stages").is_dir() {
                stores.push(path);
            }
        }
    }
    if !autosave_seen {
        // A Zarr store whose `<target>.autosave.json` is gone still carries a
        // manifest per stage group.
        for store in stores {
            let Ok(read) = std::fs::read_dir(store.join("stages")) else {
                continue;
            };
            for stage in read.flatten().take(64) {
                if let Some(manifest) =
                    read_json_bounded(&stage.path().join("manifest.json"), MAX_JSON_BYTES)
                {
                    autosave_seen = true;
                    absorb_autosave_stage(
                        &manifest,
                        &mut facts.quantities,
                        &mut autosave_table_rows,
                        &mut autosave_frames,
                    );
                }
            }
        }
    }
    if autosave_seen {
        if facts.steps.is_none() && autosave_table_rows > 0 {
            facts.steps = Some(autosave_table_rows);
        }
        if facts.frames.is_none() {
            facts.frames = Some(autosave_frames);
        }
    }
    facts
}

fn absorb_autosave_stage(
    stage: &Value,
    quantities: &mut Vec<String>,
    table_rows: &mut u64,
    frames: &mut u64,
) {
    for key in ["table_quantities", "field_quantities"] {
        for name in stage
            .get(key)
            .and_then(Value::as_array)
            .into_iter()
            .flatten()
            .filter_map(Value::as_str)
        {
            if !quantities.iter().any(|existing| existing == name) {
                quantities.push(name.to_string());
            }
        }
    }
    *table_rows += stage
        .get("table_sample_count")
        .and_then(Value::as_u64)
        .unwrap_or(0);
    *frames += stage
        .get("field_sample_count")
        .and_then(Value::as_u64)
        .unwrap_or(0);
}

fn grid_of(layout: &Value) -> Option<ResultGrid> {
    let object = layout.as_object()?;
    let cells = object
        .get("grid_cells")
        .and_then(Value::as_array)
        .map(|cells| cells.iter().filter_map(Value::as_u64).collect::<Vec<_>>())
        .filter(|cells| !cells.is_empty());
    let grid = ResultGrid {
        backend: object
            .get("backend")
            .and_then(Value::as_str)
            .map(str::to_string),
        cells,
        n_nodes: object.get("n_nodes").and_then(Value::as_u64),
        n_elements: object.get("n_elements").and_then(Value::as_u64),
        hmax: object.get("hmax").and_then(Value::as_f64),
    };
    if grid.backend.is_none()
        && grid.cells.is_none()
        && grid.n_nodes.is_none()
        && grid.n_elements.is_none()
        && grid.hmax.is_none()
    {
        None
    } else {
        Some(grid)
    }
}

struct ScalarsCsv {
    quantities: Vec<String>,
    last_step: Option<u64>,
    last_time: Option<f64>,
}

/// Header and last line of `scalars.csv`, reading at most 64 kB from the start
/// and 8 kB from the end.
fn read_scalars_csv(path: &Path) -> Option<ScalarsCsv> {
    let mut file = std::fs::File::open(path).ok()?;
    let length = file.metadata().ok()?.len();
    let mut head = Vec::new();
    (&mut file)
        .take(CSV_HEADER_BYTES)
        .read_to_end(&mut head)
        .ok()?;
    let head_text = String::from_utf8_lossy(&head);
    let header_line = head_text.lines().next()?;
    let columns: Vec<&str> = header_line.split(',').map(str::trim).collect();
    let step_index = columns.iter().position(|c| c.eq_ignore_ascii_case("step"));
    let time_index = columns.iter().position(|c| c.eq_ignore_ascii_case("time"));
    let quantities = columns
        .iter()
        .filter(|c| !c.is_empty() && !c.eq_ignore_ascii_case("step") && !c.eq_ignore_ascii_case("time"))
        .map(|c| c.to_string())
        .collect();

    let mut tail = Vec::new();
    let start = length.saturating_sub(CSV_TAIL_BYTES);
    file.seek(SeekFrom::Start(start)).ok()?;
    file.take(CSV_TAIL_BYTES).read_to_end(&mut tail).ok()?;
    let tail_text = String::from_utf8_lossy(&tail);
    let mut lines = tail_text.lines().filter(|line| !line.trim().is_empty());
    let last = lines.next_back();
    let (mut last_step, mut last_time) = (None, None);
    if let Some(last) = last.filter(|line| *line != header_line) {
        let cells: Vec<&str> = last.split(',').collect();
        last_step = step_index
            .and_then(|i| cells.get(i))
            .and_then(|cell| cell.trim().parse::<u64>().ok());
        last_time = time_index
            .and_then(|i| cells.get(i))
            .and_then(|cell| cell.trim().parse::<f64>().ok());
    }
    Some(ScalarsCsv {
        quantities,
        last_step,
        last_time,
    })
}

// ── small helpers ──────────────────────────────────────────────────────────

fn read_small_json(path: &Path) -> Option<Value> {
    read_json_bounded(path, 1024 * 1024)
}

pub(crate) fn read_small_json_pub(path: &Path) -> Option<Value> {
    read_small_json(path)
}

fn read_json_bounded(path: &Path, limit: u64) -> Option<Value> {
    let meta = std::fs::metadata(path).ok()?;
    if !meta.is_file() || meta.len() > limit {
        return None;
    }
    serde_json::from_slice(&std::fs::read(path).ok()?).ok()
}

/// No `\\?\` verbatim prefix on a path a person will read.
pub fn display_path(path: &str) -> String {
    if let Some(rest) = path.strip_prefix(r"\\?\UNC\") {
        format!(r"\\{rest}")
    } else {
        path.strip_prefix(r"\\?\").unwrap_or(path).to_string()
    }
}

/// `(bytes, stopped at a limit, newest modification time)`; symbolic links
/// are not followed.
fn folder_size(dir: &Path) -> (u64, bool, Option<SystemTime>) {
    let started = Instant::now();
    let (mut bytes, mut visited, mut newest) = (0_u64, 0_usize, None::<SystemTime>);
    let mut pending = vec![dir.to_path_buf()];
    while let Some(current) = pending.pop() {
        let Ok(read) = std::fs::read_dir(&current) else {
            continue;
        };
        for entry in read.flatten() {
            visited += 1;
            if visited > MAX_WALK_ENTRIES || started.elapsed() > WALK_BUDGET {
                return (bytes, true, newest);
            }
            let Ok(meta) = entry.metadata() else {
                continue;
            };
            if meta.file_type().is_symlink() {
                continue;
            }
            if let Ok(time) = meta.modified() {
                newest = newest.max(Some(time));
            }
            if meta.is_dir() {
                pending.push(entry.path());
            } else {
                bytes += meta.len();
            }
        }
    }
    (bytes, false, newest)
}
