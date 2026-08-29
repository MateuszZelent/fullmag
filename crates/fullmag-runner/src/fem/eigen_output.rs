use super::eigen_capability::{
    insert_native_cpu_modal_window_rejection_contract, native_cpu_modal_window_rejection_reason,
    native_cpu_modal_window_rejection_scope,
};
use super::eigen_policy::resolved_demag_realization;
use super::eigen_projection::tangent_bases;
use super::eigen_reduction::{
    tangent_frame_identity_mismatch, tangent_transport_matrix, tangent_transport_nonunitarity,
};
use crate::types::AuxiliaryArtifact;
use crate::types::RunError;
use fullmag_engine::fem::MeshTopology;
use fullmag_engine::Vector3;
use fullmag_ir::EigenDampingPolicyIR;
use fullmag_ir::EigenNormalizationIR;
use fullmag_ir::EquilibriumSourceIR;
use fullmag_ir::FemEigenPlanIR;
use fullmag_ir::KSamplingIR;
use fullmag_ir::OutputIR;
use fullmag_ir::SpinWaveBoundaryConditionIR;
use fullmag_ir::SpinWaveBoundaryKindIR;
use sha2::{Digest, Sha256};
use std::collections::BTreeSet;

pub(super) fn requested_mode_indices(outputs: &[OutputIR]) -> std::collections::BTreeSet<u32> {
    outputs
        .iter()
        .filter_map(|output| {
            if let OutputIR::EigenMode { indices, .. } = output {
                Some(indices.iter().copied())
            } else {
                None
            }
        })
        .flatten()
        .collect()
}

pub(super) fn json_artifact(
    path: impl Into<String>,
    value: &serde_json::Value,
) -> Result<AuxiliaryArtifact, RunError> {
    let bytes = serde_json::to_vec_pretty(value).map_err(|error| RunError {
        message: format!("failed to serialize eigen artifact: {}", error),
    })?;
    Ok(AuxiliaryArtifact {
        relative_path: path.into(),
        bytes,
    })
}

fn binary_artifact(path: impl Into<String>, bytes: Vec<u8>) -> AuxiliaryArtifact {
    AuxiliaryArtifact {
        relative_path: path.into(),
        bytes,
    }
}

pub(super) fn published_artifact_sha256(
    artifacts: &[AuxiliaryArtifact],
    relative_path: &str,
) -> Result<String, RunError> {
    let artifact = artifacts
        .iter()
        .find(|artifact| artifact.relative_path == relative_path)
        .ok_or_else(|| RunError {
            message: format!(
                "missing published artifact required for content digest: {relative_path}"
            ),
        })?;
    Ok(format!("sha256:{:x}", Sha256::digest(&artifact.bytes)))
}

pub(super) fn mode_field_id(sample_index: usize, raw_mode_index: u64) -> String {
    format!("analysis:eigen:sample-{sample_index:04}:mode-{raw_mode_index:04}")
}

pub(super) fn mode_field_resource_key(sample_index: usize, raw_mode_index: u64) -> String {
    format!(
        "/v2/sessions/current/data/fields/{}/samples/vector?view=phase_rotated_real&phase_rad=0",
        mode_field_id(sample_index, raw_mode_index)
    )
}

fn mode_meta_resource_key(sample_index: usize, raw_mode_index: u64) -> String {
    format!(
        "/v2/sessions/current/analysis/frequency-domain/eigen/mode-field/{sample_index}/{raw_mode_index}/meta"
    )
}

pub(super) fn mode_metadata_path(sample_index: usize, raw_mode_index: u64) -> String {
    format!("eigen/modes/sample_{sample_index:04}/mode_{raw_mode_index:04}.json")
}

fn mode_payload_path(sample_index: usize, raw_mode_index: u64) -> String {
    format!("eigen/mode_fields/sample_{sample_index:04}/mode_{raw_mode_index:04}/vector.bin")
}

fn mode_zarr_store_path() -> &'static str {
    "eigen/mode_fields.zarr"
}

fn mode_zarr_sample_group_path(sample_index: usize) -> String {
    format!("eigen/mode_fields.zarr/sample_{sample_index:04}")
}

fn mode_zarr_mode_group_path(sample_index: usize, raw_mode_index: u64) -> String {
    format!("eigen/mode_fields.zarr/sample_{sample_index:04}/mode_{raw_mode_index:04}")
}

fn mode_zarr_array_path(sample_index: usize, raw_mode_index: u64) -> String {
    format!(
        "{}/vector_xyz_complex",
        mode_zarr_mode_group_path(sample_index, raw_mode_index)
    )
}

fn mode_zarr_chunk_path(sample_index: usize, raw_mode_index: u64) -> String {
    format!(
        "{}/0.0.0",
        mode_zarr_array_path(sample_index, raw_mode_index)
    )
}

fn mode_vector_entries(value: &serde_json::Value, field: &str) -> Result<Vec<[f64; 3]>, RunError> {
    let entries = value
        .get(field)
        .and_then(serde_json::Value::as_array)
        .ok_or_else(|| RunError {
            message: format!("requested mode field payload is missing {field}"),
        })?;
    if entries.is_empty() {
        return Err(RunError {
            message: format!("requested mode field payload {field} must not be empty"),
        });
    }
    entries
        .iter()
        .enumerate()
        .map(|(entry_index, entry)| {
            let components = entry.as_array().ok_or_else(|| RunError {
                message: format!(
                    "requested mode field payload {field}[{entry_index}] must be a Cartesian XYZ array"
                ),
            })?;
            if components.len() != 3 {
                return Err(RunError {
                    message: format!(
                        "requested mode field payload {field}[{entry_index}] must contain exactly three Cartesian components"
                    ),
                });
            }
            let mut vector = [0.0; 3];
            for (component_index, component) in components.iter().enumerate() {
                let numeric = component.as_f64().filter(|numeric| numeric.is_finite()).ok_or_else(|| {
                    RunError {
                        message: format!(
                            "requested mode field payload {field}[{entry_index}][{component_index}] must be finite"
                        ),
                    }
                })?;
                vector[component_index] = numeric;
            }
            Ok(vector)
        })
        .collect()
}

fn mode_payload_bytes(real: &[[f64; 3]], imag: &[[f64; 3]]) -> Result<Vec<u8>, RunError> {
    if real.is_empty() || imag.is_empty() || real.len() != imag.len() {
        return Err(RunError {
            message: format!(
                "requested mode field payload requires equal non-empty real/imag XYZ samples: real={}, imag={}",
                real.len(),
                imag.len()
            ),
        });
    }
    let sample_count = real.len();
    let mut bytes = Vec::with_capacity(sample_count * 6 * std::mem::size_of::<f64>());
    for (index, (real_sample, imag_sample)) in real.iter().zip(imag.iter()).enumerate() {
        for component in 0..3 {
            if !real_sample[component].is_finite() || !imag_sample[component].is_finite() {
                return Err(RunError {
                    message: format!(
                        "requested mode field payload contains non-finite Cartesian component at sample {index}, component {component}"
                    ),
                });
            }
            bytes.extend_from_slice(&real_sample[component].to_le_bytes());
            bytes.extend_from_slice(&imag_sample[component].to_le_bytes());
        }
    }
    Ok(bytes)
}

