//! Read-only resources for one exact saved FEM field geometry.
//!
//! The route resolves the geometry through the immutable tensor owner and
//! historical SolutionSet revision.  It never consults the active session,
//! latest mesh, preview cache, or solver state.

use crate::error::ApiError;
use crate::schemas::materialized_dataset::descriptor_resource;
use crate::schemas::saved_field_geometry::{
    SavedFieldGeometryArtifactResource, SavedFieldGeometryBinaryQuery,
    SavedFieldGeometryDatasetResource, SavedFieldGeometryPayloadResource,
    SavedFieldGeometryPinnedSourceResource, SavedFieldGeometryRepresentationEvidenceResource,
    SavedFieldGeometryResource, MAX_SAVED_FIELD_GEOMETRY_DECODE_BYTES,
    MAX_SAVED_FIELD_SUPPORT_BINARY_BYTES, SAVED_FIELD_GEOMETRY_RESOURCE_SCHEMA,
    SAVED_FIELD_SUPPORT_BINARY_SCHEMA,
};
use crate::types::AppState;
use axum::extract::{Path, Query, State};
use axum::http::{HeaderMap, HeaderName, HeaderValue};
use axum::response::Response;
use fullmag_quantities::{SolutionArtifactRef, SolutionSet};
use fullmag_session::materialized_dataset::{
    read_materialized_dataset_artifact, MaterializedDatasetManifest,
};
use fullmag_session::solution_field_geometry::{
    read_pinned_solution_field_geometry, read_solution_field_geometry_manifest,
    SavedFemP1FieldGeometry, SolutionFieldGeometryManifest, SOLUTION_FIELD_GEOMETRY_SCHEMA,
};
use fullmag_session::solution_tensor_source::{
    resolve_solution_tensor, PinnedSolutionTensorSource,
};
use fullmag_session::{SessionStore, TensorDescriptor};
use sha2::{Digest, Sha256};
use std::sync::Arc;

const FMSP_HEADER_LEN: usize = 24;
const FMSP_VERSION: u16 = 1;
const FMSP_FLAGS: u16 = 0;
const FMMT_V2_HEADER_LEN: usize = 64;
const MAX_BINARY_RESPONSE_BYTES: usize = MAX_SAVED_FIELD_GEOMETRY_DECODE_BYTES as usize;

#[derive(Debug, Clone)]
struct ResolvedSavedGeometry {
    geometry_artifact: SolutionArtifactRef,
    geometry_manifest: SolutionFieldGeometryManifest,
    geometry: SavedFemP1FieldGeometry,
    tensor_artifact: SolutionArtifactRef,
    tensor: TensorDescriptor,
    dataset_artifact: SolutionArtifactRef,
    dataset: MaterializedDatasetManifest,
}

#[derive(Debug)]
struct BinaryPayload {
    body: Vec<u8>,
    etag: String,
    topology_hash: Option<String>,
    support_hash: Option<String>,
}

#[utoipa::path(
    get,
    path = "/v2/persistence/projects/{project_id}/runs/{run_id}/solution-sets/{solution_set_id}/revisions/{revision}/members/{member_id}/artifacts/{artifact_id}/saved-field-geometry",
    params(("project_id" = String, Path), ("run_id" = String, Path), ("solution_set_id" = String, Path), ("revision" = String, Path, description = "Canonical positive decimal u64"), ("member_id" = String, Path), ("artifact_id" = String, Path, description = "Selected materialized dataset artifact ID")),
    responses((status = 200, body = SavedFieldGeometryResource, description = "Exact immutable saved FEM geometry metadata; no active-runtime fallback"), (status = 400, description = "Invalid identity or revision"), (status = 404, description = "Pinned geometry or dataset manifest is missing"), (status = 409, description = "Pinned owner, dataset, geometry, or tensor identity mismatch"), (status = 500, description = "Corrupt or oversized persisted geometry")),
    tag = "persistence"
)]
pub async fn get_saved_field_geometry(
    State(state): State<Arc<AppState>>,
    Path((project_id, run_id, solution_id, revision, member_id, artifact_id)): Path<(
        String,
        String,
        String,
        String,
        String,
        String,
    )>,
) -> Result<axum::Json<SavedFieldGeometryResource>, ApiError> {
    super::validate_lookup_id(&member_id, "member")?;
    super::validate_lookup_id(&artifact_id, "dataset artifact")?;
    let response_project_id = project_id.clone();
    let response_run_id = run_id.clone();
    super::with_revision(
        state,
        project_id,
        run_id,
        solution_id,
        revision,
        move |store, solution| {
            let resolved = resolve_saved_geometry(store, &solution, &member_id, &artifact_id)?;
            saved_geometry_resource(
                response_project_id,
                response_run_id,
                solution.revision,
                &resolved,
            )
        },
    )
    .await
}

