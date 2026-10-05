//! "Run in new window" for a Python script (architecture A of
//! docs/design/start-screen/docs/08-script-open.md).
//!
//! The host owns consent and path authority. The renderer only ever holds an
//! opaque ticket (or a workspace item id); the path that is hashed, shown in
//! the native prompt and executed is the one this module read itself. The
//! script runs as a child process tree of the `fullmag` CLI with its own API
//! and its own Fullmag window; the CLI writes a receipt, and this module is the
//! single writer of the matching workspace-database events.

use std::collections::HashMap;
use std::path::{Path, PathBuf};
use std::process::{Command, Stdio};
use std::sync::atomic::{AtomicBool, Ordering};
use std::sync::{Arc, Mutex, PoisonError};
use std::time::{Duration, Instant};

use fullmag_runtime_control::python_runtime::resolve_interpreter_with;
use fullmag_workspace::{now_rfc3339, ItemKind};
use serde::Serialize;
use serde_json::{json, Value};
use tauri::{AppHandle, Emitter, Manager, State, WebviewUrl, WebviewWindowBuilder, WindowEvent};
use tauri_plugin_dialog::{DialogExt, MessageDialogButtons, MessageDialogKind};

use crate::api_sidecar;
use crate::script_run_core::*;
use crate::script_run_process::{self, ProcessTree};
use crate::workspace_commands::{self, WorkspaceHost};

const PYTHON_SETTING_KEY: &str = "python.interpreter";
const SUPERVISE_INTERVAL: Duration = Duration::from_millis(200);
const INSPECT_TIMEOUT: Duration = Duration::from_secs(60);
const PORT_RETRY_WINDOW: Duration = Duration::from_secs(60);

// ── wire types ──────────────────────────────────────────────────────────

#[derive(Debug, Clone, Serialize)]
pub struct ScriptPreflight {
    pub ticket: String,
    /// The file differs from the bytes the ticket was issued for.
    pub hash_changed: bool,
    /// `fullmag.script_inspect.v1`; `None` when it could not be produced.
    pub inspect: Option<Value>,
    /// Why running would be refused, when it would.
    pub refusal: Option<RefusalWire>,
    pub cli_found: bool,
    pub active_runs: usize,
    pub max_runs: usize,
    pub warning: Option<String>,
}

#[derive(Debug, Clone, Serialize)]
pub struct RefusalWire {
    pub code: &'static str,
    pub detail: String,
}

#[derive(Debug, Clone, Serialize)]
#[serde(tag = "status", rename_all = "snake_case")]
pub enum ScriptRunResult {
    Started {
        run_handle: String,
        pid: u32,
        interpreter: Value,
        warning: Option<String>,
    },
    Declined,
    Refused {
        code: &'static str,
        detail: String,
    },
}

fn refused(kind: Refusal, detail: impl Into<String>) -> ScriptRunResult {
    ScriptRunResult::Refused {
        code: kind.code(),
        detail: detail.into(),
    }
}

#[derive(Debug, Clone, Serialize)]
pub struct ScriptRunStatus {
    pub run_handle: String,
    /// `starting`, `materializing`, `waiting_for_solve`, `running` or `exited`.
    pub state: &'static str,
    pub exit_code: Option<i32>,
    pub receipt: Option<Value>,
    pub window_open: bool,
    pub error: Option<String>,
}

// ── host state ──────────────────────────────────────────────────────────

#[derive(Debug, Clone)]
struct RunState {
    state: &'static str,
    exit_code: Option<i32>,
    receipt: Option<Value>,
    window_open: bool,
    error: Option<String>,
    stop_requested_at: Option<Instant>,
}

struct RunShared {
    run_id: String,
    script: ScriptSnapshot,
    requested: RequestedRuntime,
    consent_mode: ConsentMode,
    consent_at: String,
    run_dir: PathBuf,
    state: Mutex<RunState>,
    close_prompt_open: AtomicBool,
}

impl RunShared {
    fn status(&self) -> ScriptRunStatus {
        let state = self.state.lock().unwrap_or_else(PoisonError::into_inner);
        ScriptRunStatus {
            run_handle: self.run_id.clone(),
            state: state.state,
            exit_code: state.exit_code,
            receipt: state.receipt.clone(),
            window_open: state.window_open,
            error: state.error.clone(),
        }
    }

    fn is_active(&self) -> bool {
        self.state
            .lock()
            .unwrap_or_else(PoisonError::into_inner)
            .state
            != "exited"
    }

    /// Ask the run to stop: a request file for the CLI now, a tree kill after
    /// the grace period (done by the supervisor).
    fn request_stop(&self) {
        let _ = std::fs::write(self.run_dir.join(STOP_REQUEST_FILE), b"stop");
        let mut state = self.state.lock().unwrap_or_else(PoisonError::into_inner);
        state.stop_requested_at.get_or_insert_with(Instant::now);
    }
}

#[derive(Default)]
struct HostInner {
    tickets: TicketTable,
    runs: HashMap<String, Arc<RunShared>>,
}

/// Managed state: tickets and the runs this application started.
#[derive(Clone, Default)]
pub struct ScriptRunHost {
    inner: Arc<Mutex<HostInner>>,
}