fn mode_amplitude_summary(amplitude: &serde_json::Value, sample_count: usize) -> serde_json::Value {
    let values: Vec<f64> = amplitude
        .as_array()
        .map(|items| items.iter().filter_map(|item| item.as_f64()).collect())
        .unwrap_or_default();
    let max = values.iter().copied().fold(0.0, f64::max);
    let mean = if values.is_empty() {
        0.0
    } else {
        values.iter().sum::<f64>() / values.len() as f64
    };
    serde_json::json!({
        "sample_count": sample_count,
        "max": max,
        "mean": mean,
    })
}

fn mode_component_summary(sample_count: usize) -> serde_json::Value {
    serde_json::json!({
        "real_sample_count": sample_count,
        "imag_sample_count": sample_count,
        "component_count": 3,
    })
}

fn zarr_group_artifact(path: impl Into<String>) -> Result<AuxiliaryArtifact, RunError> {
    json_artifact(
        format!("{}/.zgroup", path.into()),
        &serde_json::json!({
            "zarr_format": 2,
        }),
    )
}

fn mode_zarr_store_attrs_artifact() -> Result<AuxiliaryArtifact, RunError> {
    json_artifact(
        format!("{}/.zattrs", mode_zarr_store_path()),
        &serde_json::json!({
            "fullmag_kind": "frequency_domain_mode_field_store",
            "schema_version": 1,
            "preferred_container": "zarr",
            "quantity_ids": ["delta_m"],
            "axes": ["sample", "mode", "spatial_sample", "component", "complex"],
            "component_order": ["x", "y", "z"],
            "complex_order": ["real", "imag"],
            "storage_layout": "aos_xyz_complex_pairs",
            "compatibility_binary_exports": true,
        }),
    )
}

fn mode_zarr_array_metadata_artifact(
    sample_index: usize,
    raw_mode_index: u64,
    sample_count: usize,
) -> Result<AuxiliaryArtifact, RunError> {
    let chunk_sample_count = sample_count.max(1);
    json_artifact(
        format!(
            "{}/.zarray",
            mode_zarr_array_path(sample_index, raw_mode_index)
        ),
        &serde_json::json!({
            "zarr_format": 2,
            "shape": [sample_count, 3, 2],
            "chunks": [chunk_sample_count, 3, 2],
            "dtype": "<f8",
            "compressor": serde_json::Value::Null,
            "fill_value": 0.0,
            "order": "C",
            "filters": serde_json::Value::Null,
            "dimension_separator": ".",
        }),
    )
}

fn mode_zarr_array_attrs_artifact(
    sample_index: usize,
    raw_mode_index: u64,
    sample_count: usize,
) -> Result<AuxiliaryArtifact, RunError> {
    json_artifact(
        format!(
            "{}/.zattrs",
            mode_zarr_array_path(sample_index, raw_mode_index)
        ),
        &serde_json::json!({
            "quantity_id": "delta_m",
            "unit": "1",
            "value_kind": "complex_spatial_vector",
            "component_basis": "global_xyz",
            "axes": ["spatial_sample", "component", "complex"],
            "component_order": ["x", "y", "z"],
            "complex_order": ["real", "imag"],
            "sample_index": sample_index,
            "raw_mode_index": raw_mode_index,
            "mode_field_sample_count": sample_count,
            "storage_layout": "aos_xyz_complex_pairs",
        }),
    )
}

