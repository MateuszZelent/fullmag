//! Mesh resource endpoints.

use std::collections::{BTreeSet, HashMap};
use std::fs;
use std::sync::Arc;

use axum::extract::{Path, State};
use axum::http::{HeaderMap, StatusCode};
use axum::response::IntoResponse;
use axum::Json;
use serde_json::{json, Value};

use crate::error::ApiError;
use crate::field_store::serialize_fem_mesh_topology_binary_v1;
use crate::schemas::mesh::{
    MeshActiveBuildResource, MeshBuildDiagnosticsResource, MeshBuildHistoryResource,
    MeshCapabilitiesResource, MeshInterfaceConfigReplaceRequest, MeshInterfaceConfigResource,
    MeshInterfaceQualityResource, MeshInterfaceReportResource, MeshLastSuccessfulBuildResource,
    MeshObjectConfigEntryResource, MeshObjectConfigReplaceRequest, MeshObjectConfigResource,
    MeshObjectQualityResource, MeshObjectReportResource, MeshObjectSegmentResource,
    MeshObjectSizeFieldResource, MeshPartResource, MeshPeriodicPairResource,
    MeshPeriodicPairsResource, MeshRegionResource, MeshSemanticsResource,
    MeshSharedDomainConfigReplaceRequest, MeshSharedDomainConfigResource,
    MeshSharedDomainManifestResource, MeshSharedDomainQualityResource,
    MeshSharedDomainReportResource, MeshSolverMeshResource, MeshSummaryResource,
    MeshUniverseConfigReplaceRequest, MeshUniverseConfigResource, MeshUniverseQualityResource,
    MeshUniverseReportResource,
};
use crate::session::current_artifact_dir;
use crate::types::{AppState, SessionStateResponse};
use fullmag_authoring::{
    SceneDocument, SceneMeshInterface, SceneObject, ScriptBuilderMeshState,
    ScriptBuilderPerGeometryMeshState, ScriptBuilderUniverseState,
};
use fullmag_runner::{FemMeshObjectSegment, FemMeshPartPayload, FemMeshPayload};

#[utoipa::path(
    get,
    path = "/v2/sessions/current/meshing/summary",
    responses(
        (status = 200, description = "Current mesh summary", body = MeshSummaryResource),
        (status = 304, description = "Mesh summary not modified for the supplied ETag"),
        (status = 404, description = "No active workspace or mesh summary"),
    ),
    tag = "meshing"
)]
pub async fn get_mesh_summary(
    State(state): State<Arc<AppState>>,
    headers: HeaderMap,
) -> Result<axum::response::Response, ApiError> {
    let snapshot = current_snapshot(&state).await?;
    let mesh_workspace = current_mesh_workspace(&snapshot)?;
    let body = MeshSummaryResource {
        revision: snapshot.mesh_revision,
        mesh_summary: mesh_workspace.get("mesh_summary").cloned(),
        mesh_quality_summary: mesh_workspace.get("mesh_quality_summary").cloned(),
        effective_airbox_target: mesh_workspace.get("effective_airbox_target").cloned(),
        effective_per_object_targets: mesh_workspace.get("effective_per_object_targets").cloned(),
    };
    let etag = crate::router_v2::handlers::shared::stable_strong_etag(&format!(
        "mesh-summary:{}",
        snapshot.mesh_revision
    ));
    Ok(crate::router_v2::handlers::shared::conditional_json_response(&headers, &etag, &body))
}

#[utoipa::path(
    get,
    path = "/v2/sessions/current/meshing/capabilities",
    responses(
        (status = 200, description = "Current mesh capability read-model", body = MeshCapabilitiesResource),
        (status = 404, description = "No active workspace or mesh summary"),
    ),
    tag = "meshing"
)]
pub async fn get_mesh_capabilities(
    State(state): State<Arc<AppState>>,
) -> Result<Json<MeshCapabilitiesResource>, ApiError> {
    let snapshot = current_snapshot(&state).await?;
    let mesh_workspace = current_mesh_workspace(&snapshot)?;
    Ok(Json(MeshCapabilitiesResource {
        revision: snapshot.mesh_revision,
        mesh_capabilities: mesh_workspace.get("mesh_capabilities").cloned(),
        mesh_adaptivity_state: mesh_workspace.get("mesh_adaptivity_state").cloned(),
    }))
}

#[utoipa::path(
    get,
    path = "/v2/sessions/current/meshing/semantics",
    responses(
        (status = 200, description = "Three-level mesh semantics projection", body = MeshSemanticsResource),
        (status = 404, description = "No active workspace or scene document"),
    ),
    tag = "meshing"
)]
pub async fn get_mesh_semantics(
    State(state): State<Arc<AppState>>,
) -> Result<Json<MeshSemanticsResource>, ApiError> {
    let snapshot = current_snapshot(&state).await?;
    let scene = current_scene_document(&snapshot)?;
    let universe_config = current_universe_mesh_config(scene)
        .map(serde_json::to_value)
        .transpose()
        .map_err(|error| {
            ApiError::internal(format!(
                "failed to serialize universe mesh semantics config: {error}"
            ))
        })?;
    let shared_domain_config =
        serde_json::to_value(&scene.study.shared_domain_mesh).map_err(|error| {
            ApiError::internal(format!(
                "failed to serialize shared-domain mesh semantics config: {error}"
            ))
        })?;
    let object_configs = scene
        .objects
        .iter()
        .map(|object| {
            let config = current_object_mesh_config(object)
                .map(serde_json::to_value)
                .transpose()
                .map_err(|error| {
                    ApiError::internal(format!(
                        "failed to serialize object mesh semantics config: {error}"
                    ))
                })?;
            Ok(MeshObjectConfigEntryResource {
                object_id: object.id.clone(),
                object_name: object.name.clone(),
                config,
            })
        })
        .collect::<Result<Vec<_>, ApiError>>()?;
    let solver_mesh = snapshot
        .fem_mesh
        .as_ref()
        .map(|mesh| MeshSolverMeshResource {
            mesh_name: mesh.mesh_name.clone(),
            mesh_id: mesh.mesh_id.clone(),
            generation_id: mesh.generation_id.clone(),
            domain_mesh_mode: mesh.domain_mesh_mode.clone(),
            object_segment_count: mesh.object_segments.len() as u32,
            mesh_part_count: mesh.mesh_parts.len() as u32,
        });
    let mesh_build_diagnostics =
        snapshot
            .mesh_workspace
            .as_ref()
            .map(|workspace| MeshBuildDiagnosticsResource {
                mesh_quality_summary: workspace.get("mesh_quality_summary").cloned(),
                mesh_statistics: workspace.get("mesh_statistics").cloned(),
                last_build_summary: workspace.get("last_build_summary").cloned(),
                mesh_pipeline_status: workspace.get("mesh_pipeline_status").cloned(),
                last_build_error: workspace
                    .get("last_build_error")
                    .and_then(Value::as_str)
                    .map(ToOwned::to_owned),
            });
    Ok(Json(MeshSemanticsResource {
        revision: snapshot.mesh_revision,
        universe_config,
        shared_domain_config,
        object_configs,
        solver_mesh,
        mesh_build_diagnostics,
        render_only_controls_do_not_change_solver_domain: true,
    }))
}

