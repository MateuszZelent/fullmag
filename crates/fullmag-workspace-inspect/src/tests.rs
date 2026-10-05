//! Tests of the inspectors, the scanner and the links, on fixtures built in
//! temporary directories.

use std::fs;
use std::path::{Path, PathBuf};
use std::time::Duration;

use fullmag_application::{
    FileProjectRepository, OpaqueDocument, ProjectEnvelope, ProjectId, RawJsonEnvelope,
};
use fullmag_workspace::{Actor, ItemKind, ItemStatus, Query, Workspace, WorkspaceRoot};
use serde_json::{json, Value};

use crate::manifest::{write_run_manifest, RunManifest, RunSource};
use crate::project::{PNG_SIGNATURE, THUMBNAIL_PATH};
use crate::provenance::PROVENANCE_PATH;
use crate::scanner::{
    classify_path, describe, scan_roots, store_observed, ScanOptions, SKIPPED_DIRECTORIES,
};
use crate::*;

fn open(dir: &Path) -> Workspace {
    Workspace::open(dir.join("state").join("workspace.db")).unwrap().0
}

fn write(path: &Path, text: &str) {
    fs::create_dir_all(path.parent().unwrap()).unwrap();
    fs::write(path, text).unwrap();
}

const SCENE_EXTRAS: &str = r#"{
    "universe": {"mode": "manual", "size": [1.024e-6, 1.024e-6, 4.0e-8]},
    "materials": [{"name": "YIG", "properties": {"Ms": 1.4e5, "Aex": 3.65e-12, "alpha": 2.0e-4}}],
    "field_drives": {"drives": [{"enabled": true}, {"enabled": false}]},
    "study": {
        "exchange_enabled": true, "demag_enabled": true,
        "external_field": [0.0, 0.0, 0.1],
        "fdm": {"default_cell": [2.0e-9, 2.0e-9, 5.0e-9]},
        "solver": {"integrator": "rk45", "max_err": "1e-6"}
    }
}"#;

fn tiny_png() -> Vec<u8> {
    let mut png = PNG_SIGNATURE.to_vec();
    png.extend_from_slice(b"fixture image");
    png
}

fn write_project(path: &Path, id: &str, rich: bool, provenance: Option<&Value>) {
    let mut envelope = ProjectEnvelope::blank(ProjectId::parse(id).unwrap(), "Wall").unwrap();
    if rich {
        let mut scene = envelope.definition.scene.value().clone();
        let extras: Value = serde_json::from_str(SCENE_EXTRAS).unwrap();
        for (key, value) in extras.as_object().unwrap() {
            scene[key] = value.clone();
        }
        envelope
            .replace_scene(RawJsonEnvelope::from_value(scene).unwrap())
            .unwrap();
    }
    if let Some(provenance) = provenance {
        envelope.opaque_documents.push(
            OpaqueDocument::new(PROVENANCE_PATH, serde_json::to_vec(provenance).unwrap()).unwrap(),
        );
        envelope
            .opaque_documents
            .push(OpaqueDocument::new(THUMBNAIL_PATH, tiny_png()).unwrap());
    }
    let bytes = FileProjectRepository::new().encode_archive(&envelope).unwrap();
    fs::create_dir_all(path.parent().unwrap()).unwrap();
    fs::write(path, bytes).unwrap();
}

fn provenance_fixture() -> Value {
    json!({
        "authors": [{"name": "Ada", "role": "creator", "orcid": "0000-0001"}, {"role": "x"}],
        "citation": {"doi": "10.1/x", "license": "CC-BY-4.0"},
        "history": [
            {"revision": 1, "at": "2026-10-01T00:00:00Z", "kind": "edit", "summary": "first", "changes": ["a"]},
            {"revision": 0, "at": "t", "kind": "teleport", "summary": "dropped"}
        ],
        "runs": [
            {"run_id": "r-1", "started_at": "2026-10-01T10:00:00Z", "status": "ready",
             "frames": 12, "output_bytes": 4096, "device": "cpu"},
            {"run_id": "r-2", "started_at": "2026-10-02T10:00:00Z", "status": "ready",
             "frames": 40, "output_bytes": 8192, "duration_seconds": 3.5}
        ],
        "preview": {"colouring": "hsl-sphere", "run_id": "r-2"}
    })
}

// ── project ────────────────────────────────────────────────────────────────

