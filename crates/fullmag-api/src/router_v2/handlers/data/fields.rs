//! Field endpoints — catalog, meta, binary vector (P1 component), and 2D slice (P2).

use std::borrow::Cow;
use std::collections::{BTreeMap, BTreeSet};
use std::io::{BufRead, BufReader, Read};
use std::sync::Arc;

use axum::extract::{Path as AxumPath, Query, State};
use axum::http::{HeaderMap, HeaderName, HeaderValue, StatusCode};
use axum::response::IntoResponse;
use axum::Json;
use serde::Deserialize;
use sha2::{Digest, Sha256};

use super::fdm_region_membership::load_resolved_fdm_membership;
use super::field_resolution::{
    extract_fdm_field, extract_fem_field, fem_magnetic_node_indices,
    field_values_match_current_domain, flatten_json_field_values, is_fdm_snapshot, json_field_grid,
    live_magnetization_available, strict_flat_json_field_values,
};
use crate::artifacts::{read_json_artifact_value, try_resolve_artifact_path};
use crate::error::ApiError;
use crate::fem_slice::{fem_tetra_linear_slice, fem_tetra_slab_slice, SlabAggregation};
use crate::fem_slice_overlay::{
    collect_fem_slice_overlay, cut_norm_from_world, fem_normal_bounds_from_nodes,
    overlay_segments_to_pixel_lines, FemSliceOverlayInput, SliceOverlayBounds,
};
use crate::fem_spatial_index::FemNormalAxisIndex;
use crate::field_projection::{
    component_etag_token, parse_component, project_values, ComponentSelection,
};
use crate::field_render_png::{
    encode_rgba_matrix_png, encode_rgba_matrix_png_with_lines, encode_scalar_png,
    encode_scalar_png_with_lines, AutoScaleMode,
};
use crate::field_slice::{
    fdm_projection, fdm_slice, fem_projection_exact, fem_projection_profile, fem_slice_fallback,
    resolve_projection_profile_query, resolve_projection_query, resolve_slice_query,
    slice_etag_token, FdmField, FemField, FieldProjectionProfileQuery, FieldProjectionQuery,
    FieldSliceQuery, ProjectionResult, ResolvedProjectionQuery, SlicePlane,
};
use crate::field_store::{
    serialize_field_vector_binary_v2, serialize_field_vector_binary_v3, FieldVectorBinaryMetadata,
    FieldVectorIndexing,
};
use crate::orientation_color::apply_magnetization_hsl_rgba;
use crate::preview::{quantity_spatial_domain, quantity_unit};
use crate::quantity_data_plane::{
    projection_empty_mask_cache_key, scalar_projection_cache_key, slice_cache_key,
};
use crate::router_v2::handlers::analysis::hysteresis::read_hysteresis_points_if_available;
use crate::router_v2::handlers::sessions::status::{
    domain_generation_id, domain_generation_revision, fdm_grid_shape,
    field_catalog_revision as current_field_catalog_revision, field_quantity_revision,
};
use crate::schemas::fields::*;
use crate::session::{
    current_artifact_dir, latest_field_source_precedence, preview_cache_precedes_latest,
    preview_field_source_precedence, resolved_current_field_source, ResolvedCurrentFieldSource,
};
use crate::types::AppState;
use crate::types::SessionStateResponse;
use fullmag_quantities::{normalize_quantity_id, quantity_spec};
use fullmag_runner::{FemMeshPayload, RuntimeEngineId};

// ── Response header constants ────────────────────────────────────────────────

static HDR_FIELD_REVISION: &str = "x-fullmag-field-revision";
static HDR_DOMAIN_GEN_ID: &str = "x-fullmag-domain-generation-id";
static HDR_QUANTITY_ID: &str = "x-fullmag-quantity-id";
static HDR_COMPONENT: &str = "x-fullmag-component";
static HDR_ENCODING: &str = "x-fullmag-encoding";
static HDR_POINT_COUNT: &str = "x-fullmag-point-count";
static HDR_VALUE_COUNT: &str = "x-fullmag-value-count";
static HDR_SCOPE_KIND: &str = "x-fullmag-scope-kind";
static HDR_SCOPE_ID: &str = "x-fullmag-scope-id";
static HDR_SNAPSHOT_ID: &str = "x-fullmag-snapshot-id";
static HDR_FIELD_INDEXING: &str = "x-fullmag-field-indexing";
static HDR_NODE_INDEX_COUNT: &str = "x-fullmag-node-index-count";
const HYSTERESIS_ZARR_STORE: &str = "hysteresis.zarr";
const HYSTERESIS_ZARR_M_FIELD: &str = "fields/m";
const FDM_MULTILAYER_AIRBOX_MANIFEST: &str = "fields/H_demag/airbox/manifest.json";
const FDM_MULTILAYER_AIRBOX_FIELD: &str = "fields/H_demag/airbox/H_demag.samples.v1.json";
const FDM_MULTILAYER_AIRBOX_SCHEMA: &str = "fdm_multilayer_observation.v1";
const FDM_MULTILAYER_AIRBOX_FIELD_SCHEMA: &str = "fdm_multilayer_observation_field.v1";
const FDM_MULTILAYER_AIRBOX_H_EFF_REASON: &str = "fdm_multilayer_airbox_h_eff_unavailable.v1";
const STEADY_TRANSPORT_FIELDS: [&str; 5] = [
    "V_electric",
    "J_charge",
    "spin_potential",
    "spin_current_tensor",
    "torque_stt",
];

#[derive(Debug, Clone)]
pub(crate) struct FdmMultilayerAirboxCarrier {
    pub cells: [u32; 3],
    pub origin_m: [f64; 3],
    pub cell_size_m: [f64; 3],
    pub carrier_fingerprint: String,
    pub sample_count: usize,
    pub values: Vec<f64>,
    pub source_policy: String,
    pub source_grid_fingerprints: Vec<String>,
    pub source_runtime_identity: serde_json::Value,
}

fn is_fdm_multilayer_snapshot(snapshot: &SessionStateResponse) -> bool {
    snapshot
        .metadata
        .as_ref()
        .and_then(|metadata| metadata.get("artifact_layout"))
        .and_then(|layout| layout.get("backend"))
        .and_then(serde_json::Value::as_str)
        == Some("fdm_multilayer")
        || snapshot
            .metadata
            .as_ref()
            .and_then(|metadata| metadata.get("execution_plan"))
            .and_then(|plan| plan.get("backend_plan"))
            .and_then(|plan| plan.get("kind"))
            .and_then(serde_json::Value::as_str)
            == Some("fdm_multilayer")
}

fn raw_sha256_hex(value: &str) -> bool {
    value.len() == 64
        && value
            .as_bytes()
            .iter()
            .all(|byte| byte.is_ascii_digit() || (b'a'..=b'f').contains(byte))
}

fn fdm_multilayer_airbox_carrier_fingerprint(
    grid: &serde_json::Value,
    source_grid_fingerprints: &serde_json::Value,
    source_common_grid: &serde_json::Value,
    source_runtime_identity: &serde_json::Value,
    field_artifact_sha256: &str,
) -> Result<String, String> {
    // This seed deliberately mirrors the runner byte-for-byte.  It validates
    // the target-only carrier without using the common transform layout as an
    // observation grid.
    let seed = serde_json::json!({
        "schema_version": FDM_MULTILAYER_AIRBOX_SCHEMA,
        "scope_kind": "airbox",
        "quantity_id": "H_demag",
        "source_policy": "target_only",
        "grid": grid,
        "source_grid_fingerprints": source_grid_fingerprints,
        "source_common_grid": source_common_grid,
        "source_runtime_identity": source_runtime_identity,
        "field_artifact_sha256": field_artifact_sha256,
    });
    let bytes = serde_json::to_vec(&seed)
        .map_err(|error| format!("Airbox carrier fingerprint serialization failed: {error}"))?;
    Ok(format!("{:x}", Sha256::digest(bytes)))
}

fn validated_airbox_grid(
    value: Option<&serde_json::Value>,
    context: &str,
) -> Result<([u32; 3], [f64; 3], [f64; 3]), String> {
    let grid = value
        .and_then(serde_json::Value::as_object)
        .ok_or_else(|| format!("{context} grid is missing or malformed"))?;
    let parse_u32 = |field: &str| -> Result<[u32; 3], String> {
        let values = grid
            .get(field)
            .and_then(serde_json::Value::as_array)
            .filter(|values| values.len() == 3)
            .ok_or_else(|| format!("{context} grid.{field} is missing or malformed"))?;
        let parsed = values
            .iter()
            .map(|value| value.as_u64().and_then(|value| u32::try_from(value).ok()))
            .collect::<Option<Vec<_>>>()
            .ok_or_else(|| format!("{context} grid.{field} must contain u32 values"))?;
        let values = [parsed[0], parsed[1], parsed[2]];
        if values.contains(&0) {
            return Err(format!("{context} grid.{field} must be non-zero"));
        }
        Ok(values)
    };
    let parse_f64 = |field: &str, positive: bool| -> Result<[f64; 3], String> {
        let values = grid
            .get(field)
            .and_then(serde_json::Value::as_array)
            .filter(|values| values.len() == 3)
            .ok_or_else(|| format!("{context} grid.{field} is missing or malformed"))?;
        let parsed = values
            .iter()
            .map(serde_json::Value::as_f64)
            .collect::<Option<Vec<_>>>()
            .ok_or_else(|| format!("{context} grid.{field} must contain finite numbers"))?;
        let values = [parsed[0], parsed[1], parsed[2]];
        if values
            .iter()
            .any(|value| !value.is_finite() || (positive && *value <= 0.0))
        {
            return Err(format!("{context} grid.{field} contains invalid values"));
        }
        Ok(values)
    };
    Ok((
        parse_u32("cells")?,
        parse_f64("origin_m", false)?,
        parse_f64("cell_size_m", true)?,
    ))
}

fn read_required_string<'a>(
    value: &'a serde_json::Value,
    field: &str,
    context: &str,
) -> Result<&'a str, String> {
    value
        .get(field)
        .and_then(serde_json::Value::as_str)
        .filter(|value| !value.is_empty())
        .ok_or_else(|| format!("{context} {field} is missing or malformed"))
}

/// Reads the runner-origin Airbox carrier without ever projecting it onto the
/// common FFT layout.  A malformed carrier is deliberately indistinguishable
/// from an unavailable field to browser callers, but is retained here as a
/// detailed reason for the layout resource and diagnostics.
pub(crate) fn load_fdm_multilayer_airbox_carrier(
    snapshot: &SessionStateResponse,
) -> Result<Option<FdmMultilayerAirboxCarrier>, String> {
    if !is_fdm_multilayer_snapshot(snapshot) {
        return Ok(None);
    }
    let Some(artifact_dir) = current_artifact_dir(snapshot) else {
        return Ok(None);
    };
    let manifest_path = try_resolve_artifact_path(&artifact_dir, FDM_MULTILAYER_AIRBOX_MANIFEST)
        .map_err(|error| format!("failed to resolve Airbox manifest: {error}"))?;
    let Some(_) = manifest_path else {
        return Ok(None);
    };
    let manifest = read_json_artifact_value(&artifact_dir, FDM_MULTILAYER_AIRBOX_MANIFEST)
        .map_err(|error| format!("failed to read Airbox manifest: {error}"))?;
    if read_required_string(&manifest, "schema_version", "Airbox manifest")?
        != FDM_MULTILAYER_AIRBOX_SCHEMA
        || read_required_string(&manifest, "scope_kind", "Airbox manifest")? != "airbox"
        || read_required_string(&manifest, "quantity_id", "Airbox manifest")? != "H_demag"
        || read_required_string(&manifest, "unit", "Airbox manifest")? != "A/m"
        || read_required_string(&manifest, "source_policy", "Airbox manifest")? != "target_only"
        || manifest
            .get("target_only")
            .and_then(serde_json::Value::as_bool)
            != Some(true)
        || manifest.get("published_quantities") != Some(&serde_json::json!(["H_demag"]))
        || manifest
            .get("unavailable_quantities")
            .and_then(|value| value.get("H_eff"))
            .and_then(serde_json::Value::as_str)
            != Some(FDM_MULTILAYER_AIRBOX_H_EFF_REASON)
    {
        return Err("Airbox manifest identity, target-only, or H_eff contract is invalid".into());
    }
    let manifest_grid = manifest
        .get("grid")
        .ok_or_else(|| "Airbox manifest grid is missing".to_string())?;
    let (cells, origin_m, cell_size_m) =
        validated_airbox_grid(Some(manifest_grid), "Airbox manifest")?;
    let carrier_fingerprint =
        read_required_string(&manifest, "carrier_fingerprint", "Airbox manifest")?;
    if !raw_sha256_hex(carrier_fingerprint) {
        return Err("Airbox manifest carrier_fingerprint must be canonical raw sha256 hex".into());
    }
    let source_grid_fingerprints_value = manifest
        .get("source_grid_fingerprints")
        .and_then(serde_json::Value::as_array)
        .filter(|values| !values.is_empty())
        .ok_or_else(|| {
            "Airbox manifest source_grid_fingerprints is missing or empty".to_string()
        })?;
    let source_grid_fingerprints = source_grid_fingerprints_value
        .iter()
        .map(serde_json::Value::as_str)
        .collect::<Option<Vec<_>>>()
        .ok_or_else(|| "Airbox manifest source_grid_fingerprints is malformed".to_string())?;
    if source_grid_fingerprints
        .iter()
        .any(|value| !raw_sha256_hex(value))
    {
        return Err("Airbox manifest source_grid_fingerprints must use raw sha256 hex".into());
    }
    let source_common_grid = manifest
        .get("source_common_grid")
        .filter(|value| value.is_object())
        .ok_or_else(|| "Airbox manifest source_common_grid is missing or malformed".to_string())?;
    let _ = validated_airbox_grid(Some(source_common_grid), "Airbox source_common_grid")?;
    let source_runtime_identity = manifest
        .get("source_runtime_identity")
        .filter(|value| value.is_object())
        .cloned()
        .ok_or_else(|| {
            "Airbox manifest source_runtime_identity is missing or malformed".to_string()
        })?;
    for field in [
        "execution_engine",
        "precision",
        "demag_operator_kind",
        "fft_backend",
        "problem_source_hash",
        "run_status",
    ] {
        read_required_string(
            &source_runtime_identity,
            field,
            "Airbox source_runtime_identity",
        )?;
    }
    if read_required_string(&manifest, "field_artifact", "Airbox manifest")?
        != "H_demag.samples.v1.json"
    {
        return Err("Airbox manifest field_artifact is not the canonical H_demag carrier".into());
    }
    let expected_field_hash =
        read_required_string(&manifest, "field_artifact_sha256", "Airbox manifest")?;
    if !raw_sha256_hex(expected_field_hash) {
        return Err(
            "Airbox manifest field_artifact_sha256 must be canonical raw sha256 hex".into(),
        );
    }
    let field_path = try_resolve_artifact_path(&artifact_dir, FDM_MULTILAYER_AIRBOX_FIELD)
        .map_err(|error| format!("failed to resolve Airbox field artifact: {error}"))?
        .ok_or_else(|| "Airbox field artifact is missing".to_string())?;
    let field_bytes = std::fs::read(&field_path)
        .map_err(|error| format!("failed to read Airbox field artifact: {error}"))?;
    let actual_field_hash = format!("{:x}", Sha256::digest(&field_bytes));
    if actual_field_hash != expected_field_hash {
        return Err("Airbox field artifact sha256 does not match manifest".into());
    }
    let field_payload: serde_json::Value = serde_json::from_slice(&field_bytes)
        .map_err(|error| format!("Airbox field artifact is malformed JSON: {error}"))?;
    if read_required_string(&field_payload, "schema_version", "Airbox field artifact")?
        != FDM_MULTILAYER_AIRBOX_FIELD_SCHEMA
        || read_required_string(&field_payload, "observable", "Airbox field artifact")? != "H_demag"
        || read_required_string(&field_payload, "quantity_id", "Airbox field artifact")?
            != "H_demag"
        || read_required_string(&field_payload, "scope_kind", "Airbox field artifact")? != "airbox"
        || read_required_string(&field_payload, "unit", "Airbox field artifact")? != "A/m"
    {
        return Err("Airbox field artifact identity is invalid".into());
    }
    let field_grid = validated_airbox_grid(field_payload.get("grid"), "Airbox field artifact")?;
    if field_grid != (cells, origin_m, cell_size_m) {
        return Err("Airbox field artifact grid disagrees with manifest target grid".into());
    }
    let vectors = field_payload
        .get("values")
        .and_then(serde_json::Value::as_array)
        .filter(|values| !values.is_empty())
        .ok_or_else(|| "Airbox field artifact values are missing or empty".to_string())?;
    let mut values = Vec::with_capacity(vectors.len() * 3);
    for vector in vectors {
        let vector = vector
            .as_array()
            .filter(|values| values.len() == 3)
            .ok_or_else(|| "Airbox field artifact values must contain f64 triplets".to_string())?;
        for value in vector {
            let value = value
                .as_f64()
                .filter(|value| value.is_finite())
                .ok_or_else(|| {
                    "Airbox field artifact values contain non-finite data".to_string()
                })?;
            values.push(value);
        }
    }
    let sample_count = manifest
        .get("sample_count")
        .and_then(serde_json::Value::as_u64)
        .and_then(|value| usize::try_from(value).ok())
        .filter(|value| *value > 0)
        .ok_or_else(|| "Airbox manifest sample_count is missing or invalid".to_string())?;
    let grid_count = cells
        .iter()
        .try_fold(1usize, |total, axis| total.checked_mul(*axis as usize))
        .ok_or_else(|| "Airbox target grid cell count overflows usize".to_string())?;
    if sample_count != vectors.len()
        || sample_count != grid_count
        || values.len() != sample_count * 3
    {
        return Err("Airbox sample_count, target grid, and vector value count disagree".into());
    }
    let expected_carrier_fingerprint = fdm_multilayer_airbox_carrier_fingerprint(
        manifest_grid,
        &serde_json::Value::Array(source_grid_fingerprints_value.clone()),
        source_common_grid,
        &source_runtime_identity,
        expected_field_hash,
    )?;
    if carrier_fingerprint != expected_carrier_fingerprint {
        return Err(
            "Airbox manifest carrier_fingerprint does not match runner carrier seed".into(),
        );
    }
    Ok(Some(FdmMultilayerAirboxCarrier {
        cells,
        origin_m,
        cell_size_m,
        carrier_fingerprint: carrier_fingerprint.to_string(),
        sample_count,
        values,
        source_policy: "target_only".to_string(),
        source_grid_fingerprints: source_grid_fingerprints
            .into_iter()
            .map(str::to_string)
            .collect(),
        source_runtime_identity,
    }))
}

fn requested_fdm_multilayer_airbox_carrier(
    snapshot: &SessionStateResponse,
    query: &FieldVectorQuery,
    quantity_id: &str,
) -> Result<Option<FdmMultilayerAirboxCarrier>, ApiError> {
    if query.scope_kind.as_deref().map(str::trim) != Some("airbox")
        || !is_fdm_multilayer_snapshot(snapshot)
    {
        return Ok(None);
    }
    if query
        .scope_id
        .as_deref()
        .is_some_and(|scope_id| !scope_id.is_empty() && scope_id != "airbox")
    {
        return Err(ApiError::not_found("multilayer FDM Airbox scope not found"));
    }
    let carrier = load_fdm_multilayer_airbox_carrier(snapshot)
        .map_err(|reason| {
            ApiError::not_found(format!(
                "multilayer FDM Airbox carrier unavailable: {reason}"
            ))
        })?
        .ok_or_else(|| ApiError::not_found("multilayer FDM Airbox carrier is unavailable"))?;
    if quantity_id == "H_eff" {
        return Err(ApiError::not_found(format!(
            "multilayer FDM Airbox H_eff is unavailable: {FDM_MULTILAYER_AIRBOX_H_EFF_REASON}"
        )));
    }
    if quantity_id != "H_demag" {
        return Err(ApiError::not_found(format!(
            "field '{quantity_id}' is not published on the multilayer FDM Airbox carrier"
        )));
    }
    Ok(Some(carrier))
}

fn fdm_multilayer_airbox_scope(carrier: &FdmMultilayerAirboxCarrier) -> ResolvedFieldScope {
    ResolvedFieldScope {
        domain: ResolvedFieldScopeDomain::Air,
        kind: "airbox".to_string(),
        id: Some("airbox".to_string()),
        node_indices: (0..carrier.sample_count).collect(),
        value_indices: (0..carrier.sample_count).collect(),
        grid: Some(carrier.cells),
        carrier_hash: Some(format!("sha256:{}", carrier.carrier_fingerprint)),
    }
}

fn canonical_transport_field_artifact(
    snapshot: &SessionStateResponse,
    quantity_id: &str,
) -> Result<Option<serde_json::Value>, ApiError> {
    if !STEADY_TRANSPORT_FIELDS.contains(&quantity_id) {
        return Ok(None);
    }
    let Some(artifact_dir) = current_artifact_dir(snapshot) else {
        return Ok(None);
    };
    let relative_path = format!("fields/{quantity_id}/step_000000.json");
    if try_resolve_artifact_path(&artifact_dir, &relative_path)?.is_none() {
        return Ok(None);
    }
    let artifact = read_json_artifact_value(&artifact_dir, &relative_path)?;
    let component_count = artifact
        .get("component_count")
        .and_then(serde_json::Value::as_u64)
        .and_then(|value| usize::try_from(value).ok());
    let expected_components = quantity_spec(quantity_id).map(|spec| spec.n_comp as usize);
    let revision = artifact
        .get("revision")
        .and_then(serde_json::Value::as_u64)
        .unwrap_or(0);
    let values = strict_flat_json_field_values(&artifact).ok_or_else(|| {
        ApiError::internal(format!(
            "canonical transport field artifact '{relative_path}' values must be one flat array of finite JSON numbers"
        ))
    })?;
    if artifact
        .get("observable")
        .and_then(serde_json::Value::as_str)
        != Some(quantity_id)
        || component_count != expected_components
        || component_count.is_none_or(|count| count == 0 || values.len() % count != 0)
        || revision == 0
    {
        return Err(ApiError::internal(format!(
            "canonical transport field artifact '{relative_path}' has invalid identity, shape, values, or revision"
        )));
    }
    Ok(Some(artifact))
}

fn canonical_transport_field_artifact_revision(artifact: Option<&serde_json::Value>) -> u64 {
    artifact
        .and_then(|value| value.get("revision"))
        .and_then(serde_json::Value::as_u64)
        .unwrap_or(0)
}

#[derive(Debug)]
struct HysteresisZarrSampleRef {
    sample_index: Option<String>,
    point_id: Option<String>,
    field_value_m_t: Option<String>,
    quantity_id: Option<String>,
    branch_id: Option<String>,
    protocol_role: Option<String>,
    mesh_identity: Option<String>,
    field_revision: Option<String>,
    chunk_key: String,
    cell_count: usize,
    grid: [u32; 3],
}

fn canonical_quantity_id(requested: &str) -> Cow<'_, str> {
    normalize_quantity_id(requested)
        .map(|id| Cow::Borrowed(id.as_str()))
        .unwrap_or_else(|_| Cow::Borrowed(requested))
}

pub(crate) fn persisted_hysteresis_magnetization_values(
    snapshot: &SessionStateResponse,
    snapshot_id: &str,
) -> Result<(Vec<f64>, [u32; 3]), ApiError> {
    let snapshot_id = snapshot_id.trim();
    if snapshot_id.is_empty() {
        return Err(ApiError::bad_request("snapshot_id must not be empty"));
    }
    if snapshot_id.contains('/')
        || snapshot_id.contains('\\')
        || snapshot_id == "."
        || snapshot_id == ".."
    {
        return Err(ApiError::bad_request(
            "snapshot_id must be a single path segment",
        ));
    }
    let artifact_dir = current_artifact_dir(snapshot)
        .ok_or_else(|| ApiError::not_found("no artifact directory for persisted field snapshot"))?;
    if let Some((values, grid)) =
        persisted_hysteresis_zarr_magnetization_values(&artifact_dir, snapshot_id)?
    {
        validate_persisted_hysteresis_snapshot_domain(snapshot, snapshot_id, &values, grid)?;
        return Ok((values, grid));
    }
    let path = artifact_dir
        .join("hysteresis_snapshots")
        .join(snapshot_id)
        .join("m.json");
    let content = std::fs::read_to_string(&path).map_err(|error| {
        if error.kind() == std::io::ErrorKind::NotFound {
            ApiError::not_found(format!("hysteresis snapshot '{snapshot_id}' was not found"))
        } else {
            ApiError::internal(format!(
                "failed to read hysteresis snapshot '{}': {}",
                snapshot_id, error
            ))
        }
    })?;
    let raw: serde_json::Value = serde_json::from_str(&content).map_err(|error| {
        ApiError::internal(format!(
            "failed to parse hysteresis snapshot '{}': {}",
            snapshot_id, error
        ))
    })?;
    let values = flatten_json_field_values(&raw);
    let element_count = values.len() / 3;
    let grid = json_field_grid(&raw).unwrap_or([element_count as u32, 1, 1]);
    validate_persisted_hysteresis_snapshot_domain(snapshot, snapshot_id, &values, grid)?;
    Ok((values, grid))
}

pub(crate) async fn validate_hysteresis_snapshot_stage_scope(
    state: &Arc<AppState>,
    stage_id: Option<&str>,
    snapshot_id: &str,
) -> Result<(), ApiError> {
    let Some(stage_id) = stage_id.map(str::trim).filter(|id| !id.is_empty()) else {
        return Ok(());
    };
    if stage_id.contains('/') || stage_id.contains('\\') || stage_id == "." || stage_id == ".." {
        return Err(ApiError::bad_request(
            "stage_id must be a single path segment",
        ));
    }
    let points = read_hysteresis_points_if_available(state, stage_id).await?;
    if points
        .iter()
        .any(|point| point.snapshot_id.as_deref() == Some(snapshot_id))
    {
        return Ok(());
    }
    Err(ApiError::not_found(format!(
        "hysteresis snapshot '{snapshot_id}' is not registered for stage '{stage_id}'"
    )))
}

fn validate_persisted_hysteresis_snapshot_domain(
    snapshot: &SessionStateResponse,
    snapshot_id: &str,
    values: &[f64],
    grid: [u32; 3],
) -> Result<(), ApiError> {
    let element_count = values.len() / 3;
    let grid_count = (grid[0] as usize)
        .checked_mul(grid[1] as usize)
        .and_then(|count| count.checked_mul(grid[2] as usize))
        .ok_or_else(|| {
            ApiError::conflict(format!(
                "hysteresis snapshot '{snapshot_id}' grid dimensions overflow"
            ))
        })?;
    if grid_count != element_count {
        return Err(ApiError::conflict(format!(
            "hysteresis snapshot '{snapshot_id}' grid does not match its magnetization payload"
        )));
    }
    if !field_values_match_current_domain(snapshot, "m", 3, values) {
        return Err(ApiError::conflict(format!(
            "hysteresis snapshot '{snapshot_id}' does not match the current magnetic domain"
        )));
    }
    Ok(())
}

fn persisted_hysteresis_zarr_magnetization_values(
    artifact_dir: &std::path::Path,
    snapshot_id: &str,
) -> Result<Option<(Vec<f64>, [u32; 3])>, ApiError> {
    let field_dir = artifact_dir
        .join(HYSTERESIS_ZARR_STORE)
        .join(HYSTERESIS_ZARR_M_FIELD);
    let Some(sample_ref) =
        find_hysteresis_zarr_sample(&field_dir.join("samples.csv"), snapshot_id)?
    else {
        return Ok(None);
    };
    validate_hysteresis_zarr_root_point_index(
        &artifact_dir.join(HYSTERESIS_ZARR_STORE).join("points.csv"),
        snapshot_id,
        &sample_ref,
    )?;
    let chunk_path = field_dir.join(&sample_ref.chunk_key);
    let mut raw = Vec::new();
    std::fs::File::open(&chunk_path)
        .map_err(|error| {
            ApiError::internal(format!(
                "failed to open hysteresis Zarr chunk '{}': {}",
                chunk_path.display(),
                error
            ))
        })?
        .read_to_end(&mut raw)
        .map_err(|error| {
            ApiError::internal(format!(
                "failed to read hysteresis Zarr chunk '{}': {}",
                chunk_path.display(),
                error
            ))
        })?;
    let expected_len = sample_ref.cell_count * 3 * std::mem::size_of::<f64>();
    if raw.len() != expected_len {
        return Err(ApiError::internal(format!(
            "hysteresis Zarr chunk '{}' has {} bytes, expected {}",
            chunk_path.display(),
            raw.len(),
            expected_len
        )));
    }
    let mut values = vec![0.0; sample_ref.cell_count * 3];
    for component in 0..3 {
        for cell in 0..sample_ref.cell_count {
            let source_offset = (component * sample_ref.cell_count + cell) * 8;
            let mut bytes = [0_u8; 8];
            bytes.copy_from_slice(&raw[source_offset..source_offset + 8]);
            values[cell * 3 + component] = f64::from_le_bytes(bytes);
        }
    }
    Ok(Some((values, sample_ref.grid)))
}

fn find_hysteresis_zarr_sample(
    samples_path: &std::path::Path,
    snapshot_id: &str,
) -> Result<Option<HysteresisZarrSampleRef>, ApiError> {
    if !samples_path.exists() {
        return Ok(None);
    }
    let file = std::fs::File::open(samples_path).map_err(|error| {
        ApiError::internal(format!(
            "failed to open hysteresis Zarr sample index '{}': {}",
            samples_path.display(),
            error
        ))
    })?;
    let mut lines = BufReader::new(file).lines();
    let Some(header_line) = lines.next().transpose().map_err(|error| {
        ApiError::internal(format!(
            "failed to read hysteresis Zarr sample index '{}': {}",
            samples_path.display(),
            error
        ))
    })?
    else {
        return Ok(None);
    };
    let headers: Vec<&str> = header_line.split(',').collect();
    let column_index = |name: &str| {
        headers
            .iter()
            .position(|header| header.trim() == name)
            .ok_or_else(|| {
                ApiError::internal(format!(
                    "hysteresis Zarr sample index '{}' is missing '{}' column",
                    samples_path.display(),
                    name
                ))
            })
    };
    let snapshot_col = column_index("snapshot_id")?;
    let chunk_col = column_index("chunk_key")?;
    let cell_count_col = column_index("cell_count")?;
    let grid_x_col = column_index("grid_x")?;
    let grid_y_col = column_index("grid_y")?;
    let grid_z_col = column_index("grid_z")?;
    let optional_column = |name: &str| headers.iter().position(|header| header.trim() == name);
    let sample_index_col = optional_column("sample_index").or_else(|| optional_column("sample"));
    let point_id_col = optional_column("point_id");
    let field_value_col = optional_column("field_value_mT");
    let quantity_col = optional_column("quantity_id");
    let branch_col = optional_column("branch_id");
    let protocol_role_col = optional_column("protocol_role");
    let mesh_identity_col = optional_column("mesh_identity");
    let field_revision_col = optional_column("field_revision");

    for line in lines {
        let line = line.map_err(|error| {
            ApiError::internal(format!(
                "failed to read hysteresis Zarr sample index '{}': {}",
                samples_path.display(),
                error
            ))
        })?;
        let columns: Vec<&str> = line.split(',').collect();
        if columns
            .get(snapshot_col)
            .is_none_or(|candidate| *candidate != snapshot_id)
        {
            continue;
        }
        let parse_column = |index: usize, name: &str| -> Result<&str, ApiError> {
            columns.get(index).copied().ok_or_else(|| {
                ApiError::internal(format!(
                    "hysteresis Zarr sample row for snapshot '{snapshot_id}' is missing '{}' column",
                    name
                ))
            })
        };
        let cell_count = parse_column(cell_count_col, "cell_count")?
            .parse::<usize>()
            .map_err(|error| {
                ApiError::internal(format!(
                    "invalid hysteresis Zarr cell_count for snapshot '{snapshot_id}': {error}"
                ))
            })?;
        let grid = [
            parse_column(grid_x_col, "grid_x")?
                .parse::<u32>()
                .map_err(|error| {
                    ApiError::internal(format!(
                        "invalid hysteresis Zarr grid_x for snapshot '{snapshot_id}': {error}"
                    ))
                })?,
            parse_column(grid_y_col, "grid_y")?
                .parse::<u32>()
                .map_err(|error| {
                    ApiError::internal(format!(
                        "invalid hysteresis Zarr grid_y for snapshot '{snapshot_id}': {error}"
                    ))
                })?,
            parse_column(grid_z_col, "grid_z")?
                .parse::<u32>()
                .map_err(|error| {
                    ApiError::internal(format!(
                        "invalid hysteresis Zarr grid_z for snapshot '{snapshot_id}': {error}"
                    ))
                })?,
        ];
        let optional_value =
            |index: Option<usize>| index.and_then(|column| columns.get(column).copied());
        return Ok(Some(HysteresisZarrSampleRef {
            sample_index: optional_value(sample_index_col).map(str::to_string),
            point_id: optional_value(point_id_col).map(str::to_string),
            field_value_m_t: optional_value(field_value_col).map(str::to_string),
            quantity_id: optional_value(quantity_col).map(str::to_string),
            branch_id: optional_value(branch_col).map(str::to_string),
            protocol_role: optional_value(protocol_role_col).map(str::to_string),
            mesh_identity: optional_value(mesh_identity_col).map(str::to_string),
            field_revision: optional_value(field_revision_col).map(str::to_string),
            chunk_key: parse_column(chunk_col, "chunk_key")?.to_string(),
            cell_count,
            grid,
        }));
    }
    Ok(None)
}

