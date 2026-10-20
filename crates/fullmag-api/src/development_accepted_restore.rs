//! Explicit pre-listen reattachment of one accepted live run.
//!
//! This is a private launcher input, never an HTTP selector.  It only restores
//! an immutable accepted run which the operator pins by identity and proves
//! through the control-volume receipt.  It does not create a RunIntent, release
//! the start gate, claim a task, or start Compute.

use std::{
    fs::{self, OpenOptions},
    io::{Read, Write},
    path::Path,
    sync::atomic::Ordering,
    sync::Arc,
    time::Duration,
};

use anyhow::{bail, Context, Result};
use fullmag_application::{ProjectId, RunId, RunSpecification};
use fullmag_authoring::SceneDocument;
use fullmag_session::runtime_service::{
    validate_descriptor as validate_runtime_owner_descriptor, RuntimeServiceOwnerDescriptor,
    RuntimeServiceState,
};
use fullmag_session::{FmsTaskLifecycle, FmsTaskReadiness};
use serde::{Deserialize, Serialize};
use serde_json::{json, Value};

use crate::types::{
    AppState, CurrentLiveRequestContext, CurrentLiveSnapshotRequest, RunManifest, SessionManifest,
};

const INPUT_ENV: &str = "FULLMAG_DEVELOPMENT_ACCEPTED_REATTACH_STDIN";
const LEGACY_INPUT_ENV: &str = "FULLMAG_DEVELOPMENT_RESTORE_STDIN";
const RUNTIME_CONTROL_ROOT_ENV: &str = "FULLMAG_RUNTIME_CONTROL_ROOT";
const RUNTIME_PROVENANCE_ENV: &str = "FULLMAG_RUNTIME_PROVENANCE";
const CURRENT_COMPOSE_PROJECT_ENV: &str = "FULLMAG_COMPOSE_PROJECT";
const CURRENT_SOURCE_ROOT_ENV: &str = "FULLMAG_SOURCE_HOST_ROOT";
const CURRENT_CONTROL_VOLUME_ENV: &str = "FULLMAG_BUILD_CONTROL_VOLUME";
const CURRENT_RUNTIME_IMAGE_ENV: &str = "FULLMAG_RUNTIME_IMAGE_ID";
const RUNTIME_PROVENANCE_ROOT: &str = "/opt/fullmag/control";
const RUNTIME_PROVENANCE_RELATIVE: &str = "backend/runtime-provenance.json";
const INPUT_SCHEMA: &str = "fullmag.development-accepted-run-reattach.v1";
const PROOF_SCHEMA: &str = "fullmag.development-accepted-run-reattach-proof.v1";
const RESTORE_ACK_SCHEMA: &str = "fullmag.development-accepted-run-reattach-ack.v1";
const SUCCESSOR_DRAIN_SCHEMA: &str = "fullmag.docker-accepted-run-reattach-drain.v1";
const SUCCESSOR_RUNTIME_SCHEMA: &str = "fullmag.docker-accepted-run-reattach-runtime.v1";
const RESTORE_MODE_HELD: &str = "held_pending_restore";
const RESTORE_MODE_CONSUMED: &str = "completed_consumed_no_replay";
const RESTORE_MODE_SUCCESSOR_AUTO: &str = "successor_auto";
const RESTORE_ACK_PREFIX: &str = "restore-ack-";
const SUCCESSOR_DRAIN_PREFIX: &str = "successor-drain-";
const MAX_INPUT_BYTES: usize = 64 * 1024;
const MAX_PROOF_BYTES: usize = 256 * 1024;
const MAX_PROVENANCE_BYTES: usize = 1024 * 1024;
const MAX_CONTROL_RECORD_BYTES: usize = 8 * 1024 * 1024;
const ACTIVATION_OPERATION_SCHEMA: &str = "fullmag.docker-build-operation.v1";
const STOP_VERIFICATION_SCHEMA: &str = "fullmag.stop-failed-admission.v1";
const NAMESPACE_ATTESTATION_SCHEMA: &str = "fullmag.docker-stopped-namespace-attestation.v1";
const API_START_FAILURE_MODE: &str = "api-start-failure";
const API_START_FAILURE_ERROR_PREFIX: &str = "API binding did not become ready:";

#[derive(Debug, Deserialize)]
#[serde(deny_unknown_fields)]
struct AcceptedRestoreInput {
    schema: String,
    target_build_id: String,
    target_source_sha256: String,
    run_id: String,
    project_id: String,
    source_request_id: String,
    source_sha256: String,
    startup_provenance_sha256: String,
    config_sha256: String,
    proof_path: String,
    proof_sha256: String,
    /// Optional fields are the private successor transport.  The legacy
    /// v1 payload remains strict when all successor fields are absent.
    #[serde(default)]
    request_sha256: Option<String>,
    #[serde(default)]
    restore_mode: Option<String>,
    #[serde(default)]
    previous_ack_path: Option<String>,
    #[serde(default)]
    previous_ack_sha256: Option<String>,
    #[serde(default)]
    previous_drain_path: Option<String>,
    #[serde(default)]
    previous_drain_sha256: Option<String>,
}

#[derive(Debug, Clone, Serialize, Deserialize)]
#[serde(deny_unknown_fields)]
struct AcceptedRestoreAck {
    schema: String,
    state: String,
    restore_mode: String,
    request_sha256: String,
    proof_sha256: String,
    run_id: String,
    project_id: String,
    source_request_id: String,
    source_sha256: String,
    config_sha256: String,
    activation_attempt: String,
    reconciliation_attempt: String,
    logical_session_id: String,
    session_epoch: u64,
    api_instance_id: String,
    previous_ack_sha256: Option<String>,
}

#[derive(Debug, Clone, Deserialize)]
#[serde(deny_unknown_fields)]
struct AcceptedRestoreRuntimeMetadata {
    schema: String,
    restore_mode: String,
    request_sha256: String,
    proof_sha256: String,
    run_id: String,
    project_id: String,
    source_request_id: String,
    source_sha256: String,
    config_sha256: String,
    ack_relative: String,
    ack_sha256: String,
    api_instance_id: String,
    previous_ack_sha256: Option<String>,
}

#[derive(Debug, Clone, Serialize, Deserialize)]
#[serde(deny_unknown_fields)]
struct AcceptedRestoreSuccessorDrain {
    schema: String,
    state: String,
    request_sha256: String,
    proof_sha256: String,
    run_id: String,
    project_id: String,
    source_request_id: String,
    source_sha256: String,
    config_sha256: String,
    api_instance_id: String,
    ack_relative: String,
    ack_sha256: String,
    ready_owner_token: String,
    terminal_process_record_path: String,
    terminal_process_record_sha256: String,
    terminal_owner_record_path: String,
    terminal_owner_record_sha256: String,
    ready_owner_record_path: String,
    ready_owner_record_sha256: String,
}

#[derive(Debug, Deserialize)]
#[serde(deny_unknown_fields)]
struct AcceptedRestoreProof {
    schema: String,
    run_id: String,
    project_id: String,
    source_request_id: String,
    source_sha256: String,
    startup_provenance_sha256: String,
    activation_receipt_sha256: String,
    stop_reconcile_proof_sha256: String,
    stop_verification_sha256: String,
    terminal_owner_record_path: String,
    terminal_owner_record_sha256: String,
    terminal_process_record_path: String,
    terminal_process_record_sha256: String,
    namespace_attestation_path: Option<String>,
    namespace_attestation_sha256: Option<String>,
    activation_attempt: String,
    reconciliation_attempt: String,
    backend_container: String,
    image_id: String,
    source_root: String,
    compose_project: String,
    control_volume: String,
    development_attempt: String,
    config_sha256: String,
    logical_session_id: String,
    session_epoch: u64,
}

/// Process-local proof that the current workspace was installed by the
/// validated pre-listen reattach path. Metadata is deliberately insufficient
/// for this purpose because internal snapshot publishers can replace it.
#[derive(Debug, Clone, PartialEq, Eq)]
pub(crate) struct AcceptedRunReattachIdentity {
    pub(crate) run_id: String,
    pub(crate) session_id: String,
    pub(crate) session_epoch: u64,
    pub(crate) scene_revision: u64,
    pub(crate) proof_sha256: String,
}

impl AcceptedRunReattachIdentity {
    pub(crate) fn matches(
        &self,
        run_id: &str,
        session_id: &str,
        session_epoch: u64,
        scene_revision: u64,
    ) -> bool {
        self.proof_sha256.len() == 64
            && self.run_id == run_id
            && self.session_id == session_id
            && self.session_epoch == session_epoch
            && self.scene_revision == scene_revision
    }
}

struct LoadedAcceptedRestore {
    run_id: RunId,
    project_id: ProjectId,
    specification: RunSpecification,
    scene: SceneDocument,
    logical_session_id: String,
    session_epoch: u64,
    source_request_id: String,
    source_sha256: String,
    startup_provenance_sha256: String,
    config_sha256: String,
    request_sha256: Option<String>,
    restore_mode: Option<String>,
    previous_ack_sha256: Option<String>,
    proof_sha256: String,
    total_steps: usize,
    catalog_revision: u64,
    activation_attempt: String,
    reconciliation_attempt: String,
    mode: AcceptedRestoreMode,
    terminal_outcome: Option<String>,
}

#[derive(Debug, Clone, Copy, PartialEq, Eq)]
enum AcceptedRestoreMode {
    Held,
    Consumed,
}

/// Read and install one explicitly pinned accepted run before the API starts
/// listening.  An absent environment switch is a no-op so ordinary startup
/// and the legacy authoring restore retain their existing behavior.
pub(crate) async fn restore_before_listen(state: &Arc<AppState>) -> Result<(), String> {
    match std::env::var_os(INPUT_ENV) {
        None => return Ok(()),
        Some(value) if value == "1" => {}
        Some(_) => return Err("invalid private accepted-run reattach configuration".into()),
    }
    if std::env::var_os(LEGACY_INPUT_ENV).is_some() {
        return Err("accepted-run reattach cannot be combined with authoring restore".into());
    }
    let input = read_input().await?;
    validate_input_digests(&input).map_err(|error| error.to_string())?;
    validate_current_build(&input).map_err(|error| error.to_string())?;
    let Some(store_root) = state.submit_store_root.clone() else {
        return Err("accepted-run reattach requires the configured accepted store".into());
    };
    let proof_root = configured_runtime_control_root().map_err(|error| error.to_string())?;
    let proof_root_for_ack = proof_root.clone();
    let proof_path_for_ack = input.proof_path.clone();
    let api_instance_id = state.request_scope_instance_id.clone();
    let loaded = tokio::task::spawn_blocking(move || {
        load_accepted_restore(&store_root, &proof_root, &input, &api_instance_id)
    })
    .await
    .map_err(|error| format!("accepted-run reattach validation task failed: {error}"))?
    .map_err(|error| format!("accepted-run reattach validation failed: {error:#}"))?;

    let _transition = state.current_live_session_transition.lock().await;
    if state.current_live_state.read().await.is_some()
        || state.current_live_session_epoch.load(Ordering::Acquire) != 0
    {
        return Err("accepted-run reattach requires a fresh API workspace".into());
    }
    let snapshot = build_snapshot(state, &loaded).map_err(|error| error.to_string())?;
    *state.current_live_state.write().await = Some(snapshot);
    state
        .current_live_session_epoch
        .store(loaded.session_epoch, Ordering::Release);
    drop(_transition);

    if loaded.mode == AcceptedRestoreMode::Held {
        // Reuse the existing accepted-frontier read-model path. It reads the
        // already published task/stage receipt and may only replay the exact
        // immutable anchor; it never releases the run or starts a worker.
        let context = CurrentLiveRequestContext {
            session_id: loaded.logical_session_id.clone(),
            run_id: Some(loaded.run_id.as_str().to_string()),
            session_epoch: loaded.session_epoch,
            request_scope_epoch: format!(
                "{}:{}",
                state.request_scope_instance_id, loaded.session_epoch
            ),
        };
        crate::live_scene_preparation::publish_accepted_frontier_preparation(
            state,
            &context,
            "accepted_run_reattach",
        )
        .await
        .map_err(|error| format!("accepted-run preparation projection failed: {error}"))?;
    }

    // Install the process-local rebind authority only after the immutable
    // preparation projection succeeds.  A failed projection must not leave a
    // partially hydrated process able to bypass the durable API-instance pin.
    *state.accepted_run_reattach_identity.write().await = Some(AcceptedRunReattachIdentity {
        run_id: loaded.run_id.as_str().to_string(),
        session_id: loaded.logical_session_id.clone(),
        session_epoch: loaded.session_epoch,
        scene_revision: loaded.scene.revision,
        proof_sha256: loaded.proof_sha256.clone(),
    });

    // The preparation projection replaces metadata with its canonical
    // execution view. Re-add only this private marker so the output projector
    // can distinguish a verified API-instance rebind from a stale bridge.
    let mut current = state.current_live_state.write().await;
    let snapshot = current
        .as_mut()
        .ok_or_else(|| "accepted-run reattach lost its live snapshot".to_string())?;
    let metadata = snapshot
        .metadata
        .get_or_insert_with(|| json!({}))
        .as_object_mut()
        .ok_or_else(|| "accepted-run reattach metadata is not an object".to_string())?;
    metadata.insert(
        "accepted_run_reattach".into(),
        json!({
            "schema": INPUT_SCHEMA,
            "run_id": loaded.run_id.as_str(),
            "project_id": loaded.project_id.as_str(),
            "source_request_id": &loaded.source_request_id,
            "source_sha256": &loaded.source_sha256,
            "startup_provenance_sha256": &loaded.startup_provenance_sha256,
            "config_sha256": &loaded.config_sha256,
            "request_sha256": &loaded.request_sha256,
            "restore_mode": &loaded.restore_mode,
            "previous_ack_sha256": &loaded.previous_ack_sha256,
            "session_epoch": loaded.session_epoch,
            "proof_sha256": &loaded.proof_sha256,
            "mode": match loaded.mode {
                AcceptedRestoreMode::Held => "held",
                AcceptedRestoreMode::Consumed => "consumed",
            },
        }),
    );
    snapshot.state_version = snapshot.state_version.saturating_add(1);
    if loaded.request_sha256.is_some() {
        publish_restore_ack(
            &proof_root_for_ack,
            &proof_path_for_ack,
            &loaded,
            &state.request_scope_instance_id,
        )
        .map_err(|error| format!("publish accepted-run restore ack failed: {error:#}"))?;
    }
    Ok(())
}

/// Validate the build inside the API process and the immutable provenance
/// published by the Docker build controller.  The old development watcher
/// identity is intentionally not consulted here: Docker PID 1 does not run
/// that watcher and therefore has no `DevelopmentBackendConfig::Managed`.
/// `target_build_id` is the compiled source commit, while
/// `target_source_sha256` is the compiled source snapshot.  Requiring both
/// the embedded identity and the mounted provenance prevents a late host
/// receipt from selecting a different binary after the API has started.
fn validate_current_build(input: &AcceptedRestoreInput) -> Result<()> {
    let build = fullmag_build_info::identity();
    validate_compiled_target(input, build)?;

    let configured = std::env::var_os(RUNTIME_PROVENANCE_ENV)
        .context("accepted-run reattach requires Docker runtime provenance")?;
    let configured = Path::new(&configured);
    let expected = Path::new(RUNTIME_PROVENANCE_ROOT).join(RUNTIME_PROVENANCE_RELATIVE);
    if configured != expected {
        bail!("Docker runtime provenance path is not the fixed build-control path");
    }
    let bytes = fullmag_session::repository_path::read_bounded_regular_file(
        Path::new(RUNTIME_PROVENANCE_ROOT),
        RUNTIME_PROVENANCE_RELATIVE,
        MAX_PROVENANCE_BYTES,
    )
    .context("read Docker runtime provenance")?;
    let provenance: Value =
        serde_json::from_slice(&bytes).context("decode Docker runtime provenance")?;
    if provenance.get("schema").and_then(Value::as_str) != Some("fullmag.docker-all-image.v1")
        || provenance.get("state").and_then(Value::as_str) != Some("succeeded")
    {
        bail!("Docker runtime provenance is not a succeeded build");
    }
    let provenance_commit = provenance
        .get("commit")
        .and_then(Value::as_str)
        .context("Docker runtime provenance has no commit")?;
    let provenance_snapshot = provenance
        .get("source_snapshot_sha256")
        .and_then(Value::as_str)
        .context("Docker runtime provenance has no source snapshot")?;
    let current_image = std::env::var(CURRENT_RUNTIME_IMAGE_ENV)
        .context("accepted-run reattach requires the current runtime image identity")?;
    validate_image_id(&current_image, CURRENT_RUNTIME_IMAGE_ENV)?;
    let provenance_image = provenance
        .get("image_id")
        .and_then(Value::as_str)
        .context("Docker runtime provenance has no image identity")?;
    validate_image_id(provenance_image, "Docker runtime provenance image")?;
    if provenance_image != current_image {
        bail!("Docker runtime provenance image differs from the current runtime image");
    }
    validate_commit(provenance_commit, "Docker runtime provenance commit")?;
    validate_digest(
        provenance_snapshot,
        "Docker runtime provenance source snapshot",
    )?;
    if provenance_commit != build.git_commit || provenance_snapshot != build.source_snapshot_sha256
    {
        bail!("Docker runtime provenance differs from the compiled API build");
    }
    Ok(())
}

fn validate_compiled_target(
    input: &AcceptedRestoreInput,
    build: fullmag_build_info::BuildIdentity,
) -> Result<()> {
    validate_commit(build.git_commit, "compiled build commit")?;
    validate_digest(
        build.source_snapshot_sha256,
        "compiled build source snapshot",
    )?;
    if input.target_build_id != build.git_commit
        || input.target_source_sha256 != build.source_snapshot_sha256
    {
        bail!("accepted-run reattach input targets a different compiled build");
    }
    Ok(())
}

