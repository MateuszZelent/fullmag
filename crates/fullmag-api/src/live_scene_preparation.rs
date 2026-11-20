//! Server-side orchestration for lowering an immutable live scene into a
//! validated preparation receipt.
//!
//! Session identity, revision checks, transition fencing, and receipt
//! publication remain in the live API handler. This module owns only the
//! blocking SceneDocument -> ProblemIR -> PreparationReceipt work. Durable
//! publication remains the caller's responsibility.

mod antenna_domain;

use anyhow::Context;
use fullmag_application::{
    AcceptedPreparationReceipt, AcceptedRunPreparationSource, ClosedLoopPreparationReceipt,
    PreparationBinding, PreparationReceipt, RequestedExecution,
};
use fullmag_authoring::SceneDocument;
use fullmag_plan::PreparationPlanSource;
use serde::Serialize;
use serde_json::Value;
use std::path::PathBuf;
use std::sync::Arc;

use crate::error::ApiError;
use crate::types::{
    AppState, CurrentLivePreparationMaterializationRequest, CurrentLiveRequestContext,
    CurrentLiveSnapshotRequest, SessionStateResponse, SimulationPreparationLogEntrySnapshot,
    SimulationPreparationSnapshot, SimulationPreparationStageSnapshot,
};

pub(crate) struct LiveScenePreparationInput {
    pub repo_root: PathBuf,
    pub workspace_root: PathBuf,
    pub scene_document: SceneDocument,
    pub preparation_id: String,
    pub scene_revision: u64,
    pub requested_execution: RequestedExecution,
    pub display_projection: Value,
}

/// The one pre-solve read model shared by live FDM and FEM adapters.
///
/// `execution_plan` is the same immutable plan used to build the receipt.  It
/// therefore carries the resolved FDM grid or FEM mesh and the initial field
/// values without starting a solver or re-reading mutable session state.
#[derive(Debug, Clone, Serialize)]
pub(crate) struct LiveScenePreparationReadModel {
    pub schema_version: &'static str,
    pub preparation_id: String,
    pub scene_revision: u64,
    pub plan_fingerprint: String,
    pub requested_execution: RequestedExecution,
    pub execution_plan: fullmag_ir::ExecutionPlanIR,
    #[serde(skip)]
    pub global_sampling_mesh: Option<fullmag_runner::FemMeshPayload>,
}

/// State identity used to keep accepted preparation work off the session
/// transition lock.  The revisions cover the resources that preparation reads
/// or replaces; session/run status and the accepted workspace binding cover
/// lifecycle changes that must invalidate a prepared candidate.
#[derive(Debug, Clone, PartialEq, Eq)]
enum AcceptedPreparationPublicationMode {
    Active,
    ActiveObservation(AcceptedTaskAttemptIdentity),
    VerifiedOutput(AcceptedStageOutputIdentity),
    TerminalObservation(crate::development_accepted_restore::AcceptedRunReattachIdentity),
    TerminalVerifiedOutput {
        reattach: crate::development_accepted_restore::AcceptedRunReattachIdentity,
        output: AcceptedStageOutputIdentity,
    },
}

#[derive(Debug, Clone, PartialEq, Eq)]
struct AcceptedTaskAttemptIdentity {
    run_id: String,
    task_id: String,
    step_id: String,
    attempt_id: String,
    ownership_epoch: u64,
}

/// Identity supplied only from an already verified accepted output/catalog row.
#[derive(Debug, Clone, PartialEq, Eq)]
pub(crate) struct AcceptedStageOutputIdentity {
    pub(crate) run_id: String,
    pub(crate) task_id: String,
    pub(crate) step_id: String,
    pub(crate) case_id: String,
    pub(crate) attempt_id: String,
    pub(crate) ownership_epoch: u64,
    pub(crate) object_ref: String,
    pub(crate) data_kind: String,
    pub(crate) plan_fingerprint: Option<String>,
}

impl AcceptedTaskAttemptIdentity {
    fn from_live_header(
        header: &crate::accepted_study_worker::AcceptedLiveObservationHeader,
    ) -> Result<Self, ApiError> {
        if header.schema_version != crate::accepted_study_worker::ACCEPTED_LIVE_OBSERVATION_SCHEMA {
            return Err(ApiError::conflict_with_code(
                "accepted_preparation_current_state_changed",
                "accepted live observation header schema changed before preparation",
            ));
        }
        Ok(Self {
            run_id: header.run_id.clone(),
            task_id: header.task_id.clone(),
            step_id: header.step_id.clone(),
            attempt_id: header.attempt_id.clone(),
            ownership_epoch: header.ownership_epoch,
        })
    }
}

impl AcceptedPreparationPublicationMode {
    fn target_attempt(&self) -> Option<AcceptedTaskAttemptIdentity> {
        match self {
            Self::ActiveObservation(identity) => Some(identity.clone()),
            Self::VerifiedOutput(identity) | Self::TerminalVerifiedOutput { output: identity, .. } => Some(AcceptedTaskAttemptIdentity {
                run_id: identity.run_id.clone(),
                task_id: identity.task_id.clone(),
                step_id: identity.step_id.clone(),
                attempt_id: identity.attempt_id.clone(),
                ownership_epoch: identity.ownership_epoch,
            }),
            Self::Active | Self::TerminalObservation(_) => None,
        }
    }

    fn is_verified_output_only(&self) -> bool {
        matches!(self, Self::VerifiedOutput(_) | Self::TerminalVerifiedOutput { .. })
    }

    fn is_terminal_observation(&self) -> bool {
        matches!(self, Self::TerminalObservation(_) | Self::TerminalVerifiedOutput { .. })
    }

    fn resolves_step_initial_state(&self) -> bool {
        matches!(self, Self::Active | Self::ActiveObservation(_))
    }
}

#[derive(Debug, Clone, PartialEq, Eq)]
struct AcceptedPreparationPublicationFence {
    mode: AcceptedPreparationPublicationMode,
    session_id: String,
    run_id: String,
    session_epoch: u64,
    request_scope_epoch: String,
    session_status: String,
    run_status: String,
    scene_revision: u64,
    state_version: u64,
    scalar_revision: u64,
    mesh_revision: u64,
    mesh_build_revision: u64,
    field_catalog_revision: u64,
    field_samples_revision: u64,
    field_quantity_revisions: std::collections::BTreeMap<String, u64>,
    stage_execution_revision: u64,
    simulation_preparation_revision: u64,
    preparation_id: Option<String>,
    preparation_snapshot: Option<SimulationPreparationSnapshot>,
    accepted_run_id: Option<String>,
    accepted_step_id: Option<String>,
    display_projection: Value,
}

impl AcceptedPreparationPublicationFence {
    fn capture(
        snapshot: &SessionStateResponse,
        context: &CurrentLiveRequestContext,
        session_epoch: u64,
    ) -> Result<Self, ApiError> {
        Self::capture_with_mode(snapshot, context, session_epoch, AcceptedPreparationPublicationMode::Active)
    }

    fn capture_with_mode(
        snapshot: &SessionStateResponse,
        context: &CurrentLiveRequestContext,
        session_epoch: u64,
        mode: AcceptedPreparationPublicationMode,
    ) -> Result<Self, ApiError> {
        crate::ensure_current_live_request_context(snapshot, context, session_epoch)?;
        match &mode {
            AcceptedPreparationPublicationMode::Active
            | AcceptedPreparationPublicationMode::ActiveObservation(_) => {
                ensure_preparation_run_is_active(snapshot)?
            }
            AcceptedPreparationPublicationMode::VerifiedOutput(identity) => {
                let current_run_id = snapshot.run.as_ref().map(|run| run.run_id.as_str());
                if current_run_id != Some(identity.run_id.as_str()) {
                    return Err(ApiError::conflict_with_code(
                        "accepted_preparation_output_identity_invalid",
                        "verified output domain belongs to another current run",
                    ));
                }
            }
            AcceptedPreparationPublicationMode::TerminalObservation(identity) => {
                let run = snapshot.run.as_ref().ok_or_else(|| ApiError::conflict(
                    "terminal domain restoration requires an accepted run",
                ))?;
                let revision = snapshot.scene_document.as_ref().map(|scene| scene.revision);
                if !matches!(run.status.as_str(), "completed" | "failed" | "cancelled")
                    || !revision.is_some_and(|revision| identity.matches(
                        &run.run_id, &snapshot.session.session_id, session_epoch, revision,
                    ))
                {
                    return Err(ApiError::conflict_with_code(
                        "accepted_terminal_domain_identity_mismatch",
                        "terminal domain restoration requires the exact process-authenticated restored run",
                    ));
                }
            }
            AcceptedPreparationPublicationMode::TerminalVerifiedOutput { reattach, output } => {
                let run = snapshot.run.as_ref().ok_or_else(|| ApiError::conflict(
                    "terminal domain restoration requires an accepted run",
                ))?;
                let revision = snapshot.scene_document.as_ref().map(|scene| scene.revision);
                if !matches!(run.status.as_str(), "completed" | "failed" | "cancelled")
                    || output.run_id != run.run_id
                    || !revision.is_some_and(|revision| reattach.matches(
                        &run.run_id, &snapshot.session.session_id, session_epoch, revision,
                    ))
                {
                    return Err(ApiError::conflict_with_code(
                        "accepted_terminal_domain_identity_mismatch",
                        "terminal output restoration requires the exact process-authenticated restored run",
                    ));
                }
            }
        }
        let run_id = snapshot
            .run
            .as_ref()
            .map(|run| run.run_id.clone())
            .unwrap_or_else(|| snapshot.session.run_id.clone());
        if run_id.trim().is_empty() {
            return Err(ApiError::conflict_with_code(
                "accepted_preparation_current_run_missing",
                "accepted preparation requires the current durable live run",
            ));
        }
        if let Some(target) = mode.target_attempt() {
            if target.run_id != run_id
                || target.step_id.trim().is_empty()
                || target.task_id.trim().is_empty()
                || target.attempt_id.trim().is_empty()
                || target.ownership_epoch == 0
            {
                return Err(ApiError::conflict_with_code(
                    "accepted_preparation_current_state_changed",
                    "accepted target attempt does not match the current live run",
                ));
            }
        }
        let scene_revision = snapshot
            .scene_document
            .as_ref()
            .map(|scene| scene.revision)
            .ok_or_else(|| ApiError::not_found("no scene document available for preparation"))?;
        let display_projection = serde_json::to_value(&snapshot.display_selection).map_err(|error| {
            ApiError::internal(format!("failed to encode display projection: {error}"))
        })?;
        Ok(Self {
            mode,
            session_id: snapshot.session.session_id.clone(),
            run_id,
            session_epoch,
            request_scope_epoch: context.request_scope_epoch.clone(),
            session_status: snapshot.session.status.clone(),
            run_status: snapshot
                .run
                .as_ref()
                .map(|run| run.status.clone())
                .unwrap_or_else(|| snapshot.session.status.clone()),
            scene_revision,
            state_version: snapshot.state_version,
            scalar_revision: snapshot.scalar_revision,
            mesh_revision: snapshot.mesh_revision,
            mesh_build_revision: snapshot.mesh_build_revision,
            field_catalog_revision: snapshot.field_catalog_revision,
            field_samples_revision: snapshot.field_samples_revision,
            field_quantity_revisions: snapshot.field_quantity_revisions.clone(),
            stage_execution_revision: snapshot.stage_execution_revision,
            simulation_preparation_revision: snapshot.simulation_preparation_revision,
            preparation_id: snapshot
                .simulation_preparation
                .as_ref()
                .map(|preparation| preparation.preparation_id.clone()),
            preparation_snapshot: snapshot.simulation_preparation.clone(),
            accepted_run_id: snapshot
                .mesh_workspace
                .as_ref()
                .and_then(|workspace| workspace.get("accepted_run_id"))
                .and_then(Value::as_str)
                .map(str::to_owned),
            accepted_step_id: snapshot
                .mesh_workspace
                .as_ref()
                .and_then(|workspace| workspace.get("accepted_step_id"))
                .and_then(Value::as_str)
                .map(str::to_owned),
            display_projection,
        })
    }

    fn validate(
        &self,
        snapshot: &SessionStateResponse,
        context: &CurrentLiveRequestContext,
        session_epoch: u64,
    ) -> Result<(), ApiError> {
        crate::ensure_current_live_request_context(snapshot, context, session_epoch)?;
        let current = Self::capture_with_mode(snapshot, context, session_epoch, self.mode.clone())?;
        if &current != self {
            return Err(ApiError::conflict_with_code(
                "accepted_preparation_current_state_changed",
                "current live session or preparation inputs changed during accepted preparation",
            ));
        }
        Ok(())
    }
}

/// Capability proving that the accepted snapshot and immutable task receipt
/// were validated before taking the current-session transition fence.
#[derive(Debug, Clone)]
struct ValidatedAcceptedPreparationSource {
    run_id: String,
    step_id: String,
    specification_fingerprint: String,
    receipt_payload: Value,
}

impl ValidatedAcceptedPreparationSource {
    fn from_validated_receipt(
        current_run_id: &str,
        receipt: &AcceptedPreparationReceipt,
    ) -> Result<Self, ApiError> {
        let source = live_preparation_accepted_source(receipt).ok_or_else(|| {
            ApiError::conflict("accepted preparation receipt has no accepted-run source")
        })?;
        match receipt {
            AcceptedPreparationReceipt::Solver(receipt) => {
                validate_accepted_source_plan_identity(current_run_id, receipt.plan.source.as_ref(), source)?;
            }
            AcceptedPreparationReceipt::ClosedLoop(receipt) => {
                receipt.validate().map_err(|error| ApiError::conflict(error.to_string()))?;
                if source.run_id.as_str() != current_run_id {
                    return Err(ApiError::conflict("accepted inspection source run mismatch"));
                }
            }
        }
        let receipt_payload = receipt.payload().map_err(|error| {
            ApiError::internal(format!("accepted preparation receipt serialization failed: {error}"))
        })?;
        Ok(Self {
            run_id: source.run_id.as_str().to_owned(),
            step_id: source.step_id.clone(),
            specification_fingerprint: source.specification_fingerprint.clone(),
            receipt_payload,
        })
    }

    fn validate_receipt(
        &self,
        current_run_id: &str,
        receipt: &AcceptedPreparationReceipt,
    ) -> Result<(), ApiError> {
        let source = live_preparation_accepted_source(receipt).ok_or_else(|| {
            ApiError::conflict("accepted preparation receipt has no accepted-run source")
        })?;
        match receipt {
            AcceptedPreparationReceipt::Solver(receipt) => {
                validate_accepted_source_plan_identity(current_run_id, receipt.plan.source.as_ref(), source)?;
            }
            AcceptedPreparationReceipt::ClosedLoop(receipt) => {
                receipt.validate().map_err(|error| ApiError::conflict(error.to_string()))?;
                if source.run_id.as_str() != current_run_id {
                    return Err(ApiError::conflict("accepted inspection source run mismatch"));
                }
            }
        }
        let payload = receipt.payload().map_err(|error| {
            ApiError::internal(format!("accepted preparation receipt serialization failed: {error}"))
        })?;
        if source.run_id.as_str() != self.run_id
            || source.step_id != self.step_id
            || source.specification_fingerprint != self.specification_fingerprint
            || payload != self.receipt_payload
        {
            return Err(ApiError::conflict_with_code(
                "accepted_preparation_validation_pin_mismatch",
                "accepted preparation receipt differs from its validated snapshot identity",
            ));
        }
        Ok(())
    }
}

pub(crate) const LIVE_SCENE_PREPARATION_READ_MODEL_SCHEMA: &str =
    "fullmag.live_scene_preparation_read_model.v1";

const CANONICAL_PREPARATION_STAGE_IDS: [&str; 9] = [
    "runtime_startup",
    "script_materialization",
    "validation",
    "planning",
    "domain_preparation",
    "meshing",
    "mesh_postprocessing",
    "solver_initialization",
    "ready",
];

fn canonical_completed_preparation_stages(
    ready_at_unix_ms: u64,
    detail: &str,
) -> Vec<SimulationPreparationStageSnapshot> {
    const SOLVER_INITIALIZATION_DETAIL: &str =
        "Native solver initialization is deferred until Compute; no solver was invoked during preparation";
    const READY_DETAIL: &str = "Authored model preparation is ready; Compute has not run";

    CANONICAL_PREPARATION_STAGE_IDS
        .into_iter()
        .map(|id| {
            let is_ready = id == "ready";
            let is_solver_initialization = id == "solver_initialization";
            let stage_detail = if is_solver_initialization {
                SOLVER_INITIALIZATION_DETAIL
            } else if is_ready {
                READY_DETAIL
            } else {
                detail
            };
            SimulationPreparationStageSnapshot {
                id: id.into(),
                label: id.replace('_', " "),
                detail: stage_detail.into(),
                status: if is_solver_initialization {
                    "skipped"
                } else {
                    "completed"
                }
                .into(),
                started_at_unix_ms: is_ready.then_some(ready_at_unix_ms),
                completed_at_unix_ms: is_ready.then_some(ready_at_unix_ms),
                duration_ms: is_ready.then_some(0),
                clock_adjustment: None,
                progress_percent: (!is_solver_initialization).then_some(100),
                progress_label: if is_ready {
                    Some("ready".into())
                } else if is_solver_initialization {
                    Some("awaiting Compute".into())
                } else {
                    None
                },
            }
        })
        .collect()
}

fn canonical_ready_preparation_log(
    timestamp_unix_ms: u64,
    message: &str,
) -> SimulationPreparationLogEntrySnapshot {
    SimulationPreparationLogEntrySnapshot {
        timestamp_unix_ms,
        level: "info".into(),
        stage_id: "ready".into(),
        message: message.into(),
    }
}

/// Build the native-layer carrier for a prepared multilayer magnetization.
///
/// The runner owns the canonical field layout.  The values are flattened in
/// that layout's layer order, while every native grid and offset stays in the
/// layout so consumers never interpret independent layers as one common grid.
fn prepared_multilayer_initial_state(
    execution_plan: &fullmag_ir::ExecutionPlanIR,
) -> Result<(Vec<[f64; 3]>, Value), ApiError> {
    let fullmag_ir::BackendPlanIR::FdmMultilayer(plan) = &execution_plan.backend_plan else {
        return Err(ApiError::conflict_with_code(
            "accepted_preparation_multilayer_layout_invalid",
            "prepared initial state is not an FDM multilayer plan",
        ));
    };
    if plan.layers.is_empty() {
        return Err(ApiError::conflict_with_code(
            "accepted_preparation_multilayer_layout_invalid",
            "prepared multilayer plan has no native layers",
        ));
    }

    let layout = fullmag_runner::study_magnetization_layout_for_plan(execution_plan).map_err(
        |error| {
            ApiError::conflict_with_code(
                "accepted_preparation_multilayer_layout_invalid",
                format!("prepared multilayer field layout is invalid: {}", error.message),
            )
        },
    )?;
    let mut values = Vec::new();
    for layer in &plan.layers {
        let native_cell_count = layer
            .native_grid
            .iter()
            .try_fold(1usize, |count, axis| {
                (*axis > 0)
                    .then_some(count.checked_mul(usize::try_from(*axis).ok()?))
                    .flatten()
            })
            .ok_or_else(|| {
                ApiError::conflict_with_code(
                    "accepted_preparation_multilayer_layout_invalid",
                    format!(
                        "prepared multilayer layer '{}' has an invalid native grid",
                        layer.layer_id
                    ),
                )
            })?;
        if layer.initial_magnetization.len() != native_cell_count {
            return Err(ApiError::conflict_with_code(
                "accepted_preparation_multilayer_layout_invalid",
                format!(
                    "prepared multilayer layer '{}' initial magnetization length does not match its native grid",
                    layer.layer_id
                ),
            ));
        }
        if layer
            .initial_magnetization
            .iter()
            .flatten()
            .any(|value| !value.is_finite())
        {
            return Err(ApiError::conflict_with_code(
                "accepted_preparation_multilayer_layout_invalid",
                format!(
                    "prepared multilayer layer '{}' has non-finite initial magnetization",
                    layer.layer_id
                ),
            ));
        }
        values.extend(layer.initial_magnetization.iter().copied());
    }
    Ok((values, layout))
}

fn prepared_fem_mesh(
    execution_plan: &fullmag_ir::ExecutionPlanIR,
) -> Option<fullmag_runner::FemMeshPayload> {
    match &execution_plan.backend_plan {
        fullmag_ir::BackendPlanIR::Fem(plan) => Some(fullmag_runner::FemMeshPayload::from(plan)),
        fullmag_ir::BackendPlanIR::FemEigen(plan) => {
            Some(fullmag_runner::FemMeshPayload::from(plan))
        }
        fullmag_ir::BackendPlanIR::FemFrequencyResponse(plan) => {
            Some(fullmag_runner::FemMeshPayload::from(plan))
        }
        fullmag_ir::BackendPlanIR::AntennaFieldOnly(plan) => Some(
            fullmag_runner::StageFemMeshAsset::build_from_antenna_field_only_plan(plan).payload,
        ),
        fullmag_ir::BackendPlanIR::Fdm(_)
        | fullmag_ir::BackendPlanIR::FdmMultilayer(_)
        | fullmag_ir::BackendPlanIR::AntennaExternalLeadInspection(_) => None,
    }
}

/// Project the pinned preparation plan through the existing live metadata and
/// mesh consumers. The mesh workspace envelope alone is diagnostic state: the
/// binary topology resources require the solver-domain FemMeshPayload.
fn prepared_domain_publication(
    snapshot: &SessionStateResponse,
    read_model: &LiveScenePreparationReadModel,
) -> Result<(Value, Option<fullmag_runner::FemMeshPayload>), ApiError> {
    let mut metadata = match snapshot.metadata.as_deref() {
        None => serde_json::Map::new(),
        Some(Value::Object(metadata)) => metadata.clone(),
        Some(_) => return Err(ApiError::conflict("live metadata must be an object")),
    };
    // A newly qualified preparation owns its material samples again.
    metadata.remove("authored_damping");
    let execution_plan_metadata = serde_json::to_value(&read_model.execution_plan).map_err(
        |error| ApiError::internal(format!("failed to encode prepared execution plan: {error}")),
    )?;
    metadata.insert("execution_plan".into(), execution_plan_metadata);
    match &read_model.execution_plan.backend_plan {
        fullmag_ir::BackendPlanIR::Fdm(_) => {
            let layout = fullmag_runner::study_magnetization_layout_for_plan(&read_model.execution_plan)
                .map_err(|error| ApiError::conflict(error.message))?;
            metadata.insert("artifact_layout".into(), layout);
        }
        fullmag_ir::BackendPlanIR::FdmMultilayer(_) => {
            let (_, layout) = prepared_multilayer_initial_state(&read_model.execution_plan)?;
            metadata.insert("artifact_layout".into(), layout);
        }
        _ => {
            metadata.remove("artifact_layout");
        }
    }
    if matches!(
        &read_model.execution_plan.backend_plan,
        fullmag_ir::BackendPlanIR::AntennaFieldOnly(_)
    ) {
        metadata.remove("artifact_layout");
        metadata.remove("live_preview");
        metadata.insert("magnetic_state_present".into(), Value::Bool(false));
        metadata.insert("capabilities".into(), Value::Null);
    } else if matches!(
        &read_model.execution_plan.backend_plan,
        fullmag_ir::BackendPlanIR::Fdm(_)
            | fullmag_ir::BackendPlanIR::FdmMultilayer(_)
            | fullmag_ir::BackendPlanIR::Fem(_)
            | fullmag_ir::BackendPlanIR::FemEigen(_)
            | fullmag_ir::BackendPlanIR::FemFrequencyResponse(_)
    ) {
        metadata.remove("magnetic_state_present");
    }
    let fem_mesh = if let fullmag_ir::BackendPlanIR::AntennaFieldOnly(plan) = &read_model.execution_plan.backend_plan {
        if matches!(plan.field_sampling.domain, fullmag_ir::FieldTargetIR::Global {}) {
            let mesh = read_model.global_sampling_mesh.clone().ok_or_else(|| ApiError::conflict_with_code(
                "accepted_preparation_sampling_mesh_missing", "Global sampling requires its pinned domain mesh"))?;
            metadata.insert("antenna_domain_publication".into(), antenna_domain::global_publication_binding(plan, &mesh));
            Some(mesh)
        } else {
            metadata.remove("antenna_domain_publication");
            prepared_fem_mesh(&read_model.execution_plan)
        }
    } else {
        metadata.remove("antenna_domain_publication");
        prepared_fem_mesh(&read_model.execution_plan)
    };
    let metadata = Value::Object(metadata);
    // Keep the typed pinned plan as the authority for the binary topology.
    // The metadata JSON is a transport projection and must not replace the
    // already validated typed plan.
    if matches!(
        &read_model.execution_plan.backend_plan,
        fullmag_ir::BackendPlanIR::AntennaFieldOnly(_)
            | fullmag_ir::BackendPlanIR::Fem(_)
            | fullmag_ir::BackendPlanIR::FemEigen(_)
            | fullmag_ir::BackendPlanIR::FemFrequencyResponse(_)
    ) && fem_mesh.as_ref().is_none_or(|mesh| mesh.cells.is_empty())
    {
        return Err(ApiError::conflict_with_code(
            "accepted_preparation_mesh_missing",
            "prepared FEM plan has no materialized solver-domain topology",
        ));
    }
    Ok((metadata, fem_mesh))
}

/// Publish the actual planned initial state as an input carrier, without a
/// scalar row, solver event, or synthetic computed result. Its space/time
/// identity is anchored to the prepared domain and the pinned stage origin.
fn publish_prepared_initial_state(
    snapshot: &mut SessionStateResponse,
    read_model: &LiveScenePreparationReadModel,
    retain_accepted_scalar_series: bool,
) -> Result<(), ApiError> {
    if let Some(carrier) = prepare_initial_magnetization(&read_model.execution_plan)? {
        carrier.publish(
            snapshot, &read_model.preparation_id, &read_model.plan_fingerprint,
            read_model.scene_revision, serde_json::json!({"source_kind": "prepared_initial_state"}),
            retain_accepted_scalar_series,
        )?;
    }
    Ok(())
}

struct PreparedAcceptedStepOutputInitialState {
    carrier: PreparedInitialMagnetization,
    provenance: Value,
    claim: fullmag_application::TaskClaim,
}

fn accepted_step_output_store_read_error(
    operation: &str,
    step_id: &str,
    error: anyhow::Error,
) -> ApiError {
    accepted_preparation_store_read_error(
        operation,
        step_id,
        error,
        "accepted_preparation_input_invalid",
    )
}

fn accepted_store_read_is_transient(error: &anyhow::Error) -> bool {
    fullmag_runtime_control::is_transient_store_io(error)
        || error.chain().any(|cause| {
            cause.is::<fullmag_session::StoreWriterBusy>()
                || matches!(
                    cause.downcast_ref::<std::fs::TryLockError>(),
                    Some(std::fs::TryLockError::WouldBlock)
                )
        })
}

fn accepted_preparation_store_read_error(
    operation: &str,
    step_id: &str,
    error: anyhow::Error,
    invalid_code: &'static str,
) -> ApiError {
    let message = format!("{operation} for `{step_id}`: {error:#}");
    if accepted_store_read_is_transient(&error) {
        ApiError::with_status_and_code(
            axum::http::StatusCode::SERVICE_UNAVAILABLE,
            "accepted_preparation_pending",
            message,
        )
    } else {
        ApiError::conflict_with_code(invalid_code, message)
    }
}

