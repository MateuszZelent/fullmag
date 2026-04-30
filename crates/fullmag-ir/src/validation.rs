use std::collections::BTreeSet;
use crate::{
    CurrentModuleIR, CurrentTransportModelIR, DynamicsIR, EnergyTermIR, ProblemIR,
    SpinTorqueModuleIR,
};

pub(crate) fn vector3_is_finite(vector: &[f64; 3]) -> bool {
    vector.iter().all(|value| value.is_finite())
}

pub(crate) fn current_module_name(module: &CurrentModuleIR) -> &str {
    match module {
        CurrentModuleIR::AntennaFieldSource { name, .. }
        | CurrentModuleIR::CurrentTransport { name, .. } => name.as_str(),
    }
}

pub(crate) fn current_transport_exists(problem: &ProblemIR, name: &str) -> bool {
    problem.current_modules.iter().any(|module| {
        matches!(
            module,
            CurrentModuleIR::CurrentTransport { name: module_name, .. } if module_name == name
        )
    })
}

pub(crate) fn validate_oersted_energy_terms(problem: &ProblemIR, errors: &mut Vec<String>) {
    let mut oersted_term_count = 0usize;

    for (index, term) in problem.energy_terms.iter().enumerate() {
        match term {
            EnergyTermIR::OerstedCylinder {
                current,
                radius,
                center,
                axis,
                ..
            } => {
                oersted_term_count += 1;
                if !current.is_finite() {
                    errors.push(format!(
                        "energy_terms[{index}] oersted_cylinder current must be finite"
                    ));
                }
                if *radius <= 0.0 {
                    errors.push(format!(
                        "energy_terms[{index}] oersted_cylinder radius must be > 0"
                    ));
                }
                if !vector3_is_finite(center) {
                    errors.push(format!(
                        "energy_terms[{index}] oersted_cylinder center must contain finite values"
                    ));
                }
                if !vector3_is_finite(axis) {
                    errors.push(format!(
                        "energy_terms[{index}] oersted_cylinder axis must contain finite values"
                    ));
                } else {
                    let norm_sq = axis[0] * axis[0] + axis[1] * axis[1] + axis[2] * axis[2];
                    if norm_sq <= 1e-30 {
                        errors.push(format!(
                            "energy_terms[{index}] oersted_cylinder axis must be non-zero"
                        ));
                    }
                }
            }
            EnergyTermIR::OerstedField { source, .. } => {
                oersted_term_count += 1;
                if source.trim().is_empty() {
                    errors.push(format!(
                        "energy_terms[{index}] oersted_field source must not be empty"
                    ));
                } else if !current_transport_exists(problem, source) {
                    errors.push(format!(
                        "energy_terms[{index}] oersted_field source '{}' must reference a current_transport module",
                        source
                    ));
                }
            }
            _ => {}
        }
    }

    if oersted_term_count > 1 {
        errors.push(
            "at most one executable Oersted energy term is currently supported; use a single OerstedCylinder or OerstedField"
                .to_string(),
        );
    }
}

