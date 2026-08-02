use fullmag_ir::{
    BackendTarget, CouplingCapabilityPolicyIR, CouplingEndpointIR, CouplingKindIR,
    CouplingParametersIR, ExchangeCouplingModeIR, FdmGridAssetIR, FieldRefreshPolicyIR,
    IntegratorChoice, OutputIR, ProblemIR, RegionRealizationPolicyIR, RelaxationAlgorithmIR,
    RelaxationControlIR,
};
use std::collections::BTreeSet;

use crate::util::runtime_requests_cuda;

pub(crate) fn resolve_auto_backend(problem: &ProblemIR) -> BackendTarget {
    if matches!(
        problem.study,
        fullmag_ir::StudyIR::Relaxation {
            algorithm: RelaxationAlgorithmIR::TangentPlaneImplicit,
            ..
        }
    ) {
        return BackendTarget::Fem;
    }
    let hints = problem.backend_policy.discretization_hints.as_ref();
    let has_fdm = hints.and_then(|value| value.fdm.as_ref()).is_some()
        || problem
            .geometry_assets
            .as_ref()
            .is_some_and(|assets| !assets.fdm_grid_assets.is_empty());
    let has_fem = hints.and_then(|value| value.fem.as_ref()).is_some()
        || problem.geometry_assets.as_ref().is_some_and(|assets| {
            !assets.fem_mesh_assets.is_empty() || assets.fem_domain_mesh_asset.is_some()
        });

    match (has_fdm, has_fem) {
        (false, true) => BackendTarget::Fem,
        _ => BackendTarget::Fdm,
    }
}

pub(crate) fn region_is_conformal(
    problem: &ProblemIR,
    region: &fullmag_ir::ObjectRegionIR,
) -> bool {
    if let Some(assets) = &problem.geometry_assets {
        if let Some(domain_asset) = &assets.fem_domain_mesh_asset {
            let mesh_markers = crate::mesh::load_fem_domain_mesh_asset(domain_asset)
                .ok()
                .map(|mesh| {
                    mesh.element_markers
                        .iter()
                        .copied()
                        .collect::<BTreeSet<_>>()
                });
            return domain_asset.object_region_markers.iter().any(|marker| {
                (marker.geometry_name == region.name || marker.geometry_name == region.region_id)
                    && mesh_markers
                        .as_ref()
                        .is_some_and(|markers| markers.contains(&marker.marker))
            });
        }
    }
    false
}