/// Resolve the exact worker-effective M0 for a state-valued StepOutput input.
/// The canonical accepted read model remains untouched; this materialized
/// plan is used only to publish its actual initial magnetization carrier.
fn prepare_accepted_step_output_initial_state(
    store: &fullmag_session::SessionStore,
    accepted: &fullmag_runtime_control::AcceptedStudySnapshot,
    task_id: &str,
    step_id: &str,
    execution_plan: &fullmag_ir::ExecutionPlanIR,
    receipt: &fullmag_application::AcceptedPreparationReceipt,
    expected_attempt: Option<&AcceptedTaskAttemptIdentity>,
) -> Result<Option<PreparedAcceptedStepOutputInitialState>, ApiError> {
    use fullmag_authoring::{StudyInputSource, StudyPortDataKind};

    let accepted_step = accepted
        .study
        .steps
        .iter()
        .find(|step| step.step_id == step_id)
        .ok_or_else(|| ApiError::conflict("accepted preparation step is absent from its immutable Study"))?;
    let state_inputs = accepted_step
        .inputs
        .iter()
        .filter(|input| {
            matches!(input.data_kind, StudyPortDataKind::InitialState | StudyPortDataKind::State)
                && matches!(
                    &input.source,
                    StudyInputSource::StepOutput { .. } | StudyInputSource::PinnedArtifact { .. }
                )
        })
        .collect::<Vec<_>>();
    if state_inputs.is_empty() {
        if accepted_step.initial_state_overlay.is_some() {
            return Err(ApiError::conflict_with_code(
                "accepted_preparation_input_invalid",
                "accepted magnetization overlay has no state-valued accepted input",
            ));
        }
        // Authored resets stay bound to the canonical authored PlanIR.
        return Ok(None);
    }
    if state_inputs.len() != 1 {
        return Err(ApiError::conflict_with_code(
            "accepted_preparation_input_invalid",
            "accepted worker has multiple state-valued StepOutput inputs for one initial state",
        ));
    }
    if !matches!(
        &execution_plan.backend_plan,
        fullmag_ir::BackendPlanIR::Fdm(_)
            | fullmag_ir::BackendPlanIR::FdmMultilayer(_)
            | fullmag_ir::BackendPlanIR::Fem(_)
    ) {
        // FEM frequency response and other non-time-domain plans do not
        // publish a solver initial-magnetization carrier in this read model.
        return Ok(None);
    }

    let pending = || {
        ApiError::with_status_and_code(
            axum::http::StatusCode::SERVICE_UNAVAILABLE,
            "accepted_preparation_pending",
            format!("accepted StepOutput state for `{step_id}` is not pinned to a started task attempt yet"),
        )
    };
    let invalid = |message: String| {
        ApiError::conflict_with_code("accepted_preparation_input_invalid", message)
    };
    let run_id = &accepted.run.specification.run_id;
    let run_catalog = store
        .read_run_catalog(run_id.as_str())
        .map_err(|error| accepted_step_output_store_read_error(
            "accepted StepOutput run catalog read failed", step_id, error,
        ))?
        .ok_or_else(|| invalid("accepted StepOutput run catalog is missing".into()))?;
    let Some(durable_task) = run_catalog.tasks.iter().find(|task| task.task_id == task_id) else {
        return Err(pending());
    };
    match durable_task.lifecycle {
        fullmag_session::FmsTaskLifecycle::Accepted | fullmag_session::FmsTaskLifecycle::Queued => {
            return Err(pending());
        }
        fullmag_session::FmsTaskLifecycle::Preparing
        | fullmag_session::FmsTaskLifecycle::Running
        | fullmag_session::FmsTaskLifecycle::Stopping => {}
        fullmag_session::FmsTaskLifecycle::Succeeded
        | fullmag_session::FmsTaskLifecycle::Failed
        | fullmag_session::FmsTaskLifecycle::Cancelled
        | fullmag_session::FmsTaskLifecycle::Interrupted => {
            // A completed stage no longer exposes its start-state frame as
            // current. Let the accepted output projection publish the actual
            // terminal observation instead of replacing it with authored m0.
            return Err(pending());
        }
    }
    if !matches!(&durable_task.readiness, fullmag_session::FmsTaskReadiness::Ready) {
        return Err(pending());
    }

    let start = {
        let transaction = fullmag_runtime_control::acquire_store_read_transaction(
            store, std::time::Duration::from_secs(4),
        )
        .map_err(|error| accepted_step_output_store_read_error(
            "accepted StepOutput read fence failed", step_id, error,
        ))?;
        let claim = fullmag_runtime_control::load_current_task_claim_readonly(
            store, run_id, task_id, &transaction,
        )
        .map_err(|error| accepted_step_output_store_read_error(
            "accepted StepOutput current claim is invalid", step_id, error,
        ))?;
        let recovered = fullmag_runtime_control::recover_coordinator_readonly(
            store,
            &claim,
            &transaction,
        )
        .map_err(|error| accepted_step_output_store_read_error(
            "accepted StepOutput coordinator recovery failed", step_id, error,
        ))?;
        let starts = recovered
            .commands
            .iter()
            .filter(|command| {
                command.claim.matches_claim(&claim)
                    && matches!(&command.command, fullmag_application::WorkerCommand::Start)
            })
            .collect::<Vec<_>>();
        match starts.as_slice() {
            [] => return Err(pending()),
            [start] => (*start).clone(),
            _ => {
                return Err(invalid(format!(
                    "accepted StepOutput target `{step_id}` has multiple durable Start commands"
                )));
            }
        }
    };
    let accepted_worker_step = fullmag_runtime_control::load_accepted_worker_step_for_observation(
        store,
        accepted,
        &start,
        std::time::Duration::from_secs(4),
    )
    .map_err(|error| accepted_step_output_store_read_error(
        "accepted StepOutput worker Start is invalid", step_id, error,
    ))?;
    if accepted_worker_step.step_id != step_id
        || &accepted_worker_step.claim.run_id != run_id
        || accepted_worker_step.claim.task_id.as_str() != task_id
        || accepted_worker_step.execution_plan != *execution_plan
        || accepted_worker_step.study_inputs != accepted_step.inputs
        || accepted_worker_step.initial_state_overlay != accepted_step.initial_state_overlay
    {
        return Err(invalid(format!(
            "accepted StepOutput Start for `{step_id}` differs from its pinned read model"
        )));
    }
    if expected_attempt.is_some_and(|expected| {
        expected.run_id != accepted_worker_step.claim.run_id.as_str()
            || expected.task_id != accepted_worker_step.claim.task_id.as_str()
            || expected.step_id != accepted_worker_step.step_id
            || expected.attempt_id != accepted_worker_step.claim.attempt_id.as_str()
            || expected.ownership_epoch != accepted_worker_step.claim.ownership_epoch.value()
    }) {
        return Err(ApiError::conflict_with_code(
            "accepted_preparation_current_state_changed",
            "accepted live observation belongs to another task attempt",
        ));
    }

    // Admission is the durable attempt/epoch/lease pin for the resolved-input
    // map. Compare it with the worker's exact Start-derived Prepare before
    // reading the CAS artifact or exposing any m samples.
    let admission = store
        .read_task_admission(
            run_id.as_str(),
            task_id,
            accepted_worker_step.claim.attempt_id.as_str(),
        )
        .map_err(|error| accepted_step_output_store_read_error(
            "accepted StepOutput admission read failed", step_id, error,
        ))?
        .ok_or_else(|| invalid("accepted StepOutput attempt has no durable admission".into()))?;
    let lease = &admission.lease;
    let admitted_inputs = admission
        .resolved_inputs_snapshot
        .as_ref()
        .ok_or_else(|| invalid("accepted StepOutput admission has no resolved-input snapshot".into()))?;
    let admitted_inputs: std::collections::BTreeMap<
        String,
        fullmag_application::ResolvedInput,
    > = serde_json::from_value(admitted_inputs.inputs.clone()).map_err(|error| {
        invalid(format!("accepted StepOutput admission inputs are not typed: {error}"))
    })?;
    let admitted_frozen_context = admission
        .resolved_inputs_snapshot
        .as_ref()
        .and_then(|snapshot| snapshot.frozen_stage_context.clone())
        .map(serde_json::from_value::<fullmag_application::FrozenStageContextRefV1>)
        .transpose()
        .map_err(|error| invalid(format!("accepted StepOutput frozen context is not typed: {error}")))?;
    let current_claim = &accepted_worker_step.claim;
    let admitted_kind = match current_claim.lease.kind {
        fullmag_application::ResourceKind::Cpu => fullmag_session::FmsResourceKind::Cpu,
        fullmag_application::ResourceKind::Gpu => fullmag_session::FmsResourceKind::Gpu,
        fullmag_application::ResourceKind::Storage => fullmag_session::FmsResourceKind::Storage,
        fullmag_application::ResourceKind::Meshing => fullmag_session::FmsResourceKind::Meshing,
    };
    if admission.task.task_id != task_id
        || admission.task.attempt_id.as_deref() != Some(current_claim.attempt_id.as_str())
        || admission.task.ownership_epoch != Some(current_claim.ownership_epoch.value())
        || lease.run_id != run_id.as_str()
        || lease.task_id != task_id
        || lease.attempt_id != current_claim.attempt_id.as_str()
        || lease.ownership_epoch != current_claim.ownership_epoch.value()
        || lease.kind != admitted_kind
        || lease.state != fullmag_session::FmsResourceLeaseState::Active
        || lease.resource_id != current_claim.lease.resource_id
        || lease.lease_token != current_claim.lease.lease_token.as_str()
        || lease.budget.cpu_millis != current_claim.lease.budget.cpu_millis
        || lease.budget.memory_bytes != current_claim.lease.budget.memory_bytes
        || lease.budget.gpu_memory_bytes != current_claim.lease.budget.gpu_memory_bytes
        || lease.budget.storage_bytes != current_claim.lease.budget.storage_bytes
        || admitted_inputs != accepted_worker_step.resolved_input.inputs
        || admitted_frozen_context != accepted_worker_step.resolved_input.frozen_stage_context
    {
        return Err(invalid(format!(
            "accepted StepOutput admission differs from target attempt/epoch/lease or worker inputs for `{step_id}`"
        )));
    }

    materialize_accepted_step_output_initial_state(
        store,
        &accepted_worker_step,
        state_inputs[0],
        execution_plan,
        receipt.preparation_id(),
        receipt.plan_fingerprint(),
    )
    .map(Some)
}

fn materialize_accepted_step_output_initial_state(
    store: &fullmag_session::SessionStore,
    accepted_worker_step: &fullmag_runtime_control::AcceptedWorkerStep,
    input_port: &fullmag_authoring::StudyInputPort,
    execution_plan: &fullmag_ir::ExecutionPlanIR,
    preparation_id: &str,
    plan_fingerprint: &str,
) -> Result<PreparedAcceptedStepOutputInitialState, ApiError> {
    let invalid = |message: String| {
        ApiError::conflict_with_code("accepted_preparation_input_invalid", message)
    };
    let step_id = accepted_worker_step.step_id.as_str();
    let (source_kind, source_identity) = match &input_port.source {
        fullmag_authoring::StudyInputSource::StepOutput {
            step_id: source_step_id,
            port,
            case_id,
        } => (
            "step_output",
            serde_json::json!({
                "step_id": source_step_id,
                "port": port,
                "case_id": case_id,
            }),
        ),
        fullmag_authoring::StudyInputSource::PinnedArtifact {
            artifact_id,
            content_sha256,
        } => (
            "pinned_artifact",
            serde_json::json!({
                "artifact_id": artifact_id,
                "content_sha256": content_sha256,
            }),
        ),
        _ => {
            return Err(invalid(format!(
                "accepted state input `{}` is not a materializable source",
                input_port.port_id
            )));
        }
    };
    let current_claim = &accepted_worker_step.claim;
    let materialized = fullmag_runtime_control::materialize_accepted_worker_execution_plan_with_source(
        store,
        accepted_worker_step,
    )
    .map_err(|error| accepted_step_output_store_read_error(
        "accepted StepOutput materialization failed", step_id, error,
    ))?;
    let state_input = materialized
        .state_input
        .ok_or_else(|| invalid(format!("accepted StepOutput port `{}` has no resolved state", input_port.port_id)))?;
    if let fullmag_authoring::StudyInputSource::PinnedArtifact {
        artifact_id,
        content_sha256,
    } = &input_port.source
    {
        if state_input.artifact.artifact_id != *artifact_id
            || state_input.artifact.object_ref != *content_sha256
        {
            return Err(invalid(format!(
                "accepted pinned state input `{}` differs from its exact artifact identity",
                input_port.port_id
            )));
        }
    }
    if state_input.input_port != *input_port {
        return Err(invalid(format!(
            "accepted StepOutput input metadata differs from the immutable port `{}`",
            input_port.port_id
        )));
    }
    let expected_layout = fullmag_runner::study_magnetization_layout_for_plan(execution_plan)
        .map_err(|error| invalid(format!("accepted StepOutput target layout is invalid: {}", error.message)))?;
    let expected_layout_sha256 = fullmag_application::study_state_layout_sha256(&expected_layout)
        .map_err(|error| invalid(format!("accepted StepOutput target layout digest failed: {error}")))?;
    if state_input.layout_sha256 != expected_layout_sha256 {
        return Err(invalid(format!(
            "accepted StepOutput source layout differs from the exact target plan for `{step_id}`"
        )));
    }
    let effective_plan = materialized.execution_plan;
    if fullmag_runner::study_magnetization_layout_for_plan(&effective_plan)
        .map_err(|error| invalid(format!("materialized StepOutput layout is invalid: {}", error.message)))?
        != expected_layout
    {
        return Err(invalid(format!(
            "materialized StepOutput layout differs from the exact target plan for `{step_id}`"
        )));
    }
    let carrier = prepare_initial_magnetization(&effective_plan)?
        .ok_or_else(|| invalid(format!("accepted StepOutput plan `{step_id}` has no initial m carrier")))?;
    if accepted_worker_step.initial_state_overlay.is_none()
        && accepted_worker_step.resolved_input.frozen_stage_context.is_none()
        && carrier.values_sha256 != state_input.values_sha256
    {
        return Err(invalid(format!(
            "accepted StepOutput M0 differs from its source artifact for `{step_id}`"
        )));
    }
    let materialization_kind = if accepted_worker_step.resolved_input.frozen_stage_context.is_some() {
        "frozen_continuation"
    } else if accepted_worker_step.initial_state_overlay.is_some() {
        if source_kind == "pinned_artifact" {
            "pinned_artifact_overlay"
        } else {
            "step_output_overlay"
        }
    } else if source_kind == "pinned_artifact" {
        "pinned_artifact"
    } else {
        "step_output"
    };
    let mut provenance = serde_json::json!({
        "source_kind": "accepted_step_output_initial_state",
        "materialization_kind": materialization_kind,
        "preparation_id": preparation_id,
        "plan_fingerprint": plan_fingerprint,
        "target_attempt": {
            "run_id": current_claim.run_id.as_str(),
            "task_id": current_claim.task_id.as_str(),
            "attempt_id": current_claim.attempt_id.as_str(),
            "ownership_epoch": current_claim.ownership_epoch.value(),
            "step_id": step_id,
        },
        "accepted_input": {
            "source_kind": source_kind,
            "source_identity": source_identity,
            "port_id": input_port.port_id,
            "port_data_kind": input_port.data_kind,
            "artifact_id": state_input.artifact.artifact_id,
            "object_ref": state_input.artifact.object_ref,
            "data_kind": state_input.artifact.data_kind,
            "values_sha256": state_input.values_sha256,
            "layout_sha256": state_input.layout_sha256,
        },
        "producer_clock": {
            "step": state_input.producer_step,
            "time_seconds": state_input.producer_time_s,
            "solver_dt_seconds": state_input.producer_solver_dt_s,
        },
        "target_clock": {
            "step": 0,
            "time_seconds": carrier.start_time_s,
        },
        "materialized_state": {
            "values_sha256": carrier.values_sha256,
            "layout_sha256": state_input.layout_sha256,
        },
    });
    if let Some(overlay) = accepted_worker_step.initial_state_overlay.as_ref() {
        provenance["overlay_scopes"] = serde_json::to_value(overlay.scopes()).map_err(|error| {
            ApiError::internal(format!("encode accepted StepOutput overlay scopes: {error}"))
        })?;
    }
    if let Some(context) = accepted_worker_step.resolved_input.frozen_stage_context.as_ref() {
        provenance["frozen_stage_context"] = serde_json::to_value(context).map_err(|error| {
            ApiError::internal(format!("encode accepted frozen stage context: {error}"))
        })?;
    }
    Ok(PreparedAcceptedStepOutputInitialState {
        carrier,
        provenance,
        claim: current_claim.clone(),
    })
}

fn publish_accepted_step_output_initial_state(
    snapshot: &mut SessionStateResponse,
    read_model: &LiveScenePreparationReadModel,
    prepared: PreparedAcceptedStepOutputInitialState,
) -> Result<(), ApiError> {
    let frame = crate::session::accepted_observation_frame_ref(
        snapshot,
        0,
        Some(prepared.carrier.start_time_s),
    );
    let mut provenance = prepared.provenance;
    provenance["preparation_id"] = read_model.preparation_id.clone().into();
    provenance["plan_fingerprint"] = read_model.plan_fingerprint.clone().into();
    let mut field = prepared.carrier.field;
    field["n_comp"] = 3.into();
    field["source_step"] = 0.into();
    field["source_time_seconds"] = prepared.carrier.start_time_s.into();
    field["source_revision"] = read_model.scene_revision.into();
    field["provenance"] = provenance;
    field["observation_frame"] = serde_json::to_value(&frame).map_err(|error| {
        ApiError::internal(format!("encode accepted StepOutput observation frame: {error}"))
    })?;
    let mut fields = crate::types::LatestFields::default();
    fields.insert("m".into(), field);
    let session_id = snapshot.session.session_id.clone();
    crate::session::apply_current_live_accepted_field_frame(
        snapshot,
        crate::types::CurrentLiveFieldFrameRequest {
            session_id,
            latest_fields: Some(fields),
            replace_latest_fields: false,
            field_generation: None,
            preview_fields: None,
            clear_preview_cache: false,
        },
        frame,
    )
}

fn task_attempt_changed() -> ApiError {
    ApiError::conflict_with_code(
        "accepted_preparation_current_state_changed",
        "accepted task attempt changed before domain publication",
    )
}

fn hold_current_accepted_attempt_fence(
    store: &fullmag_session::SessionStore,
    expected: &AcceptedTaskAttemptIdentity,
    expected_claim: Option<&fullmag_application::TaskClaim>,
) -> Result<fullmag_session::ReadTransaction, ApiError> {
    let transaction = store
        .read_transaction()
        .map_err(|error| accepted_step_output_store_read_error(
            "accepted attempt final read fence failed",
            &expected.step_id,
            error,
        ))?;
    let catalog = store
        .read_run_catalog(&expected.run_id)
        .map_err(|error| accepted_step_output_store_read_error(
            "accepted attempt final catalog read failed",
            &expected.step_id,
            error,
        ))?
        .ok_or_else(task_attempt_changed)?;
    let task = catalog
        .tasks
        .iter()
        .find(|task| task.task_id == expected.task_id)
        .ok_or_else(task_attempt_changed)?;
    if !matches!(
        task.lifecycle,
        fullmag_session::FmsTaskLifecycle::Preparing
            | fullmag_session::FmsTaskLifecycle::Running
            | fullmag_session::FmsTaskLifecycle::Stopping
    ) || !matches!(
        &task.readiness,
        fullmag_session::FmsTaskReadiness::Ready
    ) || task.attempt_id.as_deref() != Some(expected.attempt_id.as_str())
        || task.ownership_epoch != Some(expected.ownership_epoch)
        || task.resource_id.is_none()
    {
        return Err(task_attempt_changed());
    }
    if let Some(expected_claim) = expected_claim {
        if expected_claim.run_id.as_str() != expected.run_id
            || expected_claim.task_id.as_str() != expected.task_id
            || expected_claim.attempt_id.as_str() != expected.attempt_id
            || expected_claim.ownership_epoch.value() != expected.ownership_epoch
        {
            return Err(task_attempt_changed());
        }
        let current_claim = fullmag_runtime_control::load_current_task_claim_readonly(
            store,
            &expected_claim.run_id,
            expected_claim.task_id.as_str(),
            &transaction,
        )
        .map_err(|error| accepted_step_output_store_read_error(
            "accepted attempt final claim read failed",
            &expected.step_id,
            error,
        ))?;
        if !expected_claim.is_same_or_renewed_by(&current_claim) {
            return Err(task_attempt_changed());
        }
    }
    Ok(transaction)
}

fn validate_verified_output_task_identity(
    identity: &AcceptedStageOutputIdentity,
    task: &fullmag_session::FmsTaskCatalogEntry,
) -> Result<(), ApiError> {
    if task.lifecycle != fullmag_session::FmsTaskLifecycle::Succeeded
        || task.task_id != identity.task_id
        || task.attempt_id.as_deref() != Some(identity.attempt_id.as_str())
        || task.ownership_epoch != Some(identity.ownership_epoch)
    {
        return Err(task_attempt_changed());
    }
    Ok(())
}

/// Verify the small output manifest and catalog row before a domain candidate
/// exists. The potentially large state object has already been decoded by the
/// accepted output projection and is deliberately not read a second time.
fn verify_accepted_stage_output_identity(
    store: &fullmag_session::SessionStore,
    accepted: Option<&fullmag_runtime_control::AcceptedStudySnapshot>,
    identity: &AcceptedStageOutputIdentity,
    expected_plan_fingerprint: &str,
) -> Result<fullmag_session::ReadTransaction, ApiError> {
    if !matches!(identity.data_kind.as_str(), "state" | "initial_state") {
        return Err(ApiError::conflict_with_code(
            "accepted_preparation_output_identity_invalid",
            "verified output-only domain requires a typed magnetization state",
        ));
    }
    if identity.plan_fingerprint.as_deref().is_some_and(|fingerprint| {
        fingerprint != expected_plan_fingerprint
    }) {
        return Err(task_attempt_changed());
    }
    if accepted.is_some_and(|accepted| {
        accepted.run.specification.run_id.as_str() != identity.run_id
    }) {
        return Err(task_attempt_changed());
    }
    let expected_task = fullmag_session::task_id_for_study_step(
        &identity.run_id,
        &identity.step_id,
    )
    .map_err(|error| ApiError::bad_request(format!("accepted output step id is invalid: {error}")))?;
    if expected_task != identity.task_id {
        return Err(task_attempt_changed());
    }

    let transaction = store
        .read_transaction()
        .map_err(|error| accepted_step_output_store_read_error(
            "verified output identity read fence failed",
            &identity.step_id,
            error,
        ))?;
    let run_catalog = store
        .read_run_catalog(&identity.run_id)
        .map_err(|error| accepted_step_output_store_read_error(
            "verified output run catalog read failed",
            &identity.step_id,
            error,
        ))?
        .ok_or_else(|| ApiError::conflict_with_code(
            "accepted_preparation_output_identity_invalid",
            "verified output run catalog is missing",
        ))?;
    let task = run_catalog
        .tasks
        .iter()
        .find(|task| task.task_id == identity.task_id)
        .ok_or_else(task_attempt_changed)?;
    validate_verified_output_task_identity(identity, task)?;

    let artifact_catalog = store
        .read_artifact_catalog(&identity.run_id)
        .map_err(|error| accepted_step_output_store_read_error(
            "verified output artifact catalog read failed",
            &identity.step_id,
            error,
        ))?
        .ok_or_else(|| ApiError::conflict_with_code(
            "accepted_preparation_output_identity_invalid",
            "verified output artifact catalog is missing",
        ))?;
    artifact_catalog.validate().map_err(|error| {
        ApiError::conflict_with_code(
            "accepted_preparation_output_identity_invalid",
            format!("verified output artifact catalog is invalid: {error}"),
        )
    })?;
    if artifact_catalog.run_id != identity.run_id {
        return Err(ApiError::conflict_with_code(
            "accepted_preparation_output_identity_invalid",
            "verified output artifact catalog belongs to another run",
        ));
    }
    let manifests = artifact_catalog.entries.iter().filter(|entry| {
        entry.artifact_type == "study_output_manifest"
            && entry.task_id == identity.task_id
            && entry.attempt_id == identity.attempt_id
            && entry.ownership_epoch == identity.ownership_epoch
            && entry.status == fullmag_session::FmsArtifactStatus::Published
            && task.artifact_ids.contains(&entry.artifact_id)
    }).collect::<Vec<_>>();
    let [manifest_entry] = manifests.as_slice() else {
        return Err(ApiError::conflict_with_code(
            "accepted_preparation_output_identity_invalid",
            "verified task must have exactly one output manifest for its attempt",
        ));
    };
    let manifest_ref = manifest_entry.object_ref.as_deref()
        .filter(|object_ref| *object_ref == manifest_entry.content_sha256)
        .ok_or_else(|| ApiError::conflict_with_code(
            "accepted_preparation_output_identity_invalid",
            "verified output manifest digest is not pinned",
        ))?;
    let manifest_bytes = store
        .cas()
        .get_bounded(manifest_ref, fullmag_session::MAX_TERMINAL_CATALOG_METADATA_BYTES)
        .map_err(|error| accepted_step_output_store_read_error(
            "verified output manifest CAS read failed",
            &identity.step_id,
            error,
        ))?
        .ok_or_else(|| ApiError::conflict_with_code(
            "accepted_preparation_output_identity_invalid",
            "verified output manifest is missing from CAS",
        ))?;
    let manifest = fullmag_runtime_control::read_study_output_manifest_projection(&manifest_bytes)
        .map_err(|error| ApiError::conflict_with_code(
            "accepted_preparation_output_identity_invalid",
            format!("verified output manifest is invalid: {error}"),
        ))?;
    if manifest.run_id != identity.run_id
        || manifest.task_id != identity.task_id
        || manifest.step_id != identity.step_id
        || manifest.attempt_id != identity.attempt_id
        || manifest.ownership_epoch != identity.ownership_epoch
    {
        return Err(task_attempt_changed());
    }
    let matching_outputs = manifest.outputs.iter().filter(|output| {
        output.case_id == identity.case_id
            && output.object_ref == identity.object_ref
            && output.data_kind == identity.data_kind
            && output.content_sha256 == identity.object_ref
    }).collect::<Vec<_>>();
    let [output] = matching_outputs.as_slice() else {
        return Err(ApiError::conflict_with_code(
            "accepted_preparation_output_identity_invalid",
            "verified output reference and case do not identify exactly one manifest output",
        ));
    };
    let artifacts = artifact_catalog.entries.iter().filter(|entry| {
        entry.artifact_id == output.artifact_id
            && entry.task_id == identity.task_id
            && entry.attempt_id == identity.attempt_id
            && entry.ownership_epoch == identity.ownership_epoch
            && entry.status == fullmag_session::FmsArtifactStatus::Published
            && entry.object_ref.as_deref() == Some(identity.object_ref.as_str())
            && entry.content_sha256 == identity.object_ref
            && entry.study_output.as_ref().is_some_and(|study_output| {
                study_output.step_id == identity.step_id
                    && study_output.port_id == output.port_id
                    && study_output.case_id == identity.case_id
            })
    }).collect::<Vec<_>>();
    if artifacts.len() != 1 {
        return Err(ApiError::conflict_with_code(
            "accepted_preparation_output_identity_invalid",
            "verified output is not pinned by exactly one artifact catalog entry",
        ));
    }
    if let Some(accepted) = accepted {
        let step = accepted.study.steps.iter().find(|step| step.step_id == identity.step_id)
            .ok_or_else(|| ApiError::conflict_with_code(
                "accepted_preparation_output_identity_invalid",
                "verified output step is absent from the immutable Study",
            ))?;
        let declared_output = step.outputs.iter().any(|port| {
            if port.port_id != output.port_id {
                return false;
            }
            matches!(
                (port.data_kind, identity.data_kind.as_str()),
                (fullmag_authoring::StudyPortDataKind::State, "state")
                    | (fullmag_authoring::StudyPortDataKind::InitialState, "initial_state")
            )
        });
        if !declared_output {
            return Err(ApiError::conflict_with_code(
                "accepted_preparation_output_identity_invalid",
                "verified output port differs from the immutable Study",
            ));
        }
    }
    Ok(transaction)
}

async fn hold_current_accepted_attempt_fence_async(
    store_root: PathBuf,
    expected: AcceptedTaskAttemptIdentity,
    expected_claim: Option<fullmag_application::TaskClaim>,
) -> Result<fullmag_session::ReadTransaction, ApiError> {
    tokio::task::spawn_blocking(move || {
        let store = fullmag_session::SessionStore::open_existing(&store_root).map_err(|error| {
            accepted_step_output_store_read_error(
                "accepted attempt final store open failed",
                &expected.step_id,
                error,
            )
        })?;
        hold_current_accepted_attempt_fence(&store, &expected, expected_claim.as_ref())
    })
    .await
    .map_err(|error| ApiError::internal(format!("accepted attempt final fence task failed: {error}")))?
}

/// Hold the durable active-task identity stable through a live observation's
/// final session pointer swap. Callers retain the returned read fence until
/// that swap is complete.
pub(crate) async fn hold_live_observation_publication_fence(
    store_root: &std::path::Path,
    header: &crate::accepted_study_worker::AcceptedLiveObservationHeader,
) -> Result<fullmag_session::ReadTransaction, ApiError> {
    let expected = AcceptedTaskAttemptIdentity::from_live_header(header)?;
    hold_current_accepted_attempt_fence_async(store_root.to_path_buf(), expected, None).await
}

async fn hold_verified_stage_output_fence_async(
    store_root: PathBuf,
    identity: AcceptedStageOutputIdentity,
    plan_fingerprint: String,
) -> Result<fullmag_session::ReadTransaction, ApiError> {
    tokio::task::spawn_blocking(move || {
        let store = fullmag_session::SessionStore::open_existing(&store_root).map_err(|error| {
            accepted_step_output_store_read_error(
                "verified output final store open failed",
                &identity.step_id,
                error,
            )
        })?;
        verify_accepted_stage_output_identity(&store, None, &identity, &plan_fingerprint)
    })
    .await
    .map_err(|error| ApiError::internal(format!("verified output final fence task failed: {error}")))?
}

struct RetainedAcceptedScalarHistory {
    run_id: String,
    rows: Vec<crate::types::ScalarRow>,
    source: crate::types::CurrentScalarSourceState,
}

/// A new accepted predecessor input becomes the stage's M0. Retire the prior
/// solver frame and its spatial caches before publishing it. Same-run scalar
/// history is returned for restoration after domain replacement, with each
/// original observation frame intact.
fn retire_previous_observation_for_step_output(
    snapshot: &mut SessionStateResponse,
) -> Option<RetainedAcceptedScalarHistory> {
    let current_run_id = snapshot
        .run
        .as_ref()
        .map(|run| run.run_id.as_str())
        .unwrap_or(snapshot.session.run_id.as_str());
    let keep_chart_rows = snapshot
        .latest_scalar_source
        .as_ref()
        .and_then(|source| source.series.as_ref())
        .is_some_and(|series| series.identity.run_id == current_run_id);
    let mut scalar_source = keep_chart_rows
        .then(|| snapshot.latest_scalar_source.clone())
        .flatten();
    let retained_history = scalar_source.take().map(|mut source| {
        source.public_source = None;
        source.accepted_live_identity = None;
        source.active_live_identity = None;
        RetainedAcceptedScalarHistory {
            run_id: source
                .series
                .as_ref()
                .expect("same-run scalar source was checked above")
                .identity
                .run_id
                .clone(),
            rows: snapshot.scalar_rows.clone(),
            source,
        }
    });

    crate::session::invalidate_live_magnetization_preview(snapshot);
    crate::session::retire_previous_solver_h_fields(snapshot);
    retained_history
}

fn restore_retained_accepted_scalar_history(
    snapshot: &mut SessionStateResponse,
    history: Option<RetainedAcceptedScalarHistory>,
) {
    let Some(history) = history else {
        return;
    };
    let current_run_id = snapshot
        .run
        .as_ref()
        .map(|run| run.run_id.as_str())
        .unwrap_or(snapshot.session.run_id.as_str());
    if current_run_id != history.run_id {
        return;
    }
    snapshot.scalar_rows = history.rows;
    snapshot.latest_scalar_source = Some(history.source);
}

/// Dense payload encoded outside the live transition lock. Publication binds
/// it to the actual session domain and the committed initial-state revision.
pub(crate) struct PreparedInitialMagnetization {
    start_time_s: f64,
    values_sha256: String,
    field: Value,
}

pub(crate) fn prepare_initial_magnetization(
    execution_plan: &fullmag_ir::ExecutionPlanIR,
) -> Result<Option<PreparedInitialMagnetization>, ApiError> {
    let (values, start_time_s, layout): (Vec<[f64; 3]>, f64, Value) =
        match &execution_plan.backend_plan {
            fullmag_ir::BackendPlanIR::Fdm(plan) => (
                plan.initial_magnetization.clone(),
                plan.time_stage.start_time_s,
                serde_json::json!({"backend": "fdm", "grid_cells": plan.grid.cells}),
            ),
            fullmag_ir::BackendPlanIR::FdmMultilayer(_) => {
                let (values, layout) = prepared_multilayer_initial_state(execution_plan)?;
                (values, 0.0, layout)
            }
            fullmag_ir::BackendPlanIR::Fem(plan) => (
                plan.initial_magnetization.clone(),
                plan.time_stage.start_time_s,
                crate::prepared_observation_bundle::prepared_fem_magnetization_layout(
                    plan.mesh.nodes.len(),
                ),
            ),
            _ => return Ok(None),
        };
    if values.is_empty()
        || values.iter().flatten().any(|value| !value.is_finite())
        || !start_time_s.is_finite()
        || start_time_s < 0.0
    {
        return Err(ApiError::conflict_with_code(
            "accepted_preparation_initial_state_invalid",
            "prepared plan has no finite initial magnetization at a valid stage origin",
        ));
    }
    use sha2::{Digest, Sha256};
    let mut digest = Sha256::new();
    for value in values.iter().flatten() {
        digest.update(value.to_le_bytes());
    }
    Ok(Some(PreparedInitialMagnetization {
        start_time_s,
        values_sha256: format!("{:x}", digest.finalize()),
        field: serde_json::json!({"values": values, "layout": layout}),
    }))
}

impl PreparedInitialMagnetization {
    pub(crate) fn publish(
        self,
        snapshot: &mut SessionStateResponse,
        preparation_id: &str,
        plan_fingerprint: &str,
        scene_revision: u64,
        mut provenance: Value,
        retain_accepted_scalar_series: bool,
    ) -> Result<(), ApiError> {
        let mut publication = crate::live_authored_initial_state::AuthoredInitialStatePublication::new(
            snapshot,
            crate::schemas::common::AuthoredInitialStateOrigin {
                preparation_id: preparation_id.into(),
                plan_fingerprint: plan_fingerprint.into(),
                scene_revision,
                initial_state_revision: snapshot.region_realization_revisions.initial_state,
                values_sha256: self.values_sha256,
            },
            self.start_time_s,
        );
        publication.retain_accepted_scalar_series = retain_accepted_scalar_series;
        provenance["preparation_id"] = preparation_id.into();
        provenance["plan_fingerprint"] = plan_fingerprint.into();
        let mut field = self.field;
        field["source_step"] = 0.into();
        field["source_time_seconds"] = self.start_time_s.into();
        field["source_revision"] = scene_revision.into();
        field["provenance"] = provenance;
        field["observation_frame"] = serde_json::to_value(&publication.frame)
            .map_err(|error| ApiError::internal(format!("encode prepared magnetization frame: {error}")))?;
        let mut fields = crate::types::LatestFields::default();
        fields.insert("m".into(), field);
        crate::session::apply_current_live_authored_initial_state(snapshot, publication, fields)
    }
}

