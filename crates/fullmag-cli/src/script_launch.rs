//! Host-managed script runs (docs/design/start-screen/docs/08-script-open.md 6.2 and 6.3).
//!
//! A run is *managed* when any of `--receipt`, `--expect-script-sha256` or
//! `--launched-by` is present. Managed runs
//!
//! * verify the script bytes before anything executes (exit 11),
//! * resolve the interpreter once, up front (exit 10),
//! * write `fullmag.script_run_receipt.v1` atomically on every exit path,
//! * publish a small `progress.json` next to the receipt so the launching host
//!   learns when the Control Room is ready and when the model waits for COMPUTE,
//! * stop on request when `stop-request` appears next to the receipt, and
//! * use the documented exit codes.
//!
//! Plain `fullmag script.py` invocations never reach this code path beyond the
//! usage history they always wrote.

use std::ffi::OsString;
use std::path::{Path, PathBuf};
use std::sync::atomic::{AtomicBool, Ordering};
use std::sync::Mutex;
use std::time::{Duration, Instant};

use anyhow::{anyhow, Context, Result};
use clap::Parser;
use fullmag_runtime_control::python_runtime::{resolve_interpreter, InterpreterSource, PYTHON_ENV};
use fullmag_workspace::{now_rfc3339, redact_args};
use serde_json::{json, Value};
use sha2::{Digest, Sha256};

use crate::args::{LaunchedByArg, ScriptCli, UiModeArg};
use crate::types::SessionRuntimeSelection;

pub(crate) const RECEIPT_SCHEMA: &str = "fullmag.script_run_receipt.v1";
pub(crate) const PROGRESS_SCHEMA: &str = "fullmag.script_run_progress.v1";
/// File next to the receipt whose appearance asks the run to stop.
pub(crate) const STOP_REQUEST_FILE: &str = "stop-request";
/// File next to the receipt that carries the live run state.
pub(crate) const PROGRESS_FILE: &str = "progress.json";
const STOP_WATCH_INTERVAL: Duration = Duration::from_millis(250);

/// Why a managed run ended, in the documented exit-code vocabulary.
#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub(crate) enum ExitKind {
    /// 1: any other failure.
    Failure,
    /// 2: usage.
    Usage,
    /// 10: no usable interpreter.
    Interpreter,
    /// 11: the script bytes differ from `--expect-script-sha256`.
    ScriptChanged,
    /// 12: syntax error.
    Syntax,
    /// 13: materialization or planning failed.
    Materialization,
    /// 14: the requested runtime is unavailable; no fallback was attempted.
    RuntimeUnavailable,
    /// 130: stopped by the user.
    Stopped,
}

impl ExitKind {
    pub(crate) fn code(self) -> i32 {
        match self {
            Self::Failure => 1,
            Self::Usage => 2,
            Self::Interpreter => 10,
            Self::ScriptChanged => 11,
            Self::Syntax => 12,
            Self::Materialization => 13,
            Self::RuntimeUnavailable => 14,
            Self::Stopped => 130,
        }
    }

    /// `outcome.status` of the receipt for a run that ended this way.
    pub(crate) fn outcome_status(self) -> &'static str {
        match self {
            Self::Usage | Self::Interpreter | Self::ScriptChanged | Self::Syntax => "not_started",
            Self::Stopped => "cancelled",
            Self::Failure | Self::Materialization | Self::RuntimeUnavailable => "failed",
        }
    }
}

/// Where a managed run is, in the order it passes through.
#[derive(Debug, Clone, Copy, PartialEq, Eq, PartialOrd, Ord)]
pub(crate) enum Stage {
    Starting,
    Materializing,
    WaitingForSolve,
    Running,
}

impl Stage {
    pub(crate) fn as_str(self) -> &'static str {
        match self {
            Self::Starting => "starting",
            Self::Materializing => "materializing",
            Self::WaitingForSolve => "waiting_for_solve",
            Self::Running => "running",
        }
    }
}

/// Facts about the script bytes read before the run.
#[derive(Debug, Clone, PartialEq, Eq)]
pub(crate) struct ScriptFacts {
    pub(crate) sha256: String,
    pub(crate) bytes: usize,
}

pub(crate) fn sha256_hex(bytes: &[u8]) -> String {
    format!("{:x}", Sha256::digest(bytes))
}

