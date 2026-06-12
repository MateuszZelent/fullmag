use anyhow::{anyhow, Result};
use fullmag_engine::fem::{FemLlgProblem, MeshTopology};
use fullmag_engine::{
    AdaptiveStepConfig, CellSize, EffectiveFieldTerms, ExchangeLlgProblem, GridShape, LlgConfig,
    MaterialParameters, TimeIntegrator,
};
use fullmag_ir::{
    BackendPlanIR, FdmMultilayerPlanIR, FdmPlanIR, FemPlanIR, IntegratorChoice,
    RelaxationAlgorithmIR,
};

#[derive(Debug, Clone, Default)]
pub(crate) struct InitialStateDiagnostic {
    pub max_effective_field_amplitude: Option<f64>,
    pub max_rhs_amplitude: Option<f64>,
    pub warnings: Vec<String>,
}

fn integrator_for_plan(integrator: IntegratorChoice) -> TimeIntegrator {
    match integrator {
        IntegratorChoice::Heun => TimeIntegrator::Heun,
        IntegratorChoice::Rk4 => TimeIntegrator::RK4,
        IntegratorChoice::Rk23 => TimeIntegrator::RK23,
        IntegratorChoice::Rk45 => TimeIntegrator::RK45,
        IntegratorChoice::Abm3 => TimeIntegrator::ABM3,
    }
}

fn relaxation_uses_pure_damping(relaxation: Option<&fullmag_ir::RelaxationControlIR>) -> bool {
    relaxation.is_some_and(|control| control.algorithm == RelaxationAlgorithmIR::LlgOverdamped)
}

fn has_nonzero_external_field(field: Option<[f64; 3]>) -> bool {
    field.is_some_and(|value| value.iter().any(|component| component.abs() > 0.0))
}

fn magnetization_is_uniform(values: &[[f64; 3]]) -> bool {
    let Some(first) = values.first() else {
        return true;
    };
    values.iter().all(|value| {
        (value[0] - first[0]).abs() <= 1e-12
            && (value[1] - first[1]).abs() <= 1e-12
            && (value[2] - first[2]).abs() <= 1e-12
    })
}

fn near_zero(value: f64) -> bool {
    value.abs() <= 1e-18
}

fn add_initial_state_warnings(
    warnings: &mut Vec<String>,
    max_effective_field_amplitude: Option<f64>,
    max_rhs_amplitude: Option<f64>,
    exchange_enabled: bool,
    demag_enabled: bool,
    external_field: Option<[f64; 3]>,
    damping: f64,
    relaxation: Option<&fullmag_ir::RelaxationControlIR>,
    uniform_initial_state: bool,
) {
    let has_external_field = has_nonzero_external_field(external_field);

    if relaxation.is_some_and(|control| control.algorithm == RelaxationAlgorithmIR::LlgOverdamped)
        && damping <= 0.0
    {
        warnings.push(
            "Relaxation requested with alpha=0. Overdamped LLG has no dissipative drive in this case, so the state will not converge.".to_string(),
        );
    }

    if exchange_enabled && !demag_enabled && !has_external_field && uniform_initial_state {
        warnings.push(
            "Demag and external field are both disabled while the initial magnetization is uniform. In this exchange-only configuration H_eff is zero, so the solver should remain static until the state is perturbed.".to_string(),
        );
    }

    if let Some(max_rhs) = max_rhs_amplitude {
        if near_zero(max_rhs) {
            match max_effective_field_amplitude {
                Some(max_h_eff) if near_zero(max_h_eff) => warnings.push(format!(
                    "Initial torque is numerically zero (max_dm_dt≈{max_rhs:.3e}, |H_eff|≈{max_h_eff:.3e}). The state is already torque-free; if motion was expected, perturb the initial magnetization or enable an active field term."
                )),
                Some(max_h_eff) => warnings.push(format!(
                    "Initial torque is numerically zero (max_dm_dt≈{max_rhs:.3e}) even though |H_eff|≈{max_h_eff:.3e} is non-zero. Magnetization is likely parallel to the effective field, so the run can look frozen until conditions change."
                )),
                None => warnings.push(format!(
                    "Initial torque is numerically zero (max_dm_dt≈{max_rhs:.3e}). The solver will appear static unless the initial state or active fields change."
                )),
            }
        }
    }
}

