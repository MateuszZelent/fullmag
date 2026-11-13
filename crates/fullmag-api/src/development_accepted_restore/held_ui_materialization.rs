//! Private pre-listen restoration of one accepted live Compute whose durable
//! RunIntent exists but whose catalog/frontier was not materialized before the
//! former API process stopped. This path never creates a new intent or command.
use super::*;

pub(super) const ENV: &str = "FULLMAG_DEVELOPMENT_HELD_UI_MATERIALIZATION_STDIN";
const REQUEST_SCHEMA: &str = "fullmag.held-ui-materialization-request.v1";
const INPUT_SCHEMA: &str = "fullmag.development-held-ui-materialization-restore.v1";
const LAUNCH_SCHEMA: &str = "fullmag.held-ui-materialization-launch.v1";
const ACK_SCHEMA: &str = "fullmag.development-held-ui-materialization-restore-ack.v1";
const MAX_INPUT_BYTES: usize = 64 * 1024;
const MAX_PROOF_BYTES: usize = 8 * 1024 * 1024;
const PROOF_DIR: &str = "held-ui-materialization";
const STOP_TERMINAL_ROOT: &str = "/opt/fullmag/control";
const STOP_TERMINAL_PREFIX: &str = "held-ui-materialization-stop/attempts/";

#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
#[serde(deny_unknown_fields)]
struct Plan {
    attempt: String,
    maintenance_request_id: String,
    plan_sha256: String,
}

#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
#[serde(deny_unknown_fields)]
struct TargetRuntime {
    build_id: String,
    source_sha256: String,
    image_id: String,
    config_sha256: String,
    accepted_store_binding: String,
}

#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
#[serde(deny_unknown_fields)]
struct SourceScope {
    backend_container_id: String,
    backend_started_at: String,
    compose_project: String,
    control_volume: String,
    frontend_container_id: String,
    frontend_started_at: String,
    namespace: String,
    namespace_registry_sha256: Option<String>,
    runtime_config_sha256: String,
    source_root: String,
    state_root_sha256: String,
}

#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
#[serde(deny_unknown_fields)]
struct RecordRef {
    path: String,
    sha256: String,
}

#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
#[serde(deny_unknown_fields)]
struct StopAuthority {
    api_quiescence: RecordRef,
    inventory: RecordRef,
    native_drain: RecordRef,
    preflight: RecordRef,
    stop_attempt: String,
    terminal: RecordRef,
}

#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
#[serde(deny_unknown_fields)]
struct AcceptedPins {
    accepted_scene_sha256: String,
    client_intent_id: String,
    command_id: String,
    command_kind: String,
    definition_sha256: String,
    execution_input_sha256: String,
    old_api_instance_id: String,
    old_request_scope_epoch: String,
    project_id: String,
    request_id: String,
    request_key_sha256: String,
    request_receipt_sha256: String,
    request_sha256: String,
    run_id: String,
    run_intent_payload_sha256: String,
    run_intent_sha256: String,
    session_created_at_unix_ms: u64,
    scene_revision: u64,
    session_epoch: u64,
    session_id: String,
    study_sha256: String,
}

#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
#[serde(deny_unknown_fields)]
pub(super) struct Input {
    accepted: AcceptedPins,
    launch_id: String,
    plan: Plan,
    schema: String,
    source_scope: SourceScope,
    stop_authority: StopAuthority,
    target_runtime: TargetRuntime,
}

#[derive(Debug, Deserialize)]
#[serde(deny_unknown_fields)]
struct PythonRequest {
    accepted: AcceptedPins,
    plan: Plan,
    schema: String,
    source_scope: SourceScope,
    stop_authority: StopAuthority,
}

#[derive(Debug, Deserialize)]
#[serde(deny_unknown_fields)]
struct LaunchRecord {
    input: Input,
    input_sha256: String,
    launch_id: String,
    request_path: String,
    request_sha256: String,
    schema: String,
}

#[derive(Debug, Clone, Serialize, Deserialize)]
#[serde(deny_unknown_fields)]
struct RestoreAck {
    accepted_store_binding: String,
    api_instance_id: String,
    catalog_sha256: String,
    command_id: String,
    config_sha256: String,
    gate_action: String,
    input_sha256: String,
    launch_id: String,
    project_id: String,
    request_receipt_sha256: String,
    run_id: String,
    scene_revision: u64,
    session_created_at_unix_ms: u64,
    schema: String,
    session_epoch: u64,
    session_id: String,
    start_release_sha256: String,
    state: String,
}

#[derive(Debug, Deserialize)]
#[serde(deny_unknown_fields)]
struct HttpBodyRef {
    raw_base64: String,
    sha256: String,
}

#[derive(Debug, Deserialize)]
#[serde(deny_unknown_fields)]
struct ApiResponseProof {
    responses: std::collections::BTreeMap<String, HttpBodyRef>,
    snapshot: Value,
}

#[derive(Debug, Deserialize)]
#[serde(deny_unknown_fields)]
struct CommandProof {
    command: Value,
    detail: CommandDetailProof,
    ledger: Value,
    request_receipt: Value,
    request_receipt_sha256: String,
}

#[derive(Debug, Deserialize)]
#[serde(deny_unknown_fields)]
struct CommandDetailProof {
    http_status: u16,
    raw_base64: String,
    sha256: String,
}

#[derive(Debug, Deserialize)]
#[serde(deny_unknown_fields)]
struct PreflightProof {
    api_pin: Value,
    api_response: ApiResponseProof,
    commands: CommandProof,
    execution_input_sha256: String,
    native_config_sha256: String,
    process_sha256: String,
    ready_owner_identity: Value,
    ready_owner_sha256: String,
    run_intent_sha256: String,
    schema: String,
    source_scope: SourceScope,
}

#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
#[serde(deny_unknown_fields)]
struct InventoryFile {
    name: String,
    sha256: String,
}

#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
#[serde(deny_unknown_fields)]
struct InventorySide {
    definition_sha256: String,
    execution_input: ExecutionInputPin,
    leases: Vec<Value>,
    other_active_runs: Vec<Value>,
    outputs: Vec<Value>,
    pending_materialization: bool,
    run_catalog_absent: bool,
    run_files: Vec<InventoryFile>,
    run_id: String,
    run_intent_payload_sha256: String,
    run_intent_sha256: String,
    start_release_absent: bool,
    store_id: String,
    study_sha256: String,
    task_attempts: Vec<Value>,
    workers: Vec<Value>,
}

#[derive(Debug, Deserialize)]
#[serde(deny_unknown_fields)]
struct InventoryProof {
    after: InventorySide,
    before: InventorySide,
    schema: String,
}

#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
#[serde(deny_unknown_fields)]
struct ExecutionInputPin {
    schema_version: String,
    sha256: String,
}

type ApiPin = Value;

#[derive(Debug, Deserialize)]
#[serde(deny_unknown_fields)]
struct QuiescenceProof {
    api_closed: bool,
    api_pin: ApiPin,
    intent_sha256: String,
    retained_process: Value,
    retained_process_sha256: String,
    schema: String,
    signal: String,
}

fn valid_hex64(value: &str) -> bool {
    value.len() == 64 && value.bytes().all(|byte| byte.is_ascii_hexdigit() && !byte.is_ascii_uppercase())
}

fn validate_input_shape(input: &Input) -> Result<()> {
    if input.schema != INPUT_SCHEMA {
        bail!("held UI restore input schema differs");
    }
    if input.plan.attempt.len() != 32
        || !input.plan.attempt.bytes().all(|byte| byte.is_ascii_hexdigit() && !byte.is_ascii_uppercase())
        || !valid_hex64(&input.plan.plan_sha256)
        || !valid_hex64(&input.target_runtime.source_sha256)
        || !valid_hex64(&input.target_runtime.config_sha256)
        || !valid_hex64(&input.target_runtime.accepted_store_binding)
        || !valid_hex64(&input.source_scope.runtime_config_sha256)
        || !valid_hex64(&input.source_scope.state_root_sha256)
        || !input.source_scope.source_root.starts_with('/')
        || input.source_scope.source_root.len() > 4096
        || input.source_scope.source_root.contains("\\")
        || std::path::Path::new(&input.source_scope.source_root)
            .components().any(|part| matches!(part, std::path::Component::ParentDir))
        || input.source_scope.compose_project.is_empty()
        || input.source_scope.control_volume.is_empty()
    {
        bail!("held UI plan or target runtime digests are invalid");
    }
    super::validate_api_instance_id(&input.launch_id, "held UI launch")?;
    super::validate_api_instance_id(&input.plan.maintenance_request_id, "held UI maintenance request")?;
    super::validate_attempt(&input.stop_authority.stop_attempt, "held UI stop attempt")?;
    let expected_dir = format!("{PROOF_DIR}/{}", input.plan.maintenance_request_id);
    for (name, reference) in [
        ("api_quiescence", &input.stop_authority.api_quiescence),
        ("inventory", &input.stop_authority.inventory),
        ("native_drain", &input.stop_authority.native_drain),
        ("preflight", &input.stop_authority.preflight),
    ] {
        fullmag_session::repository_path::validate_relative_path(&reference.path)
            .with_context(|| format!("held UI {name} path is unsafe"))?;
        if std::path::Path::new(&reference.path).parent().and_then(|path| path.to_str()) != Some(expected_dir.as_str())
            || !valid_hex64(&reference.sha256)
        {
            bail!("held UI {name} proof path or digest differs from its request directory");
        }
    }
    let terminal_path = format!("{STOP_TERMINAL_PREFIX}{}/terminal.json", input.stop_authority.stop_attempt);
    if input.stop_authority.terminal.path != terminal_path || !valid_hex64(&input.stop_authority.terminal.sha256) {
        bail!("held UI stop terminal reference differs from its exact attempt path");
    }
    if input.source_scope.namespace.is_empty() {
        if input.source_scope.namespace_registry_sha256.is_some() { bail!("unnamespaced held UI scope has a namespace registry pin"); }
    } else if !input.source_scope.namespace.starts_with("namespaces/")
        || input.source_scope.namespace_registry_sha256.as_deref().is_none_or(|sha| !valid_hex64(sha)) {
        bail!("held UI namespace or registry pin is invalid");
    }
    super::validate_container_id(&input.source_scope.backend_container_id, "held UI backend container")?;
    super::validate_container_id(&input.source_scope.frontend_container_id, "held UI frontend container")?;
    super::validate_non_empty(&input.source_scope.backend_started_at, "held UI backend StartedAt")?;
    super::validate_non_empty(&input.source_scope.frontend_started_at, "held UI frontend StartedAt")?;
    if input.accepted.command_kind != "relax"
        || input.accepted.scene_revision == 0
        || input.accepted.session_epoch == 0
        || input.accepted.session_created_at_unix_ms == 0
        || !valid_hex64(&input.accepted.run_intent_sha256)
        || !valid_hex64(&input.accepted.run_intent_payload_sha256)
        || !valid_hex64(&input.accepted.request_sha256)
        || !valid_hex64(&input.accepted.request_key_sha256)
        || !valid_hex64(&input.accepted.request_receipt_sha256)
        || !valid_hex64(&input.accepted.definition_sha256)
        || !valid_hex64(&input.accepted.study_sha256)
        || !valid_hex64(&input.accepted.accepted_scene_sha256)
        || !valid_hex64(&input.accepted.execution_input_sha256)
        || !input.accepted.old_request_scope_epoch.starts_with(&format!("{}:", input.accepted.old_api_instance_id))
    {
        bail!("held UI accepted-run pins are invalid");
    }
    super::validate_api_instance_id(&input.accepted.old_api_instance_id, "held UI previous API")?;
    let old_counter = input.accepted.old_request_scope_epoch
        .strip_prefix(&format!("{}:", input.accepted.old_api_instance_id))
        .context("held UI request-scope epoch does not match its API identity")?
        .parse::<u64>()?;
    if old_counter == 0 || old_counter != input.accepted.session_epoch
        || old_counter.to_string() != input.accepted.old_request_scope_epoch.rsplit(':').next().unwrap_or_default() {
        bail!("held UI request-scope epoch counter is invalid");
    }
    for id in [&input.accepted.run_id, &input.accepted.project_id, &input.accepted.session_id,
        &input.accepted.request_id, &input.accepted.command_id] {
        fullmag_session::repository_path::validate_store_id(id)?;
    }
    Ok(())
}