#[utoipa::path(
    get,
    path = "/v2/sessions/current/meshing/builds/current",
    responses(
        (status = 200, description = "Current active mesh build projection", body = MeshActiveBuildResource),
        (status = 304, description = "Active mesh build projection not modified for the supplied ETag"),
        (status = 404, description = "No active workspace or mesh summary"),
    ),
    tag = "meshing"
)]
pub async fn get_mesh_active_build(
    State(state): State<Arc<AppState>>,
    headers: HeaderMap,
) -> Result<axum::response::Response, ApiError> {
    let snapshot = current_snapshot(&state).await?;
    let mesh_workspace = current_mesh_workspace(&snapshot)?;
    let body = MeshActiveBuildResource {
        revision: snapshot.mesh_build_revision,
        active_build: mesh_workspace.get("active_build").cloned(),
        mesh_pipeline_status: mesh_workspace.get("mesh_pipeline_status").cloned(),
        effective_airbox_target: mesh_workspace.get("effective_airbox_target").cloned(),
        effective_per_object_targets: mesh_workspace.get("effective_per_object_targets").cloned(),
        last_build_summary: mesh_workspace.get("last_build_summary").cloned(),
        last_build_error: mesh_workspace
            .get("last_build_error")
            .and_then(Value::as_str)
            .map(ToOwned::to_owned),
    };
    let etag = crate::router_v2::handlers::shared::stable_strong_etag(&format!(
        "mesh-build-active:{}",
        snapshot.mesh_build_revision
    ));
    Ok(crate::router_v2::handlers::shared::conditional_json_response(&headers, &etag, &body))
}

#[utoipa::path(
    get,
    path = "/v2/sessions/current/meshing/builds",
    responses(
        (status = 200, description = "Mesh build history", body = MeshBuildHistoryResource),
        (status = 304, description = "Mesh build history not modified for the supplied ETag"),
        (status = 404, description = "No active workspace or mesh summary"),
    ),
    tag = "meshing"
)]
pub async fn get_mesh_build_history(
    State(state): State<Arc<AppState>>,
    headers: HeaderMap,
) -> Result<axum::response::Response, ApiError> {
    let snapshot = current_snapshot(&state).await?;
    let mesh_workspace = current_mesh_workspace(&snapshot)?;
    let history = mesh_workspace
        .get("mesh_history")
        .and_then(Value::as_array)
        .cloned()
        .unwrap_or_default();
    let body = MeshBuildHistoryResource {
        revision: snapshot.mesh_build_revision,
        history,
    };
    let etag = crate::router_v2::handlers::shared::stable_strong_etag(&format!(
        "mesh-build-history:{}",
        snapshot.mesh_build_revision
    ));
    Ok(crate::router_v2::handlers::shared::conditional_json_response(&headers, &etag, &body))
}

#[utoipa::path(
    get,
    path = "/v2/sessions/current/meshing/builds/latest-successful",
    responses(
        (status = 200, description = "Last successful mesh build projection", body = MeshLastSuccessfulBuildResource),
        (status = 304, description = "Last successful mesh build projection not modified for the supplied ETag"),
        (status = 404, description = "No active workspace or mesh summary"),
    ),
    tag = "meshing"
)]
pub async fn get_mesh_last_successful_build(
    State(state): State<Arc<AppState>>,
    headers: HeaderMap,
) -> Result<axum::response::Response, ApiError> {
    let snapshot = current_snapshot(&state).await?;
    let mesh_workspace = current_mesh_workspace(&snapshot)?;
    let body = MeshLastSuccessfulBuildResource {
        revision: snapshot.mesh_build_revision,
        last_success: mesh_workspace.get("last_build_summary").cloned(),
        effective_airbox_target: mesh_workspace.get("effective_airbox_target").cloned(),
        effective_per_object_targets: mesh_workspace.get("effective_per_object_targets").cloned(),
        last_build_error: mesh_workspace
            .get("last_build_error")
            .and_then(Value::as_str)
            .map(ToOwned::to_owned),
    };
    let etag = crate::router_v2::handlers::shared::stable_strong_etag(&format!(
        "mesh-build-last-success:{}",
        snapshot.mesh_build_revision
    ));
    Ok(crate::router_v2::handlers::shared::conditional_json_response(&headers, &etag, &body))
}

#[utoipa::path(
    get,
    path = "/v2/sessions/current/meshing/policies/universe",
    responses(
        (status = 200, description = "Current universe mesh config", body = MeshUniverseConfigResource),
        (status = 404, description = "No active workspace or scene document"),
    ),
    tag = "meshing"
)]
pub async fn get_mesh_universe_config(
    State(state): State<Arc<AppState>>,
) -> Result<Json<MeshUniverseConfigResource>, ApiError> {
    let snapshot = current_snapshot(&state).await?;
    let scene = current_scene_document(&snapshot)?;
    let config = current_universe_mesh_config(scene)
        .map(serde_json::to_value)
        .transpose()
        .map_err(|error| {
            ApiError::internal(format!("failed to serialize universe mesh config: {error}"))
        })?;
    Ok(Json(MeshUniverseConfigResource {
        revision: snapshot.mesh_revision,
        config,
    }))
}

#[utoipa::path(
    put,
    path = "/v2/sessions/current/meshing/policies/universe",
    request_body = MeshUniverseConfigReplaceRequest,
    responses(
        (status = 200, description = "Committed universe mesh config", body = MeshUniverseConfigResource),
        (status = 400, description = "Invalid universe mesh config payload"),
        (status = 404, description = "No active workspace"),
    ),
    tag = "meshing"
)]
pub async fn replace_mesh_universe_config(
    State(state): State<Arc<AppState>>,
    Json(req): Json<MeshUniverseConfigReplaceRequest>,
) -> Result<Json<MeshUniverseConfigResource>, ApiError> {
    let config: ScriptBuilderUniverseState =
        serde_json::from_value(req.config).map_err(|error| {
            ApiError::bad_request(format!("invalid universe mesh config payload: {error}"))
        })?;
    let mut scene = crate::get_or_load_current_live_scene_document(&state).await?;
    scene.study.universe_mesh = Some(config.clone());
    if scene.universe.is_none() {
        scene.universe = Some(config.clone());
    }
    let committed = crate::commit_current_live_scene_document(&state, scene).await?;
    let config = current_universe_mesh_config(&committed)
        .ok_or_else(|| ApiError::internal("committed universe mesh config missing"))?;
    let config = serde_json::to_value(config).map_err(|error| {
        ApiError::internal(format!(
            "failed to serialize committed universe mesh config: {error}"
        ))
    })?;
    let revision = current_snapshot(&state).await?.mesh_revision;
    Ok(Json(MeshUniverseConfigResource {
        revision,
        config: Some(config),
    }))
}

#[utoipa::path(
    get,
    path = "/v2/sessions/current/meshing/meshes/universe/report",
    responses(
        (status = 200, description = "Universe mesh report", body = MeshUniverseReportResource),
        (status = 404, description = "No active workspace"),
    ),
    tag = "meshing"
)]
pub async fn get_mesh_universe_report(
    State(state): State<Arc<AppState>>,
) -> Result<Json<MeshUniverseReportResource>, ApiError> {
    let snapshot = current_snapshot(&state).await?;
    let scene = current_scene_document(&snapshot)?;
    let mesh_workspace = current_mesh_workspace(&snapshot)?;
    let report = Some(json!({
        "config": current_universe_mesh_config(scene),
        "effective_airbox_target": mesh_workspace.get("effective_airbox_target").cloned().unwrap_or(Value::Null),
        "mesh_summary": mesh_workspace.get("mesh_summary").cloned().unwrap_or(Value::Null),
        "last_build_summary": mesh_workspace.get("last_build_summary").cloned().unwrap_or(Value::Null),
    }));
    Ok(Json(MeshUniverseReportResource {
        revision: snapshot.mesh_revision,
        report,
    }))
}

#[utoipa::path(
    get,
    path = "/v2/sessions/current/meshing/meshes/universe/quality",
    responses(
        (status = 200, description = "Universe mesh quality projection", body = MeshUniverseQualityResource),
        (status = 404, description = "No active workspace"),
    ),
    tag = "meshing"
)]
pub async fn get_mesh_universe_quality(
    State(state): State<Arc<AppState>>,
) -> Result<Json<MeshUniverseQualityResource>, ApiError> {
    let snapshot = current_snapshot(&state).await?;
    let mesh_workspace = current_mesh_workspace(&snapshot)?;
    let quality = Some(json!({
        "mesh_quality_summary": mesh_workspace.get("mesh_quality_summary").cloned().unwrap_or(Value::Null),
        "effective_airbox_target": mesh_workspace.get("effective_airbox_target").cloned().unwrap_or(Value::Null),
    }));
    Ok(Json(MeshUniverseQualityResource {
        revision: snapshot.mesh_revision,
        quality,
    }))
}