impl ScriptRunHost {
    fn lock(&self) -> std::sync::MutexGuard<'_, HostInner> {
        self.inner.lock().unwrap_or_else(PoisonError::into_inner)
    }

    fn active_runs(&self) -> usize {
        self.lock()
            .runs
            .values()
            .filter(|run| run.is_active())
            .count()
    }

    fn ticket(&self, token: &str) -> Option<Ticket> {
        self.lock().tickets.get(token).cloned()
    }

    fn run(&self, run_handle: &str) -> Option<Arc<RunShared>> {
        self.lock().runs.get(run_handle).cloned()
    }
}

// ── helpers ─────────────────────────────────────────────────────────────

async fn blocking<T: Send + 'static>(
    body: impl FnOnce() -> Result<T, String> + Send + 'static,
) -> Result<T, String> {
    tauri::async_runtime::spawn_blocking(body)
        .await
        .map_err(|error| format!("the operation was interrupted: {error}"))?
}

fn emit_status(app: &AppHandle, shared: &RunShared) {
    let _ = app.emit(&format!("script-run:{}", shared.run_id), shared.status());
}

/// Write `value` through a temporary sibling so a reader never sees half a file.
fn write_atomically(path: &Path, value: &Value) -> Result<(), String> {
    let mut temporary = path.as_os_str().to_owned();
    temporary.push(".tmp");
    let temporary = PathBuf::from(temporary);
    let bytes = serde_json::to_vec_pretty(value).map_err(|error| error.to_string())?;
    std::fs::write(&temporary, bytes).map_err(|error| error.to_string())?;
    std::fs::rename(&temporary, path).map_err(|error| error.to_string())
}

fn read_json(path: &Path) -> Option<Value> {
    serde_json::from_slice(&std::fs::read(path).ok()?).ok()
}

/// A port that is free on every interface (the CLI checks the wildcard address).
fn pick_free_port() -> Result<u16, String> {
    std::net::TcpListener::bind((std::net::Ipv4Addr::UNSPECIFIED, 0))
        .and_then(|listener| listener.local_addr())
        .map(|address| address.port())
        .map_err(|error| format!("no free API port available: {error}"))
}

fn apply_env(command: &mut Command, set: &[(String, std::ffi::OsString)], remove: &[String]) {
    for name in remove {
        command.env_remove(name);
    }
    for (name, value) in set {
        command.env(name, value);
    }
}

fn inherited_names() -> Vec<String> {
    std::env::vars_os()
        .filter_map(|(name, _)| name.into_string().ok())
        .collect()
}

/// Run `command` to completion with a deadline; the process is killed at the
/// deadline.
fn output_with_timeout(
    mut command: Command,
    timeout: Duration,
) -> Result<std::process::Output, String> {
    command
        .stdin(Stdio::null())
        .stdout(Stdio::piped())
        .stderr(Stdio::piped());
    script_run_process::configure(&mut command);
    let mut child = command
        .spawn()
        .map_err(|error| format!("cannot start the fullmag command line: {error}"))?;
    let mut stdout = child.stdout.take();
    let mut stderr = child.stderr.take();
    let out_reader = std::thread::spawn(move || {
        let mut bytes = Vec::new();
        if let Some(stream) = stdout.as_mut() {
            let _ = std::io::Read::read_to_end(stream, &mut bytes);
        }
        bytes
    });
    let err_reader = std::thread::spawn(move || {
        let mut bytes = Vec::new();
        if let Some(stream) = stderr.as_mut() {
            let _ = std::io::Read::read_to_end(stream, &mut bytes);
        }
        bytes
    });
    let deadline = Instant::now() + timeout;
    let status = loop {
        match child.try_wait() {
            Ok(Some(status)) => break status,
            Ok(None) if Instant::now() >= deadline => {
                let _ = child.kill();
                let _ = child.wait();
                return Err("the preflight inspection timed out".to_string());
            }
            Ok(None) => std::thread::sleep(Duration::from_millis(50)),
            Err(error) => return Err(format!("cannot observe the inspection: {error}")),
        }
    };
    Ok(std::process::Output {
        status,
        stdout: out_reader.join().unwrap_or_default(),
        stderr: err_reader.join().unwrap_or_default(),
    })
}

/// `fullmag script inspect <path> --json`: parses the file, never executes it.
fn run_inspect(
    cli: &Path,
    repo_root: &Path,
    state_root: &Path,
    script: &Path,
    explicit_python: Option<&Path>,
) -> Result<Value, String> {
    let mut command = Command::new(cli);
    command.args(["script", "inspect"]).arg(script).arg("--json");
    if let Some(python) = explicit_python {
        command.arg("--python").arg(python);
    }
    let (set, remove) = child_env_changes(
        inherited_names(),
        repo_root,
        state_root,
        &RequestedRuntime::default(),
    );
    apply_env(&mut command, &set, &remove);
    let output = output_with_timeout(command, INSPECT_TIMEOUT)?;
    if !output.status.success() {
        let stderr = String::from_utf8_lossy(&output.stderr);
        let last = stderr.lines().rev().find(|line| !line.trim().is_empty());
        return Err(format!(
            "the preflight inspection failed: {}",
            last.unwrap_or("no output")
        ));
    }
    serde_json::from_slice(&output.stdout)
        .map_err(|error| format!("the preflight inspection returned invalid JSON: {error}"))
}