#[utoipa::path(
    get,
    path = "/v2/persistence/projects/{project_id}/runs/{run_id}/solution-sets/{solution_set_id}/revisions/{revision}/members/{member_id}/artifacts/{artifact_id}/saved-field-geometry/topology",
    params(("project_id" = String, Path), ("run_id" = String, Path), ("solution_set_id" = String, Path), ("revision" = String, Path, description = "Canonical positive decimal u64"), ("member_id" = String, Path), ("artifact_id" = String, Path, description = "Selected materialized dataset artifact ID"), SavedFieldGeometryBinaryQuery),
    responses((status = 200, description = "Pinned saved FEM topology in the existing FMMT v2 binary format", content_type = "application/octet-stream"), (status = 206, description = "Partial FMMT v2 body for a single byte Range", content_type = "application/octet-stream"), (status = 304, description = "Pinned topology is unchanged"), (status = 400, description = "Invalid identity, hash, or byte budget"), (status = 404, description = "Pinned geometry or dataset manifest is missing"), (status = 409, description = "Expected pinned identity differs from the immutable artifact"), (status = 416, description = "Requested byte Range is not satisfiable"), (status = 422, description = "FMMT v2 body exceeds the bounded geometry transport budget")),
    tag = "persistence"
)]
pub async fn get_saved_field_geometry_topology(
    State(state): State<Arc<AppState>>,
    Path((project_id, run_id, solution_id, revision, member_id, artifact_id)): Path<(
        String,
        String,
        String,
        String,
        String,
        String,
    )>,
    Query(query): Query<SavedFieldGeometryBinaryQuery>,
    headers: HeaderMap,
) -> Result<Response, ApiError> {
    validate_binary_request(&member_id, &artifact_id, &query, MAX_BINARY_RESPONSE_BYTES)?;
    let body = super::with_revision_value(
        state,
        project_id,
        run_id,
        solution_id,
        revision,
        move |store, solution| {
            let resolved = resolve_saved_geometry(store, &solution, &member_id, &artifact_id)?;
            verify_expected_identity(&resolved, &query)?;
            let topology_hash = resolved.geometry.mesh.topology_fingerprint_v6();
            let etag_scope = saved_geometry_binary_etag_scope(&resolved);
            let payload = fem_mesh_payload(resolved.geometry, topology_hash.clone())?;
            let max_response_bytes = parse_response_budget(&query.max_response_bytes)?;
            let estimated = estimated_fmmt_v2_len(&payload)?;
            if estimated > MAX_BINARY_RESPONSE_BYTES || estimated > max_response_bytes {
                return Err(ApiError::unprocessable(format!(
                    "SAVED_GEOMETRY_TOPOLOGY_BYTE_LIMIT: FMMT v2 body requires {estimated} bytes, limit is {max_response_bytes}"
                )));
            }
            let body = crate::field_store::serialize_fem_mesh_topology_binary_v2(&payload)
                .map_err(|error| ApiError::unprocessable(format!("saved topology is unsupported: {error}")))?;
            if body.len() != estimated {
                return Err(ApiError::internal(
                    "saved topology serializer length differs from its bounded preflight",
                ));
            }
            let body_hash = sha256_hex(&body);
            Ok(BinaryPayload {
                body,
                etag: saved_geometry_binary_etag(&etag_scope, "topology-fmmt-v2", &body_hash),
                topology_hash: Some(topology_hash),
                support_hash: None,
            })
        },
    )
    .await?;
    let etag = body.etag.clone();
    let topology_hash = body.topology_hash.clone();
    let response =
        crate::router_v2::handlers::shared::conditional_binary_response(&headers, &etag, body.body);
    let mut response = response;
    if let Some(hash) = topology_hash {
        crate::router_v2::handlers::shared::insert_mesh_topology_hash_header(&mut response, &hash);
    }
    Ok(response)
}