pub(crate) fn validate_region_owned_planning(
    problem: &ProblemIR,
    resolved_backend: BackendTarget,
    errors: &mut Vec<String>,
) {
    let enabled_region_ids = problem
        .object_regions
        .iter()
        .filter(|region| region.enabled)
        .map(|region| region.region_id.as_str())
        .collect::<BTreeSet<_>>();
    let has_unsupported_fields = problem.material_parameter_fields.iter().any(|assignment| {
        let is_active_region = assignment
            .region_id
            .as_deref()
            .is_none_or(|region_id| enabled_region_ids.contains(region_id));
        is_active_region
            && !matches!(
                assignment.parameter,
                fullmag_ir::MaterialParameterNameIR::Ms
                    | fullmag_ir::MaterialParameterNameIR::Aex
                    | fullmag_ir::MaterialParameterNameIR::Alpha
            )
    });
    if has_unsupported_fields {
        errors.push(format!(
            "region-owned material_parameter_fields are authored in ProblemIR but not yet executable for backend='{}'; planner must not silently drop spatial material fields",
            resolved_backend.as_str()
        ));
    }
    if resolved_backend != BackendTarget::Fem
        && problem
            .object_regions
            .iter()
            .any(|region| region.enabled && region.mesh_policy.is_some())
    {
        errors.push(format!(
            "object region mesh_policy is authored in ProblemIR but not yet executable for backend='{}'; planner must not silently ignore region mesh controls",
            resolved_backend.as_str()
        ));
    }
    if resolved_backend == BackendTarget::Fem {
        for region in problem.object_regions.iter().filter(|r| r.enabled) {
            if region.mesh_policy.is_some() {
                if matches!(region.shape, fullmag_ir::RegionShapeIR::Csg { .. }) {
                    errors.push(format!(
                        "object region '{}' has CSG shape, which is not supported for mesh_policy; CSG region mesh policies are not implemented",
                        region.name
                    ));
                }
            }
        }
    }
    let has_unsupported_overrides = problem.object_regions.iter().any(|region| {
        region.enabled
            && region.material_overrides.iter().any(|over| {
                !matches!(
                    over.parameter,
                    fullmag_ir::MaterialParameterNameIR::Ms
                        | fullmag_ir::MaterialParameterNameIR::Aex
                        | fullmag_ir::MaterialParameterNameIR::Alpha
                )
            })
    });
    if has_unsupported_overrides {
        errors.push(format!(
            "object region material_overrides are authored in ProblemIR but not yet executable for backend='{}'; planner must not silently ignore region material overrides",
            resolved_backend.as_str()
        ));
    }
    if resolved_backend == BackendTarget::Fdm && runtime_requests_cuda(problem) {
        let has_cuda_region_fields = problem.material_parameter_fields.iter().any(|assignment| {
            let active = assignment.region_id.as_deref().is_none_or(|region_id| {
                problem
                    .object_regions
                    .iter()
                    .any(|region| region.enabled && region.region_id == region_id)
            });
            active
                && matches!(
                    assignment.parameter,
                    fullmag_ir::MaterialParameterNameIR::Ms
                        | fullmag_ir::MaterialParameterNameIR::Aex
                        | fullmag_ir::MaterialParameterNameIR::Alpha
                )
        }) || problem.object_regions.iter().any(|region| {
            region.enabled
                && region.material_overrides.iter().any(|override_| {
                    matches!(
                        override_.parameter,
                        fullmag_ir::MaterialParameterNameIR::Ms
                            | fullmag_ir::MaterialParameterNameIR::Aex
                            | fullmag_ir::MaterialParameterNameIR::Alpha
                    )
                })
        });
        if has_cuda_region_fields {
            errors.push(
                "fdm_cuda_region_material_fields_unsupported: CUDA native does not yet support cellwise material fields (Ms/Aex/alpha); use FDM CPU reference or disable region material overrides"
                    .to_string(),
            );
        }
    }
    if resolved_backend != BackendTarget::Fdm
        && problem
            .object_regions
            .iter()
            .any(|region| region.enabled && region.texture_override.is_some())
    {
        errors.push(format!(
            "object region texture_override is authored in ProblemIR but not yet executable for backend='{}'; planner must not silently ignore region texture overrides",
            resolved_backend.as_str()
        ));
    }

    if resolved_backend != BackendTarget::Fem
        && problem.object_regions.iter().any(|region| {
            region.enabled
                && matches!(
                    region.realization_policy,
                    fullmag_ir::RegionRealizationPolicyIR::Conformal
                        | fullmag_ir::RegionRealizationPolicyIR::Project
                )
        })
    {
        errors.push(format!(
            "object region realization_policy requests conformal/project realization in ProblemIR but backend='{}' does not yet materialize authored object regions; planner must not silently pretend the requested realization happened",
            resolved_backend.as_str()
        ));
    }

    if resolved_backend == BackendTarget::Fem {
        let is_strict =
            problem.validation_profile.execution_mode == fullmag_ir::ExecutionMode::Strict;
        let is_extended =
            problem.validation_profile.execution_mode == fullmag_ir::ExecutionMode::Extended;

        for region in &problem.object_regions {
            if !region.enabled {
                continue;
            }
            let has_sharp_override = region.material_overrides.iter().any(|over| {
                matches!(
                    over.parameter,
                    fullmag_ir::MaterialParameterNameIR::Ms
                        | fullmag_ir::MaterialParameterNameIR::Aex
                ) && matches!(
                    over.value,
                    fullmag_ir::MaterialParameterFieldIR::Constant { .. }
                ) && crate::material_transition::region_transition_is_sharp(region, over.parameter)
            }) || problem.material_parameter_fields.iter().any(
                |assignment| {
                    assignment.region_id.as_deref() == Some(region.region_id.as_str())
                        && matches!(
                            assignment.parameter,
                            fullmag_ir::MaterialParameterNameIR::Ms
                                | fullmag_ir::MaterialParameterNameIR::Aex
                        )
                        && matches!(
                            assignment.value,
                            fullmag_ir::MaterialParameterFieldIR::Constant { .. }
                        )
                        && crate::material_transition::region_transition_is_sharp(
                            region,
                            assignment.parameter,
                        )
                },
            );

            if has_sharp_override {
                let conformal = region.realization_policy != RegionRealizationPolicyIR::Project
                    && region_is_conformal(problem, region);
                if !conformal {
                    if is_strict {
                        errors.push(format!(
                            "sharp parameter override for Aex/Ms in region '{}' requires a conformal boundary (domain marker) in strict mode; projection is not allowed in strict mode",
                            region.region_id
                        ));
                    } else if is_extended {
                        if region.realization_policy != RegionRealizationPolicyIR::Project {
                            errors.push(format!(
                                "sharp parameter override for Aex/Ms in region '{}' requires conformal boundary, but no domain marker was found in the mesh; to allow projection, set realization_policy='project' and run in extended mode",
                                region.region_id
                            ));
                        }
                    }
                }
            }
        }
    }
    for coupling in problem.couplings.iter().filter(|coupling| coupling.enabled) {
        if region_coupling_is_executable_for_backend(problem, coupling, resolved_backend) {
            continue;
        }
        match coupling.capability_policy {
            CouplingCapabilityPolicyIR::RequireRuntime => {
                errors.push(format!(
                    "coupling '{}' ({}) requires runtime support, but backend='{}' does not yet materialize explicit couplings; planner must not silently drop authored coupling intent",
                    coupling.coupling_id,
                    coupling_kind_label(coupling.kind),
                    resolved_backend.as_str()
                ));
            }
            CouplingCapabilityPolicyIR::AuthoredOnly => {
                errors.push(format!(
                    "coupling '{}' ({}) is authored_only and cannot be used in strict executable planning; use an authoring/export path or a backend with coupling runtime support",
                    coupling.coupling_id,
                    coupling_kind_label(coupling.kind)
                ));
            }
        }
    }
}

