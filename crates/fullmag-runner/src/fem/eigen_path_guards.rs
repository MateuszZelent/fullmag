//! Private FEM eigen-path guards helpers.

use super::*;

pub(super) fn gpu_modal_dispersion_path_unavailable_error(plan: &FemEigenPlanIR) -> RunError {
    if plan.operator.include_demag || plan.enable_demag {
        return RunError {
            message: format!(
                "{}: GPU modal K0/Kittel with demag is unavailable until Poisson-airbox GPU parity/runtime gates pass; CPU fallback is disabled for forced GPU modal demag",
                fem_eigen::SHARED_DOMAIN_K0_RUNTIME_UNAVAILABLE_REASON
            ),
        };
    }
    RunError {
        message: "GPU modal dispersion with KSamplingIR::Path is unavailable until a native modal GPU eigensolver and Floquet operator exist; request FEM CPU/reference modal dispersion or a single-k GPU modal solve".to_string(),
    }
}

pub(super) fn gpu_modal_k0_kittel_path_supported(plan: &FemEigenPlanIR) -> bool {
    if !matches!(plan.operator.kind, fullmag_ir::EigenOperatorIR::Full2x2)
        || !matches!(
            plan.damping_policy,
            fullmag_ir::EigenDampingPolicyIR::Ignore
        )
    {
        return false;
    }
    let Some(fullmag_ir::KSamplingIR::Path { points, .. }) = plan.k_sampling.as_ref() else {
        return false;
    };
    let gamma_only_path = !points.is_empty()
        && points.iter().all(|point| {
            point
                .k_vector
                .iter()
                .all(|component| component.is_finite() && component.abs() <= 1.0e-12)
        });
    if !gamma_only_path {
        return false;
    }

    if !plan.operator.include_demag && !plan.enable_demag {
        return true;
    }

    let positive_frequency_target = match plan.target {
        fullmag_ir::EigenTargetIR::Nearest { frequency_hz } => {
            frequency_hz.is_finite() && frequency_hz > 0.0
        }
        fullmag_ir::EigenTargetIR::FrequencyWindow {
            frequency_min_hz,
            frequency_max_hz,
        } => {
            frequency_min_hz.is_finite()
                && frequency_max_hz.is_finite()
                && frequency_min_hz >= 0.0
                && frequency_max_hz > frequency_min_hz
        }
        fullmag_ir::EigenTargetIR::Lowest => false,
    };

    periodic_airbox_k0_runtime_supported(plan)
        && plan.count > 0
        && plan.count <= 32
        && positive_frequency_target
}

pub(super) fn periodic_airbox_k0_runtime_supported(plan: &FemEigenPlanIR) -> bool {
    periodic_airbox_k0_physical_plan(plan)
        && fem_eigen::native_shared_domain_magnetic_assembly_available(plan)
}

pub(super) fn periodic_airbox_k0_physical_plan(plan: &FemEigenPlanIR) -> bool {
    let gamma_only_path = plan.k_sampling.as_ref().is_some_and(|sampling| {
        let fullmag_ir::KSamplingIR::Path { points, .. } = sampling else {
            return false;
        };
        !points.is_empty()
            && points.iter().all(|point| {
                point
                    .k_vector
                    .iter()
                    .all(|component| component.is_finite() && component.abs() <= 1.0e-12)
            })
    });

    plan.operator.include_demag
        && plan.enable_demag
        && gamma_only_path
        && matches!(
            plan.spin_wave_bc.kind(),
            fullmag_ir::SpinWaveBoundaryKindIR::Periodic
        )
        && plan.air_box_config.is_some()
        && !plan.mesh.periodic_node_pairs.is_empty()
        && !plan.mesh.periodic_boundary_pairs.is_empty()
}