async fn read_input() -> Result<AcceptedRestoreInput, String> {
    let (sender, receiver) = tokio::sync::oneshot::channel();
    std::thread::Builder::new()
        .name("accepted-run-reattach-input".into())
        .spawn(move || {
            let mut bytes = Vec::new();
            let result = std::io::stdin()
                .lock()
                .take((MAX_INPUT_BYTES + 1) as u64)
                .read_to_end(&mut bytes)
                .map_err(|_| "cannot read private accepted-run reattach input".to_string())
                .and_then(|_| {
                    if bytes.len() > MAX_INPUT_BYTES {
                        Err("private accepted-run reattach input exceeds its limit".to_string())
                    } else {
                        serde_json::from_slice::<AcceptedRestoreInput>(&bytes)
                            .map_err(|_| "invalid private accepted-run reattach input".to_string())
                    }
                });
            let _ = sender.send(result);
        })
        .map_err(|_| "cannot start private accepted-run reattach reader".to_string())?;
    tokio::time::timeout(Duration::from_secs(10), receiver)
        .await
        .map_err(|_| "private accepted-run reattach input deadline exceeded".to_string())?
        .map_err(|_| "private accepted-run reattach reader disconnected".to_string())?
}

#[derive(Debug)]
struct PreviousRestoreAck {
    sha256: String,
    restore_mode: String,
}

fn load_accepted_restore(
    store_root: &Path,
    proof_root: &Path,
    input: &AcceptedRestoreInput,
    current_api_instance_id: &str,
) -> Result<LoadedAcceptedRestore> {
    let store = fullmag_session::SessionStore::open_existing(store_root)
        .context("open accepted control store")?;
    fullmag_session::repository_path::validate_relative_path(&input.proof_path)
        .context("proof_path must be a relative control-store path")?;
    let proof_bytes = fullmag_session::repository_path::read_bounded_regular_file(
        proof_root,
        &input.proof_path,
        MAX_PROOF_BYTES,
    )
    .context("read accepted-run reattach proof")?;
    if fullmag_session::hex_sha256(&proof_bytes) != input.proof_sha256 {
        bail!("accepted-run reattach proof digest differs from its input pin");
    }
    let proof: AcceptedRestoreProof =
        serde_json::from_slice(&proof_bytes).context("decode accepted-run reattach proof")?;
    validate_proof(&proof, input)?;
    validate_current_docker_binding(&proof)?;

    let predecessor = if input.previous_ack_path.is_some() {
        Some(validate_successor_transport(
            proof_root,
            input,
            &proof,
            current_api_instance_id,
        )?)
    } else {
        validate_initial_transport(input)?;
        validate_backing_records(&proof, input, proof_root)?;
        None
    };

    let run_id = RunId::parse(input.run_id.clone()).map_err(anyhow::Error::msg)?;
    let project_id = ProjectId::parse(input.project_id.clone()).map_err(anyhow::Error::msg)?;
    let accepted =
        fullmag_runtime_control::load_accepted_study_snapshot(&store, &run_id, &project_id)
            .context("load immutable accepted Study snapshot")?;
    let specification = accepted.run.specification.clone();
    if specification.snapshot.project_id != project_id || specification.run_id != run_id {
        bail!("accepted RunSpecification identity differs from explicit reattach pins");
    }
    validate_live_binding(&specification, input, &proof)?;
    let scene = scene_from_definition(&accepted.run.definition_bytes, &specification)?;
    if scene.revision != specification.snapshot.definition_revision {
        bail!("accepted SceneDocument revision differs from immutable project snapshot");
    }

    let catalog = store
        .read_run_catalog(run_id.as_str())?
        .context("accepted run catalog is missing")?;
    let start_released = store.accepted_run_start_permitted(run_id.as_str())?;
    let held = !catalog.tasks.is_empty()
        && catalog.tasks.iter().all(|task| {
            task.lifecycle == FmsTaskLifecycle::Accepted
                && matches!(&task.readiness, FmsTaskReadiness::Blocked { .. })
        })
        && !start_released;

    // This read-only guard covers only durable SessionStore leases for this
    // exact run.  Host-ledger reservations are an independent authority and
    // are deliberately not claimed or released by an accepted successor.
    let terminal_local_leases_drained = predecessor.is_some()
        && input.restore_mode.as_deref() == Some(RESTORE_MODE_SUCCESSOR_AUTO)
        && start_released
        && !held;
    if terminal_local_leases_drained {
        ensure_terminal_run_has_no_active_leases(&store, run_id.as_str())?;
    }
    let (mode, terminal_outcome, actual_restore_mode) = classify_restore_state(
        input.restore_mode.as_deref(),
        predecessor.is_some(),
        predecessor
            .as_ref()
            .map(|item| item.restore_mode.as_str()),
        held,
        start_released,
        terminal_local_leases_drained,
        &catalog,
    )?;

    if mode == AcceptedRestoreMode::Held {
        let anchor = store
            .read_preparation_receipt(run_id.as_str())?
            .context("accepted run preparation anchor is missing")?;
        anchor.validate()?;
        let application: fullmag_application::PreparationReceipt =
            serde_json::from_value(anchor.payload.clone())
                .context("accepted preparation anchor is not an application receipt")?;
        application
            .validate()
            .map_err(|error| anyhow::anyhow!(error.to_string()))?;
        let source = application
            .accepted_run_source
            .as_ref()
            .context("accepted preparation anchor has no accepted-run source")?;
        if source.run_id != run_id {
            bail!("accepted preparation anchor source run differs from reattach run");
        }
        let step_id = source.step_id.clone();
        let step = accepted
            .lowered
            .steps
            .iter()
            .find(|step| step.step_id == step_id)
            .context("accepted preparation anchor references an unknown study step")?;
        if !matches!(step.status, fullmag_plan::StudyStepLoweringStatus::Planned) {
            bail!("accepted preparation anchor does not identify a planned step");
        }
        if !fullmag_runtime_control::accepted_run_step_is_scheduler_ready(
            &store,
            &run_id,
            &step_id,
        )? {
            bail!("accepted preparation anchor is not scheduler-ready");
        }
        let task_id = fullmag_session::task_id_for_study_step(run_id.as_str(), &step_id)?;
        let task_receipt = store
            .read_task_preparation_receipt(run_id.as_str(), &task_id)?
            .context("accepted frontier task preparation receipt is missing")?;
        if task_receipt.preparation_id != anchor.preparation_id
            || task_receipt.plan_fingerprint != anchor.plan_fingerprint
            || task_receipt.payload != anchor.payload
        {
            bail!("accepted preparation anchor differs from immutable task receipt");
        }
        let stage = store
            .read_accepted_stage_preparation_receipt(run_id.as_str(), &step_id)?
            .context("accepted frontier stage receipt is missing")?;
        if !stage.matches_task_receipt(&task_receipt) {
            bail!("accepted frontier stage receipt differs from task receipt");
        }
    }

    Ok(LoadedAcceptedRestore {
        run_id,
        project_id,
        specification,
        scene,
        logical_session_id: proof.logical_session_id.clone(),
        session_epoch: proof.session_epoch,
        source_request_id: input.source_request_id.clone(),
        source_sha256: input.source_sha256.clone(),
        startup_provenance_sha256: input.startup_provenance_sha256.clone(),
        config_sha256: input.config_sha256.clone(),
        request_sha256: input.request_sha256.clone(),
        restore_mode: Some(actual_restore_mode.into()).filter(|_| input.request_sha256.is_some()),
        previous_ack_sha256: predecessor.as_ref().map(|item| item.sha256.clone()),
        proof_sha256: input.proof_sha256.clone(),
        total_steps: catalog.tasks.len(),
        catalog_revision: catalog.revision,
        activation_attempt: proof.activation_attempt.clone(),
        reconciliation_attempt: proof.reconciliation_attempt.clone(),
        mode,
        terminal_outcome,
    })
}

/// Publish the process-local success marker only after the immutable snapshot
/// and, for a held run, its preparation projection are installed.  The file
/// is create-only: a replay with identical bytes is accepted, while a
/// different payload is a hard conflict.  The control volume remains the
/// sole authority; no user-store fallback is permitted.
fn publish_restore_ack(
    proof_root: &Path,
    proof_path: &str,
    loaded: &LoadedAcceptedRestore,
    api_instance_id: &str,
) -> Result<String> {
    let request_sha256 = loaded
        .request_sha256
        .as_deref()
        .context("accepted-run restore ack requires the request digest")?;
    let restore_mode = loaded
        .restore_mode
        .as_deref()
        .context("accepted-run restore ack requires the restore mode")?;
    validate_ack_mode(restore_mode)?;
    validate_api_instance_id(api_instance_id, "current API instance")?;
    let parent = Path::new(proof_path)
        .parent()
        .context("accepted-run restore proof has no parent directory")?;
    let filename = format!("{RESTORE_ACK_PREFIX}{api_instance_id}.json");
    let ack_relative = parent.join(&filename);
    let ack_relative = ack_relative
        .to_str()
        .context("accepted-run restore ack path is not portable")?;
    let expected_api = validate_ack_record_path(ack_relative, proof_path, "ack_path")?;
    if expected_api != api_instance_id {
        bail!("accepted-run restore ack path does not bind the current API instance");
    }
    let destination = fullmag_session::repository_path::checked_path(proof_root, ack_relative)?;
    let ack = AcceptedRestoreAck {
        schema: RESTORE_ACK_SCHEMA.into(),
        state: "consumed".into(),
        restore_mode: restore_mode.into(),
        request_sha256: request_sha256.into(),
        proof_sha256: loaded.proof_sha256.clone(),
        run_id: loaded.run_id.as_str().into(),
        project_id: loaded.project_id.as_str().into(),
        source_request_id: loaded.source_request_id.clone(),
        source_sha256: loaded.source_sha256.clone(),
        config_sha256: loaded.config_sha256.clone(),
        activation_attempt: loaded.activation_attempt.clone(),
        reconciliation_attempt: loaded.reconciliation_attempt.clone(),
        logical_session_id: loaded.logical_session_id.clone(),
        session_epoch: loaded.session_epoch,
        api_instance_id: api_instance_id.into(),
        previous_ack_sha256: loaded.previous_ack_sha256.clone(),
    };
    let mut bytes = fullmag_session::canonical_json_bytes(
        &serde_json::to_value(&ack).context("encode accepted-run restore ack")?,
    );
    bytes.push(b'\n');
    if bytes.len() > MAX_PROOF_BYTES {
        bail!("accepted-run restore ack exceeds its size bound");
    }
    match OpenOptions::new()
        .write(true)
        .create_new(true)
        .open(&destination)
    {
        Ok(mut file) => {
            file.write_all(&bytes)
                .context("write accepted-run restore ack")?;
            file.sync_all()
                .context("sync accepted-run restore ack")?;
            drop(file);
            fs::File::open(destination.parent().context("restore ack has no parent")?)
                .context("open accepted-run restore ack directory")?
                .sync_all()
                .context("sync accepted-run restore ack directory")?;
            let published = fullmag_session::repository_path::read_bounded_regular_file(
                proof_root,
                ack_relative,
                MAX_PROOF_BYTES,
            )?;
            if published != bytes {
                bail!("accepted-run restore ack changed during publication");
            }
            Ok(fullmag_session::hex_sha256(&published))
        }
        Err(error) if error.kind() == std::io::ErrorKind::AlreadyExists => {
            let metadata = fs::symlink_metadata(&destination)
                .context("inspect existing accepted-run restore ack")?;
            if !metadata.is_file() || metadata.file_type().is_symlink() {
                bail!("accepted-run restore ack destination is not a regular file");
            }
            let existing = fullmag_session::repository_path::read_bounded_regular_file(
                proof_root,
                ack_relative,
                MAX_PROOF_BYTES,
            )?;
            if existing != bytes {
                bail!("accepted-run restore ack already exists with different bytes");
            }
            Ok(fullmag_session::hex_sha256(&existing))
        }
        Err(error) => Err(error).context("create accepted-run restore ack exclusively"),
    }
}

/// Validate a successor using the previous native acknowledgement and its
/// authenticated host drain.  Mutable OWNER/process records are deliberately
/// not read here: PID 1 may rotate them before this API process starts.
fn validate_successor_transport(
    proof_root: &Path,
    input: &AcceptedRestoreInput,
    proof: &AcceptedRestoreProof,
    current_api_instance_id: &str,
) -> Result<PreviousRestoreAck> {
    validate_successor_input(input)?;
    let previous_path = input
        .previous_ack_path
        .as_deref()
        .context("successor accepted-run input has no previous acknowledgement path")?;
    let previous_sha256 = input
        .previous_ack_sha256
        .as_deref()
        .context("successor accepted-run input has no previous acknowledgement digest")?;
    let previous_drain_path = input
        .previous_drain_path
        .as_deref()
        .context("successor accepted-run input has no previous drain path")?;
    let previous_drain_sha256 = input
        .previous_drain_sha256
        .as_deref()
        .context("successor accepted-run input has no previous drain digest")?;
    let previous_api_instance_id =
        validate_ack_record_path(previous_path, &input.proof_path, "previous_ack_path")?;
    validate_digest(previous_sha256, "previous_ack_sha256")?;
    validate_api_instance_id(current_api_instance_id, "current API instance")?;
    if previous_api_instance_id == current_api_instance_id {
        bail!("successor accepted-run restore reused the previous API instance");
    }

    let (ack_raw, ack_value) =
        read_proof_record(proof_root, previous_path, "previous accepted-run restore ack")?;
    if fullmag_session::hex_sha256(&ack_raw) != previous_sha256 {
        bail!("previous accepted-run restore ack digest differs from its input pin");
    }
    let ack: AcceptedRestoreAck =
        serde_json::from_value(ack_value).context("decode previous accepted-run restore ack")?;
    validate_restore_ack(
        &ack,
        input,
        proof,
        &previous_api_instance_id,
    )?;
    if ack.restore_mode != RESTORE_MODE_HELD && ack.restore_mode != RESTORE_MODE_CONSUMED {
        bail!("previous accepted-run restore ack has an unsupported mode");
    }
    if ack.restore_mode == RESTORE_MODE_CONSUMED && ack.previous_ack_sha256.is_none() {
        bail!("consumed accepted-run restore ack has no predecessor digest");
    }

    let drain_filename = format!("{SUCCESSOR_DRAIN_PREFIX}{previous_api_instance_id}.json");
    let drain_relative = Path::new(previous_path)
        .parent()
        .context("previous accepted-run restore ack has no parent")?
        .join(&drain_filename);
    let drain_relative = drain_relative
        .to_str()
        .context("successor drain path is not portable")?;
    if previous_drain_path != drain_relative {
        bail!("successor drain path differs from the previous API instance");
    }
    validate_digest(previous_drain_sha256, "previous_drain_sha256")?;
    let drain_api = validate_drain_record_path(
        drain_relative,
        &input.proof_path,
        &previous_api_instance_id,
    )?;
    if drain_api != previous_api_instance_id {
        bail!("successor drain does not bind the previous API instance");
    }
    let (drain_raw, drain_value) =
        read_proof_record(proof_root, drain_relative, "accepted-run successor drain")?;
    if fullmag_session::hex_sha256(&drain_raw) != previous_drain_sha256 {
        bail!("successor drain digest differs from its input pin");
    }
    let drain: AcceptedRestoreSuccessorDrain =
        serde_json::from_value(drain_value).context("decode accepted-run successor drain")?;
    validate_successor_drain(
        proof_root,
        &drain,
        &ack,
        input,
        previous_path,
        previous_sha256,
    )?;
    Ok(PreviousRestoreAck {
        sha256: previous_sha256.into(),
        restore_mode: ack.restore_mode,
    })
}

fn validate_initial_transport(input: &AcceptedRestoreInput) -> Result<()> {
    match (
        input.request_sha256.as_deref(),
        input.restore_mode.as_deref(),
        input.previous_ack_path.as_deref(),
        input.previous_ack_sha256.as_deref(),
        input.previous_drain_path.as_deref(),
        input.previous_drain_sha256.as_deref(),
    ) {
        (None, None, None, None, None, None) => Ok(()),
        (Some(request), Some(mode), None, None, None, None) => {
            validate_digest(request, "request_sha256")?;
            if mode != RESTORE_MODE_HELD {
                bail!("initial accepted-run restore must use held_pending_restore");
            }
            Ok(())
        }
        _ => bail!("accepted-run reattach transport fields are incomplete"),
    }
}

fn validate_successor_input(input: &AcceptedRestoreInput) -> Result<()> {
    let request_sha256 = input
        .request_sha256
        .as_deref()
        .context("successor accepted-run input has no request digest")?;
    validate_digest(request_sha256, "request_sha256")?;
    if input.restore_mode.as_deref() != Some(RESTORE_MODE_SUCCESSOR_AUTO) {
        bail!("successor accepted-run restore must use successor_auto");
    }
    if input.previous_ack_path.is_none()
        || input.previous_ack_sha256.is_none()
        || input.previous_drain_path.is_none()
        || input.previous_drain_sha256.is_none()
    {
        bail!("successor accepted-run restore requires the previous acknowledgement and drain");
    }
    Ok(())
}

