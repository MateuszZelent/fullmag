//! Saved planar inspection has no dependency on an active session or solver.
use std::sync::Arc;
use axum::{extract::{Path, Query, State}, http::{HeaderMap, HeaderValue}, response::Response, Json};
use fullmag_ir::{PlanarExtentIR, PlanarFrameIR, PlanarFramePresetIR, PlanarOperatorIR};
use fullmag_quantities::{DatasetFieldSliceRequest, DatasetNumericPrecision, DATASET_SLICE_SCHEMA_VERSION};
use fullmag_session::{SessionStore, solution_field_geometry::OwnedSampleGeometryRole};
use sha2::{Digest, Sha256};
use crate::{error::ApiError, types::AppState, schemas::saved_planar::*,
    schemas::saved_field_geometry::SavedFieldGeometryBinaryQuery,
    planar_sampling::{FemPlanarField, PlanarComponent, PlanarSampleResult, PlanarSamplingEngine, PlanarOperatorCache, Occupancy, ResolvedPlanarSampleRequest}};
use super::saved_geometry::{resolve_saved_geometry, saved_geometry_resource, verify_expected_identity};

type SavedPath = (String, String, String, String, String, String);
const MAX_SOURCE_BYTES: u64 = 64 * 1024 * 1024;
const MAX_RESPONSE_BYTES: usize = 32 * 1024 * 1024;
const RECONSTRUCTION: &str = "tet4_linear_inspection_v1";

struct BuiltSavedPlanar {
    metadata: SavedPlanarResource,
    result: PlanarSampleResult,
}

fn resolve_request(query: &SavedPlanarQuery) -> Result<(ResolvedPlanarSampleRequest, usize), ApiError> {
    for hash in [&query.expected_dataset_manifest_object_ref, &query.expected_geometry_manifest_object_ref,
        &query.expected_geometry_object_ref] {
        if !fullmag_quantities::is_canonical_sha256(&format!("sha256:{hash}")) {
            return Err(ApiError::bad_request("saved planar expected identity must be bare lowercase SHA-256"));
        }
    }
    let budget = query.max_response_bytes.parse::<usize>()
        .map_err(|_| ApiError::bad_request("invalid saved planar byte budget"))?;
    if budget == 0 || budget > MAX_RESPONSE_BYTES || budget.to_string() != query.max_response_bytes {
        return Err(ApiError::bad_request("saved planar byte budget must be canonical decimal in 1..=33554432"));
    }
    let preset = match query.plane.as_str() {
        "xy" => PlanarFramePresetIR::Xy, "xz" => PlanarFramePresetIR::Xz, "yz" => PlanarFramePresetIR::Yz,
        _ => return Err(ApiError::bad_request("saved planar plane must be xy, xz or yz")),
    };
    let component = match query.component.as_str() {
        "magnitude" => PlanarComponent::Magnitude, "x" => PlanarComponent::WorldX,
        "y" => PlanarComponent::WorldY, "z" => PlanarComponent::WorldZ,
        "u" => PlanarComponent::MonitorU, "v" => PlanarComponent::MonitorV,
        "normal" => PlanarComponent::MonitorNormal,
        _ => return Err(ApiError::bad_request("unsupported saved planar component")),
    };
    let request = ResolvedPlanarSampleRequest {
        frame: PlanarFrameIR::axis_preset(preset, query.position_m, PlanarExtentIR::Explicit {
            u_min_m: query.u_min_m, u_max_m: query.u_max_m, v_min_m: query.v_min_m, v_max_m: query.v_max_m,
        }),
        operator: PlanarOperatorIR::PlaneSample, resolution: [query.width, query.height], component,
    };
    request.validate()?;
    Ok((request, budget))
}