#[utoipa::path(
    get,
    path = "/v2/sessions/current/meshing/policies/shared-domain",
    responses(
        (status = 200, description = "Current shared-domain mesh config", body = MeshSharedDomainConfigResource),
        (status = 404, description = "No active workspace or scene document"),
    ),
    tag = "meshing"
)]
pub async fn get_mesh_shared_domain_config(
    State(state): State<Arc<AppState>>,
) -> Result<Json<MeshSharedDomainConfigResource>, ApiError> {
    let snapshot = current_snapshot(&state).await?;
    let scene = current_scene_document(&snapshot)?;
    let config = serde_json::to_value(&scene.study.shared_domain_mesh).map_err(|error| {
        ApiError::internal(format!(
            "failed to serialize shared-domain mesh config: {error}"
        ))
    })?;
    Ok(Json(MeshSharedDomainConfigResource {
        revision: snapshot.mesh_revision,
        config,
    }))
}

#[utoipa::path(
    put,
    path = "/v2/sessions/current/meshing/policies/shared-domain",
    request_body = MeshSharedDomainConfigReplaceRequest,
    responses(
        (status = 200, description = "Committed shared-domain mesh config", body = MeshSharedDomainConfigResource),
        (status = 400, description = "Invalid shared-domain mesh config payload"),
        (status = 404, description = "No active workspace"),
    ),
    tag = "meshing"
)]
pub async fn replace_mesh_shared_domain_config(
    State(state): State<Arc<AppState>>,
    Json(req): Json<MeshSharedDomainConfigReplaceRequest>,
) -> Result<Json<MeshSharedDomainConfigResource>, ApiError> {
    let config: ScriptBuilderMeshState = serde_json::from_value(req.config).map_err(|error| {
        ApiError::bad_request(format!(
            "invalid shared-domain mesh config payload: {error}"
        ))
    })?;
    let mut scene = crate::get_or_load_current_live_scene_document(&state).await?;
    scene.study.shared_domain_mesh = config.clone();
    scene.study.mesh_defaults = config.clone();
    let committed = crate::commit_current_live_scene_document(&state, scene).await?;
    let config = serde_json::to_value(&committed.study.shared_domain_mesh).map_err(|error| {
        ApiError::internal(format!(
            "failed to serialize committed shared-domain mesh config: {error}"
        ))
    })?;
    let revision = current_snapshot(&state).await?.mesh_revision;
    Ok(Json(MeshSharedDomainConfigResource { revision, config }))
}

#[utoipa::path(
    get,
    path = "/v2/sessions/current/meshing/meshes/shared-domain/report",
    responses(
        (status = 200, description = "Shared-domain mesh report", body = MeshSharedDomainReportResource),
        (status = 404, description = "No active workspace"),
    ),
    tag = "meshing"
)]
pub async fn get_mesh_shared_domain_report(
    State(state): State<Arc<AppState>>,
) -> Result<Json<MeshSharedDomainReportResource>, ApiError> {
    let snapshot = current_snapshot(&state).await?;
    let mesh_workspace = current_mesh_workspace(&snapshot)?;
    let report = Some(json!({
        "mesh_summary": mesh_workspace.get("mesh_summary").cloned().unwrap_or(Value::Null),
        "mesh_statistics": mesh_workspace.get("mesh_statistics").cloned().unwrap_or(Value::Null),
        "mesh_pipeline_status": mesh_workspace.get("mesh_pipeline_status").cloned().unwrap_or(Value::Null),
        "last_build_summary": mesh_workspace.get("last_build_summary").cloned().unwrap_or(Value::Null),
    }));
    Ok(Json(MeshSharedDomainReportResource {
        revision: snapshot.mesh_revision,
        report,
    }))
}

#[utoipa::path(
    get,
    path = "/v2/sessions/current/meshing/meshes/shared-domain/quality",
    responses(
        (status = 200, description = "Shared-domain mesh quality", body = MeshSharedDomainQualityResource),
        (status = 404, description = "No active workspace"),
    ),
    tag = "meshing"
)]
pub async fn get_mesh_shared_domain_quality(
    State(state): State<Arc<AppState>>,
) -> Result<Json<MeshSharedDomainQualityResource>, ApiError> {
    let snapshot = current_snapshot(&state).await?;
    let mesh_workspace = current_mesh_workspace(&snapshot)?;
    Ok(Json(MeshSharedDomainQualityResource {
        revision: snapshot.mesh_revision,
        quality: mesh_workspace.get("mesh_quality_summary").cloned(),
    }))
}

#[utoipa::path(
    get,
    path = "/v2/sessions/current/meshing/mesh/periodic_pairs.v1",
    responses(
        (status = 200, description = "Shared-domain periodic mesh-pair diagnostics", body = MeshPeriodicPairsResource),
        (status = 304, description = "Periodic mesh-pair diagnostics not modified for the supplied ETag"),
        (status = 204, description = "No FEM mesh available"),
        (status = 404, description = "No active workspace"),
    ),
    tag = "meshing"
)]
pub async fn get_mesh_periodic_pairs(
    State(state): State<Arc<AppState>>,
    headers: HeaderMap,
) -> Result<axum::response::Response, ApiError> {
    let snapshot = current_snapshot(&state).await?;
    let (body, source_id) = if let Some(mesh) = snapshot.fem_mesh.as_ref() {
        (
            build_periodic_pairs_resource(&snapshot, mesh),
            mesh.generation_id
                .as_deref()
                .unwrap_or("no-generation")
                .to_string(),
        )
    } else if let Some(artifact) = periodic_pairs_resource_from_artifact(&snapshot)? {
        (artifact, "artifact-file".to_string())
    } else {
        return Ok(StatusCode::NO_CONTENT.into_response());
    };

    let etag = crate::router_v2::handlers::shared::stable_strong_etag(&format!(
        "mesh-periodic-pairs:{source_id}:{}:{}",
        snapshot.mesh_revision,
        body.pairs.len()
    ));
    Ok(crate::router_v2::handlers::shared::conditional_json_response(&headers, &etag, &body))
}

fn periodic_pairs_resource_from_artifact(
    snapshot: &SessionStateResponse,
) -> Result<Option<MeshPeriodicPairsResource>, ApiError> {
    let Some(artifact_dir) = current_artifact_dir(snapshot) else {
        return Ok(None);
    };
    let artifact_path = artifact_dir.join("mesh").join("periodic_pairs.v1.json");
    if !artifact_path.exists() {
        return Ok(None);
    }
    let content = fs::read_to_string(&artifact_path).map_err(|error| {
        ApiError::internal(format!(
            "failed to read periodic pairs artifact '{}': {error}",
            artifact_path.display()
        ))
    })?;
    let mut value = serde_json::from_str::<Value>(&content).map_err(|error| {
        ApiError::internal(format!(
            "failed to parse periodic pairs artifact '{}': {error}",
            artifact_path.display()
        ))
    })?;
    if let Some(object) = value.as_object_mut() {
        object
            .entry("revision".to_string())
            .or_insert_with(|| json!(snapshot.mesh_revision));
    }
    let resource = serde_json::from_value::<MeshPeriodicPairsResource>(value).map_err(|error| {
        ApiError::internal(format!(
            "periodic pairs artifact '{}' does not match periodic_pairs.v1: {error}",
            artifact_path.display()
        ))
    })?;
    Ok(Some(resource))
}