fn coupling_kind_label(kind: CouplingKindIR) -> &'static str {
    match kind {
        CouplingKindIR::Exchange => "exchange",
        CouplingKindIR::Rkky => "rkky",
        CouplingKindIR::InterlayerExchange => "interlayer_exchange",
    }
}

fn region_coupling_is_executable_for_backend(
    problem: &ProblemIR,
    coupling: &fullmag_ir::CouplingIR,
    resolved_backend: BackendTarget,
) -> bool {
    if resolved_backend != BackendTarget::Fdm
        || !runtime_requests_cuda(problem)
        || coupling.capability_policy != CouplingCapabilityPolicyIR::RequireRuntime
    {
        return false;
    }
    if coupling.kind != CouplingKindIR::Exchange {
        return false;
    }
    if !matches!(coupling.source, CouplingEndpointIR::Region { .. })
        || !matches!(coupling.target, CouplingEndpointIR::Region { .. })
    {
        return false;
    }
    match &coupling.parameters {
        CouplingParametersIR::Exchange {
            mode: ExchangeCouplingModeIR::Explicit,
            inter_exchange: Some(value),
            ..
        } => value.is_finite() && *value >= 0.0,
        CouplingParametersIR::Exchange {
            mode: ExchangeCouplingModeIR::Disabled,
            ..
        } => true,
        CouplingParametersIR::Exchange {
            mode: ExchangeCouplingModeIR::HarmonicMean,
            scale,
            ..
        } => scale.is_none_or(|value| value.is_finite() && value >= 0.0),
        _ => false,
    }
}

pub(crate) struct PlannedStudyControls {
    pub(crate) requested_integrator: Option<fullmag_ir::RequestedIntegratorIR>,
    pub(crate) integrator: Option<IntegratorChoice>,
    pub(crate) fixed_timestep: Option<f64>,
    pub(crate) gyromagnetic_ratio: f64,
    pub(crate) relaxation: Option<RelaxationControlIR>,
    pub(crate) adaptive_timestep: Option<fullmag_ir::AdaptiveTimeStepIR>,
    pub(crate) field_refresh: Option<FieldRefreshPolicyIR>,
}

