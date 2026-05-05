use fullmag_ir::{ProblemIR, SpinTorqueModuleIR};

use crate::current_transport::ResolvedCurrentTransport;
use crate::error::PlanError;

#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub(crate) enum SpinTorqueExecutableLane {
    Fdm,
    Fem,
}

#[derive(Debug, Clone, Default)]
pub(crate) struct LegacySpinTorqueFields {
    pub current_density: Option<[f64; 3]>,
    pub stt_degree: Option<f64>,
    pub stt_beta: Option<f64>,
    pub stt_spin_polarization: Option<[f64; 3]>,
    pub stt_lambda: Option<f64>,
    pub stt_epsilon_prime: Option<f64>,
    pub stt_thickness: Option<f64>,
    pub stt_fixed_layer_position: Option<String>,
}

impl LegacySpinTorqueFields {
    pub(crate) fn from_problem(problem: &ProblemIR) -> Self {
        Self {
            current_density: problem.current_density,
            stt_degree: problem.stt_degree,
            stt_beta: problem.stt_beta,
            stt_spin_polarization: problem.stt_spin_polarization,
            stt_lambda: problem.stt_lambda,
            stt_epsilon_prime: problem.stt_epsilon_prime,
            stt_thickness: problem.stt_thickness,
            stt_fixed_layer_position: problem.stt_fixed_layer_position.clone(),
        }
    }
}

fn support_matrix_note(lane: SpinTorqueExecutableLane) -> &'static str {
    match lane {
        SpinTorqueExecutableLane::Fdm => {
            "support matrix: slonczewski=reference_executable(cpu)/production_executable(gpu), \
             zhang_li=reference_executable(cpu)/production_executable(gpu), \
             spin_orbit_torque=executable(cpu/gpu), \
             interface_cpp=semantic_only, drift_diffusion=semantic_only"
        }
        SpinTorqueExecutableLane::Fem => {
            "support matrix: slonczewski=production_executable(cpu/gpu native), zhang_li=production_executable(cpu/gpu native), \
             spin_orbit_torque=not_executable_yet, \
             interface_cpp=semantic_only, drift_diffusion=semantic_only"
        }
    }
}

fn ensure_legacy_matches(
    legacy: &LegacySpinTorqueFields,
    resolved: &LegacySpinTorqueFields,
) -> Result<(), PlanError> {
    let mismatch = legacy
        .current_density
        .is_some_and(|value| Some(value) != resolved.current_density)
        || legacy
            .stt_degree
            .is_some_and(|value| Some(value) != resolved.stt_degree)
        || legacy
            .stt_beta
            .is_some_and(|value| Some(value) != resolved.stt_beta)
        || legacy
            .stt_spin_polarization
            .is_some_and(|value| Some(value) != resolved.stt_spin_polarization)
        || legacy
            .stt_lambda
            .is_some_and(|value| Some(value) != resolved.stt_lambda)
        || legacy
            .stt_epsilon_prime
            .is_some_and(|value| Some(value) != resolved.stt_epsilon_prime)
        || legacy
            .stt_thickness
            .is_some_and(|value| Some(value) != resolved.stt_thickness)
        || legacy
            .stt_fixed_layer_position
            .as_ref()
            .is_some_and(|value| Some(value) != resolved.stt_fixed_layer_position.as_ref());
    if mismatch {
        return Err(PlanError {
            reasons: vec![
                "legacy STT fields disagree with spin_torque_modules; keep one canonical source of truth"
                    .to_string(),
            ],
        });
    }
    Ok(())
}

fn resolve_current_density_source(
    current_transports: &[ResolvedCurrentTransport],
    source: &str,
) -> Result<[f64; 3], PlanError> {
    current_transports
        .iter()
        .find(|transport| transport.name == source)
        .map(|transport| transport.current_density)
        .ok_or_else(|| PlanError {
            reasons: vec![format!(
                "spin torque current_source '{}' is not executable on this lane",
                source
            )],
        })
}

