//! GET /v2/sessions/current/status — thin LiveStatus summary.

use std::collections::BTreeMap;
use std::sync::atomic::Ordering;
use std::sync::Arc;

use axum::extract::State;
use axum::Json;
use serde_json::Value;

use crate::error::ApiError;
use crate::router_v2::handlers::data::field_resolution::{
    is_fdm_backend_kind, is_fdm_snapshot, live_magnetization_available,
};
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
const CONNECTIVITY_DEGRADED_AFTER_MS: u64 = 15_000;
const CONNECTIVITY_DISCONNECTED_AFTER_MS: u64 = 45_000;

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
    let connectivity = refresh_current_live_connectivity(&state).await;
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
        connectivity,
    )))
}

/// Advances backend-owned connectivity from the real runner publication
/// heartbeat. Only an accepted publication may restore `Connected`; this path
/// can only preserve or worsen connectivity when the heartbeat becomes stale.
pub(crate) async fn refresh_current_live_connectivity(state: &AppState) -> SessionConnectivity {
    refresh_current_live_connectivity_at(state, current_unix_ms()).await
}

pub(crate) async fn record_current_live_heartbeat(state: &AppState) {
    record_current_live_heartbeat_at(state, current_unix_ms()).await;
}

fn current_unix_ms() -> u64 {
    u64::try_from(
        std::time::SystemTime::now()
            .duration_since(std::time::UNIX_EPOCH)
            .unwrap_or_default()
            .as_millis(),
    )
    .unwrap_or(u64::MAX)
}

async fn record_current_live_heartbeat_at(state: &AppState, now_unix_ms: u64) {
    state
        .current_live_last_seen_unix_ms
        .store(now_unix_ms, Ordering::Release);
    *state.current_live_connectivity.write().await = SessionConnectivity::Connected;
}

async fn refresh_current_live_connectivity_at(
    state: &AppState,
    now_unix_ms: u64,
) -> SessionConnectivity {
    let last_seen = state.current_live_last_seen_unix_ms.load(Ordering::Acquire);
    let current = *state.current_live_connectivity.read().await;
    let next = connectivity_from_liveness_at(current, last_seen, now_unix_ms);
    if next != current {
        *state.current_live_connectivity.write().await = next;
    }
    next
}

fn connectivity_from_liveness_at(
    current: SessionConnectivity,
    last_seen_unix_ms: u64,
    now_unix_ms: u64,
) -> SessionConnectivity {
    if last_seen_unix_ms == 0 {
        return current;
    }
    let age_ms = now_unix_ms.saturating_sub(last_seen_unix_ms);
    if age_ms >= CONNECTIVITY_DISCONNECTED_AFTER_MS {
        SessionConnectivity::Disconnected
    } else if age_ms >= CONNECTIVITY_DEGRADED_AFTER_MS && current == SessionConnectivity::Connected
    {
        SessionConnectivity::Degraded
    } else {
        current
    }
}

fn is_terminal_stage_record(record: &crate::types::StageExecutionRecord) -> bool {
    matches!(
        record.status,
        crate::types::StageLifecycleState::Skipped
            | crate::types::StageLifecycleState::Completed
            | crate::types::StageLifecycleState::Cancelled
            | crate::types::StageLifecycleState::Stopped
            | crate::types::StageLifecycleState::Failed
    )
}

