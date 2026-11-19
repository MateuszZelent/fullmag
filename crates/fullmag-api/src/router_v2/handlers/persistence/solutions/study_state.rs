//! Project-owned playback of accepted final magnetization with its exact domain.

use std::sync::Arc;

use axum::{
    extract::{Path, Query, State},
    http::{HeaderMap, HeaderValue, StatusCode},
    response::{IntoResponse, Response},
    Json,
};
use fullmag_application::{DecodedStudyArtifact, ProjectId, RunId};
use fullmag_ir::BackendPlanIR;
use fullmag_session::SessionStore;

use crate::{
    error::ApiError,
    field_store::{
        serialize_fem_mesh_topology_binary_v2, serialize_field_vector_binary_v3,
        FieldVectorBinaryMetadata, FieldVectorIndexing,
    },
    live_accepted_continuation::find_published_final_state,
    router_v2::handlers::data::{
        fields::mesh_topology_hash_bytes,
        resolved_spatial_field::multilayer_native_carrier_fingerprint,
    },
    router_v2::handlers::shared::{conditional_binary_response, stable_strong_etag},
    schemas::scalars::HistoricalScalarWindow,
    schemas::stage_results::{
        StudyResultGeometry, StudyResultLayerGeometry, StudyResultStateResource,
        StudyStageResultsQuery, StudyStageResultsResource,
    },
    types::AppState,
};

const MAX_RESULT_BYTES: u64 = fullmag_runtime_control::MAX_ACCEPTED_MODEL_DOCUMENT_BYTES;

struct ResultState {
    resource: StudyResultStateResource,
    magnetization: Vec<[f64; 3]>,
    binary_grid: [u32; 3],
    mesh: Option<fullmag_runner::FemMeshPayload>,
    support: Option<Vec<bool>>,
}

