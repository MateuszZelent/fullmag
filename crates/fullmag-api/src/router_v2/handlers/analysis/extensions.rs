use std::collections::{BTreeMap, BTreeSet};
use std::sync::Arc;
use std::time::{SystemTime, UNIX_EPOCH};

use axum::extract::{Path, Query, State};
use axum::Json;
use serde::{Deserialize, Serialize};
use sha2::{Digest, Sha256};
use utoipa::{IntoParams, ToSchema};

use crate::analysis::topological_charge::{
    compute_oriented_charge, fdm_weighted_mean, fem_midpoint_weights, qualify_boundary,
    qualify_support_topology, BoundaryQualification, OrientedChargeInput, OrientedChargeQuality,
    SupportTopologyQualification, TopologicalChargeWarningCode,
};
use crate::error::ApiError;
use crate::fem_slice_overlay::{
    collect_fem_slice_overlay, FemSliceOverlayInput, SliceOverlayPoint,
};
use crate::field_slice::{resolve_slice_query, FemField, FieldSliceQuery, SlicePlane};
use crate::router_v2::handlers::data::field_resolution::is_fdm_snapshot;
use crate::router_v2::handlers::data::resolved_vector_field::{
    expand_compact_fem_node_values, resolve_topological_charge_magnetization,
    ResolvedFieldSourceKind, ResolvedObjectVectorField,
};
use crate::router_v2::handlers::sessions::status::{domain_generation_id, field_quantity_revision};
use crate::schemas::analysis_extensions::{
    TopologicalChargeExecutionProvenance as TopologicalChargeExecutionProvenanceV2,
    TopologicalChargeLayerSample as TopologicalChargeLayerSampleV2,
    TopologicalChargeMethod as TopologicalChargeMethodV2,
    TopologicalChargeMethodDescriptor as TopologicalChargeMethodDescriptorV2,
    TopologicalChargePlane as TopologicalChargePlaneV2,
    TopologicalChargeProvenance as TopologicalChargeProvenanceV2,
    TopologicalChargeQuality as TopologicalChargeQualityV2, TopologicalChargeQueryV2,
    TopologicalChargeRequestEcho as TopologicalChargeRequestEchoV2,
    TopologicalChargeResolvedSupport as TopologicalChargeResolvedSupportV2,
    TopologicalChargeResourceV2, TopologicalChargeStatus as TopologicalChargeStatusV2,
    TopologicalChargeSupportFrame as TopologicalChargeSupportFrameV2,
    TopologicalChargeTrust as TopologicalChargeTrustV2,
};
use crate::types::AppState;

#[derive(Debug, Clone, Deserialize, IntoParams, ToSchema)]
pub struct TopologicalChargeQuery {
    #[serde(default = "default_quantity_id")]
    pub quantity_id: String,
    #[serde(default = "default_plane")]
    pub plane: String,
    #[serde(default = "default_resolution")]
    pub resolution: String,
    #[serde(default)]
    pub snapshot_id: Option<String>,
    #[serde(default)]
    pub stage_id: Option<String>,
    #[serde(default = "default_method")]
    pub method: String,
    #[serde(default = "default_support")]
    pub support: String,
    #[serde(default)]
    pub profile_samples: Option<u16>,
}

#[derive(Debug, Clone, Serialize, Deserialize, ToSchema)]
pub struct TopologicalChargeSampleGrid {
    pub nx: u32,
    pub ny: u32,
    pub plane: String,
}

#[derive(Debug, Clone, Serialize, Deserialize, ToSchema)]
pub struct TopologicalChargeSampleTopology {
    pub kind: String,
    pub point_count: usize,
    pub triangle_count: usize,
}

#[derive(Debug, Clone, Serialize, Deserialize, ToSchema)]
pub struct TopologicalChargeLayerSample {
    pub index: usize,
    pub coordinate: f64,
    pub charge: Option<f64>,
    pub sample_count: usize,
    pub valid_sample_count: usize,
    pub triangle_count: usize,
    pub certification: Option<SupportCertification>,
}

#[derive(Debug, Clone, Serialize, Deserialize, ToSchema)]
pub struct TopologicalChargeWarning {
    pub code: String,
    pub message: String,
}

#[derive(Debug, Clone, Serialize, Deserialize, ToSchema)]
#[serde(rename_all = "snake_case")]
pub enum TopologicalChargeStatus {
    Ready,
    NoCurrentMagnetization,
    EmptySupport,
    InvalidMagnetization,
    DegenerateSupport,
    UnderResolved,
    Stale,
    UnsupportedGeometry,
    Error,
}

#[derive(Debug, Clone, Serialize, Deserialize, ToSchema)]
pub struct TopologicalChargeResource {
    pub object_id: String,
    pub quantity_id: String,
    pub revision: u64,
    pub status: TopologicalChargeStatus,
    pub charge: Option<f64>,
    pub nearest_integer: Option<i64>,
    pub integer_error: Option<f64>,
    pub method: String,
    pub plane: String,
    pub sample_grid: Option<TopologicalChargeSampleGrid>,
    pub sample_topology: Option<TopologicalChargeSampleTopology>,
    pub layer_samples: Vec<TopologicalChargeLayerSample>,
    pub sample_count: usize,
    pub valid_sample_count: usize,
    pub field_revision: Option<u64>,
    pub domain_generation_id: Option<String>,
    pub mesh_generation_id: Option<String>,
    pub mesh_revision: Option<u64>,
    pub computed_at_unix_ms: u64,
    pub warnings: Vec<TopologicalChargeWarning>,
    pub certification: Option<SupportCertification>,
}

#[derive(Debug, Clone, Serialize, Deserialize, ToSchema)]
pub struct SupportCertification {
    pub charge: f64,
    pub trust: TopologicalChargeTrustV2,
    pub quality: TopologicalChargeQualityV2,
}

fn default_quantity_id() -> String {
    "m".to_string()
}

fn default_plane() -> String {
    "auto".to_string()
}

fn default_resolution() -> String {
    "auto".to_string()
}

fn default_method() -> String {
    "berg_luescher".to_string()
}

fn default_support() -> String {
    "midplane".to_string()
}

async fn get_object_topological_charge_legacy(
    State(state): State<Arc<AppState>>,
    Path(object_id): Path<String>,
    Query(query): Query<TopologicalChargeQuery>,
    resolved_field_summary: Option<FieldSampleSummary>,
) -> Result<Json<TopologicalChargeResource>, ApiError> {
    let snapshot = state
        .current_live_state
        .read()
        .await
        .clone()
        .ok_or_else(|| ApiError::not_found("no active local live workspace"))?;
    let scene = snapshot
        .scene_document
        .as_ref()
        .ok_or_else(|| ApiError::not_found("no authoring scene"))?;
    let object = scene
        .objects
        .iter()
        .find(|object| object.id == object_id || object.name == object_id)
        .ok_or_else(|| ApiError::not_found(format!("object not found: {object_id}")))?;
    let requested_resolution = query.resolution;
    let requested_method = query.method;
    let requested_snapshot = query.snapshot_id.as_deref().unwrap_or("latest");
    let field_summary = resolved_field_summary;
    let mesh = snapshot.fem_mesh.as_ref();
    let field_revision = field_summary
        .as_ref()
        .map(|_| field_quantity_revision(&snapshot, &query.quantity_id).max(1));
    let field_revision_token = field_revision.unwrap_or(0);
    let mesh_revision_token = mesh.map_or(0, |_| snapshot.mesh_revision.max(1));
    let request_scope = format!(
        "resolution={requested_resolution}:support={}:profile={:?}:snapshot={:?}:stage={:?}",
        query.support, query.profile_samples, query.snapshot_id, query.stage_id
    );
    let cache_key = crate::quantity_data_plane::topological_charge_cache_key(
        &object.id,
        &query.quantity_id,
        field_revision_token,
        mesh_revision_token,
        mesh.and_then(|mesh| mesh.generation_id.as_deref()),
        scene.revision,
        &query.plane,
        &request_scope,
        &requested_method,
    );
    if let Some(cached) = state
        .quantity_data_plane
        .topological_charge_cache
        .lock()
        .await
        .get(&cache_key)
    {
        if let Ok(resource) = serde_json::from_value::<TopologicalChargeResource>(cached) {
            return Ok(Json(resource));
        }
    }
    let sampled_result = match (field_summary.as_ref(), mesh) {
        (Some(summary), None) => {
            compute_regular_fdm_topological_charge(summary, &query.plane, &query.support)
        }
        (Some(summary), Some(mesh)) => compute_fem_topological_charge(
            summary,
            mesh,
            &object.id,
            &query.plane,
            &query.support,
            query.profile_samples,
        ),
        _ => None,
    };
    let missing_fem_mesh = mesh.is_none();
    let sampled_result_has_valid_samples = sampled_result
        .as_ref()
        .is_some_and(|result| result.result.valid_sample_count > 0);
    let status = TopologicalChargeStatus::from_inputs(
        field_summary.as_ref(),
        sampled_result.as_ref(),
        sampled_result_has_valid_samples,
        missing_fem_mesh,
    );
    let warnings = topological_charge_warnings(
        &status,
        requested_snapshot,
        &requested_resolution,
        field_summary
            .as_ref()
            .map_or(0, |summary| summary.sample_count),
        sampled_result.as_ref(),
    );
    let charge: Option<f64> = matches!(status, TopologicalChargeStatus::Ready)
        .then(|| sampled_result.as_ref().map(|result| result.result.charge))
        .flatten();
    let nearest_integer = charge.map(|value| value.round() as i64);
    let integer_error = charge
        .zip(nearest_integer)
        .map(|(value, nearest)| (value - nearest as f64).abs());
    let resolved_plane = sampled_result
        .as_ref()
        .map_or_else(|| query.plane.clone(), |result| result.plane.clone());

    let resource = TopologicalChargeResource {
        object_id: object.id.clone(),
        quantity_id: query.quantity_id,
        revision: scene.revision,
        status,
        charge,
        nearest_integer,
        integer_error,
        method: sampled_result
            .as_ref()
            .map_or_else(|| requested_method.clone(), |result| result.method.clone()),
        plane: resolved_plane,
        sample_grid: sampled_result
            .as_ref()
            .and_then(|result| result.sample_grid.clone()),
        sample_topology: sampled_result
            .as_ref()
            .and_then(|result| result.sample_topology.clone()),
        layer_samples: sampled_result
            .as_ref()
            .map_or_else(Vec::new, |result| result.layer_samples.clone()),
        sample_count: sampled_result.as_ref().map_or_else(
            || {
                field_summary
                    .as_ref()
                    .map_or(0, |summary| summary.sample_count)
            },
            |result| result.result.sample_count,
        ),
        valid_sample_count: sampled_result.as_ref().map_or_else(
            || {
                field_summary
                    .as_ref()
                    .map_or(0, |summary| summary.valid_sample_count)
            },
            |result| result.result.valid_sample_count,
        ),
        field_revision,
        domain_generation_id: Some(domain_generation_id(&snapshot).to_string()),
        mesh_generation_id: mesh.and_then(|mesh| mesh.generation_id.clone()),
        mesh_revision: mesh.map(|_| snapshot.mesh_revision.max(1)),
        computed_at_unix_ms: unix_ms_now(),
        warnings,
        certification: sampled_result.and_then(|result| result.certification),
    };
    if let Ok(value) = serde_json::to_value(&resource) {
        state
            .quantity_data_plane
            .topological_charge_cache
            .lock()
            .await
            .insert(cache_key, value);
    }
    Ok(Json(resource))
}