pub(crate) fn planned_study_controls(
    problem: &ProblemIR,
    resolved_backend: BackendTarget,
    errors: &mut Vec<String>,
) -> PlannedStudyControls {
    validate_conservative_relaxation(problem, errors);
    let uses_time_integrator = matches!(
        problem.study,
        fullmag_ir::StudyIR::TimeEvolution { .. }
            | fullmag_ir::StudyIR::Hysteresis { .. }
            | fullmag_ir::StudyIR::Relaxation {
                algorithm: RelaxationAlgorithmIR::LlgOverdamped,
                ..
            }
    );
    let dynamics = problem.study.optional_dynamics();

    // Parse user-specified integrator string → Option<IntegratorChoice>.
    // "auto" resolves to None, which triggers per-study-kind default selection.
    let requested_integrator = if uses_time_integrator {
        match dynamics.expect("validated time-integrating study must define dynamics") {
            fullmag_ir::DynamicsIR::Llg { integrator, .. } => match integrator.as_str() {
                "heun" => Some(fullmag_ir::RequestedIntegratorIR::Heun),
                "rk4" => Some(fullmag_ir::RequestedIntegratorIR::Rk4),
                "rk23" => Some(fullmag_ir::RequestedIntegratorIR::Rk23),
                "rk45" => Some(fullmag_ir::RequestedIntegratorIR::Rk45),
                "abm3" => Some(fullmag_ir::RequestedIntegratorIR::Abm3),
                "coupled_imex_ark2" => None,
                "auto" => Some(fullmag_ir::RequestedIntegratorIR::Auto),
                other => {
                    errors.push(format!(
                        "integrator '{}' is not supported; use heun/rk4/rk23/rk45/abm3/coupled_imex_ark2/auto",
                        other
                    ));
                    None
                }
            },
        }
    } else {
        None
    };

    let user_integrator = requested_integrator.and_then(|requested| match requested {
        fullmag_ir::RequestedIntegratorIR::Auto => None,
        explicit => Some(match explicit {
            fullmag_ir::RequestedIntegratorIR::Auto => {
                unreachable!("auto has no concrete integrator")
            }
            fullmag_ir::RequestedIntegratorIR::Heun => IntegratorChoice::Heun,
            fullmag_ir::RequestedIntegratorIR::Rk4 => IntegratorChoice::Rk4,
            fullmag_ir::RequestedIntegratorIR::Rk23 => IntegratorChoice::Rk23,
            fullmag_ir::RequestedIntegratorIR::Rk45 => IntegratorChoice::Rk45,
            fullmag_ir::RequestedIntegratorIR::Abm3 => IntegratorChoice::Abm3,
        }),
    });

    // Resolve "auto" to the physics-optimal default per study kind.
    // TimeEvolution → RK45 (mumax3's default: Dormand-Prince, 5th-order adaptive).
    // Relaxation    → algorithm.default_integrator() (e.g. LlgOverdamped→RK23).
    let uses_coupled_imex_ark2 = dynamics.is_some_and(|dynamics| match dynamics {
        fullmag_ir::DynamicsIR::Llg { integrator, .. } => integrator == "coupled_imex_ark2",
    });
    let integrator = if uses_time_integrator && !uses_coupled_imex_ark2 {
        user_integrator.or_else(|| match &problem.study {
            fullmag_ir::StudyIR::TimeEvolution { .. } => Some(IntegratorChoice::Rk45),
            fullmag_ir::StudyIR::Relaxation { algorithm, .. } => algorithm.default_integrator(),
            fullmag_ir::StudyIR::Eigenmodes { .. } => Some(IntegratorChoice::Heun),
            fullmag_ir::StudyIR::FrequencyResponse { .. } => unreachable!(
                "frequency response is a direct harmonic solve and has no time integrator"
            ),
            fullmag_ir::StudyIR::Hysteresis { .. } => Some(IntegratorChoice::Heun),
        })
    } else {
        None
    };

    let fixed_timestep = uses_time_integrator
        .then(|| {
            dynamics.and_then(|dynamics| match dynamics {
                fullmag_ir::DynamicsIR::Llg { fixed_timestep, .. } => *fixed_timestep,
            })
        })
        .flatten();

    let gyromagnetic_ratio = dynamics.map_or(2.211e5, |dynamics| match dynamics {
        fullmag_ir::DynamicsIR::Llg {
            gyromagnetic_ratio, ..
        } => *gyromagnetic_ratio,
    });

    let relaxation = problem.study.relaxation().map(|control| {
        match resolved_backend {
            BackendTarget::Fem => {
                if control.algorithm != RelaxationAlgorithmIR::LlgOverdamped
                    && control.algorithm != RelaxationAlgorithmIR::ProjectedGradientBb
                    && control.algorithm != RelaxationAlgorithmIR::NonlinearCg
                    && control.algorithm != RelaxationAlgorithmIR::TangentPlaneImplicit
                {
                    errors.push(format!(
                        "relaxation algorithm '{}' is defined but not yet executable in the current FEM runner; supported FEM relaxation algorithms are 'llg_overdamped', 'projected_gradient_bb', 'nonlinear_cg', and 'tangent_plane_implicit'",
                        control.algorithm.as_str()
                    ));
                }
            }
            BackendTarget::Fdm => {
                if control.algorithm == RelaxationAlgorithmIR::TangentPlaneImplicit {
                    errors.push("relaxation algorithm 'tangent_plane_implicit' is FEM-only; request backend='fem' with execution_mode='extended' for the CPU/MFEM development lane".to_string());
                } else if control.algorithm != RelaxationAlgorithmIR::LlgOverdamped
                    && control.algorithm != RelaxationAlgorithmIR::ProjectedGradientBb
                    && control.algorithm != RelaxationAlgorithmIR::NonlinearCg
                {
                    errors.push(format!(
                        "relaxation algorithm '{}' is defined but not yet executable in the current FDM runner; supported FDM relaxation algorithms are 'llg_overdamped', 'projected_gradient_bb', and 'nonlinear_cg'",
                        control.algorithm.as_str()
                    ));
                }
            }
            _ => {}
        }
        if control.algorithm == RelaxationAlgorithmIR::TangentPlaneImplicit {
            if problem.validation_profile.execution_mode == fullmag_ir::ExecutionMode::Strict {
                errors.push("relaxation algorithm 'tangent_plane_implicit' is development-only and is rejected in execution_mode='strict'".to_string());
            } else if crate::util::runtime_requests_cuda(problem) {
                errors.push("relaxation algorithm 'tangent_plane_implicit' has no GPU implementation; forced GPU execution is unsupported, use the CPU/MFEM development lane".to_string());
            }
        }
        control
    });

    let adaptive_timestep = uses_time_integrator
        .then(|| {
            dynamics.and_then(|dynamics| match dynamics {
                fullmag_ir::DynamicsIR::Llg {
                    adaptive_timestep, ..
                } => adaptive_timestep.clone(),
            })
        })
        .flatten();

    let field_refresh = dynamics.and_then(|dynamics| match dynamics {
        fullmag_ir::DynamicsIR::Llg { field_refresh, .. } => field_refresh.clone(),
    });

    // Validate adaptive/fixed exclusivity and integrator compatibility.
    if uses_time_integrator && adaptive_timestep.is_some() && fixed_timestep.is_some() {
        errors.push("adaptive_timestep and fixed_timestep are mutually exclusive".to_string());
    }
    if uses_time_integrator
        && adaptive_timestep.is_some()
        && !uses_coupled_imex_ark2
        && !matches!(
            integrator,
            Some(IntegratorChoice::Rk23 | IntegratorChoice::Rk45)
        )
    {
        errors.push(format!(
            "adaptive_timestep requires an embedded-error integrator (rk23, rk45), got {:?}",
            integrator,
        ));
    }
    if uses_time_integrator {
        if let Some(adaptive) = adaptive_timestep.as_ref() {
            let requested_device = problem
                .problem_meta
                .runtime_metadata
                .get("runtime_selection")
                .and_then(|selection| selection.get("device"))
                .and_then(serde_json::Value::as_str);
            if resolved_backend == BackendTarget::Fdm
                && !matches!(requested_device, Some("cpu" | "cuda" | "gpu"))
            {
                errors.push("adaptive_timestep on FDM requires explicit runtime_selection.device='cpu'; auto selection cannot silently change the qualified adaptive lane".to_string());
            }
            if resolved_backend == BackendTarget::Fdm
                && matches!(requested_device, Some("cuda" | "gpu"))
            {
                errors.push("adaptive_timestep on FDM CUDA has no executable timestep capability identity; use runtime_selection.device='cpu' until the CUDA adaptive controller ABI is complete".to_string());
            }
            if adaptive.dt_max.is_none() {
                errors.push("adaptive_timestep.dt_max is required; planner will not invent a hidden upper bound".to_string());
            }
            if resolved_backend == BackendTarget::Fdm {
                if adaptive.max_spin_rotation.is_some() {
                    errors.push("adaptive_timestep.max_spin_rotation is unsupported by current FDM execution lanes and cannot be dropped".to_string());
                }
                if adaptive.norm_tolerance.is_some() {
                    errors.push("adaptive_timestep.norm_tolerance is unsupported by current FDM execution lanes and cannot be dropped".to_string());
                }
            }
        }
    }

    PlannedStudyControls {
        requested_integrator,
        integrator,
        fixed_timestep,
        gyromagnetic_ratio,
        relaxation,
        adaptive_timestep,
        field_refresh,
    }
}

