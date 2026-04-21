use std::sync::Arc;

use axum::extract::State;
use axum::Json;

use crate::error::ApiError;
use crate::schemas::workspace::{
    WorkspaceActiveNodeReplaceRequest, WorkspaceActiveNodeResource, WorkspaceLayoutReplaceRequest,
    WorkspaceLayoutResource, WorkspaceRibbonReplaceRequest, WorkspaceRibbonResource,
    WorkspaceSelectionReplaceRequest, WorkspaceSelectionResource,
};
use crate::types::AppState;

#[utoipa::path(
    get,
    path = "/v1/live/current/workspace/selection",
    responses(
        (status = 200, description = "Current workspace selection resource", body = WorkspaceSelectionResource),
        (status = 404, description = "No active workspace"),
    ),
    tag = "workspace"
)]
pub async fn get_workspace_selection(
    State(state): State<Arc<AppState>>,
) -> Result<Json<WorkspaceSelectionResource>, ApiError> {
    ensure_active_live_workspace(&state).await?;
    Ok(Json(state.current_workspace_selection.read().await.clone()))
}

#[utoipa::path(
    put,
    path = "/v1/live/current/workspace/selection",
    request_body = WorkspaceSelectionReplaceRequest,
    responses(
        (status = 200, description = "Workspace selection replaced", body = WorkspaceSelectionResource),
        (status = 404, description = "No active workspace"),
    ),
    tag = "workspace"
)]
pub async fn replace_workspace_selection(
    State(state): State<Arc<AppState>>,
    Json(replacement): Json<WorkspaceSelectionReplaceRequest>,
) -> Result<Json<WorkspaceSelectionResource>, ApiError> {
    ensure_active_live_workspace(&state).await?;
    let mut selection = state.current_workspace_selection.write().await;
    let changed = selection.selected_node_id != replacement.selected_node_id
        || selection.selected_object_id != replacement.selected_object_id
        || selection.selected_entity_id != replacement.selected_entity_id;
    if changed {
        selection.selected_node_id = replacement.selected_node_id;
        selection.selected_object_id = replacement.selected_object_id;
        selection.selected_entity_id = replacement.selected_entity_id;
        selection.revision = selection.revision.wrapping_add(1);
    }
    let response = selection.clone();
    let workspace_revision = response.revision;
    drop(selection);
    if changed {
        emit_workspace_realtime_change(&state, workspace_revision).await?;
    }
    Ok(Json(response))
}

#[utoipa::path(
    get,
    path = "/v1/live/current/workspace/tree/active-node",
    responses(
        (status = 200, description = "Current active workspace tree node", body = WorkspaceActiveNodeResource),
        (status = 404, description = "No active workspace"),
    ),
    tag = "workspace"
)]
pub async fn get_workspace_active_node(
    State(state): State<Arc<AppState>>,
) -> Result<Json<WorkspaceActiveNodeResource>, ApiError> {
    ensure_active_live_workspace(&state).await?;
    let selection = state.current_workspace_selection.read().await;
    Ok(Json(WorkspaceActiveNodeResource {
        revision: selection.revision,
        node_id: selection.selected_node_id.clone(),
    }))
}

#[utoipa::path(
    put,
    path = "/v1/live/current/workspace/tree/active-node",
    request_body = WorkspaceActiveNodeReplaceRequest,
    responses(
        (status = 200, description = "Current active workspace tree node replaced", body = WorkspaceActiveNodeResource),
        (status = 404, description = "No active workspace"),
    ),
    tag = "workspace"
)]
pub async fn replace_workspace_active_node(
    State(state): State<Arc<AppState>>,
    Json(replacement): Json<WorkspaceActiveNodeReplaceRequest>,
) -> Result<Json<WorkspaceActiveNodeResource>, ApiError> {
    ensure_active_live_workspace(&state).await?;
    let mut selection = state.current_workspace_selection.write().await;
    let changed = selection.selected_node_id != replacement.node_id;
    if changed {
        selection.selected_node_id = replacement.node_id.clone();
        selection.revision = selection.revision.wrapping_add(1);
    }
    let response = WorkspaceActiveNodeResource {
        revision: selection.revision,
        node_id: selection.selected_node_id.clone(),
    };
    let workspace_revision = response.revision;
    drop(selection);
    if changed {
        emit_workspace_realtime_change(&state, workspace_revision).await?;
    }
    Ok(Json(response))
}

