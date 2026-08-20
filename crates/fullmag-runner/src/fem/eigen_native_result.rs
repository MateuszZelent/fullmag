use super::eigen_solve::{
    complex_mass_norm, deembed_native_bloch_floquet_mode_vector, normalize_complex_mode,
};
use super::eigen_types::{NativeBlochFloquetDensePayload, SharedDomainModeContext};
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
    pub(super) residual_absolute_l2: f64,
    pub(super) residual_relative_l2: f64,
    pub(super) residual_linf: f64,
    pub(super) mass_norm: f64,
    pub(super) block_residual_q: f64,
    pub(super) block_residual_phi: f64,
    pub(super) block_residual_gauge: f64,
    pub(super) backend_reported_residual: f64,
    pub(super) vector: Vec<Complex64>,
    /// Native tangent coordinates before Cartesian mode-field projection.
    /// Shared-domain Poisson modes retain the scalar potential payload too;
    /// other modal lanes leave both fields empty.
    pub(super) q_vector: Vec<Complex64>,
    pub(super) phi_vector: Vec<Complex64>,
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
    let cpu_schur = solver_adapter == Some("k0_poisson_airbox_cpu_schur_slepc");
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
    if !is_native_poisson_airbox_modal_adapter(Some(solver_adapter)) {
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

pub(super) fn native_modal_modes_from_result_json(
    plan: &FemEigenPlanIR,
    raw: &str,
    runner_operator: Option<(&DMatrix<f64>, &[f64], &DMatrix<f64>)>,
    shared_domain_context: Option<&SharedDomainModeContext<'_>>,
) -> Result<Vec<NativeModalEigenpair>, RunError> {
    let result = serde_json::from_str::<serde_json::Value>(raw).map_err(|error| RunError {
        message: format!("failed to parse native modal result JSON: {error}"),
    })?;
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
    let mut modes = modes
        .iter()
        .map(|mode| {
            if poisson_airbox {
                let tangent_mass = shared_domain_context
                    .map(|context| context.reduced_tangent_mass)
                    .or_else(|| runner_operator.map(|(_, _, tangent_mass)| tangent_mass))
                    .ok_or_else(|| RunError {
                        message: "native Poisson-airbox modal result is missing its native shared-domain mass context"
                            .to_string(),
                    })?;
                native_poisson_airbox_mode_from_json(
                    plan,
                    mode,
                    tangent_mass,
                    shared_domain_context,
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
    tangent_mass: &DMatrix<f64>,
    shared_domain_context: Option<&SharedDomainModeContext<'_>>,
) -> Result<NativeModalEigenpair, RunError> {
    let real = mode
        .get("mode_q_real")
        .map(|_| required_f64_array(mode, "mode_q_real"))
        .unwrap_or_else(|| required_f64_array(mode, "mode_vector_real"))?;
    let imag = mode
        .get("mode_q_imag")
        .map(|_| required_f64_array(mode, "mode_q_imag"))
        .unwrap_or_else(|| required_f64_array(mode, "mode_vector_imag"))?;
    if real.len() != imag.len() || real.len() != tangent_mass.nrows() {
        return Err(RunError {
            message: format!(
                "native Poisson-airbox modal q vector length mismatch: real={}, imag={}, tangent_operator={}",
                real.len(),
                imag.len(),
                tangent_mass.nrows()
            ),
        });
    }
    let mut vector = real
        .iter()
        .zip(imag.iter())
        .map(|(re, im)| Complex64::new(*re, *im))
        .collect::<Vec<_>>();
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
    let eigenvalue_real = required_f64(mode, "eigenvalue_real")?;
    let eigenvalue_imag = required_f64(mode, "eigenvalue_imag")?;
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
        complex_block_mode_normalization_scale(&vector, tangent_mass, plan.normalization);
    normalize_complex_block_mode(&mut vector, tangent_mass, plan.normalization);
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
    if shared_domain_context.is_some() && phi_real.is_empty() {
        return Err(RunError {
            message: "native shared-domain modal result is missing the reconstructed phi vector"
                .to_string(),
        });
    }
    let phi_vector = phi_real
        .iter()
        .zip(phi_imag.iter())
        .map(|(re, im)| Complex64::new(*re, *im) / normalization_scale)
        .collect::<Vec<_>>();
    let residual = mode
        .get("full_residual_reconstruction_relative_error")
        .map(|_| required_f64(mode, "full_residual_reconstruction_relative_error"))
        .unwrap_or_else(|| required_f64(mode, "relative_residual"))?;
    let residual_relative_l2 = mode
        .get("relative_residual")
        .map(|_| required_f64(mode, "relative_residual"))
        .unwrap_or(Ok(residual))?;
    let block_residual_q = if shared_domain_context.is_some() {
        required_f64(mode, "magnetic_block_backward_error")?
    } else {
        mode.get("magnetic_block_backward_error")
            .map(|_| required_f64(mode, "magnetic_block_backward_error"))
            .transpose()?
            .unwrap_or(residual)
    };
    let block_residual_phi = if shared_domain_context.is_some() {
        required_f64(mode, "poisson_block_backward_error")?
    } else {
        mode.get("poisson_block_backward_error")
            .map(|_| required_f64(mode, "poisson_block_backward_error"))
            .transpose()?
            .unwrap_or(0.0)
    };
    let block_residual_gauge = if shared_domain_context.is_some() {
        required_f64(mode, "gauge_constraint_backward_error")?
    } else {
        mode.get("gauge_constraint_backward_error")
            .map(|_| required_f64(mode, "gauge_constraint_backward_error"))
            .transpose()?
            .unwrap_or(0.0)
    };
    for (name, value) in [
        ("magnetic_block_backward_error", block_residual_q),
        ("poisson_block_backward_error", block_residual_phi),
        ("gauge_constraint_backward_error", block_residual_gauge),
    ] {
        if value < 0.0 {
            return Err(RunError {
                message: format!("native modal result field '{name}' must be non-negative"),
            });
        }
    }
    let backend_reported_residual = mode
        .get("slepc_reported_backward_error")
        .map(|_| required_f64(mode, "slepc_reported_backward_error"))
        .transpose()?
        .unwrap_or(residual_relative_l2);
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
            expanded[active_position] = vector[class as usize];
            expanded[active_count + active_position] =
                vector[context.magnetic_class_count + class as usize];
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
        residual_absolute_l2: residual,
        residual_relative_l2,
        residual_linf: residual,
        mass_norm: complex_block_mass_norm(tangent_mass, &vector).re,
        block_residual_q,
        block_residual_phi,
        block_residual_gauge,
        backend_reported_residual,
        q_vector: vector.clone(),
        phi_vector,
        vector: vector_for_projection,
    })
}

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
        .map(|mode| native_bloch_floquet_mode_from_json(plan, mode, payload))
        .collect()
}

fn native_bloch_floquet_mode_from_json(
    plan: &FemEigenPlanIR,
    mode: &serde_json::Value,
    payload: &NativeBlochFloquetDensePayload,
) -> Result<NativeModalEigenpair, RunError> {
    let real = required_f64_array(mode, "mode_vector_real")?;
    let imag = required_f64_array(mode, "mode_vector_imag")?;
    if real.len() != imag.len() || real.len() != payload.stiffness.nrows() {
        return Err(RunError {
            message: format!(
                "native Bloch/Floquet modal mode vector length mismatch: real={}, imag={}, operator={}",
                real.len(),
                imag.len(),
                payload.stiffness.nrows()
            ),
        });
    }
    let embedded = real
        .iter()
        .zip(imag.iter())
        .map(|(re, im)| Complex64::new(*re, *im))
        .collect::<Vec<_>>();
    let mut vector =
        deembed_native_bloch_floquet_mode_vector(&embedded, payload.physical_complex_dof)?;
    vector = normalize_complex_mode(&vector, &payload.physical_mass, &plan.normalization);
    let eigenvalue_real = required_f64(mode, "eigenvalue_real")?;
    let eigenvalue_imag = required_f64(mode, "eigenvalue_imag")?;
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
        residual_absolute_l2,
        residual_relative_l2,
        residual_linf,
        mass_norm,
        block_residual_q: residual_relative_l2,
        block_residual_phi: 0.0,
        block_residual_gauge: 0.0,
        backend_reported_residual: residual_relative_l2,
        vector,
        q_vector: Vec::new(),
        phi_vector: Vec::new(),
    })
}

