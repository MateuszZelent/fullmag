//! Managed proof that a live solver run refuses development restart preparation.
//!
//! The probe owns an API and a real CLI solver from sealed build A while
//! build B is ready. It drives the production restart pump against a typed
//! transport request, then records process custody and continued solver work.

use std::{
    collections::BTreeSet,
    fs,
    io::{Read, Write},
    path::{Path, PathBuf},
    process::{Command, Stdio},
    time::{Duration, Instant},
};

use anyhow::{Context, Result, bail};
use serde::Deserialize;
use serde_json::{Value, json};

use super::{
    BootstrapProcessGuard, ChildProcess, ControlRoomGuard, api_port, configure_child_process,
    emit_development_restart_probe_progress, emit_owner_probe_process_started, init_api_port,
    repo_root, runtime_state_root,
};
use crate::{
    development_api_owner::{ConsumerReadinessStatus, OwnerLaunch},
    development_restart::NativeRestartPump,
};

const INPUT_SCHEMA: &str = "fullmag.development-cli-active-run-request.v2";
const RESULT_SCHEMA: &str = "fullmag.development-cli-active-run-check.v3";
const PROGRESS_SCHEMA: &str = "fullmag.development-cli-active-run-progress.v1";
const REFUSAL_ATTRIBUTION: &str = "unavailable_private_api_handler_discards_api_error";
const STARTUP_TIMEOUT: Duration = Duration::from_secs(30);
const CANDIDATE_TIMEOUT: Duration = Duration::from_secs(155);
const SOLVER_START_TIMEOUT: Duration = Duration::from_secs(45);
const REQUEST_RESULT_TIMEOUT: Duration = Duration::from_secs(45);
const ADVANCE_TIMEOUT: Duration = Duration::from_secs(20);

#[derive(Deserialize)]
#[serde(deny_unknown_fields)]
struct Input {
    schema: String,
    scenario: String,
    owner_bundle_id: String,
    owner_manifest_sha256: String,
    owner_source_sha256: String,
    ready_build_id: String,
    ready_source_sha256: String,
}

#[derive(Clone)]
struct ActiveSnapshot {
    api_instance_id: String,
    session_id: String,
    session_epoch: u64,
    run_id: String,
    solver_state: String,
    solver_steps: u64,
}

fn lower_hex(value: &str, len: usize) -> bool {
    value.len() == len
        && value
            .bytes()
            .all(|byte| byte.is_ascii_digit() || (b'a'..=b'f').contains(&byte))
}

fn read_input() -> Result<Input> {
    let mut raw = Vec::new();
    std::io::stdin().take(4097).read_to_end(&mut raw)?;
    if raw.len() > 4096 {
        bail!("active-run probe input exceeds its limit");
    }
    let input: Input = serde_json::from_slice(&raw)?;
    if input.schema != INPUT_SCHEMA
        || !matches!(input.scenario.as_str(), "running" | "paused")
        || !lower_hex(&input.owner_bundle_id, 32)
        || !lower_hex(&input.owner_manifest_sha256, 64)
        || !lower_hex(&input.owner_source_sha256, 64)
        || !lower_hex(&input.ready_build_id, 64)
        || !lower_hex(&input.ready_source_sha256, 64)
        || input.owner_source_sha256 == input.ready_source_sha256
    {
        bail!("active-run probe requires distinct, verified A and B source identities");
    }
    Ok(input)
}

fn emit_helper(pid: u32) -> Result<()> {
    println!(
        "{}",
        json!({
            "schema":"fullmag.development-cli-consumer-pump-helper.v1",
            "helper_pid":pid,"helper_waited":true,"helper_exit_code":0
        })
    );
    std::io::stdout().flush()?;
    Ok(())
}

fn emit_solver_started(pid: u32) -> Result<()> {
    if pid == 0 {
        bail!("active-run solver child has an invalid PID");
    }
    println!(
        "{}",
        json!({"schema":PROGRESS_SCHEMA,"event":"solver_started","pid":pid})
    );
    std::io::stdout().flush()?;
    Ok(())
}

fn require_readiness(
    status: &ConsumerReadinessStatus,
    input: &Input,
    confirmed: bool,
) -> Result<()> {
    if status.ready_build_id.as_deref() != Some(input.ready_build_id.as_str())
        || status.ready_source_sha256.as_deref() != Some(input.ready_source_sha256.as_str())
        || status.readiness_confirmed != confirmed
    {
        bail!("active-run pump readiness differs from the verified B candidate");
    }
    Ok(())
}

