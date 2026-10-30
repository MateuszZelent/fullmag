//! Runtime-origin target-only Airbox observation carrier for CPU FDM multilayer runs.
//!
//! The carrier is materialized after the solver has finished.  It uses the
//! final native magnetization and a separate CPU convolution oracle; it is
//! never inserted into the multilayer hot-loop runtime.

use fullmag_engine::multilayer::{
    collapse_kernel_z_plane, FdmLayerRuntime, KernelPair, MultilayerDemagRuntime,
};
use fullmag_fdm_demag::{
    compute_shifted_kernel,
    descriptors::{
        ActiveMaskIdentity, CommonTransformLayout, ConvolutionMode, FdmLayerDescriptor,
        GridGeometry,
    },
    TransferBoundaryPolicy, TransferKind,
};
use fullmag_ir::{FdmMultilayerPlanIR, ProblemIR};
use serde_json::{json, Value};
use sha2::{Digest, Sha256};

use crate::{
    artifacts::build_identity_json,
    types::{AuxiliaryArtifact, ExecutedRun},
};

const OBSERVATION_SCHEMA: &str = "fdm_multilayer_observation.v2";
const OBSERVATION_FIELD_SCHEMA: &str = "fdm_multilayer_observation_field.v1";
const H_DEMAG_FIELD_ARTIFACT: &str = "H_demag.samples.v1.json";
const H_EFF_FIELD_ARTIFACT: &str = "H_eff.samples.v1.json";
const H_EFF_UNAVAILABLE_STATIC_FIELD_MAP: &str =
    "fdm_multilayer_airbox_h_eff_static_field_map_unrepresented.v1";
const H_EFF_UNAVAILABLE_OERSTED: &str =
    "fdm_multilayer_airbox_h_eff_oersted_source_unrepresented.v1";
const H_EFF_UNAVAILABLE_FIELD_DRIVE: &str =
    "fdm_multilayer_airbox_h_eff_regional_field_drive_unrepresented.v1";
const H_EFF_UNAVAILABLE_CURRENT_SOURCE: &str =
    "fdm_multilayer_airbox_h_eff_current_source_graph_unrepresented.v1";
const H_EFF_UNAVAILABLE_ANTENNA_SOURCE: &str =
    "fdm_multilayer_airbox_h_eff_antenna_source_graph_unrepresented.v1";
const H_EFF_UNAVAILABLE_DYNAMIC_FIELD: &str =
    "fdm_multilayer_airbox_h_eff_dynamic_field_schedule_unrepresented.v1";
const H_EFF_UNAVAILABLE_COUPLING: &str =
    "fdm_multilayer_airbox_h_eff_active_coupling_unrepresented.v1";
const H_EFF_UNAVAILABLE_ENERGY_TERM: &str =
    "fdm_multilayer_airbox_h_eff_energy_term_unrepresented.v1";
const H_EFF_UNAVAILABLE_PLAN_MISMATCH: &str =
    "fdm_multilayer_airbox_h_eff_uniform_zeeman_plan_mismatch.v1";
const MU0: f64 = 4.0 * std::f64::consts::PI * 1e-7;

#[derive(Debug, Clone, PartialEq)]
pub(crate) struct AirboxObservationTarget {
    pub(crate) shape: [usize; 3],
    pub(crate) spacing_m: [f64; 3],
    pub(crate) origin_m: [f64; 3],
    pub(crate) padding_cells_above_below: [usize; 2],
    pub(crate) source_shape: [usize; 3],
    pub(crate) source_spacing_m: [f64; 3],
}

impl AirboxObservationTarget {
    /// Build a target-only grid around one magnetic support.  This helper is
    /// used by the contract tests to prove that padding changes only the
    /// observation layout, not the native/common magnetic source grid.
    #[cfg(test)]
    pub(crate) fn from_support(
        source_shape: [usize; 3],
        source_spacing_m: [f64; 3],
        source_origin_m: [f64; 3],
        padding_cells_above_below: [usize; 2],
    ) -> Result<Self, String> {
        validate_grid("source", source_shape, source_spacing_m, source_origin_m)?;
        if padding_cells_above_below.contains(&0) {
            return Err("Airbox padding must contain positive cell counts".to_string());
        }
        let z_cells = source_shape[2]
            .checked_add(padding_cells_above_below[0])
            .and_then(|value| value.checked_add(padding_cells_above_below[1]))
            .ok_or_else(|| "Airbox target z cell count overflows usize".to_string())?;
        Ok(Self {
            shape: [source_shape[0], source_shape[1], z_cells],
            spacing_m: source_spacing_m,
            origin_m: [
                source_origin_m[0],
                source_origin_m[1],
                source_origin_m[2] - padding_cells_above_below[1] as f64 * source_spacing_m[2],
            ],
            padding_cells_above_below,
            source_shape,
            source_spacing_m,
        })
    }

    pub(crate) fn from_runtime_metadata(value: &Value) -> Result<Self, String> {
        let object = value
            .as_object()
            .ok_or_else(|| "runtime_metadata.airbox_observation must be an object".to_string())?;
        if object.get("target_only").and_then(Value::as_bool) != Some(true) {
            return Err("Airbox observation requires target_only=true".to_string());
        }
        if object.get("scope_kind").and_then(Value::as_str) != Some("airbox") {
            return Err("Airbox observation requires scope_kind=airbox".to_string());
        }
        let shape = parse_usize3(object.get("cells"), "cells")?;
        let spacing_m = parse_finite3(object.get("spacing_m"), "spacing_m", true)?;
        let origin_m = parse_finite3(object.get("origin_m"), "origin_m", false)?;
        let padding = object
            .get("padding_cells_above_below")
            .map(parse_usize2)
            .transpose()?
            .unwrap_or([0, 0]);
        Ok(Self {
            shape,
            spacing_m,
            origin_m,
            padding_cells_above_below: padding,
            source_shape: [0; 3],
            source_spacing_m: [0.0; 3],
        })
    }

