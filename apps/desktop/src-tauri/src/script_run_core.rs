//! Pure logic of "Run in new window" (docs/design/start-screen/docs/08-script-open.md).
//!
//! Everything here is a plain function or value type that can be tested without
//! Tauri: the ticket table (the renderer never holds a path), the content hash
//! check, the consent text and trust decision, the CLI argument and environment
//! building, receipt parsing, exit-code mapping and the database event of a
//! finished run. `script_run.rs` wires these to the host.

use std::collections::{HashMap, VecDeque};
use std::ffi::{OsStr, OsString};
use std::io::Read;
use std::path::{Path, PathBuf};
use std::time::Duration;

use fullmag_workspace::{Actor, EventKind, ItemKind, RecordEvent, MAX_SCRIPT_BYTES};
use serde::{Deserialize, Serialize};
use serde_json::{json, Map, Value};
use sha2::{Digest, Sha256};

/// At most this many script runs are active at once.
pub const MAX_CONCURRENT_RUNS: usize = 2;
/// A stop request is graceful for this long, then the process tree is killed.
pub const STOP_GRACE: Duration = Duration::from_secs(10);
/// Tickets kept in memory; the oldest is dropped first.
pub const MAX_TICKETS: usize = 64;
pub const RECEIPT_SCHEMA: &str = "fullmag.script_run_receipt.v1";
pub const RECEIPT_FILE: &str = "receipt.json";
pub const PROGRESS_FILE: &str = "progress.json";
pub const STOP_REQUEST_FILE: &str = "stop-request";
pub const OWNER_FILE: &str = "owner.json";
pub const RECORDED_FILE: &str = "recorded.json";
pub const CONSENT_TITLE: &str = "Run Python script?";
pub const REMEMBER_TITLE: &str = "Remember this decision?";

// ── the script, as read from disk ───────────────────────────────────────

/// What the host knows about one script file at the moment it was read.
#[derive(Debug, Clone, PartialEq, Eq)]
pub struct ScriptSnapshot {
    /// Absolute path without the Windows verbatim prefix.
    pub path: PathBuf,
    /// Normalised key the database identifies the file by.
    pub path_key: String,
    pub name: String,
    pub bytes: u64,
    pub lines: u64,
    pub sha256: String,
    pub modified_at: String,
    /// `utf-8`, `utf-8-bom` or `other`.
    pub encoding: &'static str,
}

pub fn sha256_hex(bytes: &[u8]) -> String {
    format!("{:x}", Sha256::digest(bytes))
}

/// `(encoding, line count)` of raw script bytes.
pub fn byte_facts(raw: &[u8]) -> (&'static str, u64) {
    let encoding = if raw.starts_with(&[0xEF, 0xBB, 0xBF]) {
        if std::str::from_utf8(&raw[3..]).is_ok() {
            "utf-8-bom"
        } else {
            "other"
        }
    } else if raw.starts_with(&[0xFF, 0xFE]) || raw.starts_with(&[0xFE, 0xFF]) {
        "other"
    } else if std::str::from_utf8(raw).is_ok() {
        "utf-8"
    } else {
        "other"
    };
    let newlines = raw.iter().filter(|byte| **byte == b'\n').count() as u64;
    let lines = newlines + u64::from(!raw.is_empty() && !raw.ends_with(b"\n"));
    (encoding, lines)
}

pub fn display_path(path: &str) -> String {
    if let Some(rest) = path.strip_prefix(r"\\?\UNC\") {
        format!(r"\\{rest}")
    } else if let Some(rest) = path.strip_prefix(r"\\?\") {
        rest.to_string()
    } else {
        path.to_string()
    }
}

/// Read `path` once and describe it. At most 1 MiB; the digest is of exactly
/// the bytes read.
pub fn snapshot_script(path: &Path) -> Result<ScriptSnapshot, String> {
    let shown = display_path(&path.display().to_string());
    let metadata =
        std::fs::metadata(path).map_err(|error| format!("cannot read script {shown}: {error}"))?;
    if !metadata.is_file() {
        return Err(format!("{shown} is not a file"));
    }
    let mut raw = Vec::new();
    std::fs::File::open(path)
        .and_then(|file| file.take(MAX_SCRIPT_BYTES + 1).read_to_end(&mut raw))
        .map_err(|error| format!("cannot read script {shown}: {error}"))?;
    if raw.len() as u64 > MAX_SCRIPT_BYTES {
        return Err(format!("script {shown} is larger than 1 MiB"));
    }
    let identity = fullmag_workspace::identity(path)
        .map_err(|error| format!("cannot identify script {shown}: {error}"))?;
    let (encoding, lines) = byte_facts(&raw);
    let canonical = display_path(&identity.path);
    let name = Path::new(&canonical)
        .file_name()
        .and_then(OsStr::to_str)
        .unwrap_or("script.py")
        .to_string();
    let modified_at = metadata
        .modified()
        .map(fullmag_workspace::rfc3339_millis)
        .unwrap_or_default();
    Ok(ScriptSnapshot {
        path: PathBuf::from(canonical),
        path_key: identity.key,
        name,
        bytes: raw.len() as u64,
        lines,
        sha256: sha256_hex(&raw),
        modified_at,
        encoding,
    })
}

// ── wire types shared with the renderer ─────────────────────────────────

#[derive(Debug, Clone, PartialEq, Eq, Serialize)]
pub struct ScriptHandle {
    pub ticket: String,
    pub item_id: Option<i64>,
    pub name: String,
    pub display_path: String,
    pub bytes: u64,
    pub lines: u64,
    pub sha256: String,
    pub modified_at: String,
    pub encoding: &'static str,
}

#[derive(Debug, Clone, Copy, PartialEq, Eq, Deserialize)]
#[serde(rename_all = "snake_case")]
pub enum BackendChoice {
    Auto,
    Fdm,
    Fem,
    Hybrid,
}

#[derive(Debug, Clone, Copy, PartialEq, Eq, Deserialize)]
#[serde(rename_all = "snake_case")]
pub enum ModeChoice {
    Strict,
    Extended,
    Hybrid,
}

#[derive(Debug, Clone, Copy, PartialEq, Eq, Deserialize)]
#[serde(rename_all = "snake_case")]
pub enum PrecisionChoice {
    Single,
    Double,
}

#[derive(Debug, Clone, Copy, PartialEq, Eq, Deserialize)]
#[serde(rename_all = "snake_case")]
pub enum DeviceChoice {
    Auto,
    Cpu,
    Gpu,
}

