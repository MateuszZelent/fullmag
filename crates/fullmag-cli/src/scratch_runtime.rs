use reqwest::blocking::Client;
use reqwest::header::{HeaderMap, HeaderName, HeaderValue};
use serde_json::Value;
use std::io::Read;
use std::panic::{catch_unwind, AssertUnwindSafe};
use std::path::PathBuf;
use std::process::{Child, Command, Stdio};
use std::sync::atomic::{AtomicUsize, Ordering};
use std::sync::{Arc, Condvar, Mutex, MutexGuard};
use std::thread::{self, JoinHandle};
use std::time::{Duration, Instant};

const POLL_INTERVAL: Duration = Duration::from_millis(250);
const COMMAND_SETTLE_GRACE: Duration = Duration::from_secs(2);
const API_INSTANCE_HEADER: &str = "x-fullmag-api-instance";
const MODEL_SYNC_TIMEOUT: Duration = Duration::from_secs(35);
const MAX_BOOTSTRAP_ATTEMPTS: u8 = 3;
const MAX_SYNC_ERROR_BODY_BYTES: u64 = 4 * 1024;
const MAX_BOOTSTRAP_ERROR_BYTES: usize = 4 * 1024;

#[derive(Clone, PartialEq, Eq)]
struct BootstrapOwner {
    session_id: String,
    backend: String,
    scene_revision: Option<u64>,
    command_id: String,
}

#[derive(Default)]
struct BootstrapRetryState {
    owner: Option<BootstrapOwner>,
    failures: u8,
    terminal_error: Option<String>,
}

impl BootstrapRetryState {
    fn select_owner(&mut self, owner: BootstrapOwner) {
        if self.owner.as_ref() != Some(&owner) {
            *self = Self {
                owner: Some(owner),
                ..Self::default()
            };
        }
    }

    fn record_failure(&mut self, error: &anyhow::Error, retryable: bool) {
        self.failures = self.failures.saturating_add(1);
        if !retryable || self.failures >= MAX_BOOTSTRAP_ATTEMPTS {
            let mut reason = format!(
                "scratch runtime bootstrap failed after {} attempt(s): {error:#}",
                self.failures,
            );
            if reason.len() > MAX_BOOTSTRAP_ERROR_BYTES {
                let mut end = MAX_BOOTSTRAP_ERROR_BYTES;
                while !reason.is_char_boundary(end) {
                    end -= 1;
                }
                reason.truncate(end);
            }
            self.terminal_error = Some(reason);
        }
    }
}

fn retryable_bootstrap_error(error: &anyhow::Error) -> bool {
    let Some(error) = error.downcast_ref::<reqwest::Error>() else {
        return false;
    };
    match error.status() {
        Some(status) => status.is_server_error() || matches!(status.as_u16(), 408 | 429),
        None => error.is_timeout() || error.is_connect(),
    }
}

enum CurrentSession {
    NoActive,
    Active {
        session_id: String,
        backend: String,
        scene_revision: Option<u64>,
    },
    Unavailable,
}

pub(crate) fn spawn(
    api_port: u16,
    executable: PathBuf,
    ignored_session: Option<String>,
    expected_api_instance_id: String,
) -> ScratchRuntimeHandle {
    let control = PauseControl::new();
    let worker = if canonical_non_nil_uuid(&expected_api_instance_id) {
        Some(
            spawn_supervised_thread(
                Arc::clone(&control),
                "fullmag-scratch-runtime-supervisor",
                move |worker_control| {
                    run(
                        worker_control,
                        api_port,
                        executable,
                        ignored_session,
                        expected_api_instance_id,
                    )
                },
            )
            .expect("scratch runtime supervisor thread should spawn"),
        )
    } else {
        eprintln!("[fullmag] scratch runtime supervisor disabled: invalid API instance pin");
        control.publish_stopped();
        None
    };
    ScratchRuntimeHandle { control, worker }
}

pub(crate) struct ScratchRuntimeHandle {
    control: Arc<PauseControl>,
    worker: Option<JoinHandle<()>>,
}

impl ScratchRuntimeHandle {
    pub(crate) fn pause_if_idle(
        &self,
        timeout: Duration,
    ) -> anyhow::Result<ScratchRuntimePauseGuard> {
        self.control.begin_pause(timeout)?.wait_for_ack()
    }

    pub(crate) fn shutdown_paused(
        &mut self,
        mut guard: ScratchRuntimePauseGuard,
    ) -> anyhow::Result<()> {
        anyhow::ensure!(
            Arc::ptr_eq(&self.control, &guard.control),
            "pause guard belongs to a different scratch runtime"
        );
        anyhow::ensure!(
            self.worker
                .as_ref()
                .is_some_and(|worker| worker.thread().id() != thread::current().id()),
            "scratch runtime worker is unavailable or cannot join itself"
        );

        {
            let mut state = self.control.lock_state();
            anyhow::ensure!(
                matches!(state.pause, PausePhase::Paused { token } if token == guard.token),
                "pause guard no longer owns the scratch runtime pause"
            );
            state.stopping = true;
            state.pause = PausePhase::None;
            guard.armed = false;
            self.control.changed.notify_all();
        }

        let worker = self
            .worker
            .take()
            .expect("worker presence was checked before shutdown");
        worker
            .join()
            .map_err(|_| anyhow::anyhow!("scratch runtime supervisor panicked during shutdown"))?;
        Ok(())
    }
}

