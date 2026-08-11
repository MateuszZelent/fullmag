use fullmag_ir::{
    PrescribedSotFormulaIR, PrescribedSotV1DriveIR, ProblemIR, RegionRefIR, SpinTorqueModuleIR,
    TimeEnvelopeIR,
};

use crate::current_transport::ResolvedCurrentTransport;
use crate::error::PlanError;
use crate::physics_graph::physics_module_execution_enabled;

fn normalized_axis(axis: [f64; 3]) -> Option<[f64; 3]> {
    let scale = axis.iter().map(|value| value.abs()).fold(0.0, f64::max);
    if !scale.is_finite() || scale == 0.0 {
        return None;
    }
    let scaled = [axis[0] / scale, axis[1] / scale, axis[2] / scale];
    let norm = (scaled[0] * scaled[0] + scaled[1] * scaled[1] + scaled[2] * scaled[2]).sqrt();
    if !norm.is_finite() || norm == 0.0 {
        return None;
    }
    Some([scaled[0] / norm, scaled[1] / norm, scaled[2] / norm])
}

#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub(crate) enum SpinTorqueExecutableLane {
    Fdm,
    Fem,
}

#[derive(Debug, Clone, Default)]
pub(crate) struct LegacySpinTorqueFields {
    pub slonczewski_formula_version: Option<String>,
    pub slonczewski_target: Option<RegionRefIR>,
    pub slonczewski_stack_normal: Option<[f64; 3]>,
    pub slonczewski_realization_version: Option<String>,
    pub zhang_li_formula_version: Option<String>,
    pub zhang_li_operator_version: Option<String>,
    pub zhang_li_target: Option<RegionRefIR>,
    pub zhang_li_lande_g: Option<f64>,
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
            slonczewski_formula_version: None,
            slonczewski_target: None,
            slonczewski_stack_normal: None,
            slonczewski_realization_version: None,
            zhang_li_formula_version: None,
            zhang_li_operator_version: None,
            zhang_li_target: None,
            zhang_li_lande_g: None,
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
             spin_orbit_torque=reference_executable(cpu native)/semantic_only(gpu), \
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

fn spin_torque_module_id(module: &SpinTorqueModuleIR) -> Option<&str> {
    match module {
        SpinTorqueModuleIR::Slonczewski { id, .. } | SpinTorqueModuleIR::ZhangLi { id, .. } => {
            id.as_deref()
        }
        SpinTorqueModuleIR::DriftDiffusionSpinTorque { id, .. }
        | SpinTorqueModuleIR::PrescribedSot { id, .. } => Some(id),
        SpinTorqueModuleIR::InterfaceCpp { .. }
        | SpinTorqueModuleIR::DriftDiffusion { .. }
        | SpinTorqueModuleIR::SpinOrbitTorque { .. } => None,
    }
}

pub(crate) fn executable_spin_torque_modules<'a>(
    problem: &'a ProblemIR,
) -> Result<Vec<&'a SpinTorqueModuleIR>, PlanError> {
    if problem.physics_graph.is_none() {
        return Ok(problem.spin_torque_modules.iter().collect());
    }
    let mut executable = Vec::new();
    let mut reasons = Vec::new();
    for (index, module) in problem.spin_torque_modules.iter().enumerate() {
        let Some(id) = spin_torque_module_id(module) else {
            reasons.push(format!(
                "spin_torque_modules[{index}] requires a stable id when physics_graph is present"
            ));
            continue;
        };
        match physics_module_execution_enabled(problem, "spin_torque", id) {
            Ok(Some(true)) => executable.push(module),
            Ok(Some(false)) => {}
            Ok(None) => unreachable!("physics_graph presence checked above"),
            Err(graph_reasons) => reasons.extend(graph_reasons),
        }
    }
    if reasons.is_empty() {
        Ok(executable)
    } else {
        Err(PlanError { reasons })
    }
}

pub(crate) fn has_active_spin_torque_modules(problem: &ProblemIR) -> Result<bool, PlanError> {
    executable_spin_torque_modules(problem).map(|modules| !modules.is_empty())
}