#[utoipa::path(
    get,
    path = "/v2/sessions/current/analysis/extensions/objects/{object_id}/topological-charge",
    params(("object_id" = String, Path, description = "Object id"), TopologicalChargeQueryV2),
    responses((status = 200, description = "Versioned topological charge resource", body = TopologicalChargeResourceV2)),
    tag = "analysis"
)]
pub async fn get_object_topological_charge(
    State(state): State<Arc<AppState>>,
    Path(object_id): Path<String>,
    Query(query): Query<TopologicalChargeQueryV2>,
) -> Result<Json<TopologicalChargeResourceV2>, ApiError> {
    query
        .validate()
        .map_err(|error| ApiError::bad_request(error.to_string()))?;
    let snapshot = state
        .current_live_state
        .read()
        .await
        .clone()
        .ok_or_else(|| ApiError::not_found("no active local live workspace"))?;
    let scene = snapshot
        .scene_document
        .as_ref()
        .ok_or_else(|| ApiError::not_found("no authoring scene"))?;
    if !scene
        .objects
        .iter()
        .any(|object| object.id == object_id || object.name == object_id)
    {
        return Err(ApiError::not_found(format!(
            "object not found: {object_id}"
        )));
    }
    let resolved_field = resolve_topological_charge_magnetization(
        &state,
        &snapshot,
        query.snapshot_id.as_deref(),
        query.stage_id.as_deref(),
    )
    .await?;
    let field_summary = resolved_field
        .as_ref()
        .map(|field| field_summary_from_resolved_field(field, snapshot.fem_mesh.as_ref()))
        .transpose()?;
    let requested_plane = match query.plane {
        TopologicalChargePlaneV2::Auto => "auto",
        TopologicalChargePlaneV2::Xy => "xy",
        TopologicalChargePlaneV2::Xz => "xz",
        TopologicalChargePlaneV2::Yz => "yz",
    };
    let cache_key = crate::quantity_data_plane::topological_charge_cache_key(
        &object_id,
        "m",
        resolved_field.as_ref().map_or_else(
            || field_quantity_revision(&snapshot, "m"),
            |field| field.field_revision,
        ),
        snapshot
            .fem_mesh
            .as_ref()
            .map_or(0, |_| snapshot.mesh_revision.max(1)),
        snapshot
            .fem_mesh
            .as_ref()
            .and_then(|mesh| mesh.generation_id.as_deref()),
        scene.revision,
        requested_plane,
        &format!(
            "support={:?}:profile={:?}:snapshot={:?}:stage={:?}",
            query.support, query.profile_samples, query.snapshot_id, query.stage_id
        ),
        "berg_luescher_oriented_triangles_v2",
    );
    if let Some(cached) = state
        .quantity_data_plane
        .topological_charge_cache
        .lock()
        .await
        .get(&cache_key)
    {
        if let Ok(resource) = serde_json::from_value::<TopologicalChargeResourceV2>(cached) {
            return Ok(Json(resource));
        }
    }
    let fdm_qualification = (snapshot.fem_mesh.is_none()
        && query.support
            == crate::schemas::analysis_extensions::TopologicalChargeSupportMode::Midplane)
        .then(|| {
            field_summary.as_ref().and_then(|summary| {
                qualify_regular_fdm_midplane(
                    summary,
                    match query.plane {
                        TopologicalChargePlaneV2::Auto => "auto",
                        TopologicalChargePlaneV2::Xy => "xy",
                        TopologicalChargePlaneV2::Xz => "xz",
                        TopologicalChargePlaneV2::Yz => "yz",
                    },
                )
            })
        })
        .flatten();
    let fem_fe_order = fem_fe_order_from_session(&snapshot);
    let legacy_query = TopologicalChargeQuery {
        quantity_id: "m".to_string(),
        plane: match query.plane {
            TopologicalChargePlaneV2::Auto => "auto",
            TopologicalChargePlaneV2::Xy => "xy",
            TopologicalChargePlaneV2::Xz => "xz",
            TopologicalChargePlaneV2::Yz => "yz",
        }
        .to_string(),
        resolution: "auto".to_string(),
        snapshot_id: query.snapshot_id.clone(),
        stage_id: query.stage_id.clone(),
        method: "berg_luescher_oriented_triangles_v2".to_string(),
        support: match query.support {
            crate::schemas::analysis_extensions::TopologicalChargeSupportMode::Midplane => {
                "midplane"
            }
            crate::schemas::analysis_extensions::TopologicalChargeSupportMode::LayerProfile => {
                "layer_profile"
            }
        }
        .to_string(),
        profile_samples: query.resolved_profile_sample_count(),
    };
    let legacy = get_object_topological_charge_legacy(
        State(state.clone()),
        Path(object_id.clone()),
        Query(legacy_query),
        field_summary,
    )
    .await?
    .0;
    let is_fem = snapshot.fem_mesh.is_some() && !is_fdm_snapshot(&snapshot);
    let unsupported_fem_order = is_fem && fem_fe_order != Some(1);
    let unsupported_fdm_scope = !is_fem
        && fdm_requires_object_mask(
            snapshot
                .scene_document
                .as_ref()
                .map(|scene| scene.objects.len()),
        );
    let fem_certification = legacy.certification.as_ref();
    let status = if unsupported_fem_order {
        TopologicalChargeStatusV2::UnsupportedDiscretization
    } else if unsupported_fdm_scope {
        TopologicalChargeStatusV2::UnsupportedGeometry
    } else {
        match legacy.status {
            TopologicalChargeStatus::Ready => TopologicalChargeStatusV2::Ready,
            TopologicalChargeStatus::NoCurrentMagnetization => {
                TopologicalChargeStatusV2::NoCurrentMagnetization
            }
            TopologicalChargeStatus::EmptySupport => TopologicalChargeStatusV2::EmptySupport,
            TopologicalChargeStatus::InvalidMagnetization => {
                TopologicalChargeStatusV2::InvalidMagnetization
            }
            TopologicalChargeStatus::DegenerateSupport => {
                TopologicalChargeStatusV2::DegenerateSupport
            }
            TopologicalChargeStatus::UnderResolved => TopologicalChargeStatusV2::UnderResolved,
            _ => TopologicalChargeStatusV2::UnsupportedGeometry,
        }
    };
    let requested_plane = query.plane;
    let resolved_plane = topological_charge_plane_from_legacy(&legacy.plane);
    let profile = if unsupported_fem_order || unsupported_fdm_scope {
        Vec::new()
    } else {
        topological_charge_profile_response(
            &legacy,
            is_fem,
            query.support,
            fdm_profile_geometry(&snapshot),
        )
    };
    let frame = match resolved_plane {
        TopologicalChargePlaneV2::Xy | TopologicalChargePlaneV2::Auto => {
            ([1, 0, 0], [0, 1, 0], [0, 0, 1])
        }
        TopologicalChargePlaneV2::Xz => ([1, 0, 0], [0, 0, 1], [0, -1, 0]),
        TopologicalChargePlaneV2::Yz => ([0, 1, 0], [0, 0, 1], [1, 0, 0]),
    };
    let charge = (!(unsupported_fem_order || unsupported_fdm_scope))
        .then(|| {
            fdm_qualification
                .as_ref()
                .map(|qualification| qualification.charge)
                .or_else(|| fem_certification.map(|certification| certification.charge))
                .or(legacy.charge)
        })
        .flatten();
    let trust = if unsupported_fem_order || unsupported_fdm_scope {
        TopologicalChargeTrustV2::Unavailable
    } else if charge.is_none() {
        TopologicalChargeTrustV2::Unavailable
    } else if let Some(qualification) = &fdm_qualification {
        qualification.trust()
    } else if let Some(certification) = fem_certification {
        certification.trust
    } else if matches!(status, TopologicalChargeStatusV2::UnderResolved) {
        TopologicalChargeTrustV2::DiagnosticResolution
    } else {
        // A profile aggregates several certified planar supports. It has no
        // single two-dimensional topology or boundary whose integer semantics
        // could be certified without a separate three-dimensional contract.
        TopologicalChargeTrustV2::DiagnosticTopology
    };
    let integer_interpretation_is_qualified = matches!(trust, TopologicalChargeTrustV2::Qualified);
    let resource = TopologicalChargeResourceV2 {
        schema_version: "topological_charge.v2".to_string(),
        resource_revision: topological_charge_cache_digest(&cache_key),
        object_id,
        status,
        trust,
        charge,
        nearest_integer: integer_interpretation_is_qualified
            .then(|| charge.map(|value| value.round() as i64))
            .flatten(),
        integer_error: integer_interpretation_is_qualified
            .then(|| charge.map(|value| (value - value.round()).abs()))
            .flatten(),
        request: TopologicalChargeRequestEchoV2 {
            requested_plane,
            requested_support: query.support,
            requested_profile_samples: query.profile_samples,
            snapshot_id: query.snapshot_id.clone(),
            stage_id: query.stage_id.clone(),
        },
        resolved_support: TopologicalChargeResolvedSupportV2 {
            plane: resolved_plane,
            support: query.support,
            profile_sample_count: query.resolved_profile_sample_count(),
            source_kind: resolved_field
                .as_ref()
                .map_or_else(|| "unavailable".to_string(), resolved_field_source_kind),
            coordinate_m: None,
        },
        support_frame: TopologicalChargeSupportFrameV2 {
            u_axis: frame.0,
            v_axis: frame.1,
            normal_axis: frame.2,
        },
        profile,
        quality: fdm_qualification.as_ref().map_or_else(
            || fem_certification.map_or_else(|| TopologicalChargeQualityV2 {
                total_vertex_count: legacy.sample_count as u64,
                valid_vertex_count: legacy.valid_sample_count as u64,
                total_triangle_count: 0,
                valid_triangle_count: 0,
                invalid_triangle_count: 0,
                exceptional_triangle_count: 0,
                max_edge_angle_rad: None,
                min_abs_solid_angle_denominator: None,
                connected_component_count: 0,
                boundary_edge_count: 0,
                boundary_loop_count: 0,
                euler_characteristic: None,
                boundary_max_deviation_rad: None,
            }, |certification| certification.quality.clone()),
            |qualification| TopologicalChargeQualityV2 {
                total_vertex_count: qualification.quality.total_vertex_count as u64,
                valid_vertex_count: qualification.quality.valid_vertex_count as u64,
                total_triangle_count: qualification.quality.total_triangle_count as u64,
                valid_triangle_count: qualification.quality.valid_triangle_count as u64,
                invalid_triangle_count: qualification.quality.invalid_triangle_count as u64,
                exceptional_triangle_count: qualification.quality.exceptional_triangle_count as u64,
                max_edge_angle_rad: Some(qualification.quality.max_edge_angle_rad),
                min_abs_solid_angle_denominator: Some(
                    qualification.quality.min_abs_solid_angle_denominator,
                ),
                connected_component_count: qualification.topology.connected_component_count as u32,
                boundary_edge_count: qualification.topology.boundary_edge_count as u64,
                boundary_loop_count: qualification.topology.boundary_loop_count as u32,
                euler_characteristic: Some(qualification.topology.euler_characteristic),
                boundary_max_deviation_rad: qualification.boundary.max_deviation_rad,
            },
        ),
        provenance: TopologicalChargeProvenanceV2 {
            source_kind: resolved_field
                .as_ref()
                .map_or_else(|| "unavailable".to_string(), resolved_field_source_kind),
            field_id: "m".to_string(),
            field_revision: resolved_field.as_ref().map_or_else(
                || legacy.field_revision.unwrap_or_default().to_string(),
                |field| field.field_revision.to_string(),
            ),
            field_storage_domain: resolved_field.as_ref().map_or_else(
                || "unknown".to_string(),
                |field| field.field_storage_domain.clone(),
            ),
            field_node_mapping_id: resolved_field
                .as_ref()
                .and_then(|field| field.field_node_mapping_id.clone()),
            scene_revision: legacy.revision.to_string(),
            mesh_revision: legacy.mesh_revision.map(|value| value.to_string()),
            mesh_generation_id: legacy.mesh_generation_id,
            domain_generation_id: legacy.domain_generation_id.unwrap_or_default(),
            snapshot_id: resolved_field
                .as_ref()
                .and_then(|field| field.snapshot_id.clone()),
            stage_id: resolved_field
                .as_ref()
                .and_then(|field| field.stage_id.clone()),
            discretization: if is_fem {
                "fem".to_string()
            } else {
                "fdm".to_string()
            },
            fe_order: fem_fe_order,
            requested_execution: TopologicalChargeExecutionProvenanceV2 {
                backend: snapshot.session.requested_backend.clone(),
                device: snapshot.session.requested_device.clone(),
                precision: snapshot.session.requested_precision.clone(),
                mode: snapshot.session.requested_mode.clone(),
                runtime_family: None,
                engine_id: None,
                lossy_fallback_used: false,
            },
            resolved_execution: topological_charge_resolved_execution(&snapshot),
            cache_key_digest: topological_charge_cache_digest(&cache_key),
        },
        method: TopologicalChargeMethodDescriptorV2 {
            id: TopologicalChargeMethodV2::BergLuescherOrientedTrianglesV2,
            version: "2".to_string(),
            quantity_id: "m".to_string(),
        },
        computed_at_unix_ms: legacy.computed_at_unix_ms,
        warnings: unsupported_fem_order
            .then(
                || crate::schemas::analysis_extensions::TopologicalChargeWarning {
                    code: "unsupported_discretization".to_string(),
                    severity: "warning".to_string(),
                    message: "FEM topological charge requires persisted fe_order=1 provenance."
                        .to_string(),
                },
            )
            .into_iter()
            .chain(
                unsupported_fdm_scope
                    .then(|| crate::schemas::analysis_extensions::TopologicalChargeWarning {
                        code: "unsupported_geometry".to_string(),
                        severity: "warning".to_string(),
                        message: "Object-scoped FDM charge requires a per-object cell mask for multi-object scenes."
                            .to_string(),
                    }),
            )
            .chain(legacy.warnings.into_iter().map(|warning| {
                crate::schemas::analysis_extensions::TopologicalChargeWarning {
                    code: warning.code,
                    severity: "warning".to_string(),
                    message: warning.message,
                }
            }))
            .collect(),
    };
    if let Ok(value) = serde_json::to_value(&resource) {
        state
            .quantity_data_plane
            .topological_charge_cache
            .lock()
            .await
            .insert(cache_key, value);
    }
    Ok(Json(resource))
}

