//! Run-scoped, backend-neutral result dataset resources.
//!
//! This module is an adapter over immutable, product-specific artifacts.  It
//! deliberately keeps large arrays in their native data plane and exposes
//! only bounded identity, coordinates, summaries, and resource links.

use std::{
    collections::{BTreeMap, HashMap},
    path::Path,
    sync::Arc,
};

use axum::{extract::{Path as AxumPath, Query, State}, Json};
use base64::Engine;
use serde::{Deserialize, Serialize};
use serde_json::Value;
use sha2::{Digest, Sha256};
use utoipa::{IntoParams, ToSchema};

use crate::artifacts::{
    read_json_artifact_value, require_current_live_artifact_dir, try_resolve_artifact_path,
};
use crate::error::ApiError;
use crate::router_v2::handlers::analysis::frequency_domain::{
    decode_frequency_domain_artifact_payload, FrequencyDomainJsonArtifactPayload,
    FrequencyDomainFieldSweepArtifactPayload, FrequencyDomainFieldSweepModePayload,
    FrequencyDomainFieldSweepTopologyPayload,
    FrequencyDomainResponsePointPayload,
    FrequencyDomainResponseSweepArtifactPayload, FrequencyDomainSpectrumArtifactPayload,
    FrequencyDomainSpectrumModePayload, FrequencyDomainSpectrumV3ArtifactPayload,
    FrequencyDomainSpectrumV3ModePayload,
};
use crate::router_v2::handlers::analysis::spin_wave_response::{
    DynamicStructureFactorResource, SpinWaveGammaResource, SpinWavePeakResource,
};
use crate::types::AppState;

pub const ANALYSIS_RESULT_INDEX_SCHEMA_VERSION: &str =
    "fullmag.analysis.result_dataset_index.v1";
const DEFAULT_PAGE_LIMIT: usize = 100;
const MAX_PAGE_LIMIT: usize = 500;
const MAX_INLINE_AXIS_VALUES: usize = 256;
const MAX_PROJECTION_POINTS: usize = 10_000;

#[derive(Debug, Clone, Serialize, Deserialize, ToSchema)]
#[serde(rename_all = "snake_case")]
pub enum AnalysisResultProductKind {
    ModalEigen,
    DrivenResponse,
    TimeDomainSpectrum,
    DynamicStructureFactor,
}

#[derive(Debug, Clone, Serialize, Deserialize, ToSchema)]
#[serde(rename_all = "snake_case")]
pub enum AnalysisResultItemKind {
    EigenMode,
    DrivenFrequencyPoint,
    SpectralFeature,
    DsfPoint,
}

#[derive(Debug, Clone, Serialize, Deserialize, ToSchema)]
pub struct AnalysisResultSourceArtifactRef {
    pub artifact: String,
    pub revision: String,
    pub relation: String,
}

#[derive(Debug, Clone, Serialize, Deserialize, ToSchema)]
pub struct AnalysisResultAxisProjection {
    pub projection_id: String,
    pub label: String,
    pub unit: String,
    pub operation: String,
}

#[derive(Debug, Clone, Serialize, Deserialize, ToSchema)]
pub struct AnalysisResultAxisValueResource {
    pub token: String,
    pub scalar_si: Option<f64>,
    pub vector3_si: Option<[f64; 3]>,
    pub category: Option<String>,
    pub entity_ref: Option<String>,
    pub label: Option<String>,
    pub status: String,
}

#[derive(Debug, Clone, Serialize, Deserialize, ToSchema)]
pub struct AnalysisResultAxisResource {
    pub axis_id: String,
    pub role: String,
    pub value_kind: String,
    pub semantic_id: String,
    pub label: String,
    pub symbol: Option<String>,
    pub unit_si: Option<String>,
    pub preferred_display_units: Vec<String>,
    pub ordering: String,
    pub cardinality: u64,
    pub values_resource_key: Option<String>,
    pub inline_values: Option<Vec<AnalysisResultAxisValueResource>>,
    pub projections: Vec<AnalysisResultAxisProjection>,
}

#[derive(Debug, Clone, Serialize, Deserialize, ToSchema)]
pub struct AnalysisResultCoordinateResource {
    pub axis_id: String,
    pub token: String,
    pub scalar_si: Option<f64>,
    pub vector3_si: Option<[f64; 3]>,
    pub category: Option<String>,
    pub entity_ref: Option<String>,
    pub label: Option<String>,
}

#[derive(Debug, Clone, Serialize, Deserialize, ToSchema)]
pub struct AnalysisResultMeshRef {
    pub mesh_id: String,
    pub mesh_revision: Option<String>,
    pub topology_fingerprint: Option<String>,
}

#[derive(Debug, Clone, Serialize, Deserialize, ToSchema)]
pub struct AnalysisResultStatusFacets {
    pub resource: String,
    pub execution: String,
    pub completeness: String,
    pub qualification: String,
    pub reason_code: Option<String>,
    pub detail: Option<String>,
}

#[derive(Debug, Clone, Serialize, Deserialize, ToSchema)]
pub struct AnalysisResultDatasetCapabilities {
    pub sample_paging: bool,
    pub item_paging: bool,
    pub server_filtering: bool,
    pub server_sorting: bool,
    pub branch_tracking: bool,
    pub fields: bool,
    pub result_meshes: bool,
    pub comparison: bool,
    pub export: bool,
    pub live_partial_results: bool,
}

#[derive(Debug, Clone, Serialize, Deserialize, ToSchema)]
pub struct AnalysisResultProjectionDescriptor {
    pub projection_id: String,
    pub kind: String,
    pub title: String,
    pub resource_key: String,
    pub x_axis_id: Option<String>,
    pub y_axis_id: Option<String>,
    pub selectable: bool,
}

#[derive(Debug, Clone, Serialize, Deserialize, ToSchema)]
pub struct AnalysisResultDefaultCursor {
    pub sample_id: Option<String>,
    pub item_id: Option<String>,
}

#[derive(Debug, Clone, Serialize, Deserialize, ToSchema)]
pub struct AnalysisResultDatasetSummaryResource {
    pub dataset_id: String,
    pub dataset_revision: String,
    pub run_id: String,
    pub stage_id: String,
    pub product_kind: AnalysisResultProductKind,
    pub title: String,
    pub status: AnalysisResultStatusFacets,
    pub sample_count: u64,
    pub item_count: u64,
    pub manifest_resource_key: String,
}

#[derive(Debug, Clone, Serialize, Deserialize, ToSchema)]
pub struct AnalysisResultDatasetCatalogResource {
    pub schema_version: String,
    pub run_id: String,
    pub revision: String,
    pub status: String,
    pub items: Vec<AnalysisResultDatasetSummaryResource>,
    pub next_cursor: Option<String>,
    pub total_count: u64,
    pub unsupported_reason: Option<String>,
}

#[derive(Debug, Clone, Serialize, Deserialize, ToSchema)]
pub struct AnalysisResultDatasetManifestResource {
    pub schema_version: String,
    pub dataset_id: String,
    pub dataset_revision: String,
    pub run_id: String,
    pub stage_id: String,
    pub product_kind: AnalysisResultProductKind,
    pub title: String,
    pub description: Option<String>,
    pub status: AnalysisResultStatusFacets,
    pub source_artifacts: Vec<AnalysisResultSourceArtifactRef>,
    pub axes: Vec<AnalysisResultAxisResource>,
    pub item_kinds: Vec<AnalysisResultItemKind>,
    pub projections: Vec<AnalysisResultProjectionDescriptor>,
    pub capabilities: AnalysisResultDatasetCapabilities,
    pub default_cursor: AnalysisResultDefaultCursor,
    pub topology_policy: String,
    pub units_policy: String,
    pub provenance: BTreeMap<String, String>,
    pub sample_index_resource: String,
    pub item_index_resource: String,
}

#[derive(Debug, Clone, Serialize, Deserialize, ToSchema)]
pub struct AnalysisResultSampleIndexEntry {
    pub sample_id: String,
    pub sample_index: Option<u64>,
    pub coordinates: Vec<AnalysisResultCoordinateResource>,
    pub status: AnalysisResultStatusFacets,
    pub item_count: u64,
    pub branch_count: Option<u64>,
    pub source_revision: String,
    pub equilibrium_ref: Option<AnalysisResultSourceArtifactRef>,
    pub linearization_ref: Option<AnalysisResultSourceArtifactRef>,
    pub mesh_ref: Option<AnalysisResultMeshRef>,
    pub items_resource: String,
}

#[derive(Debug, Clone, Serialize, Deserialize, ToSchema)]
pub struct AnalysisResultFieldRef {
    pub field_id: String,
    pub field_revision: String,
    pub resource_key: String,
    pub status: String,
    pub quantity_id: Option<String>,
    pub representation: Option<String>,
    pub mesh_ref: Option<AnalysisResultMeshRef>,
}

#[derive(Debug, Clone, Serialize, Deserialize, ToSchema)]
pub struct AnalysisResultQualitySummary {
    pub residual_relative_l2: Option<f64>,
    pub tracking_score: Option<f64>,
    pub qualification: String,
}

#[derive(Debug, Clone, Serialize, Deserialize, ToSchema)]
pub struct AnalysisResultItemRelation {
    pub relation: String,
    pub target_dataset_id: Option<String>,
    pub target_sample_id: Option<String>,
    pub target_item_id: Option<String>,
    pub method: Option<String>,
    pub score: Option<f64>,
    pub frequency_delta_hz: Option<f64>,
    pub source_revision: String,
    pub target_revision: Option<String>,
    pub qualification: String,
}

#[derive(Debug, Clone, Serialize, Deserialize, ToSchema)]
pub struct AnalysisResultSpectralItemSummary {
    pub item_id: String,
    pub item_kind: AnalysisResultItemKind,
    pub sample_id: String,
    pub display_index: Option<u64>,
    pub frequency_hz: Option<f64>,
    pub wavevector_kf: Option<[f64; 3]>,
    pub branch_id: Option<String>,
    pub status: AnalysisResultStatusFacets,
    pub quality: AnalysisResultQualitySummary,
    pub field_ref: Option<AnalysisResultFieldRef>,
    pub detail_resource: String,
    pub source_revision: String,
    pub relations: Vec<AnalysisResultItemRelation>,
}

#[derive(Debug, Clone, Serialize, Deserialize, ToSchema)]
pub struct AnalysisResultSamplePageResource {
    pub schema_version: String,
    pub run_id: String,
    pub dataset_id: String,
    pub dataset_revision: String,
    pub cursor: Option<String>,
    pub next_cursor: Option<String>,
    pub limit: usize,
    pub total_count: u64,
    pub items: Vec<AnalysisResultSampleIndexEntry>,
}

#[derive(Debug, Clone, Serialize, Deserialize, ToSchema)]
pub struct AnalysisResultItemPageResource {
    pub schema_version: String,
    pub run_id: String,
    pub dataset_id: String,
    pub dataset_revision: String,
    pub cursor: Option<String>,
    pub next_cursor: Option<String>,
    pub limit: usize,
    pub total_count: u64,
    pub items: Vec<AnalysisResultSpectralItemSummary>,
}

#[derive(Debug, Clone, Serialize, Deserialize, ToSchema)]
pub struct AnalysisResultBranchPointResource {
    pub branch_id: String,
    pub sample_id: String,
    pub item_id: String,
    pub sample_index: Option<u64>,
    pub raw_mode_index: Option<u64>,
    pub frequency_hz: Option<f64>,
    pub status: AnalysisResultStatusFacets,
    pub source_revision: String,
}

#[derive(Debug, Clone, Serialize, Deserialize, ToSchema)]
pub struct AnalysisResultBranchSummaryResource {
    pub branch_id: String,
    pub label: String,
    pub point_count: u64,
    pub status: AnalysisResultStatusFacets,
    pub source_revision: String,
    pub points_resource: String,
}

#[derive(Debug, Clone, Serialize, Deserialize, ToSchema)]
pub struct AnalysisResultBranchPageResource {
    pub schema_version: String,
    pub run_id: String,
    pub dataset_id: String,
    pub dataset_revision: String,
    pub cursor: Option<String>,
    pub next_cursor: Option<String>,
    pub limit: usize,
    pub total_count: u64,
    pub items: Vec<AnalysisResultBranchSummaryResource>,
    pub unsupported_reason: Option<String>,
}

#[derive(Debug, Clone, Serialize, Deserialize, ToSchema)]
pub struct AnalysisResultBranchResource {
    pub schema_version: String,
    pub run_id: String,
    pub dataset_id: String,
    pub dataset_revision: String,
    pub branch_id: String,
    pub label: String,
    pub point_count: u64,
    pub status: AnalysisResultStatusFacets,
    pub source_revision: String,
    pub points_resource: String,
}

#[derive(Debug, Clone, Serialize, Deserialize, ToSchema)]
pub struct AnalysisResultBranchPointPageResource {
    pub schema_version: String,
    pub run_id: String,
    pub dataset_id: String,
    pub dataset_revision: String,
    pub branch_id: String,
    pub cursor: Option<String>,
    pub next_cursor: Option<String>,
    pub limit: usize,
    pub total_count: u64,
    pub items: Vec<AnalysisResultBranchPointResource>,
    pub unsupported_reason: Option<String>,
}

#[derive(Debug, Clone, Serialize, Deserialize, ToSchema)]
pub struct AnalysisResultRelationResource {
    pub relation_id: String,
    pub source_item_id: String,
    pub source_sample_id: String,
    pub relation: AnalysisResultItemRelation,
}

#[derive(Debug, Clone, Serialize, Deserialize, ToSchema)]
pub struct AnalysisResultRelationPageResource {
    pub schema_version: String,
    pub run_id: String,
    pub dataset_id: String,
    pub dataset_revision: String,
    pub cursor: Option<String>,
    pub next_cursor: Option<String>,
    pub limit: usize,
    pub total_count: u64,
    pub items: Vec<AnalysisResultRelationResource>,
    pub unsupported_reason: Option<String>,
}

#[derive(Debug, Clone, Serialize, Deserialize, ToSchema)]
pub struct AnalysisResultProjectionSelectionEntry {
    pub ordinal: u64,
    pub sample_id: Option<String>,
    pub item_id: Option<String>,
    pub branch_id: Option<String>,
}

#[derive(Debug, Clone, Serialize, Deserialize, ToSchema)]
pub struct AnalysisResultProjectionPoint {
    pub ordinal: u64,
    pub x: Option<f64>,
    pub y: Option<f64>,
    pub value: Option<f64>,
    pub sample_id: Option<String>,
    pub item_id: Option<String>,
    pub branch_id: Option<String>,
    pub status: String,
}

#[derive(Debug, Clone, Serialize, Deserialize, ToSchema)]
pub struct AnalysisResultProjectionSeries {
    pub series_id: String,
    pub label: String,
    pub points: Vec<AnalysisResultProjectionPoint>,
}

#[derive(Debug, Clone, Serialize, Deserialize, ToSchema)]
pub struct AnalysisResultProjectionResource {
    pub schema_version: String,
    pub run_id: String,
    pub dataset_id: String,
    pub dataset_revision: String,
    pub projection_id: String,
    pub projection_revision: String,
    pub axis_labels: BTreeMap<String, String>,
    pub axis_mapping: BTreeMap<String, String>,
    pub axis_units: BTreeMap<String, String>,
    pub fixed_coordinates: Vec<AnalysisResultCoordinateResource>,
    pub series: Vec<AnalysisResultProjectionSeries>,
    pub selection_index: Vec<AnalysisResultProjectionSelectionEntry>,
    pub status: AnalysisResultStatusFacets,
    pub unsupported_reason: Option<String>,
}

#[derive(Debug, Clone)]
struct ResultDatasetIndex {
    manifest: AnalysisResultDatasetManifestResource,
    samples: Vec<AnalysisResultSampleIndexEntry>,
    items: Vec<AnalysisResultSpectralItemSummary>,
    axis_values: BTreeMap<String, Vec<AnalysisResultAxisValueResource>>,
    projections: BTreeMap<String, AnalysisResultProjectionResource>,
}

#[derive(Debug, Clone)]
struct ResultIndexCollection {
    run_id: String,
    datasets: Vec<ResultDatasetIndex>,
}

#[derive(Debug, Clone, Serialize, Deserialize)]
struct ResultPageCursor {
    schema: u8,
    dataset_revision: String,
    query_digest: String,
    last_stable_id: String,
}

#[derive(Debug, Clone, Default)]
struct ParsedPageQuery {
    cursor: Option<String>,
    limit: usize,
    stage_id: Option<String>,
    product_kind: Option<String>,
    search: Option<String>,
    from_si: Option<f64>,
    to_si: Option<f64>,
    sample_id: Option<String>,
    item_kind: Option<String>,
    branch_id: Option<String>,
    status: Option<String>,
    has_field: Option<bool>,
    frequency_min_hz: Option<f64>,
    frequency_max_hz: Option<f64>,
    residual_max: Option<f64>,
    sort: Option<String>,
    coordinate_tokens: BTreeMap<String, String>,
    raw: BTreeMap<String, String>,
}