/// Compare the bytes of `path` with the expected digest (case-insensitive hex).
/// `Err(ScriptFacts)` carries the digest actually found.
pub(crate) fn verify_script_bytes(
    path: &Path,
    expected: Option<&str>,
) -> Result<std::result::Result<ScriptFacts, ScriptFacts>> {
    let raw = std::fs::read(path)
        .with_context(|| format!("cannot read script {}", path.display()))?;
    let facts = ScriptFacts {
        sha256: sha256_hex(&raw),
        bytes: raw.len(),
    };
    Ok(match expected {
        Some(expected) if !expected.trim().eq_ignore_ascii_case(&facts.sha256) => Err(facts),
        _ => Ok(facts),
    })
}

#[derive(Debug, Default)]
struct Report {
    receipt_path: Option<PathBuf>,
    started: Option<Instant>,
    started_at: String,
    stage: Option<Stage>,
    script: Value,
    interpreter: Value,
    process: Value,
    requested: Value,
    runtime: Option<Value>,
    session_id: Option<String>,
    run_id: Option<String>,
    problem_ir_source_hash: Option<String>,
    results_dir: Option<String>,
    next_to_script: bool,
    api_port: Option<u16>,
    ui_ready: bool,
    failure: Option<ExitKind>,
    finalized: bool,
}

static REPORT: Mutex<Option<Report>> = Mutex::new(None);
static WAIT_FOR_SOLVE: AtomicBool = AtomicBool::new(false);
static FINALIZED: AtomicBool = AtomicBool::new(false);

fn with_report<T>(body: impl FnOnce(&mut Report) -> T) -> Option<T> {
    let mut guard = REPORT.lock().unwrap_or_else(|poison| poison.into_inner());
    guard.as_mut().map(body)
}

/// `--wait-for-solve` as a flag instead of `FULLMAG_ATTACHED_WAIT_FOR_SOLVE`.
pub(crate) fn wait_for_solve_flag() -> bool {
    WAIT_FOR_SOLVE.load(Ordering::Relaxed)
}

/// True when this process is a managed run (a report exists).
pub(crate) fn is_managed_run() -> bool {
    with_report(|_| ()).is_some()
}

// ── hooks called by the orchestrator; all are no-ops outside managed runs ───

pub(crate) fn note_stage(stage: Stage) {
    let changed = with_report(|report| {
        if report.stage.map_or(true, |current| stage > current) {
            report.stage = Some(stage);
            true
        } else {
            false
        }
    });
    if changed == Some(true) {
        write_progress();
    }
}

pub(crate) fn note_api_port(port: u16) {
    with_report(|report| report.api_port = Some(port));
    write_progress();
}

pub(crate) fn note_ui_ready() {
    with_report(|report| report.ui_ready = true);
    write_progress();
}

pub(crate) fn note_ids(session_id: &str, run_id: &str) {
    with_report(|report| {
        report.session_id = Some(session_id.to_string());
        report.run_id = Some(run_id.to_string());
    });
    write_progress();
}

pub(crate) fn note_runtime(selection: &SessionRuntimeSelection) {
    if let Ok(value) = serde_json::to_value(selection) {
        with_report(|report| report.runtime = Some(value));
    }
}

pub(crate) fn note_results_dir(dir: &Path) {
    with_report(|report| report.results_dir = Some(display_path(dir)));
}

pub(crate) fn note_source_hash(hash: Option<&str>) {
    with_report(|report| report.problem_ir_source_hash = hash.map(str::to_string));
}

/// Tag the failure about to be returned. The first tag wins.
pub(crate) fn mark_failure(kind: ExitKind) {
    with_report(|report| {
        report.failure.get_or_insert(kind);
    });
}

// ── pure helpers (unit-tested) ──────────────────────────────────────────────