async fn read_input() -> Result<Input, String> {
    let (sender, receiver) = tokio::sync::oneshot::channel();
    std::thread::Builder::new()
        .name("held-ui-materialization-input".into())
        .spawn(move || {
            let mut bytes = Vec::new();
            let result = std::io::stdin().lock().take((MAX_INPUT_BYTES + 1) as u64)
                .read_to_end(&mut bytes)
                .map_err(|_| "cannot read private held UI restore input".to_string())
                .and_then(|_| {
                    if bytes.len() > MAX_INPUT_BYTES {
                        return Err("private held UI restore input exceeds its limit".into());
                    }
                    let parsed: Input = serde_json::from_slice(&bytes)
                        .map_err(|_| "invalid private held UI restore input".to_string())?;
                    let mut canonical = fullmag_session::canonical_json_bytes(
                        &serde_json::to_value(&parsed).map_err(|_| "cannot canonicalize held UI input".to_string())?
                    );
                    canonical.push(b'\n');
                    if canonical != bytes {
                        return Err("private held UI restore input is not canonical JSON plus LF".into());
                    }
                    Ok(parsed)
                });
            let _ = sender.send(result);
        })
        .map_err(|_| "cannot start private held UI restore reader".to_string())?;
    tokio::time::timeout(Duration::from_secs(10), receiver)
        .await
        .map_err(|_| "private held UI restore input deadline exceeded".to_string())?
        .map_err(|_| "private held UI restore input reader disconnected".to_string())?
}



#[derive(Debug)]
pub(super) struct LoadedRun {
    pub(super) run_id: RunId,
    pub(super) project_id: ProjectId,
    pub(super) specification: RunSpecification,
    pub(super) scene: SceneDocument,
    pub(super) intent: fullmag_session::FmsRunIntent,
    pub(super) receipt: fullmag_session::LiveComputeRequestReceipt,
    pub(super) total_steps: usize,
    pub(super) release_exists: bool,
}

pub(super) struct ValidatedHeldAuthority {
    pub(super) input: Input,
    pub(super) input_sha256: String,
    pub(super) store_root: std::path::PathBuf,
    pub(super) loaded: LoadedRun,
}

#[derive(Debug, Deserialize)]
#[serde(deny_unknown_fields)]
struct LiveDemandFile {
    schema_version: String,
    run_id: String,
    quantities: Vec<String>,
}

fn validate_catalog_without_progress(
    store: &fullmag_session::SessionStore,
    run_id: &str,
    accepted: &fullmag_runtime_control::AcceptedStudySnapshot,
) -> Result<bool> {
    let planned = accepted.lowered.steps.iter()
        .filter(|step| matches!(step.status, fullmag_plan::StudyStepLoweringStatus::Planned))
        .map(|step| {
            let id = fullmag_session::task_id_for_study_step(run_id, &step.step_id)?;
            let fingerprint = fullmag_application::study_task_input_fingerprint(&accepted.run.specification, step)?;
            Ok::<_, anyhow::Error>((step, id, fingerprint))
        }).collect::<Result<Vec<_>>>()?;
    if planned.is_empty() { bail!("held UI RunIntent has no planned executable tasks"); }
    let Some(catalog) = store.read_run_catalog(run_id)? else {
        if !store.root().join("runs").join(run_id).join("task_preparation_receipts").exists()
            && !store.root().join("runs").join(run_id).join("accepted_stage_preparation_receipts").exists() {
            return Ok(false);
        }
        bail!("held UI run has preparation history without its exact catalog");
    };
    if catalog.run_id != run_id || catalog.revision != 1 || catalog.tasks.len() != planned.len() {
        bail!("held UI existing catalog is not the exact first materialization");
    }
    for (task, (step, expected_id, expected_fingerprint)) in catalog.tasks.iter().zip(&planned) {
        let expected_reason = match step.execution_plan.as_ref() {
            Some(plan) if plan.common.resolved_backend == fullmag_ir::BackendTarget::Fem => {
                fullmag_session::FMS_TASK_AWAITING_PREPARATION_REASON
            }
            _ => fullmag_runtime_control::ACCEPTED_TASK_AWAITING_DEPENDENCY_RESOLUTION,
        };
        let expected_readiness = FmsTaskReadiness::Blocked { reason: expected_reason.into() };
        if task.task_id != *expected_id || task.input_fingerprint != *expected_fingerprint
            || task.lifecycle != FmsTaskLifecycle::Accepted
            || task.readiness != expected_readiness
            || task.observation.is_some() || task.attempt_id.is_some() || task.ownership_epoch.is_some()
            || task.resolved_input_fingerprint.is_some() || !task.artifact_ids.is_empty()
            || task.resource_id.is_some() || task.coordinator_watermark.is_some()
            || task.coordinator_genesis.is_some() {
            bail!("held UI existing task catalog contains execution progress or changed identity");
        }
        let _ = step;
    }
    if !store.list_task_cancellation_intents(run_id)?.is_empty() {
        bail!("held UI accepted run has a cancellation intent");
    }
    // Any preparation files left by this same mode must be exact derived
    // receipts for planned steps. The store readers validate each payload and
    // its CAS binding; unknown files are rejected by the run-directory scan.
    for (step, task_id, _) in planned {
        let _ = store.read_task_preparation_receipt(run_id, &task_id)?;
        let _ = store.read_accepted_stage_preparation_receipt(run_id, &step.step_id)?;
    }
    Ok(true)
}

fn validate_live_workspace_binding(live: &Value, accepted: &AcceptedPins) -> Result<()> {
    if live.get("session_id").and_then(Value::as_str) != Some(accepted.session_id.as_str())
        || live.get("session_epoch").and_then(Value::as_u64) != Some(accepted.session_epoch)
        || live.get("api_instance_id").and_then(Value::as_str) != Some(accepted.old_api_instance_id.as_str())
        || live.get("scene_revision").and_then(Value::as_u64) != Some(accepted.scene_revision) {
        bail!("held UI RunIntent live workspace differs from its API/session/scene pins");
    }
    Ok(())
}