macro_rules! choice_name {
    ($ty:ident { $($variant:ident => $text:literal),+ }) => {
        impl $ty {
            pub fn as_str(self) -> &'static str {
                match self { $($ty::$variant => $text),+ }
            }
        }
    };
}
choice_name!(BackendChoice { Auto => "auto", Fdm => "fdm", Fem => "fem", Hybrid => "hybrid" });
choice_name!(ModeChoice { Strict => "strict", Extended => "extended", Hybrid => "hybrid" });
choice_name!(PrecisionChoice { Single => "single", Double => "double" });
choice_name!(DeviceChoice { Auto => "auto", Cpu => "cpu", Gpu => "gpu" });

/// Each field is optional: absent means "as written in the script".
#[derive(Debug, Clone, Copy, Default, PartialEq, Eq, Deserialize)]
pub struct RequestedRuntime {
    #[serde(default)]
    pub backend: Option<BackendChoice>,
    #[serde(default)]
    pub mode: Option<ModeChoice>,
    #[serde(default)]
    pub precision: Option<PrecisionChoice>,
    #[serde(default)]
    pub device: Option<DeviceChoice>,
}

impl RequestedRuntime {
    /// The `requested` object of the receipt: `as_authored` is literal.
    pub fn to_json(&self) -> Value {
        let text = |value: Option<&'static str>| value.unwrap_or("as_authored");
        json!({
            "backend": text(self.backend.map(BackendChoice::as_str)),
            "mode": text(self.mode.map(ModeChoice::as_str)),
            "precision": text(self.precision.map(PrecisionChoice::as_str)),
            "device": text(self.device.map(DeviceChoice::as_str)),
        })
    }
}

#[derive(Debug, Clone, Copy, PartialEq, Eq, Deserialize, Default)]
#[serde(rename_all = "snake_case")]
pub enum ResultsChoice {
    #[default]
    Managed,
    NextToScript,
}

fn default_wait_for_solve() -> bool {
    true
}

#[derive(Debug, Clone, Deserialize)]
pub struct ScriptRunRequest {
    pub ticket: String,
    #[serde(default)]
    pub requested: RequestedRuntime,
    #[serde(default = "default_wait_for_solve")]
    pub wait_for_solve: bool,
    #[serde(default)]
    pub results: ResultsChoice,
    #[serde(default)]
    pub confirm_overwrite: Option<bool>,
}

/// Why `script_run` refused before spawning anything.
#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub enum Refusal {
    Changed,
    Syntax,
    Interpreter,
    Encoding,
    CliMissing,
    /// Unknown, expired or malformed ticket.
    Ticket,
    /// The concurrency cap is reached.
    Busy,
    /// Results next to the script were requested without confirmation.
    ConfirmRequired,
    /// The managed run directory could not be created.
    Storage,
}

impl Refusal {
    pub fn code(self) -> &'static str {
        match self {
            Self::Changed => "changed",
            Self::Syntax => "syntax",
            Self::Interpreter => "interpreter",
            Self::Encoding => "encoding",
            Self::CliMissing => "cli_missing",
            Self::Ticket => "ticket",
            Self::Busy => "busy",
            Self::ConfirmRequired => "confirm_required",
            Self::Storage => "storage",
        }
    }
}

// ── tickets ─────────────────────────────────────────────────────────────

#[derive(Debug, Clone)]
pub struct Ticket {
    pub snapshot: ScriptSnapshot,
    /// `fullmag script inspect --json` of exactly `snapshot.sha256`.
    pub preflight: Option<Value>,
}

/// Opaque tickets for files the host itself read. A ticket is the only thing a
/// run request can name: the renderer never supplies or edits a path.
#[derive(Debug, Default)]
pub struct TicketTable {
    entries: HashMap<String, Ticket>,
    order: VecDeque<String>,
}

impl TicketTable {
    pub fn issue(
        &mut self,
        token: String,
        snapshot: ScriptSnapshot,
        item_id: Option<i64>,
    ) -> ScriptHandle {
        while self.order.len() >= MAX_TICKETS {
            if let Some(oldest) = self.order.pop_front() {
                self.entries.remove(&oldest);
            }
        }
        let handle = ScriptHandle {
            ticket: token.clone(),
            item_id,
            name: snapshot.name.clone(),
            display_path: snapshot.path.display().to_string(),
            bytes: snapshot.bytes,
            lines: snapshot.lines,
            sha256: snapshot.sha256.clone(),
            modified_at: snapshot.modified_at.clone(),
            encoding: snapshot.encoding,
        };
        self.order.push_back(token.clone());
        self.entries.insert(
            token,
            Ticket {
                snapshot,
                preflight: None,
            },
        );
        handle
    }

    pub fn get(&self, token: &str) -> Option<&Ticket> {
        self.entries.get(token)
    }

    pub fn set_preflight(&mut self, token: &str, preflight: Value) {
        if let Some(ticket) = self.entries.get_mut(token) {
            ticket.preflight = Some(preflight);
        }
    }

    #[cfg(test)]
    pub fn len(&self) -> usize {
        self.entries.len()
    }
}

/// A 128-bit random token, 32 lowercase hex characters.
pub fn new_token() -> String {
    uuid::Uuid::new_v4().simple().to_string()
}

/// A file that changed after it was hashed is refused (R3).
pub fn check_unchanged(approved: &ScriptSnapshot, current: &ScriptSnapshot) -> Result<(), Refusal> {
    if approved.sha256 == current.sha256 && approved.path_key == current.path_key {
        Ok(())
    } else {
        Err(Refusal::Changed)
    }
}

/// Read the file again and compare it with the approved snapshot.
pub fn recheck_file(approved: &ScriptSnapshot) -> Result<(), Refusal> {
    match snapshot_script(&approved.path) {
        Ok(current) => check_unchanged(approved, &current),
        Err(_) => Err(Refusal::Changed),
    }
}

// ── preflight facts and refusal decisions ───────────────────────────────

