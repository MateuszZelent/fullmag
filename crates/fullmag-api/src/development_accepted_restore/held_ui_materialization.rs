//! Private pre-listen restoration of one accepted live Compute whose durable
//! RunIntent exists but whose catalog/frontier was not materialized before the
//! former API process stopped. This path never creates a new intent or command.
use super::*;
use base64::Engine;

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
    run_intent_sha256: String,
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
    accepted_store_binding: String,
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



#[derive(Debug, Clone)]
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

#[derive(Clone)]
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

/// Validate the immutable task identities of a catalog after the original
/// start gate has been released. Scheduler lifecycle, attempt, and revision
/// fields are expected to advance; task membership and input fingerprints are
/// still fixed by the accepted RunIntent.
fn validate_catalog_task_identity(
    store: &fullmag_session::SessionStore,
    run_id: &str,
    accepted: &fullmag_runtime_control::AcceptedStudySnapshot,
) -> Result<()> {
    let mut expected = std::collections::BTreeMap::new();
    for step in accepted.lowered.steps.iter()
        .filter(|step| matches!(step.status, fullmag_plan::StudyStepLoweringStatus::Planned))
    {
        let task_id = fullmag_session::task_id_for_study_step(run_id, &step.step_id)?;
        let fingerprint = fullmag_application::study_task_input_fingerprint(
            &accepted.run.specification,
            step,
        )?;
        if expected.insert(task_id, fingerprint).is_some() {
            bail!("held UI accepted plan derives duplicate task identities");
        }
    }
    if expected.is_empty() {
        bail!("held UI RunIntent has no planned executable tasks");
    }
    let catalog = store.read_run_catalog(run_id)?
        .context("released held UI run has no task catalog")?;
    if catalog.run_id != run_id || catalog.tasks.len() != expected.len() {
        bail!("released held UI catalog has a foreign run or task set");
    }
    let mut observed = std::collections::BTreeSet::new();
    for task in &catalog.tasks {
        let fingerprint = expected.get(&task.task_id)
            .context("released held UI catalog contains a foreign task")?;
        if fingerprint != &task.input_fingerprint || !observed.insert(task.task_id.as_str()) {
            bail!("released held UI task identity or accepted input fingerprint changed");
        }
    }
    if observed.len() != expected.len() {
        bail!("released held UI catalog lost an accepted task");
    }
    Ok(())
}

fn validate_released_run_directory(
    store: &fullmag_session::SessionStore,
    run_id: &str,
) -> Result<()> {
    let relative = format!("runs/{run_id}");
    let directory = fullmag_session::repository_path::checked_path(store.root(), &relative)?;
    let metadata = std::fs::symlink_metadata(&directory)
        .context("inspect released held UI run directory")?;
    if !metadata.is_dir() || metadata.file_type().is_symlink() {
        bail!("released held UI run directory is not a real directory");
    }
    for required in ["live_demand.v1.json", "run_intent.json", "run_catalog.json", "start_release.json"] {
        let path = directory.join(required);
        let metadata = std::fs::symlink_metadata(&path)
            .with_context(|| format!("inspect released held UI `{required}`"))?;
        if !metadata.is_file() || metadata.file_type().is_symlink() {
            bail!("released held UI `{required}` is not a regular file");
        }
    }
    // After the original gate opens, preserve the ordinary scheduler's native
    // history as opaque data. It is not restore authority: exact RunIntent/CAS,
    // typed catalog task identities, release receipt, and command readback are
    // validated separately. No links or special files are admitted here.
    validate_no_link_tree(&directory, 0)
}

fn validate_no_link_tree(path: &std::path::Path, depth: usize) -> Result<()> {
    if depth > 32 {
        bail!("released held UI run history exceeds the directory depth bound");
    }
    for entry in std::fs::read_dir(path).context("list released held UI history")? {
        let entry = entry?;
        let metadata = std::fs::symlink_metadata(entry.path())?;
        if metadata.file_type().is_symlink() || (!metadata.is_file() && !metadata.is_dir()) {
            bail!("released held UI run history contains a link or special file");
        }
        if metadata.is_dir() {
            validate_no_link_tree(&entry.path(), depth + 1)?;
        }
    }
    Ok(())
}

fn materialize_held_catalog(authority: &ValidatedHeldAuthority) -> Result<fullmag_session::FmsRunCatalog> {
    let input = &authority.input;
    let loaded = &authority.loaded;
    let store = fullmag_session::SessionStore::open_existing(&authority.store_root)
        .context("open held UI accepted store for catalog materialization")?;
    let run_id = loaded.run_id.as_str();
    let intent_relative = format!("runs/{run_id}/run_intent.json");
    let intent_raw = fullmag_session::repository_path::read_bounded_regular_file(
        &authority.store_root,
        &intent_relative,
        MAX_PROOF_BYTES,
    ).context("re-read immutable held UI RunIntent before catalog materialization")?;
    if sha256(&intent_raw) != input.accepted.run_intent_sha256 {
        bail!("held UI RunIntent changed before catalog materialization");
    }
    let intent: fullmag_session::FmsRunIntent =
        serde_json::from_slice(&intent_raw).context("decode held UI RunIntent before materialization")?;
    if intent != loaded.intent
        || intent.payload_sha256 != input.accepted.run_intent_payload_sha256
    {
        bail!("held UI immutable RunIntent differs before catalog materialization");
    }
    let accepted = fullmag_runtime_control::load_accepted_study_snapshot(
        &store,
        &loaded.run_id,
        &loaded.project_id,
    ).context("reload held UI accepted CAS snapshot before catalog materialization")?;
    if accepted.run.intent != loaded.intent || accepted.run.specification != loaded.specification {
        bail!("held UI accepted RunIntent or CAS specification changed before catalog materialization");
    }

    let catalog_present = validate_catalog_without_progress(&store, run_id, &accepted)
        .context("check held UI catalog for conflicting identity or progress")?;
    if loaded.release_exists
        || store.read_accepted_run_start_release(run_id)?.is_some()
        || store.accepted_run_start_permitted(run_id)?
    {
        bail!("held UI catalog materialization requires the original start gate to remain closed");
    }
    let planned_task_ids = accepted.lowered.steps.iter()
        .filter(|step| matches!(step.status, fullmag_plan::StudyStepLoweringStatus::Planned))
        .map(|step| fullmag_session::task_id_for_study_step(run_id, &step.step_id))
        .collect::<Result<std::collections::BTreeSet<_>>>()?;
    validate_run_directory(&store, run_id, catalog_present, false, &planned_task_ids)
        .context("validate held UI run directory before catalog materialization")?;

    // The prior readers return owned snapshots and leave no store transaction
    // open across the normal catalog writer.
    let catalog = crate::run_intent_persistence::materialize_accepted_run_catalog(
        &store,
        run_id,
        &loaded.project_id,
    ).context("materialize held UI catalog from the exact accepted CAS snapshot")?;
    if catalog.run_id != run_id || catalog.revision != 1 {
        bail!("held UI catalog writer returned another run or revision");
    }

    let post_intent_raw = fullmag_session::repository_path::read_bounded_regular_file(
        &authority.store_root,
        &intent_relative,
        MAX_PROOF_BYTES,
    ).context("re-read held UI RunIntent after catalog materialization")?;
    if sha256(&post_intent_raw) != input.accepted.run_intent_sha256 || post_intent_raw != intent_raw {
        bail!("held UI catalog materialization changed the immutable RunIntent bytes");
    }
    let post_snapshot = fullmag_runtime_control::load_accepted_study_snapshot(
        &store,
        &loaded.run_id,
        &loaded.project_id,
    ).context("re-read held UI accepted CAS snapshot after catalog materialization")?;
    if post_snapshot.run.intent != loaded.intent
        || post_snapshot.run.specification != loaded.specification
        || !validate_catalog_without_progress(&store, run_id, &post_snapshot)?
    {
        bail!("held UI catalog is not the exact no-progress materialization of its accepted RunIntent");
    }
    validate_run_directory(&store, run_id, true, false, &planned_task_ids)
        .context("validate held UI run directory after catalog materialization")?;
    let persisted = store.read_run_catalog(run_id)?
        .context("held UI run catalog disappeared after materialization")?;
    if persisted.run_id != catalog.run_id || persisted.revision != catalog.revision
        || persisted.tasks != catalog.tasks {
        bail!("held UI persisted catalog differs from the exact materialized catalog");
    }
    if store.read_accepted_run_start_release(run_id)?.is_some()
        || store.accepted_run_start_permitted(run_id)? {
        bail!("held UI catalog materialization opened the accepted run start gate");
    }
    Ok(persisted)
}

#[derive(Debug, PartialEq, Eq)]
struct HeldStoreEvidence {
    catalog_sha256: String,
    start_release_sha256: Option<String>,
}

fn raw_run_record_sha256(authority: &ValidatedHeldAuthority, file_name: &str) -> Result<String> {
    if !matches!(file_name, "run_catalog.json" | "start_release.json") {
        bail!("held UI run record name is not allowed");
    }
    let relative = format!("runs/{}/{}", authority.loaded.run_id.as_str(), file_name);
    let raw = fullmag_session::repository_path::read_bounded_regular_file(
        &authority.store_root,
        &relative,
        MAX_PROOF_BYTES,
    )
    .with_context(|| format!("read held UI `{file_name}` bytes"))?;
    Ok(sha256(&raw))
}

