//! Managed executable observation of the production readiness pump across builds.
//! The probe CLI and candidate are B; the exact owned API is sealed build A.

use std::{
    collections::BTreeSet,
    fs,
    io::{Read, Write},
    path::{Path, PathBuf},
    process::{Command, Stdio},
    time::{Duration, Instant},
};

use anyhow::{bail, Context, Result};
use serde::Deserialize;
use serde_json::{json, Value};

use super::{
    api_port, configure_child_process, emit_owner_probe_process_started, init_api_port, repo_root,
    runtime_state_root, BootstrapProcessGuard, ChildProcess, ControlRoomGuard,
};
use crate::{
    development_api_owner::{ConsumerReadinessStatus, OwnerLaunch},
    development_restart::NativeRestartPump,
};

#[derive(Deserialize)]
#[serde(deny_unknown_fields)]
struct Input {
    schema: String,
    owner_bundle_id: String,
    owner_manifest_sha256: String,
    owner_source_sha256: String,
    ready_build_id: String,
    ready_source_sha256: String,
}

fn bundle_entries(root: &Path) -> Result<BTreeSet<String>> {
    fs::read_dir(root)?
        .map(|entry| {
            entry?
                .file_name()
                .into_string()
                .map_err(|_| anyhow::anyhow!("native bundle entry is not UTF-8"))
        })
        .collect()
}

fn require_status(status: &ConsumerReadinessStatus, input: &Input, confirmed: bool) -> Result<()> {
    if status.ready_build_id.as_deref() != Some(input.ready_build_id.as_str())
        || status.ready_source_sha256.as_deref() != Some(input.ready_source_sha256.as_str())
        || status.readiness_confirmed != confirmed
    {
        bail!("consumer pump readiness differs from the expected verified candidate or lease");
    }
    Ok(())
}

fn candidate_evidence(pump: &NativeRestartPump) -> Result<Value> {
    let candidate = pump
        .readiness_candidate_for_probe()
        .context("consumer pump has no selected candidate")?;
    Ok(json!({
        "candidate_bundle_id":candidate.candidate_bundle_id,
        "candidate_manifest_sha256":candidate.candidate_manifest_sha256,
        "ready_build_id":candidate.ready_build_id,
        "ready_source_sha256":candidate.ready_source_sha256,
        "helper_processes":[
            {"pid":candidate.selector_helper_pid,"waited":true,"exit_code":0},
            {"pid":candidate.owner_verifier_helper_pid,"waited":true,"exit_code":0}
        ]
    }))
}

fn emit_helper(pid: u32, exit_code: i32) -> Result<()> {
    println!(
        "{}",
        json!({
            "schema":"fullmag.development-cli-consumer-pump-helper.v1",
            "helper_pid":pid,"helper_waited":true,"helper_exit_code":exit_code
        })
    );
    std::io::stdout().flush()?;
    Ok(())
}