/// First reason a preflight document forbids running, if any.
pub fn preflight_refusal(inspect: &Value) -> Option<(Refusal, String)> {
    if let Some("other") = inspect.get("encoding").and_then(Value::as_str) {
        return Some((
            Refusal::Encoding,
            "the script is not UTF-8 text (a UTF-8 byte order mark is accepted, UTF-16 and legacy code pages are not)"
                .to_string(),
        ));
    }
    let syntax = inspect.get("syntax");
    if syntax.and_then(|s| s.get("ok")) == Some(&Value::Bool(false)) {
        let field = |key: &str| syntax.and_then(|s| s.get(key)).cloned().unwrap_or(Value::Null);
        let message = field("message");
        return Some((
            Refusal::Syntax,
            format!(
                "syntax error at line {} column {}: {}",
                field("line"),
                field("column"),
                message.as_str().unwrap_or("invalid syntax")
            ),
        ));
    }
    let interpreter = inspect.get("interpreter");
    if interpreter
        .and_then(|i| i.get("status"))
        .and_then(Value::as_str)
        == Some("error")
    {
        let message = interpreter
            .and_then(|i| i.get("message"))
            .and_then(Value::as_str)
            .unwrap_or("no usable Python interpreter");
        return Some((Refusal::Interpreter, message.to_string()));
    }
    None
}

// ── consent ─────────────────────────────────────────────────────────────

/// Facts shown in the host-native prompt. Nothing here comes from the renderer.
#[derive(Debug, Clone, PartialEq, Eq)]
pub struct ConsentFacts {
    pub file_name: String,
    pub folder: String,
    pub sha256: String,
    pub interpreter: String,
    pub interpreter_version: String,
    pub working_dir: String,
    pub results: ResultsChoice,
    pub results_dir: String,
    pub active_runs: usize,
}

pub fn consent_message(facts: &ConsentFacts) -> String {
    let mut lines = vec![
        format!("File: {}", facts.file_name),
        format!("Folder: {}", facts.folder),
        format!("Content hash (sha256): {}", short_hash(&facts.sha256)),
        format!(
            "Interpreter: {} ({})",
            facts.interpreter, facts.interpreter_version
        ),
        format!("Working directory: {}", facts.working_dir),
    ];
    lines.push(match facts.results {
        ResultsChoice::Managed => format!("Results: {} (managed by Fullmag)", facts.results_dir),
        ResultsChoice::NextToScript => format!(
            "Results: next to the script, in {} (an existing results folder is kept; a new numbered folder is created)",
            facts.results_dir
        ),
    });
    lines.push(String::new());
    lines.push(
        "This script runs with your user permissions. It can read and write files and use the network."
            .to_string(),
    );
    if facts.active_runs > 0 {
        lines.push(format!(
            "{} other script run{} already active; running more than one can slow all of them down and compete for the GPU.",
            facts.active_runs,
            if facts.active_runs == 1 { " is" } else { "s are" }
        ));
    }
    lines.join("\n")
}

pub fn remember_message(facts: &ConsentFacts) -> String {
    format!(
        "Do not ask again for {} while its content stays exactly the same (hash {}).\n\nAfter any edit, Fullmag asks again.",
        facts.file_name,
        short_hash(&facts.sha256)
    )
}

pub fn short_hash(sha256: &str) -> String {
    sha256.chars().take(12).collect()
}

#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub enum ConsentMode {
    /// The native prompt must be answered.
    Prompt,
    /// A remembered decision for exactly this content skips the prompt.
    Remembered,
}

impl ConsentMode {
    pub fn as_str(self) -> &'static str {
        match self {
            Self::Prompt => "prompt",
            Self::Remembered => "remembered",
        }
    }
}

/// `trust` is the item's `meta.trust` (`{sha256, decided_at}`). A decision is
/// bound to the content hash, and writing results next to the script is never
/// pre-approved.
pub fn consent_mode(trust: Option<&Value>, sha256: &str, results: ResultsChoice) -> ConsentMode {
    let remembered = trust
        .and_then(|trust| trust.get("sha256"))
        .and_then(Value::as_str)
        .is_some_and(|stored| stored.eq_ignore_ascii_case(sha256));
    if remembered && results == ResultsChoice::Managed {
        ConsentMode::Remembered
    } else {
        ConsentMode::Prompt
    }
}

pub fn trust_patch(sha256: &str, decided_at: &str) -> Value {
    json!({ "trust": { "sha256": sha256, "decided_at": decided_at } })
}

// ── running ─────────────────────────────────────────────────────────────

/// Everything the spawn needs, decided host-side.
#[derive(Debug, Clone)]
pub struct LaunchPlan {
    pub script: PathBuf,
    pub sha256: String,
    pub api_port: u16,
    pub receipt: PathBuf,
    pub results: ResultsChoice,
    pub results_dir: PathBuf,
    pub requested: RequestedRuntime,
    pub wait_for_solve: bool,
    pub explicit_python: Option<PathBuf>,
}

/// Arguments of `fullmag` for a desktop-launched run. Every path is a separate
/// argument and never goes through a shell.
pub fn build_cli_args(plan: &LaunchPlan) -> Vec<OsString> {
    let mut args: Vec<OsString> = vec!["--interactive".into()];
    if plan.wait_for_solve {
        args.push("--wait-for-solve".into());
    }
    let mut pair = |name: &str, value: OsString| {
        args.push(name.into());
        args.push(value);
    };
    pair("--ui", "desktop".into());
    pair("--launched-by", "desktop".into());
    pair("--api-port", plan.api_port.to_string().into());
    pair("--expect-script-sha256", plan.sha256.clone().into());
    pair("--receipt", plan.receipt.clone().into_os_string());
    if let Some(python) = &plan.explicit_python {
        pair("--python", python.clone().into_os_string());
    }
    if let Some(backend) = plan.requested.backend {
        pair("--backend", backend.as_str().into());
    }
    if let Some(mode) = plan.requested.mode {
        pair("--mode", mode.as_str().into());
    }
    if let Some(precision) = plan.requested.precision {
        pair("--precision", precision.as_str().into());
    }
    match plan.results {
        ResultsChoice::Managed => {
            pair("--output-dir", plan.results_dir.clone().into_os_string());
            pair("--existing-output", "error".into());
        }
        // Never replace what is there: a new numbered folder is reserved.
        ResultsChoice::NextToScript => pair("--existing-output", "timestamp".into()),
    }
    args.push(plan.script.clone().into_os_string());
    args
}

/// Environment variable names that must not reach the script's process tree:
/// the host's own runtime control and development-owner variables.
pub fn is_private_env(name: &str) -> bool {
    let upper = name.to_ascii_uppercase();
    upper.starts_with("FULLMAG_DEVELOPMENT_")
        || upper.starts_with("FULLMAG_ATTACHED_")
        || matches!(
            upper.as_str(),
            "FULLMAG_RUNTIME_SERVICE_OWNER"
                | "FULLMAG_RUNTIME_SERVICE_CONFIG"
                | "FULLMAG_SKIP_CONTROL_ROOM"
                | "FULLMAG_UI_URL"
                | "FULLMAG_API_BASE"
                | "FULLMAG_LAUNCH_INTENT"
                | "FULLMAG_API_PORT"
        )
}