pub(super) fn write_eigen_v2_bundle(
    plan: &FemEigenPlanIR,
    summary_payload: &serde_json::Value,
    requested_modes: &std::collections::BTreeSet<u32>,
    auxiliary_artifacts: &mut Vec<AuxiliaryArtifact>,
    sample_index: usize,
) -> Result<(), RunError> {
    let modes = summary_payload
        .get("modes")
        .and_then(|value| value.as_array())
        .cloned()
        .unwrap_or_default();
    let k_vector = match plan.k_sampling.as_ref() {
        Some(KSamplingIR::Single { k_vector }) => *k_vector,
        Some(KSamplingIR::Path { .. }) | None => [0.0, 0.0, 0.0],
    };
    let label = if k_vector.iter().all(|value| *value == 0.0) {
        "Γ"
    } else {
        ""
    };
    let solver_model = summary_payload
        .get("solver_kind")
        .and_then(|value| value.as_str())
        .unwrap_or("unknown");
    let manifest_phase_convention = modes
        .first()
        .and_then(|mode| mode.get("phasor_convention"))
        .and_then(|value| value.as_str())
        .unwrap_or("exp_minus_i_omega_t");

    // A mode selected for field export is only visualizable after the complete
    // global Cartesian complex payload has been validated.  Modes not selected
    // by the author remain legitimate spectrum-only observations and never
    // receive a dangling field identifier.
    let mut visualizable_mode_indices = BTreeSet::new();
    for raw_mode_index in requested_modes.iter().copied().map(u64::from) {
        let legacy_path = format!("eigen/modes/mode_{raw_mode_index:04}.json");
        let legacy_mode = auxiliary_artifacts
            .iter()
            .find(|artifact| artifact.relative_path == legacy_path)
            .ok_or_else(|| RunError {
                message: format!(
                    "requested mode {raw_mode_index} has no legacy payload artifact for Cartesian field export"
                ),
            })
            .and_then(|artifact| {
                serde_json::from_slice::<serde_json::Value>(&artifact.bytes).map_err(|error| {
                    RunError {
                        message: format!(
                            "requested mode {raw_mode_index} legacy payload is invalid JSON: {error}"
                        ),
                    }
                })
            })?;
        let real = mode_vector_entries(&legacy_mode, "real").map_err(|mut error| {
            error.message = format!("requested mode {raw_mode_index}: {}", error.message);
            error
        })?;
        let imag = mode_vector_entries(&legacy_mode, "imag").map_err(|mut error| {
            error.message = format!("requested mode {raw_mode_index}: {}", error.message);
            error
        })?;
        let _ = mode_payload_bytes(&real, &imag).map_err(|mut error| {
            error.message = format!("requested mode {raw_mode_index}: {}", error.message);
            error
        })?;
        visualizable_mode_indices.insert(raw_mode_index);
    }

    let spectrum_v2_modes: Vec<serde_json::Value> = modes
        .iter()
        .map(|mode| {
            let raw_mode_index = mode
                .get("index")
                .and_then(|value| value.as_u64())
                .unwrap_or(0);
            let mut mode = mode.clone();
            if let Some(object) = mode.as_object_mut() {
                object.remove("component_participation");
                object.insert(
                    "raw_mode_index".to_string(),
                    serde_json::json!(raw_mode_index),
                );
                object.insert("branch_id".to_string(), serde_json::json!(raw_mode_index));
                if visualizable_mode_indices.contains(&raw_mode_index) {
                    object.insert(
                        "mode_field_id".to_string(),
                        serde_json::json!(mode_field_id(sample_index, raw_mode_index)),
                    );
                    object.insert(
                        "mode_field_resource_key".to_string(),
                        serde_json::json!(mode_field_resource_key(sample_index, raw_mode_index)),
                    );
                }
            }
            mode
        })
        .collect();
    let spectrum_v2 = serde_json::json!({
        "schema_version": "eigen_spectrum.v2",
        "solver_model": summary_payload["solver_kind"],
        "sample_count": 1,
        "mode_count": spectrum_v2_modes.len(),
        "samples": [{
            "sample_index": sample_index,
            "label": label,
            "k_vector": k_vector,
            "path_s": 0.0,
            "segment_index": 0,
            "t_in_segment": 0.0,
            "external_field_a_per_m": plan.external_field,
            "mesh_id": plan.mesh_name,
            "topology_revision": plan.mesh.topology_fingerprint_v6(),
            "modes": spectrum_v2_modes,
        }],
    });
    auxiliary_artifacts.push(json_artifact("eigen/spectrum.v2.json", &spectrum_v2)?);

    let participation_solver_device = if solver_model.contains("gpu") {
        "gpu"
    } else {
        "cpu"
    };
    let spectrum_v3_modes = modes
        .iter()
        .map(|mode| {
            let raw_mode_index = mode
                .get("index")
                .and_then(serde_json::Value::as_u64)
                .unwrap_or(0);
            let participation = match mode.get("component_participation") {
                Some(value) => {
                    serde_json::from_value::<crate::eigen::ModalParticipationObservable>(
                        value.clone(),
                    )
                    .map_err(|error| RunError {
                        message: format!(
                            "mode {raw_mode_index} has invalid component participation: {error}"
                        ),
                    })?
                }
                None => crate::eigen::ModalParticipationObservable::unavailable_without_context(
                    participation_solver_device,
                ),
            };
            let mut mode = mode.clone();
            let object = mode.as_object_mut().ok_or_else(|| RunError {
                message: format!("mode {raw_mode_index} summary is not a JSON object"),
            })?;
            object.insert(
                "mode_id".to_string(),
                serde_json::json!(format!("sample-{sample_index:04}/mode-{raw_mode_index:04}")),
            );
            object.insert(
                "raw_mode_index".to_string(),
                serde_json::json!(raw_mode_index),
            );
            object.insert("branch_id".to_string(), serde_json::json!(raw_mode_index));
            object.insert(
                "component_participation".to_string(),
                serde_json::to_value(participation).map_err(|error| RunError {
                    message: format!(
                        "mode {raw_mode_index} component participation cannot serialize: {error}"
                    ),
                })?,
            );
            if visualizable_mode_indices.contains(&raw_mode_index) {
                object.insert(
                    "mode_field_id".to_string(),
                    serde_json::json!(mode_field_id(sample_index, raw_mode_index)),
                );
                object.insert(
                    "mode_field_resource_key".to_string(),
                    serde_json::json!(mode_field_resource_key(sample_index, raw_mode_index)),
                );
            }
            Ok(mode)
        })
        .collect::<Result<Vec<_>, RunError>>()?;
    auxiliary_artifacts.push(json_artifact(
        "eigen/spectrum.v3.json",
        &serde_json::json!({
            "schema_version": "eigen_spectrum.v3",
            "solver_model": summary_payload["solver_kind"],
            "sample_count": 1,
            "mode_count": spectrum_v3_modes.len(),
            "samples": [{
                "sample_id": format!("bias-field-sample-{sample_index:04}"),
                "sample_index": sample_index,
                "label": label,
                "k_vector": k_vector,
                "path_s": 0.0,
                "segment_index": 0,
                "t_in_segment": 0.0,
                "external_field_a_per_m": plan.external_field,
                "mesh_id": plan.mesh_name,
                "topology_revision": plan.mesh.topology_fingerprint_v6(),
                "modes": spectrum_v3_modes,
            }],
        }),
    )?);

    let branches: Vec<serde_json::Value> = modes
        .iter()
        .map(|mode| {
            let raw_mode_index = mode
                .get("index")
                .and_then(|value| value.as_u64())
                .unwrap_or(0);
            let mut point = serde_json::json!({
                "branch_id": raw_mode_index,
                "cluster_id": mode["cluster_id"],
                "multiplicity": mode["multiplicity"],
                "label": format!("mode_{raw_mode_index:04}"),
                "points": [{
                    "sample_index": sample_index,
                    "raw_mode_index": raw_mode_index,
                    "frequency_hz": mode["frequency_hz"],
                    "frequency_real_hz": mode["frequency_real_hz"],
                    "frequency_imag_hz": mode["frequency_imag_hz"],
                    "angular_frequency_rad_per_s": mode["angular_frequency_rad_per_s"],
                    "tracking_confidence": 1.0,
                    "tracking_score_source": "seed",
                    "modal_overlap_available": false,
                    "overlap_prev": null,
                }],
            });
            if visualizable_mode_indices.contains(&raw_mode_index) {
                let point_object = point["points"][0]
                    .as_object_mut()
                    .expect("branch point must remain an object");
                point_object.insert(
                    "mode_field_id".to_string(),
                    serde_json::json!(mode_field_id(sample_index, raw_mode_index)),
                );
                point_object.insert(
                    "mode_field_resource_key".to_string(),
                    serde_json::json!(mode_field_resource_key(sample_index, raw_mode_index)),
                );
            }
            point
        })
        .collect();
    auxiliary_artifacts.push(json_artifact(
        "eigen/branches.v2.json",
        &serde_json::json!({
            "schema_version": "eigen_branches.v2",
            "solver_model": summary_payload["solver_kind"],
            "tracking_score_source": "seed_only",
            "modal_overlap_available": false,
            "branches": branches,
            "diagnostics": {
                "tracking_score_source": "seed_only",
                "modal_overlap_available": false,
            },
        }),
    )?);
    if !auxiliary_artifacts
        .iter()
        .any(|artifact| artifact.relative_path == "eigen/dispersion.csv")
    {
        auxiliary_artifacts.push(AuxiliaryArtifact {
            relative_path: "eigen/dispersion.csv".to_string(),
            bytes: dispersion_v2_csv(
                plan.k_sampling.as_ref(),
                &summary_payload["modes"],
                &visualizable_mode_indices,
            )
            .into_bytes(),
        });
    }

    let mut mode_metadata_paths = Vec::new();
    let mut mode_resource_keys = Vec::new();
    let mut wrote_mode_zarr_store = false;
    for raw_mode_index in requested_modes.iter().copied().map(u64::from) {
        let legacy_path = format!("eigen/modes/mode_{raw_mode_index:04}.json");
        let legacy_mode = auxiliary_artifacts
            .iter()
            .find(|artifact| artifact.relative_path == legacy_path)
            .ok_or_else(|| RunError {
                message: format!("requested mode {raw_mode_index} disappeared before publication"),
            })
            .and_then(|artifact| {
                serde_json::from_slice::<serde_json::Value>(&artifact.bytes).map_err(|error| {
                    RunError {
                        message: format!(
                            "requested mode {raw_mode_index} legacy payload is invalid JSON: {error}"
                        ),
                    }
                })
            })?;
        let real = mode_vector_entries(&legacy_mode, "real")?;
        let imag = mode_vector_entries(&legacy_mode, "imag")?;
        let sample_count = real.len();
        let source_node_count = plan.mesh.nodes.len();
        if sample_count != source_node_count {
            return Err(RunError {
                message: format!(
                    "requested mode {raw_mode_index} payload node count {sample_count} does not match source mesh node count {source_node_count}"
                ),
            });
        }
        let metadata_path = mode_metadata_path(sample_index, raw_mode_index);
        let payload_path = mode_payload_path(sample_index, raw_mode_index);
        let zarr_array_path = mode_zarr_array_path(sample_index, raw_mode_index);
        let zarr_chunk_path = mode_zarr_chunk_path(sample_index, raw_mode_index);
        let field_id = mode_field_id(sample_index, raw_mode_index);
        let field_resource = mode_field_resource_key(sample_index, raw_mode_index);
        let payload_bytes = mode_payload_bytes(&real, &imag)?;
        let payload_sha256 = format!("sha256:{:x}", Sha256::digest(&payload_bytes));
        let mut metadata = serde_json::json!({
            "schema_version": "eigen_mode.v2",
            "solver_model": summary_payload["solver_kind"],
            "sample_index": sample_index,
            "raw_mode_index": raw_mode_index,
            "branch_id": raw_mode_index,
            "frequency_hz": legacy_mode["frequency_hz"],
            "frequency_real_hz": legacy_mode["frequency_real_hz"],
            "frequency_imag_hz": legacy_mode["frequency_imag_hz"],
            "angular_frequency_rad_per_s": legacy_mode["angular_frequency_rad_per_s"],
            "eigenvalue_real": legacy_mode["eigenvalue_real"],
            "eigenvalue_imag": legacy_mode["eigenvalue_imag"],
            "normalization": legacy_mode["normalization"],
            "damping_policy": legacy_mode["damping_policy"],
            "source_mesh_identity": {
                "mesh_id": plan.mesh_name,
                "topology_fingerprint": plan.mesh.topology_fingerprint_v6(),
                "indexing": "full_domain_node_order",
                "node_count": source_node_count,
            },
            "payload_sha256": payload_sha256,
        });
        if let Some(object) = metadata.as_object_mut() {
            object.insert("mode_field_id".to_string(), serde_json::json!(field_id));
            object.insert(
                "mode_field_resource_key".to_string(),
                serde_json::json!(field_resource),
            );
            object.insert(
                "residual_norm".to_string(),
                legacy_mode["residual_norm"].clone(),
            );
            object.insert(
                "residual_absolute_l2".to_string(),
                legacy_mode["residual_absolute_l2"].clone(),
            );
            object.insert(
                "residual_relative_l2".to_string(),
                legacy_mode["residual_relative_l2"].clone(),
            );
            object.insert(
                "residual_linf".to_string(),
                legacy_mode["residual_linf"].clone(),
            );
            object.insert("mass_norm".to_string(), legacy_mode["mass_norm"].clone());
            for key in [
                "cluster_id",
                "cluster_size",
                "multiplicity",
                "q_dof_count",
                "phi_dof_count",
                "native_q_phi_payload",
                "q_real",
                "q_imag",
                "phi_real",
                "phi_imag",
                "external_field_a_per_m",
                "assembly_kind",
                "operator_input_signature_sha256",
                "phase_constraint_sha256",
                "equilibrium_artifact_sha256",
                "linearization_state_sha256",
                "periodic_mesh_certificate_sha256",
                "relax_to_eigen_handoff_sha256",
                "source_mesh_topology_sha256",
            ] {
                if legacy_mode.get(key).is_some() {
                    object.insert(key.to_string(), legacy_mode[key].clone());
                }
            }
            if let Some(block_residuals) = legacy_mode.get("block_residuals") {
                object.insert("block_residuals".to_string(), block_residuals.clone());
            }
            for key in [
                "angular_frequency_imag_rad_per_s",
                "complex_frequency_convention",
                "damping_rate_hz",
                "linewidth_fwhm_hz",
            ] {
                if legacy_mode.get(key).is_some() {
                    object.insert(key.to_string(), legacy_mode[key].clone());
                }
            }
            object.insert(
                "tangent_leakage_mean_abs".to_string(),
                legacy_mode["tangent_leakage_mean_abs"].clone(),
            );
            object.insert(
                "tangent_leakage_max_abs".to_string(),
                legacy_mode["tangent_leakage_max_abs"].clone(),
            );
            object.insert(
                "tangent_leakage_weighted_relative_l2".to_string(),
                legacy_mode["tangent_leakage_weighted_relative_l2"].clone(),
            );
            object.insert(
                "omega_rad_s".to_string(),
                legacy_mode["omega_rad_s"].clone(),
            );
            object.insert(
                "phasor_convention".to_string(),
                legacy_mode["phasor_convention"].clone(),
            );
            object.insert(
                "eigenvalue_mapping".to_string(),
                legacy_mode["eigenvalue_mapping"].clone(),
            );
            object.insert(
                "gamma_rad_s_T".to_string(),
                legacy_mode["gamma_rad_s_T"].clone(),
            );
            object.insert(
                "gamma0_rad_s_per_A_m".to_string(),
                legacy_mode["gamma0_rad_s_per_A_m"].clone(),
            );
            object.insert(
                "mu0_T_m_per_A".to_string(),
                legacy_mode["mu0_T_m_per_A"].clone(),
            );
            object.insert(
                "dominant_polarization".to_string(),
                legacy_mode["dominant_polarization"].clone(),
            );
            object.insert("k_vector".to_string(), legacy_mode["k_vector"].clone());
            object.insert(
                "value_kind".to_string(),
                serde_json::json!("complex_spatial_vector"),
            );
            object.insert(
                "component_basis".to_string(),
                serde_json::json!("global_xyz"),
            );
            object.insert("component_count".to_string(), serde_json::json!(3));
            object.insert("components".to_string(), serde_json::json!(["x", "y", "z"]));
            object.insert(
                "payload_encoding".to_string(),
                serde_json::json!("f64_interleaved_real_imag_xyz"),
            );
            object.insert(
                "binary_layout".to_string(),
                serde_json::json!("complex_f64_pairs_little_endian"),
            );
            object.insert(
                "complex_pair_count".to_string(),
                serde_json::json!(sample_count * 3),
            );
            object.insert(
                "payload_value_count".to_string(),
                serde_json::json!(sample_count * 6),
            );
            object.insert(
                "available_views".to_string(),
                serde_json::json!([
                    "complex",
                    "real",
                    "imag",
                    "abs",
                    "amplitude",
                    "phase",
                    "phase_rotated_real"
                ]),
            );
            object.insert(
                "default_view".to_string(),
                serde_json::json!("phase_rotated_real"),
            );
            object.insert("default_phase_rad".to_string(), serde_json::json!(0.0));
            object.insert(
                "mode_field_sample_count".to_string(),
                serde_json::json!(sample_count),
            );
            object.insert(
                "amplitude_summary".to_string(),
                mode_amplitude_summary(&legacy_mode["amplitude"], sample_count),
            );
            object.insert(
                "component_summary".to_string(),
                mode_component_summary(sample_count),
            );
            object.insert("storage_format".to_string(), serde_json::json!("zarr"));
            object.insert(
                "zarr_store_path".to_string(),
                serde_json::json!(mode_zarr_store_path()),
            );
            object.insert(
                "zarr_array_path".to_string(),
                serde_json::json!(zarr_array_path),
            );
            object.insert(
                "zarr_chunk_path".to_string(),
                serde_json::json!(zarr_chunk_path.clone()),
            );
            object.insert("zarr_dtype".to_string(), serde_json::json!("<f8"));
            object.insert(
                "zarr_shape".to_string(),
                serde_json::json!([sample_count, 3, 2]),
            );
            object.insert(
                "zarr_chunk_shape".to_string(),
                serde_json::json!([sample_count.max(1), 3, 2]),
            );
            object.insert("zarr_compressor".to_string(), serde_json::Value::Null);
            object.insert(
                "compatibility_binary_payload_path".to_string(),
                serde_json::json!(payload_path.clone()),
            );
        }
        auxiliary_artifacts.push(json_artifact(metadata_path.clone(), &metadata)?);
        if !wrote_mode_zarr_store {
            auxiliary_artifacts.push(zarr_group_artifact(mode_zarr_store_path())?);
            auxiliary_artifacts.push(mode_zarr_store_attrs_artifact()?);
            auxiliary_artifacts.push(zarr_group_artifact(mode_zarr_sample_group_path(
                sample_index,
            ))?);
            wrote_mode_zarr_store = true;
        }
        auxiliary_artifacts.push(zarr_group_artifact(mode_zarr_mode_group_path(
            sample_index,
            raw_mode_index,
        ))?);
        auxiliary_artifacts.push(mode_zarr_array_metadata_artifact(
            sample_index,
            raw_mode_index,
            sample_count,
        )?);
        auxiliary_artifacts.push(mode_zarr_array_attrs_artifact(
            sample_index,
            raw_mode_index,
            sample_count,
        )?);
        auxiliary_artifacts.push(binary_artifact(zarr_chunk_path, payload_bytes.clone()));
        auxiliary_artifacts.push(binary_artifact(payload_path, payload_bytes));
        mode_metadata_paths.push(metadata_path);
        mode_resource_keys.push(mode_meta_resource_key(sample_index, raw_mode_index));
    }

    auxiliary_artifacts.push(json_artifact(
        "eigen/diagnostics/solver.v1.json",
        &modal_solver_diagnostics_json(plan, solver_model, modes.len()),
    )?);

    let has_mode_fields = !mode_metadata_paths.is_empty();
    let spectrum_revision =
        published_artifact_sha256(auxiliary_artifacts, "eigen/spectrum.v2.json")?;
    let branches_revision =
        published_artifact_sha256(auxiliary_artifacts, "eigen/branches.v2.json")?;
    let mut manifest = serde_json::json!({
        "schema_version": "frequency_domain_manifest.v1",
        "analysis_family": "magnetic_frequency_domain",
        "study_product": "modal_eigen",
        "stage_kind": "eigenmodes",
        "status": "ready",
        "complete": true,
        "physics": {
            "analysis_family": "magnetic_frequency_domain",
            "phase_convention": manifest_phase_convention,
            "frequency_units": "Hz",
            "field_units": "dimensionless_delta_m",
            "normalization": normalization_label(plan.normalization),
        },
        "artifacts": {
            "spectrum_v2_path": "eigen/spectrum.v2.json",
            "branches_v2_path": "eigen/branches.v2.json",
            "dispersion_csv_path": "eigen/dispersion.csv",
            "solver_diagnostics_path": "eigen/diagnostics/solver.v1.json",
            "mode_field_zarr_store_path": if has_mode_fields {
                serde_json::json!(mode_zarr_store_path())
            } else {
                serde_json::Value::Null
            },
            "mode_field_storage_format": if has_mode_fields { "zarr" } else { "none" },
            "mode_metadata_paths": mode_metadata_paths,
        },
        "resources": {
            "spectrum_resource_key": "/v2/sessions/current/analysis/frequency-domain/eigen/spectrum.v2",
            "branches_resource_key": "/v2/sessions/current/analysis/frequency-domain/eigen/branches.v2",
            "dispersion_resource_key": "/v2/sessions/current/analysis/frequency-domain/eigen/dispersion",
            "mode_field_resources": mode_resource_keys,
        },
        "diagnostics": {
            "tracking_score_source": "seed_only",
            "modal_overlap_available": false,
        },
        "cross_artifact_refs": [
            {
                "relation": "source_spectrum",
                "artifact": "eigen/spectrum.v2.json",
                "revision": spectrum_revision,
            },
            {
                "relation": "source_branches",
                "artifact": "eigen/branches.v2.json",
                "revision": branches_revision,
            },
        ],
    });
    if summary_payload
        .get("solver_diagnostics")
        .and_then(|value| value.get("linearization_state_sha256"))
        .is_some()
    {
        if let Some(artifacts) = manifest
            .get_mut("artifacts")
            .and_then(serde_json::Value::as_object_mut)
        {
            artifacts.insert(
                "equilibrium_artifact_v7_path".to_string(),
                serde_json::json!("eigen/metadata/equilibrium_artifact.v7.json"),
            );
            artifacts.insert(
                "linearization_state_v6_path".to_string(),
                serde_json::json!("eigen/metadata/linearization_state.v6.json"),
            );
        }
    }
    if let (Some(manifest_object), Some(diagnostics_object)) = (
        manifest.as_object_mut(),
        summary_payload["solver_diagnostics"].as_object(),
    ) {
        for key in [
            "physics_contract_version",
            "operator_dictionary_version",
            "implementation_state",
            "validation_state",
            "validated_scope",
            "requested_execution",
            "resolved_execution",
            "assembly_kind",
            "operator_input_signature_sha256",
            "phase_constraint_sha256",
            "equilibrium_artifact_sha256",
            "linearization_state_sha256",
            "periodic_mesh_certificate_sha256",
            "relax_to_eigen_handoff_sha256",
            "source_mesh_topology_sha256",
            "boundary_gauge",
            "spectral",
            "block_residuals",
            "device_transfer_audit",
        ] {
            if let Some(value) = diagnostics_object.get(key) {
                manifest_object.insert(key.to_string(), value.clone());
            }
        }
        if let Some(validation) = plan.dispersion_validation.as_ref() {
            manifest_object.insert(
                "validation".to_string(),
                serde_json::json!({"dispersion_validation": validation}),
            );
        } else {
            // Keep the manifest schema explicit for direct single-point modal
            // solves.  Consumers distinguish an empty validation object
            // (executed but not analytically certified) from a missing field.
            manifest_object.insert("validation".to_string(), serde_json::json!({}));
        }
    }
    auxiliary_artifacts.push(json_artifact(
        "frequency_domain/manifest.v1.json",
        &manifest,
    )?);

    Ok(())
}