fn load_result_state(
    store: &SessionStore,
    project_id: &str,
    run_id: &str,
    artifact_id: &str,
) -> Result<ResultState, ApiError> {
    let result = find_published_final_state(store, run_id, artifact_id)
        .map_err(|error| ApiError::conflict_with_code("study_result_binding_invalid", error))?
        .ok_or_else(|| ApiError::not_found("published Study final state was not found"))?;
    let bytes = store
        .cas()
        .get_bounded(&result.output.object_ref, MAX_RESULT_BYTES)
        .map_err(|error| ApiError::conflict(format!("read published Study state: {error}")))?
        .ok_or_else(|| ApiError::not_found("published Study state object is missing"))?;
    let decoded = fullmag_application::decode_study_artifact_bytes(
        &result.output.data_kind,
        &result.output.codec_id,
        &result.output.codec_version,
        &bytes,
    )
    .map_err(|error| ApiError::unprocessable(format!("unsupported Study state: {error}")))?;
    let DecodedStudyArtifact::MagnetizationState(magnetization) = decoded else {
        return Err(ApiError::unprocessable(
            "Study result is not a magnetization state",
        ));
    };

    let typed_run = RunId::parse(run_id.to_owned())
        .map_err(|error| ApiError::bad_request(error.to_string()))?;
    let project = ProjectId::parse(project_id.to_owned())
        .map_err(|error| ApiError::bad_request(error.to_string()))?;
    let accepted =
        fullmag_runtime_control::load_accepted_study_snapshot(store, &typed_run, &project)
            .map_err(|error| {
                ApiError::conflict(format!("validate accepted Study domain: {error:#}"))
            })?;
    let execution_plan = accepted
        .lowered
        .steps
        .iter()
        .find(|step| step.step_id == result.identity.step_id)
        .and_then(|step| step.execution_plan.as_ref())
        .ok_or_else(|| ApiError::conflict("accepted Study result has no pinned execution plan"))?;
    let receipt = accepted
        .read_task_preparation_receipt(store, &result.identity.task_id)
        .map_err(|error| {
            ApiError::conflict(format!("validate accepted Study preparation: {error:#}"))
        })?;
    crate::live_accepted_projection::validate_accepted_state_domain(
        &magnetization,
        execution_plan,
        &receipt.plan_fingerprint,
        run_id,
        &result.identity.step_id,
        result.accepted_state_ref.as_ref(),
    )?;
    let expected_layout = fullmag_runner::study_magnetization_layout_for_plan(execution_plan)
        .map_err(|error| ApiError::unprocessable(error.message))?;
    if magnetization.layout != expected_layout {
        return Err(ApiError::conflict(
            "saved magnetization layout differs from its pinned plan",
        ));
    }

    let sample_count = magnetization.values.len() as u64;
    let packed_grid = || {
        u32::try_from(sample_count)
            .map(|count| [count, 1, 1])
            .map_err(|_| ApiError::unprocessable("Study result exceeds binary index capacity"))
    };
    let mut mesh = None;
    let (geometry, binary_grid, topology_fingerprint, support) = match &execution_plan.backend_plan
    {
        BackendPlanIR::Fdm(plan) => {
            let fingerprint = plan
                .grid_certificate
                .as_ref()
                .map(|certificate| certificate.grid_fingerprint.clone())
                .unwrap_or_else(|| magnetization.space_fingerprint.clone());
            (
                StudyResultGeometry::Fdm {
                    grid_cells: plan.grid.cells,
                    origin_m: plan.origin_m,
                    cell_size_m: plan.cell_size,
                },
                plan.grid.cells,
                fingerprint,
                plan.active_mask.as_ref().map(|mask| mask.to_vec()),
            )
        }
        BackendPlanIR::FdmMultilayer(plan) => {
            let (fingerprint, layout_count) =
                multilayer_native_carrier_fingerprint(&expected_layout).ok_or_else(|| {
                    ApiError::conflict("accepted multilayer Study has no exact native layout")
                })?;
            if layout_count != sample_count {
                return Err(ApiError::conflict(
                    "accepted multilayer sample count differs from its native layout",
                ));
            }
            let mut value_offset = 0;
            let mut layers = Vec::with_capacity(plan.layers.len());
            let mut active = plan
                .layers
                .iter()
                .any(|layer| layer.native_active_mask.is_some())
                .then(|| Vec::with_capacity(magnetization.values.len()));
            for layer in &plan.layers {
                let count = layer.initial_magnetization.len();
                if let Some(mask) = active.as_mut() {
                    if let Some(native) = layer.native_active_mask.as_ref() {
                        if native.len() != count {
                            return Err(ApiError::conflict(
                                "native layer support differs from its sample count",
                            ));
                        }
                        mask.extend_from_slice(native);
                    } else {
                        mask.extend(std::iter::repeat_n(true, count));
                    }
                }
                layers.push(StudyResultLayerGeometry {
                    layer_id: layer.layer_id.clone(),
                    object_id: layer.object_id.clone(),
                    grid_cells: layer.native_grid,
                    origin_m: layer.native_origin,
                    cell_size_m: layer.native_cell_size,
                    value_offset,
                    value_count: count as u64,
                });
                value_offset += count as u64;
            }
            if value_offset != sample_count {
                return Err(ApiError::conflict(
                    "native layer offsets differ from the accepted vector",
                ));
            }
            (
                StudyResultGeometry::FdmMultilayer { layers },
                packed_grid()?,
                fingerprint,
                active,
            )
        }
        BackendPlanIR::Fem(plan) => {
            let geometry = StudyResultGeometry::Fem {
                node_count: plan.mesh.nodes.len() as u64,
                element_count: plan.mesh.cell_count() as u64,
            };
            mesh = Some(fullmag_runner::FemMeshPayload::from(plan));
            let semantics =
                fullmag_application::decode_magnetization_field_semantics(&magnetization).map_err(
                    |error| ApiError::conflict(format!("invalid historical FEM support: {error}")),
                )?;
            (
                geometry,
                packed_grid()?,
                plan.mesh.topology_fingerprint_v6(),
                semantics.map(|semantics| semantics.active_node_mask),
            )
        }
        _ => {
            return Err(ApiError::unprocessable(
                "Study result geometry is not supported",
            ))
        }
    };
    let binary_count = binary_grid
        .into_iter()
        .try_fold(1u64, |count, extent| count.checked_mul(u64::from(extent)));
    if binary_count != Some(sample_count)
        || support
            .as_ref()
            .is_some_and(|mask| mask.len() != magnetization.values.len())
    {
        return Err(ApiError::conflict(
            "Study result geometry or support differs from its sample count",
        ));
    }
    let topology_fingerprint = topology_fingerprint
        .strip_prefix("sha256:")
        .map_or(topology_fingerprint.as_str(), |digest| digest);
    if !topology_fingerprint
        .bytes()
        .all(|byte| matches!(byte, b'0'..=b'9' | b'a'..=b'f'))
        || topology_fingerprint.len() != 64
    {
        return Err(ApiError::conflict(
            "Study result topology fingerprint is invalid",
        ));
    }
    Ok(ResultState {
        resource: StudyResultStateResource {
            project_id: project_id.to_owned(),
            source: result.identity,
            artifact_id: result.output.artifact_id,
            artifact_sha256: result.output.content_sha256,
            step: magnetization.step,
            time_s: magnetization.time_s,
            sample_count,
            domain_generation_id: magnetization.space_fingerprint,
            topology_fingerprint: format!("sha256:{topology_fingerprint}"),
            geometry,
            support_available: support.is_some(),
        },
        magnetization: magnetization.values,
        binary_grid,
        mesh,
        support,
    })
}