#[allow(dead_code)]
#[derive(Debug, Clone, Default, Deserialize, IntoParams)]
#[into_params(parameter_in = Query)]
pub struct AnalysisResultPageQuery {
    pub cursor: Option<String>,
    pub limit: Option<usize>,
    pub stage_id: Option<String>,
    pub product_kind: Option<String>,
    pub search: Option<String>,
    pub from_si: Option<f64>,
    pub to_si: Option<f64>,
    pub sample_id: Option<String>,
    pub item_kind: Option<String>,
    pub branch_id: Option<String>,
    pub status: Option<String>,
    pub has_field: Option<bool>,
    pub has_fields: Option<bool>,
    pub frequency_min_hz: Option<f64>,
    pub frequency_max_hz: Option<f64>,
    pub residual_max: Option<f64>,
    pub sort: Option<String>,
}

#[utoipa::path(
    get,
    path = "/v2/sessions/current/analysis/results/runs/{run_id}/datasets",
    params(("run_id" = String, Path), AnalysisResultPageQuery),
    responses((status = 200, description = "Run-scoped result dataset catalog", body = AnalysisResultDatasetCatalogResource)),
    tag = "analysis"
)]
pub async fn get_analysis_result_dataset_catalog(
    State(state): State<Arc<AppState>>,
    AxumPath(run_id): AxumPath<String>,
    Query(query): Query<HashMap<String, String>>,
) -> Result<Json<AnalysisResultDatasetCatalogResource>, ApiError> {
    let collection = load_result_indices(&state).await?;
    ensure_run(&collection, &run_id)?;
    let parsed = parse_page_query(&query)?;
    let mut all_items = collection
        .datasets
        .iter()
        .map(dataset_summary)
        .filter(|dataset| {
            parsed
                .stage_id
                .as_deref()
                .is_none_or(|stage_id| stage_id == dataset.stage_id)
                && parsed.product_kind.as_deref().is_none_or(|product_kind| {
                    serde_json::to_value(&dataset.product_kind)
                        .ok()
                        .and_then(|value| value.as_str().map(str::to_owned))
                        .as_deref()
                        == Some(product_kind)
                })
                && parsed.search.as_deref().is_none_or(|search| {
                    let search = search.to_lowercase();
                    dataset.dataset_id.to_lowercase().contains(&search)
                        || dataset.title.to_lowercase().contains(&search)
                })
                && parsed.status.as_deref().is_none_or(|status| {
                    status == dataset.status.resource
                        || status == dataset.status.execution
                        || status == dataset.status.completeness
                        || status == dataset.status.qualification
                })
        })
        .collect::<Vec<_>>();
    sort_dataset_summaries(&mut all_items, parsed.sort.as_deref())?;
    let revision = digest_json(&all_items);
    let start = cursor_start(all_items.iter().map(|item| item.dataset_id.as_str()), &revision, &parsed, "catalog")?;
    let items = all_items.iter().skip(start).take(parsed.limit).cloned().collect::<Vec<_>>();
    let next_cursor = (start + items.len() < all_items.len())
        .then(|| encode_cursor(&revision, &parsed, &items.last().map(|item| item.dataset_id.clone()).unwrap_or_default(), "catalog"));
    Ok(Json(AnalysisResultDatasetCatalogResource {
        schema_version: ANALYSIS_RESULT_INDEX_SCHEMA_VERSION.to_string(),
        run_id: collection.run_id,
        revision,
        status: if items.is_empty() { "unsupported" } else { "ready" }.to_string(),
        items,
        next_cursor,
        total_count: all_items.len() as u64,
        unsupported_reason: if all_items.is_empty() {
            Some("no validated result dataset artifacts are published".to_string())
        } else {
            None
        },
    }))
}

#[utoipa::path(
    get,
    path = "/v2/sessions/current/analysis/results/runs/{run_id}/datasets/{dataset_id}",
    params(("run_id" = String, Path), ("dataset_id" = String, Path)),
    responses((status = 200, description = "Result dataset manifest", body = AnalysisResultDatasetManifestResource)),
    tag = "analysis"
)]
pub async fn get_analysis_result_dataset_manifest(
    State(state): State<Arc<AppState>>,
    AxumPath((run_id, dataset_id)): AxumPath<(String, String)>,
) -> Result<Json<AnalysisResultDatasetManifestResource>, ApiError> {
    let collection = load_result_indices(&state).await?;
    ensure_run(&collection, &run_id)?;
    collection
        .datasets
        .into_iter()
        .find(|dataset| dataset.manifest.dataset_id == dataset_id)
        .map(|dataset| Json(dataset.manifest))
        .ok_or_else(|| ApiError::not_found(format!("RESULT_DATASET_NOT_FOUND: dataset '{dataset_id}' was not found")))
}

#[utoipa::path(
    get,
    path = "/v2/sessions/current/analysis/results/runs/{run_id}/datasets/{dataset_id}/axes/{axis_id}/values",
    params(("run_id" = String, Path), ("dataset_id" = String, Path), ("axis_id" = String, Path), AnalysisResultPageQuery),
    responses((status = 200, description = "Bounded result axis values", body = AnalysisResultAxisValuesResource)),
    tag = "analysis"
)]
pub async fn get_analysis_result_axis_values(
    State(state): State<Arc<AppState>>,
    AxumPath((run_id, dataset_id, axis_id)): AxumPath<(String, String, String)>,
    Query(query): Query<HashMap<String, String>>,
) -> Result<Json<AnalysisResultAxisValuesResource>, ApiError> {
    let collection = load_result_indices(&state).await?;
    ensure_run(&collection, &run_id)?;
    let dataset = find_dataset(&collection, &dataset_id)?;
    let values = dataset.axis_values.get(&axis_id).ok_or_else(|| {
        ApiError::unprocessable(format!("RESULT_INVALID_AXIS_FILTER: unknown axis '{axis_id}'"))
    })?;
    let parsed = parse_page_query(&query)?;
    validate_axis_range_filter(dataset, &axis_id, &parsed)?;
    let filtered_values = values
        .iter()
        .filter(|value| axis_value_matches(value, &parsed))
        .cloned()
        .collect::<Vec<_>>();
    let start = cursor_start(filtered_values.iter().map(|value| value.token.as_str()), &dataset.manifest.dataset_revision, &parsed, "axis")?;
    let page = filtered_values.iter().skip(start).take(parsed.limit).cloned().collect::<Vec<_>>();
    let next_cursor = (start + page.len() < filtered_values.len()).then(|| {
        encode_cursor(&dataset.manifest.dataset_revision, &parsed, &page.last().map(|value| value.token.clone()).unwrap_or_default(), "axis")
    });
    Ok(Json(AnalysisResultAxisValuesResource {
        schema_version: ANALYSIS_RESULT_INDEX_SCHEMA_VERSION.to_string(),
        run_id,
        dataset_id,
        dataset_revision: dataset.manifest.dataset_revision.clone(),
        axis_id,
        cursor: parsed.cursor,
        next_cursor,
        limit: parsed.limit,
        total_count: filtered_values.len() as u64,
        values: page,
    }))
}

#[derive(Debug, Clone, Serialize, Deserialize, ToSchema)]
pub struct AnalysisResultAxisValuesResource {
    pub schema_version: String,
    pub run_id: String,
    pub dataset_id: String,
    pub dataset_revision: String,
    pub axis_id: String,
    pub cursor: Option<String>,
    pub next_cursor: Option<String>,
    pub limit: usize,
    pub total_count: u64,
    pub values: Vec<AnalysisResultAxisValueResource>,
}

#[utoipa::path(
    get,
    path = "/v2/sessions/current/analysis/results/runs/{run_id}/datasets/{dataset_id}/samples",
    params(("run_id" = String, Path), ("dataset_id" = String, Path), AnalysisResultPageQuery),
    responses((status = 200, description = "Paged result samples", body = AnalysisResultSamplePageResource)),
    tag = "analysis"
)]
pub async fn get_analysis_result_samples(
    State(state): State<Arc<AppState>>,
    AxumPath((run_id, dataset_id)): AxumPath<(String, String)>,
    Query(query): Query<HashMap<String, String>>,
) -> Result<Json<AnalysisResultSamplePageResource>, ApiError> {
    let collection = load_result_indices(&state).await?;
    ensure_run(&collection, &run_id)?;
    let dataset = find_dataset(&collection, &dataset_id)?;
    let parsed = parse_page_query(&query)?;
    validate_coordinate_filters(dataset, &parsed)?;
    let samples = dataset
        .samples
        .iter()
        .filter(|sample| sample_matches(sample, &parsed))
        .cloned()
        .collect::<Vec<_>>();
    let mut samples = samples;
    sort_samples(&mut samples, parsed.sort.as_deref())?;
    let start = cursor_start(samples.iter().map(|sample| sample.sample_id.as_str()), &dataset.manifest.dataset_revision, &parsed, "samples")?;
    let page = samples.iter().skip(start).take(parsed.limit).cloned().collect::<Vec<_>>();
    let next_cursor = (start + page.len() < samples.len()).then(|| {
        encode_cursor(&dataset.manifest.dataset_revision, &parsed, &page.last().map(|sample| sample.sample_id.clone()).unwrap_or_default(), "samples")
    });
    Ok(Json(AnalysisResultSamplePageResource {
        schema_version: ANALYSIS_RESULT_INDEX_SCHEMA_VERSION.to_string(),
        run_id,
        dataset_id,
        dataset_revision: dataset.manifest.dataset_revision.clone(),
        cursor: parsed.cursor,
        next_cursor,
        limit: parsed.limit,
        total_count: samples.len() as u64,
        items: page,
    }))
}

#[utoipa::path(
    get,
    path = "/v2/sessions/current/analysis/results/runs/{run_id}/datasets/{dataset_id}/items",
    params(("run_id" = String, Path), ("dataset_id" = String, Path), AnalysisResultPageQuery),
    responses((status = 200, description = "Paged result items", body = AnalysisResultItemPageResource)),
    tag = "analysis"
)]
pub async fn get_analysis_result_items(
    State(state): State<Arc<AppState>>,
    AxumPath((run_id, dataset_id)): AxumPath<(String, String)>,
    Query(query): Query<HashMap<String, String>>,
) -> Result<Json<AnalysisResultItemPageResource>, ApiError> {
    let collection = load_result_indices(&state).await?;
    ensure_run(&collection, &run_id)?;
    let dataset = find_dataset(&collection, &dataset_id)?;
    let parsed = parse_page_query(&query)?;
    validate_coordinate_filters(dataset, &parsed)?;
    let items = dataset
        .items
        .iter()
        .filter(|item| item_matches(item, &parsed, dataset))
        .cloned()
        .collect::<Vec<_>>();
    let mut items = items;
    sort_items(&mut items, parsed.sort.as_deref())?;
    let start = cursor_start(items.iter().map(|item| item.item_id.as_str()), &dataset.manifest.dataset_revision, &parsed, "items")?;
    let page = items.iter().skip(start).take(parsed.limit).cloned().collect::<Vec<_>>();
    let next_cursor = (start + page.len() < items.len()).then(|| {
        encode_cursor(&dataset.manifest.dataset_revision, &parsed, &page.last().map(|item| item.item_id.clone()).unwrap_or_default(), "items")
    });
    Ok(Json(AnalysisResultItemPageResource {
        schema_version: ANALYSIS_RESULT_INDEX_SCHEMA_VERSION.to_string(),
        run_id,
        dataset_id,
        dataset_revision: dataset.manifest.dataset_revision.clone(),
        cursor: parsed.cursor,
        next_cursor,
        limit: parsed.limit,
        total_count: items.len() as u64,
        items: page,
    }))
}

#[utoipa::path(
    get,
    path = "/v2/sessions/current/analysis/results/runs/{run_id}/datasets/{dataset_id}/items/{item_id}",
    params(("run_id" = String, Path), ("dataset_id" = String, Path), ("item_id" = String, Path)),
    responses((status = 200, description = "Result item detail", body = AnalysisResultSpectralItemSummary)),
    tag = "analysis"
)]
pub async fn get_analysis_result_item(
    State(state): State<Arc<AppState>>,
    AxumPath((run_id, dataset_id, item_id)): AxumPath<(String, String, String)>,
) -> Result<Json<AnalysisResultSpectralItemSummary>, ApiError> {
    let collection = load_result_indices(&state).await?;
    ensure_run(&collection, &run_id)?;
    let dataset = find_dataset(&collection, &dataset_id)?;
    dataset
        .items
        .iter()
        .find(|item| item.item_id == item_id)
        .cloned()
        .map(Json)
        .ok_or_else(|| ApiError::not_found(format!("RESULT_ITEM_NOT_FOUND: item '{item_id}' was not found")))
}

#[utoipa::path(
    get,
    path = "/v2/sessions/current/analysis/results/runs/{run_id}/datasets/{dataset_id}/branches",
    params(("run_id" = String, Path), ("dataset_id" = String, Path), AnalysisResultPageQuery),
    responses((status = 200, description = "Paged tracked result branches", body = AnalysisResultBranchPageResource)),
    tag = "analysis"
)]
pub async fn get_analysis_result_branches(
    State(state): State<Arc<AppState>>,
    AxumPath((run_id, dataset_id)): AxumPath<(String, String)>,
    Query(query): Query<HashMap<String, String>>,
) -> Result<Json<AnalysisResultBranchPageResource>, ApiError> {
    let collection = load_result_indices(&state).await?;
    ensure_run(&collection, &run_id)?;
    let dataset = find_dataset(&collection, &dataset_id)?;
    let parsed = parse_page_query(&query)?;
    let mut branches = branch_summaries(dataset, &run_id, &dataset_id);
    if let Some(branch_id) = parsed.branch_id.as_deref() {
        branches.retain(|branch| branch.branch_id == branch_id);
    }
    match parsed.sort.as_deref() {
        None | Some("branch_id_asc") => {
            branches.sort_by(|left, right| left.branch_id.cmp(&right.branch_id));
        }
        Some("branch_id_desc") => {
            branches.sort_by(|left, right| right.branch_id.cmp(&left.branch_id));
        }
        Some(sort) => {
            return Err(ApiError::unprocessable(format!(
                "RESULT_INVALID_SORT: sort '{sort}' is not valid for branches"
            )));
        }
    }
    let total_count = branches.len() as u64;
    let start = cursor_start(
        branches.iter().map(|branch| branch.branch_id.as_str()),
        &dataset.manifest.dataset_revision,
        &parsed,
        "branches",
    )?;
    let items = branches
        .iter()
        .skip(start)
        .take(parsed.limit)
        .cloned()
        .collect::<Vec<_>>();
    let next_cursor = (start + items.len() < branches.len()).then(|| {
        encode_cursor(
            &dataset.manifest.dataset_revision,
            &parsed,
            &items
                .last()
                .map(|branch| branch.branch_id.clone())
                .unwrap_or_default(),
            "branches",
        )
    });
    Ok(Json(AnalysisResultBranchPageResource {
        schema_version: ANALYSIS_RESULT_INDEX_SCHEMA_VERSION.to_string(),
        run_id,
        dataset_id,
        dataset_revision: dataset.manifest.dataset_revision.clone(),
        cursor: parsed.cursor,
        next_cursor,
        limit: parsed.limit,
        total_count,
        items,
        unsupported_reason: (total_count == 0).then_some(
            "branch tracking is not published for this result dataset".to_string(),
        ),
    }))
}

#[utoipa::path(
    get,
    path = "/v2/sessions/current/analysis/results/runs/{run_id}/datasets/{dataset_id}/branches/{branch_id}",
    params(("run_id" = String, Path), ("dataset_id" = String, Path), ("branch_id" = String, Path)),
    responses((status = 200, description = "Tracked result branch", body = AnalysisResultBranchResource)),
    tag = "analysis"
)]
pub async fn get_analysis_result_branch(
    State(state): State<Arc<AppState>>,
    AxumPath((run_id, dataset_id, branch_id)): AxumPath<(String, String, String)>,
) -> Result<Json<AnalysisResultBranchResource>, ApiError> {
    let collection = load_result_indices(&state).await?;
    ensure_run(&collection, &run_id)?;
    let dataset = find_dataset(&collection, &dataset_id)?;
    branch_summaries(dataset, &run_id, &dataset_id)
        .into_iter()
        .find(|branch| branch.branch_id == branch_id)
        .map(|branch| {
            Json(AnalysisResultBranchResource {
                schema_version: ANALYSIS_RESULT_INDEX_SCHEMA_VERSION.to_string(),
                run_id,
                dataset_id,
                dataset_revision: dataset.manifest.dataset_revision.clone(),
                branch_id: branch.branch_id,
                label: branch.label,
                point_count: branch.point_count,
                status: branch.status,
                source_revision: branch.source_revision,
                points_resource: branch.points_resource,
            })
        })
        .ok_or_else(|| {
            ApiError::not_found(format!(
                "RESULT_BRANCH_NOT_FOUND: branch '{branch_id}' was not found"
            ))
        })
}