pub(super) fn normalization_label(normalization: EigenNormalizationIR) -> &'static str {
    match normalization {
        EigenNormalizationIR::UnitL2 => "unit_l2",
        EigenNormalizationIR::UnitMaxAmplitude => "unit_max_amplitude",
    }
}

pub(super) fn modal_solver_diagnostics_json(
    plan: &FemEigenPlanIR,
    solver_model: &str,
    mode_count: usize,
) -> serde_json::Value {
    let mut diagnostics = serde_json::json!({
        "schema_version": "frequency_domain_modal_solver_diagnostics.v1",
        "study_product": "modal_eigen",
        "status": "ready",
        "complete": true,
        "solver_model": solver_model,
        "resolved_solver_family": solver_model,
        "spectral_transform": "none",
        "algebraic_form": "reference_effective_field_generalized",
        "matrix_equation": "K u = lambda M u",
        "phasor_convention": "not_applicable_real_reference",
        "eigenvalue_mapping": "omega_rad_s = gamma0_rad_s_per_A_m * max(lambda_A_per_m, 0)",
        "frequency_mapping": "frequency_hz = omega_rad_s / (2*pi)",
        "production_gyrotropic_mapping": false,
        "sample_count": 1,
        "mode_count": mode_count,
        "requested_mode_count": plan.count,
        "normalization": normalization_label(plan.normalization),
    });
    merge_modal_transport_diagnostics(&mut diagnostics, modal_tangent_transport_diagnostics(plan));
    if let fullmag_ir::EigenTargetIR::FrequencyWindow {
        frequency_min_hz,
        frequency_max_hz,
    } = plan.target
    {
        let window_width = frequency_max_hz - frequency_min_hz;
        let relative_width = if frequency_min_hz > 0.0 {
            window_width / frequency_min_hz
        } else {
            0.0
        };
        let subwindow_count = (relative_width / 0.35).ceil().max(1.0).min(16.0) as usize;
        let guard_fraction = 0.25;
        let mut subwindows = Vec::with_capacity(subwindow_count);
        let mut resolved_min_hz = frequency_min_hz;
        let mut resolved_max_hz = frequency_max_hz;
        for index in 0..subwindow_count {
            let sub_min = frequency_min_hz + index as f64 * window_width / subwindow_count as f64;
            let sub_max =
                frequency_min_hz + (index + 1) as f64 * window_width / subwindow_count as f64;
            let sub_width = sub_max - sub_min;
            let search_min = (sub_min - guard_fraction * sub_width).max(0.0);
            let search_max = sub_max + guard_fraction * sub_width;
            let shift_frequency_hz = 0.5 * (sub_min + sub_max);
            resolved_min_hz = resolved_min_hz.min(search_min);
            resolved_max_hz = resolved_max_hz.max(search_max);
            subwindows.push(serde_json::json!({
                "index": index,
                "requested_hz": [sub_min, sub_max],
                "search_hz": [search_min, search_max],
                "shift_hz": shift_frequency_hz,
                "shift_frequency_hz": shift_frequency_hz,
                "shift_omega_rad_s": 2.0 * std::f64::consts::PI * shift_frequency_hz,
                "outer_iterations": 0,
                "linear_iterations_total": 0,
                "candidate_modes": 0,
                "accepted_modes": 0,
                "residual_max": 0.0,
                "stop_reason": "window_exhausted",
            }));
        }
        if let Some(object) = diagnostics.as_object_mut() {
            object.insert(
                "requested_window_hz".to_string(),
                serde_json::json!([frequency_min_hz, frequency_max_hz]),
            );
            object.insert(
                "resolved_search_window_hz".to_string(),
                serde_json::json!([resolved_min_hz, resolved_max_hz]),
            );
            object.insert(
                "window_completeness".to_string(),
                serde_json::json!({
                    "policy": "best_effort",
                    "status": "not_certified",
                    "certification_method": "none",
                    "estimated_modes_in_window": 0,
                    "certified_modes_in_window": 0,
                    "additional_modes_may_exist": true,
                }),
            );
            object.insert("subwindows".to_string(), serde_json::json!(subwindows));
        }
    }
    if let Some(reason) = native_cpu_modal_window_rejection_reason(plan) {
        if let Some(object) = diagnostics.as_object_mut() {
            object.insert(
                "production_cpu_rejection_reason".to_string(),
                serde_json::json!(reason),
            );
            object.insert(
                "production_cpu_rejection_scope".to_string(),
                serde_json::json!(native_cpu_modal_window_rejection_scope(reason)),
            );
            insert_native_cpu_modal_window_rejection_contract(object, reason);
        }
    }
    diagnostics
}