pub(crate) fn validate_current_modules(problem: &ProblemIR, errors: &mut Vec<String>) {
    for (index, module) in problem.current_modules.iter().enumerate() {
        match module {
            CurrentModuleIR::AntennaFieldSource {
                solver,
                air_box_factor,
                ..
            } => {
                if solver.trim().is_empty() {
                    errors.push(format!(
                        "current_modules[{index}] antenna_field_source solver must not be empty"
                    ));
                }
                if *air_box_factor <= 0.0 {
                    errors.push(format!(
                        "current_modules[{index}] antenna_field_source air_box_factor must be > 0"
                    ));
                }
            }
            CurrentModuleIR::CurrentTransport {
                model,
                current_density,
                solve_region,
                conductivity_s_per_m,
                ..
            } => {
                if let Some(region) = solve_region {
                    if region.trim().is_empty() {
                        errors.push(format!(
                            "current_modules[{index}] current_transport solve_region must not be empty"
                        ));
                    }
                }
                if let Some(conductivity) = conductivity_s_per_m {
                    if *conductivity <= 0.0 {
                        errors.push(format!(
                            "current_modules[{index}] current_transport conductivity_s_per_m must be > 0"
                        ));
                    }
                }
                match model {
                    CurrentTransportModelIR::PrescribedDensity => match current_density {
                        Some(current_density) => {
                            if !vector3_is_finite(current_density) {
                                errors.push(format!(
                                    "current_modules[{index}] current_transport current_density must contain finite values"
                                ));
                            }
                        }
                        None => errors.push(format!(
                            "current_modules[{index}] current_transport prescribed_density requires current_density"
                        )),
                    },
                    CurrentTransportModelIR::OhmicPoisson => {
                        if current_density.is_some() {
                            errors.push(format!(
                                "current_modules[{index}] current_transport ohmic_poisson must not define current_density"
                            ));
                        }
                    }
                }
            }
        }
    }
}

pub(crate) fn validate_legacy_spin_torque_fields(problem: &ProblemIR, errors: &mut Vec<String>) {
    let has_legacy = problem.current_density.is_some()
        || problem.stt_degree.is_some()
        || problem.stt_beta.is_some()
        || problem.stt_spin_polarization.is_some()
        || problem.stt_lambda.is_some()
        || problem.stt_epsilon_prime.is_some();
    if !has_legacy {
        return;
    }

    if problem.current_density.is_none() {
        errors.push("legacy STT fields require current_density".to_string());
    }
    if let Some(current_density) = problem.current_density {
        if !vector3_is_finite(&current_density) {
            errors.push("legacy STT current_density must contain finite values".to_string());
        }
    }
    if let Some(degree) = problem.stt_degree {
        if !(0.0 < degree && degree <= 1.0) {
            errors.push("legacy STT stt_degree must be in (0, 1]".to_string());
        }
    }
    if let Some(beta) = problem.stt_beta {
        if beta < 0.0 {
            errors.push("legacy STT stt_beta must be >= 0".to_string());
        }
    }
    if let Some(spin_polarization) = problem.stt_spin_polarization {
        if !vector3_is_finite(&spin_polarization) {
            errors.push("legacy STT stt_spin_polarization must contain finite values".to_string());
        }
    }
    if let Some(lambda_asymmetry) = problem.stt_lambda {
        if lambda_asymmetry < 1.0 {
            errors.push("legacy STT stt_lambda must be >= 1".to_string());
        }
    }
    if problem.stt_spin_polarization.is_some()
        && (problem.stt_beta.is_some() || problem.stt_lambda.is_none())
    {
        errors.push(
            "legacy STT fields mix Zhang-Li and Slonczewski parameters; use spin_torque_modules for explicit families".to_string(),
        );
    }
}