#[utoipa::path(
    get,
    path = "/v2/sessions/current/analysis/results/runs/{run_id}/datasets/{dataset_id}/branches/{branch_id}/points",
    params(("run_id" = String, Path), ("dataset_id" = String, Path), ("branch_id" = String, Path), AnalysisResultPageQuery),
    responses((status = 200, description = "Paged tracked result branch points", body = AnalysisResultBranchPointPageResource)),
    tag = "analysis"
)]
pub async fn get_analysis_result_branch_points(
    State(state): State<Arc<AppState>>,
    AxumPath((run_id, dataset_id, branch_id)): AxumPath<(String, String, String)>,
    Query(query): Query<HashMap<String, String>>,
) -> Result<Json<AnalysisResultBranchPointPageResource>, ApiError> {
    let collection = load_result_indices(&state).await?;
    ensure_run(&collection, &run_id)?;
    let dataset = find_dataset(&collection, &dataset_id)?;
    let parsed = parse_page_query(&query)?;
    let points = branch_points(dataset)
        .remove(&branch_id)
        .ok_or_else(|| {
            ApiError::not_found(format!(
                "RESULT_BRANCH_NOT_FOUND: branch '{branch_id}' was not found"
            ))
        })?;
    let start_resource = format!("branch_points:{branch_id}");
    let start = cursor_start(
        points.iter().map(|point| point.item_id.as_str()),
        &dataset.manifest.dataset_revision,
        &parsed,
        &start_resource,
    )?;
    let items = points
        .iter()
        .skip(start)
        .take(parsed.limit)
        .cloned()
        .collect::<Vec<_>>();
    let next_cursor = (start + items.len() < points.len()).then(|| {
        encode_cursor(
            &dataset.manifest.dataset_revision,
            &parsed,
            &items
                .last()
                .map(|point| point.item_id.clone())
                .unwrap_or_default(),
            &start_resource,
        )
    });
    Ok(Json(AnalysisResultBranchPointPageResource {
        schema_version: ANALYSIS_RESULT_INDEX_SCHEMA_VERSION.to_string(),
        run_id,
        dataset_id,
        dataset_revision: dataset.manifest.dataset_revision.clone(),
        branch_id,
        cursor: parsed.cursor,
        next_cursor,
        limit: parsed.limit,
        total_count: points.len() as u64,
        items,
        unsupported_reason: None,
    }))
}

#[utoipa::path(
    get,
    path = "/v2/sessions/current/analysis/results/runs/{run_id}/datasets/{dataset_id}/relations",
    params(("run_id" = String, Path), ("dataset_id" = String, Path), AnalysisResultPageQuery),
    responses((status = 200, description = "Paged result relations", body = AnalysisResultRelationPageResource)),
    tag = "analysis"
)]
pub async fn get_analysis_result_relations(
    State(state): State<Arc<AppState>>,
    AxumPath((run_id, dataset_id)): AxumPath<(String, String)>,
    Query(query): Query<HashMap<String, String>>,
) -> Result<Json<AnalysisResultRelationPageResource>, ApiError> {
    let collection = load_result_indices(&state).await?;
    ensure_run(&collection, &run_id)?;
    let dataset = find_dataset(&collection, &dataset_id)?;
    let parsed = parse_page_query(&query)?;
    let relations = relation_resources(dataset);
    let start = cursor_start(
        relations.iter().map(|relation| relation.relation_id.as_str()),
        &dataset.manifest.dataset_revision,
        &parsed,
        "relations",
    )?;
    let items = relations
        .iter()
        .skip(start)
        .take(parsed.limit)
        .cloned()
        .collect::<Vec<_>>();
    let next_cursor = (start + items.len() < relations.len()).then(|| {
        encode_cursor(
            &dataset.manifest.dataset_revision,
            &parsed,
            &items
                .last()
                .map(|relation| relation.relation_id.clone())
                .unwrap_or_default(),
            "relations",
        )
    });
    Ok(Json(AnalysisResultRelationPageResource {
        schema_version: ANALYSIS_RESULT_INDEX_SCHEMA_VERSION.to_string(),
        run_id,
        dataset_id,
        dataset_revision: dataset.manifest.dataset_revision.clone(),
        cursor: parsed.cursor,
        next_cursor,
        limit: parsed.limit,
        total_count: relations.len() as u64,
        items,
        unsupported_reason: relations.is_empty().then_some(
            "no versioned result relations are published for this dataset".to_string(),
        ),
    }))
}

#[utoipa::path(
    get,
    path = "/v2/sessions/current/analysis/results/runs/{run_id}/datasets/{dataset_id}/relations/{relation_id}",
    params(("run_id" = String, Path), ("dataset_id" = String, Path), ("relation_id" = String, Path)),
    responses((status = 200, description = "Result relation", body = AnalysisResultRelationResource)),
    tag = "analysis"
)]
pub async fn get_analysis_result_relation(
    State(state): State<Arc<AppState>>,
    AxumPath((run_id, dataset_id, relation_id)): AxumPath<(String, String, String)>,
) -> Result<Json<AnalysisResultRelationResource>, ApiError> {
    let collection = load_result_indices(&state).await?;
    ensure_run(&collection, &run_id)?;
    let dataset = find_dataset(&collection, &dataset_id)?;
    relation_resources(dataset)
        .into_iter()
        .find(|relation| relation.relation_id == relation_id)
        .map(Json)
        .ok_or_else(|| {
            ApiError::not_found(format!(
                "RESULT_RELATION_NOT_FOUND: relation '{relation_id}' was not found"
            ))
        })
}

#[utoipa::path(
    get,
    path = "/v2/sessions/current/analysis/results/runs/{run_id}/datasets/{dataset_id}/projections/{projection_id}",
    params(("run_id" = String, Path), ("dataset_id" = String, Path), ("projection_id" = String, Path)),
    responses((status = 200, description = "Bounded result projection", body = AnalysisResultProjectionResource)),
    tag = "analysis"
)]
pub async fn get_analysis_result_projection(
    State(state): State<Arc<AppState>>,
    AxumPath((run_id, dataset_id, projection_id)): AxumPath<(String, String, String)>,
) -> Result<Json<AnalysisResultProjectionResource>, ApiError> {
    let collection = load_result_indices(&state).await?;
    ensure_run(&collection, &run_id)?;
    let dataset = find_dataset(&collection, &dataset_id)?;
    dataset
        .projections
        .get(&projection_id)
        .cloned()
        .map(Json)
        .ok_or_else(|| ApiError::not_found(format!("RESULT_PROJECTION_NOT_FOUND: projection '{projection_id}' was not found")))
}

async fn load_result_indices(state: &Arc<AppState>) -> Result<ResultIndexCollection, ApiError> {
    let artifact_dir = require_current_live_artifact_dir(state).await?;
    let (run_id, default_stage_id) = current_result_identity(state).await?;
    let mut datasets = Vec::new();

    if try_resolve_artifact_path(&artifact_dir, "eigen/field_sweep.v1.json")?.is_some() {
        let digest = artifact_digest(&artifact_dir, "eigen/field_sweep.v1.json")?;
        let payload = match decode_frequency_domain_artifact_payload(
            "eigen/field_sweep.v1.json",
            read_json_artifact_value(&artifact_dir, "eigen/field_sweep.v1.json")?,
        )? {
            FrequencyDomainJsonArtifactPayload::FieldSweep(payload) => payload,
            _ => return Err(ApiError::internal("eigen/field_sweep.v1 artifact decoded to an unexpected payload")),
        };
        datasets.push(build_field_sweep_index(
            payload,
            digest,
            &run_id,
            default_stage_id.as_str(),
        )?);
    }
    if try_resolve_artifact_path(&artifact_dir, "eigen/spectrum.v3.json")?.is_some() {
        let digest = artifact_digest(&artifact_dir, "eigen/spectrum.v3.json")?;
        let payload = match decode_frequency_domain_artifact_payload(
            "eigen/spectrum.v3.json",
            read_json_artifact_value(&artifact_dir, "eigen/spectrum.v3.json")?,
        )? {
            FrequencyDomainJsonArtifactPayload::SpectrumV3(payload) => payload,
            _ => return Err(ApiError::internal("eigen/spectrum.v3 artifact decoded to an unexpected payload")),
        };
        datasets.push(build_spectrum_v3_index(
            payload,
            digest,
            &run_id,
            default_stage_id.as_str(),
        )?);
    } else if try_resolve_artifact_path(&artifact_dir, "eigen/spectrum.v2.json")?.is_some() {
        let digest = artifact_digest(&artifact_dir, "eigen/spectrum.v2.json")?;
        let payload = match decode_frequency_domain_artifact_payload(
            "eigen/spectrum.v2.json",
            read_json_artifact_value(&artifact_dir, "eigen/spectrum.v2.json")?,
        )? {
            FrequencyDomainJsonArtifactPayload::Spectrum(payload) => payload,
            _ => return Err(ApiError::internal("eigen/spectrum.v2 artifact decoded to an unexpected payload")),
        };
        datasets.push(build_spectrum_v2_index(
            payload,
            digest,
            &run_id,
            default_stage_id.as_str(),
        )?);
    }

    if try_resolve_artifact_path(&artifact_dir, "response/magnetic_response_sweep.v2.json")?.is_some() {
        let digest = artifact_digest(&artifact_dir, "response/magnetic_response_sweep.v2.json")?;
        let payload = match decode_frequency_domain_artifact_payload(
            "response/magnetic_response_sweep.v2.json",
            read_json_artifact_value(&artifact_dir, "response/magnetic_response_sweep.v2.json")?,
        )? {
            FrequencyDomainJsonArtifactPayload::ResponseSweep(payload) => payload,
            _ => return Err(ApiError::internal("response sweep artifact decoded to an unexpected payload")),
        };
        datasets.push(build_response_index(
            payload,
            digest,
            &run_id,
            default_stage_id.as_str(),
        )?);
    }

    if try_resolve_artifact_path(&artifact_dir, "analysis/spin_wave_response.gamma.v1.json")?.is_some() {
        let digest = artifact_digest(&artifact_dir, "analysis/spin_wave_response.gamma.v1.json")?;
        let payload = serde_json::from_value::<SpinWaveGammaResource>(
            read_json_artifact_value(&artifact_dir, "analysis/spin_wave_response.gamma.v1.json")?,
        )
        .map_err(|error| ApiError::internal(format!("invalid gamma artifact: {error}")))?;
        datasets.push(build_gamma_index(payload, digest, &run_id, default_stage_id.as_str())?);
    }

    if try_resolve_artifact_path(&artifact_dir, "analysis/dynamic_structure_factor.1d.v1.json")?.is_some() {
        let digest = artifact_digest(&artifact_dir, "analysis/dynamic_structure_factor.1d.v1.json")?;
        let payload = serde_json::from_value::<DynamicStructureFactorResource>(
            read_json_artifact_value(&artifact_dir, "analysis/dynamic_structure_factor.1d.v1.json")?,
        )
        .map_err(|error| ApiError::internal(format!("invalid DSF artifact: {error}")))?;
        datasets.push(build_dsf_index(payload, digest, &run_id, default_stage_id.as_str())?);
    }

    Ok(ResultIndexCollection { run_id, datasets })
}

async fn current_result_identity(state: &Arc<AppState>) -> Result<(String, String), ApiError> {
    let current = state.current_live_state.read().await;
    let snapshot = current
        .as_ref()
        .ok_or_else(|| ApiError::not_found("RESULT_RUN_NOT_FOUND: no active local live workspace"))?;
    let run_id = snapshot
        .run
        .as_ref()
        .map(|run| run.run_id.clone())
        .unwrap_or_else(|| snapshot.session.run_id.clone());
    let stage_id = snapshot
        .stage_execution
        .as_ref()
        .and_then(|execution| {
            execution
                .active_stage_index
                .and_then(|index| execution.stages.get(index))
                .and_then(|stage| stage.stage_id.clone())
        })
        .unwrap_or_else(|| "stage:analysis".to_string());
    Ok((run_id, stage_id))
}

fn ensure_run(collection: &ResultIndexCollection, requested_run_id: &str) -> Result<(), ApiError> {
    if requested_run_id == collection.run_id || requested_run_id == "run:current" {
        Ok(())
    } else {
        Err(ApiError::not_found(format!(
            "RESULT_RUN_NOT_FOUND: run '{requested_run_id}' is not the active result run"
        )))
    }
}

fn find_dataset<'a>(collection: &'a ResultIndexCollection, dataset_id: &str) -> Result<&'a ResultDatasetIndex, ApiError> {
    collection
        .datasets
        .iter()
        .find(|dataset| dataset.manifest.dataset_id == dataset_id)
        .ok_or_else(|| ApiError::not_found(format!("RESULT_DATASET_NOT_FOUND: dataset '{dataset_id}' was not found")))
}