impl Drop for ScratchRuntimeHandle {
    fn drop(&mut self) {
        self.control.request_stop();
        let Some(worker) = self.worker.take() else {
            return;
        };
        if worker.thread().id() != thread::current().id() {
            let _ = worker.join();
        }
    }
}

#[derive(Clone, Copy)]
enum PauseRefusal {
    Busy,
    TimedOut,
}

#[derive(Clone, Copy)]
enum PausePhase {
    None,
    Requested { token: u64, deadline: Instant },
    Paused { token: u64 },
    Refused { token: u64, reason: PauseRefusal },
}

struct PauseState {
    next_token: u64,
    pause: PausePhase,
    stopping: bool,
    stopped: bool,
}

struct PauseControl {
    state: Mutex<PauseState>,
    changed: Condvar,
}

impl PauseControl {
    fn new() -> Arc<Self> {
        Arc::new(Self {
            state: Mutex::new(PauseState {
                next_token: 1,
                pause: PausePhase::None,
                stopping: false,
                stopped: false,
            }),
            changed: Condvar::new(),
        })
    }

    fn lock_state(&self) -> MutexGuard<'_, PauseState> {
        self.state
            .lock()
            .unwrap_or_else(std::sync::PoisonError::into_inner)
    }

    fn begin_pause(self: &Arc<Self>, timeout: Duration) -> anyhow::Result<PauseRequestTicket> {
        let now = Instant::now();
        let deadline = now
            .checked_add(timeout)
            .ok_or_else(|| anyhow::anyhow!("scratch runtime pause timeout is too large"))?;
        let token = {
            let mut state = self.lock_state();
            anyhow::ensure!(
                !state.stopping && !state.stopped,
                "scratch runtime supervisor is stopped"
            );
            anyhow::ensure!(
                matches!(state.pause, PausePhase::None),
                "scratch runtime already has a pause request or guard"
            );
            let token = state.next_token;
            state.next_token = state
                .next_token
                .checked_add(1)
                .ok_or_else(|| anyhow::anyhow!("scratch runtime pause token space exhausted"))?;
            state.pause = PausePhase::Requested { token, deadline };
            token
        };
        self.changed.notify_all();
        Ok(PauseRequestTicket {
            control: Arc::clone(self),
            token,
            deadline,
            armed: true,
        })
    }

    fn wait_before_iteration(&self, idle: bool) -> bool {
        let mut state = self.lock_state();
        loop {
            if state.stopping || state.stopped {
                return false;
            }
            match state.pause {
                PausePhase::Requested { token, deadline } => {
                    let reason = if Instant::now() >= deadline {
                        Some(PauseRefusal::TimedOut)
                    } else if !idle {
                        Some(PauseRefusal::Busy)
                    } else {
                        state.pause = PausePhase::Paused { token };
                        self.changed.notify_all();
                        continue;
                    };
                    state.pause = PausePhase::Refused {
                        token,
                        reason: reason.expect("non-idle or expired request has a refusal reason"),
                    };
                    self.changed.notify_all();
                    return true;
                }
                PausePhase::Paused { token } => {
                    state = self
                        .changed
                        .wait(state)
                        .unwrap_or_else(std::sync::PoisonError::into_inner);
                    if matches!(state.pause, PausePhase::Paused { token: active } if active == token)
                    {
                        continue;
                    }
                }
                PausePhase::None | PausePhase::Refused { .. } => return true,
            }
        }
    }

    fn wait_poll_interval(&self, interval: Duration) {
        let deadline = Instant::now().checked_add(interval);
        let Some(deadline) = deadline else {
            return;
        };
        let mut state = self.lock_state();
        while !state.stopping && !state.stopped && matches!(state.pause, PausePhase::None) {
            let remaining = deadline.saturating_duration_since(Instant::now());
            if remaining.is_zero() {
                return;
            }
            let (next_state, result) = self
                .changed
                .wait_timeout(state, remaining)
                .unwrap_or_else(std::sync::PoisonError::into_inner);
            state = next_state;
            if result.timed_out() {
                return;
            }
        }
    }

    fn request_stop(&self) {
        let mut state = self.lock_state();
        state.stopping = true;
        state.pause = PausePhase::None;
        self.changed.notify_all();
    }

    fn is_stopping(&self) -> bool {
        let state = self.lock_state();
        state.stopping || state.stopped
    }

    fn publish_stopped(&self) {
        let mut state = self.lock_state();
        state.stopping = true;
        state.stopped = true;
        if !matches!(state.pause, PausePhase::Paused { .. }) {
            state.pause = PausePhase::None;
        }
        self.changed.notify_all();
    }

    fn cancel_pause(&self, token: u64) {
        let mut state = self.lock_state();
        let owns_phase = matches!(
            state.pause,
            PausePhase::Requested { token: active, .. }
                | PausePhase::Paused { token: active }
                | PausePhase::Refused { token: active, .. }
                if active == token
        );
        if owns_phase {
            state.pause = PausePhase::None;
            self.changed.notify_all();
        }
    }
}