#[utoipa::path(
    get,
    path = "/v2/persistence/projects/{project_id}/runs/{run_id}/solution-sets/{solution_set_id}/revisions/{revision}/members/{member_id}/artifacts/{artifact_id}/saved-field-geometry/support",
    params(("project_id" = String, Path), ("run_id" = String, Path), ("solution_set_id" = String, Path), ("revision" = String, Path, description = "Canonical positive decimal u64"), ("member_id" = String, Path), ("artifact_id" = String, Path, description = "Selected materialized dataset artifact ID"), SavedFieldGeometryBinaryQuery),
    responses((status = 200, description = "Pinned saved FEM active-node support in FMSP v1", content_type = "application/octet-stream"), (status = 206, description = "Partial FMSP body for a single byte Range", content_type = "application/octet-stream"), (status = 304, description = "Pinned support is unchanged"), (status = 400, description = "Invalid identity, hash, or byte budget"), (status = 404, description = "Pinned geometry or dataset manifest is missing"), (status = 409, description = "Expected pinned identity differs from the immutable artifact"), (status = 416, description = "Requested byte Range is not satisfiable"), (status = 422, description = "FMSP body exceeds the bounded support transport budget")),
    tag = "persistence"
)]
pub async fn get_saved_field_geometry_support(
    State(state): State<Arc<AppState>>,
    Path((project_id, run_id, solution_id, revision, member_id, artifact_id)): Path<(
        String,
        String,
        String,
        String,
        String,
        String,
    )>,
    Query(query): Query<SavedFieldGeometryBinaryQuery>,
    headers: HeaderMap,
) -> Result<Response, ApiError> {
    validate_binary_request(
        &member_id,
        &artifact_id,
        &query,
        MAX_SAVED_FIELD_SUPPORT_BINARY_BYTES as usize,
    )?;
    let body = super::with_revision_value(
        state,
        project_id,
        run_id,
        solution_id,
        revision,
        move |store, solution| {
            let resolved = resolve_saved_geometry(store, &solution, &member_id, &artifact_id)?;
            verify_expected_identity(&resolved, &query)?;
            let etag_scope = saved_geometry_binary_etag_scope(&resolved);
            let mask_body = encode_saved_support(&resolved.geometry.field_semantics.active_node_mask)?;
            let max_response_bytes = parse_response_budget(&query.max_response_bytes)?;
            if mask_body.len() > max_response_bytes {
                return Err(ApiError::unprocessable(format!(
                    "SAVED_GEOMETRY_SUPPORT_BYTE_LIMIT: FMSP body requires {} bytes, limit is {max_response_bytes}",
                    mask_body.len()
                )));
            }
            let support_hash = sha256_hex(&mask_body);
            Ok(BinaryPayload {
                body: mask_body,
                etag: saved_geometry_binary_etag(&etag_scope, "support-fmsp-v1", &support_hash),
                topology_hash: Some(resolved.geometry.mesh.topology_fingerprint_v6()),
                support_hash: Some(support_hash),
            })
        },
    )
    .await?;
    let etag = body.etag.clone();
    let topology_hash = body.topology_hash.clone();
    let support_hash = body.support_hash.clone();
    let mut response =
        crate::router_v2::handlers::shared::conditional_binary_response(&headers, &etag, body.body);
    if let Some(hash) = topology_hash {
        crate::router_v2::handlers::shared::insert_mesh_topology_hash_header(&mut response, &hash);
    }
    if let Some(hash) = support_hash {
        response.headers_mut().insert(
            HeaderName::from_static("x-fullmag-saved-support-sha256"),
            HeaderValue::from_str(&hash).map_err(|error| ApiError::internal(error.to_string()))?,
        );
    }
    Ok(response)
}