    fn from_study_universe(value: &Value, plan: &FdmMultilayerPlanIR) -> Result<Self, String> {
        let object = value
            .as_object()
            .ok_or_else(|| "runtime_metadata.study_universe must be an object".to_string())?;
        let mode = match object.get("mode") {
            None | Some(Value::Null) => "auto",
            Some(Value::String(mode)) => mode.as_str(),
            Some(_) => return Err("Airbox target study universe mode must be a string".into()),
        };
        let mode = if mode == "box" { "manual" } else { mode };
        if !matches!(mode, "manual" | "auto") {
            return Err(format!(
                "Airbox target cannot use unsupported study universe mode '{mode}'"
            ));
        }
        let size = parse_finite3(object.get("size"), "study_universe.size", true)?;
        let center = match object.get("center") {
            None | Some(Value::Null) => [0.0; 3],
            Some(value) => parse_finite3(Some(value), "study_universe.center", false)?,
        };

        let first_layer = plan
            .layers
            .first()
            .ok_or_else(|| "Airbox observation requires at least one source layer".to_string())?;
        let spacing_m = first_layer.convolution_cell_size;
        if plan
            .layers
            .iter()
            .any(|layer| layer.convolution_cell_size != spacing_m)
        {
            return Err(
                "Airbox target requires one immutable common convolution cell size".to_string(),
            );
        }
        validate_grid("planned common convolution", [1; 3], spacing_m, [0.0; 3])?;

        let mut shape = [0usize; 3];
        let mut grid = [0u32; 3];
        for axis in 0..3 {
            let cells = size[axis] / spacing_m[axis];
            if !cells.is_finite() || cells < 1.0 || cells > f64::from(u32::MAX) {
                return Err(format!(
                    "Airbox target study universe size[{axis}] is outside the supported common-cell grid range"
                ));
            }
            let nearest = cells.round();
            let rounded_extent = nearest * spacing_m[axis];
            let tolerance = 8.0
                * f64::EPSILON
                * size[axis]
                    .abs()
                    .max(rounded_extent.abs())
                    .max(spacing_m[axis].abs());
            if nearest < 1.0
                || !rounded_extent.is_finite()
                || (size[axis] - rounded_extent).abs() > tolerance
            {
                return Err(format!(
                    "Airbox target study universe size[{axis}] is not an integer multiple of the planned common convolution cell size within floating-point roundoff"
                ));
            }
            grid[axis] = nearest as u32;
            shape[axis] = usize::try_from(grid[axis]).map_err(|_| {
                format!("Airbox target cell count on axis {axis} is not addressable")
            })?;
        }
        fullmag_plan::checked_fdm_grid_cost(grid, fullmag_plan::FDM_GRID_ESTIMATED_BYTES_PER_CELL)
            .map_err(|error| {
                format!("Airbox derived target grid budget rejected before allocation: {error}")
            })?;
        let origin_m = [
            center[0] - size[0] / 2.0,
            center[1] - size[1] / 2.0,
            center[2] - size[2] / 2.0,
        ];
        validate_grid("derived target", shape, spacing_m, origin_m)?;
        Ok(Self {
            shape,
            spacing_m,
            origin_m,
            padding_cells_above_below: [0, 0],
            source_shape: [0; 3],
            source_spacing_m: [0.0; 3],
        })
    }
}

/// Materialize the optional CPU target-only carrier from an executed run.
///
/// No per-layer field sample is consumed here.  The final native
/// magnetization is projected to the target grid and evaluated by a separate
/// `MultilayerDemagRuntime` containing only source→target kernel pairs.
pub(crate) fn materialize_airbox_observation(
    problem: &ProblemIR,
    plan: &FdmMultilayerPlanIR,
    executed: &ExecutedRun,
) -> Result<Vec<AuxiliaryArtifact>, String> {
    let Some(target) = airbox_observation_target(problem, plan)? else {
        return Ok(Vec::new());
    };
    if !executed
        .provenance
        .execution_engine
        .contains("cpu_reference_multilayer")
    {
        return Ok(Vec::new());
    }
    if executed.provenance.precision != "double" {
        return Err("Airbox observation carrier requires CPU FP64 provenance".to_string());
    }
    if !plan.enable_demag {
        return Err("Airbox observation requires demagnetization enabled".to_string());
    }
    let field = compute_target_field(plan, &target, &executed.result.final_magnetization)?;
    let build_identity = build_identity_json();
    let source_runtime_identity = json!({
        "execution_engine": executed.provenance.execution_engine,
        "precision": executed.provenance.precision,
        "demag_operator_kind": executed.provenance.demag_operator_kind,
        "fft_backend": executed.provenance.fft_backend,
        "problem_source_hash": problem.problem_meta.source_hash,
        "run_status": executed.result.status,
        "build_identity": build_identity,
    });
    build_airbox_observation_artifacts(problem, plan, &target, &field, source_runtime_identity)
}

/// Resolve the immutable target-only Airbox descriptor shared by CPU and GPU
/// materializers.  The source support summary is retained for manifest
/// provenance; it does not alter the configured target grid.
pub(crate) fn airbox_observation_target(
    problem: &ProblemIR,
    plan: &FdmMultilayerPlanIR,
) -> Result<Option<AirboxObservationTarget>, String> {
    let runtime_metadata = &problem.problem_meta.runtime_metadata;
    let mut target = if let Some(metadata) = runtime_metadata.get("airbox_observation") {
        AirboxObservationTarget::from_runtime_metadata(metadata)?
    } else if let Some(universe) = runtime_metadata.get("study_universe") {
        let Some(object) = universe.as_object() else {
            return Ok(None);
        };
        if !object.get("size").is_some_and(|size| !size.is_null()) {
            return Ok(None);
        }
        AirboxObservationTarget::from_study_universe(universe, plan)?
    } else {
        return Ok(None);
    };
    let (source_shape, source_spacing) = source_grid_summary(plan)?;
    target.source_shape = source_shape;
    target.source_spacing_m = source_spacing;
    validate_grid("target", target.shape, target.spacing_m, target.origin_m)?;
    Ok(Some(target))
}

pub(crate) fn airbox_observation_requested(problem: &ProblemIR) -> bool {
    let runtime_metadata = &problem.problem_meta.runtime_metadata;
    runtime_metadata.contains_key("airbox_observation")
        || runtime_metadata
            .get("study_universe")
            .and_then(Value::as_object)
            .and_then(|object| object.get("size"))
            .is_some_and(|size| !size.is_null())
}