const ACCEPTED_LIVE_PREPARATION_WAIT_TIMEOUT: std::time::Duration =
    std::time::Duration::from_secs(1800);
const ACCEPTED_LIVE_PREPARATION_POLL_INTERVAL: std::time::Duration =
    std::time::Duration::from_millis(250);
const ACCEPTED_LIVE_RUNTIME_FAILURE_POLL_INTERVAL: std::time::Duration =
    std::time::Duration::from_secs(1);

/// Receipt, execution binding and read model produced as one preparation
/// transaction.  The model is intentionally separate from solver execution.
#[derive(Debug)]
pub(crate) struct LiveScenePreparationMaterialization {
    pub receipt: PreparationReceipt,
    pub binding: PreparationBinding,
    pub read_model: LiveScenePreparationReadModel,
}

pub(crate) struct PublishedLiveScenePreparation {
    pub disposition: &'static str,
    pub preparation_id: String,
    pub run_id: String,
    pub plan_fingerprint: String,
    pub receipt_sha256: String,
    pub read_model: LiveScenePreparationReadModel,
}

/// Own the active-Live preparation use case from immutable scene capture
/// through durable publication. The route adapter supplies only the request;
/// session and run identity are captured from the current server snapshot.
pub(crate) async fn materialize_current_live_preparation(
    state: &Arc<AppState>,
    request: CurrentLivePreparationMaterializationRequest,
) -> Result<PublishedLiveScenePreparation, ApiError> {
    let context = crate::capture_current_live_request_context(state).await?;
    if context.session_id != request.session_id {
        return Err(ApiError::conflict(
            "current_live_preparation_materialization_session_mismatch",
        ));
    }

    let (scene_document, expected_run_id) = {
        let current = state.current_live_state.read().await;
        let snapshot = current
            .as_ref()
            .ok_or_else(|| ApiError::not_found("no active local live workspace"))?;
        crate::ensure_current_live_request_context(
            snapshot,
            &context,
            state
                .current_live_session_epoch
                .load(std::sync::atomic::Ordering::Acquire),
        )?;
        ensure_current_preparation_id(snapshot, &request.preparation_id)?;
        let scene_document = snapshot.scene_document.clone().ok_or_else(|| {
            ApiError::not_found("no scene document available for current workspace")
        })?;
        let run_id = snapshot
            .run
            .as_ref()
            .map(|run| run.run_id.clone())
            .unwrap_or_else(|| snapshot.session.run_id.clone());
        (scene_document, run_id)
    };
    if scene_document.revision != request.scene_revision {
        return Err(ApiError::conflict(
            "current_live_preparation_materialization_scene_revision_mismatch",
        ));
    }

    let expected_preparation_id = request.preparation_id.clone();
    let scene_revision = request.scene_revision;
    let materialized = materialize_live_scene_preparation_model(LiveScenePreparationInput {
        repo_root: state.repo_root.clone(),
        workspace_root: state.current_workspace_root.clone(),
        scene_document,
        preparation_id: request.preparation_id,
        scene_revision,
        requested_execution: request.requested_execution,
        display_projection: request.display_projection,
    })
    .await?;
    let LiveScenePreparationMaterialization {
        receipt,
        binding,
        read_model,
    } = materialized;
    let preparation_id = receipt.preparation_id.clone();
    let plan_fingerprint = receipt.plan_fingerprint.clone();
    let run_id = expected_run_id.clone();
    let disposition = commit_live_preparation_receipt_for_context(
        state,
        &context,
        receipt,
        Some(scene_revision),
        Some(&expected_preparation_id),
        Some(&expected_run_id),
    )
    .await?;
    let disposition = match disposition {
        fullmag_session::PreparationReceiptCommitDisposition::Accepted => "accepted",
        fullmag_session::PreparationReceiptCommitDisposition::Replayed => "replayed",
    };
    Ok(PublishedLiveScenePreparation {
        disposition,
        preparation_id,
        run_id,
        plan_fingerprint,
        receipt_sha256: binding.receipt_sha256,
        read_model,
    })
}

/// Prepare a Docker live scene directly from a command while the caller owns
/// the current-live transition fence. This is the mesh/preparation branch of
/// the command dispatcher: it commits the canonical receipt and publishes the
/// same mesh/preparation read model consumed by the existing viewport. It does
/// not create a RunIntent, queue a solver, or wake the legacy scratch worker.
pub(crate) async fn prepare_current_live_scene_with_transition(
    state: &Arc<AppState>,
    context: &CurrentLiveRequestContext,
    command_id: &str,
    command_kind: &str,
) -> Result<PublishedLiveScenePreparation, ApiError> {
    let (
        scene_document,
        run_id,
        requested_execution,
        display_projection,
        preparation_revision,
        existing_preparation,
    ) = {
        let current = state.current_live_state.read().await;
        let snapshot = current
            .as_ref()
            .ok_or_else(|| ApiError::not_found("no active local live workspace"))?;
        crate::ensure_current_live_request_context(
            snapshot,
            context,
            state
                .current_live_session_epoch
                .load(std::sync::atomic::Ordering::Acquire),
        )?;
        let scene_document = snapshot
            .scene_document
            .clone()
            .ok_or_else(|| ApiError::not_found("no scene document available for preparation"))?;
        let requested_execution = RequestedExecution {
            backend: scene_document.study.requested_backend.clone(),
            device: scene_document.study.requested_device.clone(),
            precision: scene_document.study.requested_precision.clone(),
            mode: scene_document.study.requested_mode.clone(),
            minimum_resources: None,
        };
        requested_execution
            .validate()
            .map_err(|error| ApiError::bad_request(error.to_string()))?;
        let display_projection =
            serde_json::to_value(&snapshot.display_selection).map_err(|error| {
                ApiError::internal(format!("failed to encode display projection: {error}"))
            })?;
        let run_id = snapshot
            .run
            .as_ref()
            .map(|run| run.run_id.clone())
            .unwrap_or_else(|| snapshot.session.run_id.clone());
        let preparation_revision = snapshot.simulation_preparation_revision.saturating_add(1);
        let existing_preparation = snapshot.simulation_preparation.as_ref().map(|preparation| {
            (
                preparation.preparation_id.clone(),
                preparation.started_at_unix_ms,
            )
        });
        (
            scene_document,
            run_id,
            requested_execution,
            display_projection,
            preparation_revision,
            existing_preparation,
        )
    };

    let preparation_id = format!(
        "live-prep-{}",
        fullmag_session::hex_sha256(
            format!(
                "{}\0{}\0{}\0{}\0{}",
                state.request_scope_instance_id,
                context.session_id,
                context.session_epoch,
                scene_document.revision,
                command_id,
            )
            .as_bytes(),
        )
    );
    let preparation_started_at_unix_ms = existing_preparation
        .filter(|(existing_id, _)| existing_id == &preparation_id)
        .map(|(_, started_at)| started_at)
        .unwrap_or_else(|| {
            u64::try_from(crate::session::unix_time_millis_now()).unwrap_or(u64::MAX)
        });
    let materialized = materialize_live_scene_preparation_model(LiveScenePreparationInput {
        repo_root: state.repo_root.clone(),
        workspace_root: state.current_workspace_root.clone(),
        scene_document: scene_document.clone(),
        preparation_id: preparation_id.clone(),
        scene_revision: scene_document.revision,
        requested_execution: requested_execution.clone(),
        display_projection,
    })
    .await?;

    let disposition = commit_live_preparation_receipt_for_context_under_transition(
        state,
        context,
        materialized.receipt,
        Some(scene_document.revision),
        None,
        Some(&run_id),
    )
    .await?;
    let disposition = match disposition {
        fullmag_session::PreparationReceiptCommitDisposition::Accepted => "accepted",
        fullmag_session::PreparationReceiptCommitDisposition::Replayed => "replayed",
    };
    let plan_fingerprint = materialized.read_model.plan_fingerprint.clone();
    let read_model = materialized.read_model;
    let receipt_sha256 = materialized.binding.receipt_sha256;
    let now = u64::try_from(crate::session::unix_time_millis_now()).unwrap_or(u64::MAX);
    let execution_plan = serde_json::to_value(&read_model.execution_plan).map_err(|error| {
        ApiError::internal(format!(
            "failed to encode live preparation execution plan: {error}"
        ))
    })?;
    let mesh_workspace = serde_json::json!({
        "schema_version": LIVE_SCENE_PREPARATION_READ_MODEL_SCHEMA,
        "preparation_id": &read_model.preparation_id,
        "source_scene_revision": read_model.scene_revision,
        "plan_fingerprint": &read_model.plan_fingerprint,
        "status": "completed",
        "active_build": null,
        "last_build_error": null,
        "execution_plan": execution_plan,
        "mesh_pipeline_status": [{
            "id": command_kind,
            "status": "completed",
            "detail": "canonical live scene preparation ready",
        }],
    });
    let preparation = SimulationPreparationSnapshot {
        preparation_id: preparation_id.clone(),
        revision: preparation_revision,
        status: "ready".into(),
        active_stage_id: None,
        started_at_unix_ms: preparation_started_at_unix_ms,
        completed_at_unix_ms: Some(now),
        stages: canonical_completed_preparation_stages(
            now,
            "canonical live preparation receipt committed",
        ),
        log_tail: vec![canonical_ready_preparation_log(
            now,
            "canonical live authored model preparation ready; Compute has not run",
        )],
        failure: None,
    };
    {
        let mut current = state.current_live_state.write().await;
        let snapshot = current
            .as_mut()
            .ok_or_else(|| ApiError::not_found("no active local live workspace"))?;
        crate::ensure_current_live_request_context(
            snapshot,
            context,
            state
                .current_live_session_epoch
                .load(std::sync::atomic::Ordering::Acquire),
        )?;
        let (metadata, fem_mesh) = prepared_domain_publication(snapshot, &read_model)?;
        let session_status = preparation_session_status(snapshot);
        let mut prepared_snapshot = snapshot.clone();
        crate::live_authored_damping::retire_for_prepared_domain(&mut prepared_snapshot);
        crate::session::apply_current_live_snapshot(
            &mut prepared_snapshot,
            CurrentLiveSnapshotRequest {
                session_id: context.session_id.clone(),
                session: None,
                session_status,
                metadata: Some(metadata),
                mesh_workspace: Some(mesh_workspace),
                stage_execution: None,
                simulation_preparation: Some(preparation),
                run: None,
                live_state: None,
                frozen_spins_runtime_status: None,
                coupled_checkpoint: None,
                latest_scalar_row: None,
                latest_fields: None,
                replace_latest_fields: false,
                field_generation: None,
                preview_fields: None,
                clear_preview_cache: false,
                engine_log: None,
                solver_profile: None,
                fem_mesh,
            },
        )?;
        publish_prepared_initial_state(&mut prepared_snapshot, &read_model, false)?;
        *snapshot = prepared_snapshot;
    }
    if let Some(snapshot) = state.current_live_state.read().await.as_ref().cloned() {
        let display_revision = state.current_display_selection.read().await.revision;
        let realtime_state =
            crate::current_live_realtime_state_from_snapshot(state, &snapshot, display_revision)
                .await;
        crate::publish_current_live_realtime_batch_changed(state, &realtime_state, false, 0)
            .await?;
    }
    Ok(PublishedLiveScenePreparation {
        disposition,
        preparation_id,
        run_id,
        plan_fingerprint,
        receipt_sha256,
        read_model,
    })
}

/// Wait for the dependency-ready accepted Study frontier and publish its
/// immutable preparation receipt into the existing live read model.
///
/// The accepted run may contain many authored stages, but only the first
/// topological frontier can be shown before Compute: later stages can require
/// StepOutput values that do not exist yet. This helper therefore preserves
/// the complete Study in durable storage while publishing exactly one
/// model/mesh preparation for the current live view. FEM receipts arrive from
/// the admitted native preparation scheduler; FDM receipts are materialized by
/// the accepted RunIntent catalog path. No queue, claim, lease, or solver is
/// created here. Callers must release the current-session transition before
/// awaiting this helper; each publication attempt acquires and revalidates
/// that fence independently, allowing Stop and session replacement to proceed.
pub(crate) async fn publish_accepted_frontier_preparation(
    state: &Arc<AppState>,
    context: &CurrentLiveRequestContext,
    command_kind: &str,
    mesh_command_id: Option<&str>,
) -> Result<PublishedLiveScenePreparation, ApiError> {
    let run_id = {
        let current = state.current_live_state.read().await;
        let snapshot = current
            .as_ref()
            .ok_or_else(|| ApiError::not_found("no active local live workspace"))?;
        crate::ensure_current_live_request_context(
            snapshot,
            context,
            state
                .current_live_session_epoch
                .load(std::sync::atomic::Ordering::Acquire),
        )?;
        snapshot
            .run
            .as_ref()
            .map(|run| run.run_id.clone())
            .ok_or_else(|| {
                ApiError::conflict_with_code(
                    "accepted_preparation_current_run_missing",
                    "accepted preparation requires the current durable live run",
                )
            })?
    };
    let Some(store_root) = state.submit_store_root.clone() else {
        return Err(ApiError::with_status_and_code(
            axum::http::StatusCode::SERVICE_UNAVAILABLE,
            "accepted_preparation_store_unavailable",
            "accepted preparation requires the configured durable run store",
        ));
    };
    let run_id_for_worker = run_id.clone();
    let command_kind_for_worker = command_kind.to_owned();
    let (run_id, step_id) = tokio::task::spawn_blocking(move || {
        let store = fullmag_session::SessionStore::open_existing(&store_root).map_err(|error| {
            ApiError::with_status_and_code(
                axum::http::StatusCode::SERVICE_UNAVAILABLE,
                "accepted_preparation_store_unavailable",
                format!("failed to open accepted preparation store: {error}"),
            )
        })?;
        let typed_run_id = fullmag_application::RunId::parse(run_id_for_worker.clone())
            .map_err(|error| ApiError::bad_request(format!("accepted run id is invalid: {error}")))?;
        let intent = store
            .read_run_intent(typed_run_id.as_str())
            .map_err(|error| {
                ApiError::conflict(format!(
                    "accepted preparation RunIntent read failed: {error}"
                ))
            })?
            .context("accepted preparation RunIntent is missing")
            .map_err(|error| ApiError::conflict(error.to_string()))?;
        let project_id = crate::live_accepted_execution::accepted_project_id_from_intent(
            &intent,
            &typed_run_id,
        )
        .map_err(|error| {
            ApiError::conflict_with_code(
                "accepted_preparation_snapshot_invalid",
                format!("accepted preparation RunIntent is not typed: {error:#}"),
            )
        })?;
        let accepted = fullmag_runtime_control::load_accepted_study_snapshot(
            &store,
            &typed_run_id,
            &project_id,
        )
        .map_err(|error| {
            ApiError::conflict_with_code(
                "accepted_preparation_snapshot_invalid",
                format!("accepted preparation snapshot validation failed: {error:#}"),
            )
        })?;
        // Both private restore callers validate their own distinct authority
        // before reaching this exact existing anchor projection. This branch
        // grants no restore authority and never releases or executes a task.
        let step_id = if matches!(
            command_kind_for_worker.as_str(),
            "accepted_run_reattach" | "isolated_snapshot_restore"
        ) {
            let anchor = store
                .read_preparation_receipt(typed_run_id.as_str())
                .map_err(|error| {
                    ApiError::conflict(format!(
                        "accepted preparation anchor read failed: {error}"
                    ))
                })?
                .context("accepted preparation anchor is missing")
                .map_err(|error| ApiError::conflict(error.to_string()))?;
            anchor
                .validate()
                .map_err(|error| ApiError::conflict(format!("accepted preparation anchor is invalid: {error}")))?;
            let application: fullmag_application::PreparationReceipt =
                serde_json::from_value(anchor.payload.clone()).map_err(|error| {
                    ApiError::conflict(format!(
                        "accepted preparation anchor is not an application receipt: {error}"
                    ))
                })?;
            application.validate().map_err(|error| {
                ApiError::conflict(format!("accepted preparation anchor is invalid: {error}"))
            })?;
            let source = application
                .accepted_run_source
                .as_ref()
                .ok_or_else(|| {
                    ApiError::conflict(
                        "accepted preparation anchor has no accepted-run source",
                    )
                })?;
            if source.run_id != typed_run_id {
                return Err(ApiError::conflict(
                    "accepted preparation anchor source run differs from current run",
                ));
            }
            let step = accepted
                .lowered
                .steps
                .iter()
                .find(|step| step.step_id == source.step_id)
                .ok_or_else(|| {
                    ApiError::conflict(
                        "accepted preparation anchor references an unknown study step",
                    )
                })?;
            if !matches!(
                step.status,
                fullmag_plan::StudyStepLoweringStatus::Planned
            ) {
                return Err(ApiError::conflict(
                    "accepted preparation anchor references a non-planned study step",
                ));
            }
            let ready = fullmag_runtime_control::accepted_run_step_is_scheduler_ready_from_snapshot(
                &store,
                &typed_run_id,
                &source.step_id,
                &accepted,
            )
            .map_err(|error| {
                ApiError::conflict(format!(
                    "accepted preparation anchor readiness validation failed: {error}"
                ))
            })?;
            if !ready {
                return Err(ApiError::conflict(
                    "accepted preparation anchor is not scheduler-ready",
                ));
            }
            source.step_id.clone()
        } else {
            let mut selected = None;
            for step in accepted
                .lowered
                .steps
                .iter()
                .filter(|step| {
                    matches!(step.status, fullmag_plan::StudyStepLoweringStatus::Planned)
                })
            {
                if fullmag_runtime_control::accepted_run_step_is_preparation_frontier_from_snapshot(
                    &store,
                    &typed_run_id,
                    &step.step_id,
                    &accepted,
                )
                .map_err(|error| {
                    ApiError::conflict(format!(
                        "accepted preparation readiness validation failed: {error}"
                    ))
                })? {
                    selected = Some(step.step_id.clone());
                    break;
                }
            }
            if selected.is_none() {
                // Preparation may advance between scans. History identifies
                // a candidate only; recheck lifecycle, dependencies and inputs
                // before publishing it as the current live frontier.
                let launches = store
                    .list_preparation_process_launches(typed_run_id.as_str())
                    .map_err(|error| {
                        ApiError::conflict(format!(
                            "accepted preparation launches cannot be read: {error}"
                        ))
                    })?;
                for step in accepted.lowered.steps.iter().filter(|step| {
                    matches!(step.status, fullmag_plan::StudyStepLoweringStatus::Planned)
                }) {
                    let task_id = fullmag_session::task_id_for_study_step(
                        typed_run_id.as_str(),
                        &step.step_id,
                    )
                    .map_err(|error| ApiError::conflict(error.to_string()))?;
                    let launched = launches
                        .iter()
                        .any(|launch| launch.task_id == task_id.as_str());
                    let prepared = store
                        .read_task_preparation_receipt(typed_run_id.as_str(), task_id.as_str())
                        .map_err(|error| ApiError::conflict(error.to_string()))?
                        .is_some();
                    if (launched || prepared)
                        && fullmag_runtime_control::accepted_run_step_is_preparation_frontier_from_snapshot(
                            &store,
                            &typed_run_id,
                            &step.step_id,
                            &accepted,
                        )
                        .map_err(|error| {
                            ApiError::conflict(format!(
                                "accepted preparation candidate validation failed: {error}"
                            ))
                        })?
                    {
                        selected = Some(step.step_id.clone());
                        break;
                    }
                }
            }
            selected.ok_or_else(|| {
                ApiError::unprocessable_with_code(
                    "accepted_preparation_frontier_missing",
                    "accepted Study has no dependency-ready preparation frontier",
                )
            })?
        };
        Ok::<_, ApiError>((run_id_for_worker, step_id))
    })
    .await
    .map_err(|error| ApiError::internal(format!("accepted preparation frontier task failed: {error}")))??;

    if command_kind == "startup" {
        let _transition = state.current_live_session_transition.lock().await;
        crate::docker_startup::bind_startup_frontier_progress_under_transition(
            state, context, &run_id, &step_id,
        )
        .await?;
    }
    let deadline = std::time::Instant::now() + ACCEPTED_LIVE_PREPARATION_WAIT_TIMEOUT;
    let mut next_runtime_failure_observation = std::time::Instant::now();
    loop {
        // The bridge holds the transition only for its initial identity
        // capture and final CAS/commit. Native preparation may take minutes;
        // Stop and session replacement remain available during store reads.
        let publication = publish_accepted_task_preparation_with_mode(
            state,
            context,
            &run_id,
            &step_id,
            command_kind,
            AcceptedPreparationPublicationMode::Active,
            mesh_command_id,
            None,
        )
        .await;
        match publication {
            Ok(published) => return Ok(published),
            Err(error) if error.code.as_deref() == Some("accepted_preparation_pending") => {
                if let Some(reason) = state.development_admission.runtime_failure_reason() {
                    return Err(accepted_preparation_runtime_failure(reason));
                }
                if std::time::Instant::now() >= next_runtime_failure_observation {
                    // A confirmed native owner failure is terminal for this
                    // preparation wait. Starting/unknown/failed observations
                    // are deliberately not conflated: transient liveness or
                    // writer contention keeps the existing pending behavior.
                    let observed = crate::router_v2::handlers::platform::runtime_service::observe_runtime_service(state)
                        .await;
                    next_runtime_failure_observation = std::time::Instant::now()
                        + ACCEPTED_LIVE_RUNTIME_FAILURE_POLL_INTERVAL;
                    if let Ok(status) = observed {
                        if status.state
                            == crate::schemas::runtime_service::RuntimeServiceStatusState::Failed
                        {
                            return Err(accepted_preparation_runtime_failure(
                                &status.reason.message,
                            ));
                        }
                    }
                }
                if std::time::Instant::now() >= deadline {
                    return Err(ApiError::with_status_and_code(
                        axum::http::StatusCode::SERVICE_UNAVAILABLE,
                        "accepted_preparation_timeout",
                        format!(
                            "accepted preparation frontier did not reach a durable receipt within {} seconds",
                            ACCEPTED_LIVE_PREPARATION_WAIT_TIMEOUT.as_secs()
                        ),
                    ));
                }
                tokio::time::sleep(ACCEPTED_LIVE_PREPARATION_POLL_INTERVAL).await;
            }
            Err(error)
                if error.code.as_deref()
                    == Some("accepted_preparation_current_state_changed") =>
            {
                if std::time::Instant::now() >= deadline {
                    return Err(ApiError::with_status_and_code(
                        axum::http::StatusCode::SERVICE_UNAVAILABLE,
                        "accepted_preparation_timeout",
                        format!(
                            "current live preparation inputs did not stabilize within {} seconds",
                            ACCEPTED_LIVE_PREPARATION_WAIT_TIMEOUT.as_secs()
                        ),
                    ));
                }
                tokio::time::sleep(ACCEPTED_LIVE_PREPARATION_POLL_INTERVAL).await;
            }
            Err(error) => return Err(error),
        }
    }
}

fn accepted_preparation_runtime_failure(reason: &str) -> ApiError {
    ApiError::with_status_and_code(
        axum::http::StatusCode::SERVICE_UNAVAILABLE,
        "accepted_preparation_runtime_failed",
        format!(
            "native runtime failed before the accepted preparation receipt was published: {reason}"
        ),
    )
}

/// Session status published with a preparation receipt. Preparation of a new
/// stage frontier may be published while the accepted run is executing; it
/// must not flip that session back to `awaiting_command` (the projector would
/// only restore `running` on its next tick, causing status/control flicker).
/// Before execution the established `awaiting_command` publication remains.
fn preparation_session_status(snapshot: &SessionStateResponse) -> Option<String> {
    let executing = |status: &str| {
        matches!(
            status,
            "running" | "paused" | "breaking" | "queued" | "dispatched" | "claimed"
        )
    };
    if executing(&snapshot.session.status)
        || snapshot
            .run
            .as_ref()
            .is_some_and(|run| executing(&run.status))
    {
        None
    } else {
        Some("awaiting_command".into())
    }
}

pub(crate) fn ensure_preparation_run_is_active(snapshot: &SessionStateResponse) -> Result<(), ApiError> {
    let stopped = |status: &str| {
        matches!(
            status,
            "stopping" | "stopped" | "cancelled" | "failed" | "completed" | "closed"
        )
    };
    if stopped(&snapshot.session.status)
        || snapshot
            .run
            .as_ref()
            .is_some_and(|run| stopped(&run.status))
    {
        return Err(ApiError::conflict_with_code(
            "accepted_preparation_run_stopped",
            "accepted preparation cannot publish after Stop or terminal completion",
        ));
    }
    Ok(())
}

// Normal pending polls avoid rebuilding the immutable Study. A failed exit
// triggers the same task-level proof validation used by development restore.
fn observe_accepted_preparation_failure(
    store: &fullmag_session::SessionStore,
    run_id: &fullmag_application::RunId,
    step_id: &str,
    task_id: &str,
    specification: &fullmag_application::RunSpecification,
) -> anyhow::Result<Option<serde_json::Value>> {
    if !store.list_preparation_process_exit_receipts(run_id.as_str())?.iter()
        .any(|receipt| receipt.task_id == task_id && !receipt.status_success)
    {
        return Ok(None);
    }
    let accepted = fullmag_runtime_control::load_accepted_study_snapshot(
        store, run_id, &specification.snapshot.project_id,
    )?;
    let step = accepted.lowered.steps.iter().find(|step| {
        step.step_id == step_id && step.enabled
            && matches!(step.status, fullmag_plan::StudyStepLoweringStatus::Planned)
    }).context("failed preparation task is not a planned accepted Study step")?;
    let planned_inputs = std::collections::BTreeMap::from([(
        task_id.to_owned(),
        (step_id.to_owned(), fullmag_application::study_task_input_fingerprint(
            &accepted.run.specification, step,
        )?),
    )]);
    let _snapshot = store.write_transaction()?;
    if store.read_run_intent(run_id.as_str())?.as_ref() != Some(&accepted.run.intent) {
        anyhow::bail!("accepted run intent changed while reading preparation failure");
    }
    // The supervisor commits its exit before finalizing its lease. That brief
    // interval is pending, not a corrupt proof and not a completed failure.
    for receipt in store.list_preparation_process_exit_receipts(run_id.as_str())?
        .iter().filter(|receipt| receipt.task_id == task_id && !receipt.status_success)
    {
        if let Some(lease) = store.read_preparation_resource_lease(
            run_id.as_str(), &receipt.resource_id, &receipt.lease_token,
        )? {
            if lease.state == fullmag_session::FmsResourceLeaseState::Active {
                receipt.validate_for_lease(&lease)?;
                return Ok(None);
            }
        }
    }
    let catalog = store.read_run_catalog(run_id.as_str())?
        .context("accepted preparation run catalog is missing")?;
    let task = catalog.tasks.iter().find(|task| task.task_id == task_id)
        .context("accepted preparation task is missing")?;
    crate::development_accepted_restore::load_task_preparation_failure(
        store, run_id.as_str(), task, &planned_inputs,
    )
}

/// Publish preparation that was produced by the accepted task lane.
///
/// The accepted FEM preparer is the only component allowed to create native
/// mesh/space evidence.  Consequently the live API cannot re-materialize a
/// FEM receipt from the current scene after a RunIntent is accepted.  This
/// bridge reads the immutable task receipt and the pinned execution plan,
/// validates both through `AcceptedStudySnapshot`, and only then binds the
/// receipt to the current-live read model.  FDM uses the same path when its
/// accepted preparation receipt is already available, keeping the two lanes
/// on one publication contract.
/// The transition fence is held only while capturing the current publication
/// identity and for the final CAS/commit. Durable snapshot, plan, and task
/// receipt validation runs without the transition lock so large accepted
/// catalogs cannot stall current-session resource reads.
pub(crate) async fn publish_accepted_task_preparation(
    state: &Arc<AppState>,
    context: &CurrentLiveRequestContext,
    run_id: &str,
    step_id: &str,
    command_kind: &str,
) -> Result<PublishedLiveScenePreparation, ApiError> {
    publish_accepted_task_preparation_with_mode(
        state, context, run_id, step_id, command_kind, AcceptedPreparationPublicationMode::Active, None, None,
    ).await
}

/// Publish a live stage domain only for the exact worker attempt whose
/// observation header triggered the request.
pub(crate) async fn publish_accepted_task_preparation_for_observation(
    state: &Arc<AppState>,
    context: &CurrentLiveRequestContext,
    header: &crate::accepted_study_worker::AcceptedLiveObservationHeader,
) -> Result<PublishedLiveScenePreparation, ApiError> {
    let target = AcceptedTaskAttemptIdentity::from_live_header(header)?;
    let run_id = target.run_id.clone();
    let step_id = target.step_id.clone();
    publish_accepted_task_preparation_with_mode(
        state,
        context,
        &run_id,
        &step_id,
        "accepted_projection_stage_preparation",
        AcceptedPreparationPublicationMode::ActiveObservation(target),
        None,
        None,
    )
    .await
}

type AcceptedVerifiedOutputInstaller<'a> = Box<
    dyn FnOnce(
            &mut SessionStateResponse,
            &LiveScenePreparationReadModel,
        ) -> Result<(), ApiError>
        + Send
        + 'a,
>;

/// Publish only the accepted domain for a terminal stage whose exact output
/// has already been verified. This path never invents an M0 or starts a task.
pub(crate) async fn publish_accepted_task_domain_for_output<'a>(
    state: &Arc<AppState>,
    context: &CurrentLiveRequestContext,
    identity: AcceptedStageOutputIdentity,
    install_verified_output: impl FnOnce(
            &mut SessionStateResponse,
            &LiveScenePreparationReadModel,
        ) -> Result<(), ApiError>
        + Send
        + 'a,
) -> Result<PublishedLiveScenePreparation, ApiError> {
    let run_id = identity.run_id.clone();
    let step_id = identity.step_id.clone();
    publish_accepted_task_preparation_with_mode(
        state,
        context,
        &run_id,
        &step_id,
        "accepted_projection_stage_preparation",
        AcceptedPreparationPublicationMode::VerifiedOutput(identity),
        None,
        Some(Box::new(install_verified_output)),
    )
    .await
}

/// Reconstruct only the domain read-model of an authenticated terminal restore.
/// The immutable accepted plan and native preparation receipts are still fully
/// checked; this path never schedules work or authorizes Start.
pub(crate) async fn restore_terminal_task_domain(
    state: &Arc<AppState>,
    context: &CurrentLiveRequestContext,
    run_id: &str,
    step_id: &str,
) -> Result<PublishedLiveScenePreparation, ApiError> {
    let identity = state.accepted_run_reattach_identity.read().await.clone()
        .ok_or_else(|| ApiError::conflict("terminal domain restore has no process-local authority"))?;
    publish_accepted_task_preparation_with_mode(
        state, context, run_id, step_id, "accepted_projection_stage_preparation",
        AcceptedPreparationPublicationMode::TerminalObservation(identity),
        None,
        None,
    ).await
}

/// Restore a terminal domain after API restart only with the process-local
/// reattachment authority and an exact, already decoded accepted output.
pub(crate) async fn restore_terminal_task_domain_for_output<'a>(
    state: &Arc<AppState>,
    context: &CurrentLiveRequestContext,
    identity: AcceptedStageOutputIdentity,
    install_verified_output: impl FnOnce(
            &mut SessionStateResponse,
            &LiveScenePreparationReadModel,
        ) -> Result<(), ApiError>
        + Send
        + 'a,
) -> Result<PublishedLiveScenePreparation, ApiError> {
    let reattach = state
        .accepted_run_reattach_identity
        .read()
        .await
        .clone()
        .ok_or_else(|| ApiError::conflict("terminal domain restore has no process-local authority"))?;
    let run_id = identity.run_id.clone();
    let step_id = identity.step_id.clone();
    publish_accepted_task_preparation_with_mode(
        state,
        context,
        &run_id,
        &step_id,
        "accepted_projection_stage_preparation",
        AcceptedPreparationPublicationMode::TerminalVerifiedOutput {
            reattach,
            output: identity,
        },
        None,
        Some(Box::new(install_verified_output)),
    )
    .await
}