pub(crate) fn resolve_legacy_spin_torque(
    problem: &ProblemIR,
    lane: SpinTorqueExecutableLane,
    current_transports: &[ResolvedCurrentTransport],
) -> Result<LegacySpinTorqueFields, PlanError> {
    let legacy = LegacySpinTorqueFields::from_problem(problem);
    if problem.spin_torque_modules.is_empty() {
        return Ok(legacy);
    }

    if problem.spin_torque_modules.len() > 1 {
        return Err(PlanError {
            reasons: vec![format!(
                "spin_torque_modules currently supports only one executable module at a time; found {} modules; {}",
                problem.spin_torque_modules.len(),
                support_matrix_note(lane)
            )],
        });
    }

    let resolved = match &problem.spin_torque_modules[0] {
        SpinTorqueModuleIR::Slonczewski {
            current_density,
            current_source,
            degree,
            spin_polarization,
            lambda_asymmetry,
            epsilon_prime,
            free_layer_thickness_m,
            fixed_layer_position,
        } => LegacySpinTorqueFields {
            current_density: Some(match (current_density, current_source.as_deref()) {
                (Some(current_density), None) => *current_density,
                (None, Some(source)) => resolve_current_density_source(current_transports, source)?,
                _ => unreachable!("ProblemIR validation should enforce exclusive current binding"),
            }),
            stt_degree: Some(*degree),
            stt_beta: None,
            stt_spin_polarization: Some(*spin_polarization),
            stt_lambda: Some(*lambda_asymmetry),
            stt_epsilon_prime: Some(*epsilon_prime),
            stt_thickness: *free_layer_thickness_m,
            stt_fixed_layer_position: fixed_layer_position.clone(),
        },
        SpinTorqueModuleIR::ZhangLi {
            current_density,
            current_source,
            degree,
            beta,
        } => LegacySpinTorqueFields {
            current_density: Some(match (current_density, current_source.as_deref()) {
                (Some(current_density), None) => *current_density,
                (None, Some(source)) => resolve_current_density_source(current_transports, source)?,
                _ => unreachable!("ProblemIR validation should enforce exclusive current binding"),
            }),
            stt_degree: Some(*degree),
            stt_beta: Some(*beta),
            stt_spin_polarization: None,
            stt_lambda: None,
            stt_epsilon_prime: None,
            stt_thickness: None,
            stt_fixed_layer_position: None,
        },
        SpinTorqueModuleIR::InterfaceCpp { .. } => {
            return Err(PlanError {
                reasons: vec![format!(
                    "spin_torque_modules[0]=interface_cpp is semantic_only; {}",
                    support_matrix_note(lane)
                )],
            });
        }
        SpinTorqueModuleIR::DriftDiffusion { .. } => {
            return Err(PlanError {
                reasons: vec![format!(
                    "spin_torque_modules[0]=drift_diffusion is semantic_only; {}",
                    support_matrix_note(lane)
                )],
            });
        }
        SpinTorqueModuleIR::SpinOrbitTorque { .. } => match lane {
            SpinTorqueExecutableLane::Fdm => {
                // SOT uses its own dedicated plan fields (sot_*), not legacy STT fields.
                // Return empty legacy fields; SOT resolution happens via resolve_sot_fields().
                LegacySpinTorqueFields::default()
            }
            SpinTorqueExecutableLane::Fem => {
                return Err(PlanError {
                    reasons: vec![format!(
                        "spin_torque_modules[0]=spin_orbit_torque is not executable on the FEM lane yet; {}",
                        support_matrix_note(lane)
                    )],
                });
            }
        },
    };

    ensure_legacy_matches(&legacy, &resolved)?;
    Ok(resolved)
}

/// Resolved SOT-specific fields for populating the FDM/FEM plan.
#[derive(Debug, Clone, Default)]
pub(crate) struct ResolvedSotFields {
    pub current_density: Option<f64>,
    pub xi_dl: Option<f64>,
    pub xi_fl: Option<f64>,
    pub sigma: Option<[f64; 3]>,
    pub thickness: Option<f64>,
}

