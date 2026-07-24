use fullmag_ir::{
    BackendPlanIR, BackendTarget, CommonPlanMeta, DiscretizationHintsIR, DomainFrameIR,
    EnergyTermIR, ExchangeBoundaryCondition, ExecutionPlanIR, ExecutionPrecision,
    FemEigenDispersionValidationIR, FemEigenK0KittelValidationIR, FemEigenPlanIR,
    FemFrequencyDomainEquilibriumProvenanceIR, FemFrequencyResponsePlanIR, FemMagnetoelasticPlanIR,
    FemMechanicalModeIR, FemMechanicalPlanIR, FemPlanIR, GeometryEntryIR, MagnetostrictionLawIR,
    MechanicalLoadIR, OutputPlanIR, ProblemIR, ProvenancePlanIR, SeedPolicy, ThermalSeedConfig,
    TimeDependenceIR, IR_VERSION,
};
use std::collections::{BTreeMap, BTreeSet};

use crate::antenna_zeeman::{has_prescribed_zeeman_mask_source, resolve_prescribed_zeeman_masks};
use crate::current_transport::{
    has_mqs_antenna_field_source, resolve_current_transports, CurrentTransportExecutableLane,
};
use crate::error::PlanError;
use crate::mesh::{
    build_air_box_config, build_mesh_parts_from_segments, compatible_fem_material,
    initial_vectors_for_magnet, load_mesh_from_source, merge_fem_meshes, mesh_bounds,
    resolve_fem_domain_mesh_asset, resolved_domain_mesh_mode, study_universe_planner_note,
    MagnetPlanningEntry, AIR_OBJECT_SEGMENT_ID,
};
use crate::oersted::{resolve_fem_oersted_term, ResolvedOerstedTerm};
use crate::spin_torque::{resolve_legacy_spin_torque, SpinTorqueExecutableLane};
use crate::util::{
    mesh_workflow_metadata, problem_domain_frame, runtime_requests_cuda,
    shared_domain_mesh_requested, MU0,
};
use crate::validate::{
    planned_study_controls, validate_eigen_outputs, validate_executable_outputs,
    validate_frequency_response_outputs,
};

const FEM_AIRBOX_DEMAG_REQUIRED_MESSAGE: &str = "FEM demag requires a conformal shared-domain mesh with air and a Poisson airbox realization (Robin or Dirichlet).";
const CUBIC_AXIS_ORTHOGONALITY_DOT_TOL: f64 = 1e-3;
const CUBIC_AXIS_ORTHOGONALITY_CROSS_MIN_NORM: f64 = 1e-6;
const CUBIC_AXIS_VALIDATION_ERROR: &str =
    "cubic anisotropy axes must be finite, normalized and mutually orthogonal";
const FEM_DIRECT_MINIMIZER_DEMAG_RTOL_MAX: f64 = 1.0e-12;

fn is_direct_relaxation_minimizer(algorithm: fullmag_ir::RelaxationAlgorithmIR) -> bool {
    matches!(
        algorithm,
        fullmag_ir::RelaxationAlgorithmIR::ProjectedGradientBb
            | fullmag_ir::RelaxationAlgorithmIR::NonlinearCg
            | fullmag_ir::RelaxationAlgorithmIR::TangentPlaneImplicit
    )
}

fn fem_plan_has_uniaxial_anisotropy(plan: &FemPlanIR) -> bool {
    plan.material.uniaxial_anisotropy.is_some()
        || plan.material.uniaxial_anisotropy_k2.is_some()
        || plan.material.ku_field.is_some()
        || plan.material.ku2_field.is_some()
}

fn fem_plan_has_cubic_anisotropy(plan: &FemPlanIR) -> bool {
    plan.material.cubic_anisotropy_kc1.is_some()
        || plan.material.cubic_anisotropy_kc2.is_some()
        || plan.material.cubic_anisotropy_kc3.is_some()
        || plan.material.kc1_field.is_some()
        || plan.material.kc2_field.is_some()
        || plan.material.kc3_field.is_some()
}

fn fem_plan_has_slonczewski_stt(plan: &FemPlanIR) -> bool {
    plan.current_density.is_some()
        && plan.stt_degree.is_some()
        && plan.stt_spin_polarization.is_some()
        && plan.stt_lambda.is_some()
}

fn fem_plan_has_zhang_li_stt(plan: &FemPlanIR) -> bool {
    plan.current_density.is_some()
        && plan.stt_degree.is_some()
        && !fem_plan_has_slonczewski_stt(plan)
}

fn first_unsupported_elementwise_ms_cpu_owner(plan: &FemPlanIR) -> Option<&'static str> {
    // This is intentionally the same precedence as the native Context
    // diagnostic. Consistent-mass exchange is the required CPU owner;
    // Poisson demag and Zeeman may be additional consumers. The remaining
    // owners must continue to fail closed until they migrate to the common
    // element/quadrature adapter.
    if !plan.enable_exchange {
        return Some("exchange-disabled plan");
    }
    if plan.use_consistent_mass != Some(true) {
        return Some("lumped-mass exchange projection");
    }
    if plan.relaxation.is_some() {
        return Some("native FEM relaxation algorithms");
    }
    if fem_plan_has_uniaxial_anisotropy(plan) {
        return Some("uniaxial anisotropy");
    }
    if fem_plan_has_cubic_anisotropy(plan) {
        return Some("cubic anisotropy");
    }
    if plan.interfacial_dmi.is_some() || plan.dind_field.is_some() {
        return Some("interfacial DMI");
    }
    if plan.bulk_dmi.is_some() || plan.dbulk_field.is_some() {
        return Some("bulk DMI");
    }
    if plan
        .temperature
        .is_some_and(|temperature| temperature > 0.0)
    {
        return Some("thermal Brown interaction");
    }
    if fem_plan_has_zhang_li_stt(plan) {
        return Some("Zhang-Li STT");
    }
    if fem_plan_has_slonczewski_stt(plan) {
        return Some("Slonczewski STT");
    }
    if plan.has_oersted_cylinder
        || plan
            .oersted_field_xyz
            .as_ref()
            .is_some_and(|field| !field.is_empty())
    {
        return Some("Oersted interaction");
    }
    if plan.magnetoelastic.is_some() {
        return Some("magnetoelastic interaction");
    }
    None
}

pub(crate) fn elementwise_material_legality_error(
    fem_plan: &FemPlanIR,
    gpu: bool,
) -> Option<String> {
    let device = if gpu { "gpu" } else { "cpu" };

    if fem_plan.ms_element_field.is_some() {
        let owner = if gpu {
            Some("GPU material-state upload")
        } else {
            first_unsupported_elementwise_ms_cpu_owner(fem_plan)
        };
        if let Some(owner) = owner {
            return Some(format!(
                "Ms_element_field is unsupported for {owner} on resolved device '{device}': this owner does not consume the common element/quadrature material accessor"
            ));
        }
    }

    if gpu {
        let field = if fem_plan.a_element_field.is_some() {
            Some("A_element_field")
        } else {
            None
        }?;
        return Some(format!(
            "{field} is unsupported for GPU material-state upload on resolved device '{device}': this runtime has no common element/quadrature material accessor"
        ));
    }

    if fem_plan.a_element_field.is_some() && !fem_plan.enable_exchange {
        return Some(format!(
            "A_element_field is unsupported for exchange-disabled plan on resolved device '{device}': this runtime has no exchange weak form to consume the sharp coefficient"
        ));
    }
    None
}

fn exclusive_coefficient_realization_error(
    material: &fullmag_ir::MaterialIR,
    ms_element_field: &Option<Vec<f64>>,
    a_element_field: &Option<Vec<f64>>,
) -> Option<String> {
    if material.ms_field.is_some() && ms_element_field.is_some() {
        return Some(
            "FEM material coefficient 'Ms' has conflicting nodal P1 'material.ms_field' and element DG0 'ms_element_field' realizations"
                .to_string(),
        );
    }
    if material.a_field.is_some() && a_element_field.is_some() {
        return Some(
            "FEM material coefficient 'A' has conflicting nodal P1 'material.a_field' and element DG0 'a_element_field' realizations"
                .to_string(),
        );
    }
    None
}

fn domain_mesh_workflow_mode(problem: &ProblemIR) -> Option<String> {
    mesh_workflow_metadata(problem)
        .and_then(|workflow| workflow.get("domain_mesh_mode"))
        .and_then(|value| value.as_str())
        .map(str::trim)
        .filter(|value| !value.is_empty())
        .map(ToOwned::to_owned)
}

fn frequency_response_equilibrium_provenance(
    problem: &ProblemIR,
) -> Result<Option<FemFrequencyDomainEquilibriumProvenanceIR>, PlanError> {
    let Some(value) = problem
        .problem_meta
        .runtime_metadata
        .get("frequency_response_m5_equilibrium_provenance")
    else {
        return Ok(None);
    };
    serde_json::from_value::<FemFrequencyDomainEquilibriumProvenanceIR>(value.clone())
        .map(Some)
        .map_err(|error| PlanError {
            reasons: vec![format!(
                "runtime_metadata.frequency_response_m5_equilibrium_provenance is invalid: {error}"
            )],
        })
}

fn eigen_dispersion_validation(
    problem: &ProblemIR,
) -> Result<Option<FemEigenDispersionValidationIR>, PlanError> {
    let Some(value) = problem
        .problem_meta
        .runtime_metadata
        .get("dispersion_validation")
    else {
        return Ok(None);
    };
    let validation = serde_json::from_value::<FemEigenDispersionValidationIR>(value.clone())
        .map_err(|error| PlanError {
            reasons: vec![format!(
                "runtime_metadata.dispersion_validation is invalid: {error}"
            )],
        })?;
    validate_eigen_dispersion_validation(&validation)?;
    Ok(Some(validation))
}

fn eigen_k0_kittel_validation(
    problem: &ProblemIR,
) -> Result<Option<FemEigenK0KittelValidationIR>, PlanError> {
    let Some(value) = problem
        .problem_meta
        .runtime_metadata
        .get("k0_kittel_validation")
    else {
        return Ok(None);
    };
    let validation = serde_json::from_value::<FemEigenK0KittelValidationIR>(value.clone())
        .map_err(|error| PlanError {
            reasons: vec![format!(
                "runtime_metadata.k0_kittel_validation is invalid: {error}"
            )],
        })?;
    validate_eigen_k0_kittel_validation(&validation)?;
    Ok(Some(validation))
}

fn validate_eigen_k0_kittel_validation(
    validation: &FemEigenK0KittelValidationIR,
) -> Result<(), PlanError> {
    let mut errors = Vec::new();
    if validation.kind != "k0_kittel_field_sweep" {
        errors.push(
            "runtime_metadata.k0_kittel_validation.kind must be 'k0_kittel_field_sweep'"
                .to_string(),
        );
    }
    if validation
        .case_id
        .as_deref()
        .is_some_and(|value| value.trim().is_empty())
    {
        errors.push("runtime_metadata.k0_kittel_validation.case_id must be non-empty".to_string());
    }
    if let Some(demag_kind) = validation.demag_kind.as_deref() {
        match demag_kind {
            "none" | "periodic_airbox_k0" | "synthetic_demag_factor" => {}
            _ => errors.push(
                "runtime_metadata.k0_kittel_validation.demag_kind must be 'none', 'periodic_airbox_k0', or 'synthetic_demag_factor'"
                    .to_string(),
            ),
        }
    }
    match validation.model.as_str() {
        "macrospin_larmor" => {}
        "thin_film_in_plane" => {
            let effective = validation.material.effective_magnetisation;
            if !effective.is_some_and(|value| value.is_finite() && value > 0.0) {
                errors.push(
                    "runtime_metadata.k0_kittel_validation.material.effective_magnetisation must be finite and positive for thin_film_in_plane"
                        .to_string(),
                );
            }
        }
        _ => errors.push(
            "runtime_metadata.k0_kittel_validation.model must be 'macrospin_larmor' or 'thin_film_in_plane'"
                .to_string(),
        ),
    }
    if validation.field_units != "A_per_m" {
        errors.push(
            "runtime_metadata.k0_kittel_validation.field_units must be 'A_per_m'".to_string(),
        );
    }
    if !(validation.relative_tolerance.is_finite()
        && validation.relative_tolerance > 0.0
        && validation.relative_tolerance <= 0.25)
    {
        errors.push(
            "runtime_metadata.k0_kittel_validation.relative_tolerance must be in (0, 0.25]"
                .to_string(),
        );
    }
    if validation.samples.len() < 3 {
        errors.push(
            "runtime_metadata.k0_kittel_validation.samples must contain at least three samples"
                .to_string(),
        );
    }
    let mut sample_indices = BTreeSet::new();
    for (index, sample) in validation.samples.iter().enumerate() {
        if !sample_indices.insert(sample.sample_index) {
            errors.push(format!(
                "runtime_metadata.k0_kittel_validation.samples[{index}].sample_index is duplicated"
            ));
        }
        if !sample.bias_field.iter().all(|value| value.is_finite())
            || vector_norm(sample.bias_field) <= 0.0
        {
            errors.push(format!(
                "runtime_metadata.k0_kittel_validation.samples[{index}].bias_field must be finite and non-zero"
            ));
        }
    }
    if errors.is_empty() {
        Ok(())
    } else {
        Err(PlanError { reasons: errors })
    }
}

fn validate_eigen_dispersion_validation(
    validation: &FemEigenDispersionValidationIR,
) -> Result<(), PlanError> {
    let mut errors = Vec::new();
    if validation.kind != "thin_film_de_bv_low_k" {
        errors.push(
            "runtime_metadata.dispersion_validation.kind must be 'thin_film_de_bv_low_k'"
                .to_string(),
        );
    }
    if validation.analytic_model != "kalinikos_slab_n0" {
        errors.push(
            "runtime_metadata.dispersion_validation.analytic_model must be 'kalinikos_slab_n0'"
                .to_string(),
        );
    }
    if !(validation.film_thickness_m.is_finite() && validation.film_thickness_m > 0.0) {
        errors.push(
            "runtime_metadata.dispersion_validation.film_thickness_m must be finite and positive"
                .to_string(),
        );
    }
    if !(validation.max_k_rad_per_m.is_finite()
        && validation.max_k_rad_per_m > 0.0
        && validation.max_k_rad_per_m <= 3.0e6)
    {
        errors.push(
            "runtime_metadata.dispersion_validation.max_k_rad_per_m must be in (0, 3e6]"
                .to_string(),
        );
    }
    if !(validation.max_relative_error.is_finite()
        && validation.max_relative_error > 0.0
        && validation.max_relative_error <= 0.25)
    {
        errors.push(
            "runtime_metadata.dispersion_validation.max_relative_error must be in (0, 0.25]"
                .to_string(),
        );
    }
    let window = &validation.frequency_window_hz;
    if !(window.min.is_finite()
        && window.max.is_finite()
        && window.min >= 0.0
        && window.max > window.min
        && window.max <= 5.0e9)
    {
        errors.push(
            "runtime_metadata.dispersion_validation.frequency_window_hz must be finite, ordered, non-negative, and not exceed 5 GHz"
                .to_string(),
        );
    }

    let m0_norm = vector_norm(validation.equilibrium_magnetization);
    let film_normal_norm = vector_norm(validation.film_normal);
    if !(m0_norm.is_finite() && m0_norm > 0.0) {
        errors.push(
            "runtime_metadata.dispersion_validation.equilibrium_magnetization must be finite and non-zero"
                .to_string(),
        );
    }
    if !(film_normal_norm.is_finite() && film_normal_norm > 0.0) {
        errors.push(
            "runtime_metadata.dispersion_validation.film_normal must be finite and non-zero"
                .to_string(),
        );
    }
    if m0_norm.is_finite()
        && m0_norm > 0.0
        && film_normal_norm.is_finite()
        && film_normal_norm > 0.0
    {
        let cos_angle = vector_dot(validation.equilibrium_magnetization, validation.film_normal)
            .abs()
            / (m0_norm * film_normal_norm);
        if cos_angle > 1.0e-6 {
            errors.push(
                "runtime_metadata.dispersion_validation.equilibrium_magnetization must be in-plane"
                    .to_string(),
            );
        }
    }

    let mut geometries = BTreeSet::new();
    for (index, scenario) in validation.scenarios.iter().enumerate() {
        match scenario.geometry.as_str() {
            "damon_eshbach" | "backward_volume" => {
                geometries.insert(scenario.geometry.as_str());
            }
            _ => errors.push(format!(
                "runtime_metadata.dispersion_validation.scenarios[{index}].geometry must be damon_eshbach or backward_volume"
            )),
        }
        if scenario.branch_id.trim().is_empty() {
            errors.push(format!(
                "runtime_metadata.dispersion_validation.scenarios[{index}].branch_id must not be empty"
            ));
        }
        if scenario.sample_indices.len() < 3 {
            errors.push(format!(
                "runtime_metadata.dispersion_validation.scenarios[{index}].sample_indices must contain at least three samples"
            ));
        }
    }
    if !(geometries.contains("damon_eshbach") && geometries.contains("backward_volume")) {
        errors.push(
            "runtime_metadata.dispersion_validation.scenarios must include both damon_eshbach and backward_volume"
                .to_string(),
        );
    }
    if errors.is_empty() {
        Ok(())
    } else {
        Err(PlanError { reasons: errors })
    }
}

fn allows_low_k_de_bv_analytic_reference(
    validation: &Option<FemEigenDispersionValidationIR>,
) -> bool {
    validation.as_ref().is_some_and(|validation| {
        validation.kind == "thin_film_de_bv_low_k"
            && validation.analytic_model == "kalinikos_slab_n0"
    })
}

fn k_sampling_is_gamma_only(k_sampling: &Option<fullmag_ir::KSamplingIR>) -> bool {
    k_sampling.as_ref().is_none_or(|sampling| match sampling {
        fullmag_ir::KSamplingIR::Single { k_vector } => k_vector
            .iter()
            .all(|component| component.is_finite() && component.abs() <= 1.0e-12),
        fullmag_ir::KSamplingIR::Path { points, .. } => {
            !points.is_empty()
                && points.iter().all(|point| {
                    point
                        .k_vector
                        .iter()
                        .all(|component| component.is_finite() && component.abs() <= 1.0e-12)
                })
        }
    })
}