/// What to change in the inherited environment: `(set, remove)`.
/// Scripts legitimately read `FULLMAG_*` values, so the rest is inherited.
pub fn child_env_changes(
    inherited: impl IntoIterator<Item = String>,
    repo_root: &Path,
    state_root: &Path,
    requested: &RequestedRuntime,
) -> (Vec<(String, OsString)>, Vec<String>) {
    let mut remove: Vec<String> = inherited
        .into_iter()
        .filter(|name| is_private_env(name))
        .collect();
    let mut set: Vec<(String, OsString)> = vec![
        ("FULLMAG_LAUNCHED_BY".into(), "desktop".into()),
        ("FULLMAG_REPO_ROOT".into(), repo_root.as_os_str().to_owned()),
        ("FULLMAG_STATE_ROOT".into(), state_root.as_os_str().to_owned()),
    ];
    // The device travels as FULLMAG_{FDM,FEM}_EXECUTION until the CLI has a flag.
    // "auto" is an explicit request: an inherited value must not override it.
    for name in ["FULLMAG_FDM_EXECUTION", "FULLMAG_FEM_EXECUTION"] {
        match requested.device {
            Some(DeviceChoice::Cpu) => set.push((name.into(), "cpu".into())),
            Some(DeviceChoice::Gpu) => set.push((name.into(), "gpu".into())),
            Some(DeviceChoice::Auto) => remove.push(name.into()),
            None => {}
        }
    }
    remove.sort();
    remove.dedup();
    (set, remove)
}

pub fn run_dir(state_root: &Path, run_id: &str) -> PathBuf {
    state_root.join("script-runs").join(run_id)
}

pub fn new_run_id(unix_ms: u128, token: &str) -> String {
    format!("script-{unix_ms}-{}", token.chars().take(8).collect::<String>())
}

/// A run id is created by the host; anything else must not name a directory.
pub fn is_safe_run_id(run_id: &str) -> bool {
    !run_id.is_empty()
        && run_id.len() <= 64
        && run_id
            .chars()
            .all(|c| c.is_ascii_alphanumeric() || c == '-' || c == '_')
}

/// True when a fast exit says the chosen API port was taken: the host picks
/// another port once.
pub fn is_port_conflict(error: &str) -> bool {
    let lower = error.to_ascii_lowercase();
    lower.contains("not bindable") || lower.contains("address already in use")
}

// ── exit codes and receipts ─────────────────────────────────────────────

/// Name of a documented exit code (08-script-open.md 6.2).
pub fn exit_code_name(code: i32) -> &'static str {
    match code {
        0 => "ok",
        2 => "usage",
        10 => "interpreter",
        11 => "changed",
        12 => "syntax",
        13 => "materialization",
        14 => "runtime_unavailable",
        130 => "stopped",
        _ => "failed",
    }
}

/// `outcome.status` for an exit code, used when the CLI left no receipt.
pub fn status_for_exit(code: i32) -> &'static str {
    match code {
        0 => "completed",
        2 | 10 | 11 | 12 => "not_started",
        130 => "cancelled",
        _ => "failed",
    }
}

pub fn parse_receipt(bytes: &[u8]) -> Result<Value, String> {
    let value: Value =
        serde_json::from_slice(bytes).map_err(|error| format!("receipt is not JSON: {error}"))?;
    if value.get("schema").and_then(Value::as_str) != Some(RECEIPT_SCHEMA) {
        return Err(format!("receipt is not a {RECEIPT_SCHEMA} document"));
    }
    if value
        .get("outcome")
        .and_then(|outcome| outcome.get("status"))
        .and_then(Value::as_str)
        .is_none()
    {
        return Err("receipt has no outcome status".to_string());
    }
    Ok(value)
}

/// A receipt for a run whose CLI ended without writing one.
pub fn synthesize_receipt(
    snapshot_path: &str,
    sha256: &str,
    exit_code: Option<i32>,
    reason: &str,
    requested: &RequestedRuntime,
    now: &str,
) -> Value {
    let status = exit_code.map_or("cancelled", status_for_exit);
    json!({
        "schema": RECEIPT_SCHEMA,
        "script": { "path": snapshot_path, "sha256": sha256 },
        "interpreter": Value::Null,
        "process": Value::Null,
        "requested": requested.to_json(),
        "resolved": Value::Null,
        "ids": { "session_id": Value::Null, "run_id": Value::Null, "problem_ir_source_hash": Value::Null },
        "results": { "dir": Value::Null, "next_to_script": false },
        "outcome": {
            "status": status,
            "exit_code": exit_code,
            "finished_at": now,
            "duration_seconds": Value::Null,
            "error": reason,
            "synthesized_by": "desktop",
        },
    })
}

/// Complete a CLI receipt with what only the host knows: the consent and the
/// literal request (`auto` stays `auto`).
pub fn finalize_receipt(
    receipt: &mut Value,
    consent_mode: ConsentMode,
    consent_at: &str,
    sha256_at_consent: &str,
    requested: &RequestedRuntime,
    window_opened: bool,
) {
    if let Some(object) = receipt.as_object_mut() {
        object.insert(
            "consent".into(),
            json!({
                "mode": consent_mode.as_str(),
                "at": consent_at,
                "sha256_at_consent": sha256_at_consent,
            }),
        );
        object.insert("requested".into(), requested.to_json());
        object.insert("window_opened".into(), json!(window_opened));
    }
}

/// `meta.last_run.status` vocabulary of the start screen.
pub fn last_run_status(outcome_status: &str) -> &'static str {
    match outcome_status {
        "completed" => "ok",
        "cancelled" => "cancelled",
        _ => "failed",
    }
}

