//! Candidate only: private first reattachment of a terminal accepted observation.
//! Kept separate from held activation and accepted-successor ACK contracts.
use super::*;

pub(super) const ENV: &str = "FULLMAG_DEVELOPMENT_TERMINAL_OBSERVATION_STDIN";
const SCHEMA: &str = "fullmag.development-terminal-observation-input.v1";
const PROOF_SCHEMA: &str = "fullmag.development-terminal-observation-proof.v1";
const COMPUTE_PROOF_SCHEMA: &str = "fullmag.development-terminal-observation-proof.v2";

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
    start_release_sha256: Option<String>,
    source_request_id: Option<String>,
    source_sha256: Option<String>,
    compute: Option<ComputeProof>,
}

#[derive(Debug, Deserialize)]
#[serde(deny_unknown_fields)]
struct ComputeProof {
    command_id: String,
    receipt_sha256: String,
}

#[derive(Debug, Deserialize)]
#[serde(deny_unknown_fields)]
struct HistoricalRuntimeAnnotation {
    schema: String,
    api_instance_id: String,
    run_id: String,
    session_id: String,
    proof_sha256: String,
    launch_sha256: String,
    installed_relative: String,
    installed_sha256: String,
    target_build_id: String,
    target_source_sha256: String,
    target_image_id: String,
}

struct Loaded {
    hydration: SnapshotHydration,
    identity: AcceptedRunReattachIdentity,
}

