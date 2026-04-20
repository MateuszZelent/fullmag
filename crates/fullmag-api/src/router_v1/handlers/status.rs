//! GET /v1/live/current/status — thin LiveStatus summary.

use std::sync::Arc;

use axum::extract::State;
use axum::Json;

use crate::error::ApiError;
use crate::schemas::status::*;
use crate::types::AppState;
use fullmag_runner::{DisplayFieldComponent, DisplayViewMode as RunnerDisplayViewMode};

#[utoipa::path(
    get,
    path = "/v1/live/current/status",
    responses(
        (status = 200, description = "Current live status", body = LiveStatus),
        (status = 404, description = "No active workspace"),
    ),
    tag = "status"
)]
pub async fn get_status(State(state): State<Arc<AppState>>) -> Result<Json<LiveStatus>, ApiError> {
    let guard = state.current_live_state.read().await;
    let snapshot = guard
        .as_ref()
        .ok_or_else(|| ApiError::not_found("no active local live workspace"))?;

    let display_sel = state.current_display_selection.read().await;

    let session = SessionSummary {
        session_id: snapshot.session.session_id.clone(),
        name: snapshot.session.problem_name.clone(),
        created_at: snapshot.session.started_at_unix_ms.to_string(),
        workspace_root: state.current_workspace_root.display().to_string(),
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
            solver_time: r.final_time.unwrap_or(0.0),
        }
    });

    let ls = snapshot.live_state.as_ref();
    let latest = ls.map(|l| &l.latest_step);

    let solver = SolverSummary {
        state: ls
            .map(|l| l.status.clone())
            .unwrap_or_else(|| "idle".into()),
        algorithm: None,
        dt: latest.map(|s| s.dt),
        max_torque: latest.map(|s| s.max_torque_T),
        converged: latest.map(|s| s.finished),
    };

    let display = DisplaySelection {
        active_quantity_id: display_sel.selection.quantity.clone(),
        view_mode: match display_sel.selection.view_mode {
            RunnerDisplayViewMode::TwoD => DisplayViewMode::TwoD,
            RunnerDisplayViewMode::ThreeD => DisplayViewMode::ThreeD,
        },
        field_component: match display_sel.selection.field_component {
            DisplayFieldComponent::X => FieldComponent::X,
            DisplayFieldComponent::Y => FieldComponent::Y,
            DisplayFieldComponent::Z => FieldComponent::Z,
            DisplayFieldComponent::Magnitude => FieldComponent::Magnitude,
        },
        colormap: "viridis".into(),
        auto_contrast: display_sel.selection.auto_scale_enabled,
        contrast_min: None,
        contrast_max: None,
        vector_glyphs: true,
        vector_density: display_sel.selection.every_n,
        slice_mode: if display_sel.selection.all_layers {
            "all".into()
        } else {
            "single".into()
        },
        slice_layer: display_sel.selection.layer as i32,
        max_points: display_sel.selection.max_points,
        x_chosen_size: display_sel.selection.x_chosen_size,
        y_chosen_size: display_sel.selection.y_chosen_size,
    };

    let is_fem = snapshot.fem_mesh.is_some();
    let cell_count = if is_fem {
        snapshot
            .fem_mesh
            .as_ref()
            .map(|m| m.elements.len() as u64)
            .unwrap_or(0)
    } else {
        latest
            .map(|s| s.grid[0] as u64 * s.grid[1] as u64 * s.grid[2] as u64)
            .unwrap_or(0)
    };

    let domain = DomainSummary {
        generation_id: snapshot
            .fem_mesh
            .as_ref()
            .and_then(|m| m.generation_id.as_deref())
            .and_then(|g| g.parse::<u64>().ok())
            .unwrap_or(0),
        discretization: if is_fem { "fem" } else { "fdm" }.into(),
        cell_count,
    };

    let resources = ResourceRevisionMap {
        fields_revision: snapshot.state_version,
        scalars_revision: snapshot.scalar_rows.len() as u64,
        domain_generation_id: domain.generation_id,
        artifacts_revision: snapshot.artifacts.len() as u64,
        engine_log_revision: snapshot.engine_log.len() as u64,
        display_revision: display_sel.revision,
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
        algorithms_available: Vec::new(),
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

    let metrics = MetricsSummary {
        uptime_seconds: uptime,
        total_steps,
        steps_per_second: if uptime > 0 {
            Some(total_steps as f64 / uptime as f64)
        } else {
            None
        },
    };

    Ok(Json(LiveStatus {
        api_contract_version: "1.0.0".into(),
        runtime_bundle_version: snapshot.session_protocol_version.clone(),
        session,
        run,
        solver,
        display,
        domain,
        resources,
        capabilities,
        energies,
        metrics,
    }))
}