pub(super) fn verify() -> Result<()> {
    if std::env::var("FULLMAG_DEVELOPMENT_OWNER_PROBE").as_deref() != Ok("1") {
        bail!("consumer pump verification requires the managed owner probe");
    }
    let mut raw = Vec::new();
    std::io::stdin().take(4097).read_to_end(&mut raw)?;
    if raw.len() > 4096 {
        bail!("consumer pump probe input exceeds its limit");
    }
    let input: Input = serde_json::from_slice(&raw)?;
    if input.schema != "fullmag.development-cli-consumer-pump-request.v1"
        || input.owner_source_sha256 == input.ready_source_sha256
    {
        bail!("consumer pump probe requires distinct verified source identities");
    }
    init_api_port()?;
    let root = repo_root();
    let state_root = runtime_state_root(&root);
    let base = OwnerLaunch::from_environment(true, false)?
        .context("consumer pump probe requires managed native dev configuration")?;
    let (launch, owner_helper_pid) =
        base.for_candidate(&root, &input.owner_bundle_id, &input.owner_manifest_sha256)?;
    emit_helper(owner_helper_pid, 0)?;
    if launch.expects_launcher_build() {
        bail!("consumer pump probe API must come from a different compiled build");
    }
    let storage = PathBuf::from(
        std::env::var_os("FULLMAG_PROJECT_STORAGE_ROOT")
            .context("consumer pump storage is missing")?,
    );
    let worktree = std::env::var("FULLMAG_WORKTREE_ID")?;
    let bundles = storage
        .join("runtimes")
        .join(&worktree)
        .join("native-bundles");
    let api = bundles
        .join(&input.owner_bundle_id)
        .join("bin/fullmag-api.exe");
    let scope = std::env::var("FULLMAG_ACCEPTED_STORE_SCOPE")
        .context("consumer pump requires a fresh scoped accepted store")?;
    let log_path = fullmag_session::repository_path::checked_path(
        &state_root,
        &format!("consumer-pump-api-{}.log", uuid::Uuid::new_v4().simple()),
    )?;
    let log = fs::OpenOptions::new()
        .write(true)
        .create_new(true)
        .open(log_path)?;
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
            "http://localhost:3197",
        )
        .env_remove("FULLMAG_DEVELOPMENT_RESTORE_STDIN")
        .stdin(Stdio::null())
        .stdout(log.try_clone()?)
        .stderr(log);
    launch.configure_candidate_command(&mut command, Some(&scope))?;
    configure_child_process(&mut command);
    // The candidate owner helper validated this exact bundle. No executable fallback.
    let mut startup = BootstrapProcessGuard::new(ChildProcess(command.spawn()?));
    let pid = startup.process_mut().0.id();
    emit_owner_probe_process_started(pid, api_port())?;
    let client = reqwest::blocking::Client::builder()
        .no_proxy()
        .timeout(Duration::from_secs(5))
        .build()?;
    let url = format!(
        "http://127.0.0.1:{}/v2/platform/development-backend",
        api_port()
    );
    // Same-build startup readiness intentionally rejects A from this B probe.
    // Wait for HTTP while retaining the exact child; candidate-owner confirmation
    // below remains authoritative for its compiled identity and private token.
    let deadline = Instant::now() + Duration::from_secs(30);
    let response = loop {
        if startup.process_mut().0.try_wait()?.is_some() {
            bail!("consumer pump API exited before candidate-owner confirmation");
        }
        if let Ok(response) = client.get(&url).send() {
            if response.status().is_success() {
                break response;
            }
        }
        if Instant::now() >= deadline {
            bail!("consumer pump API did not publish its HTTP resource");
        }
        std::thread::sleep(Duration::from_millis(50));
    };
    let instance = response
        .headers()
        .get("x-fullmag-api-instance")
        .context("consumer pump API has no instance pin")?
        .to_str()?
        .to_owned();
    let resource: Value = response.json()?;
    if resource["current_build"]["source_sha256"] != input.owner_source_sha256
        || resource["ready_build"]["source_sha256"] != input.ready_source_sha256
        || resource["ready_build"]["id"] != input.ready_build_id
        || resource["restart_available"] != false
        || resource["workspace_identity"]
            != json!({"api_instance_id":instance,"session_id":null,"session_epoch":0})
    {
        bail!("consumer pump API does not expose the exact A/B observation");
    }
    let owner = launch.confirm(pid, api_port(), &instance)?;
    let mut guard = ControlRoomGuard::active(api_port(), Some(startup.release().0), None);
    guard.adopt_development_owner(owner)?;
    guard.enable_development_restart_transport(3197)?;
    require_status(&guard.development_consumer_status()?, &input, false)?;
    let (transport_root, transport_worktree, generation, old_api) = guard
        .development_restart_scope()
        .context("consumer pump lost owner scope")?;
    let no_pending = || -> Result<()> {
        if fullmag_session::development_restart_transport::read_pending_request(
            &transport_root,
            &transport_worktree,
            &old_api,
            &generation,
        )?
        .is_some()
        {
            bail!("consumer pump readiness fixture received a restart request");
        }
        Ok(())
    };
    no_pending()?;
    let before_bundles = bundle_entries(&bundles)?;
    let mut attach = None;
    let mut scratch = None;
    let mut pump = NativeRestartPump::default();
    let step_started = Instant::now();
    let mut preparation_started = None;
    pump.step_observed(&root, &mut guard, &mut attach, &mut scratch, |event| {
        if let super::DevelopmentRestartProgress::CandidatePreparationStarted {
            helper_pid,
            api_instance_id,
            ready_build_id,
            ready_source_sha256,
        } = &event
        {
            preparation_started = Some((
                *helper_pid,
                api_instance_id.clone(),
                ready_build_id.clone(),
                ready_source_sha256.clone(),
            ));
        }
        super::emit_development_restart_probe_progress(event);
    })?;
    let preparation_step_elapsed_ms = step_started.elapsed().as_millis();
    let (started_pid, started_api, started_build, started_source) = preparation_started
        .context("consumer pump did not expose candidate preparation startup")?;
    if started_api != instance
        || started_build != input.ready_build_id
        || started_source != input.ready_source_sha256
    {
        bail!("candidate preparation startup frame differs from the owned API and ready identity");
    }
    let (pending_pid, helper_alive) = pump
        .candidate_preparation_state_for_probe()?
        .context("consumer pump has no pending candidate preparation")?;
    if pending_pid != started_pid || !helper_alive {
        bail!("candidate preparation helper was not alive after the nonblocking pump step");
    }
    require_status(&guard.development_consumer_status()?, &input, false)?;
    let preparation_pending_observed = true;
    let preparation_step_nonblocking_observed = preparation_step_elapsed_ms < 1000;
    if !preparation_step_nonblocking_observed {
        bail!("candidate preparation blocked the production pump step");
    }

    let preparation_deadline = Instant::now() + Duration::from_secs(125);
    loop {
        if pump.readiness_candidate_for_probe().is_some() {
            break;
        }
        if Instant::now() >= preparation_deadline {
            bail!("candidate preparation did not become ready within its bounded observation");
        }
        std::thread::sleep(Duration::from_millis(250));
        pump.step_observed(
            &root,
            &mut guard,
            &mut attach,
            &mut scratch,
            super::emit_development_restart_probe_progress,
        )?;
    }
    require_status(&guard.development_consumer_status()?, &input, true)?;
    let selected = candidate_evidence(&pump)?;
    if selected["ready_build_id"] != input.ready_build_id
        || selected["ready_source_sha256"] != input.ready_source_sha256
    {
        bail!("consumer pump selected a different candidate");
    }
    for helper in selected["helper_processes"]
        .as_array()
        .context("missing selector helpers")?
    {
        emit_helper(
            helper["pid"].as_u64().context("missing helper PID")? as u32,
            0,
        )?;
    }
    let mut expected_bundles = before_bundles;
    if !expected_bundles.insert(
        selected["candidate_bundle_id"]
            .as_str()
            .context("missing selected bundle ID")?
            .to_owned(),
    ) || bundle_entries(&bundles)? != expected_bundles
    {
        bail!("consumer pump did not create exactly one new sealed bundle");
    }
    let renewed = Instant::now();
    while renewed.elapsed() < Duration::from_secs(6) {
        std::thread::sleep(Duration::from_millis(1100));
        pump.step_observed(&root, &mut guard, &mut attach, &mut scratch, |_| {})?;
        require_status(&guard.development_consumer_status()?, &input, true)?;
        if candidate_evidence(&pump)? != selected || bundle_entries(&bundles)? != expected_bundles {
            bail!("consumer pump resealed or changed its cached candidate during renewal");
        }
    }
    let renewal_observation_ms = renewed.elapsed().as_millis();
    // The managed parent keeps Ready heartbeats alive. Reads do not renew a lease.
    let paused = Instant::now();
    while paused.elapsed() < Duration::from_secs(6) {
        let status = guard.development_consumer_status()?;
        if status.ready_build_id.as_deref() != Some(input.ready_build_id.as_str()) {
            bail!("consumer pump lost its fresh watcher during the pause");
        }
        std::thread::sleep(Duration::from_millis(250));
    }
    require_status(&guard.development_consumer_status()?, &input, false)?;
    let paused_observation_ms = paused.elapsed().as_millis();
    pump.step_observed(&root, &mut guard, &mut attach, &mut scratch, |_| {})?;
    require_status(&guard.development_consumer_status()?, &input, true)?;
    if candidate_evidence(&pump)? != selected || bundle_entries(&bundles)? != expected_bundles {
        bail!("consumer pump did not reuse its candidate after lease expiry");
    }
    no_pending()?;
    let after: Value = client
        .get(&url)
        .header("x-fullmag-api-instance", &instance)
        .send()?
        .error_for_status()?
        .json()?;
    if after["workspace_identity"] != resource["workspace_identity"]
        || after["restart_available"] != false
        || pump.last_execution.is_some()
        || attach.is_some()
        || scratch.is_some()
    {
        bail!("consumer pump readiness changed the workspace or executed a restart");
    }
    require_status(
        &guard.confirm_development_consumer_readiness(None)?,
        &input,
        false,
    )?;
    let scope_before_loss = guard
        .development_restart_scope()
        .context("consumer pump lost its owned API before the scope-loss check")?;
    let same_owned_scope = scope_before_loss.0 == transport_root
        && scope_before_loss.1 == transport_worktree
        && scope_before_loss.2 == generation
        && scope_before_loss.3 == instance;
    let mut scope_loss_pump = NativeRestartPump::default();
    let mut scope_loss_attach = None;
    let mut scope_loss_scratch = None;
    let mut scope_loss_started = None;
    let scope_loss_start_time = Instant::now();
    let scope_loss_start_result = scope_loss_pump.step_observed(
        &root,
        &mut guard,
        &mut scope_loss_attach,
        &mut scope_loss_scratch,
        |event| {
            if let super::DevelopmentRestartProgress::CandidatePreparationStarted {
                helper_pid,
                api_instance_id,
                ready_build_id,
                ready_source_sha256,
            } = &event
            {
                scope_loss_started = Some((
                    *helper_pid,
                    api_instance_id.clone(),
                    ready_build_id.clone(),
                    ready_source_sha256.clone(),
                ));
            }
            super::emit_development_restart_probe_progress(event);
        },
    );
    let scope_loss_start_step_elapsed_ms = scope_loss_start_time.elapsed().as_millis();
    let scope_loss_start_succeeded = scope_loss_start_result.is_ok();
    let scope_loss_identity_matches = scope_loss_started.as_ref().is_some_and(
        |(_, started_api, started_build, started_source)| {
            same_owned_scope
                && started_api == &instance
                && started_build == &input.ready_build_id
                && started_source == &input.ready_source_sha256
        },
    );
    let scope_loss_selector_state = scope_loss_pump
        .candidate_preparation_state_for_probe()
        .ok()
        .flatten();
    let scope_loss_pending_observed = scope_loss_start_succeeded
        && scope_loss_identity_matches
        && scope_loss_started
            .as_ref()
            .zip(scope_loss_selector_state)
            .is_some_and(|((started_pid, ..), (pending_pid, helper_alive))| {
                *started_pid == pending_pid && helper_alive
            });
    let scope_loss_start_nonblocking = scope_loss_start_step_elapsed_ms < 1000;
    let scope_loss_readiness_withdrawn = guard
        .development_consumer_status()
        .and_then(|status| require_status(&status, &input, false))
        .is_ok();
    let scope_loss_no_request_before_shutdown = no_pending().is_ok();

    let (terminal, same_api_before_shutdown) = {
        let supervisor = guard.development_supervisor_mut()?;
        let same_api = supervisor.owner().child_pid() == pid
            && supervisor.owner().api_instance_id() == instance;
        supervisor.shutdown()?;
        let terminal = supervisor
            .terminal_status()
            .context("consumer pump API was not waited")?;
        (terminal, same_api)
    };

    let cancel_deadline = Instant::now() + Duration::from_secs(5);
    let cancel_step_started = Instant::now();
    scope_loss_pump.step_observed(
        &root,
        &mut guard,
        &mut scope_loss_attach,
        &mut scope_loss_scratch,
        |_| {},
    )?;
    let mut cancel_step_elapsed_ms = cancel_step_started.elapsed().as_millis();
    cancel_step_elapsed_ms = cancel_step_elapsed_ms.max(scope_loss_start_step_elapsed_ms);
    let mut scope_loss_nonblocking = scope_loss_start_nonblocking && cancel_step_elapsed_ms < 1000;

    loop {
        let pending = scope_loss_pump.candidate_preparation_state_for_probe()?;
        if pending.is_none() {
            break;
        }
        if Instant::now() >= cancel_deadline {
            break;
        }
        std::thread::sleep(Duration::from_millis(10));
        let step_started = Instant::now();
        scope_loss_pump.step_observed(
            &root,
            &mut guard,
            &mut scope_loss_attach,
            &mut scope_loss_scratch,
            |_| {},
        )?;
        let step_elapsed_ms = step_started.elapsed().as_millis();
        cancel_step_elapsed_ms = cancel_step_elapsed_ms.max(step_elapsed_ms);
        scope_loss_nonblocking &= step_elapsed_ms < 1000;
    }
    let scope_loss_still_pending = scope_loss_pump
        .candidate_preparation_state_for_probe()?
        .is_some();
    if scope_loss_still_pending {
        bail!("scope-loss selector cleanup remains unconfirmed after its bounded drain");
    }
    let canceled_helper = scope_loss_pump
        .canceled_helper_for_probe()
        .context("scope-loss pump has no waited canceled-helper evidence")?;
    let canceled_helper_exit_code = canceled_helper
        .exit_code
        .context("scope-loss helper exit code was not observed")?;
    emit_helper(canceled_helper.pid, canceled_helper_exit_code)?;

    let canceled_selector_pid = scope_loss_started.as_ref().map(|started| started.0);
    let scope_loss_helper_reaped = canceled_selector_pid == Some(canceled_helper.pid)
        && canceled_helper.exit_code.is_some()
        && !scope_loss_still_pending;
    let scope_loss_no_candidate =
        scope_loss_pump.readiness_candidate_for_probe().is_none() && !scope_loss_still_pending;
    let same_owned_api_after_shutdown = {
        let supervisor = guard.development_supervisor_mut()?;
        supervisor.owner().child_pid() == pid && supervisor.owner().api_instance_id() == instance
    };
    let scope_loss_no_replacement = same_api_before_shutdown
        && same_owned_api_after_shutdown
        && guard.development_restart_scope().is_none()
        && scope_loss_pump.last_execution.is_none()
        && scope_loss_attach.is_none()
        && scope_loss_scratch.is_none()
        && scope_loss_no_request_before_shutdown
        && no_pending().is_ok();

    let mut helpers = vec![json!({"pid":owner_helper_pid,"waited":true,"exit_code":0})];
    helpers.extend(
        selected["helper_processes"]
            .as_array()
            .context("selected candidate lost helper evidence")?
            .iter()
            .cloned(),
    );
    helpers.push(json!({
        "pid":canceled_helper.pid,
        "waited":true,
        "exit_code":canceled_helper_exit_code,
    }));
    let scope_loss_checks_passed = scope_loss_pending_observed
        && scope_loss_nonblocking
        && scope_loss_helper_reaped
        && scope_loss_no_candidate
        && scope_loss_no_replacement
        && scope_loss_readiness_withdrawn;
    println!(
        "{}",
        json!({
            "schema":"fullmag.development-cli-consumer-pump-check.v1",
            "status":if scope_loss_checks_passed { "passed" } else { "failed" },
            "api_pid":pid,"api_instance_id":instance,"api_waited":true,"api_exit_code":terminal.code(),
            "launcher_build_matches_api":false,"owner_bundle_id":input.owner_bundle_id,
            "owner_manifest_sha256":input.owner_manifest_sha256,"owner_source_sha256":input.owner_source_sha256,
            "candidate_bundle_id":selected["candidate_bundle_id"],
            "candidate_manifest_sha256":selected["candidate_manifest_sha256"],
            "ready_build_id":input.ready_build_id,"ready_source_sha256":input.ready_source_sha256,
            "preparation_step_elapsed_ms":preparation_step_elapsed_ms,
            "canceled_helper_pid":canceled_helper.pid,
            "cancel_step_elapsed_ms":cancel_step_elapsed_ms,
            "renewal_observation_ms":renewal_observation_ms,"paused_observation_ms":paused_observation_ms,
            "helper_processes":helpers,
            "checks":{"cross_build_owner_confirmed":true,"initial_readiness_absent":true,
                "preparation_pending_observed":preparation_pending_observed,
                "preparation_step_nonblocking_observed":preparation_step_nonblocking_observed,
                "ready_candidate_selected":true,"lease_renewed_past_initial_ttl":true,
                "single_candidate_bundle_reused":true,"lease_expired_without_steps":true,
                "lease_renewed_after_pause":true,"no_request_or_process_replacement":true,
                "readiness_withdrawn":scope_loss_readiness_withdrawn,"api_waited":true,
                "scope_loss_pending_observed":scope_loss_pending_observed,
                "scope_loss_nonblocking":scope_loss_nonblocking,
                "scope_loss_helper_reaped":scope_loss_helper_reaped,
                "scope_loss_no_candidate":scope_loss_no_candidate,
                "scope_loss_no_replacement":scope_loss_no_replacement}
        })
    );
    Ok(())
}