fn validate_run_directory(
    store: &fullmag_session::SessionStore,
    run_id: &str,
    catalog_present: bool,
    release_present: bool,
    planned_task_ids: &std::collections::BTreeSet<String>,
) -> Result<()> {
    use std::collections::BTreeSet;
    let relative = format!("runs/{run_id}");
    let directory = fullmag_session::repository_path::checked_path(store.root(), &relative)?;
    let meta = std::fs::symlink_metadata(&directory).context("inspect held UI run directory")?;
    if !meta.is_dir() || meta.file_type().is_symlink() { bail!("held UI run directory is not a real directory"); }
    let mut names = BTreeSet::new();
    for entry in std::fs::read_dir(&directory).context("list held UI run directory")? {
        let entry = entry?;
        let name = entry.file_name().into_string().map_err(|_| anyhow::anyhow!("held UI run file name is not UTF-8"))?;
        let metadata = std::fs::symlink_metadata(entry.path())?;
        if metadata.file_type().is_symlink() || (!metadata.is_file() && !metadata.is_dir()) {
            bail!("held UI run directory contains a link or special file");
        }
        names.insert((name, metadata.is_dir()));
    }
    let mut expected = BTreeSet::from([
        ("live_demand.v1.json".to_owned(), false),
        ("run_intent.json".to_owned(), false),
    ]);
    if catalog_present { expected.insert(("run_catalog.json".to_owned(), false)); }
    if release_present { expected.insert(("start_release.json".to_owned(), false)); }
    for dir in ["task_preparation_receipts", "accepted_stage_preparation_receipts"] {
        let candidate = directory.join(dir);
        if candidate.exists() {
            let metadata = std::fs::symlink_metadata(&candidate)?;
            if !metadata.is_dir() || metadata.file_type().is_symlink() { bail!("held UI preparation directory is unsafe"); }
            expected.insert((dir.to_owned(), true));
            for entry in std::fs::read_dir(candidate)? {
                let entry = entry?;
                let metadata = std::fs::symlink_metadata(entry.path())?;
                if !metadata.is_file() || metadata.file_type().is_symlink() { bail!("held UI preparation record is unsafe"); }
                let name = entry.file_name().into_string().map_err(|_| anyhow::anyhow!("held UI preparation name is not UTF-8"))?;
                let stem = name.strip_suffix(".json").context("held UI preparation file has an unknown extension")?;
                if !planned_task_ids.contains(stem) { bail!("held UI preparation record is outside planned task identities"); }
            }
        }
    }
    if names != expected { bail!("held UI run directory contains unproved task or output history"); }
    Ok(())
}

fn validate_inventory_files(
    store: &fullmag_session::SessionStore,
    input: &Input,
    inventory: &InventoryProof,
    specification: &RunSpecification,
    scene: &SceneDocument,
) -> Result<()> {
    let side = &inventory.before;
    let run_id = &input.accepted.run_id;
    let mut observed = std::collections::BTreeMap::new();
    for name in ["live_demand.v1.json", "run_intent.json"] {
        let relative = format!("runs/{run_id}/{name}");
        let raw = fullmag_session::repository_path::read_bounded_regular_file(
            store.root(), &relative, MAX_PROOF_BYTES,
        ).with_context(|| format!("read held UI {name}"))?;
        observed.insert(name.to_owned(), sha256(&raw));
        if let Some(proof) = side.run_files.iter().find(|file| file.name == name) {
            if proof.sha256 != sha256(&raw) { bail!("held UI {name} changed after the stop proof"); }
        }
        if name == "live_demand.v1.json" {
            let demand: LiveDemandFile = serde_json::from_slice(&raw).context("decode held UI live-demand sidecar")?;
            if demand.schema_version != "fullmag.accepted_live_demand.v1" || demand.run_id != *run_id
                || demand.quantities.len() > 64 || demand.quantities.iter().any(|item| item.trim().is_empty() || item.len() > 256) {
                bail!("held UI live-demand sidecar does not bind the accepted run");
            }
        }
    }
    if side.run_files.iter().map(|file| (file.name.as_str(), file.sha256.as_str())).collect::<Vec<_>>()
        != [
            ("live_demand.v1.json", observed["live_demand.v1.json"].as_str()),
            ("run_intent.json", observed["run_intent.json"].as_str()),
        ] {
        bail!("held UI inventory file hashes differ from the current accepted run");
    }
    if specification.snapshot.definition_sha256 != input.accepted.definition_sha256
        || specification.study.plan_sha256 != input.accepted.study_sha256
        || scene.revision != input.accepted.scene_revision
        || fullmag_session::canonical_json_sha256(&serde_json::to_value(scene)?) != input.accepted.accepted_scene_sha256 {
        bail!("held UI immutable definition, Study, or scene differs from its pins");
    }
    let identity = crate::live_execution_binding::input_identity(scene)
        .map_err(|error| anyhow::anyhow!(error.to_string()))?;
    if identity.sha256 != input.accepted.execution_input_sha256
        || identity.sha256 != inventory.before.execution_input.sha256 {
        bail!("held UI execution input differs from its immutable definition and inventory");
    }
    Ok(())
}

fn validate_store(input: &Input, store_root: &Path, inventory: &InventoryProof, preflight: &PreflightProof) -> Result<LoadedRun> {
    let store = fullmag_session::SessionStore::open_existing(store_root).context("open held UI accepted store")?;
    let binding = fullmag_runtime_control::accepted_store::store_binding(store_root)
        .context("resolve held UI accepted-store binding")?;
    if binding != input.target_runtime.accepted_store_binding { bail!("held UI private input targets another accepted store"); }
    let store_id = fullmag_session::host_resource_ledger::store_id(store_root)
        .context("resolve held UI accepted-store identity")?;
    if inventory.before.store_id != store_id {
        bail!("held UI inventory store identity differs from the configured accepted store");
    }
    let run_id = RunId::parse(input.accepted.run_id.clone()).map_err(anyhow::Error::msg)?;
    let project_id = ProjectId::parse(input.accepted.project_id.clone()).map_err(anyhow::Error::msg)?;
    let intent_relative = format!("runs/{}/run_intent.json", run_id.as_str());
    let intent_raw = fullmag_session::repository_path::read_bounded_regular_file(store_root, &intent_relative, MAX_PROOF_BYTES)
        .context("read held UI immutable RunIntent")?;
    if sha256(&intent_raw) != input.accepted.run_intent_sha256 { bail!("held UI RunIntent bytes differ from their accepted hash"); }
    let intent: fullmag_session::FmsRunIntent = serde_json::from_slice(&intent_raw).context("decode held UI RunIntent")?;
    intent.validate()?;
    if intent.run_id != input.accepted.run_id
        || intent.payload_sha256 != input.accepted.run_intent_payload_sha256
        || intent.specification.get("run_id").and_then(Value::as_str) != Some(input.accepted.run_id.as_str()) {
        bail!("held UI RunIntent identity or payload differs");
    }
    let specification: RunSpecification = serde_json::from_value(intent.specification.clone())
        .context("decode held UI accepted RunSpecification")?;
    specification.validate().map_err(|error| anyhow::anyhow!(error.to_string()))?;
    if specification.run_id != run_id || specification.snapshot.project_id != project_id {
        bail!("held UI RunSpecification project/run identity differs");
    }
    let live = specification.parameters.pointer("/live_workspace")
        .context("held UI RunIntent has no live workspace binding")?;
    validate_live_workspace_binding(live, &input.accepted)?;
    let command = live.get("command").context("held UI RunIntent has no original Compute command")?;
    let receipt_value = live.get("request_receipt").context("held UI RunIntent has no original request receipt")?;
    let receipt: fullmag_session::LiveComputeRequestReceipt = serde_json::from_value(receipt_value.clone())
        .context("decode held UI immutable request receipt")?;
    receipt.validate()?;
    let actual_receipt = crate::live_compute_request::receipt_from_intent(&intent)
        .map_err(|error| anyhow::anyhow!(error.to_string()))?
        .context("held UI RunIntent receipt is unavailable")?;
    if actual_receipt != receipt || serde_json::to_value(command)? != preflight.commands.command
        || serde_json::to_value(&receipt)? != preflight.commands.request_receipt
        || live.get("command_id").and_then(Value::as_str) != Some(input.accepted.command_id.as_str())
        || command.get("kind").and_then(Value::as_str) != Some(input.accepted.command_kind.as_str())
        || command.get("client_intent_id").and_then(Value::as_str) != Some(input.accepted.client_intent_id.as_str())
        || receipt.command_id != input.accepted.command_id
        || receipt.request_id.as_deref() != Some(input.accepted.request_id.as_str())
        || receipt.request_sha256 != input.accepted.request_sha256
        || receipt.key_sha256 != input.accepted.request_key_sha256
        || receipt.command_kind.as_deref() != Some(input.accepted.command_kind.as_str())
        || receipt.client_intent_id.as_deref() != Some(input.accepted.client_intent_id.as_str())
        || receipt.requested_target.as_ref() != command.get("target") {
        bail!("held UI immutable RunIntent command or request receipt differs from preflight");
    }
    if fullmag_session::accepted_run_start_policy_is_manual(
            specification.parameters.get(fullmag_session::ACCEPTED_RUN_START_POLICY_KEY)
                .context("held UI RunIntent has no manual start policy")?,
        )? != true {
        bail!("held UI RunIntent manual start policy differs");
    }
    let accepted = fullmag_runtime_control::load_accepted_study_snapshot(&store, &run_id, &project_id)
        .context("load held UI immutable accepted Study and execution catalog")?;
    if accepted.run.intent != intent || accepted.run.specification != specification {
        bail!("held UI immutable accepted snapshot differs from its RunIntent");
    }
    let scene = super::scene_from_definition(&accepted.run.definition_bytes, &specification)?;
    validate_inventory_files(&store, input, inventory, &specification, &scene)?;
    let planned = accepted.lowered.steps.iter()
        .filter(|step| matches!(step.status, fullmag_plan::StudyStepLoweringStatus::Planned))
        .map(|step| fullmag_session::task_id_for_study_step(run_id.as_str(), &step.step_id))
        .collect::<Result<std::collections::BTreeSet<_>>>()?;
    let catalog_present = validate_catalog_without_progress(&store, run_id.as_str(), &accepted)?;
    let release = store.read_accepted_run_start_release(run_id.as_str())?;
    let release_exists = if let Some(release) = release {
        let expected_id = crate::live_accepted_execution::accepted_start_release_request_id(
            run_id.as_str(), &input.accepted.request_id,
        );
        if release.run_id != run_id.as_str()
            || release.specification_sha256 != intent.payload_sha256
            || release.request_id != expected_id
            || release.live_request.as_ref() != Some(&receipt) {
            bail!("held UI pre-existing start release differs from the exact accepted request");
        }
        true
    } else { false };
    if release_exists && !catalog_present { bail!("held UI start release exists without its accepted catalog"); }
    validate_run_directory(&store, run_id.as_str(), catalog_present, release_exists, &planned)?;
    if store.accepted_run_start_permitted(run_id.as_str())? != release_exists {
        bail!("held UI manual accepted run release and start gate differ");
    }
    Ok(LoadedRun {
        run_id, project_id, specification, scene, intent, receipt,
        total_steps: accepted.lowered.steps.iter().filter(|step|
            matches!(step.status, fullmag_plan::StudyStepLoweringStatus::Planned)).count(),
        release_exists,
    })
}