fn diagnose_initial_state(
    node_count: usize,
    boundary_face_count: Option<usize>,
    max_effective_field_amplitude: Option<f64>,
    max_rhs_amplitude: Option<f64>,
    exchange_enabled: bool,
    demag_enabled: bool,
    external_field: Option<[f64; 3]>,
    damping: f64,
    relaxation: Option<&fullmag_ir::RelaxationControlIR>,
    uniform_initial_state: bool,
) -> Result<InitialStateDiagnostic> {
    if node_count == 0 {
        anyhow::bail!("diagnostic mesh contains no nodes");
    }

    let mut diagnostic = InitialStateDiagnostic {
        max_effective_field_amplitude,
        max_rhs_amplitude,
        warnings: Vec::new(),
    };
    add_initial_state_warnings(
        &mut diagnostic.warnings,
        diagnostic.max_effective_field_amplitude,
        diagnostic.max_rhs_amplitude,
        exchange_enabled,
        demag_enabled,
        external_field,
        damping,
        relaxation,
        uniform_initial_state,
    );
    if demag_enabled && boundary_face_count == Some(0) {
        diagnostic.warnings.push(
            "Demag is enabled, but the FEM mesh exposes no boundary faces. Verify the mesh import before trusting magnetostatic diagnostics."
                .to_string(),
        );
    }

    Ok(diagnostic)
}

pub(crate) fn diagnose_initial_fdm_plan(plan: &FdmPlanIR) -> Result<InitialStateDiagnostic> {
    let grid = GridShape::new(
        plan.grid.cells[0] as usize,
        plan.grid.cells[1] as usize,
        plan.grid.cells[2] as usize,
    )
    .map_err(|error| anyhow!("diagnostic grid error: {}", error))?;
    let cell_size = CellSize::new(plan.cell_size[0], plan.cell_size[1], plan.cell_size[2])
        .map_err(|error| anyhow!("diagnostic cell size error: {}", error))?;
    let material = MaterialParameters::new(
        plan.material.saturation_magnetisation,
        plan.material.exchange_stiffness,
        plan.material.damping,
    )
    .map_err(|error| anyhow!("diagnostic material error: {}", error))?;
    let mut dynamics = LlgConfig::new(
        plan.gyromagnetic_ratio,
        integrator_for_plan(plan.integrator),
    )
    .map_err(|error| anyhow!("diagnostic LLG config error: {}", error))?
    .with_precession_enabled(!relaxation_uses_pure_damping(plan.relaxation.as_ref()));
    if let Some(adaptive) = plan.adaptive_timestep.as_ref() {
        dynamics = dynamics.with_adaptive(AdaptiveStepConfig {
            max_error: adaptive.atol,
            dt_min: adaptive.dt_min,
            dt_max: adaptive.dt_max.unwrap_or(1e-10),
            headroom: adaptive.safety,
            rtol: adaptive.rtol,
            growth_limit: if adaptive.growth_limit == 0.0 {
                f64::INFINITY
            } else {
                adaptive.growth_limit
            },
            shrink_limit: adaptive.shrink_limit,
        });
    }
    let problem = ExchangeLlgProblem::with_terms_and_mask(
        grid,
        cell_size,
        material,
        dynamics,
        EffectiveFieldTerms {
            exchange: plan.enable_exchange,
            demag: plan.enable_demag,
            external_field: plan.external_field,
            per_node_field: None,
            magnetoelastic: None,
            ..Default::default()
        },
        plan.active_mask.clone(),
    )
    .map_err(|error| anyhow!("diagnostic problem construction error: {}", error))?;
    let state = problem
        .new_state(plan.initial_magnetization.clone())
        .map_err(|error| anyhow!("diagnostic state error: {}", error))?;
    let observables = problem
        .observe(&state)
        .map_err(|error| anyhow!("diagnostic observe error: {}", error))?;

    let mut diagnostic = InitialStateDiagnostic {
        max_effective_field_amplitude: Some(observables.max_effective_field_amplitude),
        max_rhs_amplitude: Some(observables.max_rhs_amplitude),
        warnings: Vec::new(),
    };
    add_initial_state_warnings(
        &mut diagnostic.warnings,
        diagnostic.max_effective_field_amplitude,
        diagnostic.max_rhs_amplitude,
        plan.enable_exchange,
        plan.enable_demag,
        plan.external_field,
        plan.material.damping,
        plan.relaxation.as_ref(),
        magnetization_is_uniform(&plan.initial_magnetization),
    );
    Ok(diagnostic)
}