fn unix_ms_now() -> u64 {
    SystemTime::now()
        .duration_since(UNIX_EPOCH)
        .map(|duration| duration.as_millis().min(u128::from(u64::MAX)) as u64)
        .unwrap_or(0)
}

fn fem_fe_order_from_session(snapshot: &crate::types::SessionStateResponse) -> Option<u8> {
    fem_fe_order_from_plan_summary(&snapshot.session.plan_summary).or_else(|| {
        snapshot
            .metadata
            .as_ref()
            .and_then(|metadata| metadata.get("execution_plan"))
            .and_then(|plan| plan.get("backend_plan"))
            .and_then(|backend_plan| backend_plan.get("fe_order"))
            .and_then(serde_json::Value::as_u64)
            .and_then(|order| u8::try_from(order).ok())
    })
}

fn topological_charge_resolved_execution(
    snapshot: &crate::types::SessionStateResponse,
) -> Option<TopologicalChargeExecutionProvenanceV2> {
    snapshot
        .session
        .resolved_backend
        .as_ref()
        .map(|backend| TopologicalChargeExecutionProvenanceV2 {
            backend: backend.clone(),
            device: snapshot.session.resolved_device.clone().unwrap_or_default(),
            precision: snapshot
                .session
                .resolved_precision
                .clone()
                .unwrap_or_default(),
            mode: snapshot.session.resolved_mode.clone().unwrap_or_default(),
            runtime_family: snapshot.session.resolved_runtime_family.clone(),
            engine_id: snapshot.session.resolved_engine_id.clone(),
            lossy_fallback_used: snapshot.session.resolved_fallback.is_some(),
        })
        .or_else(|| {
            snapshot
                .metadata
                .as_ref()
                .and_then(|metadata| metadata.get("resolved_execution"))
                .cloned()
                .and_then(|execution| serde_json::from_value(execution).ok())
        })
}

fn fem_fe_order_from_plan_summary(plan_summary: &serde_json::Value) -> Option<u8> {
    plan_summary
        .get("fe_order")
        .and_then(serde_json::Value::as_u64)
        .and_then(|order| u8::try_from(order).ok())
}

fn topological_charge_cache_digest(cache_key: &str) -> String {
    format!("{:x}", Sha256::digest(cache_key.as_bytes()))
}

#[derive(Clone, Copy)]
struct FdmProfileGeometry {
    origin_m: [f64; 3],
    cell_size_m: [f64; 3],
}

fn fdm_profile_geometry(
    snapshot: &crate::types::SessionStateResponse,
) -> Option<FdmProfileGeometry> {
    let layout = snapshot
        .metadata
        .as_ref()?
        .get("artifact_layout")
        .filter(|layout| {
            layout.get("backend").and_then(serde_json::Value::as_str) == Some("fdm")
        })?;
    let parse = |name: &str| -> Option<[f64; 3]> {
        let values = layout.get(name)?.as_array()?;
        let values = values
            .iter()
            .map(serde_json::Value::as_f64)
            .collect::<Option<Vec<_>>>()?;
        (values.len() == 3 && values.iter().all(|value| value.is_finite()))
            .then_some([values[0], values[1], values[2]])
    };
    let origin_m = parse("origin_m")
        .or_else(|| parse("origin"))
        .or_else(|| parse("grid_origin"))
        .or_else(|| parse("native_origin"))?;
    let cell_size_m = parse("cell_size")?;
    cell_size_m
        .iter()
        .all(|value| *value >= 0.0)
        .then_some(FdmProfileGeometry {
            origin_m,
            cell_size_m,
        })
}

