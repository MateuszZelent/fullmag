//! Managed browser/native proof for a real scene and dirty-document restart.
//!
//! The parent owns the browser and accepted-store fixture. This process owns
//! only the diagnostic API instance it launches and the restart pump it drives.

use std::{
    collections::BTreeSet,
    fs,
    io::{Read, Write},
    path::{Path, PathBuf},
    process::{Command, Stdio},
    sync::mpsc::{self, Receiver, TryRecvError},
    thread::{self, JoinHandle},
    time::{Duration, Instant, SystemTime, UNIX_EPOCH},
};

use anyhow::{bail, Context, Result};
use serde::{Deserialize, Serialize};
use serde_json::{json, Value};

use super::{
    api_port, configure_child_process, emit_development_restart_probe_progress,
    emit_owner_probe_process_started, init_api_port, repo_root, runtime_state_root,
    BootstrapProcessGuard, ChildProcess, ControlRoomGuard,
};
use crate::{
    development_api_owner::{ConsumerReadinessStatus, OwnerLaunch},
    development_restart::NativeRestartPump,
};

const INPUT_SCHEMA: &str = "fullmag.development-browser-native-input.v1";
const COMMAND_SCHEMA: &str = "fullmag.development-browser-native-command.v1";
const READY_SCHEMA: &str = "fullmag.development-browser-native-ready.v1";
const RESTORED_SCHEMA: &str = "fullmag.development-browser-native-restored.v1";
const RESULT_SCHEMA: &str = "fullmag.development-browser-native-result.v1";
const MAX_INPUT_LINE_BYTES: usize = 16 * 1024;
const MAX_COMMAND_LINE_BYTES: usize = 4 * 1024;
const PROBE_TIMEOUT: Duration = Duration::from_secs(600);
const API_START_TIMEOUT: Duration = Duration::from_secs(30);
const HELPER_CLEANUP_TIMEOUT: Duration = Duration::from_secs(5);
const READY_FRAME_TTL_MS: u64 = 1_000;
const READY_FRAME_INTERVAL: Duration = Duration::from_millis(500);
const PUMP_TICK: Duration = Duration::from_millis(50);

#[derive(Deserialize)]
#[serde(deny_unknown_fields)]
struct Input {
    schema: String,
    owner_bundle_id: String,
    owner_manifest_sha256: String,
    owner_source_sha256: String,
    ready_build_id: String,
    ready_source_sha256: String,
    web_port: u16,
    nonce: String,
}

#[derive(Deserialize)]
#[serde(deny_unknown_fields)]
struct FinishCommand {
    schema: String,
    event: String,
    nonce: String,
    new_api_instance_id: String,
}

#[derive(Serialize, Clone)]
struct HelperProcessEvidence {
    pid: u32,
    waited: bool,
    exit_code: i32,
}

struct RestoredState {
    api_pid: u32,
    api_instance_id: String,
    old_api_exit_code: i32,
    helper_processes: Vec<HelperProcessEvidence>,
}

struct CleanupEvidence {
    exit_code: Option<i32>,
    fully_known: bool,
}

