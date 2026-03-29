//! CPU reference FEM runner: executes narrow FEM LLG via `fullmag-engine::fem`.
//!
//! Current executable slice:
//! - precomputed `MeshIR`
//! - `Exchange`, optional bootstrap `Demag`, and optional `Zeeman`
//! - `LLG(heun)`
//! - `double` precision

use fullmag_engine::fem::{FemLlgProblem, FemLlgState, MeshTopology};
use fullmag_engine::{
    AdaptiveStepConfig, EffectiveFieldTerms, LlgConfig, MaterialParameters, TimeIntegrator,
};
use fullmag_ir::{ExecutionPrecision, FemPlanIR, IntegratorChoice, OutputIR};

use crate::artifact_pipeline::{ArtifactPipelineSender, ArtifactRecorder};
use crate::preview::{build_mesh_preview_field, flatten_vectors, select_observables};
use crate::relaxation::{llg_overdamped_uses_pure_damping, relaxation_converged};
use crate::scalar_metrics::{
    apply_average_m_to_step_stats, scalar_outputs_request_average_m, scalar_row_due,
};
use crate::schedules::{
    advance_due_schedules, collect_field_schedules, collect_scalar_schedules, is_due, same_time,
    OutputSchedule,
};
use crate::types::{
    ExecutedRun, ExecutionProvenance, FieldSnapshot, LivePreviewRequest, LiveStepConsumer,
    RunError, RunResult, RunStatus, StateObservables, StepAction, StepStats, StepUpdate,
};

use std::time::Instant;

pub(crate) fn execute_reference_fem(
    plan: &FemPlanIR,
    until_seconds: f64,
    outputs: &[OutputIR],
) -> Result<ExecutedRun, RunError> {
    execute_reference_fem_impl(
        plan,
        until_seconds,
        outputs,
        None::<LiveStepConsumer<'_>>,
        None,
    )
}

pub(crate) fn execute_reference_fem_with_callback(
    plan: &FemPlanIR,
    until_seconds: f64,
    outputs: &[OutputIR],
    field_every_n: u64,
    on_step: &mut impl FnMut(StepUpdate) -> StepAction,
) -> Result<ExecutedRun, RunError> {
    execute_reference_fem_impl(
        plan,
        until_seconds,
        outputs,
        Some(LiveStepConsumer {
            grid: [0, 0, 0],
            field_every_n,
            preview_request: None,
            on_step,
        }),
        None,
    )
}

pub(crate) fn execute_reference_fem_with_live_preview(
    plan: &FemPlanIR,
    until_seconds: f64,
    outputs: &[OutputIR],
    field_every_n: u64,
    preview_request: &(dyn Fn() -> LivePreviewRequest + Send + Sync),
    on_step: &mut impl FnMut(StepUpdate) -> StepAction,
) -> Result<ExecutedRun, RunError> {
    execute_reference_fem_impl(
        plan,
        until_seconds,
        outputs,
        Some(LiveStepConsumer {
            grid: [0, 0, 0],
            field_every_n,
            preview_request: Some(preview_request),
            on_step,
        }),
        None,
    )
}

pub(crate) fn execute_reference_fem_streaming(
    plan: &FemPlanIR,
    until_seconds: f64,
    outputs: &[OutputIR],
    artifact_writer: ArtifactPipelineSender,
) -> Result<ExecutedRun, RunError> {
    execute_reference_fem_impl(
        plan,
        until_seconds,
        outputs,
        None::<LiveStepConsumer<'_>>,
        Some(artifact_writer),
    )
}

pub(crate) fn execute_reference_fem_with_callback_streaming(
    plan: &FemPlanIR,
    until_seconds: f64,
    outputs: &[OutputIR],
    field_every_n: u64,
    artifact_writer: ArtifactPipelineSender,
    on_step: &mut impl FnMut(StepUpdate) -> StepAction,
) -> Result<ExecutedRun, RunError> {
    execute_reference_fem_impl(
        plan,
        until_seconds,
        outputs,
        Some(LiveStepConsumer {
            grid: [0, 0, 0],
            field_every_n,
            preview_request: None,
            on_step,
        }),
        Some(artifact_writer),
    )
}

