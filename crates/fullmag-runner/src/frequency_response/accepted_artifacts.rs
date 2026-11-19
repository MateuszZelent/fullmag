//! Bounded collection and immutable publication for accepted FEM driven response.

use crate::artifact_generation::{GenerationCommit, PublicationOwner};
use crate::eigen::FrequencyDomainArtifactIdentity;
use crate::types::RunError;
use crate::frequency_response::{frequency_response_input_descriptor, FrequencyResponseInputDescriptor};
use fullmag_ir::FemFrequencyResponsePlanIR;
use serde::de::{DeserializeOwned, MapAccess, SeqAccess, Visitor};
use serde::{Deserialize, Serialize};
use serde_json::{Deserializer, Value};
use sha2::{Digest, Sha256};
use std::collections::{BTreeMap, BTreeSet, HashSet};
use std::fs::{self, File};
use std::io::{self, BufReader, Read, Write};
use std::path::{Component, Path, PathBuf};
use std::fmt;

pub const ACCEPTED_FREQUENCY_RESPONSE_DEFAULT_INDEX_LIMIT_BYTES: u64 = 1 << 20;
pub const ACCEPTED_FREQUENCY_RESPONSE_DEFAULT_BUNDLE_LIMIT_BYTES: u64 = 256 << 20;
const MAX_NATIVE_MANIFEST_BYTES: u64 = 16 << 20;
const MAX_NATIVE_SMALL_JSON_BYTES: u64 = 16 << 20;
const MAX_NATIVE_FIELD_METADATA_BYTES: u64 = 64 << 10;
const JSON_OBJECT_SLOP_BYTES: u64 = 16 << 10;
const NATIVE_SWEEP_FIXED_OVERHEAD_BYTES: u64 = 64 << 10;
const MAX_NATIVE_OBSERVABLE_PROVENANCE_BYTES: u64 = 2 << 10;
const MAX_COMPACT_POINT_METADATA_BYTES: u64 = 64 << 10;
const MAX_COMPACT_SWEEP_POINT_BYTES: u64 = 4 << 10;
const PLACEHOLDER_SHA256: &str = "sha256:0000000000000000000000000000000000000000000000000000000000000000";

/// Resource ceilings supplied by admission before the native solve starts.
#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub struct AcceptedFrequencyResponseArtifactLimits {
    pub max_index_bytes: u64,
    pub max_point_bundle_bytes: u64,
    pub max_global_bundle_bytes: u64,
    pub max_total_output_bytes: u64,
    pub max_peak_working_bytes: u64,
    pub max_native_source_bytes: u64,
    pub max_native_dense_json_bytes: u64,
    pub require_cartesian_xyz: bool,
}

impl Default for AcceptedFrequencyResponseArtifactLimits {
    fn default() -> Self {
        Self {
            max_index_bytes: ACCEPTED_FREQUENCY_RESPONSE_DEFAULT_INDEX_LIMIT_BYTES,
            max_point_bundle_bytes: ACCEPTED_FREQUENCY_RESPONSE_DEFAULT_BUNDLE_LIMIT_BYTES,
            max_global_bundle_bytes: ACCEPTED_FREQUENCY_RESPONSE_DEFAULT_BUNDLE_LIMIT_BYTES,
            max_total_output_bytes: 16 << 30,
            max_peak_working_bytes: 32 << 30,
            max_native_source_bytes: 16 << 30,
            max_native_dense_json_bytes: 16 << 30,
            require_cartesian_xyz: true,
        }
    }
}

/// Stable bundle role consumed by the application codec registry.
#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub enum AcceptedFrequencyResponseArtifactRole {
    NativeMetadata,
    FieldMetadata,
    FieldValues,
    InputAsset,
    Table,
    Diagnostics,
}

impl AcceptedFrequencyResponseArtifactRole {
    pub const fn bundle_role(self) -> &'static str {
        match self {
            Self::NativeMetadata => "native_metadata",
            Self::FieldMetadata => "field_metadata",
            Self::FieldValues => "field_values",
            Self::InputAsset => "input_asset",
            Self::Table => "table",
            Self::Diagnostics => "diagnostics",
        }
    }
}

#[derive(Debug, PartialEq, Eq)]
pub struct ArtifactFileBytes {
    pub relative_path: String,
    pub role: AcceptedFrequencyResponseArtifactRole,
    pub bytes: Vec<u8>,
}

#[derive(Debug, PartialEq)]
pub struct AcceptedFrequencyResponsePoint {
    pub frequency_index: u64,
    pub frequency_hz: f64,
    /// Derived from native ready/complete status, exact point count, and the
    /// recorded native relative residual tolerance; the native writer emits no
    /// per-point boolean field.
    pub converged: bool,
    pub relative_residual_l2_norm: f64,
    pub solver_relative_tolerance: f64,
    pub files: Vec<ArtifactFileBytes>,
}

#[derive(Debug, Clone, Copy, Default, PartialEq, Eq)]
pub struct AcceptedFrequencyResponseResourceEstimate {
    pub native_output_bytes_upper_bound: u64,
    pub native_dense_json_peak_bytes_upper_bound: u64,
    pub publisher_output_bytes_upper_bound: u64,
    pub publisher_peak_working_bytes_upper_bound: u64,
    pub peak_working_bytes_upper_bound: u64,
    pub scratch_bytes_upper_bound: u64,
}

#[derive(Debug)]
pub struct AcceptedFrequencyResponseArtifacts {
    pub global_files: Vec<ArtifactFileBytes>,
    /// Ordered by native frequency index.
    pub points: Vec<AcceptedFrequencyResponsePoint>,
    pub artifact_generation: GenerationCommit,
    pub published_generation_root: PathBuf,
    pub resource_estimate: AcceptedFrequencyResponseResourceEstimate,
}

/// Estimate the full native-writer and collection working sets before Solve.
pub fn preflight_frequency_response_artifact_resources(
    plan: &FemFrequencyResponsePlanIR,
    limits: AcceptedFrequencyResponseArtifactLimits,
) -> Result<AcceptedFrequencyResponseResourceEstimate, RunError> {
    validate_limits(limits)?;
    validate_plan_contract(plan, limits)?;
    let descriptor = frequency_response_input_descriptor(plan)?;
    let frequency_count = u64::try_from(plan.frequencies_hz.values_hz.len())
        .map_err(|_| invalid("frequency count exceeds u64"))?;
    let full_nodes = descriptor.full_node_count;
    let native_nodes = descriptor.native_node_count;

    let mesh_bytes = serialized_len(&plan.mesh)?;
    let plan_bytes = serialized_len(plan)?;
    let source_mesh = planned_source_mesh_identity(plan)?;
    let descriptor_bytes = serialized_len(&InputDescriptorEnvelope {
        schema_version: "fullmag.fem.driven_response_input.v1",
        descriptor: &descriptor,
        equilibrium_verified: false,
        plan_sha256: PLACEHOLDER_SHA256,
        mesh_sha256: PLACEHOLDER_SHA256,
        equilibrium_magnetization_path: "input/equilibrium_magnetization.f64le",
        magnetic_node_indices_path: "input/magnetic_node_indices.u64le",
        source_mesh_identity: &source_mesh,
    })?;
    let m0_bytes = checked_mul(full_nodes, 3 * 8, "provided M0 byte length")?;
    let map_bytes = checked_mul(native_nodes, 8, "magnetic node map byte length")?;

    // Native JSON writes each point's 2N complex components plus amplitude and
    // phase arrays, then duplicates the dense points array into v1/v2 sweeps
    // and per-point JSON. Eight simultaneous dense-text copies conservatively
    // cover std::string growth and append_format's temporary formatting buffer.
    let dense_per_point = native_dense_point_json_upper_bound(native_nodes)?;
    let native_dense_json_bytes = checked_add(
        checked_mul(
            checked_mul(dense_per_point, frequency_count, "dense response sweep bound")?,
            3,
            "dense response sweep copies",
        )?,
        128 << 10,
        "dense response sweep metadata",
    )?;
    let native_dense_json_peak_bytes = checked_add(
        checked_mul(
            checked_mul(dense_per_point, frequency_count, "dense response peak bound")?,
            8,
            "dense response simultaneous copies",
        )?,
        1 << 20,
        "dense response writer overhead",
    )?;

    let values_per_node_per_point = if limits.require_cartesian_xyz { 160 } else { 64 };
    let native_field_bytes = checked_mul(
        checked_mul(native_nodes, frequency_count, "native response field count")?,
        values_per_node_per_point,
        "native response field bytes",
    )?;
    if native_dense_json_bytes > limits.max_native_dense_json_bytes {
        return Err(invalid("native dense JSON aggregate exceeds the admitted limit"));
    }
    let native_output_bytes = checked_add(
        checked_add(native_dense_json_bytes, native_field_bytes, "native artifact output")?,
        checked_add(
            checked_mul(frequency_count, 64 << 10, "native point metadata")?,
            1 << 20,
            "native metadata overhead",
        )?,
        "native artifact output",
    )?;

    let global_output_bytes = checked_add(
        checked_add(plan_bytes, mesh_bytes, "frozen input mesh and plan")?,
        checked_add(
            checked_add(m0_bytes, map_bytes, "frozen input state and map")?,
            checked_add(descriptor_bytes, 1 << 20, "input metadata and shared Zarr metadata")?,
            "frozen input closure",
        )?,
        "global artifact closure",
    )?;
    let per_point_output_bytes = checked_add(
        checked_mul(native_nodes, values_per_node_per_point, "published point field bytes")?,
        64 << 10,
        "published point metadata and Zarr metadata",
    )?;
    if global_output_bytes
        > limits.max_global_bundle_bytes.min(ACCEPTED_FREQUENCY_RESPONSE_DEFAULT_BUNDLE_LIMIT_BYTES)
    {
        return Err(invalid("estimated global artifact bundle exceeds its aggregate limit"));
    }
    if per_point_output_bytes
        > limits.max_point_bundle_bytes.min(ACCEPTED_FREQUENCY_RESPONSE_DEFAULT_BUNDLE_LIMIT_BYTES)
    {
        return Err(invalid("estimated point bundle exceeds its aggregate limit"));
    }
    let index_upper_bound = checked_add(
        checked_mul(frequency_count, 4096, "compact sweep index estimate")?,
        16 << 10,
        "compact sweep index estimate",
    )?;
    if index_upper_bound
        > limits.max_index_bytes.min(ACCEPTED_FREQUENCY_RESPONSE_DEFAULT_INDEX_LIMIT_BYTES)
    {
        return Err(invalid("estimated compact sweep index exceeds the 1 MiB index bound"));
    }
    let publisher_output_bytes = checked_add(
        global_output_bytes,
        checked_mul(per_point_output_bytes, frequency_count, "published frequency points")?,
        "published output closure",
    )?;
    let scratch_bytes = checked_add(
        checked_add(
            checked_add(
                checked_mul(full_nodes, 3 * 8, "M0 serialization scratch")?,
                checked_mul(native_nodes, 8, "map serialization scratch")?,
                "input serialization scratch",
            )?,
            mesh_bytes,
            "mesh serialization scratch",
        )?,
        checked_add(
            checked_mul(native_nodes, 128, "native per-point payload scratch")?,
            checked_mul(native_nodes, frequency_count, "native response value count")?
                .checked_mul(32)
                .ok_or_else(|| invalid("native response scratch size overflow"))?,
            "native response scratch",
        )?,
        "artifact scratch",
    )?;
    // The return value, immutable publisher payloads and downstream codec/CAS
    // copies may coexist; reserve four closure copies plus bounded scratch.
    let publisher_peak = checked_add(
        checked_mul(publisher_output_bytes, 4, "publisher and codec copies")?,
        checked_add(
            dense_per_point,
            scratch_bytes,
            "publisher temporary source and scratch",
        )?,
        "publisher peak working set",
    )?;
    let peak_working_bytes = native_dense_json_peak_bytes.max(publisher_peak);

    let estimate = AcceptedFrequencyResponseResourceEstimate {
        native_output_bytes_upper_bound: native_output_bytes,
        native_dense_json_peak_bytes_upper_bound: native_dense_json_peak_bytes,
        publisher_output_bytes_upper_bound: publisher_output_bytes,
        publisher_peak_working_bytes_upper_bound: publisher_peak,
        peak_working_bytes_upper_bound: peak_working_bytes,
        scratch_bytes_upper_bound: scratch_bytes,
    };
    validate_estimate(estimate, limits)?;
    Ok(estimate)
}