fn stored_python(workspace: &WorkspaceHost, legacy: Option<PathBuf>) -> Option<PathBuf> {
    workspace
        .with(legacy.as_deref(), |w, _| {
            Ok(w.get_kv(PYTHON_SETTING_KEY).ok().flatten())
        })
        .ok()
        .flatten()
        .and_then(|value| value.as_str().map(PathBuf::from))
        .filter(|path| path.is_absolute())
}

fn trust_of(workspace: &WorkspaceHost, legacy: Option<PathBuf>, path: &Path) -> Option<Value> {
    let path = path.to_path_buf();
    workspace
        .with(legacy.as_deref(), move |w, _| {
            Ok(w.find(&path)
                .ok()
                .flatten()
                .and_then(|item| item.meta.get("trust").cloned()))
        })
        .ok()
        .flatten()
}

fn item_path(workspace: &WorkspaceHost, legacy: Option<PathBuf>, id: i64) -> Result<PathBuf, String> {
    workspace.with(legacy.as_deref(), move |w, _| {
        let item = w
            .find(id)
            .map_err(|error| error.to_string())?
            .ok_or_else(|| format!("workspace item not found: item {id}"))?;
        if item.kind != ItemKind::Script {
            return Err(format!("item {id} is not a script"));
        }
        Ok(PathBuf::from(&item.path))
    })
}

// ── tickets ─────────────────────────────────────────────────────────────

/// Read the file, record the open (best effort) and issue a ticket for it.
async fn issue_ticket(
    app: &AppHandle,
    host: &ScriptRunHost,
    workspace: &WorkspaceHost,
    path: PathBuf,
) -> Result<ScriptHandle, String> {
    let snapshot = blocking({
        let path = path.clone();
        move || snapshot_script(&path)
    })
    .await?;
    let recorded = workspace_commands::run(
        workspace.clone(),
        workspace_commands::legacy_index_path(app),
        {
            let path = snapshot.path.clone();
            move |w, _| workspace_commands::record_script_open(w, &path)
        },
    )
    .await;
    // A locked or newer database never blocks the run: the item id is optional.
    let item_id = recorded.ok().map(|item| item.id);
    Ok(host.lock().tickets.issue(new_token(), snapshot, item_id))
}

/// Pick a `.py` file in the native dialog and issue a ticket for it.
#[tauri::command]
pub async fn script_pick(
    app: AppHandle,
    host: State<'_, ScriptRunHost>,
    workspace: State<'_, WorkspaceHost>,
) -> Result<Option<ScriptHandle>, String> {
    let picked = app
        .dialog()
        .file()
        .add_filter("Python script", &["py"])
        .blocking_pick_file();
    let Some(picked) = picked else {
        return Ok(None);
    };
    let path = picked
        .into_path()
        .map_err(|_| "selected script path is not available on this platform".to_string())?;
    issue_ticket(&app, host.inner(), workspace.inner(), path)
        .await
        .map(Some)
}

/// Issue a ticket for a script of the list: the stored path is re-read by the
/// host, the renderer sends only the item id.
#[tauri::command]
pub async fn script_open_recent(
    app: AppHandle,
    host: State<'_, ScriptRunHost>,
    workspace: State<'_, WorkspaceHost>,
    item_id: i64,
) -> Result<ScriptHandle, String> {
    let ws = workspace.inner().clone();
    let legacy = workspace_commands::legacy_index_path(&app);
    let path = blocking(move || item_path(&ws, legacy, item_id)).await?;
    issue_ticket(&app, host.inner(), workspace.inner(), path).await
}

// ── preflight ───────────────────────────────────────────────────────────

/// Static facts about the ticket's file, without executing it.
#[tauri::command]
pub async fn script_preflight(
    app: AppHandle,
    host: State<'_, ScriptRunHost>,
    workspace: State<'_, WorkspaceHost>,
    ticket: String,
) -> Result<ScriptPreflight, String> {
    let host = host.inner().clone();
    let Some(entry) = host.ticket(&ticket) else {
        return Err("unknown or expired ticket; pick the script again".to_string());
    };
    let active_runs = host.active_runs();
    let mut result = ScriptPreflight {
        ticket: ticket.clone(),
        hash_changed: false,
        inspect: None,
        refusal: None,
        cli_found: true,
        active_runs,
        max_runs: MAX_CONCURRENT_RUNS,
        warning: concurrency_warning(active_runs),
    };
    let approved = entry.snapshot.clone();
    if recheck_file(&approved).is_err() {
        result.hash_changed = true;
        result.refusal = Some(RefusalWire {
            code: Refusal::Changed.code(),
            detail: "the file changed after it was opened; open it again".to_string(),
        });
        return Ok(result);
    }
    let ws = workspace.inner().clone();
    let legacy = workspace_commands::legacy_index_path(&app);
    let ticket_for_store = ticket.clone();
    let host_for_store = host.clone();
    let outcome = blocking(move || {
        let Some(cli) = api_sidecar::find_cli_binary() else {
            return Ok(None);
        };
        let (repo_root, state_root) = api_sidecar::runtime_roots(&cli)?;
        let explicit = stored_python(&ws, legacy);
        let inspect = match &entry.preflight {
            Some(cached) => cached.clone(),
            None => run_inspect(&cli, &repo_root, &state_root, &approved.path, explicit.as_deref())?,
        };
        host_for_store
            .lock()
            .tickets
            .set_preflight(&ticket_for_store, inspect.clone());
        Ok(Some(inspect))
    })
    .await;
    match outcome {
        Ok(Some(inspect)) => {
            result.refusal = preflight_refusal(&inspect).map(|(kind, detail)| RefusalWire {
                code: kind.code(),
                detail,
            });
            result.inspect = Some(inspect);
        }
        Ok(None) => {
            result.cli_found = false;
            result.refusal = Some(RefusalWire {
                code: Refusal::CliMissing.code(),
                detail: "the fullmag command line was not found next to the application"
                    .to_string(),
            });
        }
        Err(error) => {
            result.refusal = Some(RefusalWire {
                code: Refusal::Interpreter.code(),
                detail: error,
            });
        }
    }
    Ok(result)
}