fn canonical_lf(value: &Value) -> Vec<u8> {
    let mut bytes = fullmag_session::canonical_json_bytes(value);
    bytes.push(b'\n');
    bytes
}

fn sha256(bytes: &[u8]) -> String {
    fullmag_session::hex_sha256(bytes)
}

fn parse_unique_value(bytes: &[u8], label: &str) -> Result<Value> {
    let mut deserializer = serde_json::Deserializer::from_slice(bytes);
    let value = UniqueJson::deserialize(&mut deserializer)
        .with_context(|| format!("decode {label}"))?.0;
    deserializer.end().with_context(|| format!("finish {label}"))?;
    Ok(value)
}

struct UniqueJson(Value);

impl<'de> Deserialize<'de> for UniqueJson {
    fn deserialize<D>(deserializer: D) -> std::result::Result<Self, D::Error>
    where D: serde::Deserializer<'de> {
        deserializer.deserialize_any(UniqueJsonVisitor)
    }
}

struct UniqueJsonVisitor;

impl<'de> serde::de::Visitor<'de> for UniqueJsonVisitor {
    type Value = UniqueJson;
    fn expecting(&self, formatter: &mut std::fmt::Formatter<'_>) -> std::fmt::Result {
        formatter.write_str("a JSON value without duplicate object keys")
    }
    fn visit_bool<E>(self, value: bool) -> std::result::Result<Self::Value, E> where E: serde::de::Error {
        Ok(UniqueJson(Value::Bool(value)))
    }
    fn visit_i64<E>(self, value: i64) -> std::result::Result<Self::Value, E> where E: serde::de::Error {
        Ok(UniqueJson(Value::Number(value.into())))
    }
    fn visit_u64<E>(self, value: u64) -> std::result::Result<Self::Value, E> where E: serde::de::Error {
        Ok(UniqueJson(Value::Number(value.into())))
    }
    fn visit_f64<E>(self, value: f64) -> std::result::Result<Self::Value, E> where E: serde::de::Error {
        serde_json::Number::from_f64(value).map(|number| UniqueJson(Value::Number(number)))
            .ok_or_else(|| E::custom("non-finite JSON number"))
    }
    fn visit_str<E>(self, value: &str) -> std::result::Result<Self::Value, E> where E: serde::de::Error {
        Ok(UniqueJson(Value::String(value.to_owned())))
    }
    fn visit_string<E>(self, value: String) -> std::result::Result<Self::Value, E> where E: serde::de::Error {
        Ok(UniqueJson(Value::String(value)))
    }
    fn visit_none<E>(self) -> std::result::Result<Self::Value, E> where E: serde::de::Error {
        Ok(UniqueJson(Value::Null))
    }
    fn visit_unit<E>(self) -> std::result::Result<Self::Value, E> where E: serde::de::Error {
        Ok(UniqueJson(Value::Null))
    }
    fn visit_seq<A>(self, mut seq: A) -> std::result::Result<Self::Value, A::Error>
    where A: serde::de::SeqAccess<'de> {
        let mut values = Vec::new();
        while let Some(value) = seq.next_element::<UniqueJson>()? { values.push(value.0); }
        Ok(UniqueJson(Value::Array(values)))
    }
    fn visit_map<A>(self, mut map: A) -> std::result::Result<Self::Value, A::Error>
    where A: serde::de::MapAccess<'de> {
        let mut values = serde_json::Map::new();
        while let Some(key) = map.next_key::<String>()? {
            if values.contains_key(&key) { return Err(serde::de::Error::custom("duplicate JSON object key")); }
            let value = map.next_value::<UniqueJson>()?;
            values.insert(key, value.0);
        }
        Ok(UniqueJson(Value::Object(values)))
    }
}

fn read_raw(root: &Path, reference: &RecordRef, maximum: usize, label: &str) -> Result<Vec<u8>> {
    validate_digest(&reference.sha256, &format!("{label} SHA-256"))?;
    fullmag_session::repository_path::validate_relative_path(&reference.path)
        .with_context(|| format!("{label} path is unsafe"))?;
    let bytes = fullmag_session::repository_path::read_bounded_regular_file(root, &reference.path, maximum)
        .with_context(|| format!("read pinned {label}"))?;
    if sha256(&bytes) != reference.sha256 { bail!("{label} bytes differ from their immutable pin"); }
    Ok(bytes)
}

fn read_canonical_record(root: &Path, reference: &RecordRef, label: &str) -> Result<Value> {
    let bytes = read_raw(root, reference, MAX_PROOF_BYTES, label)?;
    let value = parse_unique_value(&bytes, label)?;
    if canonical_lf(&value) != bytes { bail!("{label} is not canonical JSON plus LF"); }
    Ok(value)
}

fn validate_launch_and_request(root: &Path, input: &Input) -> Result<()> {
    let directory = format!("{PROOF_DIR}/{}", input.plan.maintenance_request_id);
    let request_path = format!("{directory}/request.json");
    let launch_path = format!("{directory}/launch.json");
    let request_bytes = fullmag_session::repository_path::read_bounded_regular_file(root, &request_path, MAX_INPUT_BYTES)
        .context("read immutable held UI request")?;
    let request_value = parse_unique_value(&request_bytes, "held UI request")?;
    if canonical_lf(&request_value) != request_bytes { bail!("held UI request is not canonical JSON plus LF"); }
    let request: PythonRequest = serde_json::from_value(request_value.clone()).context("decode held UI request")?;
    if request.schema != REQUEST_SCHEMA || request.plan != input.plan
        || request.source_scope != input.source_scope || request.stop_authority != input.stop_authority
        || request.accepted != input.accepted {
        bail!("held UI private input differs from its immutable Python request");
    }
    let request_sha = sha256(&request_bytes);
    let launch_bytes = fullmag_session::repository_path::read_bounded_regular_file(root, &launch_path, MAX_PROOF_BYTES)
        .context("read immutable held UI launch")?;
    let launch_value = parse_unique_value(&launch_bytes, "held UI launch")?;
    if canonical_lf(&launch_value) != launch_bytes { bail!("held UI launch is not canonical JSON plus LF"); }
    let launch: LaunchRecord = serde_json::from_value(launch_value).context("decode held UI launch")?;
    let input_value = serde_json::to_value(input)?;
    let input_sha = sha256(&canonical_lf(&input_value));
    if launch.schema != LAUNCH_SCHEMA || launch.launch_id != input.launch_id
        || launch.request_path != request_path || launch.request_sha256 != request_sha
        || launch.input_sha256 != input_sha || launch.input != *input {
        bail!("held UI immutable launch does not bind the exact request and private input");
    }
    Ok(())
}

fn validate_environment_and_target(input: &Input, store_root: &Path) -> Result<()> {
    super::validate_current_build_identity(&input.target_runtime.build_id, &input.target_runtime.source_sha256)?;
    super::validate_image_id(&input.target_runtime.image_id, "held UI target image")?;
    if std::env::var(super::CURRENT_RUNTIME_IMAGE_ENV)
        .context("held UI target image environment is absent")? != input.target_runtime.image_id {
        bail!("held UI target image differs from the current API image");
    }
    for (name, expected) in [
        (super::CURRENT_COMPOSE_PROJECT_ENV, input.source_scope.compose_project.as_str()),
        (super::CURRENT_SOURCE_ROOT_ENV, input.source_scope.source_root.as_str()),
        (super::CURRENT_CONTROL_VOLUME_ENV, input.source_scope.control_volume.as_str()),
    ] {
        if std::env::var(name).with_context(|| format!("held UI source scope {name} is absent"))? != expected {
            bail!("held UI source scope differs from the API runtime binding");
        }
    }
    let runtime_control_root = super::configured_runtime_control_root()?;
    let config_path = runtime_control_root.join("runtime-service/docker-all.json");
    let configured_path = std::env::var_os("FULLMAG_RUNTIME_SERVICE_CONFIG")
        .map(std::path::PathBuf::from)
        .context("held UI target has no native runtime configuration")?;
    if configured_path != config_path {
        bail!("held UI native runtime configuration path differs from the managed control root");
    }
    let config_bytes = fullmag_session::repository_path::read_bounded_regular_file(
        &runtime_control_root, "runtime-service/docker-all.json", 64 * 1024,
    ).context("read held UI target native configuration")?;
    if sha256(&config_bytes) != input.target_runtime.config_sha256 {
        bail!("held UI target native configuration differs from its immutable pin");
    }
    let config: fullmag_session::runtime_service::RuntimeServiceConfig =
        serde_json::from_slice(&config_bytes).context("decode held UI target native configuration")?;
    config.validate().context("validate held UI target native configuration")?;
    if config.store_root.as_path() != store_root {
        bail!("held UI target native configuration belongs to another accepted store");
    }
    Ok(())
}

fn validate_status_session_epoch(session: &Value, accepted: &AcceptedPins) -> Result<()> {
    let expected_wire_epoch = format!("{}@{}", accepted.session_id, accepted.session_created_at_unix_ms);
    let expected_created_at = accepted.session_created_at_unix_ms.to_string();
    if session.get("session_id").and_then(Value::as_str) != Some(accepted.session_id.as_str())
        || session.get("session_epoch").and_then(Value::as_str) != Some(expected_wire_epoch.as_str())
        || session.get("created_at").and_then(Value::as_str) != Some(expected_created_at.as_str())
        || session.get("request_scope_epoch").and_then(Value::as_str)
            != Some(accepted.old_request_scope_epoch.as_str())
    {
        bail!("held UI preflight session epoch wire binding differs");
    }
    Ok(())
}