/// Collect only writer-referenced native files and publish their exact bytes as
/// a V2 immutable generation under the attempt's `published/` child directory.
pub fn collect_publish_accepted_frequency_response_artifacts(
    plan: &FemFrequencyResponsePlanIR,
    identity: &FrequencyDomainArtifactIdentity,
    native_root: &Path,
    published_root: &Path,
    limits: AcceptedFrequencyResponseArtifactLimits,
) -> Result<AcceptedFrequencyResponseArtifacts, RunError> {
    validate_limits(limits)?;
    validate_plan_contract(plan, limits)?;
    identity.validate().map_err(io_error)?;
    let resource_estimate = preflight_frequency_response_artifact_resources(plan, limits)?;
    let native_root = validate_native_root(native_root)?;
    if fs::canonicalize(published_root).ok().as_deref() == Some(native_root.as_path()) {
        return Err(invalid("published artifact root aliases the native output root"));
    }

    let manifest_path = "frequency_domain/manifest.v1.json";
    let mut source_budget = SourceBudget::new(limits);
    let manifest_bytes = source_budget.read(&native_root, manifest_path, MAX_NATIVE_MANIFEST_BYTES, false)?;
    let mut manifest = parse_unique_json(&manifest_bytes, "native manifest")?;
    validate_native_manifest(&manifest, identity, plan)?;

    let descriptor = frequency_response_input_descriptor(plan)?;
    let frequencies = &plan.frequencies_hz.values_hz;
    let frequency_count = u64::try_from(frequencies.len())
        .map_err(|_| invalid("frequency count exceeds u64"))?;
    let artifacts = object_field(&manifest, "artifacts", "native manifest")?;
    let sweep_v1_path = required_string(artifacts, "response_sweep_v1_path", "native manifest artifacts")?;
    let sweep_v2_path = required_string(artifacts, "response_sweep_v2_path", "native manifest artifacts")?;
    let progress_path = required_string(artifacts, "response_progress_v1_path", "native manifest artifacts")?;
    let diagnostic_paths = native_diagnostic_paths(artifacts)?;
    let point_paths = parse_string_array(artifacts, "frequency_point_paths", "native manifest artifacts")?;
    validate_expected_paths(&point_paths, "response/frequency_points/frequency_", ".json", frequency_count)?;
    if sweep_v1_path != "response/magnetic_response_sweep.v1.json"
        || sweep_v2_path != "response/magnetic_response_sweep.v2.json"
        || progress_path != "response/progress.v1.json"
    {
        return Err(invalid("native artifact path is not a known frequency-response writer path"));
    }
    let write_response_fields = manifest
        .get("requested_execution")
        .and_then(|value| value.get("write_response_fields"))
        .and_then(Value::as_bool)
        .unwrap_or(false);
    let spatial_response_fields = validate_point_resource_list(
        &manifest,
        &point_paths,
        write_response_fields,
        limits.require_cartesian_xyz,
    )?;
    if limits.require_cartesian_xyz && !write_response_fields {
        return Err(invalid("Cartesian XYZ response fields were requested but native fields are absent"));
    }

    let mut source_paths = BTreeSet::new();
    source_paths.insert(manifest_path.to_string());
    source_paths.insert(sweep_v1_path.to_string());
    source_paths.insert(sweep_v2_path.to_string());
    source_paths.insert(progress_path.to_string());
    source_paths.extend(diagnostic_paths.iter().cloned());
    source_paths.extend(point_paths.iter().cloned());
    if write_response_fields {
        source_paths.insert("response/field_payloads.zarr/.zgroup".to_string());
        source_paths.insert("response/field_payloads.zarr/.zattrs".to_string());
        for index in 0..frequency_count {
            let prefix = format!("response/field_payloads.zarr/frequency_{index:04}");
            source_paths.insert(format!("{prefix}/.zgroup"));
            for name in if spatial_response_fields == Some(true) {
                vec!["vector_tangent_complex", "vector_xyz_complex"]
            } else {
                vec!["vector_tangent_complex"]
            } {
                source_paths.insert(format!("{prefix}/{name}/.zarray"));
                source_paths.insert(format!("{prefix}/{name}/.zattrs"));
            }
            source_paths.insert(format!("{prefix}/vector_tangent_complex/0.0.0"));
            source_paths.insert(format!("response/field_payloads/frequency_{index:04}/vector.bin"));
            if spatial_response_fields == Some(true) {
                source_paths.insert(format!("{prefix}/vector_xyz_complex/0.0.0"));
                source_paths.insert(format!("response/field_payloads/frequency_{index:04}/vector_xyz.bin"));
            }
        }
    }
    if let Some(periodic_path) = artifacts.get("periodic_pairs_v1_path").and_then(Value::as_str) {
        if periodic_path != "mesh/periodic_pairs.v1.json" {
            return Err(invalid("native periodic-pairs path is not a known writer path"));
        }
        source_paths.insert(periodic_path.to_string());
    }
    validate_path_set(source_paths.iter().map(String::as_str))?;

    // Inventory every explicit input before reading the sweep. This catches
    // aggregate and dense-JSON overflow before a large source file is loaded.
    source_budget.inventory(&native_root, &source_paths, &point_paths, &diagnostic_paths, sweep_v1_path, sweep_v2_path)?;
    validate_native_dense_source_bounds(
        &source_budget,
        &point_paths,
        sweep_v1_path,
        sweep_v2_path,
        descriptor.native_node_count,
        frequency_count,
    )?;
    let (sweep_v1, sweep_v1_sha256) = parse_hashed_json::<NativeSweepV1>(
        &native_root.join(sweep_v1_path),
        source_budget.file_len(sweep_v1_path)?,
        "native v1 sweep",
    )?;
    let (sweep_v2, sweep_v2_sha256) = parse_hashed_json::<NativeSweepV2>(
        &native_root.join(sweep_v2_path),
        source_budget.file_len(sweep_v2_path)?,
        "native v2 sweep",
    )?;
    validate_sweeps(&sweep_v1, &sweep_v2, &point_paths, frequencies)?;

    let solver_relative_tolerance = manifest
        .get("diagnostics")
        .and_then(|value| value.get("solver_relative_tolerance"))
        .and_then(Value::as_f64)
        .ok_or_else(|| invalid("native solver diagnostics omit solver_relative_tolerance"))?;
    if !solver_relative_tolerance.is_finite() || solver_relative_tolerance <= 0.0 {
        return Err(invalid("native solver relative tolerance is not finite and positive"));
    }
    let m0_bytes = encode_m0_le(&plan.equilibrium_magnetization, descriptor.full_node_count)?;
    let map_bytes = encode_indices_le(&descriptor.magnetic_node_indices)?;
    let mesh_bytes = serde_json::to_vec(&plan.mesh).map_err(json_error)?;
    let plan_bytes = serde_json::to_vec(plan).map_err(json_error)?;
    let plan_sha256 = sha256(&plan_bytes);
    let mesh_sha256 = sha256(&mesh_bytes);
    if sha256(&m0_bytes) != format!("sha256:{}", descriptor.equilibrium_sha256)
        || sha256(&map_bytes) != format!("sha256:{}", descriptor.magnetic_node_indices_sha256)
    {
        return Err(invalid("provided input hashes differ from the exact native compaction descriptor"));
    }

    let mut global_files = Vec::new();
    let mut points = Vec::with_capacity(frequencies.len());
    let mut output_paths = Vec::new();
    let mut output_total = 0_u64;
    let mut global_total = 0_u64;

    push_output(
        &mut global_files,
        &mut output_paths,
        &mut global_total,
        &mut output_total,
        limits,
        "input/plan.v1.json",
        AcceptedFrequencyResponseArtifactRole::InputAsset,
        plan_bytes,
        false,
    )?;
    push_output(
        &mut global_files,
        &mut output_paths,
        &mut global_total,
        &mut output_total,
        limits,
        "input/mesh.v1.json",
        AcceptedFrequencyResponseArtifactRole::InputAsset,
        mesh_bytes,
        false,
    )?;
    push_output(
        &mut global_files,
        &mut output_paths,
        &mut global_total,
        &mut output_total,
        limits,
        "input/equilibrium_magnetization.f64le",
        AcceptedFrequencyResponseArtifactRole::InputAsset,
        m0_bytes,
        false,
    )?;
    push_output(
        &mut global_files,
        &mut output_paths,
        &mut global_total,
        &mut output_total,
        limits,
        "input/magnetic_node_indices.u64le",
        AcceptedFrequencyResponseArtifactRole::InputAsset,
        map_bytes,
        false,
    )?;
    let source_mesh = published_source_mesh_identity(plan)?;
    let input_descriptor_bytes = serde_json::to_vec(&InputDescriptorEnvelope {
        schema_version: "fullmag.fem.driven_response_input.v1",
        descriptor: &descriptor,
        equilibrium_verified: false,
        plan_sha256: &plan_sha256,
        mesh_sha256: &mesh_sha256,
        equilibrium_magnetization_path: "input/equilibrium_magnetization.f64le",
        magnetic_node_indices_path: "input/magnetic_node_indices.u64le",
        source_mesh_identity: &source_mesh,
    })
    .map_err(json_error)?;
    push_output(
        &mut global_files,
        &mut output_paths,
        &mut global_total,
        &mut output_total,
        limits,
        "input/descriptor.v1.json",
        AcceptedFrequencyResponseArtifactRole::InputAsset,
        input_descriptor_bytes,
        false,
    )?;

    for (relative, role) in [
        ("response/field_payloads.zarr/.zgroup", AcceptedFrequencyResponseArtifactRole::FieldMetadata),
        ("response/field_payloads.zarr/.zattrs", AcceptedFrequencyResponseArtifactRole::FieldMetadata),
    ] {
        if write_response_fields {
            let bytes = source_budget.read(&native_root, relative, MAX_NATIVE_FIELD_METADATA_BYTES, false)?;
            validate_zarr_group_or_store(relative, &bytes)?;
            push_output(&mut global_files, &mut output_paths, &mut global_total, &mut output_total, limits, relative, role, bytes, false)?;
        }
    }
    for relative in &diagnostic_paths {
        let bytes = source_budget.read(&native_root, relative, MAX_NATIVE_SMALL_JSON_BYTES, false)?;
        validate_strict_json(&bytes, "native diagnostics")?;
        let role = if relative.contains("diagnostic") {
            AcceptedFrequencyResponseArtifactRole::Diagnostics
        } else {
            AcceptedFrequencyResponseArtifactRole::Diagnostics
        };
        push_output(&mut global_files, &mut output_paths, &mut global_total, &mut output_total, limits, relative, role, bytes, false)?;
    }
    let progress_bytes = source_budget.read(&native_root, progress_path, MAX_NATIVE_SMALL_JSON_BYTES, false)?;
    validate_progress(&progress_bytes, frequency_count)?;
    push_output(&mut global_files, &mut output_paths, &mut global_total, &mut output_total, limits, progress_path, AcceptedFrequencyResponseArtifactRole::Diagnostics, progress_bytes, false)?;
    if let Some(periodic_path) = artifacts.get("periodic_pairs_v1_path").and_then(Value::as_str) {
        let bytes = source_budget.read(&native_root, periodic_path, MAX_NATIVE_SMALL_JSON_BYTES, false)?;
        validate_strict_json(&bytes, "native periodic pairs")?;
        push_output(&mut global_files, &mut output_paths, &mut global_total, &mut output_total, limits, periodic_path, AcceptedFrequencyResponseArtifactRole::NativeMetadata, bytes, false)?;
    }

    let mut compact_points = Vec::with_capacity(frequencies.len());
    let mut point_bundle_totals = Vec::with_capacity(frequencies.len());
    for index in 0..frequencies.len() {
        let frequency_index = u64::try_from(index).map_err(|_| invalid("frequency index exceeds u64"))?;
        let point_path = &point_paths[index];
        let point_metadata_bound = native_dense_point_json_upper_bound(descriptor.native_node_count)?;
        let point_bytes = source_budget.read(&native_root, point_path, point_metadata_bound, true)?;
        let source_point_sha256 = sha256(&point_bytes);
        validate_strict_json(&point_bytes, "native point metadata")?;
        let native_point: NativePoint = serde_json::from_slice(&point_bytes).map_err(json_error)?;
        let expected_frequency = frequencies[index];
        if native_point.schema_version.as_deref() != Some("frequency_response_point.v1")
            || native_point
                .frequency_point_artifact_path
                .as_deref()
                .is_some_and(|path| path != point_path.as_str())
            || native_point.frequency_index != frequency_index
            || !native_point.frequency_hz.is_finite()
            || native_point.frequency_hz.to_bits() != expected_frequency.to_bits()
        {
            return Err(invalid(format!("native point frequency order mismatch at index {index}")));
        }
        let residual = native_point.relative_residual_l2_norm;
        if sweep_v1.points[index].relative_residual_l2_norm.to_bits() != residual.to_bits()
            || sweep_v2.points[index].relative_residual_l2_norm.to_bits() != residual.to_bits()
        {
            return Err(invalid(format!("native sweep residual metadata differs from point {index}")));
        }
        if !residual.is_finite() || residual < 0.0 || residual > solver_relative_tolerance {
            return Err(invalid(format!("native point relative residual gate failed at index {index}")));
        }
        validate_native_observables(&native_point, index)?;
        if sweep_v1.points[index].susceptibility_tensor != native_point.susceptibility_tensor
            || sweep_v2.points[index].susceptibility_tensor != native_point.susceptibility_tensor
            || sweep_v1.points[index].susceptibility_tensor_provenance.as_ref()
                != native_point.susceptibility_tensor_provenance.as_ref()
            || sweep_v2.points[index].susceptibility_tensor_provenance.as_ref()
                != native_point.susceptibility_tensor_provenance.as_ref()
            || sweep_v1.points[index].absorbed_power_density != native_point.absorbed_power_density
            || sweep_v2.points[index].absorbed_power_density != native_point.absorbed_power_density
            || sweep_v1.points[index].absorbed_power_density_provenance.as_ref()
                != native_point.absorbed_power_density_provenance.as_ref()
            || sweep_v2.points[index].absorbed_power_density_provenance.as_ref()
                != native_point.absorbed_power_density_provenance.as_ref()
        {
            return Err(invalid(format!("native sweep observable metadata differs from point {index}")));
        }
        let field_spec = validate_point_field_spec(
            &native_point,
            index,
            descriptor.native_node_count,
            write_response_fields,
            spatial_response_fields.unwrap_or(false),
            limits.require_cartesian_xyz,
        )?;
        let point_metadata_path = point_path.clone();
        let compact_metadata = CompactPointMetadata {
            schema_version: "fullmag.fem.driven_response_point.v1",
            frequency_index,
            frequency_hz: expected_frequency,
            response_amplitude: native_point.response_amplitude,
            response_phase: native_point.response_phase,
            residual_l2_norm: native_point.residual_l2_norm,
            susceptibility_tensor: native_point.susceptibility_tensor,
            susceptibility_tensor_provenance: native_point.susceptibility_tensor_provenance.as_ref(),
            absorbed_power_density: native_point.absorbed_power_density,
            absorbed_power_density_provenance: native_point.absorbed_power_density_provenance.as_ref(),
            relative_residual_l2_norm: residual,
            solver_relative_tolerance,
            converged: true,
            convergence_evidence: "native_complete_and_relative_residual_gate",
            source_point_sha256: &source_point_sha256,
            point_path: &point_metadata_path,
            frequency_point_artifact_path: &point_metadata_path,
            field_payload_path: field_spec.as_ref().map(|field| field.compact.field_payload_path.as_str()),
            component_count: field_spec.as_ref().map(|field| field.compact.component_count),
            complex_pair_count: field_spec.as_ref().map(|field| field.compact.complex_pair_count),
            payload_value_count: field_spec.as_ref().map(|field| field.compact.payload_value_count),
            available_views: field_spec.as_ref().map(|field| &field.compact.available_views),
            default_view: field_spec.as_ref().map(|field| field.compact.default_view),
            default_phase_rad: field_spec.as_ref().map(|field| field.compact.default_phase_rad),
            zarr_array_path: field_spec.as_ref().map(|field| field.compact.zarr_array_path.as_str()),
            zarr_chunk_path: field_spec.as_ref().map(|field| field.compact.zarr_chunk_path.as_str()),
            zarr_metadata_paths: field_spec.as_ref().map(|field| field.compact.zarr_metadata_paths.as_slice()),
            full_node_count: descriptor.full_node_count,
            native_node_count: descriptor.native_node_count,
            topology_fingerprint: &descriptor.topology_fingerprint,
            source_mesh_generation_id: &source_mesh.mesh_generation_id,
            equilibrium_sha256: &descriptor.equilibrium_sha256,
            magnetic_node_indices_sha256: &descriptor.magnetic_node_indices_sha256,
            source_mesh_topology_fingerprint: &source_mesh.topology_fingerprint,
            field: field_spec.as_ref().map(|field| &field.compact),
        };
        let compact_point_bytes = serde_json::to_vec(&compact_metadata).map_err(json_error)?;
        if compact_point_bytes.len() as u64 > MAX_COMPACT_POINT_METADATA_BYTES {
            return Err(invalid(format!("compact point metadata {index} exceeds its bounded size")));
        }
        let mut point_files = Vec::new();
        let mut point_total = 0_u64;
        push_output(
            &mut point_files,
            &mut output_paths,
            &mut point_total,
            &mut output_total,
            limits,
            point_path,
            AcceptedFrequencyResponseArtifactRole::FieldMetadata,
            compact_point_bytes,
            true,
        )?;
        if let Some(field) = &field_spec {
            for relative in &field.metadata_paths {
                let bytes = source_budget.read(&native_root, relative, MAX_NATIVE_FIELD_METADATA_BYTES, false)?;
                validate_zarr_metadata(relative, &bytes, field)?;
                push_output(&mut point_files, &mut output_paths, &mut point_total, &mut output_total, limits, relative, AcceptedFrequencyResponseArtifactRole::FieldMetadata, bytes, true)?;
            }
            for (relative, expected_size) in &field.payload_paths {
                let bytes = source_budget.read_exact(&native_root, relative, *expected_size, false)?;
                push_output(&mut point_files, &mut output_paths, &mut point_total, &mut output_total, limits, relative, AcceptedFrequencyResponseArtifactRole::FieldValues, bytes, true)?;
            }
        }
        if point_total > limits.max_point_bundle_bytes.min(ACCEPTED_FREQUENCY_RESPONSE_DEFAULT_BUNDLE_LIMIT_BYTES) {
            return Err(invalid(format!("point bundle {index} exceeds the aggregate point-bundle limit")));
        }
        point_bundle_totals.push(point_total);
        points.push(AcceptedFrequencyResponsePoint {
            frequency_index,
            frequency_hz: expected_frequency,
            converged: true,
            relative_residual_l2_norm: residual,
            solver_relative_tolerance,
            files: point_files,
        });
        let compact_sweep_point = CompactSweepPoint {
            frequency_index,
            frequency_hz: expected_frequency,
            response_amplitude: native_point.response_amplitude,
            response_phase: native_point.response_phase,
            susceptibility_tensor: native_point.susceptibility_tensor,
            susceptibility_tensor_provenance: native_point.susceptibility_tensor_provenance.clone(),
            absorbed_power_density: native_point.absorbed_power_density,
            absorbed_power_density_provenance: native_point.absorbed_power_density_provenance.clone(),
            relative_residual_l2_norm: residual,
            solver_relative_tolerance,
            converged: true,
            convergence_evidence: "native_complete_and_relative_residual_gate",
            point_path,
            frequency_point_artifact_path: point_path,
            field_payload_path: field_spec.as_ref().map(|field| field.compact.field_payload_path.clone()),
            field: field_spec.as_ref().map(|field| field.compact.clone()),
            full_node_count: descriptor.full_node_count,
            native_node_count: descriptor.native_node_count,
            topology_fingerprint: &descriptor.topology_fingerprint,
            source_mesh_generation_id: &source_mesh.mesh_generation_id,
            equilibrium_sha256: &descriptor.equilibrium_sha256,
            magnetic_node_indices_sha256: &descriptor.magnetic_node_indices_sha256,
            source_mesh_topology_fingerprint: &source_mesh.topology_fingerprint,
            source_point_sha256: source_point_sha256.clone(),
        };
        if serialized_len(&compact_sweep_point)? > MAX_COMPACT_SWEEP_POINT_BYTES {
            return Err(invalid(format!("compact sweep point {index} exceeds its 4 KiB estimate")));
        }
        compact_points.push(compact_sweep_point);
    }

    let source_provenance = NativeSweepProvenance {
        v1_sha256: &sweep_v1_sha256,
        v2_sha256: &sweep_v2_sha256,
    };
    let compact_sweep = CompactSweep {
        schema_version: "magnetic_response_sweep.v3",
        solve_kind: "direct_harmonic_response",
        complete: true,
        point_count: frequency_count,
        response_input_descriptor_path: "input/descriptor.v1.json",
        source_native_sweeps: source_provenance,
        points: &compact_points,
    };
    let compact_sweep_bytes = serde_json::to_vec(&compact_sweep).map_err(json_error)?;
    if compact_sweep_bytes.len() as u64 > limits.max_index_bytes.min(ACCEPTED_FREQUENCY_RESPONSE_DEFAULT_INDEX_LIMIT_BYTES) {
        return Err(invalid("compact frequency-response index exceeds the 1 MiB index bound"));
    }
    let compact_sweep_path = "response/magnetic_response_sweep.v3.json";
    push_output(
        &mut global_files,
        &mut output_paths,
        &mut global_total,
        &mut output_total,
        limits,
        compact_sweep_path,
        AcceptedFrequencyResponseArtifactRole::Table,
        compact_sweep_bytes,
        false,
    )?;
    compact_manifest(&mut manifest, &sweep_v1_sha256, &sweep_v2_sha256, &descriptor)?;
    let compact_manifest_bytes = serde_json::to_vec(&manifest).map_err(json_error)?;
    if compact_manifest_bytes.len() as u64 > MAX_NATIVE_MANIFEST_BYTES {
        return Err(invalid("compact frequency-response manifest exceeds its bounded size"));
    }
    push_output(
        &mut global_files,
        &mut output_paths,
        &mut global_total,
        &mut output_total,
        limits,
        manifest_path,
        AcceptedFrequencyResponseArtifactRole::NativeMetadata,
        compact_manifest_bytes,
        false,
    )?;
    if global_total > limits.max_global_bundle_bytes.min(ACCEPTED_FREQUENCY_RESPONSE_DEFAULT_BUNDLE_LIMIT_BYTES) {
        return Err(invalid("global artifact bundle exceeds its aggregate size limit"));
    }
    if output_total > limits.max_total_output_bytes {
        return Err(invalid("artifact aggregate output exceeds the admitted limit"));
    }

    let member_bytes = global_files
        .iter()
        .chain(points.iter().flat_map(|point| point.files.iter()))
        .map(|file| (file.relative_path.clone(), file.bytes.clone()))
        .collect::<Vec<_>>();
    let producer = PublicationOwner {
        run_id: identity.run_id.clone(),
        stage_id: identity.stage_id.clone(),
        stage_kind: "frequency_response".to_string(),
    };
    let artifact_generation = crate::artifact_generation::publish_immutable(
        published_root,
        Some(producer),
        member_bytes,
    )
    .map_err(io_error)?;
    let generation_name = artifact_generation
        .generation_id
        .strip_prefix("sha256:")
        .ok_or_else(|| invalid("immutable generation ID is not a SHA-256 digest"))?;
    let published_generation_root = published_root
        .join("frequency_domain/generations")
        .join(generation_name);
    let _ = point_bundle_totals;
    Ok(AcceptedFrequencyResponseArtifacts {
        global_files,
        points,
        artifact_generation,
        published_generation_root,
        resource_estimate,
    })
}