fn build_field_sweep_index(
    payload: FrequencyDomainFieldSweepArtifactPayload,
    source_digest: String,
    run_id: &str,
    fallback_stage_id: &str,
) -> Result<ResultDatasetIndex, ApiError> {
    let stage_id = payload.stage_id.clone().unwrap_or_else(|| fallback_stage_id.to_string());
    let dataset_id = format!("result:{run_id}:{stage_id}:modal-eigen-field-sweep");
    let source_revision = payload
        .source_revision
        .clone()
        .or(payload.revision.clone())
        .unwrap_or_else(|| source_digest.clone());
    let root_status = declared_status(
        payload.status.as_deref(),
        payload.complete,
        payload.interrupted.unwrap_or(false),
    );
    let axis = payload.scan_axis.clone().map(|axis| axis_resource(
        "bias-field",
        "outer_sweep",
        "vector3",
        axis.coordinate,
        axis.unit,
        axis.display_conversions
            .iter()
            .map(|conversion| conversion.unit.clone())
            .collect(),
        axis.display_conversions
            .iter()
            .map(|conversion| AnalysisResultAxisProjection {
                projection_id: conversion.name.clone(),
                label: conversion.name.clone(),
                unit: conversion.unit.clone(),
                operation: "scale_vector_component_or_magnitude".to_string(),
            })
            .collect(),
    )).unwrap_or_else(|| axis_resource(
        "bias-field",
        "outer_sweep",
        "vector3",
        "bias_field_a_per_m".to_string(),
        "A/m".to_string(),
        vec!["T".to_string()],
        vec![AnalysisResultAxisProjection {
            projection_id: "mu0_H".to_string(),
            label: "mu0 H".to_string(),
            unit: "T".to_string(),
            operation: "scale_vector_component_or_magnitude".to_string(),
        }],
    ));
    let raw_samples = payload.samples.unwrap_or_default();
    let mut samples = Vec::with_capacity(raw_samples.len());
    let mut items = Vec::new();
    let mut axis_values = Vec::with_capacity(raw_samples.len());
    let mut invalid = false;
    for sample in raw_samples {
        let Some(sample_id) = sample.sample_id.clone() else {
            invalid = true;
            continue;
        };
        let sample_completeness = declared_status(sample.status.as_deref(), None, false);
        let sample_status = status_facets(
            &sample_completeness,
            "published",
            &sample_completeness,
            "unvalidated",
            (sample_completeness == "partial").then_some("sample_artifact_incomplete"),
            None,
        );
        let sample_revision = sample
            .linearization_state_sha256
            .clone()
            .or(sample.equilibrium_artifact_sha256.clone())
            .unwrap_or_else(|| source_revision.clone());
        let sample_label = bias_field_label(sample.bias_field_mu0_t);
        let coordinates = vec![AnalysisResultCoordinateResource {
            axis_id: "bias-field".to_string(),
            token: sample_id.clone(),
            scalar_si: None,
            vector3_si: sample.bias_field_a_per_m,
            category: None,
            entity_ref: None,
            label: Some(sample_label.clone()),
        }];
        axis_values.push(AnalysisResultAxisValueResource {
            token: sample_id.clone(),
            scalar_si: None,
            vector3_si: sample.bias_field_a_per_m,
            category: None,
            entity_ref: None,
            label: Some(sample_label),
            status: sample_status.completeness.clone(),
        });
        let mesh_ref = sample.topology.as_ref().and_then(result_mesh_ref);
        let sample_modes = sample.modes.unwrap_or_default();
        let mut sample_item_count = 0_u64;
        for mode in sample_modes {
            if mode.sample_id != sample_id {
                invalid = true;
                continue;
            }
            let item = field_sweep_item(
                run_id,
                &dataset_id,
                &sample_id,
                &source_revision,
                mode,
                mesh_ref.clone(),
            );
            sample_item_count += 1;
            items.push(item);
        }
        let branch_count = sample.branch_ids.as_ref().map(|branches| branches.len() as u64);
        samples.push(AnalysisResultSampleIndexEntry {
            sample_id: sample_id.clone(),
            sample_index: sample.sample_index,
            coordinates,
            status: sample_status,
            item_count: sample_item_count,
            branch_count,
            source_revision: sample_revision,
            equilibrium_ref: sample.equilibrium_artifact_sha256.map(|revision| AnalysisResultSourceArtifactRef {
                artifact: "eigen/equilibrium".to_string(),
                revision,
                relation: "sample_equilibrium".to_string(),
            }),
            linearization_ref: sample.linearization_state_sha256.map(|revision| AnalysisResultSourceArtifactRef {
                artifact: "eigen/linearization".to_string(),
                revision,
                relation: "sample_linearization".to_string(),
            }),
            mesh_ref,
            items_resource: items_path(run_id, &dataset_id, &sample_id),
        });
    }
    let axis = finalize_axis(axis, axis_values.clone(), samples.len());
    let mut source_artifacts = vec![AnalysisResultSourceArtifactRef {
        artifact: "eigen/field_sweep.v1.json".to_string(),
        revision: source_digest,
        relation: "adapter_source".to_string(),
    }];
    if let Some(source) = payload.source {
        source_artifacts.push(AnalysisResultSourceArtifactRef {
            artifact: source.artifact,
            revision: source.revision,
            relation: "source_spectrum".to_string(),
        });
    }
    for reference in payload.cross_artifact_refs.unwrap_or_default() {
        source_artifacts.push(AnalysisResultSourceArtifactRef {
            artifact: reference.artifact,
            revision: reference.revision,
            relation: reference.relation,
        });
    }
    let status = if invalid {
        status_facets("partial", "published", "partial", "unvalidated", Some("invalid_sample_or_mode_identity"), None)
    } else {
        status_facets(
            &root_status,
            "published",
            &root_status,
            "unvalidated",
            (root_status == "partial").then_some("source_artifact_incomplete"),
            None,
        )
    };
    let dataset_revision = derived_dataset_revision(
        &dataset_id,
        &source_revision,
        std::slice::from_ref(&axis),
        &source_artifacts,
    );
    let projections = build_modal_projections(run_id, &dataset_id, &dataset_revision, &axis, &samples, &items, &status);
    let manifest = build_manifest(
        dataset_id,
        dataset_revision,
        run_id,
        &stage_id,
        AnalysisResultProductKind::ModalEigen,
        "Modal eigen field sweep",
        Some("Validated adapter over eigen/field_sweep.v1 and its source artifacts"),
        status,
        source_artifacts,
        vec![axis],
        vec![AnalysisResultItemKind::EigenMode],
        &projections,
        &samples,
        &items,
        "shared_across_dataset",
        payload
            .units
            .as_ref()
            .map(|units| units.bias_field_display.as_str())
            .unwrap_or("T"),
    );
    Ok(ResultDatasetIndex {
        manifest,
        samples,
        items,
        axis_values: BTreeMap::from([(String::from("bias-field"), axis_values)]),
        projections,
    })
}

fn field_sweep_item(
    run_id: &str,
    dataset_id: &str,
    sample_id: &str,
    dataset_source_revision: &str,
    mode: FrequencyDomainFieldSweepModePayload,
    mesh_ref: Option<AnalysisResultMeshRef>,
) -> AnalysisResultSpectralItemSummary {
    let field_ready = mode.field_status.as_deref() == Some("ready")
        && mode.mode_field_id.is_some()
        && mode.mode_field_resource_key.is_some()
        && mesh_ref.is_some();
    let field_reason = if field_ready {
        None
    } else if mode.field_status.as_deref() == Some("ready") && mesh_ref.is_none() {
        Some("field_mesh_identity_not_published")
    } else {
        Some("field_payload_not_published")
    };
    let item_id = mode.mode_id.clone();
    let item_status = if mode.source_revision != dataset_source_revision {
        "stale"
    } else {
        mode.status.as_str()
    };
    AnalysisResultSpectralItemSummary {
        item_id: item_id.clone(),
        item_kind: AnalysisResultItemKind::EigenMode,
        sample_id: sample_id.to_string(),
        display_index: Some(mode.raw_mode_index),
        frequency_hz: Some(mode.frequency_hz),
        wavevector_kf: None,
        branch_id: mode.branch_id.map(|branch| branch.to_string()),
        status: status_facets(
            item_status,
            "published",
            if field_ready { "ready" } else { "spectrum_only" },
            "unvalidated",
            field_reason,
            None,
        ),
        quality: AnalysisResultQualitySummary {
            residual_relative_l2: mode.residual_relative_l2,
            tracking_score: None,
            qualification: "unvalidated".to_string(),
        },
        field_ref: field_ready.then(|| AnalysisResultFieldRef {
            field_id: mode.mode_field_id.unwrap_or_default(),
            field_revision: mode.source_revision.clone(),
            resource_key: mode.mode_field_resource_key.unwrap_or_default(),
            status: "ready".to_string(),
            quantity_id: Some("m".to_string()),
            representation: Some("complex-vector-xyz".to_string()),
            mesh_ref,
        }),
        detail_resource: item_path(run_id, dataset_id, sample_id, &item_id),
        source_revision: mode.source_revision,
        relations: Vec::new(),
    }
}

fn result_mesh_ref(
    topology: &FrequencyDomainFieldSweepTopologyPayload,
) -> Option<AnalysisResultMeshRef> {
    let mesh_id = topology.mesh_id.trim();
    let mesh_revision = topology.topology_revision.trim();
    let topology_fingerprint = topology.topology_fingerprint.as_deref()?.trim();
    if mesh_id.is_empty()
        || mesh_id == "topology:not_provided"
        || mesh_id == "topology:inconsistent"
        || mesh_revision.is_empty()
        || mesh_revision == "topology:not_provided"
        || mesh_revision == "topology:inconsistent"
        || topology_fingerprint.is_empty()
    {
        return None;
    }
    Some(AnalysisResultMeshRef {
        mesh_id: mesh_id.to_string(),
        mesh_revision: Some(mesh_revision.to_string()),
        topology_fingerprint: Some(topology_fingerprint.to_string()),
    })
}

fn build_spectrum_v3_index(
    payload: FrequencyDomainSpectrumV3ArtifactPayload,
    source_digest: String,
    run_id: &str,
    stage_id: &str,
) -> Result<ResultDatasetIndex, ApiError> {
    let dataset_id = format!("result:{run_id}:{stage_id}:modal-eigen-spectrum");
    let source_revision = source_digest.clone();
    let mut samples = Vec::new();
    let mut items = Vec::new();
    let mut axis_values = BTreeMap::new();
    let mut k_values = Vec::new();
    for sample in payload.samples {
        let coordinates = spectrum_sample_coordinates(&sample.sample_id, &sample.extra);
        if let Some(coordinate) = coordinates.first() {
            if coordinate.axis_id == "wavevector" {
                k_values.push(AnalysisResultAxisValueResource {
                    token: coordinate.token.clone(),
                    scalar_si: None,
                    vector3_si: coordinate.vector3_si,
                    category: None,
                    entity_ref: None,
                    label: coordinate.label.clone(),
                    status: "ready".to_string(),
                });
            }
        }
        let sample_id = sample.sample_id.clone();
        let mesh_ref = None;
        for mode in sample.modes {
            items.push(spectrum_v3_item(run_id, &dataset_id, &sample_id, &source_revision, mode, mesh_ref.clone()));
        }
        samples.push(AnalysisResultSampleIndexEntry {
            sample_id: sample_id.clone(),
            sample_index: Some(sample.sample_index),
            coordinates,
            status: status_facets("ready", "published", "ready", "unvalidated", None, None),
            item_count: items.iter().filter(|item| item.sample_id == sample_id).count() as u64,
            branch_count: None,
            source_revision: source_revision.clone(),
            equilibrium_ref: None,
            linearization_ref: None,
            mesh_ref,
            items_resource: items_path(run_id, &dataset_id, &sample_id),
        });
    }
    let axes = if k_values.is_empty() {
        Vec::new()
    } else {
        let axis = finalize_axis(axis_resource(
            "wavevector",
            "wavevector",
            "vector3",
            "wavevector_kf".to_string(),
            "rad/m".to_string(),
            vec!["rad/m".to_string()],
            Vec::new(),
        ), k_values.clone(), samples.len());
        axis_values.insert("wavevector".to_string(), k_values);
        vec![axis]
    };
    let status = status_facets(
        if payload.solve_succeeded == Some(false) { "partial" } else { "ready" },
        "published",
        if payload.solve_succeeded == Some(false) { "partial" } else { "ready" },
        "unvalidated",
        None,
        None,
    );
    let dataset_revision = derived_dataset_revision(&dataset_id, &source_revision, &axes, &vec![AnalysisResultSourceArtifactRef {
        artifact: "eigen/spectrum.v3.json".to_string(),
        revision: source_digest.clone(),
        relation: "adapter_source".to_string(),
    }]);
    let projections = build_modal_projections(run_id, &dataset_id, &dataset_revision, &axes.first().cloned().unwrap_or_else(|| axis_resource("frequency", "spectral", "scalar", "frequency_hz".to_string(), "Hz".to_string(), vec!["Hz".to_string()], Vec::new())), &samples, &items, &status);
    let source_artifacts = vec![AnalysisResultSourceArtifactRef {
        artifact: "eigen/spectrum.v3.json".to_string(),
        revision: source_digest,
        relation: "adapter_source".to_string(),
    }];
    let manifest = build_manifest(
        dataset_id,
        dataset_revision,
        run_id,
        stage_id,
        AnalysisResultProductKind::ModalEigen,
        "Modal eigen spectrum",
        Some("Validated adapter over eigen/spectrum.v3"),
        status,
        source_artifacts,
        axes,
        vec![AnalysisResultItemKind::EigenMode],
        &projections,
        &samples,
        &items,
        "shared_across_dataset",
        "Hz",
    );
    Ok(ResultDatasetIndex { manifest, samples, items, axis_values, projections })
}

fn build_spectrum_v2_index(
    payload: FrequencyDomainSpectrumArtifactPayload,
    source_digest: String,
    run_id: &str,
    stage_id: &str,
) -> Result<ResultDatasetIndex, ApiError> {
    let dataset_id = format!("result:{run_id}:{stage_id}:modal-eigen-spectrum");
    let source_revision = source_digest.clone();
    let mut samples = Vec::new();
    let mut items = Vec::new();
    for sample in payload.samples {
        let sample_id = sample.sample_id.clone().unwrap_or_else(|| format!("legacy-sample-{:04}", sample.sample_index.unwrap_or(0)));
        for mode in sample.modes.unwrap_or_default() {
            items.push(spectrum_v2_item(run_id, &dataset_id, &sample_id, &source_revision, mode));
        }
        samples.push(AnalysisResultSampleIndexEntry {
            sample_id: sample_id.clone(),
            sample_index: sample.sample_index,
            coordinates: Vec::new(),
            status: status_facets("partial", "published", "partial", "legacy", Some("legacy_spectrum_v2_without_typed_coordinates"), None),
            item_count: items.iter().filter(|item| item.sample_id == sample_id).count() as u64,
            branch_count: None,
            source_revision: source_revision.clone(),
            equilibrium_ref: None,
            linearization_ref: None,
            mesh_ref: None,
            items_resource: items_path(run_id, &dataset_id, &sample_id),
        });
    }
    let status = status_facets("partial", "published", "partial", "legacy", Some("legacy_spectrum_v2"), None);
    let source_artifacts = vec![AnalysisResultSourceArtifactRef {
        artifact: "eigen/spectrum.v2.json".to_string(),
        revision: source_digest,
        relation: "adapter_source".to_string(),
    }];
    let dataset_revision = derived_dataset_revision(&dataset_id, &source_revision, &[], &source_artifacts);
    let projections = BTreeMap::new();
    let manifest = build_manifest(
        dataset_id,
        dataset_revision,
        run_id,
        stage_id,
        AnalysisResultProductKind::ModalEigen,
        "Modal eigen spectrum (legacy)",
        Some("Legacy adapter; typed coordinate metadata is unavailable"),
        status,
        source_artifacts,
        Vec::new(),
        vec![AnalysisResultItemKind::EigenMode],
        &projections,
        &samples,
        &items,
        "shared_across_dataset",
        "Hz",
    );
    Ok(ResultDatasetIndex { manifest, samples, items, axis_values: BTreeMap::new(), projections })
}

fn build_response_index(
    payload: FrequencyDomainResponseSweepArtifactPayload,
    source_digest: String,
    run_id: &str,
    stage_id: &str,
) -> Result<ResultDatasetIndex, ApiError> {
    let dataset_id = format!("result:{run_id}:{stage_id}:driven-response");
    let source_revision = source_digest.clone();
    let mut items = Vec::new();
    let sample_id = "response-sample-0000".to_string();
    for point in payload.points.unwrap_or_default() {
        items.push(response_item(run_id, &dataset_id, &sample_id, &source_revision, point));
    }
    let sample = AnalysisResultSampleIndexEntry {
        sample_id: sample_id.clone(),
        sample_index: Some(0),
        coordinates: Vec::new(),
        status: status_facets("partial", "published", "partial", "legacy", Some("outer_sweep_coordinates_not_typed"), None),
        item_count: items.len() as u64,
        branch_count: None,
        source_revision: source_revision.clone(),
        equilibrium_ref: None,
        linearization_ref: None,
        mesh_ref: None,
        items_resource: items_path(run_id, &dataset_id, &sample_id),
    };
    let axis = axis_resource(
        "drive-frequency",
        "spectral",
        "scalar",
        "frequency_hz".to_string(),
        "Hz".to_string(),
        vec!["GHz".to_string()],
        Vec::new(),
    );
    let values = items.iter().filter_map(|item| item.frequency_hz.map(|frequency| AnalysisResultAxisValueResource {
        token: item.item_id.clone(),
        scalar_si: Some(frequency),
        vector3_si: None,
        category: None,
        entity_ref: None,
        label: Some(format_frequency(frequency)),
        status: item.status.completeness.clone(),
    })).collect::<Vec<_>>();
    let axes = vec![finalize_axis(axis, values.clone(), 1)];
    let status = declared_status(
        payload.status.as_deref(),
        payload.complete,
        payload.interrupted.unwrap_or(false),
    );
    let status = status_facets(&status, "published", &status, "legacy", Some("response_outer_sweep_not_typed"), None);
    let source_artifacts = vec![AnalysisResultSourceArtifactRef {
        artifact: "response/magnetic_response_sweep.v2.json".to_string(),
        revision: source_digest,
        relation: "adapter_source".to_string(),
    }];
    let dataset_revision = derived_dataset_revision(&dataset_id, &source_revision, &axes, &source_artifacts);
    let projections = build_response_projection(run_id, &dataset_id, &dataset_revision, &items, &status);
    let manifest = build_manifest(
        dataset_id,
        dataset_revision,
        run_id,
        stage_id,
        AnalysisResultProductKind::DrivenResponse,
        "Driven response frequency sweep",
        Some("Typed frequency-point adapter; outer coordinates remain unavailable until response metadata is published"),
        status,
        source_artifacts,
        axes,
        vec![AnalysisResultItemKind::DrivenFrequencyPoint],
        &projections,
        &[sample.clone()],
        &items,
        "shared_across_dataset",
        "Hz",
    );
    Ok(ResultDatasetIndex { manifest, samples: vec![sample], items, axis_values: BTreeMap::from([(String::from("drive-frequency"), values)]), projections })
}

