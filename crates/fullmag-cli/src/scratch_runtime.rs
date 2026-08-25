use reqwest::blocking::Client;
use serde_json::Value;
use std::path::PathBuf;
use std::process::{Child, Command, Stdio};
use std::sync::atomic::{AtomicBool, Ordering};
use std::sync::Arc;
use std::thread::{self, JoinHandle};
use std::time::{Duration, Instant};

const POLL_INTERVAL: Duration = Duration::from_millis(250);
const COMMAND_SETTLE_GRACE: Duration = Duration::from_secs(2);

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
) -> ScratchRuntimeHandle {
    let stop = Arc::new(AtomicBool::new(false));
    let worker_stop = Arc::clone(&stop);
    let handle = thread::Builder::new()
        .name("fullmag-scratch-runtime-supervisor".to_string())
        .spawn(move || run(worker_stop, api_port, executable, ignored_session))
        .expect("scratch runtime supervisor thread should spawn");
    ScratchRuntimeHandle {
        stop,
        worker: Some(handle),
    }
}

pub(crate) struct ScratchRuntimeHandle {
    stop: Arc<AtomicBool>,
    worker: Option<JoinHandle<()>>,
}

impl Drop for ScratchRuntimeHandle {
    fn drop(&mut self) {
        self.stop.store(true, Ordering::Release);
        let Some(worker) = self.worker.take() else {
            return;
        };
        if worker.thread().id() != thread::current().id() {
            let _ = worker.join();
        }
    }
}

fn run(stop: Arc<AtomicBool>, api_port: u16, executable: PathBuf, ignored_session: Option<String>) {
    let client = match Client::builder().timeout(Duration::from_secs(1)).build() {
        Ok(client) => client,
        Err(error) => {
            eprintln!("[fullmag] scratch runtime supervisor disabled: {error}");
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

    while !stop.load(Ordering::Acquire) {
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
                        thread::sleep(POLL_INTERVAL);
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
                        thread::sleep(POLL_INTERVAL);
                        continue;
                    }
                }

                if child.is_none() && matches!(backend.as_str(), "fdm" | "fem") {
                    if let Some(command_id) = pending_compute_command(&client, &api_base) {
                        if current_session_matches(
                            &client,
                            &api_base,
                            &session_id,
                            &backend,
                            scene_revision,
                        ) {
                            match render_current_scene(&client, &api_base) {
                                Ok(script_path) => {
                                    if current_session_matches(
                                        &client,
                                        &api_base,
                                        &session_id,
                                        &backend,
                                        scene_revision,
                                    ) {
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
                                            }
                                            Err(error) => eprintln!(
                                                "[fullmag] failed to start attached scratch runtime: {error}"
                                            ),
                                        }
                                    } else {
                                        eprintln!(
                                            "[fullmag] scratch session changed during model sync; refusing to start stale runtime"
                                        );
                                    }
                                }
                                Err(error) => {
                                    eprintln!(
                                        "[fullmag] scratch scene is not runnable yet; waiting for authoring ACK: {error}"
                                    );
                                }
                            }
                        }
                    }
                }
            }
        }

        thread::sleep(POLL_INTERVAL);
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
                ) && matches!(kind, Some("remesh" | "relax" | "run" | "solve"))
                {
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
        .json(&serde_json::json!({}))
        .send()?
        .error_for_status()?;
    let body = response.json::<Value>()?;
    let path = body
        .get("script_path")
        .and_then(Value::as_str)
        .filter(|path| !path.trim().is_empty())
        .ok_or_else(|| anyhow::anyhow!("model sync did not return script_path"))?;
    Ok(PathBuf::from(path))
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