#[utoipa::path(
    get,
    path = "/v1/live/current/workspace/ribbon",
    responses(
        (status = 200, description = "Current workspace ribbon resource", body = WorkspaceRibbonResource),
        (status = 404, description = "No active workspace"),
    ),
    tag = "workspace"
)]
pub async fn get_workspace_ribbon(
    State(state): State<Arc<AppState>>,
) -> Result<Json<WorkspaceRibbonResource>, ApiError> {
    ensure_active_live_workspace(&state).await?;
    Ok(Json(state.current_workspace_ribbon.read().await.clone()))
}

#[utoipa::path(
    put,
    path = "/v1/live/current/workspace/ribbon",
    request_body = WorkspaceRibbonReplaceRequest,
    responses(
        (status = 200, description = "Workspace ribbon replaced", body = WorkspaceRibbonResource),
        (status = 404, description = "No active workspace"),
    ),
    tag = "workspace"
)]
pub async fn replace_workspace_ribbon(
    State(state): State<Arc<AppState>>,
    Json(replacement): Json<WorkspaceRibbonReplaceRequest>,
) -> Result<Json<WorkspaceRibbonResource>, ApiError> {
    ensure_active_live_workspace(&state).await?;
    let mut ribbon = state.current_workspace_ribbon.write().await;
    let changed = ribbon.workspace_mode != replacement.workspace_mode
        || ribbon.active_core_tab != replacement.active_core_tab
        || ribbon.active_contextual_tab != replacement.active_contextual_tab;
    if changed {
        ribbon.workspace_mode = replacement.workspace_mode;
        ribbon.active_core_tab = replacement.active_core_tab;
        ribbon.active_contextual_tab = replacement.active_contextual_tab;
        ribbon.revision = ribbon.revision.wrapping_add(1);
    }
    let response = ribbon.clone();
    let workspace_revision = response.revision;
    drop(ribbon);
    if changed {
        emit_workspace_realtime_change(&state, workspace_revision).await?;
    }
    Ok(Json(response))
}

#[utoipa::path(
    get,
    path = "/v1/live/current/workspace/layout",
    responses(
        (status = 200, description = "Current workspace layout resource", body = WorkspaceLayoutResource),
        (status = 404, description = "No active workspace"),
    ),
    tag = "workspace"
)]
pub async fn get_workspace_layout(
    State(state): State<Arc<AppState>>,
) -> Result<Json<WorkspaceLayoutResource>, ApiError> {
    ensure_active_live_workspace(&state).await?;
    Ok(Json(state.current_workspace_layout.read().await.clone()))
}

#[utoipa::path(
    put,
    path = "/v1/live/current/workspace/layout",
    request_body = WorkspaceLayoutReplaceRequest,
    responses(
        (status = 200, description = "Workspace layout replaced", body = WorkspaceLayoutResource),
        (status = 404, description = "No active workspace"),
    ),
    tag = "workspace"
)]
pub async fn replace_workspace_layout(
    State(state): State<Arc<AppState>>,
    Json(replacement): Json<WorkspaceLayoutReplaceRequest>,
) -> Result<Json<WorkspaceLayoutResource>, ApiError> {
    ensure_active_live_workspace(&state).await?;
    let mut layout = state.current_workspace_layout.write().await;
    let changed = layout.current_stage != replacement.current_stage
        || layout.stage_layouts != replacement.stage_layouts
        || layout.active_workspace_tab_by_stage != replacement.active_workspace_tab_by_stage;
    if changed {
        layout.current_stage = replacement.current_stage;
        layout.stage_layouts = replacement.stage_layouts;
        layout.active_workspace_tab_by_stage = replacement.active_workspace_tab_by_stage;
        layout.revision = layout.revision.wrapping_add(1);
    }
    let response = layout.clone();
    let workspace_revision = response.revision;
    drop(layout);
    if changed {
        emit_workspace_realtime_change(&state, workspace_revision).await?;
    }
    Ok(Json(response))
}

async fn ensure_active_live_workspace(state: &AppState) -> Result<(), ApiError> {
    if state.current_live_state.read().await.is_none() {
        return Err(ApiError::not_found("no active local live workspace"));
    }
    Ok(())
}

async fn emit_workspace_realtime_change(
    state: &Arc<AppState>,
    workspace_revision: u64,
) -> Result<(), ApiError> {
    if workspace_revision == 0 {
        return Ok(());
    }
    if let Some(snapshot) = state.current_live_state.read().await.as_ref().cloned() {
        let realtime_state = crate::current_live_realtime_state_from_snapshot(
            state,
            &snapshot,
            state.current_display_selection.read().await.revision,
        )
        .await;
        crate::publish_current_live_realtime_batch_changed(state, &realtime_state, false, 0)
            .await?;
    }
    Ok(())
}