fn build_saved_planar(store: &SessionStore, solution: &fullmag_quantities::SolutionSet,
    project: String, member: &str, artifact: &str, query: &SavedPlanarQuery, cache: &PlanarOperatorCache,
) -> Result<BuiltSavedPlanar, ApiError> {
    let (request, _) = resolve_request(query)?;
    let resolved = resolve_saved_geometry(store, solution, member, artifact)?;
    verify_expected_identity(&resolved, &SavedFieldGeometryBinaryQuery {
        expected_dataset_manifest_object_ref: query.expected_dataset_manifest_object_ref.clone(),
        expected_geometry_manifest_object_ref: query.expected_geometry_manifest_object_ref.clone(),
        expected_geometry_object_ref: query.expected_geometry_object_ref.clone(),
        max_response_bytes: query.max_response_bytes.clone(),
    })?;
    if resolved.geometry.owned_role != Some(OwnedSampleGeometryRole::SampleNodes) {
        return Err(ApiError::unprocessable("saved planar inspection requires owned SampleNodes; no implicit solver-field conversion"));
    }
    let source = saved_geometry_resource(project, solution.run_id.clone(), solution.revision, &resolved)?;
    let mesh = &resolved.geometry.mesh;
    mesh.cells.require_tet4().map_err(ApiError::unprocessable)?;
    let binding = resolved.tensor.field_binding.as_ref()
        .ok_or_else(|| ApiError::conflict("saved planar tensor field binding is absent"))?;
    let count = mesh.nodes.len() as u64;
    if resolved.dataset.field.coverage.total_elements != count
        || resolved.dataset.field.coverage.component_count != 3
        || count.checked_mul(24).is_none_or(|bytes| bytes > MAX_SOURCE_BYTES) {
        return Err(ApiError::unprocessable("saved planar requires complete three-component node samples within 64 MiB"));
    }
    let slice_request = DatasetFieldSliceRequest {
        schema_version: DATASET_SLICE_SCHEMA_VERSION.to_string(), dataset: binding.dataset.clone(),
        sample_id: binding.sample_id.clone(), item_id: binding.item_id.clone(), field_id: binding.field_id.clone(),
        element_offset: 0, element_count: count, max_response_bytes: MAX_SOURCE_BYTES,
    };
    let read = fullmag_session::materialized_dataset::read_materialized_dataset_slice(
        store, solution, member, artifact, &query.expected_dataset_manifest_object_ref, &slice_request,
    ).map_err(|error| ApiError::internal(error.to_string()))?
        .ok_or_else(|| ApiError::not_found("saved planar dataset is absent"))?;
    let slice = read.field.slice;
    let mut values = Vec::with_capacity(mesh.nodes.len() * 3);
    let width = slice.manifest.precision.byte_size() as usize;
    for part in &slice.part_bytes {
        if part.len() % width != 0 { return Err(ApiError::internal("unaligned saved planar source bytes")); }
        for bytes in part.chunks_exact(width) {
            let value = match slice.manifest.precision {
                DatasetNumericPrecision::F32 => f32::from_le_bytes(bytes.try_into().map_err(|_| ApiError::internal("invalid f32 source"))?) as f64,
                DatasetNumericPrecision::F64 => f64::from_le_bytes(bytes.try_into().map_err(|_| ApiError::internal("invalid f64 source"))?),
            };
            if !value.is_finite() { return Err(ApiError::internal("non-finite saved planar source")); }
            values.push(value);
        }
    }
    let geometry_key_bytes = serde_json::to_vec(&(RECONSTRUCTION, crate::planar_sampling::PLANAR_SAMPLER_VERSION, &source.geometry_payload.object_ref,
        &source.layout_digest, &request.frame, &request.operator, request.resolution))
        .map_err(|error| ApiError::internal(error.to_string()))?;
    let geometry_key = format!("saved-planar-geometry:{:x}", Sha256::digest(geometry_key_bytes));
    let result = sample_carrier(mesh, values, &request, cache, &geometry_key)?;
    let identity_bytes = serde_json::to_vec(&(RECONSTRUCTION, result.meta.sampler_version, &source.containing_solution_revision, &source.source, &source.dataset_manifest,
        &source.geometry_manifest, &source.geometry_payload, &source.layout_digest, query))
        .map_err(|error| ApiError::internal(error.to_string()))?;
    let identity = format!("sha256:{:x}", Sha256::digest(identity_bytes));
    let mut finite = result.scalar_values.iter().copied().zip(&result.occupancy)
        .filter_map(|(v, occupancy)| (*occupancy == Occupancy::Occupied && v.is_finite()).then_some(v));
    let first = finite.next();
    let range = first.map(|v| finite.fold((v,v), |(min,max), x| (min.min(x),max.max(x))));
    let metadata = SavedPlanarResource {
        schema_version: "fullmag.persistence.saved_planar.v1".into(), request_identity: identity,
        source, reconstruction: RECONSTRUCTION.into(), qualification: "not_verified".into(),
        operator: "plane_sample".into(), sampler_version: result.meta.sampler_version.into(),
        sampling_method: result.meta.sampling_method.into(), component: query.component.clone(),
        frame_origin_m: request.frame.origin_m, frame_u_axis: request.frame.u_axis,
        frame_v_axis: request.frame.v_axis, frame_normal: request.frame.normal,
        bounds_uv_m: result.meta.bounds_uv_m, resolution: result.meta.resolution,
        occupied_count: result.meta.occupied_count, empty_count: result.meta.empty_count,
        scalar_min: range.map(|r| r.0), scalar_max: range.map(|r| r.1),
        vector_components: ["x".into(), "y".into(), "z".into()], occupancy_encoding: "uint8.planar_occupancy.v1".into(),
    };
    Ok(BuiltSavedPlanar { metadata, result })
}