/// Encode target-only fields and per-quantity manifests after either a CPU or
/// native GPU field evaluator has produced exact target-grid samples. This
/// keeps source mappings, hashes, artifact paths, and unavailable-scope
/// semantics identical between execution engines.
pub(crate) fn build_airbox_observation_artifacts(
    problem: &ProblemIR,
    plan: &FdmMultilayerPlanIR,
    target: &AirboxObservationTarget,
    h_demag: &[[f64; 3]],
    mut source_runtime_identity: Value,
) -> Result<Vec<AuxiliaryArtifact>, String> {
    validate_grid("target", target.shape, target.spacing_m, target.origin_m)?;
    let expected_samples = target
        .shape
        .iter()
        .try_fold(1usize, |count, value| count.checked_mul(*value))
        .ok_or_else(|| "Airbox target cell count overflows usize".to_string())?;
    if h_demag.len() != expected_samples {
        return Err(format!(
            "Airbox target H_demag has {} samples, expected {expected_samples}",
            h_demag.len()
        ));
    }
    if h_demag.iter().flatten().any(|value| !value.is_finite()) {
        return Err("Airbox target H_demag contains nonfinite values".to_string());
    }
    let identity = source_runtime_identity.as_object_mut()
        .ok_or_else(|| "Airbox runtime identity must be an object".to_string())?;
    if identity.get("problem_source_hash").and_then(Value::as_str)
        .is_none_or(|value| value.is_empty()) {
        // UI-authored problems need not originate from a Python file. Bind
        // their actual IR instead of emitting null or an invented script hash.
        let problem_value = serde_json::to_value(problem)
            .map_err(|error| format!("Airbox ProblemIR identity serialization failed: {error}"))?;
        identity.insert("problem_source_hash".into(), json!(format!("sha256:{}",
            fullmag_session::canonical_json_sha256(&problem_value))));
        identity.insert("problem_source_hash_origin".into(), json!("canonical_problem_ir"));
    } else {
        identity.insert("problem_source_hash_origin".into(), json!("authored_source"));
    }
    identity.insert("observation_boundary_policy".into(), json!("open"));
    let source_grid_fingerprints = plan
        .layers
        .iter()
        .map(source_grid_fingerprint)
        .collect::<Result<Vec<_>, _>>()?;
    let build_identity = build_identity_json();
    let target_grid = json!({
        "cells": target.shape,
        "origin_m": target.origin_m,
        "cell_size_m": target.spacing_m,
    });
    let source_common_grid = plan.layers.first().map(|layer| {
        json!({
            "cells": plan.common_cells,
            "cell_size_m": layer.convolution_cell_size,
            "origin_m": layer.convolution_origin,
        })
    });
    let carrier_seed = json!({
        "schema_version": OBSERVATION_SCHEMA,
        "scope_kind": "airbox",
        "source_policy": "target_only",
        "grid": target_grid,
        "source_grid_fingerprints": source_grid_fingerprints,
        "source_common_grid": source_common_grid,
        "source_runtime_identity": source_runtime_identity,
    });
    let carrier_seed_bytes = serde_json::to_vec(&carrier_seed)
        .map_err(|error| format!("Airbox carrier fingerprint serialization failed: {error}"))?;
    let carrier_fingerprint = sha256_hex(&carrier_seed_bytes);
    let carrier_revision = sha256_hex_revision(&carrier_fingerprint)?;
    let h_eff_unavailable = airbox_h_eff_unavailable_reason(problem, plan);
    let h_eff = if h_eff_unavailable.is_none() {
        Some(compose_airbox_h_eff(plan, h_demag)?)
    } else {
        None
    };
    let published_quantities = if h_eff.is_some() {
        vec!["H_demag", "H_eff"]
    } else {
        vec!["H_demag"]
    };
    let unavailable_quantities = h_eff_unavailable
        .map(|reason| json!({ "H_eff": reason }))
        .unwrap_or_else(|| json!({}));
    let mut quantity_fields = vec![("H_demag", H_DEMAG_FIELD_ARTIFACT, h_demag)];
    if let Some(h_eff) = h_eff.as_deref() {
        quantity_fields.push(("H_eff", H_EFF_FIELD_ARTIFACT, h_eff));
    }

    let mut artifacts = Vec::with_capacity(quantity_fields.len() * 2);
    for (quantity_id, field_artifact, values) in quantity_fields {
        let field_payload = json!({
            "schema_version": OBSERVATION_FIELD_SCHEMA,
            "observable": quantity_id,
            "quantity_id": quantity_id,
            "unit": "A/m",
            "scope_kind": "airbox",
            "build_identity": build_identity,
            "grid": target_grid,
            "values": values,
        });
        // Compact JSON: indentation of millions of vector samples tripled the
        // artifact (308 MB for a 3.45 M-cell target grid) and its hashing time.
        let field_bytes = serde_json::to_vec(&field_payload)
            .map_err(|error| format!("Airbox {quantity_id} field serialization failed: {error}"))?;
        let field_hash = sha256_hex(&field_bytes);
        let field_generation_seed = json!({
            "schema_version": OBSERVATION_SCHEMA,
            "scope_kind": "airbox",
            "quantity_id": quantity_id,
            "source_policy": "target_only",
            "grid": target_grid,
            "source_grid_fingerprints": source_grid_fingerprints,
            "source_common_grid": source_common_grid,
            "source_runtime_identity": source_runtime_identity,
            "field_artifact_sha256": field_hash,
        });
        let field_generation_bytes = serde_json::to_vec(&field_generation_seed)
            .map_err(|error| format!("Airbox {quantity_id} field-generation serialization failed: {error}"))?;
        let field_generation_fingerprint = sha256_hex(&field_generation_bytes);
        // Both quantities share one target/source topology carrier. Each
        // field generation remains content-addressed to its own values.
        let quantity_revision = 1u64;
        let field_generation = format!("airbox:sha256:{field_generation_fingerprint}");
        let grid_revision = content_revision(
            &serde_json::to_vec(&target_grid)
                .map_err(|error| format!("Airbox grid revision serialization failed: {error}"))?,
        );
        let manifest = json!({
            "schema_version": OBSERVATION_SCHEMA,
            "scope_kind": "airbox",
            "quantity_id": quantity_id,
            "unit": "A/m",
            "build_identity": build_identity,
            "source_policy": "target_only",
            "target_only": true,
            "grid": target_grid,
            "padding_cells_above_below": target.padding_cells_above_below,
            "carrier_fingerprint": carrier_fingerprint,
            "source_grid_fingerprints": source_grid_fingerprints,
            "source_common_grid": source_common_grid,
            "source_runtime_identity": source_runtime_identity,
            "quantity_revision": quantity_revision,
            "grid_revision": grid_revision,
            "carrier_revision": carrier_revision,
            "field_generation": field_generation,
            "field_artifact": field_artifact,
            "field_artifact_sha256": field_hash,
            "sample_count": values.len(),
            "published_quantities": published_quantities,
            "unavailable_quantities": unavailable_quantities,
        });
        let manifest_bytes = serde_json::to_vec_pretty(&manifest)
            .map_err(|error| format!("Airbox {quantity_id} manifest serialization failed: {error}"))?;
        artifacts.push(AuxiliaryArtifact {
            relative_path: format!("fields/{quantity_id}/airbox/manifest.json"),
            bytes: manifest_bytes,
        });
        artifacts.push(AuxiliaryArtifact {
            relative_path: format!("fields/{quantity_id}/airbox/{field_artifact}"),
            bytes: field_bytes,
        });
    }
    Ok(artifacts)
}