#[test]
fn a_project_is_read_into_the_documented_groups_with_nulls_for_the_unknown() {
    let dir = tempfile::tempdir().unwrap();
    let path = dir.path().join("wall.fms");
    write_project(&path, "pid-wall", true, Some(&provenance_fixture()));
    let detail = inspect_project(&path);
    assert_eq!(detail.read_error, None);
    assert_eq!(detail.name.as_deref(), Some("Wall"));
    assert_eq!(detail.project_id.as_deref(), Some("pid-wall"));
    assert_eq!(detail.revision, Some(0));
    assert_eq!(detail.solver.as_deref(), Some("fdm"));
    assert_eq!(detail.migrated, Some(false));
    assert_eq!(detail.can_write, Some(true));
    assert_eq!(detail.mode.as_deref(), Some("read_write"));
    assert!(detail.provenance_recorded);
    assert_eq!(detail.authors.len(), 1);
    assert_eq!(detail.authors[0].orcid.as_deref(), Some("0000-0001"));
    assert_eq!(detail.citation.as_ref().unwrap().doi.as_deref(), Some("10.1/x"));
    assert_eq!(detail.citation.as_ref().unwrap().url, None);
    assert_eq!(detail.history.len(), 1);
    assert_eq!(detail.history[0].changes, vec!["a".to_string()]);
    assert_eq!(detail.runs.len(), 2);
    assert_eq!(detail.preview.as_ref().unwrap().colouring, "hsl-sphere");

    let summary = detail.summary.unwrap();
    assert_eq!(summary.model.discretisation.as_deref(), Some("512 \u{d7} 512 \u{d7} 8"));
    assert_eq!(summary.model.cell_size.as_deref(), Some("2 \u{d7} 2 \u{d7} 5 nm"));
    assert_eq!(summary.model.periodicity, None);
    assert_eq!(summary.model.materials, Some(vec!["YIG".to_string()]));
    assert_eq!(summary.model.ms.as_deref(), Some("140 kA/m"));
    assert_eq!(summary.model.aex.as_deref(), Some("3.65 pJ/m"));
    assert_eq!(summary.model.alpha.as_deref(), Some("2.0e-4"));
    assert_eq!(summary.model.interactions, Some(vec!["exchange".to_string(), "demag".to_string()]));
    assert_eq!(summary.execution.integrator.as_deref(), Some("RK45"));
    assert_eq!(summary.execution.tolerance.as_deref(), Some("1e-6"));
    assert_eq!(summary.execution.excitation.as_deref(), Some("static field, 1 field drive"));
    // Outputs come from the latest run by start time.
    assert_eq!(summary.outputs.frames, Some(40));
    assert_eq!(summary.outputs.size_bytes, Some(8192));
}

#[test]
fn a_blank_project_without_provenance_says_so_and_has_null_facts() {
    let dir = tempfile::tempdir().unwrap();
    let path = dir.path().join("blank.fms");
    write_project(&path, "pid-blank", false, None);
    let detail = inspect_project(&path);
    assert_eq!(detail.read_error, None);
    assert!(!detail.provenance_recorded);
    assert!(detail.authors.is_empty() && detail.runs.is_empty());
    let summary = detail.summary.unwrap();
    assert_eq!(summary.model.ms, None);
    assert_eq!(summary.execution.excitation, None);
    assert_eq!(summary.outputs.frames, None);
}

#[test]
fn a_damaged_or_missing_project_is_a_read_error_not_a_failure() {
    let dir = tempfile::tempdir().unwrap();
    let broken = dir.path().join("broken.fms");
    fs::write(&broken, b"not a zip").unwrap();
    let detail = inspect_project(&broken);
    assert!(detail.read_error.as_deref().is_some_and(|text| !text.is_empty()));
    assert!(detail.summary.is_none() && detail.revision.is_none());
    assert!(inspect_project(&dir.path().join("none.fms")).read_error.is_some());
    assert!(inspect_project(dir.path()).read_error.is_some());
}

// ── result folder ──────────────────────────────────────────────────────────