fn validate_restore_ack(
    ack: &AcceptedRestoreAck,
    input: &AcceptedRestoreInput,
    proof: &AcceptedRestoreProof,
    expected_api_instance_id: &str,
) -> Result<()> {
    if ack.schema != RESTORE_ACK_SCHEMA || ack.state != "consumed" {
        bail!("accepted-run restore ack is not a consumed native acknowledgement");
    }
    validate_ack_mode(&ack.restore_mode)?;
    validate_digest(&ack.request_sha256, "restore ack request_sha256")?;
    validate_digest(&ack.proof_sha256, "restore ack proof_sha256")?;
    validate_digest(&ack.source_sha256, "restore ack source_sha256")?;
    validate_digest(&ack.config_sha256, "restore ack config_sha256")?;
    if let Some(previous) = ack.previous_ack_sha256.as_deref() {
        validate_digest(previous, "restore ack previous_ack_sha256")?;
    }
    validate_attempt(&ack.activation_attempt, "restore ack activation_attempt")?;
    validate_attempt(&ack.reconciliation_attempt, "restore ack reconciliation_attempt")?;
    validate_non_empty(&ack.run_id, "restore ack run_id")?;
    validate_non_empty(&ack.project_id, "restore ack project_id")?;
    validate_non_empty(&ack.source_request_id, "restore ack source_request_id")?;
    validate_non_empty(&ack.logical_session_id, "restore ack logical_session_id")?;
    validate_api_instance_id(&ack.api_instance_id, "restore ack api_instance_id")?;
    if ack.api_instance_id != expected_api_instance_id
        || ack.request_sha256 != input.request_sha256.as_deref().unwrap_or_default()
        || ack.proof_sha256 != input.proof_sha256
        || ack.run_id != input.run_id
        || ack.project_id != input.project_id
        || ack.source_request_id != input.source_request_id
        || ack.source_sha256 != input.source_sha256
        || ack.config_sha256 != input.config_sha256
        || ack.activation_attempt != proof.activation_attempt
        || ack.reconciliation_attempt != proof.reconciliation_attempt
        || ack.logical_session_id != proof.logical_session_id
        || ack.session_epoch != proof.session_epoch
    {
        bail!("accepted-run restore ack differs from immutable reattach pins");
    }
    if ack.session_epoch != proof.session_epoch || ack.session_epoch == 0 {
        bail!("accepted-run restore ack has an invalid immutable session epoch");
    }
    Ok(())
}

fn validate_successor_drain(
    proof_root: &Path,
    drain: &AcceptedRestoreSuccessorDrain,
    ack: &AcceptedRestoreAck,
    input: &AcceptedRestoreInput,
    ack_relative: &str,
    ack_sha256: &str,
) -> Result<()> {
    if drain.schema != SUCCESSOR_DRAIN_SCHEMA || drain.state != "drained" {
        bail!("accepted-run successor drain is not authenticated");
    }
    for (value, field) in [
        (&drain.request_sha256, "successor drain request_sha256"),
        (&drain.proof_sha256, "successor drain proof_sha256"),
        (&drain.source_sha256, "successor drain source_sha256"),
        (&drain.config_sha256, "successor drain config_sha256"),
        (&drain.ack_sha256, "successor drain ack_sha256"),
        (
            &drain.terminal_process_record_sha256,
            "successor drain terminal_process_record_sha256",
        ),
        (
            &drain.terminal_owner_record_sha256,
            "successor drain terminal_owner_record_sha256",
        ),
        (
            &drain.ready_owner_record_sha256,
            "successor drain ready_owner_record_sha256",
        ),
    ] {
        validate_digest(value, field)?;
    }
    validate_api_instance_id(&drain.api_instance_id, "successor drain api_instance_id")?;
    validate_bounded_text(&drain.ready_owner_token, "successor drain ready_owner_token")?;
    if drain.request_sha256 != input.request_sha256.as_deref().unwrap_or_default()
        || drain.proof_sha256 != input.proof_sha256
        || drain.run_id != input.run_id
        || drain.project_id != input.project_id
        || drain.source_request_id != input.source_request_id
        || drain.source_sha256 != input.source_sha256
        || drain.config_sha256 != input.config_sha256
        || drain.api_instance_id != ack.api_instance_id
        || drain.ack_relative != ack_relative
        || drain.ack_sha256 != ack_sha256
    {
        bail!("accepted-run successor drain differs from its predecessor acknowledgement");
    }
    let (_, process_record) = read_successor_archive_record(
        proof_root,
        &drain.terminal_process_record_path,
        &drain.terminal_process_record_sha256,
        input,
        &ack.api_instance_id,
        "successor-terminal-process-",
        "terminal process record",
    )?;
    validate_successor_process_record(&process_record, ack, input, ack_relative, ack_sha256)?;
    let (_, terminal_owner_record) = read_successor_archive_record(
        proof_root,
        &drain.terminal_owner_record_path,
        &drain.terminal_owner_record_sha256,
        input,
        &ack.api_instance_id,
        "successor-terminal-owner-",
        "terminal owner record",
    )?;
    let terminal_owner = validate_native_owner(
        &terminal_owner_record,
        "successor terminal owner",
        RuntimeServiceState::Drained,
        &["exited_success"],
    )?;
    let (_, ready_owner_record) = read_successor_archive_record(
        proof_root,
        &drain.ready_owner_record_path,
        &drain.ready_owner_record_sha256,
        input,
        &ack.api_instance_id,
        "successor-ready-owner-",
        "ready owner record",
    )?;
    let ready_owner = validate_native_owner(
        &ready_owner_record,
        "successor ready owner",
        RuntimeServiceState::Ready,
        &["running"],
    )?;
    if owner_identity_key(&terminal_owner) != owner_identity_key(&ready_owner) {
        bail!("successor terminal and ready owner records differ in identity");
    }
    let process_terminal_owner = process_record
        .get("terminal_service_owner")
        .context("successor process record has no terminal service owner")?;
    let process_terminal_owner = validate_native_owner(
        process_terminal_owner,
        "successor process terminal owner",
        RuntimeServiceState::Drained,
        &["exited_success"],
    )?;
    if owner_identity_key(&process_terminal_owner) != owner_identity_key(&terminal_owner) {
        bail!("successor process terminal owner differs from the terminal owner archive");
    }
    match process_record.get("service_owner") {
        Some(process_ready_owner) => {
            let process_ready_owner = validate_native_owner(
                process_ready_owner,
                "successor process ready owner",
                RuntimeServiceState::Ready,
                &["running"],
            )?;
            if owner_identity_key(&process_ready_owner) != owner_identity_key(&ready_owner) {
                bail!("successor process ready owner differs from the ready owner archive");
            }
        }
        None if owner_identity_key(&terminal_owner) == owner_identity_key(&ready_owner) => {}
        None => bail!("successor ready owner archive differs from the terminal owner"),
    }
    if drain.ready_owner_token != ready_owner_record
        .get("owner_token")
        .and_then(Value::as_str)
        .unwrap_or_default()
    {
        bail!("successor drain ready owner token differs from its archive");
    }
    Ok(())
}

fn read_successor_archive_record(
    proof_root: &Path,
    path: &str,
    digest: &str,
    input: &AcceptedRestoreInput,
    api_instance_id: &str,
    filename_prefix: &str,
    label: &str,
) -> Result<(Vec<u8>, Value)> {
    validate_successor_archive_path(
        path,
        &input.proof_path,
        api_instance_id,
        filename_prefix,
        label,
    )?;
    let (raw, value) = read_proof_record(proof_root, path, label)?;
    if fullmag_session::hex_sha256(&raw) != digest {
        bail!("{label} digest differs from its immutable archive pin");
    }
    Ok((raw, value))
}

fn validate_successor_archive_path(
    path: &str,
    proof_path: &str,
    api_instance_id: &str,
    filename_prefix: &str,
    label: &str,
) -> Result<()> {
    fullmag_session::repository_path::validate_relative_path(path)
        .with_context(|| format!("{label} path is unsafe"))?;
    if Path::new(path).parent() != Path::new(proof_path).parent() {
        bail!("{label} must share the accepted proof directory");
    }
    let filename = Path::new(path)
        .file_name()
        .and_then(|name| name.to_str())
        .with_context(|| format!("{label} has no filename"))?;
    let expected = format!("{filename_prefix}{api_instance_id}.json");
    if filename != expected {
        bail!("{label} must name {expected}");
    }
    Ok(())
}

fn validate_successor_process_record(
    record: &Value,
    ack: &AcceptedRestoreAck,
    input: &AcceptedRestoreInput,
    ack_relative: &str,
    ack_sha256: &str,
) -> Result<()> {
    require_equal_string(record, "schema", "fullmag.docker-process-tree.v1")?;
    require_equal_string(record, "state", "drained")?;
    require_json_integer(record, "api_exit_code", "successor process record")?;
    if record.get("runtime_pid").is_some_and(|value| !value.is_null()) {
        bail!("successor process record retains a runtime pid");
    }
    let metadata: AcceptedRestoreRuntimeMetadata = serde_json::from_value(
        record
            .get("accepted_reattach")
            .cloned()
            .context("successor process record has no accepted-run metadata")?,
    )
    .context("successor process record metadata is invalid")?;
    if metadata.schema != SUCCESSOR_RUNTIME_SCHEMA
        || metadata.restore_mode != ack.restore_mode
        || metadata.request_sha256 != ack.request_sha256
        || metadata.proof_sha256 != ack.proof_sha256
        || metadata.run_id != ack.run_id
        || metadata.project_id != ack.project_id
        || metadata.source_request_id != ack.source_request_id
        || metadata.source_sha256 != ack.source_sha256
        || metadata.config_sha256 != ack.config_sha256
        || metadata.api_instance_id != ack.api_instance_id
        || metadata.previous_ack_sha256 != ack.previous_ack_sha256
        || metadata.ack_relative != ack_relative
        || metadata.ack_sha256 != ack_sha256
    {
        bail!("successor process record metadata differs from the native acknowledgement");
    }
    if metadata.request_sha256 != input.request_sha256.as_deref().unwrap_or_default()
        || metadata.proof_sha256 != input.proof_sha256
    {
        bail!("successor process record metadata differs from the input pins");
    }
    Ok(())
}

/// A terminal successor may be acknowledged only after every durable lease
/// belonging to this exact run is explicitly released.  This is a read-only
/// check: it never releases another run's resource and does not use a global
/// idle/GPU shortcut.  The preparation lease listing is the canonical session
/// reader; solver leases are scanned independently because the store's
/// task-scoped orphan helper is intentionally crate-private.
fn ensure_terminal_run_has_no_active_leases(
    store: &fullmag_session::SessionStore,
    run_id: &str,
) -> Result<()> {
    let active_preparation = store.list_active_preparation_resource_leases()?;
    if active_preparation
        .iter()
        .any(|lease| lease.run_id == run_id)
    {
        bail!("accepted-run terminal successor has an active preparation lease")
    }

    let relative_root = format!("runs/{run_id}/resource_leases");
    let root = fullmag_session::repository_path::checked_path(store.root(), &relative_root)?;
    let metadata = match fs::symlink_metadata(&root) {
        Ok(metadata) => metadata,
        Err(error) if error.kind() == std::io::ErrorKind::NotFound => return Ok(()),
        Err(error) => return Err(error).context("read exact-run solver lease directory metadata"),
    };
    if metadata.file_type().is_symlink() || !metadata.is_dir() {
        bail!("exact-run solver lease directory is not a regular directory")
    }
    for resource_entry in fs::read_dir(&root)? {
        let resource_entry = resource_entry?;
        let resource_path = resource_entry.path();
        let resource_metadata = fs::symlink_metadata(&resource_path)?;
        if resource_metadata.file_type().is_symlink() || !resource_metadata.is_dir() {
            bail!("exact-run solver resource entry is not a regular directory")
        }
        let resource_id = resource_entry
            .file_name()
            .into_string()
            .map_err(|_| anyhow::anyhow!("exact-run solver resource identifier is not UTF-8"))?;
        fullmag_session::repository_path::validate_store_id(&resource_id)?;
        for lease_entry in fs::read_dir(&resource_path)? {
            let lease_entry = lease_entry?;
            let lease_path = lease_entry.path();
            let lease_metadata = fs::symlink_metadata(&lease_path)?;
            if lease_metadata.file_type().is_symlink() || !lease_metadata.is_file() {
                bail!("exact-run solver lease entry is not a regular file")
            }
            let filename = lease_entry
                .file_name()
                .into_string()
                .map_err(|_| anyhow::anyhow!("exact-run solver lease filename is not UTF-8"))?;
            let lease_token = filename
                .strip_suffix(".json")
                .context("exact-run solver lease filename must end in .json")?;
            fullmag_session::repository_path::validate_store_id(lease_token)?;
            let relative = format!("{relative_root}/{resource_id}/{filename}");
            let bytes = fullmag_session::repository_path::read_bounded_regular_file(
                store.root(),
                &relative,
                MAX_CONTROL_RECORD_BYTES,
            )?;
            let lease: fullmag_session::FmsResourceLease = serde_json::from_slice(&bytes)
                .context("decode exact-run solver resource lease")?;
            lease.validate()?;
            if lease.run_id != run_id
                || lease.resource_id != resource_id
                || lease.lease_token != lease_token
            {
                bail!("exact-run solver lease identity does not match its path")
            }
            if lease.state == fullmag_session::FmsResourceLeaseState::Active {
                bail!("accepted-run terminal successor has an active solver lease")
            }
        }
    }
    Ok(())
}

/// Classify a pinned restore from the native durable run state.  The
/// successor's `successor_auto` value is only an intent: the catalog and the
/// accepted-run start release decide whether this API instance restores a
/// held frontier or records a terminal no-replay acknowledgement.
fn classify_restore_state(
    requested_mode: Option<&str>,
    has_predecessor: bool,
    predecessor_restore_mode: Option<&str>,
    held: bool,
    start_released: bool,
    terminal_local_leases_drained: bool,
    catalog: &fullmag_session::FmsRunCatalog,
) -> Result<(AcceptedRestoreMode, Option<String>, &'static str)> {
    if requested_mode == Some(RESTORE_MODE_SUCCESSOR_AUTO)
        && predecessor_restore_mode == Some(RESTORE_MODE_CONSUMED)
        && held
    {
        bail!("consumed accepted-run restore cannot return to a held state");
    }
    match (requested_mode, has_predecessor, held, start_released) {
        (None, false, true, false) | (Some(RESTORE_MODE_HELD), false, true, false) => {
            Ok((AcceptedRestoreMode::Held, None, RESTORE_MODE_HELD))
        }
        (Some(RESTORE_MODE_SUCCESSOR_AUTO), true, true, false) => {
            Ok((AcceptedRestoreMode::Held, None, RESTORE_MODE_HELD))
        }
        (Some(RESTORE_MODE_SUCCESSOR_AUTO), true, false, true) => {
            if !terminal_local_leases_drained {
                bail!("accepted-run terminal successor lacks an exact-run local lease proof")
            }
            let outcome = terminal_catalog_outcome(catalog)?;
            Ok((
                AcceptedRestoreMode::Consumed,
                Some(outcome.to_string()),
                RESTORE_MODE_CONSUMED,
            ))
        }
        (Some(RESTORE_MODE_SUCCESSOR_AUTO), true, true, true) => {
            bail!("accepted-run successor state has a start release while its catalog remains held")
        }
        (Some(RESTORE_MODE_SUCCESSOR_AUTO), true, false, false) => {
            bail!("accepted-run successor state is neither held nor terminally released")
        }
        (Some(RESTORE_MODE_HELD), true, _, _) => {
            bail!("held restore mode cannot carry a predecessor acknowledgement")
        }
        (Some(RESTORE_MODE_CONSUMED), _, _, _) => {
            bail!("completed_consumed_no_replay is a native acknowledgement, not an input intent")
        }
        (Some(_), _, _, _) => bail!("accepted-run restore mode is unsupported"),
        (None, true, _, _) => bail!("successor accepted-run input has no restore mode"),
        (None, false, _, _) => {
            bail!("initial accepted-run input does not identify a held accepted run")
        }
    }
}

fn terminal_catalog_outcome(catalog: &fullmag_session::FmsRunCatalog) -> Result<&'static str> {
    if catalog.tasks.is_empty()
        || catalog.tasks.iter().any(|task| {
            !matches!(
                task.lifecycle,
                FmsTaskLifecycle::Succeeded
                    | FmsTaskLifecycle::Failed
                    | FmsTaskLifecycle::Cancelled
                    | FmsTaskLifecycle::Interrupted
            )
        })
    {
        bail!("accepted run catalog is not terminal");
    }
    if catalog
        .tasks
        .iter()
        .any(|task| task.lifecycle == FmsTaskLifecycle::Failed)
    {
        Ok("failed")
    } else if catalog
        .tasks
        .iter()
        .any(|task| task.lifecycle == FmsTaskLifecycle::Interrupted)
    {
        Ok("interrupted")
    } else if catalog
        .tasks
        .iter()
        .any(|task| task.lifecycle == FmsTaskLifecycle::Cancelled)
    {
        Ok("cancelled")
    } else {
        Ok("completed")
    }
}

fn validate_restore_mode(value: &str) -> Result<()> {
    if value != RESTORE_MODE_HELD
        && value != RESTORE_MODE_CONSUMED
        && value != RESTORE_MODE_SUCCESSOR_AUTO
    {
        bail!("accepted-run restore mode is unsupported");
    }
    Ok(())
}

fn validate_ack_mode(value: &str) -> Result<()> {
    if value != RESTORE_MODE_HELD && value != RESTORE_MODE_CONSUMED {
        bail!("accepted-run restore acknowledgement has an unsupported mode");
    }
    Ok(())
}

fn validate_api_instance_id(value: &str, field: &str) -> Result<()> {
    let parsed = uuid::Uuid::parse_str(value)
        .with_context(|| format!("{field} is not a canonical UUID"))?;
    if parsed.to_string() != value {
        bail!("{field} must use the canonical lowercase UUID spelling");
    }
    Ok(())
}

fn validate_ack_record_path(path: &str, proof_path: &str, field: &str) -> Result<String> {
    fullmag_session::repository_path::validate_relative_path(path)
        .with_context(|| format!("{field} is unsafe"))?;
    if Path::new(path).parent() != Path::new(proof_path).parent() {
        bail!("{field} must share the accepted proof directory");
    }
    let filename = Path::new(path)
        .file_name()
        .and_then(|name| name.to_str())
        .with_context(|| format!("{field} has no filename"))?;
    let api_id = filename
        .strip_prefix(RESTORE_ACK_PREFIX)
        .and_then(|value| value.strip_suffix(".json"))
        .context("{field} must name restore-ack-<api_instance_id>.json")?;
    validate_api_instance_id(api_id, field)?;
    Ok(api_id.into())
}