async fn with_result<T: Send + 'static>(
    state: Arc<AppState>,
    project_id: String,
    run_id: String,
    artifact_id: String,
    render: impl FnOnce(ResultState) -> Result<T, ApiError> + Send + 'static,
) -> Result<T, ApiError> {
    super::validate_lookup_id(&artifact_id, "Study result artifact")?;
    super::with_verified_run_value(
        state,
        project_id.clone(),
        run_id.clone(),
        move |store, _| {
            render(load_result_state(
                store,
                &project_id,
                &run_id,
                &artifact_id,
            )?)
        },
    )
    .await
}

#[utoipa::path(get,
    path = "/v2/persistence/projects/{project_id}/runs/{run_id}/study-results",
    params(("project_id" = String, Path), ("run_id" = String, Path), StudyStageResultsQuery),
    responses((status = 200, description = "Published final states for the selected durable run", body = StudyStageResultsResource),
        (status = 400, description = "Invalid filter or page"), (status = 404, description = "Unknown run"),
        (status = 409, description = "Run or result ownership differs")),
    tag = "persistence")]
pub async fn list_project_study_results(
    State(state): State<Arc<AppState>>,
    Path((project_id, run_id)): Path<(String, String)>,
    Query(query): Query<StudyStageResultsQuery>,
) -> Result<Json<StudyStageResultsResource>, ApiError> {
    super::with_verified_run(
        state,
        project_id.clone(),
        run_id.clone(),
        move |store, _| {
            crate::router_v2::handlers::data::stage_results::load_project_study_results(
                store,
                &project_id,
                &run_id,
                query,
            )
        },
    )
    .await
}

#[utoipa::path(get,
    path = "/v2/persistence/projects/{project_id}/runs/{run_id}/study-results/{artifact_id}",
    params(("project_id" = String, Path), ("run_id" = String, Path), ("artifact_id" = String, Path)),
    responses((status = 200, description = "Immutable Study state with its exact spatial carrier", body = StudyResultStateResource),
        (status = 404, description = "Unknown result"), (status = 409, description = "Inconsistent project, run or carrier binding")),
    tag = "persistence")]
pub async fn get_study_result_state(
    State(state): State<Arc<AppState>>,
    Path((project_id, run_id, artifact_id)): Path<(String, String, String)>,
) -> Result<Json<StudyResultStateResource>, ApiError> {
    with_result(state, project_id, run_id, artifact_id, |result| {
        Ok(Json(result.resource))
    })
    .await
}

#[utoipa::path(get,
    path = "/v2/persistence/projects/{project_id}/runs/{run_id}/study-results/{artifact_id}/magnetization",
    params(("project_id" = String, Path), ("run_id" = String, Path), ("artifact_id" = String, Path),
        ("If-None-Match" = Option<String>, Header, description = "Strong ETag from a previous response for this saved result")),
    responses((status = 200, description = "FMVP v3 magnetization bound to the saved result and its exact domain", content_type = "application/octet-stream", headers(
            ("ETag" = String, description = "Strong ETag for this saved result payload"),
            ("x-fullmag-source-id" = String, description = "Saved Study result artifact ID"),
            ("x-fullmag-field-generation-id" = String, description = "Saved result artifact SHA-256"),
            ("x-fullmag-domain-generation-id" = String, description = "Exact saved sample layout fingerprint"),
            ("x-fullmag-mesh-topology-hash" = String, description = "Exact saved topology fingerprint"),
            ("x-fullmag-encoding" = String, description = "FMVP;version=3")
        )),
        (status = 304, description = "Unchanged immutable magnetization"), (status = 404, description = "Unknown result")),
    tag = "persistence")]