/// Airbox H_eff is the demagnetizing field plus the resolved uniform Zeeman
/// field. Interactions confined to magnetic support do not contribute to this
/// exterior visualization. Refuse composition when ProblemIR declares an
/// additional field source that FdmMultilayerPlanIR cannot represent.
fn airbox_h_eff_unavailable_reason(
    problem: &ProblemIR,
    plan: &FdmMultilayerPlanIR,
) -> Option<&'static str> {
    use fullmag_ir::EnergyTermIR;

    if !problem.field_drives.is_empty() {
        return Some(H_EFF_UNAVAILABLE_FIELD_DRIVE);
    }
    if problem
        .energy_terms
        .iter()
        .any(|term| matches!(term, EnergyTermIR::StaticFieldMap { .. }))
    {
        return Some(H_EFF_UNAVAILABLE_STATIC_FIELD_MAP);
    }
    if problem.energy_terms.iter().any(|term| {
        matches!(
            term,
            EnergyTermIR::OerstedCylinder { .. } | EnergyTermIR::OerstedField { .. }
        )
    }) {
        return Some(H_EFF_UNAVAILABLE_OERSTED);
    }
    if !problem.antenna_port_modes.is_empty()
        || !problem.antenna_field_solve_stages.is_empty()
        || !problem.antenna_target_projections.is_empty()
        || !problem.solved_antenna_drives.is_empty()
        || !problem.antenna_spectrum_requests.is_empty()
        || problem.excitation_analysis.is_some()
        || matches!(&problem.study, fullmag_ir::StudyIR::AntennaFieldSolve { .. })
    {
        return Some(H_EFF_UNAVAILABLE_ANTENNA_SOURCE);
    }
    if !problem.current_modules.is_empty()
        || !problem.spin_transport_modules.is_empty()
        || !problem.spin_torque_modules.is_empty()
        || problem.current_density.is_some()
        || problem.stt_degree.is_some()
        || problem.stt_beta.is_some()
        || problem.stt_spin_polarization.is_some()
        || problem.stt_lambda.is_some()
        || problem.stt_epsilon_prime.is_some()
        || problem.stt_thickness.is_some()
        || problem.stt_fixed_layer_position.is_some()
    {
        return Some(H_EFF_UNAVAILABLE_CURRENT_SOURCE);
    }
    if problem.couplings.iter().any(|coupling| coupling.enabled) {
        return Some(H_EFF_UNAVAILABLE_COUPLING);
    }
    if matches!(
        &problem.study,
        fullmag_ir::StudyIR::Hysteresis { .. }
            | fullmag_ir::StudyIR::Eigenmodes { .. }
            | fullmag_ir::StudyIR::FrequencyResponse { .. }
    ) {
        return Some(H_EFF_UNAVAILABLE_DYNAMIC_FIELD);
    }

    let mut authored_zeeman = None;
    for term in &problem.energy_terms {
        match term {
            EnergyTermIR::Exchange
            | EnergyTermIR::ThermalNoise { .. }
            | EnergyTermIR::Demag { .. }
            | EnergyTermIR::InterfacialDmi { .. }
            | EnergyTermIR::RotatedInterfacialDmi { .. }
            | EnergyTermIR::BulkDmi { .. } => {}
            EnergyTermIR::Zeeman { b } => {
                if authored_zeeman.replace(*b).is_some() {
                    return Some(H_EFF_UNAVAILABLE_PLAN_MISMATCH);
                }
            }
            EnergyTermIR::StaticFieldMap { .. } => {
                return Some(H_EFF_UNAVAILABLE_STATIC_FIELD_MAP);
            }
            EnergyTermIR::OerstedCylinder { .. } | EnergyTermIR::OerstedField { .. } => {
                return Some(H_EFF_UNAVAILABLE_OERSTED);
            }
            _ => return Some(H_EFF_UNAVAILABLE_ENERGY_TERM),
        }
    }
    let authored_external_field = authored_zeeman.map(|b| b.map(|component| component / MU0));
    if authored_external_field != plan.external_field
        || plan
            .external_field
            .is_some_and(|field| field.iter().any(|component| !component.is_finite()))
    {
        return Some(H_EFF_UNAVAILABLE_PLAN_MISMATCH);
    }
    None
}

fn compose_airbox_h_eff(
    plan: &FdmMultilayerPlanIR,
    h_demag: &[[f64; 3]],
) -> Result<Vec<[f64; 3]>, String> {
    let external_field = plan.external_field.unwrap_or([0.0; 3]);
    let h_eff = h_demag
        .iter()
        .map(|field| {
            [
                field[0] + external_field[0],
                field[1] + external_field[1],
                field[2] + external_field[2],
            ]
        })
        .collect::<Vec<_>>();
    if h_eff.iter().flatten().any(|value| !value.is_finite()) {
        return Err("Airbox target H_eff contains nonfinite values".to_string());
    }
    Ok(h_eff)
}

/// Materialize an on-demand Airbox carrier from the current planned
/// multilayer state. The CLI rewrites each layer's initial state from the
/// terminal continuation before requesting this snapshot.
pub(crate) fn materialize_airbox_observation_snapshot(
    problem: &ProblemIR,
    plan: &FdmMultilayerPlanIR,
) -> Result<Vec<AuxiliaryArtifact>, String> {
    if plan.precision != fullmag_ir::ExecutionPrecision::Double {
        return Err("Airbox observation carrier requires CPU FP64 plan precision".to_string());
    }
    let final_magnetization = plan
        .layers
        .iter()
        .flat_map(|layer| layer.initial_magnetization.iter().copied())
        .collect::<Vec<_>>();
    let mut provenance = crate::types::ExecutionProvenance::default();
    provenance.execution_engine = "cpu_reference_multilayer".to_string();
    provenance.precision = "double".to_string();
    provenance.demag_operator_kind = plan
        .enable_demag
        .then(|| "multilayer_tensor_fft_newell".to_string());
    provenance.fdm_fft_execution =
        super::reference::resolve_cpu_fft_execution_for_demag(plan.enable_demag, plan.fft.as_ref())
            .map_err(|error| error.to_string())?;
    provenance.fft_backend = provenance
        .fdm_fft_execution
        .as_ref()
        .map(|execution| execution.executed_backend.clone());
    let executed = ExecutedRun {
        result: crate::types::RunResult {
            status: crate::types::RunStatus::Completed,
            steps: Vec::new(),
            final_magnetization: final_magnetization.clone(),
            completion: None,
        },
        initial_magnetization: final_magnetization,
        field_snapshots: Vec::new(),
        field_snapshot_count: 0,
        auxiliary_artifacts: Vec::new(),
        provenance,
    };
    materialize_airbox_observation(problem, plan, &executed)
}