pub(crate) fn resolve_legacy_spin_torque(
    problem: &ProblemIR,
    lane: SpinTorqueExecutableLane,
    current_transports: &[ResolvedCurrentTransport],
) -> Result<LegacySpinTorqueFields, PlanError> {
    let legacy = LegacySpinTorqueFields::from_problem(problem);
    let modules = executable_spin_torque_modules(problem)?;
    if modules.is_empty() {
        return Ok(if problem.physics_graph.is_some() {
            LegacySpinTorqueFields::default()
        } else {
            legacy
        });
    }

    if modules.len() > 1 {
        return Err(PlanError {
            reasons: vec![format!(
                "spin_torque_modules currently supports only one executable module at a time; found {} modules; {}",
                modules.len(),
                support_matrix_note(lane)
            )],
        });
    }

    let resolved = match modules[0] {
        SpinTorqueModuleIR::Slonczewski {
            target,
            formula_version,
            current_density,
            current_source,
            degree,
            spin_polarization,
            stack_normal,
            lambda_asymmetry,
            epsilon_prime,
            free_layer_thickness_m,
            fixed_layer_position,
            realization,
            ..
        } => {
            if matches!(
                realization,
                Some(fullmag_ir::SlonczewskiRealizationIR::InterfaceFlux {
                    realization_version,
                    ..
                }) if realization_version == "slonczewski_interface_flux.v1"
            ) {
                let reason = match lane {
                    SpinTorqueExecutableLane::Fdm => "slonczewski_interface_flux.v1 is not executable on FDM; use the thin-layer homogenized realization",
                    SpinTorqueExecutableLane::Fem => "slonczewski_interface_flux.v1 is fail_closed on FEM until a dedicated oriented surface functional is implemented; bulk 1/t lowering is prohibited",
                };
                return Err(PlanError {
                    reasons: vec![reason.to_string()],
                });
            }
            if formula_version == "slonczewski.fullmag.v1" {
                return Err(PlanError {
                    reasons: vec![
                        "slonczewski.fullmag.v1 is read-only provenance; use slonczewski.fullmag.v2 for new runs"
                            .to_string(),
                    ],
                });
            }
            let canonical = formula_version == "slonczewski.fullmag.v2";
            let normalized_polarization = if canonical {
                normalized_axis(*spin_polarization).ok_or_else(|| PlanError {
                    reasons: vec![
                        "canonical Slonczewski spin_polarization must be a finite nonzero axis"
                            .to_string(),
                    ],
                })?
            } else {
                *spin_polarization
            };
            let normalized_stack = if canonical {
                Some(
                    normalized_axis(stack_normal.ok_or_else(|| PlanError {
                        reasons: vec!["canonical Slonczewski requires stack_normal".to_string()],
                    })?)
                    .ok_or_else(|| PlanError {
                        reasons: vec![
                            "canonical Slonczewski stack_normal must be a finite nonzero axis"
                                .to_string(),
                        ],
                    })?,
                )
            } else {
                *stack_normal
            };
            LegacySpinTorqueFields {
                slonczewski_formula_version: Some(formula_version.clone()),
                slonczewski_target: target.clone(),
                slonczewski_stack_normal: normalized_stack,
                slonczewski_realization_version: realization.as_ref().map(|realization| {
                    match realization {
                        fullmag_ir::SlonczewskiRealizationIR::ThinLayerHomogenized {
                            realization_version,
                        }
                        | fullmag_ir::SlonczewskiRealizationIR::InterfaceFlux {
                            realization_version,
                            ..
                        } => realization_version.clone(),
                    }
                }),
                zhang_li_formula_version: None,
                zhang_li_operator_version: None,
                zhang_li_target: None,
                zhang_li_lande_g: None,
                current_density: Some(match (current_density, current_source.as_deref()) {
                    (Some(current_density), None) => *current_density,
                    (None, Some(source)) => {
                        resolve_current_density_source(current_transports, source)?
                    }
                    _ => {
                        unreachable!(
                            "ProblemIR validation should enforce exclusive current binding"
                        )
                    }
                }),
                stt_degree: Some(*degree),
                stt_beta: None,
                stt_spin_polarization: Some(normalized_polarization),
                stt_lambda: Some(*lambda_asymmetry),
                stt_epsilon_prime: Some(*epsilon_prime),
                stt_thickness: *free_layer_thickness_m,
                stt_fixed_layer_position: fixed_layer_position.clone(),
            }
        }
        SpinTorqueModuleIR::ZhangLi {
            target,
            formula_version,
            operator_version,
            current_density,
            current_source,
            degree,
            beta,
            lande_g,
            ..
        } => {
            if formula_version == "zhang_li.mumax3.v1" && lane != SpinTorqueExecutableLane::Fdm {
                return Err(PlanError {
                    reasons: vec![
                        "zhang_li.mumax3.v1 is an FDM MuMax3-compatibility realization; FEM must use zhang_li.fullmag.v1"
                            .to_string(),
                    ],
                });
            }
            if formula_version == "zhang_li.fullmag.v1" && lane == SpinTorqueExecutableLane::Fdm {
                return Err(PlanError {
                    reasons: vec![
                        "zhang_li.fullmag.v1 is the canonical FEM realization and is not executable on FDM; select zhang_li.mumax3.v1 for MuMax3-compatible FDM or use FEM CPU"
                            .to_string(),
                    ],
                });
            }
            LegacySpinTorqueFields {
                slonczewski_formula_version: None,
                slonczewski_target: None,
                slonczewski_stack_normal: None,
                slonczewski_realization_version: None,
                zhang_li_formula_version: Some(formula_version.clone()),
                zhang_li_operator_version: operator_version.clone(),
                zhang_li_target: target.clone(),
                zhang_li_lande_g: *lande_g,
                current_density: Some(match (current_density, current_source.as_deref()) {
                    (Some(current_density), None) => *current_density,
                    (None, Some(source)) => {
                        resolve_current_density_source(current_transports, source)?
                    }
                    _ => unreachable!(
                        "ProblemIR validation should enforce exclusive current binding"
                    ),
                }),
                stt_degree: Some(*degree),
                stt_beta: Some(*beta),
                stt_spin_polarization: None,
                stt_lambda: None,
                stt_epsilon_prime: None,
                stt_thickness: None,
                stt_fixed_layer_position: None,
            }
        }
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
        SpinTorqueModuleIR::DriftDiffusionSpinTorque { .. } => LegacySpinTorqueFields::default(),
        SpinTorqueModuleIR::PrescribedSot { formula, .. } => match (lane, formula) {
            (SpinTorqueExecutableLane::Fem, PrescribedSotFormulaIR::FullmagV1 { .. })
            | (SpinTorqueExecutableLane::Fdm, PrescribedSotFormulaIR::FullmagV1 { .. }) => {
                // Prescribed SOT is resolved separately below so the legacy STT
                // compatibility fields remain empty.  FEM currently owns a
                // native CPU reference realization; the GPU planner/runtime
                // gate remains explicit and fail-closed.
                LegacySpinTorqueFields::default()
            }
            (SpinTorqueExecutableLane::Fdm, PrescribedSotFormulaIR::LegacyFullmagV0 { .. }) => {
                LegacySpinTorqueFields::default()
            }
            (_, PrescribedSotFormulaIR::LegacyFullmagV0 { .. }) => {
                return Err(PlanError {
                    reasons: vec![
                        "spin_torque_modules[0]=prescribed_sot formula_version=prescribed_sot.legacy_fullmag.v0 is compatibility-only and fail_closed for execution"
                            .to_string(),
                    ],
                });
            }
        },
        SpinTorqueModuleIR::SpinOrbitTorque { .. } => {
            return Err(PlanError {
                reasons: vec![format!(
                    "spin_torque_modules[0]=spin_orbit_torque is a deprecated compatibility-only Rust variant and is fail_closed for planning; {}",
                    support_matrix_note(lane)
                )],
            });
        }
    };

    ensure_legacy_matches(&legacy, &resolved)?;
    Ok(resolved)
}