pub async fn get_study_result_magnetization(
    State(state): State<Arc<AppState>>,
    Path((project_id, run_id, artifact_id)): Path<(String, String, String)>,
    headers: HeaderMap,
) -> Result<Response, ApiError> {
    let (resource, bytes) = with_result(state, project_id, run_id, artifact_id, |result| {
        let resource = result.resource;
        if resource.sample_count > MAX_RESULT_BYTES / 24 {
            return Err(ApiError::unprocessable(
                "Study result exceeds the binary response budget",
            ));
        }
        let hash = mesh_topology_hash_bytes(&resource.topology_fingerprint)?;
        let metadata = FieldVectorBinaryMetadata {
            domain_generation_id: &resource.domain_generation_id,
            mesh_topology_revision: 1,
            mesh_topology_hash: hash,
            scope_kind: "full",
            scope_id: "",
            indexing: FieldVectorIndexing::FullDomain,
            node_indices: &[],
        };
        let values = result
            .magnetization
            .into_iter()
            .flatten()
            .collect::<Vec<_>>();
        let body = serialize_field_vector_binary_v3("m", 3, result.binary_grid, &values, &metadata)
            .map_err(ApiError::internal)?;
        Ok((resource, body))
    })
    .await?;
    let mut response = binary_response(&headers, &resource, "magnetization-fmvp-v3", bytes)?;
    response.headers_mut().insert(
        "x-fullmag-encoding",
        HeaderValue::from_static("FMVP;version=3"),
    );
    Ok(response)
}

#[utoipa::path(get,
    path = "/v2/persistence/projects/{project_id}/runs/{run_id}/study-results/{artifact_id}/topology",
    params(("project_id" = String, Path), ("run_id" = String, Path), ("artifact_id" = String, Path),
        ("If-None-Match" = Option<String>, Header, description = "Strong ETag from a previous response for this saved result")),
    responses((status = 200, description = "FMMT v2 topology of the saved FEM state", content_type = "application/octet-stream", headers(
            ("ETag" = String, description = "Strong ETag for this saved result payload"),
            ("x-fullmag-source-id" = String, description = "Saved Study result artifact ID"),
            ("x-fullmag-field-generation-id" = String, description = "Saved result artifact SHA-256"),
            ("x-fullmag-domain-generation-id" = String, description = "Exact saved sample layout fingerprint"),
            ("x-fullmag-mesh-topology-hash" = String, description = "Exact saved topology fingerprint")
        )),
        (status = 304, description = "Unchanged immutable topology"), (status = 404, description = "FEM topology is unavailable")),
    tag = "persistence")]
pub async fn get_study_result_topology(
    State(state): State<Arc<AppState>>,
    Path((project_id, run_id, artifact_id)): Path<(String, String, String)>,
    headers: HeaderMap,
) -> Result<Response, ApiError> {
    let (resource, bytes) = with_result(state, project_id, run_id, artifact_id, |result| {
        let mesh = result
            .mesh
            .ok_or_else(|| ApiError::not_found("Study result has no FEM topology"))?;
        let estimated = super::saved_geometry::estimated_fmmt_v2_len(&mesh)?;
        if estimated as u64 > MAX_RESULT_BYTES {
            return Err(ApiError::unprocessable(
                "Study topology exceeds the binary response budget",
            ));
        }
        let body = serialize_fem_mesh_topology_binary_v2(&mesh).map_err(ApiError::internal)?;
        Ok((result.resource, body))
    })
    .await?;
    binary_response(&headers, &resource, "topology-fmmt-v2", bytes)
}