fn compute_target_field(
    plan: &FdmMultilayerPlanIR,
    target: &AirboxObservationTarget,
    final_magnetization: &[[f64; 3]],
) -> Result<Vec<[f64; 3]>, String> {
    let mode = if target.shape[2] == 1 {
        ConvolutionMode::TwoDStack
    } else {
        ConvolutionMode::ThreeD
    };
    let target_geometry = GridGeometry::new(target.origin_m, target.shape, target.spacing_m)
        .map_err(|error| format!("Airbox target geometry: {error}"))?;
    let target_cell_count = target_geometry.cell_count();
    let expected_native_cells = plan
        .layers
        .iter()
        .map(|layer| checked_cell_count(layer.native_grid))
        .collect::<Result<Vec<_>, _>>()?;
    let expected_total = expected_native_cells.iter().sum::<usize>();
    if final_magnetization.len() != expected_total {
        return Err(format!(
            "final native magnetization has {} cells, expected {expected_total}",
            final_magnetization.len()
        ));
    }

    let mut descriptors = Vec::with_capacity(plan.layers.len() + 1);
    let mut layers = Vec::with_capacity(plan.layers.len() + 1);
    let mut offset = 0usize;
    for (index, (layer, native_cells)) in plan.layers.iter().zip(expected_native_cells).enumerate()
    {
        let native = GridGeometry::new(
            layer.native_origin,
            layer.native_grid.map(|value| value as usize),
            layer.native_cell_size,
        )
        .map_err(|error| format!("native layer {} geometry: {error}", layer.layer_id))?;
        let active_mask = layer
            .native_active_mask
            .as_deref()
            .map(ActiveMaskIdentity::from_mask)
            .unwrap_or_else(ActiveMaskIdentity::all_active);
        let transfer_kind = if native == target_geometry {
            TransferKind::Identity
        } else {
            TransferKind::PushPull
        };
        descriptors.push(
            FdmLayerDescriptor::new(
                layer.layer_id.clone(),
                layer.object_id.clone(),
                native.clone(),
                target_geometry.clone(),
                mode,
                active_mask,
                transfer_kind,
            )
            .map_err(|error| format!("observation descriptor {}: {error}", layer.layer_id))?,
        );
        let m = final_magnetization[offset..offset + native_cells].to_vec();
        offset += native_cells;
        layers.push(FdmLayerRuntime {
            magnet_name: layer.magnet_name.clone(),
            grid: native.shape,
            cell_size: native.spacing,
            origin: native.origin,
            ms: layer.material.saturation_magnetisation,
            ms_field: layer.material.ms_field.clone(),
            exchange_stiffness: layer.material.exchange_stiffness,
            damping: layer.material.damping,
            active_mask: layer.native_active_mask.clone(),
            m,
            h_ex: vec![[0.0; 3]; native_cells],
            h_demag: vec![[0.0; 3]; native_cells],
            h_eff: vec![[0.0; 3]; native_cells],
            conv_grid: target.shape,
            conv_cell_size: target.spacing_m,
            needs_transfer: transfer_kind == TransferKind::PushPull,
            transfer_boundary_policy: TransferBoundaryPolicy::OPEN,
        });
        let _ = index;
    }

    let target_descriptor = FdmLayerDescriptor::new(
        "airbox-observation",
        "airbox",
        target_geometry.clone(),
        target_geometry,
        mode,
        ActiveMaskIdentity::all_active(),
        TransferKind::Identity,
    )
    .map_err(|error| format!("Airbox target descriptor: {error}"))?;
    descriptors.push(target_descriptor);
    layers.push(FdmLayerRuntime {
        magnet_name: "airbox-observation".to_string(),
        grid: target.shape,
        cell_size: target.spacing_m,
        origin: target.origin_m,
        ms: 1.0,
        ms_field: None,
        exchange_stiffness: 0.0,
        damping: 0.0,
        active_mask: None,
        m: vec![[0.0; 3]; target_cell_count],
        h_ex: vec![[0.0; 3]; target_cell_count],
        h_demag: vec![[0.0; 3]; target_cell_count],
        h_eff: vec![[0.0; 3]; target_cell_count],
        conv_grid: target.shape,
        conv_cell_size: target.spacing_m,
        needs_transfer: false,
        transfer_boundary_policy: TransferBoundaryPolicy::OPEN,
    });

    let fft_shape = if mode == ConvolutionMode::TwoDStack {
        [target.shape[0] * 2, target.shape[1] * 2, 1]
    } else {
        [
            target.shape[0] * 2,
            target.shape[1] * 2,
            target.shape[2] * 2,
        ]
    };
    let inverse_normalization = 1.0 / (fft_shape[0] * fft_shape[1] * fft_shape[2]) as f64;
    let layout = CommonTransformLayout::for_pair(
        target.shape,
        target.shape,
        mode,
        [0; 3],
        [0; 3],
        [0; 3],
        target.shape,
        fft_shape,
        inverse_normalization,
    )
    .map_err(|error| format!("Airbox transform layout: {error}"))?;
    let target_index = plan.layers.len();
    let base_kernel = compute_shifted_kernel(target.shape, target.spacing_m, 0.0);
    let base_kernel = if mode == ConvolutionMode::TwoDStack {
        collapse_kernel_z_plane(base_kernel)
            .map_err(|error| format!("Airbox two-dimensional kernel: {error}"))?
    } else {
        base_kernel
    };
    let kernel_pairs = (0..target_index)
        .map(|src_layer| KernelPair {
            src_layer,
            dst_layer: target_index,
            kernel: base_kernel.clone(),
        })
        .collect();
    let runtime = MultilayerDemagRuntime::new_with_layout_and_descriptors(
        kernel_pairs,
        target.shape,
        target.spacing_m,
        layout,
        descriptors,
    )?;
    runtime.compute_demag_fields_checked(&mut layers)?;
    Ok(layers
        .pop()
        .expect("target layer is always appended")
        .h_demag)
}

pub(crate) fn source_grid_summary(
    plan: &FdmMultilayerPlanIR,
) -> Result<([usize; 3], [f64; 3]), String> {
    let Some(first) = plan.layers.first() else {
        return Err("Airbox observation requires at least one source layer".to_string());
    };
    Ok((
        first.native_grid.map(|value| value as usize),
        first.native_cell_size,
    ))
}

pub(crate) fn source_grid_fingerprint(
    layer: &fullmag_ir::FdmLayerPlanIR,
) -> Result<String, String> {
    let payload = serde_json::to_vec(&json!({
        "layer_id": layer.layer_id,
        "object_id": layer.object_id,
        "cells": layer.native_grid,
        "cell_size_m": layer.native_cell_size,
        "origin_m": layer.native_origin,
        "active_mask": layer.native_active_mask,
    }))
    .map_err(|error| format!("source grid fingerprint serialization failed: {error}"))?;
    Ok(sha256_hex(&payload))
}

fn sha256_hex(bytes: &[u8]) -> String {
    let mut hasher = Sha256::new();
    hasher.update(bytes);
    format!("{:x}", hasher.finalize())
}

fn content_revision(bytes: &[u8]) -> u64 {
    let digest = Sha256::digest(bytes);
    u64::from_be_bytes(digest[..8].try_into().expect("sha256 prefix")).max(1)
}

fn sha256_hex_revision(value: &str) -> Result<u64, String> {
    if value.len() != 64 || !value.bytes().all(|byte| byte.is_ascii_hexdigit()) {
        return Err("carrier fingerprint is not canonical sha256 hex".to_string());
    }
    u64::from_str_radix(&value[..16], 16)
        .map(|revision| revision.max(1))
        .map_err(|error| format!("carrier revision parse failed: {error}"))
}

fn checked_cell_count(shape: [u32; 3]) -> Result<usize, String> {
    usize::try_from(u64::from(shape[0]) * u64::from(shape[1]) * u64::from(shape[2]))
        .map_err(|_| format!("grid {:?} is not addressable", shape))
}

fn validate_grid(
    label: &str,
    shape: [usize; 3],
    spacing_m: [f64; 3],
    origin_m: [f64; 3],
) -> Result<(), String> {
    if shape.contains(&0) {
        return Err(format!("{label} grid must contain positive cell counts"));
    }
    if spacing_m
        .iter()
        .any(|value| !value.is_finite() || *value <= 0.0)
    {
        return Err(format!("{label} spacing must be finite and positive"));
    }
    if origin_m.iter().any(|value| !value.is_finite()) {
        return Err(format!("{label} origin must contain finite coordinates"));
    }
    Ok(())
}