/// The `run` event of a finished run (actor desktop). `detail` is the receipt
/// without the paths the item already carries.
pub fn run_event(script_path: &Path, receipt: &Value, now: &str) -> RecordEvent {
    let outcome = receipt.get("outcome").cloned().unwrap_or(Value::Null);
    let text = |value: &Value, key: &str| value.get(key).cloned().unwrap_or(Value::Null);
    let status = outcome
        .get("status")
        .and_then(Value::as_str)
        .unwrap_or("failed");
    let resolved = receipt.get("resolved").cloned().unwrap_or(Value::Null);
    let requested = receipt.get("requested").cloned().unwrap_or(Value::Null);
    let device = resolved
        .get("device")
        .and_then(Value::as_str)
        .or_else(|| requested.get("device").and_then(Value::as_str))
        .unwrap_or("as_authored")
        .to_string();
    let duration = outcome.get("duration_seconds").cloned().unwrap_or(Value::Null);
    let at = outcome
        .get("finished_at")
        .and_then(Value::as_str)
        .unwrap_or(now)
        .to_string();

    let mut detail = Map::new();
    detail.insert("status".into(), json!(status));
    detail.insert("exit_code".into(), text(&outcome, "exit_code"));
    detail.insert("duration_seconds".into(), duration.clone());
    detail.insert("error".into(), text(&outcome, "error"));
    detail.insert(
        "sha256".into(),
        receipt
            .get("script")
            .map(|script| text(script, "sha256"))
            .unwrap_or(Value::Null),
    );
    detail.insert("requested".into(), requested);
    detail.insert("resolved".into(), resolved);
    detail.insert(
        "interpreter".into(),
        receipt
            .get("interpreter")
            .map(|interpreter| {
                json!({
                    "version": text(interpreter, "version"),
                    "source": text(interpreter, "source"),
                    "isolated": text(interpreter, "isolated"),
                })
            })
            .unwrap_or(Value::Null),
    );
    detail.insert(
        "consent".into(),
        receipt
            .get("consent")
            .and_then(|consent| consent.get("mode"))
            .cloned()
            .unwrap_or(Value::Null),
    );
    detail.insert(
        "ids".into(),
        receipt.get("ids").cloned().unwrap_or(Value::Null),
    );

    let mut last_run = Map::new();
    last_run.insert("status".into(), json!(last_run_status(status)));
    last_run.insert("at".into(), json!(at));
    last_run.insert("duration_seconds".into(), duration);
    last_run.insert("device".into(), json!(device));

    RecordEvent::new(ItemKind::Script, script_path, EventKind::Run, Actor::Desktop)
        .with_detail(Value::Object(detail))
        .with_meta_patch(json!({ "last_run": Value::Object(last_run) }))
}

/// What is on disk for one earlier run directory.
#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub struct RunDirState {
    pub has_owner: bool,
    pub has_recorded: bool,
    pub has_receipt: bool,
    /// The application that started the run is still alive.
    pub owner_alive: bool,
}

#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub enum ReconcileAction {
    /// Nothing to do: already recorded, not ours, or still owned by a live host.
    Skip,
    /// The CLI left a receipt that was never recorded.
    RecordReceipt,
    /// No receipt and the host is gone: write a `cancelled` receipt, then record.
    Synthesize,
}

/// Decide what the next application start does with an earlier run directory.
/// A run whose host is alive is never touched.
pub fn plan_reconcile(state: &RunDirState) -> ReconcileAction {
    if !state.has_owner || state.has_recorded || state.owner_alive {
        ReconcileAction::Skip
    } else if state.has_receipt {
        ReconcileAction::RecordReceipt
    } else {
        ReconcileAction::Synthesize
    }
}

/// Live state shown to the renderer, from the CLI's `progress.json`.
pub fn state_from_progress(progress: Option<&Value>) -> &'static str {
    match progress
        .and_then(|p| p.get("state"))
        .and_then(Value::as_str)
    {
        Some("waiting_for_solve") => "waiting_for_solve",
        Some("running") => "running",
        Some("materializing") => "materializing",
        _ => "starting",
    }
}

/// The API port and readiness announced by the CLI.
pub fn ui_endpoint(progress: Option<&Value>) -> Option<u16> {
    let progress = progress?;
    if progress.get("ui_ready") != Some(&Value::Bool(true)) {
        return None;
    }
    progress
        .get("api_port")
        .and_then(Value::as_u64)
        .and_then(|port| u16::try_from(port).ok())
        .filter(|port| *port != 0)
}

/// URL of the script's workspace, pinned to one API instance.
pub fn ui_url(port: u16, api_instance_id: &str) -> String {
    format!("http://localhost:{port}/workspace?fullmag_api_instance={api_instance_id}")
}

/// Window label of a run; used for the capability pattern `script-run-*`.
pub fn window_label(run_id: &str) -> String {
    format!("script-run-{run_id}")
}

#[cfg(test)]
pub fn run_handle_from_label(label: &str) -> Option<&str> {
    label.strip_prefix("script-run-")
}

/// Warning shown before consent when other runs are already active.
pub fn concurrency_warning(active_runs: usize) -> Option<String> {
    if active_runs == 0 {
        return None;
    }
    Some(format!(
        "{active_runs} script run{} already active. At most {MAX_CONCURRENT_RUNS} can run at once, and several runs compete for the same CPU and GPU.",
        if active_runs == 1 { " is" } else { "s are" }
    ))
}

#[cfg(test)]
mod tests {
    use super::*;
    use std::fs;

    fn scratch(name: &str) -> PathBuf {
        let dir = std::env::temp_dir().join(format!(
            "fullmag-script-run-core-{}-{name}",
            std::process::id()
        ));
        fs::create_dir_all(&dir).unwrap();
        dir
    }

    fn snapshot_of(dir: &Path, name: &str, text: &[u8]) -> ScriptSnapshot {
        let path = dir.join(name);
        fs::write(&path, text).unwrap();
        snapshot_script(&path).unwrap()
    }

    fn plan(results: ResultsChoice) -> LaunchPlan {
        LaunchPlan {
            script: PathBuf::from(r"C:\work dir\łódź sp4.py"),
            sha256: "ab".repeat(32),
            api_port: 18123,
            receipt: PathBuf::from(r"C:\state\script-runs\r1\receipt.json"),
            results,
            results_dir: PathBuf::from(r"C:\state\script-runs\r1\results"),
            requested: RequestedRuntime::default(),
            wait_for_solve: true,
            explicit_python: None,
        }
    }

    fn arg_text(args: &[OsString]) -> Vec<String> {
        args.iter().map(|a| a.to_string_lossy().into_owned()).collect()
    }

