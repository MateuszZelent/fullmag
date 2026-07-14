//! GET /v2/sessions/current/status — thin LiveStatus summary.

use std::sync::Arc;

use axum::extract::State;
use axum::Json;
use serde_json::Value;

use crate::error::ApiError;
use crate::router_v2::handlers::data::field_resolution::live_magnetization_available;
use crate::router_v2::handlers::visualization::display::build_display_selection_response;
use crate::schemas::relaxation::{canonical_torque_apm, torque_t_from_apm, RelaxationAlgorithm};
use crate::schemas::status::*;
use crate::session::command_ledger_revisions;
use crate::types::{
    AppState, CurrentDisplaySelection, CurrentWorkspaceLayout, CurrentWorkspaceRibbon,
    CurrentWorkspaceSelection, DisplayPresentationState, SessionStateResponse,
};

const RELAXATION_ALGORITHMS_AVAILABLE: [&str; 4] = [
    "llg_overdamped",
    "projected_gradient_bb",
    "nonlinear_cg",
    "tangent_plane_implicit",
];

fn relaxation_algorithms_available() -> Vec<String> {
    RELAXATION_ALGORITHMS_AVAILABLE
        .iter()
        .map(|algorithm| (*algorithm).to_string())
        .collect()
}

#[utoipa::path(
    get,
    path = "/v2/sessions/current/status",
    responses(
        (status = 200, description = "Current live status", body = LiveStatus),
        (status = 404, description = "No active workspace"),
    ),
    tag = "sessions"
)]
pub async fn get_status(State(state): State<Arc<AppState>>) -> Result<Json<LiveStatus>, ApiError> {
    let display_sel = state.current_display_selection.read().await.clone();
    let display_presentation = state.current_display_presentation.read().await.clone();
    let workspace_selection = state.current_workspace_selection.read().await.clone();
    let workspace_ribbon = state.current_workspace_ribbon.read().await.clone();
    let workspace_layout = state.current_workspace_layout.read().await.clone();
    let (commands_revision, command_completion_revision) = {
        let ledger = state.current_command_ledger.lock().await;
        let revisions = command_ledger_revisions(&ledger);
        (
            revisions.commands_revision,
            revisions.command_completion_revision,
        )
    };
    let guard = state.current_live_state.read().await;
    let snapshot = guard
        .as_ref()
        .ok_or_else(|| ApiError::not_found("no active local live workspace"))?;

    Ok(Json(build_live_status(
        state.current_workspace_root.as_path(),
        snapshot,
        &display_sel,
        &display_presentation,
        &workspace_selection,
        &workspace_ribbon,
        &workspace_layout,
        commands_revision,
        command_completion_revision,
    )))
}

