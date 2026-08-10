//! Read-only normalized physics graph resource.

use std::sync::Arc;

use axum::{extract::State, Json};

use crate::{error::ApiError, schemas::authoring::PhysicsGraphResource, types::AppState};

/// Return the semantic physics-module graph for the current authoring scene.
///
/// This endpoint is intentionally thin: mesh topology, field samples and the
/// constitutive family records stay on their dedicated resources.  The graph
/// is normalized once by `fullmag-authoring` so the planner and Control Room
/// consume the same stable module identity, scope and dependency semantics.
#[utoipa::path(
    get,
    path = "/v2/sessions/current/model/physics-graph",
    responses(
        (status = 200, description = "Normalized authored physics graph", body = PhysicsGraphResource),
        (status = 404, description = "No active workspace or scene document"),
        (status = 409, description = "The authored scene cannot be normalized into a graph")
    ),
    tag = "model"
)]
pub async fn get_physics_graph(
    State(state): State<Arc<AppState>>,
) -> Result<Json<PhysicsGraphResource>, ApiError> {
    let scene = crate::get_or_load_current_live_scene_document(&state).await?;
    let graph = fullmag_authoring::normalize_physics_graph(&scene).map_err(|error| {
        ApiError::conflict(format!("physics_graph_normalization_failed: {error}"))
    })?;
    Ok(Json(PhysicsGraphResource::from_graph(graph)))
}