// ── run ─────────────────────────────────────────────────────────────────

#[derive(Clone)]
struct Launch {
    cli: PathBuf,
    cwd: PathBuf,
    env_set: Vec<(String, std::ffi::OsString)>,
    env_remove: Vec<String>,
    plan: LaunchPlan,
    log: PathBuf,
}

impl Launch {
    fn spawn(&self) -> Result<(std::process::Child, ProcessTree), String> {
        let log = std::fs::OpenOptions::new()
            .create(true)
            .append(true)
            .open(&self.log)
            .map_err(|error| format!("cannot open the run log: {error}"))?;
        let log_err = log
            .try_clone()
            .map_err(|error| format!("cannot open the run log: {error}"))?;
        let mut command = Command::new(&self.cli);
        command
            .args(build_cli_args(&self.plan))
            .current_dir(&self.cwd)
            .stdin(Stdio::null())
            .stdout(log)
            .stderr(log_err);
        apply_env(&mut command, &self.env_set, &self.env_remove);
        script_run_process::configure(&mut command);
        let child = command
            .spawn()
            .map_err(|error| format!("cannot start {}: {error}", self.cli.display()))?;
        let tree = ProcessTree::adopt(&child)
            .map_err(|error| format!("cannot track the process tree: {error}"))?;
        Ok((child, tree))
    }
}

/// Ask for consent in native dialogs. `true` runs; the second element says the
/// person chose to remember the decision for this exact content.
fn ask_consent(app: &AppHandle, facts: &ConsentFacts, offer_remember: bool) -> (bool, bool) {
    let accepted = app
        .dialog()
        .message(consent_message(facts))
        .title(CONSENT_TITLE)
        .kind(MessageDialogKind::Warning)
        .buttons(MessageDialogButtons::OkCancelCustom(
            "Run".to_string(),
            "Cancel".to_string(),
        ))
        .blocking_show();
    if !accepted {
        return (false, false);
    }
    let remember = offer_remember
        && app
            .dialog()
            .message(remember_message(facts))
            .title(REMEMBER_TITLE)
            .kind(MessageDialogKind::Info)
            .buttons(MessageDialogButtons::OkCancelCustom(
                "Remember".to_string(),
                "Not now".to_string(),
            ))
            .blocking_show();
    (true, remember)
}