fn sample_carrier(mesh: &fullmag_ir::MeshIR, values: Vec<f64>, request: &ResolvedPlanarSampleRequest,
    cache: &PlanarOperatorCache, geometry_key: &str)
    -> Result<PlanarSampleResult, ApiError> {
    let elements = mesh.cells.require_tet4().map_err(ApiError::unprocessable)?;
    // All published sample cells participate; physical material markers must
    // not erase the field in Universe/air. The stored mesh remains untouched.
    let markers = vec![1; elements.len()];
    let field = FemPlanarField::new(3, mesh.nodes.clone(), elements, markers, values)?;
    PlanarSamplingEngine::sample_fem_cached(&field, request, cache, geometry_key)
}

async fn load_saved_planar(state: Arc<AppState>, path: SavedPath, query: SavedPlanarQuery)
    -> Result<BuiltSavedPlanar, ApiError> {
    resolve_request(&query)?;
    let (project, run, solution, revision, member, artifact) = path;
    super::validate_lookup_id(&member, "member")?;
    super::validate_lookup_id(&artifact, "dataset artifact")?;
    let cache = Arc::clone(&state.quantity_data_plane.planar_operator_cache);
    super::with_revision_value(state, project.clone(), run, solution, revision, move |store, solution| {
        build_saved_planar(store, &solution, project, &member, &artifact, &query, &cache)
    }).await
}

fn raster_binary(built: &BuiltSavedPlanar, kind: &str) -> Result<Vec<u8>, ApiError> {
    if kind == "occupancy" { return Ok(built.result.occupancy.iter().map(|value| *value as u8).collect()); }
    let values: Vec<f64> = if kind == "scalar" { built.result.scalar_values.clone() } else {
        built.result.vector_values.as_ref().ok_or_else(|| ApiError::unprocessable("saved planar vector unavailable"))?
            .iter().flat_map(|v| v.iter().copied()).collect()
    }.into_iter().enumerate().map(|(index, value)| {
        let point = index / if kind == "scalar" {1} else {3};
        if built.result.occupancy[point] == Occupancy::Occupied && value.is_finite() {value} else {0.0}
    }).collect();
    // Empty raster entries have zero transport placeholders; occupancy remains
    // authoritative and consumers must never plot them as measured zeros.
    crate::field_store::serialize_field_vector_binary_v2("H_ant", if kind == "scalar" {1} else {3},
        [built.metadata.resolution[0], built.metadata.resolution[1], 1], &values).map_err(ApiError::internal)
}

async fn binary(state: Arc<AppState>, path: SavedPath, query: SavedPlanarQuery, headers: HeaderMap, kind: &str)
    -> Result<Response, ApiError> {
    let (_, budget) = resolve_request(&query)?;
    let points = query.width as usize * query.height as usize;
    // Existing field_store FIELD_VECTOR_BINARY_HEADER_LEN is 48 (FMVP v2).
    let estimate = if kind == "occupancy" {points} else {48 + points * if kind == "scalar" {8} else {24}};
    if estimate > budget { return Err(ApiError::unprocessable("saved planar raster exceeds request byte budget")); }
    let built = load_saved_planar(state, path, query).await?;
    let body = raster_binary(&built, kind)?;
    if body.len() > budget { return Err(ApiError::unprocessable("saved planar binary exceeds request byte budget")); }
    let etag = format!("\"saved-planar-{kind}-{}-{:x}\"", built.metadata.request_identity, Sha256::digest(&body));
    let mut response = crate::router_v2::handlers::shared::conditional_binary_response(&headers, &etag, body);
    response.headers_mut().insert("x-fullmag-planar-identity", HeaderValue::from_str(&built.metadata.request_identity)
        .map_err(|error| ApiError::internal(error.to_string()))?);
    Ok(response)
}