fn native_modal_mode_from_json(
    plan: &FemEigenPlanIR,
    mode: &serde_json::Value,
    stiffness_omega: &DMatrix<f64>,
    gyrotropic_row_major: &[f64],
    tangent_mass: &DMatrix<f64>,
) -> Result<NativeModalEigenpair, RunError> {
    let real = required_f64_array(mode, "mode_vector_real")?;
    let imag = required_f64_array(mode, "mode_vector_imag")?;
    if real.len() != imag.len() || real.len() != stiffness_omega.nrows() {
        return Err(RunError {
            message: format!(
                "native modal mode vector length mismatch: real={}, imag={}, operator={}",
                real.len(),
                imag.len(),
                stiffness_omega.nrows()
            ),
        });
    }
    let mut vector = real
        .iter()
        .zip(imag.iter())
        .map(|(re, im)| Complex64::new(*re, *im))
        .collect::<Vec<_>>();
    normalize_complex_block_mode(&mut vector, tangent_mass, plan.normalization);
    let eigenvalue_real = required_f64(mode, "eigenvalue_real")?;
    let eigenvalue_imag = required_f64(mode, "eigenvalue_imag")?;
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
        residual_absolute_l2,
        residual_relative_l2,
        residual_linf,
        mass_norm,
        block_residual_q: residual_relative_l2,
        block_residual_phi: 0.0,
        block_residual_gauge: 0.0,
        backend_reported_residual: residual_relative_l2,
        vector,
        q_vector: Vec::new(),
        phi_vector: Vec::new(),
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

pub(super) fn normalize_complex_block_mode(
    vector: &mut [Complex64],
    mass: &DMatrix<f64>,
    normalization: EigenNormalizationIR,
) {
    let scale = complex_block_mode_normalization_scale(vector, mass, normalization);
    for value in vector {
        *value /= scale;
    }
}

fn complex_block_mode_normalization_scale(
    vector: &[Complex64],
    mass: &DMatrix<f64>,
    normalization: EigenNormalizationIR,
) -> f64 {
    match normalization {
        EigenNormalizationIR::UnitL2 => complex_block_mass_norm(mass, vector).re.max(0.0).sqrt(),
        EigenNormalizationIR::UnitMaxAmplitude => vector
            .iter()
            .fold(0.0_f64, |acc, value| acc.max(value.norm())),
    }
    .max(1.0e-30)
}

pub(super) fn complex_block_mass_norm(mass: &DMatrix<f64>, vector: &[Complex64]) -> Complex64 {
    let mut norm = Complex64::new(0.0, 0.0);
    for row in 0..mass.nrows() {
        let mut projected = Complex64::new(0.0, 0.0);
        for col in 0..mass.ncols() {
            projected += vector[col] * mass[(row, col)];
        }
        norm += vector[row].conj() * projected;
    }
    norm
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