fn validate_drain_record_path(
    path: &str,
    proof_path: &str,
    expected_api_instance_id: &str,
) -> Result<String> {
    fullmag_session::repository_path::validate_relative_path(path)
        .context("successor drain path is unsafe")?;
    if Path::new(path).parent() != Path::new(proof_path).parent() {
        bail!("successor drain must share the accepted proof directory");
    }
    let filename = Path::new(path)
        .file_name()
        .and_then(|name| name.to_str())
        .context("successor drain has no filename")?;
    let api_id = filename
        .strip_prefix(SUCCESSOR_DRAIN_PREFIX)
        .and_then(|value| value.strip_suffix(".json"))
        .context("successor drain must name successor-drain-<api_instance_id>.json")?;
    validate_api_instance_id(api_id, "successor drain api_instance_id")?;
    if api_id != expected_api_instance_id {
        bail!("successor drain path does not bind the previous API instance");
    }
    Ok(api_id.into())
}

fn configured_runtime_control_root() -> Result<std::path::PathBuf> {
    let raw = std::env::var_os(RUNTIME_CONTROL_ROOT_ENV)
        .context("accepted-run reattach requires FULLMAG_RUNTIME_CONTROL_ROOT")?;
    let configured = std::path::PathBuf::from(raw);
    if !configured.is_absolute()
        || configured
            .components()
            .any(|component| matches!(component, std::path::Component::ParentDir))
    {
        bail!("FULLMAG_RUNTIME_CONTROL_ROOT must be an absolute path without parent components");
    }
    fullmag_runtime_control::accepted_store::writable_product_state_path(&configured)
        .context("FULLMAG_RUNTIME_CONTROL_ROOT is not a managed regular directory")
}

fn scene_from_definition(bytes: &[u8], specification: &RunSpecification) -> Result<SceneDocument> {
    if fullmag_session::hex_sha256(bytes) != specification.snapshot.definition_sha256 {
        bail!("accepted project definition bytes differ from immutable snapshot digest");
    }
    let value: Value =
        serde_json::from_slice(bytes).context("decode accepted project definition")?;
    let object = value
        .as_object()
        .context("accepted project definition is not a JSON object")?;
    if object
        .get("schema")
        .and_then(Value::as_str)
        .is_none_or(str::is_empty)
        || object
            .get("name")
            .and_then(Value::as_str)
            .is_none_or(str::is_empty)
        || !object.get("scene").is_some_and(Value::is_object)
    {
        bail!("accepted project definition envelope is incomplete");
    }
    if object.get("project_id").and_then(Value::as_str)
        != Some(specification.snapshot.project_id.as_str())
        || object.get("revision").and_then(Value::as_u64)
            != Some(specification.snapshot.definition_revision)
    {
        bail!("accepted project definition identity differs from RunSpecification");
    }
    let scene: SceneDocument = serde_json::from_value(
        object
            .get("scene")
            .cloned()
            .context("accepted project definition has no scene")?,
    )
    .context("decode accepted SceneDocument")?;
    fullmag_authoring::validate_scene_document_for_authoring(&scene)
        .map_err(|error| anyhow::anyhow!(error.message))?;
    Ok(scene)
}

fn validate_live_binding(
    specification: &RunSpecification,
    input: &AcceptedRestoreInput,
    proof: &AcceptedRestoreProof,
) -> Result<()> {
    let live = specification
        .parameters
        .pointer("/live_workspace")
        .and_then(Value::as_object)
        .context("accepted RunSpecification has no live_workspace binding")?;
    let live_session_id = live
        .get("session_id")
        .and_then(Value::as_str)
        .filter(|value| !value.is_empty())
        .context("accepted live_workspace has no logical session_id")?;
    let live_session_epoch = live
        .get("session_epoch")
        .and_then(Value::as_u64)
        .filter(|value| *value > 0)
        .context("accepted live_workspace has no positive session_epoch")?;
    if live.get("request_idempotency_key").and_then(Value::as_str)
        != Some(input.source_request_id.as_str())
        || live.get("startup_source_sha256").and_then(Value::as_str)
            != Some(input.source_sha256.as_str())
        || live.get("scene_revision").and_then(Value::as_u64)
            != Some(specification.snapshot.definition_revision)
        || proof.session_epoch != live_session_epoch
    {
        bail!("accepted live_workspace binding differs from reattach pins");
    }
    let command = live
        .get("command")
        .and_then(Value::as_object)
        .context("accepted live_workspace has no startup command")?;
    if command.get("kind").and_then(Value::as_str) != Some("startup_script")
        || command.get("request_id").and_then(Value::as_str)
            != Some(input.source_request_id.as_str())
        || command.get("source_sha256").and_then(Value::as_str)
            != Some(input.source_sha256.as_str())
    {
        bail!("accepted startup command differs from reattach pins");
    }
    let policy = specification
        .parameters
        .get(fullmag_session::ACCEPTED_RUN_START_POLICY_KEY)
        .and_then(Value::as_object)
        .context("accepted run has no explicit manual start policy")?;
    if policy.get("schema_version").and_then(Value::as_str) != Some("accepted_run_start_policy.v1")
        || policy.get("mode").and_then(Value::as_str) != Some("manual")
    {
        bail!("accepted run is not held by the manual start gate");
    }
    if proof.logical_session_id != live_session_id {
        bail!("reattach proof logical session differs from accepted RunIntent");
    }
    Ok(())
}

/// Validate the immutable control-volume records which authorize this
/// reattach.  Digest-shaped fields in the private proof are not authority by
/// themselves: every pin is checked against the original activation receipt,
/// the terminal reconciliation receipt, and the stopped-backend verification
/// journal under the fixed build-control mount.
fn validate_backing_records(
    proof: &AcceptedRestoreProof,
    input: &AcceptedRestoreInput,
    proof_root: &Path,
) -> Result<()> {
    validate_current_docker_binding(proof)?;
    let activation_relative = format!(
        "activation/attempts/{}/receipt.json",
        proof.activation_attempt
    );
    let (activation_raw, activation) = read_control_record(
        &activation_relative,
        "original activation receipt",
    )?;
    if fullmag_session::hex_sha256(&activation_raw) != proof.activation_receipt_sha256 {
        bail!("original activation receipt digest differs from reattach proof");
    }
    require_string(&activation, "schema")?;
    for (field, expected) in [
        ("schema", ACTIVATION_OPERATION_SCHEMA),
        ("phase", "activation"),
        ("state", "outcome-unknown-resources-retained"),
        ("attempt", proof.activation_attempt.as_str()),
        ("compose_project", proof.compose_project.as_str()),
        ("control_volume", proof.control_volume.as_str()),
    ] {
        require_equal_string(&activation, field, expected)?;
    }
    let inputs_record = activation
        .get("inputs")
        .and_then(Value::as_object)
        .context("original activation receipt has no immutable inputs")?;
    let inputs_record = Value::Object(inputs_record.clone());
    for (field, expected) in [
        ("development_attempt", proof.development_attempt.as_str()),
        ("config_sha256", input.config_sha256.as_str()),
        ("source_root", proof.source_root.as_str()),
        ("image_id", proof.image_id.as_str()),
        ("backend_container", proof.backend_container.as_str()),
        ("source_sha256", input.source_sha256.as_str()),
        ("request_id", input.source_request_id.as_str()),
        ("provenance_sha256", input.startup_provenance_sha256.as_str()),
    ] {
        require_equal_string(&inputs_record, field, expected)?;
    }

    let (_, unresolved) = read_control_record(
        "activation/unresolved.json",
        "retained activation quarantine",
    )?;
    for (field, expected) in [
        ("schema", "fullmag.docker-activation-unresolved.v1"),
        ("state", "unknown-retained"),
        ("phase", "activation"),
        ("activation_outcome", "unknown-retained"),
        ("reason", "backend-namespace-stopped"),
        ("compose_project", proof.compose_project.as_str()),
        ("control_volume", proof.control_volume.as_str()),
        ("activation_attempt", proof.activation_attempt.as_str()),
        ("development_attempt", proof.development_attempt.as_str()),
        ("reconciliation_attempt", proof.reconciliation_attempt.as_str()),
        ("backend_container", proof.backend_container.as_str()),
        ("image_id", proof.image_id.as_str()),
        ("config_sha256", input.config_sha256.as_str()),
        ("source_root", proof.source_root.as_str()),
        ("source_sha256", input.source_sha256.as_str()),
        ("provenance_sha256", input.startup_provenance_sha256.as_str()),
        ("request_id", input.source_request_id.as_str()),
        ("activation_receipt_sha256", proof.activation_receipt_sha256.as_str()),
        ("native_stop_journal_sha256", proof.stop_verification_sha256.as_str()),
    ] {
        require_equal_string(&unresolved, field, expected)?;
    }
    validate_reconciled_helper(&unresolved, &activation, &proof.activation_attempt)?;

    let provenance_relative = format!(
        "activation/attempts/{}/startup-provenance.json",
        proof.activation_attempt
    );
    let (provenance_raw, provenance) = read_control_record(
        &provenance_relative,
        "original startup provenance",
    )?;
    if fullmag_session::hex_sha256(&provenance_raw) != input.startup_provenance_sha256 {
        bail!("original startup provenance digest differs from reattach pins");
    }
    validate_startup_provenance_record(
        &provenance,
        &proof.source_root,
        &input.source_sha256,
        &input.source_request_id,
    )?;
    let authorization_relative = format!(
        "activation/attempts/{}/authorization.json",
        proof.activation_attempt
    );
    let (_, authorization) = read_control_record(
        &authorization_relative,
        "original startup authorization",
    )?;
    if authorization != provenance {
        bail!("original startup authorization differs from its provenance");
    }

    let reconciliation_relative = format!(
        "activation-reconciliation/attempts/{}/terminal.json",
        proof.reconciliation_attempt
    );
    let (reconciliation_raw, reconciliation) = read_control_record(
        &reconciliation_relative,
        "terminal activation reconciliation receipt",
    )?;
    if fullmag_session::hex_sha256(&reconciliation_raw) != proof.stop_reconcile_proof_sha256 {
        bail!("terminal reconciliation receipt digest differs from reattach proof");
    }
    for (field, expected) in [
        ("schema", ACTIVATION_OPERATION_SCHEMA),
        ("phase", "activation-reconciliation"),
        ("state", "failed-confirmed"),
        ("attempt", proof.reconciliation_attempt.as_str()),
        ("compose_project", proof.compose_project.as_str()),
        ("control_volume", proof.control_volume.as_str()),
        ("reconciled_activation_attempt", proof.activation_attempt.as_str()),
        ("activation_receipt_sha256", proof.activation_receipt_sha256.as_str()),
        ("backend_container", proof.backend_container.as_str()),
        ("image_id", proof.image_id.as_str()),
        ("development_attempt", proof.development_attempt.as_str()),
        ("config_sha256", input.config_sha256.as_str()),
        ("source_root", proof.source_root.as_str()),
        ("native_stop_journal_sha256", proof.stop_verification_sha256.as_str()),
        ("activation_outcome", "unknown-retained"),
        ("reason", "backend-namespace-stopped"),
    ] {
        require_equal_string(&reconciliation, field, expected)?;
    }
    validate_reconciled_helper(&reconciliation, &activation, &proof.activation_attempt)?;

    let (reconciliation_current_raw, reconciliation_current) = read_control_record(
        "activation-reconciliation/current.json",
        "current activation reconciliation receipt",
    )?;
    require_same_raw_record(
        &reconciliation_current_raw,
        &reconciliation_raw,
        "current activation reconciliation",
    )?;
    if reconciliation_current != reconciliation {
        bail!("current activation reconciliation differs from its terminal record");
    }

    let verification_relative = format!(
        "verification/stop-failed-{}.json",
        proof.backend_container
    );
    let (verification_raw, verification) = read_control_record(
        &verification_relative,
        "stopped-backend verification journal",
    )?;
    if fullmag_session::hex_sha256(&verification_raw) != proof.stop_verification_sha256 {
        bail!("stopped-backend verification digest differs from reattach proof");
    }
    for (field, expected) in [
        ("schema", STOP_VERIFICATION_SCHEMA),
        ("state", "stopped-confirmed"),
        ("container_id", proof.backend_container.as_str()),
        ("image_id", proof.image_id.as_str()),
    ] {
        require_equal_string(&verification, field, expected)?;
    }
    let journal_has_container_state = verification.get("container_state").is_some();
    if journal_has_container_state {
        validate_container_state(&verification, proof)?;
    }
    let failure_kind = require_string(&verification, "failure_kind")?;
    let after_ready = match failure_kind {
        "native-start-failure" => false,
        "native-after-ready-failure" => true,
        _ => bail!("stopped-backend journal has an unsupported native failure kind"),
    };
    let api_start_failure = match verification.get("failure_mode") {
        None => false,
        Some(value) if value.is_null() => false,
        Some(value) if !after_ready && value.as_str() == Some(API_START_FAILURE_MODE) => true,
        Some(_) => bail!("stopped-backend journal has an unsupported failure mode"),
    };
    let failure_envelope = verification
        .get("failure_receipt")
        .and_then(Value::as_object)
        .context("stopped-backend journal has no failed process receipt")?;
    let failure_envelope = Value::Object(failure_envelope.clone());
    let process_receipt_sha256 = require_digest(&failure_envelope, "sha256", "failed process receipt")?;
    if failure_envelope
        .get("api_pid_exists")
        .and_then(Value::as_bool)
        != Some(false)
    {
        bail!("stopped-backend journal does not prove the failed API is absent");
    }
    let failure_receipt = failure_envelope
        .get("receipt")
        .context("stopped-backend journal has no wrapped process receipt")?;
    validate_native_process_receipt_mode(failure_receipt, after_ready, api_start_failure)?;
    let probe = verification
        .get("native_failure_probe")
        .and_then(Value::as_object)
        .context("stopped-backend journal has no native failure probe")?;
    let probe = Value::Object(probe.clone());
    let failed_owner = validate_native_failure_probe_mode(
        &probe,
        process_receipt_sha256,
        failure_receipt,
        after_ready,
        api_start_failure,
    )?;
    require_all_released(&probe, "reservation_states")?;
    require_all_released(&probe, "lease_states")?;
    let (terminal_process_raw, terminal_process) = read_proof_record(
        proof_root,
        &proof.terminal_process_record_path,
        "immutable terminal process receipt",
    )?;
    if fullmag_session::hex_sha256(&terminal_process_raw)
        != proof.terminal_process_record_sha256
    {
        bail!("immutable terminal process receipt digest differs from reattach proof");
    }
    require_equal_string(&terminal_process, "schema", "fullmag.docker-process-tree.v1")?;
    require_equal_string(&terminal_process, "state", "shutdown_unknown")?;
    if verification.get("terminal_process_receipt") != Some(&terminal_process) {
        bail!("stopped-backend terminal process receipt differs from immutable archive");
    }
    validate_terminal_process_receipt(&terminal_process, after_ready, &failed_owner)?;
    if after_ready {
        let retained_ready_owner = verification
            .get("retained_ready_owner")
            .context("after-ready journal has no retained ready owner")?;
        let process_ready_owner = failure_receipt
            .get("service_owner")
            .context("after-ready process receipt has no retained ready owner")?;
        if retained_ready_owner != process_ready_owner {
            bail!("after-ready journal retained ready owner differs from its process receipt");
        }
        if terminal_process.get("service_owner") != Some(retained_ready_owner) {
            bail!("after-ready terminal service owner differs from its retained ready pin");
        }
        if verification.get("terminal_retained_ready_owner") != Some(retained_ready_owner) {
            bail!("after-ready terminal retained ready owner differs from its journal pin");
        }
        require_digest(
            &verification,
            "retained_ready_owner_sha256",
            "retained ready owner",
        )?;
    }

    let (terminal_owner_raw, terminal_failed_owner) = read_proof_record(
        proof_root,
        &proof.terminal_owner_record_path,
        "immutable terminal failed owner",
    )?;
    if fullmag_session::hex_sha256(&terminal_owner_raw)
        != proof.terminal_owner_record_sha256
    {
        bail!("immutable terminal failed owner digest differs from reattach proof");
    }
    if verification.get("terminal_failed_owner") != Some(&terminal_failed_owner) {
        bail!("stopped-backend terminal failed owner differs from immutable archive");
    }
    if probe.get("failed_owner") != Some(&terminal_failed_owner) {
        bail!("stopped-backend terminal failed owner differs from its probe");
    }
    let terminal_failed_owner_sha256 = require_digest(
        &verification,
        "terminal_failed_owner_sha256",
        "terminal failed owner",
    )?;
    let failed_owner_sha256 = require_digest(&probe, "failed_owner_sha256", "failed owner")?;
    if terminal_failed_owner_sha256 != failed_owner_sha256
        || terminal_failed_owner_sha256 != proof.terminal_owner_record_sha256
    {
        bail!("stopped-backend failed owner digest changed during terminalization");
    }
    match (
        proof.namespace_attestation_path.as_deref(),
        proof.namespace_attestation_sha256.as_deref(),
    ) {
        (Some(path), Some(expected_sha256)) => {
            let (attestation_raw, attestation) =
                read_control_record(path, "stopped namespace attestation")?;
            if fullmag_session::hex_sha256(&attestation_raw) != expected_sha256 {
                bail!("stopped namespace attestation digest differs from reattach proof");
            }
            validate_namespace_attestation(
                &attestation,
                proof,
                &verification,
                &terminal_process,
                &terminal_failed_owner,
                &probe,
                &failed_owner,
                after_ready,
            )?;
        }
        (None, None) if journal_has_container_state => {}
        (None, None) => {
            bail!("legacy stopped-backend journal requires a namespace attestation");
        }
        _ => bail!("namespace attestation path and digest must be supplied together"),
    }
    Ok(())
}