fn validate_conservative_relaxation(problem: &ProblemIR, errors: &mut Vec<String>) {
    if !matches!(problem.study, fullmag_ir::StudyIR::Relaxation { .. }) {
        return;
    }
    for module in &problem.spin_torque_modules {
        let name = match module {
            fullmag_ir::SpinTorqueModuleIR::ZhangLi { .. } => "zhang_li",
            fullmag_ir::SpinTorqueModuleIR::Slonczewski { .. } => "slonczewski",
            fullmag_ir::SpinTorqueModuleIR::SpinOrbitTorque { .. } => "spin_orbit_torque",
            fullmag_ir::SpinTorqueModuleIR::PrescribedSot { .. } => "prescribed_sot",
            fullmag_ir::SpinTorqueModuleIR::InterfaceCpp { .. } => "interface_cpp",
            fullmag_ir::SpinTorqueModuleIR::DriftDiffusion { .. } => "drift_diffusion",
            fullmag_ir::SpinTorqueModuleIR::DriftDiffusionSpinTorque { .. } => {
                "drift_diffusion_spin_torque"
            }
        };
        errors.push(format!(
            "relaxation is a conservative equilibrium workflow and rejects nonconservative {name} torque"
        ));
    }
    if problem.current_density.is_some()
        || problem.stt_degree.is_some()
        || problem.stt_beta.is_some()
        || problem.stt_spin_polarization.is_some()
    {
        errors.push(
            "relaxation is a conservative equilibrium workflow and rejects legacy direct spin torque fields"
                .to_string(),
        );
    }
    if problem
        .temperature
        .is_some_and(|temperature| temperature > 0.0)
    {
        errors.push(
            "relaxation is a conservative equilibrium workflow and rejects stochastic thermal noise"
                .to_string(),
        );
    }
    for term in &problem.energy_terms {
        match term {
            fullmag_ir::EnergyTermIR::OerstedCylinder { time_dependence, .. } => {
                if time_dependence
                    .as_ref()
                    .is_some_and(|dependence| !matches!(dependence, fullmag_ir::TimeDependenceIR::Constant))
                {
                    errors.push(
                        "relaxation rejects time-dependent Oersted sources in a conservative equilibrium workflow"
                            .to_string(),
                    );
                }
                errors.push(
                    "relaxation rejects Oersted fields until identical field-energy parity is validated for the selected lane"
                        .to_string(),
                );
            }
            fullmag_ir::EnergyTermIR::OerstedField { .. } => errors.push(
                "relaxation rejects Oersted fields until identical field-energy parity is validated for the selected lane"
                    .to_string(),
            ),
            _ => {}
        }
    }
    for module in &problem.current_modules {
        if let fullmag_ir::CurrentModuleIR::AntennaFieldSource {
            drive, waveform, ..
        } = module
        {
            let time_dependent = waveform
                .as_ref()
                .or_else(|| drive.as_ref().and_then(|drive| drive.waveform.as_ref()))
                .is_some_and(|dependence| {
                    !matches!(dependence, fullmag_ir::TimeDependenceIR::Constant)
                });
            if time_dependent {
                errors.push(
                    "relaxation rejects time-dependent external-field sources in a conservative equilibrium workflow"
                        .to_string(),
                );
            }
        }
    }
}