async fn publish_accepted_task_preparation_with_mode(
    state: &Arc<AppState>,
    context: &CurrentLiveRequestContext,
    run_id: &str,
    step_id: &str,
    command_kind: &str,
    mode: AcceptedPreparationPublicationMode,
    mesh_command_id: Option<&str>,
    output_installer: Option<AcceptedVerifiedOutputInstaller<'_>>,
) -> Result<PublishedLiveScenePreparation, ApiError> {
    let terminal_observation = mode.is_terminal_observation();
    let verified_output_only = mode.is_verified_output_only();
    if verified_output_only != output_installer.is_some() {
        return Err(ApiError::conflict_with_code(
            "accepted_preparation_output_identity_invalid",
            "verified output preparation requires one atomic output installer",
        ));
    }
    let (fence, scene_revision, display_projection, preparation_revision, existing_preparation) = {
        let _transition = state.current_live_session_transition.lock().await;
        let current = state.current_live_state.read().await;
        let snapshot = current
            .as_ref()
            .ok_or_else(|| ApiError::not_found("no active local live workspace"))?;
        let session_epoch = state
            .current_live_session_epoch
            .load(std::sync::atomic::Ordering::Acquire);
        let active_run_id = snapshot
            .run
            .as_ref()
            .map(|run| run.run_id.as_str())
            .unwrap_or(snapshot.session.run_id.as_str());
        if active_run_id != run_id {
            return Err(ApiError::conflict(
                "accepted_preparation_current_run_mismatch",
            ));
        }
        let fence = match &mode {
            AcceptedPreparationPublicationMode::Active =>
                AcceptedPreparationPublicationFence::capture(snapshot, context, session_epoch)?,
            AcceptedPreparationPublicationMode::ActiveObservation(_)
            | AcceptedPreparationPublicationMode::VerifiedOutput(_)
            | AcceptedPreparationPublicationMode::TerminalObservation(_)
            | AcceptedPreparationPublicationMode::TerminalVerifiedOutput { .. } =>
                AcceptedPreparationPublicationFence::capture_with_mode(
                    snapshot, context, session_epoch, mode.clone(),
                )?,
        };
        let scene_revision = fence.scene_revision;
        let display_projection = fence.display_projection.clone();
        let existing_preparation = snapshot.simulation_preparation.clone();
        (
            fence,
            scene_revision,
            display_projection,
            snapshot.simulation_preparation_revision.saturating_add(1),
            existing_preparation,
        )
    };

    let Some(store_root) = state.submit_store_root.clone() else {
        return Err(ApiError::with_status_and_code(
            axum::http::StatusCode::SERVICE_UNAVAILABLE,
            "accepted_preparation_store_unavailable",
            "accepted preparation requires the configured durable run store",
        ));
    };
    let run_id_for_worker = run_id.to_owned();
    let step_id_for_worker = step_id.to_owned();
    let mode_for_worker = mode.clone();
    let final_fence_store_root = store_root.clone();
    let observed_preparation_started_at_unix_ms =
        u64::try_from(crate::session::unix_time_millis_now()).unwrap_or(u64::MAX);
    let materialized = tokio::task::spawn_blocking(move || {
        let store = fullmag_session::SessionStore::open_existing(&store_root).map_err(|error| {
            if accepted_store_read_is_transient(&error) {
                accepted_step_output_store_read_error(
                    "accepted preparation store open failed",
                    &step_id_for_worker,
                    error,
                )
            } else {
                ApiError::with_status_and_code(
                    axum::http::StatusCode::SERVICE_UNAVAILABLE,
                    "accepted_preparation_store_unavailable",
                    format!("failed to open accepted preparation store: {error}"),
                )
            }
        })?;
        let typed_run_id = fullmag_application::RunId::parse(run_id_for_worker.clone())
            .map_err(|error| ApiError::bad_request(format!("accepted run id is invalid: {error}")))?;
        let intent = store
            .read_run_intent(typed_run_id.as_str())
            .map_err(|error| accepted_preparation_store_read_error(
                "accepted preparation RunIntent read failed",
                &step_id_for_worker,
                error,
                "accepted_preparation_snapshot_invalid",
            ))?
            .ok_or_else(|| {
                ApiError::conflict_with_code(
                    "accepted_preparation_run_missing",
                    "accepted preparation has no durable RunIntent",
                )
            })?;
        let specification: fullmag_application::RunSpecification =
            serde_json::from_value(intent.specification.clone()).map_err(|error| {
                ApiError::conflict(format!(
                    "accepted preparation RunSpec is not typed: {error}"
                ))
            })?;
        if specification.run_id != typed_run_id {
            return Err(ApiError::conflict(
                "accepted preparation RunSpec run identity mismatch",
            ));
        }
        let task_id = fullmag_session::task_id_for_study_step(
            typed_run_id.as_str(),
            &step_id_for_worker,
        )
        .map_err(|error| ApiError::bad_request(format!("accepted step id is invalid: {error}")))?;
        // An absent success receipt may mean pending or a failed native
        // process; validate durable failure evidence before waiting. Once an
        // envelope exists, every
        // decode, CAS, plan, certificate, and accepted-run binding error is a
        // durable integrity failure and must surface immediately; mapping it
        // to pending would hide tampering or invalid native evidence behind a
        // thirty-minute wait while the manual Compute gate remains closed.
        if store
            .read_task_preparation_receipt(typed_run_id.as_str(), &task_id)
            .map_err(|error| accepted_preparation_store_read_error(
                "accepted task preparation receipt read failed",
                &step_id_for_worker,
                error,
                "accepted_preparation_receipt_invalid",
            ))?
            .is_none()
        {
            let failure = observe_accepted_preparation_failure(
                &store, &typed_run_id, &step_id_for_worker, &task_id, &specification,
            ).map_err(|error| {
                if accepted_store_read_is_transient(&error) {
                    ApiError::with_status_and_code(
                        axum::http::StatusCode::SERVICE_UNAVAILABLE,
                        "accepted_preparation_pending",
                        "accepted preparation evidence is being updated",
                    )
                } else {
                    ApiError::conflict_with_code(
                        "accepted_preparation_receipt_invalid",
                        format!("accepted preparation failure evidence is invalid: {error:#}"),
                    )
                }
            })?;
            if let Some(failure) = failure {
                return Err(ApiError::unprocessable_with_code(
                    "accepted_preparation_process_failed",
                    format!("{} (preparation exit receipt: {})",
                        failure["error"].as_str().unwrap_or("preparation failed"),
                        failure["exit_receipt_id"].as_str().unwrap_or_default()),
                ));
            }
            return Err(ApiError::with_status_and_code(
                axum::http::StatusCode::SERVICE_UNAVAILABLE,
                "accepted_preparation_pending",
                format!(
                    "accepted task preparation receipt is not ready for `{step_id_for_worker}`"
                ),
            ));
        }
        // Pending polls hold the live transition fence. Do not repeatedly
        // reconstruct a large inline FEM plan while there is no receipt to
        // publish. Existing envelopes still require the complete immutable
        // snapshot, plan, and native evidence validation below.
        let accepted = fullmag_runtime_control::load_accepted_study_snapshot(
            &store,
            &typed_run_id,
            &specification.snapshot.project_id,
        )
        .map_err(|error| {
            accepted_preparation_store_read_error(
                "accepted preparation snapshot validation failed",
                &step_id_for_worker,
                error,
                "accepted_preparation_snapshot_invalid",
            )
        })?;
        let execution_plan = accepted
            .lowered
            .steps
            .iter()
            .find(|step| step.step_id == step_id_for_worker)
            .and_then(|step| step.execution_plan.clone())
            .ok_or_else(|| {
                ApiError::conflict_with_code(
                    "accepted_preparation_plan_missing",
                    "accepted preparation step has no canonical execution plan",
                )
            })?;
        let receipt = accepted
            .read_task_preparation(&store, &task_id)
            .map_err(|error| accepted_preparation_store_read_error(
                "accepted task preparation receipt validation failed",
                &step_id_for_worker,
                error,
                "accepted_preparation_receipt_invalid",
            ))?;
        let verified_output_identity = match &mode_for_worker {
            AcceptedPreparationPublicationMode::VerifiedOutput(identity)
            | AcceptedPreparationPublicationMode::TerminalVerifiedOutput { output: identity, .. } => {
                let _read_fence = verify_accepted_stage_output_identity(
                    &store,
                    Some(&accepted),
                    identity,
                    receipt.plan_fingerprint(),
                )?;
                Some(identity.clone())
            }
            _ => None,
        };
        let accepted_initial_state = if !mode_for_worker.resolves_step_initial_state() {
            None
        } else {
            prepare_accepted_step_output_initial_state(
                &store,
                &accepted,
                &task_id,
                &step_id_for_worker,
                &execution_plan,
                &receipt,
                mode_for_worker.target_attempt().as_ref(),
            )?
        };
        let entry = accepted.catalog.entries().iter().find(|entry| entry.step_id() == step_id_for_worker)
            .ok_or_else(|| ApiError::conflict("accepted preparation has no pinned ProblemIR"))?;
        let global_sampling_mesh = antenna_domain::pinned_global_mesh(entry.problem(), &execution_plan)?;
        Ok::<_, ApiError>((
            receipt,
            execution_plan,
            specification.requested_execution,
            global_sampling_mesh,
            accepted_initial_state,
            verified_output_identity,
        ))
    })
    .await
    .map_err(|error| ApiError::internal(format!("accepted preparation task failed: {error}")))??;

    let (
        receipt,
        execution_plan,
        requested_execution,
        global_sampling_mesh,
        accepted_initial_state,
        verified_output_identity,
    ) = materialized;
    let expected_initial_state_claim = accepted_initial_state
        .as_ref()
        .map(|prepared| prepared.claim.clone());
    let validated_source =
        ValidatedAcceptedPreparationSource::from_validated_receipt(run_id, &receipt)?;
    let preparation_id = receipt.preparation_id().to_owned();
    let existing_preparation = existing_preparation
        .filter(|existing| existing.preparation_id == preparation_id);
    let preparation_started_at_unix_ms = existing_preparation
        .as_ref()
        .map(|existing| existing.started_at_unix_ms)
        .unwrap_or(observed_preparation_started_at_unix_ms);
    let plan_fingerprint = receipt.plan_fingerprint().to_owned();
    let binding = receipt.binding().map_err(|error| {
        ApiError::conflict(format!("accepted preparation binding is invalid: {error}"))
    })?;
    let read_model = LiveScenePreparationReadModel {
        schema_version: LIVE_SCENE_PREPARATION_READ_MODEL_SCHEMA,
        preparation_id: preparation_id.clone(),
        scene_revision,
        plan_fingerprint: plan_fingerprint.clone(),
        requested_execution,
        execution_plan,
        global_sampling_mesh,
    };

    let now = u64::try_from(crate::session::unix_time_millis_now()).unwrap_or(u64::MAX);
    let execution_plan_value =
        serde_json::to_value(&read_model.execution_plan).map_err(|error| {
            ApiError::internal(format!("failed to encode accepted execution plan: {error}"))
        })?;
    let mut mesh_workspace = serde_json::json!({
        "schema_version": LIVE_SCENE_PREPARATION_READ_MODEL_SCHEMA,
        "preparation_id": &read_model.preparation_id,
        "source_scene_revision": read_model.scene_revision,
        "plan_fingerprint": &read_model.plan_fingerprint,
        "status": "completed",
        "active_build": null,
        "last_build_error": null,
        "execution_plan": execution_plan_value,
        "display_projection": display_projection,
        "accepted_run_id": run_id,
        "accepted_step_id": step_id,
        "mesh_pipeline_status": [{
            "id": command_kind,
            "status": "completed",
            "detail": "accepted task preparation receipt ready",
        }],
    });
    if let Some(command_id) = mesh_command_id {
        mesh_workspace["last_build_summary"] = serde_json::json!({
            "command_id": command_id,
            "build_id": format!("mesh:{command_id}"),
            "status": "completed",
            "source_scene_revision": read_model.scene_revision,
            "preparation_id": &read_model.preparation_id,
        });
    }
    if let Some(target) = mode.target_attempt() {
        mesh_workspace["accepted_task_id"] = target.task_id.into();
        mesh_workspace["accepted_attempt_id"] = target.attempt_id.into();
        mesh_workspace["accepted_ownership_epoch"] = target.ownership_epoch.into();
    }
    let mut completed_stages = canonical_completed_preparation_stages(
        now, "accepted task preparation receipt committed",
    );
    if let Some(existing) = existing_preparation.as_ref() {
        for previous in &existing.stages {
            if let Some(stage) = completed_stages.iter_mut().find(|stage| {
                stage.id == previous.id && stage.id != "ready" && stage.id != "solver_initialization"
            }) {
                if previous.status == "completed" {
                    stage.started_at_unix_ms = previous.started_at_unix_ms;
                    stage.completed_at_unix_ms = previous.completed_at_unix_ms;
                    stage.duration_ms = previous.duration_ms;
                    stage.clock_adjustment = previous.clock_adjustment.clone();
                } else if previous.status == "active" {
                    stage.started_at_unix_ms = previous.started_at_unix_ms;
                    stage.completed_at_unix_ms = Some(now);
                    stage.duration_ms = previous.started_at_unix_ms.and_then(|start| now.checked_sub(start));
                }
            }
        }
    }
    let ready_log = if terminal_observation || verified_output_only {
        "verified accepted domain restored; no solver was restarted"
    } else {
        "accepted task authored model preparation ready; Compute has not run"
    };
    let mut preparation_log = existing_preparation.as_ref()
        .map(|existing| existing.log_tail.clone()).unwrap_or_default();
    if !preparation_log.last().is_some_and(|entry| entry.stage_id == "ready" && entry.message == ready_log) {
        preparation_log.push(canonical_ready_preparation_log(now, ready_log));
    }
    if preparation_log.len() > 128 {
        preparation_log.drain(..preparation_log.len() - 128);
    }
    let preparation = SimulationPreparationSnapshot {
        preparation_id: preparation_id.clone(),
        revision: preparation_revision,
        status: "ready".into(),
        active_stage_id: None,
        started_at_unix_ms: preparation_started_at_unix_ms,
        completed_at_unix_ms: Some(now),
        stages: completed_stages,
        log_tail: preparation_log,
        failure: None,
    };
    // Clone and prepare the large mesh/read-model candidate without either
    // the transition fence or a current-state write lock. If the live state
    // moved while the receipt was being validated, the exact pin rejects it.
    let mut prepared_snapshot = {
        let current = state.current_live_state.read().await;
        let snapshot = current
            .as_ref()
            .ok_or_else(|| ApiError::not_found("no active local live workspace"))?;
        fence.validate(
            snapshot,
            context,
            state
                .current_live_session_epoch
                .load(std::sync::atomic::Ordering::Acquire),
        )?;
        snapshot.clone()
    };
    let (metadata, fem_mesh) = prepared_domain_publication(&prepared_snapshot, &read_model)?;
    let retained_scalar_history = if accepted_initial_state.is_some()
        || verified_output_only
        || mode.target_attempt().is_some()
    {
        retire_previous_observation_for_step_output(&mut prepared_snapshot)
    } else {
        None
    };
    let session_status = if terminal_observation || verified_output_only {
        None
    } else {
        preparation_session_status(&prepared_snapshot)
    };
    crate::live_authored_damping::retire_for_prepared_domain(&mut prepared_snapshot);
    crate::session::apply_current_live_snapshot(
        &mut prepared_snapshot,
        CurrentLiveSnapshotRequest {
            session_id: context.session_id.clone(),
            session: None,
            session_status,
            metadata: Some(metadata),
            mesh_workspace: Some(mesh_workspace),
            stage_execution: None,
            simulation_preparation: Some(preparation),
            run: None,
            live_state: None,
            frozen_spins_runtime_status: None,
            coupled_checkpoint: None,
            latest_scalar_row: None,
            latest_fields: None,
            replace_latest_fields: false,
            field_generation: None,
            preview_fields: None,
            clear_preview_cache: false,
            engine_log: None,
            solver_profile: None,
            fem_mesh,
        },
    )?;
    restore_retained_accepted_scalar_history(
        &mut prepared_snapshot,
        retained_scalar_history,
    );
    if verified_output_only {
        let install_verified_output = output_installer.expect(
            "verified output mode was checked to carry one installer",
        );
        install_verified_output(&mut prepared_snapshot, &read_model)?;
    }
    // A restored terminal run must never briefly publish prepared step0 over
    // its completed solver clock. Output-only modes installed the verified
    // final state above in this same candidate before the pointer swap.
    if !terminal_observation && !verified_output_only {
        if let Some(accepted_initial_state) = accepted_initial_state {
            publish_accepted_step_output_initial_state(
                &mut prepared_snapshot,
                &read_model,
                accepted_initial_state,
            )?;
        } else {
            publish_prepared_initial_state(&mut prepared_snapshot, &read_model, true)?;
        }
    }
    if let Some(store_root) = state
        .submit_store_root
        .as_deref()
        .filter(|_| !terminal_observation && !verified_output_only)
    {
        // Evaluated fields are optional: without them the prepared m stays the
        // only readable quantity until a run publishes its fields.
        if let Err(error) = crate::prepared_observation_adoption::adopt_prepared_observation(
            &mut prepared_snapshot,
            &read_model,
            store_root,
            run_id,
            step_id,
        ) {
            tracing::warn!(error = %error, "prepared-state observation was not adopted");
        }
    }
    prepared_snapshot.state_version = prepared_snapshot.state_version.saturating_add(1);
    let display_revision = state.current_display_selection.read().await.revision;
    let realtime_state =
        crate::current_live_realtime_state_from_snapshot(state, &prepared_snapshot, display_revision)
            .await;

    // Reacquire the transition only for the final compare, immutable receipt
    // commit, and pointer swap. The commit remains serialized with Stop and
    // session replacement; catalog/plan/receipt materialization above does
    // not hold this fence.
    let transition = state.current_live_session_transition.lock().await;
    {
        let current = state.current_live_state.read().await;
        let snapshot = current
            .as_ref()
            .ok_or_else(|| ApiError::not_found("no active local live workspace"))?;
        fence.validate(
            snapshot,
            context,
            state
                .current_live_session_epoch
                .load(std::sync::atomic::Ordering::Acquire),
        )?;
    }
    if let Some(command_id) = mesh_command_id {
        let ledger = state.current_command_ledger.lock().await;
        if !ledger.iter().any(|record| {
            record.command.command_id == command_id
                && record.status == crate::types::CommandLifecycleState::Accepted
        }) {
            return Err(ApiError::conflict_with_code(
                "accepted_preparation_run_stopped",
                "the command that requested this domain is no longer active",
            ));
        }
    }
    let committed_receipt = persist_live_preparation_receipt_for_context_under_transition_with_source_pin(
        state,
        context,
        receipt,
        Some(scene_revision),
        None,
        Some(run_id),
        Some(&validated_source),
    )
    .await?;
    let output_attempt_fence = match (&mode, verified_output_identity.as_ref()) {
        (AcceptedPreparationPublicationMode::ActiveObservation(identity), _) => {
            Some(hold_current_accepted_attempt_fence_async(
                final_fence_store_root.clone(),
                identity.clone(),
                expected_initial_state_claim.clone(),
            ).await?)
        }
        (AcceptedPreparationPublicationMode::Active, _) => {
            if let Some(claim) = expected_initial_state_claim.clone() {
                Some(hold_current_accepted_attempt_fence_async(
                    final_fence_store_root.clone(),
                    AcceptedTaskAttemptIdentity {
                        run_id: claim.run_id.as_str().to_owned(),
                        task_id: claim.task_id.as_str().to_owned(),
                        step_id: step_id.to_owned(),
                        attempt_id: claim.attempt_id.as_str().to_owned(),
                        ownership_epoch: claim.ownership_epoch.value(),
                    },
                    Some(claim),
                ).await?)
            } else {
                None
            }
        }
        (
            AcceptedPreparationPublicationMode::VerifiedOutput(identity)
            | AcceptedPreparationPublicationMode::TerminalVerifiedOutput { output: identity, .. },
            Some(verified),
        ) => {
            Some(hold_verified_stage_output_fence_async(
                final_fence_store_root.clone(),
                verified.clone(),
                plan_fingerprint.clone(),
            ).await?)
        }
        _ => None,
    };
    let disposition = match &committed_receipt.disposition {
        fullmag_session::PreparationReceiptCommitDisposition::Accepted => "accepted",
        fullmag_session::PreparationReceiptCommitDisposition::Replayed => "replayed",
    };
    let previous = publish_prepared_candidate_after_final_fence(
        state,
        prepared_snapshot,
        committed_receipt.receipt,
        Ok(output_attempt_fence),
    )
    .await?;
    drop(transition);
    if let Some(previous) = previous {
        let _ = tokio::task::spawn_blocking(move || drop(previous));
    }
    crate::publish_current_live_realtime_batch_changed(state, &realtime_state, false, 0).await?;
    Ok(PublishedLiveScenePreparation {
        disposition,
        preparation_id,
        run_id: run_id.to_owned(),
        plan_fingerprint,
        receipt_sha256: binding.receipt_sha256,
        read_model,
    })
}

/// Finalize the observable candidate only after its durable attempt/output
/// fence has been acquired. The caller holds the live-session transition.
/// Take both locks in the GET handler's order so cancellation before either
/// lock is acquired leaves the previous snapshot and receipt together.
async fn publish_prepared_candidate_after_final_fence(
    state: &AppState,
    prepared_snapshot: SessionStateResponse,
    receipt: fullmag_session::FmsPreparationReceipt,
    final_fence: Result<Option<fullmag_session::ReadTransaction>, ApiError>,
) -> Result<Option<SessionStateResponse>, ApiError> {
    let final_fence = final_fence?;
    let mut current = state.current_live_state.write().await;
    let mut current_receipt = state.current_live_preparation_receipt.write().await;
    let previous = current.replace(prepared_snapshot);
    *current_receipt = Some(receipt);
    drop(current_receipt);
    drop(current);
    drop(final_fence);
    Ok(previous)
}

pub(crate) async fn commit_live_preparation_receipt_for_context(
    state: &Arc<AppState>,
    context: &CurrentLiveRequestContext,
    receipt: PreparationReceipt,
    expected_scene_revision: Option<u64>,
    expected_preparation_id: Option<&str>,
    expected_run_id: Option<&str>,
) -> Result<fullmag_session::PreparationReceiptCommitDisposition, ApiError> {
    let _session_transition = state.current_live_session_transition.lock().await;
    commit_live_preparation_receipt_for_context_under_transition(
        state,
        context,
        receipt,
        expected_scene_revision,
        expected_preparation_id,
        expected_run_id,
    )
    .await
}

/// Commit a preparation receipt while the caller already owns the current-live
/// transition fence. Mesh/prepare commands use this form so durable receipt,
/// read-model publication, and command journaling share one session boundary.
pub(crate) async fn commit_live_preparation_receipt_for_context_under_transition(
    state: &Arc<AppState>,
    context: &CurrentLiveRequestContext,
    receipt: PreparationReceipt,
    expected_scene_revision: Option<u64>,
    expected_preparation_id: Option<&str>,
    expected_run_id: Option<&str>,
) -> Result<fullmag_session::PreparationReceiptCommitDisposition, ApiError> {
    commit_live_preparation_receipt_for_context_under_transition_with_source_pin(
        state,
        context,
        AcceptedPreparationReceipt::Solver(receipt),
        expected_scene_revision,
        expected_preparation_id,
        expected_run_id,
        None,
    )
    .await
}

async fn commit_live_preparation_receipt_for_context_under_transition_with_source_pin(
    state: &Arc<AppState>,
    context: &CurrentLiveRequestContext,
    receipt: AcceptedPreparationReceipt,
    expected_scene_revision: Option<u64>,
    expected_preparation_id: Option<&str>,
    expected_run_id: Option<&str>,
    validated_source: Option<&ValidatedAcceptedPreparationSource>,
) -> Result<fullmag_session::PreparationReceiptCommitDisposition, ApiError> {
    let committed = persist_live_preparation_receipt_for_context_under_transition_with_source_pin(
        state,
        context,
        receipt,
        expected_scene_revision,
        expected_preparation_id,
        expected_run_id,
        validated_source,
    )
    .await?;
    *state.current_live_preparation_receipt.write().await = Some(committed.receipt);
    Ok(committed.disposition)
}

struct CommittedLivePreparationReceipt {
    disposition: fullmag_session::PreparationReceiptCommitDisposition,
    receipt: fullmag_session::FmsPreparationReceipt,
}

async fn persist_live_preparation_receipt_for_context_under_transition_with_source_pin(
    state: &Arc<AppState>,
    context: &CurrentLiveRequestContext,
    receipt: AcceptedPreparationReceipt,
    expected_scene_revision: Option<u64>,
    expected_preparation_id: Option<&str>,
    expected_run_id: Option<&str>,
    validated_source: Option<&ValidatedAcceptedPreparationSource>,
) -> Result<CommittedLivePreparationReceipt, ApiError> {
    let session_epoch = state
        .current_live_session_epoch
        .load(std::sync::atomic::Ordering::Acquire);
    let current = state.current_live_state.read().await;
    let snapshot = current
        .as_ref()
        .ok_or_else(|| ApiError::not_found("no active local live workspace"))?;
    crate::ensure_current_live_request_context(snapshot, context, session_epoch)?;
    if expected_scene_revision.is_some_and(|expected| {
        snapshot.scene_document.as_ref().map(|scene| scene.revision) != Some(expected)
    }) {
        return Err(ApiError::conflict(
            "current_live_preparation_materialization_scene_revision_mismatch",
        ));
    }
    if let Some(expected_preparation_id) = expected_preparation_id {
        ensure_current_preparation_id(snapshot, expected_preparation_id)?;
    }
    let current_run_id = snapshot
        .run
        .as_ref()
        .map(|run| run.run_id.clone())
        .unwrap_or_else(|| snapshot.session.run_id.clone());
    let current_preparation_id = snapshot
        .simulation_preparation
        .as_ref()
        .map(|preparation| preparation.preparation_id.clone());
    let snapshot_accepted_run_id = snapshot
        .mesh_workspace
        .as_ref()
        .and_then(|workspace| workspace.get("accepted_run_id"))
        .and_then(Value::as_str)
        .map(str::to_owned);
    if expected_run_id.is_some_and(|expected| expected != current_run_id.as_str()) {
        return Err(ApiError::conflict(
            "current_live_preparation_materialization_run_id_mismatch",
        ));
    }
    match &receipt {
        AcceptedPreparationReceipt::Solver(receipt) => receipt.validate(),
        AcceptedPreparationReceipt::ClosedLoop(receipt) => receipt.validate(),
    }
    .map_err(|error| ApiError::bad_request(error.to_string()))?;
    let preparation_id_differs = current_preparation_id
        .as_deref()
        .is_some_and(|preparation_id| preparation_id != receipt.preparation_id());
    drop(current);

    let accepted_source = live_preparation_accepted_source(&receipt);
    if let Some(source) = accepted_source {
        if let Some(validated_source) = validated_source {
            validated_source.validate_receipt(&current_run_id, &receipt)?;
        } else {
        match &receipt {
            AcceptedPreparationReceipt::Solver(receipt) => {
                validate_live_accepted_run_source(state, &current_run_id, receipt, source)?;
            }
            AcceptedPreparationReceipt::ClosedLoop(receipt) => {
                let store_root = state.submit_store_root.as_ref().ok_or_else(|| {
                    ApiError::with_status_and_code(
                        axum::http::StatusCode::SERVICE_UNAVAILABLE,
                        "accepted_preparation_store_unavailable",
                        "accepted inspection requires the configured durable run store",
                    )
                })?;
                let store = fullmag_session::SessionStore::open_existing(store_root)
                    .map_err(|error| ApiError::conflict(format!(
                        "accepted inspection store could not be opened: {error}"
                    )))?;
                validate_closed_loop_against_accepted_store(&store, &current_run_id, receipt)?;
            }
        }
        }
    } else if preparation_id_differs {
        return Err(ApiError::conflict(
            "current_live_preparation_receipt_id_mismatch",
        ));
    }

    let accepted_source_step = accepted_source.map(|source| source.step_id.clone());
    let payload = receipt.payload().map_err(|error| {
        ApiError::internal(format!("failed to encode preparation receipt: {error}"))
    })?;
    let durable_receipt = fullmag_session::FmsPreparationReceipt::new(
        receipt.preparation_id().to_owned(),
        current_run_id,
        receipt.plan_fingerprint().to_owned(),
        payload,
    );
    // The live workspace anchor and accepted task/stage receipts have
    // different durable owners. Keep the roots explicit: legacy live
    // preparations use the current-live journal store, while an accepted run
    // keeps its catalog, RunIntent, anchor, task, and stage provenance in the
    // accepted store. Do not open the live journal on the normal accepted-run
    // path: opening it may itself need its writer, although this receipt is
    // owned entirely by the accepted store.
    let previous_live_receipt = state.current_live_preparation_receipt.read().await.clone();
    let previous_legacy_replacement_needs_live_store = previous_live_receipt
        .as_ref()
        .filter(|previous| previous.run_id != durable_receipt.run_id)
        .and_then(|previous| validated_live_preparation_payload(&previous.payload))
        .is_some_and(|previous| live_preparation_accepted_source(&previous).is_none());
    let live_store = if accepted_source_step.is_none()
        || previous_legacy_replacement_needs_live_store
    {
        Some(crate::session_persistence::open_store(state)?)
    } else {
        None
    };
    let accepted_store = if accepted_source_step.is_some() {
        let store_root = state.submit_store_root.as_ref().ok_or_else(|| {
            ApiError::with_status_and_code(
                axum::http::StatusCode::SERVICE_UNAVAILABLE,
                "accepted_preparation_store_unavailable",
                "accepted preparation provenance requires the configured durable run store",
            )
        })?;
        Some(fullmag_session::SessionStore::open_existing(store_root).map_err(|error| {
            ApiError::with_status_and_code(
                axum::http::StatusCode::SERVICE_UNAVAILABLE,
                "accepted_preparation_store_unavailable",
                format!("failed to open the configured accepted run store: {error}"),
            )
        })?)
    } else {
        None
    };
    let previous_durable_receipt = match accepted_store.as_ref() {
        Some(accepted_store) => {
            read_durable_preparation_anchor(accepted_store, &durable_receipt.run_id)?
        }
        None => {
            let live_store = live_store.as_ref().ok_or_else(|| {
                ApiError::internal("legacy preparation requires the current-live journal store")
            })?;
            read_durable_preparation_anchor(live_store, &durable_receipt.run_id)?
        }
    };
    let disposition = if let Some(step_id) = accepted_source_step.as_deref() {
        let accepted_store = accepted_store.as_ref().ok_or_else(|| {
            ApiError::with_status_and_code(
                axum::http::StatusCode::SERVICE_UNAVAILABLE,
                "accepted_preparation_store_unavailable",
                "accepted preparation provenance store was not opened",
            )
        })?;
        let task_id = fullmag_session::task_id_for_study_step(&durable_receipt.run_id, step_id)
            .map_err(|error| ApiError::bad_request(format!("accepted preparation step is invalid: {error}")))?;
        let task_receipt = accepted_store
            .read_task_preparation_receipt(&durable_receipt.run_id, &task_id)
            .map_err(|error| {
                ApiError::conflict(format!("accepted task preparation receipt read failed: {error}"))
            })?
            .ok_or_else(|| {
                ApiError::conflict_with_code(
                    "accepted_preparation_task_receipt_missing",
                    "accepted preparation source has no immutable task preparation receipt",
                )
            })?;
        let stage_receipt = fullmag_session::FmsAcceptedStagePreparationReceipt::from_task_receipt(
            &task_receipt,
        )
        .map_err(|error| {
            ApiError::conflict(format!("accepted stage preparation receipt is invalid: {error}"))
        })?;
        if stage_receipt.preparation_id != durable_receipt.preparation_id
            || stage_receipt.plan_fingerprint != durable_receipt.plan_fingerprint
        {
            return Err(ApiError::conflict_with_code(
                "accepted_preparation_stage_receipt_mismatch",
                "accepted stage receipt differs from the immutable task preparation receipt",
            ));
        }

        let stale_accepted_replacement = match previous_live_receipt.as_ref() {
            Some(previous) if previous.run_id != durable_receipt.run_id => {
                prove_stale_accepted_replacement(
                    live_store.as_ref(),
                    accepted_store,
                    previous,
                    current_preparation_id.as_deref(),
                    snapshot_accepted_run_id.as_deref(),
                )?
            }
            _ => false,
        };
        let previous_stage_id = previous_live_receipt
            .as_ref()
            .and_then(|previous| accepted_stage_step_for_run(previous, &durable_receipt.run_id));
        let same_run_previous_stage_is_durable = if let Some(step_id) = previous_stage_id {
            accepted_store
                .read_accepted_stage_preparation_receipt(&durable_receipt.run_id, &step_id)
                .map(|receipt| receipt.is_some())
                .map_err(|error| ApiError::conflict(error.to_string()))?
        } else if let Some(preparation_id) = current_preparation_id.as_deref() {
            accepted_store
                .find_accepted_stage_preparation_receipt_by_preparation_id(
                    &durable_receipt.run_id,
                    preparation_id,
                )
                .map(|receipt| receipt.is_some())
                .map_err(|error| ApiError::conflict(error.to_string()))?
        } else {
            false
        };
        if preparation_id_differs
            && !stale_accepted_replacement
            && !same_run_previous_stage_is_durable
        {
            return Err(ApiError::conflict(
                "current_live_preparation_receipt_id_mismatch",
            ));
        }

        let stage_disposition = fullmag_runtime_control::retry_store_writer_busy(|| {
            accepted_store.commit_accepted_stage_preparation_receipt(&stage_receipt)
        })
        .map_err(|error| ApiError::conflict(error.to_string()))?;
        match previous_durable_receipt.as_ref() {
            None => fullmag_runtime_control::retry_store_writer_busy(|| {
                accepted_store.commit_preparation_receipt(&durable_receipt)
            })
            .map_err(|error| ApiError::conflict(error.to_string()))?,
            Some(existing) if existing.same_immutable_payload(&durable_receipt) => {
                fullmag_session::PreparationReceiptCommitDisposition::Replayed
            }
            Some(_) => stage_disposition,
        }
    } else {
        live_store
            .as_ref()
            .ok_or_else(|| {
                ApiError::internal("legacy preparation requires the current-live journal store")
            })?
            .commit_preparation_receipt(&durable_receipt)
            .map_err(|error| ApiError::conflict(error.to_string()))?
    };
    Ok(CommittedLivePreparationReceipt {
        disposition,
        receipt: durable_receipt,
    })
}