pub(crate) fn validate_spin_torque_modules(problem: &ProblemIR, errors: &mut Vec<String>) {
    let validate_vector_binding = |index: usize,
                                   label: &str,
                                   current_density: &Option<[f64; 3]>,
                                   current_source: &Option<String>,
                                   errors: &mut Vec<String>| {
        match (current_density, current_source.as_deref()) {
                (Some(current_density), None) => {
                    if !vector3_is_finite(current_density) {
                        errors.push(format!(
                            "spin_torque_modules[{index}] {label} current_density must contain finite values"
                        ));
                    }
                }
                (None, Some(source)) => {
                    if source.trim().is_empty() {
                        errors.push(format!(
                            "spin_torque_modules[{index}] {label} current_source must not be empty"
                        ));
                    } else if !current_transport_exists(problem, source) {
                        errors.push(format!(
                            "spin_torque_modules[{index}] {label} current_source '{}' must reference a current_transport module",
                            source
                        ));
                    }
                }
                (Some(_), Some(_)) => errors.push(format!(
                    "spin_torque_modules[{index}] {label} must use either current_density or current_source, not both"
                )),
                (None, None) => errors.push(format!(
                    "spin_torque_modules[{index}] {label} requires one of current_density or current_source"
                )),
            }
    };

    for (index, module) in problem.spin_torque_modules.iter().enumerate() {
        match module {
            SpinTorqueModuleIR::Slonczewski {
                current_density,
                current_source,
                degree,
                spin_polarization,
                lambda_asymmetry,
                ..
            } => {
                validate_vector_binding(
                    index,
                    "slonczewski",
                    current_density,
                    current_source,
                    errors,
                );
                if !vector3_is_finite(spin_polarization) {
                    errors.push(format!(
                        "spin_torque_modules[{index}] slonczewski spin_polarization must contain finite values"
                    ));
                }
                if !(0.0 < *degree && *degree <= 1.0) {
                    errors.push(format!(
                        "spin_torque_modules[{index}] slonczewski degree must be in (0, 1]"
                    ));
                }
                if *lambda_asymmetry < 1.0 {
                    errors.push(format!(
                        "spin_torque_modules[{index}] slonczewski lambda_asymmetry must be >= 1"
                    ));
                }
            }
            SpinTorqueModuleIR::ZhangLi {
                current_density,
                current_source,
                degree,
                beta,
            } => {
                validate_vector_binding(index, "zhang_li", current_density, current_source, errors);
                if !(0.0 < *degree && *degree <= 1.0) {
                    errors.push(format!(
                        "spin_torque_modules[{index}] zhang_li degree must be in (0, 1]"
                    ));
                }
                if *beta < 0.0 {
                    errors.push(format!(
                        "spin_torque_modules[{index}] zhang_li beta must be >= 0"
                    ));
                }
            }
            SpinTorqueModuleIR::InterfaceCpp {
                current_density,
                current_source,
                degree,
                spin_polarization,
                interface_normal,
                lambda_asymmetry,
                ..
            } => {
                validate_vector_binding(
                    index,
                    "interface_cpp",
                    current_density,
                    current_source,
                    errors,
                );
                if !vector3_is_finite(spin_polarization) || !vector3_is_finite(interface_normal) {
                    errors.push(format!(
                        "spin_torque_modules[{index}] interface_cpp vectors must contain finite values"
                    ));
                }
                if !(0.0 < *degree && *degree <= 1.0) {
                    errors.push(format!(
                        "spin_torque_modules[{index}] interface_cpp degree must be in (0, 1]"
                    ));
                }
                if *lambda_asymmetry < 1.0 {
                    errors.push(format!(
                        "spin_torque_modules[{index}] interface_cpp lambda_asymmetry must be >= 1"
                    ));
                }
            }
            SpinTorqueModuleIR::DriftDiffusion {
                current_density,
                current_source,
                degree,
                spin_polarization,
                beta,
                spin_diffusion_length_m,
            } => {
                validate_vector_binding(
                    index,
                    "drift_diffusion",
                    current_density,
                    current_source,
                    errors,
                );
                if !vector3_is_finite(spin_polarization) {
                    errors.push(format!(
                        "spin_torque_modules[{index}] drift_diffusion vectors must contain finite values"
                    ));
                }
                if !(0.0 < *degree && *degree <= 1.0) {
                    errors.push(format!(
                        "spin_torque_modules[{index}] drift_diffusion degree must be in (0, 1]"
                    ));
                }
                if *beta < 0.0 {
                    errors.push(format!(
                        "spin_torque_modules[{index}] drift_diffusion beta must be >= 0"
                    ));
                }
                if *spin_diffusion_length_m <= 0.0 {
                    errors.push(format!(
                        "spin_torque_modules[{index}] drift_diffusion spin_diffusion_length_m must be > 0"
                    ));
                }
            }
            SpinTorqueModuleIR::SpinOrbitTorque {
                charge_current_density_a_per_m2,
                current_source,
                spin_polarization,
                ferromagnet_thickness_m,
                ..
            } => {
                match (charge_current_density_a_per_m2, current_source.as_deref()) {
                    (Some(current_density), None) => {
                        if *current_density <= 0.0 {
                            errors.push(format!(
                                "spin_torque_modules[{index}] spin_orbit_torque charge_current_density_a_per_m2 must be > 0"
                            ));
                        }
                    }
                    (None, Some(source)) => {
                        if source.trim().is_empty() {
                            errors.push(format!(
                                "spin_torque_modules[{index}] spin_orbit_torque current_source must not be empty"
                            ));
                        } else if !current_transport_exists(problem, source) {
                            errors.push(format!(
                                "spin_torque_modules[{index}] spin_orbit_torque current_source '{}' must reference a current_transport module",
                                source
                            ));
                        }
                    }
                    (Some(_), Some(_)) => errors.push(format!(
                        "spin_torque_modules[{index}] spin_orbit_torque must use either charge_current_density_a_per_m2 or current_source, not both"
                    )),
                    (None, None) => errors.push(format!(
                        "spin_torque_modules[{index}] spin_orbit_torque requires one of charge_current_density_a_per_m2 or current_source"
                    )),
                }
                if !vector3_is_finite(spin_polarization) {
                    errors.push(format!(
                        "spin_torque_modules[{index}] spin_orbit_torque spin_polarization must contain finite values"
                    ));
                }
                if *ferromagnet_thickness_m <= 0.0 {
                    errors.push(format!(
                        "spin_torque_modules[{index}] spin_orbit_torque ferromagnet_thickness_m must be > 0"
                    ));
                }
            }
        }
    }

    if problem.spin_torque_modules.len() > 1 {
        let has_legacy = problem.current_density.is_some()
            || problem.stt_degree.is_some()
            || problem.stt_beta.is_some()
            || problem.stt_spin_polarization.is_some()
            || problem.stt_lambda.is_some()
            || problem.stt_epsilon_prime.is_some();
        if has_legacy {
            errors.push(
                "legacy STT fields cannot represent more than one spin_torque_modules entry"
                    .to_string(),
            );
        }
    }
}