fn allows_k0_kittel_synthetic_demag_factor(
    validation: &Option<FemEigenK0KittelValidationIR>,
    k_sampling: &Option<fullmag_ir::KSamplingIR>,
) -> bool {
    validation.as_ref().is_some_and(|validation| {
        validation.kind == "k0_kittel_field_sweep"
            && validation.case_id.as_deref() == Some("K0-3")
            && validation.demag_kind.as_deref() == Some("synthetic_demag_factor")
            && validation.model == "thin_film_in_plane"
            && k_sampling_is_gamma_only(k_sampling)
    })
}

fn vector_dot(lhs: [f64; 3], rhs: [f64; 3]) -> f64 {
    lhs[0] * rhs[0] + lhs[1] * rhs[1] + lhs[2] * rhs[2]
}

fn vector_norm(value: [f64; 3]) -> f64 {
    vector_dot(value, value).sqrt()
}

fn requested_fem_demag_realization(problem: &ProblemIR) -> fullmag_ir::RequestedFemDemagIR {
    problem
        .energy_terms
        .iter()
        .find_map(|term| match term {
            EnergyTermIR::Demag { realization } => Some(realization.normalized()),
            _ => None,
        })
        .unwrap_or(fullmag_ir::RequestedFemDemagIR::Auto)
}

fn fem_single_precision_rejection(requested_cuda: bool, context: &str) -> String {
    if requested_cuda {
        format!(
            "execution_precision='single' is not executable in the {context} GPU path; single-precision CUDA kernels are not yet implemented"
        )
    } else {
        format!(
            "execution_precision='single' is not executable in the {context} CPU path; current FEM CPU execution supports only 'double'"
        )
    }
}

fn periodic_axis_from_label(value: &str) -> Option<usize> {
    let normalized = value.trim().to_ascii_lowercase().replace('-', "_");
    if normalized.starts_with("x") {
        Some(0)
    } else if normalized.starts_with("y") {
        Some(1)
    } else if normalized.starts_with("z") {
        Some(2)
    } else {
        None
    }
}

fn periodic_boundary_axes(mesh: &fullmag_ir::MeshIR) -> BTreeSet<usize> {
    let mut axes = BTreeSet::new();
    for pair in &mesh.periodic_boundary_pairs {
        if let Some(axis) = pair
            .axis_hint
            .as_deref()
            .and_then(periodic_axis_from_label)
            .or_else(|| periodic_axis_from_label(&pair.pair_id))
        {
            axes.insert(axis);
            continue;
        }
        if let Some(translation) = pair.translation {
            let mut dominant_axis = None;
            let mut dominant_abs = 0.0;
            for (axis, value) in translation.iter().enumerate() {
                let abs_value = value.abs();
                if abs_value > dominant_abs {
                    dominant_abs = abs_value;
                    dominant_axis = Some(axis);
                }
            }
            if dominant_abs > 0.0 {
                if let Some(axis) = dominant_axis {
                    axes.insert(axis);
                }
            }
        }
    }
    axes
}

fn requested_problem_pbc_axes(problem: &ProblemIR) -> BTreeSet<usize> {
    let mut axes = BTreeSet::new();
    if let Some(pbc) = &problem.pbc {
        for (axis, boundary) in pbc.axes.iter().enumerate() {
            if *boundary == fullmag_ir::AxisBoundary::Periodic {
                axes.insert(axis);
            }
        }
    }
    axes
}

fn axis_set_label(axes: &BTreeSet<usize>) -> String {
    if axes.is_empty() {
        return "none".to_string();
    }
    axes.iter()
        .map(|axis| match axis {
            0 => "x",
            1 => "y",
            2 => "z",
            _ => "?",
        })
        .collect::<Vec<_>>()
        .join(",")
}

fn study_mechanics(problem: &ProblemIR) -> Option<&fullmag_ir::MechanicsIR> {
    match &problem.study {
        fullmag_ir::StudyIR::TimeEvolution { dynamics, .. }
        | fullmag_ir::StudyIR::Eigenmodes { dynamics, .. }
        | fullmag_ir::StudyIR::FrequencyResponse { dynamics, .. } => match dynamics {
            fullmag_ir::DynamicsIR::Llg { mechanics, .. } => mechanics.as_ref(),
        },
        fullmag_ir::StudyIR::Relaxation { dynamics, .. } => {
            dynamics.as_ref().and_then(|dynamics| {
                let fullmag_ir::DynamicsIR::Llg { mechanics, .. } = dynamics;
                mechanics.as_ref()
            })
        }
        fullmag_ir::StudyIR::Hysteresis { .. } => None,
    }
}

fn resolve_fem_magnetoelastic_plan(
    problem: &ProblemIR,
) -> Result<Option<(FemMagnetoelasticPlanIR, FemMechanicalPlanIR)>, PlanError> {
    let mut terms = problem.energy_terms.iter().filter_map(|term| {
        if let EnergyTermIR::Magnetoelastic { body, law, .. } = term {
            Some((body.as_str(), law.as_str()))
        } else {
            None
        }
    });
    let Some((body_name, law_name)) = terms.next() else {
        return Ok(None);
    };
    if terms.next().is_some() {
        return Err(PlanError {
            reasons: vec![
                "current native FEM prescribed-strain magnetoelastic path supports exactly one Magnetoelastic energy term"
                    .to_string(),
            ],
        });
    }

    match study_mechanics(problem) {
        Some(fullmag_ir::MechanicsIR::QuasistaticElasticity { .. }) => {
            return Err(PlanError {
                reasons: vec![
                    "FEM quasistatic magnetoelasticity is not executable yet; current native FEM supports only prescribed-strain magnetoelastic coupling"
                        .to_string(),
                ],
            });
        }
        Some(fullmag_ir::MechanicsIR::Elastodynamics { .. }) => {
            return Err(PlanError {
                reasons: vec![
                    "FEM elastodynamic magnetoelasticity is not executable yet; current native FEM supports only prescribed-strain magnetoelastic coupling"
                        .to_string(),
                ],
            });
        }
        Some(fullmag_ir::MechanicsIR::PrescribedStrain) | None => {}
    }

    let prescribed_strain = problem.mechanical_loads.iter().find_map(|load| {
        if let MechanicalLoadIR::PrescribedStrain { strain } = load {
            Some(*strain)
        } else {
            None
        }
    });
    let Some(prescribed_strain) = prescribed_strain else {
        return Err(PlanError {
            reasons: vec![
                "current native FEM magnetoelastic execution requires MechanicalLoadIR::PrescribedStrain; quasistatic/dynamic mechanics are not executable yet"
                    .to_string(),
            ],
        });
    };

    let Some(body) = problem
        .elastic_bodies
        .iter()
        .find(|candidate| candidate.name == body_name)
        .cloned()
    else {
        return Err(PlanError {
            reasons: vec![format!(
                "Magnetoelastic references unknown elastic body '{body_name}'"
            )],
        });
    };
    let Some(elastic_material) = problem
        .elastic_materials
        .iter()
        .find(|candidate| candidate.name == body.elastic_material)
        .cloned()
    else {
        return Err(PlanError {
            reasons: vec![format!(
                "Magnetoelastic elastic body '{}' references unknown elastic material '{}'",
                body.name, body.elastic_material
            )],
        });
    };
    let Some(law_ir) = problem
        .magnetostriction_laws
        .iter()
        .find(|law| law.name() == law_name)
        .cloned()
    else {
        return Err(PlanError {
            reasons: vec![format!(
                "Magnetoelastic references unknown magnetostriction law '{law_name}'"
            )],
        });
    };
    let (b1, b2) = match &law_ir {
        MagnetostrictionLawIR::Cubic { b1, b2, .. } => (*b1, *b2),
        MagnetostrictionLawIR::Isotropic { lambda_s, .. } => {
            return Err(PlanError {
                reasons: vec![format!(
                    "isotropic magnetostriction (lambda_s={lambda_s}) is not executable for FEM without a physically justified B1/B2 mapping; refusing lossy fallback"
                )],
            });
        }
    };
    Ok(Some((
        FemMagnetoelasticPlanIR {
            b1,
            b2,
            prescribed_strain: Some(prescribed_strain),
        },
        FemMechanicalPlanIR {
            mode: FemMechanicalModeIR::PrescribedStrain,
            body,
            elastic_material,
            magnetostriction_law: law_ir,
            boundary_conditions: problem.mechanical_bcs.clone(),
            loads: problem.mechanical_loads.clone(),
            same_mesh_only: true,
            max_picard_iterations: None,
            picard_tolerance: None,
            mechanical_dt: None,
        },
    )))
}

fn geometry_to_object_id_map(
    magnet_entries: &[crate::mesh::MagnetPlanningEntry],
) -> BTreeMap<&str, &str> {
    magnet_entries
        .iter()
        .map(|entry| (entry.geometry_name.as_str(), entry.magnet_name.as_str()))
        .collect()
}

fn plan_object_ids_match(a: &str, b: &str) -> bool {
    if a == b {
        return true;
    }
    let clean_a = a.strip_suffix("_geom").unwrap_or(a);
    let clean_b = b.strip_suffix("_geom").unwrap_or(b);
    clean_a == clean_b
}

fn remap_segment_object_ids(
    segments: &[fullmag_ir::FemObjectSegmentIR],
    geometry_to_object_id: &BTreeMap<&str, &str>,
) -> Result<Vec<fullmag_ir::FemObjectSegmentIR>, PlanError> {
    segments
        .iter()
        .map(|segment| {
            if segment.object_id == AIR_OBJECT_SEGMENT_ID {
                return Ok(segment.clone());
            }
            let seg_id = segment.object_id.as_str();
            let mut mapped_object_id = geometry_to_object_id.get(seg_id).copied();
            if mapped_object_id.is_none() && seg_id.ends_with("_geom") {
                mapped_object_id = geometry_to_object_id
                    .get(&seg_id[..seg_id.len() - 5])
                    .copied();
            }
            if mapped_object_id.is_none() {
                mapped_object_id =
                    geometry_to_object_id
                        .iter()
                        .find_map(|(geometry_id, object_id)| {
                            if plan_object_ids_match(seg_id, geometry_id)
                                || plan_object_ids_match(seg_id, object_id)
                            {
                                Some(*object_id)
                            } else {
                                None
                            }
                        });
            }
            let Some(mapped_object_id) = mapped_object_id else {
                return Err(PlanError {
                    reasons: vec![format!(
                        "FEM object segment '{}' does not map to any magnet/object id",
                        segment.object_id
                    )],
                });
            };
            Ok(fullmag_ir::FemObjectSegmentIR {
                object_id: mapped_object_id.to_string(),
                geometry_id: segment
                    .geometry_id
                    .clone()
                    .or_else(|| Some(segment.object_id.clone())),
                node_start: segment.node_start,
                node_count: segment.node_count,
                element_start: segment.element_start,
                element_count: segment.element_count,
                boundary_face_start: segment.boundary_face_start,
                boundary_face_count: segment.boundary_face_count,
            })
        })
        .collect()
}

fn segment_matches_magnet_entry(
    segment: &fullmag_ir::FemObjectSegmentIR,
    entry: &MagnetPlanningEntry,
) -> bool {
    plan_object_ids_match(&segment.object_id, &entry.geometry_name)
        || plan_object_ids_match(&segment.object_id, &entry.magnet_name)
        || segment
            .geometry_id
            .as_deref()
            .map(|geometry_id| plan_object_ids_match(geometry_id, &entry.geometry_name))
            .unwrap_or(false)
}

fn segment_node_indices_from_parts(
    mesh_parts: &[fullmag_ir::FemMeshPartIR],
    segment: &fullmag_ir::FemObjectSegmentIR,
) -> Option<Vec<usize>> {
    let matching_part = segment
        .geometry_id
        .as_deref()
        .and_then(|segment_geometry_id| {
            mesh_parts.iter().find(|part| {
                part.role == fullmag_ir::FemMeshPartRole::MagneticObject
                    && part.geometry_id.as_deref().is_some_and(|part_geometry_id| {
                        plan_object_ids_match(part_geometry_id, segment_geometry_id)
                    })
                    && !part.node_indices.is_empty()
            })
        })
        .or_else(|| {
            mesh_parts.iter().find(|part| {
                part.role == fullmag_ir::FemMeshPartRole::MagneticObject
                    && part
                        .object_id
                        .as_deref()
                        .is_some_and(|id| plan_object_ids_match(id, segment.object_id.as_str()))
                    && !part.node_indices.is_empty()
            })
        });

    matching_part.map(|part| {
        part.node_indices
            .iter()
            .map(|index| *index as usize)
            .collect()
    })
}

fn segment_node_indices(
    mesh_parts: &[fullmag_ir::FemMeshPartIR],
    segment: &fullmag_ir::FemObjectSegmentIR,
    total_nodes: usize,
) -> Result<Vec<usize>, PlanError> {
    if let Some(indices) = segment_node_indices_from_parts(mesh_parts, segment) {
        if let Some(index) = indices.iter().copied().find(|index| *index >= total_nodes) {
            return Err(PlanError {
                reasons: vec![format!(
                    "FEM object segment '{}' references node index {} outside mesh node count {}",
                    segment.object_id, index, total_nodes
                )],
            });
        }
        return Ok(indices);
    }

    let start = segment.node_start as usize;
    let end = start.saturating_add(segment.node_count as usize);
    if end > total_nodes {
        return Err(PlanError {
            reasons: vec![format!(
                "FEM object segment '{}' node range {}..{} exceeds mesh node count {}",
                segment.object_id, start, end, total_nodes
            )],
        });
    }
    Ok((start..end).collect())
}

fn segment_element_node_indices(
    mesh: &fullmag_ir::MeshIR,
    segment: &fullmag_ir::FemObjectSegmentIR,
) -> Result<Vec<usize>, PlanError> {
    let element_start = segment.element_start as usize;
    let element_end = element_start.saturating_add(segment.element_count as usize);
    if element_end > mesh.elements.len() {
        return Err(PlanError {
            reasons: vec![format!(
                "FEM object segment '{}' element range {}..{} exceeds mesh element count {}",
                segment.object_id,
                element_start,
                element_end,
                mesh.elements.len()
            )],
        });
    }

    let mut indices = mesh.elements[element_start..element_end]
        .iter()
        .flat_map(|element| element.iter().copied())
        .map(|index| index as usize)
        .collect::<Vec<_>>();
    indices.sort_unstable();
    indices.dedup();
    if let Some(index) = indices
        .iter()
        .copied()
        .find(|index| *index >= mesh.nodes.len())
    {
        return Err(PlanError {
            reasons: vec![format!(
                "FEM object segment '{}' references node index {} outside mesh node count {}",
                segment.object_id,
                index,
                mesh.nodes.len()
            )],
        });
    }
    Ok(indices)
}

fn domain_initial_node_indices(
    mesh: &fullmag_ir::MeshIR,
    mesh_parts: &[fullmag_ir::FemMeshPartIR],
    segment: &fullmag_ir::FemObjectSegmentIR,
) -> Result<Vec<usize>, PlanError> {
    let mut indices = segment_node_indices(mesh_parts, segment, mesh.nodes.len())?;
    indices.extend(segment_element_node_indices(mesh, segment)?);
    indices.sort_unstable();
    indices.dedup();
    Ok(indices)
}

#[cfg_attr(not(test), allow(dead_code))]
pub(crate) fn assign_domain_initial_for_segment(
    target: &mut [[f64; 3]],
    mesh: &fullmag_ir::MeshIR,
    mesh_parts: &[fullmag_ir::FemMeshPartIR],
    segment: &fullmag_ir::FemObjectSegmentIR,
    entry: &MagnetPlanningEntry,
) -> Result<(), PlanError> {
    assign_domain_initial_for_segments(target, mesh, mesh_parts, &[segment], entry)
}

pub(crate) fn assign_domain_initial_for_segments(
    target: &mut [[f64; 3]],
    mesh: &fullmag_ir::MeshIR,
    mesh_parts: &[fullmag_ir::FemMeshPartIR],
    segments: &[&fullmag_ir::FemObjectSegmentIR],
    entry: &MagnetPlanningEntry,
) -> Result<(), PlanError> {
    let mut node_indices = Vec::new();
    for segment in segments {
        node_indices.extend(domain_initial_node_indices(mesh, mesh_parts, segment)?);
    }
    node_indices.sort_unstable();
    node_indices.dedup();

    if let Some(fullmag_ir::InitialMagnetizationIR::SampledField { values }) =
        entry.initial_magnetization.as_ref()
    {
        if values.len() == mesh.nodes.len() {
            for node_index in node_indices {
                target[node_index] = values[node_index];
            }
            return Ok(());
        }
    }

    let sample_points = node_indices
        .iter()
        .map(|index| mesh.nodes[*index])
        .collect::<Vec<_>>();
    let values = initial_vectors_for_magnet(
        &entry.magnet_name,
        &mesh.mesh_name,
        entry.initial_magnetization.as_ref(),
        sample_points.len(),
        Some(&sample_points),
        Some(&sample_points),
    )
    .map_err(|message| PlanError {
        reasons: vec![message],
    })?;
    for (node_index, value) in node_indices.into_iter().zip(values.into_iter()) {
        target[node_index] = value;
    }
    Ok(())
}

fn assign_material_ids_to_mesh_parts(
    mesh_parts: &mut [fullmag_ir::FemMeshPartIR],
    magnet_entries: &[MagnetPlanningEntry],
    magnet_materials: &BTreeMap<String, fullmag_ir::MaterialIR>,
) {
    let geometry_to_magnet = magnet_entries
        .iter()
        .map(|entry| (entry.geometry_name.as_str(), entry.magnet_name.as_str()))
        .collect::<BTreeMap<_, _>>();

    for part in mesh_parts {
        let Some(candidate_object_id) = part.object_id.as_deref() else {
            continue;
        };
        let matches_object = magnet_entries
            .iter()
            .any(|entry| plan_object_ids_match(&entry.magnet_name, candidate_object_id));
        let matches_geometry = part
            .geometry_id
            .as_deref()
            .and_then(|geometry_id| {
                geometry_to_magnet.get(geometry_id).copied().or_else(|| {
                    let clean_geo = geometry_id.strip_suffix("_geom").unwrap_or(geometry_id);
                    geometry_to_magnet.get(clean_geo).copied()
                })
            })
            .is_some();
        if matches_object || matches_geometry {
            let material_name = magnet_materials
                .get(candidate_object_id)
                .or_else(|| {
                    let clean_candidate = candidate_object_id
                        .strip_suffix("_geom")
                        .unwrap_or(candidate_object_id);
                    magnet_materials.get(clean_candidate)
                })
                .map(|material| material.name.clone())
                .or_else(|| {
                    part.geometry_id
                        .as_deref()
                        .and_then(|geometry_id| {
                            geometry_to_magnet.get(geometry_id).copied().or_else(|| {
                                let clean_geo =
                                    geometry_id.strip_suffix("_geom").unwrap_or(geometry_id);
                                geometry_to_magnet.get(clean_geo).copied()
                            })
                        })
                        .and_then(|magnet_name| magnet_materials.get(magnet_name))
                        .map(|material| material.name.clone())
                });
            part.material_id = material_name;
        }
    }
}

