//! Candidate only: private first reattachment of a failed accepted observation.
//! Kept separate from held activation and accepted-successor ACK contracts.
use super::*;

pub(super) const ENV: &str = "FULLMAG_DEVELOPMENT_TERMINAL_OBSERVATION_STDIN";
const SCHEMA: &str = "fullmag.development-terminal-observation-input.v1";
const PROOF_SCHEMA: &str = "fullmag.development-terminal-observation-proof.v1";

#[derive(Debug, Deserialize)]
#[serde(deny_unknown_fields)]
struct Input {
    schema: String,
    target_build_id: String,
    target_source_sha256: String,
    target_image_id: String,
    launch_path: String,
    launch_sha256: String,
    proof_path: String,
    proof_sha256: String,
}

#[derive(Debug, Deserialize)]
#[serde(deny_unknown_fields)]
struct LaunchBinding {
    schema: String,
    source_proof_sha256: String,
    source_native_config_sha256: String,
    target_build_id: String,
    target_source_sha256: String,
    target_image_id: String,
    native_config_sha256: String,
    terminal_evidence_sha256: String,
}

#[derive(Debug, Deserialize)]
#[serde(deny_unknown_fields)]
struct Proof {
    schema: String,
    original_iteration: String,
    operation_sha256: String,
    preflight_raw_sha256: String,
    drain_sha256: String,
    ready_owner_sha256: String,
    compose_project: String,
    control_volume: String,
    source_root: String,
    image_id: String,
    config_sha256: String,
    run_id: String,
    project_id: String,
    session_id: String,
    session_epoch: u64,
    scene_revision: u64,
    definition_sha256: String,
    intent_sha256: String,
    specification_sha256: String,
    catalog_sha256: String,
    catalog_revision: u64,
    native_config_sha256: String,
    terminal_evidence_sha256: String,
    start_release_sha256: String,
    source_request_id: String,
    source_sha256: String,
}

struct Loaded {
    hydration: SnapshotHydration,
    identity: AcceptedRunReattachIdentity,
}

fn raw(root: &Path, relative: &str, expected: &str) -> Result<Vec<u8>> {
    validate_digest(expected, "terminal observation digest")?;
    let bytes = fullmag_session::repository_path::read_bounded_regular_file(
        root, relative, MAX_CONTROL_RECORD_BYTES,
    )?;
    if fullmag_session::hex_sha256(&bytes) != expected {
        bail!("terminal observation backing bytes differ from their pin");
    }
    Ok(bytes)
}

fn control_json(root: &Path, relative: &str, expected: &str) -> Result<Value> {
    let bytes = raw(root, relative, expected)?;
    let value: Value = serde_json::from_slice(&bytes)?;
    // Managed operation archives are canonical JSON plus LF. This also rejects
    // duplicate keys at any depth; do not impose this on native typed records.
    let mut canonical = fullmag_session::canonical_json_bytes(&value);
    canonical.push(b'\n');
    if bytes != canonical {
        bail!("terminal observation control archive is not canonical JSON plus LF");
    }
    Ok(value)
}

fn string<'a>(value: &'a Value, field: &str) -> Result<&'a str> {
    value.get(field).and_then(Value::as_str)
        .filter(|text| !text.is_empty())
        .with_context(|| format!("terminal observation has no {field}"))
}

fn equal(value: &Value, field: &str, expected: &str) -> Result<()> {
    if string(value, field)? != expected {
        bail!("terminal observation identity differs: {field}");
    }
    Ok(())
}