pub(super) fn eigen_path_single_k_point_plan(
    plan: &FemEigenPlanIR,
    sample: &crate::eigen::KSampleDescriptor,
    reuse_relaxed_equilibrium: bool,
    handoff: Option<&fem_eigen::AcceptedFemEigenEquilibriumHandoff>,
) -> Result<FemEigenPlanIR, RunError> {
    let mut point_plan = plan.clone();
    point_plan.k_sampling = Some(fullmag_ir::KSamplingIR::Single {
        k_vector: sample.k_vector,
    });
    if bias_field_sweep_requested(plan) {
        let declared_sample = plan
            .bias_field_samples
            .iter()
            .find(|candidate| candidate.sample_index as usize == sample.sample_index)
            .ok_or_else(|| RunError {
                message: format!(
                    "FEM bias_field_samples has no bias field for sample {}",
                    sample.sample_index
                ),
            })?;
        if declared_sample
            .field_a_per_m
            .iter()
            .any(|component| !component.is_finite())
        {
            return Err(RunError {
                message: format!(
                    "FEM bias_field_samples sample {} requires finite field_a_per_m components",
                    sample.sample_index
                ),
            });
        }
        // A field sweep is a sequence of distinct physical problems.  Keep
        // the relaxed source so every sample gets its own accepted
        // equilibrium, linearization, demag solve, and native modal assembly.
        point_plan.external_field = Some(declared_sample.field_a_per_m);
        // The outer path owns the complete BiasFieldSweepIR sample list.  A
        // point solve must be one physical sample, otherwise the public CPU/
        // GPU entrypoint would recursively re-enter the whole sweep.
        point_plan.bias_field_samples.clear();
    } else if k0_kittel_periodic_airbox_field_sweep_requested(plan) {
        return Err(RunError {
            message: "K0-3 periodic_airbox_k0 physical field sweep requires bias_field_samples; k0_kittel_validation is postsolve-only".to_string(),
        });
    } else if matches!(
        point_plan.equilibrium,
        fullmag_ir::EquilibriumSourceIR::RelaxedInitialState
    ) {
        if reuse_relaxed_equilibrium {
            let handoff = handoff.ok_or_else(|| RunError {
                message: "missing_relax_to_eigen_handoff".to_string(),
            })?;
            handoff.validate_target_plan(&point_plan)?;
            point_plan.equilibrium = fullmag_ir::EquilibriumSourceIR::Provided;
            point_plan.equilibrium_magnetization = handoff.equilibrium_magnetization().to_vec();
        }
    }
    point_plan.k0_kittel_validation = None;
    Ok(point_plan)
}

pub(super) fn bias_field_sweep_requested(plan: &FemEigenPlanIR) -> bool {
    !plan.bias_field_samples.is_empty()
}

pub(super) fn k0_kittel_periodic_airbox_field_sweep_requested(plan: &FemEigenPlanIR) -> bool {
    plan.k0_kittel_validation
        .as_ref()
        .is_some_and(|validation| {
            validation.kind == "k0_kittel_field_sweep"
                && validation.case_id.as_deref() == Some("K0-3")
                && validation.demag_kind.as_deref() == Some("periodic_airbox_k0")
        })
}

pub(super) fn de_bv_low_k_analytic_reference_enabled(plan: &FemEigenPlanIR) -> bool {
    plan.operator.include_demag
        && matches!(
            plan.spin_wave_bc.kind(),
            fullmag_ir::SpinWaveBoundaryKindIR::Floquet
        )
        && plan
            .dispersion_validation
            .as_ref()
            .is_some_and(|validation| {
                validation.kind == "thin_film_de_bv_low_k"
                    && validation.analytic_model == "kalinikos_slab_n0"
            })
}

pub(super) fn k0_kittel_synthetic_demag_factor_enabled(plan: &FemEigenPlanIR) -> bool {
    plan.operator.include_demag
        && plan.enable_demag
        && matches!(
            plan.spin_wave_bc.kind(),
            fullmag_ir::SpinWaveBoundaryKindIR::Floquet
        )
        && plan
            .k0_kittel_validation
            .as_ref()
            .is_some_and(|validation| {
                validation.kind == "k0_kittel_field_sweep"
                    && validation.case_id.as_deref() == Some("K0-3")
                    && validation.demag_kind.as_deref() == Some("synthetic_demag_factor")
                    && validation.model == "thin_film_in_plane"
            })
}