pub(crate) fn validate_executable_outputs(
    outputs: &[OutputIR],
    enable_exchange: bool,
    enable_demag: bool,
    enable_zeeman: bool,
    enable_oersted: bool,
    enable_h_dmi: bool,
    enable_h_dmi_bulk: bool,
    allow_h_dmi_bulk: bool,
    enable_magnetoelastic: bool,
    enable_thermal: bool,
    enable_antenna_field: bool,
    enable_regional_field_drive: bool,
    enable_spin_transport: bool,
    errors: &mut Vec<String>,
) {
    let allowed_fields = [
        "m",
        "H_ex",
        "H_demag",
        "demag_phi",
        "H_ext",
        "H_eff",
        "H_ani",
        "H_dmi",
        "H_mel",
        "H_therm",
    ];
    let allowed_scalars = [
        "E_ex",
        "E_demag",
        "E_ext",
        "E_ani",
        "E_dmi",
        "E_total",
        "time",
        "step",
        "solver_dt",
        "mx",
        "my",
        "mz",
        "max_dm_dt",
        "max_h_eff",
        "E_mel",
    ];
    let mechanical_fields = ["u", "u_dot", "eps", "sigma"];
    let transport_fields = [
        "V_electric",
        "J_charge",
        "spin_potential",
        "spin_current_tensor",
        "torque_stt",
    ];
    let mechanical_scalars = [
        "E_el",
        "E_kin_el",
        "max_u",
        "max_sigma_vm",
        "elastic_residual_norm",
    ];
    let mut seen = BTreeSet::new();

    for output in outputs {
        match output {
            OutputIR::Field { name, .. }
            | OutputIR::FieldAuto { name, .. }
            | OutputIR::FieldResolvedAuto { name, .. } => {
                if !allowed_fields.contains(&name.as_str())
                    && !mechanical_fields.contains(&name.as_str())
                    && !(enable_oersted && name == "H_oe")
                    && !(enable_antenna_field && name == "H_ant")
                    && !(enable_regional_field_drive && name == "H_drive")
                    && !(allow_h_dmi_bulk && name == "H_dmi_bulk")
                    && !(enable_spin_transport && transport_fields.contains(&name.as_str()))
                {
                    errors.push(format!(
                        "field output '{}' is not executable in the current executable path; allowed fields are m, H_ex, H_demag, demag_phi, H_ext, H_oe, H_dmi, H_dmi_bulk, H_mel, and H_eff",
                        name
                    ));
                } else if name == "H_ex" && !enable_exchange {
                    errors.push("field output 'H_ex' requires Exchange()".to_string());
                } else if name == "H_demag" && !enable_demag {
                    errors.push("field output 'H_demag' requires Demag()".to_string());
                } else if name == "demag_phi" && !enable_demag {
                    errors.push("field output 'demag_phi' requires Demag()".to_string());
                } else if name == "H_ext" && !enable_zeeman {
                    errors.push("field output 'H_ext' requires Zeeman(...)".to_string());
                } else if name == "H_dmi" && !enable_h_dmi {
                    errors.push("field output 'H_dmi' requires InterfacialDmi(...)".to_string());
                } else if name == "H_dmi_bulk" && !enable_h_dmi_bulk {
                    errors.push("field output 'H_dmi_bulk' requires BulkDmi(...)".to_string());
                } else if name == "H_oe" && !enable_oersted {
                    errors.push(
                        "field output 'H_oe' requires OerstedCylinder() or OerstedField(...)"
                            .to_string(),
                    );
                } else if name == "H_mel" && !enable_magnetoelastic {
                    errors.push("field output 'H_mel' requires Magnetoelastic(...)".to_string());
                } else if name == "H_therm" && !enable_thermal {
                    errors.push("field output 'H_therm' requires ThermalNoise(...)".to_string());
                } else if name == "H_ant" && !enable_antenna_field {
                    errors.push(
                        "field output 'H_ant' requires at least one antenna current module"
                            .to_string(),
                    );
                } else if name == "H_drive" && !enable_regional_field_drive {
                    errors.push(
                        "field output 'H_drive' requires at least one RegionalFieldDrive"
                            .to_string(),
                    );
                } else if mechanical_fields.contains(&name.as_str()) {
                    errors.push(format!(
                        "field output '{name}' requires the quasistatic/elastodynamic mechanics solver, which is not executable yet"
                    ));
                }
                if !seen.insert(format!("field:{name}")) {
                    errors.push(format!(
                        "field output '{}' is declared more than once in Phase 1",
                        name
                    ));
                }
            }
            OutputIR::Scalar { name, .. }
            | OutputIR::ScalarAuto { name, .. }
            | OutputIR::ScalarResolvedAuto { name, .. } => {
                if !allowed_scalars.contains(&name.as_str())
                    && !mechanical_scalars.contains(&name.as_str())
                    && !(enable_regional_field_drive && name == "E_drive")
                {
                    errors.push(format!(
                        "scalar output '{}' is not executable in the current executable path; allowed scalars are E_ex, E_demag, E_ext, E_ani, E_dmi, E_mel, E_total, time, step, solver_dt, mx, my, mz, max_dm_dt, and max_h_eff",
                        name
                    ));
                } else if name == "E_ex" && !enable_exchange {
                    errors.push("scalar output 'E_ex' requires Exchange()".to_string());
                } else if name == "E_demag" && !enable_demag {
                    errors.push("scalar output 'E_demag' requires Demag()".to_string());
                } else if name == "E_ext" && !enable_zeeman {
                    errors.push("scalar output 'E_ext' requires Zeeman(...)".to_string());
                } else if name == "E_drive" && !enable_regional_field_drive {
                    errors.push(
                        "scalar output 'E_drive' requires at least one RegionalFieldDrive"
                            .to_string(),
                    );
                } else if name == "E_mel" && !enable_magnetoelastic {
                    errors.push("scalar output 'E_mel' requires Magnetoelastic(...)".to_string());
                } else if mechanical_scalars.contains(&name.as_str()) {
                    errors.push(format!(
                        "scalar output '{name}' requires the quasistatic/elastodynamic mechanics solver, which is not executable yet"
                    ));
                }
                if !seen.insert(format!("scalar:{name}")) {
                    errors.push(format!(
                        "scalar output '{}' is declared more than once in Phase 1",
                        name
                    ));
                }
            }
            OutputIR::Snapshot {
                field, component, ..
            } => {
                if !allowed_fields.contains(&field.as_str())
                    && !mechanical_fields.contains(&field.as_str())
                    && !(enable_oersted && field == "H_oe")
                    && !(enable_antenna_field && field == "H_ant")
                    && !(allow_h_dmi_bulk && field == "H_dmi_bulk")
                {
                    errors.push(format!(
                        "snapshot field '{}' is not executable in the current path; allowed fields are m, H_ex, H_demag, demag_phi, H_ext, H_oe, H_dmi, H_dmi_bulk, and H_eff",
                        field
                    ));
                } else if field == "H_ex" && !enable_exchange {
                    errors.push("snapshot field 'H_ex' requires Exchange()".to_string());
                } else if field == "H_demag" && !enable_demag {
                    errors.push("snapshot field 'H_demag' requires Demag()".to_string());
                } else if field == "demag_phi" && !enable_demag {
                    errors.push("snapshot field 'demag_phi' requires Demag()".to_string());
                } else if field == "H_ext" && !enable_zeeman {
                    errors.push("snapshot field 'H_ext' requires Zeeman(...)".to_string());
                } else if field == "H_dmi" && !enable_h_dmi {
                    errors.push("snapshot field 'H_dmi' requires InterfacialDmi(...)".to_string());
                } else if field == "H_dmi_bulk" && !enable_h_dmi_bulk {
                    errors.push("snapshot field 'H_dmi_bulk' requires BulkDmi(...)".to_string());
                } else if field == "H_oe" && !enable_oersted {
                    errors.push(
                        "snapshot field 'H_oe' requires OerstedCylinder() or OerstedField(...)"
                            .to_string(),
                    );
                } else if field == "H_mel" && !enable_magnetoelastic {
                    errors.push("snapshot field 'H_mel' requires Magnetoelastic(...)".to_string());
                } else if field == "H_therm" && !enable_thermal {
                    errors.push("snapshot field 'H_therm' requires ThermalNoise(...)".to_string());
                } else if field == "H_ant" && !enable_antenna_field {
                    errors.push(
                        "snapshot field 'H_ant' requires at least one antenna current module"
                            .to_string(),
                    );
                } else if mechanical_fields.contains(&field.as_str()) {
                    errors.push(format!(
                        "snapshot field '{field}' requires the quasistatic/elastodynamic mechanics solver, which is not executable yet"
                    ));
                }
                let key = if component == "3D" {
                    format!("snapshot:{field}")
                } else {
                    format!("snapshot:{field}.{component}")
                };
                if !seen.insert(key) {
                    errors.push(format!(
                        "snapshot '{}.{}' is declared more than once",
                        field, component
                    ));
                }
            }
            OutputIR::FrequencyResponseOutput { .. } => errors
                .push("frequency response outputs require StudyIR::FrequencyResponse".to_string()),
            OutputIR::EigenSpectrum { .. }
            | OutputIR::EigenMode { .. }
            | OutputIR::DispersionCurve { .. }
            | OutputIR::EigenDiagnostics { .. } => errors.push(
                "eigenmode outputs require StudyIR::Eigenmodes and the FEM eigen planner"
                    .to_string(),
            ),
            OutputIR::SaveQuantity {
                quantity_id,
                every_seconds,
                ..
            } => {
                if *every_seconds <= 0.0 {
                    errors.push(format!(
                        "save_quantity '{}' must have positive every_seconds",
                        quantity_id
                    ));
                }
                let key = format!("save_quantity:{quantity_id}");
                if !seen.insert(key) {
                    errors.push(format!(
                        "save_quantity '{}' is declared more than once",
                        quantity_id
                    ));
                }
            }
        }
    }
}