fn validate_hysteresis_zarr_root_point_index(
    points_path: &std::path::Path,
    snapshot_id: &str,
    sample_ref: &HysteresisZarrSampleRef,
) -> Result<(), ApiError> {
    let file = std::fs::File::open(points_path).map_err(|error| {
        ApiError::internal(format!(
            "failed to open hysteresis Zarr root point index '{}': {}",
            points_path.display(),
            error
        ))
    })?;
    let mut lines = BufReader::new(file).lines();
    let Some(header_line) = lines.next().transpose().map_err(|error| {
        ApiError::internal(format!(
            "failed to read hysteresis Zarr root point index '{}': {}",
            points_path.display(),
            error
        ))
    })?
    else {
        return Err(ApiError::internal(format!(
            "hysteresis Zarr root point index '{}' is empty",
            points_path.display()
        )));
    };
    let headers: Vec<&str> = header_line.split(',').collect();
    let column_index = |name: &str| {
        headers
            .iter()
            .position(|header| header.trim() == name)
            .ok_or_else(|| {
                ApiError::internal(format!(
                    "hysteresis Zarr root point index '{}' is missing '{}' column",
                    points_path.display(),
                    name
                ))
            })
    };
    let snapshot_col = column_index("snapshot_id")?;
    let chunk_col = column_index("chunk_key")?;
    let cell_count_col = column_index("cell_count")?;
    let grid_x_col = column_index("grid_x")?;
    let grid_y_col = column_index("grid_y")?;
    let grid_z_col = column_index("grid_z")?;
    let optional_column = |name: &str| headers.iter().position(|header| header.trim() == name);
    let sample_index_col = optional_column("sample_index").or_else(|| optional_column("sample"));
    let point_id_col = optional_column("point_id");
    let field_value_col = optional_column("field_value_mT");
    let quantity_col = optional_column("quantity_id");
    let branch_col = optional_column("branch_id");
    let protocol_role_col = optional_column("protocol_role");
    let mesh_identity_col = optional_column("mesh_identity");
    let field_revision_col = optional_column("field_revision");

    for line in lines {
        let line = line.map_err(|error| {
            ApiError::internal(format!(
                "failed to read hysteresis Zarr root point index '{}': {}",
                points_path.display(),
                error
            ))
        })?;
        let columns: Vec<&str> = line.split(',').collect();
        if columns
            .get(snapshot_col)
            .is_none_or(|candidate| *candidate != snapshot_id)
        {
            continue;
        }
        let parse_column = |index: usize, name: &str| -> Result<&str, ApiError> {
            columns.get(index).copied().ok_or_else(|| {
                ApiError::internal(format!(
                    "hysteresis Zarr root point row for snapshot '{snapshot_id}' is missing '{}' column",
                    name
                ))
            })
        };
        let require_optional_match = |column: Option<usize>,
                                      expected: &Option<String>,
                                      name: &str|
         -> Result<(), ApiError> {
            if let (Some(column), Some(expected)) = (column, expected) {
                let actual = parse_column(column, name)?;
                if actual != expected {
                    return Err(ApiError::internal(format!(
                        "hysteresis Zarr root point index {name} mismatch for snapshot '{snapshot_id}': got {actual:?}, expected {expected:?}"
                    )));
                }
            }
            Ok(())
        };
        require_optional_match(sample_index_col, &sample_ref.sample_index, "sample_index")?;
        require_optional_match(point_id_col, &sample_ref.point_id, "point_id")?;
        require_optional_match(
            field_value_col,
            &sample_ref.field_value_m_t,
            "field_value_mT",
        )?;
        require_optional_match(quantity_col, &sample_ref.quantity_id, "quantity_id")?;
        require_optional_match(branch_col, &sample_ref.branch_id, "branch_id")?;
        require_optional_match(
            protocol_role_col,
            &sample_ref.protocol_role,
            "protocol_role",
        )?;
        require_optional_match(
            mesh_identity_col,
            &sample_ref.mesh_identity,
            "mesh_identity",
        )?;
        require_optional_match(
            field_revision_col,
            &sample_ref.field_revision,
            "field_revision",
        )?;
        let expected_chunk_key = format!("{HYSTERESIS_ZARR_M_FIELD}/{}", sample_ref.chunk_key);
        let actual_chunk_key = parse_column(chunk_col, "chunk_key")?;
        if actual_chunk_key != expected_chunk_key {
            return Err(ApiError::internal(format!(
                "hysteresis Zarr root point index chunk_key mismatch for snapshot '{snapshot_id}': got {actual_chunk_key:?}, expected {expected_chunk_key:?}"
            )));
        }
        let parse_usize = |index: usize, name: &str| -> Result<usize, ApiError> {
            parse_column(index, name)?.parse::<usize>().map_err(|error| {
                ApiError::internal(format!(
                    "invalid hysteresis Zarr root point index {name} for snapshot '{snapshot_id}': {error}"
                ))
            })
        };
        let cell_count = parse_usize(cell_count_col, "cell_count")?;
        let grid = [
            parse_usize(grid_x_col, "grid_x")? as u32,
            parse_usize(grid_y_col, "grid_y")? as u32,
            parse_usize(grid_z_col, "grid_z")? as u32,
        ];
        if cell_count != sample_ref.cell_count || grid != sample_ref.grid {
            return Err(ApiError::internal(format!(
                "hysteresis Zarr root point index grid/cell mismatch for snapshot '{snapshot_id}'"
            )));
        }
        return Ok(());
    }
    Err(ApiError::internal(format!(
        "hysteresis Zarr root point index '{}' has no row for snapshot '{}'",
        points_path.display(),
        snapshot_id
    )))
}

fn insert_field_headers(
    resp: &mut axum::response::Response,
    quantity_id: &str,
    component: &ComponentSelection,
    field_revision: u64,
    domain_gen_id: &str,
    point_count: usize,
    value_count: usize,
) {
    let h = resp.headers_mut();
    let insert_str = |hm: &mut axum::http::HeaderMap, name, val: String| {
        if let Ok(v) = HeaderValue::from_str(&val) {
            hm.insert(name, v);
        }
    };
    insert_str(
        h,
        axum::http::HeaderName::from_static(HDR_FIELD_REVISION),
        field_revision.to_string(),
    );
    insert_str(
        h,
        axum::http::HeaderName::from_static(HDR_DOMAIN_GEN_ID),
        domain_gen_id.to_string(),
    );
    insert_str(
        h,
        axum::http::HeaderName::from_static(HDR_QUANTITY_ID),
        quantity_id.to_string(),
    );
    let comp_str = match component {
        ComponentSelection::Full => "full".to_string(),
        ComponentSelection::Magnitude => "magnitude".to_string(),
        ComponentSelection::MagnitudeSquared => "magnitude_squared".to_string(),
        ComponentSelection::AbsIndex(i) => format!("abs_c{}", i),
        ComponentSelection::Index(i) => format!("c{}", i),
    };
    insert_str(
        h,
        axum::http::HeaderName::from_static(HDR_COMPONENT),
        comp_str,
    );
    insert_str(
        h,
        axum::http::HeaderName::from_static(HDR_ENCODING),
        "FMVP;version=2".to_string(),
    );
    insert_str(
        h,
        axum::http::HeaderName::from_static(HDR_POINT_COUNT),
        point_count.to_string(),
    );
    insert_str(
        h,
        axum::http::HeaderName::from_static(HDR_VALUE_COUNT),
        value_count.to_string(),
    );
    let n_comp_out = if point_count > 0 {
        value_count / point_count
    } else {
        0
    };
    insert_str(
        h,
        axum::http::HeaderName::from_static("x-fullmag-n-comp"),
        n_comp_out.to_string(),
    );
}

fn insert_scope_headers(resp: &mut axum::response::Response, scope: Option<&ResolvedFieldScope>) {
    let Some(scope) = scope else {
        return;
    };
    let h = resp.headers_mut();
    if let Ok(value) = HeaderValue::from_str(&scope.kind) {
        h.insert(axum::http::HeaderName::from_static(HDR_SCOPE_KIND), value);
    }
    if let Some(id) = scope.id.as_deref() {
        if let Ok(value) = HeaderValue::from_str(id) {
            h.insert(axum::http::HeaderName::from_static(HDR_SCOPE_ID), value);
        }
    }
}

fn insert_snapshot_header(resp: &mut axum::response::Response, snapshot_id: Option<&str>) {
    let Some(snapshot_id) = snapshot_id else {
        return;
    };
    if let Ok(value) = HeaderValue::from_str(snapshot_id) {
        resp.headers_mut()
            .insert(HeaderName::from_static(HDR_SNAPSHOT_ID), value);
    }
}

fn insert_field_vector_binary_headers(
    resp: &mut axum::response::Response,
    encoding_version: u8,
    topology_hash: Option<&str>,
    indexing: Option<FieldVectorIndexing>,
    node_index_count: Option<usize>,
) {
    let h = resp.headers_mut();
    if let Ok(value) = HeaderValue::from_str(&format!("FMVP;version={encoding_version}")) {
        h.insert(HeaderName::from_static(HDR_ENCODING), value);
    }
    if let Some(topology_hash) = topology_hash {
        if let Ok(value) = HeaderValue::from_str(topology_hash) {
            h.insert(
                HeaderName::from_static("x-fullmag-mesh-topology-hash"),
                value,
            );
        }
    }
    if let Some(indexing) = indexing {
        h.insert(
            HeaderName::from_static(HDR_FIELD_INDEXING),
            HeaderValue::from_static(indexing.as_str()),
        );
    }
    if let Some(node_index_count) = node_index_count {
        if let Ok(value) = HeaderValue::from_str(&node_index_count.to_string()) {
            h.insert(HeaderName::from_static(HDR_NODE_INDEX_COUNT), value);
        }
    }
}

fn field_vector_binary_header_counts(binary: &[u8]) -> (u8, usize, usize) {
    if binary.len() < 16 || &binary[0..4] != b"FMVP" {
        return (0, 0, 0);
    }
    let version = binary[4];
    let n_comp = (binary[6] as usize).max(1);
    let value_count = u32::from_le_bytes(binary[12..16].try_into().unwrap()) as usize;
    (version, value_count / n_comp, value_count)
}

// ── Catalog ──────────────────────────────────────────────────────────────────

#[derive(Debug, Clone)]
struct FieldFreshness {
    source_step: u64,
    source_revision: u64,
    materialized_at_unix_ms: u64,
    stale_by_steps: u64,
    materialization_wall_time_ns: u64,
    state: FieldMaterializationState,
    materialization_error: Option<String>,
}

fn completed_field_freshness(
    current_step: u64,
    source_step: u64,
    source_revision: u64,
    materialized_at_unix_ms: u64,
    materialization_wall_time_ns: u64,
) -> FieldFreshness {
    let stale_by_steps = current_step.saturating_sub(source_step);
    FieldFreshness {
        source_step,
        source_revision,
        materialized_at_unix_ms,
        stale_by_steps,
        materialization_wall_time_ns,
        state: if stale_by_steps == 0 {
            FieldMaterializationState::Complete
        } else {
            FieldMaterializationState::StaleComplete
        },
        materialization_error: None,
    }
}

fn current_source_step(snapshot: &SessionStateResponse) -> u64 {
    snapshot
        .live_state
        .as_ref()
        .map(|state| state.latest_step.step)
        .unwrap_or(0)
}

fn latest_json_field_freshness(
    snapshot: &SessionStateResponse,
    value: &serde_json::Value,
    _quantity_id: &str,
) -> FieldFreshness {
    let precedence = latest_field_source_precedence(snapshot, value);
    let current_step = current_source_step(snapshot);
    completed_field_freshness(
        current_step,
        precedence.source_step,
        precedence.source_revision,
        precedence.materialized_at_unix_ms,
        value
            .get("materialization_wall_time_ns")
            .and_then(serde_json::Value::as_u64)
            .unwrap_or(0),
    )
}

fn preview_field_freshness(
    snapshot: &SessionStateResponse,
    field: &fullmag_runner::LivePreviewField,
) -> FieldFreshness {
    let precedence = preview_field_source_precedence(field);
    completed_field_freshness(
        current_source_step(snapshot),
        precedence.source_step,
        precedence.source_revision,
        precedence.materialized_at_unix_ms,
        field.materialization_wall_time_ns,
    )
}

fn preview_cache_is_fresher(snapshot: &SessionStateResponse, quantity_id: &str) -> bool {
    let Some(preview) = snapshot.preview_cache.get(quantity_id) else {
        return false;
    };
    let n_comp = quantity_spec(quantity_id)
        .map(|spec| spec.n_comp as usize)
        .unwrap_or(3);
    if !field_values_match_current_domain(
        snapshot,
        quantity_id,
        n_comp,
        &preview.vector_field_values,
    ) {
        return false;
    }
    if snapshot.latest_fields.get(quantity_id).is_none() {
        return true;
    }
    preview_cache_precedes_latest(snapshot, quantity_id)
}

fn resolved_current_field_grid(
    snapshot: &SessionStateResponse,
    grid: Option<[u32; 3]>,
    point_count: usize,
) -> [u32; 3] {
    match grid {
        Some(grid)
            if snapshot.fem_mesh.is_some() && !is_fdm_snapshot(snapshot) && grid.contains(&0) =>
        {
            // Unstructured FEM geometry is carried by FMVP v3 topology metadata,
            // while its grid header is the canonical linear node-count carrier.
            [point_count as u32, 1, 1]
        }
        Some(grid) => grid,
        None if is_fdm_snapshot(snapshot) => {
            let domain_grid = fdm_grid_shape(
                snapshot,
                snapshot
                    .live_state
                    .as_ref()
                    .map(|state| state.latest_step.grid),
            );
            let domain_count = domain_grid.into_iter().try_fold(1usize, |count, axis| {
                usize::try_from(axis).ok()?.checked_mul(count)
            });
            (domain_count == Some(point_count))
                .then_some(domain_grid)
                .unwrap_or([point_count as u32, 1, 1])
        }
        None => [point_count as u32, 1, 1],
    }
}

fn resolved_current_field_values(
    snapshot: &SessionStateResponse,
    quantity_id: &str,
    n_comp: usize,
) -> Option<(Vec<f64>, [u32; 3], FieldFreshness)> {
    match resolved_current_field_source(snapshot, quantity_id, n_comp)? {
        ResolvedCurrentFieldSource::Latest(raw) => {
            let values = flatten_json_field_values(raw);
            let element_count = if n_comp > 0 {
                values.len() / n_comp
            } else {
                values.len()
            };
            let grid = resolved_current_field_grid(snapshot, json_field_grid(raw), element_count);
            let freshness = latest_json_field_freshness(snapshot, raw, quantity_id);
            Some((values, grid, freshness))
        }
        ResolvedCurrentFieldSource::Preview(field) => {
            let freshness = preview_field_freshness(snapshot, field);
            let point_count = if n_comp > 0 {
                field.vector_field_values.len() / n_comp
            } else {
                field.vector_field_values.len()
            };
            Some((
                field.vector_field_values.clone(),
                resolved_current_field_grid(snapshot, Some(field.preview_grid), point_count),
                freshness,
            ))
        }
        ResolvedCurrentFieldSource::LegacyLiveMagnetization { values, grid } => {
            let point_count = if n_comp > 0 {
                values.len() / n_comp
            } else {
                values.len()
            };
            Some((
                values.to_vec(),
                resolved_current_field_grid(snapshot, Some(grid), point_count),
                completed_field_freshness(
                    current_source_step(snapshot),
                    current_source_step(snapshot),
                    field_quantity_revision(snapshot, quantity_id),
                    snapshot
                        .live_state
                        .as_ref()
                        .map(|state| state.updated_at_unix_ms.min(u64::MAX as u128) as u64)
                        .unwrap_or(0),
                    0,
                ),
            ))
        }
    }
}

fn materializer_request_freshness(
    snapshot: &SessionStateResponse,
    status: &fullmag_runner::LiveFieldMaterializationStatus,
) -> FieldFreshness {
    let state = match status.state {
        fullmag_runner::LiveFieldMaterializationState::Pending => {
            FieldMaterializationState::Pending
        }
        fullmag_runner::LiveFieldMaterializationState::Complete => {
            FieldMaterializationState::Complete
        }
        fullmag_runner::LiveFieldMaterializationState::Superseded => {
            FieldMaterializationState::Pending
        }
        fullmag_runner::LiveFieldMaterializationState::Error => FieldMaterializationState::Error,
    };
    FieldFreshness {
        source_step: status.source_step,
        source_revision: status.request_revision,
        materialized_at_unix_ms: 0,
        stale_by_steps: current_source_step(snapshot).saturating_sub(status.source_step),
        materialization_wall_time_ns: 0,
        state,
        materialization_error: status.error.clone(),
    }
}

fn completed_payload_freshness_with_materializer_status(
    mut freshness: FieldFreshness,
    status: &fullmag_runner::LiveFieldMaterializationStatus,
) -> FieldFreshness {
    match status.state {
        fullmag_runner::LiveFieldMaterializationState::Pending
        | fullmag_runner::LiveFieldMaterializationState::Superseded => {
            freshness.state = FieldMaterializationState::StaleComplete;
            freshness.materialization_error = None;
        }
        fullmag_runner::LiveFieldMaterializationState::Error => {
            freshness.state = FieldMaterializationState::Error;
            freshness.materialization_error = status.error.clone();
        }
        fullmag_runner::LiveFieldMaterializationState::Complete => {}
    }
    freshness
}

fn materializer_status<'a>(
    snapshot: &'a SessionStateResponse,
    quantity_id: &str,
) -> Option<&'a fullmag_runner::LiveFieldMaterializationStatus> {
    snapshot
        .live_state
        .as_ref()?
        .latest_step
        .field_materialization_states
        .iter()
        .find(|status| status.quantity == quantity_id)
}

fn legacy_pending_field_freshness(snapshot: &SessionStateResponse) -> FieldFreshness {
    FieldFreshness {
        source_step: current_source_step(snapshot),
        source_revision: snapshot.display_selection.revision,
        materialized_at_unix_ms: 0,
        stale_by_steps: 0,
        materialization_wall_time_ns: 0,
        state: FieldMaterializationState::Pending,
        materialization_error: None,
    }
}

fn invalid_live_magnetization_is_present(snapshot: &SessionStateResponse) -> bool {
    snapshot
        .live_state
        .as_ref()
        .and_then(|state| state.latest_step.magnetization.as_ref())
        .is_some()
        && !live_magnetization_available(snapshot)
}

#[utoipa::path(
    get,
    path = "/v2/sessions/current/data/fields",
    responses(
        (status = 200, description = "Field catalog", body = FieldCatalog),
        (status = 404, description = "No active workspace"),
    ),
    tag = "data"
)]
pub async fn get_field_catalog(
    State(state): State<Arc<AppState>>,
) -> Result<Json<FieldCatalog>, ApiError> {
    let guard = state.current_live_state.read().await;
    let snapshot = guard
        .as_ref()
        .ok_or_else(|| ApiError::not_found("no active local live workspace"))?;

    let gen_id = domain_generation_id(snapshot);

    let mut quantities = Vec::new();

    for (qid, value) in snapshot.latest_fields.entries() {
        if preview_cache_is_fresher(snapshot, qid) {
            continue;
        }
        let n_comp = quantity_spec(qid)
            .map(|spec| spec.n_comp as usize)
            .unwrap_or(3);
        let transport_artifact = canonical_transport_field_artifact(snapshot, qid)?;
        let selected = transport_artifact.as_ref().unwrap_or(value);
        let values = if transport_artifact.is_some() {
            strict_flat_json_field_values(selected).unwrap_or_default()
        } else {
            flatten_json_field_values(selected)
        };
        if !field_values_match_current_domain(snapshot, qid, n_comp, &values) {
            continue;
        }
        push_field_descriptor(
            &mut quantities,
            qid,
            quantity_unit(qid),
            None,
            transport_artifact
                .as_ref()
                .map(|artifact| canonical_transport_field_artifact_revision(Some(artifact)))
                .unwrap_or_else(|| field_quantity_revision(snapshot, qid)),
            &gen_id,
            latest_json_field_freshness(snapshot, value, qid),
            true,
        );
    }

    for (qid, field) in snapshot.preview_cache.iter() {
        if quantities.iter().any(|q| q.quantity_id == *qid) {
            continue;
        }
        let n_comp = quantity_spec(qid)
            .map(|spec| spec.n_comp as usize)
            .unwrap_or(3);
        if !field_values_match_current_domain(snapshot, qid, n_comp, &field.vector_field_values) {
            continue;
        }
        push_field_descriptor(
            &mut quantities,
            qid,
            &field.unit,
            field
                .spatial_kind
                .starts_with("fem_")
                .then_some(field.spatial_kind.as_str()),
            field_quantity_revision(snapshot, qid),
            &gen_id,
            preview_field_freshness(snapshot, field),
            true,
        );
    }

    // A multilayer Airbox is a separately materialized observation carrier.
    // It is intentionally not tested against the current magnetic-domain
    // cardinality and is advertised only after its manifest and payload agree.
    if !quantities.iter().any(|q| q.quantity_id == "H_demag") {
        if let Ok(Some(carrier)) = load_fdm_multilayer_airbox_carrier(snapshot) {
            let revision = snapshot.field_samples_revision;
            push_field_descriptor(
                &mut quantities,
                "H_demag",
                quantity_unit("H_demag"),
                Some("airbox_only"),
                revision,
                &gen_id,
                completed_field_freshness(
                    current_source_step(snapshot),
                    current_source_step(snapshot),
                    revision,
                    0,
                    0,
                ),
                carrier.sample_count > 0,
            );
        }
    }

    let mut catalog_revision = current_field_catalog_revision(snapshot);
    for quantity_id in STEADY_TRANSPORT_FIELDS {
        if quantities.iter().any(|q| q.quantity_id == quantity_id) {
            continue;
        }
        let Some(artifact) = canonical_transport_field_artifact(snapshot, quantity_id)? else {
            continue;
        };
        let n_comp = quantity_spec(quantity_id)
            .map(|spec| spec.n_comp as usize)
            .unwrap_or(3);
        let values = flatten_json_field_values(&artifact);
        if !field_values_match_current_domain(snapshot, quantity_id, n_comp, &values) {
            continue;
        }
        let revision = canonical_transport_field_artifact_revision(Some(&artifact));
        catalog_revision = catalog_revision.max(revision);
        push_field_descriptor(
            &mut quantities,
            quantity_id,
            quantity_unit(quantity_id),
            None,
            revision,
            &gen_id,
            completed_field_freshness(
                current_source_step(snapshot),
                current_source_step(snapshot),
                revision,
                snapshot
                    .live_state
                    .as_ref()
                    .map(|state| state.updated_at_unix_ms.min(u64::MAX as u128) as u64)
                    .unwrap_or(0),
                0,
            ),
            true,
        );
    }

    let live_magnetization_is_selected = matches!(
        resolved_current_field_source(snapshot, "m", 3),
        Some(ResolvedCurrentFieldSource::LegacyLiveMagnetization { .. })
    );
    if live_magnetization_is_selected {
        quantities.retain(|quantity| quantity.quantity_id != "m");
        push_field_descriptor(
            &mut quantities,
            "m",
            quantity_unit("m"),
            None,
            field_quantity_revision(snapshot, "m"),
            &gen_id,
            completed_field_freshness(
                current_source_step(snapshot),
                current_source_step(snapshot),
                field_quantity_revision(snapshot, "m"),
                snapshot
                    .live_state
                    .as_ref()
                    .map(|state| state.updated_at_unix_ms.min(u64::MAX as u128) as u64)
                    .unwrap_or(0),
                0,
            ),
            true,
        );
    }

    for status in snapshot
        .live_state
        .as_ref()
        .into_iter()
        .flat_map(|state| state.latest_step.field_materialization_states.iter())
        .filter(|status| status.state != fullmag_runner::LiveFieldMaterializationState::Complete)
    {
        if let Some(descriptor) = quantities
            .iter_mut()
            .find(|descriptor| descriptor.quantity_id == status.quantity)
        {
            match status.state {
                fullmag_runner::LiveFieldMaterializationState::Pending
                | fullmag_runner::LiveFieldMaterializationState::Superseded => {
                    descriptor.state = FieldMaterializationState::StaleComplete;
                    descriptor.materialization_error = None;
                }
                fullmag_runner::LiveFieldMaterializationState::Error => {
                    descriptor.state = FieldMaterializationState::Error;
                    descriptor.materialization_error = status.error.clone();
                }
                fullmag_runner::LiveFieldMaterializationState::Complete => {}
            }
        } else {
            let freshness = materializer_request_freshness(snapshot, status);
            push_field_descriptor(
                &mut quantities,
                &status.quantity,
                quantity_unit(&status.quantity),
                snapshot
                    .preview_cache
                    .get(&status.quantity)
                    .filter(|field| field.spatial_kind.starts_with("fem_"))
                    .map(|field| field.spatial_kind.as_str()),
                field_quantity_revision(snapshot, &status.quantity),
                &gen_id,
                freshness,
                false,
            );
        }
    }

    let selected_quantity = canonical_quantity_id(&snapshot.display_selection.selection.quantity);
    if !quantities
        .iter()
        .any(|quantity| quantity.quantity_id == selected_quantity.as_ref())
        && !is_fem_runtime(snapshot)
        && snapshot
            .live_state
            .as_ref()
            .is_some_and(|state| state.status == "running")
        && !(selected_quantity.as_ref() == "m" && invalid_live_magnetization_is_present(snapshot))
    {
        push_field_descriptor(
            &mut quantities,
            selected_quantity.as_ref(),
            quantity_unit(selected_quantity.as_ref()),
            None,
            field_quantity_revision(snapshot, selected_quantity.as_ref()),
            &gen_id,
            legacy_pending_field_freshness(snapshot),
            false,
        );
    }

    Ok(Json(FieldCatalog {
        revision: catalog_revision,
        domain_generation_id: gen_id,
        quantities,
    }))
}

// ── Meta ─────────────────────────────────────────────────────────────────────

