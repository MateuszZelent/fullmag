//! Bounded observation of the authored initial state on the published FDM grid.

use std::sync::atomic::Ordering;
use std::time::Duration;

use fullmag_ir::{BackendPlanIR, ExecutionPlanIR, ProblemIR};
use fullmag_runner::{
    AcceptedMaterializationLane, PreparedMaterializationBatch, PreparedMaterializationRequest,
    PreparedStateIdentity,
};
use serde::{Deserialize, Serialize};
use serde_json::json;
use tokio::io::{AsyncReadExt, AsyncWriteExt};

use crate::error::ApiError;
use crate::live_authored_initial_state::apply_preparation::{
    plan_on_published_domain, qualified_base, PublishedDomainPlan,
};
use crate::types::{
    AppState, CurrentLiveFieldFrameRequest, CurrentLiveRequestContext, LatestFields,
    SessionStateResponse,
};

pub(crate) const WORKER_ARGUMENT: &str = "--evaluate-prepared-fdm-fields";
const MAX_CELLS: u64 = 65_536;
const MAX_MESSAGE_BYTES: u64 = 64 * 1024 * 1024;
const WORKER_TIMEOUT: Duration = Duration::from_secs(90);
static EVALUATOR_SLOT: tokio::sync::Semaphore = tokio::sync::Semaphore::const_new(1);

fn validate_grid(cells: [u32; 3]) -> Result<(), &'static str> {
    if cells.contains(&0) {
        return Err("Build the current FDM grid before computing fields.");
    }
    let count = cells
        .into_iter()
        .map(u64::from)
        .fold(1, u64::saturating_mul);
    if count > MAX_CELLS {
        return Err("Prepared Compute Fields supports at most 65,536 FDM cells.");
    }
    Ok(())
}

// An edited scene can retire its held RunIntent after publishing a qualified M0.
// That display is still authored input even when the historical run is terminal.
pub(crate) fn uses_prepared_field_input(snapshot: &SessionStateResponse) -> bool {
    use crate::types::RuntimeLifecycleState;

    snapshot.run.as_ref().is_none_or(|run| {
        match crate::session::accepted_runtime_lifecycle_state(&run.status) {
            RuntimeLifecycleState::Completed | RuntimeLifecycleState::Failed => false,
            RuntimeLifecycleState::Cancelled => retired_authoring_input_is_current(snapshot),
            _ => true,
        }
    })
}

fn retired_authoring_input_is_current(snapshot: &SessionStateResponse) -> bool {
    snapshot.run.as_ref().is_some_and(|run| run.status == "cancelled")
        && snapshot.session.status == "awaiting_command"
        && snapshot.stage_execution.is_none()
        && crate::live_authored_initial_state::current_publication(snapshot).is_some()
}

pub(crate) fn disabled_reason(snapshot: &SessionStateResponse) -> Result<(), &'static str> {
    if snapshot.runtime_status.code == "imported_read_only" || snapshot.session.status == "closed" {
        return Err("This session is read-only.");
    }
    if !matches!(
        crate::session::effective_runtime_status_code(snapshot).as_str(),
        "awaiting_command" | "waiting_for_compute" | "waiting_for_solve"
    ) || snapshot.run.as_ref().is_some_and(|run| {
        !(matches!(
            run.status.as_str(),
            "awaiting_command" | "waiting_for_compute" | "waiting_for_solve"
        ) || retired_authoring_input_is_current(snapshot))
            || crate::router_v2::handlers::sessions::status::accepted_solver_steps(
            snapshot,
            &run.run_id,
        ) != 0
    }) {
        return Err("Prepared Compute Fields requires an idle, unstarted Study.");
    }
    let scene = snapshot
        .scene_document
        .as_ref()
        .ok_or("Commit a scene before computing fields.")?;
    if scene.study.requested_backend != "fdm" || scene.study.requested_device != "cpu" {
        return Err("Prepared Compute Fields requires FDM with CPU explicitly selected.");
    }
    if fullmag_authoring::scene_solve_objects(scene)
        .next()
        .is_none()
    {
        return Err("Add a magnetic object before computing fields.");
    }
    if fullmag_authoring::scene_document_has_unresolved_solve_prerequisites(scene) {
        return Err("Assign material and initial magnetization to every magnetic object.");
    }
    if snapshot.magnetization_applies.pending.is_some() {
        return Err("Initial magnetization preparation is pending.");
    }
    let layout = snapshot
        .metadata
        .as_ref()
        .and_then(|metadata| metadata.get("artifact_layout"))
        .ok_or("Build the current FDM grid before computing fields.")?;
    if layout["backend"] != "fdm" {
        return Err("Prepared Compute Fields requires a single FDM grid.");
    }
    validate_grid(crate::router_v2::handlers::sessions::status::fdm_grid_shape(snapshot, None))
}