fn validate_container_state(
    journal: &Value,
    proof: &AcceptedRestoreProof,
) -> Result<()> {
    let container_state = journal
        .get("container_state")
        .and_then(Value::as_object)
        .context("stopped-backend journal has an invalid container incarnation")?;
    let container_state = Value::Object(container_state.clone());
    require_equal_string(&container_state, "id", &proof.backend_container)?;
    require_equal_string(&container_state, "image", &proof.image_id)?;
    require_string(&container_state, "started_at")?;
    require_string(&container_state, "finished_at")?;
    require_json_integer(
        journal,
        "exit_code",
        "stopped-backend journal container incarnation",
    )?;
    require_json_integer(
        &container_state,
        "exit_code",
        "stopped-backend journal container incarnation",
    )?;
    if container_state.get("exit_code") != journal.get("exit_code") {
        bail!("stopped-backend journal exit code differs from its incarnation");
    }
    Ok(())
}

fn validate_namespace_attestation(
    attestation: &Value,
    proof: &AcceptedRestoreProof,
    verification: &Value,
    terminal_process: &Value,
    terminal_failed_owner: &Value,
    probe: &Value,
    failed_owner: &Value,
    after_ready: bool,
) -> Result<()> {
    let api_start_failure = match verification.get("failure_mode") {
        None => false,
        Some(value) if value.is_null() => false,
        Some(value) if !after_ready && value.as_str() == Some(API_START_FAILURE_MODE) => true,
        Some(_) => bail!("stopped-backend journal has an unsupported failure mode"),
    };
    validate_namespace_attestation_mode(
        attestation, proof, verification, terminal_process, terminal_failed_owner,
        probe, failed_owner, after_ready, api_start_failure,
    )
}

fn validate_namespace_attestation_mode(
    attestation: &Value,
    proof: &AcceptedRestoreProof,
    verification: &Value,
    terminal_process: &Value,
    terminal_failed_owner: &Value,
    probe: &Value,
    failed_owner: &Value,
    after_ready: bool,
    api_start_failure: bool,
) -> Result<()> {
    let expected_stop_path = format!(
        "verification/stop-failed-{}.json",
        proof.backend_container
    );
    for (field, expected) in [
        ("schema", NAMESPACE_ATTESTATION_SCHEMA),
        ("state", "stopped-confirmed"),
        ("compose_project", proof.compose_project.as_str()),
        ("control_volume", proof.control_volume.as_str()),
        ("backend_container", proof.backend_container.as_str()),
        ("image_id", proof.image_id.as_str()),
        ("source_root", proof.source_root.as_str()),
        ("stop_journal_path", expected_stop_path.as_str()),
        (
            "terminal_process_receipt_path",
            proof.terminal_process_record_path.as_str(),
        ),
        (
            "terminal_failed_owner_path",
            proof.terminal_owner_record_path.as_str(),
        ),
    ] {
        require_equal_string(attestation, field, expected)?;
    }
    let failure_kind = require_string(verification, "failure_kind")?;
    require_equal_string(attestation, "failure_kind", failure_kind)?;
    if attestation.get("failure_mode") != verification.get("failure_mode") {
        bail!("stopped namespace attestation failure mode differs from journal");
    }
    if api_start_failure && failure_kind != "native-start-failure" {
        bail!("API-start failure mode is attached to an after-ready journal");
    }

    let container_state = attestation
        .get("container_state")
        .and_then(Value::as_object)
        .context("stopped namespace attestation has no container incarnation")?;
    let container_state = Value::Object(container_state.clone());
    require_equal_string(&container_state, "id", &proof.backend_container)?;
    require_equal_string(&container_state, "image", &proof.image_id)?;
    require_string(&container_state, "started_at")?;
    require_string(&container_state, "finished_at")?;
    require_json_integer(
        &container_state,
        "exit_code",
        "stopped namespace attestation container incarnation",
    )?;
    if let Some(journal_state) = verification.get("container_state") {
        let journal_state = journal_state
            .as_object()
            .context("stopped-backend journal has an invalid container incarnation")?;
        if &Value::Object(journal_state.clone()) != &container_state {
            bail!("stopped namespace attestation differs from journal incarnation");
        }
    }
    require_json_integer(
        verification,
        "exit_code",
        "stopped-backend journal container incarnation",
    )?;
    if container_state.get("exit_code") != verification.get("exit_code") {
        bail!("stopped namespace attestation exit code differs from journal");
    }
    if verification.get("terminal_process_receipt") != Some(terminal_process)
        || verification.get("terminal_failed_owner") != Some(terminal_failed_owner)
        || verification.get("native_failure_probe") != Some(probe)
    {
        bail!("stopped-backend journal snapshots are internally inconsistent");
    }

    require_equal_string(
        attestation,
        "stop_journal_sha256",
        &proof.stop_verification_sha256,
    )?;
    let terminal_process_sha256 = require_digest(
        attestation,
        "terminal_process_receipt_sha256",
        "stopped namespace terminal process receipt",
    )?;
    if terminal_process_sha256 != proof.terminal_process_record_sha256 {
        bail!("stopped namespace terminal process receipt digest differs from immutable archive");
    }
    let terminal_owner_sha256 = require_digest(
        attestation,
        "terminal_failed_owner_sha256",
        "stopped namespace terminal owner",
    )?;
    let journal_owner_sha256 = require_digest(
        verification,
        "terminal_failed_owner_sha256",
        "terminal failed owner",
    )?;
    if terminal_owner_sha256 != journal_owner_sha256 {
        bail!("stopped namespace terminal owner digest differs from the journal");
    }
    if terminal_owner_sha256 != proof.terminal_owner_record_sha256 {
        bail!("stopped namespace terminal owner digest differs from immutable archive");
    }
    let probe_sha256 = require_digest(
        attestation,
        "native_failure_probe_sha256",
        "stopped namespace native failure probe",
    )?;
    if probe_sha256 != canonical_record_sha256(probe) {
        bail!("stopped namespace native failure probe digest differs");
    }
    if attestation.get("terminal_process_receipt") != Some(terminal_process) {
        bail!("stopped namespace terminal process receipt differs from the journal");
    }
    if attestation.get("terminal_failed_owner") != Some(terminal_failed_owner)
        || attestation.get("terminal_failed_owner") != Some(failed_owner)
    {
        bail!("stopped namespace terminal owner differs from the journal");
    }
    if attestation.get("native_failure_probe") != Some(probe)
        || probe.get("failed_owner") != Some(failed_owner)
    {
        bail!("stopped namespace native failure proof differs from the journal");
    }
    if after_ready {
        if attestation.get("retained_ready_owner")
            != verification.get("retained_ready_owner")
        {
            bail!("stopped namespace retained ready owner differs from the journal");
        }
    } else if attestation.get("retained_ready_owner").is_some() {
        bail!("start-failure namespace attestation contains a ready owner");
    }
    if !attestation
        .get("created_at")
        .is_some_and(Value::is_number)
    {
        bail!("stopped namespace attestation has no creation timestamp");
    }
    Ok(())
}

fn canonical_record_sha256(value: &Value) -> String {
    let mut bytes = fullmag_session::canonical_json_bytes(value);
    bytes.push(b'\n');
    fullmag_session::hex_sha256(&bytes)
}

fn validate_reconciled_helper(
    record: &Value,
    activation: &Value,
    activation_attempt: &str,
) -> Result<()> {
    let helper_name = format!("fullmag-control-{activation_attempt}");
    require_equal_string(record, "helper_container", &helper_name)?;
    if !matches!(record.get("helper_id"), Some(value) if value.is_null()) {
        bail!("reconciled activation helper must have a null helper_id");
    }
    require_equal_string(record, "helper_state", "absent-confirmed")?;
    let activation_helper_sha = require_digest(
        activation,
        "helper_sha256",
        "original activation helper",
    )?;
    let helper_sha = require_digest(record, "helper_sha256", "reconciled activation helper")?;
    if helper_sha != activation_helper_sha {
        bail!("reconciled activation helper digest differs from original receipt");
    }
    let absence_sha = require_digest(
        record,
        "helper_absence_probe_sha256",
        "activation helper absence probe",
    )?;
    let absence_probe = json!({
        "schema": "fullmag.docker-helper-absence-probe.v1",
        "state": "absent",
        "helper_name": helper_name,
        "containers": [],
    });
    if fullmag_session::hex_sha256(&fullmag_session::canonical_json_bytes(&absence_probe))
        != absence_sha
    {
        bail!("activation helper absence probe digest is not the canonical empty probe");
    }
    Ok(())
}

fn validate_docker_binding_values(
    proof: &AcceptedRestoreProof,
    compose_project: &str,
    source_root: &str,
    control_volume: &str,
) -> Result<()> {
    for (name, value, expected) in [
        (CURRENT_COMPOSE_PROJECT_ENV, compose_project, proof.compose_project.as_str()),
        (CURRENT_SOURCE_ROOT_ENV, source_root, proof.source_root.as_str()),
        (CURRENT_CONTROL_VOLUME_ENV, control_volume, proof.control_volume.as_str()),
    ] {
        if value != expected {
            bail!("current Docker environment {name} differs from the reattach proof");
        }
    }
    Ok(())
}

fn validate_current_docker_binding(proof: &AcceptedRestoreProof) -> Result<()> {
    let compose_project = std::env::var(CURRENT_COMPOSE_PROJECT_ENV).with_context(|| {
        format!("accepted-run reattach requires current Docker environment {CURRENT_COMPOSE_PROJECT_ENV}")
    })?;
    let source_root = std::env::var(CURRENT_SOURCE_ROOT_ENV).with_context(|| {
        format!("accepted-run reattach requires current Docker environment {CURRENT_SOURCE_ROOT_ENV}")
    })?;
    let control_volume = std::env::var(CURRENT_CONTROL_VOLUME_ENV).with_context(|| {
        format!("accepted-run reattach requires current Docker environment {CURRENT_CONTROL_VOLUME_ENV}")
    })?;
    validate_docker_binding_values(proof, &compose_project, &source_root, &control_volume)
}

fn validate_startup_provenance_record(
    provenance: &Value,
    source_root: &str,
    source_sha256: &str,
    request_id: &str,
) -> Result<()> {
    for (field, expected) in [
        ("schema", "fullmag.docker-startup-script.v1"),
        ("authorization", "explicit_startup_script"),
        ("source_root", source_root),
        ("source_sha256", source_sha256),
        ("request_id", request_id),
    ] {
        require_equal_string(provenance, field, expected)?;
    }
    let source_relative = require_string(provenance, "source_relative")?;
    if source_relative.len() > 1024 {
        bail!("startup provenance source_relative exceeds its bound");
    }
    fullmag_session::repository_path::validate_relative_path(source_relative)
        .context("startup provenance source_relative is unsafe")?;
    Ok(())
}

fn validate_native_process_receipt(receipt: &Value, after_ready: bool) -> Result<()> {
    validate_native_process_receipt_mode(receipt, after_ready, false)
}

fn validate_native_process_receipt_mode(
    receipt: &Value,
    after_ready: bool,
    api_start_failure: bool,
) -> Result<()> {
    require_equal_string(receipt, "schema", "fullmag.docker-process-tree.v1")?;
    require_equal_string(receipt, "state", "failed_outcome_retained")?;
    require_json_integer(receipt, "api_exit_code", "failed process receipt")?;
    let error = require_string(receipt, "error")?;
    if api_start_failure && !error.starts_with(API_START_FAILURE_ERROR_PREFIX) {
        bail!("API-start failure receipt has no API binding error prefix");
    }
    if receipt.get("runtime_pid").is_some_and(|value| !value.is_null()) {
        bail!("failed process receipt retains a runtime pid");
    }
    if receipt
        .get("api_pid")
        .and_then(Value::as_u64)
        .is_none_or(|pid| pid == 0)
    {
        bail!("failed process receipt has no positive API pid");
    }
    if receipt.get("terminal_service_owner").is_some() {
        bail!("failed process receipt already contains a terminal owner");
    }
    if after_ready {
        let owner = receipt
            .get("service_owner")
            .context("after-ready process receipt has no retained ready owner")?;
        validate_native_owner(owner, "retained ready owner", RuntimeServiceState::Ready, &[
            "running",
        ])?;
    } else if receipt.get("service_owner").is_some() {
        bail!("native start-failure receipt contains a service owner");
    }
    Ok(())
}

fn validate_native_failure_probe(
    probe: &Value,
    process_receipt_sha256: &str,
    process_receipt: &Value,
    after_ready: bool,
) -> Result<Value> {
    validate_native_failure_probe_mode(
        probe, process_receipt_sha256, process_receipt, after_ready, false,
    )
}

fn validate_native_failure_probe_mode(
    probe: &Value,
    process_receipt_sha256: &str,
    process_receipt: &Value,
    after_ready: bool,
    api_start_failure: bool,
) -> Result<Value> {
    let expected_schema = if after_ready {
        "fullmag.docker-native-after-ready-failure-stop-probe.v1"
    } else {
        "fullmag.docker-native-start-failure-stop-probe.v1"
    };
    require_equal_string(probe, "schema", expected_schema)?;
    require_equal_string(probe, "process_receipt_sha256", process_receipt_sha256)?;
    if api_start_failure {
        require_equal_string(probe, "failure_mode", API_START_FAILURE_MODE)?;
    } else if probe.get("failure_mode").is_some_and(|value| !value.is_null()) {
        bail!("native failure probe has an unexpected failure mode");
    }
    if probe.get("process_receipt") != Some(process_receipt) {
        bail!("native failure probe process receipt differs from its journal");
    }
    for field in [
        "api_pid_exists",
        "owner_pid_exists",
        "child_pids_exist",
        "native_processes_live",
    ] {
        if probe.get(field).and_then(Value::as_bool) != Some(false) {
            bail!("native failure probe does not prove {field}=false");
        }
    }
    if probe.get("startup_enabled").and_then(Value::as_str) == Some("1") {
        bail!("native failure probe leaves startup activation enabled");
    }
    if probe
        .get("legacy_activation_marker_exists")
        .and_then(Value::as_bool)
        != Some(false)
    {
        bail!("native failure probe retains the legacy activation marker");
    }
    if probe.get("active_lease_count").and_then(Value::as_u64) != Some(0) {
        bail!("native failure probe retains an active durable lease");
    }
    let failed_owner = probe
        .get("failed_owner")
        .context("native failure probe has no failed owner")?;
    let failed_owner = validate_native_owner(
        failed_owner,
        "failed owner",
        RuntimeServiceState::Failed,
        if after_ready || api_start_failure {
            &["exited_success", "exited_failure"]
        } else {
            &["exited_success"]
        },
    )?;
    require_digest(probe, "failed_owner_sha256", "failed owner")?;
    if after_ready {
        let ready_owner = process_receipt
            .get("service_owner")
            .context("after-ready process receipt has no retained ready owner")?;
        let ready_owner = validate_native_owner(
            ready_owner,
            "retained ready owner",
            RuntimeServiceState::Ready,
            &["running"],
        )?;
        if owner_identity_key(&ready_owner) != owner_identity_key(&failed_owner) {
            bail!("after-ready failed owner differs from retained ready owner");
        }
    }
    Ok(failed_owner)
}

fn validate_terminal_process_receipt(
    receipt: &Value,
    after_ready: bool,
    failed_owner: &Value,
) -> Result<()> {
    if receipt.get("runtime_pid").is_some_and(|value| !value.is_null())
        || receipt.get("terminal_service_owner").is_some()
        || receipt.get("startup_activation").is_some()
    {
        bail!("terminal process receipt retains an owner or startup activation");
    }
    require_json_integer(receipt, "api_exit_code", "terminal process receipt")?;
    if after_ready {
        let terminal_ready_owner = receipt
            .get("service_owner")
            .context("after-ready terminal receipt has no retained ready owner")?;
        let terminal_ready_owner = validate_native_owner(
            terminal_ready_owner,
            "terminal retained ready owner",
            RuntimeServiceState::Ready,
            &["running"],
        )?;
        let failed_owner = validate_native_owner(
            failed_owner,
            "failed owner",
            RuntimeServiceState::Failed,
            &["exited_success", "exited_failure"],
        )?;
        if owner_identity_key(&terminal_ready_owner) != owner_identity_key(&failed_owner) {
            bail!("after-ready terminal owner differs from the failed owner identity");
        }
    } else if receipt.get("service_owner").is_some() {
        bail!("native start-failure terminal receipt retains a service owner");
    }
    Ok(())
}

fn validate_native_owner(
    value: &Value,
    label: &str,
    expected_state: RuntimeServiceState,
    allowed_child_statuses: &[&str],
) -> Result<Value> {
    let owner: RuntimeServiceOwnerDescriptor = serde_json::from_value(value.clone())
        .with_context(|| format!("{label} is not a runtime service owner descriptor"))?;
    validate_runtime_owner_descriptor(&owner)
        .with_context(|| format!("{label} failed canonical runtime owner validation"))?;
    if owner.state != expected_state || owner.target_id != "docker-all" {
        bail!("{label} state or target differs from the native failure contract");
    }
    if owner.control_address.is_none()
        || owner.build_commit.is_none()
        || owner.build_snapshot.is_none()
        || owner.compute_pool_generation.is_none()
        || owner.preparation_pool_generation.is_none()
        || owner.compute_pool_id.is_none()
        || owner.preparation_pool_id.is_none()
    {
        bail!("{label} lacks complete scheduler/build identity");
    }
    let build_commit = owner
        .build_commit
        .as_deref()
        .context(format!("{label} has no build commit"))?;
    validate_commit(build_commit, &format!("{label} build commit"))?;
    let build_snapshot = owner
        .build_snapshot
        .as_deref()
        .context(format!("{label} has no build snapshot"))?;
    validate_digest(build_snapshot, &format!("{label} build snapshot"))?;
    if owner.compute_pool_id.as_deref() == owner.preparation_pool_id.as_deref() {
        bail!("{label} reuses one scheduler pool");
    }
    if owner.children.len() != 2 {
        bail!("{label} must contain exactly two native children");
    }
    let mut roles = std::collections::BTreeSet::new();
    let mut pids = std::collections::BTreeSet::new();
    pids.insert(owner.pid);
    for child in &owner.children {
        if child.role != "compute" && child.role != "preparation" {
            bail!("{label} has an unexpected child role");
        }
        if !roles.insert(child.role.as_str()) {
            bail!("{label} repeats a child role");
        }
        if !pids.insert(child.pid) {
            bail!("{label} repeats the owner or another child pid");
        }
        if !allowed_child_statuses.contains(&child.status.as_str()) {
            bail!("{label} has an invalid child status");
        }
    }
    if roles.len() != 2 {
        bail!("{label} is missing a compute or preparation child");
    }
    Ok(value.clone())
}