/// No run, admission, Start or lease transitions. Canonical writer fences may
/// update their own lock-owner metadata. Both the original
/// native drain and exact durable accepted run are independently checked.
fn restore(
    state: &AppState,
    input: Input,
) -> Result<()> {
    if input.schema != SCHEMA {
        bail!("terminal observation input schema differs");
    }
    if std::env::var_os(INPUT_ENV).is_some()
        || std::env::var_os(LEGACY_INPUT_ENV).is_some()
        || std::env::var_os("FULLMAG_STARTUP_ENABLED").is_some_and(|value| value == "1")
    {
        bail!("terminal observation cannot be combined with another restore or startup");
    }
    validate_current_build_identity(&input.target_build_id, &input.target_source_sha256)?;
    validate_digest(&input.proof_sha256, "terminal observation proof")?;
    fullmag_session::repository_path::validate_relative_path(&input.proof_path)?;
    if input.proof_path != format!("terminal-observation/{}/proof.json", input.proof_sha256) {
        bail!("terminal observation proof is outside its private control namespace");
    }
    let proof_root = configured_runtime_control_root()?;
    // Do not resolve original authority documents through the private input root.
    let control_root = Path::new(RUNTIME_PROVENANCE_ROOT);
    let proof: Proof = serde_json::from_slice(&raw(&proof_root, &input.proof_path, &input.proof_sha256)?)?;
    if proof.schema != PROOF_SCHEMA {
        bail!("terminal observation proof schema differs");
    }
    validate_digest(&input.launch_sha256, "terminal observation launch binding")?;
    validate_image_id(&input.target_image_id, "target terminal observation image")?;
    let expected_launch = format!("terminal-observation/{}/launch-{}.json",
        input.proof_sha256, input.launch_sha256);
    if input.launch_path != expected_launch {
        bail!("terminal observation launch binding path differs from its identity");
    }
    let launch: LaunchBinding = serde_json::from_slice(&raw(&proof_root, &input.launch_path, &input.launch_sha256)?)?;
    if launch.schema != "fullmag.terminal-observation-launch.v1"
        || launch.source_proof_sha256 != input.proof_sha256
        || launch.source_native_config_sha256 != proof.native_config_sha256
        || launch.target_build_id != input.target_build_id
        || launch.target_source_sha256 != input.target_source_sha256
        || launch.target_image_id != input.target_image_id
        || launch.terminal_evidence_sha256 != proof.terminal_evidence_sha256
        || std::env::var(CURRENT_RUNTIME_IMAGE_ENV)? != input.target_image_id
    {
        bail!("terminal observation target launch differs from its source proof or current image");
    }
    validate_digest(&launch.native_config_sha256, "target native runtime config")?;
    validate_attempt(&proof.original_iteration, "original terminal observation iteration")?;
    if proof.session_epoch == 0 || proof.catalog_revision == 0 {
        bail!("terminal observation has a zero epoch or catalog revision");
    }
    for id in [&proof.run_id, &proof.project_id, &proof.session_id, &proof.source_request_id] {
        fullmag_session::repository_path::validate_store_id(id)?;
    }
    validate_image_id(&proof.image_id, "terminal observation image")?;
    for (value, name) in [
        (&proof.config_sha256, "config"), (&proof.definition_sha256, "definition"),
        (&proof.specification_sha256, "specification"), (&proof.source_sha256, "source"),
        (&proof.native_config_sha256, "native runtime config"),
        (&proof.terminal_evidence_sha256, "canonical terminal evidence"),
    ] {
        validate_digest(value, name)?;
    }
    for (environment, expected) in [
        (CURRENT_COMPOSE_PROJECT_ENV, proof.compose_project.as_str()),
        (CURRENT_SOURCE_ROOT_ENV, proof.source_root.as_str()),
        (CURRENT_CONTROL_VOLUME_ENV, proof.control_volume.as_str()),
    ] {
        if std::env::var(environment).context("terminal observation Docker binding is absent")? != expected {
            bail!("terminal observation belongs to another Docker scope");
        }
    }

    let base = format!("iteration/attempts/{}", proof.original_iteration);
    let operation = control_json(control_root, &format!("{base}/terminal.json"), &proof.operation_sha256)?;
    raw(control_root, &format!("{base}/receipt.json"), &proof.operation_sha256)?;
    for (field, expected) in [
        ("schema", ACTIVATION_OPERATION_SCHEMA), ("phase", "iteration"), ("state", "succeeded"),
        ("attempt", proof.original_iteration.as_str()), ("compose_project", proof.compose_project.as_str()),
        ("control_volume", proof.control_volume.as_str()), ("config_sha256", proof.config_sha256.as_str()),
    ] {
        equal(&operation, field, expected)?;
    }
    let inputs = operation.get("inputs").context("terminal iteration has no inputs")?;
    equal(inputs, "source_root", &proof.source_root)?;
    equal(inputs, "image_id", &proof.image_id)?;
    equal(inputs, "config_sha256", &proof.config_sha256)?;
    let preflight = control_json(control_root, &format!("{base}/terminal-session-preflight.json"),
        &proof.preflight_raw_sha256)?;
    equal(&operation, "terminal_session_preflight_sha256",
        &fullmag_session::canonical_json_sha256(&preflight))?;
    equal(&preflight, "schema", "fullmag.docker-terminal-session-drain-preflight.v1")?;
    equal(&preflight, "session_id", &proof.session_id)?;
    let old_api = string(&preflight, "api_instance_id")?;
    validate_api_instance_id(old_api, "old terminal observation API")?;
    if old_api == state.request_scope_instance_id {
        bail!("terminal observation reused its historical API instance");
    }
    equal(&preflight, "request_scope_epoch", &format!("{old_api}:{}", proof.session_epoch))?;
    let public_run = preflight.get("run").context("terminal preflight has no run")?;
    equal(public_run, "run_id", &proof.run_id)?;
    equal(public_run, "session_id", &proof.session_id)?;
    equal(public_run, "status", "failed")?;
    let session_started_at = string(public_run, "started_at")?.parse::<u64>()?;
    if session_started_at == 0 {
        bail!("terminal observation has no positive historical session timestamp");
    }
    equal(&preflight, "session_epoch", &format!("{}@{session_started_at}", proof.session_id))?;
    let queue = preflight.get("compute_queue").context("terminal preflight has no queue")?;
    equal(queue, "schema_version", "compute_queue.v1")?;
    if queue.get("next_cursor").is_some_and(|value| !value.is_null()) {
        bail!("terminal preflight queue was paginated");
    }
    let items = queue.get("items").and_then(Value::as_array).context("terminal queue is invalid")?;
    let held = preflight.get("held_run_intent_sha256").and_then(Value::as_object);
    let mut queued_runs = std::collections::BTreeSet::new();
    for item in items {
        equal(item, "state", "accepted")?;
        let id = string(item, "run_id")?;
        fullmag_session::repository_path::validate_store_id(id)?;
        queued_runs.insert(id);
        let pin = held.and_then(|pins| pins.get(id)).and_then(Value::as_str)
            .context("terminal preflight has an unpinned held run")?;
        validate_digest(pin, "historical held run intent")?;
    }
    if held.map_or(0, |pins| pins.len()) != queued_runs.len() {
        bail!("terminal preflight held queue pins differ");
    }
    let runtime = preflight.get("runtime_service").context("terminal preflight has no runtime")?;
    equal(runtime, "schema_version", "application_service_status.v1")?;
    equal(runtime, "state", "ready")?;
    if runtime.get("configured") != Some(&Value::Bool(true)) {
        bail!("terminal preflight runtime was not configured");
    }

    let drain = control_json(control_root, &format!("{base}/backend-drain.json"), &proof.drain_sha256)?;
    equal(&drain, "schema", "fullmag.docker-idle-restart-drain.v1")?;
    equal(&drain, "backend_container_id", string(&operation, "backend_container")?)?;
    validate_container_id(string(&drain, "backend_container_id")?, "historical backend")?;
    let process = drain.get("process_receipt").context("terminal drain has no native process receipt")?;
    let expected_process_fields = [
        "schema", "state", "api_pid", "api_exit_code", "accepted_store",
        "bootstrap", "qualification", "service_owner", "terminal_service_owner",
    ].into_iter().collect::<std::collections::BTreeSet<_>>();
    if process.as_object().context("native process receipt is not an object")?
        .keys().map(String::as_str).collect::<std::collections::BTreeSet<_>>()
        != expected_process_fields
    {
        bail!("terminal observation native drain has partial or unsupported fields");
    }
    equal(process, "schema", "fullmag.docker-process-tree.v1")?;
    equal(process, "state", "drained")?;
    equal(process, "accepted_store", "/state/runs/docker-all/session-store")?;
    require_json_integer(process, "api_exit_code", "terminal native drain")?;
    if process.get("runtime_pid").is_some_and(|value| !value.is_null()) {
        bail!("terminal drain retains a legacy runtime process");
    }
    let mut process_bytes = fullmag_session::canonical_json_bytes(process);
    process_bytes.push(b'\n');
    equal(&drain, "process_receipt_sha256", &fullmag_session::hex_sha256(&process_bytes))?;
    let ready = validate_native_owner(process.get("service_owner").context("terminal drain has no Ready owner")?,
        "historical Ready owner", RuntimeServiceState::Ready, &["running"])?;
    let terminal = validate_native_owner(process.get("terminal_service_owner").context("terminal drain has no Drained owner")?,
        "historical Drained owner", RuntimeServiceState::Drained, &["exited_success"])?;
    if owner_identity_key(&ready) != owner_identity_key(&terminal) {
        bail!("historical owner identity changed during native drain");
    }
    let ready_path = format!("runtime-control/runtime-services/docker-client-{}.json",
        string(&ready, "owner_token")?);
    let ready_bytes = raw(control_root, &ready_path, &proof.ready_owner_sha256)?;
    // Decode the native bytes directly as a typed descriptor first: duplicate
    // fields must not be hidden by an intermediate JSON Value.
    let _: RuntimeServiceOwnerDescriptor = serde_json::from_slice(&ready_bytes)?;
    let archived_ready = validate_native_owner(&serde_json::from_slice(&ready_bytes)?,
        "immutable historical Ready owner", RuntimeServiceState::Ready, &["running"])?;
    if owner_identity_key(&ready) != owner_identity_key(&archived_ready) {
        bail!("historical drain differs from its immutable Ready owner");
    }

    let store_root = state.submit_store_root.as_deref().context("terminal observation has no accepted store")?;
    if store_root != Path::new(string(process, "accepted_store")?) {
        bail!("terminal observation accepted store differs from its native drain");
    }
    let store = fullmag_session::SessionStore::open_existing(store_root)?;
    let run_id = RunId::parse(proof.run_id.clone()).map_err(anyhow::Error::msg)?;
    let project_id = ProjectId::parse(proof.project_id.clone()).map_err(anyhow::Error::msg)?;
    let accepted = fullmag_runtime_control::load_accepted_study_snapshot(&store, &run_id, &project_id)?;
    let specification = &accepted.run.specification;
    if specification.run_id != run_id || specification.snapshot.project_id != project_id
        || specification.snapshot.definition_revision != proof.scene_revision
        || specification.snapshot.definition_sha256 != proof.definition_sha256
        || fullmag_session::canonical_json_sha256(&serde_json::to_value(specification)?) != proof.specification_sha256
    {
        bail!("terminal observation immutable accepted identity differs");
    }
    let live = specification.parameters.get("live_workspace").context("accepted observation has no live binding")?;
    for (field, expected) in [
        ("api_instance_id", old_api), ("session_id", proof.session_id.as_str()),
        ("command_id", proof.source_request_id.as_str()),
        ("request_idempotency_key", proof.source_request_id.as_str()),
        ("startup_source_sha256", proof.source_sha256.as_str()),
    ] {
        equal(live, field, expected)?;
    }
    if live.get("session_epoch").and_then(Value::as_u64) != Some(proof.session_epoch)
        || live.get("scene_revision").and_then(Value::as_u64) != Some(proof.scene_revision)
    {
        bail!("terminal observation live epoch or scene differs");
    }
    let command = live.get("command").context("terminal observation has no immutable command")?;
    equal(command, "kind", "startup_script")?;
    equal(command, "request_id", &proof.source_request_id)?;
    equal(command, "source_sha256", &proof.source_sha256)?;
    let scene = scene_from_definition(&accepted.run.definition_bytes, specification)?;
    if scene.revision != proof.scene_revision {
        bail!("terminal observation scene revision differs");
    }

    // Native RuntimeServiceConfig has its own digest. It is not Compose config.
    let configuration_path = std::env::var_os("FULLMAG_RUNTIME_SERVICE_CONFIG")
        .map(std::path::PathBuf::from).context("terminal observation has no native configuration")?;
    if !configuration_path.is_absolute() || configuration_path.components().any(|part|
        matches!(part, std::path::Component::ParentDir))
    {
        bail!("native configuration path is not canonical");
    }
    let config_parent = configuration_path.parent().context("native configuration has no parent")?;
    let config_name = configuration_path.file_name().and_then(|name| name.to_str())
        .context("native configuration filename is invalid")?;
    let configuration_bytes = raw(config_parent, config_name, &launch.native_config_sha256)?;
    let config: fullmag_session::runtime_service::RuntimeServiceConfig =
        serde_json::from_slice(&configuration_bytes)?;
    config.validate()?;
    if config.store_root != store.root() {
        bail!("native configuration belongs to another accepted store");
    }
    let binding = config.host_execution.context("native configuration has no host binding")?;
    let ledger = fullmag_session::host_resource_ledger::HostResourceLedger::open_for_current_application(
        &binding.ledger_root, binding.policy,
    )?;

    // Runs entirely on spawn_blocking. These guards never await or sleep.
    let _transition = state.current_live_session_transition.try_lock()
        .context("terminal observation transition is busy")?;
    let mut current = state.current_live_state.try_write()
        .context("terminal observation workspace is busy")?;
    let mut rebind = state.accepted_run_reattach_identity.try_write()
        .context("terminal observation rebind authority is busy")?;
    if current.is_some() || rebind.is_some()
        || state.current_live_session_epoch.load(Ordering::Acquire) != 0
    {
        bail!("terminal observation requires a fresh API workspace");
    }
    let fence_run_id = proof.run_id.clone();
    let installed = ledger.with_terminal_run_evidence_fence(&store, &fence_run_id, |host_snapshot, evidence_sha256| {
    if evidence_sha256 != proof.terminal_evidence_sha256 {
        bail!("terminal observation canonical terminal evidence changed");
    }
    let store_id = fullmag_session::host_resource_ledger::HostResourceLedger::store_id(store.root())?;
    for row in &host_snapshot.reservations {
        if row.identity.store_id == store_id
            && (row.identity.run_id == proof.run_id || queued_runs.contains(row.identity.run_id.as_str()))
            && row.state != fullmag_session::host_resource_ledger::HostResourceReservationState::Released
        {
            bail!("observed run or historical held run has a nonreleased host reservation");
        }
    }
    // Canonical host-before-store validation already checked causal admissions,
    // leases, exit/no-spawn evidence and exact host release proofs. No recovery,
    // journal repair or successful scientific result is inferred.
    let relative = format!("runs/{}", proof.run_id);
    raw(store.root(), &format!("{relative}/run_intent.json"), &proof.intent_sha256)?;
    if store.read_run_intent(&proof.run_id)?.as_ref() != Some(&accepted.run.intent) {
        bail!("terminal observation intent changed after immutable load");
    }
    raw(store.root(), &format!("{relative}/run_catalog.json"), &proof.catalog_sha256)?;
    let catalog = store.read_run_catalog(&proof.run_id)?.context("terminal observation catalog is absent")?;
    let terminal_outcome = terminal_catalog_outcome(&catalog)?;
    if catalog.revision != proof.catalog_revision || terminal_outcome != "failed" {
        bail!("terminal observation requires the exact durable Failed catalog");
    }
    raw(store.root(), &format!("{relative}/start_release.json"), &proof.start_release_sha256)?;
    if !store.accepted_run_start_permitted(&proof.run_id)? {
        bail!("failed terminal observation has no canonical Start release");
    }
    let mut planned_inputs = std::collections::BTreeMap::new();
    for step in accepted.lowered.steps.iter().filter(|step| step.enabled
        && matches!(step.status, fullmag_plan::StudyStepLoweringStatus::Planned))
    {
        planned_inputs.insert(fullmag_session::task_id_for_study_step(&proof.run_id, &step.step_id)?,
            fullmag_application::study_task_input_fingerprint(specification, step)?);
    }
    if planned_inputs.len() != catalog.tasks.len() || catalog.tasks.iter().any(|task|
        planned_inputs.get(&task.task_id) != Some(&task.input_fingerprint))
    {
        bail!("terminal observation catalog differs from its immutable Study inputs");
    }
    ensure_terminal_run_has_no_active_leases(&store, &proof.run_id)?;
    // The same SessionStore writer is reentrant on this synchronous thread.
    // Do not open a separate shared transaction beneath the native writer fence.
    let journal = store.read_coordinator_journal(&proof.run_id)?;
    let stage_execution = crate::live_accepted_projection::build_terminal_observation_stage_execution(
        &accepted, &catalog, &journal, terminal_outcome,
    ).map_err(|error| anyhow::anyhow!("terminal stage observation is invalid: {error}"))?;
    // Preserve the explicitly held queue from the historical drain; never
    // turn an old Accepted task into permission to release or replay Start.
    for held_id in queued_runs {
        let pin = held.and_then(|pins| pins.get(held_id)).and_then(Value::as_str)
            .context("held intent pin disappeared")?;
        raw(store.root(), &format!("runs/{held_id}/run_intent.json"), pin)?;
        let held_catalog = store.read_run_catalog(held_id)?
            .context("historical held catalog is missing")?;
        if held_catalog.tasks.is_empty() || store.accepted_run_start_permitted(held_id)?
            || held_catalog.tasks.iter().any(|task| task.lifecycle != FmsTaskLifecycle::Accepted
                || !matches!(&task.readiness, FmsTaskReadiness::Blocked { .. }))
        {
            bail!("historical held queue is no longer held");
        }
        ensure_terminal_run_has_no_active_leases(&store, held_id)?;
    }
    let installed = json!({
        "schema": "fullmag.terminal-observation-restored.v1",
        "api_instance_id": state.request_scope_instance_id,
        "run_id": proof.run_id, "session_id": proof.session_id,
        "session_epoch": proof.session_epoch, "scene_revision": proof.scene_revision,
        "terminal_outcome": "failed", "proof_sha256": input.proof_sha256,
        "launch_sha256": input.launch_sha256,
        "source_image_id": proof.image_id, "source_config_sha256": proof.config_sha256,
        "target_build_id": input.target_build_id,
        "target_source_sha256": input.target_source_sha256,
        "target_image_id": input.target_image_id,
        "native_config_sha256": launch.native_config_sha256,
        "terminal_evidence_sha256": proof.terminal_evidence_sha256,
    });
    let loaded = Loaded {
        identity: AcceptedRunReattachIdentity {
            run_id: proof.run_id.clone(), session_id: proof.session_id.clone(),
            session_epoch: proof.session_epoch, scene_revision: proof.scene_revision,
            proof_sha256: input.proof_sha256.clone(),
        },
        hydration: SnapshotHydration {
            run_id, project_id, specification: specification.clone(), scene,
            logical_session_id: proof.session_id, session_epoch: proof.session_epoch,
            source_request_id: proof.source_request_id, source_sha256: proof.source_sha256,
            startup_provenance_sha256: None, config_sha256: proof.config_sha256,
            proof_sha256: input.proof_sha256.clone(), total_steps: catalog.tasks.len(),
            terminal_outcome: Some(terminal_outcome.into()), preparation_failure: None,
            stage_execution: Some(stage_execution),
            metadata_schema: SCHEMA, started_at_unix_ms: Some(session_started_at),
        },
    };
    let snapshot = build_snapshot_from_hydration(&state.current_workspace_root, &loaded.hydration)?;
    state.current_live_session_epoch.store(loaded.identity.session_epoch, Ordering::Release);
    *rebind = Some(loaded.identity);
    *current = Some(snapshot);
    Ok(installed)
    })?;
    // Only publish after the real in-process installation. Never create an
    // activation/predecessor ACK or a numerical/native-exit receipt.
    validate_api_instance_id(&state.request_scope_instance_id, "restored API instance")?;
    let relative = format!("terminal-observation/{}/installed-{}.json",
        input.proof_sha256, state.request_scope_instance_id);
    let mut bytes = fullmag_session::canonical_json_bytes(&installed);
    bytes.push(b'\n');
    publish_immutable_restore_bytes(&proof_root, &relative, &bytes)?;
    Ok(())
}