fn solver_completion_record(
    execution: &crate::types::StageExecutionState,
) -> Option<&crate::types::StageExecutionRecord> {
    execution
        .active_stage_index
        .and_then(|index| execution.stages.get(index))
        .or_else(|| {
            execution.stages.iter().rev().find(|record| {
                is_terminal_stage_record(record)
                    && (record.converged
                        || record.reason.is_some()
                        || record.metric.is_some()
                        || record.metric_value.is_some())
            })
        })
        .or_else(|| {
            execution
                .stages
                .iter()
                .rev()
                .find(|record| is_terminal_stage_record(record))
        })
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
    connectivity: SessionConnectivity,
) -> LiveStatus {
    let solver_lifecycle = crate::session::effective_runtime_status_code(snapshot);
    let lifecycle = lifecycle_contract(
        &solver_lifecycle,
        snapshot.runtime_status.can_accept_commands && !snapshot.runtime_status.is_busy,
        connectivity,
    );
    let terminal_session_resource =
        lifecycle.session_resource == crate::schemas::status::SessionResourceLifecycle::Tombstoned;
    let session = SessionSummary {
        session_id: snapshot.session.session_id.clone(),
        session_epoch: session_epoch(
            &snapshot.session.session_id,
            snapshot.session.started_at_unix_ms,
            snapshot.session.finished_at_unix_ms,
            terminal_session_resource,
        ),
        name: snapshot.session.problem_name.clone(),
        created_at: snapshot.session.started_at_unix_ms.to_string(),
        workspace_root: workspace_root.display().to_string(),
    };

    let run = snapshot.run.as_ref().map(|r| {
        let stage_exec = snapshot.stage_execution.as_ref();
        let crossover = snapshot.session.fem_crossover_decision.as_ref();
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
            requested_device: snapshot.session.requested_device.clone(),
            resolved_device: snapshot
                .session
                .resolved_device
                .clone()
                .unwrap_or_else(|| snapshot.session.requested_device.clone()),
            selection_reason: crossover
                .map(|decision| decision.reason.clone())
                .or_else(|| {
                    snapshot
                        .session
                        .resolved_fallback
                        .as_ref()
                        .map(|fallback| fallback.reason.clone())
                })
                .unwrap_or_else(|| "explicit_device_request".to_string()),
            calibration_id: crossover.and_then(|decision| decision.calibration_id.clone()),
            selection_confidence: crossover.and_then(|decision| decision.confidence),
        }
    });

    let ls = snapshot.live_state.as_ref();
    let latest = ls.map(|l| &l.latest_step);
    let max_torque_apm = latest.and_then(|step| canonical_torque_apm(step.max_torque_Apm));
    let completion = snapshot
        .stage_execution
        .as_ref()
        .and_then(solver_completion_record);

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

    let is_fem = snapshot.fem_mesh.is_some() && !is_fdm_snapshot(snapshot);
    let fdm_grid_shape = (!is_fem).then(|| fdm_grid_shape(snapshot, latest.map(|step| step.grid)));
    let cell_count = if is_fem {
        snapshot
            .fem_mesh
            .as_ref()
            .map(|m| m.cell_count() as u64)
            .unwrap_or(0)
    } else {
        fdm_grid_shape
            .map(|shape| shape[0] as u64 * shape[1] as u64 * shape[2] as u64)
            .unwrap_or(0)
    };
    let domain_generation_id = domain_generation_id(snapshot);
    let domain_generation_revision = domain_generation_revision(snapshot);

    let domain = DomainSummary {
        generation_id: domain_generation_id.clone(),
        discretization: if is_fem { "fem" } else { "fdm" }.into(),
        cell_count,
    };

    let field_catalog_revision = field_catalog_revision(snapshot);
    let field_revision = field_revision(snapshot);
    let artifact_revision = artifact_revision(snapshot);
    let resources = ResourceRevisionMap {
        topology_revision: topology_revision(snapshot, domain_generation_revision),
        field_catalog_revision,
        field_revision,
        slice_revision: slice_revision(field_revision, display_sel.revision),
        artifact_revision,
        command_completion_revision,
        fields_revision: field_revision,
        scalars_revision: snapshot.scalar_revision,
        domain_generation_id: domain.generation_id.clone(),
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
        simulation_preparation_revision: snapshot.simulation_preparation_revision,
        scene_revision: snapshot.scene_document.as_ref().map(|scene| scene.revision),
        region_topology_revision: snapshot.region_realization_revisions.topology,
        region_membership_revision: snapshot.region_realization_revisions.membership,
        region_coefficients_revision: snapshot.region_realization_revisions.coefficients,
        region_initial_state_revision: snapshot.region_realization_revisions.initial_state,
    };

    let blocked_transport_capability =
        |reason: &str| crate::schemas::status::TransportAuthoringCapability {
            status: "unsupported".into(),
            authoring_allowed: false,
            reason: reason.into(),
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
        active_lane: active_lane_capability_snapshot(snapshot, is_fem),
        transport_authoring: Some(crate::schemas::status::TransportAuthoringCapabilityMap {
            contract_version: "transport-authoring-capabilities.v1".into(),
            m1_one_way_steady: crate::schemas::status::TransportAuthoringCapability {
                status: "semantic_only".into(),
                authoring_allowed: true,
                reason: "M1 steady one-way authoring is available; execution qualification remains workload-scoped.".into(),
            },
            m2_reciprocal: crate::schemas::status::TransportAuthoringCapability {
                status: "semantic_only".into(),
                authoring_allowed: true,
                reason: "M2 reciprocal authoring is available; executable qualification remains workload-scoped.".into(),
            },
            m3_transient: blocked_transport_capability("Transient transport remains an M3 authoring capability."),
            gpu: blocked_transport_capability("Transport GPU authoring is unavailable until lane qualification is published."),
            single_precision: blocked_transport_capability("Transport single precision is unavailable until precision qualification is published."),
            hybrid: blocked_transport_capability("Transport hybrid execution is not supported by the v1 authoring contract."),
        }),
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

    let steps_per_second = compat_end_to_end_steps_per_second(&snapshot.solver_profile);
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
        lifecycle,
        display,
        domain,
        resources,
        capabilities,
        energies,
        metrics,
    }
}

pub(crate) fn lifecycle_contract(
    solver: &str,
    runtime_accepts_commands: bool,
    connectivity: SessionConnectivity,
) -> crate::schemas::status::SessionLifecycleSummary {
    let terminal = matches!(solver, "completed" | "failed" | "cancelled" | "closed");
    crate::schemas::status::SessionLifecycleSummary {
        solver: solver.to_string(),
        session_resource: if terminal {
            crate::schemas::status::SessionResourceLifecycle::Tombstoned
        } else {
            crate::schemas::status::SessionResourceLifecycle::Active
        },
        connectivity,
        commandability: if terminal {
            crate::schemas::status::SessionCommandability::ReadOnly
        } else if runtime_accepts_commands && connectivity == SessionConnectivity::Connected {
            crate::schemas::status::SessionCommandability::Allowed
        } else {
            crate::schemas::status::SessionCommandability::Forbidden
        },
    }
}