fn topological_charge_profile_response(
    resource: &TopologicalChargeResource,
    is_fem: bool,
    support: crate::schemas::analysis_extensions::TopologicalChargeSupportMode,
    fdm_geometry: Option<FdmProfileGeometry>,
) -> Vec<TopologicalChargeLayerSampleV2> {
    if support != crate::schemas::analysis_extensions::TopologicalChargeSupportMode::LayerProfile
        || resource.layer_samples.is_empty()
    {
        return Vec::new();
    }
    let fdm_normal_axis = match resource.plane.as_str() {
        "xy" => 2,
        "xz" => 1,
        "yz" => 0,
        _ => return Vec::new(),
    };
    let geometry = (!is_fem).then_some(fdm_geometry).flatten();
    if !is_fem && geometry.is_none_or(|geometry| geometry.cell_size_m[fdm_normal_axis] <= 0.0) {
        return Vec::new();
    }
    let coordinates = resource
        .layer_samples
        .iter()
        .map(|layer| {
            geometry.map_or(layer.coordinate, |geometry| {
                geometry.origin_m[fdm_normal_axis]
                    + (layer.index as f64 + 0.5) * geometry.cell_size_m[fdm_normal_axis]
            })
        })
        .collect::<Vec<_>>();
    let weight_m = geometry.map_or_else(
        || fem_profile_bin_weight_m(&coordinates),
        |geometry| geometry.cell_size_m[fdm_normal_axis],
    );
    resource
        .layer_samples
        .iter()
        .zip(coordinates)
        .map(|(layer, coordinate_m)| TopologicalChargeLayerSampleV2 {
            index: layer.index as u16,
            coordinate_m,
            integration_weight_m: weight_m,
            status: if layer.charge.is_some() {
                TopologicalChargeStatusV2::Ready
            } else {
                TopologicalChargeStatusV2::DegenerateSupport
            },
            trust: layer.certification.as_ref().map_or(
                TopologicalChargeTrustV2::DiagnosticTopology,
                |certification| certification.trust,
            ),
            charge: layer.charge,
            valid_triangle_count: layer
                .certification
                .as_ref()
                .map_or(layer.triangle_count as u64, |certification| {
                    certification.quality.valid_triangle_count
                }),
            total_triangle_count: layer
                .certification
                .as_ref()
                .map_or(layer.triangle_count as u64, |certification| {
                    certification.quality.total_triangle_count
                }),
        })
        .collect()
}

fn fem_profile_bin_weight_m(coordinates_m: &[f64]) -> f64 {
    coordinates_m
        .windows(2)
        .next()
        .map(|pair| (pair[1] - pair[0]).abs())
        .filter(|weight| weight.is_finite() && *weight > 0.0)
        .unwrap_or(0.0)
}

fn fdm_requires_object_mask(object_count: Option<usize>) -> bool {
    object_count.is_some_and(|count| count != 1)
}

fn topological_charge_plane_from_legacy(plane: &str) -> TopologicalChargePlaneV2 {
    match plane {
        "xy" => TopologicalChargePlaneV2::Xy,
        "xz" => TopologicalChargePlaneV2::Xz,
        "yz" => TopologicalChargePlaneV2::Yz,
        _ => TopologicalChargePlaneV2::Auto,
    }
}

fn resolved_field_source_kind(field: &ResolvedObjectVectorField) -> String {
    match field.source_kind {
        ResolvedFieldSourceKind::PersistedSnapshot => "persisted_snapshot",
        ResolvedFieldSourceKind::CurrentLive => "current_live",
        ResolvedFieldSourceKind::CurrentMaterialized => "current_materialized",
    }
    .to_string()
}

fn field_summary_from_resolved_field(
    field: &ResolvedObjectVectorField,
    mesh: Option<&fullmag_runner::FemMeshPayload>,
) -> Result<FieldSampleSummary, ApiError> {
    let values: Vec<f64> = match (mesh, field.global_node_ids.as_deref()) {
        (Some(mesh), Some(global_node_ids)) => {
            let expanded =
                expand_compact_fem_node_values(&field.values, global_node_ids, mesh.nodes.len())
                    .map_err(ApiError::conflict)?;
            expanded.into_iter().flatten().collect()
        }
        _ => field.values.iter().flatten().copied().collect(),
    };
    let sample_count = values.len() / 3;
    let valid_sample_count = field
        .values
        .iter()
        .filter(|sample| {
            let norm_squared =
                sample[0] * sample[0] + sample[1] * sample[1] + sample[2] * sample[2];
            norm_squared > 1.0e-24 && norm_squared.is_finite()
        })
        .count();
    Ok(FieldSampleSummary {
        values,
        grid: field.grid,
        object_mask: field.object_mask.clone(),
        sample_count,
        valid_sample_count,
    })
}

struct FieldSampleSummary {
    values: Vec<f64>,
    grid: Option<[u32; 3]>,
    object_mask: Option<Vec<bool>>,
    sample_count: usize,
    valid_sample_count: usize,
}

struct ComputedTopologicalCharge {
    result: crate::analysis::topological_charge::TopologicalChargeResult,
    method: String,
    plane: String,
    sample_grid: Option<TopologicalChargeSampleGrid>,
    sample_topology: Option<TopologicalChargeSampleTopology>,
    layer_samples: Vec<TopologicalChargeLayerSample>,
    certification: Option<SupportCertification>,
}

struct FdmChargeQualification {
    charge: f64,
    quality: OrientedChargeQuality,
    topology: SupportTopologyQualification,
    boundary: BoundaryQualification,
}

impl FdmChargeQualification {
    fn trust(&self) -> TopologicalChargeTrustV2 {
        qualified_support_trust(&self.quality, &self.topology, &self.boundary)
    }
}

fn qualified_support_trust(
    quality: &OrientedChargeQuality,
    topology: &SupportTopologyQualification,
    boundary: &BoundaryQualification,
) -> TopologicalChargeTrustV2 {
    if quality.under_resolved {
        TopologicalChargeTrustV2::DiagnosticResolution
    } else if !topology.is_manifold()
        || topology.connected_component_count != 1
        || topology.boundary_loop_count != 1
        || topology.euler_characteristic != 1
    {
        TopologicalChargeTrustV2::DiagnosticTopology
    } else if !boundary.is_uniform {
        TopologicalChargeTrustV2::DiagnosticBoundary
    } else {
        TopologicalChargeTrustV2::Qualified
    }
}

fn certify_oriented_support(
    points_uv: &[[f64; 2]],
    samples: &[[f64; 3]],
    triangles: &[[usize; 3]],
    charge: f64,
    quality: OrientedChargeQuality,
) -> Option<SupportCertification> {
    let topology = qualify_support_topology(samples.len(), triangles);
    let boundary = qualify_boundary(points_uv, samples, &support_boundary_edges(triangles)).ok()?;
    let trust = qualified_support_trust(&quality, &topology, &boundary);
    Some(SupportCertification {
        charge,
        trust,
        quality: TopologicalChargeQualityV2 {
            total_vertex_count: quality.total_vertex_count as u64,
            valid_vertex_count: quality.valid_vertex_count as u64,
            total_triangle_count: quality.total_triangle_count as u64,
            valid_triangle_count: quality.valid_triangle_count as u64,
            invalid_triangle_count: quality.invalid_triangle_count as u64,
            exceptional_triangle_count: quality.exceptional_triangle_count as u64,
            max_edge_angle_rad: Some(quality.max_edge_angle_rad),
            min_abs_solid_angle_denominator: Some(quality.min_abs_solid_angle_denominator),
            connected_component_count: topology.connected_component_count as u32,
            boundary_edge_count: topology.boundary_edge_count as u64,
            boundary_loop_count: topology.boundary_loop_count as u32,
            euler_characteristic: Some(topology.euler_characteristic),
            boundary_max_deviation_rad: boundary.max_deviation_rad,
        },
    })
}

fn support_boundary_edges(triangles: &[[usize; 3]]) -> Vec<[usize; 2]> {
    let mut incidence = BTreeMap::<(usize, usize), (usize, [usize; 2])>::new();
    for triangle in triangles {
        for edge in [
            [triangle[0], triangle[1]],
            [triangle[1], triangle[2]],
            [triangle[2], triangle[0]],
        ] {
            let key = if edge[0] < edge[1] {
                (edge[0], edge[1])
            } else {
                (edge[1], edge[0])
            };
            let entry = incidence.entry(key).or_insert((0, edge));
            entry.0 += 1;
        }
    }
    incidence
        .into_values()
        .filter_map(|(count, edge)| (count == 1).then_some(edge))
        .collect()
}

fn qualify_regular_fdm_midplane(
    summary: &FieldSampleSummary,
    requested_plane: &str,
) -> Option<FdmChargeQualification> {
    let profile = regular_fdm_layer_profile(&summary.values, summary.grid?, requested_plane)?;
    qualify_regular_fdm_layer(
        summary,
        requested_plane,
        profile.layers.len().checked_sub(1)? / 2,
    )
}