fn parse_usize3(value: Option<&Value>, label: &str) -> Result<[usize; 3], String> {
    let values = value
        .and_then(Value::as_array)
        .ok_or_else(|| format!("Airbox observation {label} must be a three-element array"))?;
    if values.len() != 3 {
        return Err(format!(
            "Airbox observation {label} must have three elements"
        ));
    }
    let mut output = [0usize; 3];
    for (index, value) in values.iter().enumerate() {
        let number = value
            .as_u64()
            .ok_or_else(|| format!("Airbox observation {label}[{index}] must be an integer"))?;
        output[index] = usize::try_from(number)
            .map_err(|_| format!("Airbox observation {label}[{index}] is too large"))?;
    }
    Ok(output)
}

fn parse_usize2(value: &Value) -> Result<[usize; 2], String> {
    let values = value
        .as_array()
        .ok_or_else(|| "Airbox observation padding must be an array".to_string())?;
    if values.len() != 2 {
        return Err("Airbox observation padding must have two elements".to_string());
    }
    let mut output = [0usize; 2];
    for (index, value) in values.iter().enumerate() {
        output[index] =
            usize::try_from(value.as_u64().ok_or_else(|| {
                format!("Airbox observation padding[{index}] must be an integer")
            })?)
            .map_err(|_| format!("Airbox observation padding[{index}] is too large"))?;
    }
    Ok(output)
}

fn parse_finite3(value: Option<&Value>, label: &str, positive: bool) -> Result<[f64; 3], String> {
    let values = value
        .and_then(Value::as_array)
        .ok_or_else(|| format!("Airbox observation {label} must be a three-element array"))?;
    if values.len() != 3 {
        return Err(format!(
            "Airbox observation {label} must have three elements"
        ));
    }
    let mut output = [0.0; 3];
    for (index, value) in values.iter().enumerate() {
        let number = value
            .as_f64()
            .ok_or_else(|| format!("Airbox observation {label}[{index}] must be numeric"))?;
        if !number.is_finite() || (positive && number <= 0.0) {
            return Err(format!("Airbox observation {label}[{index}] is invalid"));
        }
        output[index] = number;
    }
    Ok(output)
}

#[cfg(test)]
mod tests {
    use super::{
        compute_target_field, content_revision, materialize_airbox_observation,
        materialize_airbox_observation_snapshot, sha256_hex, sha256_hex_revision,
        AirboxObservationTarget, H_DEMAG_FIELD_ARTIFACT, H_EFF_FIELD_ARTIFACT,
        H_EFF_UNAVAILABLE_STATIC_FIELD_MAP,
    };
    use crate::{
        types::{ExecutedRun, ExecutionProvenance, RunResult, RunStatus},
        AuxiliaryArtifact,
    };
    use fullmag_ir::{
        ExchangeBoundaryCondition, ExecutionPrecision, FdmLayerPlanIR, FdmMaterialIR,
        FdmMultilayerPlanIR, FdmMultilayerSummaryIR, IntegratorChoice, ProblemIR,
    };
    use serde_json::json;

    fn tiny_plan() -> FdmMultilayerPlanIR {
        let layer = FdmLayerPlanIR {
            magnet_name: "layer".to_string(),
            layer_id: "layer:layer".to_string(),
            object_id: "layer".to_string(),
            native_grid: [2, 2, 1],
            native_cell_size: [1.0e-9, 1.0e-9, 1.0e-9],
            native_origin: [0.0, 0.0, 0.0],
            native_active_mask: None,
            native_region_mask: None,
            native_region_legend: None,
            initial_magnetization: vec![[1.0, 0.0, 0.0]; 4],
            material: FdmMaterialIR {
                saturation_magnetisation: 8.0e5,
                exchange_stiffness: 1.3e-11,
                damping: 0.02,
                ..Default::default()
            },
            convolution_grid: [2, 2, 1],
            convolution_cell_size: [1.0e-9, 1.0e-9, 1.0e-9],
            convolution_origin: [0.0, 0.0, 0.0],
            transfer_kind: "identity".to_string(),
        };
        FdmMultilayerPlanIR {
            mode: "three_d".to_string(),
            common_cells: [2, 2, 1],
            requested_common_cell_size: None,
            grid_certificate: None,
            layers: vec![layer],
            frozen_spins: None,
            enable_exchange: true,
            enable_demag: true,
            fft: None,
            external_field: None,
            interfacial_dmi: None,
            rotated_interfacial_dmi: None,
            bulk_dmi: None,
            gyromagnetic_ratio: 2.211e5,
            precision: ExecutionPrecision::Double,
            precision_policy: fullmag_ir::FdmPrecisionPolicyIR::default(),
            exchange_bc: ExchangeBoundaryCondition::Neumann,
            periodicity: None,
            resolved_periodic_images: None,
            integrator: IntegratorChoice::Heun,
            fixed_timestep: Some(1.0e-13),
            field_refresh: None,
            relaxation: None,
            planner_summary: FdmMultilayerSummaryIR {
                requested_strategy: "multilayer_convolution".to_string(),
                selected_strategy: "multilayer_convolution".to_string(),
                requested_mode: "three_d".to_string(),
                resolved_mode: "three_d".to_string(),
                eligibility: "eligible".to_string(),
                estimated_pair_kernels: 1,
                estimated_unique_kernels: 1,
                estimated_kernel_bytes: 1,
                warnings: Vec::new(),
            },
        }
    }

    #[test]
    fn padding_changes_only_target_layout() {
        let source_shape = [8, 4, 1];
        let source_spacing = [1.0e-9, 1.0e-9, 1.0e-9];
        let source_origin = [0.0, 0.0, 0.0];
        let narrow = AirboxObservationTarget::from_support(
            source_shape,
            source_spacing,
            source_origin,
            [2, 2],
        )
        .expect("narrow target");
        let wide = AirboxObservationTarget::from_support(
            source_shape,
            source_spacing,
            source_origin,
            [5, 7],
        )
        .expect("wide target");

        assert_ne!(narrow.shape, wide.shape);
        assert_ne!(narrow.origin_m, wide.origin_m);
        assert_eq!(narrow.spacing_m, wide.spacing_m);
        assert_eq!(narrow.source_shape, wide.source_shape);
        assert_eq!(narrow.source_spacing_m, wide.source_spacing_m);
    }