#[derive(Debug, PartialEq, Eq)]
struct NativeOwnerIdentity {
    owner_token: String,
    process_start_token: String,
    pid: u32,
    host: String,
    target_id: String,
    control_address: Option<String>,
    build_commit: Option<String>,
    build_snapshot: Option<String>,
    compute_pool_id: Option<String>,
    preparation_pool_id: Option<String>,
    compute_pool_generation: Option<u64>,
    preparation_pool_generation: Option<u64>,
    children: Vec<(String, u32)>,
}

fn owner_identity_key(owner: &Value) -> NativeOwnerIdentity {
    let descriptor: RuntimeServiceOwnerDescriptor = serde_json::from_value(owner.clone())
        .expect("owner identity is validated before comparison");
    let mut children = descriptor
        .children
        .into_iter()
        .map(|child| (child.role, child.pid))
        .collect::<Vec<_>>();
    children.sort();
    NativeOwnerIdentity {
        owner_token: descriptor.owner_token,
        process_start_token: descriptor.process_start_token,
        pid: descriptor.pid,
        host: descriptor.host,
        target_id: descriptor.target_id,
        control_address: descriptor.control_address,
        build_commit: descriptor.build_commit,
        build_snapshot: descriptor.build_snapshot,
        compute_pool_id: descriptor.compute_pool_id,
        preparation_pool_id: descriptor.preparation_pool_id,
        compute_pool_generation: descriptor.compute_pool_generation,
        preparation_pool_generation: descriptor.preparation_pool_generation,
        children,
    }
}

fn require_json_integer(value: &Value, field: &str, label: &str) -> Result<()> {
    if value.get(field).is_none_or(|item| {
        item.as_i64().is_none() && item.as_u64().is_none()
    }) {
        bail!("{label} has no integer {field}");
    }
    Ok(())
}

fn require_digest<'a>(value: &'a Value, field: &str, label: &str) -> Result<&'a str> {
    let digest = require_string(value, field)?;
    validate_digest(digest, &format!("{label} {field}"))?;
    Ok(digest)
}

fn read_control_record(relative: &str, label: &str) -> Result<(Vec<u8>, Value)> {
    fullmag_session::repository_path::validate_relative_path(relative)
        .with_context(|| format!("{label} path is unsafe"))?;
    let raw = fullmag_session::repository_path::read_bounded_regular_file(
        Path::new(RUNTIME_PROVENANCE_ROOT),
        relative,
        MAX_CONTROL_RECORD_BYTES,
    )
    .with_context(|| format!("read {label}"))?;
    let value: Value = serde_json::from_slice(&raw).with_context(|| format!("decode {label}"))?;
    if !value.is_object() {
        bail!("{label} is not a JSON object");
    }
    Ok((raw, value))
}

fn read_proof_record(
    proof_root: &Path,
    relative: &str,
    label: &str,
) -> Result<(Vec<u8>, Value)> {
    fullmag_session::repository_path::validate_relative_path(relative)
        .with_context(|| format!("{label} path is unsafe"))?;
    let raw = fullmag_session::repository_path::read_bounded_regular_file(
        proof_root,
        relative,
        MAX_CONTROL_RECORD_BYTES,
    )
    .with_context(|| format!("read {label}"))?;
    let value: Value = serde_json::from_slice(&raw).with_context(|| format!("decode {label}"))?;
    if !value.is_object() {
        bail!("{label} is not a JSON object");
    }
    Ok((raw, value))
}

fn require_string<'a>(value: &'a Value, field: &str) -> Result<&'a str> {
    value
        .get(field)
        .and_then(Value::as_str)
        .filter(|value| !value.is_empty())
        .with_context(|| format!("record has no {field}"))
}

fn require_equal_string(value: &Value, field: &str, expected: &str) -> Result<()> {
    if require_string(value, field)? != expected {
        bail!("record {field} differs from the reattach proof");
    }
    Ok(())
}

fn require_same_raw_record(actual: &[u8], expected: &[u8], label: &str) -> Result<()> {
    if actual != expected {
        bail!("{label} differs from its terminal record bytes");
    }
    Ok(())
}

fn require_all_released(value: &Value, field: &str) -> Result<()> {
    let states = value
        .get(field)
        .and_then(Value::as_array)
        .with_context(|| format!("native failure probe has no {field}"))?;
    if states.iter().any(|state| state.as_str() != Some("released")) {
        bail!("native failure probe {field} is not fully released");
    }
    Ok(())
}

fn validate_proof(proof: &AcceptedRestoreProof, input: &AcceptedRestoreInput) -> Result<()> {
    if proof.schema != PROOF_SCHEMA
        || proof.run_id != input.run_id
        || proof.project_id != input.project_id
        || proof.source_request_id != input.source_request_id
        || proof.source_sha256 != input.source_sha256
        || proof.startup_provenance_sha256 != input.startup_provenance_sha256
        || proof.config_sha256 != input.config_sha256
    {
        bail!("accepted-run reattach proof does not match explicit input pins");
    }
    validate_non_empty(&proof.logical_session_id, "logical_session_id")?;
    if proof.session_epoch == 0 {
        bail!("session_epoch must be positive");
    }
    validate_attempt(&proof.activation_attempt, "activation_attempt")?;
    validate_attempt(&proof.reconciliation_attempt, "reconciliation_attempt")?;
    validate_container_id(&proof.backend_container, "backend_container")?;
    validate_immutable_record_path(
        &proof.terminal_owner_record_path,
        "terminal-owner.json",
        "terminal_owner_record_path",
    )?;
    validate_immutable_record_path(
        &proof.terminal_process_record_path,
        "terminal-process.json",
        "terminal_process_record_path",
    )?;
    if Path::new(&proof.terminal_owner_record_path).parent()
        != Path::new(&proof.terminal_process_record_path).parent()
    {
        bail!("terminal owner and process records must share one proof directory");
    }
    if Path::new(&proof.terminal_owner_record_path).parent()
        != Path::new(&input.proof_path).parent()
    {
        bail!("terminal records must share the accepted reattach proof directory");
    }
    match (
        proof.namespace_attestation_path.as_deref(),
        proof.namespace_attestation_sha256.as_deref(),
    ) {
        (Some(path), Some(_)) => {
            fullmag_session::repository_path::validate_relative_path(path)
                .context("namespace_attestation_path is unsafe")?;
            let expected_namespace_path = format!(
                "verification/stopped-namespace-attestation-{}.json",
                proof.backend_container
            );
            if path != expected_namespace_path {
                bail!("namespace_attestation_path differs from the backend identity");
            }
        }
        (None, None) => {}
        _ => bail!("namespace attestation path and digest must be supplied together"),
    }
    validate_image_id(&proof.image_id, "image_id")?;
    validate_bounded_text(&proof.source_root, "source_root")?;
    validate_bounded_text(&proof.compose_project, "compose_project")?;
    validate_bounded_text(&proof.control_volume, "control_volume")?;
    validate_attempt(&proof.development_attempt, "development_attempt")?;
    for (value, field) in [
        (
            &proof.activation_receipt_sha256,
            "activation_receipt_sha256",
        ),
        (
            &proof.stop_reconcile_proof_sha256,
            "stop_reconcile_proof_sha256",
        ),
        (&proof.stop_verification_sha256, "stop_verification_sha256"),
        (
            &proof.terminal_owner_record_sha256,
            "terminal_owner_record_sha256",
        ),
        (
            &proof.terminal_process_record_sha256,
            "terminal_process_record_sha256",
        ),
    ] {
        validate_digest(value, field)?;
    }
    if let Some(value) = proof.namespace_attestation_sha256.as_deref() {
        validate_digest(value, "namespace_attestation_sha256")?;
    }
    Ok(())
}

fn validate_immutable_record_path(path: &str, filename: &str, field: &str) -> Result<()> {
    fullmag_session::repository_path::validate_relative_path(path)
        .with_context(|| format!("{field} is unsafe"))?;
    if Path::new(path).file_name().and_then(|name| name.to_str()) != Some(filename) {
        bail!("{field} must name {filename}");
    }
    if path == "runtime-control/runtime-service/process-tree.json"
        || path == "runtime-control/runtime-services/OWNER.json"
    {
        bail!("{field} must reference the immutable stopped-record archive");
    }
    Ok(())
}

fn validate_input_digests(input: &AcceptedRestoreInput) -> Result<()> {
    if input.schema != INPUT_SCHEMA {
        bail!("invalid private accepted-run reattach input schema");
    }
    let has_restart_fields = input.request_sha256.is_some()
        || input.restore_mode.is_some()
        || input.previous_ack_path.is_some()
        || input.previous_ack_sha256.is_some()
        || input.previous_drain_path.is_some()
        || input.previous_drain_sha256.is_some();
    if has_restart_fields {
        let request_sha256 = input
            .request_sha256
            .as_deref()
            .context("accepted-run successor input has no request digest")?;
        validate_digest(request_sha256, "request_sha256")?;
        let mode = input
            .restore_mode
            .as_deref()
            .context("accepted-run reattach input has no restore mode")?;
        validate_restore_mode(mode)?;
        match (
            input.previous_ack_path.as_deref(),
            input.previous_ack_sha256.as_deref(),
            input.previous_drain_path.as_deref(),
            input.previous_drain_sha256.as_deref(),
        ) {
            (None, None, None, None) if mode == RESTORE_MODE_HELD => {}
            (Some(path), Some(digest), Some(drain_path), Some(drain_digest))
                if mode == RESTORE_MODE_SUCCESSOR_AUTO =>
            {
                validate_non_empty(path, "previous_ack_path")?;
                validate_digest(digest, "previous_ack_sha256")?;
                validate_non_empty(drain_path, "previous_drain_path")?;
                validate_digest(drain_digest, "previous_drain_sha256")?;
            }
            _ => bail!("accepted-run reattach successor fields are incomplete"),
        }
    }
    for (value, field) in [
        (&input.target_build_id, "target_build_id"),
        (&input.run_id, "run_id"),
        (&input.project_id, "project_id"),
        (&input.source_request_id, "source_request_id"),
        (&input.proof_path, "proof_path"),
    ] {
        validate_non_empty(value, field)?;
    }
    for (value, field) in [
        (&input.target_source_sha256, "target_source_sha256"),
        (&input.source_sha256, "source_sha256"),
        (&input.startup_provenance_sha256, "startup_provenance_sha256"),
        (&input.config_sha256, "config_sha256"),
        (&input.proof_sha256, "proof_sha256"),
    ] {
        validate_digest(value, field)?;
    }
    Ok(())
}

fn validate_commit(value: &str, field: &str) -> Result<()> {
    if value.len() != 40
        || !value
            .bytes()
            .all(|byte| byte.is_ascii_digit() || (b'a'..=b'f').contains(&byte))
    {
        bail!("{field} must be a lowercase Git commit digest");
    }
    Ok(())
}

fn validate_non_empty(value: &str, field: &str) -> Result<()> {
    if value.trim().is_empty() {
        bail!("{field} must not be empty");
    }
    Ok(())
}

fn validate_digest(value: &str, field: &str) -> Result<()> {
    if value.len() != 64
        || !value
            .bytes()
            .all(|byte| byte.is_ascii_digit() || (b'a'..=b'f').contains(&byte))
    {
        bail!("{field} must be a lowercase SHA-256 digest");
    }
    Ok(())
}

fn validate_attempt(value: &str, field: &str) -> Result<()> {
    if value.len() != 32
        || !value
            .bytes()
            .all(|byte| byte.is_ascii_digit() || (b'a'..=b'f').contains(&byte))
    {
        bail!("{field} must be a lowercase operation token");
    }
    Ok(())
}

fn validate_container_id(value: &str, field: &str) -> Result<()> {
    if value.len() != 64
        || !value
            .bytes()
            .all(|byte| byte.is_ascii_digit() || (b'a'..=b'f').contains(&byte))
    {
        bail!("{field} must be a lowercase container identity");
    }
    Ok(())
}

fn validate_image_id(value: &str, field: &str) -> Result<()> {
    if value.len() != 71
        || !value.starts_with("sha256:")
        || !value[7..]
            .bytes()
            .all(|byte| byte.is_ascii_digit() || (b'a'..=b'f').contains(&byte))
    {
        bail!("{field} must be an immutable image identity");
    }
    if value[7..].bytes().all(|byte| byte == b'0') {
        bail!("{field} must not be an all-zero image identity");
    }
    Ok(())
}

fn validate_bounded_text(value: &str, field: &str) -> Result<()> {
    if value.is_empty() || value.len() > 4096 || value.contains('\0') {
        bail!("{field} must be bounded text");
    }
    Ok(())
}

fn build_snapshot(
    state: &AppState,
    loaded: &LoadedAcceptedRestore,
) -> Result<crate::types::SessionStateResponse> {
    let requested = &loaded.specification.requested_execution;
    let session_id = loaded.logical_session_id.clone();
    let run_id = loaded.run_id.as_str().to_string();
    let terminal_status = match loaded.terminal_outcome.as_deref() {
        Some("interrupted") => "failed",
        Some(outcome) => outcome,
        None => "awaiting_command",
    };
    let session_status = terminal_status.to_string();
    let run_status = if loaded.terminal_outcome.is_some() {
        terminal_status.to_string()
    } else {
        "waiting_for_compute".into()
    };
    let artifact_dir = state
        .current_workspace_root
        .join("runs")
        .join(&run_id)
        .display()
        .to_string();
    let now = crate::unix_time_millis_now();
    let session = SessionManifest {
        session_id: session_id.clone(),
        run_id: run_id.clone(),
        status: session_status.clone(),
        interactive_session_requested: true,
        script_path: String::new(),
        problem_name: loaded.scene.scene.name.clone(),
        requested_backend: requested.backend.clone(),
        explicit_selection: requested.backend != "auto"
            || requested.device != "auto"
            || requested.precision != "double"
            || requested.mode != "strict",
        authored_requested_device: requested.device.clone(),
        requested_device: requested.device.clone(),
        requested_precision: requested.precision.clone(),
        requested_mode: requested.mode.clone(),
        requested_cpu_threads: loaded.scene.study.requested_cpu_threads,
        execution_mode: requested.mode.clone(),
        precision: requested.precision.clone(),
        resolved_backend: None,
        resolved_device: None,
        resolved_precision: None,
        resolved_mode: None,
        resolved_runtime_family: None,
        resolved_engine_id: None,
        resolved_worker: None,
        resolved_cpu_threads: None,
        resolved_fallback: None,
        fem_crossover_decision: None,
        artifact_dir: artifact_dir.clone(),
        started_at_unix_ms: now,
        finished_at_unix_ms: 0,
        plan_summary: json!({
            "requested_execution": requested,
            "accepted_run": {
                "run_id": &run_id,
                "project_id": loaded.project_id.as_str(),
                "source_request_id": &loaded.source_request_id,
                "source_sha256": &loaded.source_sha256,
                "startup_provenance_sha256": &loaded.startup_provenance_sha256,
                "proof_sha256": &loaded.proof_sha256,
            },
        }),
    };
    let run = RunManifest {
        run_id: run_id.clone(),
        session_id: session_id.clone(),
        status: "waiting_for_compute".into(),
        total_steps: loaded.total_steps,
        final_time: None,
        final_e_ex: None,
        final_e_demag: None,
        final_e_ext: None,
        final_e_ani: None,
        final_e_dmi: None,
        final_e_rotated_dmi: None,
        final_e_total: None,
        artifact_dir,
    };
    let mut snapshot = crate::session::default_current_live_state(&CurrentLiveSnapshotRequest {
        session_id,
        session: Some(session),
        session_status: Some(session_status.clone()),
        metadata: Some(json!({
            "accepted_run_reattach": {
                "schema": INPUT_SCHEMA,
                "run_id": loaded.run_id.as_str(),
                "project_id": loaded.project_id.as_str(),
                "source_request_id": &loaded.source_request_id,
                "source_sha256": &loaded.source_sha256,
                "startup_provenance_sha256": &loaded.startup_provenance_sha256,
                "config_sha256": &loaded.config_sha256,
                "session_epoch": loaded.session_epoch,
                "proof_sha256": &loaded.proof_sha256,
                "terminal_outcome": &loaded.terminal_outcome,
            }
        })),
        mesh_workspace: None,
        stage_execution: None,
        simulation_preparation: None,
        run: Some(RunManifest {
            status: run_status,
            ..run
        }),
        live_state: None,
        frozen_spins_runtime_status: None,
        coupled_checkpoint: None,
        latest_scalar_row: None,
        latest_fields: None,
        replace_latest_fields: false,
        field_generation: None,
        preview_fields: None,
        clear_preview_cache: true,
        engine_log: None,
        solver_profile: None,
        fem_mesh: None,
    });
    snapshot.scene_document = Some(loaded.scene.clone());
    snapshot.runtime_status = crate::session::build_runtime_status_view(&session_status);
    snapshot.state_version = 1;
    Ok(snapshot)
}

#[cfg(test)]
mod tests {
    use super::*;