fn heterogeneous_fem_material_shape_supported(
    reference: &fullmag_ir::MaterialIR,
    candidate: &fullmag_ir::MaterialIR,
) -> bool {
    compatible_axis_for_region_material_field(
        reference.cubic_anisotropy_axis1,
        candidate.cubic_anisotropy_axis1,
        has_active_cubic_anisotropy(reference),
        has_active_cubic_anisotropy(candidate),
    ) && compatible_axis_for_region_material_field(
        reference.cubic_anisotropy_axis2,
        candidate.cubic_anisotropy_axis2,
        has_active_cubic_anisotropy(reference),
        has_active_cubic_anisotropy(candidate),
    )
}

fn compatible_axis_for_region_material_field(
    reference_axis: Option<[f64; 3]>,
    candidate_axis: Option<[f64; 3]>,
    reference_active: bool,
    candidate_active: bool,
) -> bool {
    match (reference_active, candidate_active) {
        (true, true) => reference_axis == candidate_axis,
        _ => true,
    }
}

fn segment_element_marker(
    mesh: &fullmag_ir::MeshIR,
    segment: &fullmag_ir::FemObjectSegmentIR,
) -> u32 {
    if segment.element_count == 0 {
        return 0;
    }
    mesh.element_markers
        .get(segment.element_start as usize)
        .copied()
        .unwrap_or(0)
}

fn build_region_materials(
    mesh: &fullmag_ir::MeshIR,
    object_segments: &[fullmag_ir::FemObjectSegmentIR],
    magnet_materials: &BTreeMap<String, fullmag_ir::MaterialIR>,
) -> Vec<fullmag_ir::FemRegionMaterialIR> {
    object_segments
        .iter()
        .filter(|segment| segment.object_id != AIR_OBJECT_SEGMENT_ID)
        .filter_map(|segment| {
            magnet_materials.get(&segment.object_id).map(|material| {
                fullmag_ir::FemRegionMaterialIR {
                    object_id: segment.object_id.clone(),
                    material: material.clone(),
                    element_marker: segment_element_marker(mesh, segment),
                }
            })
        })
        .collect()
}

fn values_differ(values: &[f64], reference: f64) -> bool {
    values
        .iter()
        .any(|value| (*value - reference).abs() > 1e-18)
}

fn axes_differ(values: &[[f64; 3]], reference: [f64; 3]) -> bool {
    values.iter().any(|value| {
        (value[0] - reference[0]).abs() > 1e-18
            || (value[1] - reference[1]).abs() > 1e-18
            || (value[2] - reference[2]).abs() > 1e-18
    })
}

fn has_cubic_anisotropy(material: &fullmag_ir::MaterialIR) -> bool {
    material.cubic_anisotropy_kc1.is_some()
        || material.cubic_anisotropy_kc2.is_some()
        || material.cubic_anisotropy_kc3.is_some()
        || material.kc1_field.is_some()
        || material.kc2_field.is_some()
        || material.kc3_field.is_some()
}

fn has_active_uniaxial_anisotropy(material: &fullmag_ir::MaterialIR) -> bool {
    has_nonzero_optional(material.uniaxial_anisotropy)
        || has_nonzero_optional(material.uniaxial_anisotropy_k2)
        || has_nonzero_field(&material.ku_field)
        || has_nonzero_field(&material.ku2_field)
}

fn has_active_cubic_anisotropy(material: &fullmag_ir::MaterialIR) -> bool {
    has_nonzero_optional(material.cubic_anisotropy_kc1)
        || has_nonzero_optional(material.cubic_anisotropy_kc2)
        || has_nonzero_optional(material.cubic_anisotropy_kc3)
        || has_nonzero_field(&material.kc1_field)
        || has_nonzero_field(&material.kc2_field)
        || has_nonzero_field(&material.kc3_field)
}

fn has_active_anisotropy(material: &fullmag_ir::MaterialIR) -> bool {
    has_active_uniaxial_anisotropy(material) || has_active_cubic_anisotropy(material)
}

fn should_promote_fem_material_template(
    reference: &fullmag_ir::MaterialIR,
    candidate: &fullmag_ir::MaterialIR,
) -> bool {
    !has_active_anisotropy(reference) && has_active_anisotropy(candidate)
}

fn has_nonzero_optional(value: Option<f64>) -> bool {
    value.is_some_and(|value| value.abs() > 1e-30)
}

fn has_nonzero_field(values: &Option<Vec<f64>>) -> bool {
    values
        .as_ref()
        .is_some_and(|values| values.iter().any(|value| value.abs() > 1e-30))
}

fn validate_cubic_anisotropy_axes(material: &fullmag_ir::MaterialIR) -> Option<String> {
    if !has_cubic_anisotropy(material) {
        return None;
    }

    let axis1 = material.cubic_anisotropy_axis1.unwrap_or([1.0, 0.0, 0.0]);
    let axis2 = material.cubic_anisotropy_axis2.unwrap_or([0.0, 1.0, 0.0]);
    if !axis1.iter().all(|component| component.is_finite())
        || !axis2.iter().all(|component| component.is_finite())
    {
        return Some(format!(
            "material '{}' {CUBIC_AXIS_VALIDATION_ERROR}",
            material.name
        ));
    }

    let norm1 = (axis1[0] * axis1[0] + axis1[1] * axis1[1] + axis1[2] * axis1[2]).sqrt();
    let norm2 = (axis2[0] * axis2[0] + axis2[1] * axis2[1] + axis2[2] * axis2[2]).sqrt();
    if !(norm1 > 1e-30 && norm1.is_finite() && norm2 > 1e-30 && norm2.is_finite()) {
        return Some(format!(
            "material '{}' {CUBIC_AXIS_VALIDATION_ERROR}",
            material.name
        ));
    }

    let c1 = [axis1[0] / norm1, axis1[1] / norm1, axis1[2] / norm1];
    let c2 = [axis2[0] / norm2, axis2[1] / norm2, axis2[2] / norm2];
    let dot = c1[0] * c2[0] + c1[1] * c2[1] + c1[2] * c2[2];
    let cross = [
        c1[1] * c2[2] - c1[2] * c2[1],
        c1[2] * c2[0] - c1[0] * c2[2],
        c1[0] * c2[1] - c1[1] * c2[0],
    ];
    let cross_norm = (cross[0] * cross[0] + cross[1] * cross[1] + cross[2] * cross[2]).sqrt();
    if !dot.is_finite()
        || !cross_norm.is_finite()
        || dot.abs() > CUBIC_AXIS_ORTHOGONALITY_DOT_TOL
        || cross_norm < CUBIC_AXIS_ORTHOGONALITY_CROSS_MIN_NORM
    {
        return Some(format!(
            "material '{}' {CUBIC_AXIS_VALIDATION_ERROR}",
            material.name
        ));
    }

    None
}

fn validate_uniaxial_anisotropy_axis(material: &fullmag_ir::MaterialIR) -> Option<String> {
    if !has_active_uniaxial_anisotropy(material) {
        return None;
    }
    let axis = material.anisotropy_axis.unwrap_or([0.0, 0.0, 1.0]);
    match normalize_nonzero_vector3(axis, "anisotropy_axis") {
        Ok(_) => None,
        Err(reason) => Some(format!("material '{}' {}", material.name, reason)),
    }
}

fn normalize_nonzero_vector3(value: [f64; 3], field_name: &str) -> Result<[f64; 3], String> {
    if value.iter().any(|component| !component.is_finite()) {
        return Err(format!("{field_name} must contain finite values"));
    }
    let norm_sq = value[0] * value[0] + value[1] * value[1] + value[2] * value[2];
    if norm_sq <= 1e-30 {
        return Err(format!("{field_name} must be non-zero"));
    }
    let inv_norm = norm_sq.sqrt().recip();
    Ok([
        value[0] * inv_norm,
        value[1] * inv_norm,
        value[2] * inv_norm,
    ])
}

fn resolve_interfacial_dmi_normal(
    requested_normal: Option<[f64; 3]>,
) -> Result<Option<[f64; 3]>, String> {
    let Some(raw_normal) = requested_normal else {
        return Ok(Some([0.0, 0.0, 1.0]));
    };
    normalize_nonzero_vector3(raw_normal, "InterfacialDmi.interface_normal").map(Some)
}

fn build_region_material_fields(
    problem: &ProblemIR,
    base_material: &fullmag_ir::MaterialIR,
    mesh: &fullmag_ir::MeshIR,
    object_segments: &[fullmag_ir::FemObjectSegmentIR],
    mesh_parts: &[fullmag_ir::FemMeshPartIR],
    magnet_materials: &BTreeMap<String, fullmag_ir::MaterialIR>,
) -> Result<(fullmag_ir::MaterialIR, Option<Vec<[f64; 3]>>), PlanError> {
    let node_count = mesh.nodes.len();
    if node_count == 0 {
        return Ok((base_material.clone(), None));
    }

    let mut material = base_material.clone();
    let base_axis = normalize_nonzero_vector3(
        base_material.anisotropy_axis.unwrap_or([0.0, 0.0, 1.0]),
        "anisotropy_axis",
    )
    .map_err(|e| PlanError { reasons: vec![e] })?;
    let mut ms_values = vec![base_material.saturation_magnetisation; node_count];
    let mut a_values = vec![base_material.exchange_stiffness; node_count];
    let mut alpha_values = vec![base_material.damping; node_count];
    let mut ku_values = vec![base_material.uniaxial_anisotropy.unwrap_or(0.0); node_count];
    let mut ku2_values = vec![base_material.uniaxial_anisotropy_k2.unwrap_or(0.0); node_count];
    let mut anisotropy_axis_values = vec![base_axis; node_count];
    let mut kc1_values = vec![base_material.cubic_anisotropy_kc1.unwrap_or(0.0); node_count];
    let mut kc2_values = vec![base_material.cubic_anisotropy_kc2.unwrap_or(0.0); node_count];
    let mut kc3_values = vec![base_material.cubic_anisotropy_kc3.unwrap_or(0.0); node_count];
    let mut dind_values = vec![base_material.interfacial_dmi.unwrap_or(0.0); node_count];
    let mut dbulk_values = vec![base_material.bulk_dmi.unwrap_or(0.0); node_count];

    let sharp_conformal_aex_regions =
        sharp_conformal_parameter_regions(problem, fullmag_ir::MaterialParameterNameIR::Aex)?;
    let sharp_conformal_ms_regions =
        sharp_conformal_parameter_regions(problem, fullmag_ir::MaterialParameterNameIR::Ms)?;

    for segment in object_segments {
        if segment.object_id == AIR_OBJECT_SEGMENT_ID {
            continue;
        }
        let Some(region_material) = magnet_materials.get(&segment.object_id) else {
            continue;
        };
        let node_indices = segment_node_indices(mesh_parts, segment, node_count)?;
        if node_indices.is_empty() {
            continue;
        }
        let region_axis = normalize_nonzero_vector3(
            region_material.anisotropy_axis.unwrap_or([0.0, 0.0, 1.0]),
            "anisotropy_axis",
        )
        .map_err(|e| PlanError {
            reasons: vec![format!("material '{}' {}", region_material.name, e)],
        })?;

        let points: Vec<[f64; 3]> = node_indices.iter().map(|&idx| mesh.nodes[idx]).collect();
        let object_translation = crate::material::object_translation(problem, &segment.object_id);

        let ms_resolved = crate::material::resolve_spatial_parameter_excluding_regions(
            problem,
            &segment.object_id,
            fullmag_ir::MaterialParameterNameIR::Ms,
            region_material.saturation_magnetisation,
            &points,
            object_translation,
            &sharp_conformal_ms_regions,
        )
        .map_err(|e| PlanError { reasons: vec![e] })?;

        let aex_resolved = crate::material::resolve_spatial_parameter_excluding_regions(
            problem,
            &segment.object_id,
            fullmag_ir::MaterialParameterNameIR::Aex,
            region_material.exchange_stiffness,
            &points,
            object_translation,
            &sharp_conformal_aex_regions,
        )
        .map_err(|e| PlanError { reasons: vec![e] })?;

        let alpha_resolved = crate::material::resolve_spatial_parameter(
            problem,
            &segment.object_id,
            fullmag_ir::MaterialParameterNameIR::Alpha,
            region_material.damping,
            &points,
            object_translation,
        )
        .map_err(|e| PlanError { reasons: vec![e] })?;

        for (i, &index) in node_indices.iter().enumerate() {
            ms_values[index] = ms_resolved[i];
            a_values[index] = aex_resolved[i];
            alpha_values[index] = alpha_resolved[i];
            ku_values[index] = region_material.uniaxial_anisotropy.unwrap_or(0.0);
            ku2_values[index] = region_material.uniaxial_anisotropy_k2.unwrap_or(0.0);
            anisotropy_axis_values[index] = region_axis;
            kc1_values[index] = region_material.cubic_anisotropy_kc1.unwrap_or(0.0);
            kc2_values[index] = region_material.cubic_anisotropy_kc2.unwrap_or(0.0);
            kc3_values[index] = region_material.cubic_anisotropy_kc3.unwrap_or(0.0);
            dind_values[index] = region_material.interfacial_dmi.unwrap_or(0.0);
            dbulk_values[index] = region_material.bulk_dmi.unwrap_or(0.0);
        }
    }

    material.ms_field =
        values_differ(&ms_values, base_material.saturation_magnetisation).then_some(ms_values);
    material.a_field =
        values_differ(&a_values, base_material.exchange_stiffness).then_some(a_values);
    material.alpha_field =
        values_differ(&alpha_values, base_material.damping).then_some(alpha_values);
    material.ku_field = values_differ(&ku_values, base_material.uniaxial_anisotropy.unwrap_or(0.0))
        .then_some(ku_values);
    material.ku2_field = values_differ(
        &ku2_values,
        base_material.uniaxial_anisotropy_k2.unwrap_or(0.0),
    )
    .then_some(ku2_values);
    material.kc1_field = values_differ(
        &kc1_values,
        base_material.cubic_anisotropy_kc1.unwrap_or(0.0),
    )
    .then_some(kc1_values);
    material.kc2_field = values_differ(
        &kc2_values,
        base_material.cubic_anisotropy_kc2.unwrap_or(0.0),
    )
    .then_some(kc2_values);
    material.kc3_field = values_differ(
        &kc3_values,
        base_material.cubic_anisotropy_kc3.unwrap_or(0.0),
    )
    .then_some(kc3_values);
    material.dind_field = values_differ(&dind_values, base_material.interfacial_dmi.unwrap_or(0.0))
        .then_some(dind_values);
    material.dbulk_field =
        values_differ(&dbulk_values, base_material.bulk_dmi.unwrap_or(0.0)).then_some(dbulk_values);
    let anisotropy_axis_field =
        axes_differ(&anisotropy_axis_values, base_axis).then_some(anisotropy_axis_values);
    Ok((material, anisotropy_axis_field))
}

fn sharp_conformal_parameter_regions(
    problem: &ProblemIR,
    parameter: fullmag_ir::MaterialParameterNameIR,
) -> Result<BTreeSet<String>, PlanError> {
    let mut region_ids = BTreeSet::new();
    for region in problem
        .object_regions
        .iter()
        .filter(|region| region.enabled)
    {
        if region.realization_policy != fullmag_ir::RegionRealizationPolicyIR::Project
            && crate::validate::region_is_conformal(problem, region)
            && sharp_constant_region_parameter(problem, region, parameter)?.is_some()
        {
            region_ids.insert(region.region_id.clone());
        }
    }
    Ok(region_ids)
}

fn material_field_constant_value(field: &fullmag_ir::MaterialParameterFieldIR) -> Option<f64> {
    match field {
        fullmag_ir::MaterialParameterFieldIR::Constant { value, .. } => value
            .as_f64()
            .or_else(|| value.as_i64().map(|value| value as f64)),
        _ => None,
    }
}

fn sharp_constant_region_parameter(
    problem: &ProblemIR,
    region: &fullmag_ir::ObjectRegionIR,
    parameter: fullmag_ir::MaterialParameterNameIR,
) -> Result<Option<f64>, PlanError> {
    if !crate::material_transition::region_transition_is_sharp(region, parameter) {
        return Ok(None);
    }
    let mut candidates: Vec<(i32, f64, String)> = Vec::new();
    for material_override in &region.material_overrides {
        if material_override.parameter != parameter {
            continue;
        }
        if let Some(value) = material_field_constant_value(&material_override.value) {
            candidates.push((
                material_override.priority,
                value,
                format!("region_override:{}", region.region_id),
            ));
        }
    }
    for assignment in &problem.material_parameter_fields {
        if assignment.owner_object != region.owner_object
            || assignment.region_id.as_deref() != Some(region.region_id.as_str())
            || assignment.parameter != parameter
        {
            continue;
        }
        if let Some(value) = material_field_constant_value(&assignment.value) {
            candidates.push((
                assignment.priority,
                value,
                format!("assignment:{}", assignment.assignment_id),
            ));
        }
    }
    if candidates.is_empty() {
        return Ok(None);
    }
    candidates.sort_by(|left, right| right.0.cmp(&left.0).then_with(|| left.2.cmp(&right.2)));
    let priority = candidates[0].0;
    let winners = candidates
        .iter()
        .filter(|candidate| candidate.0 == priority)
        .collect::<Vec<_>>();
    let value = winners[0].1;
    if winners
        .iter()
        .any(|candidate| (candidate.1 - value).abs() > 1e-18)
    {
        return Err(PlanError {
            reasons: vec![format!(
                "conflicting sharp constant {:?} values at priority {} for conformal region '{}': {}",
                parameter,
                priority,
                region.region_id,
                winners
                    .iter()
                    .map(|candidate| candidate.2.as_str())
                    .collect::<Vec<_>>()
                    .join(", ")
            )],
        });
    }
    Ok(Some(value))
}