#[utoipa::path(
    get,
    path = "/v2/sessions/current/meshing/meshes/shared-domain/manifest",
    responses(
        (status = 200, description = "Shared-domain mesh manifest for tree/selection metadata", body = MeshSharedDomainManifestResource),
        (status = 304, description = "Shared-domain mesh manifest not modified for the supplied ETag"),
        (status = 204, description = "No FEM mesh available"),
        (status = 404, description = "No active workspace"),
    ),
    tag = "meshing"
)]
pub async fn get_mesh_shared_domain_manifest(
    State(state): State<Arc<AppState>>,
    headers: HeaderMap,
) -> Result<axum::response::Response, ApiError> {
    let snapshot = current_snapshot(&state).await?;
    match snapshot.fem_mesh.as_ref() {
        Some(mesh) => {
            let provenance = mesh_build_provenance(&snapshot);
            let body = MeshSharedDomainManifestResource {
                revision: snapshot.mesh_revision,
                source_scene_revision: provenance.source_scene_revision,
                geometry_realization_revision: provenance.geometry_realization_revision,
                mesh_name: mesh.mesh_name.clone(),
                mesh_id: mesh.mesh_id.clone(),
                generation_id: mesh.generation_id.clone(),
                domain_mesh_mode: mesh.domain_mesh_mode.clone(),
                object_segments: mesh
                    .object_segments
                    .iter()
                    .map(MeshObjectSegmentResource::from)
                    .collect(),
                mesh_parts: mesh.mesh_parts.iter().map(MeshPartResource::from).collect(),
                regions: snapshot
                    .scene_document
                    .as_ref()
                    .map(|scene| mesh_manifest_regions(scene, mesh))
                    .unwrap_or_default(),
            };
            let generation_id = mesh.generation_id.as_deref().unwrap_or("no-generation");
            let etag = crate::router_v2::handlers::shared::stable_strong_etag(&format!(
                "mesh-shared-domain-manifest:{generation_id}:{}",
                snapshot.mesh_revision
            ));
            Ok(
                crate::router_v2::handlers::shared::conditional_json_response(
                    &headers, &etag, &body,
                ),
            )
        }
        None => Ok(StatusCode::NO_CONTENT.into_response()),
    }
}

#[utoipa::path(
    get,
    path = "/v2/sessions/current/meshing/meshes/shared-domain/topology",
    responses(
        (status = 200, description = "Binary shared-domain FEM topology (FMMT)", content_type = "application/octet-stream"),
        (status = 304, description = "Shared-domain topology not modified for the supplied ETag"),
        (status = 204, description = "No FEM mesh available"),
        (status = 404, description = "No active workspace"),
    ),
    tag = "meshing"
)]
pub async fn get_mesh_shared_domain_topology(
    State(state): State<Arc<AppState>>,
    headers: HeaderMap,
) -> Result<axum::response::Response, ApiError> {
    let snapshot = current_snapshot(&state).await?;
    match snapshot.fem_mesh.as_ref() {
        Some(mesh) => {
            let binary = serialize_fem_mesh_topology_binary_v1(mesh);
            let generation_id = mesh.generation_id.as_deref().unwrap_or("no-generation");
            let etag = crate::router_v2::handlers::shared::stable_strong_etag(&format!(
                "mesh-shared-domain-topology:{generation_id}:{}",
                snapshot.mesh_revision
            ));
            Ok(
                crate::router_v2::handlers::shared::conditional_binary_response(
                    &headers, &etag, binary,
                ),
            )
        }
        None => Ok(StatusCode::NO_CONTENT.into_response()),
    }
}

#[utoipa::path(
    get,
    path = "/v2/sessions/current/meshing/policies/objects/{object_id}",
    params(
        ("object_id" = String, Path, description = "Canonical scene object id")
    ),
    responses(
        (status = 200, description = "Current per-object mesh config", body = MeshObjectConfigResource),
        (status = 404, description = "No active workspace, scene document, or object"),
    ),
    tag = "meshing"
)]
pub async fn get_mesh_object_config(
    State(state): State<Arc<AppState>>,
    Path(object_id): Path<String>,
) -> Result<Json<MeshObjectConfigResource>, ApiError> {
    let snapshot = current_snapshot(&state).await?;
    let scene = current_scene_document(&snapshot)?;
    let object = scene
        .objects
        .iter()
        .find(|entry| entry.id == object_id)
        .ok_or_else(|| ApiError::not_found(format!("object not found: {object_id}")))?;
    let config = current_object_mesh_config(object)
        .map(serde_json::to_value)
        .transpose()
        .map_err(|error| {
            ApiError::internal(format!("failed to serialize object mesh config: {error}"))
        })?;
    Ok(Json(MeshObjectConfigResource {
        revision: snapshot.mesh_revision,
        object_id,
        config,
    }))
}

#[utoipa::path(
    put,
    path = "/v2/sessions/current/meshing/policies/objects/{object_id}",
    params(
        ("object_id" = String, Path, description = "Canonical scene object id")
    ),
    request_body = MeshObjectConfigReplaceRequest,
    responses(
        (status = 200, description = "Committed per-object mesh config", body = MeshObjectConfigResource),
        (status = 400, description = "Invalid per-object mesh config payload"),
        (status = 404, description = "No active workspace or object"),
    ),
    tag = "meshing"
)]
pub async fn replace_mesh_object_config(
    State(state): State<Arc<AppState>>,
    Path(object_id): Path<String>,
    Json(req): Json<MeshObjectConfigReplaceRequest>,
) -> Result<Json<MeshObjectConfigResource>, ApiError> {
    let config = req
        .config
        .map(serde_json::from_value::<ScriptBuilderPerGeometryMeshState>)
        .transpose()
        .map_err(|error| {
            ApiError::bad_request(format!("invalid object mesh config payload: {error}"))
        })?;
    let mut scene = crate::get_or_load_current_live_scene_document(&state).await?;
    let object = scene
        .objects
        .iter_mut()
        .find(|entry| entry.id == object_id)
        .ok_or_else(|| ApiError::not_found(format!("object not found: {object_id}")))?;
    object.object_mesh = config.clone();
    object.mesh_override = config.clone();
    let committed = crate::commit_current_live_scene_document(&state, scene).await?;
    let object = committed
        .objects
        .iter()
        .find(|entry| entry.id == object_id)
        .ok_or_else(|| ApiError::internal(format!("committed object missing: {object_id}")))?;
    let config = current_object_mesh_config(object)
        .map(serde_json::to_value)
        .transpose()
        .map_err(|error| {
            ApiError::internal(format!(
                "failed to serialize committed object mesh config: {error}"
            ))
        })?;
    let revision = current_snapshot(&state).await?.mesh_revision;
    Ok(Json(MeshObjectConfigResource {
        revision,
        object_id,
        config,
    }))
}

#[utoipa::path(
    get,
    path = "/v2/sessions/current/meshing/meshes/objects/{object_id}/report",
    params(
        ("object_id" = String, Path, description = "Canonical scene object id")
    ),
    responses(
        (status = 200, description = "Per-object mesh report", body = MeshObjectReportResource),
        (status = 404, description = "No active workspace or object"),
    ),
    tag = "meshing"
)]
pub async fn get_mesh_object_report(
    State(state): State<Arc<AppState>>,
    Path(object_id): Path<String>,
) -> Result<Json<MeshObjectReportResource>, ApiError> {
    let snapshot = current_snapshot(&state).await?;
    let scene = current_scene_document(&snapshot)?;
    let object = scene
        .objects
        .iter()
        .find(|entry| entry.id == object_id)
        .ok_or_else(|| ApiError::not_found(format!("object not found: {object_id}")))?;
    let mesh_workspace = current_mesh_workspace(&snapshot)?;
    let report = Some(json!({
        "object_id": object.id,
        "object_name": object.name,
        "config": current_object_mesh_config(object),
        "effective_target": mesh_workspace
            .get("effective_per_object_targets")
            .and_then(|targets| targets.get(object_id.as_str()))
            .cloned()
            .unwrap_or(Value::Null),
        "last_build_summary": mesh_workspace.get("last_build_summary").cloned().unwrap_or(Value::Null),
    }));
    Ok(Json(MeshObjectReportResource {
        revision: snapshot.mesh_revision,
        object_id,
        report,
    }))
}