#[utoipa::path(
    get,
    path = "/v2/sessions/current/data/fields/{quantity_id}/meta",
    params(
        ("quantity_id" = String, Path, description = "Quantity identifier"),
        FieldMetaQuery,
    ),
    responses(
        (status = 200, description = "Field metadata", body = FieldMeta),
        (status = 400, description = "Invalid snapshot or component parameter"),
        (status = 409, description = "Snapshot does not match the current domain"),
        (status = 404, description = "Field not found"),
    ),
    tag = "data"
)]
pub async fn get_field_meta(
    State(state): State<Arc<AppState>>,
    AxumPath(quantity_id): AxumPath<String>,
    Query(query): Query<FieldMetaQuery>,
) -> Result<Json<FieldMeta>, ApiError> {
    let quantity_id = canonical_quantity_id(&quantity_id);
    let quantity_id = quantity_id.as_ref();
    let workspace_selection = if query.scope_kind.as_deref() == Some("selection") {
        Some(state.current_workspace_selection.read().await.clone())
    } else {
        None
    };
    let guard = state.current_live_state.read().await;
    let snapshot = guard
        .as_ref()
        .ok_or_else(|| ApiError::not_found("no active local live workspace"))?;

    let spec = quantity_spec(quantity_id);
    let n_comp = spec.map(|s| s.n_comp).unwrap_or(3);
    let label = spec
        .map(|s| s.label.to_string())
        .unwrap_or_else(|| quantity_id.to_string());
    let kind = spec
        .map(|s| s.shape.as_api_kind().to_string())
        .unwrap_or_else(|| "vector_field".into());
    let unit = quantity_unit(quantity_id).to_string();
    let location = snapshot
        .preview_cache
        .get(quantity_id)
        .filter(|field| field.spatial_kind.starts_with("fem_"))
        .map(|field| field.spatial_kind.clone())
        .unwrap_or_else(|| quantity_spatial_domain(quantity_id).to_string());
    let component = parse_component(query.component.as_deref(), n_comp as usize)?;
    let airbox_carrier = requested_fdm_multilayer_airbox_carrier(
        snapshot,
        &FieldVectorQuery {
            component: query.component.clone(),
            scope_kind: query.scope_kind.clone(),
            scope_id: query.scope_id.clone(),
            owner_object_id: query.owner_object_id.clone(),
            geometry_scope: None,
            max_samples: None,
            snapshot_id: query.snapshot_id.clone(),
            stage_id: query.stage_id.clone(),
            view: None,
            phase_rad: None,
        },
        quantity_id,
    )?;
    let transport_artifact = canonical_transport_field_artifact(snapshot, quantity_id)?;
    let transport_artifact_revision =
        canonical_transport_field_artifact_revision(transport_artifact.as_ref());

    let gen_id = domain_generation_id(snapshot);
    let requested_snapshot_id = query
        .snapshot_id
        .as_deref()
        .map(str::trim)
        .filter(|id| !id.is_empty());

    let transport_artifact_values = || {
        transport_artifact.as_ref().and_then(|raw| {
            let values = flatten_json_field_values(raw);
            if !field_values_match_current_domain(snapshot, quantity_id, n_comp as usize, &values) {
                return None;
            }
            let element_count = values.len() / n_comp as usize;
            let grid = json_field_grid(raw).unwrap_or([element_count as u32, 1, 1]);
            Some((
                values,
                grid,
                completed_field_freshness(
                    current_source_step(snapshot),
                    current_source_step(snapshot),
                    transport_artifact_revision,
                    0,
                    0,
                ),
            ))
        })
    };
    let raw_values_opt: Option<(Vec<f64>, [u32; 3], FieldFreshness)> = if let Some(carrier) =
        airbox_carrier.as_ref()
    {
        Some((
            carrier.values.clone(),
            carrier.cells,
            completed_field_freshness(
                current_source_step(snapshot),
                current_source_step(snapshot),
                snapshot.field_samples_revision,
                0,
                0,
            ),
        ))
    } else if let Some(snapshot_id) = requested_snapshot_id {
        if quantity_id != "m" {
            return Err(ApiError::bad_request(format!(
                "persisted hysteresis snapshot '{snapshot_id}' is only available for magnetization"
            )));
        }
        validate_hysteresis_snapshot_stage_scope(&state, query.stage_id.as_deref(), snapshot_id)
            .await?;
        let (values, grid) = persisted_hysteresis_magnetization_values(snapshot, snapshot_id)?;
        Some((
            values,
            grid,
            completed_field_freshness(
                current_source_step(snapshot),
                current_source_step(snapshot),
                field_quantity_revision(snapshot, quantity_id),
                snapshot
                    .live_state
                    .as_ref()
                    .map(|state| state.updated_at_unix_ms.min(u64::MAX as u128) as u64)
                    .unwrap_or(0),
                0,
            ),
        ))
    } else {
        transport_artifact_values()
            .or_else(|| resolved_current_field_values(snapshot, quantity_id, n_comp as usize))
    };

    let materializer_status = materializer_status(snapshot, quantity_id)
        .filter(|status| status.state != fullmag_runner::LiveFieldMaterializationState::Complete);
    let Some((raw_values, grid, freshness)) = raw_values_opt else {
        if let Some(status) = materializer_status {
            let freshness = materializer_request_freshness(snapshot, status);
            return Ok(Json(FieldMeta {
                quantity_id: quantity_id.to_string(),
                label,
                kind,
                components: n_comp,
                location,
                unit,
                field_revision: field_quantity_revision(snapshot, quantity_id),
                domain_generation_id: gen_id.clone(),
                stats: None,
                source_step: freshness.source_step,
                source_revision: freshness.source_revision,
                materialized_at_unix_ms: freshness.materialized_at_unix_ms,
                stale_by_steps: freshness.stale_by_steps,
                materialization_wall_time_ns: freshness.materialization_wall_time_ns,
                state: freshness.state,
                materialization_error: freshness.materialization_error,
            }));
        }
        let selected_quantity =
            canonical_quantity_id(&snapshot.display_selection.selection.quantity);
        if requested_snapshot_id.is_none()
            && selected_quantity.as_ref() == quantity_id
            && !is_fem_runtime(snapshot)
            && snapshot
                .live_state
                .as_ref()
                .is_some_and(|state| state.status == "running")
            && !(quantity_id == "m" && invalid_live_magnetization_is_present(snapshot))
        {
            let freshness = legacy_pending_field_freshness(snapshot);
            return Ok(Json(FieldMeta {
                quantity_id: quantity_id.to_string(),
                label,
                kind,
                components: n_comp,
                location,
                unit,
                field_revision: field_quantity_revision(snapshot, quantity_id),
                domain_generation_id: gen_id.clone(),
                stats: None,
                source_step: freshness.source_step,
                source_revision: freshness.source_revision,
                materialized_at_unix_ms: freshness.materialized_at_unix_ms,
                stale_by_steps: freshness.stale_by_steps,
                materialization_wall_time_ns: freshness.materialization_wall_time_ns,
                state: freshness.state,
                materialization_error: freshness.materialization_error,
            }));
        }
        return Err(ApiError::not_found(format!(
            "field '{}' not available in memory",
            quantity_id
        )));
    };
    let freshness = materializer_status
        .map(|status| {
            completed_payload_freshness_with_materializer_status(freshness.clone(), status)
        })
        .unwrap_or(freshness);
    let raw_point_count = if n_comp > 0 {
        raw_values.len() / n_comp as usize
    } else {
        raw_values.len()
    };
    let scope_query = FieldVectorQuery {
        component: query.component.clone(),
        scope_kind: query.scope_kind.clone(),
        scope_id: query.scope_id.clone(),
        owner_object_id: query.owner_object_id.clone(),
        geometry_scope: None,
        max_samples: None,
        snapshot_id: query.snapshot_id.clone(),
        stage_id: query.stage_id.clone(),
        view: None,
        phase_rad: None,
    };
    let resolved_scope = if let Some(carrier) = airbox_carrier.as_ref() {
        Some(fdm_multilayer_airbox_scope(carrier))
    } else {
        resolve_field_scope(
            &scope_query,
            snapshot,
            workspace_selection.as_ref(),
            raw_point_count,
            quantity_id,
        )?
    };
    let raw_values = apply_field_scope(raw_values, grid, n_comp as usize, resolved_scope.as_ref());

    Ok(Json(FieldMeta {
        quantity_id: quantity_id.to_string(),
        label,
        kind,
        components: n_comp,
        location,
        unit,
        field_revision: if airbox_carrier.is_some() {
            snapshot.field_samples_revision
        } else if transport_artifact.is_some() {
            transport_artifact_revision
        } else {
            field_quantity_revision(snapshot, quantity_id)
        },
        domain_generation_id: gen_id,
        stats: projected_field_stats(&raw_values, n_comp as usize, &component)?,
        source_step: freshness.source_step,
        source_revision: freshness.source_revision,
        materialized_at_unix_ms: freshness.materialized_at_unix_ms,
        stale_by_steps: freshness.stale_by_steps,
        materialization_wall_time_ns: freshness.materialization_wall_time_ns,
        state: freshness.state,
        materialization_error: freshness.materialization_error,
    }))
}

#[derive(Debug, Clone, Deserialize, utoipa::IntoParams)]
pub struct FieldMetaQuery {
    /// Optional component projection used for statistics (`x`, `y`, `z`, `magnitude`, `full`).
    pub component: Option<String>,
    /// Optional FEM or FDM scope used for statistics.
    pub scope_kind: Option<String>,
    /// Scope identifier for `object`, `layer`, `region`, and `part` scopes.
    pub scope_id: Option<String>,
    /// Optional canonical owner of a `region` scope.
    pub owner_object_id: Option<String>,
    /// Optional persisted analysis snapshot id, for example a saved
    /// hysteresis-point magnetization state.
    pub snapshot_id: Option<String>,
    /// Optional hysteresis stage id that owns `snapshot_id`.
    pub stage_id: Option<String>,
}

fn projected_field_stats(
    values: &[f64],
    n_comp: usize,
    component: &ComponentSelection,
) -> Result<Option<FieldStats>, ApiError> {
    let (_, projected) = project_values(values, n_comp, component)?;
    Ok(field_stats(&projected))
}

fn field_stats(values: &[f64]) -> Option<FieldStats> {
    let mut min = f64::INFINITY;
    let mut max = f64::NEG_INFINITY;
    let mut sum = 0.0;
    let mut count = 0usize;
    for value in values.iter().copied().filter(|value| value.is_finite()) {
        min = min.min(value);
        max = max.max(value);
        sum += value;
        count += 1;
    }
    if count == 0 {
        return None;
    }
    Some(FieldStats {
        min,
        max,
        mean: sum / count as f64,
    })
}

fn push_field_descriptor(
    quantities: &mut Vec<FieldDescriptor>,
    quantity_id: &str,
    unit: &str,
    location: Option<&str>,
    field_revision: u64,
    domain_generation_id: &str,
    freshness: FieldFreshness,
    available: bool,
) {
    let spec = quantity_spec(quantity_id);
    let n_comp = spec.map(|s| s.n_comp).unwrap_or(3);
    quantities.push(FieldDescriptor {
        quantity_id: quantity_id.to_string(),
        label: spec
            .map(|s| s.label.to_string())
            .unwrap_or_else(|| quantity_id.to_string()),
        kind: spec
            .map(|s| s.shape.as_api_kind().to_string())
            .unwrap_or_else(|| "vector_field".into()),
        components: n_comp,
        location: location
            .unwrap_or_else(|| quantity_spatial_domain(quantity_id))
            .to_string(),
        unit: unit.to_string(),
        field_revision,
        domain_generation_id: domain_generation_id.to_string(),
        available,
        source_step: freshness.source_step,
        source_revision: freshness.source_revision,
        materialized_at_unix_ms: freshness.materialized_at_unix_ms,
        stale_by_steps: freshness.stale_by_steps,
        materialization_wall_time_ns: freshness.materialization_wall_time_ns,
        state: freshness.state,
        materialization_error: freshness.materialization_error,
    });
}

// ── Internal helpers ──────────────────────────────────────────────────────────

#[derive(Debug, Clone)]
struct ResolvedFieldScope {
    domain: ResolvedFieldScopeDomain,
    kind: String,
    id: Option<String>,
    node_indices: Vec<usize>,
    value_indices: Vec<usize>,
    grid: Option<[u32; 3]>,
    carrier_hash: Option<String>,
}

#[derive(Debug, Clone, Copy, PartialEq, Eq)]
enum ResolvedFieldScopeDomain {
    Air,
    Magnetic,
}

impl ResolvedFieldScope {
    fn cache_token(&self) -> String {
        match self.id.as_deref() {
            Some(id) => format!("{}:{id}", self.kind),
            None => self.kind.clone(),
        }
    }
}

fn resolve_field_geometry_scope(query: &FieldVectorQuery) -> Result<&str, ApiError> {
    let geometry_scope = query
        .geometry_scope
        .as_deref()
        .map(str::trim)
        .filter(|value| !value.is_empty())
        .unwrap_or("full");
    if geometry_scope != "full" && geometry_scope != "surface" {
        return Err(ApiError::bad_request(format!(
            "unsupported field geometry_scope '{geometry_scope}'"
        )));
    }
    let scope_kind = query
        .scope_kind
        .as_deref()
        .map(str::trim)
        .filter(|value| !value.is_empty());
    if geometry_scope == "surface" && scope_kind != Some("airbox") {
        return Err(ApiError::bad_request(
            "field geometry_scope 'surface' currently requires scope_kind 'airbox'",
        ));
    }
    Ok(geometry_scope)
}

fn resolve_field_scope(
    query: &FieldVectorQuery,
    snapshot: &SessionStateResponse,
    workspace_selection: Option<&crate::schemas::workspace::WorkspaceSelectionResource>,
    raw_point_count: usize,
    quantity_id: &str,
) -> Result<Option<ResolvedFieldScope>, ApiError> {
    let geometry_scope = resolve_field_geometry_scope(query)?;
    let Some(scope_kind) = query
        .scope_kind
        .as_deref()
        .map(str::trim)
        .filter(|v| !v.is_empty())
    else {
        return Ok(None);
    };
    if scope_kind == "full" {
        return Ok(None);
    }
    if is_fdm_snapshot(snapshot) {
        let scope =
            resolve_fdm_field_scope(query, snapshot, raw_point_count, scope_kind, geometry_scope)?;
        if quantity_spatial_domain(quantity_id) == "magnetic_only"
            && scope.domain == ResolvedFieldScopeDomain::Air
        {
            return Err(ApiError::not_found(format!(
                "field '{quantity_id}' is not available on airbox grid scope"
            )));
        }
        return Ok(Some(scope));
    }
    let mesh = snapshot.fem_mesh.as_ref().ok_or_else(|| {
        ApiError::bad_request(format!(
            "field scope '{scope_kind}' requires FEM mesh topology"
        ))
    })?;
    let scope = match scope_kind {
        "object" => {
            let object_id = required_scope_id(query, "object")?;
            resolve_object_scope(mesh, object_id)?
        }
        "part" => {
            let part_id = required_scope_id(query, "part")?;
            resolve_part_scope(mesh, part_id, "part")?
        }
        "airbox" => {
            let part = if let Some(part_id) = query.scope_id.as_deref().filter(|id| !id.is_empty())
            {
                mesh.mesh_parts
                    .iter()
                    .find(|part| part.id == part_id && part.role == "air")
                    .ok_or_else(|| {
                        ApiError::not_found(format!("airbox mesh part not found: {part_id}"))
                    })?
            } else {
                mesh.mesh_parts
                    .iter()
                    .find(|part| part.role == "air")
                    .ok_or_else(|| ApiError::not_found("airbox mesh part not found"))?
            };
            ResolvedFieldScope {
                domain: ResolvedFieldScopeDomain::Air,
                kind: "airbox".to_string(),
                id: Some(part.id.clone()),
                node_indices: node_indices_for_airbox_part(
                    mesh,
                    part,
                    geometry_scope == "surface",
                )?,
                value_indices: Vec::new(),
                grid: None,
                carrier_hash: None,
            }
        }
        "selection" => {
            let selection = workspace_selection.ok_or_else(|| {
                ApiError::bad_request("field scope 'selection' requires workspace selection state")
            })?;
            resolve_selection_scope(mesh, selection)?
        }
        _ => {
            return Err(ApiError::bad_request(format!(
                "unsupported field scope_kind '{scope_kind}'"
            )));
        }
    };
    if quantity_spatial_domain(quantity_id) == "magnetic_only"
        && scope.domain == ResolvedFieldScopeDomain::Air
    {
        return Err(ApiError::not_found(format!(
            "field '{quantity_id}' is not available on airbox mesh scope"
        )));
    }
    let node_indices = scope
        .node_indices
        .into_iter()
        .filter(|index| *index < mesh.nodes.len())
        .collect::<Vec<_>>();
    let value_indices = if raw_point_count == mesh.nodes.len() {
        node_indices.clone()
    } else if quantity_spatial_domain(quantity_id) == "magnetic_only" {
        let magnetic_node_indices = fem_magnetic_node_indices(mesh).ok_or_else(|| {
            ApiError::conflict(format!(
                "compact field '{quantity_id}' has no resolvable magnetic-node mapping"
            ))
        })?;
        if magnetic_node_indices.len() != raw_point_count {
            return Err(ApiError::conflict(format!(
                "compact field '{quantity_id}' length does not match the FEM magnetic-node mapping"
            )));
        }
        let compact_index_by_node = magnetic_node_indices
            .into_iter()
            .enumerate()
            .map(|(compact_index, node_index)| (node_index as usize, compact_index))
            .collect::<BTreeMap<_, _>>();
        node_indices
            .iter()
            .filter_map(|node_index| compact_index_by_node.get(node_index).copied())
            .collect()
    } else {
        node_indices
            .iter()
            .copied()
            .filter(|index| *index < raw_point_count)
            .collect()
    };
    Ok(Some(ResolvedFieldScope {
        node_indices,
        value_indices,
        ..scope
    }))
}

fn resolve_fdm_field_scope(
    query: &FieldVectorQuery,
    snapshot: &SessionStateResponse,
    raw_point_count: usize,
    scope_kind: &str,
    geometry_scope: &str,
) -> Result<ResolvedFieldScope, ApiError> {
    if let Some(scope) =
        resolve_multilayer_native_layer_scope(query, snapshot, raw_point_count, scope_kind)?
    {
        return Ok(scope);
    }
    let membership = load_resolved_fdm_membership(snapshot)?;
    if membership.cell_membership.len() != raw_point_count {
        return Err(ApiError::conflict(
            "FDM field length does not match current membership cell count",
        ));
    }
    let scope_id = if scope_kind == "airbox" {
        query.scope_id.as_deref().unwrap_or("airbox")
    } else {
        required_scope_id(query, scope_kind)?
    };
    let mut canonical_scope_id = scope_id.to_string();
    let mut selected = match scope_kind {
        "object" => {
            if !membership
                .object_ids
                .iter()
                .any(|id| object_ids_match(id, scope_id))
            {
                return Err(ApiError::not_found(format!(
                    "FDM object membership not found: {scope_id}"
                )));
            }
            let numeric_ids = membership
                .region_legend
                .iter()
                .filter(|entry| object_ids_match(&entry.object_id, scope_id))
                .map(|entry| entry.numeric_id)
                .collect::<BTreeSet<_>>();
            // When the region legend is empty (single-object, uniform grid)
            // all active cells (numeric_id==0) belong to the only canonical
            // object.  The raw object_ids may carry geometry aliases (e.g.
            // "film_geom") alongside the magnet name, so we must compare
            // canonical (suffix-stripped) unique count, not raw length.
            let canonical_object_count = {
                let mut seen = std::collections::HashSet::new();
                for id in &membership.object_ids {
                    let canonical = id
                        .strip_suffix("_geom")
                        .or_else(|| id.strip_suffix("_geometry"))
                        .or_else(|| id.strip_suffix("-geometry"))
                        .unwrap_or(id);
                    seen.insert(canonical);
                }
                seen.len()
            };
            membership
                .cell_membership
                .iter()
                .enumerate()
                .filter_map(|(index, numeric_id)| {
                    (numeric_ids.contains(numeric_id)
                        || (*numeric_id == 0 && canonical_object_count == 1))
                        .then_some(index)
                })
                .collect::<Vec<_>>()
        }
        "region" => {
            let requested_owner_object_id = query.owner_object_id.as_deref();
            let mut entries = membership.region_legend.iter().filter(|entry| {
                entry.region_id == scope_id
                    && requested_owner_object_id
                        .map(|owner| object_ids_match(&entry.object_id, owner))
                        .unwrap_or(true)
            });
            let entry = entries.next().ok_or_else(|| {
                if let Some(owner) = requested_owner_object_id {
                    ApiError::not_found(format!(
                        "FDM region membership not found: {owner}/{scope_id}"
                    ))
                } else {
                    ApiError::not_found(format!("FDM region membership not found: {scope_id}"))
                }
            })?;
            if entries.next().is_some() {
                let identity = requested_owner_object_id
                    .map(|owner| format!("{owner}/{scope_id}"))
                    .unwrap_or_else(|| scope_id.to_string());
                let hint = requested_owner_object_id
                    .is_none()
                    .then_some("; provide owner_object_id")
                    .unwrap_or("");
                return Err(ApiError::conflict(format!(
                    "FDM region membership '{identity}' is ambiguous{hint}"
                )));
            }
            canonical_scope_id = format!("region:{}:{}", entry.object_id, entry.region_id);
            membership
                .cell_membership
                .iter()
                .enumerate()
                .filter_map(|(index, numeric_id)| {
                    (*numeric_id == entry.numeric_id).then_some(index)
                })
                .collect::<Vec<_>>()
        }
        "airbox" => membership
            .cell_membership
            .iter()
            .enumerate()
            .filter_map(|(index, numeric_id)| (*numeric_id == u32::MAX).then_some(index))
            .collect::<Vec<_>>(),
        _ => {
            return Err(ApiError::bad_request(format!(
                "unsupported FDM field scope_kind '{scope_kind}'"
            )))
        }
    };
    if scope_kind == "airbox" && geometry_scope == "surface" {
        selected.retain(|index| fdm_cell_is_domain_surface(*index, membership.counts));
    }
    if selected.is_empty() {
        return Err(ApiError::not_found(format!(
            "FDM field scope '{scope_kind}/{scope_id}' has no realized cells"
        )));
    }
    Ok(ResolvedFieldScope {
        domain: if scope_kind == "airbox" {
            ResolvedFieldScopeDomain::Air
        } else {
            ResolvedFieldScopeDomain::Magnetic
        },
        kind: scope_kind.to_string(),
        id: Some(canonical_scope_id),
        node_indices: selected.clone(),
        value_indices: selected,
        grid: None,
        carrier_hash: Some(format!("sha256:{}", membership.grid_fingerprint)),
    })
}

fn resolve_multilayer_native_layer_scope(
    query: &FieldVectorQuery,
    snapshot: &SessionStateResponse,
    raw_point_count: usize,
    scope_kind: &str,
) -> Result<Option<ResolvedFieldScope>, ApiError> {
    let Some(layout) = snapshot
        .metadata
        .as_ref()
        .and_then(|metadata| metadata.get("artifact_layout"))
        .filter(|layout| {
            layout.get("backend").and_then(serde_json::Value::as_str) == Some("fdm_multilayer")
        })
    else {
        return Ok(None);
    };
    if scope_kind != "layer" && scope_kind != "object" {
        if scope_kind == "region" {
            return Err(ApiError::unprocessable(
                "multilayer FDM region scope is unavailable: independent native grids have no single FMRM membership carrier; use layer or object scope",
            ));
        }
        return Err(ApiError::bad_request(format!(
            "multilayer FDM field scope_kind '{scope_kind}' is unsupported; use layer or object"
        )));
    }
    let scope_id = required_scope_id(query, scope_kind)?;
    let layers = layout
        .get("layers")
        .and_then(serde_json::Value::as_array)
        .ok_or_else(|| ApiError::conflict("multilayer FDM field layout has no native layers"))?;
    let total_count = layers.iter().try_fold(0usize, |total, layer| {
        let count = layer.get("value_count")?.as_u64()?;
        total.checked_add(usize::try_from(count).ok()?)
    });
    if total_count != Some(raw_point_count) {
        return Err(ApiError::conflict(
            "multilayer FDM field length does not match native layer payload layout",
        ));
    }
    // Explorer/viewport targets use the stable `layer_id` identity while the
    // original runtime artifact historically exposed only `magnet_name`.
    // Resolve both canonical identities here, without guessing or falling
    // through to another layer when the layout is ambiguous.  Object scopes
    // similarly accept the layout's `object_id` (with `magnet_name` retained
    // as the backwards-compatible alias).
    let matching_layers = layers
        .iter()
        .filter(|layer| {
            let matches =
                |key: &str| layer.get(key).and_then(serde_json::Value::as_str) == Some(scope_id);
            match scope_kind {
                "layer" => matches("layer_id") || matches("magnet_name"),
                "object" => matches("object_id") || matches("magnet_name"),
                _ => false,
            }
        })
        .collect::<Vec<_>>();
    let layer = match matching_layers.as_slice() {
        [] => {
            return Err(ApiError::not_found(format!(
                "multilayer FDM {scope_kind} not found: {scope_id}"
            )))
        }
        [layer] => *layer,
        _ => {
            return Err(ApiError::conflict(format!(
                "multilayer FDM {scope_kind} is ambiguous: {scope_id}"
            )))
        }
    };
    let canonical_scope_id = match scope_kind {
        "layer" => ["magnet_name", "layer_id", "object_id"],
        "object" => ["object_id", "magnet_name", "layer_id"],
        _ => unreachable!("scope_kind was validated above"),
    }
    .into_iter()
    .find_map(|key| layer.get(key).and_then(serde_json::Value::as_str))
    .ok_or_else(|| {
        ApiError::conflict(format!(
            "multilayer FDM {scope_kind} has no canonical scope identity"
        ))
    })?;
    let offset = layer
        .get("value_offset")
        .and_then(serde_json::Value::as_u64)
        .and_then(|value| usize::try_from(value).ok())
        .ok_or_else(|| ApiError::conflict("multilayer FDM layer has no valid value_offset"))?;
    let count = layer
        .get("value_count")
        .and_then(serde_json::Value::as_u64)
        .and_then(|value| usize::try_from(value).ok())
        .ok_or_else(|| ApiError::conflict("multilayer FDM layer has no valid value_count"))?;
    let grid = layer
        .get("native_grid")
        .and_then(serde_json::Value::as_array)
        .filter(|values| values.len() == 3)
        .and_then(|values| {
            Some([
                u32::try_from(values[0].as_u64()?).ok()?,
                u32::try_from(values[1].as_u64()?).ok()?,
                u32::try_from(values[2].as_u64()?).ok()?,
            ])
        })
        .ok_or_else(|| ApiError::conflict("multilayer FDM layer has no valid native_grid"))?;
    if grid
        .into_iter()
        .map(|value| value as usize)
        .product::<usize>()
        != count
        || offset
            .checked_add(count)
            .is_none_or(|end| end > raw_point_count)
    {
        return Err(ApiError::conflict(
            "multilayer FDM native layer grid disagrees with its payload range",
        ));
    }
    let native_origin = serde_json::from_value::<[f64; 3]>(
        layer
            .get("native_origin")
            .cloned()
            .unwrap_or(serde_json::Value::Null),
    )
    .map_err(|error| {
        ApiError::conflict(format!(
            "multilayer FDM layer has no valid native_origin: {error}"
        ))
    })?;
    let native_cell_size = serde_json::from_value::<[f64; 3]>(
        layer
            .get("native_cell_size")
            .cloned()
            .unwrap_or(serde_json::Value::Null),
    )
    .map_err(|error| {
        ApiError::conflict(format!(
            "multilayer FDM layer has no valid native_cell_size: {error}"
        ))
    })?;
    let active_cells = layer
        .get("active_cell_count")
        .and_then(serde_json::Value::as_u64)
        .unwrap_or(count as u64);
    let native_grid_fingerprint = fullmag_ir::FdmGridCertificateIR::new(
        native_origin,
        grid,
        native_cell_size,
        active_cells,
        1,
    )
    .map_err(|error| {
        ApiError::conflict(format!(
            "multilayer FDM native layer cannot establish a grid carrier: {error}"
        ))
    })?
    .grid_fingerprint;
    Ok(Some(ResolvedFieldScope {
        domain: ResolvedFieldScopeDomain::Magnetic,
        kind: scope_kind.to_string(),
        id: Some(canonical_scope_id.to_string()),
        node_indices: (0..count).collect(),
        value_indices: (offset..offset + count).collect(),
        grid: Some(grid),
        carrier_hash: Some(format!("sha256:{native_grid_fingerprint}")),
    }))
}

fn fdm_cell_is_domain_surface(index: usize, counts: [u32; 3]) -> bool {
    let [nx, ny, nz] = counts.map(|count| count as usize);
    if nx == 0 || ny == 0 || nz == 0 {
        return false;
    }
    let plane_stride = nx.saturating_mul(ny);
    if index >= plane_stride.saturating_mul(nz) {
        return false;
    }
    let x = index % nx;
    let y = (index / nx) % ny;
    let z = index / plane_stride;
    x == 0 || x + 1 == nx || y == 0 || y + 1 == ny || z == 0 || z + 1 == nz
}

fn required_scope_id<'a>(
    query: &'a FieldVectorQuery,
    scope_kind: &str,
) -> Result<&'a str, ApiError> {
    query
        .scope_id
        .as_deref()
        .filter(|value| !value.is_empty())
        .ok_or_else(|| {
            ApiError::bad_request(format!("scope_id is required for {scope_kind} scope"))
        })
}

fn object_ids_match(a: &str, b: &str) -> bool {
    let a = a.strip_prefix("object:").unwrap_or(a);
    let b = b.strip_prefix("object:").unwrap_or(b);
    if a == b {
        return true;
    }
    let clean_a = a.strip_suffix("_geom").unwrap_or(a);
    let clean_b = b.strip_suffix("_geom").unwrap_or(b);
    clean_a == clean_b
}

fn object_segment_ids_match(
    segment: &fullmag_runner::FemMeshObjectSegment,
    object_id: &str,
) -> bool {
    object_ids_match(&segment.object_id, object_id)
        || segment
            .geometry_id
            .as_deref()
            .map(|id| object_ids_match(id, object_id))
            .unwrap_or(false)
}

fn resolve_object_scope(
    mesh: &FemMeshPayload,
    object_id: &str,
) -> Result<ResolvedFieldScope, ApiError> {
    if let Some(part) = mesh.mesh_parts.iter().find(|part| {
        part.role == "magnetic_object"
            && (part
                .object_id
                .as_deref()
                .map(|id| object_ids_match(id, object_id))
                .unwrap_or(false)
                || part
                    .geometry_id
                    .as_deref()
                    .map(|id| object_ids_match(id, object_id))
                    .unwrap_or(false)
                || object_ids_match(&part.id, object_id))
    }) {
        return Ok(ResolvedFieldScope {
            domain: ResolvedFieldScopeDomain::Magnetic,
            kind: "object".to_string(),
            id: Some(object_id.to_string()),
            node_indices: node_indices_for_part(part),
            value_indices: Vec::new(),
            grid: None,
            carrier_hash: None,
        });
    }

    let segment = mesh
        .object_segments
        .iter()
        .find(|segment| object_segment_ids_match(segment, object_id))
        .ok_or_else(|| ApiError::not_found(format!("object mesh not found: {object_id}")))?;
    Ok(ResolvedFieldScope {
        domain: if segment.object_id == "__air__" {
            ResolvedFieldScopeDomain::Air
        } else {
            ResolvedFieldScopeDomain::Magnetic
        },
        kind: "object".to_string(),
        id: Some(object_id.to_string()),
        node_indices: node_indices_for_segment(mesh, segment),
        value_indices: Vec::new(),
        grid: None,
        carrier_hash: None,
    })
}

fn node_indices_for_part(part: &fullmag_runner::FemMeshPartPayload) -> Vec<usize> {
    if part.node_indices.is_empty() {
        let start = part.node_start as usize;
        let end = start.saturating_add(part.node_count as usize);
        (start..end).collect()
    } else {
        part.node_indices
            .iter()
            .map(|index| *index as usize)
            .collect()
    }
}

fn node_indices_for_airbox_part(
    mesh: &FemMeshPayload,
    part: &fullmag_runner::FemMeshPartPayload,
    surface_only: bool,
) -> Result<Vec<usize>, ApiError> {
    let mut node_indices = if surface_only {
        crate::router_v2::handlers::shared::mesh_part_surface_node_indices(mesh, part)
            .map(|indices| indices.into_iter().map(|index| index as usize).collect())
            .ok_or_else(|| {
                ApiError::bad_request(format!(
                    "airbox surface membership is unavailable for mesh part '{}'",
                    part.id
                ))
            })?
    } else {
        node_indices_for_part(part)
    };
    let magnetic_nodes = magnetic_node_index_set(mesh);
    if magnetic_nodes.is_empty() {
        return Ok(node_indices);
    }
    node_indices.retain(|index| !magnetic_nodes.contains(index));
    Ok(node_indices)
}

fn magnetic_node_index_set(mesh: &FemMeshPayload) -> BTreeSet<usize> {
    let mut node_indices = BTreeSet::new();
    for part in &mesh.mesh_parts {
        if part.role == "magnetic_object" {
            node_indices.extend(node_indices_for_part(part));
        }
    }
    if !node_indices.is_empty() {
        return node_indices;
    }

    for segment in &mesh.object_segments {
        if segment.object_id != "__air__" {
            node_indices.extend(node_indices_for_segment(mesh, segment));
        }
    }
    if !node_indices.is_empty() {
        return node_indices;
    }

    for (element_index, marker) in mesh.element_markers.iter().enumerate() {
        if *marker == 0 {
            continue;
        }
        if let Some(element) = mesh.cells.item_nodes(element_index) {
            node_indices.extend(element.iter().map(|index| *index as usize));
        }
    }
    node_indices
}

fn node_indices_for_segment(
    mesh: &FemMeshPayload,
    segment: &fullmag_runner::FemMeshObjectSegment,
) -> Vec<usize> {
    let mut node_indices = BTreeSet::new();

    let start = segment.node_start as usize;
    let end = start.saturating_add(segment.node_count as usize);
    node_indices.extend(start..end);

    let element_start = segment.element_start as usize;
    let element_end = element_start.saturating_add(segment.element_count as usize);
    if element_end <= mesh.cell_count() {
        for element_index in element_start..element_end {
            let Some(element) = mesh.cells.item_nodes(element_index) else {
                continue;
            };
            node_indices.extend(element.iter().map(|index| *index as usize));
        }
    }

    let face_start = segment.boundary_face_start as usize;
    let face_end = face_start.saturating_add(segment.boundary_face_count as usize);
    if face_end <= mesh.facet_count() {
        for face_index in face_start..face_end {
            let Some(face) = mesh.facets.item_nodes(face_index) else {
                continue;
            };
            node_indices.extend(face.iter().map(|index| *index as usize));
        }
    }

    node_indices.into_iter().collect()
}

