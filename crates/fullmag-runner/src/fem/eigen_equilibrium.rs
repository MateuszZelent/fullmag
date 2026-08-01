//! FEM eigen equilibrium materialization and pre-eigen relaxation.

use fullmag_engine::fem::{FemLlgProblem, MeshTopology};
use fullmag_engine::{
    EffectiveFieldObservables, EffectiveFieldTerms, LlgConfig, MaterialParameters, TimeIntegrator,
    Vector3,
};
use fullmag_ir::{EquilibriumSourceIR, FemEigenPlanIR, RelaxationAlgorithmIR, RelaxationControlIR};

use crate::fem::eigen_anisotropy::volume_anisotropy_field;
use crate::fem::eigen_output::resolved_demag_realization;
use crate::relaxation::{RelaxationEnergyPlateauWindow, RelaxationTorqueConfirmation};
use crate::types::{RunError, StepStats};

/// Internal relaxation timestep for equilibrium preparation in eigen analysis.
/// This is not the user's simulation dt; it is a fixed internal parameter used
/// only for pre-eigen relaxation.
const RELAX_DT: f64 = 1e-13;
const RELAX_MAX_STEPS: u64 = 4_000;

pub(crate) fn materialize_equilibrium(
    plan: &FemEigenPlanIR,
    initial_magnetization: &[Vector3],
) -> Result<(FemLlgProblem, Vec<Vector3>, u64, EffectiveFieldObservables), RunError> {
    let mut equilibrium_guess = initial_magnetization.to_vec();
    if let EquilibriumSourceIR::Artifact { path } = &plan.equilibrium {
        equilibrium_guess = load_equilibrium_artifact(path, plan.mesh.nodes.len())?;
    }

    let topology = MeshTopology::from_ir(&plan.mesh).map_err(|error| RunError {
        message: format!("MeshTopology: {}", error),
    })?;
    let material = MaterialParameters::new(
        plan.material.saturation_magnetisation,
        plan.material.exchange_stiffness,
        plan.material.damping,
    )
    .map_err(|error| RunError {
        message: format!("Material: {}", error),
    })?;
    let dynamics = LlgConfig::new(plan.gyromagnetic_ratio, TimeIntegrator::RK23)
        .map_err(|error| RunError {
            message: format!("LLG: {}", error),
        })?
        .with_precession_enabled(false);
    let aniso_per_node: Option<Vec<Vector3>> = {
        let has_uni = plan
            .material
            .uniaxial_anisotropy
            .map_or(false, |k| k.abs() > 0.0);
        let has_cub = plan
            .material
            .cubic_anisotropy_kc1
            .map_or(false, |k| k.abs() > 0.0);
        if has_uni || has_cub {
            Some(
                equilibrium_guess
                    .iter()
                    .map(|m| volume_anisotropy_field(*m, plan))
                    .collect(),
            )
        } else {
            None
        }
    };
    let terms = EffectiveFieldTerms {
        exchange: plan.enable_exchange,
        demag: plan.enable_demag,
        external_field: plan.external_field,
        per_node_field: aniso_per_node,
        magnetoelastic: None,
        uniaxial_anisotropy: None,
        cubic_anisotropy: None,
        interfacial_dmi: None,
        bulk_dmi: None,
        zhang_li_stt: None,
        slonczewski_stt: None,
        sot: None,
        oersted_cylinder: None,
    };
    let resolved_demag = resolved_demag_realization(plan);
    let mut problem = match resolved_demag {
        Some(fullmag_ir::ResolvedFemDemagIR::PoissonRobin) => {
            FemLlgProblem::with_terms_and_demag_airbox(
                topology, material, dynamics, terms, false, None,
            )
        }
        Some(fullmag_ir::ResolvedFemDemagIR::PoissonDirichlet) => {
            FemLlgProblem::with_terms_and_demag_airbox(
                topology, material, dynamics, terms, true, None,
            )
        }
        Some(r) => {
            return Err(RunError {
                message: format!(
                    "FEM eigen runner: demag model '{}' is not yet implemented",
                    r.model_name(),
                ),
            });
        }
        None => FemLlgProblem::with_terms(topology, material, dynamics, terms),
    };
    if let Some(normal) = plan.dmi_interface_normal {
        problem.set_dmi_interface_normal(normal);
    }
    let mut state = problem
        .new_state(equilibrium_guess)
        .map_err(|error| RunError {
            message: format!("State: {}", error),
        })?;

    let mut steps_taken = 0;
    if matches!(plan.equilibrium, EquilibriumSourceIR::RelaxedInitialState) {
        let control = RelaxationControlIR {
            algorithm: RelaxationAlgorithmIR::LlgOverdamped,
            stop: fullmag_ir::RelaxStopIR {
                torque_tolerance_apm: Some(1e-5),
                energy_tolerance_j: Some(1e-12),
                max_steps: Some(RELAX_MAX_STEPS),
                max_pseudotime_s: None,
                max_physical_time_s: None,
            },
        };
        let mut energy_plateau = RelaxationEnergyPlateauWindow::default();
        let mut torque_confirmation = RelaxationTorqueConfirmation::default();
        while steps_taken < RELAX_MAX_STEPS {
            let report = problem
                .step(&mut state, RELAX_DT)
                .map_err(|error| RunError {
                    message: format!("FEM eigen relaxation step {}: {}", steps_taken, error),
                })?;
            steps_taken += 1;
            let stats = StepStats {
                step: steps_taken,
                time: report.time_seconds,
                dt: report.dt_used,
                e_ex: report.exchange_energy_joules,
                e_demag: report.demag_energy_joules,
                e_ext: report.external_energy_joules,
                e_total: report.total_energy_joules,
                max_dm_dt: report.max_rhs_amplitude,
                max_h_eff: report.max_effective_field_amplitude,
                max_h_demag: report.max_demag_field_amplitude,
                ..StepStats::default()
            };
            let energy_plateau_range = energy_plateau.record(report.total_energy_joules);
            if torque_confirmation.observe_stats(
                &control,
                &stats,
                energy_plateau_range,
                plan.gyromagnetic_ratio,
                plan.material.damping,
                true,
            ) {
                break;
            }
        }
    }

    let observables = problem.observe(&state).map_err(|error| RunError {
        message: format!("FEM eigen observables: {}", error),
    })?;
    Ok((
        problem,
        state.magnetization().to_vec(),
        steps_taken,
        observables,
    ))
}