#[utoipa::path(
    get,
    path = "/v2/sessions/current/meshing/meshes/objects/{object_id}/quality",
    params(
        ("object_id" = String, Path, description = "Canonical scene object id")
    ),
    responses(
        (status = 200, description = "Per-object mesh quality", body = MeshObjectQualityResource),
        (status = 404, description = "No active workspace or object"),
    ),
    tag = "meshing"
)]
pub async fn get_mesh_object_quality(
    State(state): State<Arc<AppState>>,
    Path(object_id): Path<String>,
) -> Result<Json<MeshObjectQualityResource>, ApiError> {
    let snapshot = current_snapshot(&state).await?;
    let scene = current_scene_document(&snapshot)?;
    scene
        .objects
        .iter()
        .find(|entry| entry.id == object_id)
        .ok_or_else(|| ApiError::not_found(format!("object not found: {object_id}")))?;
    let mesh_workspace = current_mesh_workspace(&snapshot)?;
    let quality = object_quality(&snapshot, mesh_workspace, &object_id);
    Ok(Json(MeshObjectQualityResource {
        revision: snapshot.mesh_revision,
        object_id,
        quality,
    }))
}

#[utoipa::path(
    get,
    path = "/v2/sessions/current/meshing/meshes/objects/{object_id}/size-field",
    params(
        ("object_id" = String, Path, description = "Canonical scene object id")
    ),
    responses(
        (status = 200, description = "Per-object size-field projection", body = MeshObjectSizeFieldResource),
        (status = 404, description = "No active workspace or object"),
    ),
    tag = "meshing"
)]
pub async fn get_mesh_object_size_field(
    State(state): State<Arc<AppState>>,
    Path(object_id): Path<String>,
) -> Result<Json<MeshObjectSizeFieldResource>, ApiError> {
    let snapshot = current_snapshot(&state).await?;
    let scene = current_scene_document(&snapshot)?;
    let object = scene
        .objects
        .iter()
        .find(|entry| entry.id == object_id)
        .ok_or_else(|| ApiError::not_found(format!("object not found: {object_id}")))?;
    let size_field = current_object_mesh_config(object).map(|config| {
        json!({
            "size_fields": config.size_fields,
            "operations": config.operations,
        })
    });
    Ok(Json(MeshObjectSizeFieldResource {
        revision: snapshot.mesh_revision,
        object_id,
        size_field,
    }))
}

#[utoipa::path(
    get,
    path = "/v2/sessions/current/meshing/meshes/objects/{object_id}/topology",
    params(
        ("object_id" = String, Path, description = "Canonical scene object id")
    ),
    responses(
        (status = 200, description = "Binary per-object FEM topology (FMMT)", content_type = "application/octet-stream"),
        (status = 304, description = "Per-object topology not modified for the supplied ETag"),
        (status = 204, description = "No FEM mesh available"),
        (status = 404, description = "No active workspace or object mesh"),
    ),
    tag = "meshing"
)]
pub async fn get_mesh_object_topology(
    State(state): State<Arc<AppState>>,
    headers: HeaderMap,
    Path(object_id): Path<String>,
) -> Result<axum::response::Response, ApiError> {
    let snapshot = current_snapshot(&state).await?;
    match snapshot.fem_mesh.as_ref() {
        Some(mesh) => {
            let object_mesh = subset_object_mesh(mesh, &object_id).ok_or_else(|| {
                ApiError::not_found(format!("object mesh not found: {object_id}"))
            })?;
            let binary = serialize_fem_mesh_topology_binary_v1(&object_mesh);
            let generation_id = mesh.generation_id.as_deref().unwrap_or("no-generation");
            let etag = crate::router_v2::handlers::shared::stable_strong_etag(&format!(
                "mesh-object-topology:{object_id}:{generation_id}:{}",
                snapshot.mesh_revision
            ));
            Ok(
                crate::router_v2::handlers::shared::conditional_binary_response(
                    &headers, &etag, binary,
                ),
            )
        }
        None => Ok(StatusCode::NO_CONTENT.into_response()),
    }
}

#[utoipa::path(
    get,
    path = "/v2/sessions/current/meshing/meshes/parts/{part_id}/topology",
    params(
        ("part_id" = String, Path, description = "Stable FEM mesh part id, for example an airbox part")
    ),
    responses(
        (status = 200, description = "Binary per-part FEM topology (FMMT)", content_type = "application/octet-stream"),
        (status = 304, description = "Per-part topology not modified for the supplied ETag"),
        (status = 204, description = "No FEM mesh available"),
        (status = 404, description = "No active workspace or mesh part"),
    ),
    tag = "meshing"
)]
pub async fn get_mesh_part_topology(
    State(state): State<Arc<AppState>>,
    headers: HeaderMap,
    Path(part_id): Path<String>,
) -> Result<axum::response::Response, ApiError> {
    let snapshot = current_snapshot(&state).await?;
    match snapshot.fem_mesh.as_ref() {
        Some(mesh) => {
            let part_mesh = subset_part_mesh(mesh, &part_id)
                .ok_or_else(|| ApiError::not_found(format!("mesh part not found: {part_id}")))?;
            let binary = serialize_fem_mesh_topology_binary_v1(&part_mesh);
            let generation_id = mesh.generation_id.as_deref().unwrap_or("no-generation");
            let etag = crate::router_v2::handlers::shared::stable_strong_etag(&format!(
                "mesh-part-topology:{part_id}:{generation_id}:{}",
                snapshot.mesh_revision
            ));
            Ok(
                crate::router_v2::handlers::shared::conditional_binary_response(
                    &headers, &etag, binary,
                ),
            )
        }
        None => Ok(StatusCode::NO_CONTENT.into_response()),
    }
}

#[utoipa::path(
    get,
    path = "/v2/sessions/current/meshing/policies/interfaces/{interface_id}",
    params(
        ("interface_id" = String, Path, description = "Canonical stable interface id")
    ),
    responses(
        (status = 200, description = "Current per-interface mesh config", body = MeshInterfaceConfigResource),
        (status = 404, description = "No active workspace or scene document"),
    ),
    tag = "meshing"
)]
pub async fn get_mesh_interface_config(
    State(state): State<Arc<AppState>>,
    Path(interface_id): Path<String>,
) -> Result<Json<MeshInterfaceConfigResource>, ApiError> {
    let snapshot = current_snapshot(&state).await?;
    let scene = current_scene_document(&snapshot)?;
    let config = scene
        .study
        .mesh_interfaces
        .iter()
        .find(|entry| entry.interface_id == interface_id)
        .map(|entry| serde_json::to_value(&entry.config))
        .transpose()
        .map_err(|error| {
            ApiError::internal(format!(
                "failed to serialize interface mesh config: {error}"
            ))
        })?;
    Ok(Json(MeshInterfaceConfigResource {
        revision: snapshot.mesh_revision,
        interface_id,
        config,
    }))
}