pub(crate) fn execute_reference_fem_with_live_preview_streaming(
    plan: &FemPlanIR,
    until_seconds: f64,
    outputs: &[OutputIR],
    field_every_n: u64,
    preview_request: &(dyn Fn() -> LivePreviewRequest + Send + Sync),
    artifact_writer: ArtifactPipelineSender,
    on_step: &mut impl FnMut(StepUpdate) -> StepAction,
) -> Result<ExecutedRun, RunError> {
    execute_reference_fem_impl(
        plan,
        until_seconds,
        outputs,
        Some(LiveStepConsumer {
            grid: [0, 0, 0],
            field_every_n,
            preview_request: Some(preview_request),
            on_step,
        }),
        Some(artifact_writer),
    )
}

pub(crate) fn snapshot_preview(
    plan: &FemPlanIR,
    request: &LivePreviewRequest,
) -> Result<crate::LivePreviewField, RunError> {
    let topology = MeshTopology::from_ir(&plan.mesh).map_err(|error| RunError {
        message: format!("MeshTopology: {}", error),
    })?;
    let material = MaterialParameters::new(
        plan.material.saturation_magnetisation,
        plan.material.exchange_stiffness,
        plan.material.damping,
    )
    .map_err(|e| RunError {
        message: format!("Material: {}", e),
    })?;
    let integrator = match plan.integrator {
        IntegratorChoice::Heun => TimeIntegrator::Heun,
        IntegratorChoice::Rk4 => TimeIntegrator::RK4,
        IntegratorChoice::Rk23 => TimeIntegrator::RK23,
        IntegratorChoice::Rk45 => TimeIntegrator::RK45,
        IntegratorChoice::Abm3 => TimeIntegrator::ABM3,
    };
    let pure_damping_relax = llg_overdamped_uses_pure_damping(plan.relaxation.as_ref());
    let mut dynamics = LlgConfig::new(plan.gyromagnetic_ratio, integrator)
        .map_err(|e| RunError {
            message: format!("LLG: {}", e),
        })?
        .with_precession_enabled(!pure_damping_relax);
    if let Some(adaptive) = plan.adaptive_timestep.as_ref() {
        dynamics = dynamics.with_adaptive(AdaptiveStepConfig {
            max_error: adaptive.atol,
            dt_min: adaptive.dt_min,
            dt_max: adaptive.dt_max.unwrap_or(1e-10),
            headroom: adaptive.safety,
        });
    }
    let problem = FemLlgProblem::with_terms_and_demag_transfer_grid(
        topology,
        material,
        dynamics,
        EffectiveFieldTerms {
            exchange: plan.enable_exchange,
            demag: plan.enable_demag,
            external_field: plan.external_field,
        },
        Some([plan.hmax, plan.hmax, plan.hmax]),
    );
    let state = problem
        .new_state(plan.initial_magnetization.clone())
        .map_err(|e| RunError {
            message: format!("State: {}", e),
        })?;
    let observables = observe_state(&problem, &state)?;
    Ok(build_mesh_preview_field(
        request,
        select_observables(&observables, &request.quantity),
    ))
}