fn resolve_saved_geometry(
    store: &SessionStore,
    solution: &SolutionSet,
    member_id: &str,
    dataset_artifact_id: &str,
) -> Result<ResolvedSavedGeometry, ApiError> {
    let dataset =
        read_materialized_dataset_artifact(store, solution, member_id, dataset_artifact_id)
            .map_err(|error| ApiError::internal(error.to_string()))?
            .ok_or_else(|| {
                ApiError::not_found("saved geometry materialized dataset artifact is missing")
            })?;
    if dataset.manifest_artifact.artifact_id != dataset_artifact_id {
        return Err(ApiError::conflict(
            "materialized dataset reader returned a different route artifact",
        ));
    }
    let source = dataset.manifest.field.source.clone();
    let resolved = read_pinned_solution_field_geometry(store, &source)
        .map_err(|error| ApiError::internal(error.to_string()))?
        .ok_or_else(|| ApiError::not_found("saved field geometry binding is missing"))?;
    let (geometry_manifest, geometry) = resolved;

    let owner_member = dataset
        .owner
        .members
        .iter()
        .find(|member| member.member_id == member_id)
        .ok_or_else(|| ApiError::not_found("saved geometry owner member is missing"))?;
    let mut geometry_artifact = None;
    for artifact in owner_member
        .artifacts
        .iter()
        .filter(|artifact| artifact.schema_id == SOLUTION_FIELD_GEOMETRY_SCHEMA)
    {
        let candidate = read_solution_field_geometry_manifest(store.cas(), artifact)
            .map_err(|error| ApiError::internal(error.to_string()))?;
        if candidate != geometry_manifest {
            continue;
        }
        fullmag_session::solution_field_geometry::validate_field_geometry_owner(
            &candidate,
            &dataset.owner,
            member_id,
            true,
        )
        .map_err(|error| ApiError::conflict(error.to_string()))?;
        if geometry_artifact.replace(artifact.clone()).is_some() {
            return Err(ApiError::conflict(
                "saved geometry has duplicate exact geometry manifests",
            ));
        }
    }
    let geometry_artifact = geometry_artifact.ok_or_else(|| {
        ApiError::not_found("saved geometry manifest is missing from its exact owner revision")
    })?;

    let tensor = resolve_solution_tensor(store, &source)
        .map_err(|error| ApiError::internal(error.to_string()))?;
    if tensor.artifact != geometry_manifest.tensor_artifact
        || tensor.artifact != dataset.manifest.field.tensor_artifact
    {
        return Err(ApiError::conflict(
            "saved geometry tensor artifact differs from its pinned dataset or geometry source",
        ));
    }

    Ok(ResolvedSavedGeometry {
        geometry_artifact,
        geometry_manifest,
        geometry,
        tensor_artifact: tensor.artifact,
        tensor: tensor.tensor,
        dataset_artifact: dataset.manifest_artifact,
        dataset: dataset.manifest,
    })
}