fn load_equilibrium_artifact(path: &str, expected_len: usize) -> Result<Vec<Vector3>, RunError> {
    let raw = std::fs::read_to_string(path).map_err(|error| RunError {
        message: format!("failed to read equilibrium artifact '{}': {}", path, error),
    })?;
    let value: serde_json::Value = serde_json::from_str(&raw).map_err(|error| RunError {
        message: format!("failed to parse equilibrium artifact '{}': {}", path, error),
    })?;
    let values = value
        .get("values")
        .cloned()
        .unwrap_or(value)
        .as_array()
        .cloned()
        .ok_or_else(|| RunError {
            message: format!(
                "equilibrium artifact '{}' must be a JSON array or a field artifact with 'values'",
                path
            ),
        })?;
    if values.len() != expected_len {
        return Err(RunError {
            message: format!(
                "equilibrium artifact '{}' contains {} vectors, expected {}",
                path,
                values.len(),
                expected_len
            ),
        });
    }
    values
        .into_iter()
        .map(|entry| {
            let array = entry.as_array().ok_or_else(|| RunError {
                message: format!(
                    "equilibrium artifact '{}' contains a non-vector entry",
                    path
                ),
            })?;
            if array.len() != 3 {
                return Err(RunError {
                    message: format!("equilibrium artifact '{}' contains a non-3D vector", path),
                });
            }
            Ok([
                array[0].as_f64().unwrap_or(0.0),
                array[1].as_f64().unwrap_or(0.0),
                array[2].as_f64().unwrap_or(0.0),
            ])
        })
        .collect()
}