fn resolve_part_scope(
    mesh: &FemMeshPayload,
    part_id: &str,
    public_kind: &str,
) -> Result<ResolvedFieldScope, ApiError> {
    let part = mesh
        .mesh_parts
        .iter()
        .find(|part| part.id == part_id)
        .ok_or_else(|| ApiError::not_found(format!("mesh part not found: {part_id}")))?;
    Ok(ResolvedFieldScope {
        domain: if part.role == "air" {
            ResolvedFieldScopeDomain::Air
        } else {
            ResolvedFieldScopeDomain::Magnetic
        },
        kind: public_kind.to_string(),
        id: Some(part.id.clone()),
        node_indices: node_indices_for_part(part),
        value_indices: Vec::new(),
        grid: None,
        carrier_hash: None,
    })
}

fn resolve_selection_scope(
    mesh: &FemMeshPayload,
    selection: &crate::schemas::workspace::WorkspaceSelectionResource,
) -> Result<ResolvedFieldScope, ApiError> {
    if let Some(object_id) = selection.selected_object_id.as_deref() {
        return resolve_object_scope(mesh, object_id);
    }
    if let Some(entity_id) = selection.selected_entity_id.as_deref() {
        if mesh.mesh_parts.iter().any(|part| part.id == entity_id) {
            return resolve_part_scope(mesh, entity_id, "selection");
        }
        if mesh
            .object_segments
            .iter()
            .any(|segment| object_segment_ids_match(segment, entity_id))
        {
            let mut scope = resolve_object_scope(mesh, entity_id)?;
            scope.kind = "selection".to_string();
            return Ok(scope);
        }
    }
    if let Some(node_id) = selection.selected_node_id.as_deref() {
        if node_id == "universe-airbox" || node_id == "universe-airbox-mesh" {
            let air_part_id = mesh
                .mesh_parts
                .iter()
                .find(|part| part.role == "air")
                .map(|part| part.id.clone())
                .ok_or_else(|| ApiError::not_found("airbox mesh part not found"))?;
            return resolve_part_scope(mesh, &air_part_id, "selection");
        }
        if mesh.mesh_parts.iter().any(|part| part.id == node_id) {
            return resolve_part_scope(mesh, node_id, "selection");
        }
        if mesh
            .object_segments
            .iter()
            .any(|segment| object_segment_ids_match(segment, node_id))
        {
            let mut scope = resolve_object_scope(mesh, node_id)?;
            scope.kind = "selection".to_string();
            return Ok(scope);
        }
    }
    Err(ApiError::bad_request(
        "current workspace selection does not resolve to a mesh scope",
    ))
}

fn apply_field_scope(
    raw_values: Vec<f64>,
    grid: [u32; 3],
    n_comp: usize,
    scope: Option<&ResolvedFieldScope>,
) -> Vec<f64> {
    let Some(scope) = scope else {
        return raw_values;
    };
    if n_comp == 0 {
        return raw_values;
    }
    let mut scoped = Vec::with_capacity(scope.value_indices.len() * n_comp);
    for point_index in &scope.value_indices {
        let start = point_index.saturating_mul(n_comp);
        let end = start.saturating_add(n_comp);
        if end <= raw_values.len() {
            scoped.extend_from_slice(&raw_values[start..end]);
        }
    }
    let _ = grid;
    scoped
}

fn resolve_field_vector_sample_limit(
    query: &FieldVectorQuery,
    scope: Option<&ResolvedFieldScope>,
    is_fdm: bool,
) -> Result<Option<usize>, ApiError> {
    let Some(max_samples) = query.max_samples else {
        return Ok(None);
    };
    if max_samples == 0 {
        return Err(ApiError::bad_request(
            "max_samples must be greater than zero",
        ));
    }
    // Full-domain FDM remains on the legacy FMVP v2 contract and has no cell
    // ordinal mapping. Single-grid scoped FDM carries explicit cell ordinals
    // in FMVP v3, so it can safely honour max_samples. Multilayer native
    // scopes remain unchanged until their separate sampling contract is
    // qualified.
    if is_fdm && (scope.is_none() || scope.is_some_and(|scope| scope.grid.is_some())) {
        return Ok(None);
    }
    Ok(Some(max_samples as usize))
}

fn sample_field_scope(
    mut scope: ResolvedFieldScope,
    max_samples: Option<usize>,
) -> ResolvedFieldScope {
    let Some(max_samples) = max_samples else {
        return scope;
    };
    if max_samples >= scope.node_indices.len() {
        return scope;
    }

    let sample_count = max_samples.max(1);
    let stride = (scope.node_indices.len() / sample_count).max(1);
    let sampled_positions = (0..sample_count)
        .map(|sample| sample * stride)
        .collect::<Vec<_>>();
    scope.node_indices = sampled_positions
        .iter()
        .filter_map(|position| scope.node_indices.get(*position).copied())
        .collect();
    scope.value_indices = sampled_positions
        .iter()
        .filter_map(|position| scope.value_indices.get(*position).copied())
        .collect();
    scope
}

fn field_vector_sample_cache_token(max_samples: Option<usize>) -> String {
    max_samples
        .map(|value| format!(":max_samples={value}"))
        .unwrap_or_default()
}

fn field_node_indices_cache_token(node_indices: Option<&[u32]>) -> String {
    let Some(node_indices) = node_indices else {
        return "none".to_string();
    };
    if node_indices.is_empty() {
        return "empty".to_string();
    }
    node_indices
        .iter()
        .map(u32::to_string)
        .collect::<Vec<_>>()
        .join(",")
}

fn mesh_topology_hash_bytes(hash: &str) -> Result<[u8; 32], ApiError> {
    let hash = hash.strip_prefix("sha256:").ok_or_else(|| {
        ApiError::internal("mesh topology fingerprint must use the canonical sha256: prefix")
    })?;
    let mut bytes = [0u8; 32];
    if hash.len() != 64 {
        return Err(ApiError::internal(format!(
            "mesh topology hash must be 64 hex characters, got {}",
            hash.len()
        )));
    }
    for (index, chunk) in hash.as_bytes().chunks_exact(2).enumerate() {
        let raw = std::str::from_utf8(chunk).map_err(|error| {
            ApiError::internal(format!(
                "mesh topology hash is not valid UTF-8 hex: {error}"
            ))
        })?;
        bytes[index] = u8::from_str_radix(raw, 16).map_err(|error| {
            ApiError::internal(format!("mesh topology hash contains invalid hex: {error}"))
        })?;
    }
    Ok(bytes)
}

fn sample_unscoped_field_values(
    raw_values: Vec<f64>,
    grid: [u32; 3],
    n_comp: usize,
    max_samples: Option<usize>,
) -> (Vec<f64>, [u32; 3], Option<Vec<usize>>) {
    let Some(max_samples) = max_samples else {
        return (raw_values, grid, None);
    };
    let n_comp = n_comp.max(1);
    let point_count = raw_values.len() / n_comp;
    if max_samples >= point_count {
        return (raw_values, grid, None);
    }

    let sample_count = max_samples.max(1);
    let start = point_count.saturating_sub(sample_count) / 2;
    let mut sampled = Vec::with_capacity(sample_count * n_comp);
    for point_index in start..start + sample_count {
        let offset = point_index * n_comp;
        sampled.extend_from_slice(&raw_values[offset..offset + n_comp]);
    }

    (
        sampled,
        [sample_count as u32, 1, 1],
        Some((start..start + sample_count).collect()),
    )
}

// ── Binary vector — P1 ───────────────────────────────────────────────────────

#[utoipa::path(
    get,
    path = "/v2/sessions/current/data/fields/{quantity_id}/samples/vector",
    params(
        ("quantity_id" = String, Path, description = "Quantity identifier"),
        ("If-None-Match" = Option<String>, Header, description = "Strong ETag from a previous field-vector response"),
        FieldVectorQuery,
    ),
    responses(
        (status = 200, description = "Binary FMVP field vector. Scoped FEM and FDM payloads use FMVP v3 metadata with domain_generation_id, carrier topology revision/hash, scope kind/id, indexing, and optional node_indices. Multilayer FDM layer/object scopes identify their native grid carrier. FMVP v2 remains accepted for legacy full-domain payloads.", content_type = "application/octet-stream", headers(
            ("x-fullmag-field-revision" = String, description = "Field revision"),
            ("x-fullmag-domain-generation-id" = String, description = "Domain generation identity"),
            ("x-fullmag-quantity-id" = String, description = "Canonical quantity identifier"),
            ("x-fullmag-component" = String, description = "Resolved component projection"),
            ("x-fullmag-encoding" = String, description = "FMVP encoding and version"),
            ("x-fullmag-point-count" = usize, description = "Decoded point count"),
            ("x-fullmag-value-count" = usize, description = "Scalar value count"),
            ("x-fullmag-n-comp" = usize, description = "Components per point"),
            ("x-fullmag-scope-kind" = String, description = "Resolved scope kind"),
            ("x-fullmag-scope-id" = String, description = "Resolved optional scope identifier"),
            ("x-fullmag-snapshot-id" = String, description = "Optional persisted snapshot identifier"),
            ("x-fullmag-mesh-topology-hash" = String, description = "Optional FMVP v3 mesh topology hash"),
            ("x-fullmag-field-indexing" = String, description = "Optional FMVP v3 field indexing"),
            ("x-fullmag-node-index-count" = usize, description = "Optional FMVP v3 node-index count")
        )),
        (status = 204, description = "Recognized field quantity is not available yet"),
        (status = 304, description = "Not modified — ETag matched"),
        (status = 400, description = "Invalid component or snapshot parameter"),
        (status = 404, description = "Field not found"),
        (status = 409, description = "Snapshot does not match the current domain"),
    ),
    tag = "data"
)]
pub async fn get_field_vector(
    State(state): State<Arc<AppState>>,
    headers: HeaderMap,
    AxumPath(quantity_id): AxumPath<String>,
    Query(query): Query<FieldVectorQuery>,
) -> Result<axum::response::Response, ApiError> {
    let quantity_id = canonical_quantity_id(&quantity_id);
    let quantity_id = quantity_id.as_ref();
    resolve_field_geometry_scope(&query)?;
    let workspace_selection = if query.scope_kind.as_deref() == Some("selection") {
        Some(state.current_workspace_selection.read().await.clone())
    } else {
        None
    };
    let guard = state.current_live_state.read().await;
    let Some(snapshot) = guard.as_ref() else {
        return Ok(StatusCode::NO_CONTENT.into_response());
    };
    if let Some(response) =
        analysis_frequency_response_vector_response(snapshot, quantity_id, &query, &headers)?
    {
        return Ok(response);
    }
    if let Some(response) =
        analysis_eigen_mode_vector_response(snapshot, quantity_id, &query, &headers)?
    {
        return Ok(response);
    }

    let spec = quantity_spec(quantity_id);
    let n_comp: usize = spec.map(|s| s.n_comp as usize).unwrap_or(3);

    let component = parse_component(query.component.as_deref(), n_comp)?;
    let airbox_carrier = requested_fdm_multilayer_airbox_carrier(snapshot, &query, quantity_id)?;

    let session_id = snapshot.session.session_id.clone();
    let transport_artifact = canonical_transport_field_artifact(snapshot, quantity_id)?;
    let transport_artifact_revision =
        canonical_transport_field_artifact_revision(transport_artifact.as_ref());
    let field_revision = if airbox_carrier.is_some() {
        snapshot.field_samples_revision
    } else if transport_artifact.is_some() {
        transport_artifact_revision
    } else {
        field_quantity_revision(snapshot, quantity_id)
    };
    let gen_id = domain_generation_id(snapshot);
    let gen_revision = domain_generation_revision(snapshot);
    let requested_snapshot_id = query
        .snapshot_id
        .as_deref()
        .map(str::trim)
        .filter(|id| !id.is_empty());

    // Collect raw values under the lock, then drop the lock before any heavy work
    let transport_artifact_values = || {
        transport_artifact.as_ref().and_then(|raw| {
            let values = flatten_json_field_values(raw);
            if !field_values_match_current_domain(snapshot, quantity_id, n_comp, &values) {
                return None;
            }
            let element_count = values.len() / n_comp;
            let grid = resolved_current_field_grid(snapshot, json_field_grid(raw), element_count);
            Some((values, grid))
        })
    };
    let raw_values_opt: Option<(Vec<f64>, [u32; 3])> = if let Some(carrier) =
        airbox_carrier.as_ref()
    {
        Some((carrier.values.clone(), carrier.cells))
    } else if let Some(snapshot_id) = requested_snapshot_id {
        if quantity_id != "m" {
            return Err(ApiError::bad_request(format!(
                "persisted hysteresis snapshot '{snapshot_id}' is only available for magnetization"
            )));
        }
        validate_hysteresis_snapshot_stage_scope(&state, query.stage_id.as_deref(), snapshot_id)
            .await?;
        Some(persisted_hysteresis_magnetization_values(
            snapshot,
            snapshot_id,
        )?)
    } else {
        transport_artifact_values().or_else(|| {
            resolved_current_field_values(snapshot, quantity_id, n_comp)
                .map(|(values, grid, _freshness)| (values, grid))
        })
    };
    let has_field_source = airbox_carrier.is_some()
        || snapshot.latest_fields.get(quantity_id).is_some()
        || snapshot.preview_cache.get(quantity_id).is_some()
        || transport_artifact.is_some()
        || (quantity_id == "m"
            && snapshot
                .live_state
                .as_ref()
                .and_then(|state| state.latest_step.magnetization.as_ref())
                .is_some());

    let (raw_values, grid) = match raw_values_opt {
        Some(values) => values,
        None if spec.is_some() && !has_field_source => {
            return Ok(StatusCode::NO_CONTENT.into_response());
        }
        None => {
            return Err(ApiError::not_found(format!(
                "field '{}' not available in memory",
                quantity_id
            )));
        }
    };
    let raw_point_count = if n_comp > 0 {
        raw_values.len() / n_comp
    } else {
        raw_values.len()
    };
    let resolved_scope = if let Some(carrier) = airbox_carrier.as_ref() {
        Some(fdm_multilayer_airbox_scope(carrier))
    } else {
        resolve_field_scope(
            &query,
            snapshot,
            workspace_selection.as_ref(),
            raw_point_count,
            quantity_id,
        )?
    };
    let sample_limit = resolve_field_vector_sample_limit(
        &query,
        resolved_scope.as_ref(),
        is_fdm_snapshot(snapshot),
    )?;
    let resolved_scope = resolved_scope.map(|scope| sample_field_scope(scope, sample_limit));
    let topology_hash = if is_fdm_snapshot(snapshot) {
        resolved_scope
            .as_ref()
            .and_then(|scope| scope.carrier_hash.clone())
    } else {
        snapshot
            .fem_mesh
            .as_ref()
            .map(fullmag_runner::fem_mesh_topology_fingerprint)
    };
    let topology_hash_bytes = topology_hash
        .as_deref()
        .map(mesh_topology_hash_bytes)
        .transpose()?;
    let topology_revision = if is_fdm_snapshot(snapshot) {
        gen_revision
    } else {
        snapshot.mesh_revision
    };
    let scoped_node_indices = resolved_scope
        .as_ref()
        .map(|scope| scope.node_indices.clone());

    drop(guard);

    let scope_token = resolved_scope
        .as_ref()
        .map(ResolvedFieldScope::cache_token)
        .unwrap_or_else(|| "full-domain".to_string());
    let sample_token = field_vector_sample_cache_token(sample_limit);
    let geometry_scope_token = query
        .geometry_scope
        .as_deref()
        .map(str::trim)
        .filter(|value| !value.is_empty() && *value != "full")
        .map(|value| format!(":geometry_scope={value}"))
        .unwrap_or_default();
    let snapshot_token = requested_snapshot_id
        .map(|snapshot_id| format!(":snapshot={snapshot_id}"))
        .unwrap_or_default();
    let topology_etag_token = topology_hash
        .as_ref()
        .map(|hash| format!(":topology_revision={topology_revision}:topology_hash={hash}"))
        .unwrap_or_default();
    let etag = crate::router_v2::handlers::shared::stable_strong_etag(&format!(
        "{}:{scope_token}{geometry_scope_token}{sample_token}{snapshot_token}{topology_etag_token}",
        component_etag_token(
            quantity_id,
            session_id.as_str(),
            field_revision,
            gen_revision,
            &component,
        )
    ));
    let scoped_grid = resolved_scope
        .as_ref()
        .map(|scope| {
            scope
                .grid
                .unwrap_or([scope.node_indices.len() as u32, 1, 1])
        })
        .unwrap_or(grid);
    let (raw_values, scoped_grid, sampled_node_indices) = if resolved_scope.is_some() {
        (
            apply_field_scope(raw_values, grid, n_comp, resolved_scope.as_ref()),
            scoped_grid,
            None,
        )
    } else {
        sample_unscoped_field_values(raw_values, scoped_grid, n_comp, sample_limit)
    };
    let field_node_indices = scoped_node_indices.or(sampled_node_indices);
    let field_node_indices_u32 = field_node_indices
        .as_ref()
        .map(|node_indices| {
            node_indices
                .iter()
                .map(|index| {
                    u32::try_from(*index).map_err(|_| {
                        ApiError::internal(format!(
                            "field node index {index} exceeds u32 payload capacity"
                        ))
                    })
                })
                .collect::<Result<Vec<_>, ApiError>>()
        })
        .transpose()?;
    let field_indexing = topology_hash
        .as_ref()
        .map(|_| match field_node_indices_u32.as_ref() {
            Some(_) if sample_limit.is_some() => FieldVectorIndexing::SampledNodeIndices,
            Some(_) => FieldVectorIndexing::ExplicitNodeIndices,
            None => FieldVectorIndexing::FullDomain,
        });
    let scope_kind_for_metadata = resolved_scope
        .as_ref()
        .map(|scope| scope.kind.as_str())
        .unwrap_or("full");
    let scope_id_for_metadata = resolved_scope
        .as_ref()
        .and_then(|scope| scope.id.as_deref())
        .unwrap_or("");
    let topology_cache_token = topology_hash
        .as_ref()
        .map(|hash| {
            format!(
                ":topology_hash={hash}:node_indices={}",
                field_node_indices_cache_token(field_node_indices_u32.as_deref())
            )
        })
        .unwrap_or_default();

    // P4: check projection cache before doing heavy projection work
    let comp_key = match &component {
        ComponentSelection::Full => "full".to_string(),
        ComponentSelection::Magnitude => "magnitude".to_string(),
        ComponentSelection::MagnitudeSquared => "magnitude_squared".to_string(),
        ComponentSelection::AbsIndex(i) => format!("abs_c{}", i),
        ComponentSelection::Index(i) => format!("c{}", i),
    };
    let cache_key = crate::quantity_data_plane::projection_cache_key(
        quantity_id,
        session_id.as_str(),
        field_revision,
        gen_revision,
        &format!("{comp_key}:{scope_token}{sample_token}{snapshot_token}{topology_cache_token}"),
    );
    {
        let mut proj_cache = state.quantity_data_plane.projection_cache.lock().await;
        if let Some(cached) = proj_cache.get(&cache_key) {
            let binary = cached.bytes.clone();
            drop(proj_cache);
            let (encoding_version, point_count, total_value_count) =
                field_vector_binary_header_counts(&binary);
            let mut resp = crate::router_v2::handlers::shared::conditional_binary_response(
                &headers, &etag, binary,
            );
            insert_field_headers(
                &mut resp,
                quantity_id,
                &component,
                field_revision,
                &gen_id,
                point_count,
                total_value_count,
            );
            insert_field_vector_binary_headers(
                &mut resp,
                encoding_version,
                topology_hash.as_deref(),
                field_indexing,
                field_node_indices_u32.as_ref().map(Vec::len),
            );
            insert_scope_headers(&mut resp, resolved_scope.as_ref());
            insert_snapshot_header(&mut resp, requested_snapshot_id);
            return Ok(resp);
        }
    }

    // Heavy work outside the lock
    let (out_n_comp, projected) = project_values(&raw_values, n_comp, &component)?;
    let point_count = if out_n_comp > 0 {
        projected.len() / out_n_comp
    } else {
        projected.len()
    };
    let value_count = projected.len();

    // Adjust grid for scalar output
    let out_grid = if out_n_comp == 1 && n_comp > 1 {
        [scoped_grid[0], scoped_grid[1], scoped_grid[2]]
    } else {
        scoped_grid
    };

    let binary = if let (Some(topology_hash_bytes), Some(topology_hash)) =
        (topology_hash_bytes, topology_hash.as_deref())
    {
        let indexing = field_indexing.unwrap_or(FieldVectorIndexing::FullDomain);
        let metadata = FieldVectorBinaryMetadata {
            domain_generation_id: &gen_id,
            mesh_topology_revision: topology_revision,
            mesh_topology_hash: topology_hash_bytes,
            scope_kind: scope_kind_for_metadata,
            scope_id: scope_id_for_metadata,
            indexing,
            node_indices: field_node_indices_u32.as_deref().unwrap_or(&[]),
        };
        let binary = serialize_field_vector_binary_v3(
            quantity_id,
            out_n_comp,
            out_grid,
            &projected,
            &metadata,
        )
        .map_err(ApiError::internal)?;
        debug_assert!(!topology_hash.is_empty());
        binary
    } else {
        serialize_field_vector_binary_v2(quantity_id, out_n_comp, out_grid, &projected)
            .map_err(ApiError::internal)?
    };

    // P4: populate projection cache
    {
        let mut proj_cache = state.quantity_data_plane.projection_cache.lock().await;
        proj_cache.insert(cache_key, binary.clone(), etag.clone());
    }

    let mut resp =
        crate::router_v2::handlers::shared::conditional_binary_response(&headers, &etag, binary);

    // Add informational headers (present on both 200 and 304)
    insert_field_headers(
        &mut resp,
        quantity_id,
        &component,
        field_revision,
        &gen_id,
        point_count,
        value_count,
    );
    insert_field_vector_binary_headers(
        &mut resp,
        if topology_hash.is_some() { 3 } else { 2 },
        topology_hash.as_deref(),
        field_indexing,
        field_node_indices_u32.as_ref().map(Vec::len),
    );
    insert_scope_headers(&mut resp, resolved_scope.as_ref());
    insert_snapshot_header(&mut resp, requested_snapshot_id);

    Ok(resp)
}

fn analysis_frequency_response_vector_response(
    snapshot: &SessionStateResponse,
    field_id: &str,
    query: &FieldVectorQuery,
    headers: &HeaderMap,
) -> Result<Option<axum::response::Response>, ApiError> {
    let Some(frequency_index) = parse_analysis_frequency_response_field_id(field_id) else {
        return Ok(None);
    };
    let artifact_dir = current_artifact_dir(snapshot)
        .ok_or_else(|| ApiError::not_found("no artifact directory for analysis field payload"))?;
    let frequency_point_path = response_frequency_point_path(&artifact_dir, frequency_index)?;
    let relative_path = if let Some(path) =
        response_field_payload_path_from_manifest(&artifact_dir, frequency_index)?
    {
        path
    } else if let Some(path) =
        response_field_payload_path_from_sweep(&artifact_dir, frequency_index)?
    {
        path
    } else if let Some(path) =
        response_field_payload_path_from_point_artifact(&artifact_dir, &frequency_point_path)?
    {
        path
    } else {
        format!(
            "response/field_payloads.zarr/frequency_{frequency_index:04}/vector_xyz_complex/0.0.0"
        )
    };
    let Some(path) = try_resolve_artifact_path(&artifact_dir, &relative_path)? else {
        return Err(ApiError::not_found(format!(
            "analysis frequency-response field payload is missing: {relative_path}"
        )));
    };
    let bytes = std::fs::read(&path).map_err(|error| {
        if error.kind() == std::io::ErrorKind::NotFound {
            ApiError::not_found(format!(
                "analysis frequency-response field payload is missing: {relative_path}"
            ))
        } else {
            ApiError::internal(format!(
                "failed to read analysis frequency-response field payload '{}': {}",
                relative_path, error
            ))
        }
    })?;
    let metadata = response_field_data_plane_metadata_from_point_artifact(
        &artifact_dir,
        &frequency_point_path,
    )?;
    let effective_view = query.view.as_deref().unwrap_or(&metadata.default_view);
    let effective_phase_rad = query.phase_rad.unwrap_or(metadata.default_phase_rad);
    validate_response_field_requested_view(
        &frequency_point_path,
        &metadata.available_views,
        Some(effective_view),
    )?;
    if let Some(payload_value_count) = metadata.payload_value_count {
        let expected_size = payload_value_count.checked_mul(8).ok_or_else(|| {
            ApiError::internal(format!(
                "frequency response field payload_value_count overflows byte size in '{}'",
                frequency_point_path
            ))
        })?;
        if bytes.len() as u64 != expected_size {
            return Err(ApiError::internal(format!(
                "analysis frequency-response field payload '{}' has {} bytes, expected {}",
                relative_path,
                bytes.len(),
                expected_size
            )));
        }
    }
    let values = decode_complex_f64_pairs_little_endian(&bytes)?;
    let (raw_values, n_comp, default_component) =
        if let Some(component_count) = metadata.component_count {
            analysis_complex_component_view_values(
                &values,
                component_count,
                Some(effective_view),
                Some(effective_phase_rad),
            )?
        } else {
            analysis_frequency_response_view_values(
                &values,
                Some(effective_view),
                Some(effective_phase_rad),
            )?
        };
    let component = parse_component(query.component.as_deref().or(default_component), n_comp)?;
    let (out_n_comp, projected) = project_values(&raw_values, n_comp, &component)?;
    let point_count = raw_values.len() / n_comp;
    let out_grid = [point_count as u32, 1, 1];
    let binary = serialize_analysis_field_vector_binary(
        snapshot, field_id, out_n_comp, out_grid, &projected, None,
    )?;
    let revision = analysis_payload_revision(snapshot, &relative_path, bytes.len());
    let etag = crate::router_v2::handlers::shared::stable_strong_etag(&format!(
        "{field_id}:{revision}:{}:{}:{}",
        effective_view,
        query
            .component
            .as_deref()
            .unwrap_or(default_component.unwrap_or("full")),
        effective_phase_rad
    ));
    let mut resp =
        crate::router_v2::handlers::shared::conditional_binary_response(headers, &etag, binary);
    insert_field_headers(
        &mut resp,
        field_id,
        &component,
        revision,
        &domain_generation_id(snapshot),
        point_count,
        projected.len(),
    );
    Ok(Some(resp))
}

fn response_field_payload_path_from_manifest(
    artifact_dir: &std::path::Path,
    frequency_index: u32,
) -> Result<Option<String>, ApiError> {
    if try_resolve_artifact_path(artifact_dir, "frequency_domain/manifest.v1.json")?.is_none() {
        return Ok(None);
    }
    let manifest = read_json_artifact_value(artifact_dir, "frequency_domain/manifest.v1.json")?;
    Ok(manifest
        .get("resources")
        .and_then(|resources| resources.get("response_field_resources"))
        .and_then(serde_json::Value::as_array)
        .and_then(|resources| {
            resources.iter().find_map(|resource| {
                let resource = resource.as_object()?;
                let index = resource.get("frequency_index")?.as_u64()?;
                if index == u64::from(frequency_index) {
                    resource
                        .get("payload_path")
                        .and_then(serde_json::Value::as_str)
                        .map(str::to_string)
                } else {
                    None
                }
            })
        }))
}

fn response_field_payload_path_from_sweep(
    artifact_dir: &std::path::Path,
    frequency_index: u32,
) -> Result<Option<String>, ApiError> {
    response_sweep_linked_path(
        artifact_dir,
        frequency_index,
        "response_field_payload_path",
        "response_field_payload_paths",
    )
}

fn response_frequency_point_path_from_sweep(
    artifact_dir: &std::path::Path,
    frequency_index: u32,
) -> Result<Option<String>, ApiError> {
    response_sweep_linked_path(
        artifact_dir,
        frequency_index,
        "frequency_point_artifact_path",
        "frequency_point_artifact_paths",
    )
}

fn response_frequency_point_path(
    artifact_dir: &std::path::Path,
    frequency_index: u32,
) -> Result<String, ApiError> {
    Ok(
        response_frequency_point_path_from_sweep(artifact_dir, frequency_index)?.unwrap_or_else(
            || format!("response/frequency_points/frequency_{frequency_index:04}.json"),
        ),
    )
}

fn response_field_payload_path_from_point_artifact(
    artifact_dir: &std::path::Path,
    frequency_point_artifact_path: &str,
) -> Result<Option<String>, ApiError> {
    if try_resolve_artifact_path(artifact_dir, frequency_point_artifact_path)?.is_none() {
        return Ok(None);
    }
    let point = read_json_artifact_value(artifact_dir, frequency_point_artifact_path)?;
    point
        .get("field_payload_path")
        .and_then(serde_json::Value::as_str)
        .map(str::to_string)
        .map(Some)
        .ok_or_else(|| {
            ApiError::internal(format!(
                "missing required frequency response field_payload_path in '{}'",
                frequency_point_artifact_path
            ))
        })
}

fn serialize_analysis_field_vector_binary(
    snapshot: &SessionStateResponse,
    field_id: &str,
    out_n_comp: usize,
    out_grid: [u32; 3],
    projected: &[f64],
    scope: Option<&ResolvedFieldScope>,
) -> Result<Vec<u8>, ApiError> {
    let Some(mesh) = snapshot.fem_mesh.as_ref() else {
        return serialize_field_vector_binary_v2(field_id, out_n_comp, out_grid, projected)
            .map_err(ApiError::internal);
    };
    let point_count = if out_n_comp > 0 {
        projected.len() / out_n_comp
    } else {
        projected.len()
    };
    let full_node_count = mesh.nodes.len();
    let node_indices = if let Some(scope) = scope {
        if scope.node_indices.len() != point_count {
            return Err(ApiError::conflict(format!(
                "mode_field_object_coverage_incomplete: object scope has {} nodes but the scoped mode payload has {point_count} points",
                scope.node_indices.len()
            )));
        }
        scope
            .node_indices
            .iter()
            .map(|index| {
                u32::try_from(*index).map_err(|_| {
                    ApiError::internal(format!(
                        "analysis field node index {index} exceeds u32 payload capacity"
                    ))
                })
            })
            .collect::<Result<Vec<_>, ApiError>>()?
    } else if point_count == full_node_count {
        Vec::new()
    } else {
        let indices = magnetic_node_index_set(mesh);
        if indices.len() != point_count {
            return serialize_field_vector_binary_v2(field_id, out_n_comp, out_grid, projected)
                .map_err(ApiError::internal);
        }
        indices
            .into_iter()
            .map(|index| {
                u32::try_from(index).map_err(|_| {
                    ApiError::internal(format!(
                        "analysis field node index {index} exceeds u32 payload capacity"
                    ))
                })
            })
            .collect::<Result<Vec<_>, ApiError>>()?
    };
    let topology_hash = fullmag_runner::fem_mesh_topology_fingerprint(mesh);
    let topology_hash_bytes = mesh_topology_hash_bytes(&topology_hash)?;
    let indexing = if node_indices.is_empty() {
        FieldVectorIndexing::FullDomain
    } else {
        FieldVectorIndexing::ExplicitNodeIndices
    };
    let metadata = FieldVectorBinaryMetadata {
        domain_generation_id: &domain_generation_id(snapshot),
        mesh_topology_revision: snapshot.mesh_revision,
        mesh_topology_hash: topology_hash_bytes,
        scope_kind: scope.map(|scope| scope.kind.as_str()).unwrap_or_else(|| {
            if node_indices.is_empty() {
                "full"
            } else {
                "magnetic_only"
            }
        }),
        scope_id: scope.and_then(|scope| scope.id.as_deref()).unwrap_or(""),
        indexing,
        node_indices: &node_indices,
    };
    serialize_field_vector_binary_v3(field_id, out_n_comp, out_grid, projected, &metadata)
        .map_err(ApiError::internal)
}