fn validate_preflight_scope(proof: &PreflightProof, input: &Input) -> Result<()> {
    if proof.schema != "fullmag.held-ui-materialization-preflight.v1"
        || proof.source_scope != input.source_scope
        || proof.run_intent_sha256 != input.accepted.run_intent_sha256
        || proof.execution_input_sha256 != input.accepted.execution_input_sha256
    {
        bail!("held UI preflight native/source scope differs from its stop request");
    }
    for (digest, label) in [
        (&proof.native_config_sha256, "held UI old native configuration"),
        (&proof.ready_owner_sha256, "held UI old Ready owner"),
        (&proof.process_sha256, "held UI old process receipt"),
        (&proof.run_intent_sha256, "held UI preflight RunIntent"),
        (&proof.execution_input_sha256, "held UI preflight execution input"),
    ] {
        super::validate_digest(digest, label)?;
    }
    if fullmag_session::canonical_json_sha256(&proof.ready_owner_identity) != proof.ready_owner_sha256 {
        bail!("held UI Ready owner identity differs from its preflight hash");
    }
    validate_api_pin(&proof.api_pin, &input.accepted)?;
    Ok(())
}

fn validate_preflight(proof: &PreflightProof, input: &Input) -> Result<()> {
    validate_preflight_scope(proof, input)?;
    let expected_responses = ["health", "status", "run", "scene", "queue", "commands", "runtime"]
        .into_iter().map(str::to_owned).collect::<std::collections::BTreeSet<_>>();
    if proof.api_response.responses.keys().cloned().collect::<std::collections::BTreeSet<_>>() != expected_responses {
        bail!("held UI preflight response set differs");
    }
    let mut decoded = std::collections::BTreeMap::<String, Value>::new();
    for (name, body) in &proof.api_response.responses {
        let bytes = base64::engine::general_purpose::STANDARD.decode(&body.raw_base64)
            .with_context(|| format!("decode held UI {name} response"))?;
        if bytes.len() > MAX_PROOF_BYTES || sha256(&bytes) != body.sha256 {
            bail!("held UI {name} response bytes differ from their hash");
        }
        decoded.insert(name.clone(), parse_unique_value(&bytes, &format!("held UI {name} HTTP body"))?);
    }
    let snapshot = proof.api_response.snapshot.as_object().context("held UI API snapshot is not an object")?;
    let snapshot_fields = ["api_instance_id", "health", "status", "run", "scene", "queue", "commands", "runtime"]
        .into_iter().map(str::to_owned).collect::<std::collections::BTreeSet<_>>();
    if snapshot.keys().cloned().collect::<std::collections::BTreeSet<_>>() != snapshot_fields {
        bail!("held UI API snapshot fields differ");
    }
    for name in ["health", "status", "run", "scene", "queue", "commands", "runtime"] {
        if snapshot.get(name) != decoded.get(name) { bail!("held UI snapshot differs from its raw {name} response"); }
    }
    let accepted = &input.accepted;
    let api_id = snapshot.get("api_instance_id").and_then(Value::as_str).context("held UI API snapshot has no instance id")?;
    if api_id != accepted.old_api_instance_id
        || proof.api_pin.get("pid").and_then(Value::as_u64).is_none_or(|pid| pid <= 1)
        || proof.api_pin.get("start_token").and_then(Value::as_str).is_none_or(|value| value.is_empty())
        || proof.api_pin.get("argv").and_then(Value::as_array).is_none_or(|argv| argv != &[json!("/opt/fullmag/package/bin/fullmag-api")])
        || proof.api_pin.get("exe").and_then(Value::as_str) != Some("/opt/fullmag/package/bin/fullmag-api")
        || decoded["health"].get("status").and_then(Value::as_str) != Some("ok")
        || decoded["health"].get("active_session").and_then(Value::as_bool) != Some(true)
        || decoded["runtime"].get("configured").and_then(Value::as_bool) != Some(true)
        || decoded["runtime"].get("state").and_then(Value::as_str) != Some("ready") {
        bail!("held UI API health, identity, or native readiness differs");
    }
    let status = &decoded["status"];
    let session = status.get("session").context("held UI status has no session")?;
    let resources = status.get("resources").context("held UI status has no resources")?;
    validate_status_session_epoch(session, accepted)?;
    if resources.get("scene_revision").and_then(Value::as_u64) != Some(accepted.scene_revision) {
        bail!("held UI preflight session, epoch, or scene revision differs");
    }
    let run = &decoded["run"];
    if run.get("run_id").and_then(Value::as_str) != Some(&accepted.run_id)
        || run.get("session_id").and_then(Value::as_str) != Some(&accepted.session_id)
        || run.get("status").and_then(Value::as_str) != Some("waiting_for_compute") {
        bail!("held UI preflight current run differs");
    }
    let scene = &decoded["scene"];
    if scene.get("revision").and_then(Value::as_u64) != Some(accepted.scene_revision)
        || fullmag_session::canonical_json_sha256(scene) != accepted.accepted_scene_sha256 {
        bail!("held UI preflight scene digest or revision differs");
    }
    let queue = &decoded["queue"];
    let items = queue.get("items").and_then(Value::as_array).context("held UI queue has no items")?;
    let revision = queue.get("revision").and_then(Value::as_str)
        .context("held UI queue has no revision")?;
    if queue.get("schema_version").and_then(Value::as_str) != Some("compute_queue.v1")
        || !revision.strip_prefix("sha256:").is_some_and(valid_hex64)
        || !queue.get("next_cursor").is_none_or(Value::is_null)
        || items.len() != 1 || items[0].get("run_id").and_then(Value::as_str) != Some(&accepted.run_id)
        || items[0].get("project_id").and_then(Value::as_str) != Some(&accepted.project_id)
        || items[0].get("state").and_then(Value::as_str) != Some("pending_materialization")
        || !items[0].get("task_id").is_none_or(Value::is_null) {
        bail!("held UI queue is not the single exact pending-materialization item");
    }
    if proof.commands.ledger != decoded["commands"]
        || proof.commands.command.get("command_id").and_then(Value::as_str) != Some(&accepted.command_id)
        || proof.commands.command.get("kind").and_then(Value::as_str) != Some(&accepted.command_kind)
        || proof.commands.command.get("client_intent_id").and_then(Value::as_str) != Some(&accepted.client_intent_id)
        || proof.commands.command.get("seq").and_then(Value::as_u64) != Some(0)
        || proof.commands.request_receipt.get("command_id").and_then(Value::as_str) != Some(&accepted.command_id)
        || proof.commands.request_receipt.get("request_id").and_then(Value::as_str) != Some(&accepted.request_id)
        || proof.commands.request_receipt.get("request_sha256").and_then(Value::as_str) != Some(&accepted.request_sha256)
        || proof.commands.request_receipt.get("key_sha256").and_then(Value::as_str) != Some(&accepted.request_key_sha256)
        || proof.commands.request_receipt.get("command_kind").and_then(Value::as_str) != Some(&accepted.command_kind)
        || proof.commands.request_receipt.get("client_intent_id").and_then(Value::as_str) != Some(&accepted.client_intent_id)
        || fullmag_session::canonical_json_sha256(&proof.commands.request_receipt) != accepted.request_receipt_sha256
        || proof.commands.request_receipt_sha256 != accepted.request_receipt_sha256
        || proof.commands.request_receipt.get("requested_target") != proof.commands.command.get("target") {
        bail!("held UI immutable command or request receipt differs");
    }
    if proof.commands.detail.http_status != 404 {
        bail!("held UI original command detail is not the retained 404");
    }
    let detail = base64::engine::general_purpose::STANDARD.decode(&proof.commands.detail.raw_base64)
        .context("decode held UI original command detail")?;
    if detail.len() > MAX_PROOF_BYTES || sha256(&detail) != proof.commands.detail.sha256 {
        bail!("held UI original command detail bytes differ from their hash");
    }
    let ledger = &proof.commands.ledger;
    if ledger.get("pending_count").and_then(Value::as_u64) != Some(0)
        || ledger.get("accepted_count").and_then(Value::as_u64) != Some(0)
        || ledger.get("dispatched_count").and_then(Value::as_u64) != Some(0)
        || ledger.get("running_count").and_then(Value::as_u64) != Some(0) {
        bail!("held UI command ledger contains another active command");
    }
    let ledger_commands = ledger.get("commands").and_then(Value::as_array)
        .context("held UI command ledger has no command list")?;
    if ledger_commands.iter().any(|entry|
        entry.get("command_id").and_then(Value::as_str) == Some(accepted.command_id.as_str())) {
        bail!("held UI original command already has a public ledger entry");
    }
    for hash in [&proof.native_config_sha256, &proof.ready_owner_sha256, &proof.process_sha256] {
        validate_digest(hash, "held UI native preflight hash")?;
    }
    Ok(())
}

fn validate_inventory(proof: &InventoryProof, input: &Input) -> Result<()> {
    if proof.schema != "fullmag.held-ui-materialization-inventory.v1" || proof.before != proof.after {
        bail!("held UI inventory changed or has an unsupported schema");
    }
    let side = &proof.before;
    let accepted = &input.accepted;
    if side.run_id != accepted.run_id || side.run_intent_sha256 != accepted.run_intent_sha256
        || side.execution_input.schema_version != "fullmag.scene_execution_input.v1"
        || side.execution_input.sha256 != accepted.execution_input_sha256
        || side.run_intent_payload_sha256 != accepted.run_intent_payload_sha256
        || side.definition_sha256 != accepted.definition_sha256 || side.study_sha256 != accepted.study_sha256
        || !side.run_catalog_absent || !side.start_release_absent || !side.pending_materialization
        || !side.leases.is_empty() || !side.task_attempts.is_empty() || !side.workers.is_empty()
        || !side.outputs.is_empty() || !side.other_active_runs.is_empty()
        || !side.store_id.starts_with("sha256:") || !valid_hex64(side.store_id.trim_start_matches("sha256:")) {
        bail!("held UI inventory does not prove the one untouched accepted run");
    }
    let expected = ["live_demand.v1.json", "run_intent.json"];
    if side.run_files.len() != expected.len()
        || side.run_files.iter().map(|file| file.name.as_str()).collect::<Vec<_>>() != expected
        || side.run_files.iter().find(|file| file.name == "run_intent.json").map(|file| file.sha256.as_str())
            != Some(accepted.run_intent_sha256.as_str()) {
        bail!("held UI inventory run-file set or RunIntent digest differs");
    }
    for file in &side.run_files { validate_digest(&file.sha256, "held UI run-file digest")?; }
    Ok(())
}