pub(crate) fn modal_tangent_transport_diagnostics(plan: &FemEigenPlanIR) -> serde_json::Value {
    if !matches!(
        plan.spin_wave_bc.kind(),
        SpinWaveBoundaryKindIR::Periodic | SpinWaveBoundaryKindIR::Floquet
    ) {
        return serde_json::json!({
            "basis_transport_policy": "not_applicable",
            "floquet_tangent_frame_max_mismatch": 0.0,
            "floquet_tangent_transport_max_nonunitarity": 0.0,
        });
    }

    let topology = match MeshTopology::from_ir(&plan.mesh) {
        Ok(topology) => topology,
        Err(error) => {
            return serde_json::json!({
                "basis_transport_policy": "unavailable",
                "basis_transport_error": format!("MeshTopology: {}", error),
                "floquet_tangent_frame_max_mismatch": f64::NAN,
                "floquet_tangent_transport_max_nonunitarity": f64::NAN,
            });
        }
    };
    let requested_pair_ids = plan.spin_wave_bc.boundary_pair_ids();
    let selected_pairs = topology
        .periodic_node_pairs
        .iter()
        .filter(|(pair_id, _, _)| {
            requested_pair_ids.is_empty()
                || requested_pair_ids
                    .iter()
                    .any(|requested| *requested == pair_id)
        })
        .cloned()
        .collect::<Vec<_>>();
    let bases = tangent_bases(&plan.equilibrium_magnetization);
    let mut max_mismatch: f64 = 0.0;
    let mut max_nonunitarity: f64 = 0.0;
    for (_, node_a, node_b) in selected_pairs {
        let node_a = node_a as usize;
        let node_b = node_b as usize;
        if node_a >= bases.len()
            || node_b >= bases.len()
            || topology.magnetic_node_volumes[node_a] <= 0.0
            || topology.magnetic_node_volumes[node_b] <= 0.0
        {
            continue;
        }
        let transport = tangent_transport_matrix(bases[node_a], bases[node_b]);
        max_mismatch = max_mismatch.max(tangent_frame_identity_mismatch(
            bases[node_a],
            bases[node_b],
        ));
        max_nonunitarity = max_nonunitarity.max(tangent_transport_nonunitarity(transport));
    }
    serde_json::json!({
        "basis_transport_policy": if matches!(plan.operator.kind, fullmag_ir::EigenOperatorIR::Full2x2) {
            "tangent_frame_transport"
        } else {
            "tangent_frame_identity"
        },
        "floquet_tangent_frame_max_mismatch": max_mismatch,
        "floquet_tangent_transport_max_nonunitarity": max_nonunitarity,
    })
}