#[utoipa::path(get,
    path = "/v2/persistence/projects/{project_id}/runs/{run_id}/study-results/{artifact_id}/support",
    params(("project_id" = String, Path), ("run_id" = String, Path), ("artifact_id" = String, Path),
        ("If-None-Match" = Option<String>, Header, description = "Strong ETag from a previous response for this saved result")),
    responses((status = 200, description = "FMSP support mask in exact saved sample order", content_type = "application/octet-stream", headers(
            ("ETag" = String, description = "Strong ETag for this saved result payload"),
            ("x-fullmag-source-id" = String, description = "Saved Study result artifact ID"),
            ("x-fullmag-field-generation-id" = String, description = "Saved result artifact SHA-256"),
            ("x-fullmag-domain-generation-id" = String, description = "Exact saved sample layout fingerprint"),
            ("x-fullmag-mesh-topology-hash" = String, description = "Exact saved topology fingerprint")
        )),
        (status = 204, description = "No explicit support mask"), (status = 304, description = "Unchanged immutable mask")),
    tag = "persistence")]
pub async fn get_study_result_support(
    State(state): State<Arc<AppState>>,
    Path((project_id, run_id, artifact_id)): Path<(String, String, String)>,
    headers: HeaderMap,
) -> Result<Response, ApiError> {
    let (resource, bytes) = with_result(state, project_id, run_id, artifact_id, |result| {
        let bytes = result
            .support
            .as_deref()
            .map(super::saved_geometry::encode_saved_support)
            .transpose()?;
        Ok((result.resource, bytes))
    })
    .await?;
    match bytes {
        Some(bytes) => binary_response(&headers, &resource, "support-fmsp", bytes),
        None => Ok(StatusCode::NO_CONTENT.into_response()),
    }
}

#[derive(serde::Deserialize, utoipa::IntoParams)]
#[into_params(parameter_in = Query)]
pub struct StudyResultScalarsQuery {
    pub columns: Option<String>,
    pub start: Option<u64>,
    pub limit: Option<u64>,
}

#[utoipa::path(get,
    path = "/v2/persistence/projects/{project_id}/runs/{run_id}/study-results/{artifact_id}/scalars",
    params(("project_id" = String, Path), ("run_id" = String, Path), ("artifact_id" = String, Path), StudyResultScalarsQuery),
    responses((status = 200, description = "Immutable scalar series owned by this saved Study state", body = HistoricalScalarWindow),
        (status = 400, description = "Invalid row limit"), (status = 404, description = "Qualified archived scalars unavailable")),
    tag = "persistence")]
pub async fn get_study_result_scalars(
    State(state): State<Arc<AppState>>,
    Path((project_id, run_id, artifact_id)): Path<(String, String, String)>,
    Query(query): Query<StudyResultScalarsQuery>,
) -> Result<Json<HistoricalScalarWindow>, ApiError> {
    super::validate_lookup_id(&artifact_id, "Study result artifact")?;
    super::with_verified_run(state, project_id, run_id.clone(), move |store, _| {
        let binding = find_published_final_state(store, &run_id, &artifact_id)
            .map_err(|error| ApiError::conflict_with_code("study_result_binding_invalid", error))?
            .ok_or_else(|| ApiError::not_found("published Study final state was not found"))?;
        crate::router_v2::handlers::data::scalars::read_bound_historical_scalars(
            store,
            binding,
            query.start,
            query.limit,
            query.columns.as_deref(),
        )
    })
    .await
}

fn binary_response(
    headers: &HeaderMap,
    resource: &StudyResultStateResource,
    kind: &str,
    body: Vec<u8>,
) -> Result<Response, ApiError> {
    let etag = stable_strong_etag(&format!(
        "{}:{}:{}:{}:{kind}",
        resource.project_id,
        resource.source.run_id,
        resource.artifact_sha256,
        resource.topology_fingerprint,
    ));
    let mut response = conditional_binary_response(headers, &etag, body);
    for (name, value) in [
        ("x-fullmag-source-id", resource.artifact_id.as_str()),
        (
            "x-fullmag-field-generation-id",
            resource.artifact_sha256.as_str(),
        ),
        (
            "x-fullmag-domain-generation-id",
            resource.domain_generation_id.as_str(),
        ),
        (
            "x-fullmag-mesh-topology-hash",
            resource.topology_fingerprint.as_str(),
        ),
    ] {
        response.headers_mut().insert(
            name,
            HeaderValue::from_str(value)
                .map_err(|_| ApiError::internal("invalid saved Study source header"))?,
        );
    }
    Ok(response)
}