fn saved_geometry_resource(
    project_id: String,
    run_id: String,
    containing_solution_revision: u64,
    resolved: &ResolvedSavedGeometry,
) -> Result<SavedFieldGeometryResource, ApiError> {
    let binding = resolved
        .tensor
        .field_binding
        .as_ref()
        .ok_or_else(|| ApiError::internal("saved geometry tensor field binding is missing"))?;
    let semantic_field = resolved
        .dataset
        .dataset
        .samples
        .first()
        .and_then(|sample| sample.items.first())
        .and_then(|item| item.fields.first())
        .ok_or_else(|| ApiError::internal("saved geometry dataset field is missing"))?;
    if semantic_field.descriptor != binding.descriptor {
        return Err(ApiError::conflict(
            "saved geometry dataset descriptor differs from the pinned tensor",
        ));
    }
    let topology_fingerprint = resolved.geometry.mesh.topology_fingerprint_v6();
    let topology_binary = topology_binary_identity(&resolved.geometry)?;
    let support_binary_byte_length =
        support_body_len(resolved.geometry.field_semantics.active_node_mask.len())?;
    let support_binary_hash =
        if support_binary_byte_length <= MAX_SAVED_FIELD_SUPPORT_BINARY_BYTES as usize {
            Some(support_binary_identity(&resolved.geometry.field_semantics.active_node_mask)?.1)
        } else {
            None
        };
    Ok(SavedFieldGeometryResource {
        schema_version: SAVED_FIELD_GEOMETRY_RESOURCE_SCHEMA.to_string(),
        project_id,
        run_id,
        solution_set_id: resolved.geometry_manifest.source.solution_set_id.clone(),
        containing_solution_revision: containing_solution_revision.to_string(),
        owner_solution_revision: resolved
            .geometry_manifest
            .source
            .solution_revision
            .to_string(),
        member_id: resolved.geometry_manifest.source.member_id.clone(),
        source: pinned_source_resource(&resolved.geometry_manifest.source),
        dataset_manifest: artifact_resource(&resolved.dataset_artifact),
        geometry_manifest: artifact_resource(&resolved.geometry_artifact),
        geometry_payload: SavedFieldGeometryPayloadResource {
            schema_id: resolved.geometry_manifest.geometry.schema_id.clone(),
            object_ref: resolved.geometry_manifest.geometry.object_ref.clone(),
            byte_length: resolved.geometry_manifest.geometry.byte_length.to_string(),
        },
        tensor_artifact: artifact_resource(&resolved.tensor_artifact),
        dataset: SavedFieldGeometryDatasetResource {
            dataset_id: binding.dataset.dataset_id.clone(),
            revision: binding.dataset.revision.to_string(),
            sample_id: binding.sample_id.clone(),
            item_id: binding.item_id.clone(),
            field_id: binding.field_id.clone(),
            group_id: binding.group_id.clone(),
            descriptor: descriptor_resource(&semantic_field.descriptor),
        },
        geometry_schema_version: resolved.geometry.schema_version.clone(),
        coordinate_unit: resolved.geometry.coordinate_unit.clone(),
        representation_evidence: SavedFieldGeometryRepresentationEvidenceResource::NotVerified,
        topology_fingerprint,
        support_fingerprint: binding
            .descriptor
            .active_support
            .support_fingerprint
            .clone(),
        layout_digest: binding.descriptor.layout_digest.clone(),
        producer_id: resolved.geometry.field_semantics.producer_id.clone(),
        producer_version: resolved.geometry.field_semantics.producer_version.clone(),
        node_count: resolved.geometry.mesh.nodes.len().to_string(),
        cell_count: resolved.geometry.mesh.cells.len().to_string(),
        facet_count: resolved.geometry.mesh.facets.len().to_string(),
        active_node_count: resolved
            .geometry
            .field_semantics
            .active_node_mask
            .iter()
            .filter(|active| **active)
            .count()
            .to_string(),
        geometry_decode_budget_bytes: MAX_SAVED_FIELD_GEOMETRY_DECODE_BYTES.to_string(),
        topology_binary_schema: "fullmag.binary.fem_mesh_topology.v2".to_string(),
        support_binary_schema: SAVED_FIELD_SUPPORT_BINARY_SCHEMA.to_string(),
        topology_binary_byte_length: topology_binary
            .as_ref()
            .map(|(length, _)| length.to_string()),
        topology_binary_sha256: topology_binary.map(|(_, hash)| hash),
        support_binary_byte_length: support_binary_byte_length.to_string(),
        support_binary_sha256: support_binary_hash,
    })
}

fn artifact_resource(artifact: &SolutionArtifactRef) -> SavedFieldGeometryArtifactResource {
    SavedFieldGeometryArtifactResource {
        artifact_id: artifact.artifact_id.clone(),
        kind: artifact.kind.into(),
        accepted_state: artifact.accepted_state.as_ref().map(|id| {
            crate::schemas::solutions::SolutionAcceptedStateIdResource {
                run_id: id.run_id.clone(),
                stage_id: id.stage_id.clone(),
                accepted_step: id.accepted_step.to_string(),
                clock_digest: id.clock_digest.clone(),
                state_digest: id.state_digest.clone(),
                domain_digest: id.domain_digest.clone(),
                plan_digest: id.plan_digest.clone(),
            }
        }),
        schema_id: artifact.schema_id.clone(),
        object_ref: artifact.object_ref.clone(),
        byte_length: artifact.byte_length.to_string(),
    }
}