pub(super) async fn restore_before_listen(state: &Arc<AppState>) -> Result<(), String> {
    if std::env::var_os(ENV).as_deref() != Some(std::ffi::OsStr::new("1")) {
        return Err("invalid terminal observation stdin switch".into());
    }
    // Reuse the original input-size/timeout limit, but a separate strict type.
    let mut bytes = Vec::new();
    let input = tokio::io::stdin();
    use tokio::io::AsyncReadExt;
    tokio::time::timeout(Duration::from_secs(5), input.take((MAX_INPUT_BYTES + 1) as u64)
        .read_to_end(&mut bytes)).await
        .map_err(|_| "terminal observation input timed out".to_string())?
        .map_err(|error| format!("terminal observation input failed: {error}"))?;
    if bytes.len() > MAX_INPUT_BYTES {
        return Err("terminal observation input exceeds its bound".into());
    }
    let input: Input = serde_json::from_slice(&bytes)
        .map_err(|error| format!("terminal observation input is invalid: {error}"))?;
    let state_for_load = Arc::clone(state);
    tokio::task::spawn_blocking(move || restore(&state_for_load, input))
        .await.map_err(|error| format!("terminal observation task failed: {error}"))?
        .map_err(|error| format!("terminal observation validation failed: {error:#}"))
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn private_input_rejects_unknown_and_incomplete_controls() {
        assert!(serde_json::from_value::<Input>(json!({"schema":SCHEMA})).is_err());
        assert!(serde_json::from_value::<Input>(json!({
            "schema":SCHEMA, "target_build_id":"a".repeat(40),
            "target_source_sha256":"b".repeat(64),
            "target_image_id":format!("sha256:{}", "d".repeat(64)),
            "launch_path":"terminal-observation/proof/launch.json",
            "launch_sha256":"e".repeat(64),
            "proof_path":"terminal-observation/proof.json", "proof_sha256":"c".repeat(64),
            "force":true,
        })).is_err());
    }
}