fn execute_reference_fem_impl(
    plan: &FemPlanIR,
    until_seconds: f64,
    outputs: &[OutputIR],
    mut live: Option<LiveStepConsumer<'_>>,
    artifact_writer: Option<ArtifactPipelineSender>,
) -> Result<ExecutedRun, RunError> {
    if until_seconds <= 0.0 {
        return Err(RunError {
            message: "until_seconds must be positive".to_string(),
        });
    }
    if plan.precision != ExecutionPrecision::Double {
        return Err(RunError {
            message: "execution_precision='single' is not executable in the FEM CPU reference runner; use 'double'".to_string(),
        });
    }

    let topology = MeshTopology::from_ir(&plan.mesh).map_err(|e| RunError {
        message: format!("MeshTopology: {}", e),
    })?;
    let material = MaterialParameters::new(
        plan.material.saturation_magnetisation,
        plan.material.exchange_stiffness,
        plan.material.damping,
    )
    .map_err(|e| RunError {
        message: format!("Material: {}", e),
    })?;
    let integrator = match plan.integrator {
        IntegratorChoice::Heun => TimeIntegrator::Heun,
        IntegratorChoice::Rk4 => TimeIntegrator::RK4,
        IntegratorChoice::Rk23 => TimeIntegrator::RK23,
        IntegratorChoice::Rk45 => TimeIntegrator::RK45,
        IntegratorChoice::Abm3 => TimeIntegrator::ABM3,
    };
    let pure_damping_relax = llg_overdamped_uses_pure_damping(plan.relaxation.as_ref());
    let mut dynamics = LlgConfig::new(plan.gyromagnetic_ratio, integrator)
        .map_err(|e| RunError {
            message: format!("LLG: {}", e),
        })?
        .with_precession_enabled(!pure_damping_relax);
    if let Some(adaptive) = plan.adaptive_timestep.as_ref() {
        dynamics = dynamics.with_adaptive(AdaptiveStepConfig {
            max_error: adaptive.atol,
            dt_min: adaptive.dt_min,
            dt_max: adaptive.dt_max.unwrap_or(1e-10),
            headroom: adaptive.safety,
        });
    }

    let problem = FemLlgProblem::with_terms_and_demag_transfer_grid(
        topology,
        material,
        dynamics,
        EffectiveFieldTerms {
            exchange: plan.enable_exchange,
            demag: plan.enable_demag,
            external_field: plan.external_field,
        },
        Some([plan.hmax, plan.hmax, plan.hmax]),
    );
    let mut state = problem
        .new_state(plan.initial_magnetization.clone())
        .map_err(|e| RunError {
            message: format!("State: {}", e),
        })?;
    let initial_magnetization = state.magnetization().to_vec();

    let mut dt = plan
        .fixed_timestep
        .or_else(|| plan.adaptive_timestep.as_ref().and_then(|a| a.dt_initial))
        .unwrap_or(1e-13);
    let mut steps = Vec::new();
    let mut step_count = 0u64;
    let provenance = ExecutionProvenance {
        execution_engine: "cpu_reference_fem".to_string(),
        precision: "double".to_string(),
        demag_operator_kind: if plan.enable_demag {
            Some("fem_transfer_grid_tensor_fft_newell".to_string())
        } else {
            None
        },
        fft_backend: None,
        device_name: None,
        compute_capability: None,
        cuda_driver_version: None,
        cuda_runtime_version: None,
    };
    let mut artifacts = if let Some(writer) = artifact_writer {
        ArtifactRecorder::streaming(provenance.clone(), writer)
    } else {
        ArtifactRecorder::in_memory(provenance.clone())
    };
    let mut scalar_schedules = collect_scalar_schedules(outputs)?;
    let mut field_schedules = collect_field_schedules(outputs)?;
    let default_scalar_trace = scalar_schedules.is_empty();

    if default_scalar_trace {
        record_scalar_snapshot(&problem, &state, 0, 0.0, 0, &mut steps, &mut artifacts)?;
    } else {
        record_due_outputs(
            &problem,
            &state,
            0,
            0.0,
            0,
            &mut scalar_schedules,
            &mut field_schedules,
            &mut steps,
            &mut artifacts,
        )?;
    }

    let mut previous_total_energy = Some(observe_state(&problem, &state)?.total_energy);
    let mut last_preview_revision: Option<u64> = None;
    let mut cancelled = false;

    while state.time_seconds < until_seconds {
        let dt_step = dt.min(until_seconds - state.time_seconds);
        let wall_start = Instant::now();
        let report = problem.step(&mut state, dt_step).map_err(|e| RunError {
            message: format!("FEM step {}: {}", step_count, e),
        })?;
        let wall_elapsed = wall_start.elapsed().as_nanos() as u64;
        step_count += 1;
        if let Some(next) = report.suggested_next_dt {
            dt = next;
        }
        let latest_stats = StepStats {
            step: step_count,
            time: report.time_seconds,
            dt: report.dt_used,
            e_ex: report.exchange_energy_joules,
            e_demag: report.demag_energy_joules,
            e_ext: report.external_energy_joules,
            e_total: report.total_energy_joules,
            max_dm_dt: report.max_rhs_amplitude,
            max_h_eff: report.max_effective_field_amplitude,
            max_h_demag: report.max_demag_field_amplitude,
            wall_time_ns: wall_elapsed,
            ..StepStats::default()
        };

        if !default_scalar_trace || !field_schedules.is_empty() {
            record_due_outputs(
                &problem,
                &state,
                step_count,
                dt_step,
                wall_elapsed,
                &mut scalar_schedules,
                &mut field_schedules,
                &mut steps,
                &mut artifacts,
            )?;
        }

        if let Some(live) = live.as_mut() {
            let observables = observe_state(&problem, &state)?;
            let emit_every = live.field_every_n.max(1);
            let preview_request = live.preview_request.map(|get| get());
            let preview_due = preview_request
                .as_ref()
                .map(|request| {
                    let preview_emit_every = u64::from(request.every_n.max(1));
                    last_preview_revision != Some(request.revision)
                        || step_count <= 1
                        || step_count % preview_emit_every == 0
                })
                .unwrap_or(false);
            let magnetization = if live.preview_request.is_none() && step_count % emit_every == 0 {
                Some(flatten_vectors(&observables.magnetization))
            } else {
                None
            };
            let preview_field = if preview_due {
                let request = preview_request.as_ref().expect("checked preview_due");
                last_preview_revision = Some(request.revision);
                Some(build_mesh_preview_field(
                    request,
                    select_observables(&observables, &request.quantity),
                ))
            } else {
                None
            };
            let due_scalar_row = scalar_row_due(&scalar_schedules, state.time_seconds);
            let mut update_stats = make_step_stats(
                step_count,
                state.time_seconds,
                dt_step,
                wall_elapsed,
                &observables,
            );
            if due_scalar_row || scalar_outputs_request_average_m(&scalar_schedules) {
                apply_average_m_to_step_stats(&mut update_stats, &observables.magnetization);
            }
            let action = (live.on_step)(StepUpdate {
                stats: update_stats,
                grid: live.grid,
                fem_mesh: if step_count <= 1 {
                    Some(crate::types::FemMeshPayload {
                        nodes: plan.mesh.nodes.clone(),
                        elements: plan.mesh.elements.clone(),
                        boundary_faces: plan.mesh.boundary_faces.clone(),
                    })
                } else {
                    None
                },
                magnetization,
                preview_field,
                scalar_row_due: due_scalar_row,
                finished: false,
            });
            if action == StepAction::Stop {
                cancelled = true;
            }
        }

        if cancelled {
            break;
        }

        let stop_for_relaxation = plan.relaxation.as_ref().is_some_and(|control| {
            step_count >= control.max_steps
                || relaxation_converged(
                    control,
                    &latest_stats,
                    previous_total_energy,
                    plan.gyromagnetic_ratio,
                    plan.material.damping,
                    false,
                )
        });
        previous_total_energy = Some(latest_stats.e_total);
        if stop_for_relaxation {
            break;
        }
    }

    record_final_outputs(
        &problem,
        &state,
        step_count,
        dt,
        default_scalar_trace,
        &field_schedules,
        &mut steps,
        &mut artifacts,
    )?;

    let (field_snapshots, field_snapshot_count, provenance) = artifacts.finish();

    Ok(ExecutedRun {
        result: RunResult {
            status: if cancelled {
                RunStatus::Cancelled
            } else {
                RunStatus::Completed
            },
            steps,
            final_magnetization: state.magnetization().to_vec(),
        },
        initial_magnetization,
        field_snapshots,
        field_snapshot_count,
        provenance,
    })
}

