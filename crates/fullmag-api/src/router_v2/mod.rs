//! Professional session-scoped v2 router.
//!
//! The initial v2 implementation delegates to the mature v1 read-models while
//! exposing the API as platform/session/model/meshing/simulation/data families.

pub mod handlers;
pub mod middleware;

#[cfg(test)]
mod tests;

use axum::{
    extract::{Path, Query, State},
    http::StatusCode,
    routing::{get, patch, post},
    Json, Router,
};
use serde::Deserialize;
use serde_json::{json, Value};
use std::sync::Arc;

use crate::error::ApiError;
use crate::types::{AppState, EigenModeQuery};

pub fn build_v2_router() -> Router<Arc<AppState>> {
    Router::new()
        .route("/v2/platform/health", get(handlers::platform::get_health))
        .route("/v2", get(get_v2_index))
        .route("/v2/", get(get_v2_index))
        .route(
            "/v2/platform/capabilities",
            get(handlers::platform::get_capabilities),
        )
        .route(
            "/v2/platform/asyncapi.json",
            get(handlers::platform::get_asyncapi_document),
        )
        .route(
            "/v2/platform/docs/asyncapi",
            get(handlers::platform::get_asyncapi_docs),
        )
        .route("/v2/sessions", get(list_sessions).post(create_session))
        .route(
            "/v2/sessions/current",
            get(get_current_session).patch(patch_current_session),
        )
        .route(
            "/v2/sessions/current/status",
            get(handlers::sessions::get_status),
        )
        .route(
            "/v2/sessions/current/events/ws",
            get(handlers::platform::ws_current_live),
        )
        .route(
            "/v2/sessions/current/model/scene",
            get(handlers::model::get_authoring_scene)
                .put(handlers::model::replace_authoring_scene)
                .patch(handlers::model::patch_authoring_scene),
        )
        .route(
            "/v2/sessions/current/model/geometry/capabilities",
            get(handlers::model::get_authoring_geometry_capabilities),
        )
        .route(
            "/v2/sessions/current/model/geometry/validation",
            get(handlers::model::get_authoring_geometry_validation),
        )
        .route(
            "/v2/sessions/current/model/geometry/realizations",
            post(handlers::model::create_authoring_geometry_realization),
        )
        .route(
            "/v2/sessions/current/model/geometry/realizations/current",
            get(handlers::model::get_current_authoring_geometry_realization),
        )
        .route(
            "/v2/sessions/current/model/geometry/diagnostics",
            get(handlers::model::get_authoring_geometry_diagnostics),
        )
        .route(
            "/v2/sessions/current/model/geometry/diagnostics/:diagnostic_id",
            get(handlers::model::get_authoring_geometry_diagnostic),
        )
        .route(
            "/v2/sessions/current/model/materials/:material_id",
            get(handlers::model::get_authoring_material)
                .patch(handlers::model::patch_authoring_material),
        )
        .route(
            "/v2/sessions/current/model/magnetization-assets/:asset_id",
            get(handlers::model::get_authoring_magnetization_asset)
                .patch(handlers::model::patch_authoring_magnetization_asset),
        )
        .route(
            "/v2/sessions/current/model/objects",
            post(handlers::model::create_authoring_object),
        )
        .route(
            "/v2/sessions/current/model/objects/:object_id",
            patch(handlers::model::patch_authoring_object)
                .delete(handlers::model::delete_authoring_object),
        )
        .route(
            "/v2/sessions/current/model/objects/:object_id/geometry",
            patch(handlers::model::patch_authoring_object_geometry),
        )
        .route(
            "/v2/sessions/current/model/objects/:object_id/interactions/:interaction_kind",
            get(handlers::model::get_authoring_object_interaction)
                .patch(handlers::model::patch_authoring_object_interaction),
        )
        .route(
            "/v2/sessions/current/model/study",
            get(handlers::model::get_authoring_study_runtime)
                .patch(handlers::model::patch_authoring_study_runtime),
        )
        .route(
            "/v2/sessions/current/model/universe",
            get(handlers::model::get_authoring_universe)
                .patch(handlers::model::patch_authoring_universe),
        )
        .route(
            "/v2/sessions/current/model/universe/fit",
            post(handlers::model::fit_authoring_universe),
        )
        .route(
            "/v2/sessions/current/model/script",
            get(handlers::model::get_authoring_script_source)
                .put(handlers::model::sync_authoring_script),
        )
        .route(
            "/v2/sessions/current/model/syncs",
            post(handlers::model::sync_authoring_script),
        )
        .route(
            "/v2/sessions/current/model/transactions",
            post(handlers::model::commit_authoring_transaction),
        )
        .route(
            "/v2/sessions/current/model/regions",
            get(handlers::model::get_authoring_regions),
        )
        .route(
            "/v2/sessions/current/model/regions/:region_id",
            patch(handlers::model::patch_authoring_region),
        )
        .route(
            "/v2/sessions/current/meshing/capabilities",
            get(handlers::meshing::get_mesh_capabilities),
        )
        .route(
            "/v2/sessions/current/meshing/semantics",
            get(handlers::meshing::get_mesh_semantics),
        )
        .route(
            "/v2/sessions/current/meshing/summary",
            get(handlers::meshing::get_mesh_summary),
        )
        .route(
            "/v2/sessions/current/meshing/policies/universe",
            get(handlers::meshing::get_mesh_universe_config)
                .put(handlers::meshing::replace_mesh_universe_config),
        )
        .route(
            "/v2/sessions/current/meshing/meshes/universe/quality",
            get(handlers::meshing::get_mesh_universe_quality),
        )
        .route(
            "/v2/sessions/current/meshing/meshes/universe/report",
            get(handlers::meshing::get_mesh_universe_report),
        )
        .route(
            "/v2/sessions/current/meshing/policies/shared-domain",
            get(handlers::meshing::get_mesh_shared_domain_config)
                .put(handlers::meshing::replace_mesh_shared_domain_config),
        )
        .route(
            "/v2/sessions/current/meshing/policies/objects/:object_id",
            get(handlers::meshing::get_mesh_object_config)
                .put(handlers::meshing::replace_mesh_object_config),
        )
        .route(
            "/v2/sessions/current/meshing/policies/interfaces/:interface_id",
            get(handlers::meshing::get_mesh_interface_config)
                .put(handlers::meshing::replace_mesh_interface_config),
        )
        .route(
            "/v2/sessions/current/meshing/builds",
            get(handlers::meshing::get_mesh_build_history),
        )
        .route(
            "/v2/sessions/current/meshing/builds/current",
            get(handlers::meshing::get_mesh_active_build),
        )
        .route(
            "/v2/sessions/current/meshing/builds/latest-successful",
            get(handlers::meshing::get_mesh_last_successful_build),
        )
        .route(
            "/v2/sessions/current/meshing/meshes/shared-domain/manifest",
            get(handlers::meshing::get_mesh_shared_domain_manifest),
        )
        .route(
            "/v2/sessions/current/meshing/meshes/shared-domain/topology",
            get(handlers::meshing::get_mesh_shared_domain_topology),
        )
        .route(
            "/v2/sessions/current/meshing/meshes/shared-domain/quality",
            get(handlers::meshing::get_mesh_shared_domain_quality),
        )
        .route(
            "/v2/sessions/current/meshing/meshes/shared-domain/realized-size-fields",
            get(handlers::meshing::get_mesh_realized_size_fields),
        )
        .route(
            "/v2/sessions/current/meshing/meshes/shared-domain/quality-gates",
            get(handlers::meshing::get_mesh_quality_gates),
        )
        .route(
            "/v2/sessions/current/meshing/meshes/shared-domain/report",
            get(handlers::meshing::get_mesh_shared_domain_report),
        )
        .route(
            "/v2/sessions/current/meshing/mesh/periodic_pairs.v1",
            get(handlers::meshing::get_mesh_periodic_pairs),
        )
        .route(
            "/v2/sessions/current/meshing/meshes/objects/:object_id/topology",
            get(handlers::meshing::get_mesh_object_topology),
        )
        .route(
            "/v2/sessions/current/meshing/meshes/parts/:part_id/topology",
            get(handlers::meshing::get_mesh_part_topology),
        )
        .route(
            "/v2/sessions/current/meshing/meshes/objects/:object_id/size-field",
            get(handlers::meshing::get_mesh_object_size_field),
        )
        .route(
            "/v2/sessions/current/meshing/meshes/objects/:object_id/quality",
            get(handlers::meshing::get_mesh_object_quality),
        )
        .route(
            "/v2/sessions/current/meshing/meshes/objects/:object_id/report",
            get(handlers::meshing::get_mesh_object_report),
        )
        .route(
            "/v2/sessions/current/meshing/meshes/interfaces/:interface_id/quality",
            get(handlers::meshing::get_mesh_interface_quality),
        )
        .route(
            "/v2/sessions/current/meshing/meshes/interfaces/:interface_id/report",
            get(handlers::meshing::get_mesh_interface_report),
        )
        .route(
            "/v2/sessions/current/simulation/commands",
            get(handlers::simulation::get_command_status)
                .post(handlers::simulation::submit_command),
        )
        .route(
            "/v2/sessions/current/simulation/commands/:command_id",
            get(handlers::simulation::get_command_detail),
        )
        .route(
            "/v2/sessions/current/simulation/runs/current",
            get(handlers::simulation::get_current_run),
        )
        .route(
            "/v2/sessions/current/simulation/runs/:run_id",
            get(handlers::simulation::get_run_by_id),
        )
        .route(
            "/v2/sessions/current/simulation/stages/execution",
            get(handlers::simulation::get_stage_execution),
        )
        .route(
            "/v2/sessions/current/simulation/solver/status",
            get(handlers::simulation::get_solver_status),
        )
        .route(
            "/v2/sessions/current/simulation/solver/energies/current",
            get(handlers::simulation::get_solver_energies_current),
        )
        .route(
            "/v2/sessions/current/simulation/solver/energies/history",
            get(handlers::simulation::get_solver_energies_history),
        )
        .route(
            "/v2/sessions/current/simulation/objects/:object_id/metrics",
            get(handlers::simulation::get_object_metrics),
        )
        .route(
            "/v2/sessions/current/data/quantities",
            get(handlers::data::get_quantities_catalog),
        )
        .route(
            "/v2/sessions/current/data/fields",
            get(handlers::data::get_field_catalog),
        )
        .route(
            "/v2/sessions/current/data/domain/meta",
            get(handlers::data::get_domain_meta),
        )
        .route(
            "/v2/sessions/current/data/domain/topology",
            get(handlers::data::get_domain_topology),
        )
        .route(
            "/v2/sessions/current/data/domain/slice/mesh-overlay",
            get(handlers::data::get_domain_slice_mesh_overlay),
        )
        .route(
            "/v2/sessions/current/data/fields/:quantity_id/meta",
            get(handlers::data::get_field_meta),
        )
        .route(
            "/v2/sessions/current/data/fields/:quantity_id/samples/vector",
            get(handlers::data::get_field_vector),
        )
        .route(
            "/v2/sessions/current/data/fields/:quantity_id/projection/meta",
            get(handlers::data::get_field_projection_meta),
        )
        .route(
            "/v2/sessions/current/data/fields/:quantity_id/projection/scalar",
            get(handlers::data::get_field_projection_scalar),
        )
        .route(
            "/v2/sessions/current/data/fields/:quantity_id/projection/matrix.json",
            get(handlers::data::get_field_projection_matrix_json),
        )
        .route(
            "/v2/sessions/current/data/fields/:quantity_id/projection/render.png",
            get(handlers::data::get_field_projection_render_png),
        )
        .route(
            "/v2/sessions/current/data/fields/:quantity_id/projection/empty-mask",
            get(handlers::data::get_field_projection_empty_mask),
        )
        .route(
            "/v2/sessions/current/data/fields/:quantity_id/projection/profile",
            get(handlers::data::get_field_projection_profile),
        )
        .route(
            "/v2/sessions/current/data/fields/:quantity_id/samples/slice/meta",
            get(handlers::data::get_field_slice_meta),
        )
        .route(
            "/v2/sessions/current/data/fields/:quantity_id/samples/slice/scalar",
            get(handlers::data::get_field_slice_scalar),
        )
        .route(
            "/v2/sessions/current/data/fields/:quantity_id/samples/slice/matrix.json",
            get(handlers::data::get_field_slice_matrix_json),
        )
        .route(
            "/v2/sessions/current/data/fields/:quantity_id/samples/slice/render.png",
            get(handlers::data::get_field_slice_render_png),
        )
        .route(
            "/v2/sessions/current/data/fields/:quantity_id/samples/slice/arrows",
            get(handlers::data::get_field_slice_arrows),
        )
        .route(
            "/v2/sessions/current/data/scalars",
            get(handlers::data::get_scalars),
        )
        .route(
            "/v2/sessions/current/data/artifacts",
            get(handlers::data::list_artifacts),
        )
        .route(
            "/v2/sessions/current/data/artifacts/:artifact_id",
            get(handlers::data::get_artifact),
        )
        .route(
            "/v2/sessions/current/visualization/display",
            get(handlers::visualization::get_display)
                .put(handlers::visualization::replace_display)
                .patch(handlers::visualization::patch_display),
        )
        .route(
            "/v2/sessions/current/visualization/state",
            get(handlers::visualization::get_visualization_state)
                .put(handlers::visualization::replace_visualization_state)
                .patch(handlers::visualization::patch_visualization_state),
        )
        .route(
            "/v2/sessions/current/workspace/layout",
            get(handlers::workspace::get_workspace_layout)
                .put(handlers::workspace::replace_workspace_layout),
        )
        .route(
            "/v2/sessions/current/workspace/ribbon",
            get(handlers::workspace::get_workspace_ribbon)
                .put(handlers::workspace::replace_workspace_ribbon),
        )
        .route(
            "/v2/sessions/current/workspace/selection",
            get(handlers::workspace::get_workspace_selection)
                .put(handlers::workspace::replace_workspace_selection),
        )
        .route(
            "/v2/sessions/current/workspace/tree/active-node",
            get(handlers::workspace::get_workspace_active_node)
                .put(handlers::workspace::replace_workspace_active_node),
        )
        .route(
            "/v2/sessions/current/analysis/eigenmodes/spectrum",
            get(handlers::analysis::get_spectrum),
        )
        .route(
            "/v2/sessions/current/analysis/eigen/spectrum.v2",
            get(handlers::analysis::get_spectrum_v2),
        )
        .route(
            "/v2/sessions/current/analysis/eigenmodes/modes/:mode_id",
            get(get_eigenmode_by_id),
        )
        .route(
            "/v2/sessions/current/analysis/eigen/modes/:sample_index/:mode_index",
            get(handlers::analysis::get_mode_v2),
        )
        .route(
            "/v2/sessions/current/analysis/eigenmodes/dispersion",
            get(handlers::analysis::get_dispersion),
        )
        .route(
            "/v2/sessions/current/analysis/eigen/dispersion.csv",
            get(handlers::analysis::get_dispersion_csv),
        )
        .route(
            "/v2/sessions/current/analysis/eigenmodes/branches",
            get(handlers::analysis::get_branches),
        )
        .route(
            "/v2/sessions/current/analysis/eigen/branches.v2",
            get(handlers::analysis::get_branches_v2),
        )
        .route(
            "/v2/sessions/current/persistence/checkpoints",
            get(handlers::persistence::list_checkpoints),
        )
        .route(
            "/v2/sessions/current/persistence/exports",
            post(handlers::persistence::export_session),
        )
        .route(
            "/v2/sessions/current/persistence/imports/inspections",
            post(handlers::persistence::inspect_session),
        )
        .route(
            "/v2/sessions/current/persistence/imports",
            post(handlers::persistence::commit_session),
        )
        .route(
            "/v2/sessions/current/persistence/assets/import",
            post(handlers::persistence::import_asset),
        )
        .route(
            "/v2/sessions/current/persistence/recovery",
            get(handlers::persistence::list_recovery).delete(handlers::persistence::clear_recovery),
        )
        .route(
            "/v2/sessions/current/diagnostics/gpu",
            get(handlers::diagnostics::get_gpu_telemetry),
        )
        .route(
            "/v2/sessions/current/diagnostics/engine-log",
            get(handlers::diagnostics::get_engine_log),
        )
        .layer(axum::middleware::from_fn(
            middleware::request_id::request_id_middleware,
        ))
        .layer(axum::middleware::from_fn(
            middleware::version::contract_version_middleware,
        ))
}