/// Path as a person would type it: no `\\?\` verbatim prefix.
pub(crate) fn display_path(path: &Path) -> String {
    let text = path.display().to_string();
    if let Some(rest) = text.strip_prefix(r"\\?\UNC\") {
        format!(r"\\{rest}")
    } else {
        text.strip_prefix(r"\\?\").map(str::to_string).unwrap_or(text)
    }
}

/// Error text that means "the requested runtime cannot run here".
pub(crate) fn is_runtime_unavailable_message(message: &str) -> bool {
    let lower = message.to_ascii_lowercase();
    [
        "gpu requested",
        "forced device mismatch",
        "forced backend mismatch",
        "missing_runtime",
        "missing_driver",
        "missing_library",
        "no runtime engine",
        "native fem gpu is unavailable",
        "was requested, but",
        "backend is not available",
    ]
    .iter()
    .any(|needle| lower.contains(needle))
}

/// `(requested device, resolved device)` of the recorded runtime selection.
fn runtime_devices(runtime: &Value) -> (Option<String>, Option<String>) {
    let text = |key: &str| runtime.get(key).and_then(Value::as_str).map(str::to_string);
    (text("requested_device"), text("resolved_device"))
}

/// What the receipt says about how the run ended.
#[derive(Debug, Clone, PartialEq, Eq)]
pub(crate) struct Outcome {
    pub(crate) kind: Option<ExitKind>,
    pub(crate) status: &'static str,
    pub(crate) error: Option<String>,
}

impl Outcome {
    pub(crate) fn exit_code(&self) -> i32 {
        self.kind.map_or(0, ExitKind::code)
    }
}

/// Decide the outcome from the run result and what the run reported.
///
/// `runtime` is the last recorded runtime selection. A forced GPU that did not
/// resolve to a GPU is a failed run, never a successful CPU run (R6).
pub(crate) fn classify_outcome(
    error: Option<&str>,
    tagged: Option<ExitKind>,
    stage: Stage,
    runtime: Option<&Value>,
    requested_device: Option<&str>,
) -> Outcome {
    let (effective, resolved) = runtime.map(runtime_devices).unwrap_or((None, None));
    // GPU forced either by the launcher (flag or environment) or by the script.
    let forced_gpu = requested_device == Some("gpu") || effective.as_deref() == Some("gpu");
    match error {
        None => {
            if tagged == Some(ExitKind::Stopped) {
                return Outcome {
                    kind: Some(ExitKind::Stopped),
                    status: "cancelled",
                    error: None,
                };
            }
            if forced_gpu && resolved.as_deref() != Some("gpu") {
                return Outcome {
                    kind: Some(ExitKind::RuntimeUnavailable),
                    status: "failed",
                    error: Some(format!(
                        "GPU was requested but the run resolved to {}; no fallback is allowed",
                        resolved.as_deref().unwrap_or("no device")
                    )),
                };
            }
            Outcome {
                kind: None,
                status: "completed",
                error: None,
            }
        }
        Some(message) => {
            let kind = tagged.unwrap_or_else(|| {
                if is_runtime_unavailable_message(message)
                    || (forced_gpu && message.to_ascii_lowercase().contains("cuda"))
                {
                    ExitKind::RuntimeUnavailable
                } else if stage <= Stage::Materializing {
                    ExitKind::Materialization
                } else {
                    ExitKind::Failure
                }
            });
            Outcome {
                kind: Some(kind),
                status: kind.outcome_status(),
                error: Some(message.to_string()),
            }
        }
    }
}

fn requested_json(cli: &ScriptCli) -> Value {
    use clap::ValueEnum;
    let name = |value: Option<String>| value.unwrap_or_else(|| "as_authored".to_string());
    let device = ["FULLMAG_FDM_EXECUTION", "FULLMAG_FEM_EXECUTION"]
        .iter()
        .find_map(|key| std::env::var(key).ok())
        .filter(|value| !value.trim().is_empty());
    json!({
        "backend": name(cli.backend.and_then(|v| v.to_possible_value()).map(|v| v.get_name().to_string())),
        "mode": name(cli.mode.and_then(|v| v.to_possible_value()).map(|v| v.get_name().to_string())),
        "precision": name(cli.precision.and_then(|v| v.to_possible_value()).map(|v| v.get_name().to_string())),
        "device": name(device),
    })
}

fn resolved_json(runtime: Option<&Value>) -> Value {
    let Some(runtime) = runtime else {
        return Value::Null;
    };
    let pick = |key: &str| runtime.get(key).cloned().unwrap_or(Value::Null);
    json!({
        "backend": pick("resolved_backend"),
        "device": pick("resolved_device"),
        "precision": pick("resolved_precision"),
        "mode": pick("resolved_mode"),
        "runtime_family": pick("resolved_runtime_family"),
        "engine_id": pick("resolved_engine_id"),
        "worker": pick("resolved_worker"),
        "fallback": pick("resolved_fallback"),
        "requested_effective": {
            "backend": pick("requested_backend"),
            "device": pick("requested_device"),
            "precision": pick("requested_precision"),
            "mode": pick("requested_mode"),
        },
    })
}

fn build_receipt(report: &Report, outcome: &Outcome) -> Value {
    let duration = report
        .started
        .map(|started| started.elapsed().as_secs_f64())
        .unwrap_or(0.0);
    json!({
        "schema": RECEIPT_SCHEMA,
        "script": report.script,
        "interpreter": report.interpreter,
        "process": report.process,
        "requested": report.requested,
        "resolved": resolved_json(report.runtime.as_ref()),
        "ids": {
            "session_id": report.session_id,
            "run_id": report.run_id,
            "problem_ir_source_hash": report.problem_ir_source_hash,
        },
        "results": {
            "dir": report.results_dir,
            "next_to_script": report.next_to_script,
        },
        "outcome": {
            "status": outcome.status,
            "exit_code": outcome.exit_code(),
            "started_at": report.started_at,
            "finished_at": now_rfc3339(),
            "duration_seconds": duration,
            "error": outcome.error,
        },
    })
}

fn progress_document(report: &Report) -> Value {
    json!({
        "schema": PROGRESS_SCHEMA,
        "state": report.stage.unwrap_or(Stage::Starting).as_str(),
        "api_port": report.api_port,
        "ui_ready": report.ui_ready,
        "session_id": report.session_id,
        "at": now_rfc3339(),
    })
}

/// Write `value` to `path` through a temporary sibling, so a reader never sees
/// a partial document.
pub(crate) fn write_json_atomically(path: &Path, value: &Value) -> Result<()> {
    if let Some(parent) = path.parent().filter(|parent| !parent.as_os_str().is_empty()) {
        std::fs::create_dir_all(parent)
            .with_context(|| format!("cannot create {}", parent.display()))?;
    }
    let mut temporary = path.as_os_str().to_owned();
    temporary.push(format!(".{}.tmp", std::process::id()));
    let temporary = PathBuf::from(temporary);
    std::fs::write(&temporary, serde_json::to_vec_pretty(value)?)
        .with_context(|| format!("cannot write {}", temporary.display()))?;
    std::fs::rename(&temporary, path)
        .with_context(|| format!("cannot replace {}", path.display()))?;
    Ok(())
}

fn write_progress() {
    let document = with_report(|report| {
        report
            .receipt_path
            .as_deref()
            .and_then(Path::parent)
            .map(|dir| (dir.join(PROGRESS_FILE), progress_document(report)))
    })
    .flatten();
    if let Some((path, document)) = document {
        if let Err(error) = write_json_atomically(&path, &document) {
            eprintln!("[fullmag] could not write run progress: {error:#}");
        }
    }
}

/// Write the receipt once. Later calls (for example the stop watcher racing the
/// normal exit) are ignored.
fn finalize(outcome: &Outcome) {
    if FINALIZED.swap(true, Ordering::SeqCst) {
        return;
    }
    let written = with_report(|report| {
        report.finalized = true;
        let path = report.receipt_path.clone()?;
        Some((path, build_receipt(report, outcome)))
    })
    .flatten();
    if let Some((path, receipt)) = written {
        if let Err(error) = write_json_atomically(&path, &receipt) {
            eprintln!("[fullmag] could not write the run receipt: {error:#}");
        }
    }
}

fn stage_now() -> Stage {
    with_report(|report| report.stage.unwrap_or(Stage::Starting)).unwrap_or(Stage::Starting)
}

fn spawn_stop_watcher(stop_file: PathBuf) {
    let spawned = std::thread::Builder::new()
        .name("fullmag-stop-watch".to_string())
        .spawn(move || loop {
            std::thread::sleep(STOP_WATCH_INTERVAL);
            if !stop_file.exists() {
                continue;
            }
            eprintln!("[fullmag] stop requested by the launching application");
            let outcome = classify_outcome(None, Some(ExitKind::Stopped), stage_now(), None, None);
            finalize(&outcome);
            std::process::exit(ExitKind::Stopped.code());
        });
    if let Err(error) = spawned {
        eprintln!("[fullmag] stop watcher unavailable: {error}");
    }
}

fn script_json(script: &Path, facts: &ScriptFacts) -> Value {
    let identity = fullmag_workspace::identity(script).ok();
    let modified_at = std::fs::metadata(script)
        .and_then(|metadata| metadata.modified())
        .map(fullmag_workspace::rfc3339_millis)
        .ok();
    json!({
        "path": identity.as_ref().map(|i| i.path.clone()).unwrap_or_else(|| display_path(script)),
        "path_key": identity.as_ref().map(|i| i.key.clone()),
        "sha256": facts.sha256,
        "bytes": facts.bytes,
        "modified_at": modified_at,
    })
}

// ── the entry point called from `main` ──────────────────────────────────────

/// Run script mode. Returns the result and, for managed runs only, the exit
/// code to use when the result is an error.
pub(crate) fn run_script_entry(raw_args: Vec<OsString>) -> (Result<()>, Option<i32>) {
    let managed = ScriptCli::try_parse_from(raw_args.iter())
        .ok()
        .filter(ScriptCli::is_managed);
    let Some(cli) = managed else {
        // Usage history is best effort and never changes the run.
        let usage = crate::workspace_usage::begin_script_run(&raw_args);
        let result = crate::orchestrator::run_script_mode(raw_args);
        crate::workspace_usage::finish_script_run(usage, &result);
        return (result, None);
    };
    let (result, exit) = run_managed(&cli, raw_args);
    (result, Some(exit))
}

fn run_managed(cli: &ScriptCli, raw_args: Vec<OsString>) -> (Result<()>, i32) {
    let script_arg = cli.script.clone();
    let argv: Vec<String> = raw_args
        .iter()
        .skip(1)
        .map(|arg| arg.to_string_lossy().into_owned())
        .filter(|arg| Path::new(arg) != script_arg.as_path())
        .collect();
    {
        let mut guard = REPORT.lock().unwrap_or_else(|poison| poison.into_inner());
        *guard = Some(Report {
            receipt_path: cli.receipt.clone(),
            started: Some(Instant::now()),
            started_at: now_rfc3339(),
            script: json!({ "path": display_path(&script_arg) }),
            interpreter: Value::Null,
            process: json!({
                "cwd": std::env::current_dir().ok().map(|dir| display_path(&dir)),
                "argv_redacted": redact_args(&argv),
                "pid": std::process::id(),
            }),
            requested: requested_json(cli),
            next_to_script: cli.output_dir.is_none(),
            ..Report::default()
        });
    }
    FINALIZED.store(false, Ordering::SeqCst);
    WAIT_FOR_SOLVE.store(cli.wait_for_solve, Ordering::Relaxed);
    write_progress();

    let early = prelude(cli);
    let result = match early {
        Err((kind, error)) => {
            mark_failure(kind);
            Err(error)
        }
        Ok(()) => {
            if let Some(receipt) = &cli.receipt {
                if let Some(dir) = receipt.parent() {
                    spawn_stop_watcher(dir.join(STOP_REQUEST_FILE));
                }
            }
            // The host owns the workspace database for runs it launched.
            let desktop = cli.launched_by == Some(LaunchedByArg::Desktop);
            let usage = if desktop {
                None
            } else {
                crate::workspace_usage::begin_script_run(&raw_args)
            };
            let run = std::panic::catch_unwind(std::panic::AssertUnwindSafe(|| {
                crate::orchestrator::run_script_mode(raw_args)
            }));
            let result = run.unwrap_or_else(|_| Err(anyhow!("script-mode worker panicked")));
            if !desktop {
                crate::workspace_usage::finish_script_run(usage, &result);
            }
            result
        }
    };

    let error_text = result.as_ref().err().map(|error| format!("{error:#}"));
    let (tagged, stage, runtime, requested_device) = with_report(|report| {
        (
            report.failure,
            report.stage.unwrap_or(Stage::Starting),
            report.runtime.clone(),
            report.requested["device"].as_str().map(str::to_string),
        )
    })
    .unwrap_or((None, Stage::Starting, None, None));
    let outcome = classify_outcome(
        error_text.as_deref(),
        tagged,
        stage,
        runtime.as_ref(),
        requested_device.as_deref(),
    );
    finalize(&outcome);

    // A forced GPU that did not resolve to a GPU turns a clean exit into a failure.
    let result = match (result, &outcome.error) {
        (Ok(()), Some(message)) => Err(anyhow!("{message}")),
        (other, _) => other,
    };
    (result, outcome.exit_code())
}

/// Checks that precede any execution. The error carries the exit kind.
fn prelude(cli: &ScriptCli) -> std::result::Result<(), (ExitKind, anyhow::Error)> {
    if let Some(python) = &cli.python {
        if !python.is_absolute() {
            return Err((ExitKind::Usage, anyhow!("--python must be an absolute path")));
        }
        std::env::set_var(PYTHON_ENV, python);
    }
    if let Some(expected) = &cli.expect_script_sha256 {
        let valid = expected.len() == 64 && expected.chars().all(|c| c.is_ascii_hexdigit());
        if !valid {
            return Err((
                ExitKind::Usage,
                anyhow!("--expect-script-sha256 must be 64 hexadecimal characters"),
            ));
        }
    }
    let script = cli
        .script
        .canonicalize()
        .with_context(|| format!("failed to resolve script path {}", cli.script.display()))
        .map_err(|error| (ExitKind::Failure, error))?;
    let verdict = verify_script_bytes(&script, cli.expect_script_sha256.as_deref())
        .map_err(|error| (ExitKind::Failure, error))?;
    let facts = match verdict {
        Ok(facts) => facts,
        Err(found) => {
            with_report(|report| report.script = script_json(&script, &found));
            return Err((
                ExitKind::ScriptChanged,
                anyhow!(
                    "the script changed after it was approved (expected sha256 {}, found {}); nothing was executed",
                    cli.expect_script_sha256.as_deref().unwrap_or(""),
                    found.sha256
                ),
            ));
        }
    };
    with_report(|report| report.script = script_json(&script, &facts));

    let root = crate::control_room::repo_root();
    match resolve_interpreter(&root) {
        Ok(interpreter) => {
            if cli.python.is_some() && interpreter.source == InterpreterSource::Bundle {
                eprintln!("[fullmag] --python is ignored: the packaged bundle owns Python");
            }
            with_report(|report| report.interpreter = interpreter.to_json());
            Ok(())
        }
        Err(error) => {
            with_report(|report| report.interpreter = error.to_json());
            Err((ExitKind::Interpreter, anyhow!("{error}")))
        }
    }
}

/// Which UI the orchestrator should open for `cli`.
#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub(crate) enum UiPlan {
    /// No Control Room process at all.
    None,
    /// The system browser (today's default).
    Browser,
    /// The Fullmag window, opened by this process.
    DesktopSelf,
    /// The Fullmag window, opened by the launching host.
    DesktopHost,
}