fn invalid(message: impl Into<String>) -> RunError {
    RunError { message: message.into() }
}

fn io_error(error: io::Error) -> RunError {
    invalid(format!("frequency-response artifact I/O failed: {error}"))
}

fn json_error(error: impl fmt::Display) -> RunError {
    invalid(format!("frequency-response artifact JSON is invalid: {error}"))
}

fn validate_limits(limits: AcceptedFrequencyResponseArtifactLimits) -> Result<(), RunError> {
    if limits.max_index_bytes == 0
        || limits.max_point_bundle_bytes == 0
        || limits.max_global_bundle_bytes == 0
        || limits.max_total_output_bytes == 0
        || limits.max_peak_working_bytes == 0
        || limits.max_native_source_bytes == 0
        || limits.max_native_dense_json_bytes == 0
    {
        return Err(invalid("frequency-response artifact limits must be positive"));
    }
    Ok(())
}

fn validate_plan_contract(
    plan: &FemFrequencyResponsePlanIR,
    limits: AcceptedFrequencyResponseArtifactLimits,
) -> Result<(), RunError> {
    if plan.fe_order != 1 {
        return Err(invalid("accepted frequency-response artifacts require first-order FEM"));
    }
    if plan.precision != fullmag_ir::ExecutionPrecision::Double {
        return Err(invalid("accepted frequency-response artifacts require double precision"));
    }
    if plan.spin_wave_bc.kind() != fullmag_ir::SpinWaveBoundaryKindIR::Free
        || plan.magnetostatic_bc != fullmag_ir::MagnetostaticBoundaryConditionIR::Open
    {
        return Err(invalid("accepted frequency-response artifact collector supports free/Gamma boundary conditions only"));
    }
    if !matches!(plan.equilibrium, fullmag_ir::EquilibriumSourceIR::Provided) {
        return Err(invalid("accepted frequency-response artifact collector requires a provided equilibrium"));
    }
    if plan.frequencies_hz.values_hz.is_empty()
        || plan.frequencies_hz.values_hz.iter().any(|frequency| !frequency.is_finite() || *frequency <= 0.0)
    {
        return Err(invalid("accepted frequency-response plan has an empty or invalid frequency list"));
    }
    if limits.require_cartesian_xyz && plan.mesh.nodes.is_empty() {
        return Err(invalid("Cartesian response fields require a nonempty full FEM mesh"));
    }
    Ok(())
}

fn checked_add(left: u64, right: u64, label: &str) -> Result<u64, RunError> {
    left.checked_add(right)
        .ok_or_else(|| invalid(format!("{label} aggregate size overflow")))
}

fn checked_mul(left: u64, right: u64, label: &str) -> Result<u64, RunError> {
    left.checked_mul(right)
        .ok_or_else(|| invalid(format!("{label} aggregate size overflow")))
}

fn native_dense_point_json_upper_bound(native_nodes: u64) -> Result<u64, RunError> {
    checked_add(
        checked_mul(native_nodes, 204, "dense response JSON point bound")?,
        JSON_OBJECT_SLOP_BYTES,
        "dense response JSON point bound",
    )
}

fn validate_native_dense_source_bounds(
    source_budget: &SourceBudget,
    point_paths: &[String],
    sweep_v1_path: &str,
    sweep_v2_path: &str,
    native_nodes: u64,
    frequency_count: u64,
) -> Result<(), RunError> {
    let dense_point_bound = native_dense_point_json_upper_bound(native_nodes)?;
    for path in point_paths {
        if source_budget.file_len(path)? > dense_point_bound {
            return Err(invalid(format!("native point metadata `{path}` exceeds its estimated dense JSON bound")));
        }
    }
    let dense_sweep_bound = checked_add(
        checked_mul(dense_point_bound, frequency_count, "native dense sweep JSON bound")?,
        NATIVE_SWEEP_FIXED_OVERHEAD_BYTES,
        "native dense sweep JSON bound",
    )?;
    for path in [sweep_v1_path, sweep_v2_path] {
        if source_budget.file_len(path)? > dense_sweep_bound {
            return Err(invalid(format!("native sweep `{path}` exceeds its estimated dense JSON bound")));
        }
    }
    let dense_source_bound = checked_add(
        checked_mul(dense_point_bound, checked_mul(frequency_count, 3, "native dense point and sweep count")?, "native dense source points")?,
        2 * NATIVE_SWEEP_FIXED_OVERHEAD_BYTES,
        "native dense source bound",
    )?;
    if source_budget.dense_json_bytes > dense_source_bound {
        return Err(invalid("native dense JSON source exceeds its preflight estimate"));
    }
    Ok(())
}

struct CountingWriter {
    bytes: u64,
}

impl Write for CountingWriter {
    fn write(&mut self, buffer: &[u8]) -> io::Result<usize> {
        self.bytes = self
            .bytes
            .checked_add(buffer.len() as u64)
            .ok_or_else(|| io::Error::new(io::ErrorKind::InvalidData, "serialized length overflow"))?;
        Ok(buffer.len())
    }

    fn flush(&mut self) -> io::Result<()> {
        Ok(())
    }
}

fn serialized_len(value: &impl Serialize) -> Result<u64, RunError> {
    let mut writer = CountingWriter { bytes: 0 };
    serde_json::to_writer(&mut writer, value).map_err(json_error)?;
    Ok(writer.bytes)
}

fn validate_estimate(
    estimate: AcceptedFrequencyResponseResourceEstimate,
    limits: AcceptedFrequencyResponseArtifactLimits,
) -> Result<(), RunError> {
    if estimate.native_output_bytes_upper_bound > limits.max_native_source_bytes {
        return Err(invalid("native source aggregate exceeds the admitted byte limit"));
    }
    if estimate.publisher_output_bytes_upper_bound > limits.max_total_output_bytes {
        return Err(invalid("artifact aggregate output exceeds the admitted limit"));
    }
    if estimate.peak_working_bytes_upper_bound > limits.max_peak_working_bytes {
        return Err(invalid("estimated artifact working set exceeds the admitted memory limit"));
    }
    Ok(())
}

#[derive(Serialize)]
struct InputDescriptorEnvelope<'a> {
    schema_version: &'static str,
    descriptor: &'a FrequencyResponseInputDescriptor,
    equilibrium_verified: bool,
    plan_sha256: &'a str,
    mesh_sha256: &'a str,
    equilibrium_magnetization_path: &'static str,
    magnetic_node_indices_path: &'static str,
    source_mesh_identity: &'a SourceMeshIdentity,
}

#[derive(Serialize)]
struct SourceMeshIdentity {
    mesh_generation_id: String,
    topology_fingerprint: String,
    node_count: u64,
    indexing: &'static str,
}

fn planned_source_mesh_identity(plan: &FemFrequencyResponsePlanIR) -> Result<SourceMeshIdentity, RunError> {
    let topology_fingerprint = plan
        .mesh
        .mixed_topology_fingerprint_v3()
        .map_err(|reason| invalid(format!("source mesh topology fingerprint failed: {reason}")))?;
    Ok(SourceMeshIdentity {
        mesh_generation_id: crate::types::fem_frequency_response_mesh_generation_id(plan),
        topology_fingerprint,
        node_count: u64::try_from(plan.mesh.nodes.len())
            .map_err(|_| invalid("source mesh node count exceeds u64"))?,
        indexing: "full_domain_node_order",
    })
}

fn published_source_mesh_identity(plan: &FemFrequencyResponsePlanIR) -> Result<SourceMeshIdentity, RunError> {
    let asset = crate::types::StageFemMeshAsset::build_from_fem_frequency_response_plan(plan);
    let topology_fingerprint = crate::types::fem_mesh_topology_fingerprint(&asset.payload);
    let planned = planned_source_mesh_identity(plan)?;
    Ok(SourceMeshIdentity {
        mesh_generation_id: asset.identity.generation_id().to_string(),
        topology_fingerprint,
        node_count: u64::try_from(asset.payload.nodes.len())
            .map_err(|_| invalid("published source mesh node count exceeds u64"))?,
        indexing: "full_domain_node_order",
    })
}

#[derive(Debug)]
struct StrictIgnoredAny;

