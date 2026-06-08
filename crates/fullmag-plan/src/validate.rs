use fullmag_ir::{
    BackendTarget, CouplingCapabilityPolicyIR, CouplingEndpointIR, CouplingKindIR,
    CouplingParametersIR, ExchangeCouplingModeIR, FdmGridAssetIR, FieldRefreshPolicyIR,
    IntegratorChoice, OutputIR, ProblemIR, RegionRealizationPolicyIR, RelaxationAlgorithmIR,
    RelaxationControlIR,
};
use std::collections::BTreeSet;

use crate::util::runtime_requests_cuda;

pub(crate) fn resolve_auto_backend(problem: &ProblemIR) -> BackendTarget {
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
            let has_sharp_override =
                region.material_overrides.iter().any(|over| {
                    matches!(
                        over.parameter,
                        fullmag_ir::MaterialParameterNameIR::Ms
                            | fullmag_ir::MaterialParameterNameIR::Aex
                    ) && matches!(
                        over.value,
                        fullmag_ir::MaterialParameterFieldIR::Constant { .. }
                    )
                }) || problem.material_parameter_fields.iter().any(|assignment| {
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
                });

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
                    "coupling '{}' ({:?}) requires runtime support, but backend='{}' does not yet materialize explicit couplings; planner must not silently drop authored coupling intent",
                    coupling.coupling_id,
                    coupling.kind,
                    resolved_backend.as_str()
                ));
            }
            CouplingCapabilityPolicyIR::AuthoredOnly => {
                errors.push(format!(
                    "coupling '{}' ({:?}) is authored_only and cannot be used in strict executable planning; use an authoring/export path or a backend with coupling runtime support",
                    coupling.coupling_id,
                    coupling.kind
                ));
            }
        }
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