struct PauseRequestTicket {
    control: Arc<PauseControl>,
    token: u64,
    deadline: Instant,
    armed: bool,
}

impl PauseRequestTicket {
    fn wait_for_ack(mut self) -> anyhow::Result<ScratchRuntimePauseGuard> {
        loop {
            let mut state = self.control.lock_state();
            if state.stopping || state.stopped {
                anyhow::bail!("scratch runtime supervisor stopped before acknowledging pause");
            }
            if matches!(state.pause, PausePhase::Paused { token } if token == self.token) {
                self.armed = false;
                return Ok(ScratchRuntimePauseGuard {
                    control: Arc::clone(&self.control),
                    token: self.token,
                    armed: true,
                });
            }
            match state.pause {
                PausePhase::Refused { token, reason } if token == self.token => {
                    state.pause = PausePhase::None;
                    self.control.changed.notify_all();
                    self.armed = false;
                    match reason {
                        PauseRefusal::Busy => anyhow::bail!(
                            "scratch runtime has active or pending work and cannot pause"
                        ),
                        PauseRefusal::TimedOut => {
                            anyhow::bail!("scratch runtime pause request timed out")
                        }
                    }
                }
                PausePhase::Requested { token, .. } if token == self.token => {
                    let remaining = self.deadline.saturating_duration_since(Instant::now());
                    if remaining.is_zero() {
                        state.pause = PausePhase::None;
                        self.control.changed.notify_all();
                        self.armed = false;
                        anyhow::bail!("scratch runtime pause request timed out");
                    }
                    let (state, _) = self
                        .control
                        .changed
                        .wait_timeout(state, remaining)
                        .unwrap_or_else(std::sync::PoisonError::into_inner);
                    drop(state);
                }
                PausePhase::None
                | PausePhase::Requested { .. }
                | PausePhase::Paused { .. }
                | PausePhase::Refused { .. } => {
                    anyhow::bail!("scratch runtime pause request was revoked or replaced")
                }
            }
        }
    }
}

impl Drop for PauseRequestTicket {
    fn drop(&mut self) {
        if self.armed {
            self.control.cancel_pause(self.token);
        }
    }
}

pub(crate) struct ScratchRuntimePauseGuard {
    control: Arc<PauseControl>,
    token: u64,
    armed: bool,
}

impl Drop for ScratchRuntimePauseGuard {
    fn drop(&mut self) {
        if self.armed {
            self.control.cancel_pause(self.token);
            self.armed = false;
        }
    }
}

fn spawn_supervised_thread<F>(
    control: Arc<PauseControl>,
    thread_name: &str,
    worker: F,
) -> std::io::Result<JoinHandle<()>>
where
    F: FnOnce(Arc<PauseControl>) + Send + 'static,
{
    let thread_control = Arc::clone(&control);
    thread::Builder::new()
        .name(thread_name.to_string())
        .spawn(move || {
            let terminal_control = Arc::clone(&thread_control);
            let _ = catch_unwind(AssertUnwindSafe(|| worker(thread_control)));
            terminal_control.publish_stopped();
        })
}

fn canonical_non_nil_uuid(value: &str) -> bool {
    uuid::Uuid::parse_str(value).is_ok_and(|parsed| !parsed.is_nil() && parsed.to_string() == value)
}

fn pinned_client(expected_api_instance_id: &str) -> anyhow::Result<Client> {
    anyhow::ensure!(
        canonical_non_nil_uuid(expected_api_instance_id),
        "invalid API instance pin"
    );
    let mut headers = HeaderMap::new();
    headers.insert(
        HeaderName::from_static(API_INSTANCE_HEADER),
        HeaderValue::from_bytes(expected_api_instance_id.as_bytes())?,
    );
    Ok(Client::builder()
        .no_proxy()
        .default_headers(headers)
        .timeout(Duration::from_secs(1))
        .build()?)
}

