use super::common::*;
use crate::eigen::types::PathSolveResult;
use serde::Serialize;
use std::fs;
use std::path::Path;

#[derive(Debug, Clone, Serialize)]
struct ModeAmplitudeSummary {
    sample_count: usize,
    max: Option<f64>,
    mean: Option<f64>,
}

#[derive(Debug, Clone, Serialize)]
struct ModeComponentSummary {
    real_sample_count: usize,
    imag_sample_count: usize,
    component_count: usize,
}

#[derive(Debug, Clone, Serialize)]
struct ModeArtifact {
    schema_version: &'static str,
    solver_model: String,
    sample_index: usize,
    raw_mode_index: usize,
    #[serde(skip_serializing_if = "Option::is_none")]
    branch_id: Option<usize>,
    frequency_hz: f64,
    frequency_real_hz: f64,
    frequency_imag_hz: f64,
    angular_frequency_rad_per_s: f64,
    eigenvalue_real: f64,
    eigenvalue_imag: f64,
    phasor_convention: &'static str,
    eigenvalue_mapping: &'static str,
    omega_rad_s: f64,
    #[serde(rename = "gamma_rad_s_T")]
    gamma_rad_s_t: f64,
    #[serde(rename = "gamma0_rad_s_per_A_m")]
    gamma0_rad_s_per_a_m: f64,
    #[serde(rename = "mu0_T_m_per_A")]
    mu0_t_m_per_a: f64,
    normalization: &'static str,
    damping_policy: &'static str,
    mode_field_id: String,
    mode_field_resource_key: String,
    #[serde(skip_serializing_if = "Option::is_none")]
    residual_norm: Option<f64>,
    residual_absolute_l2: f64,
    residual_relative_l2: f64,
    #[serde(skip_serializing_if = "Option::is_none")]
    residual_linf: Option<f64>,
    mass_norm: f64,
    #[serde(skip_serializing_if = "Option::is_none")]
    tangent_leakage_mean_abs: Option<f64>,
    #[serde(skip_serializing_if = "Option::is_none")]
    tangent_leakage_max_abs: Option<f64>,
    dominant_polarization: String,
    k_vector: [f64; 3],
    #[serde(skip_serializing_if = "Option::is_none")]
    external_field_a_per_m: Option<[f64; 3]>,
    #[serde(skip_serializing_if = "Option::is_none")]
    assembly_kind: Option<String>,
    #[serde(skip_serializing_if = "Option::is_none")]
    operator_input_signature_sha256: Option<String>,
    #[serde(skip_serializing_if = "Option::is_none")]
    phase_constraint_sha256: Option<String>,
    #[serde(skip_serializing_if = "Option::is_none")]
    equilibrium_artifact_sha256: Option<String>,
    #[serde(skip_serializing_if = "Option::is_none")]
    linearization_state_sha256: Option<String>,
    #[serde(skip_serializing_if = "Option::is_none")]
    periodic_mesh_certificate_sha256: Option<String>,
    #[serde(skip_serializing_if = "Option::is_none")]
    relax_to_eigen_handoff_sha256: Option<String>,
    #[serde(skip_serializing_if = "Option::is_none")]
    source_mesh_topology_sha256: Option<String>,
    source_mesh_identity: ModeSourceMeshIdentity,
    value_kind: &'static str,
    component_basis: &'static str,
    component_count: usize,
    components: [&'static str; 3],
    storage_format: &'static str,
    compatibility_binary_payload_path: String,
    payload_encoding: &'static str,
    binary_layout: &'static str,
    complex_pair_count: usize,
    payload_value_count: usize,
    available_views: [&'static str; 7],
    default_view: &'static str,
    default_phase_rad: f64,
    mode_field_sample_count: usize,
    amplitude_summary: ModeAmplitudeSummary,
    component_summary: ModeComponentSummary,
}

fn mode_amplitude_summary(amplitude: &[f64]) -> ModeAmplitudeSummary {
    let finite = amplitude
        .iter()
        .copied()
        .filter(|value| value.is_finite())
        .collect::<Vec<_>>();
    let max = finite
        .iter()
        .copied()
        .max_by(|left, right| left.partial_cmp(right).unwrap_or(std::cmp::Ordering::Equal));
    let mean = if finite.is_empty() {
        None
    } else {
        Some(finite.iter().sum::<f64>() / finite.len() as f64)
    };
    ModeAmplitudeSummary {
        sample_count: amplitude.len(),
        max,
        mean,
    }
}

fn mode_component_summary(real: &[[f64; 3]], imag: &[[f64; 3]]) -> ModeComponentSummary {
    ModeComponentSummary {
        real_sample_count: real.len(),
        imag_sample_count: imag.len(),
        component_count: 3,
    }
}

fn write_complex_vector_field_payload(
    base_dir: &Path,
    relative_path: &str,
    real_values: &[[f64; 3]],
    imag_values: &[[f64; 3]],
) -> std::io::Result<()> {
    if real_values.is_empty() || imag_values.is_empty() {
        return Err(std::io::Error::new(
            std::io::ErrorKind::InvalidData,
            "complex vector payload requires non-empty real and imaginary Cartesian samples",
        ));
    }
    if real_values.len() != imag_values.len() {
        return Err(std::io::Error::new(
            std::io::ErrorKind::InvalidData,
            format!(
                "complex vector payload length mismatch: real={}, imag={}",
                real_values.len(),
                imag_values.len()
            ),
        ));
    }
    let path = base_dir.join(relative_path);
    if let Some(parent) = path.parent() {
        fs::create_dir_all(parent)?;
    }
    let mut bytes = Vec::with_capacity(real_values.len() * 3 * 2 * std::mem::size_of::<f64>());
    for (real, imag) in real_values.iter().zip(imag_values.iter()) {
        for component in 0..3 {
            if !real[component].is_finite() || !imag[component].is_finite() {
                return Err(std::io::Error::new(
                    std::io::ErrorKind::InvalidData,
                    "complex vector payload contains a non-finite Cartesian component",
                ));
            }
            bytes.extend_from_slice(&real[component].to_le_bytes());
            bytes.extend_from_slice(&imag[component].to_le_bytes());
        }
    }
    fs::write(path, bytes)
}

pub fn write_mode_bundle(base_dir: &Path, result: &PathSolveResult) -> std::io::Result<()> {
    for sample in &result.samples {
        let diagnostics = sample_native_solver_diagnostics(sample);
        for mode in &sample.modes {
            let real = mode.lifted_real.as_deref().ok_or_else(|| {
                std::io::Error::new(
                    std::io::ErrorKind::InvalidData,
                    "mode field publication requires reconstructed global_xyz real payload",
                )
            })?;
            let imag = mode.lifted_imag.as_deref().ok_or_else(|| {
                std::io::Error::new(
                    std::io::ErrorKind::InvalidData,
                    "mode field publication requires reconstructed global_xyz imaginary payload",
                )
            })?;
            if real.is_empty() || imag.is_empty() || real.len() != imag.len() {
                return Err(std::io::Error::new(
                    std::io::ErrorKind::InvalidData,
                    format!(
                        "mode field publication requires equal non-empty real/imag payloads: real={}, imag={}",
                        real.len(),
                        imag.len()
                    ),
                ));
            }
            mode_source_mesh_identity(diagnostics, real.len())?;
        }
    }
    let eigen_dir = base_dir.join("eigen").join("modes");
    for sample in &result.samples {
        let sample_dir = eigen_dir.join(format!("sample_{:04}", sample.sample.sample_index));
        fs::create_dir_all(&sample_dir)?;
        for mode in &sample.modes {
            let real = mode.lifted_real.as_deref().ok_or_else(|| {
                std::io::Error::new(
                    std::io::ErrorKind::InvalidData,
                    "mode field publication requires reconstructed global_xyz real payload",
                )
            })?;
            let imag = mode.lifted_imag.as_deref().ok_or_else(|| {
                std::io::Error::new(
                    std::io::ErrorKind::InvalidData,
                    "mode field publication requires reconstructed global_xyz imaginary payload",
                )
            })?;
            if real.is_empty() || imag.is_empty() || real.len() != imag.len() {
                return Err(std::io::Error::new(
                    std::io::ErrorKind::InvalidData,
                    format!(
                        "mode field publication requires equal non-empty real/imag payloads: real={}, imag={}",
                        real.len(),
                        imag.len()
                    ),
                ));
            }
            let amplitude = mode.amplitude.as_deref().unwrap_or(&[]);
            let mode_field_id =
                eigen_mode_field_id(sample.sample.sample_index, mode.raw_mode_index);
            let mode_field_resource_key = eigen_mode_field_resource_key(&mode_field_id);
            let compatibility_binary_payload_path = format!(
                "eigen/mode_fields/sample_{:04}/mode_{:04}/vector.bin",
                sample.sample.sample_index, mode.raw_mode_index
            );
            let residual_absolute_l2 = finite_or_default(mode.residual_norm, 0.0);
            let residual_relative_l2 = residual_absolute_l2;
            let residual_linf = finite_or_default(mode.residual_linf, residual_absolute_l2);
            let tangent_leakage_mean_abs = finite_or_default(mode.tangent_leakage_mean_abs, 0.0);
            let tangent_leakage_max_abs =
                finite_or_default(mode.tangent_leakage_max_abs, 0.0).max(tangent_leakage_mean_abs);
            let diagnostics = sample_native_solver_diagnostics(sample);
            let payload = ModeArtifact {
                schema_version: "2",
                solver_model: result.solver_model.as_str().to_string(),
                sample_index: sample.sample.sample_index,
                raw_mode_index: mode.raw_mode_index,
                branch_id: mode.branch_id,
                frequency_hz: mode.frequency_real_hz,
                frequency_real_hz: mode.frequency_real_hz,
                frequency_imag_hz: mode.frequency_imag_hz,
                angular_frequency_rad_per_s: mode.angular_frequency_rad_per_s,
                eigenvalue_real: mode.eigenvalue_real,
                eigenvalue_imag: mode.eigenvalue_imag,
                phasor_convention: modal_phasor_convention(result.solver_model),
                eigenvalue_mapping: modal_eigenvalue_mapping(result.solver_model),
                omega_rad_s: mode.angular_frequency_rad_per_s,
                gamma_rad_s_t: reference_modal_gamma_rad_s_t(),
                gamma0_rad_s_per_a_m: REFERENCE_MODAL_GAMMA0_RAD_S_PER_A_M,
                mu0_t_m_per_a: crate::MU0,
                normalization: "unit_l2",
                damping_policy: "ignore",
                mode_field_id,
                mode_field_resource_key,
                residual_norm: Some(residual_absolute_l2),
                residual_absolute_l2,
                residual_relative_l2,
                residual_linf: Some(residual_linf),
                mass_norm: resolved_mode_mass_norm(mode),
                tangent_leakage_mean_abs: Some(tangent_leakage_mean_abs),
                tangent_leakage_max_abs: Some(tangent_leakage_max_abs),
                dominant_polarization: mode.dominant_polarization.clone(),
                k_vector: sample.sample.k_vector,
                external_field_a_per_m: sample_external_field(result, sample.sample.sample_index),
                assembly_kind: diagnostic_string(diagnostics, "assembly_kind"),
                operator_input_signature_sha256: diagnostic_string(
                    diagnostics,
                    "operator_input_signature_sha256",
                ),
                phase_constraint_sha256: diagnostic_string(diagnostics, "phase_constraint_sha256"),
                equilibrium_artifact_sha256: diagnostic_string(
                    diagnostics,
                    "equilibrium_artifact_sha256",
                ),
                linearization_state_sha256: diagnostic_string(
                    diagnostics,
                    "linearization_state_sha256",
                ),
                periodic_mesh_certificate_sha256: diagnostic_string(
                    diagnostics,
                    "periodic_mesh_certificate_sha256",
                ),
                relax_to_eigen_handoff_sha256: diagnostic_string(
                    diagnostics,
                    "relax_to_eigen_handoff_sha256",
                ),
                source_mesh_topology_sha256: diagnostic_string(
                    diagnostics,
                    "source_mesh_topology_sha256",
                ),
                source_mesh_identity: mode_source_mesh_identity(diagnostics, real.len())?,
                value_kind: "complex_spatial_vector",
                component_basis: "global_xyz",
                component_count: 3,
                components: ["x", "y", "z"],
                storage_format: "binary_compatibility_exports",
                compatibility_binary_payload_path: compatibility_binary_payload_path.clone(),
                payload_encoding: "f64_interleaved_real_imag_xyz",
                binary_layout: "complex_f64_pairs_little_endian",
                complex_pair_count: real.len() * 3,
                payload_value_count: real.len() * 6,
                available_views: [
                    "complex",
                    "real",
                    "imag",
                    "abs",
                    "amplitude",
                    "phase",
                    "phase_rotated_real",
                ],
                default_view: "phase_rotated_real",
                default_phase_rad: 0.0,
                mode_field_sample_count: real.len(),
                amplitude_summary: mode_amplitude_summary(amplitude),
                component_summary: mode_component_summary(real, imag),
            };
            let mode_bytes = serde_json::to_vec_pretty(&payload).unwrap();
            fs::write(
                eigen_dir.join(format!(
                    "sample_{:04}_mode_{:04}.json",
                    sample.sample.sample_index, mode.raw_mode_index
                )),
                &mode_bytes,
            )?;
            fs::write(
                sample_dir.join(format!("mode_{:04}.json", mode.raw_mode_index)),
                mode_bytes,
            )?;
            write_complex_vector_field_payload(
                base_dir,
                &compatibility_binary_payload_path,
                real,
                imag,
            )?;
        }
    }
    Ok(())
}