fn record_due_outputs(
    problem: &FemLlgProblem,
    state: &FemLlgState,
    step: u64,
    solver_dt: f64,
    wall_time_ns: u64,
    scalar_schedules: &mut [OutputSchedule],
    field_schedules: &mut [OutputSchedule],
    steps: &mut Vec<StepStats>,
    artifacts: &mut ArtifactRecorder,
) -> Result<(), RunError> {
    let scalar_due = scalar_schedules
        .iter()
        .any(|schedule| is_due(state.time_seconds, schedule.next_time));
    let due_field_names = field_schedules
        .iter()
        .filter(|schedule| is_due(state.time_seconds, schedule.next_time))
        .map(|schedule| schedule.name.clone())
        .collect::<Vec<_>>();

    if !scalar_due && due_field_names.is_empty() {
        return Ok(());
    }

    let observables = observe_state(problem, state)?;

    if scalar_due {
        let stats = make_step_stats(
            step,
            state.time_seconds,
            solver_dt,
            wall_time_ns,
            &observables,
        );
        artifacts.record_scalar(&stats)?;
        steps.push(stats);
        advance_due_schedules(scalar_schedules, state.time_seconds);
    }

    if !due_field_names.is_empty() {
        for name in due_field_names {
            artifacts.record_field_snapshot(FieldSnapshot {
                name: name.clone(),
                step,
                time: state.time_seconds,
                solver_dt,
                values: select_field_values(&observables, &name),
            })?;
        }
        advance_due_schedules(field_schedules, state.time_seconds);
    }

    Ok(())
}

