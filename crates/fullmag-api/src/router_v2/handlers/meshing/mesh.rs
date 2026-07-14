//! Mesh resource endpoints.

use std::collections::{BTreeMap, BTreeSet, HashMap};
use std::fs;
use std::sync::Arc;

use axum::extract::{Path, Query, State};
use axum::http::{HeaderMap, HeaderValue, StatusCode};
use axum::response::IntoResponse;
use axum::Json;
use serde::{Deserialize, Serialize};
use serde_json::{json, Value};

use crate::error::ApiError;
use crate::fem_cross_section::{
    cross_section_quality_from_fmmq, cross_section_quality_from_parent_tets,
    per_element_quality_metric_from_fmmq, serialize_cross_section_fmcs,
    serialize_cross_section_quality_fmqs, CrossSectionQualityMetric,
};
use crate::fem_cross_section_image::{
    render_cross_section_png, validate_cross_section_image_query, CrossSectionImageColorScale,
    CrossSectionImageRenderOptions,
};
use crate::fem_slice_overlay::{collect_fem_slice_overlay, FemSliceOverlayInput};
use crate::field_slice::{resolve_slice_query, FieldSliceQuery, SlicePlane};
use crate::field_store::serialize_fem_mesh_topology_binary_v1;
use crate::schemas::mesh::{
    MeshActiveBuildResource, MeshBuildDiagnosticsResource, MeshBuildHistoryResource,
    MeshBuildPolicyDiffResource, MeshBuildProvenanceResource, MeshBuildPublishedResourcesResource,
    MeshCapabilitiesResource, MeshHistogramBinElementsResource, MeshInterfaceConfigReplaceRequest,
    MeshInterfaceConfigResource, MeshInterfaceQualityResource, MeshInterfaceReportResource,
    MeshLastSuccessfulBuildResource, MeshObjectConfigEntryResource, MeshObjectConfigReplaceRequest,
    MeshObjectConfigResource, MeshObjectQualityResource, MeshObjectReportResource,
    MeshObjectSegmentResource, MeshObjectSizeFieldResource, MeshPartResource,
    MeshPeriodicBoundaryFacePairResource, MeshPeriodicDomainNodePairCountsResource,
    MeshPeriodicPairResource, MeshPeriodicPairsResource, MeshQualityGatesResource,
    MeshRealizedSizeFieldResource, MeshRealizedSizeFieldsPayload, MeshRealizedSizeFieldsResource,
    MeshRegionMembershipResource, MeshRegionQualityResource, MeshRegionResource,
    MeshSemanticsResource, MeshSharedDomainBuildReportResource,
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

#[derive(Debug, Clone, Deserialize, utoipa::IntoParams)]
#[into_params(parameter_in = Query)]
pub struct MeshSharedDomainCrossSectionQuery {
    pub plane: SlicePlane,
    pub position_percent: f64,
    pub include_polygons: Option<bool>,
    pub include_wireframe: Option<bool>,
}

#[derive(Debug, Clone, Deserialize, utoipa::IntoParams)]
#[into_params(parameter_in = Query)]
pub struct MeshSharedDomainCrossSectionQualityQuery {
    pub plane: SlicePlane,
    pub position_percent: f64,
    pub metric: CrossSectionQualityMetric,
}

#[derive(Debug, Clone, Deserialize, utoipa::IntoParams)]
#[into_params(parameter_in = Query)]
pub struct MeshSharedDomainCrossSectionImageQuery {
    pub plane: SlicePlane,
    pub position_percent: f64,
    pub metric: CrossSectionQualityMetric,
    pub color_scale: Option<CrossSectionImageColorScale>,
    pub resolution: Option<u32>,
    pub rotation_degrees: Option<f64>,
    pub wireframe: Option<bool>,
    pub legend: Option<bool>,
    pub shrink_factor: Option<f64>,
    pub filter_expression: Option<String>,
    pub edge_width: Option<f64>,
    pub dpr: Option<f64>,
}

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
            let config = optional_json_object_map(
                current_object_mesh_config(object),
                "object mesh semantics config",
            )?;
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
            topology_fingerprint: fullmag_runner::fem_mesh_topology_fingerprint(mesh),
            generation_id: mesh.generation_id.clone(),
            domain_mesh_mode: mesh.domain_mesh_mode.clone(),
            object_segment_count: mesh.object_segments.len() as u32,
            mesh_part_count: mesh.mesh_parts.len() as u32,
            build_report: mesh
                .build_report
                .as_ref()
                .and_then(|report| serde_json::to_value(report).ok()),
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
    let provenance = mesh_build_provenance(&snapshot);
    let body = MeshActiveBuildResource {
        revision: snapshot.mesh_build_revision,
        source_scene_revision: provenance.source_scene_revision,
        geometry_realization_revision: provenance.geometry_realization_revision,
        provenance: Some(mesh_build_provenance_resource(
            &snapshot,
            mesh_workspace,
            provenance,
        )),
        published_resources: mesh_build_published_resources(&snapshot, mesh_workspace),
        resolved_policy: first_workspace_value(
            mesh_workspace,
            &[&["resolved_policy"], &["active_build", "resolved_policy"]],
        ),
        policy_diff: mesh_build_policy_diff(mesh_workspace),
        active_build: mesh_workspace.get("active_build").cloned(),
        mesh_pipeline_status: mesh_workspace.get("mesh_pipeline_status").cloned(),
        effective_airbox_target: mesh_workspace.get("effective_airbox_target").cloned(),
        effective_per_object_targets: mesh_workspace.get("effective_per_object_targets").cloned(),
        last_build_summary: mesh_workspace.get("last_build_summary").cloned(),
        shared_domain_build_report: typed_shared_domain_build_report(mesh_workspace),
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

fn mesh_build_provenance_resource(
    snapshot: &SessionStateResponse,
    mesh_workspace: &Value,
    provenance: MeshBuildProvenance,
) -> MeshBuildProvenanceResource {
    MeshBuildProvenanceResource {
        command_id: first_workspace_string(
            mesh_workspace,
            &[
                &["active_build", "command_id"],
                &["last_build_summary", "command_id"],
            ],
        ),
        build_id: first_workspace_string(
            mesh_workspace,
            &[
                &["active_build", "build_id"],
                &["last_build_summary", "build_id"],
            ],
        ),
        mesh_revision: Some(snapshot.mesh_revision),
        source_scene_revision: first_workspace_u64(
            mesh_workspace,
            &[
                &["active_build", "source_scene_revision"],
                &["last_build_summary", "source_scene_revision"],
            ],
        )
        .or(provenance.source_scene_revision),
        geometry_realization_revision: first_workspace_u64(
            mesh_workspace,
            &[
                &["active_build", "geometry_realization_revision"],
                &["last_build_summary", "geometry_realization_revision"],
                &[
                    "last_build_summary",
                    "geometry_realization",
                    "realization_revision",
                ],
            ],
        )
        .or(provenance.geometry_realization_revision),
        requested_policy_revision: first_workspace_u64(
            mesh_workspace,
            &[
                &["active_build", "requested_policy_revision"],
                &["last_build_summary", "requested_policy_revision"],
            ],
        ),
        completed_at_unix_ms: first_workspace_u128(
            mesh_workspace,
            &[
                &["active_build", "completed_at_unix_ms"],
                &["last_build_summary", "completed_at_unix_ms"],
            ],
        ),
        duration_ms: first_workspace_u64(
            mesh_workspace,
            &[
                &["active_build", "duration_ms"],
                &["last_build_summary", "duration_ms"],
            ],
        ),
    }
}

fn mesh_build_published_resources(
    snapshot: &SessionStateResponse,
    mesh_workspace: &Value,
) -> Option<MeshBuildPublishedResourcesResource> {
    if let Some(value) = first_workspace_value(
        mesh_workspace,
        &[
            &["published_resources"],
            &["active_build", "published_resources"],
            &["last_build_summary", "published_resources"],
        ],
    ) {
        if let Ok(resource) = serde_json::from_value(value) {
            return Some(resource);
        }
    }
    if snapshot.mesh_revision == 0 && snapshot.mesh_build_revision == 0 {
        return None;
    }
    Some(MeshBuildPublishedResourcesResource {
        mesh_revision: Some(snapshot.mesh_revision),
        mesh_build_revision: Some(snapshot.mesh_build_revision),
        manifest: Some("/v2/sessions/current/meshing/meshes/shared-domain/manifest".to_string()),
        quality: Some("/v2/sessions/current/meshing/meshes/shared-domain/quality".to_string()),
        realized_size_fields: Some(
            "/v2/sessions/current/meshing/meshes/shared-domain/realized-size-fields".to_string(),
        ),
    })
}

fn mesh_build_policy_diff(mesh_workspace: &Value) -> Option<Vec<MeshBuildPolicyDiffResource>> {
    first_workspace_value(
        mesh_workspace,
        &[&["policy_diff"], &["active_build", "policy_diff"]],
    )
    .and_then(|value| serde_json::from_value(value).ok())
}

fn typed_shared_domain_build_report(
    mesh_workspace: &Value,
) -> Option<MeshSharedDomainBuildReportResource> {
    first_workspace_value(
        mesh_workspace,
        &[
            &["shared_domain_build_report"],
            &["last_build_summary", "shared_domain_build_report"],
            &["shared_domain_report", "shared_domain_build_report"],
        ],
    )
    .and_then(|value| serde_json::from_value(value).ok())
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
    let provenance = mesh_build_provenance(&snapshot);
    let body = MeshLastSuccessfulBuildResource {
        revision: snapshot.mesh_build_revision,
        source_scene_revision: provenance.source_scene_revision,
        geometry_realization_revision: provenance.geometry_realization_revision,
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
    let config_state = current_universe_mesh_config(scene);
    let effective_config = Some(json_object_map(
        effective_universe_mesh_config(config_state)?,
        "effective universe mesh config",
    )?);
    let config = optional_json_object_map(config_state, "universe mesh config")?;
    Ok(Json(MeshUniverseConfigResource {
        revision: snapshot.mesh_revision,
        config,
        effective_config,
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
        serde_json::from_value(serde_json::to_value(req.config).map_err(|error| {
            ApiError::bad_request(format!("invalid universe mesh config payload: {error}"))
        })?)
        .map_err(|error| {
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
    let effective_config = Some(json_object_map(
        effective_universe_mesh_config(Some(config))?,
        "effective committed universe mesh config",
    )?);
    let config = json_object_map(
        serde_json::to_value(config).map_err(|error| {
            ApiError::internal(format!(
                "failed to serialize committed universe mesh config: {error}"
            ))
        })?,
        "committed universe mesh config",
    )?;
    let revision = current_snapshot(&state).await?.mesh_revision;
    Ok(Json(MeshUniverseConfigResource {
        revision,
        config: Some(config),
        effective_config,
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
    let quality = Some(universe_quality(mesh_workspace, snapshot.fem_mesh.as_ref()));
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
    let config = json_object_map(
        serde_json::to_value(&scene.study.shared_domain_mesh).map_err(|error| {
            ApiError::internal(format!(
                "failed to serialize shared-domain mesh config: {error}"
            ))
        })?,
        "shared-domain mesh config",
    )?;
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
    let config: ScriptBuilderMeshState =
        serde_json::from_value(serde_json::to_value(req.config).map_err(|error| {
            ApiError::bad_request(format!(
                "invalid shared-domain mesh config payload: {error}"
            ))
        })?)
        .map_err(|error| {
            ApiError::bad_request(format!(
                "invalid shared-domain mesh config payload: {error}"
            ))
        })?;
    let mut scene = crate::get_or_load_current_live_scene_document(&state).await?;
    scene.study.shared_domain_mesh = config.clone();
    scene.study.mesh_defaults = config.clone();
    let committed = crate::commit_current_live_scene_document(&state, scene).await?;
    let config = json_object_map(
        serde_json::to_value(&committed.study.shared_domain_mesh).map_err(|error| {
            ApiError::internal(format!(
                "failed to serialize committed shared-domain mesh config: {error}"
            ))
        })?,
        "committed shared-domain mesh config",
    )?;
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
        "mesh_statistics": workspace_mesh_statistics(mesh_workspace).cloned().unwrap_or(Value::Null),
        "mesh_cost_report": mesh_workspace.get("mesh_cost_report").cloned().unwrap_or(Value::Null),
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
    path = "/v2/sessions/current/meshing/meshes/shared-domain/cross-section",
    params(MeshSharedDomainCrossSectionQuery),
    responses(
        (status = 200, description = "Binary shared-domain FEM cross-section geometry (FMCS)", content_type = "application/octet-stream"),
        (status = 304, description = "Cross-section geometry not modified for the supplied ETag"),
        (status = 204, description = "Not applicable (FDM)"),
        (status = 404, description = "No active workspace"),
        (status = 409, description = "FEM topology unavailable for cross-section"),
    ),
    tag = "meshing"
)]
pub async fn get_mesh_shared_domain_cross_section(
    State(state): State<Arc<AppState>>,
    headers: HeaderMap,
    Query(query): Query<MeshSharedDomainCrossSectionQuery>,
) -> Result<axum::response::Response, ApiError> {
    if !query.position_percent.is_finite()
        || query.position_percent < 0.0
        || query.position_percent > 100.0
    {
        return Err(ApiError::bad_request(
            "invalid_query: position_percent must be finite and in [0, 100]",
        ));
    }

    let snapshot = current_snapshot(&state).await?;
    let Some(mesh) = snapshot.fem_mesh.as_ref() else {
        return Ok(StatusCode::NO_CONTENT.into_response());
    };
    let cut_norm = query.position_percent / 100.0;
    let resolved = resolve_slice_query(
        &FieldSliceQuery {
            plane: query.plane,
            component: None,
            cut_world: None,
            cut_norm: Some(cut_norm),
            x_size: None,
            y_size: None,
            max_points: None,
            include_arrows: None,
            arrow_every: None,
            max_arrows: None,
        },
        1,
    )?;
    let overlay = collect_fem_slice_overlay(
        FemSliceOverlayInput {
            nodes: &mesh.nodes,
            elements: &mesh.elements,
            element_markers: &mesh.element_markers,
        },
        &resolved,
    )?;
    let include_polygons = query.include_polygons.unwrap_or(true);
    let include_wireframe = query.include_wireframe.unwrap_or(true);
    let binary = serialize_cross_section_fmcs(&overlay, include_polygons, include_wireframe);
    let generation_id = mesh.generation_id.as_deref().unwrap_or("no-generation");
    let etag = crate::router_v2::handlers::shared::stable_strong_etag(&format!(
        "mesh-shared-domain-cross-section:{}:{generation_id}:{}:{:.17e}:{}:{}:fmcs-v2",
        snapshot.mesh_revision,
        overlay.plane.as_str(),
        overlay.cut_norm,
        include_polygons,
        include_wireframe,
    ));
    Ok(crate::router_v2::handlers::shared::conditional_binary_response(&headers, &etag, binary))
}

#[utoipa::path(
    get,
    path = "/v2/sessions/current/meshing/meshes/shared-domain/cross-section/image",
    params(MeshSharedDomainCrossSectionImageQuery),
    responses(
        (status = 200, description = "Server-rendered shared-domain FEM cross-section image", content_type = "image/png"),
        (status = 304, description = "Cross-section image not modified for the supplied ETag"),
        (status = 204, description = "No FEM mesh or no data for the requested metric"),
        (status = 400, description = "Invalid query parameters"),
        (status = 404, description = "No active workspace"),
        (status = 409, description = "FEM topology unavailable for cross-section"),
    ),
    tag = "meshing"
)]
pub async fn get_mesh_shared_domain_cross_section_image(
    State(state): State<Arc<AppState>>,
    headers: HeaderMap,
    Query(query): Query<MeshSharedDomainCrossSectionImageQuery>,
) -> Result<axum::response::Response, ApiError> {
    let color_scale = query.color_scale.unwrap_or_default();
    let resolution = query.resolution.unwrap_or(1024);
    let rotation_degrees = query.rotation_degrees.unwrap_or(0.0);
    let wireframe = query.wireframe.unwrap_or(true);
    let legend = query.legend.unwrap_or(true);
    let shrink_factor = query.shrink_factor.unwrap_or(1.0);
    let edge_width = query.edge_width.unwrap_or(1.5);
    let dpr = query.dpr.unwrap_or(1.0);
    validate_cross_section_image_query(
        query.position_percent,
        resolution,
        rotation_degrees,
        shrink_factor,
        edge_width,
        dpr,
    )?;

    let snapshot = current_snapshot(&state).await?;
    let Some(mesh) = snapshot.fem_mesh.as_ref() else {
        return Ok(StatusCode::NO_CONTENT.into_response());
    };
    let artifact = snapshot
        .mesh_workspace
        .as_ref()
        .map(read_mesh_quality_data_artifact)
        .transpose()?
        .flatten();
    let cut_norm = query.position_percent / 100.0;
    let resolved = resolve_slice_query(
        &FieldSliceQuery {
            plane: query.plane,
            component: None,
            cut_world: None,
            cut_norm: Some(cut_norm),
            x_size: None,
            y_size: None,
            max_points: None,
            include_arrows: None,
            arrow_every: None,
            max_arrows: None,
        },
        1,
    )?;
    let overlay = collect_fem_slice_overlay(
        FemSliceOverlayInput {
            nodes: &mesh.nodes,
            elements: &mesh.elements,
            element_markers: &mesh.element_markers,
        },
        &resolved,
    )?;
    let (values, quality_source) = if let Some(artifact) = artifact.as_ref() {
        if let Some(values) =
            cross_section_quality_from_fmmq(&overlay, &artifact.bytes, query.metric)?
        {
            (
                values,
                format!(
                    "fmmq:{}:{}:{}",
                    artifact.path, artifact.byte_size, artifact.element_count
                ),
            )
        } else if let Some(values) = cross_section_quality_from_parent_tets(
            &overlay,
            &mesh.nodes,
            &mesh.elements,
            query.metric,
        )? {
            (values, "parent-tet-geometry-v1".to_string())
        } else {
            return Ok(StatusCode::NO_CONTENT.into_response());
        }
    } else if let Some(values) =
        cross_section_quality_from_parent_tets(&overlay, &mesh.nodes, &mesh.elements, query.metric)?
    {
        (values, "parent-tet-geometry-v1".to_string())
    } else {
        return Ok(StatusCode::NO_CONTENT.into_response());
    };

    let rendered = render_cross_section_png(
        &overlay,
        &values,
        CrossSectionImageRenderOptions {
            color_scale,
            legend,
            metric: query.metric,
            resolution,
            rotation_degrees,
            shrink_factor,
            wireframe,
            edge_width,
            dpr,
        },
        query.filter_expression.as_deref(),
    )?;
    let generation_id = mesh.generation_id.as_deref().unwrap_or("no-generation");
    let filter = query.filter_expression.as_deref().unwrap_or("");
    let etag = crate::router_v2::handlers::shared::stable_strong_etag(&format!(
        "mesh-shared-domain-cross-section-image:{}:{generation_id}:{}:{:.17e}:{}:{}:{}:{:.17e}:{}:{:.17e}:{}:{}:{}:{:.17e}:{:.17e}:png-v3",
        snapshot.mesh_revision,
        overlay.plane.as_str(),
        overlay.cut_norm,
        query.metric.as_str(),
        color_scale.as_str(),
        resolution,
        rotation_degrees,
        wireframe,
        shrink_factor,
        legend,
        filter,
        quality_source,
        edge_width,
        dpr,
    ));
    let mut response =
        crate::router_v2::handlers::shared::conditional_binary_response_with_content_type(
            &headers,
            &etag,
            rendered.png_bytes,
            HeaderValue::from_static("image/png"),
        );
    response.headers_mut().insert(
        "x-fullmag-resource-key",
        HeaderValue::from_static("meshing/meshes/shared-domain/cross-section/image"),
    );
    response.headers_mut().insert(
        "x-fullmag-renderer",
        HeaderValue::from_static("cross-section-image-v2"),
    );
    if let Ok(w) = HeaderValue::from_str(&rendered.width.to_string()) {
        response.headers_mut().insert("x-fullmag-image-width", w);
    }
    if let Ok(h) = HeaderValue::from_str(&rendered.height.to_string()) {
        response.headers_mut().insert("x-fullmag-image-height", h);
    }
    Ok(response)
}

#[utoipa::path(
    get,
    path = "/v2/sessions/current/meshing/meshes/shared-domain/cross-section/quality",
    params(MeshSharedDomainCrossSectionQualityQuery),
    responses(
        (status = 200, description = "Binary shared-domain FEM cross-section quality values (FMQS)", content_type = "application/octet-stream"),
        (status = 304, description = "Cross-section quality not modified for the supplied ETag"),
        (status = 204, description = "No per-element quality data artifact or requested metric available"),
        (status = 404, description = "No active workspace"),
        (status = 409, description = "FEM topology unavailable for cross-section"),
    ),
    tag = "meshing"
)]
pub async fn get_mesh_shared_domain_cross_section_quality(
    State(state): State<Arc<AppState>>,
    headers: HeaderMap,
    Query(query): Query<MeshSharedDomainCrossSectionQualityQuery>,
) -> Result<axum::response::Response, ApiError> {
    if !query.position_percent.is_finite()
        || query.position_percent < 0.0
        || query.position_percent > 100.0
    {
        return Err(ApiError::bad_request(
            "invalid_query: position_percent must be finite and in [0, 100]",
        ));
    }

    let snapshot = current_snapshot(&state).await?;
    let Some(mesh) = snapshot.fem_mesh.as_ref() else {
        return Ok(StatusCode::NO_CONTENT.into_response());
    };
    let artifact = snapshot
        .mesh_workspace
        .as_ref()
        .map(read_mesh_quality_data_artifact)
        .transpose()?
        .flatten();
    let cut_norm = query.position_percent / 100.0;
    let resolved = resolve_slice_query(
        &FieldSliceQuery {
            plane: query.plane,
            component: None,
            cut_world: None,
            cut_norm: Some(cut_norm),
            x_size: None,
            y_size: None,
            max_points: None,
            include_arrows: None,
            arrow_every: None,
            max_arrows: None,
        },
        1,
    )?;
    let overlay = collect_fem_slice_overlay(
        FemSliceOverlayInput {
            nodes: &mesh.nodes,
            elements: &mesh.elements,
            element_markers: &mesh.element_markers,
        },
        &resolved,
    )?;
    let (values, quality_source) = if let Some(artifact) = artifact.as_ref() {
        if let Some(values) =
            cross_section_quality_from_fmmq(&overlay, &artifact.bytes, query.metric)?
        {
            (
                values,
                format!(
                    "fmmq:{}:{}:{}",
                    artifact.path, artifact.byte_size, artifact.element_count
                ),
            )
        } else if let Some(values) = cross_section_quality_from_parent_tets(
            &overlay,
            &mesh.nodes,
            &mesh.elements,
            query.metric,
        )? {
            (values, "parent-tet-geometry-v1".to_string())
        } else {
            return Ok(StatusCode::NO_CONTENT.into_response());
        }
    } else if let Some(values) =
        cross_section_quality_from_parent_tets(&overlay, &mesh.nodes, &mesh.elements, query.metric)?
    {
        (values, "parent-tet-geometry-v1".to_string())
    } else {
        return Ok(StatusCode::NO_CONTENT.into_response());
    };
    let binary = serialize_cross_section_quality_fmqs(&values);
    let generation_id = mesh.generation_id.as_deref().unwrap_or("no-generation");
    let etag = crate::router_v2::handlers::shared::stable_strong_etag(&format!(
        "mesh-shared-domain-cross-section-quality:{}:{generation_id}:{}:{:.17e}:{:?}:{}:fmqs-v1",
        snapshot.mesh_revision,
        overlay.plane.as_str(),
        overlay.cut_norm,
        query.metric,
        quality_source,
    ));
    Ok(crate::router_v2::handlers::shared::conditional_binary_response(&headers, &etag, binary))
}

#[utoipa::path(
    get,
    path = "/v2/sessions/current/meshing/meshes/shared-domain/quality/per-element",
    params(
        ("If-None-Match" = Option<String>, Header, description = "Strong ETag from a previous per-element quality response")
    ),
    responses(
        (status = 200, description = "Binary per-element shared-domain mesh quality data (FMMQ)", content_type = "application/octet-stream"),
        (status = 304, description = "Per-element mesh quality data not modified for the supplied ETag"),
        (status = 204, description = "No per-element quality data artifact available"),
        (status = 404, description = "No active workspace"),
    ),
    tag = "meshing"
)]
pub async fn get_mesh_shared_domain_quality_data(
    State(state): State<Arc<AppState>>,
    headers: HeaderMap,
) -> Result<axum::response::Response, ApiError> {
    let snapshot = current_snapshot(&state).await?;
    let mesh_workspace = current_mesh_workspace(&snapshot)?;
    let Some(artifact) = read_mesh_quality_data_artifact(mesh_workspace)? else {
        return Ok(StatusCode::NO_CONTENT.into_response());
    };
    let etag = crate::router_v2::handlers::shared::stable_strong_etag(&format!(
        "mesh-shared-domain-quality-data:{}:{}:{}:{}",
        snapshot.mesh_revision, artifact.path, artifact.byte_size, artifact.element_count,
    ));
    Ok(
        crate::router_v2::handlers::shared::conditional_binary_response(
            &headers,
            &etag,
            artifact.bytes,
        ),
    )
}

struct MeshQualityDataArtifact {
    bytes: Vec<u8>,
    byte_size: u64,
    element_count: u64,
    path: String,
}

fn read_mesh_quality_data_artifact(
    mesh_workspace: &Value,
) -> Result<Option<MeshQualityDataArtifact>, ApiError> {
    let Some(artifact) = first_workspace_value(
        mesh_workspace,
        &[
            &["quality_data_artifact"],
            &["mesh_quality_data_artifact"],
            &["last_build_summary", "quality_data_artifact"],
        ],
    ) else {
        return Ok(None);
    };
    let Some(path) = artifact.get("path").and_then(Value::as_str) else {
        return Ok(None);
    };
    let bytes = fs::read(path).map_err(|error| {
        ApiError::internal(format!(
            "failed to read mesh quality data artifact {path}: {error}"
        ))
    })?;
    if !bytes.starts_with(b"FMMQ") {
        return Err(ApiError::internal(format!(
            "mesh quality data artifact {path} is not an FMMQ payload"
        )));
    }
    let byte_size = artifact
        .get("byte_size")
        .and_then(Value::as_u64)
        .unwrap_or(bytes.len() as u64);
    let element_count = artifact
        .get("element_count")
        .and_then(Value::as_u64)
        .unwrap_or_default();
    Ok(Some(MeshQualityDataArtifact {
        bytes,
        byte_size,
        element_count,
        path: path.to_string(),
    }))
}

#[utoipa::path(
    get,
    path = "/v2/sessions/current/meshing/meshes/shared-domain/realized-size-fields",
    responses(
        (status = 200, description = "Shared-domain realized mesh size fields", body = MeshRealizedSizeFieldsResource),
        (status = 404, description = "No active workspace"),
    ),
    tag = "meshing"
)]
pub async fn get_mesh_realized_size_fields(
    State(state): State<Arc<AppState>>,
) -> Result<Json<MeshRealizedSizeFieldsResource>, ApiError> {
    let snapshot = current_snapshot(&state).await?;
    let mesh_workspace = current_mesh_workspace(&snapshot)?;
    let realized_size_fields = normalize_realized_size_fields_payload(first_workspace_value(
        mesh_workspace,
        &[
            &["size_fields_realized"],
            &["realized_size_fields"],
            &["last_build_summary", "size_fields_realized"],
            &["last_build_summary", "realized_size_fields"],
            &["shared_domain_report", "size_fields_realized"],
            &["shared_domain_report", "realized_size_fields"],
        ],
    ));
    Ok(Json(MeshRealizedSizeFieldsResource {
        revision: snapshot.mesh_revision,
        realized_size_fields,
    }))
}

fn normalize_realized_size_fields_payload(raw: Option<Value>) -> MeshRealizedSizeFieldsPayload {
    let Some(value) = raw else {
        return MeshRealizedSizeFieldsPayload {
            source: Some("unavailable".to_string()),
            reason: Some(
                "size_fields_realized is missing from the current mesh workspace/build report"
                    .to_string(),
            ),
            fields: Vec::new(),
        };
    };

    match value {
        Value::Array(fields) => MeshRealizedSizeFieldsPayload {
            source: None,
            reason: None,
            fields: fields
                .into_iter()
                .filter_map(realized_size_field_from_value)
                .collect(),
        },
        Value::Object(mut object) => {
            let fields_value = object.remove("fields");
            let fields = match fields_value {
                Some(Value::Array(fields)) => fields
                    .into_iter()
                    .filter_map(realized_size_field_from_value)
                    .collect(),
                Some(field) => realized_size_field_from_value(field).into_iter().collect(),
                None => realized_size_field_from_value(Value::Object(object.clone()))
                    .into_iter()
                    .collect(),
            };
            MeshRealizedSizeFieldsPayload {
                source: object
                    .get("source")
                    .and_then(Value::as_str)
                    .map(ToString::to_string),
                reason: object
                    .get("reason")
                    .and_then(Value::as_str)
                    .map(ToString::to_string),
                fields,
            }
        }
        _ => MeshRealizedSizeFieldsPayload {
            source: Some("unavailable".to_string()),
            reason: Some("size_fields_realized has an unsupported payload shape".to_string()),
            fields: Vec::new(),
        },
    }
}

fn realized_size_field_from_value(value: Value) -> Option<MeshRealizedSizeFieldResource> {
    let Value::Object(mut object) = value else {
        return None;
    };
    let kind = object
        .remove("kind")
        .and_then(string_from_value)
        .filter(|value| !value.trim().is_empty())?;
    let applied = object.get("applied").and_then(Value::as_bool);
    let status = object
        .remove("status")
        .and_then(string_from_value)
        .filter(|value| !value.trim().is_empty())
        .unwrap_or_else(|| {
            if applied == Some(true) {
                "applied".to_string()
            } else {
                "requested".to_string()
            }
        });
    let source = object.remove("source").and_then(string_from_value);
    let reason = object.remove("reason").and_then(string_from_value);
    let gmsh_field_id = object
        .remove("gmsh_field_id")
        .and_then(|value| value.as_i64());
    let params = object.remove("params");
    Some(MeshRealizedSizeFieldResource {
        kind,
        status,
        source,
        reason,
        gmsh_field_id,
        applied,
        params,
    })
}

fn string_from_value(value: Value) -> Option<String> {
    match value {
        Value::String(value) => Some(value),
        _ => None,
    }
}

#[utoipa::path(
    get,
    path = "/v2/sessions/current/meshing/meshes/shared-domain/quality-gates",
    responses(
        (status = 200, description = "Shared-domain mesh quality gates", body = MeshQualityGatesResource),
        (status = 404, description = "No active workspace"),
    ),
    tag = "meshing"
)]
pub async fn get_mesh_quality_gates(
    State(state): State<Arc<AppState>>,
) -> Result<Json<MeshQualityGatesResource>, ApiError> {
    let snapshot = current_snapshot(&state).await?;
    let mesh_workspace = current_mesh_workspace(&snapshot)?;
    let gates = first_workspace_value(
        mesh_workspace,
        &[
            &["mesh_quality_gates"],
            &["quality_gates"],
            &["last_build_summary", "mesh_quality_gates"],
            &["last_build_summary", "quality_gates"],
            &["shared_domain_report", "mesh_quality_gates"],
            &["shared_domain_report", "quality_gates"],
        ],
    )
    .or_else(|| Some(derive_mesh_quality_gates(&snapshot, mesh_workspace)));
    Ok(Json(MeshQualityGatesResource {
        revision: snapshot.mesh_revision,
        gates,
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
            let topology_hash = fullmag_runner::fem_mesh_topology_fingerprint(mesh);
            let body = MeshSharedDomainManifestResource {
                revision: snapshot.mesh_revision,
                source_scene_revision: provenance.source_scene_revision,
                geometry_realization_revision: provenance.geometry_realization_revision,
                mesh_name: mesh.mesh_name.clone(),
                mesh_id: mesh.mesh_id.clone(),
                topology_fingerprint: topology_hash.clone(),
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
                "mesh-shared-domain-manifest:{generation_id}:{topology_hash}:{}:{}:{}",
                snapshot.mesh_revision,
                provenance
                    .source_scene_revision
                    .map(|revision| revision.to_string())
                    .unwrap_or_else(|| "unknown".to_string()),
                provenance
                    .geometry_realization_revision
                    .map(|revision| revision.to_string())
                    .unwrap_or_else(|| "unknown".to_string())
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
    params(
        ("If-None-Match" = Option<String>, Header, description = "Strong ETag from a previous shared-domain topology response"),
        ("Range" = Option<String>, Header, description = "Optional single byte range for chunked FMMT topology reads")
    ),
    responses(
        (status = 200, description = "Binary shared-domain FEM topology (FMMT)", content_type = "application/octet-stream"),
        (status = 206, description = "Partial shared-domain FEM topology range (FMMT)", content_type = "application/octet-stream"),
        (status = 304, description = "Shared-domain topology not modified for the supplied ETag"),
        (status = 416, description = "Requested topology byte range is not satisfiable"),
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
            let topology_hash = fullmag_runner::fem_mesh_topology_fingerprint(mesh);
            let etag = crate::router_v2::handlers::shared::stable_strong_etag(&format!(
                "mesh-shared-domain-topology:{generation_id}:{topology_hash}:{}",
                snapshot.mesh_revision,
            ));
            let mut response = crate::router_v2::handlers::shared::conditional_binary_response(
                &headers, &etag, binary,
            );
            crate::router_v2::handlers::shared::insert_mesh_topology_hash_header(
                &mut response,
                &topology_hash,
            );
            Ok(response)
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
    let config_state = current_object_mesh_config(object);
    let effective_config = Some(json_object_map(
        effective_object_mesh_config(config_state)?,
        "effective object mesh config",
    )?);
    let config = optional_json_object_map(config_state, "object mesh config")?;
    Ok(Json(MeshObjectConfigResource {
        revision: snapshot.mesh_revision,
        object_id,
        config,
        effective_config,
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
        .map(serde_json::to_value)
        .transpose()
        .map_err(|error| {
            ApiError::bad_request(format!("invalid object mesh config payload: {error}"))
        })?
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
    let config_state = current_object_mesh_config(object);
    let effective_config = Some(json_object_map(
        effective_object_mesh_config(config_state)?,
        "effective committed object mesh config",
    )?);
    let config = optional_json_object_map(config_state, "committed object mesh config")?;
    let revision = current_snapshot(&state).await?.mesh_revision;
    Ok(Json(MeshObjectConfigResource {
        revision,
        object_id,
        config,
        effective_config,
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
    path = "/v2/sessions/current/meshing/meshes/regions/{region_id}/quality",
    params(
        ("region_id" = String, Path, description = "Authored or realized region id")
    ),
    responses(
        (status = 200, description = "Per-region mesh quality", body = MeshRegionQualityResource),
        (status = 404, description = "No active workspace, mesh, scene, or region membership"),
    ),
    tag = "meshing"
)]
pub async fn get_mesh_region_quality(
    State(state): State<Arc<AppState>>,
    Path(region_id): Path<String>,
) -> Result<Json<MeshRegionQualityResource>, ApiError> {
    let snapshot = current_snapshot(&state).await?;
    let scene = current_scene_document(&snapshot)?;
    let mesh = snapshot
        .fem_mesh
        .as_ref()
        .ok_or_else(|| ApiError::not_found("no active FEM mesh"))?;
    let null_workspace = Value::Null;
    let mesh_workspace = snapshot.mesh_workspace.as_ref().unwrap_or(&null_workspace);
    let membership =
        crate::router_v2::handlers::data::mesh_region_membership::build_mesh_region_membership(
            scene,
            mesh,
            snapshot.mesh_revision,
            &region_id,
        )
        .ok_or_else(|| {
            ApiError::not_found(format!("mesh region membership '{region_id}' not found"))
        })?;
    let quality = region_quality(&snapshot, mesh_workspace, &membership)?;
    Ok(Json(MeshRegionQualityResource {
        revision: snapshot.mesh_revision,
        region_id,
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
        ("If-None-Match" = Option<String>, Header, description = "Strong ETag from a previous object-topology response"),
        ("Range" = Option<String>, Header, description = "Optional single byte range for chunked FMMT topology reads"),
        ("object_id" = String, Path, description = "Canonical scene object id")
    ),
    responses(
        (status = 200, description = "Binary per-object FEM topology (FMMT)", content_type = "application/octet-stream"),
        (status = 206, description = "Partial per-object FEM topology range (FMMT)", content_type = "application/octet-stream"),
        (status = 304, description = "Per-object topology not modified for the supplied ETag"),
        (status = 416, description = "Requested topology byte range is not satisfiable"),
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
            let topology_hash = fullmag_runner::fem_mesh_topology_fingerprint(&object_mesh);
            let etag = crate::router_v2::handlers::shared::stable_strong_etag(&format!(
                "mesh-object-topology:{object_id}:{generation_id}:{topology_hash}:{}",
                snapshot.mesh_revision,
            ));
            let mut response = crate::router_v2::handlers::shared::conditional_binary_response(
                &headers, &etag, binary,
            );
            crate::router_v2::handlers::shared::insert_mesh_topology_hash_header(
                &mut response,
                &topology_hash,
            );
            Ok(response)
        }
        None => Ok(StatusCode::NO_CONTENT.into_response()),
    }
}

#[utoipa::path(
    get,
    path = "/v2/sessions/current/meshing/meshes/parts/{part_id}/topology",
    params(
        ("If-None-Match" = Option<String>, Header, description = "Strong ETag from a previous part-topology response"),
        ("Range" = Option<String>, Header, description = "Optional single byte range for chunked FMMT topology reads"),
        ("part_id" = String, Path, description = "Stable FEM mesh part id, for example an airbox part")
    ),
    responses(
        (status = 200, description = "Binary per-part FEM topology (FMMT)", content_type = "application/octet-stream"),
        (status = 206, description = "Partial per-part FEM topology range (FMMT)", content_type = "application/octet-stream"),
        (status = 304, description = "Per-part topology not modified for the supplied ETag"),
        (status = 416, description = "Requested topology byte range is not satisfiable"),
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
            let topology_hash = fullmag_runner::fem_mesh_topology_fingerprint(&part_mesh);
            let etag = crate::router_v2::handlers::shared::stable_strong_etag(&format!(
                "mesh-part-topology:{part_id}:{generation_id}:{topology_hash}:{}",
                snapshot.mesh_revision,
            ));
            let mut response = crate::router_v2::handlers::shared::conditional_binary_response(
                &headers, &etag, binary,
            );
            crate::router_v2::handlers::shared::insert_mesh_topology_hash_header(
                &mut response,
                &topology_hash,
            );
            Ok(response)
        }
        None => Ok(StatusCode::NO_CONTENT.into_response()),
    }
}

#[utoipa::path(
    get,
    path = "/v2/sessions/current/meshing/meshes/{mesh_id}/parts/{part_id}/histogram-bins/{metric}/{bin_index}/elements",
    params(
        ("mesh_id" = String, Path, description = "Shared-domain mesh id. The aliases shared-domain, shared_domain, and study_domain resolve to the current FEM solver mesh."),
        ("part_id" = String, Path, description = "Stable FEM mesh part id, for example airbox"),
        ("metric" = String, Path, description = "Histogram metric: characteristic_size, tetra_size, edge_length, volume, sicn, or gamma"),
        ("bin_index" = u32, Path, description = "Zero-based histogram bin index")
    ),
    responses(
        (status = 200, description = "Source element and node indices for a mesh histogram bin", body = MeshHistogramBinElementsResource),
        (status = 204, description = "No FEM mesh available"),
        (status = 400, description = "Invalid histogram metric or bin index"),
        (status = 404, description = "No active workspace, mesh, or mesh part"),
    ),
    tag = "meshing"
)]
pub async fn get_mesh_histogram_bin_elements(
    State(state): State<Arc<AppState>>,
    Path((mesh_id, part_id, metric, bin_index)): Path<(String, String, String, u32)>,
) -> Result<axum::response::Response, ApiError> {
    let snapshot = current_snapshot(&state).await?;
    let Some(mesh) = snapshot.fem_mesh.as_ref() else {
        return Ok(StatusCode::NO_CONTENT.into_response());
    };
    if !matches_shared_domain_mesh_id(mesh, &mesh_id) {
        return Err(ApiError::not_found(format!("mesh not found: {mesh_id}")));
    }
    let metric = MeshHistogramMetric::from_path_segment(&metric)?;
    let quality_values = if let Some(quality_metric) = metric.quality_metric() {
        let mesh_workspace = current_mesh_workspace(&snapshot)?;
        let Some(artifact) = read_mesh_quality_data_artifact(mesh_workspace)? else {
            return Err(ApiError::bad_request(format!(
                "histogram metric {} requires per-element mesh quality data",
                metric.as_str()
            )));
        };
        per_element_quality_metric_from_fmmq(&artifact.bytes, quality_metric)?.ok_or_else(|| {
            ApiError::bad_request(format!(
                "per-element mesh quality data does not include {}",
                metric.as_str()
            ))
        })?
    } else {
        Vec::new()
    };
    let resource = mesh_histogram_bin_elements(mesh, &part_id, metric, bin_index, &quality_values)?;
    Ok(Json(resource).into_response())
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
    let quality = snapshot
        .fem_mesh
        .as_ref()
        .and_then(|mesh| interface_quality(mesh, &interface_id));
    Ok(Json(MeshInterfaceQualityResource {
        revision: snapshot.mesh_revision,
        interface_id,
        quality,
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
    // When no mesh build has occurred yet the workspace is None.
    // Return a static empty object so handlers can safely call .get()
    // and produce empty/default responses rather than HTTP 404.
    static EMPTY_MESH_WORKSPACE: std::sync::LazyLock<Value> =
        std::sync::LazyLock::new(|| Value::Object(serde_json::Map::new()));
    Ok(snapshot
        .mesh_workspace
        .as_ref()
        .unwrap_or(&EMPTY_MESH_WORKSPACE))
}

fn workspace_value_at<'a>(root: &'a Value, path: &[&str]) -> Option<&'a Value> {
    let mut current = root;
    for key in path {
        current = current.get(*key)?;
    }
    Some(current)
}

fn first_workspace_value(root: &Value, paths: &[&[&str]]) -> Option<Value> {
    paths
        .iter()
        .find_map(|path| workspace_value_at(root, path).cloned())
}

fn first_workspace_string(root: &Value, paths: &[&[&str]]) -> Option<String> {
    paths
        .iter()
        .find_map(|path| workspace_value_at(root, path).and_then(Value::as_str))
        .map(ToOwned::to_owned)
}

fn first_workspace_u64(root: &Value, paths: &[&[&str]]) -> Option<u64> {
    paths
        .iter()
        .find_map(|path| workspace_value_at(root, path).and_then(Value::as_u64))
}

fn first_workspace_u128(root: &Value, paths: &[&[&str]]) -> Option<u128> {
    paths.iter().find_map(|path| {
        workspace_value_at(root, path)
            .and_then(Value::as_u64)
            .map(u128::from)
    })
}

fn workspace_mesh_statistics(mesh_workspace: &Value) -> Option<&Value> {
    workspace_value_at(mesh_workspace, &["mesh_statistics"]).or_else(|| {
        workspace_value_at(mesh_workspace, &["last_build_summary", "mesh_statistics"])
            .filter(|value| !value.is_null())
    })
}

fn derive_mesh_quality_gates(snapshot: &SessionStateResponse, mesh_workspace: &Value) -> Value {
    let mesh = snapshot.fem_mesh.as_ref();
    let element_count = mesh.map(|mesh| mesh.elements.len()).unwrap_or_default();
    let node_count = mesh.map(|mesh| mesh.nodes.len()).unwrap_or_default();
    let marker_coverage = mesh
        .map(|mesh| mesh.element_markers.len() == mesh.elements.len())
        .unwrap_or(false);
    let outer_boundary_present = mesh
        .map(|mesh| mesh.boundary_markers.iter().any(|marker| *marker == 99))
        .unwrap_or(false);
    json!({
        "source": "derived_from_current_fem_mesh",
        "status": if element_count > 0 && marker_coverage { "pass" } else { "unknown" },
        "reason": "mesh_quality_gates is missing from the current mesh workspace/build report",
        "checks": [
            {
                "id": "non_empty_tetrahedra",
                "status": if element_count > 0 { "pass" } else { "unknown" },
                "value": element_count
            },
            {
                "id": "non_empty_nodes",
                "status": if node_count > 0 { "pass" } else { "unknown" },
                "value": node_count
            },
            {
                "id": "element_marker_coverage",
                "status": if marker_coverage { "pass" } else { "unknown" },
                "value": marker_coverage
            },
            {
                "id": "outer_boundary_marker_present",
                "status": if outer_boundary_present { "pass" } else { "unknown" },
                "value": outer_boundary_present
            }
        ],
        "mesh_quality_summary": mesh_workspace.get("mesh_quality_summary").cloned().unwrap_or(Value::Null),
        "mesh_statistics": workspace_mesh_statistics(mesh_workspace).cloned().unwrap_or(Value::Null)
    })
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

fn json_object_map(value: Value, context: &str) -> Result<BTreeMap<String, Value>, ApiError> {
    serde_json::from_value(value)
        .map_err(|error| ApiError::internal(format!("failed to serialize {context}: {error}")))
}

fn optional_json_object_map<T: Serialize>(
    value: Option<&T>,
    context: &str,
) -> Result<Option<BTreeMap<String, Value>>, ApiError> {
    value
        .map(|entry| {
            serde_json::to_value(entry)
                .map_err(|error| {
                    ApiError::internal(format!("failed to serialize {context}: {error}"))
                })
                .and_then(|value| json_object_map(value, context))
        })
        .transpose()
}

fn effective_universe_mesh_config(
    config: Option<&ScriptBuilderUniverseState>,
) -> Result<Value, ApiError> {
    let mut effective = json!({
        "mode": "auto",
        "padding": [0.0, 0.0, 0.0],
        "airbox_growth_rate": 1.3,
        "airbox_grading": "geometric",
    });
    if let Some(config) = config {
        merge_json_object(
            &mut effective,
            serde_json::to_value(config).map_err(|error| {
                ApiError::internal(format!(
                    "failed to serialize effective universe mesh config: {error}"
                ))
            })?,
        );
    }
    Ok(effective)
}

fn effective_object_mesh_config(
    config: Option<&ScriptBuilderPerGeometryMeshState>,
) -> Result<Value, ApiError> {
    let mut effective = json!({
        "mode": "inherit",
        "algorithm_2d": 6,
        "algorithm_3d": 1,
        "size_factor": 1.0,
        "size_from_curvature": 0,
        "narrow_regions": 0,
        "smoothing_steps": 1,
        "optimize_iterations": 1,
        "compute_quality": true,
        "per_element_quality": true,
        "through_thickness_symmetric": false,
        "build_requested": false,
    });
    if let Some(config) = config {
        merge_json_object(
            &mut effective,
            serde_json::to_value(config).map_err(|error| {
                ApiError::internal(format!(
                    "failed to serialize effective object mesh config: {error}"
                ))
            })?,
        );
    }
    Ok(effective)
}

fn merge_json_object(target: &mut Value, overlay: Value) {
    let (Some(target), Some(overlay)) = (target.as_object_mut(), overlay.as_object()) else {
        return;
    };
    for (key, value) in overlay {
        target.insert(key.clone(), value.clone());
    }
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

fn marker_from_value(value: &Value) -> Option<u32> {
    value.as_u64().and_then(|marker| u32::try_from(marker).ok())
}

fn scope_marker(scope: &Value) -> Option<u32> {
    scope.get("marker").and_then(marker_from_value)
}

fn scope_kind(scope: &Value) -> Option<&str> {
    scope.get("kind").and_then(Value::as_str)
}

fn filtered_worst_entries(value: Option<&Value>, marker: u32) -> Vec<Value> {
    value
        .and_then(Value::as_array)
        .map(|entries| {
            entries
                .iter()
                .filter(|entry| entry.get("marker").and_then(marker_from_value) == Some(marker))
                .cloned()
                .collect()
        })
        .unwrap_or_default()
}

fn scoped_mesh_statistics(
    mesh_workspace: &Value,
    marker: Option<u32>,
    kind: Option<&str>,
) -> Option<Value> {
    let mesh_statistics = workspace_mesh_statistics(mesh_workspace)?;
    let scopes = mesh_statistics.get("scopes").and_then(Value::as_array)?;
    let scope = scopes.iter().find(|scope| {
        marker.is_some_and(|marker| scope_marker(scope) == Some(marker))
            || kind.is_some_and(|kind| scope_kind(scope) == Some(kind))
    })?;
    let mut projection = serde_json::Map::new();
    for key in ["mesh_name", "quality_source"] {
        if let Some(value) = mesh_statistics.get(key) {
            projection.insert(key.to_string(), value.clone());
        }
    }
    projection.insert("global".to_string(), scope.clone());
    projection.insert("scopes".to_string(), Value::Array(vec![scope.clone()]));

    if let Some(marker) = marker.or_else(|| scope_marker(scope)) {
        let worst_elements = filtered_worst_entries(mesh_statistics.get("worst_elements"), marker);
        projection.insert("worst_elements".to_string(), Value::Array(worst_elements));

        if let Some(metrics) = mesh_statistics
            .get("worst_elements_by_metric")
            .and_then(Value::as_object)
        {
            let mut filtered_metrics = serde_json::Map::new();
            for (metric, entries) in metrics {
                filtered_metrics.insert(
                    metric.clone(),
                    Value::Array(filtered_worst_entries(Some(entries), marker)),
                );
            }
            projection.insert(
                "worst_elements_by_metric".to_string(),
                Value::Object(filtered_metrics),
            );
        }
    }

    Some(Value::Object(projection))
}

fn legacy_domain_volume_ratio(quality: &Value) -> Value {
    match (
        quality.get("volume_min").and_then(Value::as_f64),
        quality.get("volume_max").and_then(Value::as_f64),
    ) {
        (Some(min), Some(max)) if min.is_finite() && max.is_finite() && min > 0.0 => {
            json!(max / min)
        }
        _ => Value::Null,
    }
}

fn legacy_domain_quality_statistics(marker: u32, label: &str, quality: &Value) -> Option<Value> {
    if !quality.is_object() {
        return None;
    }
    Some(json!({
        "quality_source": "per_domain_quality",
        "global": {
            "scope_id": format!("marker:{marker}"),
            "kind": if marker == 0 { "airbox" } else { "domain" },
            "label": label,
            "role": if marker == 0 { "air" } else { "domain" },
            "marker": marker,
            "element_count": quality.get("n_elements").cloned().unwrap_or(Value::Null),
            "sicn": {
                "min": quality.get("sicn_min").cloned().unwrap_or(Value::Null),
                "max": quality.get("sicn_max").cloned().unwrap_or(Value::Null),
                "mean": quality.get("sicn_mean").cloned().unwrap_or(Value::Null),
                "p05": quality.get("sicn_p5").cloned().unwrap_or(Value::Null),
                "histogram": quality.get("sicn_histogram").cloned().unwrap_or(Value::Null)
            },
            "gamma": {
                "min": quality.get("gamma_min").cloned().unwrap_or(Value::Null),
                "mean": quality.get("gamma_mean").cloned().unwrap_or(Value::Null),
                "histogram": quality.get("gamma_histogram").cloned().unwrap_or(Value::Null)
            },
            "volume": {
                "min": quality.get("volume_min").cloned().unwrap_or(Value::Null),
                "max": quality.get("volume_max").cloned().unwrap_or(Value::Null),
                "mean": quality.get("volume_mean").cloned().unwrap_or(Value::Null),
                "std": quality.get("volume_std").cloned().unwrap_or(Value::Null),
                "ratio": legacy_domain_volume_ratio(quality)
            }
        }
    }))
}

fn merge_mesh_scope_size_statistics(
    quality: &mut Value,
    mesh: Option<&FemMeshPayload>,
    marker: u32,
) {
    let Some(size_statistics) = mesh.and_then(|mesh| mesh_scope_size_statistics(mesh, marker))
    else {
        return;
    };
    if !quality.is_object() {
        *quality = json!({});
    }
    let Some(root) = quality.as_object_mut() else {
        return;
    };
    match root.get_mut("global") {
        Some(Value::Object(global)) => {
            let Some(size_statistics) = size_statistics.as_object() else {
                return;
            };
            for (key, fallback) in size_statistics {
                match global.get_mut(key) {
                    Some(Value::Object(existing)) => {
                        let Some(fallback) = fallback.as_object() else {
                            continue;
                        };
                        for (field, value) in fallback {
                            let should_fill = match existing.get(field) {
                                Some(Value::Array(items)) => items.is_empty(),
                                Some(Value::Null) | None => true,
                                _ => false,
                            };
                            if should_fill {
                                existing.insert(field.clone(), value.clone());
                            }
                        }
                    }
                    Some(Value::Null) | None => {
                        global.insert(key.clone(), fallback.clone());
                    }
                    _ => {}
                }
            }
        }
        Some(Value::Null) | None => {
            root.insert("global".to_string(), size_statistics);
        }
        _ => {}
    }
}

fn mesh_scope_size_statistics(mesh: &FemMeshPayload, marker: u32) -> Option<Value> {
    if mesh.element_markers.len() != mesh.elements.len() {
        return None;
    }

    let mut volumes = Vec::new();
    let mut characteristic_sizes = Vec::new();
    let mut edge_lengths = Vec::new();

    for (element_index, element) in mesh.elements.iter().enumerate() {
        if mesh.element_markers[element_index] != marker {
            continue;
        }
        let Some(tet) = element_nodes(mesh, element) else {
            continue;
        };
        edge_lengths.extend(tet_edge_lengths(tet));
        let volume = tet_volume(tet).abs();
        if volume > 0.0 && volume.is_finite() {
            volumes.push(volume);
            characteristic_sizes.push((volume * 6.0 * 2.0_f64.sqrt()).cbrt());
        }
    }

    if volumes.is_empty() && edge_lengths.is_empty() {
        return None;
    }

    let element_count = volumes.len();

    Some(json!({
        "scope_id": format!("marker:{marker}"),
        "kind": if marker == 0 { "airbox" } else { "domain" },
        "label": if marker == 0 { "Airbox".to_string() } else { format!("Domain {marker}") },
        "role": if marker == 0 { "air" } else { "domain" },
        "marker": marker,
        "element_count": element_count,
        "characteristic_size": distribution_statistics(&characteristic_sizes),
        "edge_length": distribution_statistics(&edge_lengths),
        "volume": distribution_statistics(&volumes),
    }))
}

#[derive(Debug, Clone, Copy, PartialEq, Eq)]
enum MeshHistogramMetric {
    CharacteristicSize,
    EdgeLength,
    Gamma,
    Sicn,
    Volume,
}

impl MeshHistogramMetric {
    fn from_path_segment(value: &str) -> Result<Self, ApiError> {
        match value {
            "characteristic_size" | "tetra_size" => Ok(Self::CharacteristicSize),
            "edge_length" => Ok(Self::EdgeLength),
            "gamma" => Ok(Self::Gamma),
            "sicn" => Ok(Self::Sicn),
            "volume" => Ok(Self::Volume),
            other => Err(ApiError::bad_request(format!(
                "unsupported mesh histogram metric: {other}"
            ))),
        }
    }

    fn as_str(self) -> &'static str {
        match self {
            Self::CharacteristicSize => "characteristic_size",
            Self::EdgeLength => "edge_length",
            Self::Gamma => "gamma",
            Self::Sicn => "sicn",
            Self::Volume => "volume",
        }
    }

    fn quality_metric(self) -> Option<CrossSectionQualityMetric> {
        match self {
            Self::Gamma => Some(CrossSectionQualityMetric::Gamma),
            Self::Sicn => Some(CrossSectionQualityMetric::Sicn),
            Self::CharacteristicSize | Self::EdgeLength | Self::Volume => None,
        }
    }
}

#[derive(Debug, Clone, Copy)]
struct MeshHistogramSample {
    element_index: u32,
    value: f64,
}

fn matches_shared_domain_mesh_id(mesh: &FemMeshPayload, mesh_id: &str) -> bool {
    matches!(mesh_id, "shared-domain" | "shared_domain" | "study_domain")
        || mesh.mesh_id == mesh_id
        || mesh.mesh_name == mesh_id
}

fn mesh_histogram_bin_elements(
    mesh: &FemMeshPayload,
    part_id: &str,
    metric: MeshHistogramMetric,
    bin_index: u32,
    quality_values: &[f64],
) -> Result<MeshHistogramBinElementsResource, ApiError> {
    let part = mesh
        .mesh_parts
        .iter()
        .find(|part| part.id == part_id)
        .ok_or_else(|| ApiError::not_found(format!("mesh part not found: {part_id}")))?;
    let element_indices = part_source_element_indices(mesh, part)?;
    let samples = mesh_histogram_samples(mesh, &element_indices, metric, quality_values)?;
    let values = samples
        .iter()
        .map(|sample| sample.value)
        .collect::<Vec<_>>();
    let edges = size_histogram_edges(&values, 30);
    let bin_index_usize = bin_index as usize;
    if edges.len() < 2 || bin_index_usize + 1 >= edges.len() {
        return Err(ApiError::bad_request(format!(
            "histogram bin {bin_index} is out of range for metric {}",
            metric.as_str()
        )));
    }

    let mut selected_elements = BTreeSet::new();
    for sample in samples {
        if value_in_histogram_bin(sample.value, &edges, bin_index_usize) {
            selected_elements.insert(sample.element_index);
        }
    }
    let mut selected_nodes = BTreeSet::new();
    for element_index in &selected_elements {
        let element = mesh.elements.get(*element_index as usize).ok_or_else(|| {
            ApiError::internal(format!(
                "mesh element index {element_index} is out of range"
            ))
        })?;
        selected_nodes.extend(element.iter().copied());
    }

    Ok(MeshHistogramBinElementsResource {
        mesh_id: mesh.mesh_id.clone(),
        part_id: part.id.clone(),
        metric: metric.as_str().to_string(),
        bin_index,
        element_indices: selected_elements.into_iter().collect(),
        node_indices: selected_nodes.into_iter().collect(),
    })
}

fn part_source_element_indices(
    mesh: &FemMeshPayload,
    part: &FemMeshPartPayload,
) -> Result<Vec<usize>, ApiError> {
    let start = part.element_start as usize;
    let end = start.saturating_add(part.element_count as usize);
    if end > mesh.elements.len() {
        return Err(ApiError::internal(format!(
            "mesh part {} references elements outside the solver mesh",
            part.id
        )));
    }
    Ok((start..end).collect())
}

fn mesh_histogram_samples(
    mesh: &FemMeshPayload,
    element_indices: &[usize],
    metric: MeshHistogramMetric,
    quality_values: &[f64],
) -> Result<Vec<MeshHistogramSample>, ApiError> {
    let mut samples = Vec::new();
    for element_index in element_indices {
        match metric {
            MeshHistogramMetric::CharacteristicSize => {
                let element = mesh.elements.get(*element_index).ok_or_else(|| {
                    ApiError::internal(format!(
                        "mesh element index {element_index} is out of range"
                    ))
                })?;
                let Some(tet) = element_nodes(mesh, element) else {
                    continue;
                };
                let volume = tet_volume(tet).abs();
                if volume > 0.0 && volume.is_finite() {
                    samples.push(MeshHistogramSample {
                        element_index: *element_index as u32,
                        value: (volume * 6.0 * 2.0_f64.sqrt()).cbrt(),
                    });
                }
            }
            MeshHistogramMetric::Volume => {
                let element = mesh.elements.get(*element_index).ok_or_else(|| {
                    ApiError::internal(format!(
                        "mesh element index {element_index} is out of range"
                    ))
                })?;
                let Some(tet) = element_nodes(mesh, element) else {
                    continue;
                };
                let volume = tet_volume(tet).abs();
                if volume > 0.0 && volume.is_finite() {
                    samples.push(MeshHistogramSample {
                        element_index: *element_index as u32,
                        value: volume,
                    });
                }
            }
            MeshHistogramMetric::EdgeLength => {
                let element = mesh.elements.get(*element_index).ok_or_else(|| {
                    ApiError::internal(format!(
                        "mesh element index {element_index} is out of range"
                    ))
                })?;
                let Some(tet) = element_nodes(mesh, element) else {
                    continue;
                };
                samples.extend(tet_edge_lengths(tet).into_iter().filter_map(|value| {
                    value.is_finite().then_some(MeshHistogramSample {
                        element_index: *element_index as u32,
                        value,
                    })
                }));
            }
            MeshHistogramMetric::Gamma | MeshHistogramMetric::Sicn => {
                let value = quality_values.get(*element_index).ok_or_else(|| {
                    ApiError::internal(format!(
                        "quality payload is missing value for mesh element {element_index}"
                    ))
                })?;
                if value.is_finite() {
                    samples.push(MeshHistogramSample {
                        element_index: *element_index as u32,
                        value: *value,
                    });
                }
            }
        }
    }
    if samples.is_empty() {
        return Err(ApiError::bad_request(format!(
            "mesh part has no finite {} histogram values",
            metric.as_str()
        )));
    }
    Ok(samples)
}

fn value_in_histogram_bin(value: f64, edges: &[f64], bin_index: usize) -> bool {
    let Some(lo) = edges.get(bin_index).copied() else {
        return false;
    };
    let Some(hi) = edges.get(bin_index + 1).copied() else {
        return false;
    };
    if bin_index + 2 == edges.len() {
        value >= lo && value <= hi
    } else {
        value >= lo && value < hi
    }
}

fn element_nodes(mesh: &FemMeshPayload, element: &[u32; 4]) -> Option<[[f64; 3]; 4]> {
    Some([
        *mesh.nodes.get(element[0] as usize)?,
        *mesh.nodes.get(element[1] as usize)?,
        *mesh.nodes.get(element[2] as usize)?,
        *mesh.nodes.get(element[3] as usize)?,
    ])
}

fn tet_edge_lengths(tet: [[f64; 3]; 4]) -> [f64; 6] {
    [
        distance(tet[0], tet[1]),
        distance(tet[0], tet[2]),
        distance(tet[0], tet[3]),
        distance(tet[1], tet[2]),
        distance(tet[1], tet[3]),
        distance(tet[2], tet[3]),
    ]
}

fn distance(a: [f64; 3], b: [f64; 3]) -> f64 {
    ((a[0] - b[0]).powi(2) + (a[1] - b[1]).powi(2) + (a[2] - b[2]).powi(2)).sqrt()
}

fn tet_volume(tet: [[f64; 3]; 4]) -> f64 {
    let a = sub(tet[1], tet[0]);
    let b = sub(tet[2], tet[0]);
    let c = sub(tet[3], tet[0]);
    dot(a, cross(b, c)) / 6.0
}

fn sub(a: [f64; 3], b: [f64; 3]) -> [f64; 3] {
    [a[0] - b[0], a[1] - b[1], a[2] - b[2]]
}

fn dot(a: [f64; 3], b: [f64; 3]) -> f64 {
    a[0] * b[0] + a[1] * b[1] + a[2] * b[2]
}

fn cross(a: [f64; 3], b: [f64; 3]) -> [f64; 3] {
    [
        a[1] * b[2] - a[2] * b[1],
        a[2] * b[0] - a[0] * b[2],
        a[0] * b[1] - a[1] * b[0],
    ]
}

fn distribution_statistics(values: &[f64]) -> Value {
    let finite_values = values
        .iter()
        .copied()
        .filter(|value| value.is_finite())
        .collect::<Vec<_>>();
    if finite_values.is_empty() {
        return Value::Null;
    }
    let min = finite_values.iter().copied().fold(f64::INFINITY, f64::min);
    let max = finite_values
        .iter()
        .copied()
        .fold(f64::NEG_INFINITY, f64::max);
    let mean = finite_values.iter().sum::<f64>() / finite_values.len() as f64;
    let variance = finite_values
        .iter()
        .map(|value| (value - mean).powi(2))
        .sum::<f64>()
        / finite_values.len() as f64;
    json!({
        "min": min,
        "max": max,
        "mean": mean,
        "std": variance.sqrt(),
        "ratio": if min > 0.0 { Value::from(max / min) } else { Value::Null },
        "histogram": size_histogram_bins(&finite_values, 30),
    })
}

fn size_histogram_bins(values: &[f64], bin_count: usize) -> Vec<Value> {
    let edges = size_histogram_edges(values, bin_count);
    if edges.len() < 2 {
        return Vec::new();
    }
    if (edges[edges.len() - 1] - edges[0]).abs()
        <= f64::EPSILON * edges[edges.len() - 1].abs().max(1.0)
    {
        return vec![
            json!({ "lo": edges[0], "hi": edges[edges.len() - 1], "count": values.len() }),
        ];
    }

    let bins = edges.len() - 1;
    let mut counts = vec![0usize; bins];
    for value in values {
        let mut bin_index = bins - 1;
        for index in 0..bins {
            if *value < edges[index + 1] || index == bins - 1 {
                bin_index = index;
                break;
            }
        }
        counts[bin_index] += 1;
    }

    counts
        .into_iter()
        .enumerate()
        .map(|(index, count)| {
            json!({
                "lo": edges[index],
                "hi": edges[index + 1],
                "count": count,
            })
        })
        .collect()
}

fn size_histogram_edges(values: &[f64], bin_count: usize) -> Vec<f64> {
    if values.is_empty() {
        return Vec::new();
    }
    let min = values.iter().copied().fold(f64::INFINITY, f64::min);
    let max = values.iter().copied().fold(f64::NEG_INFINITY, f64::max);
    if !min.is_finite() || !max.is_finite() {
        return Vec::new();
    }
    if (max - min).abs() <= f64::EPSILON * max.abs().max(1.0) {
        return vec![min, max];
    }

    let bins = bin_count.max(1);
    if min > 0.0 {
        let ratio = (max / min).powf(1.0 / bins as f64);
        (0..=bins)
            .map(|index| {
                if index == bins {
                    max
                } else {
                    min * ratio.powf(index as f64)
                }
            })
            .collect()
    } else {
        let width = (max - min) / bins as f64;
        (0..=bins)
            .map(|index| {
                if index == bins {
                    max
                } else {
                    min + width * index as f64
                }
            })
            .collect()
    }
}

fn merge_quality_field(target: &mut Value, key: &str, value: Value) {
    if let Value::Object(fields) = target {
        fields.insert(key.to_string(), value);
    }
}

fn object_marker_from_mesh(mesh: Option<&FemMeshPayload>, object_id: &str) -> Option<u32> {
    let mesh = mesh?;
    let segment = mesh
        .object_segments
        .iter()
        .find(|segment| segment.object_id == object_id)?;
    let start = segment.element_start as usize;
    let end = start.saturating_add(segment.element_count as usize);
    let markers = mesh
        .element_markers
        .get(start..end)?
        .iter()
        .copied()
        .collect::<BTreeSet<_>>();
    if markers.len() == 1 {
        markers.first().copied()
    } else {
        None
    }
}

fn universe_quality(mesh_workspace: &Value, mesh: Option<&FemMeshPayload>) -> Value {
    let per_domain_quality = mesh
        .and_then(|mesh| mesh.per_domain_quality.get(&0))
        .and_then(|quality| serde_json::to_value(quality).ok());
    let mut quality = scoped_mesh_statistics(mesh_workspace, Some(0), Some("airbox"))
        .or_else(|| {
            per_domain_quality
                .as_ref()
                .and_then(|quality| legacy_domain_quality_statistics(0, "Airbox", quality))
        })
        .unwrap_or_else(|| json!({}));
    merge_mesh_scope_size_statistics(&mut quality, mesh, 0);
    merge_quality_field(&mut quality, "marker", json!(0));
    merge_quality_field(
        &mut quality,
        "effective_airbox_target",
        mesh_workspace
            .get("effective_airbox_target")
            .cloned()
            .unwrap_or(Value::Null),
    );
    merge_quality_field(
        &mut quality,
        "mesh_quality_summary",
        mesh_workspace
            .get("mesh_quality_summary")
            .cloned()
            .unwrap_or(Value::Null),
    );
    merge_quality_field(
        &mut quality,
        "per_domain_quality",
        per_domain_quality.unwrap_or(Value::Null),
    );
    quality
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
        .and_then(|marker| u32::try_from(marker).ok())
        .or_else(|| object_marker_from_mesh(snapshot.fem_mesh.as_ref(), object_id));
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
    let mut quality = marker
        .and_then(|marker| scoped_mesh_statistics(mesh_workspace, Some(marker), None))
        .or_else(|| {
            marker.and_then(|marker| {
                per_domain_quality.as_ref().and_then(|quality| {
                    legacy_domain_quality_statistics(marker, &format!("Domain {marker}"), quality)
                })
            })
        })
        .unwrap_or_else(|| json!({}));
    if let Some(marker) = marker {
        merge_mesh_scope_size_statistics(&mut quality, snapshot.fem_mesh.as_ref(), marker);
    }
    merge_quality_field(
        &mut quality,
        "marker",
        marker.map(Value::from).unwrap_or(Value::Null),
    );
    merge_quality_field(
        &mut quality,
        "effective_target",
        effective_target.unwrap_or(Value::Null),
    );
    merge_quality_field(
        &mut quality,
        "per_domain_quality",
        per_domain_quality.unwrap_or(Value::Null),
    );
    Some(quality)
}

fn region_quality(
    snapshot: &SessionStateResponse,
    mesh_workspace: &Value,
    membership: &MeshRegionMembershipResource,
) -> Result<Option<Value>, ApiError> {
    let Some(mesh) = snapshot.fem_mesh.as_ref() else {
        return Ok(None);
    };
    let element_indices = normalize_membership_element_indices(mesh, &membership.element_indices);
    let Some(mut global) = mesh_region_size_statistics(mesh, membership, &element_indices) else {
        return Ok(Some(json!({
            "quality_source": "region_membership",
            "membership_source": membership.source.clone(),
            "realization_method": membership.realization_method.clone(),
            "global": {
                "scope_id": format!("region:{}", membership.region_id),
                "kind": "region",
                "label": membership.region_id.clone(),
                "role": "region",
                "element_count": 0,
                "warnings": membership.realization_warnings.clone(),
            }
        })));
    };

    if let Some(artifact) = read_mesh_quality_data_artifact(mesh_workspace)? {
        if let Some(values) =
            per_element_quality_metric_from_fmmq(&artifact.bytes, CrossSectionQualityMetric::Sicn)?
        {
            merge_region_quality_metric(&mut global, "sicn", &element_indices, &values, 0.1)?;
        }
        if let Some(values) =
            per_element_quality_metric_from_fmmq(&artifact.bytes, CrossSectionQualityMetric::Gamma)?
        {
            merge_region_quality_metric(&mut global, "gamma", &element_indices, &values, 0.08)?;
        }
    }

    Ok(Some(json!({
        "quality_source": "region_membership",
        "membership_source": membership.source.clone(),
        "realization_method": membership.realization_method.clone(),
        "global": global,
    })))
}

fn normalize_membership_element_indices(
    mesh: &FemMeshPayload,
    element_indices: &[u32],
) -> Vec<usize> {
    let mut indices = BTreeSet::new();
    for element_index in element_indices {
        let index = *element_index as usize;
        if index < mesh.elements.len() {
            indices.insert(index);
        }
    }
    indices.into_iter().collect()
}

fn mesh_region_size_statistics(
    mesh: &FemMeshPayload,
    membership: &MeshRegionMembershipResource,
    element_indices: &[usize],
) -> Option<Value> {
    let mut volumes = Vec::new();
    let mut characteristic_sizes = Vec::new();
    let mut edge_lengths = Vec::new();

    for element_index in element_indices {
        let Some(element) = mesh.elements.get(*element_index) else {
            continue;
        };
        let Some(tet) = element_nodes(mesh, element) else {
            continue;
        };
        edge_lengths.extend(tet_edge_lengths(tet));
        let volume = tet_volume(tet).abs();
        if volume > 0.0 && volume.is_finite() {
            volumes.push(volume);
            characteristic_sizes.push((volume * 6.0 * 2.0_f64.sqrt()).cbrt());
        }
    }

    if volumes.is_empty() && edge_lengths.is_empty() {
        return None;
    }

    Some(json!({
        "scope_id": format!("region:{}", membership.region_id),
        "kind": "region",
        "label": membership.region_id.clone(),
        "role": "region",
        "element_count": element_indices.len(),
        "membership_source": membership.source.clone(),
        "mesh_part_ids": membership.mesh_part_ids.clone(),
        "warnings": membership.realization_warnings.clone(),
        "characteristic_size": distribution_statistics(&characteristic_sizes),
        "edge_length": distribution_statistics(&edge_lengths),
        "volume": distribution_statistics(&volumes),
    }))
}

fn merge_region_quality_metric(
    global: &mut Value,
    key: &str,
    element_indices: &[usize],
    values: &[f64],
    threshold: f64,
) -> Result<(), ApiError> {
    let mut samples = Vec::new();
    for element_index in element_indices {
        let value = values.get(*element_index).ok_or_else(|| {
            ApiError::internal(format!(
                "quality payload is missing value for mesh element {element_index}"
            ))
        })?;
        if value.is_finite() {
            samples.push(*value);
        }
    }
    if samples.is_empty() {
        return Ok(());
    }

    let below_threshold_count = samples.iter().filter(|value| **value < threshold).count();
    let p05 = percentile_f64(samples.clone(), 0.05);
    let mut metric = distribution_statistics(&samples);
    if let Some(metric) = metric.as_object_mut() {
        metric.insert("threshold".to_string(), json!(threshold));
        metric.insert("p05".to_string(), json!(p05));
        metric.insert(
            "below_threshold_count".to_string(),
            json!(below_threshold_count),
        );
        metric.insert(
            "below_threshold_fraction".to_string(),
            json!(below_threshold_count as f64 / samples.len() as f64),
        );
    }
    if let Some(global) = global.as_object_mut() {
        global.insert(key.to_string(), metric);
    }
    Ok(())
}

fn percentile_f64(mut values: Vec<f64>, quantile: f64) -> f64 {
    values.sort_by(|left, right| left.total_cmp(right));
    let index = ((values.len().saturating_sub(1)) as f64 * quantile)
        .round()
        .clamp(0.0, values.len().saturating_sub(1) as f64) as usize;
    values[index]
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
    let provenance = MeshBuildProvenance {
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
    };

    if provenance.source_scene_revision.is_some() {
        return provenance;
    }

    clean_scene_mesh_provenance(snapshot).unwrap_or(provenance)
}

fn clean_scene_mesh_provenance(snapshot: &SessionStateResponse) -> Option<MeshBuildProvenance> {
    let scene = snapshot.scene_document.as_ref()?;
    let mesh = snapshot.fem_mesh.as_ref()?;
    if scene
        .objects
        .iter()
        .any(|object| object.tags.iter().any(|tag| tag == "mesh:dirty"))
    {
        return None;
    }

    let scene_object_ids = scene
        .objects
        .iter()
        .filter(|object| object.visible)
        .map(|object| object.id.clone())
        .collect::<BTreeSet<_>>();
    if scene_object_ids.is_empty() {
        return None;
    }

    let mesh_object_ids = mesh
        .object_segments
        .iter()
        .map(|segment| segment.object_id.clone())
        .chain(
            mesh.mesh_parts
                .iter()
                .filter_map(|part| part.object_id.clone()),
        )
        .collect::<BTreeSet<_>>();
    if !scene_object_ids.is_subset(&mesh_object_ids) {
        return None;
    }

    Some(MeshBuildProvenance {
        source_scene_revision: Some(scene.revision),
        geometry_realization_revision: Some(scene.revision),
    })
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
            let domain_node_pair_counts = periodic_domain_node_pair_counts(mesh, node_pairs);
            let boundary_face_pairs = periodic_boundary_face_pairs(mesh, boundary_pair);

            MeshPeriodicPairResource {
                pair_id: boundary_pair.pair_id.clone(),
                source_marker: boundary_pair.source_marker.clone(),
                destination_marker: boundary_pair.destination_marker.clone(),
                marker_a: boundary_pair.marker_a,
                marker_b: boundary_pair.marker_b,
                expected_translation_m: boundary_pair.translation,
                paired_node_count: node_pairs.len() as u32,
                domain_node_pair_counts: Some(domain_node_pair_counts),
                unpaired_source_node_count: source_nodes.difference(&paired_source_nodes).count()
                    as u32,
                unpaired_destination_node_count: destination_nodes
                    .difference(&paired_destination_nodes)
                    .count() as u32,
                boundary_face_pairs,
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

fn periodic_domain_node_pair_counts(
    mesh: &FemMeshPayload,
    node_pairs: &[&fullmag_ir::MeshPeriodicNodePairIR],
) -> MeshPeriodicDomainNodePairCountsResource {
    let (magnetic_nodes, airbox_nodes) = mesh_node_domain_sets(mesh);
    let mut magnetic = 0u32;
    let mut airbox = 0u32;
    for pair in node_pairs {
        let node_a_is_magnetic = magnetic_nodes.contains(&pair.node_a);
        let node_b_is_magnetic = magnetic_nodes.contains(&pair.node_b);
        let node_a_is_airbox = airbox_nodes.contains(&pair.node_a);
        let node_b_is_airbox = airbox_nodes.contains(&pair.node_b);
        if !node_a_is_magnetic && !node_b_is_magnetic && (node_a_is_airbox || node_b_is_airbox) {
            airbox += 1;
        } else {
            magnetic += 1;
        }
    }
    MeshPeriodicDomainNodePairCountsResource { magnetic, airbox }
}

fn mesh_node_domain_sets(mesh: &FemMeshPayload) -> (BTreeSet<u32>, BTreeSet<u32>) {
    let mut magnetic_nodes = BTreeSet::new();
    let mut airbox_nodes = BTreeSet::new();
    for (element_index, element) in mesh.elements.iter().enumerate() {
        let marker = mesh
            .element_markers
            .get(element_index)
            .copied()
            .unwrap_or(1);
        let target = if marker == 0 {
            &mut airbox_nodes
        } else {
            &mut magnetic_nodes
        };
        target.extend(element.iter().copied());
    }
    (magnetic_nodes, airbox_nodes)
}

fn periodic_boundary_face_pairs(
    mesh: &FemMeshPayload,
    boundary_pair: &fullmag_ir::MeshPeriodicBoundaryPairIR,
) -> Vec<MeshPeriodicBoundaryFacePairResource> {
    let Some(translation) = boundary_pair.translation else {
        return Vec::new();
    };
    let source_faces = boundary_face_indices_by_marker(mesh, boundary_pair.marker_a);
    let mut destination_faces = boundary_face_indices_by_marker(mesh, boundary_pair.marker_b);
    let mut pairs = Vec::new();
    for source_face_index in source_faces {
        let Some(source_centroid) = boundary_face_centroid(mesh, source_face_index) else {
            continue;
        };
        let mut best_destination: Option<(usize, usize, f64)> = None;
        for (candidate_position, destination_face_index) in destination_faces.iter().enumerate() {
            let Some(destination_centroid) = boundary_face_centroid(mesh, *destination_face_index)
            else {
                continue;
            };
            let residual = [
                destination_centroid[0] - source_centroid[0] - translation[0],
                destination_centroid[1] - source_centroid[1] - translation[1],
                destination_centroid[2] - source_centroid[2] - translation[2],
            ];
            let residual_norm =
                (residual[0] * residual[0] + residual[1] * residual[1] + residual[2] * residual[2])
                    .sqrt();
            if best_destination
                .as_ref()
                .is_none_or(|(_, _, best_norm)| residual_norm < *best_norm)
            {
                best_destination =
                    Some((candidate_position, *destination_face_index, residual_norm));
            }
        }
        let Some((destination_position, destination_face_index, _)) = best_destination else {
            continue;
        };
        destination_faces.remove(destination_position);
        let normal_dot = boundary_face_normal(mesh, source_face_index)
            .zip(boundary_face_normal(mesh, destination_face_index))
            .map(|(source_normal, destination_normal)| {
                source_normal[0] * destination_normal[0]
                    + source_normal[1] * destination_normal[1]
                    + source_normal[2] * destination_normal[2]
            });
        pairs.push(MeshPeriodicBoundaryFacePairResource {
            face_a: source_face_index as u32,
            face_b: destination_face_index as u32,
            translation_m: translation,
            normal_dot,
            orientation: if normal_dot.is_some_and(|dot| dot <= -0.999) {
                "opposed_normals".to_string()
            } else {
                "not_opposed".to_string()
            },
        });
    }
    pairs
}

fn boundary_face_indices_by_marker(mesh: &FemMeshPayload, marker: u32) -> Vec<usize> {
    mesh.boundary_markers
        .iter()
        .enumerate()
        .filter_map(|(index, face_marker)| (*face_marker == marker).then_some(index))
        .collect()
}

fn boundary_face_centroid(mesh: &FemMeshPayload, face_index: usize) -> Option<[f64; 3]> {
    let face = mesh.boundary_faces.get(face_index)?;
    let a = mesh.nodes.get(face[0] as usize)?;
    let b = mesh.nodes.get(face[1] as usize)?;
    let c = mesh.nodes.get(face[2] as usize)?;
    Some([
        (a[0] + b[0] + c[0]) / 3.0,
        (a[1] + b[1] + c[1]) / 3.0,
        (a[2] + b[2] + c[2]) / 3.0,
    ])
}

fn boundary_face_normal(mesh: &FemMeshPayload, face_index: usize) -> Option<[f64; 3]> {
    let face = mesh.boundary_faces.get(face_index)?;
    let a = mesh.nodes.get(face[0] as usize)?;
    let b = mesh.nodes.get(face[1] as usize)?;
    let c = mesh.nodes.get(face[2] as usize)?;
    let ab = [b[0] - a[0], b[1] - a[1], b[2] - a[2]];
    let ac = [c[0] - a[0], c[1] - a[1], c[2] - a[2]];
    let cross = [
        ab[1] * ac[2] - ab[2] * ac[1],
        ab[2] * ac[0] - ab[0] * ac[2],
        ab[0] * ac[1] - ab[1] * ac[0],
    ];
    let norm = (cross[0] * cross[0] + cross[1] * cross[1] + cross[2] * cross[2]).sqrt();
    if norm <= f64::EPSILON {
        return None;
    }
    Some([cross[0] / norm, cross[1] / norm, cross[2] / norm])
}

fn mesh_manifest_regions(scene: &SceneDocument, mesh: &FemMeshPayload) -> Vec<MeshRegionResource> {
    scene
        .objects
        .iter()
        .flat_map(|object| {
            let mut regions = Vec::new();
            if let Some(region) = mesh_manifest_region_for_object(object, mesh) {
                regions.push(region);
            }
            regions.extend(
                object
                    .regions
                    .iter()
                    .filter(|region| region.enabled)
                    .filter_map(|region| {
                        mesh_manifest_region_for_object_region(object, region, mesh)
                    }),
            );
            regions
        })
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

fn mesh_manifest_region_for_object_region(
    object: &SceneObject,
    region: &fullmag_authoring::SceneObjectRegion,
    mesh: &FemMeshPayload,
) -> Option<MeshRegionResource> {
    let region_id = region.region_id.trim();
    let region_name = region.name.trim();
    if region_id.is_empty() && region_name.is_empty() {
        return None;
    }
    let geometry_aliases = region_geometry_aliases(region_id, region_name);
    let matches_region_geometry = |geometry_id: Option<&str>| {
        geometry_id
            .map(|id| geometry_aliases.contains(id))
            .unwrap_or(false)
    };
    let mesh_part_ids = mesh
        .mesh_parts
        .iter()
        .filter(|part| {
            part.object_id
                .as_deref()
                .map(|id| object_ids_match(id, &object.id))
                .unwrap_or(false)
                && matches_region_geometry(part.geometry_id.as_deref())
        })
        .map(|part| part.id.clone())
        .collect::<Vec<_>>();
    let element_count = mesh
        .object_segments
        .iter()
        .filter(|segment| {
            object_ids_match(&segment.object_id, &object.id)
                && matches_region_geometry(segment.geometry_id.as_deref())
        })
        .map(|segment| segment.element_count)
        .sum::<u32>();
    if mesh_part_ids.is_empty() && element_count == 0 {
        return None;
    }
    let bounds = region_mesh_bounds(object, region, mesh);
    let candidate_id = if !region_id.is_empty() {
        region_id.to_string()
    } else {
        region.name.clone()
    };
    Some(MeshRegionResource {
        region_id: candidate_id.clone(),
        name: region.name.clone(),
        source_object_ids: vec![object.id.clone()],
        source_region_candidate_id: Some(candidate_id),
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

fn region_mesh_bounds(
    object: &SceneObject,
    region: &fullmag_authoring::SceneObjectRegion,
    mesh: &FemMeshPayload,
) -> Option<([f64; 3], [f64; 3])> {
    let region_id = region.region_id.trim();
    let region_name = region.name.trim();
    let geometry_aliases = region_geometry_aliases(region_id, region_name);
    mesh.mesh_parts
        .iter()
        .filter(|part| {
            part.object_id
                .as_deref()
                .map(|id| object_ids_match(id, &object.id))
                .unwrap_or(false)
                && part
                    .geometry_id
                    .as_deref()
                    .map(|id| geometry_aliases.contains(id))
                    .unwrap_or(false)
        })
        .filter_map(|part| part.bounds_min.zip(part.bounds_max))
        .fold(None, |current, (min, max)| {
            Some(match current {
                Some((current_min, current_max)) => {
                    (min_vec3(current_min, min), max_vec3(current_max, max))
                }
                None => (min, max),
            })
        })
}

fn min_vec3(a: [f64; 3], b: [f64; 3]) -> [f64; 3] {
    [a[0].min(b[0]), a[1].min(b[1]), a[2].min(b[2])]
}

fn max_vec3(a: [f64; 3], b: [f64; 3]) -> [f64; 3] {
    [a[0].max(b[0]), a[1].max(b[1]), a[2].max(b[2])]
}

fn object_ids_match(a: &str, b: &str) -> bool {
    if a == b {
        return true;
    }
    let clean_a = a.strip_suffix("_geom").unwrap_or(a);
    let clean_b = b.strip_suffix("_geom").unwrap_or(b);
    clean_a == clean_b
}

fn region_geometry_aliases(region_id: &str, region_name: &str) -> BTreeSet<String> {
    let mut aliases = BTreeSet::new();
    push_region_geometry_aliases(&mut aliases, region_id);
    push_region_geometry_aliases(&mut aliases, region_name);
    aliases
}

fn push_region_geometry_aliases(aliases: &mut BTreeSet<String>, value: &str) {
    let trimmed = value.trim();
    if trimmed.is_empty() {
        return;
    }
    aliases.insert(trimmed.to_string());
    if let Some(clean) = trimmed.strip_suffix("_geom") {
        aliases.insert(clean.to_string());
    } else {
        aliases.insert(format!("{trimmed}_geom"));
    }
    aliases.insert(trimmed.replace(':', "_"));
    aliases.insert(trimmed.replace(':', "%3A"));
}

fn subset_object_mesh(mesh: &FemMeshPayload, object_id: &str) -> Option<FemMeshPayload> {
    if let Some(part) = mesh.mesh_parts.iter().find(|part| {
        part.role == "magnetic_object"
            && part
                .object_id
                .as_deref()
                .map(|id| object_ids_match(id, object_id))
                .unwrap_or(false)
    }) {
        return subset_part_mesh(mesh, &part.id);
    }

    let segment = mesh
        .object_segments
        .iter()
        .find(|segment| object_ids_match(&segment.object_id, object_id))?;
    let part = FemMeshPartPayload {
        id: object_id.to_string(),
        label: object_id.to_string(),
        role: "magnetic_object".to_string(),
        object_id: Some(object_id.to_string()),
        geometry_id: segment.geometry_id.clone(),
        material_id: None,
        element_start: segment.element_start,
        element_count: segment.element_count,
        boundary_face_start: segment.boundary_face_start,
        boundary_face_count: segment.boundary_face_count,
        boundary_face_indices: Vec::new(),
        node_start: segment.node_start,
        node_count: segment.node_count,
        node_indices: Vec::new(),
        surface_faces: Vec::new(),
        bounds_min: None,
        bounds_max: None,
    };

    subset_part_payload(mesh, &part, object_id)
}

fn interface_quality(mesh: &FemMeshPayload, interface_id: &str) -> Option<Value> {
    let owners = parse_interface_owners(interface_id);
    let interface_part = mesh.mesh_parts.iter().find(|part| {
        if part.role != "interface" {
            return false;
        }
        if part.id == interface_id || part.label == interface_id {
            return true;
        }
        let Some((left, right)) = owners.as_ref() else {
            return false;
        };
        (part.id.contains(left) && part.id.contains(right))
            || (part.label.contains(left) && part.label.contains(right))
    })?;

    let mut interface_faces = Vec::new();
    if !interface_part.surface_faces.is_empty() {
        interface_faces.extend(interface_part.surface_faces.iter().copied());
    } else if !interface_part.boundary_face_indices.is_empty() {
        for index in &interface_part.boundary_face_indices {
            if let Some(face) = mesh.boundary_faces.get(*index as usize) {
                interface_faces.push(*face);
            }
        }
    } else {
        let start = interface_part.boundary_face_start as usize;
        let end = start.saturating_add(interface_part.boundary_face_count as usize);
        interface_faces.extend(mesh.boundary_faces.get(start..end)?.iter().copied());
    }

    let mut adjacent_markers = BTreeSet::new();
    for face in &interface_faces {
        let face_nodes = [face[0], face[1], face[2]];
        for (element_index, element) in mesh.elements.iter().enumerate() {
            if face_nodes.iter().all(|node| element.contains(node)) {
                if let Some(marker) = mesh.element_markers.get(element_index) {
                    adjacent_markers.insert(*marker);
                }
            }
        }
    }

    let per_domain_quality = adjacent_markers
        .iter()
        .filter_map(|marker| {
            mesh.per_domain_quality
                .get(marker)
                .and_then(|quality| serde_json::to_value(quality).ok())
                .map(|quality| (marker.to_string(), quality))
        })
        .collect::<serde_json::Map<_, _>>();

    let bounds = bounds_for_node_indices(mesh, &interface_part.node_indices)
        .or_else(|| bounds_for_surface_faces(mesh, &interface_faces));

    Some(json!({
        "part_id": interface_part.id,
        "label": interface_part.label,
        "face_count": interface_faces.len(),
        "node_count": interface_part.node_count,
        "adjacent_markers": adjacent_markers.into_iter().collect::<Vec<_>>(),
        "per_domain_quality": Value::Object(per_domain_quality),
        "bounds_min": bounds.map(|(min, _)| min).unwrap_or([0.0, 0.0, 0.0]),
        "bounds_max": bounds.map(|(_, max)| max).unwrap_or([0.0, 0.0, 0.0]),
    }))
}

fn bounds_for_node_indices(
    mesh: &FemMeshPayload,
    node_indices: &[u32],
) -> Option<([f64; 3], [f64; 3])> {
    let mut iter = node_indices
        .iter()
        .filter_map(|index| mesh.nodes.get(*index as usize).copied());
    let first = iter.next()?;
    let mut min = first;
    let mut max = first;
    for node in iter {
        for axis in 0..3 {
            min[axis] = min[axis].min(node[axis]);
            max[axis] = max[axis].max(node[axis]);
        }
    }
    Some((min, max))
}

fn bounds_for_surface_faces(
    mesh: &FemMeshPayload,
    faces: &[[u32; 3]],
) -> Option<([f64; 3], [f64; 3])> {
    let node_indices = faces
        .iter()
        .flat_map(|face| face.iter().copied())
        .collect::<BTreeSet<_>>()
        .into_iter()
        .collect::<Vec<_>>();
    bounds_for_node_indices(mesh, &node_indices)
}

fn subset_part_mesh(mesh: &FemMeshPayload, part_id: &str) -> Option<FemMeshPayload> {
    let part = mesh.mesh_parts.iter().find(|part| part.id == part_id)?;
    subset_part_payload(mesh, part, &format!("part:{part_id}"))
}

fn subset_part_payload(
    mesh: &FemMeshPayload,
    part: &FemMeshPartPayload,
    mesh_suffix: &str,
) -> Option<FemMeshPayload> {
    let source_node_indices = collect_part_source_node_indices(mesh, part)?;
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
    if boundary_faces.is_empty() && !surface_faces.is_empty() {
        boundary_faces.extend(surface_faces.iter().copied());
    }
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
        mesh_name: format!("{}:{mesh_suffix}", mesh.mesh_name),
        mesh_id: format!("{}:{mesh_suffix}", mesh.mesh_id),
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
        build_report: mesh.build_report.clone(),
    })
}

fn collect_part_source_node_indices(
    mesh: &FemMeshPayload,
    part: &FemMeshPartPayload,
) -> Option<Vec<u32>> {
    let mut source_node_indices = BTreeSet::new();
    if part.node_indices.is_empty() {
        let node_start = part.node_start as usize;
        let node_end = node_start.saturating_add(part.node_count as usize);
        if node_start < node_end {
            mesh.nodes.get(node_start..node_end)?;
            source_node_indices.extend((node_start..node_end).map(|index| index as u32));
        }
    } else {
        for node_index in &part.node_indices {
            mesh.nodes.get(*node_index as usize)?;
            source_node_indices.insert(*node_index);
        }
    }

    let element_start = part.element_start as usize;
    let element_end = element_start.saturating_add(part.element_count as usize);
    if element_start < element_end {
        for element in mesh.elements.get(element_start..element_end)? {
            source_node_indices.extend(element.iter().copied());
        }
    }

    if part.boundary_face_indices.is_empty() {
        let face_start = part.boundary_face_start as usize;
        let face_end = face_start.saturating_add(part.boundary_face_count as usize);
        if face_start < face_end {
            for face in mesh.boundary_faces.get(face_start..face_end)? {
                source_node_indices.extend(face.iter().copied());
            }
        }
    } else {
        for face_index in &part.boundary_face_indices {
            let face = mesh.boundary_faces.get(*face_index as usize)?;
            source_node_indices.extend(face.iter().copied());
        }
    }

    for face in &part.surface_faces {
        source_node_indices.extend(face.iter().copied());
    }

    Some(source_node_indices.into_iter().collect())
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn subset_part_mesh_uses_explicit_node_indices_for_shared_airbox_nodes() {
        let mesh = FemMeshPayload {
            mesh_name: "shared".to_string(),
            mesh_id: "shared:1".to_string(),
            nodes: vec![
                [0.0, 0.0, 0.0],
                [1.0, 0.0, 0.0],
                [0.0, 1.0, 0.0],
                [0.0, 0.0, 1.0],
                [0.0, 0.0, -1.0],
            ],
            elements: vec![[0, 1, 2, 3], [0, 1, 2, 4]],
            element_markers: vec![1, 0],
            boundary_faces: vec![[0, 1, 3], [0, 1, 4]],
            boundary_markers: vec![10, 99],
            periodic_boundary_pairs: Vec::new(),
            periodic_node_pairs: Vec::new(),
            object_segments: Vec::new(),
            mesh_parts: vec![FemMeshPartPayload {
                id: "part:__air__".to_string(),
                label: "Airbox".to_string(),
                role: "air".to_string(),
                object_id: None,
                geometry_id: None,
                material_id: None,
                element_start: 1,
                element_count: 1,
                boundary_face_start: 1,
                boundary_face_count: 1,
                boundary_face_indices: Vec::new(),
                node_start: 4,
                node_count: 4,
                node_indices: vec![0, 1, 2, 4],
                surface_faces: Vec::new(),
                bounds_min: None,
                bounds_max: None,
            }],
            domain_mesh_mode: Some("shared_domain_mesh_with_air".to_string()),
            domain_frame: None,
            generation_id: None,
            per_domain_quality: HashMap::new(),
        };

        let part_mesh =
            subset_part_mesh(&mesh, "part:__air__").expect("part topology should remap");

        assert_eq!(part_mesh.nodes.len(), 4);
        assert_eq!(part_mesh.elements, vec![[0, 1, 2, 3]]);
        assert_eq!(part_mesh.element_markers, vec![0]);
        assert_eq!(part_mesh.boundary_faces, vec![[0, 1, 3]]);
        assert_eq!(part_mesh.mesh_parts[0].node_count, 4);
    }

    #[test]
    fn subset_part_mesh_promotes_surface_faces_to_binary_boundary_faces() {
        let mesh = FemMeshPayload {
            mesh_name: "shared".to_string(),
            mesh_id: "shared:1".to_string(),
            nodes: vec![[0.0, 0.0, 0.0], [1.0, 0.0, 0.0], [0.0, 1.0, 0.0]],
            elements: Vec::new(),
            element_markers: Vec::new(),
            boundary_faces: Vec::new(),
            boundary_markers: Vec::new(),
            periodic_boundary_pairs: Vec::new(),
            periodic_node_pairs: Vec::new(),
            object_segments: Vec::new(),
            mesh_parts: vec![FemMeshPartPayload {
                id: "part:interface:0:1".to_string(),
                label: "Air ↔ body".to_string(),
                role: "interface".to_string(),
                object_id: None,
                geometry_id: None,
                material_id: None,
                element_start: 0,
                element_count: 0,
                boundary_face_start: 0,
                boundary_face_count: 0,
                boundary_face_indices: Vec::new(),
                node_start: 0,
                node_count: 0,
                node_indices: vec![0, 1, 2],
                surface_faces: vec![[0, 1, 2]],
                bounds_min: None,
                bounds_max: None,
            }],
            domain_mesh_mode: Some("shared_domain_mesh_with_air".to_string()),
            domain_frame: None,
            generation_id: None,
            per_domain_quality: HashMap::new(),
        };

        let part_mesh = subset_part_mesh(&mesh, "part:interface:0:1")
            .expect("interface topology should remap surface faces");

        assert_eq!(part_mesh.nodes.len(), 3);
        assert_eq!(part_mesh.boundary_faces, vec![[0, 1, 2]]);
        assert_eq!(part_mesh.mesh_parts[0].surface_faces, vec![[0, 1, 2]]);
    }

    #[test]
    fn subset_object_mesh_fallback_remaps_segment_elements_with_shared_nodes() {
        let mesh = FemMeshPayload {
            mesh_name: "shared".to_string(),
            mesh_id: "shared:1".to_string(),
            nodes: vec![
                [0.0, 0.0, 0.0],
                [1.0, 0.0, 0.0],
                [0.0, 1.0, 0.0],
                [0.0, 0.0, 1.0],
                [0.0, 0.0, -1.0],
            ],
            elements: vec![[0, 1, 2, 4]],
            element_markers: vec![1],
            boundary_faces: vec![[0, 1, 4]],
            boundary_markers: vec![10],
            periodic_boundary_pairs: Vec::new(),
            periodic_node_pairs: Vec::new(),
            object_segments: vec![FemMeshObjectSegment {
                object_id: "body".to_string(),
                geometry_id: Some("body_geom".to_string()),
                node_start: 4,
                node_count: 1,
                element_start: 0,
                element_count: 1,
                boundary_face_start: 0,
                boundary_face_count: 1,
            }],
            mesh_parts: Vec::new(),
            domain_mesh_mode: Some("shared_domain_mesh_with_air".to_string()),
            domain_frame: None,
            generation_id: None,
            per_domain_quality: HashMap::new(),
        };

        let object_mesh = subset_object_mesh(&mesh, "body").expect("object topology should remap");

        assert_eq!(object_mesh.nodes.len(), 4);
        assert_eq!(object_mesh.elements, vec![[0, 1, 2, 3]]);
        assert_eq!(object_mesh.boundary_faces, vec![[0, 1, 3]]);
        assert_eq!(object_mesh.object_segments[0].node_count, 4);
    }
}