impl<'de> Deserialize<'de> for StrictIgnoredAny {
    fn deserialize<D>(deserializer: D) -> Result<Self, D::Error>
    where
        D: serde::Deserializer<'de>,
    {
        struct IgnoreVisitor;
        impl<'de> Visitor<'de> for IgnoreVisitor {
            type Value = StrictIgnoredAny;

            fn expecting(&self, formatter: &mut fmt::Formatter<'_>) -> fmt::Result {
                formatter.write_str("any JSON value without duplicate object keys")
            }

            fn visit_bool<E>(self, _value: bool) -> Result<Self::Value, E> {
                Ok(StrictIgnoredAny)
            }

            fn visit_i64<E>(self, _value: i64) -> Result<Self::Value, E> {
                Ok(StrictIgnoredAny)
            }

            fn visit_u64<E>(self, _value: u64) -> Result<Self::Value, E> {
                Ok(StrictIgnoredAny)
            }

            fn visit_f64<E>(self, _value: f64) -> Result<Self::Value, E> {
                Ok(StrictIgnoredAny)
            }

            fn visit_str<E>(self, _value: &str) -> Result<Self::Value, E> {
                Ok(StrictIgnoredAny)
            }

            fn visit_string<E>(self, _value: String) -> Result<Self::Value, E> {
                Ok(StrictIgnoredAny)
            }

            fn visit_unit<E>(self) -> Result<Self::Value, E> {
                Ok(StrictIgnoredAny)
            }

            fn visit_none<E>(self) -> Result<Self::Value, E> {
                Ok(StrictIgnoredAny)
            }

            fn visit_seq<A>(self, mut sequence: A) -> Result<Self::Value, A::Error>
            where
                A: SeqAccess<'de>,
            {
                while sequence.next_element::<StrictIgnoredAny>()?.is_some() {}
                Ok(StrictIgnoredAny)
            }

            fn visit_map<A>(self, mut map: A) -> Result<Self::Value, A::Error>
            where
                A: MapAccess<'de>,
            {
                let mut seen = HashSet::new();
                while let Some(key) = map.next_key::<String>()? {
                    if !seen.insert(key.clone()) {
                        return Err(serde::de::Error::custom(format!("duplicate JSON key `{key}`")));
                    }
                    map.next_value::<StrictIgnoredAny>()?;
                }
                Ok(StrictIgnoredAny)
            }
        }
        deserializer.deserialize_any(IgnoreVisitor)
    }
}

struct UniqueJson(Value);

impl<'de> Deserialize<'de> for UniqueJson {
    fn deserialize<D>(deserializer: D) -> Result<Self, D::Error>
    where
        D: serde::Deserializer<'de>,
    {
        struct ValueVisitor;
        impl<'de> Visitor<'de> for ValueVisitor {
            type Value = UniqueJson;

            fn expecting(&self, formatter: &mut fmt::Formatter<'_>) -> fmt::Result {
                formatter.write_str("JSON with unique object keys")
            }

            fn visit_bool<E>(self, value: bool) -> Result<Self::Value, E> {
                Ok(UniqueJson(Value::Bool(value)))
            }

            fn visit_i64<E>(self, value: i64) -> Result<Self::Value, E> {
                Ok(UniqueJson(Value::Number(value.into())))
            }

            fn visit_u64<E>(self, value: u64) -> Result<Self::Value, E> {
                Ok(UniqueJson(Value::Number(value.into())))
            }

            fn visit_f64<E>(self, value: f64) -> Result<Self::Value, E>
            where
                E: serde::de::Error,
            {
                let number = serde_json::Number::from_f64(value)
                    .ok_or_else(|| E::custom("non-finite JSON number"))?;
                Ok(UniqueJson(Value::Number(number)))
            }

            fn visit_str<E>(self, value: &str) -> Result<Self::Value, E> {
                Ok(UniqueJson(Value::String(value.to_string())))
            }

            fn visit_string<E>(self, value: String) -> Result<Self::Value, E> {
                Ok(UniqueJson(Value::String(value)))
            }

            fn visit_unit<E>(self) -> Result<Self::Value, E> {
                Ok(UniqueJson(Value::Null))
            }

            fn visit_none<E>(self) -> Result<Self::Value, E> {
                Ok(UniqueJson(Value::Null))
            }

            fn visit_seq<A>(self, mut sequence: A) -> Result<Self::Value, A::Error>
            where
                A: SeqAccess<'de>,
            {
                let mut values = Vec::new();
                while let Some(value) = sequence.next_element::<UniqueJson>()? {
                    values.push(value.0);
                }
                Ok(UniqueJson(Value::Array(values)))
            }

            fn visit_map<A>(self, mut map: A) -> Result<Self::Value, A::Error>
            where
                A: MapAccess<'de>,
            {
                let mut values = serde_json::Map::new();
                let mut seen = HashSet::new();
                while let Some(key) = map.next_key::<String>()? {
                    if !seen.insert(key.clone()) {
                        return Err(serde::de::Error::custom(format!("duplicate JSON key `{key}`")));
                    }
                    values.insert(key, map.next_value::<UniqueJson>()?.0);
                }
                Ok(UniqueJson(Value::Object(values)))
            }
        }
        deserializer.deserialize_any(ValueVisitor)
    }
}

fn parse_unique_json(bytes: &[u8], label: &str) -> Result<Value, RunError> {
    let mut deserializer = Deserializer::from_slice(bytes);
    let value = UniqueJson::deserialize(&mut deserializer)
        .map_err(|error| invalid(format!("{label} is invalid: {error}")))?;
    deserializer
        .end()
        .map_err(|error| invalid(format!("{label} has trailing JSON data: {error}")))?;
    Ok(value.0)
}

fn validate_strict_json(bytes: &[u8], label: &str) -> Result<(), RunError> {
    let mut deserializer = Deserializer::from_slice(bytes);
    StrictIgnoredAny::deserialize(&mut deserializer)
        .map_err(|error| invalid(format!("{label} is invalid: {error}")))?;
    deserializer
        .end()
        .map_err(|error| invalid(format!("{label} has trailing JSON data: {error}")))
}

#[derive(Debug, Deserialize)]
#[serde(deny_unknown_fields)]
struct NativeSweepV1 {
    schema_version: String,
    backend_engine_id: String,
    solver_model: String,
    damping_policy: String,
    lane_classification: String,
    matrix_layout: String,
    excitation_kind: String,
    si_units: StrictIgnoredAny,
    point_count: u64,
    points: Vec<NativePoint>,
}

#[derive(Debug, Deserialize)]
#[serde(deny_unknown_fields)]
struct NativeSweepV2 {
    schema_version: String,
    solve_kind: String,
    complete: bool,
    completed_frequency_point_count: u64,
    point_count: u64,
    frequency_point_artifact_path: String,
    response_field_payload_path: Option<String>,
    frequency_point_artifact_paths: Vec<String>,
    response_field_payload_paths: Vec<String>,
    points: Vec<NativePoint>,
}

#[derive(Debug, Deserialize)]
struct NativePoint {
    #[serde(default)]
    schema_version: Option<String>,
    frequency_index: u64,
    frequency_hz: f64,
    #[serde(default)]
    frequency_point_artifact_path: Option<String>,
    #[serde(default)]
    angular_frequency_rad_per_s: Option<f64>,
    #[serde(default)]
    response_amplitude: Option<f64>,
    #[serde(default)]
    response_phase: Option<f64>,
    #[serde(default)]
    residual_l2_norm: Option<f64>,
    relative_residual_l2_norm: f64,
    #[serde(default)]
    susceptibility_tensor: Option<[[f64; 2]; 1]>,
    #[serde(default)]
    susceptibility_tensor_provenance: Option<NativeSusceptibilityTensorProvenance>,
    #[serde(default)]
    absorbed_power_density: Option<f64>,
    #[serde(default)]
    absorbed_power_density_provenance: Option<NativeAbsorbedPowerDensityProvenance>,
    #[serde(default)]
    response_field_payload_path: Option<String>,
    #[serde(default)]
    response_tangent_field_payload_path: Option<String>,
    #[serde(default)]
    field_payload_path: Option<String>,
    #[serde(default)]
    tangent_field_payload_path: Option<String>,
    #[serde(default)]
    storage_format: Option<String>,
    #[serde(default)]
    zarr_store_path: Option<String>,
    #[serde(default)]
    zarr_array_path: Option<String>,
    #[serde(default)]
    zarr_chunk_path: Option<String>,
    #[serde(default)]
    zarr_dtype: Option<String>,
    #[serde(default)]
    zarr_shape: Option<Vec<u64>>,
    #[serde(default)]
    zarr_chunk_shape: Option<Vec<u64>>,
    #[serde(default)]
    compatibility_binary_payload_path: Option<String>,
    // Dense values are explicitly ignored while still walking the JSON tree.
    #[serde(default)]
    m_complex: Option<StrictIgnoredAny>,
    #[serde(default)]
    component_response_amplitude: Option<StrictIgnoredAny>,
    #[serde(default)]
    component_response_phase: Option<StrictIgnoredAny>,
}

#[derive(Debug, Clone, PartialEq, Serialize, Deserialize)]
#[serde(deny_unknown_fields)]
struct NativeSusceptibilityTensorProvenance {
    kind: String,
    basis: String,
    component_pair_count: u64,
    full_tensor: bool,
    response_quantity: String,
    response_units: String,
    dimensionless_si_susceptibility: bool,
    requires_ms_for_chi_si: bool,
    ms_factor_applied: bool,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    ms_source: Option<String>,
    normalization: String,
}

#[derive(Debug, Clone, PartialEq, Serialize, Deserialize)]
#[serde(deny_unknown_fields)]
struct NativeAbsorbedPowerDensityProvenance {
    kind: String,
    basis: String,
    physical_power_density: bool,
    units: String,
    requires_mu0_ms_factor: bool,
    mu0_ms_factor_applied: bool,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    ms_source: Option<String>,
    normalization: String,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    volume_weighted: Option<bool>,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    spatial_reduction: Option<String>,
    absolute_value_applied: bool,
    full_power_density: bool,
}

#[derive(Debug, Deserialize)]
struct FrequencyPointResource {
    frequency_index: u64,
    payload_path: String,
}

#[derive(Debug)]
struct FieldSpec {
    compact: CompactFieldReference,
    metadata_paths: Vec<String>,
    payload_paths: Vec<(String, u64)>,
}

#[derive(Debug, Clone, Serialize)]
struct CompactFieldReference {
    storage_format: &'static str,
    component_basis: &'static str,
    field_payload_path: String,
    payload_path: String,
    tangent_payload_path: String,
    compatibility_binary_payload_path: String,
    dtype: &'static str,
    shape: [u64; 3],
    node_indexing: &'static str,
    component_count: u64,
    complex_pair_count: u64,
    payload_value_count: u64,
    available_views: [&'static str; 7],
    default_view: &'static str,
    default_phase_rad: f64,
    zarr_array_path: String,
    zarr_chunk_path: String,
    zarr_metadata_paths: Vec<String>,
}

#[derive(Serialize)]
struct CompactPointMetadata<'a> {
    schema_version: &'static str,
    frequency_index: u64,
    frequency_hz: f64,
    #[serde(skip_serializing_if = "Option::is_none")]
    response_amplitude: Option<f64>,
    #[serde(skip_serializing_if = "Option::is_none")]
    response_phase: Option<f64>,
    #[serde(skip_serializing_if = "Option::is_none")]
    residual_l2_norm: Option<f64>,
    #[serde(skip_serializing_if = "Option::is_none")]
    susceptibility_tensor: Option<[[f64; 2]; 1]>,
    #[serde(skip_serializing_if = "Option::is_none")]
    susceptibility_tensor_provenance: Option<&'a NativeSusceptibilityTensorProvenance>,
    #[serde(skip_serializing_if = "Option::is_none")]
    absorbed_power_density: Option<f64>,
    #[serde(skip_serializing_if = "Option::is_none")]
    absorbed_power_density_provenance: Option<&'a NativeAbsorbedPowerDensityProvenance>,
    relative_residual_l2_norm: f64,
    solver_relative_tolerance: f64,
    converged: bool,
    convergence_evidence: &'static str,
    source_point_sha256: &'a str,
    point_path: &'a str,
    frequency_point_artifact_path: &'a str,
    #[serde(skip_serializing_if = "Option::is_none")]
    field_payload_path: Option<&'a str>,
    #[serde(skip_serializing_if = "Option::is_none")]
    component_count: Option<u64>,
    #[serde(skip_serializing_if = "Option::is_none")]
    complex_pair_count: Option<u64>,
    #[serde(skip_serializing_if = "Option::is_none")]
    payload_value_count: Option<u64>,
    #[serde(skip_serializing_if = "Option::is_none")]
    available_views: Option<&'a [&'static str; 7]>,
    #[serde(skip_serializing_if = "Option::is_none")]
    default_view: Option<&'static str>,
    #[serde(skip_serializing_if = "Option::is_none")]
    default_phase_rad: Option<f64>,
    #[serde(skip_serializing_if = "Option::is_none")]
    zarr_array_path: Option<&'a str>,
    #[serde(skip_serializing_if = "Option::is_none")]
    zarr_chunk_path: Option<&'a str>,
    #[serde(skip_serializing_if = "Option::is_none")]
    zarr_metadata_paths: Option<&'a [String]>,
    full_node_count: u64,
    native_node_count: u64,
    topology_fingerprint: &'a str,
    source_mesh_generation_id: &'a str,
    source_mesh_topology_fingerprint: &'a str,
    equilibrium_sha256: &'a str,
    magnetic_node_indices_sha256: &'a str,
    #[serde(skip_serializing_if = "Option::is_none")]
    field: Option<&'a CompactFieldReference>,
}

#[derive(Serialize)]
struct CompactSweepPoint<'a> {
    frequency_index: u64,
    frequency_hz: f64,
    #[serde(skip_serializing_if = "Option::is_none")]
    response_amplitude: Option<f64>,
    #[serde(skip_serializing_if = "Option::is_none")]
    response_phase: Option<f64>,
    #[serde(skip_serializing_if = "Option::is_none")]
    susceptibility_tensor: Option<[[f64; 2]; 1]>,
    #[serde(skip_serializing_if = "Option::is_none")]
    susceptibility_tensor_provenance: Option<NativeSusceptibilityTensorProvenance>,
    #[serde(skip_serializing_if = "Option::is_none")]
    absorbed_power_density: Option<f64>,
    #[serde(skip_serializing_if = "Option::is_none")]
    absorbed_power_density_provenance: Option<NativeAbsorbedPowerDensityProvenance>,
    relative_residual_l2_norm: f64,
    solver_relative_tolerance: f64,
    converged: bool,
    convergence_evidence: &'static str,
    point_path: &'a str,
    frequency_point_artifact_path: &'a str,
    #[serde(skip_serializing_if = "Option::is_none")]
    field_payload_path: Option<String>,
    #[serde(skip_serializing_if = "Option::is_none")]
    field: Option<CompactFieldReference>,
    full_node_count: u64,
    native_node_count: u64,
    topology_fingerprint: &'a str,
    source_mesh_generation_id: &'a str,
    source_mesh_topology_fingerprint: &'a str,
    equilibrium_sha256: &'a str,
    magnetic_node_indices_sha256: &'a str,
    source_point_sha256: String,
}

#[derive(Serialize)]
struct NativeSweepProvenance<'a> {
    v1_sha256: &'a str,
    v2_sha256: &'a str,
}

#[derive(Serialize)]
struct CompactSweep<'a> {
    schema_version: &'static str,
    solve_kind: &'static str,
    complete: bool,
    point_count: u64,
    response_input_descriptor_path: &'static str,
    source_native_sweeps: NativeSweepProvenance<'a>,
    points: &'a [CompactSweepPoint<'a>],
}