pub(crate) fn build_live_status(
    workspace_root: &std::path::Path,
    snapshot: &SessionStateResponse,
    display_sel: &CurrentDisplaySelection,
    display_presentation: &DisplayPresentationState,
    workspace_selection: &CurrentWorkspaceSelection,
    workspace_ribbon: &CurrentWorkspaceRibbon,
    workspace_layout: &CurrentWorkspaceLayout,
    commands_revision: u64,
    command_completion_revision: u64,
) -> LiveStatus {
    let session = SessionSummary {
        session_id: snapshot.session.session_id.clone(),
        name: snapshot.session.problem_name.clone(),
        created_at: snapshot.session.started_at_unix_ms.to_string(),
        workspace_root: workspace_root.display().to_string(),
    };

    let run = snapshot.run.as_ref().map(|r| {
        let stage_exec = snapshot.stage_execution.as_ref();
        RunSummary {
            run_id: r.run_id.clone(),
            stage_index: stage_exec.and_then(|se| se.active_stage_index).unwrap_or(0) as u32,
            stage_label: stage_exec
                .and_then(|se| se.active_stage_kind.clone())
                .unwrap_or_default(),
            stage_count: stage_exec.map(|se| se.total_stages as u32).unwrap_or(0),
            started_at: snapshot.session.started_at_unix_ms.to_string(),
            solver_steps: r.total_steps as u64,
            solver_time: r
                .final_time
                .or_else(|| snapshot.live_state.as_ref().map(|ls| ls.latest_step.time))
                .unwrap_or(0.0),
        }
    });

    let ls = snapshot.live_state.as_ref();
    let latest = ls.map(|l| &l.latest_step);
    let max_torque_apm = latest.and_then(|step| canonical_torque_apm(step.max_torque_Apm));
    let completion = snapshot.stage_execution.as_ref().and_then(|execution| {
        execution
            .active_stage_index
            .and_then(|index| execution.stages.get(index))
            .or_else(|| {
                execution.stages.iter().rev().find(|record| {
                    matches!(
                        record.status,
                        crate::types::StageLifecycleState::Skipped
                            | crate::types::StageLifecycleState::Completed
                            | crate::types::StageLifecycleState::Cancelled
                            | crate::types::StageLifecycleState::Stopped
                            | crate::types::StageLifecycleState::Failed
                    )
                })
            })
    });

    let solver = SolverSummary {
        state: ls
            .map(|l| l.status.clone())
            .unwrap_or_else(|| "idle".into()),
        algorithm: None,
        relaxation_algorithm: relaxation_algorithm_from_metadata(snapshot.metadata.as_ref()),
        dt: latest.map(|s| s.dt),
        max_torque_t: max_torque_apm.and_then(torque_t_from_apm),
        max_torque_apm,
        max_rhs_norm_per_s: latest.map(|s| s.max_dm_dt),
        max_torque: max_torque_apm,
        converged: completion.map(|record| record.converged),
    };

    let display = build_display_selection_response(&display_sel, &display_presentation);

    let is_fem = snapshot.fem_mesh.is_some();
    let fdm_grid_shape = (!is_fem).then(|| fdm_grid_shape(snapshot, latest.map(|step| step.grid)));
    let cell_count = if is_fem {
        snapshot
            .fem_mesh
            .as_ref()
            .map(|m| m.elements.len() as u64)
            .unwrap_or(0)
    } else {
        fdm_grid_shape
            .map(|shape| shape[0] as u64 * shape[1] as u64 * shape[2] as u64)
            .unwrap_or(0)
    };
    let domain_generation_id = domain_generation_id(snapshot);

    let domain = DomainSummary {
        generation_id: domain_generation_id,
        discretization: if is_fem { "fem" } else { "fdm" }.into(),
        cell_count,
    };

    let field_catalog_revision = field_catalog_revision(snapshot);
    let field_revision = field_revision(snapshot);
    let artifact_revision = artifact_revision(snapshot);
    let resources = ResourceRevisionMap {
        topology_revision: topology_revision(snapshot, domain.generation_id),
        field_catalog_revision,
        field_revision,
        slice_revision: slice_revision(field_revision, display_sel.revision),
        artifact_revision,
        command_completion_revision,
        fields_revision: field_revision,
        scalars_revision: snapshot.scalar_revision,
        domain_generation_id: domain.generation_id,
        artifacts_revision: snapshot.artifacts.len() as u64,
        engine_log_revision: snapshot.engine_log.len() as u64,
        solver_profile_revision: snapshot.solver_profile.revision,
        display_revision: display_sel.revision,
        visualization_state_revision: display_sel.revision,
        workspace_revision: workspace_selection
            .revision
            .max(workspace_ribbon.revision)
            .max(workspace_layout.revision),
        mesh_revision: snapshot.mesh_revision,
        mesh_build_revision: snapshot.mesh_build_revision,
        commands_revision,
        stages_revision: snapshot.stage_execution_revision,
        scene_revision: snapshot.scene_document.as_ref().map(|scene| scene.revision),
        region_topology_revision: snapshot.region_realization_revisions.topology,
        region_membership_revision: snapshot.region_realization_revisions.membership,
        region_coefficients_revision: snapshot.region_realization_revisions.coefficients,
        region_initial_state_revision: snapshot.region_realization_revisions.initial_state,
    };

    let capabilities = CapabilityMap {
        structured_grid: !is_fem,
        explicit_topology: is_fem,
        binary_fields: true,
        cell_fields: true,
        node_fields: is_fem,
        scalar_history: true,
        eigen_modes: false,
        gpu_telemetry: true,
        preview_2d: true,
        preview_3d: true,
        algorithms_available: relaxation_algorithms_available(),
    };

    let energies = EnergySummary {
        total: latest.map(|s| s.e_total),
        exchange: latest.map(|s| s.e_ex),
        demag: latest.map(|s| s.e_demag),
        zeeman: latest.map(|s| s.e_ext),
        anisotropy: latest.map(|s| s.e_ani),
        dmi: latest.map(|s| s.e_dmi),
    };

    let uptime = std::time::SystemTime::now()
        .duration_since(std::time::UNIX_EPOCH)
        .map(|d| d.as_secs())
        .unwrap_or(0)
        .saturating_sub(snapshot.session.started_at_unix_ms as u64 / 1000);
    let total_steps = latest.map(|s| s.step).unwrap_or(0);

    // Compute instantaneous steps/s from the solver profiler's per-step wall
    // time when available, falling back to the lifetime average.
    let steps_per_second = instantaneous_steps_per_second(&snapshot.solver_profile).or_else(|| {
        latest
            .and_then(|step| (step.wall_time_ns > 0).then_some(step.wall_time_ns as f64 / 1.0e9))
            .filter(|elapsed| *elapsed > 0.0)
            .map(|elapsed| total_steps as f64 / elapsed)
    });
    let metrics = MetricsSummary {
        uptime_seconds: uptime,
        total_steps,
        steps_per_second,
    };

    LiveStatus {
        api_contract_version: "1.0.0".into(),
        runtime_bundle_version: crate::build_info::backend_build_date().to_string(),
        session,
        run,
        solver,
        display,
        domain,
        resources,
        capabilities,
        energies,
        metrics,
    }
}