    #[test]
    fn snapshot_reads_hash_encoding_lines_and_a_clean_path() {
        let dir = scratch("snapshot");
        let plain = snapshot_of(&dir, "a b.py", b"x = 1\ny = 2\n");
        assert_eq!(plain.encoding, "utf-8");
        assert_eq!((plain.bytes, plain.lines), (12, 2));
        assert_eq!(plain.sha256, sha256_hex(b"x = 1\ny = 2\n"));
        assert_eq!(plain.name, "a b.py");
        assert!(!plain.path.display().to_string().starts_with(r"\\?\"));
        let bom = snapshot_of(&dir, "bom.py", b"\xEF\xBB\xBFx = 1\n");
        assert_eq!(bom.encoding, "utf-8-bom");
        let legacy = snapshot_of(&dir, "legacy.py", b"# \xB5\n");
        assert_eq!(legacy.encoding, "other");
        assert!(snapshot_script(&dir.join("missing.py")).is_err());
        assert!(snapshot_script(&dir).is_err());
    }

    #[test]
    fn tickets_are_opaque_bounded_and_resolve_only_what_the_host_issued() {
        let dir = scratch("tickets");
        let mut table = TicketTable::default();
        let snapshot = snapshot_of(&dir, "t.py", b"x = 1\n");
        let handle = table.issue("t0".into(), snapshot.clone(), Some(7));
        assert_eq!(handle.ticket, "t0");
        assert_eq!(handle.item_id, Some(7));
        assert_eq!(table.get("t0").unwrap().snapshot, snapshot);
        assert!(table.get("unknown").is_none());
        assert!(table.get(&snapshot.path.display().to_string()).is_none());
        for index in 0..MAX_TICKETS + 5 {
            table.issue(format!("n{index}"), snapshot.clone(), None);
        }
        assert_eq!(table.len(), MAX_TICKETS);
        assert!(table.get("t0").is_none(), "the oldest ticket is evicted");
        assert_eq!(new_token().len(), 32);
        assert_ne!(new_token(), new_token());
    }

    #[test]
    fn a_file_changed_after_hashing_is_refused() {
        let dir = scratch("changed");
        let approved = snapshot_of(&dir, "c.py", b"x = 1\n");
        assert_eq!(recheck_file(&approved), Ok(()));
        fs::write(&approved.path, b"x = 2\n").unwrap();
        assert_eq!(recheck_file(&approved), Err(Refusal::Changed));
        fs::remove_file(&approved.path).unwrap();
        assert_eq!(recheck_file(&approved), Err(Refusal::Changed));
        assert_eq!(Refusal::Changed.code(), "changed");
        assert_eq!(Refusal::CliMissing.code(), "cli_missing");
    }

    #[test]
    fn preflight_refuses_encoding_syntax_and_interpreter_in_that_order() {
        let ok = json!({"encoding": "utf-8", "syntax": {"ok": true}, "interpreter": {"status": "resolved"}});
        assert!(preflight_refusal(&ok).is_none());
        let degraded = json!({"encoding": "utf-8", "syntax": {"checked": false}, "interpreter": {"status": "resolved"}});
        assert!(preflight_refusal(&degraded).is_none());
        let encoding = json!({"encoding": "other", "syntax": {"ok": false}});
        assert_eq!(preflight_refusal(&encoding).unwrap().0, Refusal::Encoding);
        let syntax = json!({"encoding": "utf-8", "syntax": {"ok": false, "line": 3, "column": 5, "message": "invalid syntax"}});
        let (kind, message) = preflight_refusal(&syntax).unwrap();
        assert_eq!(kind, Refusal::Syntax);
        assert!(message.contains("line 3") && message.contains("invalid syntax"));
        let interpreter = json!({"encoding": "utf-8", "syntax": {"ok": true}, "interpreter": {"status": "error", "message": "no Python found"}});
        let (kind, message) = preflight_refusal(&interpreter).unwrap();
        assert_eq!(kind, Refusal::Interpreter);
        assert_eq!(message, "no Python found");
    }

    #[test]
    fn trust_is_bound_to_the_content_hash_and_never_covers_next_to_script() {
        let sha = "ab".repeat(32);
        let trust = json!({"sha256": sha, "decided_at": "2026-10-05T10:00:00.000Z"});
        assert_eq!(consent_mode(Some(&trust), &sha, ResultsChoice::Managed), ConsentMode::Remembered);
        assert_eq!(consent_mode(Some(&trust), &sha.to_uppercase(), ResultsChoice::Managed), ConsentMode::Remembered);
        assert_eq!(consent_mode(Some(&trust), &"cd".repeat(32), ResultsChoice::Managed), ConsentMode::Prompt);
        assert_eq!(consent_mode(None, &sha, ResultsChoice::Managed), ConsentMode::Prompt);
        assert_eq!(consent_mode(Some(&trust), &sha, ResultsChoice::NextToScript), ConsentMode::Prompt);
        assert_eq!(trust_patch("h", "t")["trust"]["sha256"], "h");
    }

    #[test]
    fn consent_text_names_the_file_folder_hash_interpreter_and_permissions() {
        let facts = ConsentFacts {
            file_name: "sp4.py".into(),
            folder: r"C:\work".into(),
            sha256: "0123456789abcdef".repeat(4),
            interpreter: r"C:\py\python.exe".into(),
            interpreter_version: "3.12.2".into(),
            working_dir: r"C:\work".into(),
            results: ResultsChoice::Managed,
            results_dir: r"C:\state\r1\results".into(),
            active_runs: 1,
        };
        let text = consent_message(&facts);
        for needle in ["sp4.py", r"C:\work", "0123456789ab", r"C:\py\python.exe", "3.12.2", "user permissions", "network", "1 other script run is already active"] {
            assert!(text.contains(needle), "missing {needle}: {text}");
        }
        assert!(!text.contains("0123456789abc"), "only the first 12 hex digits are shown");
        let next = consent_message(&ConsentFacts {
            results: ResultsChoice::NextToScript,
            active_runs: 0,
            ..facts.clone()
        });
        assert!(next.contains("next to the script") && next.contains("is kept"));
        assert!(!next.contains("already active"));
        assert!(remember_message(&facts).contains("0123456789ab"));
        assert_eq!(CONSENT_TITLE, "Run Python script?");
    }

    #[test]
    fn cli_arguments_are_separate_values_with_the_script_last() {
        let args = arg_text(&build_cli_args(&plan(ResultsChoice::Managed)));
        assert_eq!(args.last().unwrap(), r"C:\work dir\łódź sp4.py");
        let at = |name: &str| args.iter().position(|a| a == name).unwrap_or_else(|| panic!("{name} missing"));
        assert_eq!(args[at("--api-port") + 1], "18123");
        assert_eq!(args[at("--ui") + 1], "desktop");
        assert_eq!(args[at("--launched-by") + 1], "desktop");
        assert_eq!(args[at("--expect-script-sha256") + 1], "ab".repeat(32));
        assert_eq!(args[at("--receipt") + 1], r"C:\state\script-runs\r1\receipt.json");
        assert_eq!(args[at("--output-dir") + 1], r"C:\state\script-runs\r1\results");
        assert_eq!(args[at("--existing-output") + 1], "error");
        assert!(args.contains(&"--wait-for-solve".to_string()));
        assert!(args.contains(&"--interactive".to_string()));
        assert!(!args.contains(&"--backend".to_string()), "unset means as authored");
        assert!(!args.contains(&"--python".to_string()));
    }

    #[test]
    fn requested_runtime_and_next_to_script_shape_the_arguments() {
        let mut next = plan(ResultsChoice::NextToScript);
        next.requested = RequestedRuntime {
            backend: Some(BackendChoice::Fdm),
            mode: Some(ModeChoice::Strict),
            precision: Some(PrecisionChoice::Double),
            device: Some(DeviceChoice::Gpu),
        };
        next.wait_for_solve = false;
        next.explicit_python = Some(PathBuf::from(r"C:\py\python.exe"));
        let args = arg_text(&build_cli_args(&next));
        assert!(!args.contains(&"--output-dir".to_string()), "no managed directory next to the script");
        let at = |name: &str| args.iter().position(|a| a == name).unwrap();
        assert_eq!(args[at("--existing-output") + 1], "timestamp", "an existing folder is never replaced");
        assert_eq!(args[at("--backend") + 1], "fdm");
        assert_eq!(args[at("--mode") + 1], "strict");
        assert_eq!(args[at("--precision") + 1], "double");
        assert_eq!(args[at("--python") + 1], r"C:\py\python.exe");
        assert!(!args.contains(&"--wait-for-solve".to_string()));
        // The device is never a flag; it travels as the environment pair.
        assert!(!args.iter().any(|a| a == "--device"));
    }

    #[test]
    fn private_variables_are_removed_and_the_device_travels_as_environment() {
        let inherited = [
            "PATH",
            "FULLMAG_DEVELOPMENT_OWNER_TOKEN",
            "FULLMAG_DEVELOPMENT_RESTART_COORDINATOR",
            "FULLMAG_ATTACHED_SESSION_ID",
            "FULLMAG_API_PORT",
            "FULLMAG_SP5_DEVICE",
            "fullmag_ui_url",
        ]
        .map(String::from);
        let requested = RequestedRuntime { device: Some(DeviceChoice::Gpu), ..Default::default() };
        let (set, remove) = child_env_changes(inherited.clone(), Path::new("C:/repo"), Path::new("C:/state"), &requested);
        for name in ["FULLMAG_DEVELOPMENT_OWNER_TOKEN", "FULLMAG_DEVELOPMENT_RESTART_COORDINATOR", "FULLMAG_ATTACHED_SESSION_ID", "FULLMAG_API_PORT", "fullmag_ui_url"] {
            assert!(remove.contains(&name.to_string()), "{name} must not reach the script");
        }
        assert!(!remove.contains(&"FULLMAG_SP5_DEVICE".to_string()), "scripts may read FULLMAG_* settings");
        assert!(!remove.contains(&"PATH".to_string()));
        let value = |name: &str| set.iter().find(|(n, _)| n == name).map(|(_, v)| v.to_string_lossy().into_owned());
        assert_eq!(value("FULLMAG_LAUNCHED_BY").as_deref(), Some("desktop"));
        assert_eq!(value("FULLMAG_FDM_EXECUTION").as_deref(), Some("gpu"));
        assert_eq!(value("FULLMAG_FEM_EXECUTION").as_deref(), Some("gpu"));
        assert!(value("FULLMAG_STATE_ROOT").is_some() && value("FULLMAG_REPO_ROOT").is_some());

        let auto = RequestedRuntime { device: Some(DeviceChoice::Auto), ..Default::default() };
        let (set, remove) = child_env_changes(inherited.clone(), Path::new("r"), Path::new("s"), &auto);
        assert!(set.iter().all(|(n, _)| !n.ends_with("_EXECUTION")));
        assert!(remove.contains(&"FULLMAG_FDM_EXECUTION".to_string()), "auto must beat an inherited value");
        let (set, remove) = child_env_changes(inherited, Path::new("r"), Path::new("s"), &RequestedRuntime::default());
        assert!(set.iter().all(|(n, _)| !n.ends_with("_EXECUTION")));
        assert!(!remove.iter().any(|n| n.ends_with("_EXECUTION")));
    }

    #[test]
    fn run_ids_are_host_made_and_safe_as_directory_names() {
        let id = new_run_id(1_700_000_000_123, "0123456789abcdef");
        assert_eq!(id, "script-1700000000123-01234567");
        assert!(is_safe_run_id(&id));
        assert!(!is_safe_run_id("../escape"));
        assert!(!is_safe_run_id(""));
        assert_eq!(run_dir(Path::new("/s"), &id), Path::new("/s").join("script-runs").join(&id));
        assert_eq!(run_handle_from_label(&window_label(&id)), Some(id.as_str()));
        assert_eq!(run_handle_from_label("main"), None);
    }

    #[test]
    fn exit_codes_map_to_names_and_statuses() {
        let names: Vec<_> = [0, 1, 2, 10, 11, 12, 13, 14, 130, 99].iter().map(|c| exit_code_name(*c)).collect();
        assert_eq!(names, ["ok", "failed", "usage", "interpreter", "changed", "syntax", "materialization", "runtime_unavailable", "stopped", "failed"]);
        assert_eq!(status_for_exit(0), "completed");
        assert_eq!(status_for_exit(11), "not_started");
        assert_eq!(status_for_exit(130), "cancelled");
        assert_eq!(status_for_exit(14), "failed");
        assert!(is_port_conflict("requested FULLMAG_API_PORT=1 is not bindable and does not serve"));
        assert!(!is_port_conflict("syntax error"));
    }

    fn sample_receipt() -> Value {
        json!({
            "schema": RECEIPT_SCHEMA,
            "script": {"path": "C:/w/sp4.py", "path_key": "c:/w/sp4.py", "sha256": "ab", "bytes": 10},
            "interpreter": {"status": "resolved", "version": "3.12.2", "source": "path_probe", "isolated": false},
            "requested": {"backend": "as_authored", "device": "as_authored"},
            "resolved": {"backend": "fdm", "device": "cpu", "fallback": null},
            "ids": {"session_id": "s", "run_id": "r", "problem_ir_source_hash": "ab"},
            "results": {"dir": "C:/state/r/results", "next_to_script": false},
            "outcome": {"status": "completed", "exit_code": 0, "duration_seconds": 12.5, "finished_at": "2026-10-05T10:00:12.500Z", "error": null},
        })
    }

    #[test]
    fn receipts_are_validated_and_completed_with_consent_and_the_literal_request() {
        assert!(parse_receipt(b"not json").is_err());
        assert!(parse_receipt(br#"{"schema": "other"}"#).is_err());
        assert!(parse_receipt(&serde_json::to_vec(&json!({"schema": RECEIPT_SCHEMA})).unwrap()).is_err());
        let mut receipt = parse_receipt(&serde_json::to_vec(&sample_receipt()).unwrap()).unwrap();
        let requested = RequestedRuntime { device: Some(DeviceChoice::Auto), backend: Some(BackendChoice::Auto), ..Default::default() };
        finalize_receipt(&mut receipt, ConsentMode::Remembered, "2026-10-05T10:00:00.000Z", "ab", &requested, true);
        assert_eq!(receipt["consent"]["mode"], "remembered");
        assert_eq!(receipt["consent"]["sha256_at_consent"], "ab");
        assert_eq!(receipt["requested"]["device"], "auto", "auto stays auto");
        assert_eq!(receipt["requested"]["precision"], "as_authored");
        assert_eq!(receipt["window_opened"], true);
    }

    #[test]
    fn a_missing_receipt_is_synthesized_from_the_exit_code() {
        let none = RequestedRuntime::default();
        let killed = synthesize_receipt("C:/w/x.py", "ab", Some(130), "stopped", &none, "t");
        assert_eq!(killed["outcome"]["status"], "cancelled");
        let crashed = synthesize_receipt("C:/w/x.py", "ab", Some(1), "ended without a receipt", &none, "t");
        assert_eq!(crashed["outcome"]["status"], "failed");
        assert_eq!(crashed["outcome"]["synthesized_by"], "desktop");
        let orphan = synthesize_receipt("C:/w/x.py", "ab", None, "the launching application ended", &none, "t");
        assert_eq!(orphan["outcome"]["status"], "cancelled");
        assert!(parse_receipt(&serde_json::to_vec(&crashed).unwrap()).is_ok());
    }

    #[test]
    fn the_run_event_is_one_desktop_event_with_last_run_meta() {
        let event = run_event(Path::new("C:/w/sp4.py"), &sample_receipt(), "now");
        assert_eq!(event.event, EventKind::Run);
        assert_eq!(event.actor, Actor::Desktop);
        assert_eq!(event.kind, ItemKind::Script);
        assert_eq!(event.detail["status"], "completed");
        assert_eq!(event.detail["resolved"]["device"], "cpu");
        assert_eq!(event.detail["interpreter"]["version"], "3.12.2");
        assert!(event.detail.get("script").is_none(), "paths already live in the item");
        let last = &event.meta_patch.as_ref().unwrap()["last_run"];
        assert_eq!(last["status"], "ok");
        assert_eq!(last["device"], "cpu");
        assert_eq!(last["duration_seconds"], 12.5);
        assert_eq!(last["at"], "2026-10-05T10:00:12.500Z");
        assert_eq!(last_run_status("cancelled"), "cancelled");
        assert_eq!(last_run_status("not_started"), "failed");
    }

    #[test]
    fn progress_drives_the_state_and_the_window_endpoint() {
        assert_eq!(state_from_progress(None), "starting");
        let waiting = json!({"state": "waiting_for_solve", "api_port": 18123, "ui_ready": true});
        assert_eq!(state_from_progress(Some(&waiting)), "waiting_for_solve");
        assert_eq!(ui_endpoint(Some(&waiting)), Some(18123));
        let early = json!({"state": "materializing", "api_port": 18123, "ui_ready": false});
        assert_eq!(ui_endpoint(Some(&early)), None);
        assert_eq!(ui_endpoint(Some(&json!({"ui_ready": true, "api_port": 0}))), None);
        assert_eq!(ui_endpoint(None), None);
        let id = "11111111-2222-4333-8444-555555555555";
        assert_eq!(ui_url(18123, id), format!("http://localhost:18123/workspace?fullmag_api_instance={id}"));
    }

    #[test]
    fn concurrency_warning_appears_only_when_a_run_is_active() {
        assert!(concurrency_warning(0).is_none());
        assert!(concurrency_warning(1).unwrap().contains("1 script run is already active"));
        assert!(concurrency_warning(2).unwrap().contains("At most 2"));
        assert_eq!(MAX_CONCURRENT_RUNS, 2);
    }

    #[test]
    fn reconciliation_records_what_a_dead_host_left_and_never_touches_live_runs() {
        let base = RunDirState { has_owner: true, has_recorded: false, has_receipt: true, owner_alive: false };
        assert_eq!(plan_reconcile(&base), ReconcileAction::RecordReceipt);
        assert_eq!(plan_reconcile(&RunDirState { has_receipt: false, ..base }), ReconcileAction::Synthesize);
        assert_eq!(plan_reconcile(&RunDirState { has_recorded: true, ..base }), ReconcileAction::Skip);
        assert_eq!(plan_reconcile(&RunDirState { owner_alive: true, ..base }), ReconcileAction::Skip);
        assert_eq!(plan_reconcile(&RunDirState { has_owner: false, ..base }), ReconcileAction::Skip);
    }

    #[test]
    fn run_request_defaults_to_waiting_for_solve_and_managed_results() {
        let request: ScriptRunRequest = serde_json::from_value(json!({"ticket": "t"})).unwrap();
        assert!(request.wait_for_solve);
        assert_eq!(request.results, ResultsChoice::Managed);
        assert_eq!(request.requested, RequestedRuntime::default());
        let request: ScriptRunRequest = serde_json::from_value(json!({
            "ticket": "t", "requested": {"backend": "fem", "device": "gpu"},
            "results": "next_to_script", "confirm_overwrite": true, "wait_for_solve": false
        })).unwrap();
        assert_eq!(request.requested.backend, Some(BackendChoice::Fem));
        assert_eq!(request.requested.device, Some(DeviceChoice::Gpu));
        assert_eq!(request.results, ResultsChoice::NextToScript);
        assert!(serde_json::from_value::<ScriptRunRequest>(json!({"ticket": "t", "requested": {"device": "tpu"}})).is_err());
        assert!(serde_json::from_value::<ScriptRunRequest>(json!({"ticket": "t", "path": "C:/evil.py"})).is_ok(), "an unknown path field is ignored, never used");
    }
}