struct HashingReader<R> {
    reader: R,
    hasher: Sha256,
}

impl<R> HashingReader<R> {
    fn new(reader: R) -> Self {
        Self { reader, hasher: Sha256::new() }
    }

    fn finish(self) -> String {
        format!("sha256:{:x}", self.hasher.finalize())
    }
}

impl<R: Read> Read for HashingReader<R> {
    fn read(&mut self, buffer: &mut [u8]) -> io::Result<usize> {
        let count = self.reader.read(buffer)?;
        self.hasher.update(&buffer[..count]);
        Ok(count)
    }
}

fn parse_hashed_json<T: DeserializeOwned>(
    path: &Path,
    expected_length: u64,
    label: &str,
) -> Result<(T, String), RunError> {
    let metadata = fs::symlink_metadata(path).map_err(io_error)?;
    if metadata.file_type().is_symlink() || !metadata.is_file() || metadata.len() != expected_length {
        return Err(invalid(format!("{label} path is a link, non-file, or changed size")));
    }
    let file = File::open(path).map_err(io_error)?;
    let mut reader = HashingReader::new(BufReader::new(file));
    let mut deserializer = Deserializer::from_reader(&mut reader);
    let parsed = T::deserialize(&mut deserializer)
        .map_err(|error| invalid(format!("{label} is invalid: {error}")))?;
    deserializer
        .end()
        .map_err(|error| invalid(format!("{label} has trailing JSON data: {error}")))?;
    drop(deserializer);
    let digest = reader.finish();
    Ok((parsed, digest))
}

fn validate_sweeps(
    v1: &NativeSweepV1,
    v2: &NativeSweepV2,
    point_paths: &[String],
    frequencies: &[f64],
) -> Result<(), RunError> {
    let frequency_count = u64::try_from(frequencies.len())
        .map_err(|_| invalid("frequency count exceeds u64"))?;
    if v1.schema_version != "magnetic_response_sweep.v1"
        || v1.point_count != frequency_count
        || v1.backend_engine_id != "native_fem_mfem"
        || v1.excitation_kind != "uniform_field"
        || v1.solver_model.is_empty()
        || v1.damping_policy.is_empty()
        || v1.lane_classification.is_empty()
        || v1.matrix_layout.is_empty()
    {
        return Err(invalid("native v1 frequency sweep is incomplete or has an unsupported schema"));
    }
    let _ = &v1.si_units;
    if v2.schema_version != "magnetic_response_sweep.v2"
        || v2.solve_kind != "direct_harmonic_response"
        || !v2.complete
        || v2.completed_frequency_point_count != frequency_count
        || v2.point_count != frequency_count
        || v2.frequency_point_artifact_paths != point_paths
    {
        return Err(invalid("native v2 frequency sweep is partial or its ordered point paths mismatch"));
    }
    let first = point_paths.first().ok_or_else(|| invalid("native frequency sweep has no points"))?;
    if v2.frequency_point_artifact_path.as_str() != first.as_str() {
        return Err(invalid("native v2 primary point path differs from ordered point list"));
    }
    if v1.points.len() as u64 != frequency_count || v2.points.len() as u64 != frequency_count {
        return Err(invalid("native dense sweep point counts differ from the accepted frequency plan"));
    }
    for index in 0..frequencies.len() {
        let expected_frequency = frequencies[index];
        for (label, point) in [("v1", &v1.points[index]), ("v2", &v2.points[index])] {
            if point.frequency_index as usize != index
                || !point.frequency_hz.is_finite()
                || point.frequency_hz.to_bits() != expected_frequency.to_bits()
                || point.relative_residual_l2_norm < 0.0
                || !point.relative_residual_l2_norm.is_finite()
                || point.frequency_point_artifact_path.as_deref() != Some(point_paths[index].as_str())
            {
                return Err(invalid(format!("native {label} sweep frequency or point-path order mismatch at index {index}")));
            }
        }
        if v1.points[index].relative_residual_l2_norm.to_bits()
            != v2.points[index].relative_residual_l2_norm.to_bits()
        {
            return Err(invalid(format!("native v1/v2 residual metadata mismatch at index {index}")));
        }
    }
    let expected_payload_paths = v2
        .points
        .iter()
        .filter_map(|point| point.response_field_payload_path.clone())
        .collect::<Vec<_>>();
    if expected_payload_paths != v2.response_field_payload_paths {
        return Err(invalid("native v2 field payload paths differ from its ordered points"));
    }
    let first_payload = expected_payload_paths.first();
    if v2.response_field_payload_path.as_ref() != first_payload {
        return Err(invalid("native v2 primary field payload path differs from ordered payload list"));
    }
    Ok(())
}

fn validate_native_observables(point: &NativePoint, index: usize) -> Result<(), RunError> {
    if point.susceptibility_tensor.is_some()
        != point.susceptibility_tensor_provenance.is_some()
    {
        return Err(invalid(format!("native susceptibility value/provenance pair is incomplete at point {index}")));
    }
    if let Some(tensor) = point.susceptibility_tensor {
        if tensor[0].iter().any(|value| !value.is_finite()) {
            return Err(invalid(format!("native susceptibility pair is non-finite at point {index}")));
        }
    }
    if let Some(provenance) = &point.susceptibility_tensor_provenance {
        validate_susceptibility_tensor_provenance(provenance, index)?;
        if serialized_len(provenance)? > MAX_NATIVE_OBSERVABLE_PROVENANCE_BYTES {
            return Err(invalid(format!("native susceptibility provenance exceeds its bounded size at point {index}")));
        }
    }
    if point.absorbed_power_density.is_some()
        != point.absorbed_power_density_provenance.is_some()
    {
        return Err(invalid(format!("native absorption proxy value/provenance pair is incomplete at point {index}")));
    }
    if point.absorbed_power_density.is_some_and(|value| !value.is_finite()) {
        return Err(invalid(format!("native absorption proxy is non-finite at point {index}")));
    }
    if let Some(provenance) = &point.absorbed_power_density_provenance {
        validate_absorption_proxy_provenance(provenance, index)?;
        if serialized_len(provenance)? > MAX_NATIVE_OBSERVABLE_PROVENANCE_BYTES {
            return Err(invalid(format!("native absorption proxy provenance exceeds its bounded size at point {index}")));
        }
    }
    if let (Some(susceptibility), Some(absorption)) = (
        &point.susceptibility_tensor_provenance,
        &point.absorbed_power_density_provenance,
    ) {
        if (susceptibility.kind == "drive_projected_si_susceptibility")
            != absorption.mu0_ms_factor_applied
        {
            return Err(invalid(format!("native observable provenance disagrees about the Ms factor at point {index}")));
        }
    }
    Ok(())
}

fn validate_susceptibility_tensor_provenance(
    provenance: &NativeSusceptibilityTensorProvenance,
    index: usize,
) -> Result<(), RunError> {
    let has_ms = provenance.kind == "drive_projected_si_susceptibility";
    let valid_common = provenance.basis == "local_tangent_drive"
        && provenance.component_pair_count == 1
        && !provenance.full_tensor;
    let valid_ms = provenance.response_quantity == "delta_M_over_h_drive"
        && provenance.response_units == "dimensionless"
        && provenance.dimensionless_si_susceptibility
        && !provenance.requires_ms_for_chi_si
        && provenance.ms_factor_applied
        && matches!(provenance.ms_source.as_deref(), Some("per_node_field" | "uniform"))
        && provenance.normalization == "sum(Ms*response*conj(drive))/sum(abs(drive)^2)";
    let valid_scalar = provenance.kind == "drive_projected_scalar"
        && provenance.response_quantity == "delta_m_over_h_drive"
        && provenance.response_units == "m/A"
        && !provenance.dimensionless_si_susceptibility
        && provenance.requires_ms_for_chi_si
        && !provenance.ms_factor_applied
        && provenance.ms_source.is_none()
        && provenance.normalization == "sum(response*conj(drive))/sum(abs(drive)^2)";
    if !valid_common
        || (has_ms && !valid_ms)
        || (!has_ms && !valid_scalar)
    {
        return Err(invalid(format!("native susceptibility provenance is not the supported single projected pair at point {index}")));
    }
    Ok(())
}

fn validate_absorption_proxy_provenance(
    provenance: &NativeAbsorbedPowerDensityProvenance,
    index: usize,
) -> Result<(), RunError> {
    let with_ms = provenance.units == "drive_projected_proxy_not_W_per_m3";
    let valid_common = provenance.kind == "drive_projected_absorption_proxy"
        && provenance.basis == "local_tangent_drive"
        && !provenance.physical_power_density
        && !provenance.absolute_value_applied
        && !provenance.full_power_density;
    let valid_ms = provenance.requires_mu0_ms_factor == false
        && provenance.mu0_ms_factor_applied
        && matches!(provenance.ms_source.as_deref(), Some("per_node_field" | "uniform"))
        && provenance.normalization
            == "0.5*mu0*omega*imag(sum(Ms*response*conj(drive)))/tangent_dof_count"
        && provenance.volume_weighted == Some(false)
        && provenance.spatial_reduction.as_deref()
            == Some("drive_projected_tangent_dof_average");
    let valid_without_ms = provenance.units == "proxy_not_W_per_m3"
        && provenance.requires_mu0_ms_factor
        && !provenance.mu0_ms_factor_applied
        && provenance.ms_source.is_none()
        && provenance.normalization
            == "0.5*omega*imag(sum(response*conj(drive)))/tangent_dof_count"
        && provenance.volume_weighted.is_none()
        && provenance.spatial_reduction.is_none();
    if !valid_common
        || (with_ms && !valid_ms)
        || (!with_ms && !valid_without_ms)
    {
        return Err(invalid(format!("native absorption metadata is not a physical power density or has unsupported units at point {index}")));
    }
    Ok(())
}

fn validate_native_root(root: &Path) -> Result<PathBuf, RunError> {
    let metadata = fs::symlink_metadata(root).map_err(io_error)?;
    if metadata.file_type().is_symlink() || !metadata.is_dir() {
        return Err(invalid("native artifact root is a link or not a directory"));
    }
    fs::canonicalize(root).map_err(io_error)
}

fn validate_relative_path(relative: &str) -> Result<PathBuf, RunError> {
    if relative.is_empty()
        || !relative.is_ascii()
        || relative.contains('\\')
        || relative.starts_with('/')
        || relative.chars().any(char::is_control)
    {
        return Err(invalid("native artifact path is unsafe or non-canonical"));
    }
    let path = Path::new(relative);
    if path.components().any(|component| !matches!(component, Component::Normal(_))) {
        return Err(invalid("native artifact path contains traversal or a non-normal component"));
    }
    Ok(path.to_path_buf())
}

fn safe_native_file(root: &Path, relative: &str) -> Result<(PathBuf, fs::Metadata), RunError> {
    let relative_path = validate_relative_path(relative)?;
    let mut current = root.to_path_buf();
    let components = relative_path.components().collect::<Vec<_>>();
    for (index, component) in components.iter().enumerate() {
        let Component::Normal(part) = component else {
            return Err(invalid("native artifact path contains a non-normal component"));
        };
        current.push(part);
        let metadata = fs::symlink_metadata(&current).map_err(|error| {
            invalid(format!("native artifact path `{relative}` is missing or unsafe: {error}"))
        })?;
        if metadata.file_type().is_symlink() {
            return Err(invalid(format!("native artifact path `{relative}` traverses a link")));
        }
        let is_last = index + 1 == components.len();
        if is_last {
            if !metadata.is_file() {
                return Err(invalid(format!("native artifact path `{relative}` is not a regular file")));
            }
        } else if !metadata.is_dir() {
            return Err(invalid(format!("native artifact path `{relative}` aliases a file and directory")));
        }
    }
    let metadata = fs::symlink_metadata(&current).map_err(io_error)?;
    Ok((current, metadata))
}

struct SourceBudget {
    limits: AcceptedFrequencyResponseArtifactLimits,
    file_lengths: BTreeMap<String, u64>,
    total_bytes: u64,
    dense_json_bytes: u64,
}

impl SourceBudget {
    fn new(limits: AcceptedFrequencyResponseArtifactLimits) -> Self {
        Self {
            limits,
            file_lengths: BTreeMap::new(),
            total_bytes: 0,
            dense_json_bytes: 0,
        }
    }

    fn inventory(
        &mut self,
        root: &Path,
        paths: &BTreeSet<String>,
        point_paths: &[String],
        diagnostic_paths: &[String],
        sweep_v1: &str,
        sweep_v2: &str,
    ) -> Result<(), RunError> {
        let dense: BTreeSet<&str> = point_paths
            .iter()
            .map(String::as_str)
            .chain([sweep_v1, sweep_v2])
            .collect();
        for relative in paths {
            let (_, metadata) = safe_native_file(root, relative)?;
            self.register(relative, metadata.len(), dense.contains(relative.as_str()))?;
        }
        for relative in diagnostic_paths {
            if !self.file_lengths.contains_key(relative) {
                return Err(invalid("diagnostics path was omitted from native source inventory"));
            }
        }
        if self.total_bytes > self.limits.max_native_source_bytes {
            return Err(invalid("native source aggregate exceeds the admitted byte limit"));
        }
        if self.dense_json_bytes > self.limits.max_native_dense_json_bytes {
            return Err(invalid("native dense JSON aggregate exceeds the admitted limit"));
        }
        Ok(())
    }

    fn register(&mut self, relative: &str, length: u64, dense: bool) -> Result<(), RunError> {
        if let Some(existing) = self.file_lengths.get(relative) {
            if *existing != length {
                return Err(invalid("native source file changed size during inventory"));
            }
            return Ok(());
        }
        self.total_bytes = checked_add(self.total_bytes, length, "native source aggregate")?;
        if dense {
            self.dense_json_bytes = checked_add(self.dense_json_bytes, length, "native dense JSON aggregate")?;
        }
        self.file_lengths.insert(relative.to_string(), length);
        Ok(())
    }

    fn file_len(&self, relative: &str) -> Result<u64, RunError> {
        self.file_lengths
            .get(relative)
            .copied()
            .ok_or_else(|| invalid(format!("native file `{relative}` is not in the explicit allow-list")))
    }

    fn read(
        &mut self,
        root: &Path,
        relative: &str,
        per_file_limit: u64,
        dense: bool,
    ) -> Result<Vec<u8>, RunError> {
        let (_, metadata) = safe_native_file(root, relative)?;
        self.register(relative, metadata.len(), dense)?;
        let length = self.file_len(relative)?;
        if length > per_file_limit {
            return Err(invalid(format!("native source file `{relative}` exceeds its bounded read size")));
        }
        if self.total_bytes > self.limits.max_native_source_bytes
            || self.dense_json_bytes > self.limits.max_native_dense_json_bytes
        {
            return Err(invalid("native source aggregate exceeds its admitted read budget"));
        }
        let (path, current_metadata) = safe_native_file(root, relative)?;
        if current_metadata.len() != length {
            return Err(invalid("native source file changed size after inventory"));
        }
        read_file_exact(&path, length, per_file_limit)
    }