fn live_preparation_accepted_source(
    receipt: &AcceptedPreparationReceipt,
) -> Option<&AcceptedRunPreparationSource> {
    match receipt {
        AcceptedPreparationReceipt::Solver(receipt) => receipt.accepted_run_source.as_ref(),
        AcceptedPreparationReceipt::ClosedLoop(receipt) => Some(&receipt.plan.source),
    }
}

/// Decode only the declared schema. An operation receipt never becomes a
/// solver receipt, and malformed historical state cannot authorize replacement.
fn validated_live_preparation_payload(payload: &Value) -> Option<AcceptedPreparationReceipt> {
    if payload.get("schema_version").and_then(Value::as_str)
        == Some(fullmag_application::CLOSED_LOOP_PREPARATION_SCHEMA)
    {
        let receipt: ClosedLoopPreparationReceipt = serde_json::from_value(payload.clone()).ok()?;
        receipt.validate().ok()?;
        Some(AcceptedPreparationReceipt::ClosedLoop(receipt))
    } else {
        let receipt: PreparationReceipt = serde_json::from_value(payload.clone()).ok()?;
        receipt.validate().ok()?;
        Some(AcceptedPreparationReceipt::Solver(receipt))
    }
}

/// Re-read readiness through the immutable accepted snapshot, including
/// expected_plan and real native source-mesh evidence. Session envelopes alone
/// are not application-level preparation proof.
fn validate_closed_loop_against_accepted_store(
    store: &fullmag_session::SessionStore,
    current_run_id: &str,
    receipt: &ClosedLoopPreparationReceipt,
) -> Result<(), ApiError> {
    let source = &receipt.plan.source;
    if source.run_id.as_str() != current_run_id {
        return Err(ApiError::conflict_with_code(
            "live_preparation_accepted_source_run_mismatch",
            "accepted inspection does not belong to the current live run",
        ));
    }
    let intent = store.read_run_intent(current_run_id)
        .map_err(|error| ApiError::conflict(format!("accepted RunIntent read failed: {error}")))?
        .ok_or_else(|| ApiError::conflict_with_code(
            "accepted_preparation_run_missing", "accepted inspection has no durable RunIntent",
        ))?;
    let specification: fullmag_application::RunSpecification =
        serde_json::from_value(intent.specification)
            .map_err(|error| ApiError::conflict(format!("accepted RunSpec is not typed: {error}")))?;
    let accepted = fullmag_runtime_control::load_accepted_study_snapshot(
        store, &source.run_id, &specification.snapshot.project_id,
    ).map_err(|error| ApiError::conflict(format!(
        "accepted inspection snapshot validation failed: {error:#}"
    )))?;
    let task_id = fullmag_session::task_id_for_study_step(current_run_id, &source.step_id)
        .map_err(|error| ApiError::conflict(format!("accepted inspection task is invalid: {error}")))?;
    let verified = accepted.read_task_preparation(store, &task_id)
        .map_err(|error| ApiError::conflict_with_code(
            "accepted_preparation_receipt_invalid",
            format!("accepted inspection readiness validation failed: {error:#}"),
        ))?;
    if !matches!(&verified, AcceptedPreparationReceipt::ClosedLoop(_)) {
        return Err(ApiError::conflict("accepted inspection selected a solver preparation"));
    }
    let expected_payload = serde_json::to_value(receipt)
        .map_err(|error| ApiError::internal(format!("inspection receipt encoding failed: {error}")))?;
    let verified_payload = verified.payload()
        .map_err(|error| ApiError::internal(format!("inspection readiness encoding failed: {error}")))?;
    validate_accepted_receipt_payload_identity(&expected_payload, &verified_payload)
}

/// Accepted-run provenance is allowed on the live sync boundary only when it
/// is fenced to the current run and the durable accepted store.  A structural
/// receipt field alone is not an admission or a source identity.
fn validate_live_accepted_run_source(
    state: &AppState,
    current_run_id: &str,
    receipt: &PreparationReceipt,
    source: &AcceptedRunPreparationSource,
) -> Result<(), ApiError> {
    validate_accepted_source_plan_identity(current_run_id, receipt.plan.source.as_ref(), source)?;

    let store_root = state.submit_store_root.as_ref().ok_or_else(|| {
        ApiError::with_status_and_code(
            axum::http::StatusCode::SERVICE_UNAVAILABLE,
            "accepted_preparation_store_unavailable",
            "accepted preparation provenance requires the configured durable run store",
        )
    })?;
    let store = fullmag_session::SessionStore::open_existing(store_root).map_err(|error| {
        ApiError::with_status_and_code(
            axum::http::StatusCode::SERVICE_UNAVAILABLE,
            "accepted_preparation_store_unavailable",
            format!("failed to open the configured accepted run store: {error}"),
        )
    })?;
    let intent = store
        .read_run_intent(current_run_id)
        .map_err(|error| {
            ApiError::conflict(format!("accepted run provenance read failed: {error}"))
        })?
        .ok_or_else(|| {
            ApiError::conflict_with_code(
                "accepted_preparation_run_missing",
                "accepted preparation source has no durable run intent",
            )
        })?;
    let expected_specification_fingerprint = format!("sha256:{}", intent.payload_sha256);
    if source.specification_fingerprint != expected_specification_fingerprint {
        return Err(ApiError::conflict_with_code(
            "accepted_preparation_specification_mismatch",
            "accepted preparation source differs from the durable run specification",
        ));
    }

    let catalog = store
        .read_run_catalog(current_run_id)
        .map_err(|error| ApiError::conflict(format!("accepted run catalog read failed: {error}")))?
        .ok_or_else(|| {
            ApiError::conflict_with_code(
                "accepted_preparation_catalog_missing",
                "accepted preparation source has no durable run catalog",
            )
        })?;
    let task_id = fullmag_session::task_id_for_study_step(current_run_id, &source.step_id)
        .map_err(|error| {
            ApiError::bad_request(format!("accepted preparation step is invalid: {error}"))
        })?;
    if !catalog.tasks.iter().any(|task| task.task_id == task_id) {
        return Err(ApiError::conflict_with_code(
            "accepted_preparation_step_missing",
            "accepted preparation source step is absent from the durable run catalog",
        ));
    }
    let durable = store
        .read_task_preparation_receipt(current_run_id, &task_id)
        .map_err(|error| {
            ApiError::conflict(format!(
                "accepted task preparation receipt read failed: {error}"
            ))
        })?
        .ok_or_else(|| {
            ApiError::conflict_with_code(
                "accepted_preparation_task_receipt_missing",
                "accepted preparation source has no immutable task preparation receipt",
            )
        })?;
    let expected_payload = serde_json::to_value(receipt).map_err(|error| {
        ApiError::internal(format!(
            "accepted preparation receipt serialization failed: {error}"
        ))
    })?;
    validate_accepted_receipt_payload_identity(&expected_payload, &durable.payload)?;
    Ok(())
}

fn validate_accepted_source_plan_identity(
    current_run_id: &str,
    plan_source: Option<&PreparationPlanSource>,
    source: &AcceptedRunPreparationSource,
) -> Result<(), ApiError> {
    if source.run_id.as_str() != current_run_id {
        return Err(ApiError::conflict_with_code(
            "live_preparation_accepted_source_run_mismatch",
            "accepted preparation source does not belong to the current live run",
        ));
    }
    match plan_source {
        Some(PreparationPlanSource::AcceptedRunStep {
            run_id,
            specification_fingerprint,
            step_id,
        }) if run_id == source.run_id.as_str()
            && specification_fingerprint == &source.specification_fingerprint
            && step_id == &source.step_id =>
        {
            Ok(())
        }
        _ => Err(ApiError::bad_request(
            "live_preparation_accepted_source_plan_mismatch",
        )),
    }
}

fn validate_accepted_receipt_payload_identity(
    expected_payload: &Value,
    durable_payload: &Value,
) -> Result<(), ApiError> {
    if expected_payload == durable_payload {
        Ok(())
    } else {
        Err(ApiError::conflict_with_code(
            "accepted_preparation_task_receipt_mismatch",
            "accepted preparation receipt differs from the immutable task receipt",
        ))
    }
}

fn stale_replacement_snapshot_matches(
    previous: &fullmag_session::FmsPreparationReceipt,
    current_preparation_id: Option<&str>,
    snapshot_accepted_run_id: Option<&str>,
) -> bool {
    current_preparation_id == Some(previous.preparation_id.as_str())
        && snapshot_accepted_run_id.is_none_or(|run_id| run_id == previous.run_id)
}

fn stale_replacement_durable_evidence_matches(
    previous_run_id: &str,
    anchor_run_id: &str,
    anchor_matches_previous: bool,
    accepted_source_run_id: Option<&str>,
    task_matches_previous: bool,
    stage_matches_previous: bool,
) -> bool {
    if anchor_run_id != previous_run_id {
        return false;
    }
    match accepted_source_run_id {
        None => anchor_matches_previous,
        Some(source_run_id) => {
            source_run_id == previous_run_id
                && task_matches_previous
                && stage_matches_previous
        }
    }
}

/// Prove that a preparation from a previous run may replace the current
/// in-memory live receipt. A run-id difference alone is not sufficient: the
/// current snapshot must still point at the previous preparation, and the
/// previous run's immutable anchor, task receipt, and stage pointer must all
/// reproduce the in-memory payload. The run-level anchor remains the first
/// immutable preparation for the run, so an accepted later-stage receipt is
/// proven by its task/stage records instead of being compared to that anchor.
fn prove_stale_accepted_replacement(
    live_store: Option<&fullmag_session::SessionStore>,
    accepted_store: &fullmag_session::SessionStore,
    previous: &fullmag_session::FmsPreparationReceipt,
    current_preparation_id: Option<&str>,
    snapshot_accepted_run_id: Option<&str>,
) -> Result<bool, ApiError> {
    if !stale_replacement_snapshot_matches(
        previous,
        current_preparation_id,
        snapshot_accepted_run_id,
    ) {
        return Ok(false);
    }

    let Some(application) = validated_live_preparation_payload(&previous.payload) else {
        return Ok(false);
    };
    if let AcceptedPreparationReceipt::ClosedLoop(receipt) = &application {
        validate_closed_loop_against_accepted_store(accepted_store, &previous.run_id, receipt)?;
    }
    let source = live_preparation_accepted_source(&application);
    let anchor_store = if source.is_some() {
        accepted_store
    } else {
        live_store.ok_or_else(|| {
            ApiError::internal("stale legacy preparation requires the current-live journal store")
        })?
    };
    let Some(anchor) = read_durable_preparation_anchor(anchor_store, &previous.run_id)?
    else {
        return Ok(false);
    };
    let Some(source) = source else {
        return Ok(stale_replacement_durable_evidence_matches(
            &previous.run_id,
            &anchor.run_id,
            anchor.same_immutable_payload(previous),
            None,
            false,
            false,
        ));
    };
    let Ok(task_id) =
        fullmag_session::task_id_for_study_step(&previous.run_id, &source.step_id)
    else {
        return Ok(false);
    };
    let task_receipt = accepted_store
        .read_task_preparation_receipt(&previous.run_id, &task_id)
        .map_err(|error| {
            ApiError::conflict(format!(
                "previous accepted task preparation receipt read failed: {error}"
            ))
        })?;
    let Some(task_receipt) = task_receipt else {
        return Ok(false);
    };
    let task_matches_previous = task_receipt.payload == previous.payload;
    let stage_receipt = accepted_store
        .read_accepted_stage_preparation_receipt(&previous.run_id, &source.step_id)
        .map_err(|error| {
            ApiError::conflict(format!(
                "previous accepted stage preparation receipt read failed: {error}"
            ))
        })?;
    let Some(stage_receipt) = stage_receipt else {
        return Ok(false);
    };
    let stage_matches_previous = stage_receipt.preparation_id == previous.preparation_id
        && stage_receipt.plan_fingerprint == previous.plan_fingerprint
        && stage_receipt.matches_task_receipt(&task_receipt);
    Ok(stale_replacement_durable_evidence_matches(
        &previous.run_id,
        &anchor.run_id,
        anchor.same_immutable_payload(previous),
        Some(source.run_id.as_str()),
        task_matches_previous,
        stage_matches_previous,
    ))
}

fn read_durable_preparation_anchor(
    store: &fullmag_session::SessionStore,
    run_id: &str,
) -> Result<Option<fullmag_session::FmsPreparationReceipt>, ApiError> {
    fullmag_session::repository_path::validate_store_id(run_id)
        .map_err(|error| ApiError::conflict(format!("previous accepted run id is invalid: {error}")))?;
    let relative = format!("runs/{run_id}/preparation_receipt.json");
    let path = store.root().join(&relative);
    match std::fs::symlink_metadata(&path) {
        Ok(metadata) if metadata.is_file() => {}
        Ok(_) => {
            return Err(ApiError::conflict(
                "previous accepted preparation anchor is not a regular file",
            ));
        }
        Err(error) if error.kind() == std::io::ErrorKind::NotFound => return Ok(None),
        Err(error) => {
            return Err(ApiError::conflict(format!(
                "checking previous accepted preparation anchor failed: {error}"
            )));
        }
    }
    let data = fullmag_session::repository_path::read_bounded_regular_file(
        store.root(),
        &relative,
        16 * 1024 * 1024,
    )
    .map_err(|error| {
        ApiError::conflict(format!(
            "previous accepted preparation anchor read failed: {error}"
        ))
    })?;
    let anchor: fullmag_session::FmsPreparationReceipt =
        serde_json::from_slice(&data).map_err(|error| {
            ApiError::conflict(format!(
                "previous accepted preparation anchor is invalid: {error}"
            ))
        })?;
    anchor.validate().map_err(|error| {
        ApiError::conflict(format!(
            "previous accepted preparation anchor validation failed: {error}"
        ))
    })?;
    if anchor.run_id != run_id {
        return Err(ApiError::conflict(
            "previous accepted preparation anchor identity does not match its path",
        ));
    }
    Ok(Some(anchor))
}

/// Recover the accepted stage selected by an earlier in-memory receipt.
/// Only an accepted-run payload for the same run is eligible; malformed or
/// legacy receipts return `None` and therefore cannot authorize a replacement.
fn accepted_stage_step_for_run(
    receipt: &fullmag_session::FmsPreparationReceipt,
    run_id: &str,
) -> Option<String> {
    if receipt.run_id != run_id {
        return None;
    }
    let application = validated_live_preparation_payload(&receipt.payload)?;
    let source = live_preparation_accepted_source(&application)?;
    (source.run_id.as_str() == run_id).then(|| source.step_id.clone())
}

fn validate_live_read_model_binding(
    model_preparation_id: &str,
    model_scene_revision: u64,
    model_plan_fingerprint: &str,
    receipt_preparation_id: &str,
    receipt_scene_revision: Option<u64>,
    receipt_plan_fingerprint: &str,
) -> Result<(), ApiError> {
    if model_preparation_id != receipt_preparation_id {
        return Err(ApiError::internal(
            "live preparation read model and receipt preparation IDs disagree",
        ));
    }
    if receipt_scene_revision != Some(model_scene_revision) {
        return Err(ApiError::internal(
            "live preparation read model and receipt scene revisions disagree",
        ));
    }
    if model_plan_fingerprint != receipt_plan_fingerprint {
        return Err(ApiError::internal(
            "live preparation read model and receipt plan fingerprints disagree",
        ));
    }
    Ok(())
}

fn ensure_current_preparation_id(
    snapshot: &SessionStateResponse,
    expected_preparation_id: &str,
) -> Result<(), ApiError> {
    let active_preparation_id = snapshot
        .simulation_preparation
        .as_ref()
        .map(|preparation| preparation.preparation_id.as_str());
    if active_preparation_id != Some(expected_preparation_id) {
        return Err(ApiError::conflict(
            "current_live_preparation_materialization_id_mismatch",
        ));
    }
    Ok(())
}

/// Materialize a live preparation and its read model without native FEM work.
/// FDM is self-contained; FEM callers must use the evidence-bearing variant
/// after the existing accepted preparation admission has been established.
pub(crate) async fn materialize_live_scene_preparation_model(
    input: LiveScenePreparationInput,
) -> Result<LiveScenePreparationMaterialization, ApiError> {
    materialize_live_scene_preparation_model_with_fem_evidence(input, None).await
}

/// Materialize a live preparation from native FEM evidence produced by the
/// admitted FEM preparation lane. This function validates the evidence
/// against the canonical plan but never invokes a solver or allocates a host
/// resource itself.
pub(crate) async fn materialize_live_scene_preparation_model_with_fem_evidence(
    input: LiveScenePreparationInput,
    native_fem_evidence: Option<fullmag_plan::NativeFemMeshSpaceEvidence>,
) -> Result<LiveScenePreparationMaterialization, ApiError> {
    tokio::task::spawn_blocking(move || {
        let problem = if input.requested_execution.backend == "fem" {
            // The legacy live lowerer intentionally admits only FDM/auto. FEM
            // uses the same authored SceneDocument capture and declared
            // execution binder, then enters this adapter with native evidence
            // supplied by the already-admitted FEM lane.
            let authored = crate::script::scene_document_to_authored_problem_ir(
                &input.repo_root,
                &input.workspace_root,
                &input.scene_document,
                &input.requested_execution,
            )?;
            let bound = fullmag_application::bind_declared_execution(&authored, vec![]).map_err(
                |error| {
                    ApiError::bad_request(format!(
                        "declared execution profile could not be bound: {error}"
                    ))
                },
            )?;
            bound.validate().map_err(|errors| {
                ApiError::internal(format!(
                    "canonical SceneDocument lowering produced invalid ProblemIR: {}",
                    errors.join("; ")
                ))
            })?;
            bound
        } else {
            crate::script::scene_document_to_problem_ir(
                &input.repo_root,
                &input.workspace_root,
                &input.scene_document,
                &input.requested_execution,
            )?
        };
        let execution_plan = fullmag_plan::plan(&problem).map_err(|error| {
            ApiError::unprocessable(format!("live preparation planning rejected: {error}"))
        })?;
        validate_requested_device_binding(&problem, &input.requested_execution)?;

        let receipt = match execution_plan.common.resolved_backend {
            fullmag_ir::BackendTarget::Fem => {
                let fullmag_ir::BackendPlanIR::Fem(fem_plan) = &execution_plan.backend_plan else {
                    return Err(ApiError::unprocessable(
                        "native FEM preparation currently requires a time-domain FEM plan",
                    ));
                };
                let native = native_fem_evidence.as_ref().ok_or_else(|| {
                    ApiError::with_status_and_code(
                        axum::http::StatusCode::SERVICE_UNAVAILABLE,
                        "fem_preparation_admission_required",
                        "native FEM preparation requires an admitted preparation lane",
                    )
                })?;
                if native.fe_order != fem_plan.fe_order {
                    return Err(ApiError::unprocessable(
                        "native FEM preparation evidence has a different finite-element order",
                    ));
                }
                fullmag_application::materialize_fem_preparation_from_problem(
                    input.preparation_id.clone(),
                    input.scene_revision,
                    &problem,
                    &input.display_projection,
                    native,
                )
                .map_err(|error| {
                    ApiError::unprocessable(format!(
                        "preparation materialization rejected: {error}"
                    ))
                })?
            }
            fullmag_ir::BackendTarget::Fdm => {
                if native_fem_evidence.is_some() {
                    return Err(ApiError::bad_request(
                        "native FEM evidence cannot be attached to an FDM preparation",
                    ));
                }
                fullmag_application::materialize_fdm_preparation_from_problem(
                    input.preparation_id.clone(),
                    input.scene_revision,
                    &problem,
                    &input.display_projection,
                )
                .map_err(|error| {
                    ApiError::unprocessable(format!(
                        "preparation materialization rejected: {error}"
                    ))
                })?
            }
            other => {
                return Err(ApiError::unprocessable(format!(
                    "live preparation does not support resolved backend '{}'",
                    other.as_str()
                )));
            }
        };

        receipt.validate().map_err(|error| {
            ApiError::internal(format!("materialized preparation is invalid: {error}"))
        })?;
        if receipt.plan.requested_backend != execution_plan.common.requested_backend
            || receipt.plan.resolved_backend != execution_plan.common.resolved_backend
        {
            return Err(ApiError::internal(
                "preparation receipt and canonical execution plan disagree on backend identity",
            ));
        }
        let problem_fingerprint = format!(
            "sha256:{}",
            fullmag_session::canonical_json_sha256(&serde_json::to_value(&problem).map_err(
                |error| {
                    ApiError::internal(format!("problem fingerprint serialization failed: {error}"))
                },
            )?),
        );
        if receipt.plan.problem_fingerprint != problem_fingerprint {
            return Err(ApiError::internal(
                "preparation receipt and canonical ProblemIR fingerprint disagree",
            ));
        }
        let binding = PreparationBinding::from_receipt(&receipt).map_err(|error| {
            ApiError::internal(format!("materialized preparation binding failed: {error}"))
        })?;
        let read_model = LiveScenePreparationReadModel {
            schema_version: LIVE_SCENE_PREPARATION_READ_MODEL_SCHEMA,
            preparation_id: receipt.preparation_id.clone(),
            scene_revision: input.scene_revision,
            plan_fingerprint: receipt.plan_fingerprint.clone(),
            requested_execution: input.requested_execution,
            global_sampling_mesh: antenna_domain::pinned_global_mesh(&problem, &execution_plan)?,
            execution_plan,
        };
        validate_live_read_model_binding(
            &read_model.preparation_id,
            read_model.scene_revision,
            &read_model.plan_fingerprint,
            &receipt.preparation_id,
            receipt.plan.scene_revision,
            &receipt.plan_fingerprint,
        )?;
        Ok(LiveScenePreparationMaterialization {
            receipt,
            binding,
            read_model,
        })
    })
    .await
    .map_err(|error| {
        ApiError::internal(format!("preparation materialization task failed: {error}"))
    })?
}

/// Legacy callers need only the durable receipt. Keep them on the same
/// canonical adapter so they cannot create a second planning/materialization
/// route.
pub(crate) async fn materialize_live_scene_preparation(
    input: LiveScenePreparationInput,
) -> Result<PreparationReceipt, ApiError> {
    Ok(materialize_live_scene_preparation_model(input)
        .await?
        .receipt)
}

fn validate_requested_device_binding(
    problem: &fullmag_ir::ProblemIR,
    requested: &RequestedExecution,
) -> Result<(), ApiError> {
    let effective = problem
        .problem_meta
        .runtime_metadata
        .get("runtime_device_override")
        .or_else(|| {
            problem
                .problem_meta
                .runtime_metadata
                .get("runtime_selection")
        })
        .and_then(Value::as_object)
        .and_then(|selection| selection.get("device"))
        .and_then(Value::as_str)
        .map(normalize_runtime_device);
    validate_requested_device_value(requested.device.as_str(), effective)
}

fn normalize_runtime_device(device: &str) -> &str {
    if device.eq_ignore_ascii_case("cuda") || device.starts_with("cuda:") {
        "gpu"
    } else {
        device
    }
}

fn validate_requested_device_value(
    requested_device: &str,
    effective_device: Option<&str>,
) -> Result<(), ApiError> {
    match requested_device {
        "gpu" if effective_device != Some("gpu") => Err(ApiError::unprocessable(
            "forced GPU preparation did not retain the GPU runtime selection; fallback=none",
        )),
        "cpu" if effective_device.is_some_and(|device| device != "cpu") => {
            Err(ApiError::unprocessable(
                "forced CPU preparation differs from the canonical runtime selection",
            ))
        }
        _ => Ok(()),
    }
}

#[cfg(test)]
mod tests {
    use super::*;
    use fullmag_application::{
        ProjectId, ProjectSnapshot, RequestedExecution, RequestedResourceBudget, RunId,
        RunSpecification, StudyId, StudyReference,
    };
    use fullmag_ir::BackendTarget;
    use fullmag_plan::{
        PreparationCertificate, PreparationMarkerCertificate, PreparationPlan,
        PreparationProducer, PreparationProducerKind, PreparationQualityCertificate,
        PreparationSpaceCertificate,
    };
    use serde_json::json;

    fn digest(character: char) -> String {
        format!("sha256:{}", character.to_string().repeat(64))
    }

    #[test]
    fn completed_preparation_uses_canonical_stages_and_ready_log_stage() {
        let now = 1_700_000_000_123;
        let stages = canonical_completed_preparation_stages(now, "receipt committed");
        assert_eq!(
            stages
                .iter()
                .map(|stage| stage.id.as_str())
                .collect::<Vec<_>>(),
            CANONICAL_PREPARATION_STAGE_IDS,
        );
        let solver_initialization = stages
            .iter()
            .find(|stage| stage.id == "solver_initialization")
            .expect("canonical solver initialization stage");
        assert_eq!(solver_initialization.status, "skipped");
        assert_eq!(
            solver_initialization.detail,
            "Native solver initialization is deferred until Compute; no solver was invoked during preparation"
        );
        assert_eq!(solver_initialization.progress_percent, None);
        assert_eq!(
            solver_initialization.progress_label.as_deref(),
            Some("awaiting Compute")
        );
        assert!(solver_initialization.started_at_unix_ms.is_none());
        assert!(solver_initialization.completed_at_unix_ms.is_none());
        assert!(solver_initialization.duration_ms.is_none());

        assert!(stages.iter().filter(|stage| stage.id != "solver_initialization").all(
            |stage| stage.status == "completed" && stage.progress_percent == Some(100)
        ));
        assert!(stages.iter().filter(|stage| {
            stage.id != "solver_initialization" && stage.id != "ready"
        }).all(|stage| {
            stage.started_at_unix_ms.is_none()
                && stage.completed_at_unix_ms.is_none()
                && stage.duration_ms.is_none()
        }));
        let ready = stages.last().expect("canonical ready stage");
        assert_eq!(ready.started_at_unix_ms, Some(now));
        assert_eq!(ready.completed_at_unix_ms, Some(now));
        assert_eq!(ready.duration_ms, Some(0));
        assert_eq!(ready.status, "completed");
        assert_eq!(ready.detail, "Authored model preparation is ready; Compute has not run");
        assert_eq!(ready.progress_label.as_deref(), Some("ready"));

        let log = canonical_ready_preparation_log(now, "preparation completed");
        assert_eq!(log.stage_id, "ready");
        assert_eq!(log.timestamp_unix_ms, now);
    }

    fn accepted_source(
        run_id: &str,
        specification_character: char,
        problem_character: char,
        step_id: &str,
    ) -> AcceptedRunPreparationSource {
        AcceptedRunPreparationSource {
            schema_version: fullmag_application::ACCEPTED_RUN_PREPARATION_SOURCE_SCHEMA.into(),
            run_id: fullmag_application::RunId::parse(run_id).unwrap(),
            specification_fingerprint: digest(specification_character),
            step_id: step_id.into(),
            problem_fingerprint: digest(problem_character),
        }
    }