enum ReaderMessage {
    Finish(FinishCommand),
    Failed(&'static str),
}

enum ProbeOutcome {
    Finished,
    Failed(&'static str),
    Unknown(&'static str),
}

#[derive(Serialize)]
struct FinalResult<'a> {
    schema: &'static str,
    nonce: &'a str,
    status: &'a str,
    old_api_pid: u32,
    old_api_instance_id: &'a str,
    new_api_pid: Option<u32>,
    new_api_instance_id: Option<&'a str>,
    old_api_exit_code: Option<i32>,
    new_api_exit_code: Option<i32>,
    helper_processes: &'a [HelperProcessEvidence],
}

pub(super) fn verify() -> Result<()> {
    require_probe_gates()?;
    let input = read_input()?;
    validate_input(&input)?;
    init_api_port()?;
    if input.web_port == api_port() {
        bail!("browser workspace probe UI and API ports must be distinct");
    }

    let probe_deadline = Instant::now() + PROBE_TIMEOUT;
    let (command_receiver, command_reader) = start_command_reader(input.nonce.clone())?;
    let root = repo_root();
    let state_root = runtime_state_root(&root);
    let owner_launch = OwnerLaunch::from_environment(true, false)?
        .context("browser workspace probe requires managed native development settings")?;
    let (launch, owner_helper_pid) =
        owner_launch.for_candidate(&root, &input.owner_bundle_id, &input.owner_manifest_sha256)?;
    if launch.expects_launcher_build() {
        bail!("browser workspace probe owner API must be the sealed A bundle");
    }

    let storage = PathBuf::from(
        std::env::var_os("FULLMAG_PROJECT_STORAGE_ROOT")
            .context("browser workspace probe storage root is missing")?,
    );
    let worktree = std::env::var("FULLMAG_WORKTREE_ID")?;
    fullmag_session::repository_path::validate_store_id(&worktree)
        .context("browser workspace probe worktree id is invalid")?;
    let bundles = storage
        .join("runtimes")
        .join(&worktree)
        .join("native-bundles");
    let api = bundles
        .join(&input.owner_bundle_id)
        .join("bin")
        .join(format!("fullmag-api{}", super::EXE_SUFFIX));
    let accepted_scope = std::env::var("FULLMAG_ACCEPTED_STORE_SCOPE")
        .context("browser workspace probe requires a fresh accepted-store scope")?;
    let log_path = fullmag_session::repository_path::checked_path(
        &state_root,
        &format!(
            "browser-workspace-api-{}.log",
            uuid::Uuid::new_v4().simple()
        ),
    )?;
    let log = fs::OpenOptions::new()
        .write(true)
        .create_new(true)
        .open(&log_path)?;

    let mut command = Command::new(&api);
    command
        .current_dir(&root)
        .env("FULLMAG_REPO_ROOT", &root)
        .env("FULLMAG_STATE_ROOT", &state_root)
        .env("FULLMAG_API_PORT", api_port().to_string())
        .env("FULLMAG_DISABLE_STATIC_CONTROL_ROOM", "1")
        .env("FULLMAG_DEVELOPMENT_RESTART_COORDINATOR", "1")
        .env(
            "FULLMAG_DEVELOPMENT_RESTART_UI_ORIGIN",
            format!("http://localhost:{}", input.web_port),
        )
        .env_remove("FULLMAG_DEVELOPMENT_RESTORE_STDIN")
        .stdin(Stdio::null())
        .stdout(log.try_clone()?)
        .stderr(log);
    launch.configure_candidate_command(&mut command, Some(&accepted_scope))?;
    configure_child_process(&mut command);

    let mut startup = BootstrapProcessGuard::new(ChildProcess(command.spawn()?));
    let old_api_pid = startup.process_mut().0.id();
    if old_api_pid == 0 {
        bail!("browser workspace probe API has an invalid PID");
    }
    emit_owner_probe_process_started(old_api_pid, api_port())?;

    let client = reqwest::blocking::Client::builder()
        .no_proxy()
        .timeout(Duration::from_secs(3))
        .build()?;
    let url = format!(
        "http://127.0.0.1:{}/v2/platform/development-backend",
        api_port()
    );
    let startup_deadline = Instant::now() + API_START_TIMEOUT;
    let response = loop {
        if startup.process_mut().0.try_wait()?.is_some() {
            bail!("browser workspace probe API exited before owner confirmation");
        }
        if let Ok(response) = client.get(&url).send() {
            if response.status().is_success() {
                break response;
            }
        }
        if Instant::now() >= startup_deadline {
            bail!("browser workspace probe API did not publish its resource");
        }
        thread::sleep(Duration::from_millis(50));
    };
    let old_api_instance_id = response
        .headers()
        .get("x-fullmag-api-instance")
        .context("browser workspace probe API has no instance pin")?
        .to_str()?
        .to_owned();
    let resource: Value = response.json()?;
    if resource["current_build"]["source_sha256"] != input.owner_source_sha256
        || resource["ready_build"]["id"] != input.ready_build_id
        || resource["ready_build"]["source_sha256"] != input.ready_source_sha256
        || resource["restart_available"] != false
    {
        bail!("browser workspace probe API does not expose the exact A/B builds");
    }

    emit_json_line(&json!({
        "schema": "fullmag.development-browser-api-log.v1",
        "nonce": input.nonce,
        "api_pid": old_api_pid,
        "api_instance_id": old_api_instance_id,
        "file_name": log_path.file_name().and_then(|name| name.to_str()).context("browser API log has no UTF-8 file name")?,
    }))?;
    let owner = launch.confirm(old_api_pid, api_port(), &old_api_instance_id)?;
    let mut guard = ControlRoomGuard::active(api_port(), Some(startup.release().0), None);
    guard.adopt_development_owner(owner)?;
    guard.enable_development_restart_transport(input.web_port)?;
    let initial_readiness = guard.development_consumer_status()?;
    require_ready_identity(&initial_readiness, &input, false)?;
    let (transport_root, transport_worktree, generation_id, scope_api_id) = guard
        .development_restart_scope()
        .context("browser workspace probe lost its owned API scope")?;
    if transport_worktree != worktree || scope_api_id != old_api_instance_id {
        bail!("browser workspace probe owner scope differs from its request");
    }

    let mut runtime_attach = None;
    let mut scratch = None;
    let mut pump = NativeRestartPump::default();
    let mut reader_handle = Some(command_reader);
    let mut pending_finish: Option<FinishCommand> = None;
    let mut restored: Option<RestoredState> = None;
    let mut last_ready_frame: Option<Instant> = None;
    let mut candidate_preparation_started = false;
    let mut candidate_preparation_progress_matches = true;
    let mut completed_readiness_helpers = Vec::new();
    let mut failure = None;

    while Instant::now() < probe_deadline {
        if restored.is_none() {
            collect_completed_readiness_helpers(&pump, &mut completed_readiness_helpers);
            let pump_step = pump.step_observed(
                &root,
                &mut guard,
                &mut runtime_attach,
                &mut scratch,
                |event| {
                    if let super::DevelopmentRestartProgress::CandidatePreparationStarted {
                        api_instance_id,
                        ready_build_id,
                        ready_source_sha256,
                        ..
                    } = &event
                    {
                        candidate_preparation_started = true;
                        candidate_preparation_progress_matches &= api_instance_id
                            == &old_api_instance_id
                            && ready_build_id == &input.ready_build_id
                            && ready_source_sha256 == &input.ready_source_sha256;
                    }
                    super::emit_development_restart_probe_progress(event);
                },
            );
            collect_completed_readiness_helpers(&pump, &mut completed_readiness_helpers);
            if pump_step.is_err() {
                failure = Some(ProbeOutcome::Unknown("restart_pump_outcome_unconfirmed"));
                break;
            }
            if !candidate_preparation_progress_matches {
                failure = Some(ProbeOutcome::Unknown(
                    "candidate_preparation_scope_mismatch",
                ));
                break;
            }
            let _ = std::io::stdout().flush();
            if let Some(execution) = pump.last_execution.as_ref() {
                if !candidate_preparation_started {
                    failure = Some(ProbeOutcome::Unknown(
                        "candidate_preparation_start_not_observed",
                    ));
                    break;
                }
                match observe_restored_restart(
                    &mut guard,
                    execution,
                    &transport_root,
                    &worktree,
                    &generation_id,
                    old_api_pid,
                    &old_api_instance_id,
                ) {
                    Ok(state) => {
                        emit_restored(&input.nonce, &state)?;
                        restored = Some(state);
                    }
                    Err(_) => {
                        failure = Some(ProbeOutcome::Unknown(
                            "replacement_scope_or_process_evidence_unconfirmed",
                        ));
                        break;
                    }
                }
            } else if last_ready_frame.map_or(true, |last| last.elapsed() >= READY_FRAME_INTERVAL) {
                match readiness_frame(
                    &pump,
                    &guard,
                    &input,
                    &transport_root,
                    &transport_worktree,
                    &generation_id,
                    &old_api_instance_id,
                ) {
                    Ok(Some(frame)) => {
                        emit_json_line(&frame)?;
                        last_ready_frame = Some(Instant::now());
                    }
                    Ok(None) => {}
                    Err(_) => {
                        failure = Some(ProbeOutcome::Unknown("readiness_observation_unconfirmed"));
                        break;
                    }
                }
            }
        }

        if pending_finish.is_none() {
            match poll_command(&command_receiver) {
                Ok(Some(message)) => {
                    if let Some(handle) = reader_handle.take() {
                        if handle.join().is_err() {
                            failure = Some(ProbeOutcome::Failed("finish_command_reader_panicked"));
                            break;
                        }
                    }
                    match message {
                        ReaderMessage::Finish(command) => pending_finish = Some(command),
                        ReaderMessage::Failed(reason) => {
                            failure = Some(ProbeOutcome::Failed(reason));
                            break;
                        }
                    }
                }
                Ok(None) => {}
                Err(reason) => {
                    failure = Some(ProbeOutcome::Failed(reason));
                    break;
                }
            }
        }

        if let (Some(restored), Some(finish)) = (restored.as_ref(), pending_finish.as_ref()) {
            if finish.new_api_instance_id != restored.api_instance_id || finish.nonce != input.nonce
            {
                failure = Some(ProbeOutcome::Failed(
                    "finish_command_replacement_pin_mismatch",
                ));
            } else {
                failure = Some(ProbeOutcome::Finished);
            }
            break;
        }

        thread::sleep(PUMP_TICK);
    }

    if failure.is_none() {
        failure = Some(ProbeOutcome::Failed("browser_workspace_probe_timed_out"));
    }
    let outcome = failure.expect("probe outcome is set after the loop");

    let (new_api_pid, new_api_instance_id, old_api_exit_code, new_api_exit_code, helpers, status) =
        finalize_outcome(
            &outcome,
            restored.as_ref(),
            owner_helper_pid,
            &completed_readiness_helpers,
            old_api_pid,
            &old_api_instance_id,
            &root,
            &transport_root,
            &transport_worktree,
            &generation_id,
            &mut guard,
            &mut pump,
            &mut runtime_attach,
            &mut scratch,
        );

    emit_result(
        &input,
        status,
        old_api_pid,
        &old_api_instance_id,
        new_api_pid,
        new_api_instance_id.as_deref(),
        old_api_exit_code,
        new_api_exit_code,
        &helpers,
    )?;
    if status != "passed" {
        bail!("browser workspace native proof ended without a confirmed pass");
    }
    Ok(())
}

#[allow(clippy::type_complexity)]
fn finalize_outcome(
    outcome: &ProbeOutcome,
    restored: Option<&RestoredState>,
    owner_helper_pid: u32,
    completed_readiness_helpers: &[HelperProcessEvidence],
    old_api_pid: u32,
    old_api_instance_id: &str,
    repo_root: &Path,
    expected_scope_root: &Path,
    expected_worktree: &str,
    expected_generation: &str,
    guard: &mut ControlRoomGuard,
    pump: &mut NativeRestartPump,
    runtime_attach: &mut Option<
        fullmag_runtime_control::application_attach::BackgroundApplicationAttach,
    >,
    scratch: &mut Option<crate::scratch_runtime::ScratchRuntimeHandle>,
) -> (
    Option<u32>,
    Option<String>,
    Option<i32>,
    Option<i32>,
    Vec<HelperProcessEvidence>,
    &'static str,
) {
    if matches!(outcome, ProbeOutcome::Finished) {
        if let Some(restored) = restored {
            let scope_matches = owned_api_matches_scope(
                guard,
                expected_scope_root,
                expected_worktree,
                expected_generation,
                &restored.api_instance_id,
                restored.api_pid,
            );
            let cleanup = if scope_matches {
                match shutdown_exact_api(guard, &restored.api_instance_id, restored.api_pid) {
                    Ok(exit_code) => CleanupEvidence {
                        fully_known: exit_code.is_some(),
                        exit_code,
                    },
                    Err(_) => cleanup_owned_scope(
                        guard,
                        &[
                            (old_api_instance_id, old_api_pid),
                            (&restored.api_instance_id, restored.api_pid),
                        ],
                    ),
                }
            } else {
                cleanup_owned_scope(
                    guard,
                    &[
                        (old_api_instance_id, old_api_pid),
                        (&restored.api_instance_id, restored.api_pid),
                    ],
                )
            };
            let status = if scope_matches && cleanup.fully_known {
                "passed"
            } else {
                "unknown"
            };
            let mut helpers =
                terminal_helpers_with_owner(owner_helper_pid, &restored.helper_processes);
            merge_helper_evidence(&mut helpers, completed_readiness_helpers);
            return (
                Some(restored.api_pid),
                Some(restored.api_instance_id.clone()),
                Some(restored.old_api_exit_code),
                cleanup.exit_code,
                helpers,
                status,
            );
        }
        let cleanup = cleanup_owned_scope(guard, &[(old_api_instance_id, old_api_pid)]);
        let _drained = drain_pump_cancellation(repo_root, guard, pump, runtime_attach, scratch);
        let mut helpers = vec![HelperProcessEvidence {
            pid: owner_helper_pid,
            waited: true,
            exit_code: 0,
        }];
        append_canceled_helper(pump, &mut helpers);
        merge_helper_evidence(&mut helpers, completed_readiness_helpers);
        return (None, None, cleanup.exit_code, None, helpers, "unknown");
    }

    let execution = pump.last_execution.clone();
    let live_replacement = owned_replacement_in_scope(
        guard,
        expected_scope_root,
        expected_worktree,
        expected_generation,
        old_api_instance_id,
        old_api_pid,
    )
    .filter(|(_, pid)| {
        execution.as_ref().map_or(true, |execution| {
            execution["api_pid"]
                .as_u64()
                .and_then(|value| u32::try_from(value).ok())
                == Some(*pid)
        })
    });
    let current_is_old = owned_api_matches_scope(
        guard,
        expected_scope_root,
        expected_worktree,
        expected_generation,
        old_api_instance_id,
        old_api_pid,
    );
    let known_replacement = restored
        .map(|state| (state.api_instance_id.clone(), state.api_pid))
        .or_else(|| live_replacement.clone());
    let mut known_scopes = vec![(old_api_instance_id, old_api_pid)];
    if let Some((instance, pid)) = known_replacement.as_ref() {
        known_scopes.push((instance.as_str(), *pid));
    }
    let cleanup = cleanup_owned_scope(guard, &known_scopes);
    let drained = drain_pump_cancellation(repo_root, guard, pump, runtime_attach, scratch);

    let mut helpers = restored
        .map(|state| state.helper_processes.clone())
        .unwrap_or_default();
    let execution_helpers_known = match execution.as_ref() {
        Some(execution) if helpers.is_empty() => execution["helper_processes"]
            .as_array()
            .and_then(|values| parse_helper_processes(values).ok())
            .map(|found| {
                for helper in found {
                    push_unique_helper(&mut helpers, helper);
                }
            })
            .is_some(),
        Some(_) | None => true,
    };
    merge_helper_evidence(&mut helpers, completed_readiness_helpers);
    append_canceled_helper(pump, &mut helpers);
    push_unique_helper(
        &mut helpers,
        HelperProcessEvidence {
            pid: owner_helper_pid,
            waited: true,
            exit_code: 0,
        },
    );

    let old_api_exit_code = restored
        .map(|state| state.old_api_exit_code)
        .or_else(|| {
            execution
                .as_ref()
                .and_then(|value| value["old_api_exit_code"].as_i64())
                .and_then(|code| i32::try_from(code).ok())
        })
        .or_else(|| (current_is_old).then_some(cleanup.exit_code).flatten());
    let new_api_pid = known_replacement.as_ref().map(|(_, pid)| *pid);
    let new_api_instance_id = known_replacement
        .as_ref()
        .map(|(instance, _)| instance.clone());
    let new_api_exit_code = live_replacement
        .as_ref()
        .map(|_| cleanup.exit_code)
        .flatten();
    let status = match outcome {
        ProbeOutcome::Unknown(_) => "unknown",
        ProbeOutcome::Failed(_) if drained && cleanup.fully_known && execution_helpers_known => {
            "failed"
        }
        ProbeOutcome::Failed(_) => "unknown",
        ProbeOutcome::Finished => "unknown",
    };
    (
        new_api_pid,
        new_api_instance_id,
        old_api_exit_code,
        new_api_exit_code,
        helpers,
        status,
    )
}

fn current_owned_api(guard: &mut ControlRoomGuard) -> Option<(String, u32)> {
    let supervisor = guard.development_supervisor_mut().ok()?;
    Some((
        supervisor.owner().api_instance_id().to_owned(),
        supervisor.owner().child_pid(),
    ))
}

fn collect_completed_readiness_helpers(
    pump: &NativeRestartPump,
    helpers: &mut Vec<HelperProcessEvidence>,
) {
    let Some(candidate) = pump.readiness_candidate_for_probe() else {
        return;
    };
    for pid in [
        candidate.selector_helper_pid,
        candidate.owner_verifier_helper_pid,
    ] {
        if pid != 0 {
            push_unique_helper(
                helpers,
                HelperProcessEvidence {
                    pid,
                    waited: true,
                    exit_code: 0,
                },
            );
        }
    }
}

fn merge_helper_evidence(
    helpers: &mut Vec<HelperProcessEvidence>,
    additional: &[HelperProcessEvidence],
) {
    for helper in additional {
        push_unique_helper(helpers, helper.clone());
    }
}

fn owned_api_matches_scope(
    guard: &mut ControlRoomGuard,
    expected_root: &Path,
    expected_worktree: &str,
    expected_generation: &str,
    expected_instance_id: &str,
    expected_pid: u32,
) -> bool {
    let Some((root, worktree, generation, instance_id)) = guard.development_restart_scope() else {
        return false;
    };
    if root.as_path() != expected_root
        || worktree != expected_worktree
        || generation != expected_generation
        || instance_id != expected_instance_id
    {
        return false;
    }
    current_owned_api(guard).is_some_and(|(owner_instance, owner_pid)| {
        owner_instance == expected_instance_id && owner_pid == expected_pid
    })
}

fn owned_replacement_in_scope(
    guard: &mut ControlRoomGuard,
    expected_root: &Path,
    expected_worktree: &str,
    expected_generation: &str,
    old_api_instance_id: &str,
    old_api_pid: u32,
) -> Option<(String, u32)> {
    let (root, worktree, generation, instance_id) = guard.development_restart_scope()?;
    if root.as_path() != expected_root
        || worktree != expected_worktree
        || generation != expected_generation
        || instance_id == old_api_instance_id
    {
        return None;
    }
    let (owner_instance_id, owner_pid) = current_owned_api(guard)?;
    if owner_instance_id != instance_id || owner_pid == 0 || owner_pid == old_api_pid {
        return None;
    }
    Some((owner_instance_id, owner_pid))
}

fn append_canceled_helper(pump: &NativeRestartPump, helpers: &mut Vec<HelperProcessEvidence>) {
    if let Some(helper) = pump
        .canceled_helper_for_probe()
        .filter(|helper| helper.exit_code.is_some())
    {
        if let Some(exit_code) = helper.exit_code {
            push_unique_helper(
                helpers,
                HelperProcessEvidence {
                    pid: helper.pid,
                    waited: true,
                    exit_code,
                },
            );
        }
    }
}

fn require_probe_gates() -> Result<()> {
    if std::env::var("FULLMAG_DEVELOPMENT_OWNER_PROBE").as_deref() != Ok("1")
        || std::env::var("FULLMAG_DEVELOPMENT_RESTART_PROBE_CASE").as_deref()
            != Ok("browser-workspace")
    {
        bail!("browser workspace native proof requires both managed probe gates");
    }
    Ok(())
}

fn read_input() -> Result<Input> {
    let mut stdin = std::io::stdin();
    let raw = read_bounded_line(&mut stdin, MAX_INPUT_LINE_BYTES)
        .context("unable to read browser workspace native input line")?;
    serde_json::from_slice(&raw).context("invalid browser workspace native input")
}

fn validate_input(input: &Input) -> Result<()> {
    if input.schema != INPUT_SCHEMA
        || !lower_hex(&input.owner_bundle_id, 32)
        || !lower_hex(&input.owner_manifest_sha256, 64)
        || !lower_hex(&input.owner_source_sha256, 64)
        || !lower_hex(&input.ready_build_id, 64)
        || !lower_hex(&input.ready_source_sha256, 64)
        || input.owner_source_sha256 == input.ready_source_sha256
        || input.web_port == 0
        || !canonical_uuid(&input.nonce)
    {
        bail!("browser workspace native input does not match the bounded managed contract");
    }
    Ok(())
}

fn start_command_reader(nonce: String) -> Result<(Receiver<ReaderMessage>, JoinHandle<()>)> {
    let (sender, receiver) = mpsc::sync_channel(1);
    let handle = thread::Builder::new()
        .name("development-browser-finish-input".to_owned())
        .spawn(move || {
            let mut stdin = std::io::stdin();
            let message = match read_bounded_line(&mut stdin, MAX_COMMAND_LINE_BYTES) {
                Ok(raw) => match serde_json::from_slice::<FinishCommand>(&raw) {
                    Ok(command)
                        if command.schema == COMMAND_SCHEMA
                            && command.event == "finish"
                            && command.nonce == nonce
                            && canonical_uuid(&command.new_api_instance_id) =>
                    {
                        ReaderMessage::Finish(command)
                    }
                    _ => ReaderMessage::Failed("finish_command_invalid_or_mismatched"),
                },
                Err(_) => ReaderMessage::Failed("finish_command_eof_or_invalid_line"),
            };
            let _ = sender.send(message);
        })
        .context("unable to start bounded browser finish-command reader")?;
    Ok((receiver, handle))
}

fn read_bounded_line(reader: &mut impl Read, limit: usize) -> std::io::Result<Vec<u8>> {
    let mut bytes = Vec::with_capacity(limit.min(1024));
    let mut byte = [0u8; 1];
    loop {
        if bytes.len() == limit {
            return Err(std::io::Error::new(
                std::io::ErrorKind::InvalidData,
                "line exceeds its byte limit",
            ));
        }
        match reader.read(&mut byte)? {
            0 => {
                return Err(std::io::Error::new(
                    std::io::ErrorKind::UnexpectedEof,
                    "input line ended before newline",
                ));
            }
            _ => {
                if byte[0] == b'\n' {
                    if bytes.last() == Some(&b'\r') {
                        bytes.pop();
                    }
                    return Ok(bytes);
                }
                bytes.push(byte[0]);
            }
        }
    }
}

fn poll_command(
    receiver: &Receiver<ReaderMessage>,
) -> std::result::Result<Option<ReaderMessage>, &'static str> {
    match receiver.try_recv() {
        Ok(message) => Ok(Some(message)),
        Err(TryRecvError::Empty) => Ok(None),
        Err(TryRecvError::Disconnected) => Err("finish_command_reader_disconnected"),
    }
}

fn require_ready_identity(
    status: &ConsumerReadinessStatus,
    input: &Input,
    confirmed: bool,
) -> Result<()> {
    if status.ready_build_id.as_deref() != Some(input.ready_build_id.as_str())
        || status.ready_source_sha256.as_deref() != Some(input.ready_source_sha256.as_str())
        || status.readiness_confirmed != confirmed
    {
        bail!("browser workspace owner readiness differs from the requested B identity");
    }
    Ok(())
}

fn readiness_frame(
    pump: &NativeRestartPump,
    guard: &ControlRoomGuard,
    input: &Input,
    transport_root: &Path,
    worktree_id: &str,
    generation_id: &str,
    expected_api_instance_id: &str,
) -> Result<Option<Value>> {
    if pump.last_execution.is_some() {
        return Ok(None);
    }
    let Some((current_root, current_worktree, current_generation, current_api)) =
        guard.development_restart_scope()
    else {
        return Ok(None);
    };
    if current_root.as_path() != transport_root
        || current_worktree != worktree_id
        || current_generation != generation_id
        || current_api != expected_api_instance_id
    {
        return Ok(None);
    }
    let Some(candidate) = pump.readiness_candidate_for_probe() else {
        return Ok(None);
    };
    if candidate.worktree_id != worktree_id
        || candidate.generation_id != generation_id
        || candidate.ready_build_id != input.ready_build_id
        || candidate.ready_source_sha256 != input.ready_source_sha256
    {
        return Ok(None);
    }
    let status = guard.development_consumer_status()?;
    if require_ready_identity(&status, input, true).is_err() {
        return Ok(None);
    }
    if fullmag_session::development_restart_transport::read_pending_request(
        transport_root,
        worktree_id,
        expected_api_instance_id,
        generation_id,
    )?
    .is_some()
    {
        return Ok(None);
    }

    let observed_at_unix_ms = unix_time_ms()?;
    let valid_until_unix_ms = observed_at_unix_ms.saturating_add(READY_FRAME_TTL_MS);
    Ok(Some(json!({
        "schema": READY_SCHEMA,
        "api_instance_id": expected_api_instance_id,
        "worktree_id": worktree_id,
        "generation_id": generation_id,
        "ready_build_id": input.ready_build_id,
        "ready_source_sha256": input.ready_source_sha256,
        "ui_origin": format!("http://localhost:{}", input.web_port),
        "nonce": input.nonce,
        "observed_at_unix_ms": observed_at_unix_ms,
        "valid_until_unix_ms": valid_until_unix_ms,
    })))
}

fn observe_restored_restart(
    guard: &mut ControlRoomGuard,
    execution: &Value,
    expected_root: &Path,
    expected_worktree: &str,
    expected_generation: &str,
    old_api_pid: u32,
    old_api_instance_id: &str,
) -> Result<RestoredState> {
    let api_pid: u32 = execution["api_pid"]
        .as_u64()
        .context("restart execution has no replacement API PID")?
        .try_into()
        .context("replacement API PID is out of range")?;
    if api_pid == 0 {
        bail!("replacement API PID is invalid");
    }
    let old_api_exit_code: i32 = execution["old_api_exit_code"]
        .as_i64()
        .context("restart execution has no actual old API exit code")?
        .try_into()
        .context("old API exit code is out of range")?;
    let helper_processes = parse_helper_processes(
        execution["helper_processes"]
            .as_array()
            .context("restart execution has no terminal helper evidence")?,
    )?;
    let (root, worktree, generation, api_instance_id) = guard
        .development_restart_scope()
        .context("restored workspace has no live replacement API scope")?;
    if root.as_path() != expected_root
        || worktree != expected_worktree
        || generation != expected_generation
        || api_instance_id == old_api_instance_id
    {
        bail!("restored workspace scope differs from the consumed A/B request");
    }
    let supervisor = guard.development_supervisor_mut()?;
    if supervisor.owner().child_pid() != api_pid
        || supervisor.owner().api_instance_id() != api_instance_id
        || supervisor.owner().child_pid() == old_api_pid
    {
        bail!("restored workspace is not the exact owned replacement process");
    }
    if fullmag_session::repository_path::validate_store_id(&worktree).is_err() {
        bail!("restored workspace identity is invalid");
    }
    Ok(RestoredState {
        api_pid,
        api_instance_id,
        old_api_exit_code,
        helper_processes,
    })
}

fn parse_helper_processes(values: &[Value]) -> Result<Vec<HelperProcessEvidence>> {
    let mut seen = BTreeSet::new();
    let mut output = Vec::with_capacity(values.len());
    for value in values {
        let object = value
            .as_object()
            .context("restart helper evidence must be an object")?;
        if object.len() != 3
            || !object.contains_key("pid")
            || !object.contains_key("waited")
            || !object.contains_key("exit_code")
        {
            bail!("restart helper evidence has an unexpected shape");
        }
        let pid: u32 = value["pid"]
            .as_u64()
            .context("restart helper PID is not an integer")?
            .try_into()
            .context("restart helper PID is out of range")?;
        let waited = value["waited"]
            .as_bool()
            .context("restart helper waited evidence is not boolean")?;
        let exit_code: i32 = value["exit_code"]
            .as_i64()
            .context("restart helper exit code is not an integer")?
            .try_into()
            .context("restart helper exit code is out of range")?;
        if pid == 0 || !waited || !seen.insert(pid) {
            bail!("restart helper terminal evidence is incomplete or duplicated");
        }
        output.push(HelperProcessEvidence {
            pid,
            waited,
            exit_code,
        });
    }
    Ok(output)
}

fn emit_restored(nonce: &str, restored: &RestoredState) -> Result<()> {
    emit_json_line(&json!({
        "schema": RESTORED_SCHEMA,
        "nonce": nonce,
        "new_api_instance_id": restored.api_instance_id,
        "api_pid": restored.api_pid,
        "old_api_exit_code": restored.old_api_exit_code,
        "helper_processes": restored.helper_processes,
    }))
}

fn shutdown_exact_api(
    guard: &mut ControlRoomGuard,
    expected_instance_id: &str,
    expected_pid: u32,
) -> Result<Option<i32>> {
    let supervisor = guard.development_supervisor_mut()?;
    if supervisor.owner().api_instance_id() != expected_instance_id
        || supervisor.owner().child_pid() != expected_pid
    {
        bail!("refusing to shut down an API outside the exact owned replacement scope");
    }
    supervisor.shutdown()?;
    Ok(supervisor
        .terminal_status()
        .and_then(|status| status.code()))
}

fn cleanup_owned_scope(guard: &mut ControlRoomGuard, expected: &[(&str, u32)]) -> CleanupEvidence {
    let Ok(supervisor) = guard.development_supervisor_mut() else {
        return CleanupEvidence {
            exit_code: None,
            fully_known: false,
        };
    };
    let owner = supervisor.owner();
    if !expected.iter().any(|(instance_id, pid)| {
        owner.api_instance_id() == *instance_id && owner.child_pid() == *pid
    }) {
        return CleanupEvidence {
            exit_code: None,
            fully_known: false,
        };
    }
    match supervisor.state() {
        crate::development_api_supervisor::DevelopmentApiSupervisorState::Running
        | crate::development_api_supervisor::DevelopmentApiSupervisorState::CommitNotSent => {
            if supervisor.shutdown().is_err() {
                return CleanupEvidence {
                    exit_code: supervisor
                        .terminal_status()
                        .and_then(|status| status.code()),
                    fully_known: false,
                };
            }
        }
        crate::development_api_supervisor::DevelopmentApiSupervisorState::ExitedBeforeCommit
        | crate::development_api_supervisor::DevelopmentApiSupervisorState::Shutdown => {}
        crate::development_api_supervisor::DevelopmentApiSupervisorState::OutcomeUnknown
        | crate::development_api_supervisor::DevelopmentApiSupervisorState::Accepted => {
            return CleanupEvidence {
                exit_code: supervisor
                    .terminal_status()
                    .and_then(|status| status.code()),
                fully_known: false,
            }
        }
    }
    let exit_code = supervisor
        .terminal_status()
        .and_then(|status| status.code());
    CleanupEvidence {
        exit_code,
        fully_known: exit_code.is_some(),
    }
}

fn drain_pump_cancellation(
    repo_root: &Path,
    guard: &mut ControlRoomGuard,
    pump: &mut NativeRestartPump,
    runtime_attach: &mut Option<
        fullmag_runtime_control::application_attach::BackgroundApplicationAttach,
    >,
    scratch: &mut Option<crate::scratch_runtime::ScratchRuntimeHandle>,
) -> bool {
    let deadline = Instant::now() + HELPER_CLEANUP_TIMEOUT;
    loop {
        match pump.candidate_preparation_state_for_probe() {
            Ok(None) => return true,
            Ok(Some(_)) => {}
            Err(_) => return false,
        }
        if Instant::now() >= deadline {
            return false;
        }
        if pump
            .step_observed(repo_root, guard, runtime_attach, scratch, |_| {})
            .is_err()
        {
            return false;
        }
        thread::sleep(Duration::from_millis(10));
    }
}

fn terminal_helpers_with_owner(
    owner_helper_pid: u32,
    helpers: &[HelperProcessEvidence],
) -> Vec<HelperProcessEvidence> {
    let mut output = vec![HelperProcessEvidence {
        pid: owner_helper_pid,
        waited: true,
        exit_code: 0,
    }];
    for helper in helpers {
        push_unique_helper(&mut output, helper.clone());
    }
    output
}

fn push_unique_helper(helpers: &mut Vec<HelperProcessEvidence>, helper: HelperProcessEvidence) {
    if !helpers.iter().any(|existing| existing.pid == helper.pid) {
        helpers.push(helper);
    }
}

fn emit_result(
    input: &Input,
    status: &'static str,
    old_api_pid: u32,
    old_api_instance_id: &str,
    new_api_pid: Option<u32>,
    new_api_instance_id: Option<&str>,
    old_api_exit_code: Option<i32>,
    new_api_exit_code: Option<i32>,
    helper_processes: &[HelperProcessEvidence],
) -> Result<()> {
    emit_json_line(&serde_json::to_value(FinalResult {
        schema: RESULT_SCHEMA,
        nonce: &input.nonce,
        status,
        old_api_pid,
        old_api_instance_id,
        new_api_pid,
        new_api_instance_id,
        old_api_exit_code,
        new_api_exit_code,
        helper_processes,
    })?)
}

fn emit_json_line(value: &Value) -> Result<()> {
    let stdout = std::io::stdout();
    let mut lock = stdout.lock();
    serde_json::to_writer(&mut lock, value)?;
    lock.write_all(b"\n")?;
    lock.flush()?;
    Ok(())
}

fn unix_time_ms() -> Result<u64> {
    SystemTime::now()
        .duration_since(UNIX_EPOCH)
        .context("system time precedes the Unix epoch")?
        .as_millis()
        .try_into()
        .context("Unix millisecond timestamp is out of range")
}

fn canonical_uuid(value: &str) -> bool {
    uuid::Uuid::parse_str(value).is_ok_and(|parsed| parsed.hyphenated().to_string() == value)
}

fn lower_hex(value: &str, length: usize) -> bool {
    value.len() == length
        && value
            .bytes()
            .all(|byte| byte.is_ascii_digit() || (b'a'..=b'f').contains(&byte))
}