    #[test]
    fn content_revisions_change_with_grid_and_carrier_identity() {
        let grid_a = json!({
            "cells": [4, 4, 3],
            "origin_m": [0.0, 0.0, 0.0],
            "cell_size_m": [1.0, 1.0, 1.0],
        });
        let grid_b = json!({
            "cells": [4, 4, 5],
            "origin_m": [0.0, 0.0, -1.0],
            "cell_size_m": [1.0, 1.0, 1.0],
        });
        let grid_revision_a = content_revision(&serde_json::to_vec(&grid_a).unwrap());
        let grid_revision_b = content_revision(&serde_json::to_vec(&grid_b).unwrap());
        let carrier_a = sha256_hex(b"carrier-a");
        let carrier_b = sha256_hex(b"carrier-b");

        assert_ne!(grid_revision_a, grid_revision_b);
        assert_ne!(
            sha256_hex_revision(&carrier_a).unwrap(),
            sha256_hex_revision(&carrier_b).unwrap()
        );
    }

    #[test]
    fn airbox_h_demag_manifest_and_samples_include_build_identity() {
        let plan = tiny_plan();
        let mut problem = ProblemIR::bootstrap_example();
        problem.problem_meta.runtime_metadata.insert(
            "airbox_observation".to_string(),
            json!({
                "cells": [4, 4, 3],
                "spacing_m": [0.5e-9, 0.5e-9, 1.0e-9],
                "origin_m": [-0.5e-9, -0.5e-9, -1.0e-9],
                "padding_cells_above_below": [1, 1],
                "target_only": true,
                "scope_kind": "airbox",
                "published_quantities": ["H_demag"],
                "unavailable_quantities": {
                    "H_eff": "fdm_multilayer_airbox_h_eff_unavailable.v1"
                }
            }),
        );
        let mut provenance = ExecutionProvenance::default();
        provenance.execution_engine = "cpu_reference_multilayer".to_string();
        provenance.precision = "double".to_string();
        provenance.demag_operator_kind = Some("multilayer_tensor_fft_newell".to_string());
        provenance.fft_backend = Some("rustfft".to_string());
        let executed = ExecutedRun {
            result: RunResult {
                status: RunStatus::Completed,
                steps: Vec::new(),
                final_magnetization: vec![[1.0, 0.0, 0.0]; 4],
                completion: None,
            },
            initial_magnetization: vec![[1.0, 0.0, 0.0]; 4],
            field_snapshots: Vec::new(),
            field_snapshot_count: 0,
            auxiliary_artifacts: Vec::new(),
            provenance,
        };

        let artifacts = materialize_airbox_observation(&problem, &plan, &executed)
            .expect("target-only observation should materialize");
        assert_eq!(artifacts.len(), 4);
        let manifest = artifacts
            .iter()
            .find(|artifact| artifact.relative_path == "fields/H_demag/airbox/manifest.json")
            .expect("H_demag manifest artifact");
        let field = artifacts
            .iter()
            .find(|artifact| artifact.relative_path.ends_with(H_DEMAG_FIELD_ARTIFACT))
            .expect("H_demag field artifact");
        let h_eff_manifest = artifacts
            .iter()
            .find(|artifact| artifact.relative_path == "fields/H_eff/airbox/manifest.json")
            .expect("H_eff manifest artifact");
        let h_eff_field = artifacts
            .iter()
            .find(|artifact| artifact.relative_path.ends_with(H_EFF_FIELD_ARTIFACT))
            .expect("H_eff field artifact");
        let manifest_json: serde_json::Value = serde_json::from_slice(&manifest.bytes).unwrap();
        let h_eff_manifest_json: serde_json::Value =
            serde_json::from_slice(&h_eff_manifest.bytes).unwrap();
        assert_eq!(
            manifest_json["schema_version"],
            "fdm_multilayer_observation.v2"
        );
        assert_eq!(manifest_json["scope_kind"], "airbox");
        assert_eq!(manifest_json["quantity_id"], "H_demag");
        assert_eq!(h_eff_manifest_json["quantity_id"], "H_eff");
        assert_eq!(
            manifest_json["published_quantities"],
            json!(["H_demag", "H_eff"])
        );
        assert_eq!(
            h_eff_manifest_json["published_quantities"],
            json!(["H_demag", "H_eff"])
        );
        assert_eq!(manifest_json["unavailable_quantities"], json!({}));
        assert_eq!(h_eff_manifest_json["unavailable_quantities"], json!({}));
        assert_eq!(manifest_json["source_policy"], "target_only");
        assert!(manifest_json["carrier_fingerprint"].as_str().unwrap().len() == 64);
        let build_identity = fullmag_build_info::identity();
        let expected_build_identity = json!({
            "built_at_utc": build_identity.built_at_utc,
            "git_commit": build_identity.git_commit,
            "worktree_state": build_identity.worktree_state,
            "source_snapshot_sha256": build_identity.source_snapshot_sha256,
        });
        assert_eq!(manifest_json["build_identity"], expected_build_identity);
        assert_eq!(
            manifest_json["source_runtime_identity"]["build_identity"],
            expected_build_identity
        );
        assert_eq!(
            manifest_json["source_common_grid"]["cells"],
            json!([2, 2, 1])
        );
        assert_eq!(manifest_json["field_artifact"], "H_demag.samples.v1.json");
        assert_eq!(manifest_json["quantity_revision"], 1);
        assert_eq!(
            manifest_json["grid_revision"].as_u64(),
            Some(content_revision(
                &serde_json::to_vec(&manifest_json["grid"]).unwrap()
            ))
        );
        assert_eq!(
            manifest_json["carrier_revision"].as_u64(),
            Some(
                sha256_hex_revision(manifest_json["carrier_fingerprint"].as_str().unwrap())
                    .unwrap()
            )
        );
        assert_eq!(
            manifest_json["carrier_fingerprint"],
            h_eff_manifest_json["carrier_fingerprint"]
        );
        assert_eq!(
            manifest_json["carrier_revision"],
            h_eff_manifest_json["carrier_revision"]
        );
        assert!(manifest_json["field_generation"]
            .as_str()
            .unwrap()
            .starts_with("airbox:sha256:"));
        assert!(h_eff_manifest_json["field_generation"]
            .as_str()
            .unwrap()
            .starts_with("airbox:sha256:"));
        assert_ne!(
            manifest_json["field_generation"],
            h_eff_manifest_json["field_generation"]
        );
        let field_json: serde_json::Value = serde_json::from_slice(&field.bytes).unwrap();
        let h_eff_json: serde_json::Value = serde_json::from_slice(&h_eff_field.bytes).unwrap();
        assert_eq!(field_json["observable"], "H_demag");
        assert_eq!(h_eff_json["observable"], "H_eff");
        assert_eq!(field_json["unit"], "A/m");
        assert_eq!(h_eff_json["unit"], "A/m");
        assert_eq!(field_json["build_identity"], expected_build_identity);
        assert_eq!(h_eff_json["build_identity"], expected_build_identity);
        assert_eq!(field_json["values"].as_array().unwrap().len(), 48);
        assert_eq!(field_json["values"], h_eff_json["values"]);
    }