struct ResponseFieldDataPlaneMetadata {
    payload_path: String,
    component_count: Option<usize>,
    payload_value_count: Option<u64>,
    available_views: Vec<String>,
    default_view: String,
    default_phase_rad: f64,
    source_mesh_identity: Option<EigenModeSourceMeshIdentity>,
    component_basis: Option<String>,
    object_coverage: Option<Vec<EigenModeObjectCoverage>>,
}

#[derive(Debug, Clone, Deserialize)]
struct EigenModeSourceMeshIdentity {
    mesh_generation_id: Option<String>,
    mesh_revision: Option<u64>,
    topology_fingerprint: String,
    indexing: String,
    node_count: u64,
}

#[derive(Debug, Clone, Deserialize)]
struct EigenModeObjectCoverage {
    object_id: String,
    point_count: u64,
}

fn default_frequency_domain_field_views() -> Vec<String> {
    vec![
        "complex".to_string(),
        "real".to_string(),
        "imag".to_string(),
        "abs".to_string(),
        "amplitude".to_string(),
        "phase".to_string(),
        "phase_rotated_real".to_string(),
    ]
}

fn response_sweep_linked_path(
    artifact_dir: &std::path::Path,
    frequency_index: u32,
    point_field: &str,
    list_field: &str,
) -> Result<Option<String>, ApiError> {
    if try_resolve_artifact_path(artifact_dir, "response/magnetic_response_sweep.v2.json")?
        .is_none()
    {
        return Ok(None);
    }
    let sweep = read_json_artifact_value(artifact_dir, "response/magnetic_response_sweep.v2.json")?;
    if let Some(path) = sweep
        .get("points")
        .and_then(serde_json::Value::as_array)
        .and_then(|points| {
            points.iter().find_map(|point| {
                let point = point.as_object()?;
                let index = point.get("frequency_index")?.as_u64()?;
                if index == u64::from(frequency_index) {
                    point
                        .get(point_field)
                        .and_then(serde_json::Value::as_str)
                        .map(str::to_string)
                } else {
                    None
                }
            })
        })
    {
        return Ok(Some(path));
    }
    Ok(sweep
        .get(list_field)
        .and_then(serde_json::Value::as_array)
        .and_then(|paths| paths.get(frequency_index as usize))
        .and_then(serde_json::Value::as_str)
        .map(str::to_string))
}

fn response_field_data_plane_metadata_from_point_artifact(
    artifact_dir: &std::path::Path,
    relative_path: &str,
) -> Result<ResponseFieldDataPlaneMetadata, ApiError> {
    if try_resolve_artifact_path(artifact_dir, relative_path)?.is_none() {
        return Ok(ResponseFieldDataPlaneMetadata {
            payload_path: relative_path.to_string(),
            component_count: Some(3),
            payload_value_count: None,
            available_views: default_frequency_domain_field_views(),
            default_view: "complex".to_string(),
            default_phase_rad: 0.0,
            source_mesh_identity: None,
            component_basis: None,
            object_coverage: None,
        });
    }
    let point = read_json_artifact_value(artifact_dir, relative_path)?;
    let Some(component_count) = point
        .get("component_count")
        .and_then(serde_json::Value::as_u64)
    else {
        return Err(ApiError::internal(format!(
            "missing required frequency response field component_count in '{}'",
            relative_path
        )));
    };
    if component_count == 0 || component_count > 64 {
        return Err(ApiError::internal(format!(
            "invalid frequency response field component_count in '{}'",
            relative_path
        )));
    }
    let Some(complex_pair_count) = point
        .get("complex_pair_count")
        .and_then(serde_json::Value::as_u64)
    else {
        return Err(ApiError::internal(format!(
            "missing required frequency response field complex_pair_count in '{}'",
            relative_path
        )));
    };
    let Some(payload_value_count) = point
        .get("payload_value_count")
        .and_then(serde_json::Value::as_u64)
    else {
        return Err(ApiError::internal(format!(
            "missing required frequency response field payload_value_count in '{}'",
            relative_path
        )));
    };
    let Some(expected_payload_value_count) = complex_pair_count.checked_mul(2) else {
        return Err(ApiError::internal(format!(
            "frequency response field complex_pair_count overflows payload_value_count in '{}'",
            relative_path
        )));
    };
    if payload_value_count != expected_payload_value_count {
        return Err(ApiError::internal(format!(
            "invalid frequency response field payload_value_count in '{}'",
            relative_path
        )));
    }
    let available_views = validate_response_field_available_views(&point, relative_path)?;
    let default_view = validate_response_field_default_view(&point, relative_path)?;
    let default_phase_rad = validate_response_field_default_phase_rad(&point, relative_path)?;
    Ok(ResponseFieldDataPlaneMetadata {
        payload_path: relative_path.to_string(),
        component_count: Some(component_count as usize),
        payload_value_count: Some(payload_value_count),
        available_views,
        default_view,
        default_phase_rad,
        source_mesh_identity: None,
        component_basis: None,
        object_coverage: None,
    })
}

fn eigen_mode_data_plane_metadata_from_mode_artifact(
    artifact_dir: &std::path::Path,
    sample_index: u32,
    mode_index: u32,
) -> Result<ResponseFieldDataPlaneMetadata, ApiError> {
    let relative_path = format!("eigen/modes/sample_{sample_index:04}/mode_{mode_index:04}.json");
    if try_resolve_artifact_path(artifact_dir, &relative_path)?.is_none() {
        return Err(ApiError::internal(format!(
            "eigen mode field payload is present but metadata '{}' is missing",
            relative_path
        )));
    }
    let mode = read_json_artifact_value(artifact_dir, &relative_path)?;
    let Some(component_count) = mode
        .get("component_count")
        .and_then(serde_json::Value::as_u64)
    else {
        return Err(ApiError::internal(format!(
            "missing required eigen mode field component_count in '{}'",
            relative_path
        )));
    };
    if component_count == 0 || component_count > 64 {
        return Err(ApiError::internal(format!(
            "invalid eigen mode field component_count in '{}'",
            relative_path
        )));
    }
    let Some(complex_pair_count) = mode
        .get("complex_pair_count")
        .and_then(serde_json::Value::as_u64)
    else {
        return Err(ApiError::internal(format!(
            "missing required eigen mode field complex_pair_count in '{}'",
            relative_path
        )));
    };
    let Some(payload_value_count) = mode
        .get("payload_value_count")
        .and_then(serde_json::Value::as_u64)
    else {
        return Err(ApiError::internal(format!(
            "missing required eigen mode field payload_value_count in '{}'",
            relative_path
        )));
    };
    let Some(expected_payload_value_count) = complex_pair_count.checked_mul(2) else {
        return Err(ApiError::internal(format!(
            "eigen mode field complex_pair_count overflows payload_value_count in '{}'",
            relative_path
        )));
    };
    if payload_value_count != expected_payload_value_count {
        return Err(ApiError::internal(format!(
            "invalid eigen mode field payload_value_count in '{}'",
            relative_path
        )));
    }
    let available_views = validate_response_field_available_views(&mode, &relative_path)?;
    let default_view = validate_response_field_default_view(&mode, &relative_path)?;
    let default_phase_rad = validate_response_field_default_phase_rad(&mode, &relative_path)?;
    let source_mesh_identity = mode
        .get("source_mesh_identity")
        .cloned()
        .ok_or_else(|| {
            ApiError::conflict(format!(
                "stale_eigen_mode_mesh: eigen mode metadata '{}' has no immutable source mesh identity",
                relative_path
            ))
        })
        .and_then(|value| {
            serde_json::from_value::<EigenModeSourceMeshIdentity>(value).map_err(|error| {
                ApiError::conflict(format!(
                    "stale_eigen_mode_mesh: eigen mode metadata '{}' has invalid source mesh identity: {}",
                    relative_path, error
                ))
            })
        })?;
    let component_basis = mode
        .get("component_basis")
        .and_then(serde_json::Value::as_str)
        .map(str::to_string);
    let object_coverage = mode
        .get("object_coverage")
        .cloned()
        .map(serde_json::from_value::<Vec<EigenModeObjectCoverage>>)
        .transpose()
        .map_err(|error| {
            ApiError::internal(format!(
                "invalid eigen mode field object_coverage in '{}': {error}",
                relative_path
            ))
        })?;
    let payload_path = eigen_mode_data_plane_payload_path(
        artifact_dir,
        &mode,
        sample_index,
        mode_index,
        &relative_path,
    )?;
    Ok(ResponseFieldDataPlaneMetadata {
        payload_path,
        component_count: Some(component_count as usize),
        payload_value_count: Some(payload_value_count),
        available_views,
        default_view,
        default_phase_rad,
        source_mesh_identity: Some(source_mesh_identity),
        component_basis,
        object_coverage,
    })
}

fn eigen_mode_data_plane_payload_path(
    artifact_dir: &std::path::Path,
    mode: &serde_json::Value,
    sample_index: u32,
    mode_index: u32,
    mode_metadata_path: &str,
) -> Result<String, ApiError> {
    for field in ["zarr_chunk_path", "compatibility_binary_payload_path"] {
        if let Some(path) = mode.get(field).and_then(serde_json::Value::as_str) {
            if try_resolve_artifact_path(artifact_dir, path)?.is_some() {
                return Ok(path.to_string());
            }
        }
    }
    let legacy_path =
        format!("eigen/mode_fields/sample_{sample_index:04}/mode_{mode_index:04}/vector.bin");
    if try_resolve_artifact_path(artifact_dir, &legacy_path)?.is_some() {
        return Ok(legacy_path);
    }
    if mode.get("zarr_chunk_path").is_some()
        || mode.get("compatibility_binary_payload_path").is_some()
    {
        return Err(ApiError::not_found(format!(
            "analysis eigen mode field payload is missing for metadata: {mode_metadata_path}"
        )));
    }
    Ok(legacy_path)
}

fn validate_response_field_available_views(
    point: &serde_json::Value,
    relative_path: &str,
) -> Result<Vec<String>, ApiError> {
    let Some(available_views) = point
        .get("available_views")
        .and_then(serde_json::Value::as_array)
    else {
        return Err(ApiError::internal(format!(
            "missing required frequency response field available_views in '{}'",
            relative_path
        )));
    };
    if available_views.is_empty() || available_views.iter().any(|view| !view.is_string()) {
        return Err(ApiError::internal(format!(
            "invalid frequency response field available_views in '{}'",
            relative_path
        )));
    }
    for required_view in ["complex", "real", "imag", "phase", "phase_rotated_real"] {
        if !available_views
            .iter()
            .filter_map(serde_json::Value::as_str)
            .any(|view| view == required_view)
        {
            return Err(ApiError::internal(format!(
                "missing required frequency response field available view '{required_view}' in '{}'",
                relative_path
            )));
        }
    }
    if !available_views
        .iter()
        .filter_map(serde_json::Value::as_str)
        .any(|view| view == "abs" || view == "amplitude")
    {
        return Err(ApiError::internal(format!(
            "missing required frequency response field available view 'abs' or 'amplitude' in '{}'",
            relative_path
        )));
    }
    Ok(available_views
        .iter()
        .filter_map(serde_json::Value::as_str)
        .map(str::to_string)
        .collect())
}

fn validate_response_field_requested_view(
    relative_path: &str,
    available_views: &[String],
    requested_view: Option<&str>,
) -> Result<(), ApiError> {
    let requested_view = requested_view.unwrap_or("complex");
    let is_available = match requested_view {
        "complex" | "full" => available_views
            .iter()
            .any(|view| view == "complex" || view == "full"),
        "abs" | "amplitude" => available_views
            .iter()
            .any(|view| view == "abs" || view == "amplitude"),
        other => available_views.iter().any(|view| view == other),
    };
    if is_available {
        return Ok(());
    }
    Err(ApiError::bad_request(format!(
        "frequency-domain field view '{requested_view}' is not listed in available_views in '{}'",
        relative_path
    )))
}

fn validate_response_field_default_view(
    point: &serde_json::Value,
    relative_path: &str,
) -> Result<String, ApiError> {
    let Some(default_view) = point
        .get("default_view")
        .and_then(serde_json::Value::as_str)
    else {
        return Err(ApiError::internal(format!(
            "missing required frequency response field default_view in '{}'",
            relative_path
        )));
    };
    let default_is_available = point
        .get("available_views")
        .and_then(serde_json::Value::as_array)
        .is_some_and(|views| {
            views
                .iter()
                .filter_map(serde_json::Value::as_str)
                .any(|view| view == default_view)
        });
    if !default_is_available {
        return Err(ApiError::internal(format!(
            "invalid frequency response field default_view '{default_view}' is not listed in available_views in '{}'",
            relative_path
        )));
    }
    Ok(default_view.to_string())
}

fn validate_response_field_default_phase_rad(
    point: &serde_json::Value,
    relative_path: &str,
) -> Result<f64, ApiError> {
    let Some(default_phase_rad) = point
        .get("default_phase_rad")
        .and_then(serde_json::Value::as_f64)
    else {
        return Err(ApiError::internal(format!(
            "missing required frequency response field default_phase_rad in '{}'",
            relative_path
        )));
    };
    if !default_phase_rad.is_finite() {
        return Err(ApiError::internal(format!(
            "invalid frequency response field default_phase_rad in '{}'",
            relative_path
        )));
    }
    Ok(default_phase_rad)
}

fn validate_eigen_mode_source_mesh_identity(
    snapshot: &SessionStateResponse,
    relative_path: &str,
    source: &EigenModeSourceMeshIdentity,
) -> Result<(), ApiError> {
    let mesh = snapshot.fem_mesh.as_ref().ok_or_else(|| {
        ApiError::conflict(format!(
            "mode_field_mesh_generation_mismatch: eigen mode metadata '{}' has no current FEM mesh for identity validation",
            relative_path
        ))
    })?;
    if source.indexing != "full_domain_node_order" {
        return Err(ApiError::conflict(format!(
            "mode_field_indexing_mismatch: eigen mode metadata '{}' uses unsupported source indexing '{}'",
            relative_path, source.indexing
        )));
    }
    let current_topology_fingerprint = fullmag_runner::fem_mesh_topology_fingerprint(mesh);
    if source.topology_fingerprint.is_empty()
        || source.topology_fingerprint != current_topology_fingerprint
    {
        return Err(ApiError::conflict(format!(
            "mode_field_mesh_topology_mismatch: eigen mode metadata '{}' topology fingerprint '{}' does not match current mesh '{}'",
            relative_path, source.topology_fingerprint, current_topology_fingerprint
        )));
    }
    if let Some(source_generation_id) = source.mesh_generation_id.as_deref() {
        if mesh.generation_id.as_deref() != Some(source_generation_id) {
            return Err(ApiError::conflict(format!(
                "mode_field_mesh_generation_mismatch: eigen mode metadata '{}' mesh generation '{}' does not match current mesh generation '{}'",
                relative_path,
                source_generation_id,
                mesh.generation_id.as_deref().unwrap_or("missing")
            )));
        }
    }
    if source
        .mesh_revision
        .is_some_and(|revision| revision != snapshot.mesh_revision)
    {
        return Err(ApiError::conflict(format!(
            "mode_field_revision_stale: eigen mode metadata '{}' mesh revision {:?} does not match current mesh revision {}",
            relative_path, source.mesh_revision, snapshot.mesh_revision
        )));
    }
    if usize::try_from(source.node_count).ok() != Some(mesh.nodes.len()) {
        return Err(ApiError::conflict(format!(
            "mode_field_mesh_topology_mismatch: eigen mode metadata '{}' source node count {} does not match current mesh node count {}",
            relative_path,
            source.node_count,
            mesh.nodes.len()
        )));
    }
    Ok(())
}

fn resolve_eigen_mode_scope(
    snapshot: &SessionStateResponse,
    field_id: &str,
    query: &FieldVectorQuery,
    raw_point_count: usize,
    object_coverage: Option<&[EigenModeObjectCoverage]>,
) -> Result<Option<ResolvedFieldScope>, ApiError> {
    let scope_kind = query
        .scope_kind
        .as_deref()
        .map(str::trim)
        .filter(|value| !value.is_empty())
        .unwrap_or("full");
    if scope_kind == "full" {
        return Ok(None);
    }
    if scope_kind != "object" {
        return Err(ApiError::bad_request(format!(
            "unsupported eigen mode field scope_kind '{scope_kind}'"
        )));
    }
    let object_id = required_scope_id(query, "object")?;
    let mesh = snapshot.fem_mesh.as_ref().ok_or_else(|| {
        ApiError::conflict(
            "mode_field_mesh_generation_mismatch: object-scoped eigen mode field requires current FEM mesh topology",
        )
    })?;
    let matches_nonmagnetic_part = mesh.mesh_parts.iter().any(|part| {
        part.role != "magnetic_object"
            && (object_ids_match(&part.id, object_id)
                || part
                    .object_id
                    .as_deref()
                    .is_some_and(|id| object_ids_match(id, object_id))
                || part
                    .geometry_id
                    .as_deref()
                    .is_some_and(|id| object_ids_match(id, object_id)))
    });
    let matches_air_segment = mesh.object_segments.iter().any(|segment| {
        segment.object_id == "__air__" && object_segment_ids_match(segment, object_id)
    });
    if matches_nonmagnetic_part || matches_air_segment {
        return Err(ApiError::unprocessable(format!(
            "mode_field_object_not_magnetic: object '{object_id}' is not a magnetic mode-field carrier"
        )));
    }
    let scope = resolve_field_scope(query, snapshot, None, raw_point_count, "m").map_err(
        |error| {
            if error.status == StatusCode::NOT_FOUND {
                ApiError::not_found(format!(
                    "mode_field_object_scope_missing: magnetic object scope '{object_id}' is not present in the current shared-domain mesh"
                ))
            } else {
                error
            }
        },
    )?;
    let scope = scope.ok_or_else(|| {
        ApiError::not_found(format!(
            "mode_field_object_scope_missing: magnetic object scope '{object_id}' did not resolve"
        ))
    })?;
    let coverage = object_coverage
        .and_then(|coverage| {
            coverage
                .iter()
                .find(|entry| object_ids_match(&entry.object_id, object_id))
        })
        .ok_or_else(|| {
            ApiError::conflict(format!(
                "mode_field_object_coverage_incomplete: eigen mode field '{field_id}' does not cover object '{object_id}'"
            ))
        })?;
    if usize::try_from(coverage.point_count).ok() != Some(scope.node_indices.len()) {
        return Err(ApiError::conflict(format!(
            "mode_field_object_coverage_incomplete: eigen mode field '{field_id}' declares {} points for object '{object_id}', current membership has {}",
            coverage.point_count,
            scope.node_indices.len()
        )));
    }
    Ok(Some(scope))
}

fn analysis_eigen_mode_vector_response(
    snapshot: &SessionStateResponse,
    field_id: &str,
    query: &FieldVectorQuery,
    headers: &HeaderMap,
) -> Result<Option<axum::response::Response>, ApiError> {
    let Some((sample_index, mode_index)) = parse_analysis_eigen_mode_field_id(field_id) else {
        return Ok(None);
    };
    let artifact_dir = current_artifact_dir(snapshot)
        .ok_or_else(|| ApiError::not_found("no artifact directory for analysis field payload"))?;
    let metadata =
        eigen_mode_data_plane_metadata_from_mode_artifact(&artifact_dir, sample_index, mode_index)?;
    let relative_path = metadata.payload_path.clone();
    let source_mesh_identity = metadata.source_mesh_identity.as_ref().ok_or_else(|| {
        ApiError::conflict(format!(
            "mode_field_mesh_generation_mismatch: eigen mode payload '{}' has no immutable source mesh identity",
            relative_path
        ))
    })?;
    validate_eigen_mode_source_mesh_identity(snapshot, &relative_path, source_mesh_identity)?;
    if metadata.component_count != Some(3)
        || !matches!(
            metadata.component_basis.as_deref(),
            Some("global_xyz" | "global_cartesian_xyz")
        )
    {
        return Err(ApiError::unprocessable(format!(
            "mode_field_basis_unsupported: eigen mode field '{}' must publish a three-component global Cartesian basis",
            relative_path
        )));
    }
    let path = artifact_dir.join(&relative_path);
    let bytes = std::fs::read(&path).map_err(|error| {
        if error.kind() == std::io::ErrorKind::NotFound {
            ApiError::not_found(format!(
                "analysis eigen mode field payload is missing: {relative_path}"
            ))
        } else {
            ApiError::internal(format!(
                "failed to read analysis eigen mode field payload '{}': {}",
                relative_path, error
            ))
        }
    })?;
    if let Some(payload_value_count) = metadata.payload_value_count {
        let expected_size = payload_value_count.checked_mul(8).ok_or_else(|| {
            ApiError::internal(format!(
                "eigen mode field payload_value_count overflows byte size in '{}'",
                relative_path
            ))
        })?;
        if bytes.len() as u64 != expected_size {
            return Err(ApiError::internal(format!(
                "analysis eigen mode field payload '{}' has {} bytes, expected {}",
                relative_path,
                bytes.len(),
                expected_size
            )));
        }
    }
    let values = decode_complex_f64_pairs_little_endian(&bytes)?;
    let effective_view = query.view.as_deref().unwrap_or(&metadata.default_view);
    let effective_phase_rad = query.phase_rad.unwrap_or(metadata.default_phase_rad);
    validate_response_field_requested_view(
        &relative_path,
        &metadata.available_views,
        Some(effective_view),
    )?;
    let (raw_values, n_comp, default_component) = analysis_complex_component_view_values(
        &values,
        metadata.component_count.unwrap_or(3),
        Some(effective_view),
        Some(effective_phase_rad),
    )?;
    let component = parse_component(query.component.as_deref().or(default_component), n_comp)?;
    let (out_n_comp, projected) = project_values(&raw_values, n_comp, &component)?;
    let point_count = raw_values.len() / n_comp;
    if u64::try_from(point_count).ok() != Some(source_mesh_identity.node_count) {
        return Err(ApiError::conflict(format!(
            "mode_field_mesh_topology_mismatch: eigen mode payload '{}' point count {} does not match its source mesh node count {}",
            relative_path, point_count, source_mesh_identity.node_count
        )));
    }
    let resolved_scope = resolve_eigen_mode_scope(
        snapshot,
        field_id,
        query,
        point_count,
        metadata.object_coverage.as_deref(),
    )?;
    let projected = apply_field_scope(
        projected,
        [point_count as u32, 1, 1],
        out_n_comp,
        resolved_scope.as_ref(),
    );
    let scoped_point_count = if out_n_comp > 0 {
        projected.len() / out_n_comp
    } else {
        projected.len()
    };
    let out_grid = [scoped_point_count as u32, 1, 1];
    let binary = serialize_analysis_field_vector_binary(
        snapshot,
        field_id,
        out_n_comp,
        out_grid,
        &projected,
        resolved_scope.as_ref(),
    )?;
    let revision = analysis_payload_revision(snapshot, &relative_path, bytes.len());
    let scope_token = resolved_scope
        .as_ref()
        .map(ResolvedFieldScope::cache_token)
        .unwrap_or_else(|| "full-domain".to_string());
    let node_indices_token = resolved_scope
        .as_ref()
        .map(|scope| {
            let indices = scope
                .node_indices
                .iter()
                .map(|index| u32::try_from(*index))
                .collect::<Result<Vec<_>, _>>()
                .unwrap_or_default();
            field_node_indices_cache_token(Some(&indices))
        })
        .unwrap_or_else(|| "none".to_string());
    let etag = crate::router_v2::handlers::shared::stable_strong_etag(&format!(
        "{field_id}:{revision}:{}:{}:{}:{scope_token}:{node_indices_token}",
        effective_view,
        query
            .component
            .as_deref()
            .unwrap_or(default_component.unwrap_or("full")),
        effective_phase_rad
    ));
    let mut resp =
        crate::router_v2::handlers::shared::conditional_binary_response(headers, &etag, binary);
    insert_field_headers(
        &mut resp,
        field_id,
        &component,
        revision,
        &domain_generation_id(snapshot),
        scoped_point_count,
        projected.len(),
    );
    let topology_hash = snapshot
        .fem_mesh
        .as_ref()
        .map(fullmag_runner::fem_mesh_topology_fingerprint);
    insert_field_vector_binary_headers(
        &mut resp,
        3,
        topology_hash.as_deref(),
        Some(if resolved_scope.is_some() {
            FieldVectorIndexing::ExplicitNodeIndices
        } else {
            FieldVectorIndexing::FullDomain
        }),
        resolved_scope
            .as_ref()
            .map(|scope| scope.node_indices.len()),
    );
    insert_scope_headers(&mut resp, resolved_scope.as_ref());
    Ok(Some(resp))
}

fn analysis_frequency_response_view_values(
    values: &[f64],
    view: Option<&str>,
    phase_rad: Option<f64>,
) -> Result<(Vec<f64>, usize, Option<&'static str>), ApiError> {
    if values.len() % 6 == 0 {
        return analysis_complex_vector_view_values(values, view, phase_rad);
    }
    match view.unwrap_or("complex") {
        "complex" | "full" => Ok((values.to_vec(), 2, None)),
        "real" => Ok((
            complex_pair_scalar_view(values, |real, _imag| real),
            1,
            Some("full"),
        )),
        "imag" => Ok((
            complex_pair_scalar_view(values, |_real, imag| imag),
            1,
            Some("full"),
        )),
        "abs" | "amplitude" => Ok((
            complex_pair_scalar_view(values, |real, imag| real.hypot(imag)),
            1,
            Some("full"),
        )),
        "phase" => Ok((
            complex_pair_scalar_view(values, |real, imag| imag.atan2(real)),
            1,
            Some("full"),
        )),
        "phase_rotated_real" => {
            let phase = phase_rad.unwrap_or(0.0);
            if !phase.is_finite() {
                return Err(ApiError::bad_request("phase_rad must be finite"));
            }
            let cos_phase = phase.cos();
            let sin_phase = phase.sin();
            Ok((
                complex_pair_scalar_view(values, |real, imag| real * cos_phase - imag * sin_phase),
                1,
                Some("full"),
            ))
        }
        other => Err(ApiError::bad_request(format!(
            "unsupported frequency-domain field view '{other}'"
        ))),
    }
}

fn analysis_complex_component_view_values(
    values: &[f64],
    component_count: usize,
    view: Option<&str>,
    phase_rad: Option<f64>,
) -> Result<(Vec<f64>, usize, Option<&'static str>), ApiError> {
    if component_count == 0 || values.len() % (component_count * 2) != 0 {
        return Err(ApiError::internal(
            "analysis frequency-response payload does not match declared complex component count",
        ));
    }
    match view.unwrap_or("complex") {
        "complex" | "full" => Ok((values.to_vec(), component_count * 2, None)),
        "real" => Ok((
            complex_vector_view(values, |real, _imag| real),
            component_count,
            Some("full"),
        )),
        "imag" => Ok((
            complex_vector_view(values, |_real, imag| imag),
            component_count,
            Some("full"),
        )),
        "abs" | "amplitude" => Ok((
            complex_vector_view(values, |real, imag| real.hypot(imag)),
            component_count,
            Some("full"),
        )),
        "phase" => Ok((
            complex_vector_view(values, |real, imag| imag.atan2(real)),
            component_count,
            Some("full"),
        )),
        "phase_rotated_real" => {
            let phase = phase_rad.unwrap_or(0.0);
            if !phase.is_finite() {
                return Err(ApiError::bad_request("phase_rad must be finite"));
            }
            let cos_phase = phase.cos();
            let sin_phase = phase.sin();
            Ok((
                complex_vector_view(values, |real, imag| real * cos_phase - imag * sin_phase),
                component_count,
                Some("full"),
            ))
        }
        other => Err(ApiError::bad_request(format!(
            "unsupported frequency-domain field view '{other}'"
        ))),
    }
}

fn analysis_complex_vector_view_values(
    values: &[f64],
    view: Option<&str>,
    phase_rad: Option<f64>,
) -> Result<(Vec<f64>, usize, Option<&'static str>), ApiError> {
    if values.len() % 6 != 0 {
        return Err(ApiError::internal(
            "analysis eigen mode payload must contain complex xyz vector values",
        ));
    }
    match view.unwrap_or("complex") {
        "complex" | "full" => Ok((values.to_vec(), 6, None)),
        "real" => Ok((
            complex_vector_view(values, |real, _imag| real),
            3,
            Some("full"),
        )),
        "imag" => Ok((
            complex_vector_view(values, |_real, imag| imag),
            3,
            Some("full"),
        )),
        "abs" | "amplitude" => Ok((
            complex_vector_view(values, |real, imag| real.hypot(imag)),
            3,
            Some("full"),
        )),
        "phase" => Ok((
            complex_vector_view(values, |real, imag| imag.atan2(real)),
            3,
            Some("full"),
        )),
        "phase_rotated_real" => {
            let phase = phase_rad.unwrap_or(0.0);
            if !phase.is_finite() {
                return Err(ApiError::bad_request("phase_rad must be finite"));
            }
            let cos_phase = phase.cos();
            let sin_phase = phase.sin();
            Ok((
                complex_vector_view(values, |real, imag| real * cos_phase - imag * sin_phase),
                3,
                Some("full"),
            ))
        }
        other => Err(ApiError::bad_request(format!(
            "unsupported frequency-domain field view '{other}'"
        ))),
    }
}

fn complex_pair_scalar_view(values: &[f64], map: impl Fn(f64, f64) -> f64) -> Vec<f64> {
    values
        .chunks_exact(2)
        .map(|pair| map(pair[0], pair[1]))
        .collect()
}

fn complex_vector_view(values: &[f64], map: impl Fn(f64, f64) -> f64) -> Vec<f64> {
    values
        .chunks_exact(2)
        .map(|pair| map(pair[0], pair[1]))
        .collect()
}

fn parse_analysis_frequency_response_field_id(field_id: &str) -> Option<u32> {
    field_id
        .strip_prefix("analysis:frequency-response:frequency-")
        .and_then(|index| index.parse::<u32>().ok())
}

fn parse_analysis_eigen_mode_field_id(field_id: &str) -> Option<(u32, u32)> {
    let rest = field_id.strip_prefix("analysis:eigen:sample-")?;
    let (sample_index, mode_index) = rest.split_once(":mode-")?;
    Some((sample_index.parse().ok()?, mode_index.parse().ok()?))
}

fn decode_complex_f64_pairs_little_endian(bytes: &[u8]) -> Result<Vec<f64>, ApiError> {
    if bytes.len() % std::mem::size_of::<f64>() != 0 || bytes.len() % 16 != 0 {
        return Err(ApiError::internal(
            "analysis frequency-response payload must contain little-endian f64 complex pairs",
        ));
    }
    let mut values = Vec::with_capacity(bytes.len() / std::mem::size_of::<f64>());
    for chunk in bytes.chunks_exact(std::mem::size_of::<f64>()) {
        let mut raw = [0u8; std::mem::size_of::<f64>()];
        raw.copy_from_slice(chunk);
        let value = f64::from_le_bytes(raw);
        if !value.is_finite() {
            return Err(ApiError::internal(
                "analysis frequency-response payload contains non-finite values",
            ));
        }
        values.push(value);
    }
    Ok(values)
}

fn analysis_payload_revision(
    snapshot: &SessionStateResponse,
    relative_path: &str,
    byte_len: usize,
) -> u64 {
    let mut hash = domain_generation_revision(snapshot) ^ (byte_len as u64);
    for byte in relative_path.as_bytes() {
        hash = hash.wrapping_mul(1099511628211).wrapping_add(*byte as u64);
    }
    hash
}

// ── 2D slice — P2 ────────────────────────────────────────────────────────────

fn compute_projection(
    fdm_field: &FdmField,
    fem_field: Option<&FemField>,
    resolved: &ResolvedProjectionQuery,
) -> Result<ProjectionResult, ApiError> {
    match fem_field {
        Some(field) => fem_projection_exact(field, resolved),
        None => fdm_projection(fdm_field, resolved),
    }
}