pub(crate) fn validate_unique_names<'a>(
    names: impl Iterator<Item = &'a str>,
    label: &str,
    errors: &mut Vec<String>,
) {
    let mut seen = BTreeSet::new();
    let mut duplicates = BTreeSet::new();
    for name in names {
        if !seen.insert(name) {
            duplicates.insert(name.to_string());
        }
    }
    if !duplicates.is_empty() {
        errors.push(format!(
            "{} must have unique names: {}",
            label,
            duplicates.into_iter().collect::<Vec<_>>().join(", ")
        ));
    }
}

pub(crate) fn is_supported_llg_integrator(integrator: &str) -> bool {
    matches!(
        integrator,
        "heun" | "rk4" | "rk23" | "rk45" | "abm3" | "auto"
    )
}

pub(crate) fn validate_study_dynamics(dynamics: &DynamicsIR, errors: &mut Vec<String>) {
    match dynamics {
        DynamicsIR::Llg {
            gyromagnetic_ratio,
            integrator,
            fixed_timestep,
            field_refresh,
            ..
        } => {
            if *gyromagnetic_ratio <= 0.0 {
                errors.push("llg.gyromagnetic_ratio must be positive".to_string());
            }
            if integrator.trim().is_empty() {
                errors.push("llg.integrator must not be empty".to_string());
            } else if !is_supported_llg_integrator(integrator.as_str()) {
                errors.push(
                    "llg.integrator must be one of: heun, rk4, rk23, rk45, abm3, auto".to_string(),
                );
            }
            if fixed_timestep.is_some_and(|value| value <= 0.0) {
                errors.push("llg.fixed_timestep must be positive when provided".to_string());
            }
            if field_refresh
                .as_ref()
                .and_then(|policy| policy.demag_interval_s)
                .is_some_and(|value| value <= 0.0)
            {
                errors.push(
                    "llg.field_refresh.demag_interval_s must be positive when provided".to_string(),
                );
            }
        }
    }
}