pub(crate) fn session_epoch(
    session_id: &str,
    started_at_unix_ms: u128,
    finished_at_unix_ms: u128,
    terminal_session_resource: bool,
) -> String {
    if terminal_session_resource {
        format!("{session_id}@{started_at_unix_ms}:tombstone:{finished_at_unix_ms}")
    } else {
        format!("{session_id}@{started_at_unix_ms}")
    }
}

pub(crate) const ACTIVE_LANE_OPERATION_IDS: [&str; 33] = [
    "grid_build",
    "shared_mesh_build",
    "field_quantity",
    "vectors",
    "surface_coloring",
    "air_void_overlay",
    "region_membership",
    "hover_select_cell",
    "initial_magnetization.uniform",
    "initial_magnetization.vortex",
    "interaction.exchange",
    "interaction.demag",
    "interaction.dmi",
    "interaction.zeeman",
    "interaction.current_transport",
    "interaction.spin_torque",
    "interaction.sot",
    "interaction.stt",
    "interaction.interfacial_dmi",
    "interaction.bulk_dmi",
    "interaction.uniaxial_anisotropy",
    "interaction.cubic_anisotropy",
    "interaction.oersted",
    "interaction.oersted_field",
    "interaction.magnetoelastic",
    "interaction.thermal",
    "interaction.frozen_spins",
    "constraint.frozen_spins",
    "study.relaxation",
    "study.time_integration",
    "study.eigenmodes",
    "study.frequency_response",
    "study.fft",
];

fn active_lane_capability_snapshot(
    snapshot: &SessionStateResponse,
    is_fem: bool,
) -> ActiveLaneCapabilitySnapshot {
    let authored = ActiveLaneIdentity {
        backend: snapshot.session.requested_backend.clone(),
        discretization: normalize_lane_discretization(
            &snapshot.session.requested_backend,
            if is_fem { "fem" } else { "fdm" },
        ),
        device: snapshot.session.authored_requested_device.clone(),
        precision: snapshot.session.requested_precision.clone(),
        mode: snapshot.session.requested_mode.clone(),
    };
    let requested = ActiveLaneIdentity {
        backend: snapshot.session.requested_backend.clone(),
        discretization: normalize_lane_discretization(
            &snapshot.session.requested_backend,
            if is_fem { "fem" } else { "fdm" },
        ),
        device: snapshot.session.requested_device.clone(),
        precision: snapshot.session.requested_precision.clone(),
        mode: snapshot.session.requested_mode.clone(),
    };
    let session_resolution = (
        snapshot.session.resolved_backend.as_ref(),
        snapshot.session.resolved_device.as_ref(),
        snapshot.session.resolved_precision.as_ref(),
        snapshot.session.resolved_mode.as_ref(),
    );
    let metadata_resolution = || {
        let execution = snapshot.metadata.as_ref()?.get("resolved_execution")?;
        Some((
            execution.get("backend")?.as_str()?,
            execution.get("device")?.as_str()?,
            execution.get("precision")?.as_str()?,
            execution.get("mode")?.as_str()?,
        ))
    };
    let resolved = match session_resolution {
        (Some(backend), Some(device), Some(precision), Some(mode)) => Some(ActiveLaneIdentity {
            discretization: normalize_lane_discretization(
                backend,
                if is_fem { "fem" } else { "fdm" },
            ),
            backend: backend.clone(),
            device: device.clone(),
            precision: precision.clone(),
            mode: mode.clone(),
        }),
        (None, None, None, None) => {
            metadata_resolution().map(|(backend, device, precision, mode)| ActiveLaneIdentity {
                discretization: normalize_lane_discretization(
                    backend,
                    if is_fem { "fem" } else { "fdm" },
                ),
                backend: backend.to_string(),
                device: device.to_string(),
                precision: precision.to_string(),
                mode: mode.to_string(),
            })
        }
        _ => None,
    };
    let resolved = resolved.filter(|session_or_fallback| {
        let Some((backend, device, precision, mode)) = metadata_resolution() else {
            return true;
        };
        session_or_fallback.backend == backend
            && session_or_fallback.device == device
            && session_or_fallback.precision == precision
            && session_or_fallback.mode == mode
    });
    let fallback = snapshot
        .session
        .resolved_fallback
        .as_ref()
        .map(|value| ActiveLaneFallback {
            occurred: value.occurred,
            original_engine: value.original_engine.clone(),
            fallback_engine: value.fallback_engine.clone(),
            reason: value.reason.clone(),
            message: value.message.clone(),
        });

    let Some(planner) = snapshot.capabilities.as_ref() else {
        return ActiveLaneCapabilitySnapshot {
            schema_version: "active-lane-capabilities.v2".into(),
            authored,
            requested,
            resolved: None,
            fallback,
            source: ActiveLaneCapabilitySource {
                kind: "unavailable".into(),
                capability_profile_version: None,
                engine_id: None,
                authored_intent: "problem_ir.runtime_selection".into(),
                effective_request: "session.runtime_resolution".into(),
            },
            qualification: ActiveLaneQualification {
                status: "not_asserted".into(),
                reason: "Planner capability snapshot is unavailable; scientific qualification is not asserted.".into(),
            },
            operations: stale_active_lane_operations(
                "Planner capability snapshot is unavailable; operation support is stale.",
                "planner_capability_snapshot",
            ),
        };
    };

    if resolved.is_none() {
        return ActiveLaneCapabilitySnapshot {
            schema_version: "active-lane-capabilities.v2".into(),
            authored,
            requested,
            resolved: None,
            fallback,
            source: ActiveLaneCapabilitySource {
                kind: "planner".into(),
                capability_profile_version: Some(planner.capability_profile_version.clone()),
                engine_id: Some(planner.engine_id.as_str().to_string()),
                authored_intent: "problem_ir.runtime_selection".into(),
                effective_request: "session.runtime_resolution".into(),
            },
            qualification: ActiveLaneQualification {
                status: "not_asserted".into(),
                reason: "Execution lane is unresolved; scientific qualification is not asserted."
                    .into(),
            },
            operations: stale_active_lane_operations(
                "Execution lane is unresolved; operation support cannot be selected from requested intent.",
                "resolved_lane_identity",
            ),
        };
    }

    let discretization = resolved
        .as_ref()
        .map(|lane| lane.discretization.as_str())
        .expect("resolved lane checked above");
    let operations = active_lane_operations(planner, discretization);
    ActiveLaneCapabilitySnapshot {
        schema_version: "active-lane-capabilities.v2".into(),
        authored,
        requested,
        resolved,
        fallback,
        source: ActiveLaneCapabilitySource {
            kind: "planner".into(),
            capability_profile_version: Some(planner.capability_profile_version.clone()),
            engine_id: Some(planner.engine_id.as_str().to_string()),
            authored_intent: "problem_ir.runtime_selection".into(),
            effective_request: "session.runtime_resolution".into(),
        },
        qualification: ActiveLaneQualification {
            status: "not_asserted".into(),
            reason: "Planner capability availability is separate from workload-scoped scientific qualification evidence.".into(),
        },
        operations,
    }
}