fn record_scalar_snapshot(
    problem: &FemLlgProblem,
    state: &FemLlgState,
    step: u64,
    solver_dt: f64,
    wall_time_ns: u64,
    steps: &mut Vec<StepStats>,
    artifacts: &mut ArtifactRecorder,
) -> Result<(), RunError> {
    let observables = observe_state(problem, state)?;
    let stats = make_step_stats(
        step,
        state.time_seconds,
        solver_dt,
        wall_time_ns,
        &observables,
    );
    artifacts.record_scalar(&stats)?;
    steps.push(stats);
    Ok(())
}

fn record_final_outputs(
    problem: &FemLlgProblem,
    state: &FemLlgState,
    step: u64,
    solver_dt: f64,
    default_scalar_trace: bool,
    field_schedules: &[OutputSchedule],
    steps: &mut Vec<StepStats>,
    artifacts: &mut ArtifactRecorder,
) -> Result<(), RunError> {
    let need_scalar = default_scalar_trace
        || steps
            .last()
            .map(|stats| !same_time(stats.time, state.time_seconds))
            .unwrap_or(true);

    let requested_field_names = field_schedules
        .iter()
        .filter(|schedule| {
            schedule
                .last_sampled_time
                .map(|time| !same_time(time, state.time_seconds))
                .unwrap_or(true)
        })
        .map(|schedule| schedule.name.clone())
        .collect::<Vec<_>>();
    let missing_field_names = requested_field_names;

    if !need_scalar && missing_field_names.is_empty() {
        return Ok(());
    }

    let observables = observe_state(problem, state)?;
    if need_scalar {
        let stats = make_step_stats(step, state.time_seconds, solver_dt, 0, &observables);
        artifacts.record_scalar(&stats)?;
        steps.push(stats);
    }
    for name in missing_field_names {
        artifacts.record_field_snapshot(FieldSnapshot {
            name: name.clone(),
            step,
            time: state.time_seconds,
            solver_dt,
            values: select_field_values(&observables, &name),
        })?;
    }

    Ok(())
}

fn observe_state(
    problem: &FemLlgProblem,
    state: &FemLlgState,
) -> Result<StateObservables, RunError> {
    let observables = problem.observe(state).map_err(|e| RunError {
        message: format!("FEM engine observables: {}", e),
    })?;
    Ok(StateObservables {
        magnetization: observables.magnetization,
        exchange_field: observables.exchange_field,
        demag_field: observables.demag_field,
        external_field: observables.external_field,
        effective_field: observables.effective_field,
        exchange_energy: observables.exchange_energy_joules,
        demag_energy: observables.demag_energy_joules,
        external_energy: observables.external_energy_joules,
        total_energy: observables.total_energy_joules,
        max_dm_dt: observables.max_rhs_amplitude,
        max_h_eff: observables.max_effective_field_amplitude,
        max_h_demag: observables.max_demag_field_amplitude,
    })
}