pub(crate) fn diagnose_initial_fem_plan(plan: &FemPlanIR) -> Result<InitialStateDiagnostic> {
    let topology = MeshTopology::from_ir(&plan.mesh)
        .map_err(|error| anyhow!("diagnostic FEM topology error: {}", error))?;
    let material = MaterialParameters::new(
        plan.material.saturation_magnetisation,
        plan.material.exchange_stiffness,
        plan.material.damping,
    )
    .map_err(|error| anyhow!("diagnostic FEM material error: {}", error))?;
    let mut dynamics = LlgConfig::new(
        plan.gyromagnetic_ratio,
        integrator_for_plan(plan.integrator),
    )
    .map_err(|error| anyhow!("diagnostic FEM LLG config error: {}", error))?
    .with_precession_enabled(!relaxation_uses_pure_damping(plan.relaxation.as_ref()));
    if let Some(adaptive) = plan.adaptive_timestep.as_ref() {
        dynamics = dynamics.with_adaptive(AdaptiveStepConfig {
            max_error: adaptive.atol,
            dt_min: adaptive.dt_min,
            dt_max: adaptive.dt_max.unwrap_or(1e-10),
            headroom: adaptive.safety,
            rtol: adaptive.rtol,
            growth_limit: if adaptive.growth_limit == 0.0 {
                f64::INFINITY
            } else {
                adaptive.growth_limit
            },
            shrink_limit: adaptive.shrink_limit,
        });
    }
    let _mesh_has_air = plan.mesh.element_markers.iter().any(|marker| *marker == 0);
    let terms = EffectiveFieldTerms {
        exchange: plan.enable_exchange,
        demag: plan.enable_demag,
        external_field: plan.external_field,
        per_node_field: None,
        magnetoelastic: None,
        ..Default::default()
    };
    let problem = if !plan.enable_demag {
        FemLlgProblem::with_terms(topology, material, dynamics, terms)
    } else {
        match plan.demag_realization {
            Some(fullmag_ir::ResolvedFemDemagIR::PoissonRobin) => {
                FemLlgProblem::with_terms_and_demag_airbox(
                    topology,
                    material,
                    dynamics,
                    terms,
                    false,
                    plan.air_box_config
                        .as_ref()
                        .and_then(|config| config.robin_beta_factor),
                )
            }
            Some(fullmag_ir::ResolvedFemDemagIR::PoissonDirichlet) => {
                FemLlgProblem::with_terms_and_demag_airbox(
                    topology, material, dynamics, terms, true, None,
                )
            }
            None => FemLlgProblem::with_terms_and_demag_airbox(
                topology, material, dynamics, terms, false, None,
            ),
            Some(fullmag_ir::ResolvedFemDemagIR::FredkinKoehler) => {
                let mut diagnostic = diagnose_initial_state(
                    plan.mesh.nodes.len(),
                    Some(plan.mesh.boundary_faces.len()),
                    None,
                    None,
                    plan.enable_exchange,
                    plan.enable_demag,
                    plan.external_field,
                    plan.material.damping,
                    plan.relaxation.as_ref(),
                    magnetization_is_uniform(&plan.initial_magnetization),
                )?;
                diagnostic.warnings.push(
                    "Initial FEM diagnostic does not evaluate Fredkin-Koehler demag; \
                     the native FEM/BEM runtime will compute H_demag during execution."
                        .to_string(),
                );
                return Ok(diagnostic);
            }
            Some(
                realization @ (fullmag_ir::ResolvedFemDemagIR::Bem
                | fullmag_ir::ResolvedFemDemagIR::Fmm),
            ) => {
                return Err(anyhow!(
                    "diagnostic FEM runner: demag model '{}' is not yet implemented in the backend",
                    realization.model_name(),
                ));
            }
        }
    };
    let state = problem
        .new_state(plan.initial_magnetization.clone())
        .map_err(|error| anyhow!("diagnostic FEM state error: {}", error))?;
    let observables = problem
        .observe(&state)
        .map_err(|error| anyhow!("diagnostic FEM observe error: {}", error))?;

    let mut diagnostic = InitialStateDiagnostic {
        max_effective_field_amplitude: Some(observables.max_effective_field_amplitude),
        max_rhs_amplitude: Some(observables.max_rhs_amplitude),
        warnings: Vec::new(),
    };
    add_initial_state_warnings(
        &mut diagnostic.warnings,
        diagnostic.max_effective_field_amplitude,
        diagnostic.max_rhs_amplitude,
        plan.enable_exchange,
        plan.enable_demag,
        plan.external_field,
        plan.material.damping,
        plan.relaxation.as_ref(),
        magnetization_is_uniform(&plan.initial_magnetization),
    );
    Ok(diagnostic)
}