    fn input() -> AcceptedRestoreInput {
        AcceptedRestoreInput {
            schema: INPUT_SCHEMA.into(),
            target_build_id: "b".repeat(40),
            target_source_sha256: "a".repeat(64),
            run_id: "run-1".into(),
            project_id: "project-1".into(),
            source_request_id: "request-1".into(),
            source_sha256: "b".repeat(64),
            startup_provenance_sha256: "c".repeat(64),
            config_sha256: "d".repeat(64),
            proof_path: "accepted-run-reattach/proof/proof.json".into(),
            proof_sha256: "e".repeat(64),
            request_sha256: None,
            restore_mode: None,
            previous_ack_path: None,
            previous_ack_sha256: None,
            previous_drain_path: None,
            previous_drain_sha256: None,
        }
    }

    fn proof(input: &AcceptedRestoreInput) -> AcceptedRestoreProof {
        AcceptedRestoreProof {
            schema: PROOF_SCHEMA.into(),
            run_id: input.run_id.clone(),
            project_id: input.project_id.clone(),
            source_request_id: input.source_request_id.clone(),
            source_sha256: input.source_sha256.clone(),
            startup_provenance_sha256: input.startup_provenance_sha256.clone(),
            activation_receipt_sha256: "f".repeat(64),
            stop_reconcile_proof_sha256: "1".repeat(64),
            stop_verification_sha256: "2".repeat(64),
            terminal_owner_record_path: "accepted-run-reattach/proof/terminal-owner.json".into(),
            terminal_owner_record_sha256: "4".repeat(64),
            terminal_process_record_path: "accepted-run-reattach/proof/terminal-process.json".into(),
            terminal_process_record_sha256: "5".repeat(64),
            namespace_attestation_path: None,
            namespace_attestation_sha256: None,
            activation_attempt: "3".repeat(32),
            reconciliation_attempt: "4".repeat(32),
            backend_container: "5".repeat(64),
            image_id: format!("sha256:{}", "6".repeat(64)),
            source_root: "C:/git/fullmag".into(),
            compose_project: "fullmag-worktree-test".into(),
            control_volume: "fullmag-worktree-test-control".into(),
            development_attempt: "7".repeat(32),
            config_sha256: input.config_sha256.clone(),
            logical_session_id: "session-1".into(),
            session_epoch: 3,
        }
    }

    fn successor_input() -> AcceptedRestoreInput {
        let mut input = input();
        input.request_sha256 = Some("8".repeat(64));
        input.restore_mode = Some(RESTORE_MODE_SUCCESSOR_AUTO.into());
        input.previous_ack_path = Some(
            "accepted-run-reattach/proof/restore-ack-11111111-1111-4111-8111-111111111111.json"
                .into(),
        );
        input.previous_ack_sha256 = Some("9".repeat(64));
        input.previous_drain_path = Some(
            "accepted-run-reattach/proof/successor-drain-11111111-1111-4111-8111-111111111111.json"
                .into(),
        );
        input.previous_drain_sha256 = Some("a".repeat(64));
        input
    }

    fn ack(
        input: &AcceptedRestoreInput,
        proof: &AcceptedRestoreProof,
        api_instance_id: &str,
        previous_ack_sha256: Option<&str>,
        restore_mode: &str,
    ) -> AcceptedRestoreAck {
        AcceptedRestoreAck {
            schema: RESTORE_ACK_SCHEMA.into(),
            state: "consumed".into(),
            restore_mode: restore_mode.into(),
            request_sha256: input.request_sha256.clone().unwrap(),
            proof_sha256: input.proof_sha256.clone(),
            run_id: input.run_id.clone(),
            project_id: input.project_id.clone(),
            source_request_id: input.source_request_id.clone(),
            source_sha256: input.source_sha256.clone(),
            config_sha256: input.config_sha256.clone(),
            activation_attempt: proof.activation_attempt.clone(),
            reconciliation_attempt: proof.reconciliation_attempt.clone(),
            logical_session_id: proof.logical_session_id.clone(),
            session_epoch: proof.session_epoch,
            api_instance_id: api_instance_id.into(),
            previous_ack_sha256: previous_ack_sha256.map(str::to_owned),
        }
    }