#[utoipa::path(
    put,
    path = "/v2/sessions/current/meshing/policies/interfaces/{interface_id}",
    params(
        ("interface_id" = String, Path, description = "Canonical stable interface id")
    ),
    request_body = MeshInterfaceConfigReplaceRequest,
    responses(
        (status = 200, description = "Committed per-interface mesh config", body = MeshInterfaceConfigResource),
        (status = 400, description = "Invalid interface mesh config payload"),
        (status = 404, description = "No active workspace"),
    ),
    tag = "meshing"
)]
pub async fn replace_mesh_interface_config(
    State(state): State<Arc<AppState>>,
    Path(interface_id): Path<String>,
    Json(req): Json<MeshInterfaceConfigReplaceRequest>,
) -> Result<Json<MeshInterfaceConfigResource>, ApiError> {
    let config = req
        .config
        .map(serde_json::from_value::<ScriptBuilderPerGeometryMeshState>)
        .transpose()
        .map_err(|error| {
            ApiError::bad_request(format!("invalid interface mesh config payload: {error}"))
        })?;
    let (owner_a, owner_b) = resolve_interface_owners(&interface_id, req.owner_a, req.owner_b)?;

    let mut scene = crate::get_or_load_current_live_scene_document(&state).await?;
    if let Some(index) = scene
        .study
        .mesh_interfaces
        .iter()
        .position(|entry| entry.interface_id == interface_id)
    {
        if let Some(config) = config.clone() {
            scene.study.mesh_interfaces[index] = SceneMeshInterface {
                interface_id: interface_id.clone(),
                owner_a: owner_a.clone(),
                owner_b: owner_b.clone(),
                config,
            };
        } else {
            scene.study.mesh_interfaces.remove(index);
        }
    } else if let Some(config) = config.clone() {
        scene.study.mesh_interfaces.push(SceneMeshInterface {
            interface_id: interface_id.clone(),
            owner_a: owner_a.clone(),
            owner_b: owner_b.clone(),
            config,
        });
    }

    let _committed = crate::commit_current_live_scene_document(&state, scene).await?;
    let snapshot = current_snapshot(&state).await?;
    let committed_scene = current_scene_document(&snapshot)?;
    let config = committed_scene
        .study
        .mesh_interfaces
        .iter()
        .find(|entry| entry.interface_id == interface_id)
        .map(|entry| serde_json::to_value(&entry.config))
        .transpose()
        .map_err(|error| {
            ApiError::internal(format!(
                "failed to serialize committed interface mesh config: {error}"
            ))
        })?;
    Ok(Json(MeshInterfaceConfigResource {
        revision: snapshot.mesh_revision,
        interface_id,
        config,
    }))
}

#[utoipa::path(
    get,
    path = "/v2/sessions/current/meshing/meshes/interfaces/{interface_id}/report",
    params(
        ("interface_id" = String, Path, description = "Canonical stable interface id")
    ),
    responses(
        (status = 200, description = "Per-interface mesh report", body = MeshInterfaceReportResource),
        (status = 404, description = "No active workspace"),
    ),
    tag = "meshing"
)]
pub async fn get_mesh_interface_report(
    State(state): State<Arc<AppState>>,
    Path(interface_id): Path<String>,
) -> Result<Json<MeshInterfaceReportResource>, ApiError> {
    let snapshot = current_snapshot(&state).await?;
    let scene = current_scene_document(&snapshot)?;
    let report = scene
        .study
        .mesh_interfaces
        .iter()
        .find(|entry| entry.interface_id == interface_id)
        .map(|entry| {
            json!({
                "interface_id": entry.interface_id,
                "owner_a": entry.owner_a,
                "owner_b": entry.owner_b,
                "config": entry.config,
            })
        });
    Ok(Json(MeshInterfaceReportResource {
        revision: snapshot.mesh_revision,
        interface_id,
        report,
    }))
}

#[utoipa::path(
    get,
    path = "/v2/sessions/current/meshing/meshes/interfaces/{interface_id}/quality",
    params(
        ("interface_id" = String, Path, description = "Canonical stable interface id")
    ),
    responses(
        (status = 200, description = "Per-interface mesh quality", body = MeshInterfaceQualityResource),
        (status = 404, description = "No active workspace"),
    ),
    tag = "meshing"
)]
pub async fn get_mesh_interface_quality(
    State(state): State<Arc<AppState>>,
    Path(interface_id): Path<String>,
) -> Result<Json<MeshInterfaceQualityResource>, ApiError> {
    let snapshot = current_snapshot(&state).await?;
    Ok(Json(MeshInterfaceQualityResource {
        revision: snapshot.mesh_revision,
        interface_id,
        quality: None,
    }))
}

async fn current_snapshot(state: &Arc<AppState>) -> Result<SessionStateResponse, ApiError> {
    state
        .current_live_state
        .read()
        .await
        .as_ref()
        .cloned()
        .ok_or_else(|| ApiError::not_found("no active local live workspace"))
}

fn current_scene_document(snapshot: &SessionStateResponse) -> Result<&SceneDocument, ApiError> {
    snapshot
        .scene_document
        .as_ref()
        .ok_or_else(|| ApiError::not_found("no scene document available for current workspace"))
}

fn current_mesh_workspace(snapshot: &SessionStateResponse) -> Result<&Value, ApiError> {
    snapshot
        .mesh_workspace
        .as_ref()
        .ok_or_else(|| ApiError::not_found("no mesh workspace available for current workspace"))
}

fn current_universe_mesh_config(scene: &SceneDocument) -> Option<&ScriptBuilderUniverseState> {
    scene
        .study
        .universe_mesh
        .as_ref()
        .or(scene.universe.as_ref())
}

fn current_object_mesh_config(object: &SceneObject) -> Option<&ScriptBuilderPerGeometryMeshState> {
    object
        .object_mesh
        .as_ref()
        .or(object.mesh_override.as_ref())
}

fn resolve_interface_owners(
    interface_id: &str,
    owner_a: Option<String>,
    owner_b: Option<String>,
) -> Result<(String, String), ApiError> {
    match (owner_a, owner_b) {
        (Some(owner_a), Some(owner_b)) => Ok((owner_a, owner_b)),
        (Some(owner_a), None) => {
            let (_, parsed_b) = parse_interface_owners(interface_id).ok_or_else(|| {
                ApiError::bad_request(format!(
                    "interface owners missing and interface_id is not parseable: {interface_id}"
                ))
            })?;
            Ok((owner_a, parsed_b))
        }
        (None, Some(owner_b)) => {
            let (parsed_a, _) = parse_interface_owners(interface_id).ok_or_else(|| {
                ApiError::bad_request(format!(
                    "interface owners missing and interface_id is not parseable: {interface_id}"
                ))
            })?;
            Ok((parsed_a, owner_b))
        }
        (None, None) => parse_interface_owners(interface_id).ok_or_else(|| {
            ApiError::bad_request(format!(
                "interface owners missing and interface_id is not parseable: {interface_id}"
            ))
        }),
    }
}

fn parse_interface_owners(interface_id: &str) -> Option<(String, String)> {
    let (owner_a, owner_b) = interface_id.split_once('|')?;
    if owner_a.is_empty() || owner_b.is_empty() {
        return None;
    }
    Some((owner_a.to_string(), owner_b.to_string()))
}

fn object_quality(
    snapshot: &SessionStateResponse,
    mesh_workspace: &Value,
    object_id: &str,
) -> Option<Value> {
    let effective_target = mesh_workspace
        .get("effective_per_object_targets")
        .and_then(|targets| targets.get(object_id))
        .cloned();
    let marker = effective_target
        .as_ref()
        .and_then(|target| target.get("marker"))
        .and_then(Value::as_u64)
        .map(|marker| marker as u32);
    let per_domain_quality = marker
        .and_then(|marker| {
            snapshot
                .fem_mesh
                .as_ref()?
                .per_domain_quality
                .get(&marker)
                .cloned()
        })
        .and_then(|quality| serde_json::to_value(quality).ok());
    Some(json!({
        "marker": marker,
        "effective_target": effective_target.unwrap_or(Value::Null),
        "per_domain_quality": per_domain_quality.unwrap_or(Value::Null),
    }))
}

#[derive(Debug, Clone, Copy, Default)]
struct MeshBuildProvenance {
    source_scene_revision: Option<u64>,
    geometry_realization_revision: Option<u64>,
}

fn mesh_build_provenance(snapshot: &SessionStateResponse) -> MeshBuildProvenance {
    let last_build = snapshot
        .mesh_workspace
        .as_ref()
        .and_then(|workspace| workspace.get("last_build_summary"));
    MeshBuildProvenance {
        source_scene_revision: last_build
            .and_then(|summary| summary.get("source_scene_revision"))
            .and_then(Value::as_u64)
            .or_else(|| {
                last_build
                    .and_then(|summary| summary.get("geometry_realization"))
                    .and_then(|realization| realization.get("source_scene_revision"))
                    .and_then(Value::as_u64)
            }),
        geometry_realization_revision: last_build
            .and_then(|summary| summary.get("geometry_realization"))
            .and_then(|realization| realization.get("realization_revision"))
            .and_then(Value::as_u64),
    }
}