fn active_snapshot(
    client: &reqwest::blocking::Client,
    api_port: u16,
    expected_api_instance_id: &str,
) -> Result<ActiveSnapshot> {
    let base = format!("http://127.0.0.1:{api_port}");
    let platform_response = client
        .get(format!("{base}/v2/platform/development-backend"))
        .header("x-fullmag-api-instance", expected_api_instance_id)
        .send()?
        .error_for_status()?;
    let header_instance = platform_response
        .headers()
        .get("x-fullmag-api-instance")
        .context("active-run API response has no instance pin")?
        .to_str()?
        .to_owned();
    if header_instance != expected_api_instance_id {
        bail!("active-run API response belongs to another instance");
    }
    let platform: Value = platform_response.json()?;
    let identity = &platform["workspace_identity"];
    let api_instance_id = identity["api_instance_id"]
        .as_str()
        .context("active-run workspace identity has no API instance")?
        .to_owned();
    let session_id = identity["session_id"]
        .as_str()
        .context("active-run workspace identity has no live session")?
        .to_owned();
    // This is the transition counter from the platform identity. The status
    // endpoint's presentation epoch is a different, string-valued contract.
    let session_epoch = identity["session_epoch"]
        .as_u64()
        .context("active-run workspace identity has no numeric session epoch")?;
    if session_epoch == 0 {
        bail!("active-run live session has no committed API transition epoch");
    }
    let status: Value = client
        .get(format!("{base}/v2/sessions/current/status"))
        .header("x-fullmag-api-instance", expected_api_instance_id)
        .send()?
        .error_for_status()?
        .json()?;
    let status_session_id = status["session"]["session_id"]
        .as_str()
        .context("active-run status has no session identity")?;
    if status_session_id != session_id {
        bail!("active-run platform and status session identities differ");
    }
    let run = &status["run"];
    let run_id = run["run_id"]
        .as_str()
        .context("active-run status has no run identity")?
        .to_owned();
    let solver_state = status["solver"]["state"]
        .as_str()
        .context("active-run status has no solver state")?
        .to_owned();
    let solver_steps = run["solver_steps"]
        .as_u64()
        .context("active-run status has no numeric solver step count")?;
    Ok(ActiveSnapshot {
        api_instance_id,
        session_id,
        session_epoch,
        run_id,
        solver_state,
        solver_steps,
    })
}

fn same_active_run(left: &ActiveSnapshot, right: &ActiveSnapshot) -> bool {
    left.api_instance_id == right.api_instance_id
        && left.session_id == right.session_id
        && left.session_epoch == right.session_epoch
        && left.run_id == right.run_id
}

fn encode_scope_component(value: &str) -> String {
    let mut encoded = String::with_capacity(value.len());
    for byte in value.bytes() {
        if byte.is_ascii_alphanumeric() || b"-_.!~*'()".contains(&byte) {
            encoded.push(char::from(byte));
        } else {
            encoded.push_str(&format!("%{byte:02X}"));
        }
    }
    encoded
}

fn current_session_scope(
    client: &reqwest::blocking::Client,
    api_port: u16,
    api_instance_id: &str,
    expected_session_id: &str,
) -> Result<String> {
    let base = format!("http://127.0.0.1:{api_port}");
    let status: Value = client
        .get(format!("{base}/v2/sessions/current/status"))
        .header("x-fullmag-api-instance", api_instance_id)
        .send()?
        .error_for_status()?
        .json()?;
    let session = &status["session"];
    let session_id = session["session_id"]
        .as_str()
        .context("stage control status has no session ID")?;
    let session_epoch = session["session_epoch"]
        .as_str()
        .context("stage control status has no browser session epoch")?;
    let request_scope_epoch = session["request_scope_epoch"]
        .as_str()
        .context("stage control status has no request scope epoch")?;
    if session_id != expected_session_id {
        bail!("stage control session scope changed before command submission");
    }
    Ok(format!(
        "session={}&epoch={}&request_scope_epoch={}",
        encode_scope_component(session_id),
        encode_scope_component(session_epoch),
        encode_scope_component(request_scope_epoch),
    ))
}