#[derive(PartialEq, Eq)]
struct InputFence {
    scene_revision: u64,
    domain: crate::session::LiveFieldDomainIdentity,
    region: fullmag_authoring::RegionRealizationRevisions,
    magnetization_revision: Option<u64>,
    metadata_version: Option<u64>,
}

impl InputFence {
    fn capture(snapshot: &SessionStateResponse) -> Option<Self> {
        Some(Self {
            scene_revision: snapshot.scene_document.as_ref()?.revision,
            domain: crate::session::current_live_field_domain_identity(snapshot),
            region: snapshot.region_realization_revisions,
            magnetization_revision: snapshot.field_quantity_revisions.get("m").copied(),
            metadata_version: snapshot
                .metadata
                .as_ref()
                .map(|metadata| metadata.version()),
        })
    }
}

#[derive(Deserialize, Serialize)]
struct EvaluationInput {
    problem: ProblemIR,
    plan: ExecutionPlanIR,
    identity: PreparedStateIdentity,
}

fn evaluate(input: EvaluationInput) -> Result<PreparedMaterializationBatch, String> {
    let BackendPlanIR::Fdm(plan) = &input.plan.backend_plan else {
        return Err("Prepared Compute Fields requires a single FDM grid.".into());
    };
    if input
        .problem
        .problem_meta
        .runtime_metadata
        .get("runtime_selection")
        .and_then(|selection| selection.get("device"))
        .and_then(serde_json::Value::as_str)
        != Some("cpu")
    {
        return Err("Prepared Compute Fields requires an explicit CPU request.".into());
    }
    validate_grid(plan.grid.cells)?;
    if plan.resolved_periodic_images.is_some() {
        return Err("Prepared Compute Fields does not support truncated periodic images.".into());
    }
    let layout = fullmag_runner::study_magnetization_layout_for_plan(&input.plan)
        .map_err(|error| error.to_string())?;
    let mut batch =
        fullmag_runner::materialize_prepared_observables(&PreparedMaterializationRequest {
            plan: &input.plan,
            problem: &input.problem,
            identity: &input.identity,
            lane: AcceptedMaterializationLane::FdmCpu,
            values: &plan.initial_magnetization,
            layout: &layout,
            requested_quantity_ids: &[],
        })?;
    batch
        .fields
        .retain(|field| field.quantity_id != "m" && !field.quantity_id.starts_with("mat_"));
    Ok(batch)
}

pub(crate) fn run_worker() -> anyhow::Result<()> {
    use std::io::Read;
    let mut bytes = Vec::new();
    std::io::stdin()
        .lock()
        .take(MAX_MESSAGE_BYTES + 1)
        .read_to_end(&mut bytes)?;
    anyhow::ensure!(
        bytes.len() as u64 <= MAX_MESSAGE_BYTES,
        "prepared input exceeds byte budget"
    );
    let input = serde_json::from_slice(&bytes)?;
    let result = evaluate(input);
    serde_json::to_writer(std::io::stdout().lock(), &result)?;
    Ok(())
}

async fn evaluate_in_worker(input: Vec<u8>) -> Result<Vec<u8>, ApiError> {
    use std::process::Stdio;
    let failed = |error: std::io::Error| {
        ApiError::internal(format!("Prepared field worker I/O failed: {error}"))
    };
    let executable = std::env::current_exe().map_err(failed)?;
    let mut child = tokio::process::Command::new(executable)
        .arg(WORKER_ARGUMENT)
        .stdin(Stdio::piped())
        .stdout(Stdio::piped())
        .kill_on_drop(true)
        .spawn()
        .map_err(failed)?;
    let mut stdin = child.stdin.take().expect("piped worker stdin");
    let mut stdout = child
        .stdout
        .take()
        .expect("piped worker stdout")
        .take(MAX_MESSAGE_BYTES + 1);
    tokio::time::timeout(WORKER_TIMEOUT, async {
        stdin.write_all(&input).await.map_err(failed)?;
        drop(stdin);
        let mut output = Vec::new();
        stdout.read_to_end(&mut output).await.map_err(failed)?;
        if output.len() as u64 > MAX_MESSAGE_BYTES {
            return Err(ApiError::unprocessable(
                "Prepared field output exceeds the byte budget.",
            ));
        }
        if !child.wait().await.map_err(failed)?.success() {
            return Err(ApiError::internal(
                "Prepared field worker exited unsuccessfully.",
            ));
        }
        Ok(output)
    })
    .await
    .map_err(|_| ApiError::unprocessable("Prepared field evaluation exceeded 90 seconds."))?
}