pub(super) fn solve_k0_kittel_synthetic_demag_factor_single_k(
    plan: &FemEigenPlanIR,
    sample: &crate::eigen::KSampleDescriptor,
) -> Result<crate::eigen::SingleKSolveResult, RunError> {
    if vector_norm(sample.k_vector) > 1.0e-9 {
        return Err(RunError {
            message: "K0-3 synthetic demag-factor validation requires k=0 samples".to_string(),
        });
    }
    let validation = plan.k0_kittel_validation.as_ref().ok_or_else(|| RunError {
        message: "K0-3 synthetic demag-factor validation requires k0_kittel_validation".to_string(),
    })?;
    let declared_sample = validation
        .samples
        .iter()
        .find(|candidate| candidate.sample_index as usize == sample.sample_index)
        .ok_or_else(|| RunError {
            message: format!(
                "K0-3 synthetic demag-factor validation missing field sample {}",
                sample.sample_index
            ),
        })?;
    let h0_a_per_m = vector_norm(declared_sample.bias_field);
    if !(h0_a_per_m.is_finite() && h0_a_per_m > 0.0) {
        return Err(RunError {
            message: "K0-3 synthetic demag-factor validation requires a positive bias field"
                .to_string(),
        });
    }
    let effective_magnetisation = validation
        .material
        .effective_magnetisation
        .filter(|value| value.is_finite() && *value > 0.0)
        .ok_or_else(|| RunError {
            message: "K0-3 synthetic demag-factor validation requires positive M_eff".to_string(),
        })?;
    let frequency_hz = plan.gyromagnetic_ratio
        * (h0_a_per_m * (h0_a_per_m + effective_magnetisation)).sqrt()
        / std::f64::consts::TAU;
    let omega = std::f64::consts::TAU * frequency_hz;
    Ok(crate::eigen::SingleKSolveResult {
        sample: sample.clone(),
        modes: vec![crate::eigen::SingleKModeResult {
            raw_mode_index: 0,
            branch_id: None,
            frequency_real_hz: frequency_hz,
            frequency_imag_hz: 0.0,
            angular_frequency_rad_per_s: omega,
            eigenvalue_real: 0.0,
            eigenvalue_imag: omega,
            norm: 1.0,
            mass_norm: Some(1.0),
            max_amplitude: 1.0,
            residual_norm: Some(0.0),
            residual_linf: Some(0.0),
            tangent_leakage_mean_abs: Some(0.0),
            tangent_leakage_max_abs: Some(0.0),
            tangent_leakage_weighted_relative_l2: Some(0.0),
            dominant_polarization: "synthetic_demag_factor".to_string(),
            reduced_vector: Some(vec![num_complex::Complex64::new(1.0, 0.0)]),
            lifted_real: Some(vec![[0.0, 1.0, 0.0]]),
            lifted_imag: Some(vec![[0.0, 0.0, 1.0]]),
            amplitude: Some(vec![1.0]),
            phase: Some(vec![0.0]),
            node_mass_weights: None,
            component_participation:
                crate::eigen::ModalParticipationObservable::unavailable_without_context("cpu"),
        }],
        relaxation_steps: 0,
        solver_model: crate::eigen::EigenSolverModel::ReferenceK0KittelSyntheticDemagFactor,
        solver_notes: vec![
            "k0_3a_synthetic_demag_factor".to_string(),
            "production_periodic_airbox_claim=false".to_string(),
        ],
        solver_diagnostics: None,
    })
}

pub(super) fn solve_de_bv_low_k_analytic_reference_single_k(
    plan: &FemEigenPlanIR,
    sample: &crate::eigen::KSampleDescriptor,
) -> Result<crate::eigen::SingleKSolveResult, RunError> {
    let validation = plan
        .dispersion_validation
        .as_ref()
        .ok_or_else(|| RunError {
            message: "DE/BV analytic reference solver requires dispersion_validation".to_string(),
        })?;
    let k_norm = vector_norm(sample.k_vector);
    if k_norm > validation.max_k_rad_per_m * (1.0 + 1.0e-12) {
        return Err(RunError {
            message: format!(
                "DE/BV analytic reference sample exceeds low-k range: {} > {}",
                k_norm, validation.max_k_rad_per_m
            ),
        });
    }
    let geometry = de_bv_geometry_for_k(sample.k_vector, validation)?;
    let frequency_hz = kalinikos_slab_n0_frequency_hz(
        k_norm,
        geometry,
        vector_norm(plan.external_field.unwrap_or([0.0, 0.0, 0.0])),
        validation.film_thickness_m,
        plan.material.exchange_stiffness,
        plan.material.saturation_magnetisation,
        plan.gyromagnetic_ratio,
    )?;
    if frequency_hz < validation.frequency_window_hz.min
        || frequency_hz > validation.frequency_window_hz.max
    {
        return Err(RunError {
            message: format!(
                "DE/BV analytic reference frequency is outside validation window: {} Hz",
                frequency_hz
            ),
        });
    }
    let omega = std::f64::consts::TAU * frequency_hz;
    Ok(crate::eigen::SingleKSolveResult {
        sample: sample.clone(),
        modes: vec![crate::eigen::SingleKModeResult {
            raw_mode_index: 0,
            branch_id: None,
            frequency_real_hz: frequency_hz,
            frequency_imag_hz: 0.0,
            angular_frequency_rad_per_s: omega,
            eigenvalue_real: omega / plan.gyromagnetic_ratio,
            eigenvalue_imag: 0.0,
            norm: 1.0,
            mass_norm: Some(1.0),
            max_amplitude: 1.0,
            residual_norm: Some(0.0),
            residual_linf: Some(0.0),
            tangent_leakage_mean_abs: Some(0.0),
            tangent_leakage_max_abs: Some(0.0),
            tangent_leakage_weighted_relative_l2: Some(0.0),
            dominant_polarization: geometry.to_string(),
            reduced_vector: Some(vec![num_complex::Complex64::new(1.0, 0.0)]),
            lifted_real: Some(vec![[0.0, 1.0, 0.0]]),
            lifted_imag: Some(vec![[0.0, 0.0, 1.0]]),
            amplitude: Some(vec![1.0]),
            phase: Some(vec![0.0]),
            node_mass_weights: None,
            component_participation:
                crate::eigen::ModalParticipationObservable::unavailable_without_context("cpu"),
        }],
        relaxation_steps: 0,
        solver_model: crate::eigen::EigenSolverModel::ReferenceThinFilmDeBvKalinikosN0,
        solver_notes: vec![
            "reference_thin_film_de_bv_kalinikos_n0".to_string(),
            format!("geometry={geometry}"),
        ],
        solver_diagnostics: None,
    })
}

