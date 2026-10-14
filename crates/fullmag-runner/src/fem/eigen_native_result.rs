use super::eigen_mass_metric::ModalMassMetric;
use super::eigen_solve::{
    checked_complex_normalization_scale, complex_mass_norm,
    deembed_native_bloch_floquet_mode_vector, normalize_complex_mode_and_scale,
    normalize_complex_vector_with_scale,
};
use super::eigen_types::{NativeBlochFloquetDensePayload, SharedDomainModeContext};
use crate::native_fem::{NativeModalComplex64, NativeModalEigenTypedResult};
use crate::types::RunError;
use fullmag_ir::EigenNormalizationIR;
use fullmag_ir::FemEigenPlanIR;
use nalgebra::DMatrix;
use num_complex::Complex64;

#[derive(Debug, Clone, Copy)]
#[allow(dead_code)]
pub(crate) struct NativePoissonAirboxK0MetricsInput {
    pub mesh_resolution_m: f64,
    pub airbox_size_m: f64,
    pub magnetic_pair_count: u64,
    pub airbox_pair_count: u64,
    pub effective_magnetisation_a_per_m: f64,
}

#[derive(Debug, Clone)]
pub(super) struct NativeModalEigenpair {
    /// Stable multiplicity cluster assigned from the accepted spectrum.  The
    /// native ABI exposes a best-effort cluster id, but the runner recomputes
    /// it from the certified frequencies so JSON and typed results cannot
    /// silently advertise every mode as a singleton.
    pub(super) cluster_id: u64,
    pub(super) frequency_hz: f64,
    pub(super) omega_rad_s: f64,
    pub(super) eigenvalue_real: f64,
    pub(super) eigenvalue_imag: f64,
    pub(super) residual_absolute_l2: Option<f64>,
    pub(super) residual_relative_l2: f64,
    pub(super) residual_linf: Option<f64>,
    pub(super) mass_norm: f64,
    pub(super) block_residual_q: f64,
    pub(super) block_residual_phi: f64,
    pub(super) block_residual_gauge: Option<f64>,
    pub(super) backend_reported_residual: Option<f64>,
    pub(super) vector: Vec<Complex64>,
    /// Native tangent coordinates before Cartesian mode-field projection.
    /// Shared-domain Poisson modes retain the scalar potential payload too;
    /// other modal lanes leave both fields empty.
    pub(super) q_vector: Vec<Complex64>,
    pub(super) phi_vector: Vec<Complex64>,
    /// Native descriptor certificate for a nonzero-k Floquet mode.  The
    /// potential is kept in the doubled real-split complex coefficient
    /// layout emitted by the native formatter; it is not a Cartesian mesh
    /// field and must not be promoted to a geometric-BC certificate.
    pub(super) floquet_descriptor_certified: bool,
    pub(super) floquet_full_descriptor_certified: bool,
    pub(super) floquet_seam_frame_certified: bool,
    pub(super) floquet_gauge_policy_satisfied: bool,
    pub(super) floquet_geometric_bc_certified: bool,
    pub(super) floquet_poisson_boundary_kind: Option<String>,
    pub(super) floquet_poisson_gauge_policy: Option<String>,
    pub(super) floquet_potential_representation: Option<String>,
    pub(super) floquet_magnetic_relative_residual: Option<f64>,
    pub(super) floquet_potential_relative_residual: Option<f64>,
    pub(super) floquet_full_magnetic_relative_residual: Option<f64>,
    pub(super) floquet_full_potential_relative_residual: Option<f64>,
    pub(super) floquet_scalar_phase_seam_relative_residual: Option<f64>,
    pub(super) floquet_tangent_frame_seam_relative_residual: Option<f64>,
    pub(super) floquet_cartesian_magnetic_seam_relative_residual: Option<f64>,
    pub(super) floquet_equilibrium_pair_relative_residual: Option<f64>,
    pub(super) floquet_potential_real_split: Vec<Complex64>,
}

const NATIVE_MODAL_TYPED_VECTOR_TRANSPORT: &str = "typed_abi_v18";
const NATIVE_MODAL_JSON_VECTOR_KEYS: [&str; 14] = [
    "mode_vector_real",
    "mode_vector_imag",
    "mode_q_real",
    "mode_q_imag",
    "mode_phi_real",
    "mode_phi_imag",
    "potential_vector_real",
    "potential_vector_imag",
    "mode_delta_m_xyz_real",
    "mode_delta_m_xyz_imag",
    "mode_delta_m_xyz_complex",
    "mode_q_complex",
    "mode_phi_complex",
    "mode_vector_complex",
];

#[derive(Debug, Clone, Copy)]
struct NativeModalTypedMode<'a> {
    lambda_real: f64,
    lambda_imag: f64,
    relative_residual: f64,
    q: &'a [NativeModalComplex64],
    phi: &'a [NativeModalComplex64],
}

fn native_modal_typed_modes<'a>(
    result: &serde_json::Value,
    typed: &'a NativeModalEigenTypedResult,
) -> Result<Vec<NativeModalTypedMode<'a>>, RunError> {
    let modes = result
        .get("modes")
        .and_then(serde_json::Value::as_array)
        .ok_or_else(|| RunError {
            message: "native typed modal result JSON is missing modes[] metadata".to_string(),
        })?;
    let mode_count = modes.len();
    if let Some(count_value) = result.get("accepted_mode_count") {
        let count = count_value.as_u64().ok_or_else(|| RunError {
            message: "native typed modal accepted_mode_count must be an unsigned integer"
                .to_string(),
        })?;
        let expected = u64::try_from(mode_count).map_err(|_| RunError {
            message: "native typed modal accepted-mode count exceeds ABI dimensions".to_string(),
        })?;
        if count != expected {
            return Err(RunError {
                message: "native typed modal accepted_mode_count disagrees with modes[]"
                    .to_string(),
            });
        }
    }
    if typed.mode_lambda.len() != mode_count || typed.mode_residuals.len() != mode_count {
        return Err(RunError {
            message: format!(
                "native typed modal scalar buffer counts do not match accepted modes: modes={}, lambda={}, residuals={}",
                mode_count,
                typed.mode_lambda.len(),
                typed.mode_residuals.len()
            ),
        });
    }
    let q_width = usize::try_from(typed.q_dof_count).map_err(|_| RunError {
        message: "native typed modal q_dof_count exceeds host dimensions".to_string(),
    })?;
    let phi_width = usize::try_from(typed.phi_dof_count).map_err(|_| RunError {
        message: "native typed modal phi_dof_count exceeds host dimensions".to_string(),
    })?;
    if mode_count > 0 && q_width == 0 {
        return Err(RunError {
            message: "native typed modal accepted modes require a nonzero q_dof_count".to_string(),
        });
    }
    let expected_q = mode_count.checked_mul(q_width).ok_or_else(|| RunError {
        message: "native typed modal q buffer length overflows host dimensions".to_string(),
    })?;
    let expected_phi = mode_count.checked_mul(phi_width).ok_or_else(|| RunError {
        message: "native typed modal phi buffer length overflows host dimensions".to_string(),
    })?;
    if typed.mode_q_complex.len() != expected_q || typed.mode_phi_complex.len() != expected_phi {
        return Err(RunError {
            message: format!(
                "native typed modal vector buffer counts do not match mode-major widths: q={} expected={}, phi={} expected={}",
                typed.mode_q_complex.len(),
                expected_q,
                typed.mode_phi_complex.len(),
                expected_phi
            ),
        });
    }
    if !typed.mode_cluster_ids.is_empty() {
        return Err(RunError {
            message: "native CPU typed modal result must leave backend cluster IDs unavailable"
                .to_string(),
        });
    }

    let mut typed_modes = Vec::with_capacity(mode_count);
    for (index, mode) in modes.iter().enumerate() {
        let transport = mode
            .get("mode_vector_transport")
            .and_then(serde_json::Value::as_str);
        if transport != Some(NATIVE_MODAL_TYPED_VECTOR_TRANSPORT) {
            return Err(RunError {
                message: format!(
                    "native modal mode {index} is missing mode_vector_transport={NATIVE_MODAL_TYPED_VECTOR_TRANSPORT}"
                ),
            });
        }
        let expected_index = u64::try_from(index).map_err(|_| RunError {
            message: "native typed modal mode index exceeds ABI dimensions".to_string(),
        })?;
        if required_u64(mode, "mode_index")? != expected_index {
            return Err(RunError {
                message: format!(
                    "native typed modal mode_index is not contiguous accepted order at mode {index}"
                ),
            });
        }
        if required_u64(mode, "q_dof_count")? != typed.q_dof_count
            || required_u64(mode, "phi_dof_count")? != typed.phi_dof_count
        {
            return Err(RunError {
                message: format!(
                    "native typed modal mode {index} DOF counts disagree with the ABI widths"
                ),
            });
        }
        for key in NATIVE_MODAL_JSON_VECTOR_KEYS {
            if mode.get(key).is_some() {
                return Err(RunError {
                    message: format!(
                        "native typed modal mode {index} duplicates typed vectors in JSON field '{key}'"
                    ),
                });
            }
        }

        let physical_complex = mode
            .get("floquet_mode_vector_physical_complex")
            .map(|value| {
                value.as_bool().ok_or_else(|| RunError {
                    message: format!(
                        "native typed modal mode {index} has invalid floquet_mode_vector_physical_complex"
                    ),
                })
            })
            .transpose()?;
        let q_layout = mode
            .get("q_layout")
            .and_then(serde_json::Value::as_str)
            .ok_or_else(|| RunError {
                message: format!("native typed modal mode {index} is missing q_layout metadata"),
            })?;
        if !matches!(
            q_layout,
            "interleaved_node_component"
                | "block_component_node"
                | "doubled_real_split"
                | "native_complex_dof"
        ) {
            return Err(RunError {
                message: format!("native typed modal mode {index} has an unsupported q_layout"),
            });
        }
        if physical_complex == Some(true) && q_layout != "interleaved_node_component" {
            return Err(RunError {
                message: format!(
                    "native physical-complex Floquet mode {index} must use interleaved_node_component q layout"
                ),
            });
        }
        if physical_complex == Some(false) && q_layout != "doubled_real_split" {
            return Err(RunError {
                message: format!(
                    "native nonphysical-complex Floquet mode {index} must use doubled_real_split q layout"
                ),
            });
        }

        let phi_layout = mode.get("phi_layout").ok_or_else(|| RunError {
            message: format!("native typed modal mode {index} is missing phi_layout metadata"),
        })?;
        let representation = match mode.get("potential_representation") {
            None => None,
            Some(value) => {
                let representation = value.as_str().filter(|representation| {
                    matches!(
                        *representation,
                        "complex_coefficients" | "doubled_real_split_complex_coefficients"
                    )
                }).ok_or_else(|| RunError {
                    message: format!(
                        "native typed modal mode {index} has an unsupported potential_representation"
                    ),
                })?;
                if phi_width == 0 {
                    return Err(RunError {
                        message: format!(
                            "native typed modal mode {index} must not advertise potential_representation without phi coefficients"
                        ),
                    });
                }
                Some(representation)
            }
        };
        let expected_phi_layout = if phi_width == 0 {
            None
        } else if let Some(representation) = representation {
            if !matches!(
                representation,
                "complex_coefficients" | "doubled_real_split_complex_coefficients"
            ) {
                return Err(RunError {
                    message: format!(
                        "native typed modal mode {index} has an unsupported potential_representation"
                    ),
                });
            }
            Some(representation)
        } else if physical_complex == Some(true) {
            Some("complex_coefficients")
        } else if physical_complex == Some(false) || q_layout == "doubled_real_split" {
            Some("doubled_real_split_complex_coefficients")
        } else {
            Some("native_complex_dof")
        };
        let phi_layout_matches = if phi_width == 0 {
            phi_layout.is_null()
        } else {
            phi_layout.as_str() == expected_phi_layout
        };
        if !phi_layout_matches {
            return Err(RunError {
                message: format!(
                    "native typed modal mode {index} phi_layout disagrees with its typed phi width and representation"
                ),
            });
        }
        if let Some(representation) = representation {
            let expected_q_layout = match representation {
                "complex_coefficients" => "interleaved_node_component",
                "doubled_real_split_complex_coefficients" => "doubled_real_split",
                _ => return Err(RunError {
                    message: format!(
                        "native typed modal mode {index} has an unsupported potential_representation"
                    ),
                }),
            };
            if q_layout != expected_q_layout {
                return Err(RunError {
                    message: format!(
                        "native typed modal mode {index} q_layout disagrees with potential_representation"
                    ),
                });
            }
            if phi_layout.as_str() != Some(representation) {
                return Err(RunError {
                    message: format!(
                        "native typed modal mode {index} phi_layout disagrees with potential_representation"
                    ),
                });
            }
        }
        if let Some(count) = mode.get("potential_dof_count") {
            if count.as_u64() != Some(typed.phi_dof_count) {
                return Err(RunError {
                    message: format!(
                        "native typed modal mode {index} potential_dof_count disagrees with typed phi width"
                    ),
                });
            }
        }

        let lambda = &typed.mode_lambda[index];
        if !lambda.real.is_finite() || !lambda.imag.is_finite() {
            return Err(RunError {
                message: format!("native typed modal lambda[{index}] must be finite"),
            });
        }
        let lambda_real = required_f64(mode, "eigenvalue_real")?;
        let lambda_imag = required_f64(mode, "eigenvalue_imag")?;
        if lambda.real.to_bits() != lambda_real.to_bits()
            || lambda.imag.to_bits() != lambda_imag.to_bits()
        {
            return Err(RunError {
                message: format!(
                    "native typed modal lambda[{index}] disagrees with JSON eigenvalue scalars"
                ),
            });
        }
        let relative_residual = typed.mode_residuals[index];
        if !relative_residual.is_finite() || relative_residual < 0.0 {
            return Err(RunError {
                message: format!(
                    "native typed modal residual[{index}] must be finite and non-negative"
                ),
            });
        }
        let json_relative_residual = required_f64(mode, "relative_residual")?;
        if relative_residual.to_bits() != json_relative_residual.to_bits() {
            return Err(RunError {
                message: format!(
                    "native typed modal residual[{index}] disagrees with JSON relative_residual"
                ),
            });
        }

        let q_start = index.checked_mul(q_width).ok_or_else(|| RunError {
            message: "native typed modal q slice offset overflows host dimensions".to_string(),
        })?;
        let q_end = q_start.checked_add(q_width).ok_or_else(|| RunError {
            message: "native typed modal q slice end overflows host dimensions".to_string(),
        })?;
        let phi_start = index.checked_mul(phi_width).ok_or_else(|| RunError {
            message: "native typed modal phi slice offset overflows host dimensions".to_string(),
        })?;
        let phi_end = phi_start.checked_add(phi_width).ok_or_else(|| RunError {
            message: "native typed modal phi slice end overflows host dimensions".to_string(),
        })?;
        let q = typed
            .mode_q_complex
            .get(q_start..q_end)
            .ok_or_else(|| RunError {
                message: format!("native typed modal q slice {index} is out of bounds"),
            })?;
        let phi = typed
            .mode_phi_complex
            .get(phi_start..phi_end)
            .ok_or_else(|| RunError {
                message: format!("native typed modal phi slice {index} is out of bounds"),
            })?;
        for (name, values) in [("q", q), ("phi", phi)] {
            if let Some((component, _)) = values
                .iter()
                .enumerate()
                .find(|(_, value)| !value.real.is_finite() || !value.imag.is_finite())
            {
                return Err(RunError {
                    message: format!(
                        "native typed modal {name}[{index}][{component}] must be finite"
                    ),
                });
            }
        }
        typed_modes.push(NativeModalTypedMode {
            lambda_real,
            lambda_imag,
            relative_residual,
            q,
            phi,
        });
    }
    Ok(typed_modes)
}