pub(super) fn merge_modal_transport_diagnostics(
    target: &mut serde_json::Value,
    transport: serde_json::Value,
) {
    let Some(target_object) = target.as_object_mut() else {
        return;
    };
    let Some(transport_object) = transport.as_object() else {
        return;
    };
    for (key, value) in transport_object {
        target_object.insert(key.clone(), value.clone());
    }
}

pub(super) fn damping_policy_label(policy: EigenDampingPolicyIR) -> &'static str {
    match policy {
        EigenDampingPolicyIR::Ignore => "ignore",
        EigenDampingPolicyIR::Include => "include",
    }
}

pub(super) fn damping_imaginary_factor(damping: f64, policy: EigenDampingPolicyIR) -> f64 {
    match policy {
        EigenDampingPolicyIR::Ignore => 0.0,
        EigenDampingPolicyIR::Include => damping.abs() / (1.0 + damping * damping),
    }
}

pub(super) fn spin_wave_bc_label(bc: SpinWaveBoundaryConditionIR) -> &'static str {
    match bc.kind() {
        SpinWaveBoundaryKindIR::Free => "free",
        SpinWaveBoundaryKindIR::Pinned => "pinned",
        SpinWaveBoundaryKindIR::Periodic => "periodic",
        SpinWaveBoundaryKindIR::Floquet => "floquet",
        SpinWaveBoundaryKindIR::SurfaceAnisotropy => "surface_anisotropy",
    }
}