/// Start a script in its own process tree and window, after the host-native
/// consent prompt. The request names a ticket, never a path.
#[tauri::command]
pub async fn script_run(
    app: AppHandle,
    host: State<'_, ScriptRunHost>,
    workspace: State<'_, WorkspaceHost>,
    request: ScriptRunRequest,
) -> Result<ScriptRunResult, String> {
    let host = host.inner().clone();
    let workspace = workspace.inner().clone();
    let legacy = workspace_commands::legacy_index_path(&app);

    let Some(entry) = host.ticket(&request.ticket) else {
        return Ok(refused(
            Refusal::Ticket,
            "unknown or expired ticket; open the script again",
        ));
    };
    let approved = entry.snapshot.clone();
    if approved.encoding == "other" {
        return Ok(refused(
            Refusal::Encoding,
            "the script is not UTF-8 text; save it as UTF-8 first",
        ));
    }
    if request.results == ResultsChoice::NextToScript && request.confirm_overwrite != Some(true) {
        return Ok(refused(
            Refusal::ConfirmRequired,
            "writing results next to the script needs an explicit confirmation",
        ));
    }
    let active_runs = host.active_runs();
    if active_runs >= MAX_CONCURRENT_RUNS {
        return Ok(refused(
            Refusal::Busy,
            format!("{MAX_CONCURRENT_RUNS} script runs are already active; stop one first"),
        ));
    }
    let Some(cli) = api_sidecar::find_cli_binary() else {
        return Ok(refused(
            Refusal::CliMissing,
            "the fullmag command line was not found next to the application",
        ));
    };
    let (repo_root, state_root) = match api_sidecar::runtime_roots(&cli) {
        Ok(roots) => roots,
        Err(error) => return Ok(refused(Refusal::Storage, error)),
    };
    if recheck_file(&approved).is_err() {
        return Ok(refused(
            Refusal::Changed,
            "the file changed after it was opened; open it again",
        ));
    }

    // Static facts for exactly these bytes (cached per ticket).
    let explicit_python = stored_python(&workspace, legacy.clone());
    let inspect = {
        let (cli, repo_root, state_root, approved, explicit, host, token, cached) = (
            cli.clone(),
            repo_root.clone(),
            state_root.clone(),
            approved.clone(),
            explicit_python.clone(),
            host.clone(),
            request.ticket.clone(),
            entry.preflight.clone(),
        );
        blocking(move || {
            let inspect = match cached {
                Some(inspect) => inspect,
                None => run_inspect(&cli, &repo_root, &state_root, &approved.path, explicit.as_deref())?,
            };
            host.lock().tickets.set_preflight(&token, inspect.clone());
            Ok(inspect)
        })
        .await
    };
    let inspect = match inspect {
        Ok(inspect) => inspect,
        Err(error) => return Ok(refused(Refusal::Interpreter, error)),
    };
    if let Some((kind, detail)) = preflight_refusal(&inspect) {
        return Ok(refused(kind, detail));
    }
    let interpreter = inspect.get("interpreter").cloned().unwrap_or(Value::Null);
    let text = |key: &str| {
        interpreter
            .get(key)
            .and_then(Value::as_str)
            .unwrap_or("unknown")
            .to_string()
    };

    // Run identity and result locations are chosen here, never by the renderer.
    let token = new_token();
    let started_ms = std::time::SystemTime::now()
        .duration_since(std::time::UNIX_EPOCH)
        .map(|duration| duration.as_millis())
        .unwrap_or(0);
    let run_id = new_run_id(started_ms, &token);
    let dir = run_dir(&state_root, &run_id);
    let script_dir = approved
        .path
        .parent()
        .map(Path::to_path_buf)
        .unwrap_or_else(|| PathBuf::from("."));
    let results_dir = match request.results {
        ResultsChoice::Managed => dir.join("results"),
        ResultsChoice::NextToScript => approved.path.with_extension("zarr"),
    };

    let trust = trust_of(&workspace, legacy.clone(), &approved.path);
    let mode = consent_mode(trust.as_ref(), &approved.sha256, request.results);
    let facts = ConsentFacts {
        file_name: approved.name.clone(),
        folder: script_dir.display().to_string(),
        sha256: approved.sha256.clone(),
        interpreter: text("path"),
        interpreter_version: text("version"),
        working_dir: script_dir.display().to_string(),
        results: request.results,
        results_dir: results_dir.display().to_string(),
        active_runs,
    };
    let consent_at = now_rfc3339();
    if mode == ConsentMode::Prompt {
        let prompt_app = app.clone();
        let prompt_facts = facts.clone();
        let offer_remember = request.results == ResultsChoice::Managed;
        let (accepted, remember) =
            blocking(move || Ok(ask_consent(&prompt_app, &prompt_facts, offer_remember))).await?;
        if !accepted {
            return Ok(ScriptRunResult::Declined);
        }
        if remember {
            let (sha, at, path) = (approved.sha256.clone(), consent_at.clone(), approved.path.clone());
            let _ = workspace_commands::run(workspace.clone(), legacy.clone(), move |w, _| {
                w.patch_meta(&path, &trust_patch(&sha, &at))
                    .map_err(|error| error.to_string())
            })
            .await;
        }
    }

    // The file may have changed while the prompt was open.
    if recheck_file(&approved).is_err() {
        return Ok(refused(
            Refusal::Changed,
            "the file changed while the prompt was open; open it again",
        ));
    }

    let launch_dir = dir.clone();
    let prepared = blocking(move || {
        std::fs::create_dir_all(&launch_dir)
            .map_err(|error| format!("cannot create the run directory: {error}"))?;
        pick_free_port()
    })
    .await;
    let port = match prepared {
        Ok(port) => port,
        Err(error) => return Ok(refused(Refusal::Storage, error)),
    };
    let (env_set, env_remove) = child_env_changes(
        inherited_names(),
        &repo_root,
        &state_root,
        &request.requested,
    );
    let launch = Launch {
        cli,
        cwd: script_dir,
        env_set,
        env_remove,
        plan: LaunchPlan {
            script: approved.path.clone(),
            sha256: approved.sha256.clone(),
            api_port: port,
            receipt: dir.join(RECEIPT_FILE),
            results: request.results,
            results_dir,
            requested: request.requested,
            wait_for_solve: request.wait_for_solve,
            explicit_python,
        },
        log: dir.join("cli.log"),
    };

    let shared = Arc::new(RunShared {
        run_id: run_id.clone(),
        script: approved.clone(),
        requested: request.requested,
        consent_mode: mode,
        consent_at,
        run_dir: dir.clone(),
        state: Mutex::new(RunState {
            state: "starting",
            exit_code: None,
            receipt: None,
            window_open: false,
            error: None,
            stop_requested_at: None,
        }),
        close_prompt_open: AtomicBool::new(false),
    });
    let _ = write_atomically(
        &dir.join(OWNER_FILE),
        &json!({
            "run_id": run_id,
            "host_pid": std::process::id(),
            "started_at": now_rfc3339(),
            "script_path": approved.path.display().to_string(),
            "script_path_key": approved.path_key,
            "sha256": approved.sha256,
        }),
    );

    let spawned = blocking({
        let launch_for_spawn = launch.clone();
        move || launch_for_spawn.spawn()
    })
    .await;
    let (child, tree) = match spawned {
        Ok(pair) => pair,
        Err(error) => return Ok(refused(Refusal::CliMissing, error)),
    };
    let pid = child.id();
    host.lock().runs.insert(run_id.clone(), shared.clone());
    emit_status(&app, &shared);

    // The chip on the start screen shows the run as started until the receipt.
    {
        let (path, at, device) = (
            approved.path.clone(),
            now_rfc3339(),
            request.requested.device.map_or("as_authored", DeviceChoice::as_str),
        );
        let _ = workspace_commands::run(workspace.clone(), legacy.clone(), move |w, _| {
            w.patch_meta(
                &path,
                &json!({ "last_run": { "status": "started", "at": at, "device": device } }),
            )
            .map_err(|error| error.to_string())
        })
        .await;
    }

    let supervisor = Supervisor {
        app: app.clone(),
        shared,
        workspace,
        legacy,
        launch,
    };
    std::thread::Builder::new()
        .name(format!("fullmag-script-run-{run_id}"))
        .spawn(move || supervisor.run(child, tree))
        .map_err(|error| format!("cannot supervise the run: {error}"))?;

    Ok(ScriptRunResult::Started {
        run_handle: run_id,
        pid,
        interpreter,
        warning: concurrency_warning(active_runs),
    })
}