fn qualify_regular_fdm_layer(
    summary: &FieldSampleSummary,
    requested_plane: &str,
    layer_index: usize,
) -> Option<FdmChargeQualification> {
    let profile = regular_fdm_layer_profile(&summary.values, summary.grid?, requested_plane)?;
    let grid = summary.grid?;
    let object_mask = summary.object_mask.as_ref();
    if object_mask.is_some_and(|mask| {
        mask.len() != (grid[0] as usize) * (grid[1] as usize) * (grid[2] as usize)
    }) {
        return None;
    }
    let layer = profile.layers.get(layer_index)?;
    if profile.nx < 2 || profile.ny < 2 {
        return None;
    }
    let source_indices = plane_sample_indices(grid, layer_index, &profile.plane)?;
    let mut remap = vec![None; layer.samples.len()];
    let mut samples = Vec::new();
    let mut points_uv = Vec::new();
    for (index, sample) in layer.samples.iter().enumerate() {
        let source_index = *source_indices.get(index)?;
        let has_magnetization = sample.iter().map(|value| value * value).sum::<f64>() > 1.0e-24;
        let is_in_object = object_mask.map_or(has_magnetization, |mask| {
            mask.get(source_index) == Some(&true)
        });
        if is_in_object {
            remap[index] = Some(samples.len());
            samples.push(*sample);
            points_uv.push([(index % profile.nx) as f64, (index / profile.nx) as f64]);
        }
    }
    let triangles = regular_grid_triangles(profile.nx, profile.ny)
        .into_iter()
        .filter_map(|triangle| {
            Some([
                remap[triangle[0]]?,
                remap[triangle[1]]?,
                remap[triangle[2]]?,
            ])
        })
        .collect::<Vec<_>>();
    if triangles.is_empty() {
        return None;
    }
    let oriented = compute_oriented_charge(OrientedChargeInput::new(&samples, &triangles)).ok()?;
    let topology = qualify_support_topology(samples.len(), &triangles);
    let boundary =
        qualify_boundary(&points_uv, &samples, &support_boundary_edges(&triangles)).ok()?;
    Some(FdmChargeQualification {
        charge: oriented.charge,
        quality: oriented.quality,
        topology,
        boundary,
    })
}

fn plane_sample_indices(grid: [u32; 3], fixed_layer: usize, plane: &str) -> Option<Vec<usize>> {
    let [gx, gy, gz] = grid;
    let (nx, ny) = match plane {
        "xy" => (gx as usize, gy as usize),
        "xz" => (gx as usize, gz as usize),
        "yz" => (gy as usize, gz as usize),
        _ => return None,
    };
    let mut indices = Vec::with_capacity(nx * ny);
    for v in 0..ny {
        for u in 0..nx {
            indices.push(match plane {
                "xy" => point_index_3d(u, v, fixed_layer, gx as usize, gy as usize, gz as usize)?,
                "xz" => point_index_3d(u, fixed_layer, v, gx as usize, gy as usize, gz as usize)?,
                "yz" => point_index_3d(fixed_layer, u, v, gx as usize, gy as usize, gz as usize)?,
                _ => unreachable!(),
            });
        }
    }
    Some(indices)
}

fn regular_grid_triangles(nx: usize, ny: usize) -> Vec<[usize; 3]> {
    let mut triangles = Vec::with_capacity(2 * nx.saturating_sub(1) * ny.saturating_sub(1));
    for y in 0..ny.saturating_sub(1) {
        for x in 0..nx.saturating_sub(1) {
            let p00 = y * nx + x;
            let p10 = p00 + 1;
            let p01 = p00 + nx;
            let p11 = p01 + 1;
            triangles.push([p00, p10, p11]);
            triangles.push([p00, p11, p01]);
        }
    }
    triangles
}

impl TopologicalChargeStatus {
    fn from_inputs(
        field_summary: Option<&FieldSampleSummary>,
        sampled_result: Option<&ComputedTopologicalCharge>,
        has_valid_samples: bool,
        missing_fem_mesh: bool,
    ) -> Self {
        let Some(summary) = field_summary else {
            return Self::NoCurrentMagnetization;
        };
        let Some(result) = sampled_result else {
            if summary.sample_count > 0 && summary.valid_sample_count == 0 {
                return Self::InvalidMagnetization;
            }
            return if missing_fem_mesh {
                Self::EmptySupport
            } else {
                Self::DegenerateSupport
            };
        };
        if has_valid_samples {
            return Self::Ready;
        }
        if result
            .result
            .warnings
            .iter()
            .any(|warning| warning.code == TopologicalChargeWarningCode::NonUnitMagnetization)
        {
            Self::InvalidMagnetization
        } else {
            Self::DegenerateSupport
        }
    }
}

fn compute_regular_fdm_topological_charge(
    summary: &FieldSampleSummary,
    requested_plane: &str,
    support: &str,
) -> Option<ComputedTopologicalCharge> {
    let grid = summary.grid?;
    let profile = regular_fdm_layer_profile(&summary.values, grid, requested_plane)?;
    let mut layer_samples = Vec::with_capacity(profile.layers.len());
    let mut valid_layers = Vec::new();
    let mut sample_count = 0usize;
    let mut valid_sample_count = 0usize;

    let layer_indices: Vec<usize> = if support == "midplane" {
        vec![profile.layers.len().checked_sub(1)? / 2]
    } else {
        (0..profile.layers.len()).collect()
    };
    for index in layer_indices {
        let layer = profile.layers.get(index)?;
        let qualification = qualify_regular_fdm_layer(summary, requested_plane, index)?;
        let certification = support_certification_from_fdm(&qualification);
        sample_count += qualification.quality.total_vertex_count;
        valid_sample_count += qualification.quality.valid_vertex_count;
        valid_layers.push((layer.coordinate, qualification.charge));
        layer_samples.push(TopologicalChargeLayerSample {
            index,
            coordinate: layer.coordinate,
            charge: Some(qualification.charge),
            sample_count: qualification.quality.total_vertex_count,
            valid_sample_count: qualification.quality.valid_vertex_count,
            triangle_count: qualification.quality.total_triangle_count,
            certification: Some(certification),
        });
    }

    let result = crate::analysis::topological_charge::TopologicalChargeResult {
        charge: thickness_average_charge(&valid_layers).unwrap_or(0.0),
        sample_count,
        valid_sample_count,
        warnings: Vec::new(),
    };
    let triangle_count = layer_samples
        .iter()
        .map(|layer| layer.triangle_count)
        .sum::<usize>();
    let layer_count = layer_samples.len();
    Some(ComputedTopologicalCharge {
        result,
        method: if layer_count > 1 {
            "berg_luescher_fdm_layer_profile".to_string()
        } else {
            "berg_luescher_grid".to_string()
        },
        plane: profile.plane.clone(),
        sample_grid: Some(TopologicalChargeSampleGrid {
            nx: profile.nx as u32,
            ny: profile.ny as u32,
            plane: profile.plane,
        }),
        sample_topology: (layer_count > 1).then_some(TopologicalChargeSampleTopology {
            kind: "fdm_layer_profile".to_string(),
            point_count: sample_count,
            triangle_count,
        }),
        layer_samples,
        certification: None,
    })
}

fn support_certification_from_fdm(qualification: &FdmChargeQualification) -> SupportCertification {
    SupportCertification {
        charge: qualification.charge,
        trust: qualification.trust(),
        quality: TopologicalChargeQualityV2 {
            total_vertex_count: qualification.quality.total_vertex_count as u64,
            valid_vertex_count: qualification.quality.valid_vertex_count as u64,
            total_triangle_count: qualification.quality.total_triangle_count as u64,
            valid_triangle_count: qualification.quality.valid_triangle_count as u64,
            invalid_triangle_count: qualification.quality.invalid_triangle_count as u64,
            exceptional_triangle_count: qualification.quality.exceptional_triangle_count as u64,
            max_edge_angle_rad: Some(qualification.quality.max_edge_angle_rad),
            min_abs_solid_angle_denominator: Some(
                qualification.quality.min_abs_solid_angle_denominator,
            ),
            connected_component_count: qualification.topology.connected_component_count as u32,
            boundary_edge_count: qualification.topology.boundary_edge_count as u64,
            boundary_loop_count: qualification.topology.boundary_loop_count as u32,
            euler_characteristic: Some(qualification.topology.euler_characteristic),
            boundary_max_deviation_rad: qualification.boundary.max_deviation_rad,
        },
    }
}

fn compute_fem_topological_charge(
    summary: &FieldSampleSummary,
    mesh: &fullmag_runner::FemMeshPayload,
    object_id: &str,
    requested_plane: &str,
    support: &str,
    profile_samples: Option<u16>,
) -> Option<ComputedTopologicalCharge> {
    if support == "layer_profile" {
        return compute_fem_plane_cut_profile(
            summary,
            mesh,
            object_id,
            requested_plane,
            profile_samples.unwrap_or(33),
        );
    }
    compute_fem_plane_cut_topological_charge(summary, mesh, object_id, requested_plane, 0.5)
}

fn collapse_topological_charge_warnings(
    warnings: Vec<crate::analysis::topological_charge::TopologicalChargeWarning>,
) -> Vec<crate::analysis::topological_charge::TopologicalChargeWarning> {
    let mut collapsed = Vec::new();
    let mut saw_non_unit = false;
    let mut saw_insufficient = false;
    for warning in warnings {
        match warning.code {
            TopologicalChargeWarningCode::NonUnitMagnetization if !saw_non_unit => {
                saw_non_unit = true;
                collapsed.push(warning);
            }
            TopologicalChargeWarningCode::InsufficientSamples if !saw_insufficient => {
                saw_insufficient = true;
                collapsed.push(warning);
            }
            _ => {}
        }
    }
    collapsed
}