fn owner_identity_value(owner: &Value) -> Result<Value> {
    let descriptor: fullmag_session::runtime_service::RuntimeServiceOwnerDescriptor =
        serde_json::from_value(owner.clone()).context("decode held UI native owner")?;
    let mut children = descriptor.children.iter()
        .map(|child| (child.role.clone(), child.pid)).collect::<Vec<_>>();
    children.sort();
    Ok(json!({
        "owner_token": descriptor.owner_token,
        "process_start_token": descriptor.process_start_token,
        "pid": descriptor.pid,
        "host": descriptor.host,
        "target_id": descriptor.target_id,
        "protocol": descriptor.protocol,
        "build_commit": descriptor.build_commit,
        "build_snapshot": descriptor.build_snapshot,
        "control_address": descriptor.control_address,
        "compute_pool_generation": descriptor.compute_pool_generation,
        "preparation_pool_generation": descriptor.preparation_pool_generation,
        "compute_pool_id": descriptor.compute_pool_id,
        "preparation_pool_id": descriptor.preparation_pool_id,
        "children": children,
    }))
}

fn validate_api_pin(pin: &Value, accepted: &AcceptedPins) -> Result<()> {
    let object = pin.as_object().context("held UI API pin is not an object")?;
    let expected_fields = ["pid", "start_token", "ppid", "argv", "exe"]
        .into_iter().map(str::to_owned).collect::<std::collections::BTreeSet<_>>();
    if object.keys().cloned().collect::<std::collections::BTreeSet<_>>() != expected_fields
        || object.get("pid").and_then(Value::as_u64).is_none_or(|pid| pid <= 1)
        || object.get("ppid").and_then(Value::as_u64).is_none_or(|pid| pid == 0)
        || object.get("start_token").and_then(Value::as_str).is_none_or(|token| token.is_empty() || !token.bytes().all(|byte| byte.is_ascii_digit()))
        || object.get("argv").and_then(Value::as_array).is_none_or(|argv| argv != &[json!("/opt/fullmag/package/bin/fullmag-api")])
        || object.get("exe").and_then(Value::as_str) != Some("/opt/fullmag/package/bin/fullmag-api") {
        bail!("held UI API process pin differs from the fixed API executable");
    }
    super::validate_api_instance_id(&accepted.old_api_instance_id, "held UI old API instance")?;
    Ok(())
}

fn validate_ready_process(
    receipt: &Value,
    api_pin: &Value,
    expected_owner_identity: &Value,
    store_root: &Path,
    store_binding: &str,
) -> Result<()> {
    if receipt.get("schema").and_then(Value::as_str) != Some("fullmag.docker-process-tree.v1")
        || receipt.get("state").and_then(Value::as_str) != Some("ready")
        || receipt.get("api_pid").and_then(Value::as_u64) != api_pin.get("pid").and_then(Value::as_u64)
        || receipt.get("accepted_store").and_then(Value::as_str) != store_root.to_str()
        || receipt.get("api_diagnostic_only").and_then(Value::as_bool) == Some(true)
        || receipt.pointer("/bootstrap/binding").and_then(Value::as_str) != Some(store_binding)
    {
        bail!("held UI preflight process receipt is not the pinned Ready API process");
    }
    let owner = super::validate_native_owner(
        receipt.get("service_owner").context("held UI Ready process has no service owner")?,
        "held UI preflight Ready owner",
        fullmag_session::runtime_service::RuntimeServiceState::Ready,
        &["running"],
    )?;
    if owner_identity_value(&owner)? != *expected_owner_identity {
        bail!("held UI Ready process owner differs from preflight");
    }
    Ok(())
}