fn saved_geometry_binary_etag_scope(resolved: &ResolvedSavedGeometry) -> String {
    format!(
        "{}:{}:{}:{}:{}:{}:{}",
        resolved.geometry_manifest.source.run_id,
        resolved.geometry_manifest.source.solution_set_id,
        resolved.geometry_manifest.source.solution_revision,
        resolved.geometry_manifest.source.member_id,
        resolved.dataset_artifact.object_ref,
        resolved.geometry_artifact.object_ref,
        resolved.geometry_manifest.geometry.object_ref,
    )
}

fn saved_geometry_binary_etag(scope: &str, kind: &str, body_hash: &str) -> String {
    crate::router_v2::handlers::shared::stable_strong_etag(&format!(
        "saved-fem-geometry:{kind}:{scope}:{body_hash}"
    ))
}

fn pinned_source_resource(
    source: &PinnedSolutionTensorSource,
) -> SavedFieldGeometryPinnedSourceResource {
    SavedFieldGeometryPinnedSourceResource {
        run_id: source.run_id.clone(),
        solution_set_id: source.solution_set_id.clone(),
        solution_revision: source.solution_revision.to_string(),
        member_id: source.member_id.clone(),
        tensor_artifact_id: source.artifact_id.clone(),
        tensor_object_ref: source.tensor_object_ref.clone(),
        run_spec_digest: source.run_spec_digest.clone(),
    }
}

fn validate_binary_request(
    member_id: &str,
    dataset_artifact_id: &str,
    query: &SavedFieldGeometryBinaryQuery,
    max_budget: usize,
) -> Result<(), ApiError> {
    super::validate_lookup_id(member_id, "member")?;
    super::validate_lookup_id(dataset_artifact_id, "dataset artifact")?;
    for (label, value) in [
        (
            "dataset manifest",
            &query.expected_dataset_manifest_object_ref,
        ),
        (
            "geometry manifest",
            &query.expected_geometry_manifest_object_ref,
        ),
        ("geometry", &query.expected_geometry_object_ref),
    ] {
        if !fullmag_quantities::is_canonical_sha256(&format!("sha256:{value}")) {
            return Err(ApiError::bad_request(format!(
                "expected {label} object ref must be a bare lowercase SHA-256 hash",
            )));
        }
    }
    let requested = parse_response_budget(&query.max_response_bytes)?;
    if requested > max_budget {
        return Err(ApiError::bad_request(format!(
            "saved geometry response budget exceeds {max_budget} bytes",
        )));
    }
    Ok(())
}

fn verify_expected_identity(
    resolved: &ResolvedSavedGeometry,
    query: &SavedFieldGeometryBinaryQuery,
) -> Result<(), ApiError> {
    let expected = [
        (
            "dataset manifest",
            query.expected_dataset_manifest_object_ref.as_str(),
            resolved.dataset_artifact.object_ref.as_str(),
        ),
        (
            "geometry manifest",
            query.expected_geometry_manifest_object_ref.as_str(),
            resolved.geometry_artifact.object_ref.as_str(),
        ),
        (
            "geometry",
            query.expected_geometry_object_ref.as_str(),
            resolved.geometry_manifest.geometry.object_ref.as_str(),
        ),
    ];
    for (label, expected, actual) in expected {
        if expected != actual {
            return Err(ApiError::conflict(format!(
                "expected {label} object ref differs from the pinned artifact",
            )));
        }
    }
    Ok(())
}

fn parse_response_budget(value: &str) -> Result<usize, ApiError> {
    let parsed = value
        .parse::<u64>()
        .map_err(|_| ApiError::bad_request("max_response_bytes must be a canonical decimal u64"))?;
    if parsed.to_string() != value || parsed == 0 {
        return Err(ApiError::bad_request(
            "max_response_bytes must be a canonical positive decimal u64",
        ));
    }
    usize::try_from(parsed).map_err(|_| ApiError::bad_request("max_response_bytes is too large"))
}