fn relaxation_algorithm_from_metadata(metadata: Option<&Value>) -> Option<RelaxationAlgorithm> {
    metadata
        .and_then(|value| value.get("relaxation_algorithm"))
        .and_then(Value::as_str)
        .or_else(|| {
            metadata
                .and_then(|value| value.get("execution_plan"))
                .and_then(|value| value.get("backend_plan"))
                .and_then(|value| value.get("relax_algorithm"))
                .and_then(Value::as_str)
        })
        .and_then(RelaxationAlgorithm::parse)
}

pub(crate) fn topology_revision(snapshot: &SessionStateResponse, domain_generation_id: u64) -> u64 {
    if snapshot.fem_mesh.is_some() {
        snapshot.mesh_revision
    } else {
        domain_generation_id
    }
}

pub(crate) fn domain_generation_id(snapshot: &SessionStateResponse) -> u64 {
    if let Some(generation_id) = snapshot
        .fem_mesh
        .as_ref()
        .and_then(|m| m.generation_id.as_deref())
        .and_then(|g| g.parse::<u64>().ok())
    {
        return generation_id;
    }

    fdm_domain_generation_id(snapshot)
}

pub(crate) fn fdm_grid_shape(
    snapshot: &SessionStateResponse,
    latest_grid_shape: Option<[u32; 3]>,
) -> [u32; 3] {
    if let Some(shape) = latest_grid_shape.filter(|shape| shape.iter().all(|value| *value > 0)) {
        return shape;
    }

    fdm_artifact_layout(snapshot)
        .and_then(|layout| {
            layout
                .get("grid_cells")
                .or_else(|| layout.get("grid_shape"))
                .or_else(|| layout.get("shape"))
        })
        .and_then(value_array3_u32_positive)
        .unwrap_or([0, 0, 0])
}