fn submit_and_wait_stage_control(
    client: &reqwest::blocking::Client,
    api_port: u16,
    api_instance_id: &str,
    snapshot: &ActiveSnapshot,
    kind: &str,
    expected_runtime_state: &str,
) -> Result<String> {
    let scope = current_session_scope(client, api_port, api_instance_id, &snapshot.session_id)?;
    let client_intent_id = uuid::Uuid::new_v4().to_string();
    let request_id = uuid::Uuid::new_v4().to_string();
    let base = format!("http://127.0.0.1:{api_port}");
    let response = client
        .post(format!("{base}/v2/sessions/current/simulation/commands"))
        .header("x-fullmag-api-instance", api_instance_id)
        .header("x-fullmag-session-scope", &scope)
        .header("Idempotency-Key", &client_intent_id)
        .header("X-Request-ID", &request_id)
        .json(&json!({
            "client_intent_id":client_intent_id,
            "kind":kind,
            "reason":"user_requested",
            "requested_at_unix_ms":std::time::SystemTime::now()
                .duration_since(std::time::UNIX_EPOCH)?.as_millis(),
            "target":{"kind":"current_stage"},
            "precondition":{"runtime_state":expected_runtime_state},
        }))
        .send()?;
    let status = response.status();
    let body: Value = response.json()?;
    if !status.is_success() || body["accepted"] != true {
        bail!("{kind} command was not accepted: HTTP {status}, {body}");
    }
    let command_id = body["command_id"]
        .as_str()
        .context("accepted stage control has no command ID")?
        .to_owned();

    let deadline = Instant::now() + Duration::from_secs(30);
    loop {
        let detail: Value = client
            .get(format!(
                "{base}/v2/sessions/current/simulation/commands/{command_id}"
            ))
            .header("x-fullmag-api-instance", api_instance_id)
            .header("x-fullmag-session-scope", &scope)
            .send()?
            .error_for_status()?
            .json()?;
        if detail["command_id"] != command_id {
            bail!("{kind} command detail returned a different command identity");
        }
        match detail["status"].as_str() {
            Some("completed")
                if detail["completion_status"] == "completed" && detail["error"].is_null() =>
            {
                return Ok(command_id);
            }
            Some("failed" | "rejected") => {
                bail!("{kind} command terminated without ACK: {detail}");
            }
            _ if Instant::now() < deadline => std::thread::sleep(Duration::from_millis(50)),
            _ => bail!("{kind} command did not reach completed ACK before its deadline: {detail}"),
        }
    }
}

fn helper_pids(pump: &NativeRestartPump) -> Result<BTreeSet<u32>> {
    let candidate = pump
        .readiness_candidate_for_probe()
        .context("active-run pump has no verified B candidate")?;
    if !lower_hex(&candidate.candidate_bundle_id, 32)
        || !lower_hex(&candidate.candidate_manifest_sha256, 64)
        || !lower_hex(&candidate.ready_build_id, 64)
        || !lower_hex(&candidate.ready_source_sha256, 64)
    {
        bail!("active-run pump selected an invalid candidate identity");
    }
    let mut pids = BTreeSet::new();
    for value in [
        candidate.selector_helper_pid,
        candidate.owner_verifier_helper_pid,
    ] {
        if value == 0 || !pids.insert(value) {
            bail!("active-run candidate helper PID is invalid or duplicated");
        }
    }
    Ok(pids)
}

fn stop_child(child: &mut ChildProcess) -> Result<i32> {
    super::terminate_child_process(&mut child.0);
    child
        .0
        .try_wait()?
        .context("active-run process exit remains unconfirmed after cleanup")?
        .code()
        .context("active-run process exit code remains unknown")
}