fn validate_stop_authority(
    root: &Path,
    control_root: &Path,
    input: &Input,
    preflight: &PreflightProof,
    store_root: &Path,
) -> Result<()> {
    let authority = &input.stop_authority;
    let scope = &input.source_scope;
    let accepted = &input.accepted;
    let quiescence_value = read_canonical_record(root, &authority.api_quiescence, "held UI API quiescence")?;
    let quiescence: QuiescenceProof = serde_json::from_value(quiescence_value.clone())
        .context("decode held UI API quiescence")?;
    if quiescence.schema != "fullmag.native-terminal-api-quiescence.v1"
        || !quiescence.api_closed || quiescence.signal != "SIGTERM" {
        bail!("held UI API closure receipt differs");
    }
    validate_digest(&quiescence.intent_sha256, "held UI quiescence intent")?;
    validate_digest(&quiescence.retained_process_sha256, "held UI retained API process")?;
    validate_api_pin(&preflight.api_pin, accepted)?;
    validate_api_pin(&quiescence.api_pin, accepted)?;
    if quiescence.api_pin != preflight.api_pin {
        bail!("held UI API quiescence is not anchored to the exact preflight PID/start token");
    }
    let api_pin = &quiescence.api_pin;
    let retained = &quiescence.retained_process;
    if sha256(&canonical_lf(retained)) != quiescence.retained_process_sha256
        || quiescence.retained_process_sha256 != preflight.process_sha256 {
        bail!("held UI quiescence does not retain the exact preflight process receipt");
    }
    let store_binding = fullmag_runtime_control::accepted_store::store_binding(store_root)
        .context("resolve held UI process accepted-store binding")?;
    validate_ready_process(retained, api_pin, &preflight.ready_owner_identity, store_root, &store_binding)?;

    let process_raw = read_raw(root, &authority.native_drain, MAX_PROOF_BYTES, "held UI native drain")?;
    let process = parse_unique_value(&process_raw, "held UI native drain")?;
    if process.get("schema").and_then(Value::as_str) != Some("fullmag.docker-process-tree.v1")
        || process.get("state").and_then(Value::as_str) != Some("drained")
        || process.get("accepted_store").and_then(Value::as_str) != store_root.to_str()
        || process.get("api_pid").and_then(Value::as_u64) != api_pin.get("pid").and_then(Value::as_u64)
        || process.get("api_exit_code").and_then(Value::as_i64) != Some(-15)
        || process.get("error").and_then(Value::as_str) != Some("Fullmag API exited unexpectedly (-15)")
        || process.get("api_diagnostic_only").and_then(Value::as_bool) != Some(false) {
        bail!("held UI native drain does not prove the exact stopped API process");
    }
    let ready = super::validate_native_owner(process.get("service_owner").context("drain has no ready owner")?,
        "held UI drained ready owner", fullmag_session::runtime_service::RuntimeServiceState::Ready, &["running"])?;
    let terminal = super::validate_native_owner(process.get("terminal_service_owner").context("drain has no terminal owner")?,
        "held UI drained terminal owner", fullmag_session::runtime_service::RuntimeServiceState::Drained, &["exited_success"])?;
    let identity = owner_identity_value(&ready)?;
    if super::owner_identity_key(&ready) != super::owner_identity_key(&terminal)
        || identity != preflight.ready_owner_identity
        || quiescence.retained_process.get("service_owner") != Some(&ready) {
        bail!("held UI drain owner differs from quiescence and the exact preflight owner");
    }
    if fullmag_session::canonical_json_sha256(&identity) != preflight.ready_owner_sha256 {
        bail!("held UI Ready owner identity hash differs from preflight");
    }
    if process.pointer("/bootstrap/binding").and_then(Value::as_str) != Some(store_binding.as_str()) {
        bail!("held UI drain belongs to another accepted-store binding");
    }
    let drain_owner_image = ready.get("build_snapshot").and_then(Value::as_str)
        .context("held UI native owner has no build snapshot")?;
    validate_digest(drain_owner_image, "held UI native owner source snapshot")?;
    let terminal_raw = read_raw(control_root, &authority.terminal, MAX_PROOF_BYTES, "held UI outer stop terminal")?;
    let terminal_value = parse_unique_value(&terminal_raw, "held UI outer stop terminal")?;
    if canonical_lf(&terminal_value) != terminal_raw { bail!("held UI outer stop terminal is not canonical JSON plus LF"); }
    let terminal_obj = terminal_value.as_object().context("held UI outer stop terminal is not an object")?;
    let inputs = terminal_value.get("inputs").context("held UI stop terminal has no inputs")?;
    if terminal_obj.get("schema").and_then(Value::as_str) != Some("fullmag.docker-build-operation.v1")
        || terminal_obj.get("phase").and_then(Value::as_str) != Some("held-ui-materialization-stop")
        || terminal_obj.get("state").and_then(Value::as_str) != Some("succeeded")
        || terminal_obj.get("attempt").and_then(Value::as_str) != Some(&authority.stop_attempt)
        || terminal_obj.get("idle_backend_stopped").and_then(Value::as_bool) != Some(true)
        || terminal_obj.get("config_sha256").and_then(Value::as_str) != Some(&scope.runtime_config_sha256)
        || terminal_obj.get("compose_project").and_then(Value::as_str) != Some(&scope.compose_project)
        || terminal_obj.get("control_volume").and_then(Value::as_str) != Some(&scope.control_volume)
        || terminal_obj.get("control_namespace").and_then(Value::as_str).unwrap_or("") != scope.namespace
        || terminal_obj.get("namespace_registry_sha256").and_then(Value::as_str) != scope.namespace_registry_sha256.as_deref()
        || terminal_obj.get("backend_container").and_then(Value::as_str) != Some(&scope.backend_container_id)
        || terminal_obj.get("backend_started_at").and_then(Value::as_str) != Some(&scope.backend_started_at)
        || terminal_obj.get("frontend_container").and_then(Value::as_str) != Some(&scope.frontend_container_id)
        || terminal_obj.get("frontend_started_at").and_then(Value::as_str) != Some(&scope.frontend_started_at)
        || inputs.get("source_scope") != Some(&serde_json::to_value(scope)?)
        || inputs.get("accepted_run_id").and_then(Value::as_str) != Some(&accepted.run_id)
        || inputs.get("plan_sha256").and_then(Value::as_str) != Some(&input.plan.plan_sha256)
        || inputs.get("maintenance_request_id").and_then(Value::as_str) != Some(&input.plan.maintenance_request_id)
        || inputs.get("source_root").and_then(Value::as_str) != Some(&scope.source_root)
        || inputs.get("config_sha256").and_then(Value::as_str) != Some(&scope.runtime_config_sha256)
        || inputs.get("capture_held_ui_materialization").and_then(Value::as_bool) != Some(true) {
        bail!("held UI stop terminal does not bind the exact source, plan, run, namespace, and service IDs");
    }
    let services_value = terminal_value.get("held_ui_stop_services")
        .context("held UI stop terminal has no typed stopped-service pins")?;
    let services = services_value.as_object().context("held UI stopped-service pins are not an object")?;
    let services_sha = terminal_value.get("held_ui_stop_services_sha256").and_then(Value::as_str)
        .context("held UI stop terminal has no stopped-service digest")?;
    validate_digest(services_sha, "held UI stopped-service digest")?;
    if sha256(&canonical_lf(services_value)) != services_sha || services.len() != 2 {
        bail!("held UI stopped-service pins differ from their canonical digest");
    }
    for (name, id, started_at) in [
        ("backend", scope.backend_container_id.as_str(), scope.backend_started_at.as_str()),
        ("frontend", scope.frontend_container_id.as_str(), scope.frontend_started_at.as_str()),
    ] {
        let service = services.get(name).and_then(Value::as_object)
            .with_context(|| format!("held UI stop terminal has no {name} pin"))?;
        let fields = ["id", "image_id", "started_at", "running"];
        if service.len() != fields.len() || fields.iter().any(|field| !service.contains_key(*field))
            || service.get("id").and_then(Value::as_str) != Some(id)
            || service.get("started_at").and_then(Value::as_str) != Some(started_at)
            || service.get("running").and_then(Value::as_bool) != Some(false) {
            bail!("held UI {name} stopped incarnation differs from the selected group");
        }
        super::validate_image_id(service.get("image_id").and_then(Value::as_str)
            .context("held UI stopped service has no image id")?, "held UI stopped service image")?;
    }
    let intent_sha = terminal_obj.get("api_quiescence_intent_sha256").and_then(Value::as_str)
        .context("held UI stop terminal does not bind the API quiescence intent")?;
    validate_digest(intent_sha, "held UI API quiescence intent hash")?;
    if intent_sha != quiescence.intent_sha256 { bail!("held UI stop terminal and API quiescence intent differ"); }
    let intent_ref = RecordRef {
        path: format!("{STOP_TERMINAL_PREFIX}{}/api-quiescence-intent.json", authority.stop_attempt),
        sha256: intent_sha.to_owned(),
    };
    let intent_raw = read_raw(control_root, &intent_ref, MAX_PROOF_BYTES, "held UI API quiescence intent")?;
    let intent_value = parse_unique_value(&intent_raw, "held UI API quiescence intent")?;
    if canonical_lf(&intent_value) != intent_raw
        || intent_value.get("schema").and_then(Value::as_str) != Some("fullmag.native-terminal-api-quiescence-intent.v1") {
        bail!("held UI API quiescence intent schema or canonical encoding differs");
    }
    let prepared = intent_value.get("prepared").context("held UI API quiescence intent has no prepared pins")?;
    if prepared.get("native_config_sha256").and_then(Value::as_str) != Some(&preflight.native_config_sha256)
        || prepared.get("process_sha256").and_then(Value::as_str) != Some(&preflight.process_sha256)
        || prepared.get("api_pin") != Some(&preflight.api_pin)
        || prepared.get("ready_owner").is_none_or(|owner| owner_identity_value(owner).ok().as_ref() != Some(&preflight.ready_owner_identity)) {
        bail!("held UI API quiescence intent differs from preflight process, API, or owner");
    }
    let snapshot = &preflight.api_response.snapshot;
    let status = &snapshot["status"];
    let scene = &snapshot["scene"];
    let binding = json!({
        "schema_version": "fullmag.native-terminal-stop-preflight.v1",
        "api_instance_id": snapshot["api_instance_id"],
        "session_id": status["session"]["session_id"],
        "session_epoch": status["session"]["session_epoch"],
        "request_scope_epoch": status["session"]["request_scope_epoch"],
        "run_id": snapshot["run"]["run_id"],
        "public_run": snapshot["run"],
        "resources": status["resources"],
        "scene_sha256": fullmag_session::canonical_json_sha256(scene),
        "scene_revision": status["resources"]["scene_revision"],
        "queue": snapshot["queue"],
        "commands": snapshot["commands"],
        "runtime": snapshot["runtime"],
        "health": {"status": "ok", "active_session": true},
    });
    if prepared.get("preflight") != Some(&binding) {
        bail!("held UI quiescence intent preflight differs from exact HTTP responses");
    }
    Ok(())
}

fn validate_and_load_held_authority(
    input: Input,
    runtime_control_root: &Path,
    build_control_root: &Path,
    store_root: &Path,
) -> Result<ValidatedHeldAuthority> {
    validate_input_shape(&input).context("validate held UI input")?;
    validate_launch_and_request(runtime_control_root, &input)
        .context("authenticate held UI request and launch")?;
    validate_environment_and_target(&input, store_root)
        .context("validate held UI target runtime")?;

    let preflight_value = read_canonical_record(
        runtime_control_root, &input.stop_authority.preflight, "held UI preflight",
    )?;
    let preflight: PreflightProof = serde_json::from_value(preflight_value)
        .context("decode held UI preflight")?;
    validate_preflight(&preflight, &input).context("validate held UI preflight")?;

    let inventory_value = read_canonical_record(
        runtime_control_root, &input.stop_authority.inventory, "held UI inventory",
    )?;
    let inventory: InventoryProof = serde_json::from_value(inventory_value)
        .context("decode held UI inventory")?;
    validate_inventory(&inventory, &input).context("validate held UI inventory")?;

    validate_stop_authority(
        runtime_control_root, build_control_root, &input, &preflight, store_root,
    ).context("validate held UI stop, quiescence, and native drain")?;
    let loaded = validate_store(&input, store_root, &inventory, &preflight)
        .context("validate held UI immutable accepted run and store")?;
    let input_sha256 = sha256(&canonical_lf(&serde_json::to_value(&input)?));
    Ok(ValidatedHeldAuthority {
        input,
        input_sha256,
        store_root: store_root.to_owned(),
        loaded,
    })
}

fn validate_restore_environment_mode() -> Result<()> {
    if [
        super::INPUT_ENV,
        super::LEGACY_INPUT_ENV,
        terminal_observation::ENV,
        "FULLMAG_DEVELOPMENT_ACCEPTED_REATTACH_STDIN",
        "FULLMAG_DEVELOPMENT_TERMINAL_OBSERVATION_STDIN",
        "FULLMAG_CONTAINER_RECOVERY_AUTHORIZATION",
        "FULLMAG_CONTAINER_RECOVERY_AUTHORIZATION_SHA256",
        "FULLMAG_RUNTIME_RECOVERY_AUTHORIZATION",
        "FULLMAG_STARTUP_SCRIPT",
        "FULLMAG_STARTUP_PROVENANCE",
        "FULLMAG_STARTUP_API",
        "FULLMAG_STARTUP_PROVENANCE_SHA256",
        "FULLMAG_STARTUP_HELPER_SHA256",
        "FULLMAG_STARTUP_RECEIPT_KEY",
    ].iter().any(|name| std::env::var_os(name).is_some())
    {
        bail!("held UI materialization cannot be combined with another restore, recovery, or startup mode");
    }
    match std::env::var_os("FULLMAG_STARTUP_ENABLED") {
        Some(value) if value != "0" => bail!("held UI materialization requires startup activation to be disabled"),
        _ => {}
    }
    Ok(())
}

pub(super) async fn restore_before_listen(state: &Arc<AppState>) -> Result<(), String> {
    match std::env::var_os(ENV) {
        Some(value) if value == "1" => {}
        _ => return Err("invalid private held UI materialization configuration".into()),
    }
    validate_restore_environment_mode()
        .map_err(|error| format!("held UI restore mode validation failed: {error:#}"))?;
    let input = read_input().await?;
    validate_input_shape(&input).map_err(|error| format!("held UI restore input validation failed: {error:#}"))?;
    if state.current_live_state.read().await.is_some()
        || state.current_live_session_epoch.load(std::sync::atomic::Ordering::Acquire) != 0 {
        return Err("held UI materialization requires a fresh API workspace".into());
    }
    let store_root = state.submit_store_root.clone()
        .ok_or_else(|| "held UI materialization has no configured accepted store".to_owned())?;
    let runtime_control_root = super::configured_runtime_control_root()
        .map_err(|error| format!("held UI runtime control is unavailable: {error:#}"))?;
    let build_control_root = std::path::PathBuf::from(STOP_TERMINAL_ROOT);
    let validation = tokio::task::spawn_blocking(move || {
        validate_and_load_held_authority(input, &runtime_control_root, &build_control_root, &store_root)
    }).await.map_err(|error| format!("held UI authority validation task failed: {error}"))?
        .map_err(|error| format!("held UI authority validation failed: {error:#}"))?;
    drop(validation);
    Err("held UI authority validated; materialization is not installed yet".into())
}