fn run(
    control: Arc<PauseControl>,
    api_port: u16,
    executable: PathBuf,
    ignored_session: Option<String>,
    expected_api_instance_id: String,
) {
    let client = match pinned_client(&expected_api_instance_id) {
        Ok(client) => client,
        Err(error) => {
            eprintln!("[fullmag] scratch runtime supervisor disabled: {error:#}");
            return;
        }
    };
    let api_base = format!("http://localhost:{api_port}");
    let mut attached_session: Option<String> = None;
    let mut attached_backend: Option<String> = None;
    let mut attached_scene_revision: Option<u64> = None;
    let mut handled_command_id: Option<String> = None;
    let mut settling_command: Option<(String, bool, Instant)> = None;
    let mut pending_failure: Option<(String, String)> = None;
    let mut child: Option<Child> = None;
    let mut bootstrap_retry = BootstrapRetryState::default();

    loop {
        let idle = child.is_none()
            && handled_command_id.is_none()
            && settling_command.is_none()
            && pending_failure.is_none();
        if !control.wait_before_iteration(idle) {
            break;
        }

        if let Some(active_child) = child.as_mut() {
            match active_child.try_wait() {
                Ok(Some(status)) => {
                    eprintln!("[fullmag] scratch attached runtime exited with status {status}");
                    child = None;
                    if let Some(command_id) = handled_command_id.take() {
                        settling_command = Some((
                            command_id,
                            status.success(),
                            Instant::now() + COMMAND_SETTLE_GRACE,
                        ));
                    }
                }
                Ok(None) => {}
                Err(error) => {
                    eprintln!("[fullmag] scratch attached runtime status check failed: {error}");
                    child = None;
                    if let Some(command_id) = handled_command_id.take() {
                        settling_command =
                            Some((command_id, false, Instant::now() + COMMAND_SETTLE_GRACE));
                    }
                }
            }
        }

        let session = current_session(&client, &api_base);
        match session {
            CurrentSession::NoActive => {
                terminate_child(&mut child);
                attached_session = None;
                attached_backend = None;
                attached_scene_revision = None;
                handled_command_id = None;
                settling_command = None;
                pending_failure = None;
                bootstrap_retry = BootstrapRetryState::default();
            }
            CurrentSession::Unavailable => {}
            CurrentSession::Active {
                session_id,
                backend: _,
                scene_revision: _,
            } if ignored_session.as_deref() == Some(session_id.as_str()) => {
                terminate_child(&mut child);
                attached_session = None;
                attached_backend = None;
                attached_scene_revision = None;
                handled_command_id = None;
                settling_command = None;
                pending_failure = None;
                bootstrap_retry = BootstrapRetryState::default();
            }
            CurrentSession::Active {
                session_id,
                backend,
                scene_revision,
            } => {
                let session_changed = attached_session
                    .as_deref()
                    .is_some_and(|active| active != session_id);
                let backend_changed = matches!(backend.as_str(), "fdm" | "fem")
                    && attached_backend
                        .as_deref()
                        .is_some_and(|active| active != backend);
                let scene_changed = attached_scene_revision
                    .zip(scene_revision)
                    .is_some_and(|(active, current)| active != current);
                if session_changed || backend_changed || scene_changed {
                    terminate_child(&mut child);
                    if session_changed {
                        handled_command_id = None;
                        settling_command = None;
                        pending_failure = None;
                    } else {
                        if let Some(command_id) = handled_command_id.take() {
                            pending_failure = Some((
                                command_id,
                                "scratch runtime ownership changed while a command was active"
                                    .to_string(),
                            ));
                        }
                        if let Some((command_id, _, _)) = settling_command.take() {
                            pending_failure = Some((
                                command_id,
                                "scratch runtime ownership changed before command acknowledgement"
                                    .to_string(),
                            ));
                        }
                    }
                    attached_session = None;
                    attached_backend = None;
                    attached_scene_revision = None;
                }

                if let Some((command_id, exited_cleanly, deadline)) = settling_command.take() {
                    let terminal = command_is_terminal(&client, &api_base, &command_id);
                    if terminal != Some(true) && Instant::now() < deadline {
                        settling_command = Some((command_id, exited_cleanly, deadline));
                        control.wait_poll_interval(POLL_INTERVAL);
                        continue;
                    }
                    if terminal != Some(true) {
                        let reason = if exited_cleanly {
                            "attached scratch runtime exited before command acknowledgement"
                                .to_string()
                        } else {
                            "attached scratch runtime exited with a non-zero status before command acknowledgement"
                                .to_string()
                        };
                        pending_failure = Some((command_id, reason));
                    }
                }

                if let Some((command_id, error)) = pending_failure.as_ref() {
                    if report_command_failure(&client, &api_base, command_id, error) {
                        pending_failure = None;
                    } else {
                        control.wait_poll_interval(POLL_INTERVAL);
                        continue;
                    }
                }

                if child.is_none() && matches!(backend.as_str(), "fdm" | "fem") {
                    if let Some(command_id) = pending_compute_command(&client, &api_base) {
                        let owner = BootstrapOwner {
                            session_id: session_id.clone(),
                            backend: backend.clone(),
                            scene_revision,
                            command_id: command_id.clone(),
                        };
                        bootstrap_retry.select_owner(owner.clone());
                        if let Some(error) = bootstrap_retry.terminal_error.as_deref() {
                            if bootstrap_owner_is_current(&client, &api_base, &owner) {
                                if report_command_failure(&client, &api_base, &command_id, error) {
                                    bootstrap_retry = BootstrapRetryState::default();
                                }
                            }
                            control.wait_poll_interval(POLL_INTERVAL);
                            continue;
                        }
                        if current_session_matches(
                            &client,
                            &api_base,
                            &session_id,
                            &backend,
                            scene_revision,
                        ) && pending_compute_command(&client, &api_base).as_deref()
                            == Some(command_id.as_str())
                        {
                            match render_current_scene(&client, &api_base) {
                                Ok(script_path) => {
                                    if current_session_matches(
                                        &client,
                                        &api_base,
                                        &session_id,
                                        &backend,
                                        scene_revision,
                                    ) && pending_compute_command(&client, &api_base).as_deref()
                                        == Some(command_id.as_str())
                                    {
                                        match spawn_attached_runtime(
                                            &executable,
                                            api_port,
                                            &session_id,
                                            &backend,
                                            &script_path,
                                        ) {
                                            Ok(next_child) => {
                                                eprintln!(
                                                    "[fullmag] attached scratch runtime started for {backend} session {session_id} command {command_id}"
                                                );
                                                attached_session = Some(session_id);
                                                attached_backend = Some(backend);
                                                attached_scene_revision = scene_revision;
                                                handled_command_id = Some(command_id);
                                                child = Some(next_child);
                                                bootstrap_retry = BootstrapRetryState::default();
                                            }
                                            Err(error) => {
                                                eprintln!("[fullmag] failed to start attached scratch runtime: {error:#}");
                                                bootstrap_retry.record_failure(&error, false);
                                            }
                                        }
                                    } else {
                                        eprintln!(
                                            "[fullmag] scratch session changed during model sync; refusing to start stale runtime"
                                        );
                                    }
                                }
                                Err(error) => {
                                    eprintln!(
                                        "[fullmag] scratch runtime bootstrap sync failed: {error:#}"
                                    );
                                    bootstrap_retry
                                        .record_failure(&error, retryable_bootstrap_error(&error));
                                }
                            }
                        }
                    }
                }
            }
        }

        control.wait_poll_interval(POLL_INTERVAL);
    }

    terminate_child(&mut child);
}