#[utoipa::path(get,
    path = "/v2/persistence/projects/{project_id}/runs/{run_id}/solution-sets/{solution_set_id}/revisions/{revision}/members/{member_id}/artifacts/{artifact_id}/saved-planar/meta",
    params(("project_id" = String, Path), ("run_id" = String, Path), ("solution_set_id" = String, Path), ("revision" = String, Path), ("member_id" = String, Path), ("artifact_id" = String, Path), SavedPlanarQuery),
    responses((status = 200, body = SavedPlanarResource), (status = 400, description = "Invalid bounded query"), (status = 404, description = "Missing pinned source"), (status = 409, description = "Identity mismatch"), (status = 422, description = "Unsupported carrier or budget")), tag = "persistence")]
pub async fn get_saved_planar_meta(State(state): State<Arc<AppState>>, Path(path): Path<SavedPath>,
    Query(query): Query<SavedPlanarQuery>) -> Result<Json<SavedPlanarResource>, ApiError> {
    Ok(Json(load_saved_planar(state, path, query).await?.metadata))
}

#[utoipa::path(get,
    path = "/v2/persistence/projects/{project_id}/runs/{run_id}/solution-sets/{solution_set_id}/revisions/{revision}/members/{member_id}/artifacts/{artifact_id}/saved-planar/scalar",
    params(("project_id" = String, Path), ("run_id" = String, Path), ("solution_set_id" = String, Path), ("revision" = String, Path), ("member_id" = String, Path), ("artifact_id" = String, Path), SavedPlanarQuery),
    responses((status = 200, content_type = "application/octet-stream"), (status = 400, description = "Invalid bounded query"), (status = 404, description = "Missing pinned source"), (status = 409, description = "Identity mismatch"), (status = 422, description = "Unsupported carrier or budget")), tag = "persistence")]
pub async fn get_saved_planar_scalar(State(state): State<Arc<AppState>>, Path(path): Path<SavedPath>,
    Query(query): Query<SavedPlanarQuery>, headers: HeaderMap) -> Result<Response, ApiError> {
    binary(state, path, query, headers, "scalar").await
}

#[utoipa::path(get,
    path = "/v2/persistence/projects/{project_id}/runs/{run_id}/solution-sets/{solution_set_id}/revisions/{revision}/members/{member_id}/artifacts/{artifact_id}/saved-planar/vectors",
    params(("project_id" = String, Path), ("run_id" = String, Path), ("solution_set_id" = String, Path), ("revision" = String, Path), ("member_id" = String, Path), ("artifact_id" = String, Path), SavedPlanarQuery),
    responses((status = 200, content_type = "application/octet-stream"), (status = 400, description = "Invalid bounded query"), (status = 404, description = "Missing pinned source"), (status = 409, description = "Identity mismatch"), (status = 422, description = "Unsupported carrier or budget")), tag = "persistence")]
pub async fn get_saved_planar_vectors(State(state): State<Arc<AppState>>, Path(path): Path<SavedPath>,
    Query(query): Query<SavedPlanarQuery>, headers: HeaderMap) -> Result<Response, ApiError> {
    binary(state, path, query, headers, "vectors").await
}

#[utoipa::path(get,
    path = "/v2/persistence/projects/{project_id}/runs/{run_id}/solution-sets/{solution_set_id}/revisions/{revision}/members/{member_id}/artifacts/{artifact_id}/saved-planar/occupancy",
    params(("project_id" = String, Path), ("run_id" = String, Path), ("solution_set_id" = String, Path), ("revision" = String, Path), ("member_id" = String, Path), ("artifact_id" = String, Path), SavedPlanarQuery),
    responses((status = 200, content_type = "application/octet-stream"), (status = 400, description = "Invalid bounded query"), (status = 404, description = "Missing pinned source"), (status = 409, description = "Identity mismatch"), (status = 422, description = "Unsupported carrier or budget")), tag = "persistence")]
pub async fn get_saved_planar_occupancy(State(state): State<Arc<AppState>>, Path(path): Path<SavedPath>,
    Query(query): Query<SavedPlanarQuery>, headers: HeaderMap) -> Result<Response, ApiError> {
    binary(state, path, query, headers, "occupancy").await
}