fn diagnose_initial_multilayer_plan(plan: &FdmMultilayerPlanIR) -> InitialStateDiagnostic {
    let mut diagnostic = InitialStateDiagnostic::default();
    let uniform_initial_state = plan.layers.iter().all(|layer| {
        magnetization_is_uniform(&layer.initial_magnetization)
            && layer
                .initial_magnetization
                .first()
                .zip(
                    plan.layers
                        .first()
                        .and_then(|first| first.initial_magnetization.first()),
                )
                .map(|(current, reference)| {
                    (current[0] - reference[0]).abs() <= 1e-12
                        && (current[1] - reference[1]).abs() <= 1e-12
                        && (current[2] - reference[2]).abs() <= 1e-12
                })
                .unwrap_or(true)
    });
    let damping = plan
        .layers
        .iter()
        .map(|layer| layer.material.damping)
        .fold(f64::INFINITY, f64::min);
    add_initial_state_warnings(
        &mut diagnostic.warnings,
        None,
        None,
        plan.enable_exchange,
        plan.enable_demag,
        plan.external_field,
        if damping.is_finite() { damping } else { 0.0 },
        plan.relaxation.as_ref(),
        uniform_initial_state,
    );
    diagnostic
}

pub(crate) fn diagnose_initial_backend_plan(
    backend_plan: &BackendPlanIR,
) -> Result<InitialStateDiagnostic> {
    match backend_plan {
        BackendPlanIR::Fdm(plan) => diagnose_initial_fdm_plan(plan),
        BackendPlanIR::FdmMultilayer(plan) => Ok(diagnose_initial_multilayer_plan(plan)),
        BackendPlanIR::Fem(plan) => diagnose_initial_fem_plan(plan),
        BackendPlanIR::FemEigen(plan) => diagnose_initial_state(
            plan.mesh.nodes.len(),
            Some(plan.mesh.boundary_faces.len()),
            None,
            None,
            plan.enable_exchange,
            plan.enable_demag,
            plan.external_field,
            if plan.material.damping.is_finite() {
                plan.material.damping
            } else {
                0.0
            },
            None,
            magnetization_is_uniform(&plan.equilibrium_magnetization),
        ),
        BackendPlanIR::FemFrequencyResponse(plan) => diagnose_initial_state(
            plan.mesh.nodes.len(),
            Some(plan.mesh.boundary_faces.len()),
            None,
            None,
            plan.enable_exchange,
            plan.enable_demag,
            plan.external_field,
            if plan.material.damping.is_finite() {
                plan.material.damping
            } else {
                0.0
            },
            None,
            magnetization_is_uniform(&plan.equilibrium_magnetization),
        ),
    }
}
