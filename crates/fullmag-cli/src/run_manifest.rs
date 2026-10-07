//! `fullmag-run.json` for every script run (`fullmag.run_manifest.v1`).
//!
//! Managed runs (started by the desktop host or with `--receipt`) and plain
//! `fullmag script.py` runs both write it into the results folder: atomically
//! when the folder is known (`status: running`) and again when the run ends.
//! The manifest is the link the workspace scanner and the browser inspector
//! use to tie a results folder to its script. It is best effort: a write that
//! fails is reported on stderr and never changes the outcome of the run, and
//! nothing is ever written next to or into the user's `.py`.

use std::path::{Path, PathBuf};
use std::sync::Mutex;

use fullmag_workspace::now_rfc3339;
use fullmag_workspace_inspect::manifest::{
    collect_outputs, write_run_manifest, RunManifest, RunSource,
};
use fullmag_workspace_inspect::read_layout;
use serde_json::Value;

struct State {
    manifest: RunManifest,
    dir: Option<PathBuf>,
}

static STATE: Mutex<Option<State>> = Mutex::new(None);

fn with_state<T>(body: impl FnOnce(&mut State) -> T) -> Option<T> {
    let mut guard = STATE.lock().unwrap_or_else(|poison| poison.into_inner());
    guard.as_mut().map(body)
}

/// What the run is, known before it starts.
pub(crate) struct Begin {
    /// Absolute script path, without a `\\?\` prefix.
    pub(crate) script_path: String,
    pub(crate) script_sha256: Option<String>,
    /// What the user asked for (backend, mode, precision, device).
    pub(crate) requested: Value,
    /// `cli`, `desktop` or `python`.
    pub(crate) launched_by: String,
}

/// Start tracking a run. Nothing is written until the results folder is known.
pub(crate) fn begin(begin: Begin) {
    let started_at = now_rfc3339();
    let mut manifest = RunManifest::new(
        provisional_run_id(),
        RunSource {
            kind: "script".into(),
            path: begin.script_path,
            sha256: begin.script_sha256,
            project_id: None,
            revision: None,
        },
        fullmag_build_info::version(),
        started_at,
    );
    manifest.requested = begin.requested;
    manifest.launched_by = Some(begin.launched_by);
    let mut guard = STATE.lock().unwrap_or_else(|poison| poison.into_inner());
    *guard = Some(State {
        manifest,
        dir: None,
    });
}

fn provisional_run_id() -> String {
    let millis = std::time::SystemTime::now()
        .duration_since(std::time::UNIX_EPOCH)
        .map(|elapsed| elapsed.as_millis())
        .unwrap_or(0);
    format!("run-{millis}-{}", std::process::id())
}

/// The resolved runtime noted so far (`script_launch::resolved_json` shape).
pub(crate) fn resolved_runtime() -> Option<Value> {
    with_state(|state| state.manifest.resolved.clone())
        .filter(|resolved| !resolved.is_null())
        .map(|resolved| {
            // `classify_outcome` reads the selection keys, not the receipt's
            // `resolved` block: rebuild the keys it needs.
            serde_json::json!({
                "requested_device": resolved.pointer("/requested_effective/device"),
                "resolved_device": resolved.get("device"),
            })
        })
}

/// The run's ids are known (the orchestrator chose them).
pub(crate) fn note_ids(session_id: &str, run_id: &str) {
    with_state(|state| {
        state.manifest.session_id = Some(session_id.to_string());
        state.manifest.run_id = run_id.to_string();
    });
}

/// The runtime resolved to `resolved` (see `script_launch::resolved_json`).
pub(crate) fn note_runtime(resolved: Value) {
    with_state(|state| state.manifest.resolved = resolved);
}

/// The results folder exists: write the `running` manifest into it.
pub(crate) fn note_results_dir(dir: &Path) {
    let snapshot = with_state(|state| {
        state.dir = Some(dir.to_path_buf());
        state.manifest.clone()
    });
    if let Some(manifest) = snapshot {
        write(dir, &manifest);
    }
}

/// The run ended: record the status, exit code, stages and outputs.
pub(crate) fn finish(status: &str, exit_code: i32, error: Option<&str>) {
    let finished = with_state(|state| {
        let dir = state.dir.clone()?;
        let manifest = finished_manifest(&state.manifest, &dir, status, exit_code, error);
        state.manifest = manifest.clone();
        Some((dir, manifest))
    })
    .flatten();
    if let Some((dir, manifest)) = finished {
        write(&dir, &manifest);
    }
}