#[utoipa::path(get,
    path = "/v2/persistence/projects/{project_id}/runs/{run_id}/solution-sets/{solution_set_id}/revisions/{revision}/members/{member_id}/artifacts/{artifact_id}/saved-planar/probe",
    params(("project_id" = String, Path), ("run_id" = String, Path), ("solution_set_id" = String, Path), ("revision" = String, Path), ("member_id" = String, Path), ("artifact_id" = String, Path), SavedPlanarProbeQuery),
    responses((status = 200, body = SavedPlanarProbeResource), (status = 400, description = "Invalid bounded query"), (status = 404, description = "Missing pinned source"), (status = 409, description = "Identity mismatch"), (status = 422, description = "Unsupported carrier or budget")), tag = "persistence")]
pub async fn get_saved_planar_probe(State(state): State<Arc<AppState>>, Path(path): Path<SavedPath>,
    Query(query): Query<SavedPlanarProbeQuery>) -> Result<Json<SavedPlanarProbeResource>, ApiError> {
    if query.pixel_x >= query.width || query.pixel_y >= query.height {
        return Err(ApiError::bad_request("saved planar probe pixel is outside raster"));
    }
    let (pixel_x, pixel_y) = (query.pixel_x, query.pixel_y);
    let built = load_saved_planar(state, path, query.into_plane()).await?;
    let index = pixel_y as usize * built.metadata.resolution[0] as usize + pixel_x as usize;
    let [umin, umax, vmin, vmax] = built.metadata.bounds_uv_m;
    let u = umin + (pixel_x as f64 + 0.5) * (umax-umin) / built.metadata.resolution[0] as f64;
    let v = vmin + (pixel_y as f64 + 0.5) * (vmax-vmin) / built.metadata.resolution[1] as f64;
    let point_m = std::array::from_fn(|axis| built.metadata.frame_origin_m[axis]
        + u*built.metadata.frame_u_axis[axis] + v*built.metadata.frame_v_axis[axis]);
    Ok(Json(SavedPlanarProbeResource {
        request_identity: built.metadata.request_identity, pixel: [pixel_x, pixel_y], point_m,
        occupancy: built.result.occupancy[index] as u8,
        scalar: Some(built.result.scalar_values[index]).filter(|v| built.result.occupancy[index] == Occupancy::Occupied && v.is_finite()),
        vector: built.result.vector_values.as_ref().map(|v| v[index]).filter(|v| built.result.occupancy[index] == Occupancy::Occupied && v.iter().all(|x| x.is_finite())),
        source_entity_ordinal: built.result.source_entity_ids[index],
    }))
}