pub(crate) fn planned_study_controls(
    problem: &ProblemIR,
    resolved_backend: BackendTarget,
    errors: &mut Vec<String>,
) -> (
    IntegratorChoice,
    Option<f64>,
    f64,
    Option<RelaxationControlIR>,
    Option<fullmag_ir::AdaptiveTimeStepIR>,
    Option<FieldRefreshPolicyIR>,
) {
    // Parse user-specified integrator string → Option<IntegratorChoice>.
    // "auto" resolves to None, which triggers per-study-kind default selection.
    let user_integrator = match problem.study.dynamics() {
        fullmag_ir::DynamicsIR::Llg { integrator, .. } => match integrator.as_str() {
            "heun" => Some(IntegratorChoice::Heun),
            "rk4" => Some(IntegratorChoice::Rk4),
            "rk23" => Some(IntegratorChoice::Rk23),
            "rk45" => Some(IntegratorChoice::Rk45),
            "abm3" => Some(IntegratorChoice::Abm3),
            "auto" => None,
            other => {
                errors.push(format!(
                    "integrator '{}' is not supported; use heun/rk4/rk23/rk45/abm3/auto",
                    other
                ));
                None
            }
        },
    };

    // Resolve "auto" to the physics-optimal default per study kind.
    // TimeEvolution → RK45 (mumax3's default: Dormand-Prince, 5th-order adaptive).
    // Relaxation    → algorithm.default_integrator() (e.g. LlgOverdamped→RK23).
    let integrator = match user_integrator {
        Some(choice) => choice,
        None => match &problem.study {
            fullmag_ir::StudyIR::TimeEvolution { .. } => IntegratorChoice::Rk45,
            fullmag_ir::StudyIR::Relaxation { algorithm, .. } => algorithm.default_integrator(),
            fullmag_ir::StudyIR::Eigenmodes { .. } => IntegratorChoice::Heun,
            fullmag_ir::StudyIR::FrequencyResponse { .. } => IntegratorChoice::Heun,
        },
    };

    let fixed_timestep = match problem.study.dynamics() {
        fullmag_ir::DynamicsIR::Llg { fixed_timestep, .. } => *fixed_timestep,
    };

    let gyromagnetic_ratio = match problem.study.dynamics() {
        fullmag_ir::DynamicsIR::Llg {
            gyromagnetic_ratio, ..
        } => *gyromagnetic_ratio,
    };

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
                    errors.push(
                        "relaxation algorithm 'tangent_plane_implicit' is FEM-only and under development in the current public runner; it is not production-qualified. Request backend='fem' only for development-scale native MFEM tangent-plane implicit checks"
                            .to_string(),
                    );
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
        control
    });

    let adaptive_timestep = match problem.study.dynamics() {
        fullmag_ir::DynamicsIR::Llg {
            adaptive_timestep, ..
        } => adaptive_timestep.clone(),
    };

    let field_refresh = match problem.study.dynamics() {
        fullmag_ir::DynamicsIR::Llg { field_refresh, .. } => field_refresh.clone(),
    };

    // Validate adaptive/fixed exclusivity and integrator compatibility.
    if adaptive_timestep.is_some() && fixed_timestep.is_some() {
        errors.push("adaptive_timestep and fixed_timestep are mutually exclusive".to_string());
    }
    if adaptive_timestep.is_some()
        && !matches!(integrator, IntegratorChoice::Rk23 | IntegratorChoice::Rk45)
    {
        errors.push(format!(
            "adaptive_timestep requires an embedded-error integrator (rk23, rk45), got {:?}",
            integrator,
        ));
    }

    (
        integrator,
        fixed_timestep,
        gyromagnetic_ratio,
        relaxation,
        adaptive_timestep,
        field_refresh,
    )
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
    enable_antenna_field: bool,
    errors: &mut Vec<String>,
) {
    let allowed_fields = [
        "m", "H_ex", "H_demag", "H_ext", "H_eff", "H_ani", "H_dmi", "H_mel",
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
            OutputIR::Field { name, .. } => {
                if !allowed_fields.contains(&name.as_str())
                    && !mechanical_fields.contains(&name.as_str())
                    && !(enable_oersted && name == "H_OE")
                    && !(enable_antenna_field && name == "H_ant")
                    && !(allow_h_dmi_bulk && name == "H_dmi_bulk")
                {
                    errors.push(format!(
                        "field output '{}' is not executable in the current executable path; allowed fields are m, H_ex, H_demag, H_ext, H_OE, H_dmi, H_dmi_bulk, H_mel, and H_eff",
                        name
                    ));
                } else if name == "H_ex" && !enable_exchange {
                    errors.push("field output 'H_ex' requires Exchange()".to_string());
                } else if name == "H_demag" && !enable_demag {
                    errors.push("field output 'H_demag' requires Demag()".to_string());
                } else if name == "H_ext" && !enable_zeeman {
                    errors.push("field output 'H_ext' requires Zeeman(...)".to_string());
                } else if name == "H_dmi" && !enable_h_dmi {
                    errors.push("field output 'H_dmi' requires InterfacialDmi(...)".to_string());
                } else if name == "H_dmi_bulk" && !enable_h_dmi_bulk {
                    errors.push("field output 'H_dmi_bulk' requires BulkDmi(...)".to_string());
                } else if name == "H_OE" && !enable_oersted {
                    errors.push(
                        "field output 'H_OE' requires OerstedCylinder() or OerstedField(...)"
                            .to_string(),
                    );
                } else if name == "H_mel" && !enable_magnetoelastic {
                    errors.push("field output 'H_mel' requires Magnetoelastic(...)".to_string());
                } else if name == "H_ant" && !enable_antenna_field {
                    errors.push(
                        "field output 'H_ant' requires at least one antenna current module"
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
            OutputIR::Scalar { name, .. } => {
                if !allowed_scalars.contains(&name.as_str())
                    && !mechanical_scalars.contains(&name.as_str())
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
                    && !(enable_oersted && field == "H_OE")
                    && !(enable_antenna_field && field == "H_ant")
                    && !(allow_h_dmi_bulk && field == "H_dmi_bulk")
                {
                    errors.push(format!(
                        "snapshot field '{}' is not executable in the current path; allowed fields are m, H_ex, H_demag, H_ext, H_OE, H_dmi, H_dmi_bulk, and H_eff",
                        field
                    ));
                } else if field == "H_ex" && !enable_exchange {
                    errors.push("snapshot field 'H_ex' requires Exchange()".to_string());
                } else if field == "H_demag" && !enable_demag {
                    errors.push("snapshot field 'H_demag' requires Demag()".to_string());
                } else if field == "H_ext" && !enable_zeeman {
                    errors.push("snapshot field 'H_ext' requires Zeeman(...)".to_string());
                } else if field == "H_dmi" && !enable_h_dmi {
                    errors.push("snapshot field 'H_dmi' requires InterfacialDmi(...)".to_string());
                } else if field == "H_dmi_bulk" && !enable_h_dmi_bulk {
                    errors.push("snapshot field 'H_dmi_bulk' requires BulkDmi(...)".to_string());
                } else if field == "H_OE" && !enable_oersted {
                    errors.push(
                        "snapshot field 'H_OE' requires OerstedCylinder() or OerstedField(...)"
                            .to_string(),
                    );
                } else if field == "H_mel" && !enable_magnetoelastic {
                    errors.push("snapshot field 'H_mel' requires Magnetoelastic(...)".to_string());
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
            | OutputIR::Scalar { .. }
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