fn build_periodic_pairs_resource(
    snapshot: &SessionStateResponse,
    mesh: &FemMeshPayload,
) -> MeshPeriodicPairsResource {
    let boundary_nodes_by_marker = boundary_nodes_by_marker(mesh);
    let node_pairs_by_id = mesh.periodic_node_pairs.iter().fold(
        HashMap::<String, Vec<&fullmag_ir::MeshPeriodicNodePairIR>>::new(),
        |mut acc, pair| {
            acc.entry(pair.pair_id.clone()).or_default().push(pair);
            acc
        },
    );

    let pairs = mesh
        .periodic_boundary_pairs
        .iter()
        .map(|boundary_pair| {
            let node_pairs = node_pairs_by_id
                .get(&boundary_pair.pair_id)
                .map(Vec::as_slice)
                .unwrap_or(&[]);
            let source_nodes = boundary_nodes_by_marker
                .get(&boundary_pair.marker_a)
                .cloned()
                .unwrap_or_default();
            let destination_nodes = boundary_nodes_by_marker
                .get(&boundary_pair.marker_b)
                .cloned()
                .unwrap_or_default();
            let paired_source_nodes = node_pairs
                .iter()
                .map(|pair| pair.node_a)
                .collect::<BTreeSet<_>>();
            let paired_destination_nodes = node_pairs
                .iter()
                .map(|pair| pair.node_b)
                .collect::<BTreeSet<_>>();
            let diagnostics = periodic_pair_residuals(mesh, boundary_pair, node_pairs);

            MeshPeriodicPairResource {
                pair_id: boundary_pair.pair_id.clone(),
                source_marker: boundary_pair.source_marker.clone(),
                destination_marker: boundary_pair.destination_marker.clone(),
                marker_a: boundary_pair.marker_a,
                marker_b: boundary_pair.marker_b,
                expected_translation_m: boundary_pair.translation,
                paired_node_count: node_pairs.len() as u32,
                unpaired_source_node_count: source_nodes.difference(&paired_source_nodes).count()
                    as u32,
                unpaired_destination_node_count: destination_nodes
                    .difference(&paired_destination_nodes)
                    .count() as u32,
                max_residual_m: diagnostics.max_residual_m,
                rms_residual_m: diagnostics.rms_residual_m,
                status: diagnostics.status,
            }
        })
        .collect();

    MeshPeriodicPairsResource {
        revision: snapshot.mesh_revision,
        schema_version: "periodic_pairs.v1".to_string(),
        pairs,
    }
}

#[derive(Debug, Clone)]
struct PeriodicResidualDiagnostics {
    max_residual_m: Option<f64>,
    rms_residual_m: Option<f64>,
    status: String,
}

fn periodic_pair_residuals(
    mesh: &FemMeshPayload,
    boundary_pair: &fullmag_ir::MeshPeriodicBoundaryPairIR,
    node_pairs: &[&fullmag_ir::MeshPeriodicNodePairIR],
) -> PeriodicResidualDiagnostics {
    if node_pairs.is_empty() {
        return PeriodicResidualDiagnostics {
            max_residual_m: None,
            rms_residual_m: None,
            status: "empty".to_string(),
        };
    }
    let Some(translation) = boundary_pair.translation else {
        return PeriodicResidualDiagnostics {
            max_residual_m: None,
            rms_residual_m: None,
            status: "missing_translation".to_string(),
        };
    };

    let mut max_residual = 0.0f64;
    let mut sum_sq = 0.0f64;
    let mut valid_count = 0usize;
    for pair in node_pairs {
        let Some(src) = mesh.nodes.get(pair.node_a as usize) else {
            return PeriodicResidualDiagnostics {
                max_residual_m: None,
                rms_residual_m: None,
                status: "invalid_node_reference".to_string(),
            };
        };
        let Some(dst) = mesh.nodes.get(pair.node_b as usize) else {
            return PeriodicResidualDiagnostics {
                max_residual_m: None,
                rms_residual_m: None,
                status: "invalid_node_reference".to_string(),
            };
        };
        let residual = [
            dst[0] - src[0] - translation[0],
            dst[1] - src[1] - translation[1],
            dst[2] - src[2] - translation[2],
        ];
        let norm =
            (residual[0] * residual[0] + residual[1] * residual[1] + residual[2] * residual[2])
                .sqrt();
        max_residual = max_residual.max(norm);
        sum_sq += norm * norm;
        valid_count += 1;
    }
    let rms = (sum_sq / valid_count as f64).sqrt();
    let tolerance = boundary_pair.tolerance.unwrap_or(1e-9).max(0.0);
    let status = if max_residual > tolerance {
        "residual_exceeds_tolerance"
    } else {
        "valid"
    };

    PeriodicResidualDiagnostics {
        max_residual_m: Some(max_residual),
        rms_residual_m: Some(rms),
        status: status.to_string(),
    }
}

fn boundary_nodes_by_marker(mesh: &FemMeshPayload) -> HashMap<u32, BTreeSet<u32>> {
    let mut nodes_by_marker = HashMap::<u32, BTreeSet<u32>>::new();
    for (face_index, face) in mesh.boundary_faces.iter().enumerate() {
        let Some(marker) = mesh.boundary_markers.get(face_index).copied() else {
            continue;
        };
        let nodes = nodes_by_marker.entry(marker).or_default();
        nodes.extend(face.iter().copied());
    }
    nodes_by_marker
}

fn mesh_manifest_regions(scene: &SceneDocument, mesh: &FemMeshPayload) -> Vec<MeshRegionResource> {
    scene
        .objects
        .iter()
        .filter_map(|object| mesh_manifest_region_for_object(object, mesh))
        .collect()
}

fn mesh_manifest_region_for_object(
    object: &SceneObject,
    mesh: &FemMeshPayload,
) -> Option<MeshRegionResource> {
    let mesh_part_ids = mesh
        .mesh_parts
        .iter()
        .filter(|part| part.object_id.as_deref() == Some(object.id.as_str()))
        .map(|part| part.id.clone())
        .collect::<Vec<_>>();
    let element_count = mesh
        .object_segments
        .iter()
        .filter(|segment| segment.object_id == object.id)
        .map(|segment| segment.element_count)
        .sum::<u32>();
    if mesh_part_ids.is_empty() && element_count == 0 {
        return None;
    }
    let bounds = object_mesh_bounds(object, mesh);
    let region_id = object
        .region_name
        .clone()
        .filter(|value| !value.trim().is_empty())
        .unwrap_or_else(|| format!("region:{}", object.id));
    Some(MeshRegionResource {
        region_id: region_id.clone(),
        name: object
            .region_name
            .clone()
            .filter(|value| !value.trim().is_empty())
            .unwrap_or_else(|| object.name.clone()),
        source_object_ids: vec![object.id.clone()],
        source_region_candidate_id: Some(region_id),
        material_ref: object.material_ref.clone(),
        magnetization_ref: object.magnetization_ref.clone(),
        mesh_part_ids,
        element_count: Some(element_count),
        cell_count: None,
        bounds_min: bounds.map(|(min, _)| min),
        bounds_max: bounds.map(|(_, max)| max),
    })
}

fn object_mesh_bounds(object: &SceneObject, mesh: &FemMeshPayload) -> Option<([f64; 3], [f64; 3])> {
    mesh.mesh_parts
        .iter()
        .filter(|part| part.object_id.as_deref() == Some(object.id.as_str()))
        .filter_map(|part| part.bounds_min.zip(part.bounds_max))
        .fold(None, |current, (min, max)| {
            Some(match current {
                Some((current_min, current_max)) => {
                    (min_vec3(current_min, min), max_vec3(current_max, max))
                }
                None => (min, max),
            })
        })
        .or_else(|| object.geometry.bounds_min.zip(object.geometry.bounds_max))
}