fn build_conformal_region_element_fields(
    problem: &ProblemIR,
    base_material: &fullmag_ir::MaterialIR,
    mesh: &fullmag_ir::MeshIR,
    object_segments: &[fullmag_ir::FemObjectSegmentIR],
    magnet_materials: &BTreeMap<String, fullmag_ir::MaterialIR>,
) -> Result<(Option<Vec<f64>>, Option<Vec<f64>>), PlanError> {
    let element_count = mesh.elements.len();
    if element_count == 0 || mesh.element_markers.len() != element_count {
        return Ok((None, None));
    }

    let mut ms_values = vec![base_material.saturation_magnetisation; element_count];
    let mut a_values = vec![base_material.exchange_stiffness; element_count];
    for segment in object_segments {
        if segment.object_id == AIR_OBJECT_SEGMENT_ID {
            continue;
        }
        let Some(material) = magnet_materials.get(&segment.object_id) else {
            continue;
        };
        let start = segment.element_start as usize;
        let end = start.saturating_add(segment.element_count as usize);
        if end > element_count {
            return Err(PlanError {
                reasons: vec![format!(
                    "FEM object segment '{}' element range {}..{} exceeds mesh element count {}",
                    segment.object_id, start, end, element_count
                )],
            });
        }
        for element_index in start..end {
            ms_values[element_index] = material.saturation_magnetisation;
            a_values[element_index] = material.exchange_stiffness;
        }
    }

    let mut marker_to_region = BTreeMap::new();
    if let Some(domain_asset) = problem
        .geometry_assets
        .as_ref()
        .and_then(|assets| assets.fem_domain_mesh_asset.as_ref())
    {
        for marker in &domain_asset.object_region_markers {
            if mesh
                .element_markers
                .iter()
                .any(|mesh_marker| *mesh_marker == marker.marker)
            {
                marker_to_region.insert(marker.marker, marker.geometry_name.clone());
            }
        }
    }
    if marker_to_region.is_empty() {
        return Ok((None, None));
    }

    let mut region_by_key: BTreeMap<String, &fullmag_ir::ObjectRegionIR> = BTreeMap::new();
    for region in problem
        .object_regions
        .iter()
        .filter(|region| region.enabled)
    {
        region_by_key.insert(region.region_id.clone(), region);
        region_by_key.insert(region.name.clone(), region);
    }

    let mut ms_changed = false;
    let mut a_changed = false;
    for (element_index, marker) in mesh.element_markers.iter().copied().enumerate() {
        let Some(region_key) = marker_to_region.get(&marker) else {
            continue;
        };
        let Some(region) = region_by_key.get(region_key) else {
            continue;
        };
        let owner_material = magnet_materials
            .get(&region.owner_object)
            .unwrap_or(base_material);
        ms_values[element_index] = owner_material.saturation_magnetisation;
        a_values[element_index] = owner_material.exchange_stiffness;
        // Explicit Project remains a nodal approximation even if a conformal
        // marker is available. DG0 is reserved for non-Project conformal
        // realizations, otherwise one authored coefficient acquires both
        // public realizations.
        if region.realization_policy != fullmag_ir::RegionRealizationPolicyIR::Project {
            if let Some(value) = sharp_constant_region_parameter(
                problem,
                region,
                fullmag_ir::MaterialParameterNameIR::Ms,
            )? {
                ms_values[element_index] = value;
                ms_changed = true;
            }
            if let Some(value) = sharp_constant_region_parameter(
                problem,
                region,
                fullmag_ir::MaterialParameterNameIR::Aex,
            )? {
                a_values[element_index] = value;
                a_changed = true;
            }
        }
    }

    Ok((
        ms_changed.then_some(ms_values),
        a_changed.then_some(a_values),
    ))
}

fn gather_fem_material_field_plans(
    problem: &ProblemIR,
    material: &fullmag_ir::MaterialIR,
    node_count: usize,
) -> Vec<fullmag_ir::MaterialFieldPlan> {
    let mut material_field_plans = Vec::new();
    let is_extended =
        problem.validation_profile.execution_mode == fullmag_ir::ExecutionMode::Extended;
    for magnet in &problem.magnets {
        let mut plans = crate::material::build_material_field_plans(
            problem,
            &magnet.name,
            fullmag_ir::MaterialFieldLocationIR::Node,
        );
        for plan in &mut plans {
            if is_extended
                && (plan.parameter == fullmag_ir::MaterialParameterNameIR::Ms
                    || plan.parameter == fullmag_ir::MaterialParameterNameIR::Aex)
            {
                for region in &problem.object_regions {
                    if region.enabled && region.owner_object == magnet.name {
                        let has_sharp =
                            region.material_overrides.iter().any(|over| {
                                over.parameter == plan.parameter
                                    && matches!(
                                        over.value,
                                        fullmag_ir::MaterialParameterFieldIR::Constant { .. }
                                    )
                                    && crate::material_transition::region_transition_is_sharp(
                                        region,
                                        over.parameter,
                                    )
                            }) || problem.material_parameter_fields.iter().any(|assignment| {
                                assignment.region_id.as_deref() == Some(region.region_id.as_str())
                                    && assignment.parameter == plan.parameter
                                    && matches!(
                                        assignment.value,
                                        fullmag_ir::MaterialParameterFieldIR::Constant { .. }
                                    )
                                    && crate::material_transition::region_transition_is_sharp(
                                        region,
                                        assignment.parameter,
                                    )
                            });
                        if has_sharp {
                            let has_conformal_marker =
                                crate::validate::region_is_conformal(problem, region);
                            if region.realization_policy
                                == fullmag_ir::RegionRealizationPolicyIR::Project
                            {
                                let reason = if has_conformal_marker {
                                    "explicit project policy was requested despite an available conformal domain marker"
                                } else {
                                    "no domain marker was found in the mesh"
                                };
                                plan.warnings.push(format!(
                                    "sharp parameter override for {:?} in region '{}' requires conformal boundary, but {reason}; projected approximation will be used",
                                    plan.parameter, region.region_id
                                ));
                            } else if !has_conformal_marker {
                                plan.warnings.push(format!(
                                    "sharp parameter override for {:?} in region '{}' requires conformal boundary, but no domain marker was found in the mesh; projected approximation will be used",
                                    plan.parameter, region.region_id
                                ));
                            }
                        }
                    }
                }
            }
            let (values, fallback) = match plan.parameter {
                fullmag_ir::MaterialParameterNameIR::Ms => (
                    material.ms_field.as_deref(),
                    material.saturation_magnetisation,
                ),
                fullmag_ir::MaterialParameterNameIR::Aex => {
                    (material.a_field.as_deref(), material.exchange_stiffness)
                }
                fullmag_ir::MaterialParameterNameIR::Alpha => {
                    (material.alpha_field.as_deref(), material.damping)
                }
                _ => (None, 0.0),
            };
            let (sample_count, min, max, mean) = if let Some(values) = values {
                let min = values.iter().copied().fold(f64::INFINITY, f64::min);
                let max = values.iter().copied().fold(f64::NEG_INFINITY, f64::max);
                let mean = values.iter().sum::<f64>() / values.len() as f64;
                (values.len(), min, max, mean)
            } else {
                (node_count, fallback, fallback, fallback)
            };
            plan.realization_method = Some(
                if plan
                    .warnings
                    .iter()
                    .any(|warning| warning.contains("projected approximation"))
                {
                    "projected_nodal_sampling"
                } else if problem.object_regions.iter().any(|region| {
                    region.enabled
                        && region.owner_object == magnet.name
                        && region.realization_policy
                            == fullmag_ir::RegionRealizationPolicyIR::Conformal
                }) {
                    "conformal_domain_nodal_sampling"
                } else {
                    "nodal_sampling"
                }
                .to_string(),
            );
            plan.statistics = Some(fullmag_ir::MaterialFieldStatisticsIR {
                sample_count,
                min,
                max,
                mean,
            });
        }
        material_field_plans.extend(plans);
    }
    material_field_plans
}