fn fem_mesh_payload(
    geometry: SavedFemP1FieldGeometry,
    topology_fingerprint: String,
) -> Result<fullmag_runner::FemMeshPayload, ApiError> {
    let mesh = geometry.mesh;
    Ok(fullmag_runner::FemMeshPayload {
        mesh_name: mesh.mesh_name,
        mesh_id: topology_fingerprint,
        nodes: mesh.nodes,
        cells: mesh.cells,
        element_markers: mesh.element_markers,
        facets: mesh.facets,
        boundary_markers: mesh.boundary_markers,
        periodic_boundary_pairs: Vec::new(),
        periodic_node_pairs: Vec::new(),
        object_segments: Vec::new(),
        mesh_parts: Vec::new(),
        domain_mesh_mode: None,
        domain_frame: None,
        generation_id: None,
        per_domain_quality: std::collections::HashMap::new(),
        build_report: None,
    })
}

fn fem_mesh_payload_borrowed(
    geometry: &SavedFemP1FieldGeometry,
    topology_fingerprint: String,
) -> fullmag_runner::FemMeshPayload {
    let mesh = &geometry.mesh;
    fullmag_runner::FemMeshPayload {
        mesh_name: mesh.mesh_name.clone(),
        mesh_id: topology_fingerprint,
        nodes: mesh.nodes.clone(),
        cells: mesh.cells.clone(),
        element_markers: mesh.element_markers.clone(),
        facets: mesh.facets.clone(),
        boundary_markers: mesh.boundary_markers.clone(),
        periodic_boundary_pairs: Vec::new(),
        periodic_node_pairs: Vec::new(),
        object_segments: Vec::new(),
        mesh_parts: Vec::new(),
        domain_mesh_mode: None,
        domain_frame: None,
        generation_id: None,
        per_domain_quality: std::collections::HashMap::new(),
        build_report: None,
    }
}

fn topology_binary_identity(
    geometry: &SavedFemP1FieldGeometry,
) -> Result<Option<(usize, String)>, ApiError> {
    let topology_fingerprint = geometry.mesh.topology_fingerprint_v6();
    let estimated = estimated_fmmt_v2_len_for_geometry(geometry)?;
    if estimated > MAX_BINARY_RESPONSE_BYTES {
        return Ok(None);
    }
    let payload = fem_mesh_payload_borrowed(geometry, topology_fingerprint);
    let body = crate::field_store::serialize_fem_mesh_topology_binary_v2(&payload)
        .map_err(|error| ApiError::internal(format!("saved topology identity failed: {error}")))?;
    if body.len() != estimated {
        return Err(ApiError::internal(
            "saved topology identity length differs from its bounded preflight",
        ));
    }
    Ok(Some((body.len(), sha256_hex(&body))))
}

fn estimated_fmmt_v2_len(mesh: &fullmag_runner::FemMeshPayload) -> Result<usize, ApiError> {
    let sections = [
        (mesh.nodes.len(), 24_usize),
        (mesh.cells.types.len(), 4),
        (mesh.cells.offsets.len(), 4),
        (mesh.cells.nodes.len(), 4),
        (mesh.facets.types.len(), 4),
        (mesh.facets.roles.len(), 4),
        (mesh.facets.offsets.len(), 4),
        (mesh.facets.nodes.len(), 4),
        (mesh.element_markers.len(), 4),
        (mesh.boundary_markers.len(), 4),
    ];
    estimated_fmmt_v2_len_from_sections(
        &sections,
        mesh.cells.global_ordinals.len(),
        mesh.facets.global_ordinals.len(),
    )
}

fn estimated_fmmt_v2_len_for_geometry(
    geometry: &SavedFemP1FieldGeometry,
) -> Result<usize, ApiError> {
    let mesh = &geometry.mesh;
    let sections = [
        (mesh.nodes.len(), 24_usize),
        (mesh.cells.types.len(), 4),
        (mesh.cells.offsets.len(), 4),
        (mesh.cells.nodes.len(), 4),
        (mesh.facets.types.len(), 4),
        (mesh.facets.roles.len(), 4),
        (mesh.facets.offsets.len(), 4),
        (mesh.facets.nodes.len(), 4),
        (mesh.element_markers.len(), 4),
        (mesh.boundary_markers.len(), 4),
    ];
    estimated_fmmt_v2_len_from_sections(
        &sections,
        mesh.cells.global_ordinals.len(),
        mesh.facets.global_ordinals.len(),
    )
}