pub(crate) async fn evaluate_and_publish(
    state: &AppState,
    context: &CurrentLiveRequestContext,
    snapshot: SessionStateResponse,
    command_id: &str,
) -> Result<(), ApiError> {
    let _slot = EVALUATOR_SLOT
        .try_acquire()
        .map_err(|_| ApiError::conflict("A prepared field evaluation is already active."))?;
    let fence = InputFence::capture(&snapshot)
        .ok_or_else(|| ApiError::conflict("The input scene is no longer available."))?;
    let scene_revision = fence.scene_revision;
    let repo = state.repo_root.clone();
    let workspace = state.current_workspace_root.clone();
    let store = state.submit_store_root.clone();
    let worker_context = context.clone();
    let id = command_id.to_owned();
    let (identity, magnetization, input) = tokio::task::spawn_blocking(move || {
        let scene = snapshot
            .scene_document
            .as_ref()
            .ok_or_else(|| ApiError::conflict("The input scene is no longer available."))?;
        let PublishedDomainPlan::Ready {
            problem,
            mut plan,
            layout,
        } = plan_on_published_domain(
            &repo,
            &workspace,
            store.as_deref(),
            &worker_context,
            &snapshot,
            scene,
        )?
        else {
            return Err(ApiError::conflict(
                "Build the current FDM grid before computing fields.",
            ));
        };
        let existing = crate::live_authored_initial_state::current_publication(&snapshot);
        if let Some(publication) = existing {
            let (values, _) = qualified_base(&snapshot, &layout)?.ok_or_else(|| {
                ApiError::conflict("The displayed initial magnetization is unavailable.")
            })?;
            plan = fullmag_runner::materialize_study_magnetization_input(&plan, &layout, &values)
                .map_err(|error| ApiError::unprocessable(error.message))?;
            let current_time = publication.frame.source_time_seconds;
            let planned_clock = fullmag_runner::prepared_observation_clock(&plan)
                .map_err(ApiError::unprocessable)?;
            if current_time != Some(planned_clock.time_seconds) {
                return Err(ApiError::conflict(
                    "The current initial magnetization has a different time origin.",
                ));
            }
        }
        let BackendPlanIR::Fdm(fdm) = &plan.backend_plan else {
            return Err(ApiError::unprocessable(
                "Prepared Compute Fields requires a single FDM grid.",
            ));
        };
        validate_grid(fdm.grid.cells).map_err(ApiError::unprocessable)?;
        let flattened = fdm
            .initial_magnetization
            .iter()
            .flatten()
            .copied()
            .collect::<Vec<_>>();
        let magnetization_values_sha256 = fullmag_runner::live_preview_values_sha256(&flattened);
        if existing
            .and_then(|publication| publication.frame.authored_initial_state.as_ref())
            .is_some_and(|origin| origin.values_sha256 != magnetization_values_sha256)
        {
            return Err(ApiError::conflict(
                "The prepared plan differs from the displayed magnetization.",
            ));
        }
        let plan_value =
            serde_json::to_value(&plan).map_err(|error| ApiError::internal(error.to_string()))?;
        let identity = PreparedStateIdentity {
            run_id: snapshot.session.run_id.clone(),
            task_id: id.clone(),
            step_id: "authored_initial_state".into(),
            preparation_id: id,
            plan_fingerprint: fullmag_session::canonical_json_sha256(&plan_value),
            magnetization_values_sha256,
        };
        let magnetization = if existing.is_some() {
            None
        } else {
            Some(
                crate::live_scene_preparation::prepare_initial_magnetization(&plan)?
                    .ok_or_else(|| ApiError::unprocessable("No prepared magnetization carrier."))?,
            )
        };
        let input = serde_json::to_vec(&EvaluationInput {
            problem,
            plan,
            identity: identity.clone(),
        })
        .map_err(|error| ApiError::internal(error.to_string()))?;
        if input.len() as u64 > MAX_MESSAGE_BYTES {
            return Err(ApiError::unprocessable(
                "Prepared field input exceeds the byte budget.",
            ));
        }
        Ok::<_, ApiError>((identity, magnetization, input))
    })
    .await
    .map_err(|error| ApiError::internal(error.to_string()))??;

    let output = evaluate_in_worker(input).await?;
    let (magnetization, identity, fields) = tokio::task::spawn_blocking(move || {
        let batch: Result<PreparedMaterializationBatch, String> = serde_json::from_slice(&output)
            .map_err(|error| {
            ApiError::internal(format!("Invalid prepared field worker reply: {error}"))
        })?;
        let batch = batch.map_err(ApiError::unprocessable)?;
        if batch.identity != identity
            || batch.lane != AcceptedMaterializationLane::FdmCpu
            || batch.clock.accepted_step != 0
            || batch.fields.is_empty()
        {
            return Err(ApiError::conflict(
                "Prepared field results do not match the requested state.",
            ));
        }
        let provenance = json!({
            "source": crate::prepared_observation_adoption::PROVENANCE_SOURCE,
            "evaluation_lane": batch.lane,
            "requested_lane": batch.lane,
            "evaluation_plan_fingerprint": identity.plan_fingerprint,
            "magnetization_values_sha256": identity.magnetization_values_sha256,
            "evaluator_build_identity": batch.evaluator_build_identity,
        });
        let mut fields = LatestFields::default();
        for field in batch.fields {
            fields.insert(
                field.quantity_id,
                json!({
                    "values": field.values,
                    "n_comp": field.n_comp,
                    "layout": field.layout,
                    "carrier_id": field.carrier_id,
                    "spatial_kind": field.spatial_kind,
                    "source_step": 0,
                    "source_time_seconds": batch.clock.time_seconds,
                    "provenance": provenance,
                }),
            );
        }
        Ok::<_, ApiError>((magnetization, identity, fields))
    })
    .await
    .map_err(|error| ApiError::internal(error.to_string()))??;

    let latest = state
        .current_live_state
        .read()
        .await
        .as_ref()
        .cloned()
        .ok_or_else(|| ApiError::conflict("The input session is no longer active."))?;
    let epoch = state.current_live_session_epoch.load(Ordering::Acquire);
    crate::ensure_current_live_request_context(&latest, context, epoch)?;
    disabled_reason(&latest).map_err(ApiError::conflict)?;
    if InputFence::capture(&latest).as_ref() != Some(&fence) {
        return Err(ApiError::conflict(
            "The scene, grid or magnetization changed while computing fields.",
        ));
    }
    let mut candidate = latest;
    let session_id = candidate.session.session_id.clone();
    // Build a candidate without holding the live-state RwLock. Only swap it
    // if no independent projection published a newer snapshot meanwhile.
    let expected_state_version = candidate.state_version;
    let expected_field_revision = candidate.field_catalog_revision;
    let candidate = tokio::task::spawn_blocking(move || {
        if let Some(magnetization) = magnetization {
            magnetization.publish(
                &mut candidate,
                &identity.preparation_id,
                &identity.plan_fingerprint,
                scene_revision,
                json!({"source_kind": "prepared_initial_state"}),
                false,
            )?;
        }
        let frame = crate::live_authored_initial_state::current_publication(&candidate)
            .ok_or_else(|| ApiError::conflict("Prepared magnetization publication is missing."))?
            .frame
            .clone();
        crate::session::apply_current_live_field_frame_to_candidate(
            &mut candidate,
            CurrentLiveFieldFrameRequest {
                session_id,
                latest_fields: Some(fields),
                replace_latest_fields: false,
                field_generation: None,
                preview_fields: None,
                clear_preview_cache: false,
            },
            Some(&frame),
        )?;
        Ok::<_, ApiError>(candidate)
    })
    .await
    .map_err(|error| ApiError::internal(error.to_string()))??;

    let _transition = state.current_live_session_transition.lock().await;
    let mut current = state.current_live_state.write().await;
    let epoch = state.current_live_session_epoch.load(Ordering::Acquire);
    if !current.as_ref().is_some_and(|snapshot| {
        crate::ensure_current_live_request_context(snapshot, context, epoch).is_ok()
            && disabled_reason(snapshot).is_ok()
            && snapshot.state_version == expected_state_version
            && snapshot.field_catalog_revision == expected_field_revision
            && InputFence::capture(snapshot).as_ref() == Some(&fence)
    }) {
        return Err(ApiError::conflict(
            "The live state changed while publishing prepared fields.",
        ));
    }
    let old = current.replace(candidate);
    drop(current);
    tokio::task::spawn_blocking(move || drop(old));
    Ok(())
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn fdm_demag_and_effective_field_are_observed_at_step_zero() {
        let mut problem = ProblemIR::bootstrap_example();
        problem.problem_meta.runtime_metadata.insert(
            "runtime_selection".into(),
            json!({"device": "cpu", "precision": "double"}),
        );
        problem.energy_terms = vec![fullmag_ir::EnergyTermIR::Demag {
            realization: Default::default(),
        }];
        let plan = fullmag_plan::plan(&problem).expect("FDM demag plan");
        let BackendPlanIR::Fdm(fdm) = &plan.backend_plan else {
            panic!("expected single-grid FDM");
        };
        let flat = fdm
            .initial_magnetization
            .iter()
            .flatten()
            .copied()
            .collect::<Vec<_>>();
        let m_digest = fullmag_runner::live_preview_values_sha256(&flat);
        let identity = PreparedStateIdentity {
            run_id: "run".into(),
            task_id: "compute-fields".into(),
            step_id: "authored_initial_state".into(),
            preparation_id: "compute-fields".into(),
            plan_fingerprint: "test-plan".into(),
            magnetization_values_sha256: m_digest,
        };
        let batch = evaluate(EvaluationInput {
            problem,
            plan,
            identity: identity.clone(),
        })
        .expect("prepared FDM observation");
        assert_eq!(batch.identity, identity);
        assert_eq!(batch.clock.accepted_step, 0);
        assert_eq!(batch.clock.time_seconds, 0.0);
        assert_eq!(batch.clock.dt_seconds, None);
        let field = |id| {
            batch
                .fields
                .iter()
                .find(|field| field.quantity_id == id)
                .unwrap()
        };
        let demag = &field("H_demag").values;
        let effective = &field("H_eff").values;
        assert_eq!(demag.len(), flat.len());
        assert!(demag.iter().any(|value| value.abs() > 0.0));
        assert_eq!(effective, demag);
        assert!(batch
            .fields
            .iter()
            .all(|field| !matches!(field.quantity_id.as_str(), "H_ex" | "m")));
    }

    #[test]
    fn held_study_counts_planned_stages_separately_from_solver_steps() {
        let request = serde_json::from_value(json!({"session_id": "held-fields"})).unwrap();
        let mut snapshot = crate::session::default_current_live_state(&request);
        snapshot.session.status = "waiting_for_compute".into();
        snapshot.run = Some(crate::types::RunManifest {
            status: "waiting_for_compute".into(),
            total_steps: 1,
            run_id: "held-run".into(),
            session_id: "held-fields".into(),
            final_time: None,
            final_e_ex: None,
            final_e_demag: None,
            final_e_ext: None,
            final_e_ani: None,
            final_e_dmi: None,
            final_e_rotated_dmi: None,
            final_e_total: None,
            artifact_dir: String::new(),
        });
        assert_eq!(
            disabled_reason(&snapshot),
            Err("Commit a scene before computing fields.")
        );
        snapshot.session.status = "awaiting_command".into();
        snapshot.run.as_mut().unwrap().status = "cancelled".into();
        assert!(!uses_prepared_field_input(&snapshot));
        snapshot.authored_initial_state = Some(crate::live_authored_initial_state::AuthoredInitialStatePublication::new(
            &snapshot,
            crate::schemas::common::AuthoredInitialStateOrigin {
                preparation_id: "prepared-edit".into(),
                plan_fingerprint: "plan".into(),
                scene_revision: 2,
                initial_state_revision: 1,
                values_sha256: "state".into(),
            },
            0.0,
        ));
        assert!(uses_prepared_field_input(&snapshot));
        assert_eq!(
            disabled_reason(&snapshot),
            Err("Commit a scene before computing fields."),
        );
        snapshot.run.as_mut().unwrap().status = "failed".into();
        assert!(!uses_prepared_field_input(&snapshot));
        snapshot.run.as_mut().unwrap().status = "running".into();
        assert_eq!(
            disabled_reason(&snapshot),
            Err("Prepared Compute Fields requires an idle, unstarted Study.")
        );
    }

    #[test]
    fn caps_preview_grid_without_overflow() {
        assert!(validate_grid([25, 25, 5]).is_ok());
        assert!(validate_grid([0, 25, 5]).is_err());
        assert!(validate_grid([256, 256, 2]).is_err());
        assert!(validate_grid([u32::MAX; 3]).is_err());
    }
}