/// Re-read and bind the exact accepted catalog and optional original release.
/// This is deliberately read-only; callers invoke it before release and after
/// release so a retry cannot create a second gate or synthesize a command.
fn validate_held_store_evidence(
    authority: &ValidatedHeldAuthority,
    expect_release: bool,
) -> Result<HeldStoreEvidence> {
    let input = &authority.input;
    let loaded = &authority.loaded;
    let store = fullmag_session::SessionStore::open_existing(&authority.store_root)
        .context("open held UI accepted store for release verification")?;
    let run_id = loaded.run_id.as_str();
    let intent_relative = format!("runs/{run_id}/run_intent.json");
    let intent_raw = fullmag_session::repository_path::read_bounded_regular_file(
        &authority.store_root,
        &intent_relative,
        MAX_PROOF_BYTES,
    )
    .context("read held UI immutable RunIntent before release verification")?;
    if sha256(&intent_raw) != input.accepted.run_intent_sha256 {
        bail!("held UI RunIntent changed before release verification");
    }
    let intent: fullmag_session::FmsRunIntent =
        serde_json::from_slice(&intent_raw).context("decode held UI RunIntent before release verification")?;
    if intent != loaded.intent || intent.payload_sha256 != input.accepted.run_intent_payload_sha256 {
        bail!("held UI RunIntent differs before release verification");
    }
    let accepted = fullmag_runtime_control::load_accepted_study_snapshot(
        &store,
        &loaded.run_id,
        &loaded.project_id,
    )
    .context("reload held UI accepted CAS before release verification")?;
    if accepted.run.intent != intent || accepted.run.specification != loaded.specification {
        bail!("held UI accepted CAS differs before release verification");
    }
    let release = store.read_accepted_run_start_release(run_id)?;
    if release.is_some() != expect_release
        || store.accepted_run_start_permitted(run_id)? != expect_release
    {
        bail!("held UI start release state differs from the expected gate phase");
    }
    if let Some(release) = release.as_ref() {
        let expected_id = crate::live_accepted_execution::accepted_start_release_request_id(
            run_id,
            &input.accepted.request_id,
        );
        if release.run_id != run_id
            || release.specification_sha256 != intent.payload_sha256
            || release.request_id != expected_id
            || release.live_request.as_ref() != Some(&loaded.receipt)
        {
            bail!("held UI start release differs from the original accepted request receipt");
        }
    }

    let planned_task_ids = accepted.lowered.steps.iter()
        .filter(|step| matches!(step.status, fullmag_plan::StudyStepLoweringStatus::Planned))
        .map(|step| fullmag_session::task_id_for_study_step(run_id, &step.step_id))
        .collect::<Result<std::collections::BTreeSet<_>>>()?;
    if expect_release {
        validate_catalog_task_identity(&store, run_id, &accepted)
            .context("validate held UI released catalog task identities")?;
        validate_released_run_directory(&store, run_id)
            .context("validate held UI released run history")?;
    } else {
        if !validate_catalog_without_progress(&store, run_id, &accepted)
            .context("validate held UI closed-gate catalog before release verification")?
        {
            bail!("held UI accepted catalog is missing before release verification");
        }
        validate_run_directory(&store, run_id, true, false, &planned_task_ids)
            .context("validate held UI closed-gate run directory before release verification")?;
    }

    let start_release_sha256 = if let Some(release) = release {
        let readback = crate::live_compute_request::accepted_command_readback(
            &store,
            &intent,
            "waiting_for_compute",
        )
        .map_err(|error| anyhow::anyhow!("held UI original command readback failed: {error}"))?
        .context("held UI original accepted command is missing after release")?;
        let binding = readback.command.execution_binding.as_ref()
            .context("held UI original command readback has no execution binding")?;
        let binding_target = binding.requested_target.as_ref()
            .map(serde_json::to_value)
            .transpose()
            .context("encode held UI readback target")?;
        if readback.command.command_id != input.accepted.command_id
            || readback.command.kind != input.accepted.command_kind
            || readback.command.client_intent_id.as_deref() != Some(input.accepted.client_intent_id.as_str())
            || readback.request_id.as_deref() != Some(input.accepted.request_id.as_str())
            || binding.run_id != input.accepted.run_id
            || binding_target != loaded.receipt.requested_target
        {
            bail!("held UI original accepted command readback differs from its immutable receipt");
        }
        Some(raw_run_record_sha256(authority, "start_release.json")?)
    } else {
        None
    };
    Ok(HeldStoreEvidence {
        catalog_sha256: raw_run_record_sha256(authority, "run_catalog.json")?,
        start_release_sha256,
    })
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

fn validate_held_fdm_scope(
    accepted: &fullmag_runtime_control::AcceptedStudySnapshot,
) -> Result<()> {
    for step in accepted.lowered.steps.iter().filter(|step|
        matches!(step.status, fullmag_plan::StudyStepLoweringStatus::Planned)
    ) {
        let plan = step.execution_plan.as_ref()
            .context("held UI planned step has no resolved execution plan")?;
        if plan.common.resolved_backend != fullmag_ir::BackendTarget::Fdm {
            bail!("held UI materialization supports only resolved FDM execution plans");
        }
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
    preflight: &PreflightProof,
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
    let pinned_http_scene = preflight_scene_document(preflight, &input.accepted)?;
    if specification.snapshot.definition_sha256 != input.accepted.definition_sha256
        || specification.study.plan_sha256 != input.accepted.study_sha256
        || scene.revision != input.accepted.scene_revision
        || pinned_http_scene != *scene {
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
    if binding != input.target_runtime.accepted_store_binding
        || binding != preflight.accepted_store_binding {
        bail!("held UI private input or preflight targets another accepted store");
    }
    let store_id = fullmag_session::host_resource_ledger::HostResourceLedger::store_id(store_root)
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
    validate_held_fdm_scope(&accepted)
        .context("validate held UI resolved execution backend scope")?;
    let scene = super::scene_from_definition(&accepted.run.definition_bytes, &specification)?;
    validate_inventory_files(&store, input, inventory, &specification, &scene, preflight)?;
    let planned = accepted.lowered.steps.iter()
        .filter(|step| matches!(step.status, fullmag_plan::StudyStepLoweringStatus::Planned))
        .map(|step| fullmag_session::task_id_for_study_step(run_id.as_str(), &step.step_id))
        .collect::<Result<std::collections::BTreeSet<_>>>()?;
    let release = store.read_accepted_run_start_release(run_id.as_str())?;
    let release_exists = if let Some(release) = release.as_ref() {
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
    if store.accepted_run_start_permitted(run_id.as_str())? != release_exists {
        bail!("held UI manual accepted run release and start gate differ");
    }
    let catalog_present = if release_exists {
        validate_catalog_task_identity(&store, run_id.as_str(), &accepted)?;
        validate_released_run_directory(&store, run_id.as_str())?;
        true
    } else {
        let present = validate_catalog_without_progress(&store, run_id.as_str(), &accepted)?;
        validate_run_directory(&store, run_id.as_str(), present, false, &planned)?;
        present
    };
    if release_exists && !catalog_present { bail!("held UI start release exists without its accepted catalog"); }
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

fn read_transport_record(root: &Path, reference: &RecordRef, label: &str) -> Result<Value> {
    let bytes = read_raw(root, reference, MAX_PROOF_BYTES, label)?;
    // Python owns these immutable transport proofs and pins their exact raw
    // bytes. Keep duplicate-key and typed-schema rejection, but do not
    // reserialize Python floats through Rust's different exponent formatter.
    parse_unique_value(&bytes, label)
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
        (&proof.accepted_store_binding, "held UI preflight accepted-store binding"),
        (&proof.native_config_sha256, "held UI old native configuration"),
        (&proof.ready_owner_sha256, "held UI old Ready owner"),
        (&proof.process_sha256, "held UI old process receipt"),
        (&proof.run_intent_sha256, "held UI preflight RunIntent"),
        (&proof.execution_input_sha256, "held UI preflight execution input"),
    ] {
        super::validate_digest(digest, label)?;
    }
    if proof.accepted_store_binding != input.target_runtime.accepted_store_binding {
        bail!("held UI preflight accepted-store binding differs from the target runtime");
    }
    if fullmag_session::canonical_json_sha256(&proof.ready_owner_identity) != proof.ready_owner_sha256 {
        bail!("held UI Ready owner identity differs from its preflight hash");
    }
    validate_api_pin(&proof.api_pin, &input.accepted)?;
    Ok(())
}

fn preflight_scene_document(proof: &PreflightProof, accepted: &AcceptedPins) -> Result<SceneDocument> {
    let body = proof.api_response.responses.get("scene")
        .context("held UI preflight has no raw scene response")?;
    let bytes = base64::engine::general_purpose::STANDARD.decode(&body.raw_base64)
        .context("decode held UI raw scene response")?;
    if bytes.len() > MAX_PROOF_BYTES
        || sha256(&bytes) != body.sha256
        || body.sha256 != accepted.accepted_scene_sha256
    {
        bail!("held UI raw scene response differs from its accepted byte pin");
    }
    let value = parse_unique_value(&bytes, "held UI raw scene response")?;
    let scene: SceneDocument = serde_json::from_value(value)
        .context("decode held UI raw scene document")?;
    if scene.revision != accepted.scene_revision {
        bail!("held UI raw scene response has another scene revision");
    }
    Ok(scene)
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
        || preflight_scene_document(proof, accepted)?.revision != accepted.scene_revision {
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

fn validate_process_diagnostic_mode(receipt: &Value) -> Result<()> {
    match receipt.get("api_diagnostic_only") {
        None | Some(Value::Bool(false)) => Ok(()),
        _ => bail!("held UI preflight process receipt has an invalid diagnostic-only marker"),
    }
}

fn validate_retained_closed_process(
    receipt: &Value,
    api_pin: &Value,
    expected_owner_identity: &Value,
    store_root: &Path,
    store_binding: &str,
) -> Result<()> {
    validate_process_diagnostic_mode(receipt)?;
    if receipt.get("schema").and_then(Value::as_str) != Some("fullmag.docker-process-tree.v1")
        || receipt.get("state").and_then(Value::as_str) != Some("failed_outcome_retained")
        || receipt.get("api_pid").and_then(Value::as_u64) != api_pin.get("pid").and_then(Value::as_u64)
        || receipt.get("api_exit_code").and_then(Value::as_i64) != Some(-15)
        || receipt.get("api_diagnostic_only").and_then(Value::as_bool) != Some(false)
        || receipt.get("accepted_store").and_then(Value::as_str) != store_root.to_str()
        || receipt.pointer("/bootstrap/binding").and_then(Value::as_str) != Some(store_binding)
    {
        bail!("held UI retained process receipt is not the closed pinned API process");
    }
    let owner = super::validate_native_owner(
        receipt.get("service_owner").context("held UI retained process has no service owner")?,
        "held UI retained Ready owner",
        fullmag_session::runtime_service::RuntimeServiceState::Ready,
        &["running"],
    )?;
    if owner_identity_value(&owner)? != *expected_owner_identity {
        bail!("held UI retained process owner differs from the original Ready owner");
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
    let quiescence_value = read_transport_record(root, &authority.api_quiescence, "held UI API quiescence")?;
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
    if sha256(&canonical_lf(retained)) != quiescence.retained_process_sha256 {
        bail!("held UI quiescence retained-process bytes differ from their own digest");
    }
    let store_binding = fullmag_runtime_control::accepted_store::store_binding(store_root)
        .context("resolve held UI process accepted-store binding")?;
    if store_binding != preflight.accepted_store_binding
        || store_binding != input.target_runtime.accepted_store_binding {
        bail!("held UI preflight binding differs from the target bootstrap store");
    }
    validate_retained_closed_process(
        retained,
        api_pin,
        &preflight.ready_owner_identity,
        store_root,
        &store_binding,
    )?;

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
    validate_terminal_stop_proof_refs(&terminal_value, authority)?;
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

fn validate_terminal_stop_proof_refs(terminal: &Value, authority: &StopAuthority) -> Result<()> {
    let proofs = terminal.get("held_ui_stop_proofs")
        .context("held UI stop terminal has no typed stop-proof references")?
        .as_object()
        .context("held UI stop-proof references are not an object")?;
    if proofs.len() != 4 {
        bail!("held UI stop terminal must bind exactly four pre-stop proofs");
    }
    for (name, expected) in [
        ("preflight", &authority.preflight),
        ("api_quiescence", &authority.api_quiescence),
        ("native_drain", &authority.native_drain),
        ("inventory", &authority.inventory),
    ] {
        let actual: RecordRef = serde_json::from_value(
            proofs.get(name).context("held UI stop terminal omits a pre-stop proof reference")?.clone(),
        ).with_context(|| format!("decode held UI {name} terminal proof reference"))?;
        if &actual != expected {
            bail!("held UI stop terminal {name} proof reference differs from the immutable request");
        }
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

    let preflight_value = read_transport_record(
        runtime_control_root, &input.stop_authority.preflight, "held UI preflight",
    )?;
    let preflight: PreflightProof = serde_json::from_value(preflight_value)
        .context("decode held UI preflight")?;
    validate_preflight(&preflight, &input).context("validate held UI preflight")?;

    let inventory_value = read_transport_record(
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

fn build_held_snapshot(
    workspace_root: &Path,
    authority: &ValidatedHeldAuthority,
) -> Result<crate::types::SessionStateResponse> {
    let loaded = &authority.loaded;
    build_held_snapshot_projection(
        workspace_root,
        &authority.input,
        &authority.input_sha256,
        &loaded.run_id,
        &loaded.specification,
        &loaded.scene,
        &loaded.receipt,
        loaded.total_steps,
    )
}

fn build_held_snapshot_projection(
    workspace_root: &Path,
    input: &Input,
    input_sha256: &str,
    run_id: &RunId,
    specification: &RunSpecification,
    scene: &SceneDocument,
    receipt: &fullmag_session::LiveComputeRequestReceipt,
    total_steps: usize,
) -> Result<crate::types::SessionStateResponse> {
    let accepted = &input.accepted;
    if run_id.as_str() != accepted.run_id.as_str()
        || specification.run_id.as_str() != run_id.as_str()
        || specification.snapshot.project_id.as_str() != accepted.project_id.as_str()
        || scene.revision != accepted.scene_revision
    {
        bail!("held UI snapshot source differs from its accepted run, project, or scene pins");
    }
    let live = specification.parameters.pointer("/live_workspace")
        .context("held UI snapshot RunIntent has no live workspace")?;
    let command = live.get("command")
        .context("held UI snapshot RunIntent has no original command")?;
    let stored_receipt = live.get("request_receipt")
        .context("held UI snapshot RunIntent has no original request receipt")?;
    let receipt_value = serde_json::to_value(receipt)?;
    if live.get("command_id").and_then(Value::as_str) != Some(accepted.command_id.as_str())
        || command.get("kind").and_then(Value::as_str) != Some(accepted.command_kind.as_str())
        || command.get("client_intent_id").and_then(Value::as_str) != Some(accepted.client_intent_id.as_str())
        || receipt.command_id.as_str() != accepted.command_id.as_str()
        || receipt.request_id.as_deref() != Some(accepted.request_id.as_str())
        || receipt.request_sha256.as_str() != accepted.request_sha256.as_str()
        || receipt.key_sha256.as_str() != accepted.request_key_sha256.as_str()
        || receipt.command_kind.as_deref() != Some(accepted.command_kind.as_str())
        || receipt.client_intent_id.as_deref() != Some(accepted.client_intent_id.as_str())
        || receipt.requested_target.as_ref() != command.get("target")
        || stored_receipt != &receipt_value
    {
        bail!("held UI snapshot command or request receipt differs from its accepted pins");
    }

    let accepted_plan_metadata = json!({
        "schema": "fullmag.held-ui-materialization-plan.v1",
        "run_id": accepted.run_id.as_str(),
        "project_id": accepted.project_id.as_str(),
        "session_id": accepted.session_id.as_str(),
        "session_epoch": accepted.session_epoch,
        "session_created_at_unix_ms": accepted.session_created_at_unix_ms,
        "scene_revision": accepted.scene_revision,
        "run_intent_sha256": accepted.run_intent_sha256.as_str(),
        "run_intent_payload_sha256": accepted.run_intent_payload_sha256.as_str(),
        "definition_sha256": accepted.definition_sha256.as_str(),
        "study_sha256": accepted.study_sha256.as_str(),
        "execution_input_sha256": accepted.execution_input_sha256.as_str(),
        "command_id": accepted.command_id.as_str(),
        "command": command,
        "request_id": accepted.request_id.as_str(),
        "request_sha256": accepted.request_sha256.as_str(),
        "request_key_sha256": accepted.request_key_sha256.as_str(),
        "request_receipt_sha256": accepted.request_receipt_sha256.as_str(),
        "request_receipt": receipt_value,
    });
    let authority_metadata = json!({
        "held_ui_materialization": {
            "schema": INPUT_SCHEMA,
            "state": "pending_materialization",
            "launch_id": input.launch_id.as_str(),
            "maintenance_request_id": input.plan.maintenance_request_id.as_str(),
            "plan_sha256": input.plan.plan_sha256.as_str(),
            "input_sha256": input_sha256,
            "run_id": accepted.run_id.as_str(),
            "command_id": accepted.command_id.as_str(),
            "request_receipt_sha256": accepted.request_receipt_sha256.as_str(),
        }
    });
    let mut snapshot = super::build_accepted_snapshot(workspace_root, AcceptedSnapshotProjection {
        run_id,
        specification,
        scene,
        logical_session_id: &accepted.session_id,
        total_steps,
        terminal_outcome: None,
        preparation_failure: None,
        authority_metadata,
        accepted_plan_metadata,
    })?;
    snapshot.session.started_at_unix_ms = u128::from(accepted.session_created_at_unix_ms);
    Ok(snapshot)
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
    let ack_control_root = runtime_control_root.clone();
    let build_control_root = std::path::PathBuf::from(STOP_TERMINAL_ROOT);
    let validation = tokio::task::spawn_blocking(move || {
        validate_and_load_held_authority(input, &runtime_control_root, &build_control_root, &store_root)
    }).await.map_err(|error| format!("held UI authority validation task failed: {error}"))?
        .map_err(|error| format!("held UI authority validation failed: {error:#}"))?;
    let already_released = validation.loaded.release_exists;
    let ack_input = validation.input.clone();
    let ack_input_sha256 = validation.input_sha256.clone();

    let _transition = state.current_live_session_transition.lock().await;
    if state.current_live_state.read().await.is_some()
        || state.current_live_session_epoch.load(std::sync::atomic::Ordering::Acquire) != 0 {
        return Err("held UI materialization requires a fresh API workspace".into());
    }
    let snapshot = build_held_snapshot(&state.current_workspace_root, &validation)
        .map_err(|error| format!("held UI snapshot projection failed: {error:#}"))?;
    {
        let mut current = state.current_live_state.write().await;
        state.current_live_session_epoch.store(
            validation.input.accepted.session_epoch,
            std::sync::atomic::Ordering::Release,
        );
        *current = Some(snapshot);
    }
    drop(_transition);

    // The authority validator has completed every source/store/stop check
    // before this point. A previously released run is only rebound and read
    // back; it never enters either normal catalog or release writer.
    let store_authority = validation.clone();
    let initial_evidence = tokio::task::spawn_blocking(move || {
        if !already_released {
            materialize_held_catalog(&store_authority)
                .map_err(|error| format!("materialize held UI accepted catalog failed: {error:#}"))?;
        }
        validate_held_store_evidence(&store_authority, already_released)
            .map_err(|error| format!("validate held UI catalog/release failed: {error:#}"))
    })
    .await
    .map_err(|error| format!("held UI catalog task failed: {error}"))??;

    let context = crate::capture_current_live_request_context(state)
        .await
        .map_err(|error| format!("capture restored held UI request context failed: {error}"))?;
    if context.session_id != ack_input.accepted.session_id
        || context.session_epoch != ack_input.accepted.session_epoch
        || context.run_id.as_deref() != Some(ack_input.accepted.run_id.as_str()) {
        return Err("restored held UI request context differs from the accepted pins".into());
    }
    if !already_released {
        crate::live_scene_preparation::publish_accepted_frontier_preparation(
            state,
            &context,
            &ack_input.accepted.command_kind,
            None,
        )
        .await
        .map_err(|error| format!("held UI accepted frontier preparation failed: {error}"))?;
    }

    let gate_action = if already_released {
        "already_released_exact"
    } else {
        let before_release_authority = validation.clone();
        let before_release = tokio::task::spawn_blocking(move || {
            validate_held_store_evidence(&before_release_authority, false)
                .map_err(|error| format!("revalidate held UI store before release failed: {error:#}"))
        })
        .await
        .map_err(|error| format!("held UI pre-release verification task failed: {error}"))??;
        if before_release.start_release_sha256.is_some() {
            return Err("held UI store changed before the original start release".into());
        }
        let receipt = validation.loaded.receipt.clone();
        let released = crate::live_accepted_execution::release_accepted_live_study_with_receipt(
            state,
            &context,
            &ack_input.accepted.request_id,
            receipt,
        )
        .await
        .map_err(|error| format!("held UI original accepted-run release failed: {error}"))?
        .ok_or_else(|| "held UI original accepted-run release returned no execution".to_owned())?;
        if released.run_id != ack_input.accepted.run_id {
            return Err("held UI original accepted-run release returned another run".into());
        }
        "released"
    };

    let verify_authority = validation;
    let final_evidence = tokio::task::spawn_blocking(move || {
        validate_held_store_evidence(&verify_authority, true)
            .map_err(|error| format!("verify held UI original release/readback failed: {error:#}"))
    })
    .await
    .map_err(|error| format!("held UI release verification task failed: {error}"))??;
    if already_released
        && final_evidence.start_release_sha256 != initial_evidence.start_release_sha256
    {
        return Err("held UI exact start release changed during read-only restoration".into());
    }
    publish_held_restore_ack(
        &ack_control_root,
        &ack_input,
        &ack_input_sha256,
        &final_evidence,
        &state.request_scope_instance_id,
        gate_action,
    )
    .map_err(|error| format!("publish held UI restore ack failed: {error:#}"))?;
    Ok(())
}

fn publish_held_restore_ack(
    control_root: &Path,
    input: &Input,
    input_sha256: &str,
    evidence: &HeldStoreEvidence,
    api_instance_id: &str,
    gate_action: &str,
) -> Result<String> {
    if !matches!(gate_action, "released" | "already_released_exact") {
        bail!("held UI restore ack has an invalid gate action");
    }
    validate_digest(input_sha256, "held UI restore input digest")?;
    super::validate_api_instance_id(api_instance_id, "held UI restored API instance")?;
    let start_release_sha256 = evidence.start_release_sha256.as_deref()
        .context("held UI restore ack requires the verified original start release")?;
    let ack = RestoreAck {
        accepted_store_binding: input.target_runtime.accepted_store_binding.clone(),
        api_instance_id: api_instance_id.to_owned(),
        catalog_sha256: evidence.catalog_sha256.clone(),
        command_id: input.accepted.command_id.clone(),
        config_sha256: input.target_runtime.config_sha256.clone(),
        gate_action: gate_action.to_owned(),
        input_sha256: input_sha256.to_owned(),
        launch_id: input.launch_id.clone(),
        project_id: input.accepted.project_id.clone(),
        request_receipt_sha256: input.accepted.request_receipt_sha256.clone(),
        run_id: input.accepted.run_id.clone(),
        run_intent_sha256: input.accepted.run_intent_sha256.clone(),
        scene_revision: input.accepted.scene_revision,
        session_created_at_unix_ms: input.accepted.session_created_at_unix_ms,
        schema: ACK_SCHEMA.into(),
        session_epoch: input.accepted.session_epoch,
        session_id: input.accepted.session_id.clone(),
        start_release_sha256: start_release_sha256.to_owned(),
        state: "restored".into(),
    };
    let mut bytes = fullmag_session::canonical_json_bytes(
        &serde_json::to_value(&ack).context("encode held UI restore ack")?,
    );
    bytes.push(b'\n');
    if bytes.len() > MAX_INPUT_BYTES {
        bail!("held UI restore ack exceeds its size bound");
    }
    let relative = format!(
        "{PROOF_DIR}/{}/restore-ack-{}.json",
        input.plan.maintenance_request_id,
        input.launch_id,
    );
    fullmag_session::repository_path::validate_relative_path(&relative)
        .context("held UI restore ack path is unsafe")?;
    super::publish_immutable_restore_bytes(control_root, &relative, &bytes)
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
                session_id: "docker-startup-bf4b3f3f7d14628942d4b90dd459f173e013f11599c046d37ff402db5fbd2f00".into(),
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
    fn ready_process_diagnostic_marker_accepts_only_missing_or_boolean_false() {
        assert!(validate_process_diagnostic_mode(&json!({})).is_ok());
        assert!(validate_process_diagnostic_mode(&json!({"api_diagnostic_only": false})).is_ok());
        for value in [json!(true), json!(null), json!("false"), json!(0)] {
            assert!(
                validate_process_diagnostic_mode(&json!({"api_diagnostic_only": value})).is_err(),
                "malformed diagnostic marker must not be treated as an ordinary Ready receipt",
            );
        }
    }

    #[test]
    fn post_close_receipt_binds_original_ready_owner_without_reusing_ready_hash() {
        let store = tempfile::tempdir().unwrap();
        let api_pin = json!({
            "pid": 19080,
            "start_token": "19517880",
            "ppid": 1,
            "argv": ["/opt/fullmag/package/bin/fullmag-api"],
            "exe": "/opt/fullmag/package/bin/fullmag-api",
        });
        let owner = json!({
            "schema_version": "runtime_service_owner.v1",
            "owner_token": "11111111-1111-4111-8111-111111111111",
            "process_start_token": "22222222-2222-4222-8222-222222222222",
            "pid": 3241,
            "host": "fullmag-test-host",
            "target_id": "docker-all",
            "protocol": "stdin-v1",
            "state": "ready",
            "acquired_at": "2026-10-19T10:00:00Z",
            "heartbeat_at": "2026-10-19T10:00:01Z",
            "control_address": "127.0.0.1:43123",
            "build_commit": "6".repeat(40),
            "build_snapshot": "7".repeat(64),
            "compute_pool_id": "compute-pool",
            "preparation_pool_id": "preparation-pool",
            "compute_pool_generation": 7,
            "preparation_pool_generation": 8,
            "children": [
                {"role": "compute", "pid": 3250, "status": "running"},
                {"role": "preparation", "pid": 3251, "status": "running"},
            ],
        });
        let owner_identity = owner_identity_value(&owner).unwrap();
        let binding = "a".repeat(64);
        let ready = json!({
            "schema": "fullmag.docker-process-tree.v1",
            "state": "ready",
            "api_pid": 19080,
            "accepted_store": store.path(),
            "bootstrap": {"binding": binding},
            "service_owner": owner,
        });
        let retained = json!({
            "schema": "fullmag.docker-process-tree.v1",
            "state": "failed_outcome_retained",
            "api_pid": 19080,
            "api_exit_code": -15,
            "api_diagnostic_only": false,
            "accepted_store": store.path(),
            "bootstrap": {"binding": binding},
            "service_owner": owner,
        });
        let original_ready_sha = sha256(&canonical_lf(&ready));
        let retained_sha = sha256(&canonical_lf(&retained));
        assert_ne!(original_ready_sha, retained_sha);
        validate_retained_closed_process(
            &retained,
            &api_pin,
            &owner_identity,
            store.path(),
            &binding,
        ).unwrap();

        let mut wrong_store = retained.clone();
        wrong_store["accepted_store"] = json!("/other/store");
        assert!(validate_retained_closed_process(
            &wrong_store, &api_pin, &owner_identity, store.path(), &binding,
        ).is_err());
        let mut wrong_api = retained.clone();
        wrong_api["api_pid"] = json!(19081);
        assert!(validate_retained_closed_process(
            &wrong_api, &api_pin, &owner_identity, store.path(), &binding,
        ).is_err());
        let mut wrong_owner = retained;
        wrong_owner["service_owner"]["owner_token"] = json!("33333333-3333-4333-8333-333333333333");
        assert!(validate_retained_closed_process(
            &wrong_owner, &api_pin, &owner_identity, store.path(), &binding,
        ).is_err());
    }

    #[test]
    fn stop_terminal_binds_exact_pre_stop_proof_references() {
        let input = fixture();
        let authority = &input.stop_authority;
        let terminal = json!({
            "held_ui_stop_proofs": {
                "preflight": authority.preflight.clone(),
                "api_quiescence": authority.api_quiescence.clone(),
                "native_drain": authority.native_drain.clone(),
                "inventory": authority.inventory.clone(),
            }
        });
        assert!(validate_terminal_stop_proof_refs(&terminal, authority).is_ok());

        let mut mutated = terminal.clone();
        mutated["held_ui_stop_proofs"]["inventory"]["sha256"] = Value::String("f".repeat(64));
        assert!(validate_terminal_stop_proof_refs(&mutated, authority).is_err());

        let mut extra = terminal;
        extra["held_ui_stop_proofs"]["unbound"] = json!({
            "path": "held-ui-materialization/foreign.json",
            "sha256": "e".repeat(64),
        });
        assert!(validate_terminal_stop_proof_refs(&extra, authority).is_err());
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
            accepted_store_binding: input.target_runtime.accepted_store_binding.clone(),
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
    fn python_valid_transport_fixture_decodes_strict_rust_shapes_and_store_binding() {
        let fixture_value: Value = serde_json::from_str(include_str!(
            "../../tests/fixtures/held_ui_preflight_transport.v1.json",
        )).unwrap();
        assert_eq!(fixture_value["schema"], "fullmag.held-ui-preflight-transport-fixture.v1");

        let accepted: AcceptedPins = serde_json::from_value(fixture_value["accepted"].clone()).unwrap();
        let preflight_value = fixture_value["preflight"].clone();
        let preflight: PreflightProof = serde_json::from_value(preflight_value.clone()).unwrap();
        let mut input = fixture();
        input.accepted = accepted;
        input.source_scope = preflight.source_scope.clone();
        input.target_runtime.accepted_store_binding = preflight.accepted_store_binding.clone();

        assert_eq!(
            preflight.accepted_store_binding,
            fixture_value["preflight"]["accepted_store_binding"].as_str().unwrap(),
        );
        assert_eq!(input.target_runtime.accepted_store_binding, preflight.accepted_store_binding);
        assert_eq!(input.source_scope, preflight.source_scope);
        validate_preflight_scope(&preflight, &input).unwrap();

        let mut missing_binding = preflight_value.clone();
        missing_binding.as_object_mut().unwrap().remove("accepted_store_binding");
        assert!(serde_json::from_value::<PreflightProof>(missing_binding).is_err());

        let mut invalid_binding = preflight_value.clone();
        invalid_binding["accepted_store_binding"] = json!("g".repeat(64));
        let invalid_binding: PreflightProof = serde_json::from_value(invalid_binding).unwrap();
        assert!(validate_preflight_scope(&invalid_binding, &input).is_err());

        let mut mismatched_binding = preflight_value;
        mismatched_binding["accepted_store_binding"] = json!("f".repeat(64));
        let mismatched_binding: PreflightProof = serde_json::from_value(mismatched_binding).unwrap();
        assert!(validate_preflight_scope(&mismatched_binding, &input).is_err());
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
    fn python_transport_proof_uses_pinned_raw_float_bytes() {
        let root = tempfile::tempdir().unwrap();
        let proof_path = root.path().join("scene-proof.json");
        let raw = br#"{"geometry":{"bounds_max":[4e-09,2e-09,1e-09]}}"#;
        std::fs::write(&proof_path, raw).unwrap();
        let reference = RecordRef {
            path: "scene-proof.json".into(),
            sha256: sha256(raw),
        };

        let parsed = read_transport_record(root.path(), &reference, "scene proof").unwrap();
        assert_eq!(
            parsed["geometry"]["bounds_max"],
            json!([4e-9, 2e-9, 1e-9]),
        );
        assert_ne!(
            reference.sha256,
            fullmag_session::canonical_json_sha256(&parsed),
            "Python's raw float exponent spelling is authenticated by its byte pin",
        );

        let duplicate_path = root.path().join("duplicate-proof.json");
        let duplicate_raw = br#"{"x":1,"x":2}"#;
        std::fs::write(&duplicate_path, duplicate_raw).unwrap();
        let duplicate = RecordRef {
            path: "duplicate-proof.json".into(),
            sha256: sha256(duplicate_raw),
        };
        assert!(read_transport_record(root.path(), &duplicate, "duplicate proof").is_err());
    }

    #[test]
    fn preflight_scene_uses_raw_pin_then_deserializes_for_cas_equality() {
        let mut input = fixture();
        let raw = br#"{"revision":2,"objects":[{"id":"magnet","name":"magnet","geometry":{"geometry_kind":"Box","geometry_params":{"size":[8e-09,4e-09,2e-09]},"bounds_min":[-4e-09,-2e-09,-1e-09],"bounds_max":[4e-09,2e-09,1e-09]},"material_ref":"CoFeB"}],"materials":[{"id":"CoFeB","name":"CoFeB","properties":{"Ms":600000.0,"Aex":1e-11,"alpha":0.5}}],"study":{"stages":[{"kind":"relax","entrypoint_kind":"relax","id":"relax-a"},{"kind":"relax","entrypoint_kind":"relax","id":"relax-b"},{"kind":"relax","entrypoint_kind":"relax","id":"relax-c"}]}}"#;
        input.accepted.accepted_scene_sha256 = sha256(raw);
        let proof = PreflightProof {
            accepted_store_binding: input.target_runtime.accepted_store_binding.clone(),
            api_pin: Value::Null,
            api_response: ApiResponseProof {
                responses: std::collections::BTreeMap::from([(
                    "scene".into(),
                    HttpBodyRef {
                        raw_base64: base64::engine::general_purpose::STANDARD.encode(raw),
                        sha256: sha256(raw),
                    },
                )]),
                snapshot: Value::Null,
            },
            commands: CommandProof {
                command: Value::Null,
                detail: CommandDetailProof {
                    http_status: 404,
                    raw_base64: String::new(),
                    sha256: "0".repeat(64),
                },
                ledger: Value::Null,
                request_receipt: Value::Null,
                request_receipt_sha256: "0".repeat(64),
            },
            execution_input_sha256: input.accepted.execution_input_sha256.clone(),
            native_config_sha256: "0".repeat(64),
            process_sha256: "0".repeat(64),
            ready_owner_identity: Value::Null,
            ready_owner_sha256: "0".repeat(64),
            run_intent_sha256: input.accepted.run_intent_sha256.clone(),
            schema: "fullmag.held-ui-materialization-preflight.v1".into(),
            source_scope: input.source_scope.clone(),
        };

        let http_scene = preflight_scene_document(&proof, &input.accepted).unwrap();
        let accepted_cas_scene: SceneDocument = serde_json::from_slice(raw).unwrap();
        assert_eq!(http_scene, accepted_cas_scene);
        assert_eq!(http_scene.objects[0].geometry.bounds_max, Some([4e-9, 2e-9, 1e-9]));
        assert_eq!(
            serde_json::to_value(&http_scene).unwrap()["objects"][0]["geometry"]["geometry_params"]["size"],
            json!([8e-9, 4e-9, 2e-9]),
        );
        assert_ne!(
            sha256(raw),
            fullmag_session::canonical_json_sha256(&serde_json::to_value(&http_scene).unwrap()),
            "the scene transport hash pins Python bytes with nm-scale exponent floats",
        );
        assert_eq!(http_scene.study.stages.len(), 3);

        let mut wrong_pin = input.accepted;
        wrong_pin.accepted_scene_sha256 = "f".repeat(64);
        assert!(preflight_scene_document(&proof, &wrong_pin).is_err());
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

    #[test]
    fn held_snapshot_preserves_original_scene_session_and_pending_command() {
        use fullmag_application::{
            ProjectSnapshot, RequestedExecution, RequestedResourceBudget, StudyId, StudyReference,
        };

        let input = fixture();
        let accepted = &input.accepted;
        let run_id = RunId::parse(accepted.run_id.clone()).unwrap();
        let project_id = ProjectId::parse(accepted.project_id.clone()).unwrap();
        let command = json!({
            "kind": accepted.command_kind,
            "client_intent_id": accepted.client_intent_id,
            "target": {"kind": "stage_id", "stage_id": "relax-a"},
        });
        let receipt = fullmag_session::LiveComputeRequestReceipt {
            key_sha256: accepted.request_key_sha256.clone(),
            request_sha256: accepted.request_sha256.clone(),
            command_id: accepted.command_id.clone(),
            request_id: Some(accepted.request_id.clone()),
            command_kind: Some(accepted.command_kind.clone()),
            client_intent_id: Some(accepted.client_intent_id.clone()),
            requested_target: command.get("target").cloned(),
        };
        let mut specification = RunSpecification::new(
            ProjectSnapshot {
                project_id,
                definition_revision: 4,
                definition_sha256: accepted.definition_sha256.clone(),
            },
            StudyReference {
                study_id: StudyId::parse("study-held-ui").unwrap(),
                plan_version: "study_plan.v1".into(),
                plan_sha256: accepted.study_sha256.clone(),
            },
            accepted.study_sha256.clone(),
            json!({
                "live_workspace": {
                    "command_id": accepted.command_id,
                    "command": command,
                    "request_receipt": receipt,
                }
            }),
            RequestedExecution {
                backend: "fdm".into(),
                device: "cpu".into(),
                precision: "double".into(),
                mode: "strict".into(),
                minimum_resources: Some(RequestedResourceBudget {
                    cpu_millis: 100,
                    memory_bytes: 1,
                    gpu_memory_bytes: 0,
                    storage_bytes: 1,
                }),
            },
        );
        specification.run_id = run_id.clone();
        let command_receipt = fullmag_session::LiveComputeRequestReceipt {
            key_sha256: accepted.request_key_sha256.clone(),
            request_sha256: accepted.request_sha256.clone(),
            command_id: accepted.command_id.clone(),
            request_id: Some(accepted.request_id.clone()),
            command_kind: Some(accepted.command_kind.clone()),
            client_intent_id: Some(accepted.client_intent_id.clone()),
            requested_target: Some(json!({"kind": "stage_id", "stage_id": "relax-a"})),
        };
        let mut scene = SceneDocument::default();
        scene.revision = accepted.scene_revision;
        scene.scene.name = "held-ui-authored-study".into();
        scene.materials.push(fullmag_authoring::SceneMaterialAsset {
            id: "CoFeB".into(),
            name: "CoFeB".into(),
            properties: fullmag_authoring::ScriptBuilderMaterialState {
                ms: Some(600_000.0),
                aex: Some(1.0e-11),
                alpha: 0.5,
                dind: None,
                dbulk: None,
            },
            references: vec![],
        });
        scene.study.stages = ["relax-a", "relax-b", "relax-c"]
            .into_iter()
            .map(|id| fullmag_authoring::SceneStudyStageState {
                kind: "relax".into(),
                entrypoint_kind: "relax".into(),
                extra: std::collections::BTreeMap::from([("id".into(), json!(id))]),
                ..Default::default()
            })
            .collect();
        let workspace = tempfile::tempdir().unwrap();
        let snapshot = build_held_snapshot_projection(
            workspace.path(),
            &input,
            &"a".repeat(64),
            &run_id,
            &specification,
            &scene,
            &command_receipt,
            1,
        ).unwrap();

        assert_eq!(snapshot.session.session_id, accepted.session_id);
        assert_eq!(snapshot.session.started_at_unix_ms, u128::from(accepted.session_created_at_unix_ms));
        assert_eq!(accepted.session_epoch, 1);
        assert_eq!(accepted.session_created_at_unix_ms, 1_794_582_150_656);
        assert_eq!(snapshot.session.run_id, accepted.run_id);
        assert_eq!(snapshot.session.status, "awaiting_command");
        assert_eq!(snapshot.run.as_ref().unwrap().run_id, accepted.run_id);
        assert_eq!(snapshot.run.as_ref().unwrap().status, "waiting_for_compute");
        assert_eq!(snapshot.run.as_ref().unwrap().total_steps, 1);
        assert_eq!(snapshot.scene_document.as_ref().unwrap().study.stages.len(), 3);
        let edited_material = &snapshot.scene_document.as_ref().unwrap().materials[0].properties;
        assert_eq!(edited_material.ms, Some(600_000.0));
        assert_eq!(edited_material.aex, Some(1.0e-11));
        assert_eq!(edited_material.alpha, 0.5);
        assert_eq!(snapshot.scene_document.as_ref(), Some(&scene));
        assert_eq!(snapshot.stage_execution, None);
        assert_eq!(
            snapshot.scene_document.as_ref().unwrap().study.stages
                .iter().map(|stage| stage.extra["id"].as_str().unwrap()).collect::<Vec<_>>(),
            vec!["relax-a", "relax-b", "relax-c"],
        );
        let plan = &snapshot.session.plan_summary["accepted_run"];
        assert_eq!(plan["run_id"], accepted.run_id);
        assert_eq!(plan["command_id"], accepted.command_id);
        assert_eq!(plan["request_receipt_sha256"], accepted.request_receipt_sha256);
        assert_eq!(plan["session_epoch"], 1);
        assert_eq!(plan["session_created_at_unix_ms"], 1_794_582_150_656u64);
        assert_eq!(plan["request_receipt"], serde_json::to_value(&command_receipt).unwrap());
        assert_eq!(plan["command"]["target"]["kind"], "stage_id");
        assert_eq!(plan["command"]["target"]["stage_id"], "relax-a");
        let marker = serde_json::to_value(snapshot.metadata.as_ref().unwrap()).unwrap();
        assert_eq!(marker["held_ui_materialization"]["state"], "pending_materialization");
        assert!(marker.get("startup_provenance").is_none());
        assert_eq!(std::fs::read_dir(workspace.path()).unwrap().count(), 0);
    }

    fn accepted_catalog_fixture() -> (tempfile::TempDir, ValidatedHeldAuthority, Vec<u8>) {
        accepted_catalog_fixture_with_backend("fdm")
    }

    fn accepted_catalog_fixture_with_backend(
        requested_backend: &str,
    ) -> (tempfile::TempDir, ValidatedHeldAuthority, Vec<u8>) {
        use fullmag_application::{
            ProjectEnvelope, ProjectId, ProjectSnapshot, RequestedExecution,
            RequestedResourceBudget, RunIntent, RunSpecification, StudyId, StudyReference,
        };
        use fullmag_authoring::{
            PrimitiveStageNode, StudyDiscretizationReference, StudyExecutionProfileReference,
            StudyModelReference, StudyPipelineDocument, StudyPipelineNode,
            StudyPipelineNodeSource, StudyPlan, StudyPlanMigrationDefaults,
            StudyPrimitiveStageKind, StudySolverConfigReference,
            STUDY_PLAN_SCHEMA_VERSION_V2,
        };
        use fullmag_plan::{StudyProblemCatalog, StudyProblemCatalogEntry};
        use fullmag_session::SessionStore;
        use serde_json::json;
        use std::collections::BTreeMap;

        let temporary = tempfile::tempdir().unwrap();
        let store_root = temporary.path().join("accepted-store");
        let store = SessionStore::open(&store_root).unwrap();

        let mut authored_scene = SceneDocument::default();
        authored_scene.revision = 2;
        authored_scene.study.stages = ["relax-a", "relax-b", "relax-c"]
            .into_iter()
            .map(|id| fullmag_authoring::SceneStudyStageState {
                kind: "relax".into(),
                entrypoint_kind: "relax".into(),
                extra: BTreeMap::from([("id".into(), json!(id))]),
                ..Default::default()
            })
            .collect();
        let mut definition = ProjectEnvelope::blank(
            ProjectId::parse("project-held-ui-catalog").unwrap(),
            "Held UI catalog fixture",
        )
        .unwrap();
        definition
            .replace_scene(
                fullmag_application::RawJsonEnvelope::from_value(
                    serde_json::to_value(&authored_scene).unwrap(),
                )
                .unwrap(),
            )
            .unwrap();

        // The authored scene remains A/B/C while this accepted RunIntent
        // contains only the compiled execution step for the selected A.
        let pipeline = StudyPipelineDocument {
            version: "study_pipeline.v2".into(),
            nodes: vec![StudyPipelineNode::Primitive(PrimitiveStageNode {
                id: "script-execution-a".into(),
                label: "relax-a".into(),
                enabled: true,
                notes: None,
                source: Some(StudyPipelineNodeSource::UiAuthored),
                stage_kind: StudyPrimitiveStageKind::Run,
                payload: [("until_seconds".into(), json!("1e-9"))]
                    .into_iter()
                    .collect(),
            })],
        };
        let defaults = StudyPlanMigrationDefaults {
            model: StudyModelReference { model_id: "model:one".into(), version: "v1".into() },
            solver_config: StudySolverConfigReference { preset_id: "solver:default".into(), version: "v1".into() },
            discretization: StudyDiscretizationReference { recipe_id: "mesh:default".into(), version: "v1".into() },
            execution_profile: StudyExecutionProfileReference { profile_id: "exec:auto".into(), version: "v1".into() },
        };
        let study = StudyPlan::from_pipeline("study-held-ui", 1, &pipeline, &defaults).unwrap();
        assert_eq!(study.steps.len(), 1);
        let mut problem = fullmag_ir::ProblemIR::bootstrap_example();
        problem.problem_meta.runtime_metadata.insert("active_stage_id".into(), json!("relax-a"));
        let study_catalog = StudyProblemCatalog::from_entries(
            &study,
            vec![StudyProblemCatalogEntry::from_step(&study.steps[0], problem)],
        )
        .unwrap();
        let study_catalog_value = serde_json::to_value(&study_catalog).unwrap();

        let mut input = fixture();
        let compute_request: crate::schemas::commands::StructuredCommandRequest =
            serde_json::from_value(json!({
                "kind": "relax",
                "target": {"kind": "stage_id", "stage_id": "relax-a"},
                "client_intent_id": input.accepted.client_intent_id.as_str(),
                "precondition": {"scene_revision": input.accepted.scene_revision},
            }))
            .unwrap();
        let original_context = crate::types::CurrentLiveRequestContext {
            session_id: input.accepted.session_id.clone(),
            run_id: None,
            session_epoch: input.accepted.session_epoch,
            request_scope_epoch: input.accepted.old_request_scope_epoch.clone(),
        };
        let captured_request = crate::live_compute_request::LiveComputeRequest::capture(
            &original_context,
            &compute_request,
            Some(&input.accepted.client_intent_id),
            Some(input.accepted.request_id.clone()),
        )
        .unwrap()
        .unwrap();
        let original_receipt = captured_request.receipt(input.accepted.command_id.clone());
        let execution_input = crate::live_execution_binding::input_identity(&authored_scene).unwrap();
        input.accepted.execution_input_sha256 = execution_input.sha256.clone();
        input.accepted.request_key_sha256 = original_receipt.key_sha256.clone();
        input.accepted.request_sha256 = original_receipt.request_sha256.clone();
        input.accepted.request_receipt_sha256 = fullmag_session::canonical_json_sha256(
            &serde_json::to_value(&original_receipt).unwrap(),
        );
        let original_command = json!({
            "seq": 0,
            "command_id": input.accepted.command_id.as_str(),
            "kind": input.accepted.command_kind.as_str(),
            "created_at_unix_ms": input.accepted.session_created_at_unix_ms,
            "client_intent_id": input.accepted.client_intent_id.as_str(),
            "precondition": {"scene_revision": input.accepted.scene_revision},
            "target": {"kind": "stage_id", "stage_id": "relax-a"},
        });
        let live_workspace = json!({
            "api_instance_id": input.accepted.old_api_instance_id.as_str(),
            "session_id": input.accepted.session_id.as_str(),
            "session_epoch": input.accepted.session_epoch,
            "scene_revision": input.accepted.scene_revision,
            "execution_input": execution_input,
            "command_id": input.accepted.command_id.as_str(),
            "request_idempotency_key": input.accepted.client_intent_id.as_str(),
            "request_receipt": original_receipt.clone(),
            "step_id": "relax-a",
            "command": original_command,
        });
        let specification = RunSpecification::new(
            ProjectSnapshot::from_envelope(&definition).unwrap(),
            StudyReference {
                study_id: StudyId::parse("study-held-ui").unwrap(),
                plan_version: STUDY_PLAN_SCHEMA_VERSION_V2.into(),
                plan_sha256: study.canonical_sha256().unwrap(),
            },
            fullmag_session::canonical_json_sha256(&study_catalog_value),
            json!({
                "fullmag.accepted_run_start": {
                    "schema_version": "accepted_run_start_policy.v1",
                    "mode": "manual"
                },
                "live_workspace": live_workspace,
            }),
            RequestedExecution {
                backend: requested_backend.into(),
                device: "cpu".into(),
                precision: "double".into(),
                mode: "strict".into(),
                minimum_resources: Some(RequestedResourceBudget {
                    cpu_millis: 100,
                    memory_bytes: 1,
                    gpu_memory_bytes: 0,
                    storage_bytes: 1,
                }),
            },
        );
        let run_intent = RunIntent::new(
            format!("live-http-v2-{}", original_receipt.key_sha256),
            specification,
        );
        crate::run_intent_persistence::commit_validated_run_intent(
            &store,
            &run_intent,
            &definition,
            &study,
            &study_catalog,
            &BTreeMap::new(),
        )
        .unwrap();

        let run_id = run_intent.specification.run_id.clone();
        let persisted_intent = store.read_run_intent(run_id.as_str()).unwrap().unwrap();
        let intent_relative = format!("runs/{}/run_intent.json", run_id.as_str());
        let intent_raw = fullmag_session::repository_path::read_bounded_regular_file(
            &store_root,
            &intent_relative,
            MAX_PROOF_BYTES,
        )
        .unwrap();
        let typed_specification: RunSpecification =
            serde_json::from_value(persisted_intent.specification.clone()).unwrap();
        let accepted = fullmag_runtime_control::load_accepted_study_snapshot(
            &store,
            &run_id,
            &typed_specification.snapshot.project_id,
        )
        .unwrap();
        assert_eq!(accepted.catalog.entries().len(), 1);
        assert_eq!(
            accepted.catalog.entries()[0].problem().problem_meta.runtime_metadata["active_stage_id"],
            "relax-a",
        );
        let planned = accepted
            .lowered
            .steps
            .iter()
            .filter(|step| matches!(step.status, fullmag_plan::StudyStepLoweringStatus::Planned))
            .collect::<Vec<_>>();
        assert_eq!(planned.len(), 1);

        let persisted_receipt = crate::live_compute_request::receipt_from_intent(&persisted_intent)
            .unwrap()
            .unwrap();
        assert_eq!(persisted_receipt, original_receipt);

        input.accepted.run_id = run_id.as_str().to_owned();
        input.accepted.project_id = typed_specification.snapshot.project_id.as_str().to_owned();
        input.accepted.run_intent_sha256 = sha256(&intent_raw);
        input.accepted.run_intent_payload_sha256 = persisted_intent.payload_sha256.clone();
        input.accepted.definition_sha256 = typed_specification.snapshot.definition_sha256.clone();
        input.accepted.study_sha256 = typed_specification.study.plan_sha256.clone();
        input.target_runtime.accepted_store_binding =
            fullmag_runtime_control::accepted_store::store_binding(&store_root).unwrap();

        // Production direct-Compute acceptance stores this immutable demand
        // sidecar before startup; the fixture supplies the exact run binding.
        let run_directory = store_root.join("runs").join(run_id.as_str());
        std::fs::write(
            run_directory.join("live_demand.v1.json"),
            serde_json::to_vec(&json!({
                "schema_version": "fullmag.accepted_live_demand.v1",
                "run_id": run_id.as_str(),
                "quantities": ["m"],
            }))
            .unwrap(),
        )
        .unwrap();

        let authority = ValidatedHeldAuthority {
            input,
            input_sha256: "a".repeat(64),
            store_root: store_root.clone(),
            loaded: LoadedRun {
                run_id: RunId::parse(run_id.as_str().to_owned()).unwrap(),
                project_id: typed_specification.snapshot.project_id.clone(),
                specification: typed_specification,
                scene: authored_scene,
                intent: persisted_intent,
                receipt: persisted_receipt,
                total_steps: planned.len(),
                release_exists: false,
            },
        };
        (temporary, authority, intent_raw)
    }

    #[test]
    fn held_catalog_materializes_only_selected_compiled_stage_and_keeps_gate_closed() {
        use fullmag_session::SessionStore;

        let (_temporary, authority, original_intent_bytes) = accepted_catalog_fixture();
        assert_eq!(authority.loaded.scene.study.stages.len(), 3);
        let run_id = authority.loaded.run_id.as_str();
        let catalog = materialize_held_catalog(&authority).unwrap();
        assert_eq!(catalog.tasks.len(), 1);
        assert_eq!(catalog.tasks[0].lifecycle, FmsTaskLifecycle::Accepted);
        assert!(matches!(&catalog.tasks[0].readiness, FmsTaskReadiness::Blocked { .. }));
        assert!(catalog.tasks[0].attempt_id.is_none());
        assert!(catalog.tasks[0].ownership_epoch.is_none());
        assert!(catalog.tasks[0].observation.is_none());
        assert!(catalog.tasks[0].artifact_ids.is_empty());

        let store = SessionStore::open_existing(&authority.store_root).unwrap();
        let intent_relative = format!("runs/{run_id}/run_intent.json");
        let after_first = fullmag_session::repository_path::read_bounded_regular_file(
            &authority.store_root, &intent_relative, MAX_PROOF_BYTES,
        ).unwrap();
        assert_eq!(after_first, original_intent_bytes);
        assert!(store.read_accepted_run_start_release(run_id).unwrap().is_none());
        assert!(!store.accepted_run_start_permitted(run_id).unwrap());

        let replay = materialize_held_catalog(&authority).unwrap();
        assert_eq!(replay, catalog, "an exact no-progress catalog is idempotently read back");
        assert!(store.read_accepted_run_start_release(run_id).unwrap().is_none());
        assert!(!store.accepted_run_start_permitted(run_id).unwrap());

        let run_directory = authority.store_root.join("runs").join(run_id);
        let names = std::fs::read_dir(&run_directory)
            .unwrap()
            .map(|entry| entry.unwrap().file_name().to_string_lossy().into_owned())
            .collect::<std::collections::BTreeSet<_>>();
        assert!(names.contains("run_catalog.json"));
        assert!(!names.contains("start_release.json"));
        for prohibited in ["task_attempts", "task_admissions", "resource_leases", "outputs"] {
            assert!(!names.contains(prohibited), "unexpected progress directory: {prohibited}");
        }
    }

    #[test]
    fn held_restore_requires_resolved_fdm_but_accepts_auto_resolving_to_fdm() {
        use fullmag_session::SessionStore;

        let (_temporary, authority, _) = accepted_catalog_fixture_with_backend("auto");
        let store = SessionStore::open_existing(&authority.store_root).unwrap();
        let mut accepted = fullmag_runtime_control::load_accepted_study_snapshot(
            &store,
            &authority.loaded.run_id,
            &authority.loaded.project_id,
        )
        .unwrap();
        assert_eq!(accepted.run.specification.requested_execution.backend, "auto");
        assert_eq!(
            accepted.lowered.steps[0]
                .execution_plan
                .as_ref()
                .unwrap()
                .common
                .resolved_backend,
            fullmag_ir::BackendTarget::Fdm,
        );
        validate_held_fdm_scope(&accepted).unwrap();

        accepted.lowered.steps[0]
            .execution_plan
            .as_mut()
            .unwrap()
            .common
            .resolved_backend = fullmag_ir::BackendTarget::Fem;
        assert!(validate_held_fdm_scope(&accepted).is_err());
    }

    #[test]
    fn held_release_readback_binds_original_receipt_and_is_read_only_on_replay() {
        use fullmag_session::SessionStore;

        let (_temporary, authority, original_intent_bytes) = accepted_catalog_fixture();
        let catalog = materialize_held_catalog(&authority).unwrap();
        let before_release = validate_held_store_evidence(&authority, false).unwrap();
        assert_eq!(before_release.catalog_sha256, raw_run_record_sha256(&authority, "run_catalog.json").unwrap());
        assert!(before_release.start_release_sha256.is_none());

        let store = SessionStore::open_existing(&authority.store_root).unwrap();
        let release_request_id = crate::live_accepted_execution::accepted_start_release_request_id(
            authority.loaded.run_id.as_str(),
            &authority.input.accepted.request_id,
        );
        store.release_accepted_run_start_for_live_request(
            authority.loaded.run_id.as_str(),
            &authority.loaded.intent.payload_sha256,
            &release_request_id,
            &authority.loaded.receipt,
        ).unwrap();
        let release_path = authority.store_root.join("runs")
            .join(authority.loaded.run_id.as_str()).join("start_release.json");
        let release_before = std::fs::read(&release_path).unwrap();

        let released = validate_held_store_evidence(&authority, true).unwrap();
        let expected_release_sha256 = sha256(&release_before);
        assert_eq!(released.catalog_sha256, before_release.catalog_sha256);
        assert_eq!(released.start_release_sha256.as_deref(), Some(expected_release_sha256.as_str()));
        let repeated = validate_held_store_evidence(&authority, true).unwrap();
        assert_eq!(repeated.catalog_sha256, released.catalog_sha256);
        assert_eq!(repeated.start_release_sha256, released.start_release_sha256);
        assert_eq!(std::fs::read(&release_path).unwrap(), release_before);
        assert_eq!(store.read_accepted_run_start_release(authority.loaded.run_id.as_str()).unwrap()
            .unwrap().live_request.as_ref(), Some(&authority.loaded.receipt));
        assert_eq!(
            std::fs::read(authority.store_root.join("runs").join(authority.loaded.run_id.as_str()).join("run_intent.json")).unwrap(),
            original_intent_bytes,
        );
        assert_eq!(catalog.run_id, authority.loaded.run_id.as_str());

        let control = tempfile::tempdir().unwrap();
        let ack_dir = control.path().join(PROOF_DIR).join(&authority.input.plan.maintenance_request_id);
        std::fs::create_dir_all(&ack_dir).unwrap();
        let api_instance_id = "00000000-0000-4000-8000-000000000003";
        let ack_sha = publish_held_restore_ack(
            control.path(),
            &authority.input,
            &"f".repeat(64),
            &released,
            api_instance_id,
            "already_released_exact",
        ).unwrap();
        let ack_path = ack_dir.join(format!("restore-ack-{}.json", authority.input.launch_id));
        let ack_raw = std::fs::read(&ack_path).unwrap();
        assert_eq!(sha256(&ack_raw), ack_sha);
        let ack: Value = serde_json::from_slice(&ack_raw).unwrap();
        let expected_ack_fields = [
            "accepted_store_binding", "api_instance_id", "catalog_sha256", "command_id",
            "config_sha256", "gate_action", "input_sha256", "launch_id", "project_id",
            "request_receipt_sha256", "run_id", "run_intent_sha256", "scene_revision",
            "session_created_at_unix_ms", "schema", "session_epoch", "session_id",
            "start_release_sha256", "state",
        ].into_iter().collect::<std::collections::BTreeSet<_>>();
        let actual_ack_fields = ack.as_object().unwrap().keys().map(String::as_str)
            .collect::<std::collections::BTreeSet<_>>();
        assert_eq!(actual_ack_fields, expected_ack_fields);
        assert_eq!(
            ack.get("run_intent_sha256").and_then(Value::as_str),
            Some(authority.input.accepted.run_intent_sha256.as_str()),
        );
        assert_eq!(ack["schema"], ACK_SCHEMA);
        assert_eq!(ack["state"], "restored");
        assert_eq!(ack["gate_action"], "already_released_exact");
        assert_eq!(ack["api_instance_id"], api_instance_id);
        assert_eq!(ack["run_id"], authority.input.accepted.run_id);
        assert_eq!(
            publish_held_restore_ack(
                control.path(),
                &authority.input,
                &"f".repeat(64),
                &released,
                api_instance_id,
                "already_released_exact",
            ).unwrap(),
            ack_sha,
            "exact ack replay is immutable and idempotent",
        );
        assert!(publish_held_restore_ack(
            control.path(),
            &authority.input,
            &"f".repeat(64),
            &released,
            api_instance_id,
            "released",
        ).is_err(), "a conflicting gate action must not overwrite the ack");
    }

    #[test]
    fn released_held_catalog_allows_exact_scheduler_progress_and_rejects_foreign_tasks() {
        use chrono::Utc;
        use fullmag_session::{
            FmsTaskLifecycle, FmsTaskReadiness, SessionStore,
        };

        let (_temporary, authority, _) = accepted_catalog_fixture();
        let catalog = materialize_held_catalog(&authority).unwrap();
        let store = SessionStore::open_existing(&authority.store_root).unwrap();
        let run_id = authority.loaded.run_id.as_str();
        let release_request_id = crate::live_accepted_execution::accepted_start_release_request_id(
            run_id,
            &authority.input.accepted.request_id,
        );
        store.release_accepted_run_start_for_live_request(
            run_id,
            &authority.loaded.intent.payload_sha256,
            &release_request_id,
            &authority.loaded.receipt,
        ).unwrap();

        let release_path = authority.store_root.join("runs").join(run_id).join("start_release.json");
        let release_before = std::fs::read(&release_path).unwrap();
        let mut progressed = catalog.clone();
        progressed.revision += 1;
        progressed.updated_at = Utc::now();
        let task = &mut progressed.tasks[0];
        task.lifecycle = FmsTaskLifecycle::Succeeded;
        task.readiness = FmsTaskReadiness::Ready;
        task.observation = Some(fullmag_session::FmsObservationState::Stale);
        task.attempt_id = Some("attempt-held-ui-progressed".into());
        task.ownership_epoch = Some(1);
        task.resolved_input_fingerprint = Some(task.input_fingerprint.clone());
        store.commit_run_catalog(&progressed).unwrap();
        let catalog_path = authority.store_root.join("runs").join(run_id).join("run_catalog.json");
        let progressed_catalog_bytes = std::fs::read(&catalog_path).unwrap();

        let evidence = validate_held_store_evidence(&authority, true)
            .expect("the exact released run may advance before restore acknowledgement");
        let release_sha256 = sha256(&release_before);
        assert_eq!(evidence.catalog_sha256, sha256(&progressed_catalog_bytes));
        assert_eq!(evidence.start_release_sha256.as_deref(), Some(release_sha256.as_str()));
        let repeated = validate_held_store_evidence(&authority, true)
            .expect("read-only released-state rebind is idempotent after progress");
        assert_eq!(repeated, evidence);
        assert_eq!(std::fs::read(&catalog_path).unwrap(), progressed_catalog_bytes);
        assert_eq!(std::fs::read(&release_path).unwrap(), release_before);

        let mut foreign = progressed;
        foreign.revision += 1;
        foreign.updated_at = Utc::now();
        foreign.tasks[0].task_id = "foreign-task-held-ui".into();
        store.commit_run_catalog(&foreign).unwrap();
        assert!(validate_held_store_evidence(&authority, true).is_err());
        assert_eq!(std::fs::read(&release_path).unwrap(), release_before);
    }

    #[test]
    fn released_held_store_rejects_foreign_release_run_or_receipt() {
        use fullmag_session::SessionStore;

        let (_temporary, authority, _) = accepted_catalog_fixture();
        materialize_held_catalog(&authority).unwrap();
        let store = SessionStore::open_existing(&authority.store_root).unwrap();
        let run_id = authority.loaded.run_id.as_str();
        let release_request_id = crate::live_accepted_execution::accepted_start_release_request_id(
            run_id,
            &authority.input.accepted.request_id,
        );
        store.release_accepted_run_start_for_live_request(
            run_id,
            &authority.loaded.intent.payload_sha256,
            &release_request_id,
            &authority.loaded.receipt,
        ).unwrap();
        let path = authority.store_root.join("runs").join(run_id).join("start_release.json");
        let original = std::fs::read(&path).unwrap();
        let mut release: Value = serde_json::from_slice(&original).unwrap();

        release["run_id"] = Value::String("foreign-run-held-ui".into());
        std::fs::write(&path, serde_json::to_vec_pretty(&release).unwrap()).unwrap();
        assert!(validate_held_store_evidence(&authority, true).is_err());

        release = serde_json::from_slice(&original).unwrap();
        release["request_id"] = Value::String("foreign-request-held-ui".into());
        std::fs::write(&path, serde_json::to_vec_pretty(&release).unwrap()).unwrap();
        assert!(validate_held_store_evidence(&authority, true).is_err());
    }

    #[test]
    fn held_catalog_refuses_progressed_catalog_without_overwriting_it() {
        use chrono::Utc;
        use fullmag_session::{
            FmsRunCatalog, FmsTaskCatalogEntry, FmsTaskLifecycle, FmsTaskReadiness,
            SessionStore, FMS_RUN_CATALOG_SCHEMA,
        };

        let (_temporary, authority, original_intent_bytes) = accepted_catalog_fixture();
        let store = SessionStore::open_existing(&authority.store_root).unwrap();
        let run_id = authority.loaded.run_id.as_str();
        let accepted = fullmag_runtime_control::load_accepted_study_snapshot(
            &store,
            &authority.loaded.run_id,
            &authority.loaded.project_id,
        )
        .unwrap();
        let step = accepted.lowered.steps.iter()
            .find(|step| matches!(step.status, fullmag_plan::StudyStepLoweringStatus::Planned))
            .unwrap();
        let task_id = fullmag_session::task_id_for_study_step(run_id, &step.step_id).unwrap();
        let input_fingerprint = fullmag_application::study_task_input_fingerprint(
            &authority.loaded.specification, step,
        ).unwrap();
        let progressed = FmsRunCatalog {
            schema_version: FMS_RUN_CATALOG_SCHEMA.into(),
            run_id: run_id.into(),
            revision: 1,
            updated_at: Utc::now(),
            tasks: vec![FmsTaskCatalogEntry {
                task_id,
                input_fingerprint,
                lifecycle: FmsTaskLifecycle::Running,
                readiness: FmsTaskReadiness::Ready,
                observation: None,
                attempt_id: Some("attempt-held-ui-fixture".into()),
                ownership_epoch: Some(1),
                resolved_input_fingerprint: None,
                artifact_ids: Vec::new(),
                resource_id: None,
                coordinator_watermark: None,
                coordinator_genesis: None,
            }],
        };
        store.commit_run_catalog(&progressed).unwrap();
        let catalog_path = authority.store_root.join("runs").join(run_id).join("run_catalog.json");
        let catalog_before = std::fs::read(&catalog_path).unwrap();
        let intent_path = authority.store_root.join("runs").join(run_id).join("run_intent.json");
        let intent_before = std::fs::read(&intent_path).unwrap();

        assert!(materialize_held_catalog(&authority).is_err());
        assert_eq!(std::fs::read(&catalog_path).unwrap(), catalog_before);
        assert_eq!(std::fs::read(&intent_path).unwrap(), original_intent_bytes);
        assert_eq!(std::fs::read(&intent_path).unwrap(), intent_before);
        assert!(store.read_accepted_run_start_release(run_id).unwrap().is_none());
        assert!(!store.accepted_run_start_permitted(run_id).unwrap());
    }
}
