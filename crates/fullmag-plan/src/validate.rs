use fullmag_ir::{
    BackendTarget, FdmGridAssetIR, FieldRefreshPolicyIR, IntegratorChoice, OutputIR, ProblemIR,
    RelaxationAlgorithmIR, RelaxationControlIR,
};
use std::collections::BTreeSet;

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

pub(crate) fn planned_study_controls(
    problem: &ProblemIR,
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
        if control.algorithm != RelaxationAlgorithmIR::LlgOverdamped
            && control.algorithm != RelaxationAlgorithmIR::ProjectedGradientBb
            && control.algorithm != RelaxationAlgorithmIR::NonlinearCg
        {
            errors.push(format!(
                "relaxation algorithm '{}' is defined but not yet executable in the current public runner; only 'llg_overdamped', 'projected_gradient_bb', and 'nonlinear_cg' are currently supported",
                control.algorithm.as_str()
            ));
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
    enable_antenna_field: bool,
    errors: &mut Vec<String>,
) {
    let allowed_fields = [
        "m", "H_ex", "H_demag", "H_ext", "H_eff", "H_ani", "H_dmi",
        // Magnetoelastic (semantic-only)
        "H_mel", "u", "u_dot", "eps", "sigma",
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
        // Magnetoelastic (semantic-only)
        "E_mel",
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
                    && !(enable_oersted && name == "H_OE")
                    && !(enable_antenna_field && name == "H_ant")
                {
                    errors.push(format!(
                        "field output '{}' is not executable in the current FDM path; allowed fields are m, H_ex, H_demag, H_ext, H_OE, and H_eff",
                        name
                    ));
                } else if name == "H_ex" && !enable_exchange {
                    errors.push("field output 'H_ex' requires Exchange()".to_string());
                } else if name == "H_demag" && !enable_demag {
                    errors.push("field output 'H_demag' requires Demag()".to_string());
                } else if name == "H_ext" && !enable_zeeman {
                    errors.push("field output 'H_ext' requires Zeeman(...)".to_string());
                } else if name == "H_OE" && !enable_oersted {
                    errors.push(
                        "field output 'H_OE' requires OerstedCylinder() or OerstedField(...)"
                            .to_string(),
                    );
                } else if name == "H_ant" && !enable_antenna_field {
                    errors.push(
                        "field output 'H_ant' requires at least one antenna current module"
                            .to_string(),
                    );
                }
                if !seen.insert(format!("field:{name}")) {
                    errors.push(format!(
                        "field output '{}' is declared more than once in Phase 1",
                        name
                    ));
                }
            }
            OutputIR::Scalar { name, .. } => {
                if !allowed_scalars.contains(&name.as_str()) {
                    errors.push(format!(
                        "scalar output '{}' is not executable in the current FDM path; allowed scalars are E_ex, E_demag, E_ext, E_total, time, step, solver_dt, mx, my, mz, max_dm_dt, and max_h_eff",
                        name
                    ));
                } else if name == "E_ex" && !enable_exchange {
                    errors.push("scalar output 'E_ex' requires Exchange()".to_string());
                } else if name == "E_demag" && !enable_demag {
                    errors.push("scalar output 'E_demag' requires Demag()".to_string());
                } else if name == "E_ext" && !enable_zeeman {
                    errors.push("scalar output 'E_ext' requires Zeeman(...)".to_string());
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
                    && !(enable_oersted && field == "H_OE")
                    && !(enable_antenna_field && field == "H_ant")
                {
                    errors.push(format!(
                        "snapshot field '{}' is not executable in the current path; allowed fields are m, H_ex, H_demag, H_ext, H_OE, and H_eff",
                        field
                    ));
                } else if field == "H_ex" && !enable_exchange {
                    errors.push("snapshot field 'H_ex' requires Exchange()".to_string());
                } else if field == "H_demag" && !enable_demag {
                    errors.push("snapshot field 'H_demag' requires Demag()".to_string());
                } else if field == "H_ext" && !enable_zeeman {
                    errors.push("snapshot field 'H_ext' requires Zeeman(...)".to_string());
                } else if field == "H_OE" && !enable_oersted {
                    errors.push(
                        "snapshot field 'H_OE' requires OerstedCylinder() or OerstedField(...)"
                            .to_string(),
                    );
                } else if field == "H_ant" && !enable_antenna_field {
                    errors.push(
                        "snapshot field 'H_ant' requires at least one antenna current module"
                            .to_string(),
                    );
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
            OutputIR::Field { .. }
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