fn min_vec3(a: [f64; 3], b: [f64; 3]) -> [f64; 3] {
    [a[0].min(b[0]), a[1].min(b[1]), a[2].min(b[2])]
}

fn max_vec3(a: [f64; 3], b: [f64; 3]) -> [f64; 3] {
    [a[0].max(b[0]), a[1].max(b[1]), a[2].max(b[2])]
}

fn subset_object_mesh(mesh: &FemMeshPayload, object_id: &str) -> Option<FemMeshPayload> {
    let segment = mesh
        .object_segments
        .iter()
        .find(|segment| segment.object_id == object_id)?;
    let node_start = segment.node_start as usize;
    let node_end = node_start.saturating_add(segment.node_count as usize);
    let element_start = segment.element_start as usize;
    let element_end = element_start.saturating_add(segment.element_count as usize);
    let face_start = segment.boundary_face_start as usize;
    let face_end = face_start.saturating_add(segment.boundary_face_count as usize);

    let nodes = mesh.nodes.get(node_start..node_end)?.to_vec();
    let elements = mesh
        .elements
        .get(element_start..element_end)?
        .iter()
        .map(|element| {
            [
                element[0] - segment.node_start,
                element[1] - segment.node_start,
                element[2] - segment.node_start,
                element[3] - segment.node_start,
            ]
        })
        .collect::<Vec<_>>();
    let boundary_faces = mesh
        .boundary_faces
        .get(face_start..face_end)?
        .iter()
        .map(|face| {
            [
                face[0] - segment.node_start,
                face[1] - segment.node_start,
                face[2] - segment.node_start,
            ]
        })
        .collect::<Vec<_>>();
    let element_markers = mesh
        .element_markers
        .get(element_start..element_end)
        .map(|markers| markers.to_vec())
        .unwrap_or_default();
    let boundary_markers = mesh
        .boundary_markers
        .get(face_start..face_end)
        .map(|markers| markers.to_vec())
        .unwrap_or_default();
    let quality_markers = element_markers.iter().copied().collect::<BTreeSet<_>>();
    let per_domain_quality = quality_markers
        .iter()
        .filter_map(|marker| {
            mesh.per_domain_quality
                .get(marker)
                .cloned()
                .map(|quality| (*marker, quality))
        })
        .collect::<HashMap<_, _>>();

    Some(FemMeshPayload {
        mesh_name: format!("{}:{object_id}", mesh.mesh_name),
        mesh_id: format!("{}:{object_id}", mesh.mesh_id),
        nodes,
        elements,
        element_markers,
        boundary_faces,
        boundary_markers,
        periodic_boundary_pairs: Vec::new(),
        periodic_node_pairs: Vec::new(),
        object_segments: vec![FemMeshObjectSegment {
            object_id: object_id.to_string(),
            geometry_id: segment.geometry_id.clone(),
            node_start: 0,
            node_count: segment.node_count,
            element_start: 0,
            element_count: segment.element_count,
            boundary_face_start: 0,
            boundary_face_count: segment.boundary_face_count,
        }],
        mesh_parts: Vec::new(),
        domain_mesh_mode: mesh.domain_mesh_mode.clone(),
        domain_frame: mesh.domain_frame.clone(),
        generation_id: mesh.generation_id.clone(),
        per_domain_quality,
    })
}

fn subset_part_mesh(mesh: &FemMeshPayload, part_id: &str) -> Option<FemMeshPayload> {
    let part = mesh.mesh_parts.iter().find(|part| part.id == part_id)?;
    let source_node_indices = if part.node_indices.is_empty() {
        let start = part.node_start as usize;
        let end = start.saturating_add(part.node_count as usize);
        (start..end).map(|index| index as u32).collect::<Vec<_>>()
    } else {
        part.node_indices.clone()
    };
    let mut node_map = HashMap::with_capacity(source_node_indices.len());
    let mut nodes = Vec::with_capacity(source_node_indices.len());
    for source_index in source_node_indices {
        let node = *mesh.nodes.get(source_index as usize)?;
        let target_index = nodes.len() as u32;
        node_map.insert(source_index, target_index);
        nodes.push(node);
    }

    let element_start = part.element_start as usize;
    let element_end = element_start.saturating_add(part.element_count as usize);
    let mut elements = Vec::new();
    let mut element_markers = Vec::new();
    for (source_element_index, element) in mesh
        .elements
        .get(element_start..element_end)?
        .iter()
        .enumerate()
    {
        let remapped = [
            *node_map.get(&element[0])?,
            *node_map.get(&element[1])?,
            *node_map.get(&element[2])?,
            *node_map.get(&element[3])?,
        ];
        elements.push(remapped);
        if let Some(marker) = mesh
            .element_markers
            .get(element_start + source_element_index)
        {
            element_markers.push(*marker);
        }
    }

    let face_indices = if part.boundary_face_indices.is_empty() {
        let start = part.boundary_face_start as usize;
        let end = start.saturating_add(part.boundary_face_count as usize);
        (start..end).map(|index| index as u32).collect::<Vec<_>>()
    } else {
        part.boundary_face_indices.clone()
    };
    let mut boundary_faces = Vec::new();
    let mut boundary_markers = Vec::new();
    for face_index in face_indices {
        let face = mesh.boundary_faces.get(face_index as usize)?;
        let remapped = [
            *node_map.get(&face[0])?,
            *node_map.get(&face[1])?,
            *node_map.get(&face[2])?,
        ];
        boundary_faces.push(remapped);
        if let Some(marker) = mesh.boundary_markers.get(face_index as usize) {
            boundary_markers.push(*marker);
        }
    }

    let surface_faces = part
        .surface_faces
        .iter()
        .filter_map(|face| {
            Some([
                *node_map.get(&face[0])?,
                *node_map.get(&face[1])?,
                *node_map.get(&face[2])?,
            ])
        })
        .collect::<Vec<_>>();
    let quality_markers = element_markers.iter().copied().collect::<BTreeSet<_>>();
    let per_domain_quality = quality_markers
        .iter()
        .filter_map(|marker| {
            mesh.per_domain_quality
                .get(marker)
                .cloned()
                .map(|quality| (*marker, quality))
        })
        .collect::<HashMap<_, _>>();
    let object_segments = part
        .object_id
        .as_ref()
        .map(|object_id| {
            vec![FemMeshObjectSegment {
                object_id: object_id.clone(),
                geometry_id: part.geometry_id.clone(),
                node_start: 0,
                node_count: nodes.len() as u32,
                element_start: 0,
                element_count: elements.len() as u32,
                boundary_face_start: 0,
                boundary_face_count: boundary_faces.len() as u32,
            }]
        })
        .unwrap_or_default();
    let mesh_part = FemMeshPartPayload {
        id: part.id.clone(),
        label: part.label.clone(),
        role: part.role.clone(),
        object_id: part.object_id.clone(),
        geometry_id: part.geometry_id.clone(),
        material_id: part.material_id.clone(),
        element_start: 0,
        element_count: elements.len() as u32,
        boundary_face_start: 0,
        boundary_face_count: boundary_faces.len() as u32,
        boundary_face_indices: (0..boundary_faces.len() as u32).collect(),
        node_start: 0,
        node_count: nodes.len() as u32,
        node_indices: (0..nodes.len() as u32).collect(),
        surface_faces,
        bounds_min: part.bounds_min,
        bounds_max: part.bounds_max,
    };

    Some(FemMeshPayload {
        mesh_name: format!("{}:part:{part_id}", mesh.mesh_name),
        mesh_id: format!("{}:part:{part_id}", mesh.mesh_id),
        nodes,
        elements,
        element_markers,
        boundary_faces,
        boundary_markers,
        periodic_boundary_pairs: Vec::new(),
        periodic_node_pairs: Vec::new(),
        object_segments,
        mesh_parts: vec![mesh_part],
        domain_mesh_mode: mesh.domain_mesh_mode.clone(),
        domain_frame: mesh.domain_frame.clone(),
        generation_id: mesh.generation_id.clone(),
        per_domain_quality,
    })
}