/// Resolved SOT-specific fields for populating the FDM/FEM plan.
#[derive(Debug, Clone, Default)]
pub(crate) struct ResolvedSotFields {
    pub formula_version: Option<&'static str>,
    pub target: Option<RegionRefIR>,
    pub current_density: Option<f64>,
    pub xi_dl: Option<f64>,
    pub xi_fl: Option<f64>,
    pub sigma: Option<[f64; 3]>,
    pub thickness: Option<f64>,
    pub envelope: Option<TimeEnvelopeIR>,
    pub drive: Option<PrescribedSotV1DriveIR>,
}

/// Extract SOT parameters from the first spin_torque_modules entry if it is SOT.
pub(crate) fn resolve_sot_fields(
    problem: &ProblemIR,
    current_transports: &[ResolvedCurrentTransport],
    allow_stage_time_envelope: bool,
) -> Result<ResolvedSotFields, PlanError> {
    let modules = executable_spin_torque_modules(problem)?;
    if modules.is_empty() {
        return Ok(ResolvedSotFields::default());
    }
    match modules[0] {
        SpinTorqueModuleIR::PrescribedSot {
            target: Some(target),
            formula:
                PrescribedSotFormulaIR::FullmagV1 {
                    drive,
                    xi_dl,
                    xi_fl,
                    free_layer_thickness_m,
                },
            ..
        } => {
            let (current_density, sigma) = match drive {
                PrescribedSotV1DriveIR::SignedScalar {
                    current_density_apm2,
                    sigma_hat,
                    envelope,
                } => {
                    match envelope {
                        None | Some(TimeEnvelopeIR::Constant { .. }) => {}
                        Some(_) if allow_stage_time_envelope => {}
                        Some(_) => {
                            return Err(PlanError {
                                reasons: vec![
                                    "prescribed_sot.fullmag.v1 non-constant TimeEnvelope requires_stage_time_execution"
                                        .to_string(),
                                ],
                            });
                        }
                    }
                    (*current_density_apm2, normalize_axis(*sigma_hat))
                }
                PrescribedSotV1DriveIR::VectorCurrentSource {
                    current_source_id,
                    drive_direction,
                    interface_normal,
                } => {
                    let current = resolve_current_density_source(
                        current_transports,
                        current_source_id,
                    )?;
                    let drive_direction = normalize_axis(*drive_direction);
                    let interface_normal = normalize_axis(*interface_normal);
                    let signed_current = dot(current, drive_direction);
                    let sigma = normalize_axis(cross(interface_normal, drive_direction));
                    (signed_current, sigma)
                }
            };
            Ok(ResolvedSotFields {
                formula_version: Some("prescribed_sot.fullmag.v1"),
                target: Some(target.clone()),
                current_density: Some(current_density),
                xi_dl: Some(*xi_dl),
                xi_fl: Some(*xi_fl),
                sigma: Some(sigma),
                thickness: Some(*free_layer_thickness_m),
                envelope: match drive {
                    PrescribedSotV1DriveIR::SignedScalar { envelope, .. } => envelope.clone(),
                    PrescribedSotV1DriveIR::VectorCurrentSource { .. } => None,
                },
                drive: Some(drive.clone()),
            })
        }
        SpinTorqueModuleIR::PrescribedSot {
            target,
            formula:
                PrescribedSotFormulaIR::LegacyFullmagV0 {
                    drive,
                    raw_spin_polarization,
                    xi_dl,
                    xi_fl,
                    free_layer_thickness_m,
                    ..
                },
            ..
        } => {
            if target.is_some() {
                return Err(PlanError {
                    reasons: vec![
                        "prescribed_sot.legacy_fullmag.v0 must retain its historical global target=null"
                            .to_string(),
                    ],
                });
            }
            let current_density = match drive {
                fullmag_ir::PrescribedSotLegacyDriveIR::LegacyScalarMagnitude {
                    raw_charge_current_density_apm2,
                } => *raw_charge_current_density_apm2,
                fullmag_ir::PrescribedSotLegacyDriveIR::LegacyCurrentSourceNorm {
                    current_source_id,
                } => {
                    let current = resolve_current_density_source(
                        current_transports,
                        current_source_id,
                    )?;
                    dot(current, current).sqrt()
                }
            };
            Ok(ResolvedSotFields {
                formula_version: Some("prescribed_sot.legacy_fullmag.v0"),
                target: None,
                current_density: Some(current_density),
                xi_dl: Some(*xi_dl),
                xi_fl: Some(*xi_fl),
                sigma: Some(*raw_spin_polarization),
                thickness: Some(*free_layer_thickness_m),
                envelope: None,
                drive: None,
            })
        }
        SpinTorqueModuleIR::PrescribedSot { target: None, .. } => Err(PlanError {
            reasons: vec![
                "prescribed_sot.fullmag.v1 requires an explicit target before planning"
                    .to_string(),
            ],
        }),
        SpinTorqueModuleIR::SpinOrbitTorque { .. } => Err(PlanError {
            reasons: vec![
                "spin_orbit_torque is a deprecated compatibility-only Rust variant and is fail_closed for SOT field resolution"
                    .to_string(),
            ],
        }),
        _ => Ok(ResolvedSotFields::default()),
    }
}