fn current_session(client: &Client, api_base: &str) -> CurrentSession {
    let status_response = match client
        .get(format!("{api_base}/v2/sessions/current/status"))
        .send()
    {
        Ok(response) => response,
        Err(_) => return CurrentSession::Unavailable,
    };
    if status_response.status() == reqwest::StatusCode::NOT_FOUND {
        return CurrentSession::NoActive;
    }
    let status = match status_response
        .error_for_status()
        .and_then(|response| response.json::<Value>())
    {
        Ok(status) => status,
        Err(_) => return CurrentSession::Unavailable,
    };
    let Some(session_id) = status
        .get("session")
        .and_then(|session| session.get("session_id"))
        .and_then(Value::as_str)
    else {
        return CurrentSession::NoActive;
    };
    let scene_response = match client
        .get(format!("{api_base}/v2/sessions/current/model/scene"))
        .send()
    {
        Ok(response) => response,
        Err(_) => {
            return CurrentSession::Active {
                session_id: session_id.to_string(),
                backend: "unknown".to_string(),
                scene_revision: None,
            }
        }
    };
    let (backend, scene_revision) = match scene_response
        .error_for_status()
        .and_then(|response| response.json::<Value>())
    {
        Ok(scene) => {
            let backend = scene
                .get("study")
                .and_then(|study| study.get("requested_backend"))
                .and_then(Value::as_str)
                .and_then(normalize_backend)
                .or_else(|| {
                    scene
                        .get("study")
                        .and_then(|study| study.get("backend"))
                        .and_then(Value::as_str)
                        .and_then(normalize_backend)
                })
                .unwrap_or_else(|| "unknown".to_string());
            let scene_revision = scene
                .get("revision")
                .or_else(|| scene.get("scene_revision"))
                .and_then(Value::as_u64);
            (backend, scene_revision)
        }
        Err(_) => ("unknown".to_string(), None),
    };
    CurrentSession::Active {
        session_id: session_id.to_string(),
        backend,
        scene_revision,
    }
}

fn current_session_matches(
    client: &Client,
    api_base: &str,
    expected_session_id: &str,
    expected_backend: &str,
    expected_scene_revision: Option<u64>,
) -> bool {
    matches!(
        current_session(client, api_base),
        CurrentSession::Active {
            session_id,
            backend,
            scene_revision,
        } if session_id == expected_session_id
            && backend == expected_backend
            && scene_revision == expected_scene_revision
    )
}

fn report_command_failure(client: &Client, api_base: &str, command_id: &str, error: &str) -> bool {
    client
        .post(format!(
            "{api_base}/v2/sessions/current/simulation/commands/{command_id}/failure"
        ))
        .json(&serde_json::json!({"error": error}))
        .send()
        .and_then(|response| response.error_for_status())
        .is_ok()
}

fn command_is_terminal(client: &Client, api_base: &str, command_id: &str) -> Option<bool> {
    let response = client
        .get(format!(
            "{api_base}/v2/sessions/current/simulation/commands/{command_id}"
        ))
        .send()
        .ok()?;
    if response.status() == reqwest::StatusCode::NOT_FOUND {
        return Some(true);
    }
    let body = response.error_for_status().ok()?.json::<Value>().ok()?;
    Some(matches!(
        body.get("status").and_then(Value::as_str),
        Some("completed" | "failed" | "rejected")
    ))
}

fn normalize_backend(value: &str) -> Option<String> {
    match value.trim().to_ascii_lowercase().as_str() {
        "fdm" | "cpu-fdm" | "fdm_cpu_reference" => Some("fdm".to_string()),
        "fem" | "cpu-fem" | "fem_cpu" => Some("fem".to_string()),
        _ => None,
    }
}

#[cfg(test)]
mod bootstrap_tests {
    use super::*;

    fn owner() -> BootstrapOwner {
        BootstrapOwner {
            session_id: "session-A".to_string(),
            backend: "fdm".to_string(),
            scene_revision: Some(7),
            command_id: "command-A".to_string(),
        }
    }

