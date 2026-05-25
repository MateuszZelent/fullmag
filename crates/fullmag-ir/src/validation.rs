use crate::{
    CurrentModuleIR, CurrentTransportModelIR, DynamicsIR, EnergyTermIR, MechanicalLoadIR,
    MechanicsIR, ProblemIR, SpinTorqueModuleIR,
};
use std::collections::BTreeSet;

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

pub(crate) fn validate_dmi_energy_terms(problem: &ProblemIR, errors: &mut Vec<String>) {
    for (index, term) in problem.energy_terms.iter().enumerate() {
        match term {
            EnergyTermIR::InterfacialDmi {
                d,
                interface_normal,
            } => {
                if !d.is_finite() {
                    errors.push(format!(
                        "energy_terms[{index}] interfacial_dmi D must be finite"
                    ));
                }
                if let Some(normal) = interface_normal {
                    if !vector3_is_finite(normal) {
                        errors.push(format!(
                            "energy_terms[{index}] interfacial_dmi interface_normal must contain finite values"
                        ));
                    } else {
                        let norm_sq =
                            normal[0] * normal[0] + normal[1] * normal[1] + normal[2] * normal[2];
                        if norm_sq <= 1e-30 {
                            errors.push(format!(
                                "energy_terms[{index}] interfacial_dmi interface_normal must be non-zero"
                            ));
                        }
                    }
                }
            }
            EnergyTermIR::BulkDmi { d } => {
                if !d.is_finite() {
                    errors.push(format!("energy_terms[{index}] bulk_dmi D must be finite"));
                }
            }
            _ => {}
        }
    }
}