fn dot(left: [f64; 3], right: [f64; 3]) -> f64 {
    left[0] * right[0] + left[1] * right[1] + left[2] * right[2]
}

fn cross(left: [f64; 3], right: [f64; 3]) -> [f64; 3] {
    [
        left[1] * right[2] - left[2] * right[1],
        left[2] * right[0] - left[0] * right[2],
        left[0] * right[1] - left[1] * right[0],
    ]
}

fn normalize_axis(axis: [f64; 3]) -> [f64; 3] {
    let scale = axis.into_iter().map(f64::abs).fold(0.0, f64::max);
    let scaled = axis.map(|component| component / scale);
    let scaled_norm = dot(scaled, scaled).sqrt();
    scaled.map(|component| component / scaled_norm)
}

#[cfg(test)]
mod tests {
    use super::*;
    use fullmag_ir::{
        PrescribedSotCompatibilityOriginIR, PrescribedSotFormulaIR, PrescribedSotLegacyDriveIR,
        PrescribedSotV1DriveIR, ProblemIR, RegionRefIR,
    };

    #[test]
    fn inactive_graph_module_filters_nonzero_torque_and_legacy_fields() {
        let mut problem = ProblemIR::bootstrap_example();
        problem.current_density = Some([1.0e11, 0.0, 0.0]);
        problem.stt_degree = Some(0.4);
        problem.stt_beta = Some(0.02);
        problem.spin_torque_modules = vec![SpinTorqueModuleIR::ZhangLi {
            schema_version: Some("zhang_li_torque.v1".to_string()),
            id: Some("zl".to_string()),
            target: Some(RegionRefIR {
                object_id: "strip".to_string(),
                region_id: None,
            }),
            formula_version: "zhang_li.fullmag.v1".to_string(),
            operator_version: Some("zl_central_reference_v1".to_string()),
            current_density: Some([1.0e11, 0.0, 0.0]),
            current_source: None,
            degree: 0.4,
            beta: 0.02,
            lande_g: Some(2.1),
        }];
        let family_payload = serde_json::to_value(&problem.spin_torque_modules[0])
            .expect("serialize canonical inactive torque payload");
        problem.physics_graph = Some(serde_json::json!({
            "schema_version": "physics_graph.v1",
            "scene_revision": 1,
            "modules": [{
                "id": "zl",
                "kind": "spin_torque",
                "applies_to": [{"kind": "object", "object_id": "strip"}],
                "solve_domain": [{"object_id": "strip"}],
                "depends_on": [],
                "activation": "inactive",
                "family_payload": family_payload
            }],
            "edges": []
        }));

        let resolved = resolve_legacy_spin_torque(&problem, SpinTorqueExecutableLane::Fdm, &[])
            .expect("inactive torque is omitted");
        assert!(resolved.current_density.is_none());
        assert!(resolved.stt_degree.is_none());
        assert!(resolved.stt_beta.is_none());
        assert!(resolved.zhang_li_formula_version.is_none());
    }

