use std::sync::Arc;

use axum::{
    extract::{Path, State},
    Json,
};

use crate::{
    error::ApiError,
    schemas::{
        PlanarMonitorCollectionResource, PlanarMonitorCreateRequest, PlanarMonitorDeleteRequest,
        PlanarMonitorDuplicateRequest, PlanarMonitorPatchRequest, PlanarMonitorResource,
    },
    types::AppState,
};

#[utoipa::path(
    get,
    path = "/v2/sessions/current/model/planar-monitors",
    responses((status = 200, body = PlanarMonitorCollectionResource)),
    tag = "model"
)]
pub async fn list_planar_monitors(
    State(state): State<Arc<AppState>>,
) -> Result<Json<PlanarMonitorCollectionResource>, ApiError> {
    let scene = crate::get_or_load_current_live_scene_document(&state).await?;
    Ok(Json(PlanarMonitorCollectionResource {
        scene_revision: scene.revision,
        count: scene.monitors.planar.len(),
        monitors: scene.monitors.planar,
    }))
}

#[utoipa::path(
    post,
    path = "/v2/sessions/current/model/planar-monitors",
    request_body = PlanarMonitorCreateRequest,
    responses(
        (status = 200, body = PlanarMonitorResource),
        (status = 400, description = "Invalid monitor"),
        (status = 409, description = "Revision or identity conflict")
    ),
    tag = "model"
)]
pub async fn create_planar_monitor(
    State(state): State<Arc<AppState>>,
    Json(request): Json<PlanarMonitorCreateRequest>,
) -> Result<Json<PlanarMonitorResource>, ApiError> {
    let mut scene = crate::get_or_load_current_live_scene_document(&state).await?;
    check_scene_revision(scene.revision, request.expected_scene_revision)?;
    ensure_new_identity(
        &scene.monitors.planar,
        &request.monitor.id,
        &request.monitor.name,
    )?;
    let monitor_id = request.monitor.id.clone();
    scene.monitors.planar.push(request.monitor);
    let committed = crate::commit_current_live_scene_document(&state, scene).await?;
    monitor_resource(&committed, &monitor_id).map(Json)
}

#[utoipa::path(
    get,
    path = "/v2/sessions/current/model/planar-monitors/{monitor_id}",
    params(("monitor_id" = String, Path)),
    responses((status = 200, body = PlanarMonitorResource), (status = 404, description = "Monitor missing")),
    tag = "model"
)]
pub async fn get_planar_monitor(
    State(state): State<Arc<AppState>>,
    Path(monitor_id): Path<String>,
) -> Result<Json<PlanarMonitorResource>, ApiError> {
    let scene = crate::get_or_load_current_live_scene_document(&state).await?;
    monitor_resource(&scene, &monitor_id).map(Json)
}

#[utoipa::path(
    patch,
    path = "/v2/sessions/current/model/planar-monitors/{monitor_id}",
    params(("monitor_id" = String, Path)),
    request_body = PlanarMonitorPatchRequest,
    responses((status = 200, body = PlanarMonitorResource), (status = 404, description = "Monitor missing"), (status = 409, description = "Revision conflict")),
    tag = "model"
)]
pub async fn patch_planar_monitor(
    State(state): State<Arc<AppState>>,
    Path(monitor_id): Path<String>,
    Json(request): Json<PlanarMonitorPatchRequest>,
) -> Result<Json<PlanarMonitorResource>, ApiError> {
    let mut scene = crate::get_or_load_current_live_scene_document(&state).await?;
    check_scene_revision(scene.revision, request.expected_scene_revision)?;
    if request.monitor.id != monitor_id {
        return Err(ApiError::bad_request(
            "planar_monitor_id_mismatch: path id and payload id differ",
        ));
    }
    if scene
        .monitors
        .planar
        .iter()
        .any(|monitor| monitor.id != monitor_id && monitor.name == request.monitor.name)
    {
        return Err(ApiError::conflict(
            "duplicate_planar_monitor_name: monitor names must be unique",
        ));
    }
    let existing = scene
        .monitors
        .planar
        .iter_mut()
        .find(|monitor| monitor.id == monitor_id)
        .ok_or_else(|| ApiError::not_found(format!("planar monitor not found: {monitor_id}")))?;
    *existing = request.monitor;
    let committed = crate::commit_current_live_scene_document(&state, scene).await?;
    monitor_resource(&committed, &monitor_id).map(Json)
}