/// Extract SOT parameters from the first spin_torque_modules entry if it is SOT.
pub(crate) fn resolve_sot_fields(
    problem: &ProblemIR,
    current_transports: &[ResolvedCurrentTransport],
) -> Result<ResolvedSotFields, PlanError> {
    if problem.spin_torque_modules.is_empty() {
        return Ok(ResolvedSotFields::default());
    }
    match &problem.spin_torque_modules[0] {
        SpinTorqueModuleIR::SpinOrbitTorque {
            charge_current_density_a_per_m2,
            current_source,
            damping_like_efficiency,
            field_like_efficiency,
            spin_polarization,
            ferromagnet_thickness_m,
        } => {
            let je = match (charge_current_density_a_per_m2, current_source.as_deref()) {
                (Some(j), None) => *j,
                (None, Some(source)) => {
                    let transport = current_transports
                        .iter()
                        .find(|t| t.name == source)
                        .ok_or_else(|| PlanError {
                            reasons: vec![format!(
                                "SOT current_source '{}' not found among resolved current transports",
                                source
                            )],
                        })?;
                    // For SOT, use the magnitude of the current density vector
                    let j = transport.current_density;
                    (j[0] * j[0] + j[1] * j[1] + j[2] * j[2]).sqrt()
                }
                _ => {
                    return Err(PlanError {
                        reasons: vec![
                            "SOT requires exactly one of charge_current_density_a_per_m2 or current_source".to_string()
                        ],
                    });
                }
            };
            Ok(ResolvedSotFields {
                current_density: Some(je),
                xi_dl: Some(*damping_like_efficiency),
                xi_fl: Some(*field_like_efficiency),
                sigma: Some(*spin_polarization),
                thickness: Some(*ferromagnet_thickness_m),
            })
        }
        _ => Ok(ResolvedSotFields::default()),
    }
}

#[cfg(test)]
mod tests {
    use super::*;
    use fullmag_ir::ProblemIR;

    #[test]
    fn resolves_single_slonczewski_module_for_fdm() {
        let mut problem = ProblemIR::bootstrap_example();
        problem.spin_torque_modules = vec![SpinTorqueModuleIR::Slonczewski {
            current_density: Some([0.0, 0.0, 5e10]),
            current_source: None,
            degree: 0.4,
            spin_polarization: [0.0, 0.0, 1.0],
            lambda_asymmetry: 1.0,
            epsilon_prime: 0.0,
            free_layer_thickness_m: None,
            fixed_layer_position: None,
        }];
        let resolved =
            resolve_legacy_spin_torque(&problem, SpinTorqueExecutableLane::Fdm, &[]).unwrap();
        assert_eq!(resolved.current_density, Some([0.0, 0.0, 5e10]));
        assert_eq!(resolved.stt_spin_polarization, Some([0.0, 0.0, 1.0]));
        assert_eq!(resolved.stt_lambda, Some(1.0));
    }

    #[test]
    fn rejects_multiple_modules_for_current_executable_lane() {
        let mut problem = ProblemIR::bootstrap_example();
        problem.spin_torque_modules = vec![
            SpinTorqueModuleIR::ZhangLi {
                current_density: Some([1e11, 0.0, 0.0]),
                current_source: None,
                degree: 0.4,
                beta: 0.02,
            },
            SpinTorqueModuleIR::Slonczewski {
                current_density: Some([0.0, 0.0, 5e10]),
                current_source: None,
                degree: 0.4,
                spin_polarization: [0.0, 0.0, 1.0],
                lambda_asymmetry: 1.0,
                epsilon_prime: 0.0,
                free_layer_thickness_m: None,
                fixed_layer_position: None,
            },
        ];
        let err =
            resolve_legacy_spin_torque(&problem, SpinTorqueExecutableLane::Fdm, &[]).unwrap_err();
        assert!(err
            .reasons
            .iter()
            .any(|reason| reason.contains("only one executable module at a time")));
    }

    #[test]
    fn resolves_zhang_li_module_for_fem_lane() {
        let mut problem = ProblemIR::bootstrap_example();
        problem.spin_torque_modules = vec![SpinTorqueModuleIR::ZhangLi {
            current_density: Some([1e11, 0.0, 0.0]),
            current_source: None,
            degree: 0.4,
            beta: 0.02,
        }];
        let resolved =
            resolve_legacy_spin_torque(&problem, SpinTorqueExecutableLane::Fem, &[]).unwrap();
        assert_eq!(resolved.current_density, Some([1e11, 0.0, 0.0]));
        assert_eq!(resolved.stt_beta, Some(0.02));
    }