    #[test]
    fn airbox_h_eff_adds_the_resolved_uniform_zeeman_field() {
        let mut problem = ProblemIR::bootstrap_example();
        problem.problem_meta.runtime_metadata.insert(
            "airbox_observation".to_string(),
            json!({
                "cells": [4, 4, 3],
                "spacing_m": [0.5e-9, 0.5e-9, 1.0e-9],
                "origin_m": [-0.5e-9, -0.5e-9, -1.0e-9],
                "padding_cells_above_below": [1, 1],
                "target_only": true,
                "scope_kind": "airbox",
                "published_quantities": ["H_demag"]
            }),
        );
        let mut plan = tiny_plan();
        let zeeman_b = [1.25e-2, -3.0e-3, 8.0e-4];
        plan.external_field = Some(zeeman_b.map(|component| component / super::MU0));
        problem
            .energy_terms
            .push(fullmag_ir::EnergyTermIR::Zeeman { b: zeeman_b });

        let artifacts = materialize_airbox_observation_snapshot(&problem, &plan)
            .expect("uniform Zeeman field should compose with Airbox H_demag");
        let payload = |artifact_name: &str| {
            let artifact = artifacts
                .iter()
                .find(|artifact| artifact.relative_path.ends_with(artifact_name))
                .expect("Airbox quantity payload");
            serde_json::from_slice::<serde_json::Value>(&artifact.bytes).unwrap()
        };
        let h_demag = payload(H_DEMAG_FIELD_ARTIFACT);
        let h_eff = payload(H_EFF_FIELD_ARTIFACT);
        let demag_values = h_demag["values"].as_array().unwrap();
        let effective_values = h_eff["values"].as_array().unwrap();
        for (demag, effective) in demag_values.iter().zip(effective_values) {
            for axis in 0..3 {
                assert_eq!(
                    effective[axis].as_f64().unwrap(),
                    demag[axis].as_f64().unwrap() + plan.external_field.unwrap()[axis]
                );
            }
        }
    }

    #[test]
    fn airbox_h_eff_declares_an_unrepresented_static_field_map() {
        let mut problem = ProblemIR::bootstrap_example();
        problem.problem_meta.runtime_metadata.insert(
            "airbox_observation".to_string(),
            json!({
                "cells": [4, 4, 3],
                "spacing_m": [0.5e-9, 0.5e-9, 1.0e-9],
                "origin_m": [-0.5e-9, -0.5e-9, -1.0e-9],
                "padding_cells_above_below": [1, 1],
                "target_only": true,
                "scope_kind": "airbox"
            }),
        );
        problem.energy_terms.push(fullmag_ir::EnergyTermIR::StaticFieldMap {
            id: "bias-map".to_string(),
            field_b_t: vec![[1.0e-3, 0.0, 0.0]; 4],
        });

        let artifacts = materialize_airbox_observation_snapshot(&problem, &tiny_plan())
            .expect("unrepresented H_eff source should not block H_demag");
        assert_eq!(artifacts.len(), 2);
        let manifest = artifacts
            .iter()
            .find(|artifact| artifact.relative_path == "fields/H_demag/airbox/manifest.json")
            .expect("H_demag manifest artifact");
        let manifest: serde_json::Value = serde_json::from_slice(&manifest.bytes).unwrap();
        assert_eq!(manifest["published_quantities"], json!(["H_demag"]));
        assert_eq!(
            manifest["unavailable_quantities"]["H_eff"],
            H_EFF_UNAVAILABLE_STATIC_FIELD_MAP
        );
    }

    #[test]
    fn on_demand_snapshot_uses_current_planned_state_and_airbox_scope() {
        let mut problem = ProblemIR::bootstrap_example();
        problem.problem_meta.source_hash = Some("snapshot-source".to_string());
        problem.problem_meta.runtime_metadata.insert(
            "airbox_observation".to_string(),
            json!({
                "cells": [4, 4, 3],
                "spacing_m": [0.5e-9, 0.5e-9, 1.0e-9],
                "origin_m": [-0.5e-9, -0.5e-9, -1.0e-9],
                "padding_cells_above_below": [1, 1],
                "target_only": true,
                "scope_kind": "airbox"
            }),
        );
        let plan_x = tiny_plan();
        let mut plan_z = plan_x.clone();
        plan_z.layers[0].initial_magnetization.fill([0.0, 0.0, 1.0]);

        let artifacts_x = materialize_airbox_observation_snapshot(&problem, &plan_x)
            .expect("x-state Airbox snapshot");
        let artifacts_z = materialize_airbox_observation_snapshot(&problem, &plan_z)
            .expect("z-state Airbox snapshot");
        let payload = |artifacts: &[AuxiliaryArtifact]| {
            let artifact = artifacts
                .iter()
                .find(|artifact| artifact.relative_path.ends_with(H_DEMAG_FIELD_ARTIFACT))
                .expect("Airbox samples artifact");
            serde_json::from_slice::<serde_json::Value>(&artifact.bytes).unwrap()
        };
        let field_x = payload(&artifacts_x);
        let field_z = payload(&artifacts_z);

        assert_eq!(field_x["scope_kind"], "airbox");
        assert_eq!(field_x["quantity_id"], "H_demag");
        assert_ne!(field_x["values"], field_z["values"]);
    }

    #[test]
    fn target_field_is_translation_invariant_when_z_padding_changes() {
        let plan = tiny_plan();
        let final_magnetization = vec![[1.0, 0.0, 0.0]; 4];
        let narrow = AirboxObservationTarget {
            shape: [4, 4, 3],
            spacing_m: [0.5e-9, 0.5e-9, 1.0e-9],
            origin_m: [-0.5e-9, -0.5e-9, -1.0e-9],
            padding_cells_above_below: [1, 1],
            source_shape: [2, 2, 1],
            source_spacing_m: [1.0e-9, 1.0e-9, 1.0e-9],
        };
        let wide = AirboxObservationTarget {
            shape: [4, 4, 5],
            spacing_m: narrow.spacing_m,
            origin_m: [-0.5e-9, -0.5e-9, -2.0e-9],
            padding_cells_above_below: [2, 2],
            source_shape: narrow.source_shape,
            source_spacing_m: narrow.source_spacing_m,
        };
        let narrow_field = compute_target_field(&plan, &narrow, &final_magnetization)
            .expect("narrow Airbox target field");
        let wide_field = compute_target_field(&plan, &wide, &final_magnetization)
            .expect("wide Airbox target field");
        for k in 0..narrow.shape[2] {
            for y in 0..narrow.shape[1] {
                for x in 0..narrow.shape[0] {
                    let narrow_index =
                        k * narrow.shape[1] * narrow.shape[0] + y * narrow.shape[0] + x;
                    let wide_index =
                        (k + 1) * wide.shape[1] * wide.shape[0] + y * wide.shape[0] + x;
                    for component in 0..3 {
                        assert!(
                            (narrow_field[narrow_index][component]
                                - wide_field[wide_index][component])
                                .abs()
                                < 1.0e-9,
                            "target padding changed field at ({x},{y},{k}) component {component}: narrow={} wide={}",
                            narrow_field[narrow_index][component],
                            wide_field[wide_index][component]
                        );
                    }
                }
            }
        }
    }
}