    #[test]
    fn canonical_prescribed_sot_signed_scalar_preserves_current_sign() {
        let mut problem = ProblemIR::bootstrap_example();
        problem.spin_torque_modules = vec![SpinTorqueModuleIR::PrescribedSot {
            schema_version: "prescribed_sot.v1".to_string(),
            id: "sot".to_string(),
            target: Some(RegionRefIR {
                object_id: "strip".to_string(),
                region_id: None,
            }),
            formula: PrescribedSotFormulaIR::FullmagV1 {
                drive: PrescribedSotV1DriveIR::SignedScalar {
                    current_density_apm2: -1.0e10,
                    sigma_hat: [0.0, 1.0, 0.0],
                    envelope: Some(TimeEnvelopeIR::Constant { value: 0.25 }),
                },
                xi_dl: 0.1,
                xi_fl: 0.0,
                free_layer_thickness_m: 1.0e-9,
            },
        }];

        let resolved = resolve_sot_fields(&problem, &[], false)
            .expect("canonical prescribed SOT must lower for FDM execution");
        assert_eq!(resolved.current_density, Some(-1.0e10));
        assert_eq!(
            resolved.envelope,
            Some(TimeEnvelopeIR::Constant { value: 0.25 })
        );
        assert_eq!(resolved.sigma, Some([0.0, 1.0, 0.0]));
        assert_eq!(resolved.xi_dl, Some(0.1));
        assert_eq!(resolved.thickness, Some(1.0e-9));
    }

    #[test]
    fn canonical_prescribed_sot_is_eligible_for_fem_reference_lane() {
        let mut problem = ProblemIR::bootstrap_example();
        problem.spin_torque_modules = vec![SpinTorqueModuleIR::PrescribedSot {
            schema_version: "prescribed_sot.v1".to_string(),
            id: "sot".to_string(),
            target: Some(RegionRefIR {
                object_id: "strip".to_string(),
                region_id: None,
            }),
            formula: PrescribedSotFormulaIR::FullmagV1 {
                drive: PrescribedSotV1DriveIR::SignedScalar {
                    current_density_apm2: 1.0e11,
                    sigma_hat: [0.0, 1.0, 0.0],
                    envelope: None,
                },
                xi_dl: 0.12,
                xi_fl: -0.02,
                free_layer_thickness_m: 1.5e-9,
            },
        }];

        let resolved = resolve_legacy_spin_torque(&problem, SpinTorqueExecutableLane::Fem, &[])
            .expect("canonical prescribed SOT must be eligible for FEM reference lowering");
        assert!(resolved.current_density.is_none());
        assert!(resolved.stt_degree.is_none());
    }

    #[test]
    fn canonical_prescribed_sot_vector_binding_preserves_axes_and_reverses_signed_projection() {
        let mut problem = ProblemIR::bootstrap_example();
        problem.spin_torque_modules = vec![SpinTorqueModuleIR::PrescribedSot {
            schema_version: "prescribed_sot.v1".to_string(),
            id: "sot".to_string(),
            target: Some(RegionRefIR {
                object_id: "strip".to_string(),
                region_id: None,
            }),
            formula: PrescribedSotFormulaIR::FullmagV1 {
                drive: PrescribedSotV1DriveIR::VectorCurrentSource {
                    current_source_id: "drive".to_string(),
                    drive_direction: [2.0, 0.0, 0.0],
                    interface_normal: [0.0, 0.0, 3.0],
                },
                xi_dl: 0.1,
                xi_fl: 0.0,
                free_layer_thickness_m: 1.0e-9,
            },
        }];
        let resolve = |jx| {
            resolve_sot_fields(
                &problem,
                &[ResolvedCurrentTransport {
                    name: "drive".to_string(),
                    current_density: [jx, 4.0e9, 0.0],
                    solve_region: None,
                    time_envelope: None,
                }],
                false,
            )
            .unwrap()
        };
        let positive = resolve(5.0e10);
        let negative = resolve(-5.0e10);
        assert_eq!(positive.current_density, Some(5.0e10));
        assert_eq!(negative.current_density, Some(-5.0e10));
        assert_eq!(positive.sigma, Some([0.0, 1.0, 0.0]));
        assert_eq!(positive.drive, negative.drive);
        assert!(matches!(
            positive.drive,
            Some(PrescribedSotV1DriveIR::VectorCurrentSource {
                current_source_id,
                drive_direction: [2.0, 0.0, 0.0],
                interface_normal: [0.0, 0.0, 3.0],
            }) if current_source_id == "drive"
        ));
    }