// ── supervision ─────────────────────────────────────────────────────────

struct Supervisor {
    app: AppHandle,
    shared: Arc<RunShared>,
    workspace: WorkspaceHost,
    legacy: Option<PathBuf>,
    launch: Launch,
}

impl Supervisor {
    fn run(mut self, mut child: std::process::Child, mut tree: ProcessTree) {
        let started = Instant::now();
        let progress_path = self.shared.run_dir.join(PROGRESS_FILE);
        let receipt_path = self.shared.run_dir.join(RECEIPT_FILE);
        let mut window_open = false;
        let mut retried = false;
        let mut killed = false;
        let mut last = ("", false);

        let exit_code = loop {
            std::thread::sleep(SUPERVISE_INTERVAL);
            let progress = read_json(&progress_path);
            let state = state_from_progress(progress.as_ref());
            if !window_open {
                if let Some(port) = ui_endpoint(progress.as_ref()) {
                    // The API identity pins the window to this run's API instance.
                    if let Ok(instance) = fullmag_runtime_control::runtime_service_client::verify_api_identity(port) {
                        match self.open_window(&ui_url(port, &instance)) {
                            Ok(()) => window_open = true,
                            Err(error) => {
                                self.set_error(format!("cannot open the script window: {error}"));
                            }
                        }
                    }
                }
            }
            {
                let mut shared = self.shared.state.lock().unwrap_or_else(PoisonError::into_inner);
                shared.state = state;
                shared.window_open = window_open;
            }
            if (state, window_open) != last {
                last = (state, window_open);
                emit_status(&self.app, &self.shared);
            }
            let escalate = self
                .shared
                .state
                .lock()
                .unwrap_or_else(PoisonError::into_inner)
                .stop_requested_at
                .is_some_and(|at| at.elapsed() >= STOP_GRACE);
            if escalate && !killed {
                killed = true;
                tree.kill();
            }
            match child.try_wait() {
                Ok(Some(status)) => {
                    let code = status.code();
                    let early = !window_open && started.elapsed() < PORT_RETRY_WINDOW;
                    let conflict = read_json(&receipt_path)
                        .and_then(|r| r["outcome"]["error"].as_str().map(is_port_conflict))
                        .unwrap_or(false);
                    if early && conflict && !retried && !killed {
                        // The chosen port was taken in the meantime: one more try.
                        retried = true;
                        let _ = std::fs::remove_file(&receipt_path);
                        let _ = std::fs::remove_file(&progress_path);
                        match pick_free_port().and_then(|port| {
                            self.launch.plan.api_port = port;
                            self.launch.spawn()
                        }) {
                            Ok((next_child, next_tree)) => {
                                child = next_child;
                                tree = next_tree;
                                continue;
                            }
                            Err(error) => {
                                self.set_error(error);
                            }
                        }
                    }
                    break if killed { Some(130) } else { code };
                }
                Ok(None) => {}
                Err(_) => break None,
            }
        };
        // Whatever the CLI left behind ends with the job.
        drop(tree);
        self.finish(exit_code, killed);
    }

    fn set_error(&self, message: String) {
        self.shared
            .state
            .lock()
            .unwrap_or_else(PoisonError::into_inner)
            .error = Some(message);
    }