fn make_step_stats(
    step: u64,
    time: f64,
    solver_dt: f64,
    wall_time_ns: u64,
    observables: &StateObservables,
) -> StepStats {
    let mut stats = StepStats {
        step,
        time,
        dt: solver_dt,
        e_ex: observables.exchange_energy,
        e_demag: observables.demag_energy,
        e_ext: observables.external_energy,
        e_total: observables.total_energy,
        max_dm_dt: observables.max_dm_dt,
        max_h_eff: observables.max_h_eff,
        max_h_demag: observables.max_h_demag,
        wall_time_ns,
        ..StepStats::default()
    };
    apply_average_m_to_step_stats(&mut stats, &observables.magnetization);
    stats
}

fn select_field_values(observables: &StateObservables, name: &str) -> Vec<[f64; 3]> {
    if let Some(dot_pos) = name.find('.') {
        let base = &name[..dot_pos];
        let comp = &name[dot_pos + 1..];
        let full = select_base_field(observables, base);
        let idx = match comp {
            "x" => 0,
            "y" => 1,
            "z" => 2,
            _ => panic!("unsupported snapshot component '{}' in '{}'", comp, name),
        };
        return full.iter().map(|v| [v[idx], 0.0, 0.0]).collect();
    }
    select_base_field(observables, name)
}

fn select_base_field(observables: &StateObservables, name: &str) -> Vec<[f64; 3]> {
    match name {
        "m" => observables.magnetization.clone(),
        "H_ex" => observables.exchange_field.clone(),
        "H_demag" => observables.demag_field.clone(),
        "H_ext" => observables.external_field.clone(),
        "H_eff" => observables.effective_field.clone(),
        other => panic!("unsupported FEM field snapshot '{}'", other),
    }
}

#[cfg(test)]
mod tests {
    use super::*;
    use fullmag_ir::{
        ExchangeBoundaryCondition, ExecutionPrecision, FemPlanIR, IntegratorChoice, MaterialIR,
        MeshIR, RelaxationAlgorithmIR, RelaxationControlIR,
    };

    fn make_test_plan(enable_demag: bool) -> FemPlanIR {
        FemPlanIR {
            mesh_name: "unit_tet".to_string(),
            mesh_source: Some("meshes/unit_tet.msh".to_string()),
            mesh: MeshIR {
                mesh_name: "unit_tet".to_string(),
                nodes: vec![
                    [0.0, 0.0, 0.0],
                    [1.0, 0.0, 0.0],
                    [0.0, 1.0, 0.0],
                    [0.0, 0.0, 1.0],
                ],
                elements: vec![[0, 1, 2, 3]],
                element_markers: vec![1],
                boundary_faces: vec![[0, 1, 2]],
                boundary_markers: vec![1],
            },
            fe_order: 1,
            hmax: 1.0,
            initial_magnetization: vec![[1.0, 0.0, 0.0]; 4],
            material: MaterialIR {
                name: "Py".to_string(),
                saturation_magnetisation: 800e3,
                exchange_stiffness: 13e-12,
                damping: 0.5,
                uniaxial_anisotropy: None,
                anisotropy_axis: None,
            },
            enable_exchange: true,
            enable_demag,
            external_field: None,
            gyromagnetic_ratio: 2.211e5,
            precision: ExecutionPrecision::Double,
            exchange_bc: ExchangeBoundaryCondition::Neumann,
            integrator: IntegratorChoice::Heun,
            fixed_timestep: Some(1e-13),
            adaptive_timestep: None,
            relaxation: None,
            demag_realization: None,
            air_box_config: None,
        }
    }