#[cfg(test)]
mod tests {
    use super::*;
    fn query() -> SavedPlanarQuery {
        SavedPlanarQuery {
            expected_dataset_manifest_object_ref: "a".repeat(64),
            expected_geometry_manifest_object_ref: "b".repeat(64),
            expected_geometry_object_ref: "c".repeat(64),
            plane: "xy".into(), position_m: 0.25,
            u_min_m: 0.0, u_max_m: 0.5, v_min_m: 0.0, v_max_m: 0.5,
            width: 1, height: 1, component: "magnitude".into(), max_response_bytes: "1024".into(),
        }
    }
    fn sample_test_carrier(mesh: &fullmag_ir::MeshIR, values: Vec<f64>, request: &ResolvedPlanarSampleRequest)
        -> Result<PlanarSampleResult, ApiError> {
        super::sample_carrier(mesh, values, request, &PlanarOperatorCache::new(2, 1024*1024), "test-plane")
    }
    fn carrier() -> fullmag_ir::MeshIR {
        fullmag_ir::MeshIR {
            nodes: vec![[0.,0.,0.], [1.,0.,0.], [0.,1.,0.], [0.,0.,1.]],
            cells: fullmag_ir::FemConnectivityIR::from_tet4(vec![[0,1,2,3]]),
            element_markers: vec![0], ..Default::default()
        }
    }
    #[test]
    fn norm_is_derived_after_vector_interpolation_even_in_air() {
        let (request, _) = resolve_request(&query()).unwrap();
        // At the tetrahedron centroid all four weights are 1/4. The vector
        // cancels exactly, whereas interpolation of vertex norms yields one.
        let result = sample_test_carrier(&carrier(), vec![1.,0.,0., -1.,0.,0., 0.,1.,0., 0.,-1.,0.], &request).unwrap();
        assert_eq!(result.scalar_values, vec![0.]);
        assert_eq!(result.vector_values.unwrap(), vec![[0.,0.,0.]]);
        assert_eq!(result.occupancy, vec![crate::planar_sampling::Occupancy::Occupied]);
        assert_eq!(carrier().element_markers, vec![0]);
    }
    #[test]
    fn outside_support_remains_empty_not_extrapolated() {
        let mut q = query(); q.position_m = 2.;
        let result = sample_test_carrier(&carrier(), vec![1.;12], &resolve_request(&q).unwrap().0).unwrap();
        assert_eq!(result.occupancy, vec![crate::planar_sampling::Occupancy::Empty]);
        assert!(result.scalar_values[0].is_nan());
        assert_eq!(result.source_entity_ids, vec![None]);
    }
    #[test]
    fn all_axis_frames_preserve_si_and_signed_normal() {
        for (plane, normal, scalar) in [("xy", [0.,0.,1.], 3.), ("xz", [0.,-1.,0.], -2.), ("yz", [1.,0.,0.], 1.)] {
            let mut q = query(); q.plane = plane.into(); q.component = "normal".into();
            let (request,_) = resolve_request(&q).unwrap();
            assert_eq!(request.frame.normal, normal);
            let result = sample_test_carrier(&carrier(), [1.,2.,3.].repeat(4), &request).unwrap();
            assert_eq!(result.scalar_values, vec![scalar]);
        }
    }
    #[test]
    fn query_fences_nonfinite_extent_counts_and_identity() {
        for bad in [0, u32::MAX] { let mut q = query(); q.width = bad; assert!(resolve_request(&q).is_err()); }
        for value in [f64::NAN, f64::INFINITY] { let mut q = query(); q.position_m = value; assert!(resolve_request(&q).is_err()); }
        let mut q = query(); q.u_max_m = q.u_min_m; assert!(resolve_request(&q).is_err());
        for value in ["0", "010", "33554433", "-1"] { let mut q=query(); q.max_response_bytes=value.into(); assert!(resolve_request(&q).is_err()); }
        let mut q=query(); q.expected_geometry_object_ref="A".repeat(64); assert!(resolve_request(&q).is_err());
        let mut q=query(); q.component="m".into(); assert!(resolve_request(&q).is_err());
        let mut q=query(); q.plane="oblique".into(); assert!(resolve_request(&q).is_err());
    }
    #[test]
    fn no_silent_topology_or_partial_value_fallback() {
        let request=resolve_request(&query()).unwrap().0;
        assert!(sample_test_carrier(&carrier(), vec![0.;9], &request).is_err());
        let mut mesh=carrier(); mesh.cells=fullmag_ir::FemConnectivityIR::empty();
        assert!(sample_test_carrier(&mesh, vec![0.;12], &request).is_err());
    }
    #[test]
    fn geometry_operator_reused_across_components_and_values() {
        let cache = PlanarOperatorCache::new(2, 1024*1024);
        let mesh = carrier();
        let mut request = resolve_request(&query()).unwrap().0;
        let first = super::sample_carrier(&mesh, [1.,2.,3.].repeat(4), &request, &cache, "pinned-plane").unwrap();
        request.component = PlanarComponent::WorldX;
        let second = super::sample_carrier(&mesh, [4.,5.,6.].repeat(4), &request, &cache, "pinned-plane").unwrap();
        assert_eq!(cache.build_count(), 1);
        assert!((first.scalar_values[0] - 14_f64.sqrt()).abs() < 1e-12);
        assert_eq!(second.scalar_values, vec![4.]);
    }
    #[test]
    fn probe_has_flat_strict_query_contract() {
        let mut value=serde_json::to_value(query()).unwrap();
        value["pixel_x"]=serde_json::json!(0); value["pixel_y"]=serde_json::json!(0);
        let probe: SavedPlanarProbeQuery=serde_json::from_value(value.clone()).unwrap();
        assert_eq!(probe.into_plane().plane, "xy");
        value["stage_id"]=serde_json::json!("live");
        assert!(serde_json::from_value::<SavedPlanarProbeQuery>(value).is_err());
    }
}