#[cfg(test)]
mod tests {
    use super::*;

    fn fixture() -> Input {
        Input {
            accepted: AcceptedPins {
                accepted_scene_sha256: "a".repeat(64),
                client_intent_id: "study:relax:1794584570782:eddae8c0-f2ae-46fe-9f57-d676e0eba121".into(),
                command_id: "fm-5886f18f-96bd-481b-a064-726f49b22d07".into(),
                command_kind: "relax".into(),
                definition_sha256: "b".repeat(64), execution_input_sha256: "c".repeat(64),
                old_api_instance_id: "75c6d4d1-00a9-416d-b27e-6fda461ad85d".into(),
                old_request_scope_epoch: "75c6d4d1-00a9-416d-b27e-6fda461ad85d:1".into(),
                project_id: "project-live-4100b4f4843786fb095305286d66ea1d5b3cf4f23d17abc62e384f6cf7c303e1".into(),
                request_id: "09126e13-8dce-4a7b-9093-350188eb660a".into(),
                request_key_sha256: "d".repeat(64), request_receipt_sha256: "e".repeat(64),
                request_sha256: "f".repeat(64),
                run_id: "run-live-6b6552a649f3cd4a87309ab4b48a1f0c83c0a884636a180dea580f83e0bf8cd0".into(),
                run_intent_payload_sha256: "1".repeat(64), run_intent_sha256: "2".repeat(64),
                scene_revision: 2, session_epoch: 1, session_created_at_unix_ms: 1794582150656,
                session_id: "session-live-4100b4f4843786fb095305286d66ea1d5b3cf4f23d17abc62e384f6cf7c303e1".into(),
                study_sha256: "3".repeat(64),
            },
            launch_id: "00000000-0000-4000-8000-000000000000".into(),
            plan: Plan { attempt: "4".repeat(32), maintenance_request_id: "00000000-0000-4000-8000-000000000001".into(), plan_sha256: "5".repeat(64) },
            schema: INPUT_SCHEMA.into(),
            source_scope: SourceScope {
                backend_container_id: "a".repeat(64), backend_started_at: "2026-11-13T00:00:00Z".into(),
                compose_project: "fullmag-fixture".into(), control_volume: "fullmag-control".into(),
                frontend_container_id: "b".repeat(64), frontend_started_at: "2026-11-13T00:00:00Z".into(),
                namespace: String::new(), namespace_registry_sha256: None,
                runtime_config_sha256: "6".repeat(64), source_root: "/src/fullmag".into(),
                state_root_sha256: "7".repeat(64),
            },
            stop_authority: StopAuthority {
                api_quiescence: RecordRef { path: "held-ui-materialization/00000000-0000-4000-8000-000000000001/api-quiescence.json".into(), sha256: "8".repeat(64) },
                inventory: RecordRef { path: "held-ui-materialization/00000000-0000-4000-8000-000000000001/inventory.json".into(), sha256: "9".repeat(64) },
                native_drain: RecordRef { path: "held-ui-materialization/00000000-0000-4000-8000-000000000001/native-drain.json".into(), sha256: "a".repeat(64) },
                preflight: RecordRef { path: "held-ui-materialization/00000000-0000-4000-8000-000000000001/preflight.json".into(), sha256: "b".repeat(64) },
                stop_attempt: "c".repeat(32),
                terminal: RecordRef { path: format!("{STOP_TERMINAL_PREFIX}{}/terminal.json", "c".repeat(32)), sha256: "d".repeat(64) },
            },
            target_runtime: TargetRuntime {
                build_id: "a".repeat(40), source_sha256: "e".repeat(64),
                image_id: format!("sha256:{}", "f".repeat(64)), config_sha256: "6".repeat(64),
                accepted_store_binding: "1".repeat(64),
            },
        }
    }

    #[test]
    fn input_shape_binds_original_command_session_and_exact_proof_namespace() {
        let input = fixture();
        validate_input_shape(&input).unwrap();
        let mut wrong = input.clone();
        wrong.accepted.old_request_scope_epoch = "75c6d4d1-00a9-416d-b27e-6fda461ad85d:2".into();
        assert!(validate_input_shape(&wrong).is_err());
        let mut wrong = input.clone();
        wrong.stop_authority.preflight.path = "held-ui-materialization/foreign/preflight.json".into();
        assert!(validate_input_shape(&wrong).is_err());
    }

    #[test]
    fn status_session_epoch_must_match_the_unmodified_http_wire_shape() {
        let accepted = fixture().accepted;
        let session = json!({
            "session_id": accepted.session_id,
            "session_epoch": format!("{}@{}", accepted.session_id, accepted.session_created_at_unix_ms),
            "created_at": accepted.session_created_at_unix_ms.to_string(),
            "request_scope_epoch": accepted.old_request_scope_epoch,
        });
        validate_status_session_epoch(&session, &accepted).unwrap();

        let mut normalized = session.clone();
        normalized["session_epoch"] = json!(accepted.session_epoch);
        assert!(validate_status_session_epoch(&normalized, &accepted).is_err());

        let mut drifted_created_at = session;
        drifted_created_at["created_at"] = json!((accepted.session_created_at_unix_ms + 1).to_string());
        assert!(validate_status_session_epoch(&drifted_created_at, &accepted).is_err());
    }

    #[test]
    fn immutable_live_workspace_binds_old_api_internal_epoch_and_scene_revision() {
        let accepted = fixture().accepted;
        let live = json!({
            "session_id": accepted.session_id,
            "session_epoch": accepted.session_epoch,
            "api_instance_id": accepted.old_api_instance_id,
            "scene_revision": accepted.scene_revision,
        });
        validate_live_workspace_binding(&live, &accepted).unwrap();

        let mut wrong_api = live.clone();
        wrong_api["api_instance_id"] = json!("00000000-0000-4000-8000-000000000000");
        assert!(validate_live_workspace_binding(&wrong_api, &accepted).is_err());

        let mut wrong_scene = live;
        wrong_scene["scene_revision"] = json!(accepted.scene_revision + 1);
        assert!(validate_live_workspace_binding(&wrong_scene, &accepted).is_err());
    }

    #[test]
    fn preflight_separates_old_native_config_from_retained_compose_config() {
        let input = fixture();
        let identity = json!({
            "owner_token": "1".repeat(32),
            "process_start_token": "101",
            "pid": 101,
            "host": "linux-native",
            "target_id": "docker-all",
            "protocol": "runtime-service.v1",
            "build_commit": "2".repeat(40),
            "build_snapshot": "3".repeat(64),
            "control_address": "127.0.0.1:44100",
            "compute_pool_generation": 1,
            "preparation_pool_generation": 1,
            "compute_pool_id": "pool-compute",
            "preparation_pool_id": "pool-preparation",
            "children": [["compute", 102], ["preparation", 103]],
        });
        let proof = PreflightProof {
            api_pin: json!({
                "pid": 101,
                "start_token": "1000",
                "ppid": 99,
                "argv": ["/opt/fullmag/package/bin/fullmag-api"],
                "exe": "/opt/fullmag/package/bin/fullmag-api",
            }),
            api_response: ApiResponseProof {
                responses: std::collections::BTreeMap::new(),
                snapshot: Value::Null,
            },
            commands: CommandProof {
                command: Value::Null,
                detail: CommandDetailProof { http_status: 404, raw_base64: String::new(), sha256: "4".repeat(64) },
                ledger: Value::Null,
                request_receipt: Value::Null,
                request_receipt_sha256: "5".repeat(64),
            },
            execution_input_sha256: input.accepted.execution_input_sha256.clone(),
            native_config_sha256: "8".repeat(64),
            process_sha256: "9".repeat(64),
            ready_owner_identity: identity.clone(),
            ready_owner_sha256: fullmag_session::canonical_json_sha256(&identity),
            run_intent_sha256: input.accepted.run_intent_sha256.clone(),
            schema: "fullmag.held-ui-materialization-preflight.v1".into(),
            source_scope: input.source_scope.clone(),
        };
        assert_ne!(proof.native_config_sha256, input.source_scope.runtime_config_sha256);
        validate_preflight_scope(&proof, &input).unwrap();

        let mut drifted = proof;
        drifted.source_scope.runtime_config_sha256 = "a".repeat(64);
        assert!(validate_preflight_scope(&drifted, &input).is_err());
    }

    #[test]
    fn authority_loader_refuses_missing_immutable_request_without_writing() {
        let runtime_control = tempfile::tempdir().unwrap();
        let build_control = tempfile::tempdir().unwrap();
        let store = tempfile::tempdir().unwrap();
        let before = std::fs::read_dir(runtime_control.path()).unwrap().count();
        let result = validate_and_load_held_authority(
            fixture(), runtime_control.path(), build_control.path(), store.path(),
        );
        assert!(result.is_err());
        assert_eq!(std::fs::read_dir(runtime_control.path()).unwrap().count(), before);
        assert_eq!(std::fs::read_dir(build_control.path()).unwrap().count(), 0);
        assert_eq!(std::fs::read_dir(store.path()).unwrap().count(), 0);
    }

    #[test]
    fn input_schema_rejects_unknown_and_partial_fields() {
        let mut value = serde_json::to_value(fixture()).unwrap();
        value.as_object_mut().unwrap().insert("extra".into(), json!(true));
        assert!(serde_json::from_value::<Input>(value).is_err());
        let mut value = serde_json::to_value(fixture()).unwrap();
        value.as_object_mut().unwrap().remove("target_runtime");
        assert!(serde_json::from_value::<Input>(value).is_err());
    }
}