fn native_modal_typed_complex_values(
    values: &[NativeModalComplex64],
    name: &str,
) -> Result<Vec<Complex64>, RunError> {
    values
        .iter()
        .enumerate()
        .map(|(index, value)| {
            if !value.real.is_finite() || !value.imag.is_finite() {
                return Err(RunError {
                    message: format!("native typed modal {name}[{index}] must be finite"),
                });
            }
            Ok(Complex64::new(value.real, value.imag))
        })
        .collect()
}

#[derive(Debug, Default)]
struct NativeFloquetModeCertificate {
    descriptor_certified: bool,
    full_descriptor_certified: bool,
    seam_frame_certified: bool,
    gauge_policy_satisfied: bool,
    geometric_bc_certified: bool,
    poisson_boundary_kind: Option<String>,
    poisson_gauge_policy: Option<String>,
    potential_representation: Option<String>,
    magnetic_relative_residual: Option<f64>,
    potential_relative_residual: Option<f64>,
    full_magnetic_relative_residual: Option<f64>,
    full_potential_relative_residual: Option<f64>,
    scalar_phase_seam_relative_residual: Option<f64>,
    tangent_frame_seam_relative_residual: Option<f64>,
    cartesian_magnetic_seam_relative_residual: Option<f64>,
    equilibrium_pair_relative_residual: Option<f64>,
    potential_real_split: Vec<Complex64>,
}

pub(super) fn diagnostics_number(
    diagnostics: &serde_json::Map<String, serde_json::Value>,
    key: &str,
) -> Option<f64> {
    diagnostics
        .get(key)
        .or_else(|| diagnostics.get("metrics").and_then(|value| value.get(key)))
        .and_then(|value| value.as_f64())
}

pub(super) fn normalize_native_window_subwindows(
    diagnostics: &mut serde_json::Map<String, serde_json::Value>,
) {
    let raw_subwindows = diagnostics
        .get("executed_subwindows")
        .cloned()
        .or_else(|| diagnostics.get("subwindows").cloned());
    let Some(serde_json::Value::Array(subwindows)) = raw_subwindows else {
        return;
    };

    let normalized = subwindows
        .into_iter()
        .filter_map(|subwindow| {
            let mut object = subwindow.as_object()?.clone();
            if let Some(status) = object.get("status").and_then(|value| value.as_str()) {
                let normalized_status = match status {
                    "failed" | "interrupted" => "solve_error",
                    other => other,
                };
                object.insert(
                    "status".to_string(),
                    serde_json::Value::String(normalized_status.to_string()),
                );
            }
            object
                .entry("accepted_frequencies_hz".to_string())
                .or_insert_with(|| serde_json::json!([]));
            if !object.contains_key("candidate_mode_count") {
                let accepted_mode_count = object
                    .get("accepted_mode_count")
                    .cloned()
                    .unwrap_or_else(|| serde_json::json!(0));
                object.insert("candidate_mode_count".to_string(), accepted_mode_count);
            }
            Some(serde_json::Value::Object(object))
        })
        .collect::<Vec<_>>();
    diagnostics.insert(
        "subwindows".to_string(),
        serde_json::Value::Array(normalized),
    );
    diagnostics.remove("executed_subwindows");
}

pub(super) fn merge_poisson_airbox_modal_result_diagnostics(
    diagnostics: &mut serde_json::Map<String, serde_json::Value>,
    result_raw: &str,
) -> Result<(), RunError> {
    let result =
        serde_json::from_str::<serde_json::Value>(result_raw).map_err(|error| RunError {
            message: format!("failed to parse native modal result JSON: {error}"),
        })?;
    let solver_adapter = result
        .get("solver_adapter")
        .and_then(|value| value.as_str());
    if !is_native_poisson_airbox_modal_adapter(solver_adapter) {
        return Ok(());
    }
    let gpu = matches!(
        solver_adapter,
        Some("k0_poisson_airbox_gpu_petsc_slepc")
            | Some("k0_poisson_airbox_gpu_modal_device_krylov")
    );
    let floquet_cpu_schur = solver_adapter == Some("floquet_airbox_cpu_schur_slepc");
    let cpu_schur =
        floquet_cpu_schur || solver_adapter == Some("k0_poisson_airbox_cpu_schur_slepc");
    let gpu_scalable_selected_spectrum = result
        .get("scalable_selected_spectrum")
        .and_then(|value| value.as_bool())
        .or_else(|| {
            diagnostics
                .get("scalable_selected_spectrum")
                .and_then(|value| value.as_bool())
        })
        .unwrap_or(gpu);
    diagnostics.insert(
        "solver_model".to_string(),
        serde_json::json!(solver_adapter.unwrap_or("unknown")),
    );
    diagnostics.insert(
        "resolved_solver_family".to_string(),
        serde_json::json!(if gpu {
            if gpu_scalable_selected_spectrum {
                "device_resident_arnoldi_shift_invert"
            } else {
                "device_dense_validation_shift_invert"
            }
        } else if floquet_cpu_schur {
            "floquet_poisson_airbox_schur"
        } else if cpu_schur {
            "k0_poisson_airbox_schur"
        } else {
            "k0_poisson_airbox_full_coupled"
        }),
    );
    diagnostics.insert(
        "spectral_transform".to_string(),
        serde_json::json!(if gpu {
            "shift_invert"
        } else if cpu_schur {
            "shift_invert"
        } else {
            "shift_invert"
        }),
    );
    diagnostics.insert(
        "algebraic_form".to_string(),
        serde_json::json!(if gpu {
            "schur_reduced_descriptor"
        } else if cpu_schur {
            "schur_reduced_descriptor"
        } else {
            "full_coupled_poisson_airbox_augmented_gauge"
        }),
    );
    if gpu {
        diagnostics.insert(
            "scalable_selected_spectrum".to_string(),
            serde_json::json!(gpu_scalable_selected_spectrum),
        );
    }
    diagnostics.insert(
        "matrix_equation".to_string(),
        serde_json::json!(if gpu || cpu_schur {
            "L_eff q = lambda B_qq q; phi(q) = -P^-1 A_phiq q"
        } else {
            "A_full x = lambda B_full x"
        }),
    );
    diagnostics.insert(
        "phasor_convention".to_string(),
        serde_json::json!("exp_plus_i_omega_t"),
    );
    diagnostics.insert(
        "eigenvalue_mapping".to_string(),
        serde_json::json!("lambda_imag_positive_frequency"),
    );
    let fields = [
        ("solver_adapter", &["solver_adapter"][..]),
        ("demag_kind", &["demag_kind"][..]),
        ("gauge_policy", &["gauge_policy"][..]),
        ("q_dof_count", &["q_dof_count"][..]),
        ("phi_dof_count", &["phi_dof_count"][..]),
        ("magnetic_pair_count", &["magnetic_pair_count"][..]),
        ("airbox_pair_count", &["airbox_pair_count"][..]),
        ("augmented_dof_count", &["augmented_dof_count"][..]),
        ("augmented_phi_dof_count", &["augmented_phi_dof_count"][..]),
        ("residual_tolerance", &["residual_tolerance"][..]),
        (
            "poisson_constraint_relative_residual",
            &["metrics", "poisson_constraint_relative_residual"][..],
        ),
        (
            "full_residual_reconstruction_relative_error",
            &["metrics", "full_residual_reconstruction_relative_error"][..],
        ),
        (
            "relative_reference_frequency_error",
            &["metrics", "relative_reference_frequency_error"][..],
        ),
        ("omega_rad_s", &["eigenpair", "omega_rad_s"][..]),
        ("frequency_hz", &["eigenpair", "frequency_hz"][..]),
    ];
    for (field, path) in fields {
        if diagnostics.contains_key(field) {
            continue;
        }
        if let Some(value) =
            json_value_at(&result, field).or_else(|| json_nested_value(&result, path))
        {
            diagnostics.insert(field.to_string(), value.clone());
        }
    }
    if !diagnostics.contains_key("augmented_phi_dof_count") {
        if let Some(augmented_dof_count) = diagnostics
            .get("augmented_dof_count")
            .and_then(|value| value.as_u64())
        {
            let q_dof_count = diagnostics
                .get("q_dof_count")
                .and_then(|value| value.as_u64())
                .unwrap_or(0);
            if augmented_dof_count >= q_dof_count {
                diagnostics.insert(
                    "augmented_phi_dof_count".to_string(),
                    serde_json::json!(augmented_dof_count - q_dof_count),
                );
            }
        }
    }
    if !diagnostics.contains_key("accepted_mode_count") {
        if let Some(value) = json_value_at(&result, "accepted_mode_count")
            .or_else(|| json_nested_value(&result, &["slepc", "accepted_mode_count"]))
        {
            diagnostics.insert("accepted_mode_count".to_string(), value.clone());
        }
    }
    Ok(())
}

pub(super) fn is_native_poisson_airbox_modal_adapter(adapter: Option<&str>) -> bool {
    matches!(
        adapter,
        Some("floquet_airbox_cpu_schur_slepc")
            | Some("k0_poisson_airbox_cpu_full_coupled_slepc")
            | Some("k0_poisson_airbox_cpu_schur_slepc")
            | Some("k0_poisson_airbox_gpu_petsc_slepc")
            | Some("k0_poisson_airbox_gpu_modal_device_krylov")
    )
}

fn is_native_k0_poisson_airbox_modal_adapter(adapter: Option<&str>) -> bool {
    matches!(
        adapter,
        Some("k0_poisson_airbox_cpu_full_coupled_slepc")
            | Some("k0_poisson_airbox_cpu_schur_slepc")
            | Some("k0_poisson_airbox_gpu_petsc_slepc")
            | Some("k0_poisson_airbox_gpu_modal_device_krylov")
    )
}

fn json_value_at<'a>(value: &'a serde_json::Value, key: &str) -> Option<&'a serde_json::Value> {
    value.get(key)
}

fn json_nested_value<'a>(
    value: &'a serde_json::Value,
    path: &[&str],
) -> Option<&'a serde_json::Value> {
    let mut current = value;
    for key in path {
        current = current.get(*key)?;
    }
    Some(current)
}

#[allow(dead_code)]
pub(crate) fn native_poisson_airbox_k0_metrics_from_result_json(
    raw: &str,
    input: NativePoissonAirboxK0MetricsInput,
) -> Result<crate::eigen::K0KittelPeriodicAirboxDemagMetrics, RunError> {
    let result = serde_json::from_str::<serde_json::Value>(raw).map_err(|error| RunError {
        message: format!("failed to parse native Poisson-airbox modal result JSON: {error}"),
    })?;
    let demag_kind = result
        .get("demag_kind")
        .and_then(|value| value.as_str())
        .ok_or_else(|| RunError {
            message: "native Poisson-airbox modal result JSON is missing demag_kind".to_string(),
        })?;
    if demag_kind != "periodic_airbox_k0" {
        return Err(RunError {
            message: format!(
                "native Poisson-airbox modal result demag_kind must be periodic_airbox_k0, got {demag_kind}"
            ),
        });
    }
    let solver_adapter = result
        .get("solver_adapter")
        .and_then(|value| value.as_str())
        .ok_or_else(|| RunError {
            message: "native Poisson-airbox modal result JSON is missing solver_adapter"
                .to_string(),
        })?;
    if !is_native_k0_poisson_airbox_modal_adapter(Some(solver_adapter)) {
        return Err(RunError {
            message: format!(
                "native Poisson-airbox modal result solver_adapter must be a supported CPU/GPU K0 adapter, got {solver_adapter}"
            ),
        });
    }
    let phi_dof_count = required_u64(&result, "phi_dof_count").or_else(|_| {
        required_u64(&result, "poisson_phi_dof_count").or_else(|_| {
            Err(RunError {
                message: "native Poisson-airbox modal result JSON is missing phi_dof_count"
                    .to_string(),
            })
        })
    })?;
    let augmented_phi_dof_count =
        required_u64(&result, "augmented_phi_dof_count").or_else(|_| {
            required_u64(&result, "poisson_augmented_phi_dof_count").or_else(|_| {
                let augmented_dof_count = required_u64(&result, "augmented_dof_count")?;
                let q_dof_count = required_u64(&result, "q_dof_count")?;
                augmented_dof_count
                    .checked_sub(q_dof_count)
                    .ok_or_else(|| RunError {
                        message: "native Poisson-airbox modal result JSON has augmented_dof_count < q_dof_count".to_string(),
                    })
            })
        })?;
    let poisson_constraint_relative_residual =
        required_f64(&result, "poisson_constraint_relative_residual")?;
    let relative_kittel_frequency_error =
        required_f64(&result, "relative_reference_frequency_error")?;
    if !(input.mesh_resolution_m.is_finite() && input.mesh_resolution_m > 0.0) {
        return Err(RunError {
            message: "native Poisson-airbox K0 metrics require positive mesh_resolution_m"
                .to_string(),
        });
    }
    if !(input.airbox_size_m.is_finite() && input.airbox_size_m > 0.0) {
        return Err(RunError {
            message: "native Poisson-airbox K0 metrics require positive airbox_size_m".to_string(),
        });
    }
    if input.magnetic_pair_count == 0 || input.airbox_pair_count == 0 {
        return Err(RunError {
            message: "native Poisson-airbox K0 metrics require magnetic and airbox pair counts"
                .to_string(),
        });
    }
    if !(input.effective_magnetisation_a_per_m.is_finite()
        && input.effective_magnetisation_a_per_m > 0.0)
    {
        return Err(RunError {
            message: "native Poisson-airbox K0 metrics require positive effective magnetisation"
                .to_string(),
        });
    }
    if !(poisson_constraint_relative_residual.is_finite()
        && poisson_constraint_relative_residual >= 0.0)
    {
        return Err(RunError {
            message: "native Poisson-airbox modal result has invalid Poisson constraint residual"
                .to_string(),
        });
    }
    if !(relative_kittel_frequency_error.is_finite() && relative_kittel_frequency_error >= 0.0) {
        return Err(RunError {
            message: "native Poisson-airbox modal result has invalid reference frequency error"
                .to_string(),
        });
    }
    Ok(crate::eigen::K0KittelPeriodicAirboxDemagMetrics {
        mesh_resolution_m: input.mesh_resolution_m,
        airbox_size_m: input.airbox_size_m,
        phi_dof_count,
        augmented_phi_dof_count,
        poisson_constraint_relative_residual,
        magnetic_pair_count: input.magnetic_pair_count,
        airbox_pair_count: input.airbox_pair_count,
        effective_magnetisation_a_per_m: input.effective_magnetisation_a_per_m,
        relative_kittel_frequency_error,
    })
}