pub(crate) fn validate_material_dmi_values(problem: &ProblemIR, errors: &mut Vec<String>) {
    for material in &problem.materials {
        if material
            .interfacial_dmi
            .is_some_and(|value| !value.is_finite())
        {
            errors.push(format!(
                "material '{}' interfacial_dmi must be finite",
                material.name
            ));
        }
        if material.bulk_dmi.is_some_and(|value| !value.is_finite()) {
            errors.push(format!(
                "material '{}' bulk_dmi must be finite",
                material.name
            ));
        }
        if material
            .dind_field
            .as_ref()
            .is_some_and(|values| values.iter().any(|value| !value.is_finite()))
        {
            errors.push(format!(
                "material '{}' dind_field must contain finite values",
                material.name
            ));
        }
        if material
            .dbulk_field
            .as_ref()
            .is_some_and(|values| values.iter().any(|value| !value.is_finite()))
        {
            errors.push(format!(
                "material '{}' dbulk_field must contain finite values",
                material.name
            ));
        }
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
    if problem.stt_thickness.is_some_and(|value| value <= 0.0) {
        errors.push("legacy STT stt_thickness must be > 0".to_string());
    }
    if let Some(position) = problem.stt_fixed_layer_position.as_deref() {
        if !matches!(position, "top" | "bottom") {
            errors
                .push("legacy STT stt_fixed_layer_position must be 'top' or 'bottom'".to_string());
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
                free_layer_thickness_m,
                fixed_layer_position,
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
                if free_layer_thickness_m.is_some_and(|value| value <= 0.0) {
                    errors.push(format!(
                        "spin_torque_modules[{index}] slonczewski free_layer_thickness_m must be > 0"
                    ));
                }
                if let Some(position) = fixed_layer_position.as_deref() {
                    if !matches!(position, "top" | "bottom") {
                        errors.push(format!(
                            "spin_torque_modules[{index}] slonczewski fixed_layer_position must be 'top' or 'bottom'"
                        ));
                    }
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

pub(crate) fn validate_magnetoelastic(problem: &ProblemIR, errors: &mut Vec<String>) {
    validate_unique_names(
        problem
            .elastic_materials
            .iter()
            .map(|material| material.name.as_str()),
        "elastic_materials",
        errors,
    );
    validate_unique_names(
        problem.elastic_bodies.iter().map(|body| body.name.as_str()),
        "elastic_bodies",
        errors,
    );
    validate_unique_names(
        problem.magnetostriction_laws.iter().map(|law| law.name()),
        "magnetostriction_laws",
        errors,
    );

    for (index, material) in problem.elastic_materials.iter().enumerate() {
        if material.name.trim().is_empty() {
            errors.push(format!("elastic_materials[{index}].name must not be empty"));
        }
        if !(material.c11.is_finite() && material.c11 > 0.0) {
            errors.push(format!(
                "elastic_materials[{index}].c11 must be finite and > 0"
            ));
        }
        if !material.c12.is_finite() {
            errors.push(format!("elastic_materials[{index}].c12 must be finite"));
        }
        if !(material.c44.is_finite() && material.c44 > 0.0) {
            errors.push(format!(
                "elastic_materials[{index}].c44 must be finite and > 0"
            ));
        }
        if !(material.density.is_finite() && material.density > 0.0) {
            errors.push(format!(
                "elastic_materials[{index}].density must be finite and > 0"
            ));
        }
        if material
            .mechanical_damping
            .is_some_and(|value| !value.is_finite() || value < 0.0)
        {
            errors.push(format!(
                "elastic_materials[{index}].mechanical_damping must be finite and >= 0 when provided"
            ));
        }
    }

    let geometry_names: BTreeSet<&str> = problem
        .geometry
        .entries
        .iter()
        .map(|entry| entry.name())
        .collect();
    let elastic_material_names: BTreeSet<&str> = problem
        .elastic_materials
        .iter()
        .map(|material| material.name.as_str())
        .collect();
    for (index, body) in problem.elastic_bodies.iter().enumerate() {
        if body.name.trim().is_empty() {
            errors.push(format!("elastic_bodies[{index}].name must not be empty"));
        }
        if !geometry_names.contains(body.geometry.as_str()) {
            errors.push(format!(
                "elastic_bodies[{index}] references unknown geometry '{}'",
                body.geometry
            ));
        }
        if !elastic_material_names.contains(body.elastic_material.as_str()) {
            errors.push(format!(
                "elastic_bodies[{index}] references unknown elastic material '{}'",
                body.elastic_material
            ));
        }
    }

    for (index, law) in problem.magnetostriction_laws.iter().enumerate() {
        if law.name().trim().is_empty() {
            errors.push(format!(
                "magnetostriction_laws[{index}].name must not be empty"
            ));
        }
        match law {
            crate::MagnetostrictionLawIR::Cubic { b1, b2, .. } => {
                if !b1.is_finite() {
                    errors.push(format!("magnetostriction_laws[{index}].b1 must be finite"));
                }
                if !b2.is_finite() {
                    errors.push(format!("magnetostriction_laws[{index}].b2 must be finite"));
                }
            }
            crate::MagnetostrictionLawIR::Isotropic { lambda_s, .. } => {
                if !lambda_s.is_finite() {
                    errors.push(format!(
                        "magnetostriction_laws[{index}].lambda_s must be finite"
                    ));
                }
            }
        }
    }

    for (index, load) in problem.mechanical_loads.iter().enumerate() {
        match load {
            MechanicalLoadIR::BodyForce { f } => {
                if !vector3_is_finite(f) {
                    errors.push(format!(
                        "mechanical_loads[{index}].f must contain finite values"
                    ));
                }
            }
            MechanicalLoadIR::PrescribedStrain { strain } => {
                if strain.iter().any(|value| !value.is_finite()) {
                    errors.push(format!(
                        "mechanical_loads[{index}].strain must contain finite values"
                    ));
                }
            }
            MechanicalLoadIR::PrescribedStress { stress } => {
                if stress.iter().any(|value| !value.is_finite()) {
                    errors.push(format!(
                        "mechanical_loads[{index}].stress must contain finite values"
                    ));
                }
            }
        }
    }

    let magnet_names: BTreeSet<&str> = problem
        .magnets
        .iter()
        .map(|magnet| magnet.name.as_str())
        .collect();
    let body_names: BTreeSet<&str> = problem
        .elastic_bodies
        .iter()
        .map(|body| body.name.as_str())
        .collect();
    let law_names: BTreeSet<&str> = problem
        .magnetostriction_laws
        .iter()
        .map(|law| law.name())
        .collect();
    let has_magnetoelastic = problem
        .energy_terms
        .iter()
        .any(|term| matches!(term, EnergyTermIR::Magnetoelastic { .. }));

    for (index, term) in problem.energy_terms.iter().enumerate() {
        if let EnergyTermIR::Magnetoelastic { magnet, body, law } = term {
            if !magnet_names.contains(magnet.as_str()) {
                errors.push(format!(
                    "energy_terms[{index}] magnetoelastic references unknown magnet '{}'",
                    magnet
                ));
            }
            if !body_names.contains(body.as_str()) {
                errors.push(format!(
                    "energy_terms[{index}] magnetoelastic references unknown elastic body '{}'",
                    body
                ));
            }
            if !law_names.contains(law.as_str()) {
                errors.push(format!(
                    "energy_terms[{index}] magnetoelastic references unknown magnetostriction law '{}'",
                    law
                ));
            }
        }
    }

    let mechanics = match &problem.study {
        crate::StudyIR::TimeEvolution { dynamics, .. }
        | crate::StudyIR::Relaxation { dynamics, .. }
        | crate::StudyIR::Eigenmodes { dynamics, .. }
        | crate::StudyIR::FrequencyResponse { dynamics, .. } => match dynamics {
            DynamicsIR::Llg { mechanics, .. } => mechanics.as_ref(),
        },
    };
    if mechanics.is_some() && !has_magnetoelastic {
        errors.push("llg.mechanics requires a Magnetoelastic energy term".to_string());
    }
    match mechanics {
        Some(MechanicsIR::QuasistaticElasticity {
            max_picard_iterations,
            picard_tolerance,
        }) => {
            if *max_picard_iterations == 0 {
                errors.push(
                    "llg.mechanics.max_picard_iterations must be > 0 for quasistatic_elasticity"
                        .to_string(),
                );
            }
            if !picard_tolerance.is_finite() || *picard_tolerance <= 0.0 {
                errors.push(
                    "llg.mechanics.picard_tolerance must be finite and > 0 for quasistatic_elasticity"
                        .to_string(),
                );
            }
        }
        Some(MechanicsIR::Elastodynamics { mechanical_dt }) => {
            if mechanical_dt.is_some_and(|value| !value.is_finite() || value <= 0.0) {
                errors.push(
                    "llg.mechanics.mechanical_dt must be finite and > 0 when provided".to_string(),
                );
            }
        }
        Some(MechanicsIR::PrescribedStrain) | None => {}
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