fn compute_fem_plane_cut_topological_charge(
    summary: &FieldSampleSummary,
    mesh: &fullmag_runner::FemMeshPayload,
    object_id: &str,
    requested_plane: &str,
    cut_norm: f64,
) -> Option<ComputedTopologicalCharge> {
    let fem_field = object_scoped_fem_field(summary, mesh, object_id)?;
    let plane = resolve_fem_plane(&fem_field.nodes, requested_plane)?;
    let resolved_slice = resolve_slice_query(
        &FieldSliceQuery {
            plane,
            component: Some("full".to_string()),
            cut_world: None,
            cut_norm: Some(cut_norm),
            x_size: Some(2),
            y_size: Some(2),
            max_points: Some(4),
            include_arrows: Some(false),
            arrow_every: None,
            max_arrows: None,
        },
        3,
    )
    .ok()?;
    let overlay = collect_fem_slice_overlay(
        FemSliceOverlayInput {
            nodes: &fem_field.nodes,
            elements: &fem_field.elements,
            element_markers: &fem_field.element_markers,
        },
        &resolved_slice,
    )
    .ok()?;

    let mut sample_map = BTreeMap::<CutPointKey, usize>::new();
    let mut samples = Vec::new();
    let mut points_uv = Vec::new();
    let mut triangles = Vec::new();
    let mut degenerate_triangle_count = 0usize;
    for polygon in &overlay.polygons {
        if polygon.points.len() < 3 {
            continue;
        }
        for index in 1..(polygon.points.len() - 1) {
            let mut points = [
                &polygon.points[0],
                &polygon.points[index],
                &polygon.points[index + 1],
            ];
            let signed_area = cut_triangle_signed_area(points);
            if signed_area.abs() <= 1.0e-30 {
                degenerate_triangle_count += 1;
                continue;
            }
            if signed_area < 0.0 {
                points.swap(1, 2);
            }
            let mut triangle = [0usize; 3];
            for (slot, point) in points.into_iter().enumerate() {
                triangle[slot] = remap_cut_point(
                    &fem_field,
                    point,
                    &mut sample_map,
                    &mut samples,
                    &mut points_uv,
                )?;
            }
            triangles.push(triangle);
        }
    }
    let duplicate_triangle_count = deduplicate_oriented_triangles(&mut triangles);
    if samples.len() < 3 || triangles.is_empty() {
        return None;
    }

    let strict_result = crate::analysis::topological_charge::compute_oriented_charge(
        crate::analysis::topological_charge::OrientedChargeInput::new(&samples, &triangles),
    )
    .ok()?;
    let certification = certify_oriented_support(
        &points_uv,
        &samples,
        &triangles,
        strict_result.charge,
        strict_result.quality.clone(),
    );
    let mut result = crate::analysis::topological_charge::TopologicalChargeResult {
        charge: strict_result.charge,
        sample_count: strict_result.quality.total_vertex_count,
        valid_sample_count: strict_result.quality.valid_vertex_count,
        warnings: Vec::new(),
    };
    if degenerate_triangle_count > 0 {
        result.warnings.push(
            crate::analysis::topological_charge::TopologicalChargeWarning {
                code: TopologicalChargeWarningCode::InsufficientSamples,
                message: format!(
                    "{degenerate_triangle_count} degenerate FEM cut triangles were skipped."
                ),
            },
        );
    }
    if duplicate_triangle_count > 0 {
        result.warnings.push(
            crate::analysis::topological_charge::TopologicalChargeWarning {
                code: TopologicalChargeWarningCode::InsufficientSamples,
                message: format!(
                    "{duplicate_triangle_count} coincident FEM cut triangles were deterministically deduplicated."
                ),
            },
        );
    }
    let sample_count = result.sample_count;
    let valid_sample_count = result.valid_sample_count;
    let triangle_count = triangles.len();
    let charge = (valid_sample_count > 0).then_some(result.charge);
    Some(ComputedTopologicalCharge {
        result,
        method: "berg_luescher_oriented_triangles_v2".to_string(),
        plane: plane.as_str().to_string(),
        sample_grid: None,
        sample_topology: Some(TopologicalChargeSampleTopology {
            kind: "tetra_plane_cut".to_string(),
            point_count: sample_count,
            triangle_count,
        }),
        layer_samples: vec![TopologicalChargeLayerSample {
            index: 0,
            coordinate: overlay.cut_world,
            charge,
            sample_count,
            valid_sample_count,
            triangle_count,
            certification: certification.clone(),
        }],
        certification,
    })
}

fn deduplicate_oriented_triangles(triangles: &mut Vec<[usize; 3]>) -> usize {
    let mut seen = BTreeSet::new();
    let original_count = triangles.len();
    triangles.retain(|triangle| {
        let mut key = *triangle;
        key.sort_unstable();
        seen.insert(key)
    });
    original_count - triangles.len()
}

fn compute_fem_plane_cut_profile(
    summary: &FieldSampleSummary,
    mesh: &fullmag_runner::FemMeshPayload,
    object_id: &str,
    requested_plane: &str,
    profile_samples: u16,
) -> Option<ComputedTopologicalCharge> {
    if profile_samples < 3 {
        return None;
    }
    let mut cuts = Vec::with_capacity(profile_samples as usize);
    for index in 0..profile_samples {
        let cut_norm = (f64::from(index) + 0.5) / f64::from(profile_samples);
        cuts.push(compute_fem_plane_cut_topological_charge(
            summary,
            mesh,
            object_id,
            requested_plane,
            cut_norm,
        )?);
    }
    let charges = cuts
        .iter()
        .map(|cut| (cut.result.valid_sample_count > 0).then_some(cut.result.charge))
        .collect::<Vec<_>>();
    let coordinates_m = cuts
        .iter()
        .filter_map(|cut| cut.layer_samples.first().map(|layer| layer.coordinate))
        .collect::<Vec<_>>();
    let thickness_m = match (coordinates_m.first(), coordinates_m.last(), cuts.len()) {
        (Some(first), Some(last), count) if count > 1 => {
            (last - first).abs() * count as f64 / (count - 1) as f64
        }
        _ => 0.0,
    };
    let weights = fem_midpoint_weights(cuts.len(), thickness_m);
    let charge = fdm_weighted_mean(&charges, &weights)?;
    let plane = cuts.first()?.plane.clone();
    let sample_count = cuts.iter().map(|cut| cut.result.sample_count).sum();
    let valid_sample_count = cuts.iter().map(|cut| cut.result.valid_sample_count).sum();
    let warnings = collapse_topological_charge_warnings(
        cuts.iter()
            .flat_map(|cut| cut.result.warnings.iter().cloned())
            .collect(),
    );
    let layer_samples = cuts
        .into_iter()
        .flat_map(|cut| cut.layer_samples)
        .collect::<Vec<_>>();
    Some(ComputedTopologicalCharge {
        result: crate::analysis::topological_charge::TopologicalChargeResult {
            charge,
            sample_count,
            valid_sample_count,
            warnings,
        },
        method: "fem_p1_exact_plane_cut_profile".to_string(),
        plane,
        sample_grid: None,
        sample_topology: Some(TopologicalChargeSampleTopology {
            kind: "tetra_plane_cut_profile".to_string(),
            point_count: sample_count,
            triangle_count: layer_samples.iter().map(|layer| layer.triangle_count).sum(),
        }),
        layer_samples,
        certification: None,
    })
}

#[derive(Debug, Clone, Copy, PartialEq, Eq, PartialOrd, Ord)]
enum CutPointKey {
    MeshNode(u32),
    MeshEdge { low: u32, high: u32 },
}

fn cut_point_key(point: &SliceOverlayPoint) -> CutPointKey {
    let [a, b] = point.edge_node_ids;
    if a == b {
        return CutPointKey::MeshNode(a);
    }
    let (low, high) = if a <= b { (a, b) } else { (b, a) };
    CutPointKey::MeshEdge { low, high }
}

fn remap_cut_point(
    field: &FemField,
    point: &SliceOverlayPoint,
    sample_map: &mut BTreeMap<CutPointKey, usize>,
    samples: &mut Vec<[f64; 3]>,
    points_uv: &mut Vec<[f64; 2]>,
) -> Option<usize> {
    let key = cut_point_key(point);
    if let Some(index) = sample_map.get(&key) {
        return Some(*index);
    }
    let sample = cut_point_sample(field, point)?;
    let index = samples.len();
    sample_map.insert(key, index);
    samples.push(sample);
    points_uv.push(point.uv);
    Some(index)
}

fn cut_point_sample(field: &FemField, point: &SliceOverlayPoint) -> Option<[f64; 3]> {
    let [a, b] = point.edge_node_ids;
    if a == b {
        return fem_field_node_vector(field, a as usize);
    }
    let left = fem_field_node_vector(field, a as usize)?;
    let right = fem_field_node_vector(field, b as usize)?;
    let t = point.edge_t.clamp(0.0, 1.0);
    Some([
        left[0] + (right[0] - left[0]) * t,
        left[1] + (right[1] - left[1]) * t,
        left[2] + (right[2] - left[2]) * t,
    ])
}

fn fem_field_node_vector(field: &FemField, node_index: usize) -> Option<[f64; 3]> {
    if field.n_comp != 3 {
        return None;
    }
    let base = node_index.checked_mul(3)?;
    Some([
        *field.values.get(base)?,
        *field.values.get(base + 1)?,
        *field.values.get(base + 2)?,
    ])
}

fn cut_triangle_signed_area(points: [&SliceOverlayPoint; 3]) -> f64 {
    let a = points[0].uv;
    let b = points[1].uv;
    let c = points[2].uv;
    0.5 * ((b[0] - a[0]) * (c[1] - a[1]) - (b[1] - a[1]) * (c[0] - a[0]))
}