    #[test]
    fn legacy_prescribed_sot_formula_preserves_raw_global_evaluator_inputs() {
        let formula = PrescribedSotFormulaIR::LegacyFullmagV0 {
            drive: PrescribedSotLegacyDriveIR::LegacyScalarMagnitude {
                raw_charge_current_density_apm2: -1.0e10,
            },
            raw_spin_polarization: [0.0, 1.0, 0.0],
            xi_dl: 0.1,
            xi_fl: 0.0,
            free_layer_thickness_m: 1.0e-9,
            compatibility_origin: PrescribedSotCompatibilityOriginIR {
                source_ir_version: "0.2.0".to_string(),
                authored_kind: "spin_orbit_torque".to_string(),
            },
        };
        let mut problem = ProblemIR::bootstrap_example();
        problem.spin_torque_modules = vec![SpinTorqueModuleIR::PrescribedSot {
            schema_version: "prescribed_sot.v1".to_string(),
            id: "sot".to_string(),
            target: None,
            formula,
        }];
        let resolved = resolve_sot_fields(&problem, &[], false)
            .expect("legacy prescribed SOT must remain executable without reinterpretation");
        assert_eq!(
            resolved.formula_version,
            Some("prescribed_sot.legacy_fullmag.v0")
        );
        assert_eq!(resolved.current_density, Some(-1.0e10));
        assert_eq!(resolved.sigma, Some([0.0, 1.0, 0.0]));
        assert_eq!(resolved.target, None);
    }

    #[test]
    fn migrated_v0_2_sot_lowers_to_legacy_evaluator_without_changing_raw_inputs() {
        let mut value = serde_json::to_value(ProblemIR::bootstrap_example()).unwrap();
        value["ir_version"] = serde_json::json!("0.2.0");
        value["problem_meta"]["script_api_version"] = serde_json::json!("0.2.0");
        value["problem_meta"]["serializer_version"] = serde_json::json!("0.2.0");
        value["spin_torque_modules"] = serde_json::json!([{
            "kind": "spin_orbit_torque",
            "charge_current_density_a_per_m2": -5.0e10,
            "damping_like_efficiency": 0.12,
            "field_like_efficiency": -0.03,
            "spin_polarization": [0.0, 2.0, 0.0],
            "ferromagnet_thickness_m": 1.5e-9
        }]);
        let problem: ProblemIR = serde_json::from_value(value).expect("0.2 migration");
        let resolved = resolve_sot_fields(&problem, &[], false).expect("legacy lowering");

        assert_eq!(
            resolved.formula_version,
            Some("prescribed_sot.legacy_fullmag.v0")
        );
        assert_eq!(resolved.current_density, Some(-5.0e10));
        assert_eq!(resolved.sigma, Some([0.0, 2.0, 0.0]));
        assert_eq!(resolved.xi_dl, Some(0.12));
        assert_eq!(resolved.xi_fl, Some(-0.03));
        assert_eq!(resolved.target, None);
    }

    #[test]
    fn deprecated_spin_orbit_torque_fails_closed_on_fdm_planner_paths() {
        let mut problem = ProblemIR::bootstrap_example();
        problem.spin_torque_modules = vec![SpinTorqueModuleIR::SpinOrbitTorque {
            charge_current_density_a_per_m2: Some(1.0e10),
            current_source: None,
            damping_like_efficiency: 0.1,
            field_like_efficiency: 0.0,
            spin_polarization: [0.0, 1.0, 0.0],
            ferromagnet_thickness_m: 1.0e-9,
        }];

        let legacy_error = resolve_legacy_spin_torque(&problem, SpinTorqueExecutableLane::Fdm, &[])
            .expect_err("deprecated wire variant must not enter the legacy FDM path");
        assert!(legacy_error
            .reasons
            .iter()
            .any(|reason| reason.contains("deprecated") && reason.contains("fail_closed")));

        let sot_error = resolve_sot_fields(&problem, &[], false)
            .expect_err("deprecated wire variant must not enter SOT field resolution");
        assert!(sot_error
            .reasons
            .iter()
            .any(|reason| reason.contains("deprecated") && reason.contains("fail_closed")));
    }