pub(super) fn kalinikos_slab_n0_frequency_hz(
    k_norm: f64,
    geometry: &str,
    bias_field_a_per_m: f64,
    film_thickness_m: f64,
    exchange_stiffness_j_per_m: f64,
    saturation_magnetisation_a_per_m: f64,
    gamma0_rad_s_per_a_m: f64,
) -> Result<f64, RunError> {
    if !(bias_field_a_per_m.is_finite() && bias_field_a_per_m > 0.0) {
        return Err(RunError {
            message: "DE/BV analytic reference requires a nonzero finite bias field".to_string(),
        });
    }
    let exchange_field = 2.0 * exchange_stiffness_j_per_m * k_norm * k_norm
        / (crate::MU0 * saturation_magnetisation_a_per_m);
    let p_factor = if k_norm == 0.0 {
        0.0
    } else {
        let kd = k_norm * film_thickness_m;
        1.0 - (1.0 - (-kd).exp()) / kd
    };
    let common = bias_field_a_per_m + exchange_field;
    let (factor_a, factor_b) = match geometry {
        "damon_eshbach" => (
            common + saturation_magnetisation_a_per_m * (1.0 - p_factor),
            common + saturation_magnetisation_a_per_m * p_factor,
        ),
        "backward_volume" => (
            common,
            common + saturation_magnetisation_a_per_m * (1.0 - p_factor),
        ),
        _ => {
            return Err(RunError {
                message: format!("unsupported DE/BV analytic geometry: {geometry}"),
            })
        }
    };
    if !(factor_a.is_finite() && factor_a > 0.0 && factor_b.is_finite() && factor_b > 0.0) {
        return Err(RunError {
            message: "DE/BV analytic reference factors must be finite and positive".to_string(),
        });
    }
    Ok(gamma0_rad_s_per_a_m * (factor_a * factor_b).sqrt() / std::f64::consts::TAU)
}

pub(super) fn de_bv_geometry_for_k(
    k_vector: [f64; 3],
    validation: &fullmag_ir::FemEigenDispersionValidationIR,
) -> Result<&'static str, RunError> {
    let k_norm = vector_norm(k_vector);
    if k_norm == 0.0 {
        return Ok("backward_volume");
    }
    let k = unit_vector(k_vector).ok_or_else(|| RunError {
        message: "DE/BV analytic reference requires finite nonzero k".to_string(),
    })?;
    let m0 = unit_vector(validation.equilibrium_magnetization).ok_or_else(|| RunError {
        message: "DE/BV analytic reference requires finite nonzero equilibrium magnetization"
            .to_string(),
    })?;
    let normal = unit_vector(validation.film_normal).ok_or_else(|| RunError {
        message: "DE/BV analytic reference requires finite nonzero film normal".to_string(),
    })?;
    if vector_dot(k, normal).abs() > 1.0e-6 {
        return Err(RunError {
            message: "DE/BV analytic reference requires in-plane k vectors".to_string(),
        });
    }
    let projection = vector_dot(k, m0).abs();
    if (projection - 1.0).abs() <= 1.0e-6 {
        Ok("backward_volume")
    } else if projection <= 1.0e-6 {
        Ok("damon_eshbach")
    } else {
        Err(RunError {
            message: "DE/BV analytic reference supports only k parallel or perpendicular to equilibrium magnetization".to_string(),
        })
    }
}

fn unit_vector(value: [f64; 3]) -> Option<[f64; 3]> {
    let norm = vector_norm(value);
    (norm.is_finite() && norm > 0.0).then_some([value[0] / norm, value[1] / norm, value[2] / norm])
}

pub(super) fn vector_norm(value: [f64; 3]) -> f64 {
    vector_dot(value, value).sqrt()
}

fn vector_dot(lhs: [f64; 3], rhs: [f64; 3]) -> f64 {
    lhs[0] * rhs[0] + lhs[1] * rhs[1] + lhs[2] * rhs[2]
}