fn thickness_average_charge(layers: &[(f64, f64)]) -> Option<f64> {
    if layers.is_empty() {
        return None;
    }
    if layers.len() == 1 {
        return Some(layers[0].1);
    }
    let mut sorted = layers.to_vec();
    sorted.sort_by(|a, b| a.0.total_cmp(&b.0));
    let thickness = sorted.last()?.0 - sorted.first()?.0;
    if thickness.abs() <= 1.0e-30 {
        return Some(sorted.iter().map(|(_, charge)| charge).sum::<f64>() / sorted.len() as f64);
    }
    let mut integral = 0.0;
    for pair in sorted.windows(2) {
        let dz = pair[1].0 - pair[0].0;
        integral += 0.5 * dz * (pair[0].1 + pair[1].1);
    }
    Some(integral / thickness)
}

fn object_scoped_fem_field(
    summary: &FieldSampleSummary,
    mesh: &fullmag_runner::FemMeshPayload,
    object_id: &str,
) -> Option<FemField> {
    if summary.values.len() / 3 != mesh.nodes.len() {
        return None;
    }
    let tet_elements = mesh.require_tet4_elements().ok()?;
    let (node_indices, element_indices) = object_mesh_scope(mesh, object_id)?;
    let mut selected_nodes = BTreeSet::new();
    for index in node_indices {
        if index < mesh.nodes.len() {
            selected_nodes.insert(index);
        }
    }
    for element_index in &element_indices {
        if let Some(element) = tet_elements.get(*element_index) {
            for node_index in element {
                selected_nodes.insert(*node_index as usize);
            }
        }
    }
    if selected_nodes.is_empty() {
        return None;
    }

    let mut node_map = BTreeMap::new();
    let mut nodes = Vec::with_capacity(selected_nodes.len());
    let mut values = Vec::with_capacity(selected_nodes.len() * 3);
    for old_index in selected_nodes {
        let new_index = nodes.len() as u32;
        node_map.insert(old_index as u32, new_index);
        nodes.push(*mesh.nodes.get(old_index)?);
        let value_offset = old_index * 3;
        values.extend_from_slice(summary.values.get(value_offset..value_offset + 3)?);
    }

    let mut elements = Vec::new();
    let mut element_markers = Vec::new();
    for element_index in element_indices {
        let element = *tet_elements.get(element_index)?;
        let Some(remapped) = remap_tetra(element, &node_map) else {
            continue;
        };
        elements.push(remapped);
        if let Some(marker) = mesh.element_markers.get(element_index) {
            element_markers.push(*marker);
        }
    }
    if elements.is_empty() {
        return None;
    }

    Some(FemField {
        n_comp: 3,
        nodes,
        elements,
        element_markers,
        values,
    })
}

fn object_mesh_scope(
    mesh: &fullmag_runner::FemMeshPayload,
    object_id: &str,
) -> Option<(Vec<usize>, Vec<usize>)> {
    if let Some(part) = mesh
        .mesh_parts
        .iter()
        .find(|part| part.role == "magnetic_object" && part.object_id.as_deref() == Some(object_id))
    {
        let nodes = if part.node_indices.is_empty() {
            range_indices(
                part.node_start as usize,
                part.node_count as usize,
                mesh.nodes.len(),
            )
        } else {
            part.node_indices
                .iter()
                .map(|index| *index as usize)
                .collect()
        };
        let elements = range_indices(
            part.element_start as usize,
            part.element_count as usize,
            mesh.cell_count(),
        );
        return Some((nodes, elements));
    }
    let segment = mesh
        .object_segments
        .iter()
        .find(|segment| segment.object_id == object_id)?;
    Some((
        range_indices(
            segment.node_start as usize,
            segment.node_count as usize,
            mesh.nodes.len(),
        ),
        range_indices(
            segment.element_start as usize,
            segment.element_count as usize,
            mesh.cell_count(),
        ),
    ))
}

fn range_indices(start: usize, count: usize, limit: usize) -> Vec<usize> {
    let end = start.saturating_add(count).min(limit);
    if start >= end {
        return Vec::new();
    }
    (start..end).collect()
}

fn remap_tetra(element: [u32; 4], node_map: &BTreeMap<u32, u32>) -> Option<[u32; 4]> {
    Some([
        *node_map.get(&element[0])?,
        *node_map.get(&element[1])?,
        *node_map.get(&element[2])?,
        *node_map.get(&element[3])?,
    ])
}

fn resolve_fem_plane(nodes: &[[f64; 3]], requested_plane: &str) -> Option<SlicePlane> {
    match requested_plane {
        "xy" | "XY" => return Some(SlicePlane::Xy),
        "xz" | "XZ" => return Some(SlicePlane::Xz),
        "yz" | "YZ" => return Some(SlicePlane::Yz),
        "auto" | "" => {}
        _ => return None,
    }
    let mut min = [f64::INFINITY; 3];
    let mut max = [f64::NEG_INFINITY; 3];
    for node in nodes {
        for axis in 0..3 {
            min[axis] = min[axis].min(node[axis]);
            max[axis] = max[axis].max(node[axis]);
        }
    }
    let extent = [max[0] - min[0], max[1] - min[1], max[2] - min[2]];
    if extent[2] <= extent[0] && extent[2] <= extent[1] {
        Some(SlicePlane::Xy)
    } else if extent[1] <= extent[0] && extent[1] <= extent[2] {
        Some(SlicePlane::Xz)
    } else {
        Some(SlicePlane::Yz)
    }
}

struct FdmLayerProfile {
    plane: String,
    nx: usize,
    ny: usize,
    layers: Vec<FdmLayerSamples>,
}

struct FdmLayerSamples {
    coordinate: f64,
    samples: Vec<[f64; 3]>,
}

fn regular_fdm_layer_profile(
    values: &[f64],
    grid: [u32; 3],
    requested_plane: &str,
) -> Option<FdmLayerProfile> {
    let [gx, gy, gz] = grid;
    let point_count = gx as usize * gy as usize * gz as usize;
    if gx == 0 || gy == 0 || gz == 0 || values.len() != point_count * 3 {
        return None;
    }
    let resolved_plane = resolve_fdm_plane(grid, requested_plane)?;
    let (nx, ny, layer_count) = match resolved_plane {
        "xy" if gx >= 2 && gy >= 2 => (gx as usize, gy as usize, gz as usize),
        "xz" if gx >= 2 && gz >= 2 => (gx as usize, gz as usize, gy as usize),
        "yz" if gy >= 2 && gz >= 2 => (gy as usize, gz as usize, gx as usize),
        _ => return None,
    };
    let mut layers = Vec::with_capacity(layer_count);
    for fixed_layer in 0..layer_count {
        layers.push(FdmLayerSamples {
            coordinate: fixed_layer as f64,
            samples: plane_samples(
                values,
                gx as usize,
                gy as usize,
                gz as usize,
                fixed_layer,
                resolved_plane,
            )?,
        });
    }
    Some(FdmLayerProfile {
        plane: resolved_plane.to_string(),
        nx,
        ny,
        layers,
    })
}

fn resolve_fdm_plane(grid: [u32; 3], requested_plane: &str) -> Option<&'static str> {
    match requested_plane {
        "xy" | "XY" => return Some("xy"),
        "xz" | "XZ" => return Some("xz"),
        "yz" | "YZ" => return Some("yz"),
        "auto" | "" => {}
        _ => return None,
    }

    let [gx, gy, gz] = grid;
    if gz <= gx && gz <= gy {
        Some("xy")
    } else if gy <= gx && gy <= gz {
        Some("xz")
    } else {
        Some("yz")
    }
}

fn plane_samples(
    values: &[f64],
    gx: usize,
    gy: usize,
    gz: usize,
    fixed_layer: usize,
    plane: &str,
) -> Option<Vec<[f64; 3]>> {
    let (nx, ny) = match plane {
        "xy" => (gx, gy),
        "xz" => (gx, gz),
        "yz" => (gy, gz),
        _ => return None,
    };
    let mut samples = Vec::with_capacity(nx * ny);
    for v in 0..ny {
        for u in 0..nx {
            let point_index = match plane {
                "xy" => point_index_3d(u, v, fixed_layer, gx, gy, gz)?,
                "xz" => point_index_3d(u, fixed_layer, v, gx, gy, gz)?,
                "yz" => point_index_3d(fixed_layer, u, v, gx, gy, gz)?,
                _ => return None,
            };
            let value_index = point_index * 3;
            samples.push([
                *values.get(value_index)?,
                *values.get(value_index + 1)?,
                *values.get(value_index + 2)?,
            ]);
        }
    }
    Some(samples)
}

fn point_index_3d(x: usize, y: usize, z: usize, gx: usize, gy: usize, gz: usize) -> Option<usize> {
    (x < gx && y < gy && z < gz).then_some((z * gy + y) * gx + x)
}