    #[test]
    fn transient_budget_is_retained_across_polls_and_terminal_ack_retries() {
        let mut retry = BootstrapRetryState::default();
        for attempt in 1..=MAX_BOOTSTRAP_ATTEMPTS {
            retry.select_owner(owner());
            retry.record_failure(&anyhow::anyhow!("timeout"), true);
            assert_eq!(retry.failures, attempt);
            assert_eq!(
                retry.terminal_error.is_some(),
                attempt == MAX_BOOTSTRAP_ATTEMPTS
            );
        }
        let reason = retry.terminal_error.clone();
        retry.select_owner(owner());
        assert_eq!(retry.failures, MAX_BOOTSTRAP_ATTEMPTS);
        assert_eq!(retry.terminal_error, reason);
    }

    #[test]
    fn deterministic_failure_is_terminal_and_reason_is_utf8_bounded() {
        let mut retry = BootstrapRetryState::default();
        retry.select_owner(owner());
        retry.record_failure(&anyhow::anyhow!("{}", "ł".repeat(5000)), false);
        assert_eq!(retry.failures, 1);
        assert!(retry.terminal_error.as_ref().unwrap().len() <= MAX_BOOTSTRAP_ERROR_BYTES);
    }

    #[test]
    fn each_ownership_dimension_starts_a_new_budget() {
        let mut variants = Vec::new();
        let mut session = owner();
        session.session_id = "session-B".to_string();
        variants.push(session);
        let mut backend = owner();
        backend.backend = "fem".to_string();
        variants.push(backend);
        let mut scene = owner();
        scene.scene_revision = Some(8);
        variants.push(scene);
        let mut command = owner();
        command.command_id = "command-B".to_string();
        variants.push(command);
        for changed in variants {
            let mut retry = BootstrapRetryState::default();
            retry.select_owner(owner());
            retry.record_failure(&anyhow::anyhow!("failed"), false);
            retry.select_owner(changed);
            assert_eq!(retry.failures, 0);
            assert!(retry.terminal_error.is_none());
        }
    }
}

fn pending_compute_command(client: &Client, api_base: &str) -> Option<String> {
    let Ok(response) = client
        .get(format!(
            "{api_base}/v2/sessions/current/simulation/commands"
        ))
        .send()
    else {
        return None;
    };
    let Ok(response) = response.error_for_status() else {
        return None;
    };
    let Ok(body) = response.json::<Value>() else {
        return None;
    };
    body.get("commands")
        .and_then(Value::as_array)
        .and_then(|commands| {
            commands.iter().find_map(|command| {
                let status = command.get("status").and_then(Value::as_str);
                let kind = command.get("kind").and_then(Value::as_str);
                if matches!(
                    status,
                    Some("queued" | "pending" | "accepted" | "dispatched")
                ) && matches!(
                    kind,
                    Some("remesh" | "fdm_grid_refresh" | "relax" | "run" | "solve")
                ) {
                    command
                        .get("command_id")
                        .and_then(Value::as_str)
                        .map(str::to_string)
                } else {
                    None
                }
            })
        })
}

fn render_current_scene(client: &Client, api_base: &str) -> anyhow::Result<PathBuf> {
    let response = client
        .post(format!("{api_base}/v2/sessions/current/model/syncs"))
        .timeout(MODEL_SYNC_TIMEOUT)
        .json(&serde_json::json!({}))
        .send()?;
    if let Err(error) = response.error_for_status_ref() {
        let status = response.status();
        let mut bytes = Vec::new();
        let _ = response
            .take(MAX_SYNC_ERROR_BODY_BYTES)
            .read_to_end(&mut bytes);
        let detail = String::from_utf8_lossy(&bytes);
        return Err(anyhow::Error::new(error)
            .context(format!("model sync returned {status}: {}", detail.trim(),)));
    }
    let body = response.json::<Value>()?;
    let path = body
        .get("script_path")
        .and_then(Value::as_str)
        .filter(|path| !path.trim().is_empty())
        .ok_or_else(|| anyhow::anyhow!("model sync did not return script_path"))?;
    Ok(PathBuf::from(path))
}

fn bootstrap_owner_is_current(client: &Client, api_base: &str, owner: &BootstrapOwner) -> bool {
    current_session_matches(
        client,
        api_base,
        &owner.session_id,
        &owner.backend,
        owner.scene_revision,
    ) && pending_compute_command(client, api_base).as_deref() == Some(owner.command_id.as_str())
        && current_session_matches(
            client,
            api_base,
            &owner.session_id,
            &owner.backend,
            owner.scene_revision,
        )
}

fn spawn_attached_runtime(
    executable: &PathBuf,
    api_port: u16,
    session_id: &str,
    backend: &str,
    script_path: &PathBuf,
) -> anyhow::Result<Child> {
    let mut command = Command::new(executable);
    command
        .arg(script_path)
        .arg("--interactive")
        .arg("--backend")
        .arg(backend)
        .arg("--mode")
        .arg("strict")
        .arg("--precision")
        .arg("double")
        .env("FULLMAG_API_PORT", api_port.to_string())
        .env("FULLMAG_ATTACHED_SESSION_ID", session_id)
        .env("FULLMAG_ATTACHED_WAIT_FOR_SOLVE", "1")
        .env("FULLMAG_SKIP_CONTROL_ROOM", "1")
        .stdin(Stdio::null())
        .stdout(Stdio::inherit())
        .stderr(Stdio::inherit());
    Ok(command.spawn()?)
}