    fn accepted_test_specification(run_id: &str) -> RunSpecification {
        let mut specification = RunSpecification::new(
            ProjectSnapshot {
                project_id: ProjectId::parse("project-cross-store").unwrap(),
                definition_revision: 1,
                definition_sha256: "a".repeat(64),
            },
            StudyReference {
                study_id: StudyId::parse("study-cross-store").unwrap(),
                plan_version: "study_plan.v1".into(),
                plan_sha256: "b".repeat(64),
            },
            "c".repeat(64),
            json!({"temperature": 300}),
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
        specification.run_id = RunId::parse(run_id).unwrap();
        specification
    }

    fn accepted_test_receipt(
        specification: &RunSpecification,
        step_id: &str,
        preparation_id: &str,
    ) -> PreparationReceipt {
        let fingerprint = |hex: char| format!("sha256:{}", hex.to_string().repeat(64));
        let producer = |kind: PreparationProducerKind, output: char| {
            PreparationProducer::new(
                kind,
                format!("fullmag.{}", kind.as_str()),
                format!("{}.producer.v1", kind.as_str()),
                "test",
                fingerprint('a'),
                fingerprint(output),
            )
            .unwrap()
        };
        let specification_fingerprint = format!("sha256:{}", specification.fingerprint().unwrap());
        let source = fullmag_plan::PreparationPlanSource::accepted_run_step(
            specification.run_id.as_str(),
            specification_fingerprint,
            step_id,
        )
        .unwrap();
        let plan = PreparationPlan::new_for_accepted_run(
            fingerprint('b'),
            source,
            BackendTarget::Auto,
            BackendTarget::Fdm,
            producer(PreparationProducerKind::Geometry, '1'),
            producer(PreparationProducerKind::Display, '2'),
            producer(PreparationProducerKind::Grid, '3'),
            producer(PreparationProducerKind::Mesh, '4'),
            producer(PreparationProducerKind::Space, '5'),
        )
        .unwrap();
        let marker_map = fingerprint('c');
        let certificates = vec![
            PreparationCertificate {
                schema_version: fullmag_plan::PREPARATION_CERTIFICATE_SCHEMA.into(),
                producer: plan.geometry.clone(),
                quality: None,
                marker_map: None,
                cell_count: None,
                space: None,
            },
            PreparationCertificate {
                schema_version: fullmag_plan::PREPARATION_CERTIFICATE_SCHEMA.into(),
                producer: plan.display.clone(),
                quality: None,
                marker_map: None,
                cell_count: None,
                space: None,
            },
            PreparationCertificate {
                schema_version: fullmag_plan::PREPARATION_CERTIFICATE_SCHEMA.into(),
                producer: plan.grid.clone(),
                quality: None,
                marker_map: None,
                cell_count: Some(4),
                space: None,
            },
            PreparationCertificate {
                schema_version: fullmag_plan::PREPARATION_CERTIFICATE_SCHEMA.into(),
                producer: plan.mesh.clone(),
                quality: Some(PreparationQualityCertificate {
                    cell_count: 4,
                    invalid_cell_count: 0,
                    min_quality: Some(0.2),
                    max_aspect_ratio: Some(3.0),
                    jacobian: None,
                    quality_fingerprint: fingerprint('d'),
                    mesh_source: None,
                }),
                marker_map: Some(PreparationMarkerCertificate {
                    marker_map_fingerprint: marker_map.clone(),
                    marker_ids: vec![1],
                }),
                cell_count: Some(4),
                space: None,
            },
            PreparationCertificate {
                schema_version: fullmag_plan::PREPARATION_CERTIFICATE_SCHEMA.into(),
                producer: plan.space.clone(),
                quality: None,
                marker_map: Some(PreparationMarkerCertificate {
                    marker_map_fingerprint: marker_map.clone(),
                    marker_ids: vec![1],
                }),
                cell_count: None,
                space: Some(PreparationSpaceCertificate {
                    mesh_fingerprint: plan.mesh.output_fingerprint.clone(),
                    marker_map_fingerprint: Some(marker_map),
                    dof_count: 8,
                    space_fingerprint: plan.space.output_fingerprint.clone(),
                    fe_family: None,
                    fe_order: None,
                    local_dof_count: None,
                    true_dof_count: None,
                }),
            },
        ];
        PreparationReceipt::ready_for_accepted_run(
            preparation_id,
            plan,
            certificates,
            Vec::new(),
            specification,
            step_id,
        )
        .unwrap()
    }

    fn legacy_test_receipt(
        specification: &RunSpecification,
        preparation_id: &str,
    ) -> PreparationReceipt {
        let accepted_receipt = accepted_test_receipt(specification, "step-a", preparation_id);
        let accepted_plan = accepted_receipt.plan;
        let plan = PreparationPlan::new(
            accepted_plan.problem_fingerprint.clone(),
            1,
            accepted_plan.requested_backend.clone(),
            accepted_plan.resolved_backend.clone(),
            accepted_plan.geometry.clone(),
            accepted_plan.display.clone(),
            accepted_plan.grid.clone(),
            accepted_plan.mesh.clone(),
            accepted_plan.space.clone(),
        )
        .unwrap();
        PreparationReceipt::ready(
            preparation_id,
            plan,
            accepted_receipt.certificates,
            accepted_receipt.reuse,
        )
        .unwrap()
    }

    #[test]
    fn accepted_source_identity_accepts_exact_binding_and_rejects_stale_or_mismatched_input() {
        let source = accepted_source("run-accepted", 'a', 'b', "step-a");
        let plan_source = PreparationPlanSource::AcceptedRunStep {
            run_id: "run-accepted".into(),
            specification_fingerprint: digest('a'),
            step_id: "step-a".into(),
        };
        assert!(validate_accepted_source_plan_identity(
            "run-accepted",
            Some(&plan_source),
            &source,
        )
        .is_ok());

        let stale =
            validate_accepted_source_plan_identity("run-replaced", Some(&plan_source), &source)
                .expect_err("a source from the previous run must be fenced");
        assert_eq!(
            stale.code.as_deref(),
            Some("live_preparation_accepted_source_run_mismatch")
        );

        let mismatched_plan = PreparationPlanSource::AcceptedRunStep {
            run_id: "run-accepted".into(),
            specification_fingerprint: digest('c'),
            step_id: "step-a".into(),
        };
        let mismatch =
            validate_accepted_source_plan_identity("run-accepted", Some(&mismatched_plan), &source)
                .expect_err("a source rebound to another specification must be rejected");
        assert_eq!(
            mismatch.message,
            "live_preparation_accepted_source_plan_mismatch"
        );
    }

    #[test]
    fn accepted_stage_lookup_uses_typed_run_identity() {
        let run_id = "run-recovery";
        let specification = accepted_test_specification(run_id);
        let application = accepted_test_receipt(&specification, "step-a", "prep-recovery");
        let receipt = fullmag_session::FmsPreparationReceipt::new(
            "prep-recovery",
            run_id,
            application.plan_fingerprint.clone(),
            serde_json::to_value(application).unwrap(),
        );
        assert_eq!(
            accepted_stage_step_for_run(&receipt, run_id),
            Some("step-a".to_owned()),
        );
        assert_eq!(accepted_stage_step_for_run(&receipt, "run-other"), None);
    }

    #[test]
    fn stale_accepted_replacement_requires_previous_preparation_identity() {
        let previous = fullmag_session::FmsPreparationReceipt::new(
            "prep-previous",
            "run-previous",
            digest('a'),
            json!({
                "schema_version": fullmag_session::FMS_PREPARATION_RECEIPT_SCHEMA,
                "preparation_id": "prep-previous",
                "plan_fingerprint": digest('a'),
            }),
        );
        assert!(stale_replacement_snapshot_matches(
            &previous,
            Some("prep-previous"),
            Some("run-previous"),
        ));
        assert!(stale_replacement_snapshot_matches(
            &previous,
            Some("prep-previous"),
            None,
        ));
        assert!(!stale_replacement_snapshot_matches(
            &previous,
            Some("prep-next"),
            Some("run-previous"),
        ));
        assert!(!stale_replacement_snapshot_matches(
            &previous,
            Some("prep-previous"),
            Some("run-next"),
        ));
        assert!(!stale_replacement_snapshot_matches(&previous, None, None));
    }

    #[test]
    fn stale_accepted_replacement_accepts_stage_receipt_beyond_run_anchor() {
        // The accepted store keeps the first immutable anchor (stage A), while
        // the accepted store keeps the selected later stage (stage B).
        assert!(stale_replacement_durable_evidence_matches(
            "run-previous",
            "run-previous",
            false,
            Some("run-previous"),
            true,
            true,
        ));

        // A legacy MeshBuild has no accepted source and is eligible only when
        // its payload is exactly the live run anchor.
        assert!(stale_replacement_durable_evidence_matches(
            "run-legacy",
            "run-legacy",
            true,
            None,
            false,
            false,
        ));

        assert!(!stale_replacement_durable_evidence_matches(
            "run-previous",
            "run-current",
            false,
            Some("run-previous"),
            true,
            true,
        ));
        assert!(!stale_replacement_durable_evidence_matches(
            "run-previous",
            "run-previous",
            false,
            Some("run-current"),
            true,
            true,
        ));
        assert!(!stale_replacement_durable_evidence_matches(
            "run-previous",
            "run-previous",
            false,
            Some("run-previous"),
            false,
            true,
        ));
    }

    #[tokio::test]
    async fn accepted_commit_ignores_busy_live_journal_and_legacy_commit_still_uses_it() {
        let temporary = tempfile::tempdir().unwrap();
        let accepted_root = temporary.path().join("accepted-store");
        let live_root = temporary.path().join("live-store");
        let run_id = "test-run";
        let step_id = "step-a";
        let next_step_id = "step-b";
        let specification = accepted_test_specification(run_id);
        let task_id = fullmag_session::task_id_for_study_step(run_id, step_id).unwrap();
        let next_task_id =
            fullmag_session::task_id_for_study_step(run_id, next_step_id).unwrap();
        let preparation_id = format!("prep-{task_id}");
        let next_preparation_id = format!("prep-{next_task_id}");
        let receipt = accepted_test_receipt(&specification, step_id, &preparation_id);
        let next_receipt =
            accepted_test_receipt(&specification, next_step_id, &next_preparation_id);
        let payload = serde_json::to_value(&receipt).unwrap();
        let next_payload = serde_json::to_value(&next_receipt).unwrap();
        let accepted_store = fullmag_session::SessionStore::open(&accepted_root).unwrap();
        let intent = fullmag_session::FmsRunIntent::new(
            run_id,
            "intent-cross-store",
            serde_json::to_value(&specification).unwrap(),
        );
        accepted_store.commit_run_intent(&intent).unwrap();
        accepted_store
            .commit_run_catalog(&fullmag_session::FmsRunCatalog {
                schema_version: fullmag_session::FMS_RUN_CATALOG_SCHEMA.into(),
                run_id: run_id.into(),
                revision: 1,
                updated_at: chrono::Utc::now(),
                tasks: vec![fullmag_session::FmsTaskCatalogEntry {
                    task_id: task_id.clone(),
                    input_fingerprint: "d".repeat(64),
                    lifecycle: fullmag_session::FmsTaskLifecycle::Accepted,
                    readiness: fullmag_session::FmsTaskReadiness::Blocked {
                        reason: "awaiting preparation".into(),
                    },
                    observation: None,
                    attempt_id: None,
                    ownership_epoch: None,
                    resolved_input_fingerprint: None,
                    artifact_ids: Vec::new(),
                    resource_id: None,
                    coordinator_watermark: None,
                    coordinator_genesis: None,
                },
                fullmag_session::FmsTaskCatalogEntry {
                    task_id: next_task_id.clone(),
                    input_fingerprint: "e".repeat(64),
                    lifecycle: fullmag_session::FmsTaskLifecycle::Accepted,
                    readiness: fullmag_session::FmsTaskReadiness::Blocked {
                        reason: "awaiting preparation".into(),
                    },
                    observation: None,
                    attempt_id: None,
                    ownership_epoch: None,
                    resolved_input_fingerprint: None,
                    artifact_ids: Vec::new(),
                    resource_id: None,
                    coordinator_watermark: None,
                    coordinator_genesis: None,
                }],
            })
            .unwrap();
        accepted_store
            .commit_task_preparation_receipt(
                &fullmag_session::FmsTaskPreparationReceipt::new(
                    run_id,
                    step_id,
                    "d".repeat(64),
                    preparation_id.clone(),
                    receipt.plan_fingerprint.clone(),
                    payload,
                )
                .unwrap(),
            )
            .unwrap();
        accepted_store
            .commit_task_preparation_receipt(
                &fullmag_session::FmsTaskPreparationReceipt::new(
                    run_id,
                    next_step_id,
                    "e".repeat(64),
                    next_preparation_id.clone(),
                    next_receipt.plan_fingerprint.clone(),
                    next_payload,
                )
                .unwrap(),
            )
            .unwrap();

        let mut state = crate::router_v2::tests::test_app_state_with_live_session().await;
        let state_mut = std::sync::Arc::get_mut(&mut state).unwrap();
        state_mut.submit_store_root = Some(accepted_root.clone());
        state_mut.current_command_journal_store_root = Some(live_root.clone());
        let context = crate::capture_current_live_request_context(&state)
            .await
            .unwrap();
        let live_store = fullmag_session::SessionStore::open(&live_root).unwrap();
        let contention_store =
            fullmag_session::SessionStore::open_existing(&accepted_root).unwrap();
        let live_contention_store =
            fullmag_session::SessionStore::open_existing(&live_root).unwrap();
        let (ready_tx, ready_rx) = std::sync::mpsc::channel();
        let (go_tx, go_rx) = std::sync::mpsc::channel();
        let contention_thread = std::thread::spawn(move || {
            let Ok(accepted_lease) = contention_store.write_transaction() else {
                let _ = ready_tx.send(false);
                return;
            };
            let Ok(live_lease) = live_contention_store.write_transaction() else {
                drop(accepted_lease);
                let _ = ready_tx.send(false);
                return;
            };
            if ready_tx.send(true).is_err() {
                drop(live_lease);
                drop(accepted_lease);
                return;
            }
            if go_rx
                .recv_timeout(std::time::Duration::from_secs(5))
                .is_ok()
            {
                // Start the bounded hold only after the main thread has
                // witnessed the native conflict and is about to call the API.
                std::thread::sleep(std::time::Duration::from_millis(250));
            }
            drop(live_lease);
            drop(accepted_lease);
        });
        let ready = ready_rx.recv_timeout(std::time::Duration::from_secs(5));
        let probe_error = match (
            &ready,
            fullmag_session::SessionStore::open_existing(&accepted_root),
        ) {
            (Ok(true), Ok(probe)) => match probe.write_transaction() {
                Ok(lease) => {
                    drop(lease);
                    None
                }
                Err(error) => Some(error),
            },
            (_, Err(error)) => Some(error),
            _ => None,
        };
        let native_busy = probe_error.as_ref().is_some_and(|error| {
            error
                .chain()
                .any(|cause| cause.is::<fullmag_session::StoreWriterBusy>())
                && format!("{error:#}").contains("conflict=native descriptor")
        });
        let live_probe_error = match (
            &ready,
            fullmag_session::SessionStore::open_existing(&live_root),
        ) {
            (Ok(true), Ok(probe)) => match probe.write_transaction() {
                Ok(lease) => {
                    drop(lease);
                    None
                }
                Err(error) => Some(error),
            },
            (_, Err(error)) => Some(error),
            _ => None,
        };
        let live_native_busy = live_probe_error.as_ref().is_some_and(|error| {
            error
                .chain()
                .any(|cause| cause.is::<fullmag_session::StoreWriterBusy>())
                && format!("{error:#}").contains("conflict=native descriptor")
        });
        let _transition = state.current_live_session_transition.lock().await;
        let go_sent = go_tx.send(()).is_ok();
        let disposition = if native_busy && live_native_busy && go_sent {
            commit_live_preparation_receipt_for_context_under_transition(
                &state,
                &context,
                receipt.clone(),
                None,
                None,
                Some(run_id),
            )
            .await
        } else {
            Err(ApiError::conflict(
                "test setup did not establish native writer contention",
            ))
        };
        let contention_join = contention_thread.join();
        assert!(
            matches!(ready, Ok(true)),
            "contention thread did not acquire the native writer: {ready:?}"
        );
        assert!(
            native_busy,
            "test setup must observe native StoreWriterBusy before accepted commit: {probe_error:?}"
        );
        assert!(
            live_native_busy,
            "test setup must hold the live journal writer during accepted commit: {live_probe_error:?}"
        );
        assert!(
            go_sent,
            "contention thread was not ready to start its bounded hold"
        );
        assert!(
            contention_join.is_ok(),
            "contention thread must finish bounded cleanup"
        );
        let disposition = disposition.unwrap();
        assert_eq!(
            disposition,
            fullmag_session::PreparationReceiptCommitDisposition::Accepted
        );
        let accepted_anchor = accepted_store
            .read_preparation_receipt(run_id)
            .unwrap()
            .expect("accepted run anchor must be in the accepted store");
        assert_eq!(accepted_anchor.preparation_id, preparation_id);
        let stage = accepted_store
            .read_accepted_stage_preparation_receipt(run_id, step_id)
            .unwrap()
            .expect("accepted stage pointer must be in the accepted store");
        assert_eq!(stage.preparation_id, preparation_id);
        assert!(
            live_store.read_preparation_receipt(run_id).unwrap().is_none(),
            "live journal store must not receive an accepted run anchor"
        );
        assert!(
            live_store.read_run_catalog(run_id).unwrap().is_none(),
            "live journal store must not receive an accepted run catalog"
        );

        drop(_transition);
        let _transition = state.current_live_session_transition.lock().await;
        let replay = commit_live_preparation_receipt_for_context_under_transition(
            &state, &context, receipt.clone(), None, None, Some(run_id),
        )
        .await
        .unwrap();
        assert_eq!(
            replay,
            fullmag_session::PreparationReceiptCommitDisposition::Replayed
        );

        drop(_transition);
        let _transition = state.current_live_session_transition.lock().await;
        let next_stage = commit_live_preparation_receipt_for_context_under_transition(
            &state,
            &context,
            next_receipt.clone(),
            None,
            None,
            Some(run_id),
        )
        .await
        .unwrap();
        assert_eq!(
            next_stage,
            fullmag_session::PreparationReceiptCommitDisposition::Accepted
        );
        assert_eq!(
            accepted_store
                .read_preparation_receipt(run_id)
                .unwrap()
                .unwrap()
                .preparation_id,
            preparation_id
        );
        assert!(accepted_store
            .read_accepted_stage_preparation_receipt(run_id, next_step_id)
            .unwrap()
            .is_some());

        drop(_transition);
        let _transition = state.current_live_session_transition.lock().await;
        let next_replay = commit_live_preparation_receipt_for_context_under_transition(
            &state,
            &context,
            next_receipt.clone(),
            None,
            None,
            Some(run_id),
        )
        .await
        .unwrap();
        assert_eq!(
            next_replay,
            fullmag_session::PreparationReceiptCommitDisposition::Replayed
        );

        let next_stage_receipt = accepted_store
            .read_accepted_stage_preparation_receipt(run_id, next_step_id)
            .unwrap()
            .unwrap();
        let stage_path = accepted_root.join(next_stage_receipt.relative_path().unwrap());
        std::fs::remove_file(stage_path).unwrap();
        *state.current_live_preparation_receipt.write().await = None;
        drop(_transition);
        let _transition = state.current_live_session_transition.lock().await;
        let recovered = commit_live_preparation_receipt_for_context_under_transition(
            &state,
            &context,
            next_receipt,
            None,
            None,
            Some(run_id),
        )
        .await
        .unwrap();
        assert_eq!(
            recovered,
            fullmag_session::PreparationReceiptCommitDisposition::Accepted
        );
        assert!(
            accepted_store
                .read_accepted_stage_preparation_receipt(run_id, next_step_id)
                .unwrap()
                .is_some(),
            "missing stage pointer must be rebuilt from the immutable task receipt"
        );

        // The legacy path publishes against a run already catalogued in the
        // live journal. Set it up only after checking that accepted commits did
        // not create any live-journal catalog or anchor.
        live_store
            .commit_run_catalog(&fullmag_session::FmsRunCatalog {
                schema_version: fullmag_session::FMS_RUN_CATALOG_SCHEMA.into(),
                run_id: run_id.into(),
                revision: 1,
                updated_at: chrono::Utc::now(),
                tasks: Vec::new(),
            })
            .unwrap();
        let legacy_receipt = legacy_test_receipt(&specification, "prep-live-legacy");
        let legacy_disposition = commit_live_preparation_receipt_for_context_under_transition(
            &state,
            &context,
            legacy_receipt,
            None,
            None,
            Some(run_id),
        )
        .await
        .unwrap();
        assert_eq!(
            legacy_disposition,
            fullmag_session::PreparationReceiptCommitDisposition::Accepted
        );
        assert_eq!(
            live_store
                .read_preparation_receipt(run_id)
                .unwrap()
                .unwrap()
                .preparation_id,
            "prep-live-legacy",
            "unaccepted legacy receipt must continue to use the current-live journal store"
        );
        assert_eq!(
            accepted_store
                .read_preparation_receipt(run_id)
                .unwrap()
                .unwrap()
                .preparation_id,
            preparation_id,
            "legacy receipt must not replace the accepted-store run anchor"
        );
    }

    #[test]
    fn accepted_receipt_requires_exact_immutable_task_payload() {
        let expected = json!({
            "preparation_id": "prep-step-a",
            "plan_fingerprint": digest('d'),
            "accepted_run_source": {"step_id": "step-a"},
        });
        assert!(validate_accepted_receipt_payload_identity(&expected, &expected).is_ok());

        let mut changed = expected.clone();
        changed["plan_fingerprint"] = json!(digest('e'));
        let error = validate_accepted_receipt_payload_identity(&changed, &expected)
            .expect_err("a changed accepted receipt payload must not be rebound");
        assert_eq!(
            error.code.as_deref(),
            Some("accepted_preparation_task_receipt_mismatch")
        );
    }

    #[test]
    fn read_model_binding_requires_the_same_preparation_revision_and_plan() {
        let plan_fingerprint = digest('f');
        assert!(validate_live_read_model_binding(
            "prep-step-a",
            7,
            &plan_fingerprint,
            "prep-step-a",
            Some(7),
            &plan_fingerprint,
        )
        .is_ok());

        let error = validate_live_read_model_binding(
            "prep-step-a",
            8,
            &plan_fingerprint,
            "prep-step-a",
            Some(7),
            &plan_fingerprint,
        )
        .expect_err("a stale scene revision must not expose a read model");
        assert!(error.message.contains("scene revisions disagree"));
    }

    fn prepared_fem_read_model(with_topology: bool) -> LiveScenePreparationReadModel {
        let mut fem = fullmag_ir::FemPlanIR::default();
        fem.mesh_name = "prepared-tetra".into();
        fem.fe_order = 1;
        if with_topology {
            fem.mesh.nodes = vec![
                [0.0, 0.0, 0.0],
                [1e-9, 0.0, 0.0],
                [0.0, 1e-9, 0.0],
                [0.0, 0.0, 1e-9],
            ];
            fem.mesh.cells = fullmag_ir::FemConnectivityIR::from_tet4(vec![[0, 1, 2, 3]]);
            fem.mesh.element_markers = vec![1];
            fem.initial_magnetization = vec![[1.0, 0.0, 0.0]; 4];
        }
        LiveScenePreparationReadModel {
            schema_version: LIVE_SCENE_PREPARATION_READ_MODEL_SCHEMA,
            global_sampling_mesh: None,
            preparation_id: "prep-domain".into(),
            scene_revision: 7,
            plan_fingerprint: digest('a'),
            requested_execution: RequestedExecution {
                backend: "fem".into(),
                device: "gpu".into(),
                precision: "double".into(),
                mode: "strict".into(),
                minimum_resources: None,
            },
            execution_plan: fullmag_ir::ExecutionPlanIR {
                common: fullmag_ir::CommonPlanMeta {
                    ir_version: "test".into(),
                    requested_backend: fullmag_ir::BackendTarget::Fem,
                    resolved_backend: fullmag_ir::BackendTarget::Fem,
                    execution_mode: fullmag_ir::ExecutionMode::Strict,
                    material_field_plans: Vec::new(),
                },
                backend_plan: fullmag_ir::BackendPlanIR::Fem(fem),
                output_plan: fullmag_ir::OutputPlanIR {
                    outputs: Vec::new(),
                },
                provenance: fullmag_ir::ProvenancePlanIR {
                    notes: Vec::new(),
                    integrator_resolution: None,
                    fem_eigen_execution_resolution: None,
                    physics_graph: None,
                },
            },
        }
    }

    #[tokio::test]
    async fn absorbing_boundary_live_fem_projects_edited_and_removed_profiles_in_native_node_order() {
        for equal_node_and_element_counts in [false, true] {
            check_fem_damping_endpoints(equal_node_and_element_counts).await;
        }
    }

    async fn check_fem_damping_endpoints(equal_node_and_element_counts: bool) {
        use fullmag_ir::{AirBoxPolicyIR, BackendTarget, DiscretizationHintsIR, EnergyTermIR,
            FemConnectivityIR, FemDomainMeshAssetIR, FemDomainRegionMarkerIR, FemFacetConnectivityIR,
            FemHintsIR, GeometryAssetsIR, MeshIR, ProblemIR};

        let mut problem = ProblemIR::bootstrap_example();
        problem.backend_policy.requested_backend = BackendTarget::Fem;
        problem.backend_policy.discretization_hints = Some(DiscretizationHintsIR {
            fdm: None, hybrid: None,
            fem: Some(FemHintsIR { order: 1, hmax: 2e-9, mesh: None, demag_solver_policy: None }),
        });
        problem.air_box_policy = Some(AirBoxPolicyIR { boundary_marker: Some(99), ..Default::default() });
        problem.energy_terms = vec![EnergyTermIR::Exchange];
        problem.geometry_assets = Some(GeometryAssetsIR {
            fdm_grid_assets: vec![], fem_mesh_assets: vec![],
            fem_domain_mesh_asset: Some(FemDomainMeshAssetIR {
                mesh_source: None, build_report: None, object_region_markers: vec![],
                region_markers: vec![FemDomainRegionMarkerIR { geometry_name: "strip".into(), marker: 1 }],
                mesh: Some(MeshIR {
                    mesh_name: "strip".into(),
                    nodes: vec![[0.,0.,0.], [1e-9,0.,0.], [0.,1e-9,0.], [0.,0.,1e-9],
                        [-2e-9,-2e-9,-2e-9], [2e-9,-2e-9,-2e-9], [-2e-9,2e-9,-2e-9], [-2e-9,-2e-9,2e-9]],
                    cells: FemConnectivityIR::from_tet4(vec![[0,1,2,3], [4,5,6,7]]),
                    element_markers: vec![1,0],
                    facets: FemFacetConnectivityIR::from_tri3(vec![[0,1,2], [4,5,6]]),
                    boundary_markers: vec![1,99], periodic_boundary_pairs: vec![], periodic_node_pairs: vec![],
                    per_domain_quality: Default::default(),
                }),
            }),
        });
        if equal_node_and_element_counts {
            let mesh = problem.geometry_assets.as_mut().unwrap().fem_domain_mesh_asset.as_mut()
                .unwrap().mesh.as_mut().unwrap();
            let mut magnetic = vec![[0_u32, 1, 2, 3]];
            // Three conforming barycentric subdivisions each add one node and
            // three tetrahedra. The full mesh then has 11 nodes and 11 cells.
            for _ in 0..3 {
                let cell = magnetic.pop().unwrap();
                let center = std::array::from_fn(|axis| cell.iter()
                    .map(|index| mesh.nodes[*index as usize][axis] * 0.25).sum());
                let index = mesh.nodes.len() as u32;
                mesh.nodes.push(center);
                for slot in 0..4 {
                    let mut child = cell;
                    child[slot] = index;
                    magnetic.push(child);
                }
            }
            mesh.element_markers = vec![1; magnetic.len()];
            mesh.element_markers.push(0);
            magnetic.push([4, 5, 6, 7]);
            mesh.cells = FemConnectivityIR::from_tet4(magnetic);
            assert_eq!(mesh.nodes.len(), mesh.cell_count());
        }
        let fullmag_ir::StudyIR::TimeEvolution {
            dynamics: fullmag_ir::DynamicsIR::Llg { fixed_timestep, .. }, ..
        } = &mut problem.study else { panic!("fixture requires LLG time evolution") };
        // The refined tetrahedra have sub-nanometre edges.
        *fixed_timestep = Some(1e-17);
        let mut model = prepared_fem_read_model(true);
        model.execution_plan = fullmag_plan::plan(&problem).unwrap();
        let layout = fullmag_runner::study_magnetization_layout_for_plan(&model.execution_plan).unwrap();
        let mut request: CurrentLiveSnapshotRequest = serde_json::from_value(json!({"session_id": "fem-absorber"})).unwrap();
        let mut snapshot = crate::session::default_current_live_state(&request);
        let (metadata, mesh) = prepared_domain_publication(&snapshot, &model).unwrap();
        request.metadata = Some(metadata);
        request.fem_mesh = mesh;
        crate::session::apply_current_live_snapshot(&mut snapshot, request).unwrap();
        let mesh_revision = snapshot.mesh_revision;
        let base = problem.materials[0].damping;
        for (i, face) in [Some("x+"), Some("x-"), None].into_iter().enumerate() {
            problem.magnets[0].absorbing_boundary = face.map(|face| serde_json::from_value(json!({
                "total_width_m": 0.5e-9, "ramp_width_m": 0.25e-9, "max_damping": 0.5,
                "faces": [face], "profile": "linear", "frame": "object"
            })).unwrap());
            let plan = fullmag_plan::plan(&problem).unwrap();
            let updated_layout = fullmag_runner::study_magnetization_layout_for_plan(&plan).unwrap();
            assert_eq!(layout, updated_layout);
            let revision = i as u64 + 1;
            let projected = crate::live_authored_damping::project_damping(plan.backend_plan, updated_layout, revision).unwrap();
            snapshot.metadata.as_mut().unwrap()["authored_damping"] =
                crate::live_authored_damping::binding(revision, Some(&projected));
            crate::session::replace_authored_damping(&mut snapshot, Some(projected));
            let published = crate::session::resolved_current_field_source(&snapshot, "mat_alpha", 1);
            let Some(crate::session::ResolvedCurrentFieldSource::Latest(raw)) = published else {
                panic!("edited FEM damping must be an accepted native scalar source");
            };
            let samples = raw["values"].as_array().unwrap();
            let nodes = &snapshot.fem_mesh.as_ref().unwrap().nodes;
            assert_eq!(samples.len(), nodes.len());
            for (node, sample) in nodes[..4].iter().zip(samples) {
                let at_face = match face { Some("x+") => node[0] > 0., Some("x-") => node[0] == 0., _ => false };
                let expected = base + if at_face {0.5} else {0.0};
                assert!((sample.as_f64().unwrap() - expected).abs() < 1e-12);
            }
            assert_eq!(snapshot.mesh_revision, mesh_revision);
            let expected: Vec<f64> = samples.iter().map(|sample| sample.as_f64().unwrap()).collect();
            crate::router_v2::tests::assert_fem_absorber_field_endpoints(&snapshot, &expected).await;
        }
    }

    fn prepared_field_only_read_model() -> LiveScenePreparationReadModel {
        let mut model = prepared_fem_read_model(true);
        let fullmag_ir::BackendPlanIR::Fem(fem) = &model.execution_plan.backend_plan else {
            unreachable!();
        };
        model.execution_plan.backend_plan = fullmag_ir::BackendPlanIR::AntennaFieldOnly(
            fullmag_ir::AntennaFieldOnlyPlanIR {
                schema_version: "antenna_field_only_plan.v1".into(),
                stage_id: "inspect".into(),
                port_mode_id: "port".into(),
                source_object_id: "conductor".into(),
                source_mesh: fem.mesh.clone(),
                source_object_segments: Vec::new(),
                source_mesh_parts: Vec::new(),
                field_sampling: fullmag_ir::AntennaFieldSamplingPlanIR {
                    domain: fullmag_ir::FieldTargetIR::Object { object_id: "sampling".into() },
                    carrier_kind: "points".into(),
                    location: "node".into(),
                    topology_digest: digest('b'),
                    positions_xyz_m: vec![[2e-9, 0.0, 0.0]],
                    cells: fullmag_ir::FemConnectivityIR::empty(),
                },
            },
        );
        model
    }

    #[test]
    fn prepared_field_only_domain_publishes_canonical_source_topology_without_magnetic_fields() {
        let request: CurrentLiveSnapshotRequest = serde_json::from_value(json!({
            "session_id": "prepared-field-only-session",
        })).unwrap();
        let mut snapshot = crate::session::default_current_live_state(&request);
        snapshot.metadata = Some(json!({"artifact_layout": {"backend": "fdm"}}).into());
        snapshot.latest_fields = serde_json::from_value(json!({
            "m": {"values": [[1.0, 0.0, 0.0]]},
            "mat_ms": {"values": [800_000.0]},
            "mat_aex": {"values": [1e-11]},
        })).unwrap();
        let model = prepared_field_only_read_model();
        let expected = fullmag_runner::StageFemMeshAsset::build_from_backend_plan(
            &model.execution_plan.backend_plan,
        ).unwrap().payload;
        let (metadata, mesh) = prepared_domain_publication(&snapshot, &model).unwrap();
        assert!(metadata.get("artifact_layout").is_none());
        assert_eq!(metadata["magnetic_state_present"], false);
        assert!(metadata["capabilities"].is_null());
        let mesh = mesh.expect("field-only source topology must be visible before Compute");
        assert_eq!(mesh.generation_id, expected.generation_id);
        assert_eq!(mesh.nodes, expected.nodes);
        assert_eq!(mesh.cells, expected.cells);
        let mut publication = request;
        publication.metadata = Some(metadata);
        publication.fem_mesh = Some(mesh);
        crate::session::apply_current_live_snapshot(&mut snapshot, publication).unwrap();
        publish_prepared_initial_state(&mut snapshot, &model, false).unwrap();
        assert!(snapshot.fem_mesh.is_some());
        assert!(snapshot.latest_fields.get("m").is_none());
        assert!(snapshot.latest_fields.get("mat_ms").is_none());
        assert!(snapshot.latest_fields.get("mat_aex").is_none());
        assert!(snapshot.live_state.is_none());
        assert!(snapshot.quantities.is_empty());
        assert!(snapshot.capabilities.is_none());
        assert!(snapshot.scalar_rows.is_empty());
        assert!(!crate::field_store::serialize_fem_mesh_topology_binary_v2(
            snapshot.fem_mesh.as_ref().unwrap(),
        ).unwrap().is_empty());
    }

    fn global_field_only_fixture() -> (fullmag_ir::ProblemIR, LiveScenePreparationReadModel) {
        use sha2::{Digest, Sha256};
        let mut model = prepared_field_only_read_model();
        let fullmag_ir::BackendPlanIR::AntennaFieldOnly(plan) =
            &mut model.execution_plan.backend_plan
        else {
            unreachable!()
        };
        let mut mesh = plan.source_mesh.clone();
        mesh.mesh_name = "global-sampling".into();
        mesh.nodes.push([0.0, 0.0, -1e-9]);
        mesh.cells = fullmag_ir::FemConnectivityIR::from_tet4(vec![[0, 1, 2, 3], [0, 2, 1, 4]]);
        mesh.element_markers = vec![1, 0];
        mesh.facets = fullmag_ir::FemFacetConnectivityIR::from_tri3(vec![
            [0, 1, 3],
            [0, 3, 2],
            [1, 2, 3],
            [0, 2, 4],
            [0, 4, 1],
            [2, 1, 4],
        ]);
        mesh.boundary_markers = vec![1; 6];
        plan.field_sampling.domain = fullmag_ir::FieldTargetIR::Global {};
        plan.field_sampling.carrier_kind = "fem_domain_mesh_asset".into();
        plan.field_sampling.positions_xyz_m = mesh.nodes.clone();
        plan.field_sampling.cells = mesh.cells.clone();
        plan.field_sampling.topology_digest = format!(
            "sha256:{:x}",
            Sha256::digest(serde_json::to_vec(&mesh).unwrap())
        );
        let mut problem = fullmag_ir::ProblemIR::bootstrap_example();
        problem.magnets.clear();
        let source_geometry = problem.geometry.entries[0].name().to_owned();
        plan.source_object_id = source_geometry.clone();
        plan.source_mesh.nodes = vec![
            [0.0, 0.0, 0.0],
            [1e-9, 0.0, 0.0],
            [0.0, 1e-9, 0.0],
            [0.0, 0.0, 1e-9],
            [0.0, 0.0, 0.0],
            [1e-9, 0.0, 0.0],
            [0.0, 1e-9, 0.0],
            [0.0, 0.0, -1e-9],
        ];
        plan.source_mesh.cells =
            fullmag_ir::FemConnectivityIR::from_tet4(vec![[0, 1, 2, 3], [4, 6, 5, 7]]);
        plan.source_mesh.element_markers = vec![1, 2];
        plan.source_object_segments = vec![fullmag_ir::FemObjectSegmentIR {
            object_id: source_geometry.clone(),
            geometry_id: Some(source_geometry.clone()),
            node_start: 0,
            node_count: 8,
            element_start: 0,
            element_count: 2,
            boundary_face_start: 0,
            boundary_face_count: 0,
        }];
        problem.geometry_assets = Some(fullmag_ir::GeometryAssetsIR {
            fem_domain_mesh_asset: Some(fullmag_ir::FemDomainMeshAssetIR {
                mesh: Some(mesh),
                mesh_source: None,
                region_markers: vec![fullmag_ir::FemDomainRegionMarkerIR {
                    geometry_name: source_geometry,
                    marker: 1,
                }],
                object_region_markers: Vec::new(),
                build_report: None,
            }),
            ..Default::default()
        });
        (problem, model)
    }

    #[test]
    fn global_preparation_preserves_sampling_order_and_independent_source() {
        let (problem, mut model) = global_field_only_fixture();
        model.global_sampling_mesh =
            antenna_domain::pinned_global_mesh(&problem, &model.execution_plan).unwrap();
        let request = serde_json::from_value(serde_json::json!({"session_id":"global"})).unwrap();
        let snapshot = crate::session::default_current_live_state(&request);
        let (metadata, mesh) = prepared_domain_publication(&snapshot, &model).unwrap();
        let mesh = mesh.unwrap();
        let fullmag_ir::BackendPlanIR::AntennaFieldOnly(plan) = &model.execution_plan.backend_plan
        else {
            unreachable!()
        };
        assert_eq!(mesh.nodes, plan.field_sampling.positions_xyz_m);
        assert_eq!(mesh.cells, plan.field_sampling.cells);
        assert_eq!(mesh.element_markers, vec![1, 0]);
        assert_eq!(mesh.facets.len(), 6);
        assert_eq!(mesh.mesh_parts.len(), 2);
        assert_eq!(mesh.mesh_parts[0].role, "conductor");
        assert_eq!(
            mesh.mesh_parts[0].object_id.as_deref(),
            Some(plan.source_object_id.as_str())
        );
        assert_eq!(mesh.mesh_parts[1].role, "air");
        assert_eq!(mesh.mesh_parts[1].element_start, 1);
        assert_eq!(mesh.mesh_parts[1].node_indices, vec![0, 1, 2, 4]);
        let source =
            fullmag_runner::StageFemMeshAsset::build_from_antenna_field_only_plan(plan).payload;
        assert_eq!(source.nodes.len(), 8);
        assert_eq!(source.cells.len(), 2);
        assert_eq!(source.nodes[0], source.nodes[4]);
        assert_eq!(source.cells, plan.source_mesh.cells);
        assert_ne!(mesh.generation_id, source.generation_id);
        assert_eq!(
            metadata["antenna_domain_publication"]["sampling_topology_digest"],
            plan.field_sampling.topology_digest
        );
        assert!(
            serde_json::to_value(&model)
                .unwrap()
                .get("global_sampling_mesh")
                .is_none()
        );
    }

    #[test]
    fn global_preparation_preserves_explicit_magnetic_target_ownership() {
        use sha2::{Digest, Sha256};
        let (mut problem, mut model) = global_field_only_fixture();
        let mut geometry = serde_json::to_value(&problem.geometry.entries[0]).unwrap();
        geometry["name"] = json!("waveguide-geometry");
        problem
            .geometry
            .entries
            .push(serde_json::from_value(geometry).unwrap());
        problem.regions.push(fullmag_ir::RegionIR {
            name: "waveguide-region".into(),
            geometry: "waveguide-geometry".into(),
        });
        problem.magnets.push(fullmag_ir::MagnetIR {
            object_id: Some("waveguide".into()),
            name: "waveguide".into(),
            region: "waveguide-region".into(),
            material: "magnetic-material".into(),
            initial_magnetization: None,
            absorbing_boundary: None,
        });
        let asset = problem
            .geometry_assets
            .as_mut()
            .unwrap()
            .fem_domain_mesh_asset
            .as_mut()
            .unwrap();
        asset
            .region_markers
            .push(fullmag_ir::FemDomainRegionMarkerIR {
                geometry_name: "waveguide-geometry".into(),
                marker: 2,
            });
        let mesh = asset.mesh.as_mut().unwrap();
        mesh.element_markers[1] = 2;
        let fullmag_ir::BackendPlanIR::AntennaFieldOnly(plan) =
            &mut model.execution_plan.backend_plan
        else {
            unreachable!()
        };
        plan.field_sampling.topology_digest = format!(
            "sha256:{:x}",
            Sha256::digest(serde_json::to_vec(mesh).unwrap())
        );
        let payload = antenna_domain::pinned_global_mesh(&problem, &model.execution_plan)
            .unwrap()
            .unwrap();
        assert_eq!(payload.mesh_parts[0].role, "conductor");
        assert_eq!(payload.mesh_parts[1].role, "magnetic_object");
        assert_eq!(
            payload.mesh_parts[1].object_id.as_deref(),
            Some("waveguide")
        );
        assert_eq!(payload.element_markers, vec![1, 2]);
    }

    #[test]
    fn global_source_scope_retains_cut_and_rejects_stale_binding() {
        let (problem, mut model) = global_field_only_fixture();
        model.global_sampling_mesh =
            antenna_domain::pinned_global_mesh(&problem, &model.execution_plan).unwrap();
        let request = serde_json::from_value(json!({"session_id":"global-source"})).unwrap();
        let mut snapshot = crate::session::default_current_live_state(&request);
        let (metadata, mesh) = prepared_domain_publication(&snapshot, &model).unwrap();
        let fullmag_ir::BackendPlanIR::AntennaFieldOnly(plan) = &model.execution_plan.backend_plan
        else {
            unreachable!()
        };
        let source_id = plan.source_object_id.clone();
        let mut scene = fullmag_authoring::SceneDocument::default();
        scene.revision = 7;
        scene.study.requested_backend = "fem".into();
        scene.objects.push(
            serde_json::from_value(json!({
                "id": source_id, "name": "Current source", "role": "antenna",
                "geometry": {"geometry_kind":"Box", "geometry_params":{"size":[1e-9,1e-9,1e-9]}},
                "material_ref":"", "magnetization_ref":null,
            }))
            .unwrap(),
        );
        snapshot.scene_document = Some(scene);
        snapshot.metadata = Some(metadata.into());
        snapshot.fem_mesh = mesh.map(Into::into);
        snapshot.mesh_workspace = Some(
            json!({
                "schema_version": LIVE_SCENE_PREPARATION_READ_MODEL_SCHEMA,
                "source_scene_revision":7, "preparation_id":"prep-domain", "status":"completed",
                "execution_plan": model.execution_plan, "accepted_run_id": snapshot.session.run_id,
            })
            .into(),
        );
        snapshot.simulation_preparation = Some(crate::types::SimulationPreparationSnapshot {
            preparation_id: "prep-domain".into(),
            revision: 1,
            status: "ready".into(),
            active_stage_id: None,
            started_at_unix_ms: 1,
            completed_at_unix_ms: Some(2),
            stages: Vec::new(),
            log_tail: Vec::new(),
            failure: None,
        });
        let resolve = crate::router_v2::handlers::meshing::mesh::field_only_source_payload;
        let source = resolve(&snapshot, &source_id).unwrap().unwrap();
        assert_eq!(source.nodes.len(), 8);
        assert_eq!(source.nodes[0], source.nodes[4]);
        assert_eq!(source.element_markers, vec![1, 2]);
        snapshot.session.status = "completed".into();
        assert!(resolve(&snapshot, &source_id).unwrap().is_some());
        let metadata = snapshot.metadata.take();
        assert!(resolve(&snapshot, &source_id).is_err());
        snapshot.metadata = metadata;
        snapshot.scene_document.as_mut().unwrap().revision += 1;
        assert!(resolve(&snapshot, &source_id).is_err());
    }

    #[test]
    fn global_preparation_rejects_missing_or_different_pinned_mesh() {
        let (mut problem, model) = global_field_only_fixture();
        problem
            .geometry_assets
            .as_mut()
            .unwrap()
            .fem_domain_mesh_asset
            .as_mut()
            .unwrap()
            .mesh
            .as_mut()
            .unwrap()
            .nodes[0][0] += 1e-12;
        assert!(antenna_domain::pinned_global_mesh(&problem, &model.execution_plan).is_err());
        problem
            .geometry_assets
            .as_mut()
            .unwrap()
            .fem_domain_mesh_asset
            .as_mut()
            .unwrap()
            .mesh = None;
        assert!(antenna_domain::pinned_global_mesh(&problem, &model.execution_plan).is_err());
        let request =
            serde_json::from_value(serde_json::json!({"session_id":"global-missing"})).unwrap();
        let snapshot = crate::session::default_current_live_state(&request);
        assert!(prepared_domain_publication(&snapshot, &model).is_err());
        let metadata: crate::shared_json::SharedJson =
            serde_json::json!({"execution_plan": model.execution_plan}).into();
        assert!(crate::quantities::extract_fem_mesh_from_metadata(&metadata).is_none());
    }

    fn prepared_multilayer_read_model() -> LiveScenePreparationReadModel {
        let layer = |layer_id: &str,
                     object_id: &str,
                     magnet_name: &str,
                     native_grid: [u32; 3],
                     native_origin: [f64; 3],
                     initial_magnetization: Vec<[f64; 3]>| {
            fullmag_ir::FdmLayerPlanIR {
                rotated_interfacial_dmi: None,
                magnet_name: magnet_name.into(),
                layer_id: layer_id.into(),
                object_id: object_id.into(),
                native_grid,
                native_cell_size: [1.0, 1.0, 1.0],
                native_origin,
                native_active_mask: None,
                native_region_mask: None,
                native_region_legend: None,
                initial_magnetization,
                material: fullmag_ir::FdmMaterialIR::default(),
                convolution_grid: [2, 1, 2],
                convolution_cell_size: [1.0, 1.0, 1.0],
                convolution_origin: [0.0, 0.0, 0.0],
                transfer_kind: "identity".into(),
            }
        };
        let multilayer = fullmag_ir::FdmMultilayerPlanIR {
            mode: "two_d_stack".into(),
            common_cells: [2, 1, 2],
            requested_common_cell_size: None,
            grid_certificate: None,
            layers: vec![
                layer(
                    "layer:top",
                    "object:top",
                    "top",
                    [2, 1, 1],
                    [0.0, 0.0, 0.0],
                    vec![[1.0, 0.0, 0.0], [2.0, 0.0, 0.0]],
                ),
                layer(
                    "layer:bottom",
                    "object:bottom",
                    "bottom",
                    [1, 1, 2],
                    [0.0, 0.0, 2.0],
                    vec![[3.0, 0.0, 0.0], [4.0, 0.0, 0.0]],
                ),
            ],
            frozen_spins: None,
            enable_exchange: false,
            enable_demag: true,
            fft: None,
            external_field: None,
            interfacial_dmi: None,
            rotated_interfacial_dmi: None,
            bulk_dmi: None,
            gyromagnetic_ratio: 1.0,
            precision: fullmag_ir::ExecutionPrecision::Double,
            precision_policy: fullmag_ir::FdmPrecisionPolicyIR::default(),
            exchange_bc: fullmag_ir::ExchangeBoundaryCondition::Neumann,
            periodicity: None,
            resolved_periodic_images: None,
            integrator: fullmag_ir::IntegratorChoice::Heun,
            fixed_timestep: Some(1e-13),
            field_refresh: None,
            relaxation: None,
            planner_summary: fullmag_ir::FdmMultilayerSummaryIR {
                requested_strategy: "multilayer_convolution".into(),
                selected_strategy: "multilayer_convolution".into(),
                requested_mode: "two_d_stack".into(),
                resolved_mode: "two_d_stack".into(),
                eligibility: "eligible".into(),
                estimated_pair_kernels: 1,
                estimated_unique_kernels: 1,
                estimated_kernel_bytes: 0,
                warnings: Vec::new(),
            },
        };
        let mut model = prepared_fem_read_model(true);
        model.requested_execution.backend = "fdm".into();
        model.execution_plan.common.requested_backend = fullmag_ir::BackendTarget::Fdm;
        model.execution_plan.common.resolved_backend = fullmag_ir::BackendTarget::Fdm;
        model.execution_plan.backend_plan = fullmag_ir::BackendPlanIR::FdmMultilayer(multilayer);
        model
    }

    #[test]
    fn prepared_multilayer_initial_state_preserves_native_layer_offsets() {
        let request: CurrentLiveSnapshotRequest = serde_json::from_value(json!({
            "session_id": "prepared-multilayer-session",
        }))
        .unwrap();
        let mut snapshot = crate::session::default_current_live_state(&request);
        snapshot.metadata = Some(json!({
            "artifact_layout": {
                "backend": "fdm_multilayer",
                "stale_marker": "previous-run",
                "layers": [{"layer_id": "layer:top", "value_offset": 999, "value_count": 999}]
            }
        }).into());
        let model = prepared_multilayer_read_model();
        let (metadata, mesh) = prepared_domain_publication(&snapshot, &model).unwrap();
        assert!(mesh.is_none());
        assert_eq!(metadata["artifact_layout"]["backend"], "fdm_multilayer");
        assert!(metadata["artifact_layout"].get("stale_marker").is_none());
        assert_eq!(metadata["artifact_layout"]["layers"][0]["value_offset"], 0);
        assert_eq!(metadata["artifact_layout"]["layers"][0]["value_count"], 2);
        assert_eq!(metadata["artifact_layout"]["layers"][1]["value_offset"], 2);
        assert_eq!(metadata["artifact_layout"]["layers"][1]["value_count"], 2);

        let mut publication: CurrentLiveSnapshotRequest = serde_json::from_value(json!({
            "session_id": "prepared-multilayer-session",
        }))
        .unwrap();
        publication.metadata = Some(metadata.into());
        crate::session::apply_current_live_snapshot(&mut snapshot, publication).unwrap();
        publish_prepared_initial_state(&mut snapshot, &model, false).unwrap();

        let field = snapshot.latest_fields.get("m").expect("initial m field");
        assert_eq!(
            field["values"],
            json!([
                [1.0, 0.0, 0.0],
                [2.0, 0.0, 0.0],
                [3.0, 0.0, 0.0],
                [4.0, 0.0, 0.0]
            ])
        );
        assert_eq!(field["layout"]["backend"], "fdm_multilayer");
        assert!(field["layout"].get("grid_cells").is_none());
        assert_eq!(field["layout"]["layers"][0]["native_grid"], json!([2, 1, 1]));
        assert_eq!(field["layout"]["layers"][1]["native_grid"], json!([1, 1, 2]));
        assert_eq!(field["layout"]["layers"][1]["value_offset"], 2);
        assert_eq!(field["source_time_seconds"], 0.0);
        assert!(snapshot.scalar_rows.is_empty());
        let bundle = snapshot.field_publication_bundles.get("m").expect("multilayer m0 bundle");
        assert!(bundle.observation_frame.authored_initial_state.is_some());
        assert!(bundle.field.carrier_id.starts_with("fdm-multilayer:sha256:"));
        assert_eq!(bundle.field.scope_kind, "full");
    }

    #[test]
    fn prepared_fem_domain_is_visible_to_existing_binary_and_material_resources_before_solve() {
        let request: CurrentLiveSnapshotRequest = serde_json::from_value(json!({
            "session_id": "prepared-domain-session",
            "metadata": {"docker_startup": {"request_id": "startup-domain"}},
        }))
        .unwrap();
        let mut snapshot = crate::session::default_current_live_state(&request);
        snapshot.metadata = request.metadata.clone().map(Into::into);
        let model = prepared_fem_read_model(true);
        assert_eq!(
            match &model.execution_plan.backend_plan {
                fullmag_ir::BackendPlanIR::Fem(plan) => plan.mesh.cells.len(),
                _ => 0,
            },
            1,
            "the pinned typed FEM plan must carry solver topology before publication"
        );
        let (metadata, mesh) = prepared_domain_publication(&snapshot, &model).unwrap();
        assert_eq!(metadata["docker_startup"]["request_id"], "startup-domain");
        let mesh = mesh.expect("prepared FEM topology must be published before Compute");
        assert_eq!(mesh.nodes.len(), 4);
        assert_eq!(mesh.cells.len(), 1);
        let generation = mesh.generation_id.clone().unwrap();
        let mut publication: CurrentLiveSnapshotRequest = serde_json::from_value(json!({
            "session_id": "prepared-domain-session",
        }))
        .unwrap();
        publication.metadata = Some(metadata.into());
        publication.fem_mesh = Some(mesh);
        crate::session::apply_current_live_snapshot(&mut snapshot, publication).unwrap();
        publish_prepared_initial_state(&mut snapshot, &model, false).unwrap();
        assert_eq!(
            snapshot.latest_fields.get("m").unwrap()["values"],
            json!(vec![[1.0, 0.0, 0.0]; 4])
        );
        assert_eq!(
            snapshot.latest_fields.get("m").unwrap()["provenance"]["source_kind"],
            "prepared_initial_state"
        );
        assert_eq!(
            crate::router_v2::handlers::sessions::status::domain_generation_id(&snapshot),
            generation,
        );
        assert!(
            crate::router_v2::handlers::sessions::status::domain_generation_revision(&snapshot) > 0
        );
        assert!(!crate::field_store::serialize_fem_mesh_topology_binary_v2(
            snapshot.fem_mesh.as_ref().unwrap()
        )
        .unwrap()
        .is_empty());
        assert_eq!(
            snapshot.latest_fields.get("mat_ms").unwrap()["values"]
                .as_array()
                .unwrap()
                .len(),
            4
        );
        assert!(
            snapshot.scalar_rows.is_empty(),
            "preparation must not fabricate solver observations"
        );
        assert!(snapshot.live_state.is_none());
        let bundle = snapshot.field_publication_bundles.get("m").expect("FEM m0 bundle");
        assert!(bundle.observation_frame.authored_initial_state.is_some());
        assert_eq!(bundle.domain_generation_id, generation);
    }

    #[test]
    fn preparation_poll_rejects_stop_without_changing_session_identity() {
        let request: CurrentLiveSnapshotRequest = serde_json::from_value(json!({
            "session_id": "stop-during-preparation",
        }))
        .unwrap();
        let mut snapshot = crate::session::default_current_live_state(&request);
        assert!(ensure_preparation_run_is_active(&snapshot).is_ok());
        snapshot.session.status = "stopping".into();
        snapshot.run = Some(crate::types::RunManifest {
            run_id: "stop-during-preparation-run".into(),
            session_id: snapshot.session.session_id.clone(),
            status: "stopping".into(),
            total_steps: 1,
            final_time: None,
            final_e_ex: None,
            final_e_demag: None,
            final_e_ext: None,
            final_e_ani: None,
            final_e_dmi: None,
            final_e_rotated_dmi: None,
            final_e_total: None,
            artifact_dir: ".".into(),
        });
        let error = ensure_preparation_run_is_active(&snapshot)
            .expect_err("Stop must fence a later preparation poll for the same session");
        assert_eq!(
            error.code.as_deref(),
            Some("accepted_preparation_run_stopped")
        );
        assert_eq!(snapshot.session.status, "stopping");
        assert_eq!(
            snapshot.run.as_ref().map(|run| run.status.as_str()),
            Some("stopping")
        );
    }

    #[test]
    fn multilayer_metadata_clears_the_previous_fem_solver_domain() {
        let request: CurrentLiveSnapshotRequest = serde_json::from_value(json!({
            "session_id": "switch-to-multilayer",
        })).unwrap();
        let mut snapshot = crate::session::default_current_live_state(&request);
        let (_, mesh) = prepared_domain_publication(&snapshot, &prepared_fem_read_model(true)).unwrap();
        snapshot.fem_mesh = mesh.map(Into::into);
        assert!(snapshot.fem_mesh.is_some());
        crate::session::apply_current_live_metadata(&mut snapshot, json!({
            "execution_plan": {"backend_plan": {"kind": "fdm_multilayer"}},
        }));
        assert!(snapshot.fem_mesh.is_none(), "a new FDM multilayer plan must not retain stale FEM topology");
    }

    #[test]
    fn prepared_fem_domain_rejects_an_unmaterialized_plan() {
        let request: CurrentLiveSnapshotRequest = serde_json::from_value(json!({
            "session_id": "empty-domain-session",
        }))
        .unwrap();
        let snapshot = crate::session::default_current_live_state(&request);
        let error = prepared_domain_publication(&snapshot, &prepared_fem_read_model(false))
            .expect_err("a FEM preparation cannot report ready without solver topology");
        assert_eq!(
            error.code.as_deref(),
            Some("accepted_preparation_mesh_missing")
        );
    }

    #[test]
    fn forced_device_guard_preserves_profile_and_rejects_fallback() {
        let requested = RequestedExecution {
            backend: "fem".into(),
            device: "gpu".into(),
            precision: "double".into(),
            mode: "strict".into(),
            minimum_resources: None,
        };
        let before = requested.clone();
        let fallback = validate_requested_device_value(requested.device.as_str(), None)
            .expect_err("forced GPU cannot accept an unresolved runtime device");
        assert!(fallback.message.contains("fallback=none"));
        assert_eq!(
            requested, before,
            "the guard must not rewrite request intent"
        );

        assert!(validate_requested_device_value(requested.device.as_str(), Some("gpu")).is_ok());
        assert!(
            validate_requested_device_value("gpu", Some(normalize_runtime_device("cuda:0")))
                .is_ok()
        );
        assert!(validate_requested_device_value("cpu", Some("gpu")).is_err());
    }

    #[test]
    fn accepted_step_output_read_defers_transient_store_errors_only() {
        let transient = accepted_step_output_store_read_error(
            "reading admitted input",
            "step-b",
            anyhow::anyhow!(std::io::Error::from_raw_os_error(12)).context("CAS read"),
        );
        assert_eq!(transient.status, axum::http::StatusCode::SERVICE_UNAVAILABLE);
        assert_eq!(transient.code.as_deref(), Some("accepted_preparation_pending"));

        let busy_read = accepted_step_output_store_read_error(
            "reading admitted input",
            "step-b",
            anyhow::Error::new(std::fs::TryLockError::WouldBlock),
        );
        assert_eq!(busy_read.status, axum::http::StatusCode::SERVICE_UNAVAILABLE);
        assert_eq!(busy_read.code.as_deref(), Some("accepted_preparation_pending"));

        let corrupt = accepted_step_output_store_read_error(
            "reading admitted input",
            "step-b",
            anyhow::anyhow!(std::io::Error::from(std::io::ErrorKind::InvalidData))
                .context("CAS read"),
        );
        assert_eq!(corrupt.status, axum::http::StatusCode::CONFLICT);
        assert_eq!(
            corrupt.code.as_deref(),
            Some("accepted_preparation_input_invalid")
        );
    }

    #[tokio::test]
    async fn live_view_continuity_rejected_final_fence_preserves_the_current_snapshot_and_receipt() {
        let state = crate::router_v2::tests::test_app_state_with_live_session().await;
        let _transition = state.current_live_session_transition.lock().await;
        let original = state.current_live_state.read().await.as_ref().unwrap().clone();
        let mut candidate = original.clone();
        candidate.state_version = candidate.state_version.saturating_add(1);
        let run_id = original
            .run
            .as_ref()
            .map(|run| run.run_id.as_str())
            .unwrap_or(original.session.run_id.as_str());
        let receipt_a = fullmag_session::FmsPreparationReceipt::new(
            "prep-a",
            run_id,
            digest('a'),
            json!({"stage": "a"}),
        );
        let receipt_b = fullmag_session::FmsPreparationReceipt::new(
            "prep-b",
            run_id,
            digest('b'),
            json!({"stage": "b"}),
        );
        *state.current_live_preparation_receipt.write().await = Some(receipt_a.clone());

        let rejected = publish_prepared_candidate_after_final_fence(
            &state,
            candidate.clone(),
            receipt_b.clone(),
            Err(task_attempt_changed()),
        )
        .await;
        let error = match rejected {
            Err(error) => error,
            Ok(previous) => {
                drop(previous);
                panic!("a rejected final fence must not publish the candidate");
            }
        };
        assert_eq!(error.code.as_deref(), Some("accepted_preparation_current_state_changed"));
        assert_eq!(
            state.current_live_state.read().await.as_ref().unwrap().state_version,
            original.state_version,
        );
        assert_eq!(
            state.current_live_preparation_receipt.read().await.as_ref().unwrap().preparation_id,
            "prep-a",
        );

        // Cancel after taking the snapshot lock but before the receipt lock.
        // No reader may see a snapshot from the candidate after cancellation.
        let receipt_guard = state.current_live_preparation_receipt.read().await;
        {
            use std::future::Future;
            let mut publish = Box::pin(publish_prepared_candidate_after_final_fence(
                &state, candidate.clone(), receipt_b.clone(), Ok(None),
            ));
            std::future::poll_fn(|cx| {
                assert!(publish.as_mut().poll(cx).is_pending());
                std::task::Poll::Ready(())
            }).await;
            assert!(state.current_live_state.try_read().is_err());
        }
        assert_eq!(state.current_live_state.read().await.as_ref().unwrap().state_version, original.state_version);
        assert_eq!(receipt_guard.as_ref().unwrap().preparation_id, "prep-a");
        drop(receipt_guard);
        let previous = publish_prepared_candidate_after_final_fence(
            &state,
            candidate.clone(),
            receipt_b,
            Ok(None),
        )
        .await
        .unwrap();
        drop(previous);
        assert_eq!(
            state.current_live_state.read().await.as_ref().unwrap().state_version,
            candidate.state_version,
        );
        assert_eq!(
            state.current_live_preparation_receipt.read().await.as_ref().unwrap().preparation_id,
            "prep-b",
        );
    }

    #[test]
    fn live_view_continuity_verified_output_mode_admits_succeeded_attempt_without_prepared_m0() {
        let directory = tempfile::tempdir().unwrap();
        let store = fullmag_session::SessionStore::open(directory.path().join("store")).unwrap();
        let run_id = "run-verified-output-without-m0";
        let step_id = "step-a";
        let task_id = fullmag_session::task_id_for_study_step(run_id, step_id).unwrap();
        let attempt_id = "attempt-verified-output";
        let ownership_epoch = 7;
        let object_ref = store.cas().put(b"already-verified final state bytes").unwrap();
        let manifest = fullmag_session::FmsStudyOutputManifest {
            schema_version: fullmag_session::FMS_STUDY_OUTPUT_MANIFEST_SCHEMA_V1.into(),
            run_id: run_id.into(),
            task_id: task_id.clone(),
            step_id: step_id.into(),
            attempt_id: attempt_id.into(),
            ownership_epoch,
            accepted_state_ref: None,
            observation_source: None,
            outputs: vec![fullmag_session::FmsStudyOutputManifestEntry {
                port_id: "final_state".into(),
                case_id: "default".into(),
                data_kind: "state".into(),
                codec_id: fullmag_application::STUDY_MAGNETIZATION_CODEC_ID.into(),
                codec_version: fullmag_application::STUDY_MAGNETIZATION_CODEC_VERSION.into(),
                artifact_id: "artifact-state".into(),
                object_ref: object_ref.clone(),
                content_sha256: object_ref.clone(),
            }],
        };
        manifest.validate().unwrap();
        let manifest_bytes = serde_json::to_vec(&manifest).unwrap();
        let manifest_ref = store.cas().put(&manifest_bytes).unwrap();
        let manifest_artifact_id = "artifact-output-manifest";
        let succeeded = fullmag_session::FmsTaskCatalogEntry {
            task_id: task_id.clone(),
            input_fingerprint: "a".repeat(64),
            lifecycle: fullmag_session::FmsTaskLifecycle::Succeeded,
            readiness: fullmag_session::FmsTaskReadiness::Ready,
            observation: None,
            attempt_id: Some(attempt_id.into()),
            ownership_epoch: Some(ownership_epoch),
            resolved_input_fingerprint: None,
            artifact_ids: vec![manifest_artifact_id.into(), "artifact-state".into()],
            resource_id: None,
            coordinator_watermark: None,
            coordinator_genesis: None,
        };
        let run_catalog = fullmag_session::FmsRunCatalog {
            schema_version: fullmag_session::FMS_RUN_CATALOG_SCHEMA.into(),
            run_id: run_id.into(),
            revision: 1,
            updated_at: chrono::Utc::now(),
            tasks: vec![succeeded.clone()],
        };
        run_catalog.validate().unwrap();
        let artifact_catalog = fullmag_session::FmsArtifactCatalog {
            schema_version: fullmag_session::FMS_ARTIFACT_CATALOG_SCHEMA.into(),
            run_id: run_id.into(),
            revision: 1,
            updated_at: chrono::Utc::now(),
            entries: vec![
                fullmag_session::FmsArtifactCatalogEntry {
                    artifact_id: manifest_artifact_id.into(),
                    task_id: task_id.clone(),
                    attempt_id: attempt_id.into(),
                    ownership_epoch,
                    logical_path: "outputs/manifest.json".into(),
                    artifact_type: "study_output_manifest".into(),
                    content_sha256: manifest_ref.clone(),
                    object_ref: Some(manifest_ref.clone()),
                    status: fullmag_session::FmsArtifactStatus::Published,
                    required: true,
                    study_output: None,
                },
                fullmag_session::FmsArtifactCatalogEntry {
                    artifact_id: "artifact-state".into(),
                    task_id: task_id.clone(),
                    attempt_id: attempt_id.into(),
                    ownership_epoch,
                    logical_path: "outputs/state.bin".into(),
                    artifact_type: "study_state".into(),
                    content_sha256: object_ref.clone(),
                    object_ref: Some(object_ref.clone()),
                    status: fullmag_session::FmsArtifactStatus::Published,
                    required: true,
                    study_output: Some(fullmag_session::FmsStudyArtifactOutput {
                        step_id: step_id.into(),
                        port_id: "final_state".into(),
                        case_id: "default".into(),
                    }),
                },
            ],
        };
        artifact_catalog.validate().unwrap();
        let run_directory = store.root().join("runs").join(run_id);
        std::fs::create_dir_all(&run_directory).unwrap();
        std::fs::write(
            run_directory.join("run_catalog.json"),
            serde_json::to_vec(&run_catalog).unwrap(),
        )
        .unwrap();
        std::fs::write(
            run_directory.join("artifact_catalog.json"),
            serde_json::to_vec(&artifact_catalog).unwrap(),
        )
        .unwrap();

        let identity = AcceptedStageOutputIdentity {
            run_id: run_id.into(),
            task_id: task_id.clone(),
            step_id: step_id.into(),
            case_id: "default".into(),
            attempt_id: attempt_id.into(),
            ownership_epoch,
            object_ref: object_ref.clone(),
            data_kind: "state".into(),
            plan_fingerprint: None,
        };
        let mode = AcceptedPreparationPublicationMode::VerifiedOutput(identity.clone());
        assert!(!mode.resolves_step_initial_state());
        validate_verified_output_task_identity(&identity, &succeeded).unwrap();
        assert!(store.read_task_admission(run_id, &task_id, attempt_id).unwrap().is_none());
        let read_fence = verify_accepted_stage_output_identity(
            &store,
            None,
            &identity,
            "canonical-plan-fingerprint",
        )
        .unwrap();
        drop(read_fence);

        let mut terminal_snapshot_request: CurrentLiveSnapshotRequest = serde_json::from_value(json!({
            "session_id": "verified-output-without-m0",
        }))
        .unwrap();
        terminal_snapshot_request.session_status = Some("completed".into());
        let mut terminal_snapshot = crate::session::default_current_live_state(&terminal_snapshot_request);
        terminal_snapshot.session.run_id = run_id.into();
        terminal_snapshot.scene_document = Some(fullmag_authoring::SceneDocument::default());
        terminal_snapshot.run = Some(crate::types::RunManifest {
            run_id: run_id.into(),
            session_id: terminal_snapshot.session.session_id.clone(),
            status: "completed".into(),
            total_steps: 1,
            final_time: None,
            final_e_ex: None,
            final_e_demag: None,
            final_e_ext: None,
            final_e_ani: None,
            final_e_dmi: None,
            final_e_rotated_dmi: None,
            final_e_total: None,
            artifact_dir: ".".into(),
        });
        let terminal_context = crate::types::CurrentLiveRequestContext {
            session_id: terminal_snapshot.session.session_id.clone(),
            run_id: Some(run_id.into()),
            session_epoch: 1,
            request_scope_epoch: "test-output-only".into(),
        };
        let active_mode_error = AcceptedPreparationPublicationFence::capture_with_mode(
            &terminal_snapshot,
            &terminal_context,
            1,
            AcceptedPreparationPublicationMode::Active,
        )
        .expect_err("ordinary preparation must remain blocked after terminal completion");
        assert_eq!(
            active_mode_error.code.as_deref(),
            Some("accepted_preparation_run_stopped")
        );
        AcceptedPreparationPublicationFence::capture_with_mode(
            &terminal_snapshot,
            &terminal_context,
            1,
            mode.clone(),
        )
        .expect("a verified output may restore a succeeded producer after terminal completion");

        let request: CurrentLiveSnapshotRequest = serde_json::from_value(json!({
            "session_id": "verified-output-without-m0",
        }))
        .unwrap();
        let mut snapshot = crate::session::default_current_live_state(&request);
        snapshot.latest_fields.insert("m".into(), json!({"values": [[1.0, 0.0, 0.0]]}));
        let before_version = snapshot.state_version;
        let before_fields = serde_json::to_value(&snapshot.latest_fields).unwrap();

        let mut stale = identity.clone();
        stale.attempt_id = "older-attempt".into();
        let error = match verify_accepted_stage_output_identity(
            &store,
            None,
            &stale,
            "canonical-plan-fingerprint",
        ) {
            Err(error) => error,
            Ok(read_fence) => {
                drop(read_fence);
                panic!("an output from another attempt must be rejected before publication");
            }
        };
        assert_eq!(
            error.code.as_deref(),
            Some("accepted_preparation_current_state_changed")
        );
        assert_eq!(snapshot.state_version, before_version);
        assert_eq!(serde_json::to_value(&snapshot.latest_fields).unwrap(), before_fields);
    }

    #[test]
    fn live_view_continuity_restores_same_run_scalar_history_after_domain_replacement() {
        let run = accepted_test_specification("run-live-view-continuity-scalar-history");
        let problem = fullmag_ir::ProblemIR::bootstrap_example();
        let execution_plan = fullmag_plan::plan(&problem).unwrap();
        let receipt = fullmag_application::materialize_fdm_preparation_from_problem(
            "prep-scalar-history",
            1,
            &problem,
            &json!({}),
        )
        .unwrap();
        let request: CurrentLiveSnapshotRequest = serde_json::from_value(json!({
            "session_id": "live-view-continuity-scalar-history",
        }))
        .unwrap();
        let mut snapshot = crate::session::default_current_live_state(&request);
        snapshot.session.run_id = run.run_id.as_str().to_owned();
        let identity = crate::types::AcceptedLiveScalarIdentity {
            run_id: run.run_id.as_str().to_owned(),
            task_id: "task-scalar-history".into(),
            step_id: "step-a".into(),
            case_id: "default".into(),
            attempt_id: "attempt-scalar-history".into(),
            ownership_epoch: 1,
        };
        let old_frame = crate::session::accepted_observation_frame_ref(
            &snapshot,
            31,
            Some(3.1e-9),
        );
        let mut row = crate::types::ScalarRow::from_accepted_stats(&fullmag_runner::StepStats {
            step: 31, time: 3.1e-9, dt: 1e-12, mx: 0.1, my: 0.2, mz: 0.3,
            ..Default::default()
        });
        row.observation_frame = Some(old_frame);
        let expected_frame = row.observation_frame.clone();
        snapshot.scalar_rows = vec![row];
        snapshot.latest_scalar_source = Some(crate::types::CurrentScalarSourceState {
            public_source: None,
            accepted_live_identity: Some(identity.clone()),
            active_live_identity: Some(identity.clone()),
            series: Some(crate::types::CurrentScalarSeries {
                identity,
                row_revisions: vec![snapshot.scalar_revision],
            }),
        });
        let retained = retire_previous_observation_for_step_output(&mut snapshot);
        let read_model = LiveScenePreparationReadModel {
            schema_version: LIVE_SCENE_PREPARATION_READ_MODEL_SCHEMA,
            preparation_id: receipt.preparation_id.clone(),
            scene_revision: 2,
            plan_fingerprint: receipt.plan_fingerprint.clone(),
            requested_execution: run.requested_execution.clone(),
            execution_plan,
            global_sampling_mesh: None,
        };
        let (metadata, fem_mesh) = prepared_domain_publication(&snapshot, &read_model).unwrap();
        let mut publication: CurrentLiveSnapshotRequest = serde_json::from_value(json!({
            "session_id": "live-view-continuity-scalar-history",
        }))
        .unwrap();
        publication.metadata = Some(metadata.into());
        publication.fem_mesh = fem_mesh;
        crate::session::apply_current_live_snapshot(&mut snapshot, publication).unwrap();
        assert!(snapshot.scalar_rows.is_empty(), "domain replacement must first retire current rows");
        restore_retained_accepted_scalar_history(&mut snapshot, retained);

        assert_eq!(snapshot.scalar_rows.len(), 1);
        assert_eq!(snapshot.scalar_rows[0].observation_frame, expected_frame);
        let source = snapshot.latest_scalar_source.as_ref().unwrap();
        assert!(source.public_source.is_none());
        assert!(source.accepted_live_identity.is_none());
        assert!(source.active_live_identity.is_none());
        assert_eq!(source.series.as_ref().unwrap().identity.run_id, run.run_id.as_str());
    }

    #[test]
    fn live_view_continuity_pinned_artifact_overlay_uses_verified_predecessor_for_serial_fdm_stt() {
        use fullmag_application::{
            PreparationBinding, ResolvedInput, ResolvedStudyArtifact, ResolvedTaskInput,
            ResourceBudget, ResourceKind, ResourceLease, TaskRecord, RESOLVED_TASK_INPUT_SCHEMA,
            STUDY_MAGNETIZATION_CODEC_ID, STUDY_MAGNETIZATION_CODEC_VERSION,
        };
        use fullmag_authoring::{
            StudyInitialStateOverlay, StudyInputPort, StudyInputSource, StudyPortDataKind,
        };
        use fullmag_ir::{
            GeometryEntryIR, InitialMagnetizationIR, ObjectRegionIR, RegionRealizationPolicyIR,
            RegionShapeIR, RegionTextureOverrideIR, SpinTorqueModuleIR,
        };

        let directory = tempfile::tempdir().unwrap();
        let store = fullmag_session::SessionStore::open(directory.path().join("store")).unwrap();
        let run = accepted_test_specification("run-live-view-continuity-pinned-overlay");
        let mut problem = fullmag_ir::ProblemIR::bootstrap_example();
        problem.geometry.entries[0] = GeometryEntryIR::Box {
            name: "strip".into(),
            size: [4e-9, 2e-9, 2e-9],
        };
        problem.magnets[0].object_id = Some("strip".into());
        problem.magnets[0].initial_magnetization = Some(InitialMagnetizationIR::Uniform {
            value: [1.0, 0.0, 0.0],
        });
        problem.object_regions.push(ObjectRegionIR {
            region_id: "left-half".into(),
            owner_object: "strip".into(),
            name: "left half".into(),
            shape: RegionShapeIR::Box {
                size: [2e-9, 2e-9, 2e-9],
                center: [-1e-9, 0.0, 0.0],
            },
            frame: Default::default(),
            enabled: true,
            priority: 0,
            mesh_policy: None,
            material_overrides: Vec::new(),
            texture_override: Some(RegionTextureOverrideIR {
                initial_magnetization: InitialMagnetizationIR::Uniform {
                    value: [1.0, 0.0, 0.0],
                },
            }),
            realization_policy: RegionRealizationPolicyIR::default(),
            material_transition: None,
        });
        problem.spin_torque_modules = vec![SpinTorqueModuleIR::Slonczewski {
            schema_version: None,
            id: None,
            target: None,
            formula_version: "slonczewski.legacy_fullmag.v0".into(),
            current_density: Some([0.0, 0.0, 5e10]),
            current_source: None,
            degree: 0.4,
            spin_polarization: [0.0, 0.0, 1.0],
            stack_normal: None,
            lambda_asymmetry: 1.0,
            epsilon_prime: 0.0,
            free_layer_thickness_m: None,
            fixed_layer_position: None,
            realization: None,
            time_expression: None,
        }];
        let execution_plan = fullmag_plan::plan(&problem).unwrap();
        let fullmag_ir::BackendPlanIR::Fdm(fdm) = &execution_plan.backend_plan else {
            panic!("the pinned-overlay fixture must resolve to FDM");
        };
        assert!(fdm.stt_spin_polarization.is_some());
        let authored_base = fdm.initial_magnetization.clone();
        assert!(authored_base.iter().all(|value| *value == [1.0, 0.0, 0.0]));
        let layout = fullmag_runner::study_magnetization_layout_for_plan(&execution_plan).unwrap();
        let predecessor_values = (0..authored_base.len())
            .map(|index| match index % 3 {
                0 => [0.0, 1.0, 0.0],
                1 => [0.0, 0.0, 1.0],
                _ => [0.0, -1.0, 0.0],
            })
            .collect::<Vec<_>>();
        let state_bytes = serde_json::to_vec(&json!({
            "observable": "m",
            "unit": "1",
            "step": 23,
            "time": 2.3e-9,
            "solver_dt": 1e-12,
            "layout": layout,
            "provenance": {"execution_engine": "fdm_cpu"},
            "state_identity": {
                "schema_version": fullmag_application::MAGNETIZATION_STATE_IDENTITY_SCHEMA,
                "backend": "fdm",
                "layout_sha256": fullmag_application::study_state_layout_sha256(&layout).unwrap(),
                "sample_count": predecessor_values.len(),
            },
            "values": predecessor_values,
        }))
        .unwrap();
        let object_ref = store.cas().put(&state_bytes).unwrap();
        let artifact_id = "pinned-predecessor".to_owned();
        let input = ResolvedInput {
            source: artifact_id.clone(),
            content_sha256: object_ref.clone(),
            study_artifact: Some(ResolvedStudyArtifact {
                artifact_id: artifact_id.clone(),
                object_ref: object_ref.clone(),
                data_kind: "state".into(),
                codec_id: STUDY_MAGNETIZATION_CODEC_ID.into(),
                codec_version: STUDY_MAGNETIZATION_CODEC_VERSION.into(),
            }),
        };
        let receipt = fullmag_application::materialize_fdm_preparation_from_problem(
            "prep-pinned-overlay",
            1,
            &problem,
            &json!({}),
        )
        .unwrap();
        let mut task = TaskRecord::new(run.run_id.clone(), "b".repeat(64)).unwrap();
        task.queue().unwrap();
        let claim = task
            .claim(
                ResourceLease::new(
                    "cpu-live-view-continuity-pinned-overlay",
                    ResourceKind::Cpu,
                    ResourceBudget {
                        cpu_millis: 100,
                        memory_bytes: 1 << 20,
                        gpu_memory_bytes: 0,
                        storage_bytes: 1 << 20,
                    },
                )
                .unwrap(),
            )
            .unwrap();
        let port = StudyInputPort {
            port_id: "initial_state".into(),
            data_kind: StudyPortDataKind::State,
            required: true,
            source: StudyInputSource::PinnedArtifact {
                artifact_id,
                content_sha256: object_ref.clone(),
            },
        };
        let overlay = StudyInitialStateOverlay::Scoped {
            scopes: vec![fullmag_ir::RegionRefIR {
                object_id: "strip".into(),
                region_id: Some("left-half".into()),
            }],
        };
        let worker_step = fullmag_runtime_control::AcceptedWorkerStep {
            claim: claim.clone(),
            step_id: "step-b".into(),
            study_inputs: vec![port.clone()],
            initial_state_overlay: Some(overlay.clone()),
            problem: problem.clone(),
            execution_plan: execution_plan.clone(),
            until_seconds: Some(1e-9),
            resolved_input: ResolvedTaskInput {
                schema_version: RESOLVED_TASK_INPUT_SCHEMA.into(),
                run_id: claim.run_id.clone(),
                task_id: claim.task_id.clone(),
                attempt_id: claim.attempt_id.clone(),
                ownership_epoch: claim.ownership_epoch,
                specification_fingerprint: run.fingerprint().unwrap(),
                plan_fingerprint: fullmag_session::canonical_json_sha256(
                    &serde_json::to_value(&execution_plan).unwrap(),
                ),
                requested_execution: run.requested_execution.clone(),
                preparation: PreparationBinding::from_receipt(&receipt).unwrap(),
                inputs: [(port.port_id.clone(), input)].into_iter().collect(),
                frozen_stage_context: None,
            },
        };
        let overlay_mask = fullmag_plan::study_magnetization_overlay_mask(
            &problem,
            &execution_plan,
            overlay.scopes(),
        )
        .unwrap();
        assert!(overlay_mask.iter().any(|masked| *masked));
        assert!(overlay_mask.iter().any(|masked| !*masked));
        let expected_plan = fullmag_runner::materialize_study_magnetization_input_with_overlay(
            &execution_plan,
            &layout,
            &predecessor_values,
            Some((&problem, overlay.scopes())),
        )
        .unwrap();
        let fullmag_ir::BackendPlanIR::Fdm(expected_fdm) = &expected_plan.backend_plan else {
            panic!("the overlay expectation must remain FDM");
        };

        let effective = materialize_accepted_step_output_initial_state(
            &store,
            &worker_step,
            &port,
            &execution_plan,
            &receipt.preparation_id,
            &receipt.plan_fingerprint,
        )
        .expect("PinnedArtifact plus scoped overlay is a valid accepted worker input");
        assert_eq!(effective.carrier.field["values"], json!(expected_fdm.initial_magnetization));
        assert_ne!(effective.carrier.field["values"], json!(predecessor_values));
        assert_eq!(effective.provenance["source_kind"], "accepted_step_output_initial_state");
        assert_eq!(effective.provenance["materialization_kind"], "pinned_artifact_overlay");
        assert_eq!(effective.provenance["accepted_input"]["source_kind"], "pinned_artifact");
        assert_eq!(effective.provenance["accepted_input"]["source_identity"]["artifact_id"], "pinned-predecessor");
        assert_eq!(effective.provenance["producer_clock"]["step"], 23);
        assert_eq!(effective.provenance["producer_clock"]["time_seconds"], 2.3e-9);
    }

    #[test]
    fn live_view_continuity_uses_verified_step_output_m0_for_serial_fdm_stt() {
        use fullmag_application::{
            PreparationBinding, ResolvedInput, ResolvedStudyArtifact, ResolvedTaskInput,
            ResourceBudget, ResourceKind, ResourceLease, TaskRecord, RESOLVED_TASK_INPUT_SCHEMA,
            STUDY_MAGNETIZATION_CODEC_ID, STUDY_MAGNETIZATION_CODEC_VERSION,
        };
        use fullmag_authoring::{StudyInputPort, StudyInputSource, StudyPortDataKind};
        use fullmag_ir::{GeometryEntryIR, InitialMagnetizationIR, SpinTorqueModuleIR};

        let directory = tempfile::tempdir().unwrap();
        let store = fullmag_session::SessionStore::open(directory.path().join("store")).unwrap();
        let run = accepted_test_specification("run-live-view-continuity");
        let mut problem = fullmag_ir::ProblemIR::bootstrap_example();
        problem.geometry.entries[0] = GeometryEntryIR::Box {
            name: "strip".into(),
            size: [4e-9, 2e-9, 2e-9],
        };
        problem.magnets[0].initial_magnetization = Some(InitialMagnetizationIR::Uniform {
            value: [1.0, 0.0, 0.0],
        });
        problem.spin_torque_modules = vec![SpinTorqueModuleIR::Slonczewski {
            schema_version: None,
            id: None,
            target: None,
            formula_version: "slonczewski.legacy_fullmag.v0".into(),
            current_density: Some([0.0, 0.0, 5e10]),
            current_source: None,
            degree: 0.4,
            spin_polarization: [0.0, 0.0, 1.0],
            stack_normal: None,
            lambda_asymmetry: 1.0,
            epsilon_prime: 0.0,
            free_layer_thickness_m: None,
            fixed_layer_position: None,
            realization: None,
            time_expression: None,
        }];
        let execution_plan = fullmag_plan::plan(&problem).unwrap();
        let fullmag_ir::BackendPlanIR::Fdm(fdm) = &execution_plan.backend_plan else {
            panic!("the serial STT fixture must resolve to FDM");
        };
        assert!(fdm.stt_spin_polarization.is_some(), "fixture must retain STT");
        assert_eq!(run.requested_execution.device, "cpu");
        assert!(fdm.initial_magnetization.len() > 1, "fixture needs a spatial predecessor");
        let authored_base = fdm.initial_magnetization.clone();
        assert!(authored_base.iter().all(|value| *value == [1.0, 0.0, 0.0]));

        let receipt = fullmag_application::materialize_fdm_preparation_from_problem(
            "prep-step-b",
            1,
            &problem,
            &json!({}),
        )
        .unwrap();
        let layout = fullmag_runner::study_magnetization_layout_for_plan(&execution_plan).unwrap();
        let predecessor_values = (0..authored_base.len())
            .map(|index| {
                if index % 2 == 0 {
                    [0.0, 1.0, 0.0]
                } else {
                    [0.0, 0.0, 1.0]
                }
            })
            .collect::<Vec<_>>();
        assert_ne!(predecessor_values, authored_base);
        let state_bytes = serde_json::to_vec(&json!({
            "observable": "m",
            "unit": "1",
            "step": 17,
            "time": 1.7e-9,
            "solver_dt": 1e-12,
            "layout": layout,
            "provenance": {"execution_engine": "fdm_cpu"},
            "state_identity": {
                "schema_version": fullmag_application::MAGNETIZATION_STATE_IDENTITY_SCHEMA,
                "backend": "fdm",
                "layout_sha256": fullmag_application::study_state_layout_sha256(&layout).unwrap(),
                "sample_count": predecessor_values.len(),
            },
            "values": predecessor_values,
        }))
        .unwrap();
        let object_ref = store.cas().put(&state_bytes).unwrap();
        let artifact_id = "step-a-final".to_owned();
        let input = ResolvedInput {
            source: artifact_id.clone(),
            content_sha256: object_ref.clone(),
            study_artifact: Some(ResolvedStudyArtifact {
                artifact_id,
                object_ref,
                data_kind: "state".into(),
                codec_id: STUDY_MAGNETIZATION_CODEC_ID.into(),
                codec_version: STUDY_MAGNETIZATION_CODEC_VERSION.into(),
            }),
        };
        let mut task = TaskRecord::new(run.run_id.clone(), "a".repeat(64)).unwrap();
        task.queue().unwrap();
        let claim = task
            .claim(
                ResourceLease::new(
                    "cpu-live-view-continuity",
                    ResourceKind::Cpu,
                    ResourceBudget {
                        cpu_millis: 100,
                        memory_bytes: 1 << 20,
                        gpu_memory_bytes: 0,
                        storage_bytes: 1 << 20,
                    },
                )
                .unwrap(),
            )
            .unwrap();
        let port = StudyInputPort {
            port_id: "initial_state".into(),
            data_kind: StudyPortDataKind::State,
            required: true,
            source: StudyInputSource::StepOutput {
                step_id: "step-a".into(),
                port: "final_state".into(),
                case_id: "default".into(),
            },
        };
        let worker_step = fullmag_runtime_control::AcceptedWorkerStep {
            claim: claim.clone(),
            step_id: "step-b".into(),
            study_inputs: vec![port.clone()],
            initial_state_overlay: None,
            problem: problem.clone(),
            execution_plan: execution_plan.clone(),
            until_seconds: Some(1e-9),
            resolved_input: ResolvedTaskInput {
                schema_version: RESOLVED_TASK_INPUT_SCHEMA.into(),
                run_id: claim.run_id.clone(),
                task_id: claim.task_id.clone(),
                attempt_id: claim.attempt_id.clone(),
                ownership_epoch: claim.ownership_epoch,
                specification_fingerprint: run.fingerprint().unwrap(),
                plan_fingerprint: fullmag_session::canonical_json_sha256(
                    &serde_json::to_value(&execution_plan).unwrap(),
                ),
                requested_execution: run.requested_execution.clone(),
                preparation: PreparationBinding::from_receipt(&receipt).unwrap(),
                inputs: [(port.port_id.clone(), input)].into_iter().collect(),
                frozen_stage_context: None,
            },
        };
        let effective = materialize_accepted_step_output_initial_state(
            &store,
            &worker_step,
            &port,
            &execution_plan,
            &receipt.preparation_id,
            &receipt.plan_fingerprint,
        )
        .unwrap();
        assert_eq!(effective.carrier.field["values"], json!(predecessor_values));
        assert_eq!(
            effective.provenance["materialization_kind"],
            "step_output"
        );
        assert_eq!(effective.provenance["producer_clock"]["step"], 17);
        assert_eq!(effective.provenance["producer_clock"]["time_seconds"], 1.7e-9);
        assert_eq!(effective.provenance["target_clock"]["step"], 0);
        assert_eq!(effective.provenance["target_clock"]["time_seconds"], 0.0);

        let request: CurrentLiveSnapshotRequest = serde_json::from_value(json!({
            "session_id": "live-view-continuity",
        }))
        .unwrap();
        let mut snapshot = crate::session::default_current_live_state(&request);
        let read_model = LiveScenePreparationReadModel {
            schema_version: LIVE_SCENE_PREPARATION_READ_MODEL_SCHEMA,
            preparation_id: receipt.preparation_id.clone(),
            scene_revision: 7,
            plan_fingerprint: receipt.plan_fingerprint.clone(),
            requested_execution: run.requested_execution.clone(),
            execution_plan,
            global_sampling_mesh: None,
        };
        let (old_metadata, old_fem_mesh) = prepared_domain_publication(&snapshot, &read_model).unwrap();
        let mut old_domain: CurrentLiveSnapshotRequest = serde_json::from_value(json!({
            "session_id": "live-view-continuity",
        }))
        .unwrap();
        old_domain.metadata = Some(old_metadata.into());
        old_domain.fem_mesh = old_fem_mesh;
        crate::session::apply_current_live_snapshot(&mut snapshot, old_domain).unwrap();
        let old_h_locator = serde_json::json!({
            "owner": {
                "session_id": "session-live-view-continuity",
                "session_epoch": "1",
                "request_scope_epoch": "scope-live-view-continuity",
                "run_id": run.run_id.as_str(),
                "runtime_stage_id": "step-a",
                "authored_stage_id": "step-a",
                "module_id": "fdm",
                "object_id": "strip",
                "output_id": "H_demag",
                "source_digest": "sha256:old-source",
                "content_digest": "sha256:old-content",
                "observation_mesh_revision": 1,
                "observation_topology_revision": 1,
                "historical_inspection": true,
                "native_mesh_identity": "sha256:old-mesh",
                "native_topology_identity": "sha256:old-topology"
            },
            "carrier_scope_kind": "object",
            "carrier_scope_id": "strip",
            "carrier_id": "artifact:sha256:old-content:point_samples",
            "carrier_digest": "sha256:old-content",
            "carrier_revision": "1",
            "indexing": "point_samples",
            "sample_count": 1,
            "coordinate_frame": "world",
            "coordinate_unit": "m",
            "topology_binary_schema": "FMMT.v2"
        });
        snapshot.latest_fields.insert(
            "H_demag".into(),
            json!({
                "values": [[1.0, 0.0, 0.0]],
                "source_step": 17,
                "artifact_field_locator": old_h_locator.clone()
            }),
        );
        let old_h_frame = crate::session::accepted_observation_frame_ref(
            &snapshot,
            17,
            Some(1.7e-9),
        );
        let mut old_h_bundle = crate::schemas::common::FieldPublicationBundle::for_response(
            old_h_frame,
            1,
            1,
            1,
            1,
            "sha256:old-topology",
            "H_demag",
            "x",
            "object",
            Some("strip"),
            "artifact:old-h",
            "sha256:old-content",
        );
        old_h_bundle.field.artifact_field_locator = Some(
            serde_json::from_value(old_h_locator).unwrap(),
        );
        snapshot
            .field_publication_bundles
            .insert("H_demag".into(), old_h_bundle);
        snapshot.preview_cache.insert(fullmag_runner::LivePreviewField {
            config_revision: 1,
            source_step: 17,
            source_time_seconds: Some(1.7e-9),
            source_revision: 1,
            materialized_at_unix_ms: 1,
            materialization_wall_time_ns: 1,
            quantity: "H_demag".into(),
            unit: "T".into(),
            spatial_kind: "vector".into(),
            quantity_domain: "magnetic_only".into(),
            preview_grid: [1, 1, 1],
            original_grid: [1, 1, 1],
            vector_field_values: vec![1.0, 0.0, 0.0],
            x_chosen_size: 1,
            y_chosen_size: 1,
            applied_x_chosen_size: 1,
            applied_y_chosen_size: 1,
            applied_layer_stride: 1,
            auto_downscaled: false,
            auto_downscale_message: None,
            active_mask: None,
        });
        let same_domain_generation = crate::router_v2::handlers::sessions::status::domain_generation_id(&snapshot);
        let (metadata, fem_mesh) = prepared_domain_publication(&snapshot, &read_model).unwrap();
        retire_previous_observation_for_step_output(&mut snapshot);
        assert!(snapshot.latest_fields.get("H_demag").is_none());
        assert!(snapshot.field_publication_bundles.get("H_demag").is_none());
        assert!(snapshot.preview_cache.get("H_demag").is_none());
        assert_eq!(
            crate::router_v2::handlers::sessions::status::domain_generation_id(&snapshot),
            same_domain_generation,
            "same-grid stage switches retain the active prepared domain identity"
        );
        let mut publication: CurrentLiveSnapshotRequest = serde_json::from_value(json!({
            "session_id": "live-view-continuity",
        }))
        .unwrap();
        publication.metadata = Some(metadata.into());
        publication.fem_mesh = fem_mesh;
        crate::session::apply_current_live_snapshot(&mut snapshot, publication).unwrap();
        publish_accepted_step_output_initial_state(&mut snapshot, &read_model, effective).unwrap();

        let field = snapshot.latest_fields.get("m").expect("accepted M0 carrier");
        assert_eq!(field["values"], json!(predecessor_values));
        assert!(snapshot.latest_fields.get("H_demag").is_none());
        assert!(snapshot.preview_cache.get("H_demag").is_none());
        assert_eq!(
            snapshot.metadata.as_deref().unwrap()["execution_plan"],
            serde_json::to_value(&read_model.execution_plan).unwrap(),
            "the published metadata stays bound to the canonical authored execution plan"
        );
        assert_eq!(
            field["provenance"]["source_kind"],
            "accepted_step_output_initial_state"
        );
        assert_eq!(
            field["provenance"]["plan_fingerprint"],
            read_model.plan_fingerprint
        );
        assert_eq!(field["provenance"]["target_attempt"]["attempt_id"], claim.attempt_id.as_str());
        assert!(field["observation_frame"]["authored_initial_state"].is_null());
        assert_eq!(
            field["observation_frame"]["domain_generation_id"],
            crate::router_v2::handlers::sessions::status::domain_generation_id(&snapshot)
        );
        assert!(snapshot.authored_initial_state.is_none());
    }
}
