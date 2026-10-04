//! Best-effort usage history for the per-user workspace database.
//!
//! `fullmag script.py` records a `run`, `fullmag project open` and
//! `fullmag session open` record an `open` (spec
//! `docs/design/start-screen/docs/07-workspace-database.md`, section 4). Every
//! function here swallows its errors: a locked, damaged or newer database must
//! never change the outcome of the command it describes.

use std::ffi::OsString;
use std::path::{Path, PathBuf};
use std::time::Instant;

use clap::{Parser, ValueEnum};
use fullmag_workspace::{
    now_rfc3339, record_best_effort, redact_args, script_meta, Actor, EventKind, ItemKind,
    RecordEvent, Workspace,
};
use serde_json::{json, Value};

use crate::args::ScriptCli;

/// What `begin_script_run` remembers to describe the outcome later.
pub(crate) struct ScriptRun {
    script: PathBuf,
    device: String,
    started: Instant,
}

/// Record the start of a script run. Returns `None` (and records nothing)
/// when the arguments do not parse or the script is not a file.
pub(crate) fn begin_script_run(raw_args: &[OsString]) -> Option<ScriptRun> {
    let cli = ScriptCli::try_parse_from(raw_args.iter()).ok()?;
    if !cli.script.is_file() {
        return None;
    }
    let name = |value: Option<&str>| value.unwrap_or("auto").to_string();
    let device = name(
        cli.backend
            .and_then(|v| v.to_possible_value())
            .as_ref()
            .map(|v| v.get_name()),
    );
    let mode = cli
        .mode
        .and_then(|v| v.to_possible_value())
        .map(|v| v.get_name().to_string());
    let precision = cli
        .precision
        .and_then(|v| v.to_possible_value())
        .map(|v| v.get_name().to_string());

    // Arguments only, never environment values; secret-looking option values
    // are redacted and the script path itself is the item, not an argument.
    let args: Vec<String> = raw_args
        .iter()
        .skip(1)
        .map(|arg| arg.to_string_lossy().into_owned())
        .filter(|arg| Path::new(arg) != cli.script.as_path())
        .collect();

    let mut meta = script_meta(&cli.script).unwrap_or_else(|_| json!({}));
    meta["last_run"] = json!({
        "status": "started",
        "at": now_rfc3339(),
        "device": device,
    });
    meta["args"] = json!(redact_args(&args));

    record_best_effort(
        RecordEvent::new(ItemKind::Script, &cli.script, EventKind::Run, Actor::Cli)
            .with_detail(json!({
                "device": device,
                "mode": mode,
                "precision": precision,
                "interactive": cli.interactive,
                "headless": cli.headless,
                "status": "started",
            }))
            .with_meta_patch(meta),
    );
    Some(ScriptRun {
        script: cli.script,
        device,
        started: Instant::now(),
    })
}

/// Update `meta.last_run` with the outcome. A run that is killed before it
/// returns keeps the `started` status, which is what happened as far as the
/// CLI can tell.
pub(crate) fn finish_script_run(run: Option<ScriptRun>, result: &anyhow::Result<()>) {
    let Some(run) = run else { return };
    let patch = json!({
        "last_run": {
            "status": if result.is_ok() { "ok" } else { "failed" },
            "at": now_rfc3339(),
            "duration_seconds": run.started.elapsed().as_secs_f64(),
            "device": run.device,
        }
    });
    if let Ok((workspace, outcome)) = Workspace::open_default() {
        fullmag_workspace::log_outcome(&outcome);
        let _ = workspace.patch_meta(run.script.as_path(), &patch);
    }
}

/// Record that a `.fms` project was opened from the command line.
pub(crate) fn record_project_open(
    path: &Path,
    project_id: Option<&str>,
    detail: Value,
    meta_patch: Value,
) {
    let mut event =
        RecordEvent::new(ItemKind::Project, path, EventKind::Open, Actor::Cli).with_detail(detail);
    if let Some(project_id) = project_id {
        event = event.with_project_id(project_id);
    }
    if !meta_patch.is_null() {
        event = event.with_meta_patch(meta_patch);
    }
    record_best_effort(event);
}