fn estimated_fmmt_v2_len_from_sections(
    sections: &[(usize, usize)],
    cell_global_ordinal_count: usize,
    facet_global_ordinal_count: usize,
) -> Result<usize, ApiError> {
    let mut total = FMMT_V2_HEADER_LEN;
    for &(count, width) in sections {
        total = align_eight(total)
            .checked_add(count.checked_mul(width).ok_or_else(|| {
                ApiError::unprocessable("SAVED_GEOMETRY_TOPOLOGY_BYTE_LIMIT: length overflow")
            })?)
            .ok_or_else(|| {
                ApiError::unprocessable("SAVED_GEOMETRY_TOPOLOGY_BYTE_LIMIT: length overflow")
            })?;
    }
    for (count, width) in [
        (cell_global_ordinal_count, 8_usize),
        (facet_global_ordinal_count, 8_usize),
    ] {
        if count != 0 {
            total = align_eight(total)
                .checked_add(count.checked_mul(width).ok_or_else(|| {
                    ApiError::unprocessable("SAVED_GEOMETRY_TOPOLOGY_BYTE_LIMIT: length overflow")
                })?)
                .ok_or_else(|| {
                    ApiError::unprocessable("SAVED_GEOMETRY_TOPOLOGY_BYTE_LIMIT: length overflow")
                })?;
        }
    }
    Ok(total)
}

fn align_eight(value: usize) -> usize {
    value.saturating_add(7) & !7
}

fn support_body_len(node_count: usize) -> Result<usize, ApiError> {
    let packed = node_count.checked_add(7).ok_or_else(|| {
        ApiError::unprocessable("SAVED_GEOMETRY_SUPPORT_BYTE_LIMIT: length overflow")
    })? / 8;
    FMSP_HEADER_LEN.checked_add(packed).ok_or_else(|| {
        ApiError::unprocessable("SAVED_GEOMETRY_SUPPORT_BYTE_LIMIT: length overflow")
    })
}

fn encode_saved_support(mask: &[bool]) -> Result<Vec<u8>, ApiError> {
    if mask.is_empty() {
        return Err(ApiError::unprocessable(
            "SAVED_GEOMETRY_SUPPORT_INVALID: active-node support is empty",
        ));
    }
    let body_len = support_body_len(mask.len())?;
    if body_len > MAX_SAVED_FIELD_SUPPORT_BINARY_BYTES as usize {
        return Err(ApiError::unprocessable(format!(
            "SAVED_GEOMETRY_SUPPORT_BYTE_LIMIT: FMSP body requires {body_len} bytes"
        )));
    }
    let packed_len = body_len - FMSP_HEADER_LEN;
    let node_count = u64::try_from(mask.len()).map_err(|_| {
        ApiError::unprocessable("SAVED_GEOMETRY_SUPPORT_INVALID: node count overflow")
    })?;
    let payload_len = u64::try_from(packed_len).map_err(|_| {
        ApiError::unprocessable("SAVED_GEOMETRY_SUPPORT_INVALID: byte count overflow")
    })?;
    let mut body = Vec::with_capacity(body_len);
    body.extend_from_slice(b"FMSP");
    body.extend_from_slice(&FMSP_VERSION.to_le_bytes());
    body.extend_from_slice(&FMSP_FLAGS.to_le_bytes());
    body.extend_from_slice(&node_count.to_le_bytes());
    body.extend_from_slice(&payload_len.to_le_bytes());
    body.resize(body_len, 0);
    for (index, active) in mask.iter().copied().enumerate() {
        if active {
            body[FMSP_HEADER_LEN + index / 8] |= 1 << (index % 8);
        }
    }
    Ok(body)
}

fn support_binary_identity(mask: &[bool]) -> Result<(Vec<u8>, String), ApiError> {
    let body = encode_saved_support(mask)?;
    let hash = sha256_hex(&body);
    Ok((body, hash))
}

fn sha256_hex(bytes: &[u8]) -> String {
    format!("{:x}", Sha256::digest(bytes))
}

#[cfg(test)]
#[path = "saved_geometry_tests.rs"]
mod tests;