fn build_gamma_index(
    payload: SpinWaveGammaResource,
    source_digest: String,
    run_id: &str,
    stage_id: &str,
) -> Result<ResultDatasetIndex, ApiError> {
    let dataset_id = format!("result:{run_id}:{stage_id}:time-domain-spectrum");
    let sample_id = "gamma-spectrum-sample-0000".to_string();
    let peaks = payload.peaks;
    let items = peaks.iter().map(|peak| AnalysisResultSpectralItemSummary {
        item_id: format!("legacy:gamma:peak:{}", peak.index),
        item_kind: AnalysisResultItemKind::SpectralFeature,
        sample_id: sample_id.clone(),
        display_index: Some(peak.index as u64),
        frequency_hz: Some(peak.frequency_hz),
        wavevector_kf: None,
        branch_id: None,
        status: status_facets("partial", "published", "partial", "legacy", Some("legacy_gamma_feature"), None),
        quality: AnalysisResultQualitySummary { residual_relative_l2: None, tracking_score: None, qualification: "legacy".to_string() },
        field_ref: None,
        detail_resource: item_path(run_id, &dataset_id, &sample_id, &format!("legacy:gamma:peak:{}", peak.index)),
        source_revision: source_digest.clone(),
        relations: Vec::new(),
    }).collect::<Vec<_>>();
    let sample = AnalysisResultSampleIndexEntry {
        sample_id: sample_id.clone(),
        sample_index: Some(0),
        coordinates: Vec::new(),
        status: status_facets("partial", "published", "partial", "legacy", Some("legacy_gamma_schema"), None),
        item_count: items.len() as u64,
        branch_count: None,
        source_revision: source_digest.clone(),
        equilibrium_ref: None,
        linearization_ref: None,
        mesh_ref: None,
        items_resource: items_path(run_id, &dataset_id, &sample_id),
    };
    let axis = axis_resource("frequency", "spectral", "scalar", "frequency_hz".to_string(), "Hz".to_string(), vec!["GHz".to_string()], Vec::new());
    let values = items.iter().filter_map(|item| item.frequency_hz.map(|frequency| AnalysisResultAxisValueResource { token: item.item_id.clone(), scalar_si: Some(frequency), vector3_si: None, category: None, entity_ref: None, label: Some(format_frequency(frequency)), status: "partial".to_string() })).collect::<Vec<_>>();
    let axes = vec![finalize_axis(axis, values.clone(), 1)];
    let status = status_facets("partial", "published", "partial", "legacy", Some("legacy_gamma_adapter"), None);
    let source_artifacts = vec![AnalysisResultSourceArtifactRef { artifact: "analysis/spin_wave_response.gamma.v1.json".to_string(), revision: source_digest.clone(), relation: "adapter_source".to_string() }];
    let dataset_revision = derived_dataset_revision(&dataset_id, &source_digest, &axes, &source_artifacts);
    let projections = build_gamma_projection(
        run_id,
        &dataset_id,
        &dataset_revision,
        &peaks,
        &payload.frequency_unit,
        &status,
    );
    let manifest = build_manifest(dataset_id, dataset_revision, run_id, stage_id, AnalysisResultProductKind::TimeDomainSpectrum, "LLG Gamma spectrum", Some("Bounded legacy adapter; peaks are spectral features, never eigenmodes"), status, source_artifacts, axes, vec![AnalysisResultItemKind::SpectralFeature], &projections, &[sample.clone()], &items, "shared_across_dataset", "Hz");
    Ok(ResultDatasetIndex { manifest, samples: vec![sample], items, axis_values: BTreeMap::from([(String::from("frequency"), values)]), projections })
}

fn build_gamma_projection(
    run_id: &str,
    dataset_id: &str,
    dataset_revision: &str,
    peaks: &[SpinWavePeakResource],
    frequency_unit: &str,
    status: &AnalysisResultStatusFacets,
) -> BTreeMap<String, AnalysisResultProjectionResource> {
    let points = peaks
        .iter()
        .map(|peak| AnalysisResultProjectionPoint {
            ordinal: peak.index as u64,
            x: peak.frequency_hz.is_finite().then_some(peak.frequency_hz),
            y: peak.power.is_finite().then_some(peak.power),
            value: peak.power.is_finite().then_some(peak.power),
            sample_id: Some(String::from("gamma-spectrum-sample-0000")),
            item_id: Some(format!("legacy:gamma:peak:{}", peak.index)),
            branch_id: None,
            status: status.completeness.clone(),
        })
        .filter(|point| point.x.is_some() && point.y.is_some())
        .collect::<Vec<_>>();
    let selection_index = points
        .iter()
        .map(|point| AnalysisResultProjectionSelectionEntry {
            ordinal: point.ordinal,
            sample_id: point.sample_id.clone(),
            item_id: point.item_id.clone(),
            branch_id: None,
        })
        .collect::<Vec<_>>();
    let projection_revision = digest_json(&(points.clone(), &selection_index));
    let projection_id = String::from("spectrum");
    let projection = AnalysisResultProjectionResource {
        schema_version: ANALYSIS_RESULT_INDEX_SCHEMA_VERSION.to_string(),
        run_id: run_id.to_string(),
        dataset_id: dataset_id.to_string(),
        dataset_revision: dataset_revision.to_string(),
        projection_id: projection_id.clone(),
        projection_revision,
        axis_labels: BTreeMap::from([
            (String::from("x"), String::from("Frequency")),
            (String::from("y"), String::from("Spectral power")),
        ]),
        axis_mapping: BTreeMap::from([
            (String::from("x"), String::from("frequency_hz")),
            (String::from("y"), String::from("spectral_power")),
        ]),
        axis_units: BTreeMap::from([
            (String::from("x"), frequency_unit.to_string()),
            (String::from("y"), String::from("unknown")),
        ]),
        fixed_coordinates: Vec::new(),
        series: vec![AnalysisResultProjectionSeries {
            series_id: String::from("spectral-features"),
            label: String::from("Spectral features"),
            points,
        }],
        selection_index,
        status: status.clone(),
        unsupported_reason: None,
    };
    BTreeMap::from([(projection_id, projection)])
}

fn build_dsf_index(
    payload: DynamicStructureFactorResource,
    source_digest: String,
    run_id: &str,
    stage_id: &str,
) -> Result<ResultDatasetIndex, ApiError> {
    let dataset_id = format!("result:{run_id}:{stage_id}:dynamic-structure-factor");
    let sample_id = "dsf-sample-0000".to_string();
    let count = payload.frequency_count.min(MAX_PROJECTION_POINTS / payload.wavevector_count.max(1));
    let mut items = Vec::new();
    for frequency_index in 0..count {
        for wavevector_index in 0..payload.wavevector_count.min(MAX_PROJECTION_POINTS / count.max(1)) {
            let ordinal = (frequency_index * payload.wavevector_count + wavevector_index) as u64;
            let item_id = format!("legacy:dsf:{frequency_index}:{wavevector_index}");
            items.push(AnalysisResultSpectralItemSummary {
                item_id: item_id.clone(),
                item_kind: AnalysisResultItemKind::DsfPoint,
                sample_id: sample_id.clone(),
                display_index: Some(ordinal),
                frequency_hz: payload.frequency_hz.get(frequency_index).copied(),
                wavevector_kf: payload.k_rad_per_m.get(wavevector_index).map(|value| [*value, 0.0, 0.0]),
                branch_id: None,
                status: status_facets("partial", "published", "partial", "legacy", Some("legacy_dsf_adapter"), None),
                quality: AnalysisResultQualitySummary { residual_relative_l2: None, tracking_score: None, qualification: "legacy".to_string() },
                field_ref: None,
                detail_resource: item_path(run_id, &dataset_id, &sample_id, &item_id),
                source_revision: source_digest.clone(),
                relations: Vec::new(),
            });
        }
    }
    let sample = AnalysisResultSampleIndexEntry {
        sample_id: sample_id.clone(), sample_index: Some(0), coordinates: Vec::new(),
        status: status_facets("partial", "published", "partial", "legacy", Some("legacy_dsf_schema"), None),
        item_count: items.len() as u64, branch_count: None, source_revision: source_digest.clone(), equilibrium_ref: None, linearization_ref: None, mesh_ref: None,
        items_resource: items_path(run_id, &dataset_id, &sample_id),
    };
    let frequency_values = payload
        .frequency_hz
        .iter()
        .enumerate()
        .take(count)
        .map(|(index, value)| AnalysisResultAxisValueResource { token: format!("frequency:{index}"), scalar_si: Some(*value), vector3_si: None, category: None, entity_ref: None, label: Some(format_frequency(*value)), status: "partial".to_string() })
        .collect::<Vec<_>>();
    let wavevector_values = payload
        .k_rad_per_m
        .iter()
        .enumerate()
        .take(payload.wavevector_count)
        .map(|(index, value)| AnalysisResultAxisValueResource { token: format!("wavevector:{index}"), scalar_si: Some(*value), vector3_si: None, category: None, entity_ref: None, label: Some(format!("k[{index}]")), status: "partial".to_string() })
        .collect::<Vec<_>>();
    let axes = vec![
        finalize_axis(axis_resource("frequency", "spectral", "scalar", "frequency_hz".to_string(), payload.frequency_unit.clone(), vec!["GHz".to_string()], Vec::new()), frequency_values.clone(), 1),
        finalize_axis(axis_resource("wavevector", "wavevector", "scalar", "k_rad_per_m".to_string(), payload.wavevector_unit.clone(), vec!["rad/um".to_string()], Vec::new()), wavevector_values.clone(), 1),
    ];
    let status = status_facets("partial", "published", "partial", "legacy", Some("legacy_dsf_adapter"), None);
    let source_artifacts = vec![AnalysisResultSourceArtifactRef { artifact: "analysis/dynamic_structure_factor.1d.v1.json".to_string(), revision: source_digest.clone(), relation: "adapter_source".to_string() }];
    let dataset_revision = derived_dataset_revision(&dataset_id, &source_digest, &axes, &source_artifacts);
    let projections = build_dsf_projection(
        run_id,
        &dataset_id,
        &dataset_revision,
        &payload,
        &status,
    );
    let manifest = build_manifest(dataset_id, dataset_revision, run_id, stage_id, AnalysisResultProductKind::DynamicStructureFactor, "Dynamic structure factor", Some("Bounded legacy adapter; dense tiles remain in the native data plane"), status, source_artifacts, axes, vec![AnalysisResultItemKind::DsfPoint], &projections, &[sample.clone()], &items, "shared_across_dataset", &payload.frequency_unit);
    Ok(ResultDatasetIndex { manifest, samples: vec![sample], items, axis_values: BTreeMap::from([(String::from("frequency"), frequency_values), (String::from("wavevector"), wavevector_values)]), projections })
}

fn build_dsf_projection(
    run_id: &str,
    dataset_id: &str,
    dataset_revision: &str,
    payload: &DynamicStructureFactorResource,
    status: &AnalysisResultStatusFacets,
) -> BTreeMap<String, AnalysisResultProjectionResource> {
    let frequency_count = payload
        .frequency_count
        .min(MAX_PROJECTION_POINTS / payload.wavevector_count.max(1));
    let wavevector_count = payload
        .wavevector_count
        .min(MAX_PROJECTION_POINTS / frequency_count.max(1));
    let points = (0..frequency_count)
        .flat_map(|frequency_index| {
            (0..wavevector_count).filter_map(move |wavevector_index| {
                let ordinal = (frequency_index * payload.wavevector_count + wavevector_index) as u64;
                let is_invalid_probe = payload
                    .invalid_probe_mask
                    .get(wavevector_index)
                    .copied()
                    .unwrap_or(true);
                let flat_index = frequency_index
                    .checked_mul(payload.wavevector_count)?
                    .checked_add(wavevector_index)?;
                let x = payload.k_rad_per_m.get(wavevector_index).copied();
                let y = payload.frequency_hz.get(frequency_index).copied();
                let value = payload.power.get(flat_index).copied();
                Some(AnalysisResultProjectionPoint {
                    ordinal,
                    x: (!is_invalid_probe).then_some(x?).filter(|value| value.is_finite()),
                    y: (!is_invalid_probe).then_some(y?).filter(|value| value.is_finite()),
                    value: (!is_invalid_probe).then_some(value?).filter(|value| value.is_finite()),
                    sample_id: Some(String::from("dsf-sample-0000")),
                    item_id: Some(format!("legacy:dsf:{frequency_index}:{wavevector_index}")),
                    branch_id: None,
                    status: if is_invalid_probe {
                        String::from("unsupported")
                    } else {
                        status.completeness.clone()
                    },
                })
            })
        })
        .collect::<Vec<_>>();
    let selection_index = points
        .iter()
        .filter(|point| point.x.is_some() && point.y.is_some() && point.value.is_some())
        .map(|point| AnalysisResultProjectionSelectionEntry {
            ordinal: point.ordinal,
            sample_id: point.sample_id.clone(),
            item_id: point.item_id.clone(),
            branch_id: None,
        })
        .collect::<Vec<_>>();
    let projection_id = String::from("dsf-map");
    let projection = AnalysisResultProjectionResource {
        schema_version: ANALYSIS_RESULT_INDEX_SCHEMA_VERSION.to_string(),
        run_id: run_id.to_string(),
        dataset_id: dataset_id.to_string(),
        dataset_revision: dataset_revision.to_string(),
        projection_id: projection_id.clone(),
        projection_revision: digest_json(&(points.clone(), &selection_index)),
        axis_labels: BTreeMap::from([
            (String::from("x"), String::from("Wavevector")),
            (String::from("y"), String::from("Frequency")),
        ]),
        axis_mapping: BTreeMap::from([
            (String::from("x"), String::from("k_rad_per_m")),
            (String::from("y"), String::from("frequency_hz")),
        ]),
        axis_units: BTreeMap::from([
            (String::from("x"), payload.wavevector_unit.clone()),
            (String::from("y"), payload.frequency_unit.clone()),
        ]),
        fixed_coordinates: Vec::new(),
        series: vec![AnalysisResultProjectionSeries {
            series_id: String::from("dsf"),
            label: String::from("S(k, f)"),
            points,
        }],
        selection_index,
        status: status.clone(),
        unsupported_reason: None,
    };
    BTreeMap::from([(projection_id, projection)])
}

fn spectrum_v3_item(run_id: &str, dataset_id: &str, sample_id: &str, source_revision: &str, mode: FrequencyDomainSpectrumV3ModePayload, mesh_ref: Option<AnalysisResultMeshRef>) -> AnalysisResultSpectralItemSummary {
    let field_ready = mode.mode_field_id.is_some() && mode.mode_field_resource_key.is_some();
    let item_id = mode.mode_id.clone();
    AnalysisResultSpectralItemSummary {
        item_id: item_id.clone(), item_kind: AnalysisResultItemKind::EigenMode, sample_id: sample_id.to_string(), display_index: Some(mode.raw_mode_index), frequency_hz: Some(mode.frequency_hz), wavevector_kf: None, branch_id: mode.branch_id.map(|branch| branch.to_string()),
        status: status_facets("ready", "published", if field_ready { "ready" } else { "spectrum_only" }, "unvalidated", (!field_ready).then_some("field_payload_not_published"), None),
        quality: AnalysisResultQualitySummary { residual_relative_l2: Some(mode.residual_relative_l2), tracking_score: None, qualification: "unvalidated".to_string() },
        field_ref: field_ready.then(|| AnalysisResultFieldRef { field_id: mode.mode_field_id.unwrap_or_default(), field_revision: source_revision.to_string(), resource_key: mode.mode_field_resource_key.unwrap_or_default(), status: "ready".to_string(), quantity_id: Some("m".to_string()), representation: Some("complex-vector-xyz".to_string()), mesh_ref }),
        detail_resource: item_path(run_id, dataset_id, sample_id, &item_id), source_revision: source_revision.to_string(), relations: Vec::new(),
    }
}

fn spectrum_v2_item(run_id: &str, dataset_id: &str, sample_id: &str, source_revision: &str, mode: FrequencyDomainSpectrumModePayload) -> AnalysisResultSpectralItemSummary {
    let item_id = mode.mode_id.clone().unwrap_or_else(|| format!("legacy:{sample_id}:mode:{}", mode.raw_mode_index.unwrap_or(0)));
    AnalysisResultSpectralItemSummary {
        item_id: item_id.clone(), item_kind: AnalysisResultItemKind::EigenMode, sample_id: sample_id.to_string(), display_index: mode.raw_mode_index, frequency_hz: mode.frequency_hz.or(mode.frequency_real_hz), wavevector_kf: None, branch_id: mode.branch_id.map(|branch| branch.to_string()), status: status_facets("partial", "published", "spectrum_only", "legacy", Some("legacy_spectrum_v2"), None), quality: AnalysisResultQualitySummary { residual_relative_l2: None, tracking_score: None, qualification: "legacy".to_string() }, field_ref: None, detail_resource: item_path(run_id, dataset_id, sample_id, &item_id), source_revision: source_revision.to_string(), relations: Vec::new(),
    }
}