pub(crate) fn plan_fem(
    problem: &ProblemIR,
    resolved_backend: BackendTarget,
) -> Result<ExecutionPlanIR, PlanError> {
    let mut errors = Vec::new();

    let fem_hints = match &problem.backend_policy.discretization_hints {
        Some(DiscretizationHintsIR { fem: Some(fem), .. }) => fem,
        _ => {
            errors.push(
                "FEM discretization hints (order + hmax) are required for backend='fem'"
                    .to_string(),
            );
            if !errors.is_empty() {
                return Err(PlanError { reasons: errors });
            }
            unreachable!();
        }
    };

    let geometry_by_name: BTreeMap<&str, &GeometryEntryIR> = problem
        .geometry
        .entries
        .iter()
        .map(|entry| (entry.name(), entry))
        .collect();
    let region_to_geometry: BTreeMap<&str, &str> = problem
        .regions
        .iter()
        .map(|region| (region.name.as_str(), region.geometry.as_str()))
        .collect();

    let resolved_domain_mesh_asset =
        resolve_fem_domain_mesh_asset(problem, true).map_err(|message| PlanError {
            reasons: vec![message],
        })?;
    let requested_demag_realization = requested_fem_demag_realization(problem);
    // Commit 4: fail early when study_universe requires a shared domain mesh
    // but no fem_domain_mesh_asset was provided.
    if resolved_domain_mesh_asset.is_none()
        && shared_domain_mesh_requested(problem, requested_demag_realization)
    {
        return Err(PlanError {
            reasons: vec![format!(
                "{} Shared-domain FEM mesh (fem_domain_mesh_asset) was not provided. \
                     Call study.build_domain_mesh() or study.domain_mesh(...) before solving.",
                FEM_AIRBOX_DEMAG_REQUIRED_MESSAGE
            )],
        });
    }
    if resolved_domain_mesh_asset.is_none()
        && problem
            .energy_terms
            .iter()
            .any(|term| matches!(term, EnergyTermIR::Demag { .. }))
        && requested_demag_realization.requires_airbox()
    {
        return Err(PlanError {
            reasons: vec![format!(
                "{} Missing shared-domain FEM mesh with air.",
                FEM_AIRBOX_DEMAG_REQUIRED_MESSAGE
            )],
        });
    }
    let mut merged_initial_magnetization = Vec::new();
    let mut mesh_parts = Vec::with_capacity(problem.magnets.len());
    let mut mesh_sources = Vec::with_capacity(problem.magnets.len());
    let mut selected_material: Option<fullmag_ir::MaterialIR> = None;
    let mut has_heterogeneous_materials = false;
    let mut magnet_materials = BTreeMap::<String, fullmag_ir::MaterialIR>::new();
    let mut magnet_entries = Vec::with_capacity(problem.magnets.len());

    for magnet in &problem.magnets {
        let Some(geometry_name) = region_to_geometry.get(magnet.region.as_str()).copied() else {
            errors.push(format!(
                "magnet '{}' references region '{}' with no geometry binding",
                magnet.name, magnet.region
            ));
            continue;
        };
        let Some(_geometry_entry) = geometry_by_name.get(geometry_name).copied() else {
            errors.push(format!(
                "magnet '{}' references geometry '{}' which is missing from geometry.entries",
                magnet.name, geometry_name
            ));
            continue;
        };
        let Some(material) = problem
            .materials
            .iter()
            .find(|candidate| candidate.name == magnet.material)
            .cloned()
        else {
            errors.push(format!(
                "magnet '{}' references missing material '{}'",
                magnet.name, magnet.material
            ));
            continue;
        };
        if let Some(reason) = validate_cubic_anisotropy_axes(&material) {
            errors.push(reason);
        }
        if let Some(reason) = validate_uniaxial_anisotropy_axis(&material) {
            errors.push(reason);
        }
        if let Some(reference_material) = selected_material.as_ref() {
            if !compatible_fem_material(reference_material, &material) {
                if !heterogeneous_fem_material_shape_supported(reference_material, &material) {
                    errors.push(format!(
                        "current multi-body FEM baseline requires shared anisotropy axes/material-law shape across magnets; '{}' is incompatible with '{}'",
                        magnet.name,
                        problem.magnets[0].name
                    ));
                } else {
                    has_heterogeneous_materials = true;
                    if should_promote_fem_material_template(reference_material, &material) {
                        selected_material = Some(material.clone());
                    }
                }
            }
        } else {
            selected_material = Some(material.clone());
        }
        magnet_materials.insert(magnet.name.clone(), material.clone());

        magnet_entries.push(MagnetPlanningEntry {
            magnet_name: magnet.name.clone(),
            geometry_name: geometry_name.to_string(),
            initial_magnetization: magnet.initial_magnetization.clone(),
        });

        if resolved_domain_mesh_asset.is_some() {
            continue;
        }

        let mesh_asset = problem
            .geometry_assets
            .as_ref()
            .and_then(|assets| {
                assets
                    .fem_mesh_assets
                    .iter()
                    .find(|asset| asset.geometry_name == geometry_name)
            })
            .cloned();

        let mesh_asset = match mesh_asset {
            Some(asset) => asset,
            None => {
                errors.push(format!(
                    "geometry '{}' requires a precomputed FEM mesh asset; no MeshIR was provided",
                    geometry_name
                ));
                continue;
            }
        };

        let mesh = match (&mesh_asset.mesh, &mesh_asset.mesh_source) {
            (Some(mesh), _) => mesh.clone(),
            (None, Some(source)) => match load_mesh_from_source(source) {
                Ok(mesh) => mesh,
                Err(message) => {
                    errors.push(message);
                    continue;
                }
            },
            (None, None) => {
                errors.push(format!(
                    "geometry '{}' requires a FEM mesh asset with inline mesh or mesh_source",
                    geometry_name
                ));
                continue;
            }
        };

        match initial_vectors_for_magnet(
            &magnet.name,
            &mesh.mesh_name,
            magnet.initial_magnetization.as_ref(),
            mesh.nodes.len(),
            Some(&mesh.nodes),
            Some(&mesh.nodes),
        ) {
            Ok(initial_magnetization) => merged_initial_magnetization.extend(initial_magnetization),
            Err(message) => errors.push(message),
        }
        mesh_parts.push((geometry_name.to_string(), mesh));
        mesh_sources.push(mesh_asset.mesh_source);
    }

    let mut enable_exchange = false;
    let mut enable_demag = false;
    let mut external_field = None;
    let mut demag_realization = fullmag_ir::RequestedFemDemagIR::Auto;
    let mut interfacial_dmi: Option<f64> = None;
    let mut interfacial_dmi_normal: Option<[f64; 3]> = None;
    let mut bulk_dmi: Option<f64> = None;
    let mut has_magnetoelastic = false;
    let mut has_thermal_noise = false;
    let mut thermal_seed_config = None;
    let mut thermal_temperature = problem.temperature;
    for term in &problem.energy_terms {
        match term {
            fullmag_ir::EnergyTermIR::Exchange => {
                if enable_exchange {
                    errors.push("Exchange is declared more than once".to_string());
                }
                enable_exchange = true;
            }
            fullmag_ir::EnergyTermIR::ThermalNoise { temperature, seed } => {
                if has_thermal_noise {
                    errors.push("ThermalNoise is declared more than once".to_string());
                }
                has_thermal_noise = true;
                if runtime_requests_cuda(problem) {
                    errors.push(
                        "strict FEM GPU ThermalNoise remains unsupported pending CAP-THERM-GPU-001"
                            .to_string(),
                    );
                }
                if let Some(problem_temperature) = thermal_temperature {
                    if (problem_temperature - *temperature).abs() > 1.0e-6 {
                        errors.push(
                            "ThermalNoise temperature disagrees with Problem temperature"
                                .to_string(),
                        );
                    }
                }
                thermal_temperature = Some(*temperature);
                if *seed == Some(0) {
                    errors.push("ThermalNoise seed must be positive; use system entropy for an unspecified seed".to_string());
                }
                thermal_seed_config = Some(ThermalSeedConfig {
                    policy: if seed.is_some() {
                        SeedPolicy::Fixed
                    } else {
                        SeedPolicy::SystemEntropy
                    },
                    seed: *seed,
                });
            }
            fullmag_ir::EnergyTermIR::Demag { realization } => {
                if enable_demag {
                    errors.push("Demag is declared more than once".to_string());
                }
                enable_demag = true;
                demag_realization = *realization;
            }
            fullmag_ir::EnergyTermIR::Zeeman { b } => {
                if external_field.is_some() {
                    errors.push("Zeeman is declared more than once".to_string());
                }
                external_field = Some([b[0] / MU0, b[1] / MU0, b[2] / MU0]);
            }
            fullmag_ir::EnergyTermIR::InterfacialDmi {
                d,
                interface_normal,
            } => {
                if interfacial_dmi.is_some() {
                    errors.push("InterfacialDmi is declared more than once".to_string());
                }
                interfacial_dmi = Some(*d);
                interfacial_dmi_normal = *interface_normal;
            }
            fullmag_ir::EnergyTermIR::BulkDmi { d } => {
                if bulk_dmi.is_some() {
                    errors.push("BulkDmi is declared more than once".to_string());
                }
                bulk_dmi = Some(*d);
            }
            fullmag_ir::EnergyTermIR::OerstedCylinder { .. }
            | fullmag_ir::EnergyTermIR::OerstedField { .. } => {
                // Oersted field: extracted separately below.
            }
            fullmag_ir::EnergyTermIR::Magnetoelastic { .. } => {
                if has_magnetoelastic {
                    errors.push("Magnetoelastic is declared more than once".to_string());
                }
                has_magnetoelastic = true;
            }
        }
    }
    if interfacial_dmi.is_some() {
        match resolve_interfacial_dmi_normal(interfacial_dmi_normal) {
            Ok(normal) => interfacial_dmi_normal = normal,
            Err(reason) => errors.push(reason),
        }
    } else {
        interfacial_dmi_normal = None;
    }
    let has_material_interfacial_dmi = problem.materials.iter().any(|material| {
        material.interfacial_dmi.is_some()
            || material
                .dind_field
                .as_ref()
                .is_some_and(|values: &Vec<f64>| !values.is_empty())
    });
    let has_material_bulk_dmi = problem.materials.iter().any(|material| {
        material.bulk_dmi.is_some()
            || material
                .dbulk_field
                .as_ref()
                .is_some_and(|values: &Vec<f64>| !values.is_empty())
    });
    if !(enable_exchange
        || enable_demag
        || external_field.is_some()
        || interfacial_dmi.is_some()
        || bulk_dmi.is_some()
        || has_material_interfacial_dmi
        || has_material_bulk_dmi
        || has_magnetoelastic)
    {
        errors.push(
            "the current FEM planning baseline requires at least one of Exchange, Demag, Zeeman, InterfacialDmi, BulkDmi, or Magnetoelastic"
                .to_string(),
        );
    }

    validate_executable_outputs(
        &problem.study.sampling().outputs,
        enable_exchange,
        enable_demag,
        external_field.is_some(),
        problem.energy_terms.iter().any(|term| {
            matches!(
                term,
                fullmag_ir::EnergyTermIR::OerstedCylinder { .. }
                    | fullmag_ir::EnergyTermIR::OerstedField { .. }
            )
        }),
        interfacial_dmi.is_some() || has_material_interfacial_dmi,
        bulk_dmi.is_some() || has_material_bulk_dmi,
        true,
        has_magnetoelastic,
        problem
            .energy_terms
            .iter()
            .any(|term| matches!(term, fullmag_ir::EnergyTermIR::ThermalNoise { .. })),
        has_mqs_antenna_field_source(problem) || has_prescribed_zeeman_mask_source(problem),
        !problem.field_drives.is_empty(),
        &mut errors,
    );
    if problem.backend_policy.execution_precision != ExecutionPrecision::Double {
        errors.push(fem_single_precision_rejection(
            runtime_requests_cuda(problem),
            "native FEM time-domain",
        ));
    }

    let controls = planned_study_controls(problem, resolved_backend, &mut errors);
    let requested_integrator = controls.requested_integrator;
    let integrator = controls.integrator;
    let fixed_timestep = controls.fixed_timestep;
    let gyromagnetic_ratio = controls.gyromagnetic_ratio;
    let relaxation = controls.relaxation;
    let adaptive_timestep = controls.adaptive_timestep;
    let field_refresh = controls.field_refresh;

    let requested_static_pbc = problem
        .pbc
        .as_ref()
        .is_some_and(|pbc| pbc.has_any_periodic());

    if !errors.is_empty() {
        return Err(PlanError { reasons: errors });
    }

    let requested_demag_solver_policy = fem_hints.demag_solver_policy.clone();
    let mut demag_solver_policy = requested_demag_solver_policy.clone();
    let mut direct_minimizer_demag_policy_note = None;
    if enable_demag
        && relaxation
            .as_ref()
            .is_some_and(|control| is_direct_relaxation_minimizer(control.algorithm))
    {
        let algorithm = relaxation
            .as_ref()
            .expect("checked direct-minimizer relaxation")
            .algorithm;
        match demag_solver_policy.as_mut() {
            Some(policy) if policy.rtol > FEM_DIRECT_MINIMIZER_DEMAG_RTOL_MAX => {
                return Err(PlanError {
                    reasons: vec![format!(
                        "FEM {} with demag requires demag_solver_policy.rtol <= 1e-12 for strict Armijo energy resolution; requested rtol={:.6e}",
                        algorithm.as_str(),
                        policy.rtol,
                    )],
                });
            }
            Some(policy) => {
                direct_minimizer_demag_policy_note = Some(format!(
                    "FEM direct-minimizer demag solver policy: algorithm={} requested_rtol={:.6e} resolved_rtol={:.6e}",
                    algorithm.as_str(),
                    policy.rtol,
                    policy.rtol,
                ));
            }
            None => {
                let mut policy = fullmag_ir::FemLinearSolverPolicy::default();
                policy.rtol = FEM_DIRECT_MINIMIZER_DEMAG_RTOL_MAX;
                direct_minimizer_demag_policy_note = Some(format!(
                    "FEM direct-minimizer demag solver policy: algorithm={} requested=default resolved_rtol={:.6e}",
                    algorithm.as_str(),
                    policy.rtol,
                ));
                demag_solver_policy = Some(policy);
            }
        }
    }

    let (magnetoelastic, mechanics) = resolve_fem_magnetoelastic_plan(problem)?
        .map(|(magnetoelastic, mechanics)| (Some(magnetoelastic), Some(mechanics)))
        .unwrap_or((None, None));
    let current_transports =
        resolve_current_transports(problem, CurrentTransportExecutableLane::Fem)?;
    let spin_torque =
        resolve_legacy_spin_torque(problem, SpinTorqueExecutableLane::Fem, &current_transports)?;

    let base_material =
        selected_material.expect("validation should have caught missing FEM material");
    let geometry_to_object_id = geometry_to_object_id_map(&magnet_entries);
    let (mesh, raw_object_segments, mesh_source, initial_magnetization) =
        if let Some(domain_asset) = resolved_domain_mesh_asset.as_ref() {
            let mut initial = vec![[0.0, 0.0, 0.0]; domain_asset.mesh.nodes.len()];
            for entry in &magnet_entries {
                let matching_segments = domain_asset
                    .object_segments
                    .iter()
                    .filter(|segment| segment_matches_magnet_entry(segment, entry))
                    .collect::<Vec<_>>();
                if matching_segments.is_empty() {
                    return Err(PlanError {
                        reasons: vec![format!(
                            "shared-domain FEM mesh asset is missing a segment for geometry '{}'",
                            entry.geometry_name
                        )],
                    });
                };
                assign_domain_initial_for_segments(
                    &mut initial,
                    &domain_asset.mesh,
                    &domain_asset.mesh_parts,
                    &matching_segments,
                    entry,
                )?;
            }
            (
                domain_asset.mesh.clone(),
                domain_asset.object_segments.clone(),
                domain_asset.mesh_source.clone(),
                initial,
            )
        } else {
            let (mesh, object_segments) =
                merge_fem_meshes(&mesh_parts).map_err(|message| PlanError {
                    reasons: vec![message],
                })?;
            let mesh_source = if mesh_parts.len() == 1 {
                mesh_sources.first().cloned().flatten()
            } else {
                None
            };
            (
                mesh,
                object_segments,
                mesh_source,
                merged_initial_magnetization,
            )
        };
    let object_segments = remap_segment_object_ids(&raw_object_segments, &geometry_to_object_id)?;
    let mesh_build_report = resolved_domain_mesh_asset
        .as_ref()
        .and_then(|asset| asset.build_report.clone());
    let n_nodes = mesh.nodes.len();
    let n_elements = mesh.elements.len();
    let mesh_name = mesh.mesh_name.clone();
    let domain_mesh_mode = resolved_domain_mesh_mode(&mesh);
    let mut periodic_mesh_certificate_v6 = None;
    if !requested_static_pbc && !mesh.periodic_node_pairs.is_empty() {
        return Err(PlanError {
            reasons: vec![
                "FEM static/time-domain mesh.periodic_node_pairs require ProblemIR.pbc to declare \
                 the physical PBC intent; mesh periodic-pair metadata is topology only and must not \
                 enable periodic physics implicitly."
                    .to_string(),
            ],
        });
    }
    if requested_static_pbc && mesh.periodic_node_pairs.is_empty() {
        return Err(PlanError {
            reasons: vec![
                "FEM static/time-domain PBC requires mesh.periodic_node_pairs metadata; provide a \
                 periodic FEM mesh or use the FEM eigen solver with spin_wave_bc='periodic'/'floquet'."
                    .to_string(),
            ],
        });
    }
    if requested_static_pbc {
        let requested_axes = requested_problem_pbc_axes(problem);
        let mesh_axes = periodic_boundary_axes(&mesh);
        if mesh_axes.is_empty() {
            return Err(PlanError {
                reasons: vec![format!(
                    "FEM static/time-domain PBC requires mesh periodic axes to be inferable from \
                     mesh.periodic_boundary_pairs axis_hint, pair_id, or translation; ProblemIR.pbc \
                     axes are {}.",
                    axis_set_label(&requested_axes)
                )],
            });
        }
        if mesh_axes != requested_axes {
            return Err(PlanError {
                reasons: vec![format!(
                    "FEM static/time-domain PBC mesh periodic axes ({}) must match ProblemIR.pbc \
                     axes ({}); mesh periodic-pair metadata is topology only and must not add or \
                     replace physical PBC axes.",
                    axis_set_label(&mesh_axes),
                    axis_set_label(&requested_axes)
                )],
            });
        }
    }
    if !mesh.periodic_node_pairs.is_empty() && enable_demag {
        if !problem
            .pbc
            .as_ref()
            .is_some_and(|pbc| pbc.demag == fullmag_ir::FdmDemagPeriodicityIR::PeriodicAirboxK0)
        {
            return Err(PlanError {
                reasons: vec![
                    "FEM static/time-domain demag PBC requires ProblemIR.pbc.demag='periodic_airbox_k0'; \
                     use study.pbc(..., demag='periodic_airbox_k0') so the dipolar boundary condition \
                     is explicit instead of relying on mesh metadata or an open demag contract."
                        .to_string(),
                ],
            });
        }
        if mesh.periodic_boundary_pairs.is_empty() {
            return Err(PlanError {
                reasons: vec![format!(
                    "FEM demag PBC requires mesh.periodic_boundary_pairs metadata (needed to \
                     identify open vs periodic seam faces for Robin boundary assembly); mesh '{}' \
                     has {} periodic_node_pairs but no periodic_boundary_pairs. Regenerate the \
                     mesh with periodic boundary pair metadata.",
                    mesh_name,
                    mesh.periodic_node_pairs.len()
                )],
            });
        }
        if periodic_boundary_axes(&mesh).len() >= 3 {
            return Err(PlanError {
                reasons: vec![
                    "fully periodic 3D FEM demag is not supported in the static/time-domain \
                     airbox slice; use at least one open axis with an explicit airbox boundary \
                     policy or disable periodic demag"
                        .to_string(),
                ],
            });
        }
        periodic_mesh_certificate_v6 = Some(mesh.periodic_mesh_certificate_v6().map_err(
            |certificate_errors| {
                PlanError {
                    reasons: certificate_errors
                        .into_iter()
                        .map(|reason| format!("FEM periodic mesh certificate v6: {reason}"))
                        .collect(),
                }
            },
        )?);
        // Demag PBC with open boundary: allowed (P^T A P reduction via Rust reference path).
        // Fully 3D periodic demag is not supported in v1.
    }
    if shared_domain_mesh_requested(problem, demag_realization)
        && domain_mesh_mode != fullmag_ir::FemDomainMeshModeIR::SharedDomainMeshWithAir
    {
        return Err(PlanError {
            reasons: vec![format!(
                "{} Shared-domain FEM was requested, but the resolved final FEM mesh has no air region. Materialize a conformal domain mesh with air via study.build_domain_mesh() / study.domain_mesh(...).",
                FEM_AIRBOX_DEMAG_REQUIRED_MESSAGE
            )],
        });
    }
    let mut resolved_mesh_parts = if let Some(domain_asset) = resolved_domain_mesh_asset.as_ref() {
        let mut parts = domain_asset.mesh_parts.clone();
        // Remap geometry-name object_ids to magnet/object-name object_ids so that
        // the frontend can match them against the selected object id (e.g. "nanoflower_left"
        // instead of "nanoflower_left_geom").
        for part in &mut parts {
            if let Some(ref geo_id) = part.object_id.clone() {
                let mut mapped = geometry_to_object_id.get(geo_id.as_str()).copied();
                if mapped.is_none() && geo_id.ends_with("_geom") {
                    mapped = geometry_to_object_id
                        .get(&geo_id[..geo_id.len() - 5])
                        .copied();
                }
                if let Some(mapped) = mapped {
                    part.object_id = Some(mapped.to_string());
                }
            }
        }
        parts
    } else {
        build_mesh_parts_from_segments(&mesh, &object_segments, domain_mesh_mode)
    };
    assign_material_ids_to_mesh_parts(&mut resolved_mesh_parts, &magnet_entries, &magnet_materials);
    // Populate region_materials whenever multiple magnetic bodies are present (not only for
    // heterogeneous materials), because the runner uses region_materials to resolve which
    // element markers are magnetic vs. air when multiple non-zero markers exist.
    let needs_region_materials = has_heterogeneous_materials || magnet_entries.len() > 1;
    let region_materials = if needs_region_materials {
        build_region_materials(&mesh, &object_segments, &magnet_materials)
    } else {
        Vec::new()
    };

    let (material, anisotropy_axis_field) = build_region_material_fields(
        problem,
        &base_material,
        &mesh,
        &object_segments,
        &resolved_mesh_parts,
        &magnet_materials,
    )?;
    let (ms_element_field, a_element_field) = build_conformal_region_element_fields(
        problem,
        &base_material,
        &mesh,
        &object_segments,
        &magnet_materials,
    )?;
    if let Some(reason) =
        exclusive_coefficient_realization_error(&material, &ms_element_field, &a_element_field)
    {
        return Err(PlanError {
            reasons: vec![reason],
        });
    }
    let requires_consistent_mass_exchange = ms_element_field.is_some();

    if periodic_mesh_certificate_v6.is_some() {
        periodic_mesh_certificate_v6 = Some(
            mesh.periodic_mesh_certificate_v6_with_material_and_nodal_fields(
                ms_element_field.as_deref(),
                a_element_field.as_deref(),
                material.ms_field.as_deref(),
                material.a_field.as_deref(),
            )
            .map(|certificate| {
                fullmag_ir::MeshIR::periodic_certificate_with_region_identity(
                    certificate,
                    &problem.object_regions,
                )
            })
            .map_err(|certificate_errors| PlanError {
                reasons: certificate_errors
                    .into_iter()
                    .map(|reason| format!("FEM periodic region/material certificate v6: {reason}"))
                    .collect(),
            })?,
        );
    }

    if interfacial_dmi.is_none() {
        interfacial_dmi = material.interfacial_dmi;
    }
    if bulk_dmi.is_none() {
        bulk_dmi = material.bulk_dmi;
    }
    if interfacial_dmi.is_some()
        || material
            .dind_field
            .as_ref()
            .is_some_and(|values| !values.is_empty())
    {
        match resolve_interfacial_dmi_normal(interfacial_dmi_normal) {
            Ok(normal) => interfacial_dmi_normal = normal,
            Err(reason) => {
                return Err(PlanError {
                    reasons: vec![reason],
                });
            }
        }
    }
    let domain_frame = problem_domain_frame(problem)
        .map(|frame| frame.with_mesh_bounds(mesh_bounds(&mesh)))
        .and_then(DomainFrameIR::finalized);

    // S07: Auto-resolve demag realization.
    // Phase-1A: normalize legacy variants and reject unimplemented models.
    let demag_realization = demag_realization.normalized();
    if !demag_realization.is_implemented() {
        return Err(PlanError {
            reasons: vec![format!(
                "Demag model '{}' is not yet implemented. Currently supported: airbox and fredkin_koehler.",
                demag_realization.model_name(),
            )],
        });
    }

    let resolved_demag_realization: Option<fullmag_ir::ResolvedFemDemagIR> = if enable_demag {
        let has_air_elements = mesh.element_markers.iter().any(|&m| m == 0);
        if demag_realization.requires_airbox() && !has_air_elements {
            return Err(PlanError {
                reasons: vec![format!(
                    "{} The resolved FEM mesh has no air elements.",
                    FEM_AIRBOX_DEMAG_REQUIRED_MESSAGE
                )],
            });
        }
        Some(match demag_realization {
            fullmag_ir::RequestedFemDemagIR::PoissonDirichlet => {
                fullmag_ir::ResolvedFemDemagIR::PoissonDirichlet
            }
            fullmag_ir::RequestedFemDemagIR::PoissonRobin => {
                fullmag_ir::ResolvedFemDemagIR::PoissonRobin
            }
            fullmag_ir::RequestedFemDemagIR::Auto => fullmag_ir::ResolvedFemDemagIR::PoissonRobin,
            // Unimplemented models are already rejected above.
            fullmag_ir::RequestedFemDemagIR::Bem => fullmag_ir::ResolvedFemDemagIR::Bem,
            fullmag_ir::RequestedFemDemagIR::FredkinKoehler => {
                fullmag_ir::ResolvedFemDemagIR::FredkinKoehler
            }
            fullmag_ir::RequestedFemDemagIR::Fmm => fullmag_ir::ResolvedFemDemagIR::Fmm,
        })
    } else {
        None
    };
    let air_box_config =
        build_air_box_config(problem, &mesh, resolved_demag_realization).map_err(|reason| {
            PlanError {
                reasons: vec![reason],
            }
        })?;
    let universe_note = study_universe_planner_note(
        problem,
        &mesh,
        resolved_demag_realization,
        air_box_config.as_ref(),
    );

    // Phase-0C: enforce P1-only constraint.
    // The native FEM backend currently supports only first-order (P1) H1
    // finite elements (it asserts GetNDofs() == n_nodes).  Reject higher
    // orders at the planner level with a clear error.
    if fem_hints.order != 1 {
        return Err(PlanError {
            reasons: vec![format!(
                "FEM backend currently supports only first-order (P1) elements \
                 (fe_order = 1). Requested fe_order = {}. Higher-order support is \
                 planned but not yet implemented.",
                fem_hints.order,
            )],
        });
    }

    let dind_field = material.dind_field.clone();
    let dbulk_field = material.dbulk_field.clone();
    let antenna_zeeman_masks = resolve_prescribed_zeeman_masks(problem, &mesh.nodes, None)?;
    let active_field_drives: Vec<_> = problem
        .field_drives
        .iter()
        .filter(|drive| crate::util::field_drive_is_active(drive, problem))
        .cloned()
        .collect();
    let field_drive_geometry_masks = active_field_drives
        .iter()
        .filter_map(|drive| {
            let fullmag_ir::FieldSpatialProfileIR::GeometryMask { object_id, .. } =
                &drive.spatial_profile
            else {
                return None;
            };
            problem
                .geometry
                .entries
                .iter()
                .find(|entry| entry.name() == object_id)
                .cloned()
        })
        .collect();

    let mut fem_plan = FemPlanIR {
        mesh_name: mesh_name.clone(),
        mesh_source,
        mesh,
        object_segments,
        mesh_parts: resolved_mesh_parts,
        mesh_build_report,
        domain_mesh_mode,
        domain_frame,
        fe_order: fem_hints.order,
        hmax: fem_hints.hmax,
        initial_magnetization,
        material,
        anisotropy_axis_field,
        ms_element_field,
        a_element_field,
        region_materials,
        enable_exchange,
        enable_demag,
        external_field,
        antenna_zeeman_masks,
        field_drives: active_field_drives,
        field_drive_geometry_masks,
        time_stage: crate::util::time_stage_context(problem),
        current_modules: problem.current_modules.clone(),
        gyromagnetic_ratio,
        precision: problem.backend_policy.execution_precision,
        exchange_bc: ExchangeBoundaryCondition::Neumann,
        integrator,
        fixed_timestep,
        adaptive_timestep,
        field_refresh,
        relaxation,
        demag_realization: resolved_demag_realization,
        air_box_config,
        interfacial_dmi,
        dmi_interface_normal: interfacial_dmi_normal,
        bulk_dmi,
        dind_field,
        dbulk_field,
        temperature: thermal_temperature,
        current_density: spin_torque.current_density,
        stt_degree: spin_torque.stt_degree,
        stt_beta: spin_torque.stt_beta,
        stt_spin_polarization: spin_torque.stt_spin_polarization,
        stt_lambda: spin_torque.stt_lambda,
        stt_epsilon_prime: spin_torque.stt_epsilon_prime,
        stt_thickness: spin_torque.stt_thickness,
        stt_fixed_layer_position: spin_torque.stt_fixed_layer_position.clone(),
        has_oersted_cylinder: false,
        oersted_current: None,
        oersted_radius: None,
        oersted_center: None,
        oersted_axis: None,
        oersted_field_xyz: None,
        oersted_time_dep_kind: 0,
        oersted_time_dep_freq: 0.0,
        oersted_time_dep_phase: 0.0,
        oersted_time_dep_offset: 0.0,
        oersted_time_dep_t_on: 0.0,
        oersted_time_dep_t_off: 0.0,
        magnetoelastic,
        mechanics,
        demag_solver_policy,
        thermal_seed_config,
        oersted_realization: None,
        gpu_device_index: None,
        mfem_device_string: None,
        use_consistent_mass: if requires_consistent_mass_exchange {
            Some(true)
        } else {
            None
        },
    };

    // ── Extract Oersted realizations from energy terms ──
    for (term_index, term) in problem.energy_terms.iter().enumerate() {
        if let Some(oersted) = resolve_fem_oersted_term(
            problem,
            term_index,
            term,
            &current_transports,
            &fem_plan.mesh,
            &fem_plan.object_segments,
            &fem_plan.mesh_parts,
        )? {
            match oersted {
                ResolvedOerstedTerm::Cylinder(oersted) => {
                    fem_plan.has_oersted_cylinder = true;
                    fem_plan.oersted_current = Some(oersted.current);
                    fem_plan.oersted_radius = Some(oersted.radius);
                    fem_plan.oersted_center = Some(oersted.center);
                    fem_plan.oersted_axis = Some(oersted.axis);
                    fem_plan.oersted_realization =
                        Some(fullmag_ir::OerstedRealization::InfiniteCylinder);
                    if let Some(td) = &oersted.time_dependence {
                        match td {
                            TimeDependenceIR::Constant => {
                                fem_plan.oersted_time_dep_kind = 0;
                            }
                            TimeDependenceIR::Sinusoidal {
                                frequency_hz,
                                phase_rad,
                                offset,
                            } => {
                                fem_plan.oersted_time_dep_kind = 1;
                                fem_plan.oersted_time_dep_freq = *frequency_hz;
                                fem_plan.oersted_time_dep_phase = *phase_rad;
                                fem_plan.oersted_time_dep_offset = *offset;
                            }
                            TimeDependenceIR::Pulse { t_on, t_off } => {
                                fem_plan.oersted_time_dep_kind = 2;
                                fem_plan.oersted_time_dep_t_on = *t_on;
                                fem_plan.oersted_time_dep_t_off = *t_off;
                            }
                            TimeDependenceIR::PiecewiseLinear { .. }
                            | TimeDependenceIR::SincPulse { .. } => {
                                return Err(PlanError {
                                    reasons: vec![
                                        "Oersted time dependence supports only 'Constant', 'Sinusoidal', or 'Pulse' on the FEM backend; use prescribed_zeeman_mask antenna sources for sinc-pulse spin-wave drives"
                                            .to_string(),
                                    ],
                                });
                            }
                        }
                    }
                }
                ResolvedOerstedTerm::Field(field) => {
                    fem_plan.oersted_field_xyz = Some(field.field_xyz);
                    fem_plan.oersted_realization =
                        Some(fullmag_ir::OerstedRealization::BiotSavartMidpoint);
                }
            }
            break;
        }
    }

    if let Some(reason) =
        elementwise_material_legality_error(&fem_plan, runtime_requests_cuda(problem))
    {
        return Err(PlanError {
            reasons: vec![reason],
        });
    }

    let study_note = if let Some(control) = fem_plan.relaxation.as_ref() {
        format!(
            "study: relaxation algorithm={} torque_tolerance={} energy_tolerance={} max_steps={}",
            control.algorithm.as_str(),
            control
                .stop
                .torque_tolerance_apm
                .map(|value| format!("{value:.6e}"))
                .unwrap_or_else(|| "none".to_string()),
            control
                .stop
                .energy_tolerance_j
                .map(|value| format!("{value:.6e}"))
                .unwrap_or_else(|| "none".to_string()),
            control
                .stop
                .max_steps
                .map(|value| value.to_string())
                .unwrap_or_else(|| "none".to_string())
        )
    } else {
        "study: time_evolution".to_string()
    };
    let mut provenance_notes = vec![
        if resolved_domain_mesh_asset.is_some() {
            "Bootstrap FEM planner using study-level shared-domain mesh asset".to_string()
        } else if mesh_parts.len() == 1 {
            "Bootstrap FEM planner with precomputed MeshIR asset".to_string()
        } else {
            format!(
                "Bootstrap multi-body FEM planner merged {} disjoint mesh assets into one FEM plan",
                mesh_parts.len()
            )
        },
        format!("mesh asset: {mesh_name} ({n_nodes} nodes, {n_elements} elements)"),
        format!(
            "active terms: exchange={}, demag={}, zeeman={}",
            enable_exchange,
            enable_demag,
            external_field.is_some()
        ),
        study_note,
        "Executable time-domain FEM requires the native MFEM/libCEED/hypre backend; the Rust FEM baseline remains internal-only for preview and validation helpers"
            .to_string(),
    ];
    if let Some(certificate) = periodic_mesh_certificate_v6.as_ref() {
        provenance_notes.push(format!(
            "periodic mesh certificate: schema={} topology={} marker_map={} material_realization={} region_classes={} max_material_residual={:.6e} magnetic_classes={} scalar_classes={} translation_residual_max_m={:.6e} normal_mismatch_max={:.6e}",
            certificate.schema_version,
            certificate.topology_fingerprint,
            certificate.marker_map_fingerprint,
            certificate.material_realization_fingerprint,
            certificate.region_class_count,
            certificate.max_material_residual,
            certificate.magnetic_class_count,
            certificate.scalar_class_count,
            certificate.translation_residual_max_m,
            certificate.normal_mismatch_max,
        ));
    }
    if fem_plan.relaxation.as_ref().is_some_and(|control| {
        control.algorithm == fullmag_ir::RelaxationAlgorithmIR::TangentPlaneImplicit
    }) {
        provenance_notes.push(
            "tangent_plane_implicit resolved to the CPU/MFEM development lane; this fallback is not production-qualified"
                .to_string(),
        );
    }
    if let Some(note) = direct_minimizer_demag_policy_note {
        provenance_notes.push(note);
    }
    if let Some(note) = universe_note {
        provenance_notes.push(note);
    }
    let material_field_plans =
        gather_fem_material_field_plans(problem, &fem_plan.material, n_nodes);
    for field_plan in &material_field_plans {
        if let Some(statistics) = &field_plan.statistics {
            provenance_notes.push(format!(
                "material field {:?} on '{}': method={} samples={} min={:.6e} max={:.6e} mean={:.6e}",
                field_plan.parameter,
                field_plan.object_id,
                field_plan.realization_method.as_deref().unwrap_or("unknown"),
                statistics.sample_count,
                statistics.min,
                statistics.max,
                statistics.mean,
            ));
        }
        provenance_notes.extend(field_plan.warnings.iter().cloned());
    }

    Ok(ExecutionPlanIR {
        common: CommonPlanMeta {
            ir_version: IR_VERSION.to_string(),
            requested_backend: problem.backend_policy.requested_backend,
            resolved_backend,
            execution_mode: problem.validation_profile.execution_mode,
            material_field_plans,
        },
        backend_plan: BackendPlanIR::Fem(fem_plan),
        output_plan: OutputPlanIR {
            outputs: problem.study.sampling().outputs.clone(),
        },
        provenance: ProvenancePlanIR {
            notes: provenance_notes,
            integrator_resolution: requested_integrator.map(|requested_integrator| {
                fullmag_ir::IntegratorResolutionProvenanceIR {
                    requested_integrator: Some(requested_integrator),
                    resolved_integrator: integrator,
                }
            }),
        },
    })
}