pub(super) fn spin_wave_bc_json(bc: &SpinWaveBoundaryConditionIR) -> serde_json::Value {
    serde_json::json!({
        "kind": spin_wave_bc_label(bc.clone()),
        "boundary_pair_id": bc.boundary_pair_id(),
        "pair_ids": bc.boundary_pair_ids(),
        "phase_convention": bc.phase_convention(),
        "surface_anisotropy_ks": bc.surface_anisotropy_ks(),
        "surface_anisotropy_axis": bc.surface_anisotropy_axis(),
    })
}

pub(super) fn solver_kind_label(plan: &FemEigenPlanIR) -> &'static str {
    if matches!(plan.spin_wave_bc.kind(), SpinWaveBoundaryKindIR::Floquet) {
        if matches!(plan.operator.kind, fullmag_ir::EigenOperatorIR::Full2x2) {
            "cpu_full_2x2_phase_reduced_floquet"
        } else {
            "cpu_phase_reduced_floquet"
        }
    } else {
        match (plan.operator.kind, plan.damping_policy) {
            (fullmag_ir::EigenOperatorIR::Full2x2, EigenDampingPolicyIR::Ignore) => {
                "cpu_full_2x2_symmetric"
            }
            (fullmag_ir::EigenOperatorIR::Full2x2, EigenDampingPolicyIR::Include) => {
                "cpu_full_2x2_damped"
            }
            (_, EigenDampingPolicyIR::Ignore) => "cpu_reference_symmetric",
            (_, EigenDampingPolicyIR::Include) => "cpu_generalized_eigen",
        }
    }
}

pub(super) fn solver_notes(
    plan: &FemEigenPlanIR,
    complex_reduction: bool,
    use_sparse: bool,
) -> &'static str {
    if complex_reduction && matches!(plan.operator.kind, fullmag_ir::EigenOperatorIR::Full2x2) {
        "phase-aware Floquet reduction on the full 2x2 tangent-frame block with phase*(T_node^T T_root) transport"
    } else if complex_reduction {
        "phase-aware periodic reduction on a real doubled Hermitian block"
    } else if use_sparse && matches!(plan.operator.kind, fullmag_ir::EigenOperatorIR::Full2x2) {
        "sparse LOBPCG on full 2×2 Herring-Kittel block operator (2N DOF)"
    } else if use_sparse {
        "sparse LOBPCG iterative eigensolver for large DOF systems"
    } else if matches!(plan.operator.kind, fullmag_ir::EigenOperatorIR::Full2x2) {
        "full 2×2 Herring-Kittel block operator in tangent plane (2N DOF)"
    } else if matches!(plan.damping_policy, EigenDampingPolicyIR::Include) {
        "damping artifacts use first-order alpha linewidth correction over the CPU reference eigenbasis"
    } else {
        "cpu reference symmetric eigen solve"
    }
}

pub(super) fn solver_capabilities(
    plan: &FemEigenPlanIR,
    complex_reduction: bool,
    use_sparse: bool,
) -> Vec<&'static str> {
    let mut capabilities = vec!["cpu_reference_eigen", "artifact_backed_analyze"];
    if use_sparse {
        capabilities.push("sparse_lobpcg");
    }
    if matches!(plan.operator.kind, fullmag_ir::EigenOperatorIR::Full2x2) {
        capabilities.push("full_2x2_herring_kittel");
    }
    match plan.spin_wave_bc.kind() {
        SpinWaveBoundaryKindIR::Free => capabilities.push("free_bc"),
        SpinWaveBoundaryKindIR::Pinned => capabilities.push("pinned_bc"),
        SpinWaveBoundaryKindIR::Periodic => capabilities.push("periodic_zero_phase"),
        SpinWaveBoundaryKindIR::Floquet => capabilities.push("floquet_phase_reduction"),
        SpinWaveBoundaryKindIR::SurfaceAnisotropy => {
            capabilities.push("surface_anisotropy_boundary_term")
        }
    }
    if plan.enable_exchange {
        capabilities.push("exchange");
    }
    if plan.enable_demag {
        match resolved_demag_realization(plan)
            .unwrap_or(fullmag_ir::ResolvedFemDemagIR::PoissonRobin)
        {
            fullmag_ir::ResolvedFemDemagIR::PoissonDirichlet => {
                capabilities.push("demag_poisson_dirichlet")
            }
            fullmag_ir::ResolvedFemDemagIR::PoissonRobin => {
                capabilities.push("demag_poisson_robin")
            }
            fullmag_ir::ResolvedFemDemagIR::Bem => capabilities.push("demag_bem"),
            fullmag_ir::ResolvedFemDemagIR::FredkinKoehler => {
                capabilities.push("demag_fredkin_koehler")
            }
            fullmag_ir::ResolvedFemDemagIR::Fmm => capabilities.push("demag_fmm"),
        }
    }
    if plan.external_field.is_some() {
        capabilities.push("zeeman");
    }
    if plan.interfacial_dmi.is_some() {
        capabilities.push("interfacial_dmi");
    }
    if plan.bulk_dmi.is_some() {
        capabilities.push("bulk_dmi");
    }
    if matches!(plan.damping_policy, EigenDampingPolicyIR::Include) {
        capabilities.push("damping_linewidth_metadata");
    }
    if matches!(
        plan.target,
        fullmag_ir::EigenTargetIR::FrequencyWindow { .. }
    ) {
        capabilities.push("frequency_window_filter");
    }
    if complex_reduction {
        capabilities.push("complex_mode_projection");
        if matches!(plan.operator.kind, fullmag_ir::EigenOperatorIR::Full2x2) {
            capabilities.push("floquet_tangent_frame_transport");
        }
    }
    capabilities
}