/// `manifest` completed with the outcome and what the folder now holds. Pure
/// apart from reading `dir`; a run that ended is never `running`.
pub(crate) fn finished_manifest(
    manifest: &RunManifest,
    dir: &Path,
    status: &str,
    exit_code: i32,
    error: Option<&str>,
) -> RunManifest {
    let mut finished = manifest.clone();
    finished.status = status.to_string();
    finished.exit_code = Some(exit_code);
    finished.error = error.map(str::to_string);
    finished.finished_at = Some(now_rfc3339());
    finished.stages = read_layout(dir).stages;
    finished.outputs = collect_outputs(dir);
    finished
}

fn write(dir: &Path, manifest: &RunManifest) {
    if let Err(error) = write_run_manifest(dir, manifest) {
        eprintln!("[fullmag] could not write the run manifest: {error}");
    }
}

#[cfg(test)]
mod tests {
    use super::*;
    use fullmag_workspace_inspect::manifest::read_run_manifest;
    use serde_json::json;

    fn sample() -> RunManifest {
        let mut manifest = RunManifest::new(
            "run-session-1",
            RunSource {
                kind: "script".into(),
                path: "C:/sim/wall.py".into(),
                sha256: Some("ab".repeat(32)),
                project_id: None,
                revision: None,
            },
            "0.1.0",
            "2026-10-05T10:00:00.000Z",
        );
        manifest.requested = json!({"backend": "fdm", "device": "as_authored"});
        manifest.resolved = json!({"backend": "fdm", "device": "cpu", "precision": "double"});
        manifest.launched_by = Some("cli".into());
        manifest
    }

    #[test]
    fn a_finished_manifest_carries_outcome_stages_and_outputs() {
        let dir = tempfile::tempdir().unwrap();
        let stage = dir.path().join("stages/stage_00_relax");
        std::fs::create_dir_all(&stage).unwrap();
        std::fs::write(stage.join("scalars.csv"), "step,time,mx\n1,1e-13,0.5\n").unwrap();
        std::fs::create_dir_all(dir.path().join("artifacts")).unwrap();
        std::fs::write(dir.path().join("artifacts/metadata.json"), "{\"status\":\"completed\"}").unwrap();

        let finished = finished_manifest(&sample(), dir.path(), "failed", 14, Some("no GPU"));
        assert_eq!(finished.status, "failed");
        assert_eq!(finished.exit_code, Some(14));
        assert_eq!(finished.error.as_deref(), Some("no GPU"));
        assert!(finished.finished_at.as_deref().is_some_and(|t| t.ends_with('Z')));
        assert_eq!(finished.stages[0].kind.as_deref(), Some("relax"));
        assert_eq!(finished.stages[0].steps, Some(1));
        assert!(finished.outputs.iter().any(|o| o.path == "artifacts/metadata.json"));
        // Requested and resolved stay separate and untouched.
        assert_eq!(finished.requested["device"], "as_authored");
        assert_eq!(finished.resolved["device"], "cpu");
        assert_eq!(finished.source.path, "C:/sim/wall.py");
    }

    #[test]
    fn the_lifecycle_writes_running_first_and_the_outcome_last() {
        let dir = tempfile::tempdir().unwrap();
        let results = dir.path().join("wall.zarr");
        begin(Begin {
            script_path: "C:/sim/wall.py".into(),
            script_sha256: Some("cd".repeat(32)),
            requested: json!({"backend": "auto"}),
            launched_by: "cli".into(),
        });
        // Nothing is written before the folder is known.
        assert!(!results.exists());
        note_ids("session-9", "run-session-9");
        note_runtime(json!({"device": "gpu", "requested_effective": {"device": "gpu"}}));
        assert_eq!(
            resolved_runtime().unwrap()["resolved_device"],
            "gpu",
            "classify_outcome reads the resolved device back"
        );
        note_results_dir(&results);
        let running = read_run_manifest(&results).unwrap().unwrap();
        assert_eq!(running.status, "running");
        assert_eq!(running.run_id, "run-session-9");
        assert_eq!(running.session_id.as_deref(), Some("session-9"));
        assert_eq!(running.launched_by.as_deref(), Some("cli"));
        assert_eq!(running.finished_at, None);

        finish("completed", 0, None);
        let done = read_run_manifest(&results).unwrap().unwrap();
        assert_eq!(done.status, "completed");
        assert_eq!(done.exit_code, Some(0));
        assert!(done.finished_at.is_some());
        assert_eq!(done.source.sha256, Some("cd".repeat(32)));
        *STATE.lock().unwrap() = None;
        // The script's own folder is untouched: only the results folder was written.
        assert_eq!(std::fs::read_dir(dir.path()).unwrap().count(), 1);
    }
}