fn stale_active_lane_operations(
    reason: &str,
    requirement: &str,
) -> BTreeMap<String, ActiveLaneOperationCapability> {
    ACTIVE_LANE_OPERATION_IDS
        .into_iter()
        .map(|id| {
            (
                id.to_string(),
                operation(ActiveLaneCapabilityState::Stale, reason, [requirement]),
            )
        })
        .collect()
}

fn active_lane_operations(
    planner: &fullmag_runner::BackendCapabilities,
    discretization: &str,
) -> BTreeMap<String, ActiveLaneOperationCapability> {
    let is_fdm = discretization == "fdm";
    let is_fem = discretization == "fem";
    let has_fields =
        !planner.preview_quantities.is_empty() || !planner.snapshot_quantities.is_empty();
    let has_term = |terms: &[&str]| {
        planner
            .supported_terms
            .iter()
            .any(|term| terms.iter().any(|candidate| term == candidate))
    };
    let has_prefixed_term = |prefixes: &[&str]| {
        planner.supported_terms.iter().any(|term| {
            prefixes
                .iter()
                .any(|prefix| term == prefix || term.starts_with(&format!("{prefix}_")))
        })
    };
    let supported = |reason: &str, requires: &[&str]| {
        operation(
            ActiveLaneCapabilityState::Supported,
            reason,
            requires.iter().copied(),
        )
    };
    let unsupported = |reason: &str, requires: &[&str]| {
        operation(
            ActiveLaneCapabilityState::Unsupported,
            reason,
            requires.iter().copied(),
        )
    };
    let semantic_only = |reason: &str, requires: &[&str]| {
        operation(
            ActiveLaneCapabilityState::SemanticOnly,
            reason,
            requires.iter().copied(),
        )
    };
    let deferred = |reason: &str, requires: &[&str]| {
        operation(
            ActiveLaneCapabilityState::Deferred,
            reason,
            requires.iter().copied(),
        )
    };
    let term_operation = |available: bool, term: &str| {
        if available {
            supported(
                "The resolved planner lane advertises this interaction as executable.",
                &[term],
            )
        } else {
            unsupported(
                "The resolved planner lane does not advertise this interaction.",
                &[term],
            )
        }
    };
    let eigen_engine = planner.engine_id.as_str().contains("eigen");
    let frequency_engine = planner.engine_id.as_str().contains("frequency_response");
    let time_domain_engine = !eigen_engine && !frequency_engine;
    let frozen_spins = planner.feature_capabilities.get("constraint.frozen_spins");
    let frozen_spins_executable = frozen_spins.is_some_and(|feature| {
        matches!(
            feature.status,
            fullmag_ir::FemMixedTopologyCapabilityStatusIR::ReferenceExecutable
                | fullmag_ir::FemMixedTopologyCapabilityStatusIR::DevelopmentExecutable
                | fullmag_ir::FemMixedTopologyCapabilityStatusIR::PartialProductionExecutable
                | fullmag_ir::FemMixedTopologyCapabilityStatusIR::Implemented
                | fullmag_ir::FemMixedTopologyCapabilityStatusIR::ProductionExecutable
                | fullmag_ir::FemMixedTopologyCapabilityStatusIR::Validated
        )
    });
    let frozen_spins_operation = || {
        if frozen_spins_executable {
            supported(
                frozen_spins
                    .map(|feature| feature.reason.as_str())
                    .unwrap_or("Frozen Spins execution is available for the resolved lane."),
                &["planner_feature:constraint.frozen_spins"],
            )
        } else {
            unsupported(
                frozen_spins
                    .map(|feature| feature.reason.as_str())
                    .unwrap_or(
                    "The resolved planner profile does not publish Frozen Spins execution support.",
                ),
                &["planner_feature:constraint.frozen_spins"],
            )
        }
    };

    BTreeMap::from([
        (
            "grid_build".into(),
            if is_fdm {
                deferred(
                    "FDM grid and membership masks are immutable execution-plan artifacts; standalone refresh is deferred until a safe replanning lifecycle exists.",
                    &["discretization:fdm", "safe_replanning_lifecycle"],
                )
            } else {
                unsupported(
                    "Structured-grid refresh is not applicable to the resolved lane.",
                    &["discretization:fdm"],
                )
            },
        ),
        (
            "shared_mesh_build".into(),
            if is_fem {
                supported(
                    "Shared-domain mesh build is owned by the resolved FEM lane.",
                    &["discretization:fem"],
                )
            } else {
                unsupported(
                    "Shared-domain mesh build is not applicable to the resolved lane.",
                    &["discretization:fem"],
                )
            },
        ),
        (
            "field_quantity".into(),
            if has_fields {
                supported(
                    "The planner advertises field quantities for the resolved lane.",
                    &["planner:field_quantities"],
                )
            } else {
                unsupported(
                    "The planner advertises no field quantities for the resolved lane.",
                    &["planner:field_quantities"],
                )
            },
        ),
        (
            "vectors".into(),
            if has_fields {
                supported(
                    "Vector rendering can consume planner-advertised field quantities.",
                    &["field_quantity"],
                )
            } else {
                unsupported(
                    "Vector rendering requires a planner-advertised field quantity.",
                    &["field_quantity"],
                )
            },
        ),
        (
            "surface_coloring".into(),
            if has_fields {
                supported(
                    "Surface coloring can consume planner-advertised field quantities.",
                    &["field_quantity"],
                )
            } else {
                unsupported(
                    "Surface coloring requires a planner-advertised field quantity.",
                    &["field_quantity"],
                )
            },
        ),
        (
            "air_void_overlay".into(),
            semantic_only(
                "Air/void presentation semantics exist, but the planner profile does not publish current domain-resource readiness.",
                &["domain_metadata:compatible"],
            ),
        ),
        (
            "region_membership".into(),
            semantic_only(
                "Region-membership semantics exist, but the planner profile does not publish current membership-resource readiness.",
                &["domain_metadata:compatible", "region_membership_resource:compatible"],
            ),
        ),
        (
            "hover_select_cell".into(),
            if is_fdm {
                supported(
                    "Cell hover and selection are supported for structured FDM domains.",
                    &["discretization:fdm", "region_membership"],
                )
            } else {
                unsupported(
                    "Cell hover and selection are specific to structured FDM domains.",
                    &["discretization:fdm"],
                )
            },
        ),
        (
            "initial_magnetization.uniform".into(),
            if is_fdm || is_fem {
                supported(
                    "Uniform initial magnetization is executable in the resolved FDM/FEM lane.",
                    &["initial_magnetization:uniform", "resolved_lane_identity"],
                )
            } else {
                unsupported(
                    "Uniform initial magnetization requires a resolved FDM or FEM lane.",
                    &["discretization:fdm_or_fem"],
                )
            },
        ),
        (
            "initial_magnetization.vortex".into(),
            if is_fdm || is_fem {
                supported(
                    "Vortex initial magnetization is executable in the resolved FDM/FEM lane.",
                    &["initial_magnetization:vortex", "resolved_lane_identity"],
                )
            } else {
                unsupported(
                    "Vortex initial magnetization requires a resolved FDM or FEM lane.",
                    &["discretization:fdm_or_fem"],
                )
            },
        ),
        (
            "interaction.exchange".into(),
            term_operation(has_term(&["exchange"]), "interaction:exchange"),
        ),
        (
            "interaction.demag".into(),
            term_operation(
                !planner.supported_demag_realizations.is_empty() || has_prefixed_term(&["demag"]),
                "interaction:demag",
            ),
        ),
        (
            "interaction.dmi".into(),
            term_operation(
                has_term(&["interfacial_dmi", "bulk_dmi"]),
                "interaction:dmi",
            ),
        ),
        (
            "interaction.zeeman".into(),
            term_operation(has_term(&["zeeman"]), "interaction:zeeman"),
        ),
        (
            "interaction.current_transport".into(),
            term_operation(
                has_term(&["current_transport", "stt", "sot", "oersted"]),
                "interaction:current_transport",
            ),
        ),
        (
            "interaction.spin_torque".into(),
            term_operation(has_term(&["stt", "sot"]), "interaction:spin_torque"),
        ),
        (
            "interaction.sot".into(),
            term_operation(has_term(&["sot"]), "interaction:sot"),
        ),
        (
            "interaction.stt".into(),
            term_operation(has_term(&["stt"]), "interaction:stt"),
        ),
        (
            "interaction.interfacial_dmi".into(),
            term_operation(
                has_term(&["interfacial_dmi"]),
                "interaction:interfacial_dmi",
            ),
        ),
        (
            "interaction.bulk_dmi".into(),
            term_operation(has_term(&["bulk_dmi"]), "interaction:bulk_dmi"),
        ),
        (
            "interaction.uniaxial_anisotropy".into(),
            term_operation(
                has_term(&["uniaxial_anisotropy"]),
                "interaction:uniaxial_anisotropy",
            ),
        ),
        (
            "interaction.cubic_anisotropy".into(),
            term_operation(
                has_term(&["cubic_anisotropy"]),
                "interaction:cubic_anisotropy",
            ),
        ),
        (
            "interaction.oersted".into(),
            term_operation(has_term(&["oersted"]), "interaction:oersted"),
        ),
        (
            "interaction.oersted_field".into(),
            term_operation(has_term(&["oersted"]), "interaction:oersted_field"),
        ),
        (
            "interaction.magnetoelastic".into(),
            term_operation(has_term(&["magnetoelastic"]), "interaction:magnetoelastic"),
        ),
        (
            "interaction.thermal".into(),
            term_operation(has_term(&["thermal"]), "interaction:thermal"),
        ),
        (
            "interaction.frozen_spins".into(),
            frozen_spins_operation(),
        ),
        (
            "constraint.frozen_spins".into(),
            frozen_spins_operation(),
        ),
        (
            "study.relaxation".into(),
            if time_domain_engine {
                supported(
                    "The resolved planner capability profile is a time-domain lane.",
                    &["planner:time_domain_lane"],
                )
            } else {
                unsupported(
                    "The resolved planner capability profile is not a time-domain lane.",
                    &["planner:time_domain_lane"],
                )
            },
        ),
        (
            "study.time_integration".into(),
            if time_domain_engine {
                supported(
                    "The resolved planner capability profile is a time-domain lane.",
                    &["planner:time_domain_lane"],
                )
            } else {
                unsupported(
                    "The resolved planner capability profile is not a time-domain lane.",
                    &["planner:time_domain_lane"],
                )
            },
        ),
        (
            "study.eigenmodes".into(),
            if eigen_engine || planner.supports_coupled_eigenmodes {
                supported(
                    "The resolved planner lane advertises eigenmode execution.",
                    &["planner:eigenmodes"],
                )
            } else {
                semantic_only("Eigenmode authoring exists, but the resolved planner lane does not advertise executable support.", &["planner:eigenmodes"])
            },
        ),
        (
            "study.frequency_response".into(),
            if frequency_engine || planner.supports_frequency_response {
                supported(
                    "The resolved planner lane advertises frequency-response execution.",
                    &["planner:frequency_response"],
                )
            } else {
                semantic_only("Frequency-response authoring exists, but the resolved planner lane does not advertise executable support.", &["planner:frequency_response"])
            },
        ),
        (
            "study.fft".into(),
            if has_fields {
                supported(
                    "FFT post-processing can consume planner-advertised field quantities.",
                    &["field_quantity"],
                )
            } else {
                unsupported(
                    "FFT post-processing requires planner-advertised field quantities.",
                    &["field_quantity"],
                )
            },
        ),
    ])
}