fn projection_error_estimate(
    fdm_field: &FdmField,
    fem_field: Option<&FemField>,
    resolved: &ResolvedProjectionQuery,
    projection: &ProjectionResult,
) -> Result<(Option<f64>, Option<String>), ApiError> {
    if fem_field.is_some() {
        return Ok((Some(0.0), Some("exact_tetra_volume".to_string())));
    }
    if resolved.samples <= 1 {
        return Ok((None, None));
    }
    let mut coarse_query = resolved.clone();
    coarse_query.adaptive = false;
    coarse_query.samples = (resolved.samples / 2).max(1);
    let coarse = fdm_projection(fdm_field, &coarse_query)?;
    let mut max_abs_diff = 0.0f64;
    for (fine, coarse) in projection
        .scalar_values
        .iter()
        .zip(coarse.scalar_values.iter())
    {
        if fine.is_finite() && coarse.is_finite() {
            max_abs_diff = max_abs_diff.max((fine - coarse).abs());
        }
    }
    Ok((
        Some(max_abs_diff),
        Some("coarse_fine_sample_delta_max_abs".to_string()),
    ))
}

fn is_fem_runtime(snapshot: &crate::types::SessionStateResponse) -> bool {
    matches!(
        snapshot.capabilities.as_ref().map(|cap| cap.engine_id),
        Some(
            RuntimeEngineId::FemCpuNative
                | RuntimeEngineId::FemNativeGpu
                | RuntimeEngineId::FemEigenCpuBaseline
                | RuntimeEngineId::FemEigenNativeGpu
                | RuntimeEngineId::FemFrequencyResponseDenseValidation
                | RuntimeEngineId::FemFrequencyResponseProductionCpu
        )
    ) || (snapshot.fem_mesh.is_some() && !is_fdm_snapshot(snapshot))
}

fn fem_topology_available(snapshot: &crate::types::SessionStateResponse) -> bool {
    snapshot.fem_mesh.as_ref().is_some_and(|mesh| {
        !mesh.nodes.is_empty() && (!mesh.cells.is_empty() || !mesh.facets.is_empty())
    })
}

fn component_label(c: &ComponentSelection) -> String {
    match c {
        ComponentSelection::Full => "full".into(),
        ComponentSelection::Magnitude => "magnitude".into(),
        ComponentSelection::MagnitudeSquared => "magnitude_squared".into(),
        ComponentSelection::AbsIndex(i) => format!("abs_c{}", i),
        ComponentSelection::Index(i) => format!("c{}", i),
    }
}

fn projection_etag_token(
    quantity_id: &str,
    session_id: &str,
    field_revision: u64,
    domain_generation_id: &str,
    q: &crate::field_slice::ResolvedProjectionQuery,
    sampling_method: &str,
) -> String {
    format!(
        "fmpr:{quantity_id}:{session_id}:{field_revision}:{domain_generation_id}:method={sampling_method}:{}:{}x{}:{}:{}:air={}:samples={}:adaptive={}:tol={}:min_samples={}:tile={},{},{}:v4",
        q.plane.as_str(),
        q.full_x_size,
        q.full_y_size,
        component_label(&q.component),
        q.reduction.as_str(),
        u8::from(q.include_air_as_zero),
        q.samples,
        u8::from(q.adaptive),
        q.error_tolerance
            .map(|value| value.to_bits().to_string())
            .unwrap_or_else(|| "none".to_string()),
        q.min_samples,
        q.tile_x
            .map_or_else(|| "full".to_string(), |value| value.to_string()),
        q.tile_y
            .map_or_else(|| "full".to_string(), |value| value.to_string()),
        q.tile_size
            .map_or_else(|| "full".to_string(), |value| value.to_string()),
    )
}

fn slice_cut_cache_key(q: &crate::field_slice::ResolvedSliceQuery) -> String {
    q.cut_world
        .map(|value| format!("world:{}", value.to_bits()))
        .unwrap_or_else(|| format!("norm:{}", q.cut_norm.to_bits()))
}

#[derive(Debug, Clone, Deserialize, utoipa::IntoParams)]
#[into_params(parameter_in = Query)]
pub struct FieldSliceMatrixQuery {
    pub plane: SlicePlane,
    pub component: Option<String>,
    pub color_mode: Option<String>,
    pub cut_world: Option<f64>,
    pub cut_norm: Option<f64>,
    pub mode: Option<String>,
    pub thickness_world: Option<f64>,
    pub aggregation: Option<String>,
    pub x_size: Option<u32>,
    pub y_size: Option<u32>,
    pub max_points: Option<u32>,
    pub samples: Option<u32>,
    pub format: Option<String>,
}

#[derive(Debug, Clone, Deserialize, utoipa::IntoParams)]
#[into_params(parameter_in = Query)]
pub struct FieldProjectionMatrixQuery {
    pub plane: SlicePlane,
    pub component: Option<String>,
    pub color_mode: Option<String>,
    pub mode: Option<String>,
    pub aggregation: Option<String>,
    pub reduction: Option<String>,
    pub include_air_as_zero: Option<bool>,
    pub samples: Option<u32>,
    pub adaptive: Option<bool>,
    pub error_tolerance: Option<f64>,
    pub min_samples: Option<u32>,
    pub x_size: Option<u32>,
    pub y_size: Option<u32>,
    pub max_points: Option<u32>,
    pub format: Option<String>,
}

#[derive(Debug, Clone, Deserialize, utoipa::IntoParams)]
#[into_params(parameter_in = Query)]
pub struct FieldRenderPngQuery {
    pub plane: SlicePlane,
    pub component: Option<String>,
    pub color_mode: Option<String>,
    pub cut_world: Option<f64>,
    pub cut_norm: Option<f64>,
    pub mode: Option<String>,
    pub thickness_world: Option<f64>,
    pub aggregation: Option<String>,
    pub reduction: Option<String>,
    pub include_air_as_zero: Option<bool>,
    pub samples: Option<u32>,
    pub adaptive: Option<bool>,
    pub error_tolerance: Option<f64>,
    pub min_samples: Option<u32>,
    pub x_size: Option<u32>,
    pub y_size: Option<u32>,
    pub max_points: Option<u32>,
    pub colormap: Option<String>,
    pub vmin: Option<f64>,
    pub vmax: Option<f64>,
    pub auto_scale: Option<String>,
    pub alpha_mask: Option<bool>,
    pub show_mesh: Option<bool>,
    pub show_arrows: Option<bool>,
}

struct MatrixBuild {
    response: FieldMatrixResponse,
    scalar_values: Option<Vec<f64>>,
    rgba_pixels: Option<Vec<[u8; 4]>>,
    mask_flat: Vec<u8>,
    mesh_lines: Vec<[f64; 4]>,
}

fn slice_matrix_mode(mode: Option<&str>) -> Result<&'static str, ApiError> {
    match mode.unwrap_or("exact") {
        "exact" => Ok("exact"),
        "slab" => Ok("slab"),
        "projection" => Err(ApiError::bad_request(
            "invalid_query: use projection/matrix.json for mode=projection",
        )),
        other => Err(ApiError::bad_request(format!(
            "invalid_query: unsupported slice matrix mode '{other}'"
        ))),
    }
}

fn matrix_format(format: Option<&str>) -> Result<&'static str, ApiError> {
    match format.unwrap_or("values") {
        "values" => Ok("values"),
        "rgba" => Ok("rgba"),
        "both" => Ok("both"),
        other => Err(ApiError::bad_request(format!(
            "invalid_query: unsupported matrix format '{other}'"
        ))),
    }
}

fn color_mode(color_mode: Option<&str>, component: Option<&str>) -> Result<&'static str, ApiError> {
    let inferred = if component == Some("orientation") {
        "orientation"
    } else {
        color_mode.unwrap_or("scalar")
    };
    match inferred {
        "scalar" => Ok("scalar"),
        "orientation" => Ok("orientation"),
        other => Err(ApiError::bad_request(format!(
            "invalid_query: unsupported color_mode '{other}'"
        ))),
    }
}

fn matrix_axes(plane: SlicePlane) -> (&'static str, &'static str, &'static str) {
    match plane {
        SlicePlane::Xy => ("x", "y", "z"),
        SlicePlane::Xz => ("x", "z", "y"),
        SlicePlane::Yz => ("y", "z", "x"),
    }
}

fn slice_normal_axis(plane: SlicePlane) -> usize {
    match plane {
        SlicePlane::Xy => 2,
        SlicePlane::Xz => 1,
        SlicePlane::Yz => 0,
    }
}

fn fdm_normal_bounds(field: &FdmField, plane: SlicePlane) -> Option<(f64, f64)> {
    let axis = slice_normal_axis(plane);
    let origin = field.origin?;
    let spacing = field.spacing?;
    let extent = field.grid[axis] as f64 * spacing[axis];
    if !origin[axis].is_finite() || !extent.is_finite() || extent.abs() <= f64::EPSILON {
        return None;
    }
    let end = origin[axis] + extent;
    Some((origin[axis].min(end), origin[axis].max(end)))
}

fn matrix_hash(raw: &str) -> String {
    crate::router_v2::handlers::shared::stable_strong_etag(raw)
}

fn spatial_index_key(
    quantity_id: &str,
    domain_generation_id: &str,
    normal_axis: usize,
    field: &FemField,
) -> String {
    format!(
        "fem-spatial:{quantity_id}:{domain_generation_id}:axis={normal_axis}:nodes={}:elements={}:v1",
        field.nodes.len(),
        field.elements.len()
    )
}

async fn get_or_build_fem_spatial_index(
    state: &AppState,
    quantity_id: &str,
    domain_generation_id: &str,
    plane: SlicePlane,
    field: &FemField,
) -> std::sync::Arc<FemNormalAxisIndex> {
    let normal_axis = match plane {
        SlicePlane::Xy => 2,
        SlicePlane::Xz => 1,
        SlicePlane::Yz => 0,
    };
    let key = spatial_index_key(quantity_id, domain_generation_id, normal_axis, field);
    let mut cache = state
        .quantity_data_plane
        .fem_spatial_index_cache
        .lock()
        .await;
    if let Some(index) = cache.get(&key) {
        return index.clone();
    }
    let bins = (field.elements.len() as f64).sqrt().ceil().max(16.0) as usize;
    let index = std::sync::Arc::new(FemNormalAxisIndex::build(
        &field.nodes,
        &field.elements,
        normal_axis,
        bins,
    ));
    cache.insert(key, index.clone());
    index
}

fn slice_query_from_matrix(query: &FieldSliceMatrixQuery, component: String) -> FieldSliceQuery {
    FieldSliceQuery {
        plane: query.plane,
        component: Some(component),
        cut_world: query.cut_world,
        cut_norm: query.cut_norm,
        x_size: query.x_size,
        y_size: query.y_size,
        max_points: query.max_points,
        include_arrows: None,
        arrow_every: None,
        max_arrows: None,
    }
}

fn projection_query_from_matrix(query: &FieldProjectionMatrixQuery) -> FieldProjectionQuery {
    FieldProjectionQuery {
        plane: query.plane,
        component: query.component.clone(),
        reduction: query
            .reduction
            .clone()
            .or_else(|| query.aggregation.clone())
            .or_else(|| Some("mean_occupied".to_string())),
        include_air_as_zero: query.include_air_as_zero,
        samples: query.samples,
        adaptive: query.adaptive,
        error_tolerance: query.error_tolerance,
        min_samples: query.min_samples,
        x_size: query.x_size,
        y_size: query.y_size,
        max_points: query.max_points,
        tile_x: None,
        tile_y: None,
        tile_size: None,
    }
}

fn matrix_rows(values: &[f64], mask: &[u8], x_size: u32, y_size: u32) -> Vec<Vec<Option<f64>>> {
    let width = x_size as usize;
    (0..y_size as usize)
        .map(|row| {
            (0..width)
                .map(|col| {
                    let index = row * width + col;
                    let value = values.get(index).copied().unwrap_or(f64::NAN);
                    if mask.get(index).copied().unwrap_or(1) == 0 && value.is_finite() {
                        Some(value)
                    } else {
                        None
                    }
                })
                .collect()
        })
        .collect()
}

fn mask_rows(mask: &[u8], x_size: u32, y_size: u32) -> Vec<Vec<u8>> {
    let width = x_size as usize;
    (0..y_size as usize)
        .map(|row| {
            (0..width)
                .map(|col| mask.get(row * width + col).copied().unwrap_or(1))
                .collect()
        })
        .collect()
}

fn rgba_rows(rgba: &[[u8; 4]], x_size: u32, y_size: u32) -> Vec<Vec<[u8; 4]>> {
    let width = x_size as usize;
    (0..y_size as usize)
        .map(|row| {
            (0..width)
                .map(|col| rgba.get(row * width + col).copied().unwrap_or([0, 0, 0, 0]))
                .collect()
        })
        .collect()
}

fn finite_min_max(values: &[f64], mask: &[u8]) -> (Option<f64>, Option<f64>) {
    let mut min = f64::INFINITY;
    let mut max = f64::NEG_INFINITY;
    for (index, value) in values.iter().copied().enumerate() {
        if mask.get(index).copied().unwrap_or(1) == 0 && value.is_finite() {
            min = min.min(value);
            max = max.max(value);
        }
    }
    if min.is_infinite() || max.is_infinite() {
        (None, None)
    } else {
        (Some(min), Some(max))
    }
}

fn orientation_rgba_from_full_values(result: &crate::field_slice::SliceResult) -> Vec<[u8; 4]> {
    let width = result.x_size as usize;
    let height = result.y_size as usize;
    let mut rgba = Vec::with_capacity(width * height);
    for pixel in 0..width * height {
        if result.empty_mask.get(pixel).copied().unwrap_or(1) != 0 || result.n_comp_out < 3 {
            rgba.push([0, 0, 0, 0]);
            continue;
        }
        let base = pixel * result.n_comp_out;
        let mx = result.scalar_values.get(base).copied().unwrap_or(0.0);
        let my = result.scalar_values.get(base + 1).copied().unwrap_or(0.0);
        let mz = result.scalar_values.get(base + 2).copied().unwrap_or(0.0);
        rgba.push(apply_magnetization_hsl_rgba(mx, my, mz, 255));
    }
    rgba
}

fn magnitude_values_from_full(result: &crate::field_slice::SliceResult) -> Vec<f64> {
    let pixel_count = result.x_size as usize * result.y_size as usize;
    (0..pixel_count)
        .map(|pixel| {
            if result.empty_mask.get(pixel).copied().unwrap_or(1) != 0 || result.n_comp_out < 3 {
                return f64::NAN;
            }
            let base = pixel * result.n_comp_out;
            let mx = result.scalar_values.get(base).copied().unwrap_or(0.0);
            let my = result.scalar_values.get(base + 1).copied().unwrap_or(0.0);
            let mz = result.scalar_values.get(base + 2).copied().unwrap_or(0.0);
            (mx * mx + my * my + mz * mz).sqrt()
        })
        .collect()
}

fn matrix_response_from_slice(
    quantity_id: &str,
    plane: SlicePlane,
    mode: &str,
    component: &str,
    color_mode: &str,
    format: &str,
    aggregation: Option<String>,
    effective_thickness_world: Option<f64>,
    result: crate::field_slice::SliceResult,
    hash: String,
) -> Result<MatrixBuild, ApiError> {
    let (u_axis, v_axis, normal_axis) = matrix_axes(plane);
    let mask_flat = result.empty_mask.clone();
    let mut scalar_values = None;
    let mut values = None;
    let mut rgba_pixels = None;
    let mut rgba = None;

    if color_mode == "orientation" {
        if result.n_comp_out < 3 {
            return Err(ApiError::bad_request(
                "invalid_query: color_mode=orientation requires a vector field with at least 3 components",
            ));
        }
        let pixels = orientation_rgba_from_full_values(&result);
        if format == "rgba" || format == "both" || format == "values" {
            rgba = Some(rgba_rows(&pixels, result.x_size, result.y_size));
            rgba_pixels = Some(pixels);
        }
        if format == "both" {
            let magnitudes = magnitude_values_from_full(&result);
            values = Some(matrix_rows(
                &magnitudes,
                &mask_flat,
                result.x_size,
                result.y_size,
            ));
            scalar_values = Some(magnitudes);
        }
    } else {
        if result.n_comp_out != 1 {
            return Err(ApiError::bad_request(
                "invalid_query: matrix.json scalar mode requires a scalar component",
            ));
        }
        scalar_values = Some(result.scalar_values.clone());
        values = Some(matrix_rows(
            &result.scalar_values,
            &mask_flat,
            result.x_size,
            result.y_size,
        ));
    }

    let (min, max) = scalar_values
        .as_ref()
        .map(|values| finite_min_max(values, &mask_flat))
        .unwrap_or((None, None));
    let response = FieldMatrixResponse {
        schema: "fullmag.field_2d.matrix.v1".to_string(),
        quantity_id: quantity_id.to_string(),
        plane: plane.as_str().to_string(),
        mode: mode.to_string(),
        component: component.to_string(),
        color_mode: color_mode.to_string(),
        x_size: result.x_size,
        y_size: result.y_size,
        u_axis: u_axis.to_string(),
        v_axis: v_axis.to_string(),
        normal_axis: normal_axis.to_string(),
        cut_world: result.cut_world,
        bounds: FieldSliceBounds {
            u_min: result.u_min,
            u_max: result.u_max,
            v_min: result.v_min,
            v_max: result.v_max,
        },
        values,
        rgba,
        mask: mask_rows(&mask_flat, result.x_size, result.y_size),
        min,
        max,
        sampling_method: result.sampling_method.to_string(),
        aggregation,
        effective_thickness_world,
        matrix_hash: hash,
        warnings: Vec::new(),
    };

    Ok(MatrixBuild {
        response,
        scalar_values,
        rgba_pixels,
        mask_flat,
        mesh_lines: Vec::new(),
    })
}

fn matrix_response_from_projection(
    quantity_id: &str,
    plane: SlicePlane,
    component: &str,
    aggregation: &str,
    projection: ProjectionResult,
    hash: String,
) -> MatrixBuild {
    let (u_axis, v_axis, normal_axis) = matrix_axes(plane);
    let mask_flat = projection.empty_mask.clone();
    let values = matrix_rows(
        &projection.scalar_values,
        &mask_flat,
        projection.x_size,
        projection.y_size,
    );
    let (min, max) = finite_min_max(&projection.scalar_values, &mask_flat);
    let response = FieldMatrixResponse {
        schema: "fullmag.field_2d.matrix.v1".to_string(),
        quantity_id: quantity_id.to_string(),
        plane: plane.as_str().to_string(),
        mode: "projection".to_string(),
        component: component.to_string(),
        color_mode: "scalar".to_string(),
        x_size: projection.x_size,
        y_size: projection.y_size,
        u_axis: u_axis.to_string(),
        v_axis: v_axis.to_string(),
        normal_axis: normal_axis.to_string(),
        cut_world: None,
        bounds: FieldSliceBounds {
            u_min: projection.u_min,
            u_max: projection.u_max,
            v_min: projection.v_min,
            v_max: projection.v_max,
        },
        values: Some(values),
        rgba: None,
        mask: mask_rows(&mask_flat, projection.x_size, projection.y_size),
        min,
        max,
        sampling_method: projection.sampling_method.to_string(),
        aggregation: Some(aggregation.to_string()),
        effective_thickness_world: None,
        matrix_hash: hash,
        warnings: Vec::new(),
    };
    MatrixBuild {
        response,
        scalar_values: Some(projection.scalar_values),
        rgba_pixels: None,
        mask_flat,
        mesh_lines: Vec::new(),
    }
}

fn matrix_etag_token(
    quantity_id: &str,
    session_id: &str,
    field_revision: u64,
    domain_generation_id: &str,
    plane: SlicePlane,
    mode: &str,
    component: &str,
    color_mode: &str,
    x_size: u32,
    y_size: u32,
    extra: &str,
) -> String {
    format!(
        "fmmatrix:{quantity_id}:{session_id}:{field_revision}:{domain_generation_id}:{}:{mode}:{component}:{color_mode}:{x_size}x{y_size}:{extra}:v2",
        plane.as_str()
    )
}

fn component_for_matrix(
    n_comp: usize,
    color_mode: &str,
    component: Option<&str>,
) -> Result<(String, ComponentSelection), ApiError> {
    if color_mode == "orientation" {
        if n_comp < 3 {
            return Err(ApiError::bad_request(
                "invalid_query: color_mode=orientation requires n_comp >= 3",
            ));
        }
        return Ok(("orientation".to_string(), ComponentSelection::Full));
    }
    let raw = component.unwrap_or(if n_comp == 1 { "full" } else { "magnitude" });
    let parsed = parse_component(Some(raw), n_comp)?;
    if matches!(parsed, ComponentSelection::Full) && n_comp > 1 {
        return Err(ApiError::bad_request(
            "invalid_query: scalar matrix requires a scalar component, not full",
        ));
    }
    Ok((component_label(&parsed), parsed))
}

async fn build_slice_matrix(
    state: &AppState,
    quantity_id: &str,
    query: &FieldSliceMatrixQuery,
) -> Result<(String, MatrixBuild), ApiError> {
    let mode = slice_matrix_mode(query.mode.as_deref())?;
    let format = matrix_format(query.format.as_deref())?;
    let color_mode = color_mode(query.color_mode.as_deref(), query.component.as_deref())?;
    let guard = state.current_live_state.read().await;
    let snapshot = guard
        .as_ref()
        .ok_or_else(|| ApiError::not_found("no active local live workspace"))?;
    let spec = quantity_spec(quantity_id);
    let n_comp: usize = spec.map(|s| s.n_comp as usize).unwrap_or(3);
    let (component_label, component) =
        component_for_matrix(n_comp, color_mode, query.component.as_deref())?;
    let resolved_component = if color_mode == "orientation" {
        "full".to_string()
    } else {
        component_label.clone()
    };
    let mut resolved =
        resolve_slice_query(&slice_query_from_matrix(query, resolved_component), n_comp)?;
    resolved.component = component;

    let field_revision = field_quantity_revision(snapshot, &quantity_id);
    let gen_id = domain_generation_id(snapshot);
    let session_id = snapshot.session.session_id.clone();
    let fdm_field = extract_fdm_field(snapshot, quantity_id, n_comp)
        .ok_or_else(|| ApiError::not_found(format!("field '{}' not available", quantity_id)))?;
    let fem_field = extract_fem_field(snapshot, quantity_id, n_comp);
    drop(guard);

    let spatial_index = if let Some(fem_field) = fem_field.as_ref() {
        Some(
            get_or_build_fem_spatial_index(state, quantity_id, &gen_id, query.plane, fem_field)
                .await,
        )
    } else {
        None
    };
    let result = match mode {
        "exact" => {
            if let Some(fem_field) = fem_field.as_ref() {
                fem_tetra_linear_slice(fem_field, &resolved, spatial_index.as_deref())?
            } else {
                fdm_slice(&fdm_field, &resolved)?
            }
        }
        "slab" => {
            let fem_field = fem_field.as_ref().ok_or_else(|| {
                ApiError::conflict("mode=slab requires a nodal FEM field matching the current mesh")
            })?;
            let aggregation = SlabAggregation::parse(query.aggregation.as_deref())?;
            fem_tetra_slab_slice(
                fem_field,
                &resolved,
                query.thickness_world.unwrap_or(0.0),
                aggregation,
                query.samples.unwrap_or(5),
                spatial_index.as_deref(),
            )?
        }
        _ => unreachable!("slice_matrix_mode only returns exact or slab"),
    };

    let aggregation = if mode == "slab" {
        Some(
            SlabAggregation::parse(query.aggregation.as_deref())?
                .as_str()
                .to_string(),
        )
    } else {
        None
    };
    let extra = format!(
        "cut={}:thickness={}:aggregation={}:samples={}:method={}",
        resolved
            .cut_world
            .map(|value| format!("world:{}", value.to_bits()))
            .unwrap_or_else(|| format!("norm:{}", resolved.cut_norm.to_bits())),
        query
            .thickness_world
            .map(|value| value.to_bits().to_string())
            .unwrap_or_else(|| "none".to_string()),
        aggregation.as_deref().unwrap_or("sample"),
        query.samples.unwrap_or(1),
        result.sampling_method
    );
    let hash = matrix_hash(&matrix_etag_token(
        quantity_id,
        &session_id,
        field_revision,
        &gen_id,
        query.plane,
        mode,
        &component_label,
        color_mode,
        result.x_size,
        result.y_size,
        &extra,
    ));
    let mut matrix = matrix_response_from_slice(
        quantity_id,
        query.plane,
        mode,
        &component_label,
        color_mode,
        format,
        aggregation,
        if mode == "slab" {
            query.thickness_world
        } else {
            None
        },
        result,
        hash.clone(),
    )?;
    if let Some(fem_field) = fem_field.as_ref() {
        if let Ok(overlay) = collect_fem_slice_overlay(
            FemSliceOverlayInput {
                nodes: &fem_field.nodes,
                elements: &fem_field.elements,
                element_markers: &fem_field.element_markers,
            },
            &resolved,
        ) {
            matrix.mesh_lines = overlay_segments_to_pixel_lines(
                &overlay.segments,
                SliceOverlayBounds {
                    u_min: matrix.response.bounds.u_min,
                    u_max: matrix.response.bounds.u_max,
                    v_min: matrix.response.bounds.v_min,
                    v_max: matrix.response.bounds.v_max,
                },
                matrix.response.x_size,
                matrix.response.y_size,
            );
        }
    }
    Ok((hash, matrix))
}

async fn build_projection_matrix(
    state: &AppState,
    quantity_id: &str,
    query: &FieldProjectionMatrixQuery,
) -> Result<(String, MatrixBuild), ApiError> {
    if query
        .mode
        .as_deref()
        .is_some_and(|mode| mode != "projection")
    {
        return Err(ApiError::bad_request(
            "invalid_query: projection/matrix.json only supports mode=projection",
        ));
    }
    let color_mode = color_mode(query.color_mode.as_deref(), query.component.as_deref())?;
    if color_mode == "orientation" {
        return Err(ApiError::bad_request(
            "invalid_query: projection/matrix.json does not yet support color_mode=orientation",
        ));
    }
    let _ = matrix_format(query.format.as_deref())?;
    let guard = state.current_live_state.read().await;
    let snapshot = guard
        .as_ref()
        .ok_or_else(|| ApiError::not_found("no active local live workspace"))?;
    let spec = quantity_spec(quantity_id);
    let n_comp: usize = spec.map(|s| s.n_comp as usize).unwrap_or(3);
    let resolved = resolve_projection_query(&projection_query_from_matrix(query), n_comp)?;
    let field_revision = field_quantity_revision(snapshot, &quantity_id);
    let gen_id = domain_generation_id(snapshot);
    let session_id = snapshot.session.session_id.clone();
    let fdm_field = extract_fdm_field(snapshot, quantity_id, n_comp)
        .ok_or_else(|| ApiError::not_found(format!("field '{}' not available", quantity_id)))?;
    let fem_field = extract_fem_field(snapshot, quantity_id, n_comp);
    drop(guard);

    let projection = compute_projection(&fdm_field, fem_field.as_ref(), &resolved)?;
    let component = component_label(&resolved.component);
    let extra = format!(
        "reduction={}:samples={}:adaptive={}:method={}",
        resolved.reduction.as_str(),
        resolved.samples,
        u8::from(resolved.adaptive),
        projection.sampling_method
    );
    let hash = matrix_hash(&matrix_etag_token(
        quantity_id,
        &session_id,
        field_revision,
        &gen_id,
        query.plane,
        "projection",
        &component,
        "scalar",
        projection.x_size,
        projection.y_size,
        &extra,
    ));
    let matrix = matrix_response_from_projection(
        quantity_id,
        query.plane,
        &component,
        resolved.reduction.as_str(),
        projection,
        hash.clone(),
    );
    Ok((hash, matrix))
}

#[utoipa::path(
    get,
    path = "/v2/sessions/current/data/fields/{quantity_id}/projection/meta",
    params(
        ("quantity_id" = String, Path, description = "Quantity identifier"),
        FieldProjectionQuery,
    ),
    responses(
        (status = 200, description = "Projection metadata with binary scalar URL", body = FieldProjectionMeta),
        (status = 304, description = "Not modified"),
        (status = 400, description = "Invalid query parameters"),
        (status = 404, description = "Field not found"),
    ),
    tag = "data"
)]
pub async fn get_field_projection_meta(
    State(state): State<Arc<AppState>>,
    headers: HeaderMap,
    AxumPath(quantity_id): AxumPath<String>,
    Query(query): Query<FieldProjectionQuery>,
) -> Result<axum::response::Response, ApiError> {
    let guard = state.current_live_state.read().await;
    let snapshot = guard
        .as_ref()
        .ok_or_else(|| ApiError::not_found("no active local live workspace"))?;

    let spec = quantity_spec(&quantity_id);
    let n_comp: usize = spec.map(|s| s.n_comp as usize).unwrap_or(3);
    let resolved = resolve_projection_query(&query, n_comp)?;
    let field_revision = field_quantity_revision(snapshot, &quantity_id);
    let gen_id = domain_generation_id(snapshot);
    let session_id = snapshot.session.session_id.clone();
    let fdm_field = extract_fdm_field(snapshot, &quantity_id, n_comp)
        .ok_or_else(|| ApiError::not_found(format!("field '{}' not available", quantity_id)))?;
    let fem_field = extract_fem_field(snapshot, &quantity_id, n_comp);
    drop(guard);

    let projection = compute_projection(&fdm_field, fem_field.as_ref(), &resolved)?;
    let (error_estimate, error_method) =
        projection_error_estimate(&fdm_field, fem_field.as_ref(), &resolved, &projection)?;
    let etag_token = projection_etag_token(
        &quantity_id,
        &session_id,
        field_revision,
        &gen_id,
        &resolved,
        projection.sampling_method,
    );
    let etag = crate::router_v2::handlers::shared::stable_strong_etag(&etag_token);
    let mask_etag_token = format!("empty-mask:{etag_token}");
    let mask_etag = crate::router_v2::handlers::shared::stable_strong_etag(&mask_etag_token);
    let comp_label = component_label(&resolved.component);
    let tile_query = match (resolved.tile_x, resolved.tile_y, resolved.tile_size) {
        (Some(tile_x), Some(tile_y), Some(tile_size)) => {
            format!("&tile_x={tile_x}&tile_y={tile_y}&tile_size={tile_size}")
        }
        _ => String::new(),
    };
    let adaptive_query = if resolved.adaptive {
        format!(
            "&adaptive=true&min_samples={}{}",
            resolved.min_samples,
            resolved
                .error_tolerance
                .map(|value| format!("&error_tolerance={value}"))
                .unwrap_or_default()
        )
    } else {
        String::new()
    };
    let scalar_href = format!(
        "/v2/sessions/current/data/fields/{}/projection/scalar?plane={}&component={}&reduction={}&include_air_as_zero={}&samples={}&x_size={}&y_size={}{}{}",
        urlencoding(&quantity_id),
        urlencoding(resolved.plane.as_str()),
        urlencoding(&comp_label),
        urlencoding(resolved.reduction.as_str()),
        resolved.include_air_as_zero,
        resolved.samples,
        resolved.full_x_size,
        resolved.full_y_size,
        adaptive_query,
        tile_query,
    );
    let empty_mask_href = format!(
        "/v2/sessions/current/data/fields/{}/projection/empty-mask?plane={}&component={}&reduction={}&include_air_as_zero={}&samples={}&x_size={}&y_size={}{}{}",
        urlencoding(&quantity_id),
        urlencoding(resolved.plane.as_str()),
        urlencoding(&comp_label),
        urlencoding(resolved.reduction.as_str()),
        resolved.include_air_as_zero,
        resolved.samples,
        resolved.full_x_size,
        resolved.full_y_size,
        adaptive_query,
        tile_query,
    );
    let meta = FieldProjectionMeta {
        quantity_id: quantity_id.clone(),
        component: comp_label,
        plane: resolved.plane.as_str().to_string(),
        reduction: resolved.reduction.as_str().to_string(),
        include_air_as_zero: resolved.include_air_as_zero,
        samples: projection.samples,
        field_revision,
        domain_generation_id: gen_id,
        sampling_method: projection.sampling_method.to_string(),
        etag: etag.clone(),
        projection_revision: etag_token,
        x_pixels: projection.x_size,
        y_pixels: projection.y_size,
        grid: FieldSliceGrid {
            x_size: projection.x_size,
            y_size: projection.y_size,
            point_count: projection.x_size * projection.y_size,
        },
        bounds: Some(FieldSliceBounds {
            u_min: projection.u_min,
            u_max: projection.u_max,
            v_min: projection.v_min,
            v_max: projection.v_max,
        }),
        occupied_count: projection.occupied_count,
        occupied_measure: projection.occupied_measure,
        empty_count: projection.empty_count,
        error_estimate,
        error_method,
        scalar: FieldSliceBinaryDescriptor {
            available: true,
            n_comp: 1,
            point_count: projection.x_size * projection.y_size,
            min: Some(projection.min),
            max: Some(projection.max),
            etag: Some(etag.clone()),
            href: Some(scalar_href),
        },
        empty_mask: FieldProjectionMaskDescriptor {
            available: true,
            point_count: projection.x_size * projection.y_size,
            etag: Some(mask_etag),
            href: Some(empty_mask_href),
        },
    };

    Ok(crate::router_v2::handlers::shared::conditional_json_response(&headers, &etag, &meta))
}