    #[test]
    fn resolves_named_current_source_for_fdm() {
        let mut problem = ProblemIR::bootstrap_example();
        problem.spin_torque_modules = vec![SpinTorqueModuleIR::ZhangLi {
            current_density: None,
            current_source: Some("drive".to_string()),
            degree: 0.4,
            beta: 0.02,
        }];
        let resolved = resolve_legacy_spin_torque(
            &problem,
            SpinTorqueExecutableLane::Fdm,
            &[ResolvedCurrentTransport {
                name: "drive".to_string(),
                current_density: [1e11, 0.0, 0.0],
                solve_region: None,
            }],
        )
        .unwrap();
        assert_eq!(resolved.current_density, Some([1e11, 0.0, 0.0]));
    }

    #[test]
    fn resolves_named_current_source_for_fem() {
        let mut problem = ProblemIR::bootstrap_example();
        problem.spin_torque_modules = vec![SpinTorqueModuleIR::Slonczewski {
            current_density: None,
            current_source: Some("drive".to_string()),
            degree: 0.4,
            spin_polarization: [0.0, 0.0, 1.0],
            lambda_asymmetry: 1.0,
            epsilon_prime: 0.0,
            free_layer_thickness_m: None,
            fixed_layer_position: None,
        }];
        let resolved = resolve_legacy_spin_torque(
            &problem,
            SpinTorqueExecutableLane::Fem,
            &[ResolvedCurrentTransport {
                name: "drive".to_string(),
                current_density: [0.0, 0.0, 5e10],
                solve_region: Some("pillar".to_string()),
            }],
        )
        .unwrap();
        assert_eq!(resolved.current_density, Some([0.0, 0.0, 5e10]));
        assert_eq!(resolved.stt_spin_polarization, Some([0.0, 0.0, 1.0]));
    }

    #[test]
    fn legacy_match_checks_slonczewski_thickness_and_position() {
        let mut problem = ProblemIR::bootstrap_example();
        problem.current_density = Some([0.0, 0.0, 5e10]);
        problem.stt_degree = Some(0.4);
        problem.stt_spin_polarization = Some([0.0, 0.0, 1.0]);
        problem.stt_lambda = Some(1.0);
        problem.stt_thickness = Some(1.5e-9);
        problem.stt_fixed_layer_position = Some("bottom".to_string());
        problem.spin_torque_modules = vec![SpinTorqueModuleIR::Slonczewski {
            current_density: Some([0.0, 0.0, 5e10]),
            current_source: None,
            degree: 0.4,
            spin_polarization: [0.0, 0.0, 1.0],
            lambda_asymmetry: 1.0,
            epsilon_prime: 0.0,
            free_layer_thickness_m: Some(2.0e-9),
            fixed_layer_position: Some("top".to_string()),
        }];

        let err =
            resolve_legacy_spin_torque(&problem, SpinTorqueExecutableLane::Fdm, &[]).unwrap_err();
        assert!(err
            .reasons
            .iter()
            .any(|reason| reason.contains("legacy STT fields disagree")));
    }

    #[test]
    fn rejects_spin_orbit_torque_for_fem_lane() {
        let mut problem = ProblemIR::bootstrap_example();
        problem.spin_torque_modules = vec![SpinTorqueModuleIR::SpinOrbitTorque {
            charge_current_density_a_per_m2: Some(5.0e10),
            current_source: None,
            damping_like_efficiency: 0.12,
            field_like_efficiency: 0.01,
            spin_polarization: [0.0, 1.0, 0.0],
            ferromagnet_thickness_m: 1.5e-9,
        }];

        let err =
            resolve_legacy_spin_torque(&problem, SpinTorqueExecutableLane::Fem, &[]).unwrap_err();
        assert!(err
            .reasons
            .iter()
            .any(|reason| reason.contains("spin_orbit_torque is not executable on the FEM lane")));
    }
}