fn operation(
    state: ActiveLaneCapabilityState,
    reason: &str,
    requires: impl IntoIterator<Item = impl Into<String>>,
) -> ActiveLaneOperationCapability {
    use crate::schemas::status::ActiveLaneCapabilityReasonCode;

    let reason_code = match state {
        ActiveLaneCapabilityState::Supported => ActiveLaneCapabilityReasonCode::CapabilitySupported,
        ActiveLaneCapabilityState::SemanticOnly => {
            ActiveLaneCapabilityReasonCode::CapabilitySemanticOnly
        }
        ActiveLaneCapabilityState::Deferred => ActiveLaneCapabilityReasonCode::CapabilityDeferred,
        ActiveLaneCapabilityState::Unsupported => {
            ActiveLaneCapabilityReasonCode::CapabilityUnsupported
        }
        ActiveLaneCapabilityState::Stale => ActiveLaneCapabilityReasonCode::CapabilityStale,
    };
    ActiveLaneOperationCapability {
        state,
        reason_code,
        reason: reason.into(),
        requires: requires.into_iter().map(Into::into).collect(),
    }
}

fn normalize_lane_discretization(value: &str, fallback: &str) -> String {
    let normalized = value.to_ascii_lowercase();
    if normalized == "auto" {
        "auto".into()
    } else if normalized.contains("hybrid") {
        "hybrid".into()
    } else if normalized.contains("fem") {
        "fem".into()
    } else if normalized.contains("fdm") {
        "fdm".into()
    } else {
        fallback.into()
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
    if snapshot.fem_mesh.is_some() && !is_fdm_snapshot(snapshot) {
        snapshot.mesh_revision
    } else {
        domain_generation_id
    }
}

pub(crate) fn domain_generation_id(snapshot: &SessionStateResponse) -> String {
    if !is_fdm_snapshot(snapshot) {
        if let Some(generation_id) = snapshot
            .fem_mesh
            .as_ref()
            .and_then(|m| m.generation_id.as_deref())
        {
            return generation_id.to_string();
        }
    }

    fdm_grid_fingerprint(snapshot)
        .map(str::to_string)
        .unwrap_or_else(|| fdm_domain_generation_id(snapshot).to_string())
}

pub(crate) fn domain_generation_revision(snapshot: &SessionStateResponse) -> u64 {
    if !is_fdm_snapshot(snapshot) {
        if let Some(generation_id) = snapshot
            .fem_mesh
            .as_ref()
            .and_then(|mesh| mesh.generation_id.as_deref())
        {
            return fnv1a_hash_bytes(1469598103934665603_u64, generation_id.as_bytes()).max(1);
        }
    }
    fdm_domain_generation_id(snapshot)
}

pub(crate) fn fdm_grid_fingerprint(snapshot: &SessionStateResponse) -> Option<&str> {
    snapshot
        .metadata
        .as_ref()
        .and_then(|metadata| metadata.get("execution_plan"))
        .and_then(|plan| plan.get("backend_plan"))
        .and_then(|backend_plan| backend_plan.get("grid_certificate"))
        .and_then(|certificate| certificate.get("grid_fingerprint"))
        .and_then(Value::as_str)
}

pub(crate) fn fdm_grid_shape(
    snapshot: &SessionStateResponse,
    latest_grid_shape: Option<[u32; 3]>,
) -> [u32; 3] {
    if let Some(shape) = latest_grid_shape.filter(|shape| shape.iter().all(|value| *value > 0)) {
        return shape;
    }

    snapshot
        .metadata
        .as_ref()
        .and_then(|metadata| {
            metadata
                .get("artifact_layout")
                .filter(|layout| {
                    layout
                        .get("backend")
                        .and_then(Value::as_str)
                        .is_some_and(is_fdm_backend_kind)
                })
                .and_then(|layout| {
                    layout
                        .get("grid_cells")
                        .or_else(|| layout.get("grid_shape"))
                        .or_else(|| layout.get("shape"))
                        .or_else(|| layout.get("common_cells"))
                })
                .or_else(|| {
                    metadata
                        .get("execution_plan")
                        .and_then(|plan| plan.get("backend_plan"))
                        .and_then(|backend_plan| backend_plan.get("grid"))
                        .and_then(|grid| grid.get("cells"))
                        .or_else(|| {
                            metadata
                                .get("execution_plan")
                                .and_then(|plan| plan.get("backend_plan"))
                                .and_then(|backend_plan| backend_plan.get("common_cells"))
                        })
                })
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

    if let Some((origin, spacing)) = fdm_grid_geometry(snapshot) {
        revision = fnv1a_hash_bytes(revision, b"layout");
        revision = fnv1a_hash_f64_array(revision, origin);
        revision = fnv1a_hash_f64_array(revision, spacing);
    }

    revision.max(1)
}

fn fdm_artifact_layout(snapshot: &SessionStateResponse) -> Option<&Value> {
    snapshot
        .metadata
        .as_ref()
        .and_then(|metadata| metadata.get("artifact_layout"))
        .filter(|layout| {
            layout
                .get("backend")
                .and_then(Value::as_str)
                .is_some_and(is_fdm_backend_kind)
        })
}

/// Resolve the physical geometry of an FDM domain from the published artifact
/// layout or, for multilayer plans, from the planner-owned grid certificate.
/// The latter is intentionally the fallback because `field_layout` stores
/// multilayer native layers rather than duplicating common-grid coordinates at
/// the top level.
pub(crate) fn fdm_grid_geometry(snapshot: &SessionStateResponse) -> Option<([f64; 3], [f64; 3])> {
    let metadata = snapshot.metadata.as_ref()?;
    if let Some(layout) = fdm_artifact_layout(snapshot) {
        if let Some(geometry) = fdm_geometry_from_value(layout) {
            return Some(geometry);
        }
    }

    let backend_plan = metadata
        .get("execution_plan")
        .and_then(|plan| plan.get("backend_plan"))?;
    fdm_geometry_from_value(backend_plan).or_else(|| {
        backend_plan
            .get("grid_certificate")
            .and_then(fdm_geometry_from_value)
    })
}

fn fdm_geometry_from_value(value: &Value) -> Option<([f64; 3], [f64; 3])> {
    let origin_value = value
        .get("origin_m")
        .or_else(|| value.get("origin"))
        .or_else(|| value.get("grid_origin"))
        .or_else(|| value.get("native_origin"));
    let origin = match origin_value {
        Some(origin) => value_array3_f64_any_finite(origin)?,
        None => [0.0, 0.0, 0.0],
    };
    let spacing = value
        .get("cell_size")
        .or_else(|| value.get("cell_m"))
        .and_then(value_array3_f64_allow_planar)?;
    Some((origin, spacing))
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
fn compat_end_to_end_steps_per_second(
    profile: &crate::schemas::diagnostics::SolverProfileResource,
) -> Option<f64> {
    profile
        .rates
        .end_to_end_steps_per_second
        .as_ref()
        .map(|metric| metric.value)
}

#[cfg(test)]
mod tests {
    use super::{
        compat_end_to_end_steps_per_second, connectivity_from_liveness_at, lifecycle_contract,
        relaxation_algorithms_available, session_epoch, solver_completion_record,
        CONNECTIVITY_DEGRADED_AFTER_MS, CONNECTIVITY_DISCONNECTED_AFTER_MS,
    };
    use crate::schemas::status::{
        SessionCommandability, SessionConnectivity, SessionResourceLifecycle,
    };

    #[test]
    fn awaiting_command_is_an_active_commandable_session_resource() {
        let lifecycle =
            lifecycle_contract("awaiting_command", true, SessionConnectivity::Connected);
        assert_eq!(lifecycle.solver, "awaiting_command");
        assert_eq!(lifecycle.session_resource, SessionResourceLifecycle::Active);
        assert_eq!(lifecycle.connectivity, SessionConnectivity::Connected);
        assert_eq!(lifecycle.commandability, SessionCommandability::Allowed);
    }

    #[test]
    fn completed_session_is_a_read_only_tombstone_with_a_new_epoch() {
        let lifecycle = lifecycle_contract("completed", false, SessionConnectivity::Connected);
        assert_eq!(
            lifecycle.session_resource,
            SessionResourceLifecycle::Tombstoned
        );
        assert_eq!(lifecycle.commandability, SessionCommandability::ReadOnly);
        assert_eq!(session_epoch("session-1", 1000, 0, false), "session-1@1000");
        assert_eq!(
            session_epoch("session-1", 1000, 2000, true),
            "session-1@1000:tombstone:2000"
        );
    }

    #[test]
    fn degraded_transport_preserves_solver_lifecycle_but_forbids_commands() {
        let lifecycle = lifecycle_contract("running", true, SessionConnectivity::Degraded);
        assert_eq!(lifecycle.solver, "running");
        assert_eq!(lifecycle.session_resource, SessionResourceLifecycle::Active);
        assert_eq!(lifecycle.connectivity, SessionConnectivity::Degraded);
        assert_eq!(lifecycle.commandability, SessionCommandability::Forbidden);
    }

    #[test]
    fn periodic_idle_ticks_keep_long_awaiting_session_connected_until_ticks_stop() {
        let mut last_seen = 1_000_u64;
        let mut connectivity = SessionConnectivity::Connected;
        for now in (11_000_u64..=61_000_u64).step_by(10_000) {
            last_seen = now;
            connectivity = connectivity_from_liveness_at(connectivity, last_seen, now);
            assert_eq!(connectivity, SessionConnectivity::Connected);
            assert_eq!(
                lifecycle_contract("awaiting_command", true, connectivity).commandability,
                SessionCommandability::Allowed
            );
        }

        connectivity = connectivity_from_liveness_at(
            connectivity,
            last_seen,
            last_seen + CONNECTIVITY_DEGRADED_AFTER_MS,
        );
        assert_eq!(connectivity, SessionConnectivity::Degraded);
        connectivity = connectivity_from_liveness_at(
            connectivity,
            last_seen,
            last_seen + CONNECTIVITY_DISCONNECTED_AFTER_MS,
        );
        assert_eq!(connectivity, SessionConnectivity::Disconnected);
    }

    #[test]
    fn status_uses_last_solver_completion_before_terminal_save_stage() {
        let execution: crate::types::StageExecutionState =
            serde_json::from_value(serde_json::json!({
                "total_stages": 2,
                "completed_stage_indexes": [0, 1],
                "stage_statuses": ["completed", "completed"],
                "active_stage_index": null,
                "active_stage_kind": "flat_save_state",
                "runtime_state": "completed",
                "stages": [
                    {"status": "completed", "converged": true, "reason": "torque"},
                    {"status": "completed"}
                ]
            }))
            .expect("two completed scripted stages should deserialize");

        let completion = solver_completion_record(&execution).expect("solver completion");
        assert!(completion.converged);
        assert_eq!(completion.reason, Some(fullmag_ir::StageStopReason::Torque));
    }

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

    #[test]
    fn compatibility_rate_alias_is_only_the_closed_end_to_end_rate() {
        let mut profile = crate::schemas::diagnostics::SolverProfileResource::default();
        profile.rates.end_to_end_steps_per_second =
            Some(crate::schemas::diagnostics::RateMetricResource {
                value: 2.0,
                window_step_count: 10,
                window_wall_time_ns: 5_000_000_000,
                source_revision: 7,
            });
        assert_eq!(compat_end_to_end_steps_per_second(&profile), Some(2.0));
        profile.rates.end_to_end_steps_per_second = None;
        assert_eq!(compat_end_to_end_steps_per_second(&profile), None);
    }
}