fn response_item(run_id: &str, dataset_id: &str, sample_id: &str, source_revision: &str, point: FrequencyDomainResponsePointPayload) -> AnalysisResultSpectralItemSummary {
    let item_id = point.point_id.clone().unwrap_or_else(|| format!("legacy:response:point:{}", point.frequency_index.unwrap_or(0)));
    AnalysisResultSpectralItemSummary { item_id: item_id.clone(), item_kind: AnalysisResultItemKind::DrivenFrequencyPoint, sample_id: sample_id.to_string(), display_index: point.frequency_index, frequency_hz: point.frequency_hz, wavevector_kf: None, branch_id: None, status: status_facets("partial", "published", "partial", "legacy", Some("response_point_field_contract_not_published"), None), quality: AnalysisResultQualitySummary { residual_relative_l2: None, tracking_score: None, qualification: "legacy".to_string() }, field_ref: None, detail_resource: item_path(run_id, dataset_id, sample_id, &item_id), source_revision: source_revision.to_string(), relations: Vec::new() }
}

fn branch_points(
    dataset: &ResultDatasetIndex,
) -> BTreeMap<String, Vec<AnalysisResultBranchPointResource>> {
    let sample_indices = dataset
        .samples
        .iter()
        .map(|sample| (sample.sample_id.as_str(), sample.sample_index))
        .collect::<BTreeMap<_, _>>();
    let mut points = BTreeMap::<String, Vec<AnalysisResultBranchPointResource>>::new();
    for item in &dataset.items {
        let Some(branch_id) = item.branch_id.clone() else {
            continue;
        };
        points
            .entry(branch_id.clone())
            .or_default()
            .push(AnalysisResultBranchPointResource {
                branch_id,
                sample_id: item.sample_id.clone(),
                item_id: item.item_id.clone(),
                sample_index: sample_indices
                    .get(item.sample_id.as_str())
                    .copied()
                    .flatten(),
                raw_mode_index: item.display_index,
                frequency_hz: item.frequency_hz,
                status: item.status.clone(),
                source_revision: item.source_revision.clone(),
            });
    }
    for branch in points.values_mut() {
        branch.sort_by(|left, right| {
            left.sample_index
                .unwrap_or(u64::MAX)
                .cmp(&right.sample_index.unwrap_or(u64::MAX))
                .then_with(|| {
                    left.raw_mode_index
                        .unwrap_or(u64::MAX)
                        .cmp(&right.raw_mode_index.unwrap_or(u64::MAX))
                })
                .then_with(|| left.item_id.cmp(&right.item_id))
        });
    }
    points
}

fn branch_summaries(
    dataset: &ResultDatasetIndex,
    run_id: &str,
    dataset_id: &str,
) -> Vec<AnalysisResultBranchSummaryResource> {
    branch_points(dataset)
        .into_iter()
        .map(|(branch_id, points)| {
            let complete = points.iter().all(|point| {
                matches!(
                    point.status.completeness.as_str(),
                    "ready" | "complete"
                )
            });
            let first_source_revision = points[0].source_revision.as_str();
            let source_revision = if points
                .iter()
                .map(|point| point.source_revision.as_str())
                .all(|revision| revision == first_source_revision)
            {
                points[0].source_revision.clone()
            } else {
                digest_json(&points)
            };
            AnalysisResultBranchSummaryResource {
                points_resource: branch_points_path(run_id, dataset_id, &branch_id),
                branch_id: branch_id.clone(),
                label: format!("Branch {branch_id}"),
                point_count: points.len() as u64,
                status: status_facets(
                    if complete { "ready" } else { "stale" },
                    "published",
                    if complete { "complete" } else { "partial" },
                    "unvalidated",
                    (!complete).then_some("branch_points_partial"),
                    None,
                ),
                source_revision,
            }
        })
        .collect()
}

fn relation_resources(
    dataset: &ResultDatasetIndex,
) -> Vec<AnalysisResultRelationResource> {
    dataset
        .items
        .iter()
        .flat_map(|item| {
            item.relations.iter().map(|relation| {
                let relation_id = format!(
                    "relation:{}:{}",
                    item.item_id,
                    digest_json(relation)
                );
                AnalysisResultRelationResource {
                    relation_id,
                    source_item_id: item.item_id.clone(),
                    source_sample_id: item.sample_id.clone(),
                    relation: relation.clone(),
                }
            })
        })
        .collect()
}

fn spectrum_sample_coordinates(sample_id: &str, extra: &crate::router_v2::handlers::analysis::frequency_domain::FrequencyDomainArtifactExtras) -> Vec<AnalysisResultCoordinateResource> {
    let vector = extra.0.get("k_vector").and_then(|value| value.as_array()).and_then(|values| {
        let values = values.iter().map(Value::as_f64).collect::<Option<Vec<_>>>()?;
        (values.len() == 3).then(|| [values[0], values[1], values[2]])
    });
    vector.map(|vector| vec![AnalysisResultCoordinateResource { axis_id: "wavevector".to_string(), token: sample_id.to_string(), scalar_si: None, vector3_si: Some(vector), category: None, entity_ref: None, label: Some(sample_id.to_string()) }]).unwrap_or_default()
}

fn build_manifest(
    dataset_id: String,
    dataset_revision: String,
    run_id: &str,
    stage_id: &str,
    product_kind: AnalysisResultProductKind,
    title: &str,
    description: Option<&str>,
    status: AnalysisResultStatusFacets,
    source_artifacts: Vec<AnalysisResultSourceArtifactRef>,
    axes: Vec<AnalysisResultAxisResource>,
    item_kinds: Vec<AnalysisResultItemKind>,
    projections: &BTreeMap<String, AnalysisResultProjectionResource>,
    samples: &[AnalysisResultSampleIndexEntry],
    items: &[AnalysisResultSpectralItemSummary],
    topology_policy: &str,
    units_policy: &str,
) -> AnalysisResultDatasetManifestResource {
    let axes = axes
        .into_iter()
        .map(|mut axis| {
            axis.values_resource_key = Some(axis_values_path(run_id, &dataset_id, &axis.axis_id));
            axis
        })
        .collect::<Vec<_>>();
    let projection_descriptors = projections.values().map(|projection| AnalysisResultProjectionDescriptor { projection_id: projection.projection_id.clone(), kind: "line".to_string(), title: projection.projection_id.clone(), resource_key: projection_path(run_id, &dataset_id, &projection.projection_id), x_axis_id: projection.axis_mapping.get("x").cloned(), y_axis_id: projection.axis_mapping.get("y").cloned(), selectable: !projection.selection_index.is_empty() }).collect::<Vec<_>>();
    let fields = items.iter().any(|item| item.field_ref.is_some());
    let branch_tracking = items.iter().any(|item| item.branch_id.is_some());
    AnalysisResultDatasetManifestResource {
        schema_version: ANALYSIS_RESULT_INDEX_SCHEMA_VERSION.to_string(),
        dataset_id: dataset_id.clone(), dataset_revision, run_id: run_id.to_string(), stage_id: stage_id.to_string(), product_kind, title: title.to_string(), description: description.map(str::to_string), status, source_artifacts, axes, item_kinds,
        projections: projection_descriptors,
        capabilities: AnalysisResultDatasetCapabilities { sample_paging: true, item_paging: true, server_filtering: true, server_sorting: true, branch_tracking, fields, result_meshes: false, comparison: false, export: true, live_partial_results: true },
        default_cursor: AnalysisResultDefaultCursor { sample_id: samples.first().map(|sample| sample.sample_id.clone()), item_id: items.first().map(|item| item.item_id.clone()) },
        topology_policy: topology_policy.to_string(), units_policy: units_policy.to_string(), provenance: BTreeMap::from([(String::from("adapter"), String::from(ANALYSIS_RESULT_INDEX_SCHEMA_VERSION)), (String::from("qualification"), String::from("unvalidated"))]),
        sample_index_resource: samples_path(run_id, &dataset_id), item_index_resource: items_path(run_id, &dataset_id, "",),
    }
}

fn build_modal_projections(
    run_id: &str,
    dataset_id: &str,
    dataset_revision: &str,
    axis: &AnalysisResultAxisResource,
    samples: &[AnalysisResultSampleIndexEntry],
    items: &[AnalysisResultSpectralItemSummary],
    status: &AnalysisResultStatusFacets,
) -> BTreeMap<String, AnalysisResultProjectionResource> {
    let mut by_branch: BTreeMap<String, Vec<AnalysisResultProjectionPoint>> = BTreeMap::new();
    let sample_coordinate = |sample_id: &str| samples
        .iter()
        .find(|sample| sample.sample_id == sample_id)
        .and_then(|sample| sample.coordinates.first())
        .and_then(projection_scalar_for_coordinate);
    let spectrum_projection = axis.axis_id == "frequency";
    for (ordinal, item) in items.iter().enumerate() {
        let Some(frequency) = item.frequency_hz else { continue };
        let branch = item.branch_id.clone().unwrap_or_else(|| format!("item:{}", item.item_id));
        let (x, y) = if spectrum_projection {
            (Some(frequency), item.display_index.map(|index| index as f64))
        } else {
            (sample_coordinate(&item.sample_id), Some(frequency))
        };
        if x.is_some_and(|value| !value.is_finite()) || y.is_some_and(|value| !value.is_finite()) {
            continue;
        }
        if x.is_none() || y.is_none() {
            continue;
        }
        by_branch.entry(branch.clone()).or_default().push(AnalysisResultProjectionPoint { ordinal: ordinal as u64, x, y, value: Some(frequency), sample_id: Some(item.sample_id.clone()), item_id: Some(item.item_id.clone()), branch_id: item.branch_id.clone(), status: item.status.completeness.clone() });
    }
    let series = by_branch.into_iter().map(|(series_id, points)| AnalysisResultProjectionSeries { label: series_id.clone(), series_id, points }).collect::<Vec<_>>();
    let selection_index = series.iter().flat_map(|series| series.points.iter().map(|point| AnalysisResultProjectionSelectionEntry { ordinal: point.ordinal, sample_id: point.sample_id.clone(), item_id: point.item_id.clone(), branch_id: point.branch_id.clone() })).collect::<Vec<_>>();
    let projection_id = if spectrum_projection { "spectrum" } else if axis.axis_id == "drive-frequency" { "response-sweep" } else { "field-frequency-map" };
    let projection_revision = digest_json(&selection_index);
    let unsupported_reason = selection_index
        .is_empty()
        .then_some(if spectrum_projection {
            String::from("spectrum projection requires finite mode frequencies and display indices")
        } else {
            String::from("projection requires a scalar or axis-aligned vector coordinate")
        });
    let (axis_labels, axis_mapping, axis_units) = if spectrum_projection {
        (
            BTreeMap::from([(String::from("x"), String::from("Frequency")), (String::from("y"), String::from("Mode index"))]),
            BTreeMap::from([(String::from("x"), String::from("frequency_hz")), (String::from("y"), String::from("display_index"))]),
            BTreeMap::from([(String::from("x"), axis.unit_si.clone().unwrap_or_else(|| String::from("Hz"))), (String::from("y"), String::from("index"))]),
        )
    } else {
        (
            BTreeMap::from([(String::from("x"), axis.label.clone()), (String::from("y"), String::from("Frequency"))]),
            BTreeMap::from([(String::from("x"), axis.axis_id.clone()), (String::from("y"), String::from("frequency_hz"))]),
            BTreeMap::from([(String::from("x"), axis.unit_si.clone().unwrap_or_else(|| String::from("unknown"))), (String::from("y"), String::from("Hz"))]),
        )
    };
    BTreeMap::from([(projection_id.to_string(), AnalysisResultProjectionResource { schema_version: ANALYSIS_RESULT_INDEX_SCHEMA_VERSION.to_string(), run_id: run_id.to_string(), dataset_id: dataset_id.to_string(), dataset_revision: dataset_revision.to_string(), projection_id: projection_id.to_string(), projection_revision, axis_labels, axis_mapping, axis_units, fixed_coordinates: Vec::new(), series, selection_index, status: status.clone(), unsupported_reason })])
}

fn projection_scalar_for_coordinate(
    coordinate: &AnalysisResultCoordinateResource,
) -> Option<f64> {
    if let Some(scalar) = coordinate.scalar_si {
        return scalar.is_finite().then_some(scalar);
    }
    let vector = coordinate.vector3_si?;
    if vector.iter().any(|value| !value.is_finite()) {
        return None;
    }
    let non_zero = vector.iter().filter(|value| value.abs() > f64::EPSILON).count();
    (non_zero <= 1).then(|| vector.iter().map(|value| value * value).sum::<f64>().sqrt())
}

fn build_response_projection(
    run_id: &str,
    dataset_id: &str,
    dataset_revision: &str,
    items: &[AnalysisResultSpectralItemSummary],
    status: &AnalysisResultStatusFacets,
) -> BTreeMap<String, AnalysisResultProjectionResource> {
    let projection_id = "response-sweep";
    let selection_index = items
        .iter()
        .enumerate()
        .map(|(ordinal, item)| AnalysisResultProjectionSelectionEntry {
            ordinal: ordinal as u64,
            sample_id: Some(item.sample_id.clone()),
            item_id: Some(item.item_id.clone()),
            branch_id: item.branch_id.clone(),
        })
        .collect::<Vec<_>>();
    let projection_revision = digest_json(&selection_index);
    let points = items
        .iter()
        .enumerate()
        .map(|(ordinal, item)| AnalysisResultProjectionPoint {
            ordinal: ordinal as u64,
            x: item.frequency_hz,
            y: None,
            value: None,
            sample_id: Some(item.sample_id.clone()),
            item_id: Some(item.item_id.clone()),
            branch_id: item.branch_id.clone(),
            status: item.status.completeness.clone(),
        })
        .collect::<Vec<_>>();
    let projection = AnalysisResultProjectionResource {
        schema_version: ANALYSIS_RESULT_INDEX_SCHEMA_VERSION.to_string(),
        run_id: run_id.to_string(),
        dataset_id: dataset_id.to_string(),
        dataset_revision: dataset_revision.to_string(),
        projection_id: projection_id.to_string(),
        projection_revision,
        axis_labels: BTreeMap::from([
            (String::from("x"), String::from("Drive frequency")),
            (String::from("y"), String::from("Response observable")),
        ]),
        axis_mapping: BTreeMap::from([
            (String::from("x"), String::from("drive-frequency")),
            (String::from("y"), String::from("response-observable")),
        ]),
        axis_units: BTreeMap::from([(String::from("x"), String::from("Hz"))]),
        fixed_coordinates: Vec::new(),
        series: vec![AnalysisResultProjectionSeries {
            series_id: String::from("response"),
            label: String::from("Response observable"),
            points,
        }],
        selection_index,
        status: status.clone(),
        unsupported_reason: Some(String::from(
            "response observable is not published by the typed response-point artifact",
        )),
    };
    BTreeMap::from([(projection_id.to_string(), projection)])
}

fn axis_resource(axis_id: &str, role: &str, value_kind: &str, semantic_id: String, unit_si: String, preferred_display_units: Vec<String>, projections: Vec<AnalysisResultAxisProjection>) -> AnalysisResultAxisResource {
    AnalysisResultAxisResource { axis_id: axis_id.to_string(), role: role.to_string(), value_kind: value_kind.to_string(), semantic_id, label: axis_id.to_string(), symbol: None, unit_si: Some(unit_si), preferred_display_units, ordering: "source_order".to_string(), cardinality: 0, values_resource_key: None, inline_values: None, projections }
}

fn finalize_axis(mut axis: AnalysisResultAxisResource, values: Vec<AnalysisResultAxisValueResource>, sample_count: usize) -> AnalysisResultAxisResource {
    axis.cardinality = values.len().max(sample_count) as u64;
    axis.inline_values = (values.len() <= MAX_INLINE_AXIS_VALUES).then_some(values);
    axis.values_resource_key = Some(format!("axis:{}/values", axis.axis_id));
    axis
}

fn status_facets(resource: &str, execution: &str, completeness: &str, qualification: &str, reason_code: Option<&str>, detail: Option<&str>) -> AnalysisResultStatusFacets {
    AnalysisResultStatusFacets { resource: resource.to_string(), execution: execution.to_string(), completeness: completeness.to_string(), qualification: qualification.to_string(), reason_code: reason_code.map(str::to_string), detail: detail.map(str::to_string) }
}

fn declared_status(status: Option<&str>, complete: Option<bool>, interrupted: bool) -> String {
    if interrupted || status.is_some_and(|status| status.eq_ignore_ascii_case("interrupted")) { return "interrupted".to_string(); }
    if status.is_some_and(|status| status.eq_ignore_ascii_case("corrupt")) { return "corrupt".to_string(); }
    if complete == Some(true) || status.is_some_and(|status| status.eq_ignore_ascii_case("complete")) { "ready".to_string() } else { "partial".to_string() }
}

fn dataset_summary(dataset: &ResultDatasetIndex) -> AnalysisResultDatasetSummaryResource {
    AnalysisResultDatasetSummaryResource { dataset_id: dataset.manifest.dataset_id.clone(), dataset_revision: dataset.manifest.dataset_revision.clone(), run_id: dataset.manifest.run_id.clone(), stage_id: dataset.manifest.stage_id.clone(), product_kind: dataset.manifest.product_kind.clone(), title: dataset.manifest.title.clone(), status: dataset.manifest.status.clone(), sample_count: dataset.samples.len() as u64, item_count: dataset.items.len() as u64, manifest_resource_key: dataset.manifest.sample_index_resource.replace("/samples", "") }
}