/// A results folder as `fullmag-cli` and `fullmag-runner` write it.
fn write_results_folder(root: &Path, script: Option<&Path>) {
    write(&root.join(".zgroup"), r#"{"zarr_format":2}"#);
    write(
        &root.join(".zattrs"),
        &json!({
            "fullmag_schema": "fullmag.script_results.v1",
            "script_path": script.map(|p| p.display().to_string()),
            "session_id": "session-1"
        })
        .to_string(),
    );
    write(
        &root.join("output-storage.json"),
        &json!({
            "schema": "fullmag.output_storage.resolved.v1", "state": "succeeded",
            "resolved": {"run_id": "run-session-1", "data_format": "zarr"}
        })
        .to_string(),
    );
    write(
        &root.join("sequence_manifest.json"),
        &json!({"kind": "flat_sequence", "stages": [
            {"index": 1, "entrypoint_kind": "relax", "until_seconds": 1e-9},
            {"index": 2, "entrypoint_kind": "run", "until_seconds": 4e-12}
        ]})
        .to_string(),
    );
    // Earlier stage.
    let early = root.join("stages/stage_00_relax");
    write(&early.join("scalars.csv"), "step,time,mx,my\n1,1e-13,0.1,0.2\n2,2e-13,0.3,0.4\n");
    write(&early.join("metadata.json"), r#"{"status":"completed","scalar_rows":2,"field_snapshots":0}"#);
    // Final stage with an autosave store.
    let fin = root.join("artifacts");
    let mut csv = String::from("step,time,solver_dt,mx,E_total\n");
    for step in 1..=300 {
        csv.push_str(&format!("{step},{}e-13,1e-13,0.5,1.0\n", step));
    }
    write(&fin.join("scalars.csv"), &csv);
    write(
        &fin.join("metadata.json"),
        &json!({
            "status": "completed", "scalar_rows": 300, "field_snapshots": 4,
            "artifact_layout": {"backend": "fem", "n_nodes": 353, "n_elements": 1545, "hmax": 8e-9}
        })
        .to_string(),
    );
    let stage = json!({
        "schema_version": "fullmag.stage_autosave.v1", "target": "main", "stage_id": "run",
        "stage_index": 0, "table_quantities": ["mx", "E_total"], "field_quantities": ["m"],
        "complete": true, "table_sample_count": 300, "field_sample_count": 4
    });
    write(
        &fin.join("main.autosave.json"),
        &json!({"schema_version": "fullmag.stage_autosave.artifact.v1", "target": "main",
                "stages": [stage]})
        .to_string(),
    );
    let stage_dir = fin.join("main.zarr/stages/stage_0000_run");
    write(&stage_dir.join("manifest.json"), &stage.to_string());
    // An array chunk: binary, never opened by a reader.
    fs::create_dir_all(stage_dir.join("fields/m")).unwrap();
    fs::write(stage_dir.join("fields/m/0.0"), vec![0xFF_u8; 70_000]).unwrap();
}

#[test]
fn a_script_results_folder_yields_stages_quantities_grid_and_sizes() {
    let dir = tempfile::tempdir().unwrap();
    let results = dir.path().join("wall.zarr");
    let script = dir.path().join("wall.py");
    write_results_folder(&results, Some(&script));
    assert!(is_result_dir(&results));

    let detail = inspect_result(&results);
    assert_eq!(detail.read_error, None);
    assert_eq!(detail.format.as_deref(), Some("zarr"));
    assert!(!detail.has_manifest);
    assert_eq!(detail.run_id.as_deref(), Some("run-session-1"));
    assert_eq!(detail.status.as_deref(), Some("completed"));
    let source = detail.source.clone().unwrap();
    assert_eq!((source.kind.as_str(), source.sha256), ("script", None));
    assert!(source.path.ends_with("wall.py"));

    let stages: Vec<(&str, Option<&str>, Option<u64>)> = detail
        .stages
        .iter()
        .map(|s| (s.id.as_str(), s.kind.as_deref(), s.steps))
        .collect();
    assert_eq!(
        stages,
        vec![
            ("stage_00_relax", Some("relax"), Some(2)),
            ("final", Some("run"), Some(300))
        ]
    );
    assert_eq!(detail.stages[0].time_s, Some(2e-13));
    assert_eq!(detail.stages[1].time_s, Some(3e-11));
    for quantity in ["mx", "my", "E_total", "m"] {
        assert!(detail.quantities.iter().any(|q| q == quantity), "{quantity}");
    }
    assert!(!detail.quantities.iter().any(|q| q == "step" || q == "time"));
    assert_eq!(detail.frames, Some(4));
    let grid = detail.grid.unwrap();
    assert_eq!(grid.backend.as_deref(), Some("fem"));
    assert_eq!((grid.n_nodes, grid.n_elements, grid.hmax), (Some(353), Some(1545), Some(8e-9)));
    // The 70 kB chunk is counted in the size and never parsed.
    assert!(detail.total_bytes.unwrap() >= 70_000);
    assert!(!detail.total_bytes_truncated);
    assert!(detail.modified_at.as_deref().is_some_and(|t| t.ends_with('Z')));
    assert!(detail.outputs.iter().any(|o| o.kind == "zarr_store"));
}

#[test]
fn the_run_manifest_wins_and_a_damaged_one_is_reported_beside_the_facts() {
    let dir = tempfile::tempdir().unwrap();
    let results = dir.path().join("out");
    write_results_folder(&results, None);
    let mut manifest = RunManifest::new(
        "run-77",
        RunSource {
            kind: "script".into(),
            path: "C:/sim/wall.py".into(),
            sha256: Some("cd".repeat(32)),
            project_id: None,
            revision: None,
        },
        "0.1.0",
        "2026-10-05T10:00:00.000Z",
    );
    manifest.status = "failed".into();
    manifest.finished_at = Some("2026-10-05T10:05:00.000Z".into());
    write_run_manifest(&results, &manifest).unwrap();
    let detail = inspect_result(&results);
    assert!(detail.has_manifest);
    assert_eq!(detail.run_id.as_deref(), Some("run-77"));
    assert_eq!(detail.status.as_deref(), Some("failed"));
    assert_eq!(detail.source.unwrap().sha256, Some("cd".repeat(32)));
    assert_eq!(detail.finished_at.as_deref(), Some("2026-10-05T10:05:00.000Z"));
    assert!(!detail.stages.is_empty(), "stages fall back to the directories");

    fs::write(results.join("fullmag-run.json"), b"{broken").unwrap();
    let detail = inspect_result(&results);
    assert!(detail.read_error.as_deref().unwrap().contains("fullmag-run.json"));
    assert_eq!(detail.run_id.as_deref(), Some("run-session-1"));
    assert!(detail.frames.is_some());
}

#[test]
fn plain_folders_are_not_result_folders_and_missing_ones_are_read_errors() {
    let dir = tempfile::tempdir().unwrap();
    write(&dir.path().join("notes/readme.txt"), "x");
    assert!(!is_result_dir(&dir.path().join("notes")));
    assert!(!is_result_dir(&dir.path().join("none")));
    assert!(inspect_result(&dir.path().join("none")).read_error.is_some());
    assert!(inspect_result(&dir.path().join("notes/readme.txt")).read_error.is_some());
    // A foreign Zarr group is not Fullmag's.
    write(&dir.path().join("other/.zgroup"), r#"{"zarr_format":2}"#);
    write(&dir.path().join("other/.zattrs"), r#"{"schema_version":"someone.else"}"#);
    assert!(!is_result_dir(&dir.path().join("other")));
}

#[test]
fn a_bare_zarr_store_with_stage_groups_is_recognised_from_its_stage_manifests() {
    let dir = tempfile::tempdir().unwrap();
    let store = dir.path().join("main.zarr");
    write(&store.join(".zgroup"), r#"{"zarr_format":2}"#);
    write(
        &store.join("stages/stage_0000_run/manifest.json"),
        &json!({"stage_id": "run", "table_quantities": ["mx"], "field_quantities": [],
                "table_sample_count": 9, "field_sample_count": 0})
        .to_string(),
    );
    assert!(is_result_dir(&store));
    let detail = inspect_result(&store);
    assert_eq!(detail.format.as_deref(), Some("zarr"));
    assert_eq!(detail.quantities, vec!["mx".to_string()]);
    assert_eq!(detail.stages[0].steps, Some(9));
}

// ── scanner ────────────────────────────────────────────────────────────────

fn root(path: &Path) -> WorkspaceRoot {
    WorkspaceRoot {
        path: path.display().to_string(),
        kinds: Vec::new(),
        recursive: true,
        enabled: true,
    }
}

fn names(workspace: &Workspace, kind: ItemKind) -> Vec<String> {
    let mut names: Vec<String> = scanner::items_of(workspace, kind)
        .into_iter()
        .map(|item| item.name)
        .collect();
    names.sort();
    names
}

#[test]
fn the_scanner_finds_items_skips_noise_and_executes_nothing() {
    let dir = tempfile::tempdir().unwrap();
    let work = dir.path().join("work");
    let sentinel = dir.path().join("EXECUTED");
    let evil = format!(
        "import fullmag\nopen({:?}, 'w').write('x')\n",
        sentinel.display().to_string()
    );
    write(&work.join("wall.py"), &evil);
    write(&work.join("plain.py"), "print('no fullmag here')\n");
    write(&work.join("sub/deep.py"), "from fullmag.shapes import Box\n");
    for skipped in SKIPPED_DIRECTORIES {
        write(&work.join(skipped).join("hidden.py"), "import fullmag\n");
    }
    write_project(&work.join("models/a.fms"), "pid-a", true, None);
    write(&work.join("models/bad.fms"), "not a zip");
    write_results_folder(&work.join("wall.zarr"), Some(&work.join("wall.py")));
    // Inside a recognised results folder nothing is scanned further.
    write(&work.join("wall.zarr/artifacts/inside.py"), "import fullmag\n");

    let workspace = open(dir.path());
    let report = scan_roots(&workspace, &[root(&work)], &ScanOptions::default(), Actor::Web);
    assert_eq!(report.warnings, Vec::<String>::new());
    assert_eq!(report.added, 5, "{report:?}");
    assert_eq!(report.updated, 0);
    assert_eq!(report.missing, 0);
    assert!(report.skipped >= (SKIPPED_DIRECTORIES.len() + 1) as u64);
    assert!(report.scanned > 10);
    assert!(!sentinel.exists(), "the scanner must never execute a script");

    assert_eq!(names(&workspace, ItemKind::Script), vec!["deep", "wall"]);
    assert_eq!(names(&workspace, ItemKind::Project), vec!["Wall", "bad"]);
    assert_eq!(names(&workspace, ItemKind::Result), vec!["wall"]);

    // Scanned items are unused and attributed to the web front end.
    for item in workspace
        .list(&Query { include_results: true, ..Query::default() })
        .unwrap()
    {
        assert_eq!(item.use_count, 0, "{}", item.name);
        let history = workspace.history(item.id, 5).unwrap();
        assert_eq!(history[0].actor, Actor::Web);
    }
    let bad = scanner::items_of(&workspace, ItemKind::Project)
        .into_iter()
        .find(|item| item.name == "bad")
        .unwrap();
    assert_eq!(bad.status, ItemStatus::Failed);
    let wall = scanner::items_of(&workspace, ItemKind::Script)
        .into_iter()
        .find(|item| item.name == "wall")
        .unwrap();
    assert!(wall.meta["sha256"].is_string(), "the digest is observed by the scan");
    assert_eq!(wall.meta["uses_fullmag"], true);
    let result = scanner::items_of(&workspace, ItemKind::Result).remove(0);
    assert!(result.size_bytes.unwrap() >= 70_000, "size is the folder total");
    assert_eq!(result.meta["format"], "zarr");
}

#[test]
fn a_rescan_updates_keeps_forgotten_items_forgotten_and_records_edits_and_missing_files() {
    let dir = tempfile::tempdir().unwrap();
    let work = dir.path().join("work");
    write(&work.join("a.py"), "import fullmag\nx = 1\n");
    write(&work.join("b.py"), "import fullmag\n");
    write(&work.join("d.py"), "import fullmag\n");
    let workspace = open(dir.path());
    let roots = [root(&work)];
    let first = scan_roots(&workspace, &roots, &ScanOptions::default(), Actor::Web);
    assert_eq!(first.added, 3);

    let a = scanner::items_of(&workspace, ItemKind::Script)
        .into_iter()
        .find(|item| item.name == "a")
        .unwrap();
    let b = scanner::items_of(&workspace, ItemKind::Script)
        .into_iter()
        .find(|item| item.name == "b")
        .unwrap();
    workspace.forget(b.id, Actor::Web).unwrap();
    write(&work.join("a.py"), "import fullmag\nx = 2\ny = 3\n");
    fs::remove_file(work.join("b.py")).unwrap();
    fs::remove_file(work.join("d.py")).unwrap();
    write(&work.join("c.py"), "import fullmag\n");

    let second = scan_roots(&workspace, &roots, &ScanOptions::default(), Actor::Web);
    assert_eq!((second.added, second.updated, second.missing), (1, 1, 1), "{second:?}");
    let a_after = workspace.find(a.id).unwrap().unwrap();
    assert_eq!(a_after.use_count, 0, "a scan never counts a use");
    let edits: Vec<_> = workspace
        .history(a.id, 10)
        .unwrap()
        .into_iter()
        .filter(|event| event.kind == fullmag_workspace::EventKind::Edit)
        .collect();
    assert_eq!(edits.len(), 1);
    assert_eq!(edits[0].detail["lines_before"], 2);
    assert_eq!(edits[0].detail["lines_after"], 3);
    let b_after = workspace.find(b.id).unwrap().unwrap();
    assert!(b_after.forgotten, "forgotten stays forgotten");

    // A third scan finds nothing new and records no second edit.
    let third = scan_roots(&workspace, &roots, &ScanOptions::default(), Actor::Web);
    assert_eq!((third.added, third.missing), (0, 0));
    assert_eq!(
        workspace
            .history(a.id, 10)
            .unwrap()
            .iter()
            .filter(|event| event.kind == fullmag_workspace::EventKind::Edit)
            .count(),
        1
    );
}

#[test]
fn limits_stop_the_scan_with_a_warning_and_roots_are_validated() {
    let dir = tempfile::tempdir().unwrap();
    let work = dir.path().join("work");
    for index in 0..20 {
        write(&work.join(format!("s{index}.py")), "import fullmag\n");
    }
    let workspace = open(dir.path());
    let capped = scan_roots(
        &workspace,
        &[root(&work)],
        &ScanOptions { max_entries: 5, ..ScanOptions::default() },
        Actor::Web,
    );
    assert!(capped.warnings.iter().any(|w| w.contains("stopped after 5 entries")));
    assert!(capped.added <= 5);

    let timed = scan_roots(
        &workspace,
        &[root(&work)],
        &ScanOptions { time_budget: Duration::ZERO, ..ScanOptions::default() },
        Actor::Web,
    );
    assert!(timed.warnings.iter().any(|w| w.contains("stopped after")));

    // Depth: a script three levels down is out of reach at depth 1.
    write(&work.join("a/b/c/deep.py"), "import fullmag\n");
    let shallow = scan_roots(
        &open(&dir.path().join("other")),
        &[root(&work)],
        &ScanOptions { max_depth: 1, ..ScanOptions::default() },
        Actor::Web,
    );
    assert_eq!(shallow.added, 20);

    let report = scan_roots(
        &workspace,
        &[
            WorkspaceRoot { path: "relative/path".into(), ..root(&work) },
            WorkspaceRoot { path: dir.path().join("nope").display().to_string(), ..root(&work) },
            WorkspaceRoot { enabled: false, ..root(&work) },
        ],
        &ScanOptions::default(),
        Actor::Web,
    );
    assert_eq!(report.warnings.len(), 2, "{report:?}");
    assert_eq!(report.scanned, 0);
}

#[test]
fn root_kinds_and_non_recursive_roots_are_honoured() {
    let dir = tempfile::tempdir().unwrap();
    let work = dir.path().join("work");
    write(&work.join("a.py"), "import fullmag\n");
    write(&work.join("sub/b.py"), "import fullmag\n");
    write_project(&work.join("p.fms"), "pid-p", false, None);
    let workspace = open(dir.path());
    let only_scripts = WorkspaceRoot {
        kinds: vec![ItemKind::Script],
        recursive: false,
        ..root(&work)
    };
    let report = scan_roots(&workspace, &[only_scripts], &ScanOptions::default(), Actor::Web);
    assert_eq!(report.added, 1);
    assert_eq!(names(&workspace, ItemKind::Script), vec!["a"]);
    assert!(names(&workspace, ItemKind::Project).is_empty());
}

#[cfg(unix)]
#[test]
fn symbolic_links_are_never_followed() {
    let dir = tempfile::tempdir().unwrap();
    let work = dir.path().join("work");
    let outside = dir.path().join("outside");
    write(&outside.join("secret.py"), "import fullmag\n");
    fs::create_dir_all(&work).unwrap();
    std::os::unix::fs::symlink(&outside, work.join("link")).unwrap();
    let workspace = open(dir.path());
    let report = scan_roots(&workspace, &[root(&work)], &ScanOptions::default(), Actor::Web);
    assert_eq!(report.added, 0);
    assert!(report.skipped >= 1);
}

// ── add one path ───────────────────────────────────────────────────────────

#[test]
fn classify_path_accepts_only_the_documented_shapes() {
    let dir = tempfile::tempdir().unwrap();
    let script = dir.path().join("a.py");
    let project = dir.path().join("a.fms");
    let results = dir.path().join("r.zarr");
    write(&script, "x = 1\n");
    write_project(&project, "pid", false, None);
    write_results_folder(&results, None);
    write(&dir.path().join("notes.txt"), "x");

    assert_eq!(classify_path(&script, None), Ok(ItemKind::Script));
    assert_eq!(classify_path(&project, Some(ItemKind::Project)), Ok(ItemKind::Project));
    assert_eq!(classify_path(&results, None), Ok(ItemKind::Result));
    assert!(classify_path(&script, Some(ItemKind::Project)).unwrap_err().contains("not a project"));
    assert!(classify_path(Path::new("rel/a.py"), None).unwrap_err().contains("absolute"));
    assert!(classify_path(&dir.path().join("notes.txt"), None).is_err());
    assert!(classify_path(&dir.path().join("nope.py"), None).is_err());
    assert!(classify_path(dir.path(), None).unwrap_err().contains("results folder"));
    let dotdot: PathBuf = dir.path().join("sub").join("..").join("a.py");
    assert!(classify_path(&dotdot, None).unwrap_err().contains(".."));
}

#[cfg(unix)]
#[test]
fn classify_path_refuses_a_symbolic_link() {
    let dir = tempfile::tempdir().unwrap();
    let target = dir.path().join("t.py");
    write(&target, "x = 1\n");
    let link = dir.path().join("l.py");
    std::os::unix::fs::symlink(&target, &link).unwrap();
    assert!(classify_path(&link, None).unwrap_err().contains("symbolic link"));
}

#[test]
fn an_explicit_add_counts_as_a_use_and_brings_a_forgotten_item_back() {
    let dir = tempfile::tempdir().unwrap();
    let script = dir.path().join("a.py");
    write(&script, "import fullmag\n");
    let workspace = open(dir.path());
    let described = describe(&script, ItemKind::Script);
    let receipt = store_observed(&workspace, &described, Actor::Web, true).unwrap();
    assert!(receipt.created);
    let item = workspace.find(receipt.item_id).unwrap().unwrap();
    assert_eq!(item.use_count, 1);
    workspace.forget(item.id, Actor::Web).unwrap();
    store_observed(&workspace, &described, Actor::Web, true).unwrap();
    let item = workspace.find(receipt.item_id).unwrap().unwrap();
    assert_eq!((item.use_count, item.forgotten), (2, false));
    let history = workspace.history(item.id, 10).unwrap();
    assert_eq!(history[0].detail["source"], "add");
    assert_eq!(history[0].actor, Actor::Web);
}

// ── links ──────────────────────────────────────────────────────────────────

#[test]
fn results_link_to_their_script_by_path_or_digest_and_back() {
    let dir = tempfile::tempdir().unwrap();
    let work = dir.path().join("work");
    let script = work.join("wall.py");
    write(&script, "import fullmag\nx = 1\n");
    let copy = work.join("copy_of_wall.py");
    fs::copy(&script, &copy).unwrap();
    let workspace = open(dir.path());

    let script_receipt =
        store_observed(&workspace, &describe(&script, ItemKind::Script), Actor::Web, false).unwrap();
    let script_item = workspace.find(script_receipt.item_id).unwrap().unwrap();
    let sha = script_item.meta["sha256"].as_str().unwrap().to_string();

    // One result names the script by path; another only by digest (the script moved).
    for (name, source_path) in [("by_path", script.display().to_string()), ("by_hash", "C:/gone/old.py".to_string())] {
        let folder = work.join(name);
        write_results_folder(&folder, None);
        write_run_manifest(
            &folder,
            &RunManifest::new(
                format!("run-{name}"),
                RunSource {
                    kind: "script".into(),
                    path: source_path,
                    sha256: Some(sha.clone()),
                    project_id: None,
                    revision: None,
                },
                "0.1.0",
                "2026-10-05T10:00:00.000Z",
            ),
        )
        .unwrap();
        store_observed(&workspace, &describe(&folder, ItemKind::Result), Actor::Web, false).unwrap();
    }
    // An unrelated result.
    let other = work.join("other");
    write_results_folder(&other, None);
    store_observed(&workspace, &describe(&other, ItemKind::Result), Actor::Web, false).unwrap();

    let linked = link::linked_results(&workspace, &script_item).unwrap();
    let mut linked_names: Vec<&str> = linked.iter().map(|item| item.name.as_str()).collect();
    linked_names.sort();
    assert_eq!(linked_names, vec!["by_hash", "by_path"]);

    let result = linked.iter().find(|item| item.name == "by_path").unwrap();
    let back = link::linked_source(&workspace, result).unwrap().unwrap();
    assert_eq!(back.id, script_item.id);
    let by_hash = linked.iter().find(|item| item.name == "by_hash").unwrap();
    assert_eq!(
        link::linked_source(&workspace, by_hash).unwrap().unwrap().id,
        script_item.id
    );
    let unrelated = workspace.find(other.as_path()).unwrap().unwrap();
    assert!(link::linked_source(&workspace, &unrelated).unwrap().is_none());

    // The copy has the same digest, so it also claims the digest-linked result.
    let copy_receipt =
        store_observed(&workspace, &describe(&copy, ItemKind::Script), Actor::Web, false).unwrap();
    let copy_item = workspace.find(copy_receipt.item_id).unwrap().unwrap();
    assert!(link::linked_results(&workspace, &copy_item).unwrap().len() >= 2);
}

#[test]
fn project_results_link_by_project_id() {
    let dir = tempfile::tempdir().unwrap();
    let work = dir.path().join("work");
    let project = work.join("a.fms");
    write_project(&project, "pid-link", false, None);
    let workspace = open(dir.path());
    let receipt =
        store_observed(&workspace, &describe(&project, ItemKind::Project), Actor::Web, false).unwrap();
    let project_item = workspace.find(receipt.item_id).unwrap().unwrap();
    let folder = work.join("run1");
    write_results_folder(&folder, None);
    write_run_manifest(
        &folder,
        &RunManifest::new(
            "run-p",
            RunSource {
                kind: "project".into(),
                path: "D:/moved/elsewhere.fms".into(),
                sha256: None,
                project_id: Some("pid-link".into()),
                revision: Some(3),
            },
            "0.1.0",
            "2026-10-05T10:00:00.000Z",
        ),
    )
    .unwrap();
    store_observed(&workspace, &describe(&folder, ItemKind::Result), Actor::Web, false).unwrap();
    let linked = link::linked_results(&workspace, &project_item).unwrap();
    assert_eq!(linked.len(), 1);
    assert_eq!(linked[0].name, "run1");
}

#[test]
fn an_api_project_run_without_a_known_path_links_by_project_id_only() {
    let dir = tempfile::tempdir().unwrap();
    let work = dir.path().join("work");
    let project = work.join("a.fms");
    write_project(&project, "pid-api", false, None);
    let other = work.join("b.fms");
    write_project(&other, "pid-other", false, None);
    let workspace = open(dir.path());
    let item_of = |path: &Path| {
        let receipt =
            store_observed(&workspace, &describe(path, ItemKind::Project), Actor::Web, false).unwrap();
        workspace.find(receipt.item_id).unwrap().unwrap()
    };
    let (project_item, other_item) = (item_of(&project), item_of(&other));
    let folder = work.join("results/run-1/step-attempt-1");
    write_results_folder(&folder, None);
    let mut manifest = RunManifest::new(
        "run-1-1",
        RunSource {
            kind: "project".into(),
            path: String::new(),
            sha256: Some("ab".repeat(32)),
            project_id: Some("pid-api".into()),
            revision: Some(4),
        },
        "0.1.0",
        "2026-10-05T10:00:00.000Z",
    );
    manifest.launched_by = Some("api".into());
    write_run_manifest(&folder, &manifest).unwrap();
    store_observed(&workspace, &describe(&folder, ItemKind::Result), Actor::Web, false).unwrap();
    assert_eq!(link::linked_results(&workspace, &project_item).unwrap().len(), 1);
    assert!(link::linked_results(&workspace, &other_item).unwrap().is_empty());
    let result = workspace
        .list(&fullmag_workspace::Query {
            kind: Some(ItemKind::Result),
            limit: 10,
            ..Default::default()
        })
        .unwrap()
        .remove(0);
    let source = link::linked_source(&workspace, &result).unwrap().unwrap();
    assert_eq!(source.project_id.as_deref(), Some("pid-api"));
}