pub(super) fn verify() -> Result<()> {
    if std::env::var("FULLMAG_DEVELOPMENT_OWNER_PROBE").as_deref() != Ok("1") {
        bail!("active-run verification requires the managed owner probe");
    }
    let input = read_input()?;
    init_api_port()?;
    let root = repo_root();
    let state_root = runtime_state_root(&root);
    let owner_base = OwnerLaunch::from_environment(true, false)?
        .context("active-run probe requires managed native development settings")?;
    let (launch, owner_helper_pid) =
        owner_base.for_candidate(&root, &input.owner_bundle_id, &input.owner_manifest_sha256)?;
    if owner_helper_pid == 0 || launch.expects_launcher_build() {
        bail!("active-run owner API must come from the sealed A bundle");
    }
    emit_helper(owner_helper_pid)?;

    let storage = PathBuf::from(
        std::env::var_os("FULLMAG_PROJECT_STORAGE_ROOT")
            .context("active-run probe storage root is missing")?,
    );
    let worktree = std::env::var("FULLMAG_WORKTREE_ID")?;
    fullmag_session::repository_path::validate_store_id(&worktree)
        .context("active-run probe worktree ID is invalid")?;
    let bundles = storage
        .join("runtimes")
        .join(&worktree)
        .join("native-bundles");
    let api = bundles
        .join(&input.owner_bundle_id)
        .join("bin")
        .join(format!("fullmag-api{}", super::EXE_SUFFIX));
    let accepted_scope = std::env::var("FULLMAG_ACCEPTED_STORE_SCOPE")
        .context("active-run probe requires a fresh accepted-store scope")?;
    let api_log_path = fullmag_session::repository_path::checked_path(
        &state_root,
        &format!("active-run-api-{}.log", uuid::Uuid::new_v4().simple()),
    )?;
    let api_log = fs::OpenOptions::new()
        .write(true)
        .create_new(true)
        .open(api_log_path)?;
    let mut api_command = Command::new(&api);
    api_command
        .current_dir(&root)
        .env("FULLMAG_REPO_ROOT", &root)
        .env("FULLMAG_STATE_ROOT", &state_root)
        .env("FULLMAG_API_PORT", api_port().to_string())
        .env("FULLMAG_DISABLE_STATIC_CONTROL_ROOM", "1")
        .env("FULLMAG_DEVELOPMENT_RESTART_COORDINATOR", "1")
        .env(
            "FULLMAG_DEVELOPMENT_RESTART_UI_ORIGIN",
            "http://localhost:3197",
        )
        .env_remove("FULLMAG_DEVELOPMENT_RESTORE_STDIN")
        .stdin(Stdio::null())
        .stdout(api_log.try_clone()?)
        .stderr(api_log);
    launch.configure_candidate_command(&mut api_command, Some(&accepted_scope))?;
    configure_child_process(&mut api_command);
    let mut api_startup = BootstrapProcessGuard::new(ChildProcess(api_command.spawn()?));
    let api_pid = api_startup.process_mut().0.id();
    emit_owner_probe_process_started(api_pid, api_port())?;

    let client = reqwest::blocking::Client::builder()
        .no_proxy()
        .timeout(Duration::from_secs(5))
        .build()?;
    let platform_url = format!(
        "http://127.0.0.1:{}/v2/platform/development-backend",
        api_port()
    );
    let startup_deadline = Instant::now() + STARTUP_TIMEOUT;
    let (api_instance_id, initial_platform) = loop {
        if api_startup.process_mut().0.try_wait()?.is_some() {
            bail!("active-run A API exited before owner confirmation");
        }
        if let Ok(response) = client.get(&platform_url).send() {
            if response.status().is_success() {
                let api_instance_id = response
                    .headers()
                    .get("x-fullmag-api-instance")
                    .context("active-run A API has no instance pin")?
                    .to_str()?
                    .to_owned();
                let resource: Value = response.json()?;
                break (api_instance_id, resource);
            }
        }
        if Instant::now() >= startup_deadline {
            bail!("active-run A API did not publish its platform resource");
        }
        std::thread::sleep(Duration::from_millis(50));
    };
    if initial_platform["current_build"]["source_sha256"] != input.owner_source_sha256
        || initial_platform["ready_build"]["id"] != input.ready_build_id
        || initial_platform["ready_build"]["source_sha256"] != input.ready_source_sha256
        || initial_platform["restart_available"] != false
        || initial_platform["workspace_identity"]
            != json!({"api_instance_id":api_instance_id,"session_id":null,"session_epoch":0})
    {
        bail!("active-run A API does not expose the exact empty A/B workspace identity");
    }
    let owner = launch.confirm(api_pid, api_port(), &api_instance_id)?;
    let mut guard = ControlRoomGuard::active(api_port(), Some(api_startup.release().0), None);
    guard.adopt_development_owner(owner)?;
    guard.enable_development_restart_transport(3197)?;
    require_readiness(&guard.development_consumer_status()?, &input, false)?;

    // A live owner accepts and explicitly aborts one empty-idle acquisition.
    let mut acquisition = guard
        .development_supervisor_mut()?
        .owner()
        .acquire(&uuid::Uuid::new_v4().to_string())?;
    let idle_workspace = acquisition.workspace();
    if idle_workspace["state"] != "no_session"
        || idle_workspace["session_epoch"].as_u64() != Some(0)
    {
        bail!("active-run owner acquisition did not observe empty idle state");
    }
    acquisition.confirm_held()?;
    acquisition.abort()?;

    let (transport_root, transport_worktree, generation_id, scope_api_instance) = guard
        .development_restart_scope()
        .context("active-run probe lost the owned A API scope")?;
    if scope_api_instance != api_instance_id {
        bail!("active-run transport scope differs from the owned A API");
    }
    if fullmag_session::development_restart_transport::read_pending_request(
        &transport_root,
        &transport_worktree,
        &api_instance_id,
        &generation_id,
    )?
    .is_some()
    {
        bail!("active-run probe requires an empty restart transport slot");
    }
    let mut attach = None;
    let mut scratch = None;
    let mut pump = NativeRestartPump::default();
    let mut preparation_pid = None;
    let candidate_deadline = Instant::now() + CANDIDATE_TIMEOUT;
    loop {
        pump.step_observed(&root, &mut guard, &mut attach, &mut scratch, |event| {
            if let super::DevelopmentRestartProgress::CandidatePreparationStarted {
                helper_pid,
                api_instance_id: started_api,
                ready_build_id,
                ready_source_sha256,
            } = &event
            {
                if started_api == &api_instance_id
                    && ready_build_id == &input.ready_build_id
                    && ready_source_sha256 == &input.ready_source_sha256
                {
                    preparation_pid = Some(*helper_pid);
                }
            }
            emit_development_restart_probe_progress(event);
        })?;
        if pump.readiness_candidate_for_probe().is_some() {
            break;
        }
        if Instant::now() >= candidate_deadline {
            bail!("active-run pump did not prepare the verified B candidate in time");
        }
        std::thread::sleep(Duration::from_millis(100));
    }
    require_readiness(&guard.development_consumer_status()?, &input, true)?;
    let selected = pump
        .readiness_candidate_for_probe()
        .context("active-run pump lost the verified B candidate")?;
    if selected.ready_build_id != input.ready_build_id
        || selected.ready_source_sha256 != input.ready_source_sha256
        || selected.generation_id != generation_id
        || selected.worktree_id != transport_worktree
    {
        bail!("active-run pump selected a candidate outside the pinned B API scope");
    }
    if pump.candidate_preparation_state_for_probe()?.is_some() {
        bail!("active-run candidate preparation helper is still active after readiness");
    }
    let prepared_helpers = helper_pids(&pump)?;
    let prep_pid = preparation_pid.context("active-run candidate preparation did not start")?;
    if prep_pid == 0 || !prepared_helpers.contains(&prep_pid) || prep_pid == api_pid {
        bail!("active-run preparation PID is not the selected candidate selector helper");
    }
    let mut helper_processes = vec![json!({"pid":owner_helper_pid,"waited":true,"exit_code":0})];
    for pid in &prepared_helpers {
        emit_helper(*pid)?;
        helper_processes.push(json!({"pid":pid,"waited":true,"exit_code":0}));
    }
    let unique_helpers: BTreeSet<u32> = helper_processes
        .iter()
        .filter_map(|record| record["pid"].as_u64().map(|pid| pid as u32))
        .collect();
    if unique_helpers.len() != helper_processes.len() {
        bail!("active-run helper custody contains duplicate process IDs");
    }

    // Start only the frozen fixture explicitly supplied by the managed parent.
    let fixture = PathBuf::from(
        std::env::var_os("FULLMAG_DEVELOPMENT_ACTIVE_RUN_SCRIPT")
            .context("active-run probe has no frozen DSL fixture path")?,
    );
    if !fixture.is_absolute()
        || !fs::symlink_metadata(&fixture)
            .map(|metadata| metadata.file_type().is_file() && metadata.len() > 0)
            .unwrap_or(false)
    {
        bail!("active-run probe fixture must be a non-empty absolute regular file");
    }
    let solver_log_path = fullmag_session::repository_path::checked_path(
        &state_root,
        &format!("active-run-solver-{}.log", uuid::Uuid::new_v4().simple()),
    )?;
    let solver_log = fs::OpenOptions::new()
        .write(true)
        .create_new(true)
        .open(solver_log_path)?;
    let cli = api.with_file_name(format!("fullmag{}", super::EXE_SUFFIX));
    let solver_state_root =
        fullmag_session::repository_path::checked_path(&state_root, "solver-state")?;
    fs::create_dir(&solver_state_root)?;
    let mut solver_command = Command::new(&cli);
    launch.configure_candidate_command(&mut solver_command, Some(&accepted_scope))?;
    solver_command
        .current_dir(&root)
        .arg("-i")
        .arg(&fixture)
        .args(["--backend", "fdm"])
        .env("FULLMAG_REPO_ROOT", &root)
        .env("FULLMAG_STATE_ROOT", &solver_state_root)
        .env("FULLMAG_STATE_DIR", &solver_state_root)
        .env("FULLMAG_API_PORT", api_port().to_string())
        .env("FULLMAG_SKIP_CONTROL_ROOM", "1")
        .env("FULLMAG_FDM_EXECUTION", "cpu")
        .env_remove("FULLMAG_ATTACHED_SESSION_ID")
        .stdin(Stdio::null())
        .stdout(solver_log.try_clone()?)
        .stderr(solver_log);
    configure_child_process(&mut solver_command);
    let mut solver_startup = BootstrapProcessGuard::new(ChildProcess(solver_command.spawn()?));
    let solver_pid = solver_startup.process_mut().0.id();
    emit_solver_started(solver_pid)?;

    let solver_start_deadline = Instant::now() + SOLVER_START_TIMEOUT;
    let initially_running = loop {
        if solver_startup.process_mut().0.try_wait()?.is_some() {
            bail!("active-run A solver CLI exited before publishing a live run");
        }
        if let Ok(snapshot) = active_snapshot(&client, api_port(), &api_instance_id) {
            if snapshot.api_instance_id == api_instance_id
                && snapshot.solver_state == "running"
                && snapshot.solver_steps > 0
            {
                break snapshot;
            }
        }
        if Instant::now() >= solver_start_deadline {
            bail!("active-run A solver did not publish a running run with positive steps");
        }
        std::thread::sleep(Duration::from_millis(100));
    };
    let pause_command_id = if input.scenario == "paused" {
        let command_id = submit_and_wait_stage_control(
            &client,
            api_port(),
            &api_instance_id,
            &initially_running,
            "pause",
            "running",
        )?;
        let pause_deadline = Instant::now() + Duration::from_secs(30);
        loop {
            if solver_startup.process_mut().0.try_wait()?.is_some() {
                bail!("active-run solver exited while acknowledging pause");
            }
            let snapshot = active_snapshot(&client, api_port(), &api_instance_id)?;
            if !same_active_run(&initially_running, &snapshot) {
                bail!("active-run identity changed while pausing the solver");
            }
            if snapshot.solver_state == "paused" {
                break;
            }
            if snapshot.solver_state != "running" || Instant::now() >= pause_deadline {
                bail!("active-run solver did not enter paused after terminal pause ACK");
            }
            std::thread::sleep(Duration::from_millis(50));
        }
        Some(command_id)
    } else {
        None
    };
    let before = if input.scenario == "paused" {
        active_snapshot(&client, api_port(), &api_instance_id)?
    } else {
        initially_running.clone()
    };
    if !same_active_run(&initially_running, &before) {
        bail!("active-run identity changed before the restart-refusal baseline");
    }
    let expected_refusal_state = if input.scenario == "paused" {
        "paused"
    } else {
        "running"
    };
    if before.solver_state != expected_refusal_state || before.solver_steps == 0 {
        bail!("active-run probe did not reach the requested pre-refusal runtime state");
    }
    let current_platform = client
        .get(&platform_url)
        .header("x-fullmag-api-instance", &api_instance_id)
        .send()?
        .error_for_status()?
        .json::<Value>()?;
    if current_platform["workspace_identity"]["session_id"] != before.session_id
        || current_platform["workspace_identity"]["session_epoch"].as_u64()
            != Some(before.session_epoch)
    {
        bail!("active-run platform identity does not match the observed live solver session");
    }

    use fullmag_session::development_restart_transport as transport;
    let request_id = uuid::Uuid::new_v4().to_string();
    let status_token = uuid::Uuid::new_v4().simple().to_string();
    let request = transport::RestartRequest {
        schema: transport::RESTART_REQUEST_SCHEMA.to_owned(),
        request_id: request_id.clone(),
        status_token_sha256: fullmag_session::hex_sha256(status_token.as_bytes()),
        old_api_instance_id: api_instance_id.clone(),
        generation_id: generation_id.clone(),
        session_id: Some(before.session_id.clone()),
        session_epoch: before.session_epoch,
        editor: json!({"source":"active-run restart refusal probe","cursor":0}),
        workspace: json!({"selection":[],"inspector":null}),
        project_document: json!({"dirty":false,"name":"active-run refusal probe"}),
    };
    transport::publish_request(&transport_root, &transport_worktree, &request)?;

    let token_sha = request.status_token_sha256.clone();
    let result_deadline = Instant::now() + REQUEST_RESULT_TIMEOUT;
    let mut handoff_staged = false;
    let mut old_api_exited = false;
    let mut replacement_started = false;
    let restart_result = loop {
        if let Some(result) = transport::read_result(
            &transport_root,
            &transport_worktree,
            &request_id,
            &token_sha,
        )? {
            break result;
        }
        if solver_startup.process_mut().0.try_wait()?.is_some() {
            bail!("active-run solver exited while restart refusal was being observed");
        }
        if Instant::now() >= result_deadline {
            bail!("active-run restart request has no terminal result before the deadline");
        }
        pump.step_observed(&root, &mut guard, &mut attach, &mut scratch, |event| {
            match &event {
                super::DevelopmentRestartProgress::HandoffStaged { .. } => {
                    handoff_staged = true;
                }
                super::DevelopmentRestartProgress::OldApiExited { .. } => {
                    old_api_exited = true;
                }
                super::DevelopmentRestartProgress::Replacement(_) => {
                    replacement_started = true;
                }
                super::DevelopmentRestartProgress::CandidatePreparationStarted { .. }
                | super::DevelopmentRestartProgress::RestorePreparationHelperWaited { .. } => {}
            }
            emit_development_restart_probe_progress(event);
        })?;
        std::thread::sleep(Duration::from_millis(100));
    };
    let result_state = format!("{:?}", restart_result.state).to_lowercase();
    let public_reason = restart_result.public_reason.clone();
    if restart_result.state != transport::RestartResultState::Failed
        || public_reason.as_deref() != Some("restart_preparation_refused")
        || handoff_staged
        || old_api_exited
        || replacement_started
        || pump.last_execution.is_some()
        || attach.is_some()
        || scratch.is_some()
    {
        bail!("active-run restart did not terminate as a pre-handoff refusal");
    }

    if solver_startup.process_mut().0.try_wait()?.is_some() {
        bail!("active-run solver exited before refusal baseline observation");
    }
    let refusal_baseline = active_snapshot(&client, api_port(), &api_instance_id)?;
    if !same_active_run(&before, &refusal_baseline)
        || refusal_baseline.solver_state != expected_refusal_state
        || (input.scenario == "paused" && refusal_baseline.solver_steps != before.solver_steps)
        || refusal_baseline.solver_steps < before.solver_steps
    {
        bail!("active-run refusal baseline differs from the original live solver run");
    }
    let after = if input.scenario == "paused" {
        let snapshot = active_snapshot(&client, api_port(), &api_instance_id)?;
        if solver_startup.process_mut().0.try_wait()?.is_some()
            || !same_active_run(&before, &snapshot)
            || snapshot.solver_state != "paused"
            || snapshot.solver_steps != refusal_baseline.solver_steps
        {
            bail!("paused solver state or identity changed after restart refusal");
        }
        snapshot
    } else {
        let advance_deadline = Instant::now() + ADVANCE_TIMEOUT;
        loop {
            if solver_startup.process_mut().0.try_wait()?.is_some() {
                bail!("active-run solver exited after restart refusal");
            }
            if let Ok(snapshot) = active_snapshot(&client, api_port(), &api_instance_id) {
                if !same_active_run(&before, &snapshot) || snapshot.solver_state != "running" {
                    bail!(
                        "active-run API, session, run, or live solver state changed after refusal"
                    );
                }
                if snapshot.solver_steps > refusal_baseline.solver_steps {
                    break snapshot;
                }
            }
            if Instant::now() >= advance_deadline {
                bail!("active-run solver steps did not advance before the bounded deadline");
            }
            std::thread::sleep(Duration::from_millis(100));
        }
    };
    let resume_command_id = if input.scenario == "paused" {
        Some(submit_and_wait_stage_control(
            &client,
            api_port(),
            &api_instance_id,
            &after,
            "resume",
            "paused",
        )?)
    } else {
        None
    };
    let after_resume = if input.scenario == "paused" {
        let resume_deadline = Instant::now() + ADVANCE_TIMEOUT;
        loop {
            if solver_startup.process_mut().0.try_wait()?.is_some() {
                bail!("active-run solver exited after resume ACK");
            }
            if let Ok(snapshot) = active_snapshot(&client, api_port(), &api_instance_id) {
                if !same_active_run(&before, &snapshot) {
                    bail!("active-run identity changed after resume ACK");
                }
                if snapshot.solver_state == "running" && snapshot.solver_steps > after.solver_steps
                {
                    break Some(snapshot);
                }
                if snapshot.solver_state != "paused" && snapshot.solver_state != "running" {
                    bail!("active-run solver entered an unexpected state after resume ACK");
                }
            }
            if Instant::now() >= resume_deadline {
                bail!("active-run solver did not resume and advance after resume ACK");
            }
            std::thread::sleep(Duration::from_millis(100));
        }
    } else {
        None
    };
    let api_after = active_snapshot(&client, api_port(), &api_instance_id)?;
    if !same_active_run(&before, &api_after)
        || (input.scenario == "running"
            && (api_after.solver_state != "running" || api_after.solver_steps < after.solver_steps))
        || (input.scenario == "paused"
            && (api_after.solver_state != "running"
                || after_resume
                    .as_ref()
                    .is_none_or(|resumed| api_after.solver_steps < resumed.solver_steps)))
    {
        bail!("active-run final API observation differs from the continuing live run");
    }

    if solver_startup.process_mut().0.try_wait()?.is_some() {
        bail!("active-run solver was not alive at cleanup");
    }
    let solver = solver_startup.release();
    let mut solver = solver;
    let solver_exit_code = stop_child(&mut solver)?;
    let (api_terminal, same_api) = {
        let supervisor = guard.development_supervisor_mut()?;
        let same_api = supervisor.owner().child_pid() == api_pid
            && supervisor.owner().api_instance_id() == api_instance_id;
        supervisor.shutdown()?;
        let terminal = supervisor
            .terminal_status()
            .context("active-run A API wait was not confirmed")?;
        (terminal, same_api)
    };
    let api_exit_code = api_terminal
        .code()
        .context("active-run A API exit code is unknown")?;

    let checks = json!({
        "idle_owner_acquire_accepted_and_aborted":true,
        "candidate_ready_observed":true,
        "active_run_running_observed":initially_running.solver_state == "running",
        "active_run_paused_before_refusal":input.scenario == "paused" && before.solver_state == "paused",
        "pause_command_terminal":input.scenario == "paused" && pause_command_id.is_some(),
        "active_run_steps_positive":before.solver_steps > 0,
        "typed_restart_intent_published":true,
        "active_run_refusal_failed":result_state == "failed",
        "no_handoff_staged":!handoff_staged,
        "no_old_api_exit":!old_api_exited,
        "no_replacement_started":!replacement_started,
        "same_owner_session_run_after_refusal":same_api && same_active_run(&before, &after) && same_active_run(&before, &api_after),
        "solver_worker_alive_after_refusal":true,
        "solver_steps_advanced_after_refusal":input.scenario == "running" && after.solver_steps > refusal_baseline.solver_steps,
        "paused_state_preserved_after_refusal":input.scenario == "paused" && after.solver_state == "paused" && after.solver_steps == refusal_baseline.solver_steps,
        "resume_command_terminal":input.scenario == "paused" && resume_command_id.is_some(),
        "solver_resumed_after_refusal":after_resume.as_ref().is_some_and(|snapshot| snapshot.solver_state == "running"),
        "solver_steps_advanced_after_resume":after_resume.as_ref().is_some_and(|snapshot| snapshot.solver_steps > after.solver_steps),
    });
    let result = json!({
        "schema":RESULT_SCHEMA,
        "status":"passed",
        "scenario":input.scenario,
        "request_id":request_id,
        "old_api_instance_id":api_instance_id,
        "session_id":before.session_id,
        "api_transition_epoch_before":before.session_epoch,
        "api_transition_epoch_after":api_after.session_epoch,
        "run_id":before.run_id,
        "solver_steps_before":before.solver_steps,
        "solver_steps_at_refusal":refusal_baseline.solver_steps,
        "solver_steps_after":after.solver_steps,
        "solver_state_before":before.solver_state,
        "solver_state_after":after.solver_state,
        "pause_command_id":pause_command_id,
        "resume_command_id":resume_command_id,
        "solver_steps_after_resume":after_resume.as_ref().map(|snapshot| snapshot.solver_steps),
        "solver_state_after_resume":after_resume.as_ref().map(|snapshot| snapshot.solver_state.as_str()),
        "active_run_result_state":result_state,
        "active_run_public_reason":public_reason,
        "refusal_reason_attribution":REFUSAL_ATTRIBUTION,
        "api_process":{"pid":api_pid,"waited":true,"exit_code":api_exit_code},
        "solver_process":{"pid":solver_pid,"waited":true,"exit_code":solver_exit_code},
        "helper_processes":helper_processes,
        "checks":checks,
    });
    let mut output = std::io::stdout().lock();
    serde_json::to_writer(&mut output, &result)?;
    output.write_all(b"\n")?;
    output.flush()?;
    Ok(())
}