fn topological_charge_warnings(
    status: &TopologicalChargeStatus,
    requested_snapshot: &str,
    requested_resolution: &str,
    sample_count: usize,
    fdm_result: Option<&ComputedTopologicalCharge>,
) -> Vec<TopologicalChargeWarning> {
    match status {
        TopologicalChargeStatus::Ready => fdm_result_warnings(fdm_result),
        TopologicalChargeStatus::NoCurrentMagnetization => vec![TopologicalChargeWarning {
            code: "no_current_magnetization".to_string(),
            message: format!(
                "Current magnetization field data is not available for this object yet (snapshot: {requested_snapshot}, resolution: {requested_resolution}).",
            ),
        }],
        TopologicalChargeStatus::EmptySupport => vec![TopologicalChargeWarning {
            code: "empty_support".to_string(),
            message: format!(
                "No valid two-dimensional support is available for the selected object and analysis plane (magnetization samples: {sample_count}).",
            ),
        }],
        TopologicalChargeStatus::InvalidMagnetization => vec![TopologicalChargeWarning {
            code: "invalid_magnetization".to_string(),
            message: "No valid magnetization vectors are available on the selected support; the result is undefined, not Q = 0.".to_string(),
        }],
        TopologicalChargeStatus::DegenerateSupport => {
            vec![TopologicalChargeWarning {
                code: "degenerate_support".to_string(),
                message: "The selected support has no usable oriented triangles for topological charge.".to_string(),
            }]
        }
        TopologicalChargeStatus::UnderResolved => vec![TopologicalChargeWarning {
            code: "under_resolved".to_string(),
            message: "Topological charge was computed, but neighboring magnetization directions indicate an under-resolved texture.".to_string(),
        }],
        TopologicalChargeStatus::Stale => vec![TopologicalChargeWarning {
            code: "stale".to_string(),
            message: "Topological charge source data is stale.".to_string(),
        }],
        TopologicalChargeStatus::UnsupportedGeometry => vec![TopologicalChargeWarning {
            code: "unsupported_geometry".to_string(),
            message: "The selected geometry is not supported for topological charge.".to_string(),
        }],
        TopologicalChargeStatus::Error => vec![TopologicalChargeWarning {
            code: "error".to_string(),
            message: "Topological charge calculation failed.".to_string(),
        }],
    }
}

fn fdm_result_warnings(
    fdm_result: Option<&ComputedTopologicalCharge>,
) -> Vec<TopologicalChargeWarning> {
    let Some(fdm_result) = fdm_result else {
        return Vec::new();
    };
    fdm_result
        .result
        .warnings
        .iter()
        .map(|warning| TopologicalChargeWarning {
            code: match warning.code {
                TopologicalChargeWarningCode::NonUnitMagnetization => {
                    "non_unit_magnetization".to_string()
                }
                TopologicalChargeWarningCode::InsufficientSamples => {
                    "degenerate_support".to_string()
                }
            },
            message: warning.message.clone(),
        })
        .collect()
}

#[cfg(test)]
mod tests {
    use crate::analysis::topological_charge::{
        TopologicalChargeResult, TopologicalChargeWarning as CoreTopologicalChargeWarning,
        TopologicalChargeWarningCode,
    };
    use crate::fem_slice_overlay::SliceOverlayPointKind;

    use super::{
        cut_point_key, deduplicate_oriented_triangles, fdm_requires_object_mask,
        fdm_result_warnings, fem_fe_order_from_plan_summary, fem_profile_bin_weight_m,
        qualify_regular_fdm_midplane, topological_charge_cache_digest,
        topological_charge_profile_response, ComputedTopologicalCharge, FdmProfileGeometry,
        FieldSampleSummary, SliceOverlayPoint, TopologicalChargeLayerSample,
        TopologicalChargeResource, TopologicalChargeStatus, TopologicalChargeTrustV2,
    };

    #[test]
    fn fem_p1_cut_key_uses_global_edge_identity_not_interpolation_rounding() {
        let forward = SliceOverlayPoint {
            edge_node_ids: [4, 9],
            edge_t: 0.499_999_999_999,
            uv: [0.0, 0.0],
            world: [0.0, 0.0, 0.0],
            kind: SliceOverlayPointKind::EdgeIntersection,
        };
        let reversed = SliceOverlayPoint {
            edge_node_ids: [9, 4],
            edge_t: 0.500_000_000_001,
            uv: [0.0, 0.0],
            world: [0.0, 0.0, 0.0],
            kind: SliceOverlayPointKind::EdgeIntersection,
        };

        assert_eq!(cut_point_key(&forward), cut_point_key(&reversed));
    }

    #[test]
    fn fem_cut_deduplicates_coincident_triangles_by_global_cut_vertices() {
        let mut triangles = vec![[0, 1, 2], [2, 1, 0], [0, 2, 3]];

        assert_eq!(deduplicate_oriented_triangles(&mut triangles), 1);
        assert_eq!(triangles, vec![[0, 1, 2], [0, 2, 3]]);
    }

    #[test]
    fn fem_order_is_accepted_only_from_persisted_plan_provenance() {
        assert_eq!(
            fem_fe_order_from_plan_summary(&serde_json::json!({ "fe_order": 1 })),
            Some(1)
        );
        assert_eq!(
            fem_fe_order_from_plan_summary(&serde_json::json!({ "fe_order": 2 })),
            Some(2)
        );
        assert_eq!(fem_fe_order_from_plan_summary(&serde_json::json!({})), None);
    }

    #[test]
    fn fdm_multi_object_scope_requires_explicit_ownership_mask() {
        assert!(!fdm_requires_object_mask(Some(1)));
        assert!(fdm_requires_object_mask(Some(2)));
        // Missing scene is rejected by the route before this scope predicate.
        assert!(!fdm_requires_object_mask(None));
    }

    #[test]
    fn fdm_midplane_with_nonuniform_boundary_stays_diagnostic() {
        let mut values = vec![0.0; 27];
        for sample in values.chunks_exact_mut(3) {
            sample[2] = 1.0;
        }
        values[..3].copy_from_slice(&[
            15.0_f64.to_radians().sin(),
            0.0,
            15.0_f64.to_radians().cos(),
        ]);
        let summary = FieldSampleSummary {
            values,
            grid: Some([3, 3, 1]),
            object_mask: Some(vec![true; 9]),
            sample_count: 9,
            valid_sample_count: 9,
        };

        let qualification = qualify_regular_fdm_midplane(&summary, "xy")
            .expect("a regular FDM midplane should construct a support");

        assert_eq!(
            qualification.trust(),
            TopologicalChargeTrustV2::DiagnosticBoundary
        );
        assert!(qualification.boundary.max_deviation_rad.unwrap() > 10.0_f64.to_radians());
    }

    #[test]
    fn fem_profile_bin_weight_is_the_spacing_between_bin_midpoints() {
        let coordinates_m = [-1.0e-9, 0.0, 1.0e-9];
        assert_eq!(fem_profile_bin_weight_m(&coordinates_m), 1.0e-9);
        assert_eq!(fem_profile_bin_weight_m(&[0.0]), 0.0);
    }

    #[test]
    fn fdm_profile_publishes_cell_centres_and_physical_thickness_weights() {
        let resource = TopologicalChargeResource {
            object_id: "object".to_string(),
            quantity_id: "m".to_string(),
            revision: 1,
            status: TopologicalChargeStatus::Ready,
            charge: Some(0.0),
            nearest_integer: Some(0),
            integer_error: Some(0.0),
            method: "berg_luescher_grid".to_string(),
            plane: "xy".to_string(),
            sample_grid: None,
            sample_topology: None,
            layer_samples: vec![
                TopologicalChargeLayerSample {
                    index: 0,
                    coordinate: 0.0,
                    charge: Some(0.0),
                    sample_count: 9,
                    valid_sample_count: 9,
                    triangle_count: 8,
                    certification: None,
                },
                TopologicalChargeLayerSample {
                    index: 1,
                    coordinate: 1.0,
                    charge: Some(0.0),
                    sample_count: 9,
                    valid_sample_count: 9,
                    triangle_count: 8,
                    certification: None,
                },
            ],
            sample_count: 18,
            valid_sample_count: 18,
            field_revision: Some(1),
            domain_generation_id: Some("domain".to_string()),
            mesh_generation_id: None,
            mesh_revision: None,
            computed_at_unix_ms: 0,
            warnings: Vec::new(),
            certification: None,
        };

        let profile = topological_charge_profile_response(
            &resource,
            false,
            crate::schemas::analysis_extensions::TopologicalChargeSupportMode::LayerProfile,
            Some(FdmProfileGeometry {
                origin_m: [0.0, 0.0, 10.0e-9],
                cell_size_m: [1.0e-9, 1.0e-9, 2.0e-9],
            }),
        );

        assert_eq!(profile.len(), 2);
        assert!((profile[0].coordinate_m - 11.0e-9).abs() <= 1.0e-21);
        assert!((profile[1].coordinate_m - 13.0e-9).abs() <= 1.0e-21);
        assert!((profile[0].integration_weight_m - 2.0e-9).abs() <= 1.0e-21);
        assert!((profile[1].integration_weight_m - 2.0e-9).abs() <= 1.0e-21);
    }

    #[test]
    fn cache_digest_is_stable_and_does_not_expose_cache_key_contents() {
        let digest = topological_charge_cache_digest("analysis:topological-charge:object-a");
        assert_eq!(digest.len(), 64);
        assert_eq!(
            digest,
            topological_charge_cache_digest("analysis:topological-charge:object-a")
        );
        assert_ne!(
            digest,
            topological_charge_cache_digest("analysis:topological-charge:object-b")
        );
        assert!(!digest.contains("object-a"));
    }

    #[test]
    fn public_topological_charge_warnings_do_not_expose_insufficient_samples() {
        let result = ComputedTopologicalCharge {
            result: TopologicalChargeResult {
                charge: 0.0,
                sample_count: 3,
                valid_sample_count: 3,
                warnings: vec![CoreTopologicalChargeWarning {
                    code: TopologicalChargeWarningCode::InsufficientSamples,
                    message: "A degenerate support was skipped.".to_string(),
                }],
            },
            method: "berg_luescher_oriented_triangles_v2".to_string(),
            plane: "xy".to_string(),
            sample_grid: None,
            sample_topology: None,
            layer_samples: Vec::new(),
            certification: None,
        };

        let warnings = fdm_result_warnings(Some(&result));

        assert_eq!(warnings.len(), 1);
        assert_eq!(warnings[0].code, "degenerate_support");
        assert_ne!(warnings[0].code, "insufficient_samples");
    }
}