pub(crate) fn validate_eigen_outputs(outputs: &[OutputIR], errors: &mut Vec<String>) {
    let mut seen = BTreeSet::new();
    for output in outputs {
        match output {
            OutputIR::EigenSpectrum { quantity } => {
                let key = format!("eigen_spectrum:{quantity}");
                if !seen.insert(key) {
                    errors.push(format!(
                        "eigen spectrum output '{}' is declared more than once",
                        quantity
                    ));
                }
            }
            OutputIR::EigenMode { field, indices } => {
                if indices.is_empty() {
                    errors.push(format!(
                        "eigen mode output '{}' must request at least one index",
                        field
                    ));
                }
                for index in indices {
                    let key = format!("eigen_mode:{field}:{index}");
                    if !seen.insert(key) {
                        errors.push(format!(
                            "eigen mode output '{}' requests mode {} more than once",
                            field, index
                        ));
                    }
                }
            }
            OutputIR::DispersionCurve { name } => {
                let key = format!("dispersion:{name}");
                if !seen.insert(key) {
                    errors.push(format!(
                        "dispersion output '{}' is declared more than once",
                        name
                    ));
                }
            }
            OutputIR::EigenDiagnostics { .. } => {
                let key = "eigen_diagnostics".to_string();
                if !seen.insert(key) {
                    errors.push("eigen diagnostics output is declared more than once".to_string());
                }
            }
            OutputIR::FrequencyResponseOutput { .. }
            | OutputIR::Field { .. }
            | OutputIR::FieldAuto { .. }
            | OutputIR::FieldResolvedAuto { .. }
            | OutputIR::Scalar { .. }
            | OutputIR::ScalarAuto { .. }
            | OutputIR::ScalarResolvedAuto { .. }
            | OutputIR::Snapshot { .. }
            | OutputIR::SaveQuantity { .. } => {
                errors.push(
                    "StudyIR::Eigenmodes supports only eigen_spectrum, eigen_mode, dispersion_curve, and eigen_diagnostics outputs"
                        .to_string(),
                );
            }
        }
    }
}