pub(crate) fn plan_fem_eigen(
    problem: &ProblemIR,
    resolved_backend: BackendTarget,
) -> Result<ExecutionPlanIR, PlanError> {
    let mut errors = Vec::new();

    let fem_hints = match &problem.backend_policy.discretization_hints {
        Some(DiscretizationHintsIR { fem: Some(fem), .. }) => fem,
        _ => {
            return Err(PlanError {
                reasons: vec![
                    "FEM discretization hints (order + hmax) are required for backend='fem'"
                        .to_string(),
                ],
            });
        }
    };

    let fullmag_ir::StudyIR::Eigenmodes {
        dynamics,
        operator,
        count,
        target,
        equilibrium,
        k_sampling,
        normalization,
        damping_policy,
        spin_wave_bc,
        mode_tracking,
        ..
    } = &problem.study
    else {
        unreachable!("plan_fem_eigen is only called for StudyIR::Eigenmodes");
    };

    let geometry_by_name: BTreeMap<&str, &GeometryEntryIR> = problem
        .geometry
        .entries
        .iter()
        .map(|entry| (entry.name(), entry))
        .collect();
    let region_to_geometry: BTreeMap<&str, &str> = problem
        .regions
        .iter()
        .map(|region| (region.name.as_str(), region.geometry.as_str()))
        .collect();

    let resolved_domain_mesh_asset =
        resolve_fem_domain_mesh_asset(problem, true).map_err(|message| PlanError {
            reasons: vec![message],
        })?;
    let requested_demag_realization = requested_fem_demag_realization(problem);
    // Commit 4: fail early when study_universe requires a shared domain mesh
    // but no fem_domain_mesh_asset was provided (eigen path).
    if resolved_domain_mesh_asset.is_none()
        && shared_domain_mesh_requested(problem, requested_demag_realization)
    {
        return Err(PlanError {
            reasons: vec![format!(
                "{} Shared-domain FEM mesh (fem_domain_mesh_asset) was not provided. \
                     Call study.build_domain_mesh() or study.domain_mesh(...) before solving.",
                FEM_AIRBOX_DEMAG_REQUIRED_MESSAGE
            )],
        });
    }
    if resolved_domain_mesh_asset.is_none()
        && problem
            .energy_terms
            .iter()
            .any(|term| matches!(term, EnergyTermIR::Demag { .. }))
        && requested_demag_realization.requires_airbox()
    {
        return Err(PlanError {
            reasons: vec![format!(
                "{} Missing shared-domain FEM mesh with air.",
                FEM_AIRBOX_DEMAG_REQUIRED_MESSAGE
            )],
        });
    }
    let mut merged_equilibrium = Vec::new();
    let mut mesh_parts = Vec::with_capacity(problem.magnets.len());
    let mut mesh_sources = Vec::with_capacity(problem.magnets.len());
    let mut selected_material: Option<fullmag_ir::MaterialIR> = None;
    let mut magnet_entries = Vec::with_capacity(problem.magnets.len());

    for magnet in &problem.magnets {
        let Some(geometry_name) = region_to_geometry.get(magnet.region.as_str()).copied() else {
            errors.push(format!(
                "magnet '{}' references region '{}' with no geometry binding",
                magnet.name, magnet.region
            ));
            continue;
        };
        let Some(_geometry_entry) = geometry_by_name.get(geometry_name).copied() else {
            errors.push(format!(
                "magnet '{}' references geometry '{}' which is missing from geometry.entries",
                magnet.name, geometry_name
            ));
            continue;
        };
        let Some(material) = problem
            .materials
            .iter()
            .find(|candidate| candidate.name == magnet.material)
            .cloned()
        else {
            errors.push(format!(
                "magnet '{}' references missing material '{}'",
                magnet.name, magnet.material
            ));
            continue;
        };
        if let Some(reference_material) = selected_material.as_ref() {
            if !compatible_fem_material(reference_material, &material) {
                errors.push(format!(
                    "current multi-body FEM eigen baseline requires identical material law across magnets; '{}' is incompatible with '{}'",
                    magnet.name,
                    problem.magnets[0].name
                ));
            }
        } else {
            selected_material = Some(material.clone());
        }

        magnet_entries.push(MagnetPlanningEntry {
            magnet_name: magnet.name.clone(),
            geometry_name: geometry_name.to_string(),
            initial_magnetization: magnet.initial_magnetization.clone(),
        });

        if resolved_domain_mesh_asset.is_some() {
            continue;
        }

        let mesh_asset = problem
            .geometry_assets
            .as_ref()
            .and_then(|assets| {
                assets
                    .fem_mesh_assets
                    .iter()
                    .find(|asset| asset.geometry_name == geometry_name)
            })
            .cloned();

        let mesh_asset = match mesh_asset {
            Some(asset) => asset,
            None => {
                errors.push(format!(
                    "geometry '{}' requires a precomputed FEM mesh asset; no MeshIR was provided",
                    geometry_name
                ));
                continue;
            }
        };

        let mesh = match (&mesh_asset.mesh, &mesh_asset.mesh_source) {
            (Some(mesh), _) => mesh.clone(),
            (None, Some(source)) => match load_mesh_from_source(source) {
                Ok(mesh) => mesh,
                Err(message) => {
                    errors.push(message);
                    continue;
                }
            },
            (None, None) => {
                errors.push(format!(
                    "geometry '{}' requires a FEM mesh asset with inline mesh or mesh_source",
                    geometry_name
                ));
                continue;
            }
        };

        match initial_vectors_for_magnet(
            &magnet.name,
            &mesh.mesh_name,
            magnet.initial_magnetization.as_ref(),
            mesh.nodes.len(),
            Some(&mesh.nodes),
            Some(&mesh.nodes),
        ) {
            Ok(values) => merged_equilibrium.extend(values),
            Err(message) => errors.push(message),
        }
        mesh_parts.push((geometry_name.to_string(), mesh));
        mesh_sources.push(mesh_asset.mesh_source);
    }

    let mut enable_exchange = false;
    let mut enable_demag = false;
    let mut external_field = None;
    let mut demag_realization = fullmag_ir::RequestedFemDemagIR::Auto;
    let mut interfacial_dmi: Option<f64> = None;
    let mut interfacial_dmi_normal: Option<[f64; 3]> = None;
    let mut bulk_dmi: Option<f64> = None;
    for term in &problem.energy_terms {
        match term {
            fullmag_ir::EnergyTermIR::Exchange => {
                if enable_exchange {
                    errors.push("Exchange is declared more than once".to_string());
                }
                enable_exchange = true;
            }
            fullmag_ir::EnergyTermIR::Demag { realization } => {
                if enable_demag {
                    errors.push("Demag is declared more than once".to_string());
                }
                enable_demag = true;
                demag_realization = *realization;
            }
            fullmag_ir::EnergyTermIR::Zeeman { b } => {
                if external_field.is_some() {
                    errors.push("Zeeman is declared more than once".to_string());
                }
                external_field = Some([b[0] / MU0, b[1] / MU0, b[2] / MU0]);
            }
            fullmag_ir::EnergyTermIR::InterfacialDmi {
                d,
                interface_normal,
            } => {
                if interfacial_dmi.is_some() {
                    errors.push("InterfacialDmi is declared more than once".to_string());
                }
                interfacial_dmi = Some(*d);
                interfacial_dmi_normal = *interface_normal;
            }
            fullmag_ir::EnergyTermIR::BulkDmi { d } => {
                if bulk_dmi.is_some() {
                    errors.push("BulkDmi is declared more than once".to_string());
                }
                bulk_dmi = Some(*d);
            }
            other => {
                errors.push(format!(
                    "energy term '{:?}' is not yet executable in the FEM eigen baseline",
                    other
                ));
            }
        }
    }
    if interfacial_dmi.is_some() {
        match resolve_interfacial_dmi_normal(interfacial_dmi_normal) {
            Ok(normal) => interfacial_dmi_normal = normal,
            Err(reason) => errors.push(reason),
        }
    } else {
        interfacial_dmi_normal = None;
    }
    if !(enable_exchange
        || enable_demag
        || external_field.is_some()
        || interfacial_dmi.is_some()
        || bulk_dmi.is_some())
    {
        errors.push(
            "the current FEM eigen baseline requires at least one of Exchange, Demag, Zeeman, InterfacialDmi, or BulkDmi"
                .to_string(),
        );
    }
    if operator.include_demag && !enable_demag {
        errors.push(
            "eigen operator requested include_demag=true but the problem does not declare Demag()"
                .to_string(),
        );
    }
    let dispersion_validation = match eigen_dispersion_validation(problem) {
        Ok(validation) => validation,
        Err(error) => {
            errors.extend(error.reasons);
            None
        }
    };
    let k0_kittel_validation = match eigen_k0_kittel_validation(problem) {
        Ok(validation) => validation,
        Err(error) => {
            errors.extend(error.reasons);
            None
        }
    };
    if operator.include_demag
        && matches!(
            spin_wave_bc.kind(),
            fullmag_ir::SpinWaveBoundaryKindIR::Floquet
        )
        && !allows_low_k_de_bv_analytic_reference(&dispersion_validation)
        && !allows_k0_kittel_synthetic_demag_factor(&k0_kittel_validation, &k_sampling)
    {
        errors.push(
            "dynamic demag for Floquet periodic FEM is not implemented yet. Disable demag or use k=0/free boundary."
                .to_string(),
        );
    }
    match spin_wave_bc.kind() {
        fullmag_ir::SpinWaveBoundaryKindIR::Periodic => {
            let requested_pair_ids = spin_wave_bc.boundary_pair_ids();
            let has_pairs = if requested_pair_ids.is_empty() {
                if let Some(domain_asset) = resolved_domain_mesh_asset.as_ref() {
                    !domain_asset.mesh.periodic_node_pairs.is_empty()
                } else {
                    mesh_parts
                        .iter()
                        .any(|(_, mesh)| !mesh.periodic_node_pairs.is_empty())
                }
            } else {
                requested_pair_ids.iter().all(|pair_id| {
                    mesh_parts.iter().any(|(_, mesh)| {
                        mesh.periodic_node_pairs
                            .iter()
                            .any(|pair| pair.pair_id == *pair_id)
                    }) || resolved_domain_mesh_asset
                        .as_ref()
                        .is_some_and(|domain_asset| {
                            domain_asset
                                .mesh
                                .periodic_node_pairs
                                .iter()
                                .any(|pair| pair.pair_id == *pair_id)
                        })
                })
            };
            if !has_pairs {
                errors.push(
                    "spin_wave_bc.kind='periodic' requires mesh.periodic_node_pairs metadata"
                        .to_string(),
                );
            }
        }
        fullmag_ir::SpinWaveBoundaryKindIR::Floquet => {
            let requested_pair_ids = spin_wave_bc.boundary_pair_ids();
            let has_pairs = if requested_pair_ids.is_empty() {
                if let Some(domain_asset) = resolved_domain_mesh_asset.as_ref() {
                    !domain_asset.mesh.periodic_node_pairs.is_empty()
                } else {
                    mesh_parts
                        .iter()
                        .any(|(_, mesh)| !mesh.periodic_node_pairs.is_empty())
                }
            } else {
                requested_pair_ids.iter().all(|pair_id| {
                    mesh_parts.iter().any(|(_, mesh)| {
                        mesh.periodic_node_pairs
                            .iter()
                            .any(|pair| pair.pair_id == *pair_id)
                    }) || resolved_domain_mesh_asset
                        .as_ref()
                        .is_some_and(|domain_asset| {
                            domain_asset
                                .mesh
                                .periodic_node_pairs
                                .iter()
                                .any(|pair| pair.pair_id == *pair_id)
                        })
                })
            };
            if !has_pairs {
                errors.push(
                    "spin_wave_bc.kind='floquet' requires mesh.periodic_node_pairs metadata"
                        .to_string(),
                );
            }
            if !matches!(
                k_sampling,
                Some(fullmag_ir::KSamplingIR::Single { .. })
                    | Some(fullmag_ir::KSamplingIR::Path { .. })
            ) {
                errors.push(
                    "spin_wave_bc.kind='floquet' requires k_sampling=Single{ k_vector = [...] }"
                        .to_string(),
                );
            }
        }
        fullmag_ir::SpinWaveBoundaryKindIR::SurfaceAnisotropy => {
            if spin_wave_bc
                .surface_anisotropy_ks()
                .is_none_or(|ks| !ks.is_finite() || ks <= 0.0)
            {
                errors.push(
                    "spin_wave_bc.kind='surface_anisotropy' requires surface_anisotropy_ks > 0"
                        .to_string(),
                );
            }
            if spin_wave_bc
                .surface_anisotropy_axis()
                .is_none_or(|axis| axis.iter().all(|component| component.abs() <= 1e-30))
            {
                errors.push(
                    "spin_wave_bc.kind='surface_anisotropy' requires a non-zero surface_anisotropy_axis"
                        .to_string(),
                );
            }
            if mesh_parts.iter().any(|(_, mesh)| {
                mesh.element_markers.iter().any(|&marker| marker == 0)
                    && mesh.element_markers.iter().any(|&marker| marker != 0)
            }) || resolved_domain_mesh_asset.as_ref().is_some_and(|domain| {
                domain
                    .mesh
                    .element_markers
                    .iter()
                    .any(|&marker| marker == 0)
                    && domain
                        .mesh
                        .element_markers
                        .iter()
                        .any(|&marker| marker != 0)
            }) {
                errors.push(
                    "spin_wave_bc.kind='surface_anisotropy' currently requires a standalone magnetic mesh; shared-domain airbox meshes do not yet expose magnetic interface faces"
                        .to_string(),
                );
            }
        }
        _ => {}
    }

    validate_eigen_outputs(&problem.study.sampling().outputs, &mut errors);
    if problem.backend_policy.execution_precision != ExecutionPrecision::Double {
        errors.push(fem_single_precision_rejection(
            runtime_requests_cuda(problem),
            "FEM eigen",
        ));
    }

    let gyromagnetic_ratio = match dynamics {
        fullmag_ir::DynamicsIR::Llg {
            gyromagnetic_ratio, ..
        } => *gyromagnetic_ratio,
    };

    if !errors.is_empty() {
        return Err(PlanError { reasons: errors });
    }

    let material =
        selected_material.expect("validation should have caught missing FEM eigen material");
    let geometry_to_object_id = geometry_to_object_id_map(&magnet_entries);
    let (mesh, raw_object_segments, mesh_source, equilibrium_magnetization) =
        if let Some(domain_asset) = resolved_domain_mesh_asset.as_ref() {
            let mut equilibrium = vec![[0.0, 0.0, 0.0]; domain_asset.mesh.nodes.len()];
            for entry in &magnet_entries {
                let matching_segments = domain_asset
                    .object_segments
                    .iter()
                    .filter(|segment| segment_matches_magnet_entry(segment, entry))
                    .collect::<Vec<_>>();
                if matching_segments.is_empty() {
                    return Err(PlanError {
                        reasons: vec![format!(
                            "shared-domain FEM mesh asset is missing a segment for geometry '{}'",
                            entry.geometry_name
                        )],
                    });
                };
                assign_domain_initial_for_segments(
                    &mut equilibrium,
                    &domain_asset.mesh,
                    &domain_asset.mesh_parts,
                    &matching_segments,
                    entry,
                )?;
            }
            (
                domain_asset.mesh.clone(),
                domain_asset.object_segments.clone(),
                domain_asset.mesh_source.clone(),
                equilibrium,
            )
        } else {
            let (mesh, object_segments) =
                merge_fem_meshes(&mesh_parts).map_err(|message| PlanError {
                    reasons: vec![message],
                })?;
            let mesh_source = if mesh_parts.len() == 1 {
                mesh_sources.first().cloned().flatten()
            } else {
                None
            };
            (mesh, object_segments, mesh_source, merged_equilibrium)
        };
    let object_segments = remap_segment_object_ids(&raw_object_segments, &geometry_to_object_id)?;
    let mesh_build_report = resolved_domain_mesh_asset
        .as_ref()
        .and_then(|asset| asset.build_report.clone());
    let mesh_name = mesh.mesh_name.clone();
    let n_nodes = mesh.nodes.len();
    let n_elements = mesh.elements.len();
    let domain_mesh_mode = resolved_domain_mesh_mode(&mesh);
    if shared_domain_mesh_requested(problem, demag_realization)
        && domain_mesh_mode != fullmag_ir::FemDomainMeshModeIR::SharedDomainMeshWithAir
    {
        return Err(PlanError {
            reasons: vec![format!(
                "{} Shared-domain FEM was requested, but the resolved final FEM mesh has no air region. Attach a conformal shared-domain mesh asset.",
                FEM_AIRBOX_DEMAG_REQUIRED_MESSAGE
            )],
        });
    }
    let mut resolved_mesh_parts = if let Some(domain_asset) = resolved_domain_mesh_asset.as_ref() {
        domain_asset.mesh_parts.clone()
    } else {
        build_mesh_parts_from_segments(&mesh, &object_segments, domain_mesh_mode)
    };
    let mesh_part_materials = magnet_entries
        .iter()
        .map(|entry| (entry.magnet_name.clone(), material.clone()))
        .collect::<BTreeMap<_, _>>();
    assign_material_ids_to_mesh_parts(
        &mut resolved_mesh_parts,
        &magnet_entries,
        &mesh_part_materials,
    );
    let domain_frame = problem_domain_frame(problem)
        .map(|frame| frame.with_mesh_bounds(mesh_bounds(&mesh)))
        .and_then(DomainFrameIR::finalized);

    // Phase-1A: normalize and reject unimplemented models (eigen path).
    let demag_realization = demag_realization.normalized();
    if !demag_realization.is_implemented() {
        return Err(PlanError {
            reasons: vec![format!(
                "Demag model '{}' is not yet implemented. Currently supported: airbox and fredkin_koehler.",
                demag_realization.model_name(),
            )],
        });
    }

    let resolved_demag_realization: Option<fullmag_ir::ResolvedFemDemagIR> = if enable_demag
        && operator.include_demag
    {
        let has_air_elements = mesh.element_markers.iter().any(|&m| m == 0);
        if demag_realization.requires_airbox() && !has_air_elements {
            return Err(PlanError {
                reasons: vec![format!(
                    "{} The resolved FEM mesh has no air elements.",
                    FEM_AIRBOX_DEMAG_REQUIRED_MESSAGE
                )],
            });
        }
        Some(match demag_realization {
            fullmag_ir::RequestedFemDemagIR::PoissonDirichlet => {
                fullmag_ir::ResolvedFemDemagIR::PoissonDirichlet
            }
            fullmag_ir::RequestedFemDemagIR::PoissonRobin => {
                fullmag_ir::ResolvedFemDemagIR::PoissonRobin
            }
            fullmag_ir::RequestedFemDemagIR::Auto => fullmag_ir::ResolvedFemDemagIR::PoissonRobin,
            fullmag_ir::RequestedFemDemagIR::Bem => fullmag_ir::ResolvedFemDemagIR::Bem,
            fullmag_ir::RequestedFemDemagIR::FredkinKoehler => {
                fullmag_ir::ResolvedFemDemagIR::FredkinKoehler
            }
            fullmag_ir::RequestedFemDemagIR::Fmm => fullmag_ir::ResolvedFemDemagIR::Fmm,
        })
    } else {
        None
    };
    let air_box_config =
        build_air_box_config(problem, &mesh, resolved_demag_realization).map_err(|reason| {
            PlanError {
                reasons: vec![reason],
            }
        })?;
    if !errors.is_empty() {
        return Err(PlanError { reasons: errors });
    }

    // Phase-0C: enforce P1-only constraint (eigen path).
    if fem_hints.order != 1 {
        return Err(PlanError {
            reasons: vec![format!(
                "FEM backend currently supports only first-order (P1) elements \
                 (fe_order = 1). Requested fe_order = {}. Higher-order support is \
                 planned but not yet implemented.",
                fem_hints.order,
            )],
        });
    }

    let fem_plan = FemEigenPlanIR {
        mesh_name: mesh_name.clone(),
        mesh_source,
        mesh,
        object_segments,
        mesh_parts: resolved_mesh_parts,
        mesh_build_report,
        domain_mesh_mode,
        domain_frame,
        fe_order: fem_hints.order,
        hmax: fem_hints.hmax,
        equilibrium_magnetization,
        material,
        operator: operator.clone(),
        count: *count,
        target: target.clone(),
        equilibrium: equilibrium.clone(),
        k_sampling: k_sampling.clone(),
        normalization: *normalization,
        damping_policy: *damping_policy,
        enable_exchange,
        enable_demag: enable_demag && operator.include_demag,
        interfacial_dmi,
        dmi_interface_normal: interfacial_dmi_normal,
        bulk_dmi,
        external_field,
        gyromagnetic_ratio,
        precision: problem.backend_policy.execution_precision,
        exchange_bc: ExchangeBoundaryCondition::Neumann,
        spin_wave_bc: spin_wave_bc.clone(),
        demag_realization: resolved_demag_realization,
        air_box_config,
        mode_tracking: mode_tracking.clone(),
        dispersion_validation,
        k0_kittel_validation,
    };

    let study_note = format!(
        "study: eigenmodes operator={:?} count={} normalization={:?} damping_policy={:?}",
        fem_plan.operator.kind, fem_plan.count, fem_plan.normalization, fem_plan.damping_policy
    );
    let material_field_plans =
        gather_fem_material_field_plans(problem, &fem_plan.material, fem_plan.mesh.nodes.len());
    let mut provenance_notes = vec![
        if resolved_domain_mesh_asset.is_some() {
            "Bootstrap FEM eigen planner using study-level shared-domain mesh asset".to_string()
        } else {
            "Bootstrap FEM eigen planner with separate FemEigenPlanIR".to_string()
        },
        format!("mesh asset: {mesh_name} ({n_nodes} nodes, {n_elements} elements)"),
        format!(
            "active terms: exchange={}, demag={}, zeeman={}",
            enable_exchange,
            enable_demag && operator.include_demag,
            external_field.is_some()
        ),
        study_note,
        "FEM eigen execution currently targets the transitional CPU FEM baseline; native MFEM/SLEPc integration remains future work"
            .to_string(),
    ];
    for field_plan in &material_field_plans {
        provenance_notes.extend(field_plan.warnings.iter().cloned());
    }

    Ok(ExecutionPlanIR {
        common: CommonPlanMeta {
            ir_version: IR_VERSION.to_string(),
            requested_backend: problem.backend_policy.requested_backend,
            resolved_backend,
            execution_mode: problem.validation_profile.execution_mode,
            material_field_plans,
        },
        backend_plan: BackendPlanIR::FemEigen(fem_plan),
        output_plan: OutputPlanIR {
            outputs: problem.study.sampling().outputs.clone(),
        },
        provenance: ProvenancePlanIR {
            notes: provenance_notes,
            integrator_resolution: None,
        },
    })
}