fn fdm_domain_generation_id(snapshot: &SessionStateResponse) -> u64 {
    let latest_grid_shape = snapshot
        .live_state
        .as_ref()
        .map(|state| state.latest_step.grid);
    let grid_shape = fdm_grid_shape(snapshot, latest_grid_shape);
    if grid_shape.iter().all(|value| *value == 0) {
        return 0;
    }

    let mut revision = fnv1a_hash_bytes(0xcbf29ce484222325, b"fdm-domain-v1");
    for value in grid_shape {
        revision = fnv1a_hash_u64(revision, value as u64);
    }

    if let Some(layout) = fdm_artifact_layout(snapshot) {
        revision = fnv1a_hash_bytes(revision, b"layout");
        if let Some(origin) = layout
            .get("origin_m")
            .or_else(|| layout.get("origin"))
            .or_else(|| layout.get("grid_origin"))
            .or_else(|| layout.get("native_origin"))
            .and_then(value_array3_f64_any_finite)
        {
            revision = fnv1a_hash_f64_array(revision, origin);
        }
        if let Some(spacing) = layout
            .get("cell_size")
            .and_then(value_array3_f64_allow_planar)
        {
            revision = fnv1a_hash_f64_array(revision, spacing);
        }
    }

    revision.max(1)
}

fn fdm_artifact_layout(snapshot: &SessionStateResponse) -> Option<&Value> {
    snapshot
        .metadata
        .as_ref()
        .and_then(|metadata| metadata.get("artifact_layout"))
        .filter(|layout| layout.get("backend").and_then(Value::as_str) == Some("fdm"))
}

fn value_array3_u32_positive(value: &Value) -> Option<[u32; 3]> {
    let array = value.as_array()?;
    let values = [
        u32::try_from(array.first()?.as_u64()?).ok()?,
        u32::try_from(array.get(1)?.as_u64()?).ok()?,
        u32::try_from(array.get(2)?.as_u64()?).ok()?,
    ];
    values.iter().all(|value| *value > 0).then_some(values)
}

fn value_array3_f64_any_finite(value: &Value) -> Option<[f64; 3]> {
    let array = value.as_array()?;
    let values = [
        array.first()?.as_f64()?,
        array.get(1)?.as_f64()?,
        array.get(2)?.as_f64()?,
    ];
    values
        .iter()
        .all(|value| value.is_finite())
        .then_some(values)
}

fn value_array3_f64_allow_planar(value: &Value) -> Option<[f64; 3]> {
    let values = value_array3_f64_any_finite(value)?;
    values.iter().all(|value| *value >= 0.0).then_some(values)
}

fn fnv1a_hash_bytes(mut hash: u64, bytes: &[u8]) -> u64 {
    for byte in bytes {
        hash ^= *byte as u64;
        hash = hash.wrapping_mul(1099511628211);
    }
    hash
}

fn fnv1a_hash_u64(hash: u64, value: u64) -> u64 {
    fnv1a_hash_bytes(hash, &value.to_le_bytes())
}

fn fnv1a_hash_f64_array(mut hash: u64, values: [f64; 3]) -> u64 {
    for value in values {
        hash = fnv1a_hash_u64(hash, value.to_bits());
    }
    hash
}

pub(crate) fn field_catalog_revision(snapshot: &SessionStateResponse) -> u64 {
    if snapshot.field_catalog_revision > 0 {
        return snapshot.field_catalog_revision;
    }
    let mut revision = snapshot.latest_fields.len() as u64;
    for (quantity, value) in snapshot.latest_fields.entries() {
        revision = revision
            .wrapping_mul(16777619)
            .wrapping_add(quantity.len() as u64)
            .wrapping_add(
                value
                    .get("components")
                    .and_then(serde_json::Value::as_u64)
                    .unwrap_or(0),
            )
            .wrapping_add(
                value
                    .get("domain_generation_id")
                    .and_then(serde_json::Value::as_u64)
                    .unwrap_or(0),
            );
    }
    for (quantity, field) in snapshot.preview_cache.iter() {
        if snapshot.latest_fields.get(quantity).is_some() {
            continue;
        }
        revision = revision
            .wrapping_mul(16777619)
            .wrapping_add(quantity.len() as u64)
            .wrapping_add(field.vector_field_values.len() as u64)
            .wrapping_add(field.preview_grid.iter().map(|v| *v as u64).sum::<u64>());
    }
    if snapshot.latest_fields.get("m").is_none()
        && snapshot.preview_cache.get("m").is_none()
        && snapshot
            .live_state
            .as_ref()
            .and_then(|state| state.latest_step.magnetization.as_deref())
            .is_some_and(|values| {
                !values.is_empty()
                    && values.len() % 3 == 0
                    && values.iter().all(|value| value.is_finite())
            })
    {
        revision = revision.wrapping_mul(16777619).wrapping_add(1);
    }
    revision
}