fn artifact_digest(artifact_dir: &Path, artifact_path: &str) -> Result<String, ApiError> {
    let path = try_resolve_artifact_path(artifact_dir, artifact_path)?.ok_or_else(|| ApiError::not_found(format!("result artifact '{artifact_path}' was not found")))?;
    let bytes = std::fs::read(path).map_err(|error| ApiError::internal(format!("failed to read result artifact: {error}")))?;
    Ok(format!("sha256:{:x}", Sha256::digest(bytes)))
}

fn derived_dataset_revision(dataset_id: &str, source_revision: &str, axes: &[AnalysisResultAxisResource], sources: &[AnalysisResultSourceArtifactRef]) -> String {
    digest_json(&(ANALYSIS_RESULT_INDEX_SCHEMA_VERSION, dataset_id, source_revision, axes, sources))
}

fn digest_json<T: Serialize>(value: &T) -> String {
    let bytes = serde_json::to_vec(value).expect("result index values must serialize");
    format!("sha256:{:x}", Sha256::digest(bytes))
}

fn encode_path_segment(value: &str) -> String {
    let mut encoded = String::with_capacity(value.len());
    for byte in value.bytes() {
        if byte.is_ascii_alphanumeric() || matches!(byte, b'-' | b'.' | b'_' | b'~') {
            encoded.push(char::from(byte));
        } else {
            encoded.push_str(&format!("%{byte:02X}"));
        }
    }
    encoded
}

fn samples_path(run_id: &str, dataset_id: &str) -> String {
    format!(
        "/v2/sessions/current/analysis/results/runs/{}/datasets/{}/samples",
        encode_path_segment(run_id),
        encode_path_segment(dataset_id),
    )
}

fn axis_values_path(run_id: &str, dataset_id: &str, axis_id: &str) -> String {
    format!(
        "/v2/sessions/current/analysis/results/runs/{}/datasets/{}/axes/{}/values",
        encode_path_segment(run_id),
        encode_path_segment(dataset_id),
        encode_path_segment(axis_id),
    )
}

fn items_path(run_id: &str, dataset_id: &str, sample_id: &str) -> String {
    let base = format!(
        "/v2/sessions/current/analysis/results/runs/{}/datasets/{}/items",
        encode_path_segment(run_id),
        encode_path_segment(dataset_id),
    );
    if sample_id.is_empty() {
        base
    } else {
        format!("{base}?sample_id={}", encode_path_segment(sample_id))
    }
}

fn item_path(run_id: &str, dataset_id: &str, sample_id: &str, item_id: &str) -> String {
    if item_id.is_empty() {
        items_path(run_id, dataset_id, sample_id)
    } else {
        format!(
            "/v2/sessions/current/analysis/results/runs/{}/datasets/{}/items/{}",
            encode_path_segment(run_id),
            encode_path_segment(dataset_id),
            encode_path_segment(item_id),
        )
    }
}

fn projection_path(run_id: &str, dataset_id: &str, projection_id: &str) -> String {
    format!(
        "/v2/sessions/current/analysis/results/runs/{}/datasets/{}/projections/{}",
        encode_path_segment(run_id),
        encode_path_segment(dataset_id),
        encode_path_segment(projection_id),
    )
}

fn branch_points_path(run_id: &str, dataset_id: &str, branch_id: &str) -> String {
    format!(
        "/v2/sessions/current/analysis/results/runs/{}/datasets/{}/branches/{}/points",
        encode_path_segment(run_id),
        encode_path_segment(dataset_id),
        encode_path_segment(branch_id),
    )
}

fn format_frequency(value: f64) -> String { if value.abs() >= 1.0e9 { format!("{:.6} GHz", value / 1.0e9) } else { format!("{value:.6} Hz") } }
fn bias_field_label(field: Option<[f64; 3]>) -> String {
    let Some(field) = field else { return "bias field unavailable".to_string() };
    let magnitude = field.iter().map(|value| value * value).sum::<f64>().sqrt();
    if !magnitude.is_finite() { return "bias field unavailable".to_string(); }
    if magnitude.abs() >= 1.0e-3 {
        format!("μ₀H = {:.3} mT", magnitude * 1.0e3)
    } else {
        format!("μ₀H = {:.6} T", magnitude)
    }
}

fn parse_page_query(query: &HashMap<String, String>) -> Result<ParsedPageQuery, ApiError> {
    const ALLOWED_KEYS: &[&str] = &[
        "cursor",
        "limit",
        "stage_id",
        "product_kind",
        "search",
        "from_si",
        "to_si",
        "sample_id",
        "item_kind",
        "branch_id",
        "status",
        "has_field",
        "has_fields",
        "frequency_min_hz",
        "frequency_max_hz",
        "residual_max",
        "sort",
    ];
    if let Some(key) = query
        .keys()
        .find(|key| !ALLOWED_KEYS.contains(&key.as_str()) && !key.starts_with("coordinate."))
    {
        return Err(ApiError::unprocessable(format!(
            "RESULT_INVALID_FILTER: unsupported query parameter '{key}'"
        )));
    }
    let limit = match query.get("limit") {
        None => DEFAULT_PAGE_LIMIT,
        Some(value) => value.parse::<usize>().map_err(|_| ApiError::unprocessable("RESULT_INVALID_PAGE_LIMIT: limit must be an integer"))?,
    };
    if limit == 0 || limit > MAX_PAGE_LIMIT { return Err(ApiError::unprocessable(format!("RESULT_INVALID_PAGE_LIMIT: limit must be between 1 and {MAX_PAGE_LIMIT}"))); }
    let parse_finite = |key: &str| -> Result<Option<f64>, ApiError> { query.get(key).map(|value| value.parse::<f64>().ok().filter(|number| number.is_finite()).ok_or_else(|| ApiError::unprocessable(format!("RESULT_INVALID_RANGE: {key} must be finite")))).transpose() };
    let frequency_min_hz = parse_finite("frequency_min_hz")?;
    let frequency_max_hz = parse_finite("frequency_max_hz")?;
    if let (Some(min), Some(max)) = (frequency_min_hz, frequency_max_hz) { if min > max { return Err(ApiError::unprocessable("RESULT_INVALID_RANGE: frequency_min_hz must not exceed frequency_max_hz")); } }
    let residual_max = parse_finite("residual_max")?;
    if residual_max.is_some_and(|value| value < 0.0) { return Err(ApiError::unprocessable("RESULT_INVALID_RANGE: residual_max must not be negative")); }
    let has_field = parse_bool_filter(query, "has_field")?;
    let has_fields = parse_bool_filter(query, "has_fields")?;
    if let (Some(has_field), Some(has_fields)) = (has_field, has_fields) {
        if has_field != has_fields {
            return Err(ApiError::unprocessable("RESULT_INVALID_FILTER: has_field and has_fields must agree"));
        }
    }
    let has_field = has_field.or(has_fields);
    let from_si = parse_finite("from_si")?;
    let to_si = parse_finite("to_si")?;
    if let (Some(min), Some(max)) = (from_si, to_si) { if min > max { return Err(ApiError::unprocessable("RESULT_INVALID_RANGE: from_si must not exceed to_si")); } }
    if query
        .get("search")
        .is_some_and(|value| value.chars().count() > 128)
    {
        return Err(ApiError::unprocessable(
            "RESULT_INVALID_FILTER: search must be at most 128 characters",
        ));
    }
    let mut raw = BTreeMap::new();
    for (key, value) in query { if key != "cursor" { raw.insert(key.clone(), value.clone()); } }
    let coordinate_tokens = query
        .iter()
        .filter_map(|(key, value)| key.strip_prefix("coordinate.").map(|axis| (axis.to_string(), value.clone())))
        .collect::<BTreeMap<_, _>>();
    if coordinate_tokens.len() > 16 {
        return Err(ApiError::unprocessable(
            "RESULT_INVALID_FILTER: at most 16 coordinate filters are supported",
        ));
    }
    let sort = query.get("sort").cloned();
    validate_sort(sort.as_deref())?;
    validate_enum_filter(
        query.get("product_kind").map(String::as_str),
        "product_kind",
        &["modal_eigen", "driven_response", "time_domain_spectrum", "dynamic_structure_factor"],
    )?;
    validate_enum_filter(
        query.get("item_kind").map(String::as_str),
        "item_kind",
        &["eigen_mode", "driven_frequency_point", "spectral_feature", "dsf_point"],
    )?;
    Ok(ParsedPageQuery { cursor: query.get("cursor").cloned(), limit, stage_id: query.get("stage_id").cloned(), product_kind: query.get("product_kind").cloned(), search: query.get("search").cloned(), from_si, to_si, sample_id: query.get("sample_id").cloned(), item_kind: query.get("item_kind").cloned(), branch_id: query.get("branch_id").cloned(), status: query.get("status").cloned(), has_field, frequency_min_hz, frequency_max_hz, residual_max, sort, coordinate_tokens, raw })
}

fn validate_enum_filter(
    value: Option<&str>,
    key: &str,
    supported: &[&str],
) -> Result<(), ApiError> {
    if let Some(value) = value {
        if !supported.contains(&value) {
            return Err(ApiError::unprocessable(format!(
                "RESULT_INVALID_FILTER: unsupported {key} '{value}'"
            )));
        }
    }
    Ok(())
}

fn parse_bool_filter(
    query: &HashMap<String, String>,
    key: &str,
) -> Result<Option<bool>, ApiError> {
    query.get(key).map(|value| match value.as_str() {
        "true" => Ok(true),
        "false" => Ok(false),
        _ => Err(ApiError::unprocessable(format!(
            "RESULT_INVALID_FILTER: {key} must be true or false"
        ))),
    }).transpose()
}

fn validate_sort(sort: Option<&str>) -> Result<(), ApiError> {
    let supported = [
        "dataset_id_asc",
        "dataset_id_desc",
        "sample_id_asc",
        "sample_id_desc",
        "sample_index_asc",
        "sample_index_desc",
        "branch_id_asc",
        "branch_id_desc",
        "frequency_asc",
        "frequency_desc",
        "display_index_asc",
        "display_index_desc",
        "item_id_asc",
        "item_id_desc",
    ];
    if let Some(sort) = sort {
        if !supported.contains(&sort) {
            return Err(ApiError::unprocessable(format!(
                "RESULT_INVALID_SORT: unsupported sort '{sort}'"
            )));
        }
    }
    Ok(())
}

fn sort_dataset_summaries(
    datasets: &mut [AnalysisResultDatasetSummaryResource],
    sort: Option<&str>,
) -> Result<(), ApiError> {
    match sort {
        None => {}
        Some("dataset_id_asc") => datasets.sort_by(|left, right| left.dataset_id.cmp(&right.dataset_id)),
        Some("dataset_id_desc") => datasets.sort_by(|left, right| right.dataset_id.cmp(&left.dataset_id)),
        Some(sort) => return Err(ApiError::unprocessable(format!(
            "RESULT_INVALID_SORT: sort '{sort}' is not valid for dataset catalog"
        ))),
    }
    Ok(())
}

fn sort_samples(
    samples: &mut [AnalysisResultSampleIndexEntry],
    sort: Option<&str>,
) -> Result<(), ApiError> {
    match sort {
        None => {}
        Some("sample_id_asc") => samples.sort_by(|left, right| left.sample_id.cmp(&right.sample_id)),
        Some("sample_id_desc") => samples.sort_by(|left, right| right.sample_id.cmp(&left.sample_id)),
        Some("sample_index_asc") => samples.sort_by(|left, right| {
            left.sample_index
                .unwrap_or(u64::MAX)
                .cmp(&right.sample_index.unwrap_or(u64::MAX))
                .then_with(|| left.sample_id.cmp(&right.sample_id))
        }),
        Some("sample_index_desc") => samples.sort_by(|left, right| {
            right
                .sample_index
                .unwrap_or(u64::MIN)
                .cmp(&left.sample_index.unwrap_or(u64::MIN))
                .then_with(|| left.sample_id.cmp(&right.sample_id))
        }),
        Some(sort) => return Err(ApiError::unprocessable(format!(
            "RESULT_INVALID_SORT: sort '{sort}' is not valid for samples"
        ))),
    }
    Ok(())
}

fn sort_items(
    items: &mut [AnalysisResultSpectralItemSummary],
    sort: Option<&str>,
) -> Result<(), ApiError> {
    match sort {
        None => {}
        Some("item_id_asc") => items.sort_by(|left, right| left.item_id.cmp(&right.item_id)),
        Some("item_id_desc") => items.sort_by(|left, right| right.item_id.cmp(&left.item_id)),
        Some("frequency_asc") => items.sort_by(|left, right| {
            left.frequency_hz
                .partial_cmp(&right.frequency_hz)
                .unwrap_or(std::cmp::Ordering::Equal)
                .then_with(|| left.item_id.cmp(&right.item_id))
        }),
        Some("frequency_desc") => items.sort_by(|left, right| {
            right
                .frequency_hz
                .partial_cmp(&left.frequency_hz)
                .unwrap_or(std::cmp::Ordering::Equal)
                .then_with(|| left.item_id.cmp(&right.item_id))
        }),
        Some("display_index_asc") => items.sort_by(|left, right| {
            left.display_index
                .unwrap_or(u64::MAX)
                .cmp(&right.display_index.unwrap_or(u64::MAX))
                .then_with(|| left.item_id.cmp(&right.item_id))
        }),
        Some("display_index_desc") => items.sort_by(|left, right| {
            right
                .display_index
                .unwrap_or(u64::MIN)
                .cmp(&left.display_index.unwrap_or(u64::MIN))
                .then_with(|| left.item_id.cmp(&right.item_id))
        }),
        Some(sort) => return Err(ApiError::unprocessable(format!(
            "RESULT_INVALID_SORT: sort '{sort}' is not valid for items"
        ))),
    }
    Ok(())
}

fn query_digest(query: &ParsedPageQuery, resource: &str) -> String { digest_json(&(resource, &query.raw)) }

fn encode_cursor(
    dataset_revision: &str,
    query: &ParsedPageQuery,
    last_stable_id: &str,
    resource: &str,
) -> String {
    let cursor = ResultPageCursor { schema: 1, dataset_revision: dataset_revision.to_string(), query_digest: query_digest(query, resource), last_stable_id: last_stable_id.to_string() };
    let bytes = serde_json::to_vec(&cursor).expect("cursor serializes");
    base64::engine::general_purpose::URL_SAFE_NO_PAD.encode(bytes)
}

fn decode_cursor(cursor: &str) -> Result<ResultPageCursor, ApiError> {
    let bytes = base64::engine::general_purpose::URL_SAFE_NO_PAD.decode(cursor).map_err(|_| ApiError::bad_request("RESULT_INVALID_CURSOR: cursor is not valid base64url"))?;
    serde_json::from_slice(&bytes).map_err(|_| ApiError::bad_request("RESULT_INVALID_CURSOR: cursor payload is invalid"))
}

fn cursor_start<'a, I>(ids: I, dataset_revision: &str, query: &ParsedPageQuery, resource: &str) -> Result<usize, ApiError>
where I: Iterator<Item = &'a str> {
    let Some(cursor) = query.cursor.as_deref() else { return Ok(0) };
    let cursor = decode_cursor(cursor)?;
    if cursor.schema != 1 || cursor.dataset_revision != dataset_revision || cursor.query_digest != query_digest(query, resource) { return Err(ApiError::conflict_with_code("RESULT_PAGE_CURSOR_STALE", "result page cursor is stale for the current dataset revision, query, or resource")); }
    let ids = ids.collect::<Vec<_>>();
    ids.iter().position(|id| *id == cursor.last_stable_id).map(|index| index + 1).ok_or_else(|| ApiError::conflict_with_code("RESULT_PAGE_CURSOR_STALE", format!("cursor stable id '{}' is no longer present", cursor.last_stable_id)))
}

fn validate_coordinate_filters(dataset: &ResultDatasetIndex, query: &ParsedPageQuery) -> Result<(), ApiError> {
    for (axis_id, token) in &query.coordinate_tokens {
        let values = dataset.axis_values.get(axis_id).ok_or_else(|| ApiError::unprocessable(format!("RESULT_INVALID_AXIS_FILTER: unknown axis '{axis_id}'")))?;
        if !values.iter().any(|value| value.token == *token) { return Err(ApiError::unprocessable(format!("RESULT_UNKNOWN_AXIS_VALUE_TOKEN: unknown value token '{token}' for axis '{axis_id}'"))); }
    }
    Ok(())
}