struct TerminalInstallation {
    proof_root: std::path::PathBuf,
    proof_sha256: String,
    receipt: Value,
    outcome: String,
    command: Option<crate::types::TrackedCommandRecord>,
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

fn validate_source(
    proof: &Proof,
    intent: &fullmag_session::FmsRunIntent,
    specification: &RunSpecification,
    live: &Value,
) -> Result<(String, String)> {
    let command = live.get("command").context("terminal observation has no immutable command")?;
    match (
        proof.schema.as_str(), proof.start_release_sha256.as_deref(),
        proof.source_request_id.as_deref(), proof.source_sha256.as_deref(), proof.compute.as_ref(),
    ) {
        (PROOF_SCHEMA, Some(release_sha), Some(source_id), Some(source_sha), None) => {
            validate_digest(release_sha, "terminal observation Start release")?;
            fullmag_session::repository_path::validate_store_id(source_id)?;
            validate_digest(source_sha, "terminal observation startup source")?;
            for (field, expected) in [
                ("command_id", source_id), ("request_idempotency_key", source_id),
                ("startup_source_sha256", source_sha),
            ] {
                equal(live, field, expected)?;
            }
            equal(command, "kind", "startup_script")?;
            equal(command, "request_id", source_id)?;
            equal(command, "source_sha256", source_sha)?;
            Ok((source_id.into(), source_sha.into()))
        }
        (COMPUTE_PROOF_SCHEMA, None, None, None, Some(compute)) => {
            validate_digest(&compute.receipt_sha256, "terminal observation Compute receipt")?;
            fullmag_session::repository_path::validate_store_id(&compute.command_id)?;
            let manual = specification.parameters.get(fullmag_session::ACCEPTED_RUN_START_POLICY_KEY)
                .map(fullmag_session::accepted_run_start_policy_is_manual).transpose()?.unwrap_or(false);
            if manual || live.get("startup_source_sha256").is_some_and(|value| !value.is_null()) {
                bail!("terminal observation Compute must have its automatic Start binding");
            }
            let receipt = crate::live_compute_request::receipt_from_intent(intent)
                .map_err(|error| anyhow::anyhow!("{error}"))?
                .context("terminal observation Compute has no durable request receipt")?;
            let kind = string(command, "kind")?;
            let value = live.get("request_receipt").context("terminal observation Compute receipt is absent")?;
            if !matches!(kind, "solve" | "run" | "relax")
                || receipt.command_kind.as_deref() != Some(kind)
                || receipt.command_id != compute.command_id
                || receipt.client_intent_id.as_deref() != command.get("client_intent_id").and_then(Value::as_str)
                || receipt.requested_target.is_none()
                || fullmag_session::canonical_json_sha256(value) != compute.receipt_sha256
            {
                bail!("terminal observation Compute receipt differs from its command or proof");
            }
            equal(live, "request_idempotency_key", &receipt.key_sha256)?;
            equal(command, "command_id", &compute.command_id)?;
            Ok((receipt.request_id.unwrap_or(receipt.command_id), receipt.request_sha256))
        }
        _ => bail!("terminal observation source proof schema or fields differ"),
    }
}

fn validate_historical_terminal_observation_annotation(
    control_root: &Path,
    annotation: &Value,
    compose_project: &str,
    control_volume: &str,
    source_root: &str,
    operation_image_id: &str,
    ready_owner: &Value,
) -> Result<()> {
    let annotation: HistoricalRuntimeAnnotation = serde_json::from_value(annotation.clone())
        .context("historical terminal observation annotation shape differs")?;
    if annotation.schema != "fullmag.terminal-observation-runtime.v1" {
        bail!("historical terminal observation annotation schema differs");
    }
    validate_api_instance_id(&annotation.api_instance_id, "historical terminal observation API")?;
    for (id, label) in [
        (&annotation.run_id, "historical terminal observation run"),
        (&annotation.session_id, "historical terminal observation session"),
    ] {
        fullmag_session::repository_path::validate_store_id(id)
            .with_context(|| format!("{label} identity is invalid"))?;
    }
    for (digest, label) in [
        (&annotation.proof_sha256, "historical terminal observation proof"),
        (&annotation.launch_sha256, "historical terminal observation launch"),
        (&annotation.installed_sha256, "historical terminal observation installed receipt"),
        (&annotation.target_source_sha256, "historical terminal observation target source"),
    ] {
        validate_digest(digest, label)?;
    }
    validate_commit(
        &annotation.target_build_id,
        "historical terminal observation target build",
    )?;
    validate_image_id(&annotation.target_image_id, "historical terminal observation target image")?;
    if annotation.target_build_id != string(ready_owner, "build_commit")?
        || annotation.target_source_sha256 != string(ready_owner, "build_snapshot")?
        || annotation.target_image_id != operation_image_id
    {
        bail!("historical terminal observation target differs from the drained owner or operation image");
    }
    validate_image_id(operation_image_id, "terminal observation operation image")?;

    let archive = format!("runtime-control/terminal-observation/{}/", annotation.proof_sha256);
    let installed_relative = format!(
        "terminal-observation/{}/installed-{}.json",
        annotation.proof_sha256, annotation.api_instance_id
    );
    if annotation.installed_relative != installed_relative {
        bail!("historical terminal observation installed path differs");
    }

    let prior_proof_value = control_json(
        control_root,
        &format!("{archive}proof.json"),
        &annotation.proof_sha256,
    )?;
    let prior_proof: Proof = serde_json::from_value(prior_proof_value)
        .context("historical terminal observation proof shape differs")?;
    if !matches!(prior_proof.schema.as_str(), PROOF_SCHEMA | COMPUTE_PROOF_SCHEMA)
        || prior_proof.run_id != annotation.run_id
        || prior_proof.session_id != annotation.session_id
        || prior_proof.session_epoch == 0
        || prior_proof.compose_project != compose_project
        || prior_proof.control_volume != control_volume
        || prior_proof.source_root != source_root
    {
        bail!("historical terminal observation proof identity or scope differs");
    }
    fullmag_session::repository_path::validate_store_id(&prior_proof.run_id)?;
    fullmag_session::repository_path::validate_store_id(&prior_proof.session_id)?;
    validate_image_id(&prior_proof.image_id, "historical terminal observation source image")?;
    for (digest, label) in [
        (&prior_proof.config_sha256, "historical terminal observation source config"),
        (&prior_proof.native_config_sha256, "historical terminal observation source native config"),
        (&prior_proof.terminal_evidence_sha256, "historical terminal observation terminal evidence"),
    ] {
        validate_digest(digest, label)?;
    }

    let launch_relative = format!("{archive}launch-{}.json", annotation.launch_sha256);
    let launch_value = control_json(control_root, &launch_relative, &annotation.launch_sha256)?;
    let launch: LaunchBinding = serde_json::from_value(launch_value)
        .context("historical terminal observation launch shape differs")?;
    validate_digest(&launch.native_config_sha256, "historical terminal observation target native config")?;
    if launch.schema != "fullmag.terminal-observation-launch.v1"
        || launch.source_proof_sha256 != annotation.proof_sha256
        || launch.source_native_config_sha256 != prior_proof.native_config_sha256
        || launch.target_build_id != annotation.target_build_id
        || launch.target_source_sha256 != annotation.target_source_sha256
        || launch.target_image_id != annotation.target_image_id
        || launch.terminal_evidence_sha256 != prior_proof.terminal_evidence_sha256
    {
        bail!("historical terminal observation launch binding differs");
    }

    let installed_value = control_json(
        control_root,
        &format!("runtime-control/{installed_relative}"),
        &annotation.installed_sha256,
    )?;
    let terminal_outcome = string(&installed_value, "terminal_outcome")?;
    if !matches!(terminal_outcome, "failed" | "completed") {
        bail!("historical terminal observation installed outcome differs");
    }
    let expected_installed = json!({
        "schema": "fullmag.terminal-observation-restored.v1",
        "api_instance_id": &annotation.api_instance_id,
        "run_id": &prior_proof.run_id,
        "session_id": &prior_proof.session_id,
        "session_epoch": prior_proof.session_epoch,
        "scene_revision": prior_proof.scene_revision,
        "terminal_outcome": terminal_outcome,
        "proof_sha256": &annotation.proof_sha256,
        "launch_sha256": &annotation.launch_sha256,
        "source_image_id": &prior_proof.image_id,
        "source_config_sha256": &prior_proof.config_sha256,
        "target_build_id": &annotation.target_build_id,
        "target_source_sha256": &annotation.target_source_sha256,
        "target_image_id": &annotation.target_image_id,
        "native_config_sha256": &launch.native_config_sha256,
        "terminal_evidence_sha256": &prior_proof.terminal_evidence_sha256,
    });
    if installed_value != expected_installed {
        bail!("historical terminal observation installed receipt differs");
    }
    Ok(())
}

fn validate_native_process_receipt_fields(process: &Value) -> Result<()> {
    let mut expected = [
        "schema", "state", "api_pid", "api_exit_code", "accepted_store",
        "bootstrap", "qualification", "service_owner", "terminal_service_owner",
    ]
    .into_iter()
    .map(str::to_string)
    .collect::<std::collections::BTreeSet<_>>();
    match (
        process.get("container_recovery"),
        process.get("container_recovery_authorization"),
    ) {
        (None, None) => {}
        (Some(_), Some(_)) => {
            expected.extend([
                "container_recovery".to_string(),
                "container_recovery_authorization".to_string(),
            ]);
        }
        _ => bail!("historical recovery annotations are incomplete"),
    }
    if process.get("terminal_observation").is_some() {
        expected.insert("terminal_observation".to_string());
    }
    let actual = process
        .as_object()
        .context("native process receipt is not an object")?
        .keys()
        .cloned()
        .collect::<std::collections::BTreeSet<_>>();
    if actual != expected {
        bail!("terminal observation native drain has partial or unsupported fields");
    }
    Ok(())
}

/// No run, admission, Start or lease transitions. Canonical writer fences may
/// update their own lock-owner metadata. Both the original
/// native drain and exact durable accepted run are independently checked.
fn restore(
    state: &AppState,
    input: Input,
) -> Result<TerminalInstallation> {
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
    if !matches!(proof.schema.as_str(), PROOF_SCHEMA | COMPUTE_PROOF_SCHEMA) {
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
    for id in [&proof.run_id, &proof.project_id, &proof.session_id] {
        fullmag_session::repository_path::validate_store_id(id)?;
    }
    validate_image_id(&proof.image_id, "terminal observation image")?;
    for (value, name) in [
        (&proof.config_sha256, "config"), (&proof.definition_sha256, "definition"),
        (&proof.specification_sha256, "specification"),
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
    let expected_outcome = match string(public_run, "status")? {
        "failed" => "failed",
        "completed" => "completed",
        _ => bail!("terminal observation public run status is unsupported"),
    };
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
    let historical_recovery = process.get("container_recovery");
    let historical_authorization = process.get("container_recovery_authorization");
    match (historical_recovery, historical_authorization) {
        (None, None) => {}
        (Some(recovered), Some(authorized)) => {
            // These annotations bind only a completed historical recovery;
            // they cannot replace the current owner/drain or terminal fence.
            recovered.as_object().context("historical recovery is not an object")?;
            authorized.as_object().context("historical recovery authorization is not an object")?;
            equal(recovered, "schema_version", "runtime_service_container_recovery.v1")?;
            equal(authorized, "schema_version", "fullmag.docker-container-recovery-authorization.v1")?;
            equal(recovered, "status", "recovered")?;
            if !matches!(string(recovered, "outcome")?,
                "retained_attempt_history_recovered" | "retained_manual_held_runs_recovered"
                | "retained_terminal_runs_recovered" | "empty_namespace_recovered"
                | "retained_cancelled_runs_recovered") {
                bail!("historical recovery outcome is unsupported");
            }
            fullmag_session::repository_path::validate_store_id(string(recovered, "request_id")?)?;
            for key in ["request_id", "request_sha256", "config_sha256", "attestation_sha256", "owner_sha256_after"] {
                let value = string(recovered, key)?;
                equal(authorized, key, value)?;
                if key != "request_id" { validate_digest(value, "historical recovery binding")?; }
            }
        }
        _ => bail!("historical recovery annotations are incomplete"),
    }
    let historical_terminal_observation = process.get("terminal_observation");
    validate_native_process_receipt_fields(process)?;
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
    if let Some(annotation) = historical_terminal_observation {
        validate_historical_terminal_observation_annotation(
            control_root,
            annotation,
            &proof.compose_project,
            &proof.control_volume,
            &proof.source_root,
            &proof.image_id,
            &ready,
        )?;
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
    equal(live, "api_instance_id", old_api)?;
    equal(live, "session_id", &proof.session_id)?;
    if live.get("session_epoch").and_then(Value::as_u64) != Some(proof.session_epoch)
        || live.get("scene_revision").and_then(Value::as_u64) != Some(proof.scene_revision)
    {
        bail!("terminal observation live epoch or scene differs");
    }
    let (source_request_id, source_sha256) = validate_source(&proof, &accepted.run.intent, specification, live)?;
    if proof.schema == COMPUTE_PROOF_SCHEMA
        && preflight.get("scene_revision").and_then(Value::as_u64) != Some(proof.scene_revision)
    {
        bail!("terminal observation would replace a newer editable scene");
    }
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
    let (receipt, command, outcome) = ledger.with_terminal_run_evidence_fence(&store, &fence_run_id, |host_snapshot, evidence_sha256| {
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
    if catalog.revision != proof.catalog_revision || terminal_outcome != expected_outcome {
        bail!("terminal observation catalog differs from the hash-bound public run outcome");
    }
    if let Some(release_sha256) = proof.start_release_sha256.as_deref() {
        raw(store.root(), &format!("{relative}/start_release.json"), release_sha256)?;
    }
    let release_present = store.read_accepted_run_start_release(&proof.run_id)?.is_some();
    if release_present != proof.start_release_sha256.is_some()
        || !store.accepted_run_start_permitted(&proof.run_id)?
    {
        bail!("terminal observation Start evidence differs from its immutable policy");
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
    let command = crate::live_compute_request::accepted_command_readback(&store, &accepted.run.intent, terminal_outcome)
        .map_err(|error| anyhow::anyhow!("terminal Compute journal readback: {error}"))?;
    let installed = json!({
        "schema": "fullmag.terminal-observation-restored.v1",
        "api_instance_id": state.request_scope_instance_id,
        "run_id": proof.run_id, "session_id": proof.session_id,
        "session_epoch": proof.session_epoch, "scene_revision": proof.scene_revision,
        "terminal_outcome": terminal_outcome, "proof_sha256": input.proof_sha256,
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
            source_request_id, source_sha256,
            startup_provenance_sha256: None, config_sha256: proof.config_sha256,
            proof_sha256: input.proof_sha256.clone(), total_steps: catalog.tasks.len(),
            terminal_outcome: Some(terminal_outcome.into()), preparation_failure: None,
            stage_execution: Some(stage_execution),
            metadata_schema: SCHEMA, started_at_unix_ms: Some(session_started_at),
        },
    };
    let mut snapshot = build_snapshot_from_hydration(&state.current_workspace_root, &loaded.hydration)?;
    if proof.schema == COMPUTE_PROOF_SCHEMA {
        snapshot.session.status = "awaiting_command".into();
        crate::session::refresh_runtime_status(&mut snapshot);
    }
    state.current_live_session_epoch.store(loaded.identity.session_epoch, Ordering::Release);
    *rebind = Some(loaded.identity);
    *current = Some(snapshot);
    Ok((installed, command, terminal_outcome.to_owned()))
    })?;
    Ok(TerminalInstallation { proof_root, proof_sha256: input.proof_sha256, receipt, outcome, command })
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
    let restored = tokio::task::spawn_blocking(move || restore(&state_for_load, input))
        .await.map_err(|error| format!("terminal observation task failed: {error}"))?
        .map_err(|error| format!("terminal observation validation failed: {error:#}"))?;

    let _transition = state.current_live_session_transition.lock().await;
    let snapshot = state.current_live_state.read().await.as_ref().cloned()
        .ok_or_else(|| "terminal observation lost its installed workspace".to_owned())?;
    crate::live_command_journal::recover(state, &snapshot)
        .await.map_err(|error| format!("terminal observation command journal recovery failed: {error}"))?;
    if let Some(command) = restored.command {
        crate::live_command_journal::project_terminal_compute(state, &snapshot, command, &restored.outcome)
            .await.map_err(|error| format!("terminal observation command projection failed: {error}"))?;
    }
    drop(_transition);

    // Publish only after both read models are installed. No Start, native
    // lease, or numerical receipt is written by this path.
    validate_api_instance_id(&state.request_scope_instance_id, "restored API instance")
        .map_err(|error| error.to_string())?;
    let relative = format!("terminal-observation/{}/installed-{}.json",
        restored.proof_sha256, state.request_scope_instance_id);
    let mut bytes = fullmag_session::canonical_json_bytes(&restored.receipt);
    bytes.push(b'\n');
    tokio::task::spawn_blocking(move || publish_immutable_restore_bytes(&restored.proof_root, &relative, &bytes))
        .await.map_err(|error| format!("terminal observation receipt task failed: {error}"))?
        .map(|_| ())
        .map_err(|error| format!("terminal observation receipt publication failed: {error:#}"))
}

#[cfg(test)]
mod tests {
    use super::*;

    const HISTORICAL_COMPOSE: &str = "fullmag-p22";
    const HISTORICAL_CONTROL_VOLUME: &str = "fullmag-p22-control";
    const HISTORICAL_SOURCE_ROOT: &str = "/workspace/fullmag";
    const HISTORICAL_API_ID: &str = "12345678-1234-4234-8234-123456789abc";

    fn canonical_record(value: &Value) -> Vec<u8> {
        let mut bytes = fullmag_session::canonical_json_bytes(value);
        bytes.push(b'\n');
        bytes
    }

    fn write_record(root: &Path, relative: &str, bytes: &[u8]) {
        let path = root.join(relative);
        std::fs::create_dir_all(path.parent().expect("record parent")).unwrap();
        std::fs::write(path, bytes).unwrap();
    }

    fn historical_annotation_fixture(
        proof_schema: &str,
    ) -> (tempfile::TempDir, Value, Value, String) {
        let root = tempfile::tempdir().unwrap();
        let source_image = format!("sha256:{}", "c".repeat(64));
        let operation_image = format!("sha256:{}", "d".repeat(64));
        let target_build_id = "a".repeat(40);
        let target_source_sha256 = "b".repeat(64);
        let source_config_sha256 = "3".repeat(64);
        let source_native_config_sha256 = "4".repeat(64);
        let terminal_evidence_sha256 = "5".repeat(64);
        let target_native_config_sha256 = "6".repeat(64);
        let mut proof = json!({
            "schema": proof_schema,
            "original_iteration": "0123456789abcdef0123456789abcdef",
            "operation_sha256": "7".repeat(64),
            "preflight_raw_sha256": "8".repeat(64),
            "drain_sha256": "9".repeat(64),
            "ready_owner_sha256": "a".repeat(64),
            "compose_project": HISTORICAL_COMPOSE,
            "control_volume": HISTORICAL_CONTROL_VOLUME,
            "source_root": HISTORICAL_SOURCE_ROOT,
            "image_id": source_image,
            "config_sha256": source_config_sha256,
            "run_id": "historical-run-6c24",
            "project_id": "historical-project",
            "session_id": "historical-session-275",
            "session_epoch": 275,
            "scene_revision": 6,
            "definition_sha256": "1".repeat(64),
            "intent_sha256": "2".repeat(64),
            "specification_sha256": "3".repeat(64),
            "catalog_sha256": "4".repeat(64),
            "catalog_revision": 3,
            "native_config_sha256": source_native_config_sha256,
            "terminal_evidence_sha256": terminal_evidence_sha256,
        });
        if proof_schema == PROOF_SCHEMA {
            proof["start_release_sha256"] = json!("5".repeat(64));
            proof["source_request_id"] = json!("historical-source-request");
            proof["source_sha256"] = json!("6".repeat(64));
        } else {
            proof["compute"] = json!({
                "command_id": "historical-compute-command",
                "receipt_sha256": "7".repeat(64),
            });
        }
        let proof_bytes = canonical_record(&proof);
        let proof_sha256 = fullmag_session::hex_sha256(&proof_bytes);
        let archive = format!("runtime-control/terminal-observation/{proof_sha256}");
        write_record(root.path(), &format!("{archive}/proof.json"), &proof_bytes);

        let launch = json!({
            "schema": "fullmag.terminal-observation-launch.v1",
            "source_proof_sha256": proof_sha256,
            "source_native_config_sha256": source_native_config_sha256,
            "target_build_id": target_build_id,
            "target_source_sha256": target_source_sha256,
            "target_image_id": operation_image,
            "native_config_sha256": target_native_config_sha256,
            "terminal_evidence_sha256": terminal_evidence_sha256,
        });
        let launch_bytes = canonical_record(&launch);
        let launch_sha256 = fullmag_session::hex_sha256(&launch_bytes);
        write_record(
            root.path(),
            &format!("{archive}/launch-{launch_sha256}.json"),
            &launch_bytes,
        );

        let installed_relative = format!(
            "terminal-observation/{proof_sha256}/installed-{HISTORICAL_API_ID}.json"
        );
        let installed = json!({
            "schema": "fullmag.terminal-observation-restored.v1",
            "api_instance_id": HISTORICAL_API_ID,
            "run_id": "historical-run-6c24",
            "session_id": "historical-session-275",
            "session_epoch": 275,
            "scene_revision": 6,
            "terminal_outcome": "completed",
            "proof_sha256": proof_sha256,
            "launch_sha256": launch_sha256,
            "source_image_id": source_image,
            "source_config_sha256": source_config_sha256,
            "target_build_id": target_build_id,
            "target_source_sha256": target_source_sha256,
            "target_image_id": operation_image,
            "native_config_sha256": target_native_config_sha256,
            "terminal_evidence_sha256": terminal_evidence_sha256,
        });
        let installed_bytes = canonical_record(&installed);
        let installed_sha256 = fullmag_session::hex_sha256(&installed_bytes);
        write_record(
            root.path(),
            &format!("runtime-control/{installed_relative}"),
            &installed_bytes,
        );

        let annotation = json!({
            "schema": "fullmag.terminal-observation-runtime.v1",
            "api_instance_id": HISTORICAL_API_ID,
            "run_id": "historical-run-6c24",
            "session_id": "historical-session-275",
            "proof_sha256": proof_sha256,
            "launch_sha256": launch_sha256,
            "installed_relative": installed_relative,
            "installed_sha256": installed_sha256,
            "target_build_id": target_build_id,
            "target_source_sha256": target_source_sha256,
            "target_image_id": operation_image,
        });
        let ready_owner = json!({
            "build_commit": target_build_id,
            "build_snapshot": target_source_sha256,
        });
        (root, annotation, ready_owner, operation_image)
    }

    fn validate_fixture(
        root: &Path,
        annotation: &Value,
        ready_owner: &Value,
        operation_image: &str,
    ) -> Result<()> {
        validate_historical_terminal_observation_annotation(
            root,
            annotation,
            HISTORICAL_COMPOSE,
            HISTORICAL_CONTROL_VOLUME,
            HISTORICAL_SOURCE_ROOT,
            operation_image,
            ready_owner,
        )
    }

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

    #[test]
    fn process_receipt_allows_only_supported_optional_annotation_shapes() {
        let base = json!({
            "schema": "fullmag.docker-process-tree.v1",
            "state": "drained",
            "api_pid": 123,
            "api_exit_code": 0,
            "accepted_store": "/state/runs/docker-all/session-store",
            "bootstrap": null,
            "qualification": null,
            "service_owner": {},
            "terminal_service_owner": {},
        });
        assert!(validate_native_process_receipt_fields(&base).is_ok());

        let mut annotation_only = base.clone();
        annotation_only["terminal_observation"] = json!({});
        assert!(validate_native_process_receipt_fields(&annotation_only).is_ok());

        let mut with_recovery = base.clone();
        with_recovery["container_recovery"] = json!({});
        with_recovery["container_recovery_authorization"] = json!({});
        assert!(validate_native_process_receipt_fields(&with_recovery).is_ok());

        with_recovery["terminal_observation"] = json!({});
        assert!(validate_native_process_receipt_fields(&with_recovery).is_ok());

        let mut partial_recovery = base.clone();
        partial_recovery["container_recovery"] = json!({});
        assert!(validate_native_process_receipt_fields(&partial_recovery).is_err());

        let mut unknown = base;
        unknown["unrecognized"] = json!(true);
        assert!(validate_native_process_receipt_fields(&unknown).is_err());
    }

    #[test]
    fn historical_terminal_observation_annotation_accepts_producer_cas_bindings() {
        let (root, annotation, ready_owner, operation_image) =
            historical_annotation_fixture(PROOF_SCHEMA);
        validate_fixture(root.path(), &annotation, &ready_owner, &operation_image)
            .expect("known historical terminal observation receipt");
        let proof_path = root.path().join(format!(
            "runtime-control/terminal-observation/{}/proof.json",
            annotation["proof_sha256"].as_str().unwrap(),
        ));
        let prior_proof: Value = serde_json::from_slice(&std::fs::read(proof_path).unwrap()).unwrap();
        assert_ne!(
            prior_proof["image_id"].as_str(),
            annotation["target_image_id"].as_str(),
            "target image is pinned to the operation while source proof image may be older"
        );
        assert_eq!(annotation["target_image_id"].as_str(), Some(operation_image.as_str()));
    }

    #[test]
    fn historical_compute_terminal_observation_annotation_accepts_producer_cas_bindings() {
        let (root, annotation, ready_owner, operation_image) =
            historical_annotation_fixture(COMPUTE_PROOF_SCHEMA);
        validate_fixture(root.path(), &annotation, &ready_owner, &operation_image)
            .expect("known historical Compute terminal observation receipt");
        let proof_path = root.path().join(format!(
            "runtime-control/terminal-observation/{}/proof.json",
            annotation["proof_sha256"].as_str().unwrap(),
        ));
        let prior_proof: Value = serde_json::from_slice(&std::fs::read(proof_path).unwrap()).unwrap();
        assert_eq!(prior_proof["schema"], COMPUTE_PROOF_SCHEMA);
        assert_eq!(prior_proof["compute"]["command_id"], "historical-compute-command");
        assert!(prior_proof.get("start_release_sha256").is_none());
        assert!(prior_proof.get("source_request_id").is_none());
        assert!(prior_proof.get("source_sha256").is_none());
    }

    #[test]
    fn historical_terminal_observation_annotation_rejects_partial_tampered_and_foreign_pins() {
        let (root, annotation, ready_owner, operation_image) =
            historical_annotation_fixture(COMPUTE_PROOF_SCHEMA);

        let mut unknown = annotation.clone();
        unknown["unexpected"] = json!(true);
        assert!(validate_fixture(root.path(), &unknown, &ready_owner, &operation_image).is_err());

        let mut partial = annotation.clone();
        partial.as_object_mut().unwrap().remove("installed_relative");
        assert!(validate_fixture(root.path(), &partial, &ready_owner, &operation_image).is_err());

        let mut foreign_session = annotation.clone();
        foreign_session["session_id"] = json!("a-different-session");
        assert!(validate_fixture(root.path(), &foreign_session, &ready_owner, &operation_image).is_err());

        for (field, value) in [
            ("target_build_id", json!("f".repeat(40))),
            ("target_source_sha256", json!("e".repeat(64))),
            ("target_image_id", json!(format!("sha256:{}", "e".repeat(64)))),
        ] {
            let mut foreign_pin = annotation.clone();
            foreign_pin[field] = value;
            assert!(validate_fixture(root.path(), &foreign_pin, &ready_owner, &operation_image).is_err());
        }

        let installed_relative = annotation["installed_relative"].as_str().unwrap();
        std::fs::write(
            root.path().join("runtime-control").join(installed_relative),
            b"tampered\n",
        )
        .unwrap();
        assert!(validate_fixture(root.path(), &annotation, &ready_owner, &operation_image).is_err());
    }
}