pub(crate) fn plan_fem_frequency_response(
    problem: &ProblemIR,
    resolved_backend: BackendTarget,
) -> Result<ExecutionPlanIR, PlanError> {
    let fullmag_ir::StudyIR::FrequencyResponse {
        dynamics,
        operator,
        equilibrium,
        k_sampling,
        normalization,
        damping_policy,
        spin_wave_bc,
        magnetostatic_bc,
        excitation,
        frequencies_hz,
        solver_policy,
        sampling,
    } = &problem.study
    else {
        unreachable!("plan_fem_frequency_response is only called for StudyIR::FrequencyResponse");
    };

    let mut errors = Vec::new();
    validate_frequency_response_outputs(&sampling.outputs, &mut errors);
    let requested_device = if runtime_requests_cuda(problem) {
        fullmag_ir::ExecutionDevice::Gpu
    } else {
        fullmag_ir::ExecutionDevice::Cpu
    };
    if problem.backend_policy.execution_precision != ExecutionPrecision::Double {
        errors.push(fem_single_precision_rejection(
            runtime_requests_cuda(problem),
            "FEM frequency response",
        ));
    }
    let has_nonzero_k = !k_sampling
        .as_ref()
        .is_none_or(fullmag_ir::KSamplingIR::is_single_gamma);
    let has_floquet_dynamic_demag = operator.include_demag
        && spin_wave_bc.kind() == fullmag_ir::SpinWaveBoundaryKindIR::Floquet
        && has_nonzero_k;
    if *magnetostatic_bc == fullmag_ir::MagnetostaticBoundaryConditionIR::FloquetAirbox {
        if !operator.include_demag {
            errors.push(
                "magnetostatic_bc=floquet_airbox requires include_demag=true and a Demag energy term"
                    .to_string(),
            );
        }
        if spin_wave_bc.kind() != fullmag_ir::SpinWaveBoundaryKindIR::Floquet {
            errors.push(
                "magnetostatic_bc=floquet_airbox requires spin_wave_bc=floquet for the dynamic magnetization"
                    .to_string(),
            );
        }
        if !has_nonzero_k {
            errors.push("magnetostatic_bc=floquet_airbox requires nonzero k".to_string());
        }
        if has_floquet_dynamic_demag && requested_device != fullmag_ir::ExecutionDevice::Gpu {
            errors.push(
                "magnetostatic_bc=floquet_airbox demag-k operator is not implemented for FEM frequency response; keep demag disabled for the narrow GPU Floquet slice until the coupled delta_m/delta_phi Bloch airbox operator is validated"
                    .to_string(),
            );
        }
    } else if has_floquet_dynamic_demag {
        errors.push(
            "Floquet/Bloch dynamic demag for FEM frequency response requires magnetostatic_bc=floquet_airbox and a validated demag-k operator"
                .to_string(),
        );
    }
    if *magnetostatic_bc == fullmag_ir::MagnetostaticBoundaryConditionIR::PeriodicAirboxK0 {
        if spin_wave_bc.kind() != fullmag_ir::SpinWaveBoundaryKindIR::Periodic {
            errors.push(
                "magnetostatic_bc=periodic_airbox_k0 requires spin_wave_bc=periodic for the dynamic magnetization"
                    .to_string(),
            );
        }
        if has_nonzero_k {
            errors.push("magnetostatic_bc=periodic_airbox_k0 requires k=0".to_string());
        }
    }
    if !errors.is_empty() {
        return Err(PlanError { reasons: errors });
    }

    let use_floquet_airbox_gpu_unavailable_boundary = *magnetostatic_bc
        == fullmag_ir::MagnetostaticBoundaryConditionIR::FloquetAirbox
        && has_floquet_dynamic_demag
        && requested_device == fullmag_ir::ExecutionDevice::Gpu;
    let eigen_proxy_k_sampling = if use_floquet_airbox_gpu_unavailable_boundary {
        Some(fullmag_ir::KSamplingIR::Single {
            k_vector: [0.0, 0.0, 0.0],
        })
    } else {
        k_sampling.clone()
    };
    let eigen_proxy_spin_wave_bc = if use_floquet_airbox_gpu_unavailable_boundary {
        fullmag_ir::SpinWaveBoundaryConditionIR::Config(fullmag_ir::SpinWaveBoundaryConfigIR {
            kind: fullmag_ir::SpinWaveBoundaryKindIR::Periodic,
            boundary_pair_id: None,
            pair_ids: spin_wave_bc
                .boundary_pair_ids()
                .into_iter()
                .map(str::to_string)
                .collect(),
            phase_convention: fullmag_ir::PhaseConventionIR::default(),
            surface_anisotropy_ks: None,
            surface_anisotropy_axis: None,
        })
    } else {
        spin_wave_bc.clone()
    };

    let mut eigen_proxy = problem.clone();
    eigen_proxy.study = fullmag_ir::StudyIR::Eigenmodes {
        dynamics: dynamics.clone(),
        operator: operator.clone(),
        count: 1,
        target: fullmag_ir::EigenTargetIR::Lowest,
        equilibrium: equilibrium.clone(),
        k_sampling: eigen_proxy_k_sampling,
        normalization: fullmag_ir::EigenNormalizationIR::UnitL2,
        damping_policy: *damping_policy,
        spin_wave_bc: eigen_proxy_spin_wave_bc,
        sampling: fullmag_ir::SamplingIR {
            table_autosave: None,
            outputs: vec![fullmag_ir::OutputIR::EigenSpectrum {
                quantity: "eigenfrequency".to_string(),
            }],
        },
        mode_tracking: None,
    };

    let eigen_plan = plan_fem_eigen(&eigen_proxy, resolved_backend)?;
    let BackendPlanIR::FemEigen(eigen) = eigen_plan.backend_plan else {
        unreachable!("FEM eigen proxy must produce BackendPlanIR::FemEigen");
    };

    let response_spin_wave_bc =
        normalize_frequency_response_gamma_floquet_spin_wave_bc(spin_wave_bc, k_sampling.as_ref());
    let mut response_plan = FemFrequencyResponsePlanIR {
        mesh_name: eigen.mesh_name,
        mesh_source: eigen.mesh_source,
        mesh: eigen.mesh,
        object_segments: eigen.object_segments,
        mesh_parts: eigen.mesh_parts,
        mesh_build_report: eigen.mesh_build_report,
        domain_mesh_mode: eigen.domain_mesh_mode,
        domain_mesh_workflow_mode: domain_mesh_workflow_mode(problem),
        domain_frame: eigen.domain_frame,
        fe_order: eigen.fe_order,
        hmax: eigen.hmax,
        equilibrium_magnetization: eigen.equilibrium_magnetization,
        material: eigen.material,
        operator: operator.clone(),
        equilibrium: equilibrium.clone(),
        k_sampling: k_sampling.clone(),
        normalization: *normalization,
        damping_policy: *damping_policy,
        spin_wave_bc: response_spin_wave_bc,
        magnetostatic_bc: *magnetostatic_bc,
        excitation: excitation.clone(),
        frequencies_hz: frequencies_hz.clone(),
        solver_policy: solver_policy.clone(),
        enable_exchange: eigen.enable_exchange,
        enable_demag: eigen.enable_demag,
        interfacial_dmi: eigen.interfacial_dmi,
        dmi_interface_normal: eigen.dmi_interface_normal,
        bulk_dmi: eigen.bulk_dmi,
        external_field: eigen.external_field,
        gyromagnetic_ratio: eigen.gyromagnetic_ratio,
        precision: eigen.precision,
        requested_device,
        exchange_bc: eigen.exchange_bc,
        demag_realization: eigen.demag_realization,
        air_box_config: eigen.air_box_config,
        demag_solver_policy: problem
            .backend_policy
            .discretization_hints
            .as_ref()
            .and_then(|hints| hints.fem.as_ref())
            .and_then(|fem| fem.demag_solver_policy.clone()),
        periodic_constraint_sets: Vec::new(),
        equilibrium_provenance: frequency_response_equilibrium_provenance(problem)?,
    };
    response_plan.periodic_constraint_sets =
        frequency_response_periodic_constraint_sets(&response_plan);

    if let Some(reason) = fem_frequency_response_production_slice_rejection_reason(&response_plan) {
        return Err(PlanError {
            reasons: vec![format!(
                "FEM frequency response is currently executable only for the native MFEM production CPU/GPU supported frequency-domain slices: {reason}"
            )],
        });
    }

    let mut provenance_notes = eigen_plan.provenance.notes;
    provenance_notes.push(format!(
        "study: frequency_response operator={:?} frequencies={} normalization={:?} damping_policy={:?}",
        response_plan.operator.kind,
        response_plan.frequencies_hz.values_hz.len(),
        response_plan.normalization,
        response_plan.damping_policy
    ));
    provenance_notes.push(
        "FEM frequency response plans to the native frequency-domain family; execution remains gated by native driven-solver availability"
            .to_string(),
    );

    Ok(ExecutionPlanIR {
        common: CommonPlanMeta {
            ir_version: IR_VERSION.to_string(),
            requested_backend: problem.backend_policy.requested_backend,
            resolved_backend,
            execution_mode: problem.validation_profile.execution_mode,
            material_field_plans: eigen_plan.common.material_field_plans,
        },
        backend_plan: BackendPlanIR::FemFrequencyResponse(response_plan),
        output_plan: OutputPlanIR {
            outputs: sampling.outputs.clone(),
        },
        provenance: ProvenancePlanIR {
            notes: provenance_notes,
            integrator_resolution: None,
        },
    })
}