#[utoipa::path(
    get,
    path = "/v2/sessions/current/data/fields/{quantity_id}/projection/scalar",
    params(
        ("quantity_id" = String, Path, description = "Quantity identifier"),
        FieldProjectionQuery,
    ),
    responses(
        (status = 200, description = "Binary FMVP v2 projected scalar raster", content_type = "application/octet-stream"),
        (status = 304, description = "Not modified"),
        (status = 400, description = "Invalid query parameters"),
        (status = 404, description = "Field not found"),
    ),
    tag = "data"
)]
pub async fn get_field_projection_scalar(
    State(state): State<Arc<AppState>>,
    headers: HeaderMap,
    AxumPath(quantity_id): AxumPath<String>,
    Query(query): Query<FieldProjectionQuery>,
) -> Result<axum::response::Response, ApiError> {
    let guard = state.current_live_state.read().await;
    let snapshot = guard
        .as_ref()
        .ok_or_else(|| ApiError::not_found("no active local live workspace"))?;

    let spec = quantity_spec(&quantity_id);
    let n_comp: usize = spec.map(|s| s.n_comp as usize).unwrap_or(3);
    let resolved = resolve_projection_query(&query, n_comp)?;
    let field_revision = field_quantity_revision(snapshot, &quantity_id);
    let gen_id = domain_generation_id(snapshot);
    let session_id = snapshot.session.session_id.clone();
    let fdm_field = extract_fdm_field(snapshot, &quantity_id, n_comp)
        .ok_or_else(|| ApiError::not_found(format!("field '{}' not available", quantity_id)))?;
    let fem_field = extract_fem_field(snapshot, &quantity_id, n_comp);
    let sampling_method = if fem_field.is_some() {
        "fem_tetra_volume_projection_conservative"
    } else if resolved.adaptive {
        "fdm_layer_projection_adaptive_nearest"
    } else {
        "fdm_layer_projection_nearest"
    };
    let component = component_label(&resolved.component);
    let component_cache_token = format!(
        "{component}:method={sampling_method}:tol={}:min={}",
        resolved
            .error_tolerance
            .map(|value| value.to_bits().to_string())
            .unwrap_or_else(|| "none".to_string()),
        resolved.min_samples
    );
    let cache_key = scalar_projection_cache_key(
        &quantity_id,
        &session_id,
        field_revision,
        &gen_id,
        resolved.plane.as_str(),
        resolved.x_size,
        resolved.y_size,
        &component_cache_token,
        resolved.reduction.as_str(),
        resolved.include_air_as_zero,
        resolved.samples,
        resolved.tile_x,
        resolved.tile_y,
        resolved.tile_size,
    );
    let etag_token = projection_etag_token(
        &quantity_id,
        &session_id,
        field_revision,
        &gen_id,
        &resolved,
        sampling_method,
    );
    let etag = crate::router_v2::handlers::shared::stable_strong_etag(&etag_token);
    drop(guard);

    {
        let mut cache = state.quantity_data_plane.scalar_slice_cache.lock().await;
        if let Some(cached) = cache.get(&cache_key) {
            return Ok(
                crate::router_v2::handlers::shared::conditional_binary_response(
                    &headers,
                    &cached.etag,
                    cached.bytes.clone(),
                ),
            );
        }
    }

    let projection = compute_projection(&fdm_field, fem_field.as_ref(), &resolved)?;
    let binary = serialize_field_vector_binary_v2(
        &quantity_id,
        1,
        [projection.x_size, projection.y_size, 1],
        &projection.scalar_values,
    )
    .map_err(ApiError::internal)?;
    {
        let mut cache = state.quantity_data_plane.scalar_slice_cache.lock().await;
        cache.insert(cache_key, binary.clone(), etag.clone());
    }

    Ok(crate::router_v2::handlers::shared::conditional_binary_response(&headers, &etag, binary))
}

#[utoipa::path(
    get,
    path = "/v2/sessions/current/data/fields/{quantity_id}/projection/profile",
    params(
        ("quantity_id" = String, Path, description = "Quantity identifier"),
        FieldProjectionProfileQuery,
    ),
    responses(
        (status = 200, description = "Depth-resolved FEM projection profile for one raster pixel", body = FieldProjectionProfile),
        (status = 400, description = "Invalid query parameters"),
        (status = 404, description = "Field not found"),
        (status = 409, description = "Projection profile requires nodal FEM field and tetrahedral mesh"),
    ),
    tag = "data"
)]
pub async fn get_field_projection_profile(
    State(state): State<Arc<AppState>>,
    AxumPath(quantity_id): AxumPath<String>,
    Query(query): Query<FieldProjectionProfileQuery>,
) -> Result<Json<FieldProjectionProfile>, ApiError> {
    let guard = state.current_live_state.read().await;
    let snapshot = guard
        .as_ref()
        .ok_or_else(|| ApiError::not_found("no active local live workspace"))?;

    let spec = quantity_spec(&quantity_id);
    let n_comp: usize = spec.map(|s| s.n_comp as usize).unwrap_or(3);
    let resolved = resolve_projection_profile_query(&query, n_comp)?;
    let field_revision = field_quantity_revision(snapshot, &quantity_id);
    let gen_id = domain_generation_id(snapshot);
    let fem_field = extract_fem_field(snapshot, &quantity_id, n_comp).ok_or_else(|| {
        ApiError::conflict(
            "projection profile requires a nodal FEM field matching the current mesh",
        )
    })?;
    drop(guard);

    let profile = fem_projection_profile(&fem_field, &resolved)?;
    let sample_count = profile.samples.len() as u32;
    let truncated = sample_count >= resolved.max_samples;
    Ok(Json(FieldProjectionProfile {
        quantity_id: quantity_id.clone(),
        component: component_label(&resolved.component),
        plane: resolved.plane.as_str().to_string(),
        field_revision,
        domain_generation_id: gen_id,
        sampling_method: profile.sampling_method.to_string(),
        pixel_x: resolved.pixel_x,
        pixel_y: resolved.pixel_y,
        x_pixels: resolved.x_size,
        y_pixels: resolved.y_size,
        u: profile.u,
        v: profile.v,
        bounds: Some(FieldSliceBounds {
            u_min: profile.u_min,
            u_max: profile.u_max,
            v_min: profile.v_min,
            v_max: profile.v_max,
        }),
        sample_count,
        truncated,
        samples: profile
            .samples
            .into_iter()
            .map(|sample| FieldProjectionProfileSample {
                element_index: sample.element_index,
                marker: sample.marker,
                normal_coord: sample.normal_coord,
                value: sample.value,
                measure: sample.measure,
            })
            .collect(),
    }))
}

#[utoipa::path(
    get,
    path = "/v2/sessions/current/data/fields/{quantity_id}/projection/empty-mask",
    params(
        ("quantity_id" = String, Path, description = "Quantity identifier"),
        FieldProjectionQuery,
    ),
    responses(
        (status = 200, description = "Binary projected empty-column mask, one byte per raster cell", content_type = "application/octet-stream"),
        (status = 304, description = "Not modified"),
        (status = 400, description = "Invalid query parameters"),
        (status = 404, description = "Field not found"),
    ),
    tag = "data"
)]
pub async fn get_field_projection_empty_mask(
    State(state): State<Arc<AppState>>,
    headers: HeaderMap,
    AxumPath(quantity_id): AxumPath<String>,
    Query(query): Query<FieldProjectionQuery>,
) -> Result<axum::response::Response, ApiError> {
    let guard = state.current_live_state.read().await;
    let snapshot = guard
        .as_ref()
        .ok_or_else(|| ApiError::not_found("no active local live workspace"))?;

    let spec = quantity_spec(&quantity_id);
    let n_comp: usize = spec.map(|s| s.n_comp as usize).unwrap_or(3);
    let resolved = resolve_projection_query(&query, n_comp)?;
    let field_revision = field_quantity_revision(snapshot, &quantity_id);
    let gen_id = domain_generation_id(snapshot);
    let session_id = snapshot.session.session_id.clone();
    let fdm_field = extract_fdm_field(snapshot, &quantity_id, n_comp)
        .ok_or_else(|| ApiError::not_found(format!("field '{}' not available", quantity_id)))?;
    let fem_field = extract_fem_field(snapshot, &quantity_id, n_comp);
    let sampling_method = if fem_field.is_some() {
        "fem_tetra_volume_projection_conservative"
    } else if resolved.adaptive {
        "fdm_layer_projection_adaptive_nearest"
    } else {
        "fdm_layer_projection_nearest"
    };
    let component = component_label(&resolved.component);
    let component_cache_token = format!(
        "{component}:method={sampling_method}:tol={}:min={}",
        resolved
            .error_tolerance
            .map(|value| value.to_bits().to_string())
            .unwrap_or_else(|| "none".to_string()),
        resolved.min_samples
    );
    let cache_key = projection_empty_mask_cache_key(
        &quantity_id,
        &session_id,
        field_revision,
        &gen_id,
        resolved.plane.as_str(),
        resolved.x_size,
        resolved.y_size,
        &component_cache_token,
        resolved.reduction.as_str(),
        resolved.include_air_as_zero,
        resolved.samples,
        resolved.tile_x,
        resolved.tile_y,
        resolved.tile_size,
    );
    let etag_token = projection_etag_token(
        &quantity_id,
        &session_id,
        field_revision,
        &gen_id,
        &resolved,
        sampling_method,
    );
    let etag =
        crate::router_v2::handlers::shared::stable_strong_etag(&format!("empty-mask:{etag_token}"));
    drop(guard);

    {
        let mut cache = state.quantity_data_plane.scalar_slice_cache.lock().await;
        if let Some(cached) = cache.get(&cache_key) {
            return Ok(
                crate::router_v2::handlers::shared::conditional_binary_response(
                    &headers,
                    &cached.etag,
                    cached.bytes.clone(),
                ),
            );
        }
    }

    let projection = compute_projection(&fdm_field, fem_field.as_ref(), &resolved)?;
    let binary = projection.empty_mask;
    {
        let mut cache = state.quantity_data_plane.scalar_slice_cache.lock().await;
        cache.insert(cache_key, binary.clone(), etag.clone());
    }

    Ok(crate::router_v2::handlers::shared::conditional_binary_response(&headers, &etag, binary))
}

#[utoipa::path(
    get,
    path = "/v2/sessions/current/data/fields/{quantity_id}/samples/slice/matrix.json",
    params(
        ("quantity_id" = String, Path, description = "Quantity identifier"),
        FieldSliceMatrixQuery,
    ),
    responses(
        (status = 200, description = "Debug JSON 2D slice matrix", body = FieldMatrixResponse),
        (status = 304, description = "Not modified"),
        (status = 400, description = "Invalid query parameters"),
        (status = 404, description = "Field not found"),
        (status = 409, description = "Requested FEM mode requires mesh/field parity"),
    ),
    tag = "data"
)]
pub async fn get_field_slice_matrix_json(
    State(state): State<Arc<AppState>>,
    headers: HeaderMap,
    AxumPath(quantity_id): AxumPath<String>,
    Query(query): Query<FieldSliceMatrixQuery>,
) -> Result<axum::response::Response, ApiError> {
    let (etag, matrix) = build_slice_matrix(&state, &quantity_id, &query).await?;
    Ok(
        crate::router_v2::handlers::shared::conditional_json_response(
            &headers,
            &etag,
            &matrix.response,
        ),
    )
}

#[utoipa::path(
    get,
    path = "/v2/sessions/current/data/fields/{quantity_id}/projection/matrix.json",
    params(
        ("quantity_id" = String, Path, description = "Quantity identifier"),
        FieldProjectionMatrixQuery,
    ),
    responses(
        (status = 200, description = "Debug JSON 2D projection matrix", body = FieldMatrixResponse),
        (status = 304, description = "Not modified"),
        (status = 400, description = "Invalid query parameters"),
        (status = 404, description = "Field not found"),
    ),
    tag = "data"
)]
pub async fn get_field_projection_matrix_json(
    State(state): State<Arc<AppState>>,
    headers: HeaderMap,
    AxumPath(quantity_id): AxumPath<String>,
    Query(query): Query<FieldProjectionMatrixQuery>,
) -> Result<axum::response::Response, ApiError> {
    let (etag, matrix) = build_projection_matrix(&state, &quantity_id, &query).await?;
    Ok(
        crate::router_v2::handlers::shared::conditional_json_response(
            &headers,
            &etag,
            &matrix.response,
        ),
    )
}

#[utoipa::path(
    get,
    path = "/v2/sessions/current/data/fields/{quantity_id}/samples/slice/render.png",
    params(
        ("quantity_id" = String, Path, description = "Quantity identifier"),
        FieldRenderPngQuery,
    ),
    responses(
        (status = 200, description = "Diagnostic PNG for a 2D slice", content_type = "image/png"),
        (status = 304, description = "Not modified"),
        (status = 400, description = "Invalid query parameters"),
        (status = 404, description = "Field not found"),
        (status = 409, description = "Requested FEM mode requires mesh/field parity"),
    ),
    tag = "data"
)]
pub async fn get_field_slice_render_png(
    State(state): State<Arc<AppState>>,
    headers: HeaderMap,
    AxumPath(quantity_id): AxumPath<String>,
    Query(query): Query<FieldRenderPngQuery>,
) -> Result<axum::response::Response, ApiError> {
    let matrix_query = FieldSliceMatrixQuery {
        plane: query.plane,
        component: query.component.clone(),
        color_mode: query.color_mode.clone(),
        cut_world: query.cut_world,
        cut_norm: query.cut_norm,
        mode: query.mode.clone(),
        thickness_world: query.thickness_world,
        aggregation: query.aggregation.clone(),
        x_size: query.x_size,
        y_size: query.y_size,
        max_points: query.max_points,
        samples: query.samples,
        format: Some("both".to_string()),
    };
    let (matrix_etag, matrix) = build_slice_matrix(&state, &quantity_id, &matrix_query).await?;
    let png = encode_png_from_matrix(&matrix, &query)?;
    let render_etag = matrix_hash(&format!(
        "render:{}:colormap={}:auto={}:vmin={}:vmax={}:alpha={}:mesh={}:arrows={}",
        matrix_etag,
        query.colormap.as_deref().unwrap_or("viridis"),
        query.auto_scale.as_deref().unwrap_or("slice"),
        query
            .vmin
            .map_or_else(|| "none".to_string(), |value| value.to_bits().to_string()),
        query
            .vmax
            .map_or_else(|| "none".to_string(), |value| value.to_bits().to_string()),
        u8::from(query.alpha_mask.unwrap_or(true)),
        u8::from(query.show_mesh.unwrap_or(false)),
        u8::from(query.show_arrows.unwrap_or(false)),
    ));
    let mut response =
        crate::router_v2::handlers::shared::conditional_binary_response_with_content_type(
            &headers,
            &render_etag,
            png,
            HeaderValue::from_static("image/png"),
        );
    insert_matrix_headers(
        &mut response,
        &matrix_etag,
        &matrix.response.sampling_method,
    );
    Ok(response)
}

#[utoipa::path(
    get,
    path = "/v2/sessions/current/data/fields/{quantity_id}/projection/render.png",
    params(
        ("quantity_id" = String, Path, description = "Quantity identifier"),
        FieldRenderPngQuery,
    ),
    responses(
        (status = 200, description = "Diagnostic PNG for a 2D projection", content_type = "image/png"),
        (status = 304, description = "Not modified"),
        (status = 400, description = "Invalid query parameters"),
        (status = 404, description = "Field not found"),
    ),
    tag = "data"
)]
pub async fn get_field_projection_render_png(
    State(state): State<Arc<AppState>>,
    headers: HeaderMap,
    AxumPath(quantity_id): AxumPath<String>,
    Query(query): Query<FieldRenderPngQuery>,
) -> Result<axum::response::Response, ApiError> {
    let matrix_query = FieldProjectionMatrixQuery {
        plane: query.plane,
        component: query.component.clone(),
        color_mode: query.color_mode.clone(),
        mode: query
            .mode
            .clone()
            .or_else(|| Some("projection".to_string())),
        aggregation: query.aggregation.clone(),
        reduction: query.reduction.clone(),
        include_air_as_zero: query.include_air_as_zero,
        samples: query.samples,
        adaptive: query.adaptive,
        error_tolerance: query.error_tolerance,
        min_samples: query.min_samples,
        x_size: query.x_size,
        y_size: query.y_size,
        max_points: query.max_points,
        format: Some("values".to_string()),
    };
    let (matrix_etag, matrix) =
        build_projection_matrix(&state, &quantity_id, &matrix_query).await?;
    let png = encode_png_from_matrix(&matrix, &query)?;
    let render_etag = matrix_hash(&format!(
        "render:{}:colormap={}:auto={}:vmin={}:vmax={}:alpha={}:mesh={}:arrows={}",
        matrix_etag,
        query.colormap.as_deref().unwrap_or("viridis"),
        query.auto_scale.as_deref().unwrap_or("slice"),
        query
            .vmin
            .map_or_else(|| "none".to_string(), |value| value.to_bits().to_string()),
        query
            .vmax
            .map_or_else(|| "none".to_string(), |value| value.to_bits().to_string()),
        u8::from(query.alpha_mask.unwrap_or(true)),
        u8::from(query.show_mesh.unwrap_or(false)),
        u8::from(query.show_arrows.unwrap_or(false)),
    ));
    let mut response =
        crate::router_v2::handlers::shared::conditional_binary_response_with_content_type(
            &headers,
            &render_etag,
            png,
            HeaderValue::from_static("image/png"),
        );
    insert_matrix_headers(
        &mut response,
        &matrix_etag,
        &matrix.response.sampling_method,
    );
    Ok(response)
}

fn encode_png_from_matrix(
    matrix: &MatrixBuild,
    query: &FieldRenderPngQuery,
) -> Result<Vec<u8>, ApiError> {
    let mesh_lines: &[[f64; 4]] = if query.show_mesh.unwrap_or(false) {
        &matrix.mesh_lines
    } else {
        &[]
    };
    if let Some(rgba) = matrix.rgba_pixels.as_ref() {
        if mesh_lines.is_empty() {
            return encode_rgba_matrix_png(
                matrix.response.x_size,
                matrix.response.y_size,
                rgba,
                &matrix.mask_flat,
                query.alpha_mask.unwrap_or(true),
            );
        }
        return encode_rgba_matrix_png_with_lines(
            matrix.response.x_size,
            matrix.response.y_size,
            rgba,
            &matrix.mask_flat,
            query.alpha_mask.unwrap_or(true),
            mesh_lines,
        );
    }
    let values = matrix.scalar_values.as_ref().ok_or_else(|| {
        ApiError::internal("render_png: scalar matrix values missing for PNG render")
    })?;
    if mesh_lines.is_empty() {
        return encode_scalar_png(
            matrix.response.x_size,
            matrix.response.y_size,
            values,
            &matrix.mask_flat,
            query.colormap.as_deref().unwrap_or("viridis"),
            AutoScaleMode::parse(query.auto_scale.as_deref())?,
            query.vmin,
            query.vmax,
            query.alpha_mask.unwrap_or(true),
        );
    }
    encode_scalar_png_with_lines(
        matrix.response.x_size,
        matrix.response.y_size,
        values,
        &matrix.mask_flat,
        query.colormap.as_deref().unwrap_or("viridis"),
        AutoScaleMode::parse(query.auto_scale.as_deref())?,
        query.vmin,
        query.vmax,
        query.alpha_mask.unwrap_or(true),
        mesh_lines,
    )
}

fn insert_matrix_headers(
    response: &mut axum::response::Response,
    matrix_hash: &str,
    sampling_method: &str,
) {
    if let Ok(value) = HeaderValue::from_str(matrix_hash) {
        response
            .headers_mut()
            .insert(HeaderName::from_static("x-fullmag-matrix-hash"), value);
    }
    if let Ok(value) = HeaderValue::from_str(sampling_method) {
        response
            .headers_mut()
            .insert(HeaderName::from_static("x-fullmag-sampling-method"), value);
    }
}

#[utoipa::path(
    get,
    path = "/v2/sessions/current/data/fields/{quantity_id}/samples/slice/meta",
    params(
        ("quantity_id" = String, Path, description = "Quantity identifier"),
        FieldSliceQuery,
    ),
    responses(
        (status = 200, description = "Slice metadata with resolved parameters and binary URLs", body = FieldSliceMeta),
        (status = 304, description = "Not modified"),
        (status = 400, description = "Invalid query parameters"),
        (status = 404, description = "Field not found"),
        (status = 409, description = "Slice requires mesh topology (FEM only)"),
    ),
    tag = "data"
)]
pub async fn get_field_slice_meta(
    State(state): State<Arc<AppState>>,
    headers: HeaderMap,
    AxumPath(quantity_id): AxumPath<String>,
    Query(query): Query<FieldSliceQuery>,
) -> Result<axum::response::Response, ApiError> {
    let guard = state.current_live_state.read().await;
    let snapshot = guard
        .as_ref()
        .ok_or_else(|| ApiError::not_found("no active local live workspace"))?;

    let spec = quantity_spec(&quantity_id);
    let n_comp: usize = spec.map(|s| s.n_comp as usize).unwrap_or(3);

    let resolved = resolve_slice_query(&query, n_comp)?;
    let is_fem = is_fem_runtime(snapshot);
    if is_fem && !fem_topology_available(snapshot) {
        return Err(ApiError::conflict(
            "quantity slice requires mesh topology for FEM runtime",
        ));
    }

    let field_revision = field_quantity_revision(snapshot, &quantity_id);
    let gen_id = domain_generation_id(snapshot);
    let session_id = snapshot.session.session_id.clone();

    let fdm_field = extract_fdm_field(snapshot, &quantity_id, n_comp)
        .ok_or_else(|| ApiError::not_found(format!("field '{}' not available", quantity_id)))?;
    let fem_field = extract_fem_field(snapshot, &quantity_id, n_comp);

    drop(guard);
    let spatial_index = if let Some(fem_field) = fem_field.as_ref() {
        Some(
            get_or_build_fem_spatial_index(
                &state,
                &quantity_id,
                &gen_id,
                resolved.plane,
                fem_field,
            )
            .await,
        )
    } else {
        None
    };

    // Perform slice outside lock
    let slice_result = if let Some(fem_field) = fem_field.as_ref() {
        fem_tetra_linear_slice(fem_field, &resolved, spatial_index.as_deref())?
    } else if is_fem {
        fem_slice_fallback(&fdm_field, &resolved)?
    } else {
        fdm_slice(&fdm_field, &resolved)?
    };
    let response_cut_norm = cut_norm_from_world(
        slice_result.cut_world,
        fem_field
            .as_ref()
            .and_then(|field| fem_normal_bounds_from_nodes(&field.nodes, resolved.plane))
            .or_else(|| fdm_normal_bounds(&fdm_field, resolved.plane)),
        resolved.cut_norm,
    );

    let scalar_etag_token = slice_etag_token(
        &quantity_id,
        &session_id,
        field_revision,
        &gen_id,
        &resolved,
    );
    let scalar_etag = crate::router_v2::handlers::shared::stable_strong_etag(&scalar_etag_token);

    let meta_etag_token = format!("meta:{}", scalar_etag_token);
    let meta_etag = crate::router_v2::handlers::shared::stable_strong_etag(&meta_etag_token);

    let mut arrows_query = resolved.clone();
    arrows_query.component = ComponentSelection::Full;
    arrows_query.include_arrows = true;
    let arrows_etag_token = format!(
        "arrows:{}",
        slice_etag_token(
            &quantity_id,
            &session_id,
            field_revision,
            &gen_id,
            &arrows_query,
        )
    );
    let arrows_etag = crate::router_v2::handlers::shared::stable_strong_etag(&arrows_etag_token);

    let comp_label = component_label(&resolved.component);
    let plane_str = resolved.plane.as_str().to_string();
    let cut_kind = if query.cut_world.is_some() {
        "world"
    } else {
        "normalized"
    };

    // Build canonical href parameters for binary endpoints
    let comp_param = urlencoding(&comp_label);
    let plane_param = urlencoding(&plane_str);
    let cut_param = if query.cut_world.is_some() {
        resolved
            .cut_world
            .map(|value| format!("cut_world={value}"))
            .unwrap_or_else(|| format!("cut_norm={response_cut_norm:.6}"))
    } else {
        format!("cut_norm={response_cut_norm:.6}")
    };
    let size_param = format!("x_size={}&y_size={}", resolved.x_size, resolved.y_size);

    let scalar_href = format!(
        "/v2/sessions/current/data/fields/{}/samples/slice/scalar?plane={}&component={}&{}&{}",
        urlencoding(&quantity_id),
        plane_param,
        comp_param,
        cut_param,
        size_param
    );
    let arrows_href = if resolved.include_arrows {
        Some(format!(
            "/v2/sessions/current/data/fields/{}/samples/slice/arrows?plane={}&component=full&{}&{}&arrow_every={}&max_arrows={}",
            urlencoding(&quantity_id),
            plane_param,
            cut_param,
            size_param,
            resolved.arrow_every,
            resolved.max_arrows
        ))
    } else {
        None
    };

    let meta = FieldSliceMeta {
        quantity_id: quantity_id.clone(),
        component: comp_label,
        plane: plane_str,
        cut_kind: cut_kind.to_string(),
        cut_norm: response_cut_norm,
        cut_world: slice_result.cut_world,
        field_revision,
        domain_generation_id: gen_id,
        sampling_method: slice_result.sampling_method.to_string(),
        etag: meta_etag.clone(),
        slice_revision: meta_etag_token.clone(),
        x_pixels: slice_result.x_size,
        y_pixels: slice_result.y_size,
        grid: FieldSliceGrid {
            x_size: slice_result.x_size,
            y_size: slice_result.y_size,
            point_count: slice_result.x_size * slice_result.y_size,
        },
        bounds: Some(FieldSliceBounds {
            u_min: slice_result.u_min,
            u_max: slice_result.u_max,
            v_min: slice_result.v_min,
            v_max: slice_result.v_max,
        }),
        scalar: FieldSliceBinaryDescriptor {
            available: true,
            n_comp: slice_result.n_comp_out as u8,
            point_count: slice_result.x_size * slice_result.y_size,
            min: Some(slice_result.min),
            max: Some(slice_result.max),
            etag: Some(scalar_etag.clone()),
            href: Some(scalar_href),
        },
        arrows: FieldSliceBinaryDescriptor {
            available: resolved.include_arrows && slice_result.arrow_count > 0,
            n_comp: 2,
            point_count: slice_result.arrow_count as u32,
            min: None,
            max: None,
            etag: if resolved.include_arrows {
                Some(arrows_etag)
            } else {
                None
            },
            href: arrows_href,
        },
    };

    Ok(crate::router_v2::handlers::shared::conditional_json_response(&headers, &meta_etag, &meta))
}

#[utoipa::path(
    get,
    path = "/v2/sessions/current/data/fields/{quantity_id}/samples/slice/scalar",
    params(
        ("quantity_id" = String, Path, description = "Quantity identifier"),
        FieldSliceQuery,
    ),
    responses(
        (status = 200, description = "Binary FMVP v2 2D scalar slice", content_type = "application/octet-stream"),
        (status = 304, description = "Not modified"),
        (status = 400, description = "Invalid query parameters"),
        (status = 404, description = "Field not found"),
        (status = 409, description = "Slice requires mesh topology"),
    ),
    tag = "data"
)]
pub async fn get_field_slice_scalar(
    State(state): State<Arc<AppState>>,
    headers: HeaderMap,
    AxumPath(quantity_id): AxumPath<String>,
    Query(query): Query<FieldSliceQuery>,
) -> Result<axum::response::Response, ApiError> {
    let guard = state.current_live_state.read().await;
    let snapshot = guard
        .as_ref()
        .ok_or_else(|| ApiError::not_found("no active local live workspace"))?;

    let spec = quantity_spec(&quantity_id);
    let n_comp: usize = spec.map(|s| s.n_comp as usize).unwrap_or(3);

    let mut resolved = resolve_slice_query(&query, n_comp)?;
    resolved.include_arrows = false;
    let is_fem = is_fem_runtime(snapshot);
    if is_fem && !fem_topology_available(snapshot) {
        return Err(ApiError::conflict(
            "quantity slice requires mesh topology for FEM runtime",
        ));
    }
    let field_revision = field_quantity_revision(snapshot, &quantity_id);
    let gen_id = domain_generation_id(snapshot);
    let session_id = snapshot.session.session_id.clone();

    let fdm_field = extract_fdm_field(snapshot, &quantity_id, n_comp)
        .ok_or_else(|| ApiError::not_found(format!("field '{}' not available", quantity_id)))?;
    let fem_field = extract_fem_field(snapshot, &quantity_id, n_comp);

    let component = component_label(&resolved.component);
    let cache_key = slice_cache_key(
        &quantity_id,
        &session_id,
        field_revision,
        &gen_id,
        resolved.plane.as_str(),
        &slice_cut_cache_key(&resolved),
        resolved.x_size,
        resolved.y_size,
        &component,
        resolved.include_arrows,
        resolved.arrow_every,
        resolved.max_arrows,
    );
    let etag_token = slice_etag_token(
        &quantity_id,
        &session_id,
        field_revision,
        &gen_id,
        &resolved,
    );
    let etag = crate::router_v2::handlers::shared::stable_strong_etag(&etag_token);

    drop(guard);
    let spatial_index = if let Some(fem_field) = fem_field.as_ref() {
        Some(
            get_or_build_fem_spatial_index(
                &state,
                &quantity_id,
                &gen_id,
                resolved.plane,
                fem_field,
            )
            .await,
        )
    } else {
        None
    };

    {
        let mut cache = state.quantity_data_plane.scalar_slice_cache.lock().await;
        if let Some(cached) = cache.get(&cache_key) {
            let mut resp = crate::router_v2::handlers::shared::conditional_binary_response(
                &headers,
                &cached.etag,
                cached.bytes.clone(),
            );
            if let Ok(v) = HeaderValue::from_str(&field_revision.to_string()) {
                resp.headers_mut()
                    .insert(axum::http::HeaderName::from_static(HDR_FIELD_REVISION), v);
            }
            return Ok(resp);
        }
    }

    let slice_result = if let Some(fem_field) = fem_field.as_ref() {
        fem_tetra_linear_slice(fem_field, &resolved, spatial_index.as_deref())?
    } else if is_fem {
        fem_slice_fallback(&fdm_field, &resolved)?
    } else {
        fdm_slice(&fdm_field, &resolved)?
    };

    let grid = [resolved.x_size, resolved.y_size, 1];
    let binary = serialize_field_vector_binary_v2(
        &quantity_id,
        slice_result.n_comp_out,
        grid,
        &slice_result.scalar_values,
    )
    .map_err(ApiError::internal)?;

    {
        let mut cache = state.quantity_data_plane.scalar_slice_cache.lock().await;
        cache.insert(cache_key, binary.clone(), etag.clone());
    }

    let mut resp =
        crate::router_v2::handlers::shared::conditional_binary_response(&headers, &etag, binary);
    if let Ok(v) = HeaderValue::from_str(&field_revision.to_string()) {
        resp.headers_mut()
            .insert(axum::http::HeaderName::from_static(HDR_FIELD_REVISION), v);
    }
    Ok(resp)
}