pub(super) fn solver_limitations(
    plan: &FemEigenPlanIR,
    complex_reduction: bool,
    use_sparse: bool,
) -> Vec<&'static str> {
    let mut limitations = Vec::new();
    if use_sparse {
        limitations.push("sparse_lobpcg_may_miss_modes_near_degeneracy");
    }
    if matches!(
        plan.target,
        fullmag_ir::EigenTargetIR::FrequencyWindow { .. }
    ) {
        limitations.push("frequency_window_is_filtered_after_reference_solve");
        limitations.push("frequency_window_sparse_lobpcg_uses_oversampled_lowest_candidates");
        limitations.push("no_shift_invert_or_feast_window_solver_yet");
    }
    if !matches!(plan.operator.kind, fullmag_ir::EigenOperatorIR::Full2x2) {
        limitations.push("scalar_projection_only_accurate_for_uniform_equilibrium");
    }
    if matches!(plan.damping_policy, EigenDampingPolicyIR::Include) {
        limitations.push("no_generalized_qz_backend");
        limitations.push("damping_is_first_order_linewidth_correction");
    }
    if complex_reduction {
        limitations.push("floquet_uses_phase_reduced_hermitian_block");
        if !matches!(plan.operator.kind, fullmag_ir::EigenOperatorIR::Full2x2) {
            limitations.push("scalar_floquet_requires_identity_tangent_frame_transport");
        }
    }
    if plan.interfacial_dmi.is_some() || plan.bulk_dmi.is_some() {
        limitations.push("dmi_operator_is_cpu_first_reference_approximation");
    }
    if matches!(
        plan.spin_wave_bc.kind(),
        SpinWaveBoundaryKindIR::SurfaceAnisotropy
    ) {
        limitations.push("surface_anisotropy_requires_exposed_boundary_faces");
    }
    limitations
}

pub(super) fn demag_realization_label(realization: fullmag_ir::ResolvedFemDemagIR) -> &'static str {
    realization.provenance_name()
}

pub(super) fn equilibrium_source_json(equilibrium: &EquilibriumSourceIR) -> serde_json::Value {
    match equilibrium {
        EquilibriumSourceIR::Provided => serde_json::json!({ "kind": "provided" }),
        EquilibriumSourceIR::RelaxedInitialState => {
            serde_json::json!({ "kind": "relaxed_initial_state" })
        }
        EquilibriumSourceIR::Artifact { path } => {
            serde_json::json!({ "kind": "artifact", "path": path })
        }
    }
}

pub(super) fn k_vector_json(k_sampling: Option<&KSamplingIR>) -> serde_json::Value {
    match k_sampling {
        Some(KSamplingIR::Single { k_vector }) => serde_json::json!(k_vector),
        Some(KSamplingIR::Path { .. }) => serde_json::json!([0.0, 0.0, 0.0]),
        None => serde_json::Value::Null,
    }
}

pub(super) fn dispersion_csv(
    k_sampling: Option<&KSamplingIR>,
    modes: &serde_json::Value,
) -> String {
    let k_vector = match k_sampling {
        Some(KSamplingIR::Single { k_vector }) => *k_vector,
        Some(KSamplingIR::Path { .. }) => [0.0, 0.0, 0.0],
        None => [0.0, 0.0, 0.0],
    };
    let mut csv = String::from("mode_index,kx,ky,kz,frequency_hz,angular_frequency_rad_per_s\n");
    if let Some(entries) = modes.as_array() {
        for entry in entries {
            csv.push_str(&format!(
                "{},{:.15e},{:.15e},{:.15e},{:.15e},{:.15e}\n",
                entry["index"].as_u64().unwrap_or(0),
                k_vector[0],
                k_vector[1],
                k_vector[2],
                entry["frequency_hz"].as_f64().unwrap_or(0.0),
                entry["angular_frequency_rad_per_s"].as_f64().unwrap_or(0.0),
            ));
        }
    }
    csv
}

pub(super) fn dispersion_v2_csv(
    k_sampling: Option<&KSamplingIR>,
    modes: &serde_json::Value,
    visualizable_mode_indices: &BTreeSet<u64>,
) -> String {
    let k_vector = match k_sampling {
        Some(KSamplingIR::Single { k_vector }) => *k_vector,
        Some(KSamplingIR::Path { .. }) => [0.0, 0.0, 0.0],
        None => [0.0, 0.0, 0.0],
    };
    let label = if k_vector.iter().all(|value| *value == 0.0) {
        "Γ"
    } else {
        ""
    };
    let mut csv = String::from(
        "sample_index,path_s_rad_per_m,kx_rad_per_m,ky_rad_per_m,kz_rad_per_m,label,raw_mode_index,branch_id,frequency_hz,omega_rad_s,line_width_hz,residual_norm,overlap_score,tracking_score_source,mode_field_id,mode_field_resource_key\n",
    );
    if let Some(entries) = modes.as_array() {
        for entry in entries {
            let raw_mode_index = entry["index"].as_u64().unwrap_or(0);
            let (field_id, field_resource_key) =
                if visualizable_mode_indices.contains(&raw_mode_index) {
                    (
                        mode_field_id(0, raw_mode_index),
                        mode_field_resource_key(0, raw_mode_index),
                    )
                } else {
                    (String::new(), String::new())
                };
            let residual_norm = entry["residual_norm"]
                .as_f64()
                .map(|value| format!("{value:.16e}"))
                .unwrap_or_default();
            let line_width_hz = entry["frequency_imag_hz"]
                .as_f64()
                .filter(|value| value.is_finite() && *value > 0.0)
                .map(|value| format!("{:.16e}", 2.0 * value))
                .unwrap_or_default();
            csv.push_str(&format!(
                "0,{:.16e},{:.16e},{:.16e},{:.16e},{},{},{},{:.16e},{:.16e},{},{},{},seed,{},{}\n",
                0.0,
                k_vector[0],
                k_vector[1],
                k_vector[2],
                label,
                raw_mode_index,
                raw_mode_index,
                entry["frequency_hz"].as_f64().unwrap_or(0.0),
                entry["angular_frequency_rad_per_s"].as_f64().unwrap_or(0.0),
                line_width_hz,
                residual_norm,
                "",
                field_id,
                field_resource_key,
            ));
        }
    }
    csv
}

/// Classify the dominant polarization character of a spin-wave mode.
///
/// Heuristics (all for the real scalar LLG linearization):
/// - `"uniform"`: mode amplitude is spatially homogeneous (Kittel / macrospin mode).
///   Criterion: mean amplitude over active nodes ≥ 60 % of the maximum.
/// - `"op"`: equilibrium is predominantly out-of-plane (|⟨mz⟩| > 0.7 ⇒ mz-dominated modes).
/// - `"ip"`: default for in-plane equilibrium configurations.
/// - `"mixed"`: fallback when the active node set is empty or max amplitude is degenerate.
pub(super) fn classify_polarization(
    amplitude: &[f64],
    active_nodes: &[usize],
    equilibrium: &[Vector3],
    max_amplitude: f64,
) -> &'static str {
    if active_nodes.is_empty() || max_amplitude < 1e-30 {
        return "mixed";
    }

    let n = active_nodes.len() as f64;

    // Spatial uniformity: mean / max over active nodes.
    let mean_amplitude: f64 = active_nodes.iter().map(|&i| amplitude[i]).sum::<f64>() / n;
    if mean_amplitude / max_amplitude > 0.6 {
        return "uniform";
    }

    // Determine equilibrium orientation: average |mz| over active nodes.
    let mean_mz_abs: f64 = if equilibrium.len() > *active_nodes.iter().max().unwrap_or(&0) {
        active_nodes
            .iter()
            .map(|&i| equilibrium[i][2].abs())
            .sum::<f64>()
            / n
    } else {
        0.0
    };

    if mean_mz_abs > 0.7 {
        "op"
    } else {
        "ip"
    }
}