pub(crate) fn validate_frequency_response_outputs(outputs: &[OutputIR], errors: &mut Vec<String>) {
    let mut seen = BTreeSet::new();
    for output in outputs {
        match output {
            OutputIR::FrequencyResponseOutput { observable } => {
                let key = format!("frequency_response:{observable:?}");
                if !seen.insert(key) {
                    errors.push(format!(
                        "frequency response observable '{observable:?}' is declared more than once"
                    ));
                }
            }
            OutputIR::EigenSpectrum { .. }
            | OutputIR::EigenMode { .. }
            | OutputIR::DispersionCurve { .. }
            | OutputIR::EigenDiagnostics { .. }
            | OutputIR::Field { .. }
            | OutputIR::FieldAuto { .. }
            | OutputIR::FieldResolvedAuto { .. }
            | OutputIR::Scalar { .. }
            | OutputIR::ScalarAuto { .. }
            | OutputIR::ScalarResolvedAuto { .. }
            | OutputIR::Snapshot { .. }
            | OutputIR::SaveQuantity { .. } => {
                errors.push(
                    "StudyIR::FrequencyResponse supports only frequency_response_output entries"
                        .to_string(),
                );
            }
        }
    }
}

pub(crate) fn validate_grid_asset_cell_size(
    asset: &FdmGridAssetIR,
    requested_cell_size: [f64; 3],
    errors: &mut Vec<String>,
) {
    const CELL_TOLERANCE: f64 = 1e-12;
    for axis in 0..3 {
        let requested = requested_cell_size[axis];
        let provided = asset.cell_size[axis];
        if (requested - provided).abs() > CELL_TOLERANCE * requested.max(1.0) {
            let label = ["x", "y", "z"][axis];
            errors.push(format!(
                "fdm_grid_asset for geometry '{}' has cell_size[{label}]={provided:.6e} m, but planner requested {requested:.6e} m",
                asset.geometry_name
            ));
        }
    }
}