    fn open_window(&self, url: &str) -> Result<(), String> {
        let parsed: url::Url = url.parse().map_err(|error| format!("invalid URL: {error}"))?;
        let label = window_label(&self.shared.run_id);
        let window = WebviewWindowBuilder::new(&self.app, &label, WebviewUrl::External(parsed))
            .title(format!("Fullmag - {}", self.shared.script.name))
            .inner_size(1400.0, 900.0)
            .min_inner_size(800.0, 600.0)
            .center()
            .build()
            .map_err(|error| error.to_string())?;
        let shared = self.shared.clone();
        let app = self.app.clone();
        window.on_window_event(move |event| {
            if let WindowEvent::CloseRequested { api, .. } = event {
                if !shared.is_active() {
                    return;
                }
                // Closing the window stops the run: ask first.
                api.prevent_close();
                if shared.close_prompt_open.swap(true, Ordering::SeqCst) {
                    return;
                }
                let shared = shared.clone();
                app.dialog()
                    .message("Closing this window stops the script run. Stop it now?")
                    .title("Stop script run?")
                    .kind(MessageDialogKind::Warning)
                    .buttons(MessageDialogButtons::OkCancelCustom(
                        "Stop run".to_string(),
                        "Keep running".to_string(),
                    ))
                    .show(move |stop| {
                        shared.close_prompt_open.store(false, Ordering::SeqCst);
                        if stop {
                            shared.request_stop();
                        }
                    });
            }
        });
        Ok(())
    }

    /// The receipt, the database events and the final status.
    fn finish(&self, exit_code: Option<i32>, killed: bool) {
        let now = now_rfc3339();
        let receipt_path = self.shared.run_dir.join(RECEIPT_FILE);
        let window_opened = self
            .shared
            .state
            .lock()
            .unwrap_or_else(PoisonError::into_inner)
            .window_open;
        let mut receipt = std::fs::read(&receipt_path)
            .ok()
            .and_then(|bytes| parse_receipt(&bytes).ok())
            .unwrap_or_else(|| {
                let reason = match (killed, exit_code) {
                    (true, _) => "the run was stopped and its process tree was ended".to_string(),
                    (false, Some(code)) => format!(
                        "the process ended ({}, exit code {code}) without writing a receipt",
                        exit_code_name(code)
                    ),
                    (false, None) => "the process ended without writing a receipt".to_string(),
                };
                synthesize_receipt(
                    &self.shared.script.path.display().to_string(),
                    &self.shared.script.sha256,
                    exit_code,
                    &reason,
                    &self.shared.requested,
                    &now,
                )
            });
        finalize_receipt(
            &mut receipt,
            self.shared.consent_mode,
            &self.shared.consent_at,
            &self.shared.script.sha256,
            &self.shared.requested,
            window_opened,
        );
        let _ = write_atomically(&receipt_path, &receipt);

        let event = run_event(&self.shared.script.path, &receipt, &now);
        let recorded = self
            .workspace
            .with(self.legacy.as_deref(), |w, _| {
                w.record(&event).map(|_| ()).map_err(|error| error.to_string())
            })
            .is_ok();
        if recorded {
            let _ = write_atomically(
                &self.shared.run_dir.join(RECORDED_FILE),
                &json!({ "recorded_at": now_rfc3339() }),
            );
        }

        {
            let mut state = self.shared.state.lock().unwrap_or_else(PoisonError::into_inner);
            state.state = "exited";
            state.exit_code = exit_code;
            state.receipt = Some(receipt);
            state.window_open = false;
        }
        emit_status(&self.app, &self.shared);
        if let Some(window) = self
            .app
            .get_webview_window(&window_label(&self.shared.run_id))
        {
            // The run is over: nothing is left to ask about.
            let _ = window.destroy();
        }
    }
}

// ── status, stop, trust ─────────────────────────────────────────────────

#[tauri::command]
pub async fn script_run_status(
    host: State<'_, ScriptRunHost>,
    run_handle: String,
) -> Result<ScriptRunStatus, String> {
    host.inner()
        .run(&run_handle)
        .map(|run| run.status())
        .ok_or_else(|| format!("unknown script run: {run_handle}"))
}

/// Ask a run to stop: gracefully first, the process tree is ended after 10 s.
#[tauri::command]
pub async fn script_run_stop(
    host: State<'_, ScriptRunHost>,
    run_handle: String,
) -> Result<(), String> {
    let run = host
        .inner()
        .run(&run_handle)
        .ok_or_else(|| format!("unknown script run: {run_handle}"))?;
    if run.is_active() {
        run.request_stop();
    }
    Ok(())
}

/// Forget a remembered "do not ask again" decision.
#[tauri::command]
pub async fn script_trust_forget(
    app: AppHandle,
    workspace: State<'_, WorkspaceHost>,
    item_id: i64,
) -> Result<(), String> {
    workspace_commands::run(
        workspace.inner().clone(),
        workspace_commands::legacy_index_path(&app),
        move |w, _| {
            w.patch_meta(item_id, &json!({ "trust": Value::Null }))
                .map_err(|error| error.to_string())
        },
    )
    .await
}

// ── interpreter ─────────────────────────────────────────────────────────

fn interpreter_document(explicit: Option<&Path>) -> Value {
    let root = api_sidecar::find_cli_binary()
        .and_then(|cli| api_sidecar::runtime_roots(&cli).ok())
        .map(|(repo_root, _)| repo_root)
        .or_else(|| std::env::current_dir().ok())
        .unwrap_or_default();
    match resolve_interpreter_with(&root, explicit) {
        Ok(resolved) => resolved.to_json(),
        Err(error) => error.to_json(),
    }
}