    fn make_box_demag_plan() -> FemPlanIR {
        FemPlanIR {
            mesh_name: "box_40x20x10_coarse".to_string(),
            mesh_source: Some("examples/assets/box_40x20x10_coarse.mesh.json".to_string()),
            mesh: MeshIR {
                mesh_name: "box_40x20x10_coarse".to_string(),
                nodes: vec![
                    [-20e-9, -10e-9, -5e-9],
                    [20e-9, -10e-9, -5e-9],
                    [20e-9, 10e-9, -5e-9],
                    [-20e-9, 10e-9, -5e-9],
                    [-20e-9, -10e-9, 5e-9],
                    [20e-9, -10e-9, 5e-9],
                    [20e-9, 10e-9, 5e-9],
                    [-20e-9, 10e-9, 5e-9],
                ],
                elements: vec![
                    [0, 1, 2, 6],
                    [0, 2, 3, 6],
                    [0, 3, 7, 6],
                    [0, 7, 4, 6],
                    [0, 4, 5, 6],
                    [0, 5, 1, 6],
                ],
                element_markers: vec![1; 6],
                boundary_faces: vec![
                    [0, 1, 2],
                    [0, 1, 5],
                    [1, 2, 6],
                    [0, 2, 3],
                    [2, 3, 6],
                    [0, 3, 7],
                    [3, 6, 7],
                    [0, 4, 7],
                    [4, 6, 7],
                    [0, 4, 5],
                    [4, 5, 6],
                    [1, 5, 6],
                ],
                boundary_markers: vec![1; 12],
            },
            fe_order: 1,
            hmax: 10e-9,
            initial_magnetization: vec![[0.0, 0.0, 1.0]; 8],
            material: MaterialIR {
                name: "Py".to_string(),
                saturation_magnetisation: 800e3,
                exchange_stiffness: 13e-12,
                damping: 0.5,
                uniaxial_anisotropy: None,
                anisotropy_axis: None,
            },
            enable_exchange: true,
            enable_demag: true,
            external_field: None,
            gyromagnetic_ratio: 2.211e5,
            precision: ExecutionPrecision::Double,
            exchange_bc: ExchangeBoundaryCondition::Neumann,
            integrator: IntegratorChoice::Heun,
            fixed_timestep: Some(1e-13),
            adaptive_timestep: None,
            relaxation: None,
            demag_realization: None,
            air_box_config: None,
        }
    }

    #[test]
    fn uniform_fem_relaxation_produces_near_zero_exchange_energy() {
        let plan = make_test_plan(false);
        let result = execute_reference_fem(&plan, 1e-12, &[]).expect("FEM run should succeed");
        assert_eq!(result.result.status, RunStatus::Completed);
        assert!(!result.result.steps.is_empty());
        for step in &result.result.steps {
            assert!(
                step.e_ex.abs() < 1e-24,
                "uniform FEM state should have near-zero exchange energy"
            );
        }
    }

    #[test]
    fn demag_outputs_are_nonzero_when_enabled() {
        let plan = make_box_demag_plan();
        let result =
            execute_reference_fem(&plan, 1e-12, &[]).expect("FEM demag run should succeed");
        assert_eq!(result.result.status, RunStatus::Completed);
        let last = result.result.steps.last().expect("at least one step");
        assert!(last.e_demag >= 0.0);
        assert!(last.max_h_demag > 0.0);
    }

    #[test]
    fn fem_callback_emits_live_updates() {
        let plan = make_test_plan(true);
        let mut seen = 0usize;
        let result = execute_reference_fem_with_callback(&plan, 5e-13, &[], 2, &mut |update| {
            seen += 1;
            assert_eq!(update.grid, [0, 0, 0]);
            StepAction::Continue
        })
        .expect("callback FEM run should succeed");

        assert_eq!(result.result.status, RunStatus::Completed);
        assert!(seen > 0, "expected at least one live FEM callback update");
    }

    #[test]
    fn llg_overdamped_relaxation_stops_before_time_limit_on_uniform_fem_state() {
        let plan = FemPlanIR {
            relaxation: Some(RelaxationControlIR {
                algorithm: RelaxationAlgorithmIR::LlgOverdamped,
                torque_tolerance: 1e-6,
                energy_tolerance: None,
                max_steps: 1000,
            }),
            ..make_test_plan(false)
        };

        let executed =
            execute_reference_fem(&plan, 1e-9, &[]).expect("FEM relaxation run should succeed");

        assert!(executed.result.steps.len() <= 2);
        let final_time = executed.result.steps.last().expect("final stats").time;
        assert!(
            final_time < 1e-9,
            "FEM relaxation should stop early, got final_time={final_time}"
        );
    }
}