fn terminate_child(child: &mut Option<Child>) {
    let Some(mut child_process) = child.take() else {
        return;
    };
    let _ = child_process.kill();
    let _ = child_process.wait();
}

fn spawn_pause_diagnostic_handle<F>(
    control: Arc<PauseControl>,
    worker: F,
) -> anyhow::Result<ScratchRuntimeHandle>
where
    F: FnOnce(Arc<PauseControl>) + Send + 'static,
{
    let worker = spawn_supervised_thread(
        Arc::clone(&control),
        "fullmag-scratch-pause-diagnostic",
        worker,
    )?;
    Ok(ScratchRuntimeHandle {
        control,
        worker: Some(worker),
    })
}

fn wait_for_diagnostic_count(counter: &AtomicUsize, minimum: usize) -> anyhow::Result<()> {
    let deadline = Instant::now() + Duration::from_secs(2);
    while counter.load(Ordering::Acquire) < minimum {
        anyhow::ensure!(
            Instant::now() < deadline,
            "scratch pause diagnostic worker did not make progress"
        );
        thread::sleep(Duration::from_millis(1));
    }
    Ok(())
}

fn wait_for_diagnostic_pause(control: &PauseControl, token: u64) -> anyhow::Result<()> {
    let deadline = Instant::now() + Duration::from_secs(2);
    loop {
        let state = control.lock_state();
        if matches!(state.pause, PausePhase::Paused { token: active } if active == token) {
            return Ok(());
        }
        anyhow::ensure!(
            !state.stopping && !state.stopped,
            "diagnostic worker stopped before acknowledging pause"
        );
        drop(state);
        anyhow::ensure!(
            Instant::now() < deadline,
            "diagnostic worker did not acknowledge pause"
        );
        thread::sleep(Duration::from_millis(1));
    }
}

fn wait_for_diagnostic_release(
    control: &PauseControl,
    receiver: std::sync::mpsc::Receiver<()>,
) -> bool {
    loop {
        if control.is_stopping() {
            return false;
        }
        match receiver.recv_timeout(Duration::from_millis(5)) {
            Ok(()) => return true,
            Err(std::sync::mpsc::RecvTimeoutError::Timeout) => {}
            Err(std::sync::mpsc::RecvTimeoutError::Disconnected) => return false,
        }
    }
}