/// Parse the JSON-vector transport retained for the unaffected GPU route and
/// legacy fixtures. Live native CPU admission uses the typed v18 counterpart.
pub(super) fn native_modal_modes_from_result_json(
    plan: &FemEigenPlanIR,
    raw: &str,
    runner_operator: Option<(&DMatrix<f64>, &[f64], &DMatrix<f64>)>,
    shared_domain_context: Option<&SharedDomainModeContext<'_>>,
) -> Result<Vec<NativeModalEigenpair>, RunError> {
    let result = serde_json::from_str::<serde_json::Value>(raw).map_err(|error| RunError {
        message: format!("failed to parse native modal result JSON: {error}"),
    })?;
    native_modal_modes_from_result_value(
        plan,
        &result,
        runner_operator,
        shared_domain_context,
        None,
    )
}

pub(super) fn native_modal_modes_from_typed_result(
    plan: &FemEigenPlanIR,
    raw: &str,
    typed: Option<&NativeModalEigenTypedResult>,
    runner_operator: Option<(&DMatrix<f64>, &[f64], &DMatrix<f64>)>,
    shared_domain_context: Option<&SharedDomainModeContext<'_>>,
) -> Result<Vec<NativeModalEigenpair>, RunError> {
    let typed = typed.ok_or_else(|| RunError {
        message: "native CPU modal result is missing its owned typed ABI v18 buffers".to_string(),
    })?;
    let result = serde_json::from_str::<serde_json::Value>(raw).map_err(|error| RunError {
        message: format!("failed to parse native modal result metadata JSON: {error}"),
    })?;
    let typed_modes = native_modal_typed_modes(&result, typed)?;
    native_modal_modes_from_result_value(
        plan,
        &result,
        runner_operator,
        shared_domain_context,
        Some(&typed_modes),
    )
}