fn fem_frequency_response_production_slice_rejection_reason(
    plan: &FemFrequencyResponsePlanIR,
) -> Option<&'static str> {
    if plan.magnetostatic_bc == fullmag_ir::MagnetostaticBoundaryConditionIR::FloquetAirbox {
        if plan.requested_device != fullmag_ir::ExecutionDevice::Gpu {
            return Some(
                "magnetostatic_bc=floquet_airbox demag-k is currently allowed only for explicit production GPU requests that publish native unavailable artifacts",
            );
        }
        if plan.domain_mesh_mode != fullmag_ir::FemDomainMeshModeIR::SharedDomainMeshWithAir {
            return Some("magnetostatic_bc=floquet_airbox requires a shared-domain airbox mesh");
        }
        if !plan.enable_demag || plan.demag_realization.is_none() {
            return Some(
                "magnetostatic_bc=floquet_airbox requires include_demag=true and a Demag energy term",
            );
        }
        if plan.spin_wave_bc.kind() != fullmag_ir::SpinWaveBoundaryKindIR::Floquet {
            return Some(
                "magnetostatic_bc=floquet_airbox requires spin_wave_bc=floquet for the dynamic magnetization",
            );
        }
        if plan
            .k_sampling
            .as_ref()
            .is_none_or(fullmag_ir::KSamplingIR::is_single_gamma)
        {
            return Some("magnetostatic_bc=floquet_airbox requires nonzero k");
        }
        if !plan.periodic_constraint_sets.iter().any(|constraint| {
            constraint.unknown_family == fullmag_ir::PeriodicUnknownFamilyIR::MagnetizationDynamic
                && constraint.domain_scope == fullmag_ir::PeriodicDomainScopeIR::MagneticDomain
                && matches!(
                    constraint.phase_policy,
                    fullmag_ir::PeriodicPhasePolicyIR::BlochPhase { .. }
                )
        }) {
            return Some("magnetostatic_bc=floquet_airbox requires a delta_m Bloch constraint set");
        }
        if !plan.periodic_constraint_sets.iter().any(|constraint| {
            constraint.unknown_family
                == fullmag_ir::PeriodicUnknownFamilyIR::MagnetostaticPotentialDynamic
                && constraint.domain_scope
                    == fullmag_ir::PeriodicDomainScopeIR::MagnetostaticDomainWithAir
                && matches!(
                    constraint.phase_policy,
                    fullmag_ir::PeriodicPhasePolicyIR::BlochPhase { .. }
                )
        }) {
            return Some(
                "magnetostatic_bc=floquet_airbox requires a delta_phi Bloch constraint set",
            );
        }
        return None;
    }
    if plan.magnetostatic_bc == fullmag_ir::MagnetostaticBoundaryConditionIR::PeriodicAirboxK0 {
        if plan.domain_mesh_mode != fullmag_ir::FemDomainMeshModeIR::SharedDomainMeshWithAir {
            return Some(
                "magnetostatic_bc=periodic_airbox_k0 requires a shared-domain airbox mesh",
            );
        }
        if !plan.enable_demag || plan.demag_realization.is_none() {
            return Some(
                "magnetostatic_bc=periodic_airbox_k0 requires include_demag=true and a Demag energy term",
            );
        }
        if plan.spin_wave_bc.kind() != fullmag_ir::SpinWaveBoundaryKindIR::Periodic {
            return Some(
                "magnetostatic_bc=periodic_airbox_k0 requires spin_wave_bc=periodic for the dynamic magnetization",
            );
        }
        if !plan
            .k_sampling
            .as_ref()
            .is_none_or(fullmag_ir::KSamplingIR::is_single_gamma)
        {
            return Some("magnetostatic_bc=periodic_airbox_k0 requires k=0");
        }
        if !plan.periodic_constraint_sets.iter().any(|constraint| {
            constraint.unknown_family == fullmag_ir::PeriodicUnknownFamilyIR::MagnetizationDynamic
                && constraint.domain_scope == fullmag_ir::PeriodicDomainScopeIR::MagneticDomain
        }) {
            return Some(
                "magnetostatic_bc=periodic_airbox_k0 requires a delta_m periodic constraint set",
            );
        }
        if !plan.periodic_constraint_sets.iter().any(|constraint| {
            constraint.unknown_family
                == fullmag_ir::PeriodicUnknownFamilyIR::MagnetostaticPotentialDynamic
                && constraint.domain_scope
                    == fullmag_ir::PeriodicDomainScopeIR::MagnetostaticDomainWithAir
        }) {
            return Some(
                "magnetostatic_bc=periodic_airbox_k0 requires a delta_phi periodic constraint set",
            );
        }
        return None;
    }
    if plan.domain_mesh_mode != fullmag_ir::FemDomainMeshModeIR::MergedMagneticMesh
        && plan.domain_mesh_mode != fullmag_ir::FemDomainMeshModeIR::SharedDomainMeshWithAir
    {
        return Some("frequency-response dynamic demag requires a magnetic-body or shared-domain airbox mesh");
    }
    if plan.enable_demag != plan.demag_realization.is_some() {
        return Some("frequency-response dynamic demag requires include_demag=true and a resolved Demag energy term");
    }
    match plan.spin_wave_bc.kind() {
        fullmag_ir::SpinWaveBoundaryKindIR::Free => {
            if !plan
                .k_sampling
                .as_ref()
                .is_none_or(fullmag_ir::KSamplingIR::is_single_gamma)
            {
                return Some(
                    "nonzero-k Floquet/Bloch driven response requires spin_wave_bc=floquet",
                );
            }
        }
        fullmag_ir::SpinWaveBoundaryKindIR::Periodic => {
            if !plan
                .k_sampling
                .as_ref()
                .is_none_or(fullmag_ir::KSamplingIR::is_single_gamma)
            {
                return Some(
                    "nonzero-k Floquet/Bloch driven response requires spin_wave_bc=floquet",
                );
            }
            if plan.mesh.periodic_node_pairs.is_empty() {
                return Some(
                    "static periodic driven response requires mesh.periodic_node_pairs metadata",
                );
            }
        }
        fullmag_ir::SpinWaveBoundaryKindIR::Floquet => {
            if plan.mesh.periodic_boundary_pairs.is_empty() {
                return Some(
                    "nonzero-k Floquet/Bloch driven response requires mesh.periodic_boundary_pairs metadata with translations",
                );
            }
            if plan.mesh.periodic_node_pairs.is_empty() {
                return Some(
                    "nonzero-k Floquet/Bloch driven response requires mesh.periodic_node_pairs metadata",
                );
            }
            if plan.mesh.periodic_boundary_pairs.iter().any(|pair| {
                pair.translation
                    .is_none_or(|translation| !translation.iter().all(|value| value.is_finite()))
            }) {
                return Some(
                    "nonzero-k Floquet/Bloch driven response requires finite periodic boundary pair translations",
                );
            }
        }
        _ => {
            return Some("the requested spin-wave boundary condition is not enforced by the driven response operator");
        }
    }
    None
}

fn normalize_frequency_response_gamma_floquet_spin_wave_bc(
    spin_wave_bc: &fullmag_ir::SpinWaveBoundaryConditionIR,
    k_sampling: Option<&fullmag_ir::KSamplingIR>,
) -> fullmag_ir::SpinWaveBoundaryConditionIR {
    if spin_wave_bc.kind() != fullmag_ir::SpinWaveBoundaryKindIR::Floquet
        || !k_sampling.is_none_or(fullmag_ir::KSamplingIR::is_single_gamma)
    {
        return spin_wave_bc.clone();
    }
    match spin_wave_bc {
        fullmag_ir::SpinWaveBoundaryConditionIR::Legacy(_) => {
            fullmag_ir::SpinWaveBoundaryConditionIR::Legacy(
                fullmag_ir::SpinWaveBoundaryKindIR::Periodic,
            )
        }
        fullmag_ir::SpinWaveBoundaryConditionIR::Config(config) => {
            let mut normalized = config.clone();
            normalized.kind = fullmag_ir::SpinWaveBoundaryKindIR::Periodic;
            fullmag_ir::SpinWaveBoundaryConditionIR::Config(normalized)
        }
    }
}

pub(crate) fn frequency_response_periodic_constraint_sets(
    plan: &FemFrequencyResponsePlanIR,
) -> Vec<fullmag_ir::PeriodicConstraintSetIR> {
    let mut constraint_sets = Vec::new();
    if plan.spin_wave_bc.kind() == fullmag_ir::SpinWaveBoundaryKindIR::Periodic {
        let pair_ids = selected_frequency_response_periodic_pair_ids(plan);
        if !pair_ids.is_empty() {
            constraint_sets.push(fullmag_ir::PeriodicConstraintSetIR {
                unknown_family: fullmag_ir::PeriodicUnknownFamilyIR::MagnetizationDynamic,
                domain_scope: fullmag_ir::PeriodicDomainScopeIR::MagneticDomain,
                pair_ids,
                phase_policy: fullmag_ir::PeriodicPhasePolicyIR::ZeroPhase,
                phase_loop_diagnostics: None,
            });
        }
    }
    if plan.spin_wave_bc.kind() == fullmag_ir::SpinWaveBoundaryKindIR::Floquet {
        let pair_ids = selected_frequency_response_periodic_pair_ids(plan);
        if !pair_ids.is_empty() {
            if let Some(k_vector_rad_per_m) =
                frequency_response_single_k_vector_rad_per_m(plan.k_sampling.as_ref())
            {
                let phase_loop_diagnostics =
                    frequency_response_phase_loop_diagnostics(plan, &pair_ids, k_vector_rad_per_m);
                let phase_policy = fullmag_ir::PeriodicPhasePolicyIR::BlochPhase {
                    phase_convention: plan.spin_wave_bc.phase_convention(),
                    k_vector_rad_per_m,
                    real_imag_mixing: true,
                };
                constraint_sets.push(fullmag_ir::PeriodicConstraintSetIR {
                    unknown_family: fullmag_ir::PeriodicUnknownFamilyIR::MagnetizationDynamic,
                    domain_scope: fullmag_ir::PeriodicDomainScopeIR::MagneticDomain,
                    pair_ids: pair_ids.clone(),
                    phase_policy: phase_policy.clone(),
                    phase_loop_diagnostics: phase_loop_diagnostics.clone(),
                });
                if plan.magnetostatic_bc
                    == fullmag_ir::MagnetostaticBoundaryConditionIR::FloquetAirbox
                {
                    constraint_sets.push(fullmag_ir::PeriodicConstraintSetIR {
                        unknown_family:
                            fullmag_ir::PeriodicUnknownFamilyIR::MagnetostaticPotentialDynamic,
                        domain_scope: fullmag_ir::PeriodicDomainScopeIR::MagnetostaticDomainWithAir,
                        pair_ids,
                        phase_policy,
                        phase_loop_diagnostics,
                    });
                }
            }
        }
    }
    if plan.magnetostatic_bc == fullmag_ir::MagnetostaticBoundaryConditionIR::PeriodicAirboxK0 {
        let pair_ids = selected_frequency_response_periodic_pair_ids(plan);
        if !pair_ids.is_empty() {
            constraint_sets.push(fullmag_ir::PeriodicConstraintSetIR {
                unknown_family: fullmag_ir::PeriodicUnknownFamilyIR::MagnetostaticPotentialDynamic,
                domain_scope: fullmag_ir::PeriodicDomainScopeIR::MagnetostaticDomainWithAir,
                pair_ids,
                phase_policy: fullmag_ir::PeriodicPhasePolicyIR::ZeroPhase,
                phase_loop_diagnostics: None,
            });
        }
    }
    constraint_sets
}

fn frequency_response_phase_loop_diagnostics(
    plan: &FemFrequencyResponsePlanIR,
    pair_ids: &[String],
    k_vector_rad_per_m: [f64; 3],
) -> Option<fullmag_ir::PeriodicPhaseLoopDiagnosticsIR> {
    let translations = pair_ids
        .iter()
        .filter_map(|pair_id| {
            plan.mesh
                .periodic_boundary_pairs
                .iter()
                .find(|pair| pair.pair_id == *pair_id)
                .and_then(|pair| pair.translation)
        })
        .filter(|translation| translation.iter().all(|value| value.is_finite()))
        .collect::<Vec<_>>();
    if translations.len() < 2 {
        return None;
    }

    let mut checked_loop_count = 0_u64;
    let mut max_phase_loop_residual_rad = 0.0_f64;
    for first in 0..translations.len() {
        for second in (first + 1)..translations.len() {
            let phase_first_then_second =
                bloch_phase_angle_rad(k_vector_rad_per_m, translations[first])
                    + bloch_phase_angle_rad(k_vector_rad_per_m, translations[second]);
            let phase_second_then_first =
                bloch_phase_angle_rad(k_vector_rad_per_m, translations[second])
                    + bloch_phase_angle_rad(k_vector_rad_per_m, translations[first]);
            let residual =
                canonical_phase_residual_rad(phase_first_then_second - phase_second_then_first);
            max_phase_loop_residual_rad = max_phase_loop_residual_rad.max(residual.abs());
            checked_loop_count += 1;
        }
    }

    Some(fullmag_ir::PeriodicPhaseLoopDiagnosticsIR {
        checked_loop_count,
        max_phase_loop_residual_rad,
    })
}

fn bloch_phase_angle_rad(k_vector_rad_per_m: [f64; 3], translation_m: [f64; 3]) -> f64 {
    -k_vector_rad_per_m[0] * translation_m[0]
        - k_vector_rad_per_m[1] * translation_m[1]
        - k_vector_rad_per_m[2] * translation_m[2]
}

fn canonical_phase_residual_rad(phase_rad: f64) -> f64 {
    let two_pi = 2.0 * std::f64::consts::PI;
    let mut value = (phase_rad + std::f64::consts::PI).rem_euclid(two_pi) - std::f64::consts::PI;
    if value <= -std::f64::consts::PI {
        value += two_pi;
    }
    value
}

fn frequency_response_single_k_vector_rad_per_m(
    k_sampling: Option<&fullmag_ir::KSamplingIR>,
) -> Option<[f64; 3]> {
    match k_sampling {
        None => Some([0.0, 0.0, 0.0]),
        Some(fullmag_ir::KSamplingIR::Single { k_vector }) => Some(*k_vector),
        Some(fullmag_ir::KSamplingIR::Path { .. }) => None,
    }
}

fn selected_frequency_response_periodic_pair_ids(plan: &FemFrequencyResponsePlanIR) -> Vec<String> {
    let requested_pair_ids = plan.spin_wave_bc.boundary_pair_ids();
    if requested_pair_ids.is_empty() {
        plan.mesh
            .periodic_boundary_pairs
            .iter()
            .map(|pair| pair.pair_id.clone())
            .collect()
    } else {
        requested_pair_ids.into_iter().map(str::to_string).collect()
    }
}