#[utoipa::path(
    get,
    path = "/v2/sessions/current/data/fields/{quantity_id}/samples/slice/arrows",
    params(
        ("quantity_id" = String, Path, description = "Quantity identifier"),
        FieldSliceQuery,
    ),
    responses(
        (status = 200, description = "Binary FMVP v2 2D arrow (u,v) pairs", content_type = "application/octet-stream"),
        (status = 304, description = "Not modified"),
        (status = 400, description = "Invalid query parameters"),
        (status = 404, description = "Field not found"),
        (status = 409, description = "Slice requires mesh topology"),
    ),
    tag = "data"
)]
pub async fn get_field_slice_arrows(
    State(state): State<Arc<AppState>>,
    headers: HeaderMap,
    AxumPath(quantity_id): AxumPath<String>,
    Query(mut query): Query<FieldSliceQuery>,
) -> Result<axum::response::Response, ApiError> {
    // Arrows always use the full vector
    query.component = Some("full".to_string());
    query.include_arrows = Some(true);

    let guard = state.current_live_state.read().await;
    let snapshot = guard
        .as_ref()
        .ok_or_else(|| ApiError::not_found("no active local live workspace"))?;

    let spec = quantity_spec(&quantity_id);
    let n_comp: usize = spec.map(|s| s.n_comp as usize).unwrap_or(3);

    let mut resolved = resolve_slice_query(&query, n_comp)?;
    resolved.component = ComponentSelection::Full;
    resolved.include_arrows = true;
    let is_fem = is_fem_runtime(snapshot);
    if is_fem && !fem_topology_available(snapshot) {
        return Err(ApiError::conflict(
            "quantity slice requires mesh topology for FEM runtime",
        ));
    }
    let field_revision = field_quantity_revision(snapshot, &quantity_id);
    let gen_id = domain_generation_id(snapshot);
    let session_id = snapshot.session.session_id.clone();

    let fdm_field = extract_fdm_field(snapshot, &quantity_id, n_comp)
        .ok_or_else(|| ApiError::not_found(format!("field '{}' not available", quantity_id)))?;
    let fem_field = extract_fem_field(snapshot, &quantity_id, n_comp);

    let cache_key = slice_cache_key(
        &quantity_id,
        &session_id,
        field_revision,
        &gen_id,
        resolved.plane.as_str(),
        &slice_cut_cache_key(&resolved),
        resolved.x_size,
        resolved.y_size,
        "full",
        true,
        resolved.arrow_every,
        resolved.max_arrows,
    );
    let etag_token = format!(
        "arrows:{}",
        slice_etag_token(
            &quantity_id,
            &session_id,
            field_revision,
            &gen_id,
            &resolved
        )
    );
    let etag = crate::router_v2::handlers::shared::stable_strong_etag(&etag_token);

    drop(guard);
    let spatial_index = if let Some(fem_field) = fem_field.as_ref() {
        Some(
            get_or_build_fem_spatial_index(
                &state,
                &quantity_id,
                &gen_id,
                resolved.plane,
                fem_field,
            )
            .await,
        )
    } else {
        None
    };

    {
        let mut cache = state.quantity_data_plane.arrow_slice_cache.lock().await;
        if let Some(cached) = cache.get(&cache_key) {
            return Ok(
                crate::router_v2::handlers::shared::conditional_binary_response(
                    &headers,
                    &cached.etag,
                    cached.bytes.clone(),
                ),
            );
        }
    }

    let slice_result = if let Some(fem_field) = fem_field.as_ref() {
        fem_tetra_linear_slice(fem_field, &resolved, spatial_index.as_deref())?
    } else if is_fem {
        fem_slice_fallback(&fdm_field, &resolved)?
    } else {
        fdm_slice(&fdm_field, &resolved)?
    };

    let arrow_count = slice_result.arrow_count as u32;
    let binary = serialize_field_vector_binary_v2(
        &quantity_id,
        2,
        [arrow_count, 1, 1],
        &slice_result.arrow_values,
    )
    .map_err(ApiError::internal)?;

    {
        let mut cache = state.quantity_data_plane.arrow_slice_cache.lock().await;
        cache.insert(cache_key, binary.clone(), etag.clone());
    }

    Ok(crate::router_v2::handlers::shared::conditional_binary_response(&headers, &etag, binary))
}

// ── URL encoding helper ───────────────────────────────────────────────────────

fn urlencoding(s: &str) -> String {
    let mut out = String::with_capacity(s.len());
    for byte in s.bytes() {
        match byte {
            b'A'..=b'Z' | b'a'..=b'z' | b'0'..=b'9' | b'-' | b'_' | b'.' | b'~' => {
                out.push(byte as char);
            }
            _ => {
                out.push('%');
                out.push_str(&format!("{:02X}", byte));
            }
        }
    }
    out
}

#[cfg(test)]
mod tests {
    use super::{
        analysis_complex_vector_view_values, analysis_frequency_response_view_values,
        apply_field_scope, decode_complex_f64_pairs_little_endian, is_fem_runtime,
        parse_analysis_eigen_mode_field_id, parse_analysis_frequency_response_field_id,
        parse_component, preview_cache_is_fresher, project_values, resolve_field_scope,
        serialize_analysis_field_vector_binary, FieldVectorQuery, ResolvedFieldScopeDomain,
    };
    use crate::session::default_current_live_state;
    use crate::types::CurrentLiveSnapshotRequest;
    use fullmag_runner::{
        BackendCapabilities, FemMeshPartPayload, FemMeshPayload, LivePreviewField, RuntimeEngineId,
    };

    #[test]
    fn downscaled_preview_does_not_hide_full_latest_field() {
        let request: CurrentLiveSnapshotRequest = serde_json::from_value(
            serde_json::json!({ "session_id": "downscaled-preview-precedence" }),
        )
        .expect("minimal live snapshot request should deserialize");
        let mut snapshot = default_current_live_state(&request);
        snapshot.metadata = Some(serde_json::json!({
            "execution_plan": { "backend_plan": { "kind": "fdm" } }
        }));
        snapshot.latest_fields = serde_json::from_value(serde_json::json!({
            "H_demag": {
                "source_step": 12,
                "source_revision": 12,
                "layout": {
                    "grid_cells": [4, 1, 1],
                    "original_grid_cells": [4, 1, 1]
                },
                "values": [
                    [1.0, 0.0, 0.0],
                    [2.0, 0.0, 0.0],
                    [3.0, 0.0, 0.0],
                    [4.0, 0.0, 0.0]
                ]
            }
        }))
        .expect("full latest field should deserialize");
        snapshot.preview_cache.insert(LivePreviewField {
            config_revision: 13,
            source_step: 13,
            source_revision: 13,
            materialized_at_unix_ms: 1,
            materialization_wall_time_ns: 0,
            quantity: "H_demag".to_string(),
            unit: "A/m".to_string(),
            spatial_kind: "grid".to_string(),
            quantity_domain: "full_domain".to_string(),
            preview_grid: [2, 1, 1],
            original_grid: [4, 1, 1],
            vector_field_values: vec![1.0, 0.0, 0.0, 4.0, 0.0, 0.0],
            x_chosen_size: 2,
            y_chosen_size: 1,
            applied_x_chosen_size: 2,
            applied_y_chosen_size: 1,
            applied_layer_stride: 1,
            auto_downscaled: true,
            auto_downscale_message: Some("preview only".to_string()),
            active_mask: None,
        });
        if let Some(live_state) = snapshot.live_state.as_mut() {
            live_state.latest_step.grid = [4, 1, 1];
        }

        assert!(!preview_cache_is_fresher(&snapshot, "H_demag"));
    }

    #[test]
    fn parses_frequency_response_analysis_field_id() {
        assert_eq!(
            parse_analysis_frequency_response_field_id(
                "analysis:frequency-response:frequency-0007"
            ),
            Some(7)
        );
        assert_eq!(
            parse_analysis_frequency_response_field_id("analysis:eigen:sample-0000:mode-0001"),
            None
        );
    }

    #[test]
    fn parses_eigen_mode_analysis_field_id() {
        assert_eq!(
            parse_analysis_eigen_mode_field_id("analysis:eigen:sample-0007:mode-0011"),
            Some((7, 11))
        );
        assert_eq!(
            parse_analysis_eigen_mode_field_id("analysis:frequency-response:frequency-0001"),
            None
        );
    }

    #[test]
    fn decodes_complex_f64_pair_payload() {
        let mut bytes = Vec::new();
        bytes.extend_from_slice(&1.25f64.to_le_bytes());
        bytes.extend_from_slice(&(-0.5f64).to_le_bytes());

        let values = decode_complex_f64_pairs_little_endian(&bytes)
            .expect("complex f64 pair payload should decode");

        assert_eq!(values, vec![1.25, -0.5]);
    }

    #[test]
    fn airbox_field_scope_honors_explicit_part_scope_id() {
        let mesh = FemMeshPayload {
            mesh_name: "multi-airbox-test".to_string(),
            mesh_id: "multi-airbox-test:1".to_string(),
            nodes: vec![[0.0, 0.0, 0.0]; 8],
            cells: fullmag_ir::FemConnectivityIR::empty(),
            element_markers: Vec::new(),
            facets: fullmag_ir::FemFacetConnectivityIR::empty(),
            boundary_markers: Vec::new(),
            periodic_boundary_pairs: Vec::new(),
            periodic_node_pairs: Vec::new(),
            object_segments: Vec::new(),
            mesh_parts: vec![
                FemMeshPartPayload {
                    id: "body".to_string(),
                    label: "body".to_string(),
                    role: "magnetic_object".to_string(),
                    object_id: Some("body".to_string()),
                    geometry_id: Some("body".to_string()),
                    material_id: Some("mat-body".to_string()),
                    element_start: 0,
                    element_count: 0,
                    boundary_face_start: 0,
                    boundary_face_count: 0,
                    boundary_face_indices: Vec::new(),
                    node_start: 0,
                    node_count: 4,
                    node_indices: vec![0, 1, 2, 3],
                    facet_global_ordinals: Vec::new(),
                    bounds_min: None,
                    bounds_max: None,
                },
                FemMeshPartPayload {
                    id: "airbox-a".to_string(),
                    label: "airbox-a".to_string(),
                    role: "air".to_string(),
                    object_id: None,
                    geometry_id: None,
                    material_id: None,
                    element_start: 0,
                    element_count: 0,
                    boundary_face_start: 0,
                    boundary_face_count: 0,
                    boundary_face_indices: Vec::new(),
                    node_start: 4,
                    node_count: 2,
                    node_indices: vec![4, 5],
                    facet_global_ordinals: Vec::new(),
                    bounds_min: None,
                    bounds_max: None,
                },
                FemMeshPartPayload {
                    id: "airbox-b".to_string(),
                    label: "airbox-b".to_string(),
                    role: "air".to_string(),
                    object_id: None,
                    geometry_id: None,
                    material_id: None,
                    element_start: 0,
                    element_count: 0,
                    boundary_face_start: 0,
                    boundary_face_count: 0,
                    boundary_face_indices: Vec::new(),
                    node_start: 6,
                    node_count: 2,
                    node_indices: vec![6, 7],
                    facet_global_ordinals: Vec::new(),
                    bounds_min: None,
                    bounds_max: None,
                },
            ],
            domain_mesh_mode: Some("shared_domain".to_string()),
            domain_frame: None,
            generation_id: Some("multi-airbox-generation".to_string()),
            per_domain_quality: Default::default(),
            build_report: None,
        };
        let request: CurrentLiveSnapshotRequest =
            serde_json::from_value(serde_json::json!({ "session_id": "scope-test" }))
                .expect("minimal live snapshot request should deserialize");
        let mut snapshot = default_current_live_state(&request);
        snapshot.fem_mesh = Some(mesh);

        let scope = resolve_field_scope(
            &FieldVectorQuery {
                component: Some("full".to_string()),
                geometry_scope: None,
                max_samples: None,
                phase_rad: None,
                scope_id: Some("airbox-b".to_string()),
                owner_object_id: None,
                scope_kind: Some("airbox".to_string()),
                snapshot_id: None,
                stage_id: None,
                view: None,
            },
            &snapshot,
            None,
            8,
            "H_demag",
        )
        .expect("airbox scope should resolve")
        .expect("airbox scope should be scoped");

        assert_eq!(scope.domain, ResolvedFieldScopeDomain::Air);
        assert_eq!(scope.id.as_deref(), Some("airbox-b"));
        assert_eq!(scope.node_indices, vec![6, 7]);

        let magnetic_scope = resolve_field_scope(
            &FieldVectorQuery {
                component: Some("full".to_string()),
                geometry_scope: None,
                max_samples: None,
                phase_rad: None,
                scope_id: Some("body".to_string()),
                owner_object_id: None,
                scope_kind: Some("part".to_string()),
                snapshot_id: None,
                stage_id: None,
                view: None,
            },
            &snapshot,
            None,
            8,
            "H_demag",
        )
        .expect("magnetic part scope should resolve")
        .expect("magnetic part scope should be scoped");

        assert_eq!(magnetic_scope.domain, ResolvedFieldScopeDomain::Magnetic);
        assert_eq!(magnetic_scope.node_indices, vec![0, 1, 2, 3]);
        assert!(
            scope
                .node_indices
                .iter()
                .all(|index| !magnetic_scope.node_indices.contains(index)),
            "airbox and magnetic-part carrier masks must be disjoint"
        );
        assert_eq!(scope.value_indices, vec![6, 7]);
        assert_eq!(magnetic_scope.value_indices, vec![0, 1, 2, 3]);
    }

    #[test]
    fn compact_magnetic_field_scope_keeps_global_nodes_and_uses_compact_offsets() {
        let mesh = FemMeshPayload {
            mesh_name: "compact-scope-test".to_string(),
            mesh_id: "compact-scope-test:1".to_string(),
            nodes: vec![[0.0, 0.0, 0.0]; 5],
            cells: fullmag_ir::FemConnectivityIR::empty(),
            element_markers: Vec::new(),
            facets: fullmag_ir::FemFacetConnectivityIR::empty(),
            boundary_markers: Vec::new(),
            periodic_boundary_pairs: Vec::new(),
            periodic_node_pairs: Vec::new(),
            object_segments: Vec::new(),
            mesh_parts: vec![
                FemMeshPartPayload {
                    id: "body-a".to_string(),
                    label: "body-a".to_string(),
                    role: "magnetic_object".to_string(),
                    object_id: Some("body-a".to_string()),
                    geometry_id: Some("body-a".to_string()),
                    material_id: None,
                    element_start: 0,
                    element_count: 0,
                    boundary_face_start: 0,
                    boundary_face_count: 0,
                    boundary_face_indices: Vec::new(),
                    node_start: 0,
                    node_count: 1,
                    node_indices: vec![1],
                    facet_global_ordinals: Vec::new(),
                    bounds_min: None,
                    bounds_max: None,
                },
                FemMeshPartPayload {
                    id: "body-b".to_string(),
                    label: "body-b".to_string(),
                    role: "magnetic_object".to_string(),
                    object_id: Some("body-b".to_string()),
                    geometry_id: Some("body-b".to_string()),
                    material_id: None,
                    element_start: 0,
                    element_count: 0,
                    boundary_face_start: 0,
                    boundary_face_count: 0,
                    boundary_face_indices: Vec::new(),
                    node_start: 0,
                    node_count: 1,
                    node_indices: vec![3],
                    facet_global_ordinals: Vec::new(),
                    bounds_min: None,
                    bounds_max: None,
                },
            ],
            domain_mesh_mode: Some("shared_domain".to_string()),
            domain_frame: None,
            generation_id: Some("compact-scope-generation".to_string()),
            per_domain_quality: Default::default(),
            build_report: None,
        };
        let request: CurrentLiveSnapshotRequest = serde_json::from_value(serde_json::json!({
            "session_id": "compact-scope-test"
        }))
        .expect("minimal live snapshot request should deserialize");
        let mut snapshot = default_current_live_state(&request);
        snapshot.fem_mesh = Some(mesh);

        let scope = resolve_field_scope(
            &FieldVectorQuery {
                component: Some("full".to_string()),
                geometry_scope: None,
                max_samples: None,
                phase_rad: None,
                scope_id: Some("body-b".to_string()),
                owner_object_id: None,
                scope_kind: Some("part".to_string()),
                snapshot_id: None,
                stage_id: None,
                view: None,
            },
            &snapshot,
            None,
            2,
            "m",
        )
        .expect("compact magnetic scope should resolve")
        .expect("part scope should be scoped");

        assert_eq!(scope.node_indices, vec![3]);
        assert_eq!(scope.value_indices, vec![1]);
        assert_eq!(
            apply_field_scope(
                vec![1.0, 0.0, 0.0, 0.0, 1.0, 0.0],
                [2, 1, 1],
                3,
                Some(&scope),
            ),
            vec![0.0, 1.0, 0.0],
        );
    }

    #[test]
    fn rejects_incomplete_complex_f64_pair_payload() {
        let bytes = 1.25f64.to_le_bytes();

        let error = decode_complex_f64_pairs_little_endian(&bytes)
            .expect_err("single f64 is not a complete complex pair");

        assert!(error.message.contains("complex pairs"), "{}", error.message);
    }

    #[test]
    fn frequency_response_view_amplitude_returns_scalar_values_for_single_component_payload() {
        let (values, n_comp, default_component) =
            analysis_frequency_response_view_values(&[3.0, 4.0], Some("amplitude"), None)
                .expect("amplitude view should resolve");

        assert_eq!(values, vec![5.0]);
        assert_eq!(n_comp, 1);
        assert_eq!(default_component, Some("full"));
    }

    #[test]
    fn frequency_response_view_abs_alias_returns_scalar_values_for_single_component_payload() {
        let (values, n_comp, default_component) =
            analysis_frequency_response_view_values(&[3.0, 4.0], Some("abs"), None)
                .expect("abs view should resolve");

        assert_eq!(values, vec![5.0]);
        assert_eq!(n_comp, 1);
        assert_eq!(default_component, Some("full"));
    }

    #[test]
    fn frequency_response_view_real_returns_scalar_values_for_single_component_payload() {
        let (values, n_comp, default_component) =
            analysis_frequency_response_view_values(&[3.0, 4.0, -2.0, 7.0], Some("real"), None)
                .expect("real view should resolve");

        assert_eq!(values, vec![3.0, -2.0]);
        assert_eq!(n_comp, 1);
        assert_eq!(default_component, Some("full"));
    }

    #[test]
    fn frequency_response_view_imag_returns_scalar_values_for_single_component_payload() {
        let (values, n_comp, default_component) =
            analysis_frequency_response_view_values(&[3.0, 4.0, -2.0, 7.0], Some("imag"), None)
                .expect("imag view should resolve");

        assert_eq!(values, vec![4.0, 7.0]);
        assert_eq!(n_comp, 1);
        assert_eq!(default_component, Some("full"));
    }

    #[test]
    fn frequency_response_view_phase_returns_scalar_values_for_single_component_payload() {
        let (values, n_comp, default_component) =
            analysis_frequency_response_view_values(&[1.0, 0.0, 0.0, 1.0], Some("phase"), None)
                .expect("phase view should resolve");

        assert!((values[0]).abs() < 1.0e-12);
        assert!((values[1] - std::f64::consts::FRAC_PI_2).abs() < 1.0e-12);
        assert_eq!(n_comp, 1);
        assert_eq!(default_component, Some("full"));
    }

    #[test]
    fn frequency_response_view_real_returns_xyz_values_for_vector_payload() {
        let (values, n_comp, default_component) = analysis_frequency_response_view_values(
            &[1.0, 2.0, 3.0, 4.0, -5.0, 6.0],
            Some("real"),
            None,
        )
        .expect("real vector response view should resolve");

        assert_eq!(values, vec![1.0, 3.0, -5.0]);
        assert_eq!(n_comp, 3);
        assert_eq!(default_component, Some("full"));
    }

    #[test]
    fn frequency_response_view_imag_returns_xyz_values_for_vector_payload() {
        let (values, n_comp, default_component) = analysis_frequency_response_view_values(
            &[1.0, 2.0, 3.0, 4.0, -5.0, 6.0],
            Some("imag"),
            None,
        )
        .expect("imag vector response view should resolve");

        assert_eq!(values, vec![2.0, 4.0, 6.0]);
        assert_eq!(n_comp, 3);
        assert_eq!(default_component, Some("full"));
    }

    #[test]
    fn frequency_response_view_phase_returns_xyz_values_for_vector_payload() {
        let (values, n_comp, default_component) = analysis_frequency_response_view_values(
            &[1.0, 0.0, 0.0, 1.0, -1.0, 0.0],
            Some("phase"),
            None,
        )
        .expect("phase vector response view should resolve");

        assert!((values[0]).abs() < 1.0e-12);
        assert!((values[1] - std::f64::consts::FRAC_PI_2).abs() < 1.0e-12);
        assert!((values[2] - std::f64::consts::PI).abs() < 1.0e-12);
        assert_eq!(n_comp, 3);
        assert_eq!(default_component, Some("full"));
    }

    #[test]
    fn frequency_response_view_phase_rotated_real_returns_xyz_values_for_vector_payload() {
        let (values, n_comp, default_component) = analysis_frequency_response_view_values(
            &[1.0, 0.0, 0.0, 1.0, 3.0, 4.0],
            Some("phase_rotated_real"),
            Some(0.0),
        )
        .expect("vector response view should resolve");

        assert_eq!(values, vec![1.0, 0.0, 3.0]);
        assert_eq!(n_comp, 3);
        assert_eq!(default_component, Some("full"));
    }

    #[test]
    fn frequency_response_view_phase_rotated_real_applies_phase() {
        let (values, n_comp, _) = analysis_frequency_response_view_values(
            &[1.0, 0.0],
            Some("phase_rotated_real"),
            Some(std::f64::consts::FRAC_PI_2),
        )
        .expect("phase rotated view should resolve");

        assert!((values[0]).abs() < 1.0e-12);
        assert_eq!(n_comp, 1);
    }

    #[test]
    fn production_cpu_frequency_response_runtime_is_fem_runtime() {
        let mut snapshot = default_current_live_state(&CurrentLiveSnapshotRequest {
            session_id: "frequency-response-production-cpu".to_string(),
            coupled_checkpoint: None,
            session: None,
            session_status: None,
            metadata: None,
            mesh_workspace: None,
            stage_execution: None,
            simulation_preparation: None,
            run: None,
            live_state: None,
            latest_scalar_row: None,
            latest_fields: None,
            preview_fields: None,
            clear_preview_cache: false,
            engine_log: None,
            solver_profile: None,
            fem_mesh: None,
        });
        snapshot.capabilities = Some(BackendCapabilities {
            engine_id: RuntimeEngineId::FemFrequencyResponseProductionCpu,
            capability_profile_version: "test".to_string(),
            supported_terms: Vec::new(),
            term_scopes: std::collections::BTreeMap::new(),
            feature_capabilities: std::collections::BTreeMap::new(),
            supported_demag_realizations: Vec::new(),
            preview_quantities: Vec::new(),
            snapshot_quantities: Vec::new(),
            scalar_outputs: Vec::new(),
            approximate_operators: Vec::new(),
            supports_frequency_response: false,
            supports_coupled_magnetoelastic_quasistatic: false,
            supports_coupled_magnetoelastic_elastodynamic: false,
            supports_frequency_domain_elastodynamics: false,
            supports_coupled_eigenmodes: false,
            supports_lossy_fallback_override: false,
        });

        assert!(is_fem_runtime(&snapshot));
    }

    #[test]
    fn eigen_mode_view_phase_rotated_real_returns_xyz_values() {
        let (values, n_comp, default_component) = analysis_complex_vector_view_values(
            &[1.0, 0.0, 0.0, 1.0, 3.0, 4.0],
            Some("phase_rotated_real"),
            Some(std::f64::consts::FRAC_PI_2),
        )
        .expect("phase rotated vector view should resolve");

        assert!((values[0]).abs() < 1.0e-12);
        assert!((values[1] + 1.0).abs() < 1.0e-12);
        assert_eq!(values[2], -4.0);
        assert_eq!(n_comp, 3);
        assert_eq!(default_component, Some("full"));
    }

    #[test]
    fn eigen_mode_view_abs_alias_returns_xyz_amplitudes() {
        let (values, n_comp, default_component) = analysis_complex_vector_view_values(
            &[3.0, 4.0, 5.0, 12.0, 8.0, 15.0],
            Some("abs"),
            None,
        )
        .expect("abs vector view should resolve");

        assert_eq!(values, vec![5.0, 13.0, 17.0]);
        assert_eq!(n_comp, 3);
        assert_eq!(default_component, Some("full"));
    }

    #[test]
    fn analysis_field_vector_binary_uses_fmvp_v3_explicit_nodes_for_scoped_fem_payload() {
        let mut snapshot = default_current_live_state(&CurrentLiveSnapshotRequest {
            session_id: "analysis-field-fem-scope".to_string(),
            coupled_checkpoint: None,
            session: None,
            session_status: None,
            metadata: None,
            mesh_workspace: None,
            stage_execution: None,
            simulation_preparation: None,
            run: None,
            live_state: None,
            latest_scalar_row: None,
            latest_fields: None,
            preview_fields: None,
            clear_preview_cache: false,
            engine_log: None,
            solver_profile: None,
            fem_mesh: None,
        });
        snapshot.fem_mesh = Some(FemMeshPayload {
            facets: fullmag_ir::FemFacetConnectivityIR::empty(),
            boundary_markers: Vec::new(),
            domain_frame: None,
            domain_mesh_mode: None,
            element_markers: vec![1],
            cells: fullmag_ir::FemConnectivityIR::from_tet4(vec![[1, 2, 3, 4]]),
            generation_id: None,
            mesh_id: "mesh:analysis-field-fem-scope".to_string(),
            mesh_name: "analysis-field-fem-scope".to_string(),
            mesh_parts: vec![FemMeshPartPayload {
                boundary_face_count: 0,
                boundary_face_indices: Vec::new(),
                boundary_face_start: 0,
                bounds_max: None,
                bounds_min: None,
                element_count: 1,
                element_start: 0,
                geometry_id: Some("film_geom".to_string()),
                id: "part:film".to_string(),
                label: "Film".to_string(),
                material_id: None,
                node_count: 2,
                node_indices: vec![1, 3],
                node_start: 0,
                object_id: Some("film".to_string()),
                role: "magnetic_object".to_string(),
                facet_global_ordinals: Vec::new(),
            }],
            nodes: vec![
                [0.0, 0.0, 0.0],
                [1.0, 0.0, 0.0],
                [0.0, 1.0, 0.0],
                [0.0, 0.0, 1.0],
                [1.0, 1.0, 1.0],
            ],
            object_segments: Vec::new(),
            per_domain_quality: std::collections::HashMap::new(),
            periodic_boundary_pairs: Vec::new(),
            periodic_node_pairs: Vec::new(),
            build_report: None,
        });
        let values = vec![1.0, 0.0, 0.0, 0.0, 1.0, 0.0];

        let binary = serialize_analysis_field_vector_binary(
            &snapshot,
            "analysis:frequency-response:frequency-0000",
            3,
            [2, 1, 1],
            &values,
            None,
        )
        .expect("analysis FEM field should serialize");

        assert_eq!(&binary[0..4], b"FMVP");
        assert_eq!(binary[4], 3);
        assert_eq!(binary[6], 3);
        assert_eq!(u32::from_le_bytes(binary[12..16].try_into().unwrap()), 6);
        assert_eq!(u32::from_le_bytes(binary[16..20].try_into().unwrap()), 2);
        let metadata_len = u32::from_le_bytes(binary[8..12].try_into().unwrap()) as usize;
        assert!(metadata_len >= 68);
        let metadata_start = 48;
        assert_eq!(&binary[metadata_start..metadata_start + 4], b"FMMI");
        assert_eq!(
            u32::from_le_bytes(
                binary[metadata_start + 56..metadata_start + 60]
                    .try_into()
                    .unwrap()
            ),
            1
        );
        assert_eq!(
            u32::from_le_bytes(
                binary[metadata_start + 60..metadata_start + 64]
                    .try_into()
                    .unwrap()
            ),
            2
        );
        let scope_kind_len = u16::from_le_bytes(
            binary[metadata_start + 64..metadata_start + 66]
                .try_into()
                .unwrap(),
        ) as usize;
        let scope_id_len = u16::from_le_bytes(
            binary[metadata_start + 66..metadata_start + 68]
                .try_into()
                .unwrap(),
        ) as usize;
        let generation_id_len = u16::from_le_bytes(
            binary[metadata_start + 8..metadata_start + 10]
                .try_into()
                .unwrap(),
        ) as usize;
        let node_indices_start =
            metadata_start + 68 + scope_kind_len + scope_id_len + generation_id_len;
        assert_eq!(
            u32::from_le_bytes(
                binary[node_indices_start..node_indices_start + 4]
                    .try_into()
                    .unwrap()
            ),
            1
        );
        assert_eq!(
            u32::from_le_bytes(
                binary[node_indices_start + 4..node_indices_start + 8]
                    .try_into()
                    .unwrap()
            ),
            3
        );
    }

    #[test]
    fn frequency_response_real_view_can_project_xyz_components() {
        let (values, n_comp, default_component) = analysis_frequency_response_view_values(
            &[
                1.0, 10.0, 2.0, 20.0, 3.0, 30.0, 4.0, 40.0, 5.0, 50.0, 6.0, 60.0,
            ],
            Some("real"),
            None,
        )
        .expect("real vector response view should resolve");
        let component = parse_component(Some("y"), n_comp).expect("y component is valid");
        let (out_n_comp, projected) =
            project_values(&values, n_comp, &component).expect("y projection should resolve");

        assert_eq!(values, vec![1.0, 2.0, 3.0, 4.0, 5.0, 6.0]);
        assert_eq!(n_comp, 3);
        assert_eq!(default_component, Some("full"));
        assert_eq!(out_n_comp, 1);
        assert_eq!(projected, vec![2.0, 5.0]);
    }

    #[test]
    fn rejects_unknown_frequency_response_view() {
        let error = analysis_frequency_response_view_values(&[1.0, 0.0], Some("bad"), None)
            .expect_err("unknown view should fail");

        assert!(
            error
                .message
                .contains("unsupported frequency-domain field view"),
            "{}",
            error.message
        );
    }
}