#[utoipa::path(
    delete,
    path = "/v2/sessions/current/model/planar-monitors/{monitor_id}",
    params(("monitor_id" = String, Path)),
    request_body = PlanarMonitorDeleteRequest,
    responses((status = 200, body = PlanarMonitorCollectionResource), (status = 404, description = "Monitor missing"), (status = 409, description = "Revision conflict")),
    tag = "model"
)]
pub async fn delete_planar_monitor(
    State(state): State<Arc<AppState>>,
    Path(monitor_id): Path<String>,
    Json(request): Json<PlanarMonitorDeleteRequest>,
) -> Result<Json<PlanarMonitorCollectionResource>, ApiError> {
    let mut scene = crate::get_or_load_current_live_scene_document(&state).await?;
    check_scene_revision(scene.revision, request.expected_scene_revision)?;
    let before = scene.monitors.planar.len();
    scene
        .monitors
        .planar
        .retain(|monitor| monitor.id != monitor_id);
    if before == scene.monitors.planar.len() {
        return Err(ApiError::not_found(format!(
            "planar monitor not found: {monitor_id}"
        )));
    }
    let committed = crate::commit_current_live_scene_document(&state, scene).await?;
    Ok(Json(PlanarMonitorCollectionResource {
        scene_revision: committed.revision,
        count: committed.monitors.planar.len(),
        monitors: committed.monitors.planar,
    }))
}

#[utoipa::path(
    post,
    path = "/v2/sessions/current/model/planar-monitors/{monitor_id}/duplicate",
    params(("monitor_id" = String, Path)),
    request_body = PlanarMonitorDuplicateRequest,
    responses((status = 200, body = PlanarMonitorResource), (status = 404, description = "Monitor missing"), (status = 409, description = "Revision conflict")),
    tag = "model"
)]
pub async fn duplicate_planar_monitor(
    State(state): State<Arc<AppState>>,
    Path(monitor_id): Path<String>,
    Json(request): Json<PlanarMonitorDuplicateRequest>,
) -> Result<Json<PlanarMonitorResource>, ApiError> {
    let mut scene = crate::get_or_load_current_live_scene_document(&state).await?;
    check_scene_revision(scene.revision, request.expected_scene_revision)?;
    let source = scene
        .monitors
        .planar
        .iter()
        .find(|monitor| monitor.id == monitor_id)
        .cloned()
        .ok_or_else(|| ApiError::not_found(format!("planar monitor not found: {monitor_id}")))?;
    let mut duplicate = source;
    duplicate.id = request
        .new_id
        .unwrap_or_else(|| available_copy_id(&scene.monitors.planar, &monitor_id));
    duplicate.name = request
        .new_name
        .unwrap_or_else(|| available_copy_name(&scene.monitors.planar, &duplicate.name));
    ensure_new_identity(&scene.monitors.planar, &duplicate.id, &duplicate.name)?;
    let duplicate_id = duplicate.id.clone();
    scene.monitors.planar.push(duplicate);
    let committed = crate::commit_current_live_scene_document(&state, scene).await?;
    monitor_resource(&committed, &duplicate_id).map(Json)
}

fn check_scene_revision(current: u64, expected: u64) -> Result<(), ApiError> {
    if current == expected {
        Ok(())
    } else {
        Err(ApiError::conflict(format!(
            "scene_revision_conflict: expected {expected}, current {current}"
        )))
    }
}

fn ensure_new_identity(
    monitors: &[fullmag_ir::PlanarMonitorIR],
    id: &str,
    name: &str,
) -> Result<(), ApiError> {
    if monitors.iter().any(|monitor| monitor.id == id) {
        return Err(ApiError::conflict(format!(
            "duplicate_planar_monitor_id: {id}"
        )));
    }
    if monitors.iter().any(|monitor| monitor.name == name) {
        return Err(ApiError::conflict(format!(
            "duplicate_planar_monitor_name: {name}"
        )));
    }
    Ok(())
}

fn monitor_resource(
    scene: &fullmag_authoring::SceneDocument,
    monitor_id: &str,
) -> Result<PlanarMonitorResource, ApiError> {
    let monitor = scene
        .monitors
        .planar
        .iter()
        .find(|monitor| monitor.id == monitor_id)
        .cloned()
        .ok_or_else(|| ApiError::not_found(format!("planar monitor not found: {monitor_id}")))?;
    Ok(PlanarMonitorResource {
        scene_revision: scene.revision,
        monitor,
    })
}

fn available_copy_id(monitors: &[fullmag_ir::PlanarMonitorIR], source: &str) -> String {
    available_copy_value(monitors.iter().map(|monitor| monitor.id.as_str()), source)
}

fn available_copy_name(monitors: &[fullmag_ir::PlanarMonitorIR], source: &str) -> String {
    available_copy_value(monitors.iter().map(|monitor| monitor.name.as_str()), source)
}

fn available_copy_value<'a>(existing: impl Iterator<Item = &'a str>, source: &str) -> String {
    let existing = existing.collect::<std::collections::HashSet<_>>();
    (1..)
        .map(|index| format!("{source} copy {index}"))
        .find(|candidate| !existing.contains(candidate.as_str()))
        .expect("unbounded copy suffix space")
}