/// The interpreter a run would use now (the stored setting included).
#[tauri::command]
pub async fn python_interpreter_status(
    app: AppHandle,
    workspace: State<'_, WorkspaceHost>,
) -> Result<Value, String> {
    let ws = workspace.inner().clone();
    let legacy = workspace_commands::legacy_index_path(&app);
    blocking(move || {
        let explicit = stored_python(&ws, legacy);
        Ok(interpreter_document(explicit.as_deref()))
    })
    .await
}

/// Choose an interpreter (absolute path) or clear the choice with `null`. A
/// path that fails the resolver's probe is reported and not stored.
#[tauri::command]
pub async fn python_interpreter_set(
    app: AppHandle,
    workspace: State<'_, WorkspaceHost>,
    path: Option<String>,
) -> Result<Value, String> {
    let ws = workspace.inner().clone();
    let legacy = workspace_commands::legacy_index_path(&app);
    blocking(move || {
        let Some(path) = path.filter(|path| !path.trim().is_empty()) else {
            ws.with(legacy.as_deref(), |w, _| {
                w.remove_kv(PYTHON_SETTING_KEY).map_err(|error| error.to_string())
            })?;
            return Ok(interpreter_document(None));
        };
        let candidate = PathBuf::from(path.trim());
        if !candidate.is_absolute() {
            return Err("the interpreter must be an absolute path".to_string());
        }
        let document = interpreter_document(Some(&candidate));
        if document.get("status").and_then(Value::as_str) == Some("resolved") {
            let stored = json!(candidate.display().to_string());
            ws.with(legacy.as_deref(), move |w, _| {
                w.set_kv(PYTHON_SETTING_KEY, &stored).map_err(|error| error.to_string())
            })?;
        }
        Ok(document)
    })
    .await
}

// ── startup reconciliation ──────────────────────────────────────────────

/// Record the runs an earlier application session started and never recorded
/// (a crash or a kill left a receipt, or none, without its database event).
pub fn reconcile_at_startup(app: &AppHandle, workspace: &WorkspaceHost) {
    let Some(cli) = api_sidecar::find_cli_binary() else {
        return;
    };
    let Ok((_, state_root)) = api_sidecar::runtime_roots(&cli) else {
        return;
    };
    let legacy = workspace_commands::legacy_index_path(app);
    reconcile_runs(workspace, legacy, &state_root.join("script-runs"));
}

fn reconcile_runs(workspace: &WorkspaceHost, legacy: Option<PathBuf>, root: &Path) {
    let Ok(entries) = std::fs::read_dir(root) else {
        return;
    };
    for entry in entries.flatten() {
        let dir = entry.path();
        let Some(run_id) = dir.file_name().and_then(|n| n.to_str()).map(str::to_string) else {
            continue;
        };
        if !is_safe_run_id(&run_id) {
            continue;
        }
        let owner = read_json(&dir.join(OWNER_FILE));
        let receipt = std::fs::read(dir.join(RECEIPT_FILE))
            .ok()
            .and_then(|bytes| parse_receipt(&bytes).ok());
        let state = RunDirState {
            has_owner: owner.is_some(),
            has_recorded: dir.join(RECORDED_FILE).exists(),
            has_receipt: receipt.is_some(),
            owner_alive: owner
                .as_ref()
                .and_then(|o| o["host_pid"].as_u64())
                .map(|pid| u32::try_from(pid).unwrap_or(0))
                .is_some_and(|pid| pid == std::process::id() || script_run_process::pid_alive(pid)),
        };
        let now = now_rfc3339();
        let receipt = match plan_reconcile(&state) {
            ReconcileAction::Skip => continue,
            ReconcileAction::RecordReceipt => receipt.expect("planned from an existing receipt"),
            ReconcileAction::Synthesize => {
                let owner = owner.clone().unwrap_or(Value::Null);
                let synthesized = synthesize_receipt(
                    owner["script_path"].as_str().unwrap_or(""),
                    owner["sha256"].as_str().unwrap_or(""),
                    None,
                    "the launching application ended before the run finished",
                    &RequestedRuntime::default(),
                    &now,
                );
                let _ = write_atomically(&dir.join(RECEIPT_FILE), &synthesized);
                synthesized
            }
        };
        let script_path = receipt["script"]["path"]
            .as_str()
            .map(PathBuf::from)
            .or_else(|| {
                owner
                    .as_ref()
                    .and_then(|o| o["script_path"].as_str())
                    .map(PathBuf::from)
            });
        let Some(script_path) = script_path.filter(|p| !p.as_os_str().is_empty()) else {
            continue;
        };
        let event = run_event(&script_path, &receipt, &now);
        let recorded = workspace
            .with(legacy.as_deref(), |w, _| {
                w.record(&event).map(|_| ()).map_err(|error| error.to_string())
            })
            .is_ok();
        if recorded {
            let _ = write_atomically(&dir.join(RECORDED_FILE), &json!({ "recorded_at": now }));
        }
    }
}