    fn read_exact(
        &mut self,
        root: &Path,
        relative: &str,
        expected_length: u64,
        dense: bool,
    ) -> Result<Vec<u8>, RunError> {
        let bytes = self.read(root, relative, expected_length, dense)?;
        if bytes.len() as u64 != expected_length {
            return Err(invalid(format!("native payload `{relative}` has the wrong byte length")));
        }
        Ok(bytes)
    }
}

fn read_file_exact(path: &Path, expected_length: u64, per_file_limit: u64) -> Result<Vec<u8>, RunError> {
    if expected_length > per_file_limit {
        return Err(invalid("native artifact file exceeds its bounded read size"));
    }
    let capacity = usize::try_from(expected_length)
        .map_err(|_| invalid("native artifact file exceeds addressable memory"))?;
    let mut file = File::open(path).map_err(io_error)?;
    let read_limit = expected_length
        .checked_add(1)
        .ok_or_else(|| invalid("native artifact read limit overflow"))?;
    let mut bytes = Vec::with_capacity(capacity);
    Read::by_ref(&mut file)
        .take(read_limit)
        .read_to_end(&mut bytes)
        .map_err(io_error)?;
    if bytes.len() as u64 != expected_length {
        return Err(invalid("native artifact file changed size while it was read"));
    }
    Ok(bytes)
}

fn object_field<'a>(value: &'a Value, key: &str, label: &str) -> Result<&'a serde_json::Map<String, Value>, RunError> {
    value
        .get(key)
        .and_then(Value::as_object)
        .ok_or_else(|| invalid(format!("{label} is missing object `{key}`")))
}

fn required_string<'a>(value: &'a serde_json::Map<String, Value>, key: &str, label: &str) -> Result<&'a str, RunError> {
    value
        .get(key)
        .and_then(Value::as_str)
        .ok_or_else(|| invalid(format!("{label} is missing string `{key}`")))
}

fn parse_string_array(
    value: &serde_json::Map<String, Value>,
    key: &str,
    label: &str,
) -> Result<Vec<String>, RunError> {
    let entries = value
        .get(key)
        .and_then(Value::as_array)
        .ok_or_else(|| invalid(format!("{label} is missing array `{key}`")))?;
    entries
        .iter()
        .map(|entry| {
            entry
                .as_str()
                .map(str::to_string)
                .ok_or_else(|| invalid(format!("{label} array `{key}` contains a non-string path")))
        })
        .collect()
}

fn native_diagnostic_paths(artifacts: &serde_json::Map<String, Value>) -> Result<Vec<String>, RunError> {
    let mut paths = BTreeSet::new();
    for key in ["response_diagnostics_v1_path", "solver_diagnostics_path", "response_diagnostics_path"] {
        if let Some(value) = artifacts.get(key) {
            if value.is_null() {
                continue;
            }
            let path = value
                .as_str()
                .ok_or_else(|| invalid(format!("native diagnostics path `{key}` is not a string")))?;
            if path != "response/diagnostics/solver.v1.json" && path != "response/diagnostics.v1.json" {
                return Err(invalid("native diagnostics path is not a known writer path"));
            }
            paths.insert(path.to_string());
        }
    }
    if paths.is_empty() {
        return Err(invalid("native manifest does not explicitly reference response diagnostics"));
    }
    Ok(paths.into_iter().collect())
}

fn validate_expected_paths(
    paths: &[String],
    prefix: &str,
    suffix: &str,
    count: u64,
) -> Result<(), RunError> {
    if paths.len() as u64 != count {
        return Err(invalid("native frequency point path count does not match the requested sweep"));
    }
    let mut casefold = BTreeSet::new();
    for (index, path) in paths.iter().enumerate() {
        if !casefold.insert(path.to_ascii_lowercase()) {
            return Err(invalid("native frequency point paths have a case-fold collision"));
        }
        let expected = format!("{prefix}{index:04}{suffix}");
        if path != &expected {
            return Err(invalid(format!("native frequency point path/order mismatch: expected `{expected}`")));
        }
        validate_relative_path(path)?;
    }
    Ok(())
}

fn validate_path_set<'a>(paths: impl IntoIterator<Item = &'a str>) -> Result<(), RunError> {
    let mut files = BTreeSet::new();
    let mut directories = BTreeSet::new();
    for raw in paths {
        validate_relative_path(raw)?;
        let key = raw.to_ascii_lowercase();
        if !files.insert(key.clone()) {
            return Err(invalid("artifact paths contain a duplicate or case-fold collision"));
        }
        if directories.contains(&key) {
            return Err(invalid("artifact paths contain a file/directory alias collision"));
        }
        let mut prefix = String::new();
        let mut components = raw.split('/').peekable();
        while let Some(component) = components.next() {
            if !prefix.is_empty() {
                prefix.push('/');
            }
            prefix.push_str(component);
            if components.peek().is_some() {
                let prefix_key = prefix.to_ascii_lowercase();
                if files.contains(&prefix_key) {
                    return Err(invalid("artifact paths contain a file/directory alias collision"));
                }
                directories.insert(prefix_key);
            }
        }
    }
    Ok(())
}

fn validate_native_manifest(
    manifest: &Value,
    identity: &FrequencyDomainArtifactIdentity,
    plan: &FemFrequencyResponsePlanIR,
) -> Result<(), RunError> {
    if required_string(manifest.as_object().ok_or_else(|| invalid("native manifest root is not an object"))?, "schema_version", "native manifest")? != "frequency_domain_manifest.v1" {
        return Err(invalid("native frequency-domain manifest schema is unsupported"));
    }
    for (key, expected) in [
        ("session_id", identity.session_id.as_str()),
        ("run_id", identity.run_id.as_str()),
        ("stage_id", identity.stage_id.as_str()),
        ("runtime_id", identity.runtime_id.as_str()),
    ] {
        let actual = manifest.get(key).and_then(Value::as_str).unwrap_or_default();
        if actual != expected {
            return Err(invalid(format!("native manifest {key} does not match the supplied artifact identity")));
        }
    }
    if manifest.get("study_product").and_then(Value::as_str) != Some("driven_response")
        || manifest.get("stage_kind").and_then(Value::as_str) != Some("frequency_response")
        || manifest.get("status").and_then(Value::as_str) != Some("ready")
        || manifest.get("complete").and_then(Value::as_bool) != Some(true)
    {
        return Err(invalid("native frequency-response manifest is not complete and ready"));
    }
    let requested = object_field(manifest, "requested_execution", "native manifest")?;
    if requested.get("frequency_count").and_then(Value::as_u64)
        != Some(plan.frequencies_hz.values_hz.len() as u64)
    {
        return Err(invalid("native manifest frequency count differs from the accepted plan"));
    }
    let resolved = object_field(manifest, "resolved_execution", "native manifest")?;
    if resolved.get("native_backend").and_then(Value::as_str) != Some("native_mfem_matrix_free")
        || resolved.get("production_solver").and_then(Value::as_bool) != Some(true)
    {
        return Err(invalid("native response was not produced by the production MFEM solver"));
    }
    let expected_lane = if plan.requested_device == fullmag_ir::ExecutionDevice::Gpu {
        "production_gpu"
    } else {
        "production_cpu"
    };
    if resolved.get("resolved_execution_lane").and_then(Value::as_str) != Some(expected_lane) {
        return Err(invalid("native resolved lane differs from the requested device; fallback is forbidden"));
    }
    let diagnostics = object_field(manifest, "diagnostics", "native manifest")?;
    if diagnostics.get("validation_fallback_used").and_then(Value::as_bool) == Some(true) {
        return Err(invalid("native manifest reports a validation fallback"));
    }
    Ok(())
}

fn validate_point_resource_list(
    manifest: &Value,
    point_paths: &[String],
    write_fields: bool,
    require_xyz: bool,
) -> Result<Option<bool>, RunError> {
    let resources = manifest
        .get("resources")
        .and_then(|value| value.get("response_field_resources"))
        .and_then(Value::as_array);
    let Some(resources) = resources else {
        if require_xyz {
            return Err(invalid("native manifest omits required response field resources"));
        }
        if write_fields {
            return Err(invalid("native response fields are requested but their resources are missing"));
        }
        return Ok(None);
    };
    if require_xyz && (!write_fields || resources.len() != point_paths.len()) {
        return Err(invalid("native response field resource list is incomplete"));
    }
    if !write_fields {
        return Ok(None);
    }
    if resources.len() != point_paths.len() {
        return Err(invalid("native response field resource list is incomplete"));
    }
    let mut spatial: Option<bool> = None;
    for (index, value) in resources.iter().enumerate() {
        let resource: FrequencyPointResource = serde_json::from_value(value.clone()).map_err(json_error)?;
        if resource.frequency_index as usize != index {
            return Err(invalid("native response field resources are not in frequency order"));
        }
        let xyz = format!("response/field_payloads.zarr/frequency_{index:04}/vector_xyz_complex/0.0.0");
        let tangent = format!("response/field_payloads.zarr/frequency_{index:04}/vector_tangent_complex/0.0.0");
        let point_is_spatial = if resource.payload_path == xyz {
            true
        } else if resource.payload_path == tangent {
            false
        } else {
            return Err(invalid("native field resource points to an unexpected field path"));
        };
        if require_xyz && !point_is_spatial {
            return Err(invalid("Cartesian XYZ field visualization cannot use a tangent payload"));
        }
        if spatial.is_some_and(|expected| expected != point_is_spatial) {
            return Err(invalid("native response field resources mix tangent and Cartesian XYZ layouts"));
        }
        spatial = Some(point_is_spatial);
    }
    Ok(spatial)
}

fn validate_progress(bytes: &[u8], frequency_count: u64) -> Result<(), RunError> {
    let progress = parse_unique_json(bytes, "native progress")?;
    if progress.get("schema_version").and_then(Value::as_str) != Some("frequency_domain_sweep_progress.v1")
        || progress.get("status").and_then(Value::as_str) != Some("ready")
        || progress.get("complete").and_then(Value::as_bool) != Some(true)
        || progress.get("total_frequency_points").and_then(Value::as_u64) != Some(frequency_count)
        || progress.get("completed_frequency_points").and_then(Value::as_u64) != Some(frequency_count)
    {
        return Err(invalid("native progress does not confirm a complete ordered sweep"));
    }
    Ok(())
}

fn validate_point_field_spec(
    native: &NativePoint,
    index: usize,
    native_node_count: u64,
    write_fields: bool,
    spatial_fields: bool,
    require_xyz: bool,
) -> Result<Option<FieldSpec>, RunError> {
    if !write_fields {
        if require_xyz {
            return Err(invalid("Cartesian response fields were requested but native fields are absent"));
        }
        return Ok(None);
    }
    if require_xyz && !spatial_fields {
        return Err(invalid("tangent response payload cannot be published as Cartesian XYZ"));
    }
    let prefix = format!("response/field_payloads.zarr/frequency_{index:04}");
    let tangent_array = format!("{prefix}/vector_tangent_complex");
    let tangent_chunk = format!("{tangent_array}/0.0.0");
    let tangent_compat = format!("response/field_payloads/frequency_{index:04}/vector.bin");
    let primary_array = if spatial_fields {
        format!("{prefix}/vector_xyz_complex")
    } else {
        tangent_array.clone()
    };
    let primary_chunk = format!("{primary_array}/0.0.0");
    let primary_compat = if spatial_fields {
        format!("response/field_payloads/frequency_{index:04}/vector_xyz.bin")
    } else {
        tangent_compat.clone()
    };
    let components = if spatial_fields { 3_u64 } else { 2_u64 };
    let expected_shape = vec![native_node_count, components, 2];
    let field_payload_path = native
        .response_field_payload_path
        .as_deref()
        .or(native.field_payload_path.as_deref());
    let tangent_payload_path = native
        .response_tangent_field_payload_path
        .as_deref()
        .or(native.tangent_field_payload_path.as_deref());
    if native.storage_format.as_deref() != Some("zarr")
        || native.zarr_store_path.as_deref() != Some("response/field_payloads.zarr")
        || field_payload_path != Some(primary_chunk.as_str())
        || tangent_payload_path != Some(tangent_chunk.as_str())
        || native.zarr_array_path.as_deref() != Some(primary_array.as_str())
        || native.zarr_chunk_path.as_deref() != Some(primary_chunk.as_str())
        || native.zarr_dtype.as_deref() != Some("<f8")
        || native.zarr_shape.as_ref() != Some(&expected_shape)
        || native.zarr_chunk_shape.as_ref() != Some(&expected_shape)
        || native.compatibility_binary_payload_path.as_deref() != Some(primary_compat.as_str())
    {
        return Err(invalid(format!("native response field layout or Cartesian/tangent identity mismatch at point {index}")));
    }
    let tangent_length = checked_mul(native_node_count, 32, "native tangent point payload")?;
    let mut metadata_paths = vec![
        format!("{prefix}/.zgroup"),
        format!("{tangent_array}/.zarray"),
        format!("{tangent_array}/.zattrs"),
    ];
    let mut payload_paths = vec![
        (tangent_chunk.clone(), tangent_length),
        (tangent_compat.clone(), tangent_length),
    ];
    if spatial_fields {
        let xyz_length = checked_mul(native_node_count, 48, "native Cartesian point payload")?;
        metadata_paths.push(format!("{primary_array}/.zarray"));
        metadata_paths.push(format!("{primary_array}/.zattrs"));
        payload_paths.push((primary_chunk.clone(), xyz_length));
        payload_paths.push((primary_compat.clone(), xyz_length));
    }
    let component_basis = if spatial_fields { "global_xyz" } else { "local_tangent_frame" };
    let complex_pair_count = checked_mul(native_node_count, components, "response complex-pair count")?;
    let payload_value_count = checked_mul(complex_pair_count, 2, "response point value count")?;
    let compact = CompactFieldReference {
        storage_format: "zarr",
        component_basis,
        field_payload_path: primary_chunk.clone(),
        payload_path: primary_chunk,
        tangent_payload_path: tangent_chunk,
        compatibility_binary_payload_path: primary_compat,
        dtype: "<f8",
        shape: [native_node_count, components, 2],
        node_indexing: "explicit_node_indices",
        component_count: components,
        complex_pair_count,
        payload_value_count,
        available_views: ["complex", "real", "imag", "abs", "amplitude", "phase", "phase_rotated_real"],
        default_view: "phase_rotated_real",
        default_phase_rad: 0.0,
        zarr_array_path: primary_array,
        zarr_chunk_path: if spatial_fields {
            format!("{prefix}/vector_xyz_complex/0.0.0")
        } else {
            format!("{prefix}/vector_tangent_complex/0.0.0")
        },
        zarr_metadata_paths: metadata_paths.clone(),
    };
    Ok(Some(FieldSpec { compact, metadata_paths, payload_paths }))
}