async fn get_v2_index() -> Json<Value> {
    Json(json!({
        "api": "Fullmag API v2",
        "version": "2.0.0",
        "openapi": "/v2/platform/openapi.json",
        "swagger": "/v2/platform/docs/swagger/",
        "current_session": "/v2/sessions/current",
        "families": [
            "platform",
            "sessions",
            "model",
            "meshing",
            "simulation",
            "data",
            "visualization",
            "workspace",
            "analysis",
            "persistence",
            "diagnostics"
        ]
    }))
}

async fn list_sessions(State(state): State<Arc<AppState>>) -> Json<Value> {
    let guard = state.current_live_state.read().await;
    let sessions = guard
        .as_ref()
        .map(|snapshot| {
            vec![json!({
                "session_id": snapshot.session.session_id,
                "name": snapshot.session.problem_name,
                "status": snapshot.session.status,
                "current": true,
            })]
        })
        .unwrap_or_default();
    Json(json!({
        "schema_version": "2.0.0",
        "sessions": sessions,
    }))
}

async fn create_session() -> Result<Json<Value>, ApiError> {
    Err(ApiError {
        status: StatusCode::BAD_REQUEST,
        message: "the local runtime currently exposes only /v2/sessions/current".to_string(),
    })
}

async fn get_current_session(State(state): State<Arc<AppState>>) -> Result<Json<Value>, ApiError> {
    let guard = state.current_live_state.read().await;
    let snapshot = guard
        .as_ref()
        .ok_or_else(|| ApiError::not_found("no active local live workspace"))?;
    Ok(Json(json!({
        "schema_version": "2.0.0",
        "session_id": snapshot.session.session_id,
        "name": snapshot.session.problem_name,
        "status": snapshot.session.status,
        "script_path": snapshot.session.script_path,
        "current": true,
    })))
}

async fn patch_current_session() -> Result<Json<Value>, ApiError> {
    Err(ApiError {
        status: StatusCode::BAD_REQUEST,
        message: "session metadata mutation is not yet supported by the local runtime".to_string(),
    })
}

#[derive(Debug, Deserialize)]
struct EigenmodeByIdQuery {
    sample_index: Option<u32>,
}

async fn get_eigenmode_by_id(
    State(state): State<Arc<AppState>>,
    Path(mode_id): Path<String>,
    Query(query): Query<EigenmodeByIdQuery>,
) -> Result<Json<Value>, ApiError> {
    let index = mode_id
        .parse::<u32>()
        .map_err(|_| ApiError::bad_request(format!("invalid eigenmode id: {mode_id}")))?;
    handlers::analysis::get_mode(
        State(state),
        Query(EigenModeQuery {
            index,
            sample_index: query.sample_index,
        }),
    )
    .await
}