pub(crate) fn verify_idle_pause_control() -> anyhow::Result<Value> {
    use std::sync::mpsc::sync_channel;

    // Hold the diagnostic worker before its polling boundary so the busy
    // refusal is deterministic and exercises the same control state as run().
    let busy_control = PauseControl::new();
    let (busy_ready_tx, busy_ready_rx) = sync_channel(1);
    let (busy_release_tx, busy_release_rx) = sync_channel(1);
    let (busy_boundary_tx, busy_boundary_rx) = sync_channel(1);
    let busy_progress = Arc::new(AtomicUsize::new(0));
    let busy_worker_progress = Arc::clone(&busy_progress);
    let busy_handle = spawn_pause_diagnostic_handle(Arc::clone(&busy_control), move |control| {
        let _ = busy_ready_tx.send(());
        if wait_for_diagnostic_release(&control, busy_release_rx) {
            let continued = control.wait_before_iteration(false);
            let _ = busy_boundary_tx.send(continued);
            while continued && control.wait_before_iteration(true) {
                busy_worker_progress.fetch_add(1, Ordering::Release);
                thread::yield_now();
            }
        }
    })?;
    busy_ready_rx.recv_timeout(Duration::from_secs(1))?;
    let busy_request = busy_control.begin_pause(Duration::from_secs(1))?;
    busy_release_tx.send(())?;
    let busy_error = busy_request
        .wait_for_ack()
        .err()
        .ok_or_else(|| anyhow::anyhow!("busy scratch runtime unexpectedly paused"))?;
    anyhow::ensure!(
        busy_error.to_string().contains("active or pending work"),
        "busy scratch runtime was refused for an unexpected reason: {busy_error:#}"
    );
    anyhow::ensure!(
        busy_boundary_rx.recv_timeout(Duration::from_secs(1))?,
        "busy diagnostic worker did not continue after refusing pause"
    );
    wait_for_diagnostic_count(&busy_progress, 1)?;
    drop(busy_handle);

    // Expire a request while the worker is held away from its boundary, then
    // prove that processing that boundary later cannot acknowledge the old ID.
    let timeout_control = PauseControl::new();
    let (timeout_ready_tx, timeout_ready_rx) = sync_channel(1);
    let (timeout_release_tx, timeout_release_rx) = sync_channel(1);
    let (timeout_boundary_tx, timeout_boundary_rx) = sync_channel(1);
    let timeout_handle =
        spawn_pause_diagnostic_handle(Arc::clone(&timeout_control), move |control| {
            let _ = timeout_ready_tx.send(());
            if wait_for_diagnostic_release(&control, timeout_release_rx) {
                let continued = control.wait_before_iteration(true);
                let _ = timeout_boundary_tx.send(continued);
            }
        })?;
    timeout_ready_rx.recv_timeout(Duration::from_secs(1))?;
    let late_request = timeout_control.begin_pause(Duration::from_millis(10))?;
    let timeout_error = late_request
        .wait_for_ack()
        .err()
        .ok_or_else(|| anyhow::anyhow!("held scratch runtime unexpectedly acknowledged pause"))?;
    anyhow::ensure!(
        timeout_error.to_string().contains("timed out"),
        "held scratch runtime failed for an unexpected reason: {timeout_error:#}"
    );
    timeout_release_tx.send(())?;
    anyhow::ensure!(
        timeout_boundary_rx.recv_timeout(Duration::from_secs(1))?,
        "late diagnostic boundary did not continue"
    );
    anyhow::ensure!(
        matches!(timeout_control.lock_state().pause, PausePhase::None),
        "timed-out request remained active after the late boundary"
    );
    drop(timeout_handle);

    // Simulate a terminal notification racing with a waiter after the worker
    // has acknowledged and retained the pause token. The waiter must reject it.
    let terminal_control = PauseControl::new();
    let (terminal_ready_tx, terminal_ready_rx) = sync_channel(1);
    let terminal_handle =
        spawn_pause_diagnostic_handle(Arc::clone(&terminal_control), move |control| {
            let _ = terminal_ready_tx.send(());
            while control.wait_before_iteration(true) {
                thread::yield_now();
            }
        })?;
    terminal_ready_rx.recv_timeout(Duration::from_secs(1))?;
    let terminal_request = terminal_control.begin_pause(Duration::from_secs(1))?;
    wait_for_diagnostic_pause(&terminal_control, terminal_request.token)?;
    terminal_control.publish_stopped();
    anyhow::ensure!(
        matches!(
            terminal_control.lock_state().pause,
            PausePhase::Paused { token } if token == terminal_request.token
        ),
        "terminal diagnostic did not retain the acknowledged pause token"
    );
    let terminal_error = terminal_request
        .wait_for_ack()
        .err()
        .ok_or_else(|| anyhow::anyhow!("stopped scratch worker returned a pause guard"))?;
    anyhow::ensure!(
        terminal_error
            .to_string()
            .contains("stopped before acknowledging pause"),
        "terminal scratch worker failed for an unexpected reason: {terminal_error:#}"
    );
    drop(terminal_handle);

    // A returned guard holds a real worker at its polling boundary. Dropping it
    // releases that worker; consuming it with shutdown joins the same worker.
    let resume_control = PauseControl::new();
    let resume_progress = Arc::new(AtomicUsize::new(0));
    let resume_worker_progress = Arc::clone(&resume_progress);
    let resume_handle =
        spawn_pause_diagnostic_handle(Arc::clone(&resume_control), move |control| {
            while control.wait_before_iteration(true) {
                resume_worker_progress.fetch_add(1, Ordering::Release);
                thread::yield_now();
            }
        })?;
    wait_for_diagnostic_count(&resume_progress, 2)?;
    let resume_guard = resume_handle.pause_if_idle(Duration::from_secs(1))?;
    let paused_count = resume_progress.load(Ordering::Acquire);
    thread::sleep(Duration::from_millis(10));
    anyhow::ensure!(
        resume_progress.load(Ordering::Acquire) == paused_count,
        "guarded diagnostic worker progressed while paused"
    );
    drop(resume_guard);
    wait_for_diagnostic_count(&resume_progress, paused_count.saturating_add(1))?;
    drop(resume_handle);

    let shutdown_control = PauseControl::new();
    let shutdown_progress = Arc::new(AtomicUsize::new(0));
    let shutdown_worker_progress = Arc::clone(&shutdown_progress);
    let mut shutdown_handle =
        spawn_pause_diagnostic_handle(Arc::clone(&shutdown_control), move |control| {
            while control.wait_before_iteration(true) {
                shutdown_worker_progress.fetch_add(1, Ordering::Release);
                thread::yield_now();
            }
        })?;
    wait_for_diagnostic_count(&shutdown_progress, 2)?;
    let shutdown_guard = shutdown_handle.pause_if_idle(Duration::from_secs(1))?;
    let shutdown_count = shutdown_progress.load(Ordering::Acquire);
    shutdown_handle.shutdown_paused(shutdown_guard)?;
    anyhow::ensure!(
        shutdown_control.lock_state().stopped,
        "paused diagnostic worker did not publish its stopped state"
    );
    thread::sleep(Duration::from_millis(10));
    anyhow::ensure!(
        shutdown_progress.load(Ordering::Acquire) == shutdown_count,
        "shutdown diagnostic worker progressed after join"
    );

    Ok(serde_json::json!({
        "schema": "fullmag.scratch_runtime.pause_control_diagnostic.v1",
        "status": "passed",
        "scope": "pause protocol with native threads; no API or solver execution",
        "checks": {
            "busy_refusal_preserves_progress": true,
            "timeout_revokes_late_request": true,
            "stopped_worker_does_not_ack_paused_request": true,
            "guard_drop_resumes_worker": true,
            "paused_shutdown_joins_worker": true
        }
    }))
}