fn validate_zarr_group_or_store(relative: &str, bytes: &[u8]) -> Result<(), RunError> {
    let value = parse_unique_json(bytes, "native Zarr metadata")?;
    if relative.ends_with(".zgroup") && value.get("zarr_format").and_then(Value::as_u64) != Some(2) {
        return Err(invalid("native response Zarr group is not Zarr v2"));
    }
    Ok(())
}

fn validate_zarr_metadata(relative: &str, bytes: &[u8], field: &FieldSpec) -> Result<(), RunError> {
    let value = parse_unique_json(bytes, "native Zarr array metadata")?;
    if relative.ends_with(".zgroup") {
        if value.get("zarr_format").and_then(Value::as_u64) != Some(2) {
            return Err(invalid("native response Zarr point group is not Zarr v2"));
        }
        return Ok(());
    }
    if relative.ends_with(".zarray") {
        let is_xyz = relative.contains("vector_xyz_complex");
        let components = if is_xyz { 3 } else { 2 };
        let shape = [field.compact.shape[0], components, 2];
        let parsed_shape = value
            .get("shape")
            .and_then(Value::as_array)
            .and_then(|items| items.iter().map(Value::as_u64).collect::<Option<Vec<_>>>());
        let parsed_chunks = value
            .get("chunks")
            .and_then(Value::as_array)
            .and_then(|items| items.iter().map(Value::as_u64).collect::<Option<Vec<_>>>());
        if value.get("zarr_format").and_then(Value::as_u64) != Some(2)
            || value.get("dtype").and_then(Value::as_str) != Some("<f8")
            || parsed_shape.as_deref() != Some(shape.as_slice())
            || parsed_chunks.as_deref() != Some(shape.as_slice())
        {
            return Err(invalid("native Zarr array metadata does not match the declared f64 response shape"));
        }
        return Ok(());
    }
    if relative.ends_with(".zattrs") {
        if !value.is_object() {
            return Err(invalid("native Zarr array attributes are not an object"));
        }
        if let Some(basis) = value.get("component_basis").and_then(Value::as_str) {
            let expected = if relative.contains("vector_xyz_complex") { "global_xyz" } else { "local_tangent_frame" };
            if basis != expected {
                return Err(invalid("native Zarr component basis mislabeled Cartesian XYZ or tangent payload"));
            }
        }
        return Ok(());
    }
    Err(invalid("native response field metadata path is not a known Zarr metadata file"))
}

fn compact_manifest(
    manifest: &mut Value,
    v1_sha256: &str,
    v2_sha256: &str,
    descriptor: &FrequencyResponseInputDescriptor,
) -> Result<(), RunError> {
    let object = manifest
        .as_object_mut()
        .ok_or_else(|| invalid("native manifest root is not an object"))?;
    let artifacts = object
        .get_mut("artifacts")
        .and_then(Value::as_object_mut)
        .ok_or_else(|| invalid("native manifest artifacts are missing"))?;
    artifacts.remove("response_sweep_v1_path");
    artifacts.remove("response_sweep_v2_path");
    artifacts.insert(
        "response_sweep_v3_path".to_string(),
        Value::String("response/magnetic_response_sweep.v3.json".to_string()),
    );
    artifacts.insert(
        "response_input_descriptor_v1_path".to_string(),
        Value::String("input/descriptor.v1.json".to_string()),
    );
    object.insert("equilibrium_verified".to_string(), Value::Bool(false));
    object.insert(
        "input_provenance".to_string(),
        serde_json::json!({
            "schema_version": "fullmag.fem.driven_response_input.v1",
            "equilibrium_verified": false,
            "topology_fingerprint": descriptor.topology_fingerprint,
            "equilibrium_sha256": descriptor.equilibrium_sha256,
            "magnetic_node_indices_sha256": descriptor.magnetic_node_indices_sha256,
            "full_node_count": descriptor.full_node_count,
            "native_node_count": descriptor.native_node_count,
            "descriptor_path": "input/descriptor.v1.json"
        }),
    );
    object.insert(
        "native_sweep_source_hashes".to_string(),
        serde_json::json!({
            "magnetic_response_sweep_v1_sha256": v1_sha256,
            "magnetic_response_sweep_v2_sha256": v2_sha256
        }),
    );
    Ok(())
}

fn encode_m0_le(values: &[[f64; 3]], full_node_count: u64) -> Result<Vec<u8>, RunError> {
    if values.len() as u64 != full_node_count {
        return Err(invalid("provided M0 length differs from the full source mesh"));
    }
    let byte_length = checked_mul(full_node_count, 3 * 8, "provided M0 byte length")?;
    let capacity = usize::try_from(byte_length).map_err(|_| invalid("provided M0 exceeds addressable memory"))?;
    let mut bytes = Vec::with_capacity(capacity);
    for vector in values {
        for component in vector {
            bytes.extend_from_slice(&component.to_le_bytes());
        }
    }
    Ok(bytes)
}

fn encode_indices_le(indices: &[u64]) -> Result<Vec<u8>, RunError> {
    let length = checked_mul(indices.len() as u64, 8, "magnetic node index map")?;
    let capacity = usize::try_from(length).map_err(|_| invalid("magnetic node map exceeds addressable memory"))?;
    let mut bytes = Vec::with_capacity(capacity);
    for index in indices {
        bytes.extend_from_slice(&index.to_le_bytes());
    }
    Ok(bytes)
}

fn sha256(bytes: &[u8]) -> String {
    format!("sha256:{:x}", Sha256::digest(bytes))
}

fn push_output(
    files: &mut Vec<ArtifactFileBytes>,
    output_paths: &mut Vec<String>,
    bundle_total: &mut u64,
    output_total: &mut u64,
    limits: AcceptedFrequencyResponseArtifactLimits,
    relative_path: &str,
    role: AcceptedFrequencyResponseArtifactRole,
    bytes: Vec<u8>,
    point_bundle: bool,
) -> Result<(), RunError> {
    validate_relative_path(relative_path)?;
    let candidate_paths = output_paths
        .iter()
        .map(String::as_str)
        .chain(std::iter::once(relative_path));
    validate_path_set(candidate_paths)?;
    let byte_length = u64::try_from(bytes.len()).map_err(|_| invalid("published artifact file exceeds u64"))?;
    *bundle_total = checked_add(*bundle_total, byte_length, "artifact bundle aggregate")?;
    *output_total = checked_add(*output_total, byte_length, "all-output aggregate")?;
    let hard_bundle_limit = if point_bundle {
        limits.max_point_bundle_bytes.min(ACCEPTED_FREQUENCY_RESPONSE_DEFAULT_BUNDLE_LIMIT_BYTES)
    } else {
        limits.max_global_bundle_bytes.min(ACCEPTED_FREQUENCY_RESPONSE_DEFAULT_BUNDLE_LIMIT_BYTES)
    };
    if *bundle_total > hard_bundle_limit {
        return Err(invalid(if point_bundle {
            "point bundle exceeds its aggregate size limit"
        } else {
            "global artifact bundle exceeds its aggregate size limit"
        }));
    }
    if *output_total > limits.max_total_output_bytes {
        return Err(invalid("artifact aggregate output exceeds the admitted limit"));
    }
    output_paths.push(relative_path.to_string());
    files.push(ArtifactFileBytes { relative_path: relative_path.to_string(), role, bytes });
    Ok(())
}

#[cfg(test)]
mod output_publication_tests {
    use super::*;
    use serde_json::{json, Value};
    use sha2::{Digest, Sha256};
    use std::fs;

    const SESSION_ID: &str = "session:accepted-fr";
    const RUN_ID: &str = "run:accepted-fr";
    const STAGE_ID: &str = "stage:accepted-fr";
    const RUNTIME_ID: &str = "runtime:accepted-fr";
    const POINT_PATHS: [&str; 2] = [
        "response/frequency_points/frequency_0000.json",
        "response/frequency_points/frequency_0001.json",
    ];

    fn fixture_plan() -> FemFrequencyResponsePlanIR {
        let mut plan = super::super::tests::minimal_frequency_response_plan();
        plan.frequencies_hz.values_hz = vec![1.0e9, 2.0e9];
        plan.requested_device = fullmag_ir::ExecutionDevice::Gpu;
        plan
    }

    fn fixture_identity() -> FrequencyDomainArtifactIdentity {
        FrequencyDomainArtifactIdentity::try_new(SESSION_ID, RUN_ID, STAGE_ID, RUNTIME_ID)
            .expect("fixture identity is exact")
    }

    fn default_limits() -> AcceptedFrequencyResponseArtifactLimits {
        AcceptedFrequencyResponseArtifactLimits::default()
    }

    fn write_json(root: &Path, relative: &str, value: &Value) {
        let path = root.join(relative);
        fs::create_dir_all(path.parent().expect("fixture path has a parent")).unwrap();
        fs::write(path, serde_json::to_vec(value).unwrap()).unwrap();
    }

    fn write_bytes(root: &Path, relative: &str, bytes: &[u8]) {
        let path = root.join(relative);
        fs::create_dir_all(path.parent().expect("fixture path has a parent")).unwrap();
        fs::write(path, bytes).unwrap();
    }

    fn point_json(index: usize, frequency_hz: f64) -> Value {
        let root = format!("response/field_payloads.zarr/frequency_{index:04}");
        let chunk = format!("{root}/vector_xyz_complex/0.0.0");
        let tangent = format!("response/field_payloads.zarr/frequency_{index:04}/vector_tangent_complex/0.0.0");
        json!({
            "schema_version": "frequency_response_point.v1",
            "frequency_index": index,
            "frequency_point_artifact_path": POINT_PATHS[index],
            "field_payload_path": chunk,
            "tangent_field_payload_path": tangent,
            "storage_format": "zarr",
            "zarr_store_path": "response/field_payloads.zarr",
            "zarr_array_path": format!("{root}/vector_xyz_complex"),
            "zarr_chunk_path": chunk,
            "zarr_dtype": "<f8",
            "zarr_shape": [1, 3, 2],
            "zarr_chunk_shape": [1, 3, 2],
            "zarr_compressor": null,
            "compatibility_binary_payload_path": format!("response/field_payloads/frequency_{index:04}/vector_xyz.bin"),
            "frequency_hz": frequency_hz,
            "angular_frequency_rad_per_s": frequency_hz * std::f64::consts::TAU,
            "m_complex": [[0.1, -0.2], [0.3, 0.4]],
            "response_amplitude": 0.4,
            "response_phase": 0.5,
            "component_response_amplitude": [0.2, 0.5],
            "component_response_phase": [-0.3, 0.7],
            "residual_l2_norm": 1.0e-9,
            "relative_residual_l2_norm": 1.0e-9,
            "susceptibility_tensor": [[0.25, 0.5]],
            "susceptibility_tensor_provenance": fixture_susceptibility_provenance(),
            "absorbed_power_density": 0.125,
            "absorbed_power_density_provenance": fixture_absorption_provenance(),
            "residual_source": "matrix_free_gmres",
            "excitation_provenance": { "kind": "field", "phase_rad": 0.0 }
        })
    }

    fn fixture_susceptibility_provenance() -> Value {
        json!({
            "kind": "drive_projected_si_susceptibility",
            "basis": "local_tangent_drive",
            "component_pair_count": 1,
            "full_tensor": false,
            "response_quantity": "delta_M_over_h_drive",
            "response_units": "dimensionless",
            "dimensionless_si_susceptibility": true,
            "requires_ms_for_chi_si": false,
            "ms_factor_applied": true,
            "ms_source": "uniform",
            "normalization": "sum(Ms*response*conj(drive))/sum(abs(drive)^2)"
        })
    }

    fn fixture_absorption_provenance() -> Value {
        json!({
            "kind": "drive_projected_absorption_proxy",
            "basis": "local_tangent_drive",
            "physical_power_density": false,
            "units": "drive_projected_proxy_not_W_per_m3",
            "requires_mu0_ms_factor": false,
            "mu0_ms_factor_applied": true,
            "ms_source": "uniform",
            "normalization": "0.5*mu0*omega*imag(sum(Ms*response*conj(drive)))/tangent_dof_count",
            "volume_weighted": false,
            "spatial_reduction": "drive_projected_tangent_dof_average",
            "absolute_value_applied": false,
            "full_power_density": false
        })
    }