fn validate_axis_range_filter(
    dataset: &ResultDatasetIndex,
    axis_id: &str,
    query: &ParsedPageQuery,
) -> Result<(), ApiError> {
    if (query.from_si.is_some() || query.to_si.is_some())
        && dataset
            .manifest
            .axes
            .iter()
            .find(|axis| axis.axis_id == axis_id)
            .is_some_and(|axis| axis.value_kind != "scalar")
    {
        return Err(ApiError::unprocessable(format!(
            "RESULT_INVALID_RANGE: axis '{axis_id}' does not publish scalar SI values"
        )));
    }
    Ok(())
}

fn axis_value_matches(value: &AnalysisResultAxisValueResource, query: &ParsedPageQuery) -> bool {
    let search_matches = query.search.as_deref().is_none_or(|search| {
        let search = search.to_lowercase();
        value.token.to_lowercase().contains(&search)
            || value
                .label
                .as_deref()
                .is_some_and(|label| label.to_lowercase().contains(&search))
            || value
                .category
                .as_deref()
                .is_some_and(|category| category.to_lowercase().contains(&search))
            || value
                .entity_ref
                .as_deref()
                .is_some_and(|entity| entity.to_lowercase().contains(&search))
    });
    let range_matches = value.scalar_si.is_none_or(|scalar| {
        query.from_si.is_none_or(|from| scalar >= from)
            && query.to_si.is_none_or(|to| scalar <= to)
    });
    let status_matches = query.status.as_deref().is_none_or(|status| status == value.status);
    search_matches && range_matches && status_matches
}

fn sample_matches(sample: &AnalysisResultSampleIndexEntry, query: &ParsedPageQuery) -> bool {
    if query.sample_id.as_deref().is_some_and(|sample_id| sample_id != sample.sample_id) { return false; }
    if query.status.as_deref().is_some_and(|status| status != sample.status.completeness && status != sample.status.resource) { return false; }
    if query.search.as_deref().is_some_and(|search| {
        let search = search.to_lowercase();
        !sample.sample_id.to_lowercase().contains(&search)
            && !sample.coordinates.iter().any(|coordinate| {
                coordinate.token.to_lowercase().contains(&search)
                    || coordinate.label.as_deref().is_some_and(|label| label.to_lowercase().contains(&search))
            })
    }) { return false; }
    query.coordinate_tokens.iter().all(|(axis_id, token)| sample.coordinates.iter().any(|coordinate| &coordinate.axis_id == axis_id && &coordinate.token == token))
}

fn item_matches(item: &AnalysisResultSpectralItemSummary, query: &ParsedPageQuery, dataset: &ResultDatasetIndex) -> bool {
    if query.sample_id.as_deref().is_some_and(|sample_id| sample_id != item.sample_id) { return false; }
    if query.item_kind.as_deref().is_some_and(|kind| serde_json::to_value(&item.item_kind).ok().and_then(|value| value.as_str().map(str::to_string)).as_deref() != Some(kind)) { return false; }
    if query.branch_id.as_deref().is_some_and(|branch| item.branch_id.as_deref() != Some(branch)) { return false; }
    if query.status.as_deref().is_some_and(|status| status != item.status.completeness && status != item.status.resource) { return false; }
    if query.has_field.is_some_and(|has_field| item.field_ref.is_some() != has_field) { return false; }
    if query.frequency_min_hz.is_some_and(|min| item.frequency_hz.is_none_or(|frequency| frequency < min)) { return false; }
    if query.frequency_max_hz.is_some_and(|max| item.frequency_hz.is_none_or(|frequency| frequency > max)) { return false; }
    if query.residual_max.is_some_and(|max| item.quality.residual_relative_l2.is_none_or(|residual| residual > max)) { return false; }
    if query.search.as_deref().is_some_and(|search| {
        let search = search.to_lowercase();
        !item.item_id.to_lowercase().contains(&search)
            && !item.branch_id.as_deref().is_some_and(|branch| branch.to_lowercase().contains(&search))
            && !item.detail_resource.to_lowercase().contains(&search)
    }) { return false; }
    if !query.coordinate_tokens.is_empty() { dataset.samples.iter().find(|sample| sample.sample_id == item.sample_id).is_some_and(|sample| query.coordinate_tokens.iter().all(|(axis_id, token)| sample.coordinates.iter().any(|coordinate| &coordinate.axis_id == axis_id && &coordinate.token == token))) } else { true }
}

#[cfg(test)]
mod tests {
    use super::*;
    use crate::router_v2::handlers::analysis::frequency_domain::FrequencyDomainArtifactExtras;

    #[test]
    fn page_limit_is_bounded_and_finite_ranges_are_validated() {
        let query = HashMap::from([(String::from("limit"), String::from("501"))]);
        let error = parse_page_query(&query).expect_err("limit must be rejected");
        assert!(error.message.starts_with("RESULT_INVALID_PAGE_LIMIT"));

        let query = HashMap::from([
            (String::from("frequency_min_hz"), String::from("2")),
            (String::from("frequency_max_hz"), String::from("1")),
        ]);
        let error = parse_page_query(&query).expect_err("reversed range must be rejected");
        assert!(error.message.starts_with("RESULT_INVALID_RANGE"));
    }

    #[test]
    fn cursor_binds_revision_and_query_without_exposing_offset() {
        let query = parse_page_query(&HashMap::from([(String::from("limit"), String::from("2"))])).unwrap();
        let encoded = encode_cursor("sha256:revision", &query, "sample-0001", "samples");
        assert!(!encoded.contains("sample-0001"));
        let next_query = parse_page_query(&HashMap::from([
            (String::from("cursor"), encoded.clone()),
            (String::from("limit"), String::from("2")),
        ])).unwrap();
        assert_eq!(cursor_start(["sample-0000", "sample-0001", "sample-0002"].into_iter(), "sha256:revision", &next_query, "samples").unwrap(), 2);
        let stale = parse_page_query(&HashMap::from([
            (String::from("cursor"), encoded.clone()),
            (String::from("limit"), String::from("3")),
        ])).unwrap();
        let error = cursor_start(["sample-0000", "sample-0001"].into_iter(), "sha256:revision", &stale, "samples").expect_err("changed query must stale");
        assert_eq!(error.code.as_deref(), Some("RESULT_PAGE_CURSOR_STALE"));

        let cross_resource_query = parse_page_query(&HashMap::from([
            (String::from("cursor"), encoded),
            (String::from("limit"), String::from("2")),
        ])).unwrap();
        let error = cursor_start(
            ["sample-0000", "sample-0001"].into_iter(),
            "sha256:revision",
            &cross_resource_query,
            "items",
        )
        .expect_err("a samples cursor must not be accepted by items");
        assert_eq!(error.code.as_deref(), Some("RESULT_PAGE_CURSOR_STALE"));
    }

    #[test]
    fn frequency_labels_are_display_only() {
        assert_eq!(format_frequency(2.5e9), "2.500000 GHz");
    }

    #[test]
    fn query_filters_are_bounded_and_has_fields_alias_is_consistent() {
        let query = HashMap::from([(String::from("unknown"), String::from("value"))]);
        let error = parse_page_query(&query).expect_err("unknown filters must be rejected");
        assert!(error.message.starts_with("RESULT_INVALID_FILTER"));

        let query = HashMap::from([(String::from("item_kind"), String::from("mode"))]);
        let error = parse_page_query(&query).expect_err("unknown item kinds must be rejected");
        assert!(error.message.starts_with("RESULT_INVALID_FILTER"));

        let query = HashMap::from([(String::from("search"), "x".repeat(129))]);
        let error = parse_page_query(&query).expect_err("search must be bounded");
        assert!(error.message.starts_with("RESULT_INVALID_FILTER"));

        let query = (1..=17)
            .map(|index| (format!("coordinate.axis-{index}"), String::from("v")))
            .collect::<HashMap<_, _>>();
        let error = parse_page_query(&query).expect_err("coordinate filters must be bounded");
        assert!(error.message.starts_with("RESULT_INVALID_FILTER"));

        let query = HashMap::from([(String::from("has_fields"), String::from("true"))]);
        assert_eq!(parse_page_query(&query).unwrap().has_field, Some(true));
    }

    #[test]
    fn field_sweep_items_keep_their_owner_identity_and_encode_resource_paths() {
        let mesh_ref = Some(AnalysisResultMeshRef {
            mesh_id: "mesh/test".to_string(),
            mesh_revision: Some("mesh-rev-1".to_string()),
            topology_fingerprint: Some(
                "sha256:aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa"
                    .to_string(),
            ),
        });
        let item = field_sweep_item(
            "run/1",
            "dataset/1",
            "sample/1",
            "revision-1",
            FrequencyDomainFieldSweepModePayload {
                sample_id: "sample/1".to_string(),
                mode_id: "mode/1".to_string(),
                raw_mode_index: 3,
                branch_id: Some(7),
                frequency_hz: 2.5e9,
                angular_frequency_rad_per_s: 2.5e9,
                mode_artifact_path: None,
                mode_field_id: Some("field-1".to_string()),
                mode_field_resource_key: Some("data/fields/field-1".to_string()),
                residual_relative_l2: Some(1.0e-8),
                source_revision: "revision-1".to_string(),
                field_status: Some("ready".to_string()),
                status: "ready".to_string(),
                extra: FrequencyDomainArtifactExtras(BTreeMap::new()),
            },
            mesh_ref,
        );

        assert_eq!(item.sample_id, "sample/1");
        assert_eq!(item.status.completeness, "ready");
        assert_eq!(
            item.detail_resource,
            "/v2/sessions/current/analysis/results/runs/run%2F1/datasets/dataset%2F1/items/mode%2F1",
        );
        assert_eq!(
            item.field_ref
                .as_ref()
                .and_then(|field| field.mesh_ref.as_ref())
                .and_then(|mesh| mesh.topology_fingerprint.as_deref()),
            Some("sha256:aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa"),
        );

        let spectrum_only = field_sweep_item(
            "run/1",
            "dataset/1",
            "sample/1",
            "revision-1",
            FrequencyDomainFieldSweepModePayload {
                sample_id: "sample/1".to_string(),
                mode_id: "mode/without-mesh".to_string(),
                raw_mode_index: 4,
                branch_id: None,
                frequency_hz: 2.5e9,
                angular_frequency_rad_per_s: 2.5e9,
                mode_artifact_path: None,
                mode_field_id: Some("field-2".to_string()),
                mode_field_resource_key: Some("data/fields/field-2".to_string()),
                residual_relative_l2: None,
                source_revision: "revision-1".to_string(),
                field_status: Some("ready".to_string()),
                status: "ready".to_string(),
                extra: FrequencyDomainArtifactExtras(BTreeMap::new()),
            },
            None,
        );
        assert!(spectrum_only.field_ref.is_none());
        assert_eq!(
            spectrum_only.status.reason_code.as_deref(),
            Some("field_mesh_identity_not_published")
        );
    }

    #[test]
    fn result_resource_paths_encode_sample_query_values() {
        assert_eq!(
            items_path("run/1", "dataset/1", "sample/1"),
            "/v2/sessions/current/analysis/results/runs/run%2F1/datasets/dataset%2F1/items?sample_id=sample%2F1",
        );
        assert_eq!(
            axis_values_path("run/1", "dataset/1", "bias/field"),
            "/v2/sessions/current/analysis/results/runs/run%2F1/datasets/dataset%2F1/axes/bias%2Ffield/values",
        );
    }

    #[test]
    fn branch_resources_are_derived_from_stable_item_ids() {
        let status = status_facets("ready", "published", "ready", "unvalidated", None, None);
        let dataset = ResultDatasetIndex {
            manifest: AnalysisResultDatasetManifestResource {
                schema_version: ANALYSIS_RESULT_INDEX_SCHEMA_VERSION.to_string(),
                dataset_id: "dataset/1".to_string(),
                dataset_revision: "revision-1".to_string(),
                run_id: "run/1".to_string(),
                stage_id: "stage-1".to_string(),
                product_kind: AnalysisResultProductKind::ModalEigen,
                title: "Modal".to_string(),
                description: None,
                status: status.clone(),
                source_artifacts: Vec::new(),
                axes: Vec::new(),
                item_kinds: vec![AnalysisResultItemKind::EigenMode],
                projections: Vec::new(),
                capabilities: AnalysisResultDatasetCapabilities {
                    sample_paging: true,
                    item_paging: true,
                    server_filtering: true,
                    server_sorting: true,
                    branch_tracking: true,
                    fields: false,
                    result_meshes: false,
                    comparison: false,
                    export: true,
                    live_partial_results: true,
                },
                default_cursor: AnalysisResultDefaultCursor {
                    sample_id: None,
                    item_id: None,
                },
                topology_policy: "shared".to_string(),
                units_policy: "SI".to_string(),
                provenance: BTreeMap::new(),
                sample_index_resource: "samples".to_string(),
                item_index_resource: "items".to_string(),
            },
            samples: vec![AnalysisResultSampleIndexEntry {
                sample_id: "sample/1".to_string(),
                sample_index: Some(4),
                coordinates: Vec::new(),
                status: status.clone(),
                item_count: 1,
                branch_count: Some(1),
                source_revision: "revision-1".to_string(),
                equilibrium_ref: None,
                linearization_ref: None,
                mesh_ref: None,
                items_resource: "items".to_string(),
            }],
            items: vec![AnalysisResultSpectralItemSummary {
                item_id: "mode/1".to_string(),
                item_kind: AnalysisResultItemKind::EigenMode,
                sample_id: "sample/1".to_string(),
                display_index: Some(2),
                frequency_hz: Some(2.5e9),
                wavevector_kf: None,
                branch_id: Some("branch/7".to_string()),
                status: status.clone(),
                quality: AnalysisResultQualitySummary {
                    residual_relative_l2: None,
                    tracking_score: Some(0.99),
                    qualification: "unvalidated".to_string(),
                },
                field_ref: None,
                detail_resource: "item".to_string(),
                source_revision: "revision-1".to_string(),
                relations: Vec::new(),
            }],
            axis_values: BTreeMap::new(),
            projections: BTreeMap::new(),
        };
        let summaries = branch_summaries(&dataset, "run/1", "dataset/1");
        assert_eq!(summaries.len(), 1);
        assert_eq!(summaries[0].branch_id, "branch/7");
        assert_eq!(summaries[0].point_count, 1);
        assert_eq!(
            summaries[0].points_resource,
            "/v2/sessions/current/analysis/results/runs/run%2F1/datasets/dataset%2F1/branches/branch%2F7/points"
        );
        let points = branch_points(&dataset);
        assert_eq!(points["branch/7"][0].item_id, "mode/1");
    }

    #[test]
    fn single_sample_modal_spectrum_has_a_selectable_projection() {
        let axis = finalize_axis(
            axis_resource(
                "frequency",
                "spectral",
                "scalar",
                "frequency_hz".to_string(),
                "Hz".to_string(),
                vec!["GHz".to_string()],
                Vec::new(),
            ),
            Vec::new(),
            1,
        );
        let item = AnalysisResultSpectralItemSummary {
            item_id: "mode-1".to_string(),
            item_kind: AnalysisResultItemKind::EigenMode,
            sample_id: "sample-1".to_string(),
            display_index: Some(0),
            frequency_hz: Some(2.5e9),
            wavevector_kf: None,
            branch_id: None,
            status: status_facets("ready", "published", "ready", "unvalidated", None, None),
            quality: AnalysisResultQualitySummary {
                residual_relative_l2: None,
                tracking_score: None,
                qualification: "unvalidated".to_string(),
            },
            field_ref: None,
            detail_resource: "item".to_string(),
            source_revision: "revision".to_string(),
            relations: Vec::new(),
        };
        let status = status_facets("ready", "published", "ready", "unvalidated", None, None);
        let projection = build_modal_projections(
            "run",
            "dataset",
            "dataset-revision",
            &axis,
            &[AnalysisResultSampleIndexEntry {
                sample_id: "sample-1".to_string(),
                sample_index: Some(0),
                coordinates: Vec::new(),
                status: status.clone(),
                item_count: 1,
                branch_count: None,
                source_revision: "revision".to_string(),
                equilibrium_ref: None,
                linearization_ref: None,
                mesh_ref: None,
                items_resource: "samples".to_string(),
            }],
            &[item],
            &status,
        );
        let projection = projection.get("spectrum").expect("spectrum projection");
        assert_eq!(projection.axis_mapping.get("x").map(String::as_str), Some("frequency_hz"));
        assert_eq!(projection.axis_units.get("y").map(String::as_str), Some("index"));
        assert_eq!(projection.selection_index.len(), 1);
        assert_eq!(projection.series[0].points[0].x, Some(2.5e9));
    }
}