    #[test]
    fn resolves_single_slonczewski_module_for_fdm() {
        let mut problem = ProblemIR::bootstrap_example();
        problem.spin_torque_modules = vec![SpinTorqueModuleIR::Slonczewski {
            schema_version: None,
            id: None,
            target: None,
            formula_version: "slonczewski.legacy_fullmag.v0".to_string(),
            current_density: Some([0.0, 0.0, 5e10]),
            current_source: None,
            degree: 0.4,
            spin_polarization: [0.0, 0.0, 1.0],
            stack_normal: None,
            lambda_asymmetry: 1.0,
            epsilon_prime: 0.0,
            free_layer_thickness_m: None,
            fixed_layer_position: None,
            realization: None,
        }];
        let resolved =
            resolve_legacy_spin_torque(&problem, SpinTorqueExecutableLane::Fdm, &[]).unwrap();
        assert_eq!(resolved.current_density, Some([0.0, 0.0, 5e10]));
        assert_eq!(resolved.stt_spin_polarization, Some([0.0, 0.0, 1.0]));
        assert_eq!(resolved.stt_lambda, Some(1.0));
    }

    #[test]
    fn canonical_slonczewski_preserves_stack_normal_target_and_signed_current() {
        let mut problem = ProblemIR::bootstrap_example();
        let target = RegionRefIR {
            object_id: "strip".to_string(),
            region_id: None,
        };
        problem.spin_torque_modules = vec![SpinTorqueModuleIR::Slonczewski {
            schema_version: Some("slonczewski_torque.v1".to_string()),
            id: Some("cpp".to_string()),
            target: Some(target.clone()),
            formula_version: "slonczewski.fullmag.v2".to_string(),
            current_density: Some([3.0e10, -4.0e10, 0.0]),
            current_source: None,
            degree: 0.4,
            spin_polarization: [0.0, 0.0, 4.0],
            stack_normal: Some([0.0, 2.0, 0.0]),
            lambda_asymmetry: 1.0,
            epsilon_prime: 0.0,
            free_layer_thickness_m: Some(1.0e-9),
            fixed_layer_position: None,
            realization: Some(fullmag_ir::SlonczewskiRealizationIR::ThinLayerHomogenized {
                realization_version: "slonczewski_thin_layer_homogenized.v1".to_string(),
            }),
        }];
        let resolved = resolve_legacy_spin_torque(&problem, SpinTorqueExecutableLane::Fdm, &[])
            .expect("canonical Slonczewski should resolve");
        assert_eq!(
            resolved.slonczewski_formula_version.as_deref(),
            Some("slonczewski.fullmag.v2")
        );
        assert_eq!(resolved.slonczewski_target, Some(target));
        assert_eq!(resolved.slonczewski_stack_normal, Some([0.0, 1.0, 0.0]));
        assert_eq!(resolved.stt_spin_polarization, Some([0.0, 0.0, 1.0]));
        assert_eq!(resolved.current_density, Some([3.0e10, -4.0e10, 0.0]));
    }

    #[test]
    fn fdm_rejects_canonical_slonczewski_interface_flux_realization() {
        let mut problem = ProblemIR::bootstrap_example();
        problem.spin_torque_modules = vec![SpinTorqueModuleIR::Slonczewski {
            schema_version: Some("slonczewski_torque.v1".to_string()),
            id: Some("cpp_interface".to_string()),
            target: Some(RegionRefIR {
                object_id: "strip".to_string(),
                region_id: None,
            }),
            formula_version: "slonczewski.fullmag.v2".to_string(),
            current_density: Some([0.0, 0.0, 4.0e10]),
            current_source: None,
            degree: 0.4,
            spin_polarization: [0.0, 0.0, 1.0],
            stack_normal: Some([0.0, 0.0, 1.0]),
            lambda_asymmetry: 1.0,
            epsilon_prime: 0.0,
            free_layer_thickness_m: Some(1.0e-9),
            fixed_layer_position: None,
            realization: Some(fullmag_ir::SlonczewskiRealizationIR::InterfaceFlux {
                interface_id: "fixed_to_free".to_string(),
                realization_version: "slonczewski_interface_flux.v1".to_string(),
            }),
        }];

        let error = resolve_legacy_spin_torque(&problem, SpinTorqueExecutableLane::Fdm, &[])
            .expect_err("FDM must not lower interface flux to a homogenized volume torque");
        assert!(error.reasons.iter().any(|reason| {
            reason.contains("slonczewski_interface_flux.v1")
                && reason.contains("not executable on FDM")
        }));
    }