pub(crate) fn field_revision(snapshot: &SessionStateResponse) -> u64 {
    if snapshot.field_samples_revision > 0 {
        return snapshot.field_samples_revision;
    }
    snapshot
        .latest_fields
        .entries()
        .filter_map(|(_, value)| {
            value
                .get("field_revision")
                .and_then(serde_json::Value::as_u64)
                .or_else(|| value.get("revision").and_then(serde_json::Value::as_u64))
        })
        .max()
        .or_else(|| (!snapshot.preview_cache.is_empty()).then_some(1))
        .or_else(|| {
            (snapshot.latest_fields.get("m").is_none()
                && snapshot.preview_cache.get("m").is_none()
                && live_magnetization_available(snapshot))
            .then_some(1)
        })
        .unwrap_or(0)
}

pub(crate) fn field_quantity_revision(snapshot: &SessionStateResponse, quantity_id: &str) -> u64 {
    snapshot
        .field_quantity_revisions
        .get(quantity_id)
        .copied()
        .or_else(|| {
            (quantity_id == "m")
                .then(|| live_magnetization_revision(snapshot))
                .flatten()
        })
        .or_else(|| {
            snapshot.latest_fields.get(quantity_id).and_then(|value| {
                value
                    .get("field_revision")
                    .and_then(serde_json::Value::as_u64)
                    .or_else(|| value.get("revision").and_then(serde_json::Value::as_u64))
            })
        })
        .or_else(|| {
            (snapshot.preview_cache.get(quantity_id).is_some()
                || (quantity_id == "m"
                    && snapshot.latest_fields.get("m").is_none()
                    && snapshot.preview_cache.get("m").is_none()
                    && live_magnetization_available(snapshot)))
            .then(|| field_revision(snapshot).max(1))
        })
        .unwrap_or(0)
}

fn live_magnetization_revision(snapshot: &SessionStateResponse) -> Option<u64> {
    if !live_magnetization_available(snapshot) {
        return None;
    }
    snapshot
        .live_state
        .as_ref()
        .map(|state| state.latest_step.step.max(1))
}

pub(crate) fn slice_revision(field_revision: u64, display_revision: u64) -> u64 {
    field_revision
        .wrapping_mul(31)
        .wrapping_add(display_revision)
        .max(display_revision)
}

pub(crate) fn artifact_revision(snapshot: &SessionStateResponse) -> u64 {
    snapshot
        .artifacts
        .iter()
        .fold(snapshot.artifacts.len() as u64, |revision, artifact| {
            revision
                .wrapping_mul(16777619)
                .wrapping_add(artifact.path.len() as u64)
                .wrapping_add(artifact.kind.len() as u64)
        })
}

/// Compute instantaneous steps/s from the solver profiler's recent per-step
/// wall time samples.  Returns `None` when the profiler is inactive or has
/// no samples, allowing the caller to fall back to the lifetime average.
fn instantaneous_steps_per_second(
    profile: &crate::schemas::diagnostics::SolverProfileResource,
) -> Option<f64> {
    if profile.latest_samples.is_empty() {
        return None;
    }
    // Average the per-step wall time from the most recent samples (up to 5).
    let window = &profile.latest_samples[profile.latest_samples.len().saturating_sub(5)..];
    let total_ns: u64 = window.iter().map(|s| s.total_ns).sum();
    if total_ns == 0 || window.is_empty() {
        return None;
    }
    let avg_ns = total_ns as f64 / window.len() as f64;
    Some(1.0e9 / avg_ns)
}

#[cfg(test)]
mod tests {
    use super::relaxation_algorithms_available;

    #[test]
    fn session_status_advertises_production_relaxation_algorithms() {
        assert_eq!(
            relaxation_algorithms_available(),
            vec![
                "llg_overdamped".to_string(),
                "projected_gradient_bb".to_string(),
                "nonlinear_cg".to_string(),
                "tangent_plane_implicit".to_string(),
            ]
        );
    }
}