pub(crate) fn ui_plan(cli: &ScriptCli) -> UiPlan {
    match cli.ui {
        _ if cli.headless => UiPlan::None,
        Some(UiModeArg::None) => UiPlan::None,
        Some(UiModeArg::Desktop) => {
            if cli.launched_by == Some(LaunchedByArg::Desktop) {
                UiPlan::DesktopHost
            } else {
                UiPlan::DesktopSelf
            }
        }
        Some(UiModeArg::Browser) | None => UiPlan::Browser,
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    fn parse(extra: &[&str]) -> ScriptCli {
        let mut args = vec!["fullmag", "x.py"];
        args.extend_from_slice(extra);
        ScriptCli::try_parse_from(args).expect("arguments should parse")
    }

    fn scratch(name: &str) -> PathBuf {
        let dir = std::env::temp_dir().join(format!(
            "fullmag-script-launch-{}-{}",
            std::process::id(),
            name
        ));
        std::fs::create_dir_all(&dir).unwrap();
        dir
    }

    #[test]
    fn new_flags_parse_and_default_to_the_existing_behaviour() {
        let plain = parse(&[]);
        assert!(!plain.is_managed());
        assert_eq!(ui_plan(&plain), UiPlan::Browser);
        assert!(!plain.wait_for_solve);

        let digest = "a".repeat(64);
        let managed = parse(&[
            "--ui",
            "desktop",
            "--api-port",
            "18081",
            "--wait-for-solve",
            "--expect-script-sha256",
            digest.as_str(),
            "--receipt",
            "r.json",
            "--launched-by",
            "desktop",
            "--python",
            "/usr/bin/python3",
        ]);
        assert!(managed.is_managed());
        assert_eq!(managed.api_port, Some(18081));
        assert_eq!(ui_plan(&managed), UiPlan::DesktopHost);
        assert_eq!(ui_plan(&parse(&["--ui", "desktop"])), UiPlan::DesktopSelf);
        assert_eq!(ui_plan(&parse(&["--ui", "none"])), UiPlan::None);
        assert_eq!(ui_plan(&parse(&["--headless"])), UiPlan::None);
        assert!(ScriptCli::try_parse_from(["fullmag", "x.py", "--ui", "window"]).is_err());
    }

    #[test]
    fn script_mode_detection_accepts_every_new_flag_before_the_script() {
        let raw = |parts: &[&str]| parts.iter().map(OsString::from).collect::<Vec<_>>();
        assert!(crate::is_script_mode(&raw(&[
            "fullmag",
            "--ui",
            "none",
            "--wait-for-solve",
            "--api-port",
            "1",
            "--receipt",
            "r.json",
            "--expect-script-sha256",
            "ab",
            "--launched-by",
            "desktop",
            "--python",
            "p",
            "x.py"
        ])));
    }

    #[test]
    fn exit_codes_match_the_contract() {
        let codes: Vec<i32> = [
            ExitKind::Failure,
            ExitKind::Usage,
            ExitKind::Interpreter,
            ExitKind::ScriptChanged,
            ExitKind::Syntax,
            ExitKind::Materialization,
            ExitKind::RuntimeUnavailable,
            ExitKind::Stopped,
        ]
        .iter()
        .map(|kind| kind.code())
        .collect();
        assert_eq!(codes, [1, 2, 10, 11, 12, 13, 14, 130]);
        assert_eq!(ExitKind::ScriptChanged.outcome_status(), "not_started");
        assert_eq!(ExitKind::Stopped.outcome_status(), "cancelled");
        assert_eq!(ExitKind::Materialization.outcome_status(), "failed");
    }

    #[test]
    fn hash_check_reports_the_digest_found_and_ignores_case() {
        let dir = scratch("hash");
        let script = dir.join("a.py");
        std::fs::write(&script, b"x = 1\n").unwrap();
        let digest = sha256_hex(b"x = 1\n");
        let ok = verify_script_bytes(&script, Some(&digest.to_uppercase())).unwrap();
        assert_eq!(ok.unwrap().bytes, 6);
        let none = verify_script_bytes(&script, None).unwrap();
        assert!(none.is_ok());
        std::fs::write(&script, b"x = 2\n").unwrap();
        let changed = verify_script_bytes(&script, Some(&digest)).unwrap();
        assert_eq!(changed.unwrap_err().sha256, sha256_hex(b"x = 2\n"));
    }

    #[test]
    fn outcome_classification_follows_stage_tag_and_requested_device() {
        let cpu = json!({"requested_device": "cpu", "resolved_device": "cpu"});
        let gpu_on_cpu = json!({"requested_device": "gpu", "resolved_device": "cpu"});
        let gpu_ok = json!({"requested_device": "gpu", "resolved_device": "gpu"});

        let ok = classify_outcome(None, None, Stage::Running, Some(&cpu), None);
        assert_eq!((ok.status, ok.exit_code()), ("completed", 0));

        let forced = classify_outcome(None, None, Stage::Running, Some(&gpu_on_cpu), None);
        assert_eq!((forced.status, forced.exit_code()), ("failed", 14));
        assert!(forced.error.unwrap().contains("no fallback"));
        let unresolved = json!({"requested_device": "gpu", "resolved_device": null});
        assert_eq!(
            classify_outcome(None, None, Stage::Running, Some(&unresolved), None).exit_code(),
            14
        );
        assert_eq!(classify_outcome(None, None, Stage::Running, Some(&gpu_ok), None).exit_code(), 0);

        let early = classify_outcome(Some("python helper failed"), None, Stage::Materializing, None, None);
        assert_eq!((early.status, early.exit_code()), ("failed", 13));
        let late = classify_outcome(Some("solver diverged"), None, Stage::Running, None, None);
        assert_eq!(late.exit_code(), 1);
        let gpu_error = classify_outcome(
            Some("GPU requested, but native FEM GPU is unavailable: no device"),
            None,
            Stage::Materializing,
            None,
            None,
        );
        assert_eq!(gpu_error.exit_code(), 14);
        // The launcher forced a GPU (environment) and the CUDA backend is missing.
        let forced_by_launcher = classify_outcome(
            Some("RunError: FDM CUDA execution was requested, but the CUDA backend is not available"),
            None,
            Stage::Materializing,
            None,
            Some("gpu"),
        );
        assert_eq!(forced_by_launcher.exit_code(), 14);
        // A GPU the launcher forced that resolved to CPU is a failed run, never a CPU success.
        let launcher_gpu_on_cpu = classify_outcome(None, None, Stage::Running, Some(&cpu), Some("gpu"));
        assert_eq!(launcher_gpu_on_cpu.exit_code(), 14);
        let syntax = classify_outcome(Some("boom"), Some(ExitKind::Syntax), Stage::Starting, None, None);
        assert_eq!((syntax.status, syntax.exit_code()), ("not_started", 12));
        let stopped = classify_outcome(None, Some(ExitKind::Stopped), Stage::Running, None, None);
        assert_eq!((stopped.status, stopped.exit_code()), ("cancelled", 130));
    }

    #[test]
    fn receipt_records_requested_and_resolved_separately() {
        let report = Report {
            receipt_path: None,
            started: Some(Instant::now()),
            started_at: "2026-10-05T10:00:00.000Z".into(),
            script: json!({"path": "C:/s/x.py", "sha256": "ab"}),
            interpreter: json!({"status": "resolved"}),
            process: json!({"pid": 1}),
            requested: json!({"backend": "auto", "device": "gpu"}),
            runtime: Some(json!({
                "requested_backend": "auto", "requested_device": "gpu",
                "resolved_backend": "fdm", "resolved_device": "cpu",
                "resolved_fallback": null
            })),
            session_id: Some("s".into()),
            run_id: Some("r".into()),
            problem_ir_source_hash: Some("ab".into()),
            results_dir: Some("C:/state/results".into()),
            ..Report::default()
        };
        let outcome = classify_outcome(None, None, Stage::Running, report.runtime.as_ref(), None);
        let receipt = build_receipt(&report, &outcome);
        assert_eq!(receipt["schema"], RECEIPT_SCHEMA);
        assert_eq!(receipt["requested"]["device"], "gpu");
        assert_eq!(receipt["resolved"]["device"], "cpu");
        assert!(receipt["resolved"]["fallback"].is_null());
        assert_eq!(receipt["outcome"]["status"], "failed");
        assert_eq!(receipt["outcome"]["exit_code"], 14);
        assert_eq!(receipt["ids"]["problem_ir_source_hash"], "ab");
        assert_eq!(receipt["results"]["dir"], "C:/state/results");
    }

    #[test]
    fn atomic_write_replaces_without_leaving_temporaries() {
        let dir = scratch("atomic");
        let path = dir.join("receipt.json");
        write_json_atomically(&path, &json!({"a": 1})).unwrap();
        write_json_atomically(&path, &json!({"a": 2})).unwrap();
        let value: Value = serde_json::from_slice(&std::fs::read(&path).unwrap()).unwrap();
        assert_eq!(value["a"], 2);
        let leftovers = std::fs::read_dir(&dir)
            .unwrap()
            .filter_map(|entry| entry.ok())
            .filter(|entry| entry.file_name().to_string_lossy().ends_with(".tmp"))
            .count();
        assert_eq!(leftovers, 0);
    }

    #[test]
    fn requested_json_keeps_unset_values_as_authored_and_flags_literal() {
        let requested = requested_json(&parse(&["--backend", "auto", "--mode", "strict"]));
        assert_eq!(requested["backend"], "auto");
        assert_eq!(requested["mode"], "strict");
        assert_eq!(requested["precision"], "as_authored");
        assert!(requested["device"].is_string());
    }

    #[test]
    fn verbatim_prefixes_are_dropped_from_displayed_paths() {
        assert_eq!(display_path(Path::new(r"\\?\C:\a\b.py")), r"C:\a\b.py");
        assert_eq!(display_path(Path::new(r"\\?\UNC\srv\share\b.py")), r"\\srv\share\b.py");
    }
}