    #[test]
    fn fem_interface_flux_slonczewski_fails_closed_before_bulk_lowering() {
        let mut problem = ProblemIR::bootstrap_example();
        problem.spin_torque_modules = vec![SpinTorqueModuleIR::Slonczewski {
            schema_version: Some("slonczewski_torque.v1".to_string()),
            id: Some("cpp-interface".to_string()),
            target: Some(RegionRefIR {
                object_id: "strip".to_string(),
                region_id: None,
            }),
            formula_version: "slonczewski.fullmag.v2".to_string(),
            current_density: Some([0.0, 0.0, 5e10]),
            current_source: None,
            degree: 0.4,
            spin_polarization: [0.0, 0.0, 1.0],
            stack_normal: Some([0.0, 0.0, 1.0]),
            lambda_asymmetry: 1.0,
            epsilon_prime: 0.0,
            free_layer_thickness_m: None,
            fixed_layer_position: None,
            realization: Some(fullmag_ir::SlonczewskiRealizationIR::InterfaceFlux {
                interface_id: "fixed-to-free".to_string(),
                realization_version: "slonczewski_interface_flux.v1".to_string(),
            }),
        }];

        let err = resolve_legacy_spin_torque(&problem, SpinTorqueExecutableLane::Fem, &[])
            .expect_err("FEM interface flux needs a real surface functional");
        assert!(err.reasons.iter().any(|reason| {
            reason.contains("slonczewski_interface_flux.v1")
                && reason.contains("fail_closed")
                && reason.contains("surface")
        }));
    }

    #[test]
    fn rejects_multiple_modules_for_current_executable_lane() {
        let mut problem = ProblemIR::bootstrap_example();
        problem.spin_torque_modules = vec![
            SpinTorqueModuleIR::ZhangLi {
                schema_version: None,
                id: None,
                target: None,
                formula_version: "zhang_li.legacy_fullmag.v0".to_string(),
                operator_version: None,
                current_density: Some([1e11, 0.0, 0.0]),
                current_source: None,
                degree: 0.4,
                beta: 0.02,
                lande_g: None,
            },
            SpinTorqueModuleIR::Slonczewski {
                schema_version: None,
                id: None,
                target: None,
                formula_version: "slonczewski.legacy_fullmag.v0".to_string(),
                current_density: Some([0.0, 0.0, 5e10]),
                current_source: None,
                degree: 0.4,
                spin_polarization: [0.0, 0.0, 1.0],
                stack_normal: None,
                lambda_asymmetry: 1.0,
                epsilon_prime: 0.0,
                free_layer_thickness_m: None,
                fixed_layer_position: None,
                realization: None,
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
            schema_version: None,
            id: None,
            target: None,
            formula_version: "zhang_li.legacy_fullmag.v0".to_string(),
            operator_version: None,
            current_density: Some([1e11, 0.0, 0.0]),
            current_source: None,
            degree: 0.4,
            beta: 0.02,
            lande_g: None,
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
            schema_version: None,
            id: None,
            target: None,
            formula_version: "zhang_li.legacy_fullmag.v0".to_string(),
            operator_version: None,
            current_density: None,
            current_source: Some("drive".to_string()),
            degree: 0.4,
            beta: 0.02,
            lande_g: None,
        }];
        let resolved = resolve_legacy_spin_torque(
            &problem,
            SpinTorqueExecutableLane::Fdm,
            &[ResolvedCurrentTransport {
                name: "drive".to_string(),
                current_density: [1e11, 0.0, 0.0],
                solve_region: None,
                time_envelope: None,
            }],
        )
        .unwrap();
        assert_eq!(resolved.current_density, Some([1e11, 0.0, 0.0]));
    }

    #[test]
    fn resolves_named_current_source_for_fem() {
        let mut problem = ProblemIR::bootstrap_example();
        problem.spin_torque_modules = vec![SpinTorqueModuleIR::Slonczewski {
            schema_version: None,
            id: None,
            target: None,
            formula_version: "slonczewski.legacy_fullmag.v0".to_string(),
            current_density: None,
            current_source: Some("drive".to_string()),
            degree: 0.4,
            spin_polarization: [0.0, 0.0, 1.0],
            stack_normal: None,
            lambda_asymmetry: 1.0,
            epsilon_prime: 0.0,
            free_layer_thickness_m: None,
            fixed_layer_position: None,
            realization: None,
        }];
        let resolved = resolve_legacy_spin_torque(
            &problem,
            SpinTorqueExecutableLane::Fem,
            &[ResolvedCurrentTransport {
                name: "drive".to_string(),
                current_density: [0.0, 0.0, 5e10],
                solve_region: Some("pillar".to_string()),
                time_envelope: None,
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
            schema_version: None,
            id: None,
            target: None,
            formula_version: "slonczewski.legacy_fullmag.v0".to_string(),
            current_density: Some([0.0, 0.0, 5e10]),
            current_source: None,
            degree: 0.4,
            spin_polarization: [0.0, 0.0, 1.0],
            stack_normal: None,
            lambda_asymmetry: 1.0,
            epsilon_prime: 0.0,
            free_layer_thickness_m: Some(2.0e-9),
            fixed_layer_position: Some("top".to_string()),
            realization: None,
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
            .any(|reason| reason.contains("spin_orbit_torque") && reason.contains("fail_closed")));
    }
}