    fn fixture_native_tree(root: &Path) {
        fs::create_dir_all(root).unwrap();
        let point_paths = json!(POINT_PATHS);
        let field_resources = json!([
            {"frequency_index": 0, "field_resource_id": "analysis:frequency-response:frequency-0000", "storage_format": "zarr", "payload_path": "response/field_payloads.zarr/frequency_0000/vector_xyz_complex/0.0.0"},
            {"frequency_index": 1, "field_resource_id": "analysis:frequency-response:frequency-0001", "storage_format": "zarr", "payload_path": "response/field_payloads.zarr/frequency_0001/vector_xyz_complex/0.0.0"}
        ]);
        write_json(
            root,
            "frequency_domain/manifest.v1.json",
            &json!({
                "schema_version": "frequency_domain_manifest.v1",
                "analysis_family": "magnetic_frequency_domain",
                "study_product": "driven_response",
                "revision": "production-gpu-matrix-free-v1",
                "session_id": SESSION_ID,
                "run_id": RUN_ID,
                "stage_id": STAGE_ID,
                "runtime_id": RUNTIME_ID,
                "stage_kind": "frequency_response",
                "status": "ready",
                "complete": true,
                "requested_execution": {"frequency_count": 2, "write_response_fields": true},
                "resolved_execution": {
                    "backend_engine_id": "native_fem_mfem",
                    "native_backend": "native_mfem_matrix_free",
                    "resolved_execution_lane": "production_gpu",
                    "production_solver": true
                },
                "physics": {"llg_gamma0_si": 2.211e5, "llg_alpha": 0.01, "spin_wave_bc": {"kind": "open"}},
                "artifacts": {
                    "response_sweep_v1_path": "response/magnetic_response_sweep.v1.json",
                    "response_sweep_v2_path": "response/magnetic_response_sweep.v2.json",
                    "response_diagnostics_v1_path": "response/diagnostics/solver.v1.json",
                    "response_progress_v1_path": "response/progress.v1.json",
                    "frequency_point_paths": point_paths.clone()
                },
                "resources": {"response_field_resources": field_resources},
                "diagnostics": {"point_count": 2, "completed_frequency_point_count": 2, "written_frequency_point_artifacts": 2, "solver_relative_tolerance": 1.0e-8},
                "capabilities": {"production_solver_available": true, "production_native_solver_available": true, "gpu_available": true}
            }),
        );

        let points = json!([
            {"frequency_index": 0, "frequency_point_artifact_path": POINT_PATHS[0], "response_field_payload_path": "response/field_payloads.zarr/frequency_0000/vector_xyz_complex/0.0.0", "frequency_hz": 1.0e9, "response_amplitude": 0.4, "response_phase": 0.5, "residual_l2_norm": 1.0e-9, "relative_residual_l2_norm": 1.0e-9, "susceptibility_tensor": [[0.25, 0.5]], "susceptibility_tensor_provenance": fixture_susceptibility_provenance(), "absorbed_power_density": 0.125, "absorbed_power_density_provenance": fixture_absorption_provenance(), "m_complex": [[0.1, -0.2], [0.3, 0.4]]},
            {"frequency_index": 1, "frequency_point_artifact_path": POINT_PATHS[1], "response_field_payload_path": "response/field_payloads.zarr/frequency_0001/vector_xyz_complex/0.0.0", "frequency_hz": 2.0e9, "response_amplitude": 0.4, "response_phase": 0.5, "residual_l2_norm": 1.0e-9, "relative_residual_l2_norm": 1.0e-9, "susceptibility_tensor": [[0.25, 0.5]], "susceptibility_tensor_provenance": fixture_susceptibility_provenance(), "absorbed_power_density": 0.125, "absorbed_power_density_provenance": fixture_absorption_provenance(), "m_complex": [[0.1, -0.2], [0.3, 0.4]]}
        ]);
        write_json(
            root,
            "response/magnetic_response_sweep.v1.json",
            &json!({
                "schema_version": "magnetic_response_sweep.v1",
                "backend_engine_id": "native_fem_mfem",
                "solver_model": "linearized_llg_tangent",
                "damping_policy": "linearized_llg_tangent",
                "lane_classification": "production_gpu",
                "matrix_layout": "matrix_free_block_real",
                "excitation_kind": "uniform_field",
                "si_units": {"frequency": "Hz", "angular_frequency": "rad/s"},
                "point_count": 2,
                "points": points.clone()
            }),
        );
        write_json(
            root,
            "response/magnetic_response_sweep.v2.json",
            &json!({
                "schema_version": "magnetic_response_sweep.v2",
                "solve_kind": "direct_harmonic_response",
                "complete": true,
                "completed_frequency_point_count": 2,
                "point_count": 2,
                "frequency_point_artifact_path": POINT_PATHS[0],
                "response_field_payload_path": "response/field_payloads.zarr/frequency_0000/vector_xyz_complex/0.0.0",
                "frequency_point_artifact_paths": point_paths.clone(),
                "response_field_payload_paths": [
                    "response/field_payloads.zarr/frequency_0000/vector_xyz_complex/0.0.0",
                    "response/field_payloads.zarr/frequency_0001/vector_xyz_complex/0.0.0"
                ],
                "points": points.clone()
            }),
        );
        write_json(
            root,
            "response/progress.v1.json",
            &json!({"schema_version": "frequency_domain_sweep_progress.v1", "status": "ready", "complete": true, "total_frequency_points": 2, "completed_frequency_points": 2}),
        );
        write_json(
            root,
            "response/diagnostics/solver.v1.json",
            &json!({"schema_version": "frequency_domain_response_diagnostics.v1", "solver_relative_tolerance": 1.0e-8, "relative_residual_l2_norm": 1.0e-9}),
        );

        write_json(root, "response/field_payloads.zarr/.zgroup", &json!({"zarr_format": 2}));
        write_json(root, "response/field_payloads.zarr/.zattrs", &json!({"fullmag_kind": "frequency_domain_response_field_store", "schema_version": 1}));
        let xyz_array = json!({"zarr_format": 2, "shape": [1, 3, 2], "chunks": [1, 3, 2], "dtype": "<f8", "compressor": null, "fill_value": 0.0, "order": "C", "filters": null, "dimension_separator": "."});
        let tangent_array = json!({"zarr_format": 2, "shape": [1, 2, 2], "chunks": [1, 2, 2], "dtype": "<f8", "compressor": null, "fill_value": 0.0, "order": "C", "filters": null, "dimension_separator": "."});
        let xyz_attrs = json!({"quantity_id": "delta_m", "unit": "1", "value_kind": "complex_spatial_vector", "component_basis": "global_xyz", "axes": ["spatial_sample", "component", "complex"], "component_order": ["x", "y", "z"], "complex_order": ["real", "imag"], "storage_layout": "aos_component_complex_pairs"});
        let tangent_attrs = json!({"quantity_id": "delta_m", "unit": "1", "value_kind": "complex_tangent_vector", "component_basis": "local_tangent_frame", "axes": ["spatial_sample", "component", "complex"], "component_order": ["tangent_e1", "tangent_e2"], "complex_order": ["real", "imag"], "storage_layout": "aos_component_complex_pairs"});
        for index in 0..2 {
            let prefix = format!("response/field_payloads.zarr/frequency_{index:04}");
            write_json(root, &format!("{prefix}/.zgroup"), &json!({"zarr_format": 2}));
            write_json(root, &format!("{prefix}/vector_xyz_complex/.zarray"), &xyz_array);
            write_json(root, &format!("{prefix}/vector_xyz_complex/.zattrs"), &xyz_attrs);
            write_json(root, &format!("{prefix}/vector_tangent_complex/.zarray"), &tangent_array);
            write_json(root, &format!("{prefix}/vector_tangent_complex/.zattrs"), &tangent_attrs);

            let xyz: [f64; 6] = [1.0, 0.1, 2.0, 0.2, 3.0, 0.3];
            let xyz_bytes = xyz.iter().flat_map(|value| value.to_le_bytes()).collect::<Vec<_>>();
            let tangent: [f64; 4] = [0.1, 0.01, 0.2, 0.02];
            let tangent_bytes = tangent.iter().flat_map(|value| value.to_le_bytes()).collect::<Vec<_>>();
            write_bytes(root, &format!("{prefix}/vector_xyz_complex/0.0.0"), &xyz_bytes);
            write_bytes(root, &format!("{prefix}/vector_tangent_complex/0.0.0"), &tangent_bytes);
            write_bytes(root, &format!("response/field_payloads/frequency_{index:04}/vector_xyz.bin"), &xyz_bytes);
            write_bytes(root, &format!("response/field_payloads/frequency_{index:04}/vector.bin"), &tangent_bytes);
            write_json(root, POINT_PATHS[index], &point_json(index, (index as f64 + 1.0) * 1.0e9));
        }
    }

    fn temp_roots() -> (tempfile::TempDir, PathBuf, PathBuf) {
        let temp = tempfile::tempdir().unwrap();
        let native = temp.path().join("native");
        let published = temp.path().join("published");
        fixture_native_tree(&native);
        (temp, native, published)
    }

    fn rewrite_json(path: &Path, edit: impl FnOnce(&mut Value)) {
        let mut value: Value = serde_json::from_slice(&fs::read(path).unwrap()).unwrap();
        edit(&mut value);
        fs::write(path, serde_json::to_vec(&value).unwrap()).unwrap();
    }

    fn expect_error_contains(
        native: &Path,
        published: &Path,
        needle: &str,
        limits: AcceptedFrequencyResponseArtifactLimits,
    ) {
        let error = collect_publish_accepted_frequency_response_artifacts(
            &fixture_plan(),
            &fixture_identity(),
            native,
            published,
            limits,
        )
        .expect_err("invalid native artifact must fail closed");
        assert!(error.message.contains(needle), "unexpected error: {}", error.message);
    }

    #[test]
    fn collects_and_publishes_valid_two_frequency_native_fixture() {
        let (_temp, native, published) = temp_roots();
        write_bytes(&native, "response/field_payloads/frequency_9876/unreferenced.bin", b"ignore me");
        let artifacts = collect_publish_accepted_frequency_response_artifacts(
            &fixture_plan(),
            &fixture_identity(),
            &native,
            &published,
            default_limits(),
        )
        .expect("valid native frequency-response fixture should publish");

        assert_eq!(artifacts.points.len(), 2);
        assert_eq!(artifacts.points[0].frequency_index, 0);
        assert_eq!(artifacts.points[1].frequency_index, 1);
        assert_eq!(artifacts.points[0].frequency_hz, 1.0e9);
        assert_eq!(artifacts.points[1].frequency_hz, 2.0e9);
        assert!(artifacts.points.iter().all(|point| point.converged));
        assert!(artifacts.points.iter().all(|point| point.relative_residual_l2_norm <= point.solver_relative_tolerance));
        assert!(artifacts.points.iter().flat_map(|point| &point.files).any(|file| {
            file.relative_path.ends_with("vector_xyz_complex/0.0.0")
                && file.bytes == [1.0_f64, 0.1, 2.0, 0.2, 3.0, 0.3].iter().flat_map(|value| value.to_le_bytes()).collect::<Vec<_>>()
        }));
        let point_metadata = artifacts.points[0]
            .files
            .iter()
            .find(|file| file.relative_path == POINT_PATHS[0])
            .expect("compact point metadata is published");
        let point_metadata: Value = serde_json::from_slice(&point_metadata.bytes).unwrap();
        assert_eq!(point_metadata["component_count"], json!(3));
        assert_eq!(point_metadata["complex_pair_count"], json!(3));
        assert_eq!(point_metadata["payload_value_count"], json!(6));
        assert_eq!(point_metadata["field"]["shape"], json!([1, 3, 2]));
        assert_eq!(point_metadata["field"]["complex_pair_count"], json!(3));
        assert_eq!(point_metadata["field"]["payload_value_count"], json!(6));
        assert_eq!(point_metadata["susceptibility_tensor"], json!([[0.25, 0.5]]));
        assert_eq!(point_metadata["susceptibility_tensor_provenance"]["response_units"], "dimensionless");
        assert_eq!(point_metadata["susceptibility_tensor_provenance"]["full_tensor"], false);
        assert_eq!(point_metadata["absorbed_power_density"], json!(0.125));
        assert_eq!(point_metadata["absorbed_power_density_provenance"]["physical_power_density"], false);
        assert_eq!(point_metadata["absorbed_power_density_provenance"]["units"], "drive_projected_proxy_not_W_per_m3");
        for dense_key in ["m_complex", "component_response_amplitude", "component_response_phase"] {
            assert!(point_metadata.get(dense_key).is_none(), "compact point must omit dense source key {dense_key}");
        }
        for suffix in ["vector_xyz_complex/0.0.0", "vector_xyz.bin"] {
            let payload = artifacts.points[0]
                .files
                .iter()
                .find(|file| file.relative_path.ends_with(suffix))
                .expect("Cartesian XYZ payload is included");
            assert_eq!(payload.bytes.len(), 3 * 2 * std::mem::size_of::<f64>());
        }
        assert!(!artifacts.global_files.iter().any(|file| file.relative_path.contains("magnetic_response_sweep.v1")));
        assert!(!artifacts.global_files.iter().any(|file| file.relative_path.contains("magnetic_response_sweep.v2")));
        assert!(!artifacts.points.iter().flat_map(|point| &point.files).any(|file| file.relative_path.contains("unreferenced")));
        let index = artifacts.global_files.iter().find(|file| file.relative_path.ends_with("magnetic_response_sweep.v3.json")).expect("compact v3 index exists");
        assert!(index.bytes.len() as u64 <= default_limits().max_index_bytes);
        let compact_sweep: Value = serde_json::from_slice(&index.bytes).unwrap();
        let sweep_point = &compact_sweep["points"][0];
        assert_eq!(sweep_point["susceptibility_tensor"], json!([[0.25, 0.5]]));
        assert_eq!(sweep_point["susceptibility_tensor_provenance"]["response_units"], "dimensionless");
        assert_eq!(sweep_point["absorbed_power_density"], json!(0.125));
        assert_eq!(sweep_point["absorbed_power_density_provenance"]["physical_power_density"], false);
        assert!(serde_json::to_vec(sweep_point).unwrap().len() as u64 <= MAX_COMPACT_SWEEP_POINT_BYTES);
        for dense_key in ["m_complex", "component_response_amplitude", "component_response_phase"] {
            assert!(sweep_point.get(dense_key).is_none(), "compact sweep must omit dense source key {dense_key}");
        }
        let generation_member = artifacts.artifact_generation.content.members.get(&index.relative_path).expect("index is committed");
        assert_eq!(generation_member.byte_length, index.bytes.len() as u64);
        assert_eq!(generation_member.sha256, format!("sha256:{:x}", Sha256::digest(&index.bytes)));
        assert_eq!(fs::read(artifacts.published_generation_root.join(&index.relative_path)).unwrap(), index.bytes);
    }

    #[test]
    fn rejects_partial_sweep_and_owner_mismatch() {
        let (_temp, native, published) = temp_roots();
        rewrite_json(&native.join("frequency_domain/manifest.v1.json"), |manifest| {
            manifest["complete"] = json!(false);
            manifest["status"] = json!("interrupted");
        });
        expect_error_contains(&native, &published, "complete", default_limits());

        let (_temp, native, published) = temp_roots();
        rewrite_json(&native.join("frequency_domain/manifest.v1.json"), |manifest| {
            manifest["run_id"] = json!("run:other");
        });
        expect_error_contains(&native, &published, "run_id", default_limits());
    }

    #[test]
    fn rejects_frequency_order_and_residual_gate_failures() {
        let (_temp, native, published) = temp_roots();
        rewrite_json(&native.join(POINT_PATHS[0]), |point| point["frequency_hz"] = json!(2.0e9));
        expect_error_contains(&native, &published, "frequency", default_limits());

        let (_temp, native, published) = temp_roots();
        rewrite_json(&native.join(POINT_PATHS[1]), |point| point["relative_residual_l2_norm"] = json!(1.0e-3));
        expect_error_contains(&native, &published, "residual", default_limits());
    }

    #[test]
    fn rejects_unsafe_paths_casefold_aliases_and_symlinked_inputs() {
        let (_temp, native, published) = temp_roots();
        rewrite_json(&native.join("frequency_domain/manifest.v1.json"), |manifest| {
            manifest["artifacts"]["frequency_point_paths"][0] = json!("../escape.json");
        });
        expect_error_contains(&native, &published, "path", default_limits());

        let (_temp, native, published) = temp_roots();
        rewrite_json(&native.join("frequency_domain/manifest.v1.json"), |manifest| {
            manifest["artifacts"]["frequency_point_paths"][1] = json!("response/frequency_points/FREQUENCY_0000.JSON");
        });
        expect_error_contains(&native, &published, "collision", default_limits());

        #[cfg(unix)]
        {
            use std::os::unix::fs::symlink;
            let (_temp, native, published) = temp_roots();
            let point = native.join(POINT_PATHS[0]);
            let outside = native.join("outside.json");
            fs::write(&outside, fs::read(&point).unwrap()).unwrap();
            fs::remove_file(&point).unwrap();
            symlink(&outside, &point).unwrap();
            expect_error_contains(&native, &published, "link", default_limits());
        }
    }

    #[test]
    fn preflight_rejects_aggregate_overflow_before_native_solve() {
        let mut limits = default_limits();
        limits.max_peak_working_bytes = 1;
        let error = preflight_frequency_response_artifact_resources(&fixture_plan(), limits)
            .expect_err("one byte cannot cover the estimated native and publisher workset");
        assert!(error.message.contains("working"), "unexpected error: {}", error.message);

        let (_temp, native, published) = temp_roots();
        let mut limits = default_limits();
        limits.max_total_output_bytes = 1;
        expect_error_contains(&native, &published, "aggregate", limits);
    }
}