    fn owner_fixture(state: &str, child_status: &str) -> Value {
        json!({
            "schema_version": "runtime_service_owner.v1",
            "owner_token": "11111111-1111-4111-8111-111111111111",
            "process_start_token": "22222222-2222-4222-8222-222222222222",
            "pid": 3241,
            "host": "fullmag-test-host",
            "target_id": "docker-all",
            "protocol": "stdin-v1",
            "state": state,
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
                {"role": "compute", "pid": 3250, "status": child_status},
                {"role": "preparation", "pid": 3251, "status": child_status},
            ],
        })
    }

    fn canonical_record_bytes(value: &Value) -> Vec<u8> {
        let mut bytes = fullmag_session::canonical_json_bytes(value);
        bytes.push(b'\n');
        bytes
    }

    #[test]
    fn legacy_input_stays_strict_and_initial_extension_is_explicit() {
        let mut input = input();
        assert!(validate_input_digests(&input).is_ok());
        input.request_sha256 = Some("8".repeat(64));
        input.restore_mode = Some(RESTORE_MODE_HELD.into());
        assert!(validate_input_digests(&input).is_ok());
        input.previous_ack_sha256 = Some("9".repeat(64));
        assert!(validate_input_digests(&input).is_err());
        input.restore_mode = Some(RESTORE_MODE_SUCCESSOR_AUTO.into());
        input.previous_ack_path = Some("previous-ack.json".into());
        assert!(validate_input_digests(&input).is_err());
        input.previous_drain_path = Some("previous-drain.json".into());
        assert!(validate_input_digests(&input).is_err());
        input.previous_drain_sha256 = Some("a".repeat(64));
        assert!(validate_input_digests(&input).is_ok());
        input.previous_ack_path = None;
        assert!(validate_input_digests(&input).is_err());
    }

    #[test]
    fn successor_ack_and_drain_names_bind_one_api_generation() {
        let mut input = successor_input();
        let proof = proof(&input);
        let old_id = "11111111-1111-4111-8111-111111111111";
        let new_id = "22222222-2222-4222-8222-222222222222";
        assert_eq!(
            validate_ack_record_path(
                input.previous_ack_path.as_deref().unwrap(),
                &input.proof_path,
                "previous_ack_path",
            )
            .unwrap(),
            old_id
        );
        assert!(validate_ack_record_path(
            "accepted-run-reattach/proof/restore-ack-other.json",
            &input.proof_path,
            "previous_ack_path",
        )
        .is_err());
        let old_ack = ack(&input, &proof, old_id, None, RESTORE_MODE_HELD);
        let old_ack_raw = canonical_record_bytes(&serde_json::to_value(&old_ack).unwrap());
        let old_ack_sha256 = fullmag_session::hex_sha256(&old_ack_raw);
        input.previous_ack_sha256 = Some(old_ack_sha256.clone());
        let temporary = tempfile::tempdir().unwrap();
        let proof_dir = temporary.path().join("accepted-run-reattach/proof");
        fs::create_dir_all(&proof_dir).unwrap();

        let terminal_owner = owner_fixture("drained", "exited_success");
        let ready_owner = owner_fixture("ready", "running");
        let process_record = json!({
            "schema": "fullmag.docker-process-tree.v1",
            "state": "drained",
            "api_pid": 3227,
            "api_exit_code": 0,
            "runtime_pid": null,
            "service_owner": ready_owner.clone(),
            "terminal_service_owner": terminal_owner.clone(),
            "accepted_reattach": {
                "schema": SUCCESSOR_RUNTIME_SCHEMA,
                "restore_mode": RESTORE_MODE_HELD,
                "request_sha256": input.request_sha256.clone().unwrap(),
                "proof_sha256": input.proof_sha256.clone(),
                "run_id": input.run_id.clone(),
                "project_id": input.project_id.clone(),
                "source_request_id": input.source_request_id.clone(),
                "source_sha256": input.source_sha256.clone(),
                "config_sha256": input.config_sha256.clone(),
                "ack_relative": input.previous_ack_path.clone().unwrap(),
                "ack_sha256": old_ack_sha256.clone(),
                "api_instance_id": old_id,
                "previous_ack_sha256": null,
            },
        });
        let process_raw = canonical_record_bytes(&process_record);
        fs::write(
            proof_dir.join(format!("successor-terminal-process-{old_id}.json")),
            &process_raw,
        )
        .unwrap();
        let terminal_raw = canonical_record_bytes(&terminal_owner);
        fs::write(
            proof_dir.join(format!("successor-terminal-owner-{old_id}.json")),
            &terminal_raw,
        )
        .unwrap();
        let ready_raw = canonical_record_bytes(&ready_owner);
        fs::write(
            proof_dir.join(format!("successor-ready-owner-{old_id}.json")),
            &ready_raw,
        )
        .unwrap();
        let mut drain = AcceptedRestoreSuccessorDrain {
            schema: SUCCESSOR_DRAIN_SCHEMA.into(),
            state: "drained".into(),
            request_sha256: input.request_sha256.clone().unwrap(),
            proof_sha256: input.proof_sha256.clone(),
            run_id: input.run_id.clone(),
            project_id: input.project_id.clone(),
            source_request_id: input.source_request_id.clone(),
            source_sha256: input.source_sha256.clone(),
            config_sha256: input.config_sha256.clone(),
            api_instance_id: old_id.into(),
            ack_relative: input.previous_ack_path.clone().unwrap(),
            ack_sha256: old_ack_sha256,
            ready_owner_token: ready_owner
                .get("owner_token")
                .and_then(Value::as_str)
                .unwrap()
                .into(),
            terminal_process_record_path: format!(
                "accepted-run-reattach/proof/successor-terminal-process-{old_id}.json"
            ),
            terminal_process_record_sha256: fullmag_session::hex_sha256(&process_raw),
            terminal_owner_record_path: format!(
                "accepted-run-reattach/proof/successor-terminal-owner-{old_id}.json"
            ),
            terminal_owner_record_sha256: fullmag_session::hex_sha256(&terminal_raw),
            ready_owner_record_path: format!(
                "accepted-run-reattach/proof/successor-ready-owner-{old_id}.json"
            ),
            ready_owner_record_sha256: fullmag_session::hex_sha256(&ready_raw),
        };
        let drain_raw = canonical_record_bytes(&serde_json::to_value(&drain).unwrap());
        input.previous_drain_sha256 = Some(fullmag_session::hex_sha256(&drain_raw));
        assert!(validate_restore_ack(
            &old_ack,
            &input,
            &proof,
            old_id,
        )
        .is_ok());
        let held_successor_ack = ack(
            &input,
            &proof,
            new_id,
            input.previous_ack_sha256.as_deref(),
            RESTORE_MODE_HELD,
        );
        assert!(validate_restore_ack(
            &held_successor_ack,
            &input,
            &proof,
            new_id,
        )
        .is_ok());
        assert!(validate_successor_drain(
            temporary.path(),
            &drain,
            &old_ack,
            &input,
            input.previous_ack_path.as_deref().unwrap(),
            input.previous_ack_sha256.as_deref().unwrap(),
        )
        .is_ok());
        let mut mismatched_digest = drain.clone();
        mismatched_digest.terminal_owner_record_sha256 = "f".repeat(64);
        assert!(validate_successor_drain(
            temporary.path(),
            &mismatched_digest,
            &old_ack,
            &input,
            input.previous_ack_path.as_deref().unwrap(),
            input.previous_ack_sha256.as_deref().unwrap(),
        )
        .is_err());
        drain.api_instance_id = new_id.into();
        assert!(validate_successor_drain(
            temporary.path(),
            &drain,
            &old_ack,
            &input,
            input.previous_ack_path.as_deref().unwrap(),
            input.previous_ack_sha256.as_deref().unwrap(),
        )
        .is_err());
    }

    #[test]
    fn restore_ack_has_exact_python_wire_fields() {
        let input = successor_input();
        let p = proof(&input);
        let value = serde_json::to_value(ack(
            &input,
            &p,
            "11111111-1111-4111-8111-111111111111",
            None,
            RESTORE_MODE_HELD,
        ))
        .unwrap();
        let fields = value.as_object().unwrap().keys().cloned().collect::<std::collections::BTreeSet<_>>();
        let expected = [
            "schema", "state", "restore_mode", "request_sha256", "proof_sha256",
            "run_id", "project_id", "source_request_id", "source_sha256",
            "config_sha256", "activation_attempt", "reconciliation_attempt",
            "logical_session_id", "session_epoch", "api_instance_id",
            "previous_ack_sha256",
        ]
        .into_iter()
        .map(str::to_owned)
        .collect::<std::collections::BTreeSet<_>>();
        assert_eq!(fields, expected);
    }

    #[test]
    fn terminal_outcome_requires_every_task_terminal() {
        let pending: fullmag_session::FmsRunCatalog = serde_json::from_value(json!({
            "schema_version": "run_catalog.v1",
            "run_id": "run-1",
            "revision": 1,
            "updated_at": "2026-10-20T10:00:00Z",
            "tasks": [{
                "task_id": "task-1",
                "input_fingerprint": "a".repeat(64),
                "lifecycle": "accepted",
                "readiness": {"state": "blocked", "reason": "awaiting_compute"}
            }]
        }))
        .unwrap();
        assert!(terminal_catalog_outcome(&pending).is_err());
    }

    #[test]
    fn successor_auto_uses_native_catalog_and_release_state() {
        let held: fullmag_session::FmsRunCatalog = serde_json::from_value(json!({
            "schema_version": "run_catalog.v1",
            "run_id": "run-1",
            "revision": 1,
            "updated_at": "2026-10-20T10:00:00Z",
            "tasks": [{
                "task_id": "task-1",
                "input_fingerprint": "a".repeat(64),
                "lifecycle": "accepted",
                "readiness": {"state": "blocked", "reason": "awaiting_compute"}
            }]
        }))
        .unwrap();
        let (mode, outcome, wire_mode) = classify_restore_state(
            Some(RESTORE_MODE_SUCCESSOR_AUTO),
            true,
            Some(RESTORE_MODE_HELD),
            true,
            false,
            false,
            &held,
        )
        .unwrap();
        assert_eq!(mode, AcceptedRestoreMode::Held);
        assert_eq!(outcome, None);
        assert_eq!(wire_mode, RESTORE_MODE_HELD);

        let terminal: fullmag_session::FmsRunCatalog = serde_json::from_value(json!({
            "schema_version": "run_catalog.v1",
            "run_id": "run-1",
            "revision": 2,
            "updated_at": "2026-10-20T10:00:00Z",
            "tasks": [{
                "task_id": "task-1",
                "input_fingerprint": "a".repeat(64),
                "lifecycle": "succeeded",
                "readiness": {"state": "ready"}
            }]
        }))
        .unwrap();
        let (mode, outcome, wire_mode) = classify_restore_state(
            Some(RESTORE_MODE_SUCCESSOR_AUTO),
            true,
            Some(RESTORE_MODE_HELD),
            false,
            true,
            true,
            &terminal,
        )
        .unwrap();
        assert_eq!(mode, AcceptedRestoreMode::Consumed);
        assert_eq!(outcome.as_deref(), Some("completed"));
        assert_eq!(wire_mode, RESTORE_MODE_CONSUMED);

        assert!(classify_restore_state(
            Some(RESTORE_MODE_SUCCESSOR_AUTO),
            false,
            None,
            true,
            false,
            false,
            &held,
        )
        .is_err());
        assert!(classify_restore_state(
            Some(RESTORE_MODE_SUCCESSOR_AUTO),
            true,
            Some(RESTORE_MODE_HELD),
            true,
            true,
            false,
            &held,
        )
        .is_err());
        assert!(classify_restore_state(
            Some(RESTORE_MODE_SUCCESSOR_AUTO),
            true,
            Some(RESTORE_MODE_CONSUMED),
            true,
            false,
            false,
            &held,
        )
        .is_err());
    }

    #[test]
    fn current_docker_binding_requires_exact_group_source_and_control_volume() {
        let input = input();
        let proof = proof(&input);
        assert!(validate_docker_binding_values(
            &proof,
            &proof.compose_project,
            &proof.source_root,
            &proof.control_volume,
        )
        .is_ok());
        assert!(validate_docker_binding_values(
            &proof,
            "different-compose-project",
            &proof.source_root,
            &proof.control_volume,
        )
        .is_err());
        assert!(validate_docker_binding_values(
            &proof,
            &proof.compose_project,
            "D:/other-source",
            &proof.control_volume,
        )
        .is_err());
        assert!(validate_docker_binding_values(
            &proof,
            &proof.compose_project,
            &proof.source_root,
            "different-control-volume",
        )
        .is_err());
    }

    #[test]
    fn proof_requires_exact_pins_and_both_terminal_receipts() {
        let input = input();
        let proof = AcceptedRestoreProof {
            schema: PROOF_SCHEMA.into(),
            run_id: input.run_id.clone(),
            project_id: input.project_id.clone(),
            source_request_id: input.source_request_id.clone(),
            source_sha256: input.source_sha256.clone(),
            startup_provenance_sha256: input.startup_provenance_sha256.clone(),
            activation_receipt_sha256: "f".repeat(64),
            stop_reconcile_proof_sha256: "1".repeat(64),
            stop_verification_sha256: "2".repeat(64),
            terminal_owner_record_path: "accepted-run-reattach/proof/terminal-owner.json".into(),
            terminal_owner_record_sha256: "4".repeat(64),
            terminal_process_record_path: "accepted-run-reattach/proof/terminal-process.json".into(),
            terminal_process_record_sha256: "5".repeat(64),
            namespace_attestation_path: Some(
                "verification/stopped-namespace-attestation-".to_string()
                    + &"5".repeat(64)
                    + ".json",
            ),
            namespace_attestation_sha256: Some("3".repeat(64)),
            activation_attempt: "3".repeat(32),
            reconciliation_attempt: "4".repeat(32),
            backend_container: "5".repeat(64),
            image_id: format!("sha256:{}", "6".repeat(64)),
            source_root: "C:/git/fullmag".into(),
            compose_project: "fullmag-worktree-test".into(),
            control_volume: "fullmag-worktree-test-control".into(),
            development_attempt: "7".repeat(32),
            config_sha256: input.config_sha256.clone(),
            logical_session_id: "session-1".into(),
            session_epoch: 3,
        };
        assert!(validate_proof(&proof, &input).is_ok());
        let mut changed = proof;
        changed.source_request_id = "other-request".into();
        assert!(validate_proof(&changed, &input).is_err());
        changed.source_request_id = input.source_request_id.clone();
        changed.namespace_attestation_path = Some("verification/other.json".into());
        assert!(validate_proof(&changed, &input).is_err());
        changed.namespace_attestation_path = None;
        changed.namespace_attestation_sha256 = Some("3".repeat(64));
        assert!(validate_proof(&changed, &input).is_err());
        changed.namespace_attestation_sha256 = None;
        assert!(validate_proof(&changed, &input).is_ok());
    }

    #[test]
    fn proof_pins_the_immutable_live_session_epoch() {
        let input = input();
        let mut proof = AcceptedRestoreProof {
            schema: PROOF_SCHEMA.into(),
            run_id: input.run_id.clone(),
            project_id: input.project_id.clone(),
            source_request_id: input.source_request_id.clone(),
            source_sha256: input.source_sha256.clone(),
            startup_provenance_sha256: input.startup_provenance_sha256.clone(),
            activation_receipt_sha256: "f".repeat(64),
            stop_reconcile_proof_sha256: "1".repeat(64),
            stop_verification_sha256: "2".repeat(64),
            terminal_owner_record_path: "accepted-run-reattach/proof/terminal-owner.json".into(),
            terminal_owner_record_sha256: "4".repeat(64),
            terminal_process_record_path: "accepted-run-reattach/proof/terminal-process.json".into(),
            terminal_process_record_sha256: "5".repeat(64),
            namespace_attestation_path: Some(
                "verification/stopped-namespace-attestation-".to_string()
                    + &"5".repeat(64)
                    + ".json",
            ),
            namespace_attestation_sha256: Some("3".repeat(64)),
            activation_attempt: "3".repeat(32),
            reconciliation_attempt: "4".repeat(32),
            backend_container: "5".repeat(64),
            image_id: format!("sha256:{}", "6".repeat(64)),
            source_root: "C:/git/fullmag".into(),
            compose_project: "fullmag-worktree-test".into(),
            control_volume: "fullmag-worktree-test-control".into(),
            development_attempt: "7".repeat(32),
            config_sha256: input.config_sha256.clone(),
            logical_session_id: "session-1".into(),
            session_epoch: 7,
        };
        assert!(validate_proof(&proof, &input).is_ok());
        proof.session_epoch = 0;
        assert!(validate_proof(&proof, &input).is_err());
    }

    #[test]
    fn reconciled_helper_requires_exact_absence_probe_and_original_digest() {
        let attempt = "a".repeat(32);
        let helper_name = format!("fullmag-control-{attempt}");
        let absence_probe = serde_json::json!({
            "schema": "fullmag.docker-helper-absence-probe.v1",
            "state": "absent",
            "helper_name": helper_name,
            "containers": [],
        });
        let activation = serde_json::json!({
            "helper_sha256": "b".repeat(64),
        });
        let record = serde_json::json!({
            "helper_container": format!("fullmag-control-{attempt}"),
            "helper_id": null,
            "helper_state": "absent-confirmed",
            "helper_sha256": "b".repeat(64),
            "helper_absence_probe_sha256": fullmag_session::hex_sha256(
                &fullmag_session::canonical_json_bytes(&absence_probe),
            ),
        });
        assert!(validate_reconciled_helper(&record, &activation, &attempt).is_ok());

        let mut changed = record;
        changed["helper_container"] = Value::String("fullmag-control-other".into());
        assert!(validate_reconciled_helper(&changed, &activation, &attempt).is_err());
    }

    #[test]
    fn immutable_terminal_archive_paths_are_separate_from_mutable_runtime_records() {
        assert!(validate_immutable_record_path(
            "accepted-run-reattach/proof/terminal-owner.json",
            "terminal-owner.json",
            "owner",
        )
        .is_ok());
        assert!(validate_immutable_record_path(
            "runtime-control/runtime-services/OWNER.json",
            "terminal-owner.json",
            "owner",
        )
        .is_err());
        assert!(validate_immutable_record_path(
            "accepted-run-reattach/proof/terminal.json",
            "terminal-process.json",
            "process",
        )
        .is_err());
    }

    #[test]
    fn reconciliation_current_requires_identical_terminal_bytes() {
        assert!(require_same_raw_record(b"{\"a\":1}\n", b"{\"a\":1}\n", "reconciliation").is_ok());
        assert!(require_same_raw_record(b"{\"a\":1}", b"{\"a\":1}\n", "reconciliation").is_err());
    }

    #[test]
    fn input_digest_validation_rejects_uppercase_or_short_values() {
        let mut input = input();
        assert!(validate_input_digests(&input).is_ok());
        input.schema = "other-schema".into();
        assert!(validate_input_digests(&input).is_err());
        input.schema = INPUT_SCHEMA.into();
        input.config_sha256 = "A".repeat(64);
        assert!(validate_input_digests(&input).is_err());
        input.config_sha256 = "d".repeat(63);
        assert!(validate_input_digests(&input).is_err());
    }

    #[test]
    fn startup_provenance_is_bound_to_explicit_source_and_request() {
        let source_root = "C:/git/fullmag";
        let source_sha256 = "b".repeat(64);
        let request_id = "request-1";
        let provenance = serde_json::json!({
            "schema": "fullmag.docker-startup-script.v1",
            "authorization": "explicit_startup_script",
            "source_root": source_root,
            "source_relative": "examples/accepted.py",
            "source_sha256": source_sha256.clone(),
            "request_id": request_id,
        });
        assert!(validate_startup_provenance_record(
            &provenance,
            source_root,
            &source_sha256,
            request_id,
        )
        .is_ok());
        let mut changed = provenance;
        changed["request_id"] = Value::String("other-request".into());
        assert!(validate_startup_provenance_record(
            &changed,
            source_root,
            &source_sha256,
            request_id,
        )
        .is_err());
        changed["request_id"] = Value::String(request_id.into());
        changed["source_relative"] = Value::String("../accepted.py".into());
        assert!(validate_startup_provenance_record(
            &changed,
            source_root,
            &source_sha256,
            request_id,
        )
        .is_err());
    }

    #[test]
    fn target_build_identity_is_the_compiled_commit_and_snapshot() {
        const COMMIT: &str = "aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa";
        const SNAPSHOT: &str = "bbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbb";
        let mut input = input();
        let build = fullmag_build_info::BuildIdentity {
            built_at_utc: "fixture",
            git_commit: COMMIT,
            worktree_state: "clean",
            source_snapshot_sha256: SNAPSHOT,
        };
        input.target_build_id = build.git_commit.into();
        input.target_source_sha256 = build.source_snapshot_sha256.into();
        assert!(validate_compiled_target(&input, build).is_ok());

        input.target_build_id = "c".repeat(40);
        assert!(validate_compiled_target(&input, build).is_err());
    }

    fn process_receipt_fixture(owner: Option<Value>) -> Value {
        let mut receipt = serde_json::json!({
            "schema": "fullmag.docker-process-tree.v1",
            "state": "failed_outcome_retained",
            "api_pid": 3227,
            "api_exit_code": -15,
            "error": "runtime service failed during startup",
            "runtime_pid": null,
        });
        if let Some(owner) = owner {
            receipt["service_owner"] = owner;
        }
        receipt
    }

    #[test]
    fn native_failure_probe_requires_wrapper_digest_owner_and_absent_pids() {
        let process_receipt = process_receipt_fixture(None);
        let failed_owner = owner_fixture("failed", "exited_success");
        let process_sha = "8".repeat(64);
        let probe = serde_json::json!({
            "schema": "fullmag.docker-native-start-failure-stop-probe.v1",
            "process_receipt_sha256": process_sha,
            "process_receipt": process_receipt,
            "failed_owner_sha256": "9".repeat(64),
            "failed_owner": failed_owner,
            "api_pid_exists": false,
            "owner_pid_exists": false,
            "child_pids_exist": false,
            "native_processes_live": false,
            "startup_enabled": null,
            "legacy_activation_marker_exists": false,
            "active_lease_count": 0,
        });
        assert!(validate_native_failure_probe(
            &probe,
            &process_sha,
            probe.get("process_receipt").unwrap(),
            false,
        )
        .is_ok());
        let mut changed = probe;
        changed["owner_pid_exists"] = true.into();
        assert!(validate_native_failure_probe(
            &changed,
            &process_sha,
            changed.get("process_receipt").unwrap(),
            false,
        )
        .is_err());
    }

    #[test]
    fn api_start_failure_requires_exact_api_error_and_drained_terminal_state() {
        let mut process_receipt = process_receipt_fixture(None);
        process_receipt["error"] = json!("API binding did not become ready: API loopback probe failed");
        let failed_owner = owner_fixture("failed", "exited_failure");
        let process_sha = "a".repeat(64);
        let mut probe = serde_json::json!({
            "schema": "fullmag.docker-native-start-failure-stop-probe.v1",
            "failure_mode": API_START_FAILURE_MODE,
            "process_receipt_sha256": process_sha,
            "process_receipt": process_receipt,
            "failed_owner_sha256": "b".repeat(64),
            "failed_owner": failed_owner,
            "api_pid_exists": false,
            "owner_pid_exists": false,
            "child_pids_exist": false,
            "native_processes_live": false,
            "startup_enabled": null,
            "legacy_activation_marker_exists": false,
            "active_lease_count": 0,
        });
        assert!(validate_native_process_receipt_mode(
            probe.get("process_receipt").unwrap(), false, true
        )
        .is_ok());
        assert!(validate_native_failure_probe_mode(
            &probe,
            &process_sha,
            probe.get("process_receipt").unwrap(),
            false,
            true,
        )
        .is_ok());

        probe["process_receipt"]["error"] = json!(
            "private accepted-run reattach must succeed before API startup"
        );
        assert!(validate_native_process_receipt_mode(
            probe.get("process_receipt").unwrap(), false, true
        )
        .is_err());

        probe["process_receipt"]["error"] = json!(
            "API binding did not become ready: API loopback probe failed"
        );
        probe["failed_owner"]["children"][0]["status"] = json!("running");
        assert!(validate_native_failure_probe_mode(
            &probe,
            &process_sha,
            probe.get("process_receipt").unwrap(),
            false,
            true,
        )
        .is_err());
        probe["failed_owner"]["children"][0]["status"] = json!("exited_failure");
        probe["reservation_states"] = json!(["unknown"]);
        assert!(require_all_released(&probe, "reservation_states").is_err());
    }

    #[test]
    fn native_owner_contract_rejects_noncanonical_identity_and_pid_alias() {
        let mut uppercase = owner_fixture("failed", "exited_success");
        uppercase["build_commit"] = Value::String("A".repeat(40));
        assert!(validate_native_owner(
            &uppercase,
            "failed owner",
            RuntimeServiceState::Failed,
            &["exited_success"],
        )
        .is_err());

        let mut aliased_pid = owner_fixture("failed", "exited_success");
        aliased_pid["children"][0]["pid"] = aliased_pid["pid"].clone();
        assert!(validate_native_owner(
            &aliased_pid,
            "failed owner",
            RuntimeServiceState::Failed,
            &["exited_success"],
        )
        .is_err());
    }

    #[test]
    fn after_ready_probe_preserves_ready_identity_and_terminal_service_owner() {
        let ready_owner = owner_fixture("ready", "running");
        let failed_owner = owner_fixture("failed", "exited_success");
        let process_receipt = process_receipt_fixture(Some(ready_owner.clone()));
        let process_sha = "a".repeat(64);
        let probe = serde_json::json!({
            "schema": "fullmag.docker-native-after-ready-failure-stop-probe.v1",
            "process_receipt_sha256": process_sha,
            "process_receipt": process_receipt,
            "failed_owner_sha256": "b".repeat(64),
            "failed_owner": failed_owner,
            "api_pid_exists": false,
            "owner_pid_exists": false,
            "child_pids_exist": false,
            "native_processes_live": false,
            "startup_enabled": null,
            "legacy_activation_marker_exists": false,
            "active_lease_count": 0,
        });
        let failed = validate_native_failure_probe(
            &probe,
            &process_sha,
            probe.get("process_receipt").unwrap(),
            true,
        )
        .unwrap();
        let terminal = serde_json::json!({
            "schema": "fullmag.docker-process-tree.v1",
            "state": "shutdown_unknown",
            "api_exit_code": -15,
            "runtime_pid": null,
            "service_owner": ready_owner,
        });
        assert!(validate_terminal_process_receipt(&terminal, true, &failed).is_ok());
    }

    #[test]
    fn namespace_attestation_binds_legacy_journal_and_container_incarnation() {
        let input = input();
        let mut proof = AcceptedRestoreProof {
            schema: PROOF_SCHEMA.into(),
            run_id: input.run_id.clone(),
            project_id: input.project_id.clone(),
            source_request_id: input.source_request_id.clone(),
            source_sha256: input.source_sha256.clone(),
            startup_provenance_sha256: input.startup_provenance_sha256.clone(),
            activation_receipt_sha256: "f".repeat(64),
            stop_reconcile_proof_sha256: "1".repeat(64),
            stop_verification_sha256: "2".repeat(64),
            terminal_owner_record_path: "accepted-run-reattach/proof/terminal-owner.json".into(),
            terminal_owner_record_sha256: "4".repeat(64),
            terminal_process_record_path: "accepted-run-reattach/proof/terminal-process.json".into(),
            terminal_process_record_sha256: "5".repeat(64),
            namespace_attestation_path: Some(
                "verification/stopped-namespace-attestation-".to_string()
                    + &"5".repeat(64)
                    + ".json",
            ),
            namespace_attestation_sha256: Some("3".repeat(64)),
            activation_attempt: "3".repeat(32),
            reconciliation_attempt: "4".repeat(32),
            backend_container: "5".repeat(64),
            image_id: format!("sha256:{}", "6".repeat(64)),
            source_root: "C:/git/fullmag".into(),
            compose_project: "fullmag-worktree-test".into(),
            control_volume: "fullmag-worktree-test-control".into(),
            development_attempt: "7".repeat(32),
            config_sha256: input.config_sha256.clone(),
            logical_session_id: "session-1".into(),
            session_epoch: 3,
        };
        let failed_owner = owner_fixture("failed", "exited_success");
        let failed_owner_sha256 = canonical_record_sha256(&failed_owner);
        let probe = serde_json::json!({
            "failed_owner": failed_owner.clone(),
            "failed_owner_sha256": failed_owner_sha256.clone(),
        });
        let terminal = serde_json::json!({
            "schema": "fullmag.docker-process-tree.v1",
            "state": "shutdown_unknown",
            "api_exit_code": -15,
            "runtime_pid": null,
        });
        let terminal_sha256 = canonical_record_sha256(&terminal);
        proof.terminal_process_record_sha256 = terminal_sha256.clone();
        proof.terminal_owner_record_sha256 = failed_owner_sha256.clone();
        let container_state = serde_json::json!({
            "id": proof.backend_container.clone(),
            "image": proof.image_id.clone(),
            "started_at": "2026-10-19T10:00:00Z",
            "finished_at": "2026-10-19T10:00:05Z",
            "exit_code": 1,
        });
        let verification = serde_json::json!({
            "failure_kind": "native-start-failure",
            "exit_code": 1,
            "terminal_failed_owner_sha256": failed_owner_sha256.clone(),
            "terminal_process_receipt": terminal.clone(),
            "terminal_failed_owner": failed_owner.clone(),
            "native_failure_probe": probe.clone(),
        });
        let mut attestation = serde_json::json!({
            "schema": NAMESPACE_ATTESTATION_SCHEMA,
            "state": "stopped-confirmed",
            "compose_project": proof.compose_project.clone(),
            "control_volume": proof.control_volume.clone(),
            "backend_container": proof.backend_container.clone(),
            "image_id": proof.image_id.clone(),
            "source_root": proof.source_root.clone(),
            "container_state": container_state,
            "stop_journal_path": "verification/stop-failed-".to_string() + &"5".repeat(64) + ".json",
            "stop_journal_sha256": proof.stop_verification_sha256.clone(),
            "terminal_process_receipt_path": proof.terminal_process_record_path.clone(),
            "terminal_process_receipt_sha256": terminal_sha256.clone(),
            "terminal_process_receipt": terminal,
            "terminal_failed_owner_path": proof.terminal_owner_record_path.clone(),
            "terminal_failed_owner_sha256": failed_owner_sha256,
            "terminal_failed_owner": failed_owner.clone(),
            "failure_kind": "native-start-failure",
            "native_failure_probe_sha256": canonical_record_sha256(&probe),
            "native_failure_probe": probe,
            "created_at": 1.0,
        });
        assert!(validate_namespace_attestation(
            &attestation,
            &proof,
            &verification,
            &attestation["terminal_process_receipt"],
            &attestation["terminal_failed_owner"],
            &attestation["native_failure_probe"],
            &attestation["terminal_failed_owner"],
            false,
        )
        .is_ok());
        proof.terminal_owner_record_sha256 = "9".repeat(64);
        assert!(validate_namespace_attestation(
            &attestation,
            &proof,
            &verification,
            &attestation["terminal_process_receipt"],
            &attestation["terminal_failed_owner"],
            &attestation["native_failure_probe"],
            &attestation["terminal_failed_owner"],
            false,
        )
        .is_err());
        proof.terminal_owner_record_sha256 =
            canonical_record_sha256(&attestation["terminal_failed_owner"]);
        attestation["container_state"]["exit_code"] = Value::Number(2.into());
        assert!(validate_namespace_attestation(
            &attestation,
            &proof,
            &verification,
            &attestation["terminal_process_receipt"],
            &attestation["terminal_failed_owner"],
            &attestation["native_failure_probe"],
            &attestation["terminal_failed_owner"],
            false,
        )
        .is_err());
    }
}