fn native_modal_modes_from_result_value(
    plan: &FemEigenPlanIR,
    result: &serde_json::Value,
    runner_operator: Option<(&DMatrix<f64>, &[f64], &DMatrix<f64>)>,
    shared_domain_context: Option<&SharedDomainModeContext<'_>>,
    typed_modes: Option<&[NativeModalTypedMode<'_>]>,
) -> Result<Vec<NativeModalEigenpair>, RunError> {
    let Some(modes) = result.get("modes").and_then(|value| value.as_array()) else {
        return Err(RunError {
            message: "native modal result JSON is missing complete modes[] payload".to_string(),
        });
    };
    let poisson_airbox = is_native_poisson_airbox_modal_adapter(
        result
            .get("solver_adapter")
            .and_then(|value| value.as_str()),
    );
    if typed_modes.is_some() && !poisson_airbox {
        for (index, mode) in modes.iter().enumerate() {
            if !matches!(
                mode.get("q_layout").and_then(serde_json::Value::as_str),
                Some("native_complex_dof" | "doubled_real_split")
            ) {
                return Err(RunError {
                    message: format!(
                        "native generic typed modal mode {index} has an unsupported q layout"
                    ),
                });
            }
        }
    }
    let mut modes = modes
        .iter()
        .enumerate()
        .map(|(index, mode)| {
            let typed_mode = typed_modes.map(|typed_modes| &typed_modes[index]);
            if poisson_airbox {
                let tangent_mass = shared_domain_context
                    .map(|context| context.reduced_tangent_mass)
                    .or_else(|| runner_operator.map(|(_, _, tangent_mass)| tangent_mass as &dyn ModalMassMetric))
                    .ok_or_else(|| RunError {
                        message: "native Poisson-airbox modal result is missing its native shared-domain mass context"
                            .to_string(),
                    })?;
                native_poisson_airbox_mode_from_payload(
                    plan,
                    mode,
                    tangent_mass,
                    shared_domain_context,
                    typed_mode,
                )
            } else {
                let (stiffness_omega, gyrotropic_row_major, tangent_mass) =
                    runner_operator.ok_or_else(|| RunError {
                        message: "native non-shared modal result is missing its explicit runner operator context"
                            .to_string(),
                    })?;
                native_modal_mode_from_json(
                    plan,
                    mode,
                    stiffness_omega,
                    gyrotropic_row_major,
                    tangent_mass,
                    typed_mode,
                )
            }
        })
        .collect::<Result<Vec<_>, _>>()?;
    assign_modal_frequency_clusters(&mut modes);
    Ok(modes)
}

/// Assign deterministic multiplicity clusters from the accepted spectrum.
/// Native backends may expose an implementation-specific cluster id, but the
/// public artifact needs one stable rule shared by CPU and GPU lanes.  Modes
/// whose positive frequencies differ by at most the relative tolerance belong
/// to the same cluster; the original mode ordering is preserved.
fn assign_modal_frequency_clusters(modes: &mut [NativeModalEigenpair]) {
    const RELATIVE_CLUSTER_TOLERANCE: f64 = 1.0e-7;
    let mut ordered = (0..modes.len()).collect::<Vec<_>>();
    ordered.sort_by(|left, right| {
        modes[*left]
            .frequency_hz
            .total_cmp(&modes[*right].frequency_hz)
            .then_with(|| left.cmp(right))
    });
    let mut next_cluster = 0_u64;
    let mut previous_frequency: Option<f64> = None;
    for index in ordered {
        let frequency = modes[index].frequency_hz;
        let starts_new_cluster = previous_frequency
            .map(|previous| {
                (frequency - previous).abs()
                    > RELATIVE_CLUSTER_TOLERANCE * frequency.abs().max(previous.abs()).max(1.0)
            })
            .unwrap_or(true);
        if starts_new_cluster {
            next_cluster = next_cluster.saturating_add(1);
        }
        modes[index].cluster_id = next_cluster.saturating_sub(1);
        previous_frequency = Some(frequency);
    }
}

pub(super) fn native_poisson_airbox_mode_from_json(
    plan: &FemEigenPlanIR,
    mode: &serde_json::Value,
    tangent_mass: &dyn ModalMassMetric,
    shared_domain_context: Option<&SharedDomainModeContext<'_>>,
) -> Result<NativeModalEigenpair, RunError> {
    native_poisson_airbox_mode_from_payload(plan, mode, tangent_mass, shared_domain_context, None)
}

fn native_poisson_airbox_mode_from_payload(
    plan: &FemEigenPlanIR,
    mode: &serde_json::Value,
    tangent_mass: &dyn ModalMassMetric,
    shared_domain_context: Option<&SharedDomainModeContext<'_>>,
    typed_mode: Option<&NativeModalTypedMode<'_>>,
) -> Result<NativeModalEigenpair, RunError> {
    let mut vector = if let Some(typed_mode) = typed_mode {
        native_modal_typed_complex_values(typed_mode.q, "q")?
    } else {
        let real = mode
            .get("mode_q_real")
            .map(|_| required_f64_array(mode, "mode_q_real"))
            .unwrap_or_else(|| required_f64_array(mode, "mode_vector_real"))?;
        let imag = mode
            .get("mode_q_imag")
            .map(|_| required_f64_array(mode, "mode_q_imag"))
            .unwrap_or_else(|| required_f64_array(mode, "mode_vector_imag"))?;
        if real.len() != imag.len() {
            return Err(RunError {
                message: format!(
                    "native Poisson-airbox modal q vector length mismatch: real={}, imag={}",
                    real.len(),
                    imag.len()
                ),
            });
        }
        real.iter()
            .zip(imag.iter())
            .map(|(re, im)| Complex64::new(*re, *im))
            .collect::<Vec<_>>()
    };
    if vector.len() != tangent_mass.nrows() {
        return Err(RunError {
            message: format!(
                "native Poisson-airbox modal q vector length mismatch: q={}, tangent_operator={}",
                vector.len(),
                tangent_mass.nrows()
            ),
        });
    }
    if mode.get("q_layout").and_then(|value| value.as_str()) == Some("interleaved_node_component") {
        if vector.len() % 2 != 0 {
            return Err(RunError {
                message: "native shared-domain modal interleaved q vector has odd length"
                    .to_string(),
            });
        }
        let node_count = vector.len() / 2;
        let mut block_order = vec![Complex64::new(0.0, 0.0); vector.len()];
        for node in 0..node_count {
            block_order[node] = vector[2 * node];
            block_order[node_count + node] = vector[2 * node + 1];
        }
        vector = block_order;
    }
    let eigenvalue_real = native_modal_scalar(
        mode,
        "eigenvalue_real",
        typed_mode.map(|value| value.lambda_real),
    )?;
    let eigenvalue_imag = native_modal_scalar(
        mode,
        "eigenvalue_imag",
        typed_mode.map(|value| value.lambda_imag),
    )?;
    let frequency_hz = required_f64(mode, "frequency_hz")?;
    let omega_rad_s = required_f64(mode, "omega_rad_s")?;
    validate_native_modal_lambda_frequency_mapping(eigenvalue_imag, omega_rad_s, frequency_hz)?;
    if eigenvalue_real.abs() > 1.0e-9 * eigenvalue_imag.abs().max(1.0) {
        return Err(RunError {
            message: format!(
                "native Poisson-airbox real-frequency-rotated mode has nonzero real eigenvalue: {}",
                eigenvalue_real
            ),
        });
    }
    let normalization_scale =
        normalize_complex_block_mode(&mut vector, tangent_mass, plan.normalization)?;
    let floquet_certificate = if mode
        .get("potential_representation")
        .and_then(|v| v.as_str())
        == Some("complex_coefficients")
    {
        if shared_domain_context.is_none() {
            return Err(RunError {
                message: "physical complex potential requires shared-domain mesh context".into(),
            });
        }
        validate_native_physical_potential_layout_with_typed_phi(
            mode,
            typed_mode.map(|value| value.phi),
        )?;
        // Physical phi is normalized and exported below. Parse its independent
        // full-field/seam diagnostics, but keep it out of the legacy
        // doubled-real coefficient artifact writer.
        native_floquet_physical_mode_certificate_from_json(mode)?
    } else {
        native_floquet_mode_certificate_from_payload(
            mode,
            normalization_scale,
            typed_mode.map(|value| value.phi),
        )?
    };
    let raw_phi_vector = if let Some(typed_mode) = typed_mode.filter(|_| {
        mode.get("q_layout").and_then(serde_json::Value::as_str) != Some("doubled_real_split")
    }) {
        native_modal_typed_complex_values(typed_mode.phi, "phi")?
    } else {
        let phi_real = mode
            .get("mode_phi_real")
            .map(|_| required_f64_array(mode, "mode_phi_real"))
            .unwrap_or_else(|| Ok(Vec::new()))?;
        let phi_imag = mode
            .get("mode_phi_imag")
            .map(|_| required_f64_array(mode, "mode_phi_imag"))
            .unwrap_or_else(|| Ok(Vec::new()))?;
        if phi_real.len() != phi_imag.len() {
            return Err(RunError {
                message: format!(
                    "native Poisson-airbox modal phi vector length mismatch: real={}, imag={}",
                    phi_real.len(),
                    phi_imag.len()
                ),
            });
        }
        phi_real
            .iter()
            .zip(phi_imag.iter())
            .map(|(re, im)| Complex64::new(*re, *im))
            .collect::<Vec<_>>()
    };
    if shared_domain_context.is_some() && raw_phi_vector.is_empty() {
        return Err(RunError {
            message: "native shared-domain modal result is missing the reconstructed phi vector"
                .to_string(),
        });
    }
    let phi_vector = normalize_complex_vector_with_scale(&raw_phi_vector, normalization_scale)?;
    let (residual_absolute_l2, residual_relative_l2, residual_linf, backend_reported_residual) =
        native_modal_residuals_from_payload(mode, typed_mode.map(|value| value.relative_residual))?;
    let block_residual_q = if shared_domain_context.is_some() {
        required_f64(mode, "magnetic_block_backward_error")?
    } else {
        mode.get("magnetic_block_backward_error")
            .map(|_| required_f64(mode, "magnetic_block_backward_error"))
            .transpose()?
            .unwrap_or(residual_relative_l2)
    };
    let block_residual_phi = if shared_domain_context.is_some() {
        required_f64(mode, "poisson_block_backward_error")?
    } else {
        mode.get("poisson_block_backward_error")
            .map(|_| required_f64(mode, "poisson_block_backward_error"))
            .transpose()?
            .unwrap_or(0.0)
    };
    let block_residual_gauge = optional_nonnegative_f64(mode, "gauge_constraint_backward_error")?;
    if shared_domain_context.is_some() && mode.get("gauge_constraint_backward_error").is_none() {
        return Err(RunError {
            message: "native shared-domain modal result is missing gauge_constraint_backward_error (use null when no scalar gauge equation applies)".to_string(),
        });
    }
    for (name, value) in [
        ("magnetic_block_backward_error", Some(block_residual_q)),
        ("poisson_block_backward_error", Some(block_residual_phi)),
        ("gauge_constraint_backward_error", block_residual_gauge),
    ] {
        if value.is_some_and(|value| value < 0.0) {
            return Err(RunError {
                message: format!("native modal result field '{name}' must be non-negative"),
            });
        }
    }
    let vector_for_projection = if let Some(context) = shared_domain_context {
        if vector.len() != 2usize.saturating_mul(context.magnetic_class_count) {
            return Err(RunError {
                message:
                    "native shared-domain q vector length does not match reduced magnetic classes"
                        .to_string(),
            });
        }
        let active_count = context.active_nodes.len();
        let mut expanded = vec![Complex64::new(0.0, 0.0); 2usize * active_count];
        for (active_position, node) in context.active_nodes.iter().copied().enumerate() {
            let class = *context.magnetic_classes.get(node).ok_or_else(|| RunError {
                message: "native shared-domain magnetic class map is shorter than the mesh"
                    .to_string(),
            })?;
            if class == u32::MAX || class as usize >= context.magnetic_class_count {
                return Err(RunError {
                    message: "native shared-domain active node has no valid magnetic class"
                        .to_string(),
                });
            }
            let phase = match context.node_phases {
                Some(phases) => *phases.get(node).ok_or_else(|| RunError {
                    message: "native shared-domain Bloch phase map is shorter than the mesh"
                        .to_string(),
                })?,
                None => Complex64::new(1.0, 0.0),
            };
            expanded[active_position] = phase * vector[class as usize];
            expanded[active_count + active_position] =
                phase * vector[context.magnetic_class_count + class as usize];
        }
        expanded
    } else {
        vector.clone()
    };
    Ok(NativeModalEigenpair {
        cluster_id: 0,
        frequency_hz,
        omega_rad_s,
        eigenvalue_real,
        eigenvalue_imag,
        residual_absolute_l2,
        residual_relative_l2,
        residual_linf,
        mass_norm: complex_block_mass_norm(tangent_mass, &vector).re,
        block_residual_q,
        block_residual_phi,
        block_residual_gauge,
        backend_reported_residual,
        q_vector: vector.clone(),
        phi_vector,
        floquet_descriptor_certified: floquet_certificate.descriptor_certified,
        floquet_full_descriptor_certified: floquet_certificate.full_descriptor_certified,
        floquet_seam_frame_certified: floquet_certificate.seam_frame_certified,
        floquet_gauge_policy_satisfied: floquet_certificate.gauge_policy_satisfied,
        floquet_geometric_bc_certified: floquet_certificate.geometric_bc_certified,
        floquet_poisson_boundary_kind: floquet_certificate.poisson_boundary_kind,
        floquet_poisson_gauge_policy: floquet_certificate.poisson_gauge_policy,
        floquet_potential_representation: floquet_certificate.potential_representation,
        floquet_magnetic_relative_residual: floquet_certificate.magnetic_relative_residual,
        floquet_potential_relative_residual: floquet_certificate.potential_relative_residual,
        floquet_full_magnetic_relative_residual: floquet_certificate
            .full_magnetic_relative_residual,
        floquet_full_potential_relative_residual: floquet_certificate
            .full_potential_relative_residual,
        floquet_scalar_phase_seam_relative_residual: floquet_certificate
            .scalar_phase_seam_relative_residual,
        floquet_tangent_frame_seam_relative_residual: floquet_certificate
            .tangent_frame_seam_relative_residual,
        floquet_cartesian_magnetic_seam_relative_residual: floquet_certificate
            .cartesian_magnetic_seam_relative_residual,
        floquet_equilibrium_pair_relative_residual: floquet_certificate
            .equilibrium_pair_relative_residual,
        floquet_potential_real_split: floquet_certificate.potential_real_split,
        vector: vector_for_projection,
    })
}

/// Parse the legacy JSON-vector Floquet fixture format. Live native CPU
/// Floquet admission uses the typed v18 counterpart.
#[allow(dead_code)]
pub(super) fn native_bloch_floquet_modes_from_result_json(
    plan: &FemEigenPlanIR,
    raw: &str,
    payload: &NativeBlochFloquetDensePayload,
) -> Result<Vec<NativeModalEigenpair>, RunError> {
    let result = serde_json::from_str::<serde_json::Value>(raw).map_err(|error| RunError {
        message: format!("failed to parse native Bloch/Floquet modal result JSON: {error}"),
    })?;
    let modes = result
        .get("modes")
        .and_then(|value| value.as_array())
        .ok_or_else(|| RunError {
            message: "native Bloch/Floquet modal result JSON is missing modes[]".to_string(),
        })?;
    modes
        .iter()
        .map(|mode| native_bloch_floquet_mode_from_json(plan, mode, payload, None))
        .collect()
}

pub(super) fn native_bloch_floquet_modes_from_typed_result(
    plan: &FemEigenPlanIR,
    raw: &str,
    typed: Option<&NativeModalEigenTypedResult>,
    payload: &NativeBlochFloquetDensePayload,
) -> Result<Vec<NativeModalEigenpair>, RunError> {
    let typed = typed.ok_or_else(|| RunError {
        message: "native CPU Bloch/Floquet result is missing its owned typed ABI v18 buffers"
            .to_string(),
    })?;
    let result = serde_json::from_str::<serde_json::Value>(raw).map_err(|error| RunError {
        message: format!("failed to parse native Bloch/Floquet modal metadata JSON: {error}"),
    })?;
    let typed_modes = native_modal_typed_modes(&result, typed)?;
    let modes = result
        .get("modes")
        .and_then(|value| value.as_array())
        .ok_or_else(|| RunError {
            message: "native Bloch/Floquet typed modal result JSON is missing modes[]".to_string(),
        })?;
    modes
        .iter()
        .zip(typed_modes.iter())
        .enumerate()
        .map(|(index, (mode, typed_mode))| {
            if mode.get("q_layout").and_then(serde_json::Value::as_str)
                != Some("doubled_real_split")
                || mode
                    .get("floquet_mode_vector_physical_complex")
                    .and_then(serde_json::Value::as_bool)
                    .is_some_and(|physical_complex| physical_complex)
            {
                return Err(RunError {
                    message: format!(
                        "native Bloch/Floquet typed mode {index} does not carry the doubled-real embedded q layout"
                    ),
                });
            }
            native_bloch_floquet_mode_from_json(plan, mode, payload, Some(typed_mode))
        })
        .collect()
}

fn native_bloch_floquet_mode_from_json(
    plan: &FemEigenPlanIR,
    mode: &serde_json::Value,
    payload: &NativeBlochFloquetDensePayload,
    typed_mode: Option<&NativeModalTypedMode<'_>>,
) -> Result<NativeModalEigenpair, RunError> {
    let embedded = if let Some(typed_mode) = typed_mode {
        native_modal_typed_complex_values(typed_mode.q, "q")?
    } else {
        let real = required_f64_array(mode, "mode_vector_real")?;
        let imag = required_f64_array(mode, "mode_vector_imag")?;
        if real.len() != imag.len() {
            return Err(RunError {
                message: format!(
                    "native Bloch/Floquet modal mode vector length mismatch: real={}, imag={}",
                    real.len(),
                    imag.len()
                ),
            });
        }
        real.iter()
            .zip(imag.iter())
            .map(|(re, im)| Complex64::new(*re, *im))
            .collect::<Vec<_>>()
    };
    if embedded.len() != payload.stiffness.nrows() {
        return Err(RunError {
            message: format!(
                "native Bloch/Floquet modal mode vector length mismatch: q={}, operator={}",
                embedded.len(),
                payload.stiffness.nrows()
            ),
        });
    }
    let mut vector =
        deembed_native_bloch_floquet_mode_vector(&embedded, payload.physical_complex_dof)?;
    let (normalized, normalization_scale) =
        normalize_complex_mode_and_scale(&vector, &payload.physical_mass, &plan.normalization)?;
    vector = normalized;
    let floquet_certificate = native_floquet_mode_certificate_from_payload(
        mode,
        normalization_scale,
        typed_mode.map(|value| value.phi),
    )?;
    let eigenvalue_real =
        native_modal_scalar(mode, "eigenvalue_real", typed_mode.map(|v| v.lambda_real))?;
    let eigenvalue_imag =
        native_modal_scalar(mode, "eigenvalue_imag", typed_mode.map(|v| v.lambda_imag))?;
    let frequency_hz = required_f64(mode, "frequency_hz")?;
    let omega_rad_s = required_f64(mode, "omega_rad_s")?;
    validate_native_modal_lambda_frequency_mapping(eigenvalue_imag, omega_rad_s, frequency_hz)?;
    let lambda = Complex64::new(eigenvalue_real, eigenvalue_imag);
    let (residual_absolute_l2, residual_relative_l2, residual_linf) =
        gyrotropic_pencil_residual_norms(
            &payload.stiffness,
            &payload.gyrotropic_row_major,
            lambda,
            &embedded,
        );
    let mass_norm = complex_mass_norm(&payload.physical_mass, &vector).re;
    Ok(NativeModalEigenpair {
        cluster_id: 0,
        frequency_hz,
        omega_rad_s,
        eigenvalue_real,
        eigenvalue_imag,
        residual_absolute_l2: Some(residual_absolute_l2),
        residual_relative_l2,
        residual_linf: Some(residual_linf),
        mass_norm,
        block_residual_q: residual_relative_l2,
        block_residual_phi: 0.0,
        block_residual_gauge: None,
        backend_reported_residual: None,
        vector,
        q_vector: Vec::new(),
        phi_vector: Vec::new(),
        floquet_descriptor_certified: floquet_certificate.descriptor_certified,
        floquet_full_descriptor_certified: floquet_certificate.full_descriptor_certified,
        floquet_seam_frame_certified: floquet_certificate.seam_frame_certified,
        floquet_gauge_policy_satisfied: floquet_certificate.gauge_policy_satisfied,
        floquet_geometric_bc_certified: floquet_certificate.geometric_bc_certified,
        floquet_poisson_boundary_kind: floquet_certificate.poisson_boundary_kind,
        floquet_poisson_gauge_policy: floquet_certificate.poisson_gauge_policy,
        floquet_potential_representation: floquet_certificate.potential_representation,
        floquet_magnetic_relative_residual: floquet_certificate.magnetic_relative_residual,
        floquet_potential_relative_residual: floquet_certificate.potential_relative_residual,
        floquet_full_magnetic_relative_residual: floquet_certificate
            .full_magnetic_relative_residual,
        floquet_full_potential_relative_residual: floquet_certificate
            .full_potential_relative_residual,
        floquet_scalar_phase_seam_relative_residual: floquet_certificate
            .scalar_phase_seam_relative_residual,
        floquet_tangent_frame_seam_relative_residual: floquet_certificate
            .tangent_frame_seam_relative_residual,
        floquet_cartesian_magnetic_seam_relative_residual: floquet_certificate
            .cartesian_magnetic_seam_relative_residual,
        floquet_equilibrium_pair_relative_residual: floquet_certificate
            .equilibrium_pair_relative_residual,
        floquet_potential_real_split: floquet_certificate.potential_real_split,
    })
}

fn native_modal_mode_from_json(
    plan: &FemEigenPlanIR,
    mode: &serde_json::Value,
    stiffness_omega: &DMatrix<f64>,
    gyrotropic_row_major: &[f64],
    tangent_mass: &DMatrix<f64>,
    typed_mode: Option<&NativeModalTypedMode<'_>>,
) -> Result<NativeModalEigenpair, RunError> {
    let mut vector = if let Some(typed_mode) = typed_mode {
        native_modal_typed_complex_values(typed_mode.q, "q")?
    } else {
        let real = required_f64_array(mode, "mode_vector_real")?;
        let imag = required_f64_array(mode, "mode_vector_imag")?;
        if real.len() != imag.len() {
            return Err(RunError {
                message: format!(
                    "native modal mode vector length mismatch: real={}, imag={}",
                    real.len(),
                    imag.len()
                ),
            });
        }
        real.iter()
            .zip(imag.iter())
            .map(|(re, im)| Complex64::new(*re, *im))
            .collect::<Vec<_>>()
    };
    if vector.len() != stiffness_omega.nrows() {
        return Err(RunError {
            message: format!(
                "native modal mode vector length mismatch: q={}, operator={}",
                vector.len(),
                stiffness_omega.nrows()
            ),
        });
    }
    let normalization_scale =
        normalize_complex_block_mode(&mut vector, tangent_mass, plan.normalization)?;
    let floquet_certificate = native_floquet_mode_certificate_from_payload(
        mode,
        normalization_scale,
        typed_mode.map(|value| value.phi),
    )?;
    let eigenvalue_real =
        native_modal_scalar(mode, "eigenvalue_real", typed_mode.map(|v| v.lambda_real))?;
    let eigenvalue_imag =
        native_modal_scalar(mode, "eigenvalue_imag", typed_mode.map(|v| v.lambda_imag))?;
    let frequency_hz = required_f64(mode, "frequency_hz")?;
    let omega_rad_s = required_f64(mode, "omega_rad_s")?;
    validate_native_modal_lambda_frequency_mapping(eigenvalue_imag, omega_rad_s, frequency_hz)?;
    let lambda = Complex64::new(eigenvalue_real, eigenvalue_imag);
    let (residual_absolute_l2, residual_relative_l2, residual_linf) =
        gyrotropic_pencil_residual_norms(stiffness_omega, gyrotropic_row_major, lambda, &vector);
    let mass_norm = complex_block_mass_norm(tangent_mass, &vector).re;
    Ok(NativeModalEigenpair {
        cluster_id: 0,
        frequency_hz,
        omega_rad_s,
        eigenvalue_real,
        eigenvalue_imag,
        residual_absolute_l2: Some(residual_absolute_l2),
        residual_relative_l2,
        residual_linf: Some(residual_linf),
        mass_norm,
        block_residual_q: residual_relative_l2,
        block_residual_phi: 0.0,
        block_residual_gauge: None,
        backend_reported_residual: None,
        vector,
        q_vector: Vec::new(),
        phi_vector: Vec::new(),
        floquet_descriptor_certified: floquet_certificate.descriptor_certified,
        floquet_full_descriptor_certified: floquet_certificate.full_descriptor_certified,
        floquet_seam_frame_certified: floquet_certificate.seam_frame_certified,
        floquet_gauge_policy_satisfied: floquet_certificate.gauge_policy_satisfied,
        floquet_geometric_bc_certified: floquet_certificate.geometric_bc_certified,
        floquet_poisson_boundary_kind: floquet_certificate.poisson_boundary_kind,
        floquet_poisson_gauge_policy: floquet_certificate.poisson_gauge_policy,
        floquet_potential_representation: floquet_certificate.potential_representation,
        floquet_magnetic_relative_residual: floquet_certificate.magnetic_relative_residual,
        floquet_potential_relative_residual: floquet_certificate.potential_relative_residual,
        floquet_full_magnetic_relative_residual: floquet_certificate
            .full_magnetic_relative_residual,
        floquet_full_potential_relative_residual: floquet_certificate
            .full_potential_relative_residual,
        floquet_scalar_phase_seam_relative_residual: floquet_certificate
            .scalar_phase_seam_relative_residual,
        floquet_tangent_frame_seam_relative_residual: floquet_certificate
            .tangent_frame_seam_relative_residual,
        floquet_cartesian_magnetic_seam_relative_residual: floquet_certificate
            .cartesian_magnetic_seam_relative_residual,
        floquet_equilibrium_pair_relative_residual: floquet_certificate
            .equilibrium_pair_relative_residual,
        floquet_potential_real_split: floquet_certificate.potential_real_split,
    })
}

pub(super) fn validate_native_modal_lambda_frequency_mapping(
    eigenvalue_imag: f64,
    omega_rad_s: f64,
    frequency_hz: f64,
) -> Result<(), RunError> {
    if eigenvalue_imag <= 0.0 {
        return Err(RunError {
            message: format!(
                "native modal lambda=i*omega contract requires a positive-frequency branch, got Im(lambda)={eigenvalue_imag}"
            ),
        });
    }
    let expected_omega = eigenvalue_imag;
    if !approximately_equal(omega_rad_s, expected_omega, 1.0e-9, 1.0e-9) {
        return Err(RunError {
            message: format!(
                "native modal lambda=i*omega contract mismatch: omega_rad_s={omega_rad_s}, Im(lambda)={eigenvalue_imag}"
            ),
        });
    }
    let expected_frequency = expected_omega / std::f64::consts::TAU;
    if !approximately_equal(frequency_hz, expected_frequency, 1.0e-9, 1.0e-9) {
        return Err(RunError {
            message: format!(
                "native modal frequency mapping mismatch: frequency_hz={frequency_hz}, expected Im(lambda)/(2*pi)={expected_frequency}"
            ),
        });
    }
    Ok(())
}

fn approximately_equal(left: f64, right: f64, relative_tol: f64, absolute_tol: f64) -> bool {
    (left - right).abs() <= absolute_tol.max(relative_tol * left.abs().max(right.abs()))
}

fn required_f64(value: &serde_json::Value, key: &str) -> Result<f64, RunError> {
    value
        .get(key)
        .and_then(|field| field.as_f64())
        .filter(|number| number.is_finite())
        .ok_or_else(|| RunError {
            message: format!("native modal result field '{key}' must be finite"),
        })
}

fn native_modal_scalar(
    mode: &serde_json::Value,
    key: &str,
    typed_value: Option<f64>,
) -> Result<f64, RunError> {
    let metadata_value = required_f64(mode, key)?;
    if let Some(typed_value) = typed_value {
        if !typed_value.is_finite() || typed_value.to_bits() != metadata_value.to_bits() {
            return Err(RunError {
                message: format!("native typed modal scalar '{key}' disagrees with JSON metadata"),
            });
        }
        Ok(typed_value)
    } else {
        Ok(metadata_value)
    }
}

fn optional_nonnegative_f64(value: &serde_json::Value, key: &str) -> Result<Option<f64>, RunError> {
    let Some(field) = value.get(key) else {
        return Ok(None);
    };
    if field.is_null() {
        return Ok(None);
    }
    let number = required_f64(value, key)?;
    if number < 0.0 {
        return Err(RunError {
            message: format!("native modal result field '{key}' must be non-negative"),
        });
    }
    Ok(Some(number))
}

fn native_modal_residuals_from_json(
    mode: &serde_json::Value,
) -> Result<(Option<f64>, f64, Option<f64>, Option<f64>), RunError> {
    native_modal_residuals_from_payload(mode, None)
}

fn native_modal_residuals_from_payload(
    mode: &serde_json::Value,
    typed_relative_residual: Option<f64>,
) -> Result<(Option<f64>, f64, Option<f64>, Option<f64>), RunError> {
    let residual_relative_l2 = match optional_nonnegative_f64(mode, "relative_residual")? {
        Some(value) => value,
        None => optional_nonnegative_f64(mode, "full_residual_reconstruction_relative_error")?
            .ok_or_else(|| RunError {
                message: "native modal result is missing a relative residual".to_string(),
            })?,
    };
    let residual_relative_l2 = if let Some(typed_value) = typed_relative_residual {
        if !typed_value.is_finite()
            || typed_value < 0.0
            || typed_value.to_bits() != residual_relative_l2.to_bits()
        {
            return Err(RunError {
                message: "native typed modal residual disagrees with JSON relative residual"
                    .to_string(),
            });
        }
        typed_value
    } else {
        residual_relative_l2
    };
    let residual_absolute_l2 = optional_nonnegative_f64(mode, "residual_absolute_l2")?;
    let residual_linf = optional_nonnegative_f64(mode, "residual_linf")?;
    let backend_reported_residual =
        optional_nonnegative_f64(mode, "slepc_reported_backward_error")?;
    Ok((
        residual_absolute_l2,
        residual_relative_l2,
        residual_linf,
        backend_reported_residual,
    ))
}

#[allow(dead_code)]
fn required_u64(value: &serde_json::Value, key: &str) -> Result<u64, RunError> {
    value
        .get(key)
        .and_then(|field| field.as_u64())
        .ok_or_else(|| RunError {
            message: format!("native modal result field '{key}' must be an integer"),
        })
}

fn required_f64_array(value: &serde_json::Value, key: &str) -> Result<Vec<f64>, RunError> {
    let array = value
        .get(key)
        .and_then(|field| field.as_array())
        .ok_or_else(|| RunError {
            message: format!("native modal result field '{key}' must be an array"),
        })?;
    array
        .iter()
        .enumerate()
        .map(|(index, item)| {
            item.as_f64()
                .filter(|number| number.is_finite())
                .ok_or_else(|| RunError {
                    message: format!("native modal result field '{key}[{index}]' must be finite"),
                })
        })
        .collect()
}

fn validate_native_physical_potential_layout(mode: &serde_json::Value) -> Result<(), RunError> {
    validate_native_physical_potential_layout_with_typed_phi(mode, None)
}

fn validate_native_physical_potential_layout_with_typed_phi(
    mode: &serde_json::Value,
    typed_phi: Option<&[NativeModalComplex64]>,
) -> Result<(), RunError> {
    if mode.get("potential_vector_real").is_some() || mode.get("potential_vector_imag").is_some() {
        return Err(RunError {
            message: "physical potential must not contain doubled-real coefficient vectors".into(),
        });
    }
    let count = mode
        .get("potential_dof_count")
        .and_then(|v| v.as_u64())
        .ok_or_else(|| RunError {
            message: "physical potential requires potential_dof_count".into(),
        })?;
    let actual_count = if let Some(phi) = typed_phi {
        if mode.get("mode_phi_real").is_some() || mode.get("mode_phi_imag").is_some() {
            return Err(RunError {
                message:
                    "physical potential typed result must not duplicate JSON coefficient vectors"
                        .into(),
            });
        }
        phi.len() as u64
    } else {
        let real = required_f64_array(mode, "mode_phi_real")?;
        let imag = required_f64_array(mode, "mode_phi_imag")?;
        if real.len() != imag.len() {
            return Err(RunError {
                message: "physical potential real/imag vector lengths do not match".into(),
            });
        }
        real.len() as u64
    };
    if count == 0 || count != actual_count {
        return Err(RunError {
            message: "physical potential coefficient count does not match typed or JSON vectors"
                .into(),
        });
    }
    Ok(())
}

fn native_floquet_physical_mode_certificate_from_json(
    mode: &serde_json::Value,
) -> Result<NativeFloquetModeCertificate, RunError> {
    let required_bool = |key: &str| {
        mode.get(key)
            .and_then(serde_json::Value::as_bool)
            .ok_or_else(|| RunError {
                message: format!("native physical Floquet mode requires boolean '{key}'"),
            })
    };
    let descriptor_certified = required_bool("floquet_descriptor_certified")?;
    let full_descriptor_certified = required_bool("floquet_full_descriptor_certified")?;
    let seam_frame_certified = required_bool("floquet_seam_frame_certified")?;
    let gauge_policy_satisfied = required_bool("floquet_gauge_policy_satisfied")?;
    let geometric_bc_certified = required_bool("floquet_geometric_bc_certified")?;
    if geometric_bc_certified {
        return Err(RunError {
            message: "native Floquet certificate cannot claim geometric BC certification".into(),
        });
    }
    if descriptor_certified != full_descriptor_certified {
        return Err(RunError {
            message: "native Floquet descriptor and full-descriptor certification flags disagree"
                .into(),
        });
    }
    let potential_representation = mode
        .get("potential_representation")
        .and_then(serde_json::Value::as_str)
        .filter(|value| *value == "complex_coefficients")
        .map(str::to_owned)
        .ok_or_else(|| RunError {
            message: "native physical Floquet mode has an unsupported potential representation"
                .into(),
        })?;
    let poisson_boundary_kind = mode
        .get("poisson_boundary_kind")
        .and_then(serde_json::Value::as_str)
        .filter(|value| {
            matches!(
                *value,
                "pure_neumann" | "poisson_robin" | "poisson_dirichlet"
            )
        })
        .map(str::to_owned)
        .ok_or_else(|| RunError {
            message:
                "native physical Floquet mode has a missing or unsupported Poisson boundary kind"
                    .into(),
        })?;
    let poisson_gauge_policy = mode
        .get("poisson_gauge_policy")
        .and_then(serde_json::Value::as_str)
        .filter(|value| matches!(*value, "require_invertible" | "none"))
        .map(str::to_owned)
        .ok_or_else(|| RunError {
            message:
                "native physical Floquet mode has a missing or unsupported Poisson gauge policy"
                    .into(),
        })?;
    let poisson_policy_matches_boundary = match poisson_boundary_kind.as_str() {
        "pure_neumann" => poisson_gauge_policy == "require_invertible",
        "poisson_robin" | "poisson_dirichlet" => poisson_gauge_policy == "none",
        _ => false,
    };
    if gauge_policy_satisfied != poisson_policy_matches_boundary {
        return Err(RunError {
            message: "native Floquet gauge-policy certificate disagrees with the Poisson boundary and gauge policy".into(),
        });
    }

    let magnetic_relative_residual = optional_nonnegative_f64(mode, "magnetic_relative_residual")?;
    let potential_relative_residual =
        optional_nonnegative_f64(mode, "potential_relative_residual")?;
    let full_magnetic_relative_residual =
        optional_nonnegative_f64(mode, "floquet_full_magnetic_relative_residual")?;
    let full_potential_relative_residual =
        optional_nonnegative_f64(mode, "floquet_full_potential_relative_residual")?;
    let scalar_phase_seam_relative_residual =
        optional_nonnegative_f64(mode, "floquet_scalar_phase_seam_relative_residual")?;
    let tangent_frame_seam_relative_residual =
        optional_nonnegative_f64(mode, "floquet_tangent_frame_seam_relative_residual")?;
    let cartesian_magnetic_seam_relative_residual =
        optional_nonnegative_f64(mode, "floquet_cartesian_magnetic_seam_relative_residual")?;
    let equilibrium_pair_relative_residual =
        optional_nonnegative_f64(mode, "floquet_equilibrium_pair_relative_residual")?;
    let gauge_constraint_backward_error =
        optional_nonnegative_f64(mode, "gauge_constraint_backward_error")?;
    if mode.get("gauge_constraint_backward_error").is_none()
        || gauge_constraint_backward_error.is_some()
        || mode
            .get("gauge_constraint_policy")
            .and_then(serde_json::Value::as_str)
            != Some("nonzero_k_poisson_without_mean_constraint")
    {
        return Err(RunError {
            message: "native nonzero-k Floquet mode must identify the invertible Poisson gauge policy and leave the inapplicable gauge residual null".into(),
        });
    }

    if full_descriptor_certified {
        const TOLERANCE: f64 = 1.0e-8;
        let required_residuals = [
            ("magnetic_relative_residual", magnetic_relative_residual),
            ("potential_relative_residual", potential_relative_residual),
            (
                "floquet_full_magnetic_relative_residual",
                full_magnetic_relative_residual,
            ),
            (
                "floquet_full_potential_relative_residual",
                full_potential_relative_residual,
            ),
            (
                "floquet_scalar_phase_seam_relative_residual",
                scalar_phase_seam_relative_residual,
            ),
            (
                "floquet_tangent_frame_seam_relative_residual",
                tangent_frame_seam_relative_residual,
            ),
            (
                "floquet_cartesian_magnetic_seam_relative_residual",
                cartesian_magnetic_seam_relative_residual,
            ),
            (
                "floquet_equilibrium_pair_relative_residual",
                equilibrium_pair_relative_residual,
            ),
        ];
        if !seam_frame_certified || !gauge_policy_satisfied {
            return Err(RunError {
                message: "native full Floquet descriptor certificate is missing seam or gauge-policy proof".into(),
            });
        }
        for (name, value) in required_residuals {
            if !value.is_some_and(|value| value <= TOLERANCE) {
                return Err(RunError {
                    message: format!(
                        "native full Floquet certificate requires '{name}' in [0, {TOLERANCE}]"
                    ),
                });
            }
        }
    }

    Ok(NativeFloquetModeCertificate {
        descriptor_certified,
        full_descriptor_certified,
        seam_frame_certified,
        gauge_policy_satisfied,
        geometric_bc_certified: false,
        poisson_boundary_kind: Some(poisson_boundary_kind),
        poisson_gauge_policy: Some(poisson_gauge_policy),
        potential_representation: Some(potential_representation),
        magnetic_relative_residual,
        potential_relative_residual,
        full_magnetic_relative_residual,
        full_potential_relative_residual,
        scalar_phase_seam_relative_residual,
        tangent_frame_seam_relative_residual,
        cartesian_magnetic_seam_relative_residual,
        equilibrium_pair_relative_residual,
        potential_real_split: Vec::new(),
    })
}

/// Parse the optional certificate emitted by the native nonzero-k Floquet
/// modal formatter. The payload stays in the doubled real-split complex
/// coefficient layout; it is not a Cartesian mesh field.
fn native_floquet_mode_certificate_from_json(
    mode: &serde_json::Value,
    normalization_scale: f64,
) -> Result<NativeFloquetModeCertificate, RunError> {
    native_floquet_mode_certificate_from_payload(mode, normalization_scale, None)
}

fn native_floquet_mode_certificate_from_payload(
    mode: &serde_json::Value,
    normalization_scale: f64,
    typed_phi: Option<&[NativeModalComplex64]>,
) -> Result<NativeFloquetModeCertificate, RunError> {
    const CERTIFICATE_KEYS: [&str; 7] = [
        "floquet_descriptor_certified",
        "floquet_geometric_bc_certified",
        "potential_representation",
        "magnetic_relative_residual",
        "potential_relative_residual",
        "potential_vector_real",
        "potential_vector_imag",
    ];
    let has_any = CERTIFICATE_KEYS.iter().any(|key| mode.get(*key).is_some());
    if !has_any {
        return Ok(NativeFloquetModeCertificate::default());
    }

    let descriptor_certified = mode
        .get("floquet_descriptor_certified")
        .and_then(serde_json::Value::as_bool)
        .ok_or_else(|| RunError {
            message:
                "native Floquet mode certificate requires boolean floquet_descriptor_certified"
                    .to_string(),
        })?;
    if !descriptor_certified {
        if CERTIFICATE_KEYS[1..]
            .iter()
            .any(|key| mode.get(*key).is_some())
        {
            return Err(RunError {
                message: "native Floquet mode has certificate payload while floquet_descriptor_certified is false".to_string(),
            });
        }
        return Ok(NativeFloquetModeCertificate::default());
    }

    let geometric_bc_certified = mode
        .get("floquet_geometric_bc_certified")
        .and_then(serde_json::Value::as_bool)
        .ok_or_else(|| RunError {
            message:
                "native Floquet descriptor certificate is missing boolean floquet_geometric_bc_certified"
                    .to_string(),
        })?;
    if geometric_bc_certified {
        return Err(RunError {
            message:
                "native Floquet descriptor certificate cannot claim geometric BC certification"
                    .to_string(),
        });
    }
    let potential_representation = mode
        .get("potential_representation")
        .and_then(serde_json::Value::as_str)
        .filter(|value| *value == "doubled_real_split_complex_coefficients")
        .map(str::to_owned)
        .ok_or_else(|| RunError {
            message:
                "native Floquet descriptor certificate has unsupported potential_representation"
                    .to_string(),
        })?;
    let magnetic_relative_residual = required_f64(mode, "magnetic_relative_residual")?;
    let potential_relative_residual = required_f64(mode, "potential_relative_residual")?;
    for (name, value) in [
        ("magnetic_relative_residual", magnetic_relative_residual),
        ("potential_relative_residual", potential_relative_residual),
    ] {
        if !(0.0..=1.0e-8).contains(&value) {
            return Err(RunError {
                message: format!(
                    "native Floquet descriptor certificate field '{name}' must be in [0, 1e-8]"
                ),
            });
        }
    }
    if !(normalization_scale.is_finite() && normalization_scale > 0.0) {
        return Err(RunError {
            message: "native Floquet descriptor certificate requires a positive finite normalization scale"
                .to_string(),
        });
    }
    let potential_real_split = if let Some(phi) = typed_phi {
        if mode.get("potential_vector_real").is_some()
            || mode.get("potential_vector_imag").is_some()
        {
            return Err(RunError {
                message: "native typed Floquet potential must not be duplicated in JSON".into(),
            });
        }
        if phi.is_empty() || phi.len() % 2 != 0 {
            return Err(RunError {
                message: format!(
                    "native typed Floquet potential requires a non-empty even coefficient count, got {}",
                    phi.len()
                ),
            });
        }
        if mode
            .get("potential_dof_count")
            .and_then(serde_json::Value::as_u64)
            .is_some_and(|count| count != phi.len() as u64)
        {
            return Err(RunError {
                message: "native typed Floquet potential count disagrees with potential_dof_count"
                    .into(),
            });
        }
        phi.iter()
            .map(|value| Complex64::new(value.real, value.imag) / normalization_scale)
            .collect::<Vec<_>>()
    } else {
        let potential_real = required_f64_array(mode, "potential_vector_real")?;
        let potential_imag = required_f64_array(mode, "potential_vector_imag")?;
        if potential_real.is_empty()
            || potential_real.len() != potential_imag.len()
            || potential_real.len() % 2 != 0
        {
            return Err(RunError {
                message: format!(
                    "native Floquet potential real-split vector requires equal non-empty even lengths: real={}, imag={}",
                    potential_real.len(),
                    potential_imag.len()
                ),
            });
        }
        potential_real
            .into_iter()
            .zip(potential_imag)
            .map(|(real, imag)| Complex64::new(real, imag) / normalization_scale)
            .collect::<Vec<_>>()
    };
    if potential_real_split
        .iter()
        .any(|value| !value.re.is_finite() || !value.im.is_finite())
    {
        return Err(RunError {
            message:
                "native Floquet descriptor certificate potential payload overflows after normalization"
                    .to_string(),
        });
    }
    Ok(NativeFloquetModeCertificate {
        descriptor_certified: true,
        full_descriptor_certified: false,
        seam_frame_certified: false,
        gauge_policy_satisfied: false,
        geometric_bc_certified: false,
        poisson_boundary_kind: None,
        poisson_gauge_policy: None,
        potential_representation: Some(potential_representation),
        magnetic_relative_residual: Some(magnetic_relative_residual),
        potential_relative_residual: Some(potential_relative_residual),
        full_magnetic_relative_residual: None,
        full_potential_relative_residual: None,
        scalar_phase_seam_relative_residual: None,
        tangent_frame_seam_relative_residual: None,
        cartesian_magnetic_seam_relative_residual: None,
        equilibrium_pair_relative_residual: None,
        potential_real_split,
    })
}

pub(super) fn normalize_complex_block_mode(
    vector: &mut [Complex64],
    mass: &dyn ModalMassMetric,
    normalization: EigenNormalizationIR,
) -> Result<f64, RunError> {
    if mass.nrows() != vector.len() {
        return Err(RunError {
            message: "modal normalization mass metric dimensions do not match the vector".into(),
        });
    }
    let quadratic = match normalization {
        EigenNormalizationIR::UnitL2 => Some(mass.normalization_quadratic_form(vector)?),
        EigenNormalizationIR::UnitMaxAmplitude => None,
    };
    let scale = checked_complex_normalization_scale(vector, quadratic, &normalization)?;
    let normalized = normalize_complex_vector_with_scale(vector, scale)?;
    // Commit the complete checked vector atomically; invalid input leaves it intact.
    vector.copy_from_slice(&normalized);
    Ok(scale)
}
pub(super) fn complex_block_mass_norm(
    mass: &dyn ModalMassMetric,
    vector: &[Complex64],
) -> Complex64 {
    mass.quadratic_form(vector)
}

pub(super) fn gyrotropic_pencil_residual_norms(
    stiffness_omega: &DMatrix<f64>,
    gyrotropic_row_major: &[f64],
    lambda: Complex64,
    vector: &[Complex64],
) -> (f64, f64, f64) {
    let dim = vector.len();
    let mut residual_l2: f64 = 0.0;
    let mut residual_linf: f64 = 0.0;
    let mut k_norm_l2: f64 = 0.0;
    let mut g_norm_l2: f64 = 0.0;
    for row in 0..dim {
        let mut k_row = Complex64::new(0.0, 0.0);
        let mut g_row = Complex64::new(0.0, 0.0);
        for col in 0..dim {
            k_row += vector[col] * stiffness_omega[(row, col)];
            g_row += vector[col] * gyrotropic_row_major[row * dim + col];
        }
        let residual = k_row - lambda * g_row;
        let residual_norm = residual.norm();
        residual_l2 += residual_norm * residual_norm;
        residual_linf = residual_linf.max(residual_norm);
        k_norm_l2 += k_row.norm_sqr();
        g_norm_l2 += g_row.norm_sqr();
    }
    let residual_absolute_l2 = residual_l2.sqrt();
    let denominator = k_norm_l2.sqrt() + lambda.norm() * g_norm_l2.sqrt();
    let residual_relative_l2 = if denominator > 0.0 {
        residual_absolute_l2 / denominator
    } else {
        residual_absolute_l2
    };
    (residual_absolute_l2, residual_relative_l2, residual_linf)
}

#[cfg(test)]
mod tests {
    use super::*;

    fn native_complex(real: f64, imag: f64) -> NativeModalComplex64 {
        NativeModalComplex64 { real, imag }
    }

    fn shared_poisson_mode_metadata(
        mode_index: u64,
        frequency_hz: f64,
        residual: f64,
    ) -> serde_json::Value {
        let omega = std::f64::consts::TAU * frequency_hz;
        serde_json::json!({
            "mode_vector_transport": NATIVE_MODAL_TYPED_VECTOR_TRANSPORT,
            "mode_index": mode_index,
            "q_dof_count": 4,
            "phi_dof_count": 3,
            "q_layout": "block_component_node",
            "phi_layout": "native_complex_dof",
            "potential_dof_count": 3,
            "eigenvalue_real": 0.0,
            "eigenvalue_imag": omega,
            "omega_rad_s": omega,
            "frequency_hz": frequency_hz,
            "relative_residual": residual,
            "full_residual_reconstruction_relative_error": residual,
            "magnetic_block_backward_error": 3.0e-12,
            "poisson_block_backward_error": 4.0e-12,
            "gauge_constraint_backward_error": null
        })
    }

    fn shared_poisson_typed_fixture() -> (serde_json::Value, NativeModalEigenTypedResult) {
        let modes = vec![
            shared_poisson_mode_metadata(0, 3.0e9, 1.0e-12),
            shared_poisson_mode_metadata(1, 4.0e9, 2.0e-12),
        ];
        let result = serde_json::json!({
            "solver_adapter": "k0_poisson_airbox_cpu_full_coupled_slepc",
            "accepted_mode_count": 2,
            "modes": modes
        });
        let omega0 = std::f64::consts::TAU * 3.0e9;
        let omega1 = std::f64::consts::TAU * 4.0e9;
        let typed = NativeModalEigenTypedResult {
            q_dof_count: 4,
            phi_dof_count: 3,
            mode_lambda: vec![native_complex(0.0, omega0), native_complex(0.0, omega1)],
            mode_q_complex: vec![
                native_complex(1.0, 0.0),
                native_complex(0.0, 0.0),
                native_complex(0.0, 0.0),
                native_complex(0.0, 1.0),
                native_complex(0.0, 0.0),
                native_complex(2.0, 0.0),
                native_complex(0.0, 3.0),
                native_complex(0.0, 0.0),
            ],
            mode_phi_complex: vec![
                native_complex(2.0, 4.0),
                native_complex(3.0, 5.0),
                native_complex(7.0, 11.0),
                native_complex(13.0, 17.0),
                native_complex(19.0, 23.0),
                native_complex(29.0, 31.0),
            ],
            mode_delta_m_xyz_complex: Vec::new(),
            mode_residuals: vec![1.0e-12, 2.0e-12],
            mode_cluster_ids: Vec::new(),
            resolved_execution_target: 0,
            resolved_scalar_representation: 0,
            resolved_spectral_transform_kind: 0,
        };
        (result, typed)
    }

    fn shared_context<'a>(
        mass: &'a DMatrix<f64>,
        active_nodes: &'a [usize],
        magnetic_classes: &'a [u32],
        node_phases: Option<&'a [Complex64]>,
    ) -> SharedDomainModeContext<'a> {
        SharedDomainModeContext {
            reduced_tangent_mass: mass,
            active_nodes,
            magnetic_classes,
            magnetic_class_count: 2,
            node_phases,
        }
    }

    fn legacy_shared_poisson_result() -> serde_json::Value {
        let mut mode0 = shared_poisson_mode_metadata(0, 3.0e9, 1.0e-12);
        mode0["mode_q_real"] = serde_json::json!([1.0, 0.0, 0.0, 0.0]);
        mode0["mode_q_imag"] = serde_json::json!([0.0, 0.0, 0.0, 1.0]);
        mode0["mode_phi_real"] = serde_json::json!([2.0, 3.0, 7.0]);
        mode0["mode_phi_imag"] = serde_json::json!([4.0, 5.0, 11.0]);
        let mut mode1 = shared_poisson_mode_metadata(1, 4.0e9, 2.0e-12);
        mode1["mode_q_real"] = serde_json::json!([0.0, 2.0, 0.0, 0.0]);
        mode1["mode_q_imag"] = serde_json::json!([0.0, 0.0, 3.0, 0.0]);
        mode1["mode_phi_real"] = serde_json::json!([13.0, 19.0, 29.0]);
        mode1["mode_phi_imag"] = serde_json::json!([17.0, 23.0, 31.0]);
        serde_json::json!({
            "solver_adapter": "k0_poisson_airbox_cpu_full_coupled_slepc",
            "accepted_mode_count": 2,
            "modes": [mode0, mode1]
        })
    }

    #[test]
    fn native_modal_residual_parser_keeps_unknown_norms_unavailable() {
        let mode = serde_json::json!({"relative_residual": 2.5e-10});
        let (absolute, relative, linf, backend) =
            native_modal_residuals_from_json(&mode).expect("relative residual should parse");

        assert_eq!(absolute, None);
        assert_eq!(relative, 2.5e-10);
        assert_eq!(linf, None);
        assert_eq!(backend, None);
    }

    #[test]
    fn physical_potential_accepts_odd_dof_count_without_doubled_real_layout() {
        let mut mode = serde_json::json!({
            "potential_dof_count": 3,
            "mode_phi_real": [1.0, 2.0, 3.0],
            "mode_phi_imag": [0.5, 0.0, -0.5]
        });
        validate_native_physical_potential_layout(&mode).unwrap();
        mode["potential_vector_real"] = serde_json::json!([1.0, 2.0, 3.0]);
        assert!(validate_native_physical_potential_layout(&mode)
            .unwrap_err()
            .message
            .contains("doubled-real"));
        mode.as_object_mut()
            .unwrap()
            .remove("potential_vector_real");
        mode["potential_dof_count"] = serde_json::json!(6);
        assert!(validate_native_physical_potential_layout(&mode).is_err());
    }

    #[test]
    fn native_floquet_certificate_payload_roundtrips_to_interleaved_binary() {
        let mode = serde_json::json!({
            "floquet_descriptor_certified": true,
            "floquet_geometric_bc_certified": false,
            "potential_representation": "doubled_real_split_complex_coefficients",
            "magnetic_relative_residual": 2.0e-10,
            "potential_relative_residual": 3.0e-10,
            "potential_vector_real": [2.0, -4.0, 6.0, -8.0],
            "potential_vector_imag": [1.0, -3.0, 5.0, -7.0],
        });

        let certificate = native_floquet_mode_certificate_from_json(&mode, 2.0)
            .expect("valid native Floquet certificate should parse");
        assert!(certificate.descriptor_certified);
        assert!(!certificate.geometric_bc_certified);
        assert_eq!(
            certificate.potential_real_split,
            vec![
                Complex64::new(1.0, 0.5),
                Complex64::new(-2.0, -1.5),
                Complex64::new(3.0, 2.5),
                Complex64::new(-4.0, -3.5),
            ]
        );

        let bytes = super::super::eigen_output::floquet_potential_payload_bytes(
            &certificate.potential_real_split,
        )
        .expect("parsed potential should serialize");
        assert_eq!(bytes.len(), certificate.potential_real_split.len() * 16);
        for (index, value) in certificate.potential_real_split.iter().enumerate() {
            let offset = index * 16;
            assert_eq!(
                f64::from_le_bytes(bytes[offset..offset + 8].try_into().unwrap()),
                value.re
            );
            assert_eq!(
                f64::from_le_bytes(bytes[offset + 8..offset + 16].try_into().unwrap()),
                value.im
            );
        }
    }

    #[test]
    fn native_floquet_certificate_rejects_payload_when_descriptor_is_false() {
        let mode = serde_json::json!({
            "floquet_descriptor_certified": false,
            "potential_vector_real": [1.0, 2.0],
            "potential_vector_imag": [0.0, 0.0],
        });

        let error = native_floquet_mode_certificate_from_json(&mode, 1.0)
            .expect_err("non-certified Floquet payload must be rejected");
        assert!(error.message.contains("certificate payload"));
    }

    #[test]
    fn native_floquet_certificate_rejects_geometric_bc_claim() {
        let mode = serde_json::json!({
            "floquet_descriptor_certified": true,
            "floquet_geometric_bc_certified": true,
            "potential_representation": "doubled_real_split_complex_coefficients",
            "magnetic_relative_residual": 1.0e-10,
            "potential_relative_residual": 1.0e-10,
            "potential_vector_real": [1.0, 2.0],
            "potential_vector_imag": [0.0, 0.0],
        });

        let error = native_floquet_mode_certificate_from_json(&mode, 1.0)
            .expect_err("geometric BC claim must be rejected");
        assert!(error.message.contains("geometric BC"));
    }

    #[test]
    fn typed_shared_poisson_modes_match_legacy_vectors_phase_and_full_phi() {
        let plan = super::super::eigen_tests::minimal_native_modal_plan();
        let (typed_metadata, typed_buffers) = shared_poisson_typed_fixture();
        let legacy_result = legacy_shared_poisson_result();
        let mass = DMatrix::<f64>::identity(4, 4);
        let active_nodes = [0_usize, 1_usize];
        let magnetic_classes = [0_u32, 1_u32];
        let phases = [Complex64::new(1.0, 0.0), Complex64::new(0.0, -1.0)];
        let context = shared_context(&mass, &active_nodes, &magnetic_classes, Some(&phases));

        let legacy = native_modal_modes_from_result_json(
            &plan,
            &legacy_result.to_string(),
            None,
            Some(&context),
        )
        .expect("literal legacy fixture should be admitted");
        let typed = native_modal_modes_from_typed_result(
            &plan,
            &typed_metadata.to_string(),
            Some(&typed_buffers),
            None,
            Some(&context),
        )
        .expect("typed CPU vectors should preserve legacy admission");

        assert_eq!(typed.len(), 2);
        assert_eq!(typed[0].frequency_hz, 3.0e9);
        assert_eq!(typed[1].frequency_hz, 4.0e9);
        for (legacy_mode, typed_mode) in legacy.iter().zip(&typed) {
            assert_eq!(typed_mode.frequency_hz, legacy_mode.frequency_hz);
            assert_eq!(typed_mode.eigenvalue_real, legacy_mode.eigenvalue_real);
            assert_eq!(typed_mode.eigenvalue_imag, legacy_mode.eigenvalue_imag);
            assert_eq!(
                typed_mode.residual_relative_l2,
                legacy_mode.residual_relative_l2
            );
            assert_eq!(typed_mode.mass_norm, legacy_mode.mass_norm);
            assert_eq!(typed_mode.q_vector, legacy_mode.q_vector);
            assert_eq!(typed_mode.phi_vector, legacy_mode.phi_vector);
            assert_eq!(typed_mode.vector, legacy_mode.vector);
        }
        assert_eq!(typed[0].phi_vector.len(), 3);
        assert_eq!(
            typed[0].phi_vector[2],
            Complex64::new(7.0, 11.0) / 2.0_f64.sqrt()
        );
        assert_eq!(
            typed[1].vector[1],
            Complex64::new(0.0, -2.0) / 13.0_f64.sqrt()
        );
    }

    #[test]
    fn typed_physical_floquet_keeps_interleaved_q_phase_and_odd_full_phi() {
        let plan = super::super::eigen_tests::minimal_native_modal_plan();
        let omega = std::f64::consts::TAU * 3.0e9;
        let mode = serde_json::json!({
            "mode_vector_transport": NATIVE_MODAL_TYPED_VECTOR_TRANSPORT,
            "mode_index": 0,
            "q_dof_count": 4,
            "phi_dof_count": 3,
            "floquet_mode_vector_physical_complex": true,
            "q_layout": "interleaved_node_component",
            "phi_layout": "complex_coefficients",
            "potential_dof_count": 3,
            "potential_representation": "complex_coefficients",
            "floquet_descriptor_certified": false,
            "floquet_full_descriptor_certified": false,
            "floquet_seam_frame_certified": false,
            "floquet_gauge_policy_satisfied": true,
            "floquet_geometric_bc_certified": false,
            "poisson_boundary_kind": "pure_neumann",
            "poisson_gauge_policy": "require_invertible",
            "gauge_constraint_backward_error": null,
            "gauge_constraint_policy": "nonzero_k_poisson_without_mean_constraint",
            "eigenvalue_real": 0.0,
            "eigenvalue_imag": omega,
            "omega_rad_s": omega,
            "frequency_hz": 3.0e9,
            "relative_residual": 1.0e-12,
            "magnetic_block_backward_error": 3.0e-12,
            "poisson_block_backward_error": 4.0e-12
        });
        let typed_metadata = serde_json::json!({
            "solver_adapter": "floquet_airbox_cpu_schur_slepc",
            "accepted_mode_count": 1,
            "modes": [mode.clone()]
        });
        let mut legacy_mode = mode;
        legacy_mode["mode_q_real"] = serde_json::json!([1.0, 0.0, 0.0, 0.0]);
        legacy_mode["mode_q_imag"] = serde_json::json!([0.0, 0.0, 0.0, 1.0]);
        legacy_mode["mode_phi_real"] = serde_json::json!([2.0, 3.0, 7.0]);
        legacy_mode["mode_phi_imag"] = serde_json::json!([4.0, 5.0, 11.0]);
        let legacy_json = serde_json::json!({
            "solver_adapter": "floquet_airbox_cpu_schur_slepc",
            "accepted_mode_count": 1,
            "modes": [legacy_mode]
        });
        let typed_buffers = NativeModalEigenTypedResult {
            q_dof_count: 4,
            phi_dof_count: 3,
            mode_lambda: vec![native_complex(0.0, omega)],
            mode_q_complex: vec![
                native_complex(1.0, 0.0),
                native_complex(0.0, 0.0),
                native_complex(0.0, 0.0),
                native_complex(0.0, 1.0),
            ],
            mode_phi_complex: vec![
                native_complex(2.0, 4.0),
                native_complex(3.0, 5.0),
                native_complex(7.0, 11.0),
            ],
            mode_delta_m_xyz_complex: Vec::new(),
            mode_residuals: vec![1.0e-12],
            mode_cluster_ids: Vec::new(),
            resolved_execution_target: 0,
            resolved_scalar_representation: 0,
            resolved_spectral_transform_kind: 0,
        };
        let mass = DMatrix::<f64>::identity(4, 4);
        let active_nodes = [0_usize, 1_usize];
        let magnetic_classes = [0_u32, 1_u32];
        let phases = [Complex64::new(1.0, 0.0), Complex64::new(0.0, -1.0)];
        let context = shared_context(&mass, &active_nodes, &magnetic_classes, Some(&phases));
        let legacy = native_modal_modes_from_result_json(
            &plan,
            &legacy_json.to_string(),
            None,
            Some(&context),
        )
        .expect("legacy physical-complex Floquet fixture should parse");
        let typed = native_modal_modes_from_typed_result(
            &plan,
            &typed_metadata.to_string(),
            Some(&typed_buffers),
            None,
            Some(&context),
        )
        .expect("typed physical-complex Floquet vectors should preserve the legacy layout");

        assert_eq!(typed[0].q_vector, legacy[0].q_vector);
        assert_eq!(typed[0].vector, legacy[0].vector);
        assert_eq!(typed[0].phi_vector, legacy[0].phi_vector);
        assert_eq!(
            typed[0].floquet_potential_representation.as_deref(),
            Some("complex_coefficients")
        );
        assert_eq!(typed[0].phi_vector.len(), 3);
        assert_eq!(
            typed[0].phi_vector[2],
            Complex64::new(7.0, 11.0) / 2.0_f64.sqrt()
        );
        assert_eq!(
            typed[0].vector[3],
            Complex64::new(1.0, 0.0) / 2.0_f64.sqrt()
        );
    }

    #[test]
    fn typed_zero_phi_requires_null_layout_and_no_potential_representation() {
        let (mut metadata, mut buffers) = shared_poisson_typed_fixture();
        metadata["solver_adapter"] = serde_json::json!("cpu_native_operator");
        buffers.phi_dof_count = 0;
        buffers.mode_phi_complex.clear();
        for mode in metadata["modes"].as_array_mut().unwrap() {
            mode["phi_dof_count"] = serde_json::json!(0);
            mode["potential_dof_count"] = serde_json::json!(0);
            mode["phi_layout"] = serde_json::Value::Null;
            mode["q_layout"] = serde_json::json!("native_complex_dof");
        }
        assert_eq!(native_modal_typed_modes(&metadata, &buffers).unwrap().len(), 2);

        for value in [serde_json::json!({}), serde_json::json!([]),
                      serde_json::json!(true), serde_json::json!(7),
                      serde_json::json!("native_complex_dof")] {
            let mut malformed = metadata.clone();
            malformed["modes"][0]["phi_layout"] = value;
            assert!(native_modal_typed_modes(&malformed, &buffers)
                .unwrap_err().message.contains("phi_layout disagrees"));
        }
        for value in [serde_json::json!("unknown"),
                      serde_json::json!("complex_coefficients"),
                      serde_json::json!("doubled_real_split_complex_coefficients"),
                      serde_json::Value::Null, serde_json::json!({}),
                      serde_json::json!(true), serde_json::json!(7)] {
            let mut malformed = metadata.clone();
            malformed["modes"][0]["potential_representation"] = value;
            let error = native_modal_typed_modes(&malformed, &buffers).unwrap_err();
            assert!(error.message.contains("potential_representation"));
        }
    }

    #[test]
    fn typed_modal_transport_rejects_bad_metadata_buffers_and_scalars() {
        let (metadata, buffers) = shared_poisson_typed_fixture();

        let mut invalid_accepted_count = metadata.clone();
        invalid_accepted_count["accepted_mode_count"] = serde_json::json!("2");
        assert!(native_modal_typed_modes(&invalid_accepted_count, &buffers)
            .unwrap_err()
            .message
            .contains("accepted_mode_count must be an unsigned integer"));

        let mut missing_marker = metadata.clone();
        missing_marker["modes"][0]
            .as_object_mut()
            .unwrap()
            .remove("mode_vector_transport");
        assert!(native_modal_typed_modes(&missing_marker, &buffers)
            .unwrap_err()
            .message
            .contains("mode_vector_transport"));

        let mut wrong_index = metadata.clone();
        wrong_index["modes"][1]["mode_index"] = serde_json::json!(0);
        assert!(native_modal_typed_modes(&wrong_index, &buffers)
            .unwrap_err()
            .message
            .contains("contiguous accepted order"));

        let mut wrong_width = metadata.clone();
        wrong_width["modes"][0]["q_dof_count"] = serde_json::json!(5);
        assert!(native_modal_typed_modes(&wrong_width, &buffers)
            .unwrap_err()
            .message
            .contains("DOF counts"));

        let mut missing_phi_layout = metadata.clone();
        missing_phi_layout["modes"][0]["phi_layout"] = serde_json::Value::Null;
        assert!(native_modal_typed_modes(&missing_phi_layout, &buffers)
            .unwrap_err()
            .message
            .contains("phi_layout disagrees"));

        let mut duplicated_cartesian = metadata.clone();
        duplicated_cartesian["modes"][0]["mode_delta_m_xyz_complex"] =
            serde_json::json!([1.0, 2.0]);
        assert!(native_modal_typed_modes(&duplicated_cartesian, &buffers)
            .unwrap_err()
            .message
            .contains("duplicates typed vectors"));

        let mut short_buffers = buffers.clone();
        short_buffers.mode_q_complex.pop();
        assert!(native_modal_typed_modes(&metadata, &short_buffers)
            .unwrap_err()
            .message
            .contains("vector buffer counts"));

        let mut nonfinite = buffers.clone();
        nonfinite.mode_q_complex[0].real = f64::NAN;
        assert!(native_modal_typed_modes(&metadata, &nonfinite)
            .unwrap_err()
            .message
            .contains("must be finite"));

        let mut wrong_lambda = buffers.clone();
        wrong_lambda.mode_lambda[0].imag += 1.0;
        assert!(native_modal_typed_modes(&metadata, &wrong_lambda)
            .unwrap_err()
            .message
            .contains("lambda[0] disagrees"));

        let mut wrong_residual = buffers.clone();
        wrong_residual.mode_residuals[1] += 1.0e-15;
        assert!(native_modal_typed_modes(&metadata, &wrong_residual)
            .unwrap_err()
            .message
            .contains("residual[1] disagrees"));

        let plan = super::super::eigen_tests::minimal_native_modal_plan();
        let missing_typed =
            native_modal_modes_from_typed_result(&plan, &metadata.to_string(), None, None, None)
                .expect_err("live CPU admission must reject missing typed buffers");
        assert!(missing_typed
            .message
            .contains("owned typed ABI v18 buffers"));
    }

    #[test]
    fn typed_interrupted_prefix_is_exact_and_does_not_gain_legacy_phi() {
        let plan = super::super::eigen_tests::minimal_native_modal_plan();
        let (metadata, buffers) = shared_poisson_typed_fixture();
        let mass = DMatrix::<f64>::identity(4, 4);
        let active_nodes = [0_usize, 1_usize];
        let magnetic_classes = [0_u32, 1_u32];
        let phases = [Complex64::new(1.0, 0.0), Complex64::new(0.0, -1.0)];
        let context = shared_context(&mass, &active_nodes, &magnetic_classes, Some(&phases));

        let mut prefix_metadata = metadata.clone();
        prefix_metadata["modes"].as_array_mut().unwrap().truncate(1);
        prefix_metadata["accepted_mode_count"] = serde_json::json!(1);
        let mut prefix_buffers = buffers.clone();
        prefix_buffers.mode_lambda.truncate(1);
        prefix_buffers.mode_residuals.truncate(1);
        prefix_buffers.mode_q_complex.truncate(4);
        prefix_buffers.mode_phi_complex.truncate(3);
        let prefix = native_modal_modes_from_typed_result(
            &plan,
            &prefix_metadata.to_string(),
            Some(&prefix_buffers),
            None,
            Some(&context),
        )
        .expect("interrupted typed results retain the accepted prefix");
        assert_eq!(prefix.len(), 1);
        assert_eq!(prefix[0].frequency_hz, 3.0e9);
        assert!(native_modal_typed_modes(&metadata, &prefix_buffers)
            .unwrap_err()
            .message
            .contains("scalar buffer counts"));

        let omega = std::f64::consts::TAU * 3.0e9;
        let mut uncertified_mode = serde_json::json!({
            "mode_vector_transport": NATIVE_MODAL_TYPED_VECTOR_TRANSPORT,
            "mode_index": 0,
            "q_dof_count": 4,
            "phi_dof_count": 2,
            "q_layout": "doubled_real_split",
            "phi_layout": "doubled_real_split_complex_coefficients",
            "eigenvalue_real": 0.0,
            "eigenvalue_imag": omega,
            "omega_rad_s": omega,
            "frequency_hz": 3.0e9,
            "relative_residual": 1.0e-12
        });
        let uncertified_metadata = serde_json::json!({
            "solver_adapter": "k0_poisson_airbox_cpu_full_coupled_slepc",
            "accepted_mode_count": 1,
            "modes": [uncertified_mode.clone()]
        });
        let uncertified_buffers = NativeModalEigenTypedResult {
            q_dof_count: 4,
            phi_dof_count: 2,
            mode_lambda: vec![native_complex(0.0, omega)],
            mode_q_complex: vec![
                native_complex(1.0, 0.0),
                native_complex(0.0, 0.0),
                native_complex(0.0, 0.0),
                native_complex(0.0, 0.0),
            ],
            mode_phi_complex: vec![native_complex(2.0, 1.0), native_complex(-4.0, -3.0)],
            mode_delta_m_xyz_complex: Vec::new(),
            mode_residuals: vec![1.0e-12],
            mode_cluster_ids: Vec::new(),
            resolved_execution_target: 0,
            resolved_scalar_representation: 0,
            resolved_spectral_transform_kind: 0,
        };
        let context = shared_context(&mass, &active_nodes, &magnetic_classes, None);
        let typed_error = native_modal_modes_from_typed_result(
            &plan,
            &uncertified_metadata.to_string(),
            Some(&uncertified_buffers),
            None,
            Some(&context),
        )
        .expect_err("typed uncertified phi must not bypass the old shared-domain requirement");

        uncertified_mode["mode_vector_real"] = serde_json::json!([1.0, 0.0, 0.0, 0.0]);
        uncertified_mode["mode_vector_imag"] = serde_json::json!([0.0, 0.0, 0.0, 0.0]);
        let legacy_uncertified = serde_json::json!({
            "solver_adapter": "k0_poisson_airbox_cpu_full_coupled_slepc",
            "modes": [uncertified_mode]
        });
        let legacy_error = native_modal_modes_from_result_json(
            &plan,
            &legacy_uncertified.to_string(),
            None,
            Some(&context),
        )
        .expect_err("legacy uncertified phi omission remains rejected");
        assert_eq!(typed_error.message, legacy_error.message);
    }

    #[test]
    fn typed_nonphysical_floquet_phi_matches_legacy_certificate_payload() {
        let plan = super::super::eigen_tests::minimal_native_modal_plan();
        let omega = std::f64::consts::TAU * 1.0e9;
        let mode = serde_json::json!({
            "mode_vector_transport": NATIVE_MODAL_TYPED_VECTOR_TRANSPORT,
            "mode_index": 0,
            "q_dof_count": 4,
            "phi_dof_count": 2,
            "floquet_mode_vector_physical_complex": false,
            "q_layout": "doubled_real_split",
            "phi_layout": "doubled_real_split_complex_coefficients",
            "potential_dof_count": 2,
            "potential_representation": "doubled_real_split_complex_coefficients",
            "floquet_descriptor_certified": true,
            "floquet_geometric_bc_certified": false,
            "magnetic_relative_residual": 1.0e-12,
            "potential_relative_residual": 2.0e-12,
            "eigenvalue_real": 0.0,
            "eigenvalue_imag": omega,
            "omega_rad_s": omega,
            "frequency_hz": 1.0e9,
            "relative_residual": 1.0e-12
        });
        let typed_metadata = serde_json::json!({
            "accepted_mode_count": 1,
            "modes": [mode.clone()]
        });
        let mut legacy_mode = mode;
        legacy_mode["mode_vector_real"] = serde_json::json!([2.0, 0.0, 0.0, 0.0]);
        legacy_mode["mode_vector_imag"] = serde_json::json!([2.0, 0.0, 0.0, 0.0]);
        legacy_mode["potential_vector_real"] = serde_json::json!([2.0, -4.0]);
        legacy_mode["potential_vector_imag"] = serde_json::json!([1.0, -3.0]);
        let legacy_json = serde_json::json!({
            "accepted_mode_count": 1,
            "modes": [legacy_mode]
        });
        let typed = NativeModalEigenTypedResult {
            q_dof_count: 4,
            phi_dof_count: 2,
            mode_lambda: vec![native_complex(0.0, omega)],
            mode_q_complex: vec![
                native_complex(2.0, 2.0),
                native_complex(0.0, 0.0),
                native_complex(0.0, 0.0),
                native_complex(0.0, 0.0),
            ],
            mode_phi_complex: vec![native_complex(2.0, 1.0), native_complex(-4.0, -3.0)],
            mode_delta_m_xyz_complex: Vec::new(),
            mode_residuals: vec![1.0e-12],
            mode_cluster_ids: Vec::new(),
            resolved_execution_target: 0,
            resolved_scalar_representation: 0,
            resolved_spectral_transform_kind: 0,
        };
        let payload = NativeBlochFloquetDensePayload {
            physical_complex_dof: 1,
            stiffness: DMatrix::<f64>::zeros(4, 4),
            gyrotropic_row_major: vec![0.0; 16],
            tangent_mass: DMatrix::<f64>::identity(4, 4),
            physical_mass: vec![vec![Complex64::new(1.0, 0.0)]],
        };
        let legacy =
            native_bloch_floquet_modes_from_result_json(&plan, &legacy_json.to_string(), &payload)
                .expect("literal legacy Floquet fixture should parse");
        let typed = native_bloch_floquet_modes_from_typed_result(
            &plan,
            &typed_metadata.to_string(),
            Some(&typed),
            &payload,
        )
        .expect("typed doubled-real q and phi should preserve the legacy certificate");
        assert_eq!(typed.len(), 1);
        assert_eq!(typed[0].vector, legacy[0].vector);
        assert_eq!(typed[0].eigenvalue_imag, legacy[0].eigenvalue_imag);
        assert_eq!(
            typed[0].floquet_descriptor_certified,
            legacy[0].floquet_descriptor_certified
        );
        assert_eq!(
            typed[0].floquet_potential_real_split,
            legacy[0].floquet_potential_real_split
        );
        assert_eq!(
            typed[0].floquet_potential_real_split,
            vec![
                Complex64::new(2.0, 1.0) / 2.0_f64.sqrt(),
                Complex64::new(-4.0, -3.0) / 2.0_f64.sqrt(),
            ]
        );
    }

    #[test]
    fn typed_contour_doubled_q_keeps_the_generic_legacy_basis() {
        let plan = super::super::eigen_tests::minimal_native_modal_plan();
        let omega = std::f64::consts::TAU * 1.0e9;
        let mode = serde_json::json!({
            "mode_vector_transport": NATIVE_MODAL_TYPED_VECTOR_TRANSPORT,
            "mode_index": 0,
            "q_dof_count": 4,
            "phi_dof_count": 0,
            "q_layout": "doubled_real_split",
            "phi_layout": null,
            "eigenvalue_real": 0.0,
            "eigenvalue_imag": omega,
            "omega_rad_s": omega,
            "frequency_hz": 1.0e9,
            "relative_residual": 1.0e-12
        });
        let typed_metadata = serde_json::json!({
            "solver_adapter": "native_modal_contour_cpu",
            "accepted_mode_count": 1,
            "modes": [mode.clone()]
        });
        let mut legacy_mode = mode;
        legacy_mode["mode_vector_real"] = serde_json::json!([2.0, 0.0, 0.0, 0.0]);
        legacy_mode["mode_vector_imag"] = serde_json::json!([2.0, 0.0, 0.0, 0.0]);
        let legacy_metadata = serde_json::json!({
            "solver_adapter": "native_modal_contour_cpu",
            "accepted_mode_count": 1,
            "modes": [legacy_mode]
        });
        let typed_buffers = NativeModalEigenTypedResult {
            q_dof_count: 4,
            phi_dof_count: 0,
            mode_lambda: vec![native_complex(0.0, omega)],
            mode_q_complex: vec![
                native_complex(2.0, 2.0),
                native_complex(0.0, 0.0),
                native_complex(0.0, 0.0),
                native_complex(0.0, 0.0),
            ],
            mode_phi_complex: Vec::new(),
            mode_delta_m_xyz_complex: Vec::new(),
            mode_residuals: vec![1.0e-12],
            mode_cluster_ids: Vec::new(),
            resolved_execution_target: 0,
            resolved_scalar_representation: 0,
            resolved_spectral_transform_kind: 0,
        };
        let stiffness = DMatrix::<f64>::identity(4, 4);
        let gyrotropic = vec![0.0; 16];
        let mass = DMatrix::<f64>::identity(4, 4);
        let legacy = native_modal_modes_from_result_json(
            &plan,
            &legacy_metadata.to_string(),
            Some((&stiffness, &gyrotropic, &mass)),
            None,
        )
        .expect("legacy contour fixture should parse in the generic route");
        let typed = native_modal_modes_from_typed_result(
            &plan,
            &typed_metadata.to_string(),
            Some(&typed_buffers),
            Some((&stiffness, &gyrotropic, &mass)),
            None,
        )
        .expect("typed contour q should preserve the generic legacy basis");
        assert_eq!(typed[0].vector, legacy[0].vector);
        assert_eq!(typed[0].vector.len(), 4);
        assert_eq!(typed[0].floquet_potential_real_split, Vec::new());
    }
}
