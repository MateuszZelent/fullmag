//! CPU reference engine: executes FDM LLG via `fullmag-engine`.
//!
//! This remains the calibration baseline for terms that are not yet wired
//! into the native CUDA backend.

use fullmag_engine::{
    magnetoelastic::{MagnetoelasticParams, PrescribedStrainField},
    AdaptiveStepConfig, AxisBoundary, CellSize, CubicAnisotropyConfig, EffectiveFieldTerms,
    ExchangeLlgProblem, ExchangeLlgState, FdmBoundaryPolicy, GridShape, LlgConfig,
    MagnetoelasticTermConfig, MaterialParameters, OerstedCylinderConfig, SlonczewskiSttConfig,
    SotConfig, TimeIntegrator, UniaxialAnisotropyConfig, ZhangLiSttConfig,
};
use fullmag_ir::{
    ExecutionPrecision, FdmPlanIR, IntegratorChoice, OutputIR, RelaxationAlgorithmIR,
};

use crate::artifact_pipeline::{ArtifactPipelineSender, ArtifactRecorder};
use crate::interactive_runtime::{display_is_global_scalar, display_refresh_due};
use crate::preview::{build_grid_preview_field, flatten_vectors, select_observables};
use crate::quantities::normalized_quantity_name;
use crate::relaxation::{
    execute_nonlinear_cg, execute_projected_gradient_bb, llg_overdamped_uses_pure_damping,
    relaxation_converged,
};
use crate::scalar_metrics::{
    apply_average_m_to_step_stats, scalar_outputs_request_average_m, scalar_row_due,
    single_object_scalars,
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

/// Build a `ZhangLiSttConfig` from plan fields if ZL STT is requested.
fn build_mel(plan: &FdmPlanIR) -> Option<MagnetoelasticTermConfig> {
    let b1 = plan.mel_b1?;
    let strain = plan.mel_uniform_strain?;
    Some(MagnetoelasticTermConfig {
        params: MagnetoelasticParams {
            b1,
            b2: plan.mel_b2.unwrap_or(0.0),
            ms: plan.material.saturation_magnetisation,
        },
        strain: PrescribedStrainField::Uniform(strain),
    })
}

fn build_sot(plan: &FdmPlanIR) -> Option<SotConfig> {
    let je = plan.sot_current_density?;
    let sigma = plan.sot_sigma?;
    let thickness = plan.sot_thickness?;
    if je == 0.0 || thickness <= 0.0 {
        return None;
    }
    Some(SotConfig {
        current_density: je,
        xi_dl: plan.sot_xi_dl.unwrap_or(0.0),
        xi_fl: plan.sot_xi_fl.unwrap_or(0.0),
        sigma,
        thickness,
    })
}

fn build_zl_stt(plan: &FdmPlanIR) -> Option<ZhangLiSttConfig> {
    let j = plan.current_density?;
    let p = plan.stt_degree?;
    if j[0] == 0.0 && j[1] == 0.0 && j[2] == 0.0 || p <= 0.0 {
        return None;
    }
    Some(ZhangLiSttConfig {
        current_density: j,
        spin_polarization: p,
        non_adiabaticity: plan.stt_beta.unwrap_or(0.0),
    })
}

/// Build a `SlonczewskiSttConfig` from plan fields if Slonczewski STT is requested.
/// `cell_dz` is the cell thickness in z used as the layer thickness when none is
/// provided elsewhere.
fn build_slon_stt(plan: &FdmPlanIR, cell_dz: f64) -> Option<SlonczewskiSttConfig> {
    let p_axis = plan.stt_spin_polarization?;
    let lam = plan.stt_lambda?;
    if lam <= 0.0 {
        return None;
    }
    let j = plan.current_density?;
    let j_mag = (j[0] * j[0] + j[1] * j[1] + j[2] * j[2]).sqrt();
    if j_mag == 0.0 {
        return None;
    }
    Some(SlonczewskiSttConfig {
        current_density_magnitude: j_mag,
        spin_polarization_axis: p_axis,
        lambda: lam,
        epsilon_prime: plan.stt_epsilon_prime.unwrap_or(0.0),
        degree: plan.stt_degree.unwrap_or(1.0),
        thickness: cell_dz,
    })
}

/// Build an `OerstedCylinderConfig` from plan fields if Oersted is requested.
fn build_oersted(plan: &FdmPlanIR) -> Option<OerstedCylinderConfig> {
    if !plan.has_oersted_cylinder {
        return None;
    }
    let current = plan.oersted_current?;
    let radius = plan.oersted_radius?;
    if radius <= 0.0 {
        return None;
    }
    Some(OerstedCylinderConfig {
        current,
        radius,
        center: plan.oersted_center.unwrap_or([0.0, 0.0, 0.0]),
        axis: plan.oersted_axis.unwrap_or([0.0, 0.0, 1.0]),
        time_dep_kind: plan.oersted_time_dep_kind,
        time_dep_freq: plan.oersted_time_dep_freq,
        time_dep_phase: plan.oersted_time_dep_phase,
        time_dep_offset: plan.oersted_time_dep_offset,
        time_dep_t_on: plan.oersted_time_dep_t_on,
        time_dep_t_off: plan.oersted_time_dep_t_off,
    })
}

pub(crate) fn snapshot_preview(
    plan: &FdmPlanIR,
    request: &LivePreviewRequest,
) -> Result<crate::LivePreviewField, RunError> {
    let (problem, state) = build_snapshot_problem_and_state(plan)?;
    let observables = observe_state(&problem, &state)?;
    Ok(build_grid_preview_field(
        request,
        select_observables(&observables, &request.quantity)?,
        plan.grid.cells,
        plan.active_mask.as_deref(),
    ))
}

pub(crate) fn snapshot_vector_fields(
    plan: &FdmPlanIR,
    quantities: &[&str],
    request: &LivePreviewRequest,
) -> Result<Vec<crate::LivePreviewField>, RunError> {
    let (problem, state) = build_snapshot_problem_and_state(plan)?;
    let observables = observe_state(&problem, &state)?;
    let mut cached = Vec::new();
    let mut seen = std::collections::HashSet::new();

    for quantity in quantities
        .iter()
        .filter_map(|quantity| normalized_quantity_name(quantity).ok())
    {
        if !seen.insert(quantity) {
            continue;
        }
        let mut preview_request = request.clone();
        preview_request.quantity = quantity.to_string();
        cached.push(build_grid_preview_field(
            &preview_request,
            select_observables(&observables, quantity)?,
            plan.grid.cells,
            plan.active_mask.as_deref(),
        ));
    }

    Ok(cached)
}

pub(crate) fn build_snapshot_problem_and_state(
    plan: &FdmPlanIR,
) -> Result<(ExchangeLlgProblem, ExchangeLlgState), RunError> {
    let grid = GridShape::new(
        plan.grid.cells[0] as usize,
        plan.grid.cells[1] as usize,
        plan.grid.cells[2] as usize,
    )
    .map_err(|e| RunError {
        message: format!("Grid: {}", e),
    })?;
    let cell_size = CellSize::new(plan.cell_size[0], plan.cell_size[1], plan.cell_size[2])
        .map_err(|e| RunError {
            message: format!("CellSize: {}", e),
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
            rtol: adaptive.rtol,
            growth_limit: if adaptive.growth_limit == 0.0 {
                f64::INFINITY
            } else {
                adaptive.growth_limit
            },
            shrink_limit: adaptive.shrink_limit,
        });
    }

    let mut problem = ExchangeLlgProblem::with_terms_and_mask(
        grid,
        cell_size,
        material,
        dynamics,
        EffectiveFieldTerms {
            exchange: plan.enable_exchange,
            demag: plan.enable_demag,
            external_field: plan.external_field,
            per_node_field: None,
            magnetoelastic: build_mel(plan),
            uniaxial_anisotropy: plan.material.uniaxial_anisotropy_ku1.map(|ku1| {
                UniaxialAnisotropyConfig {
                    ku1,
                    ku2: plan.material.uniaxial_anisotropy_ku2.unwrap_or(0.0),
                    axis: plan.material.anisotropy_axis.unwrap_or([0.0, 0.0, 1.0]),
                }
            }),
            cubic_anisotropy: plan
                .material
                .cubic_anisotropy_kc1
                .map(|kc1| CubicAnisotropyConfig {
                    kc1,
                    kc2: plan.material.cubic_anisotropy_kc2.unwrap_or(0.0),
                    axis1: plan
                        .material
                        .cubic_anisotropy_axis1
                        .unwrap_or([1.0, 0.0, 0.0]),
                    axis2: plan
                        .material
                        .cubic_anisotropy_axis2
                        .unwrap_or([0.0, 1.0, 0.0]),
                }),
            interfacial_dmi: plan.interfacial_dmi,
            bulk_dmi: plan.bulk_dmi,
            zhang_li_stt: build_zl_stt(plan),
            slonczewski_stt: build_slon_stt(plan, plan.cell_size[2]),
            sot: build_sot(plan),
            oersted_cylinder: build_oersted(plan),
        },
        plan.active_mask.clone(),
    )
    .map_err(|e| RunError {
        message: format!("Problem construction: {}", e),
    })?;
    // Wire periodic boundary policy from plan
    if let Some(ref pbc) = plan.periodicity {
        let map_axis = |a: &fullmag_ir::AxisBoundary| match a {
            fullmag_ir::AxisBoundary::Periodic => AxisBoundary::Periodic,
            fullmag_ir::AxisBoundary::Open => AxisBoundary::Open,
        };
        problem.boundary_policy = FdmBoundaryPolicy {
            x: map_axis(&pbc.axes[0]),
            y: map_axis(&pbc.axes[1]),
            z: map_axis(&pbc.axes[2]),
        };
        if let Some(ic) = pbc.image_counts {
            problem.demag_image_counts = ic;
        }
    }
    // Set thermal noise parameters
    problem.temperature = plan.temperature.unwrap_or(0.0);
    if let Some(dt) = plan.fixed_timestep {
        problem.thermal_dt = dt;
    }
    let state = problem
        .new_state(plan.initial_magnetization.clone())
        .map_err(|e| RunError {
            message: format!("State: {}", e),
        })?;
    Ok((problem, state))
}

/// Execute an FDM plan on the CPU reference engine.
///
/// Pass `live: Some(LiveStepConsumer { .. })` for per-step callbacks /
/// live preview, and `artifact_writer: Some(sender)` for streaming artifacts.
pub(crate) fn execute_reference_fdm(
    plan: &FdmPlanIR,
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
            message: format!(
                "execution_precision='{}' is not executable in the CPU reference runner; use 'double'",
                match plan.precision {
                    ExecutionPrecision::Single => "single",
                    ExecutionPrecision::Double => "double",
                }
            ),
        });
    }

    let grid = GridShape::new(
        plan.grid.cells[0] as usize,
        plan.grid.cells[1] as usize,
        plan.grid.cells[2] as usize,
    )
    .map_err(|e| RunError {
        message: format!("Grid: {}", e),
    })?;

    let cell_size = CellSize::new(plan.cell_size[0], plan.cell_size[1], plan.cell_size[2])
        .map_err(|e| RunError {
            message: format!("CellSize: {}", e),
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
            rtol: adaptive.rtol,
            growth_limit: if adaptive.growth_limit == 0.0 {
                f64::INFINITY
            } else {
                adaptive.growth_limit
            },
            shrink_limit: adaptive.shrink_limit,
        });
    }

    let mut problem = ExchangeLlgProblem::with_terms_and_mask(
        grid,
        cell_size,
        material,
        dynamics,
        EffectiveFieldTerms {
            exchange: plan.enable_exchange,
            demag: plan.enable_demag,
            external_field: plan.external_field,
            per_node_field: None,
            magnetoelastic: build_mel(plan),
            uniaxial_anisotropy: plan.material.uniaxial_anisotropy_ku1.map(|ku1| {
                UniaxialAnisotropyConfig {
                    ku1,
                    ku2: plan.material.uniaxial_anisotropy_ku2.unwrap_or(0.0),
                    axis: plan.material.anisotropy_axis.unwrap_or([0.0, 0.0, 1.0]),
                }
            }),
            cubic_anisotropy: plan
                .material
                .cubic_anisotropy_kc1
                .map(|kc1| CubicAnisotropyConfig {
                    kc1,
                    kc2: plan.material.cubic_anisotropy_kc2.unwrap_or(0.0),
                    axis1: plan
                        .material
                        .cubic_anisotropy_axis1
                        .unwrap_or([1.0, 0.0, 0.0]),
                    axis2: plan
                        .material
                        .cubic_anisotropy_axis2
                        .unwrap_or([0.0, 1.0, 0.0]),
                }),
            interfacial_dmi: plan.interfacial_dmi,
            bulk_dmi: plan.bulk_dmi,
            zhang_li_stt: build_zl_stt(plan),
            slonczewski_stt: build_slon_stt(plan, plan.cell_size[2]),
            sot: build_sot(plan),
            oersted_cylinder: build_oersted(plan),
        },
        plan.active_mask.clone(),
    )
    .map_err(|e| RunError {
        message: format!("Problem construction: {}", e),
    })?;
    // Wire periodic boundary policy
    if let Some(ref pbc) = plan.periodicity {
        let map_axis = |a: &fullmag_ir::AxisBoundary| match a {
            fullmag_ir::AxisBoundary::Periodic => AxisBoundary::Periodic,
            fullmag_ir::AxisBoundary::Open => AxisBoundary::Open,
        };
        problem.boundary_policy = FdmBoundaryPolicy {
            x: map_axis(&pbc.axes[0]),
            y: map_axis(&pbc.axes[1]),
            z: map_axis(&pbc.axes[2]),
        };
        if let Some(ic) = pbc.image_counts {
            problem.demag_image_counts = ic;
        }
    }

    let mut state = problem
        .new_state(plan.initial_magnetization.clone())
        .map_err(|e| RunError {
            message: format!("State: {}", e),
        })?;
    let initial_magnetization = state.magnetization().to_vec();

    let mut dt =
        crate::resolve_initial_timestep(plan.fixed_timestep, plan.adaptive_timestep.as_ref())
            .unwrap_or(crate::DEFAULT_ADAPTIVE_DT_INITIAL);
    let mut last_solver_dt = 0.0;
    let mut steps: Vec<StepStats> = Vec::new();
    let mut step_count: u64 = 0;
    let mut artifacts = if let Some(writer) = artifact_writer {
        ArtifactRecorder::streaming(
            ExecutionProvenance {
                execution_engine: "cpu_reference".to_string(),
                precision: "double".to_string(),
                demag_operator_kind: if plan.enable_demag {
                    Some("tensor_fft_newell".to_string())
                } else {
                    None
                },
                fft_backend: if plan.enable_demag {
                    Some("rustfft".to_string())
                } else {
                    None
                },
                device_name: None,
                compute_capability: None,
                cuda_driver_version: None,
                cuda_runtime_version: None,
                ..Default::default()
            },
            writer,
        )
    } else {
        ArtifactRecorder::in_memory(ExecutionProvenance {
            execution_engine: "cpu_reference".to_string(),
            precision: "double".to_string(),
            demag_operator_kind: if plan.enable_demag {
                Some("tensor_fft_newell".to_string())
            } else {
                None
            },
            fft_backend: if plan.enable_demag {
                Some("rustfft".to_string())
            } else {
                None
            },
            device_name: None,
            compute_capability: None,
            cuda_driver_version: None,
            cuda_runtime_version: None,
            ..Default::default()
        })
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

    // --- Create FFT workspace once for the entire simulation ---
    let mut fft_workspace = problem.create_workspace();
    let mut integrator_bufs = problem.create_integrator_buffers();
    let mut previous_total_energy = Some(observe_state(&problem, &state)?.total_energy);
    let mut last_preview_revision: Option<u64> = None;
    let mut cancelled = false;

    // --- Dispatch on relaxation algorithm ---
    let is_direct_minimization = plan.relaxation.as_ref().is_some_and(|control| {
        matches!(
            control.algorithm,
            RelaxationAlgorithmIR::ProjectedGradientBb | RelaxationAlgorithmIR::NonlinearCg
        )
    });

    if is_direct_minimization {
        // Direct minimization: BB or NCG — bypasses LLG time-stepping
        let control = plan.relaxation.as_ref().unwrap();
        let wall_start = Instant::now();

        let result = match control.algorithm {
            RelaxationAlgorithmIR::ProjectedGradientBb => execute_projected_gradient_bb(
                &problem,
                state.magnetization(),
                &mut fft_workspace,
                control,
            ),
            RelaxationAlgorithmIR::NonlinearCg => {
                execute_nonlinear_cg(&problem, state.magnetization(), &mut fft_workspace, control)
            }
            _ => unreachable!(),
        };

        let wall_elapsed = wall_start.elapsed().as_nanos() as u64;

        // Update state with result
        state
            .set_magnetization(result.final_magnetization)
            .map_err(|e| RunError {
                message: format!("Setting relaxation result: {}", e),
            })?;
        step_count = result.steps_taken;

        // Record final observables
        let observables = observe_state(&problem, &state)?;
        steps.push(make_step_stats(
            step_count,
            state.time_seconds,
            0.0,
            wall_elapsed,
            &observables,
        ));
    } else {
        // LLG overdamped (or no relaxation): existing time-stepping loop
        let mut current_observables = observe_state(&problem, &state)?;
        let mut current_stats =
            make_step_stats(step_count, state.time_seconds, 0.0, 0, &current_observables);
        while state.time_seconds < until_seconds {
            if let Some(live) = live.as_mut() {
                if let Some(display_selection) = live.display_selection.map(|get| get()) {
                    let preview_due = display_refresh_due(
                        last_preview_revision,
                        &display_selection,
                        current_stats.step,
                    );
                    let preview_targets_global_scalar =
                        display_is_global_scalar(&display_selection);
                    let preview_field = if preview_due && !preview_targets_global_scalar {
                        let request = display_selection.preview_request();
                        Some(build_grid_preview_field(
                            &request,
                            select_observables(&current_observables, &request.quantity)?,
                            live.grid,
                            plan.active_mask.as_deref(),
                        ))
                    } else {
                        None
                    };
                    let action = (live.on_step)(StepUpdate {
                        stats: current_stats.clone(),
                        scalar_row_due: preview_due && preview_targets_global_scalar,
                        grid: live.grid,
                        fem_mesh: None,
                        magnetization: None,
                        preview_field,
                        cached_preview_fields: None,
                        finished: false,
                    });
                    if preview_due {
                        last_preview_revision = Some(display_selection.revision);
                    }
                    if action == StepAction::Stop {
                        cancelled = true;
                        break;
                    }
                }
            }

            let dt_step = dt.min(until_seconds - state.time_seconds);
            let wall_start = Instant::now();
            let report = problem
                .step_with_buffers(
                    &mut state,
                    dt_step,
                    &mut fft_workspace,
                    &mut integrator_bufs,
                )
                .map_err(|e| RunError {
                    message: format!("Step {}: {}", step_count, e),
                })?;
            let wall_elapsed = wall_start.elapsed().as_nanos() as u64;
            step_count += 1;
            last_solver_dt = report.dt_used;
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
                max_torque_Apm: report.max_torque_Apm,
                max_torque_T: report.max_torque_Apm * crate::MU0,
                wall_time_ns: wall_elapsed,
                ..StepStats::default()
            };
            current_stats = latest_stats.clone();

            if !default_scalar_trace || !field_schedules.is_empty() {
                record_due_outputs(
                    &problem,
                    &state,
                    step_count,
                    report.dt_used,
                    wall_elapsed,
                    &mut scalar_schedules,
                    &mut field_schedules,
                    &mut steps,
                    &mut artifacts,
                )?;
            }

            if let Some(live) = live.as_mut() {
                let observables = observe_state(&problem, &state)?;
                current_observables = observables.clone();
                let heavy_payload_every = live.field_every_n.max(1);
                let display_selection = live.display_selection.map(|get| get());
                let preview_due = display_selection
                    .as_ref()
                    .map(|selection| {
                        display_refresh_due(last_preview_revision, selection, step_count)
                    })
                    .unwrap_or(false);
                let preview_targets_global_scalar = display_selection
                    .as_ref()
                    .is_some_and(display_is_global_scalar);
                let magnetization =
                    if live.display_selection.is_none() && step_count % heavy_payload_every == 0 {
                        Some(flatten_vectors(&observables.magnetization))
                    } else {
                        None
                    };
                let preview_field = if preview_due && !preview_targets_global_scalar {
                    let selection = display_selection.as_ref().expect("checked preview_due");
                    let request = selection.preview_request();
                    Some(build_grid_preview_field(
                        &request,
                        select_observables(&observables, &request.quantity)?,
                        live.grid,
                        plan.active_mask.as_deref(),
                    ))
                } else {
                    None
                };
                let due_scalar_row = scalar_row_due(&scalar_schedules, state.time_seconds)
                    || (preview_due && preview_targets_global_scalar);
                let mut update_stats = make_step_stats(
                    step_count,
                    state.time_seconds,
                    report.dt_used,
                    wall_elapsed,
                    &observables,
                );
                if due_scalar_row || scalar_outputs_request_average_m(&scalar_schedules) {
                    apply_average_m_to_step_stats(&mut update_stats, &observables.magnetization);
                }
                let action = (live.on_step)(StepUpdate {
                    stats: update_stats,
                    scalar_row_due: due_scalar_row,
                    grid: live.grid,
                    fem_mesh: None,
                    magnetization,
                    preview_field,
                    cached_preview_fields: None,
                    finished: false,
                });
                if preview_due {
                    last_preview_revision = Some(
                        display_selection
                            .as_ref()
                            .expect("checked preview_due")
                            .revision,
                    );
                }
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
                        pure_damping_relax,
                    )
            });
            previous_total_energy = Some(latest_stats.e_total);
            if stop_for_relaxation {
                break;
            }
        }
    }

    record_final_outputs(
        &problem,
        &state,
        step_count,
        last_solver_dt,
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
        auxiliary_artifacts: Vec::new(),
        provenance,
    })
}

fn record_due_outputs(
    problem: &ExchangeLlgProblem,
    state: &ExchangeLlgState,
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
                values: select_field_values(&observables, &name)?,
            })?;
        }
        advance_due_schedules(field_schedules, state.time_seconds);
    }

    Ok(())
}

fn record_scalar_snapshot(
    problem: &ExchangeLlgProblem,
    state: &ExchangeLlgState,
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
    problem: &ExchangeLlgProblem,
    state: &ExchangeLlgState,
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
    let missing_field_names = requested_field_names
        .into_iter()
        .filter(|name| {
            !field_schedules.iter().any(|schedule| {
                schedule.name == *name
                    && schedule
                        .last_sampled_time
                        .map(|time| same_time(time, state.time_seconds))
                        .unwrap_or(false)
            })
        })
        .collect::<Vec<_>>();

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
            values: select_field_values(&observables, &name)?,
        })?;
    }

    Ok(())
}

pub(crate) fn observe_state(
    problem: &ExchangeLlgProblem,
    state: &ExchangeLlgState,
) -> Result<StateObservables, RunError> {
    let observables = problem.observe(state).map_err(|e| RunError {
        message: format!("Engine observables: {}", e),
    })?;

    Ok(StateObservables {
        magnetization: observables.magnetization,
        exchange_field: observables.exchange_field,
        demag_field: observables.demag_field,
        external_field: observables.external_field,
        antenna_field: vec![[0.0, 0.0, 0.0]; state.magnetization().len()],
        effective_field: observables.effective_field,
        anisotropy_field: Vec::new(),
        dmi_field: Vec::new(),
        magnetoelastic_field: Vec::new(),
        cubic_anisotropy_field: Vec::new(),
        bulk_dmi_field: Vec::new(),
        oersted_field: Vec::new(),
        thermal_field: Vec::new(),
        exchange_energy: observables.exchange_energy_joules,
        demag_energy: observables.demag_energy_joules,
        external_energy: observables.external_energy_joules,
        anisotropy_energy: 0.0,
        dmi_energy: 0.0,
        total_energy: observables.total_energy_joules,
        max_dm_dt: observables.max_rhs_amplitude,
        max_h_eff: observables.max_effective_field_amplitude,
        max_h_demag: observables.max_demag_field_amplitude,
        max_torque_Apm: observables.max_torque_Apm,
        per_object_scalars: std::collections::HashMap::new(),
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
        e_ani: observables.anisotropy_energy,
        e_dmi: observables.dmi_energy,
        e_total: observables.total_energy,
        max_dm_dt: observables.max_dm_dt,
        max_h_eff: observables.max_h_eff,
        max_h_demag: observables.max_h_demag,
        wall_time_ns,
        ..StepStats::default()
    };
    apply_average_m_to_step_stats(&mut stats, &observables.magnetization);
    stats.per_object_scalars = if observables.per_object_scalars.is_empty() {
        single_object_scalars("free", &stats)
    } else {
        observables.per_object_scalars.clone()
    };
    stats
}

fn select_field_values(
    observables: &StateObservables,
    name: &str,
) -> Result<Vec<[f64; 3]>, RunError> {
    // Handle component-qualified snapshot names (e.g. "m.z")
    if let Some(dot_pos) = name.find('.') {
        let base = &name[..dot_pos];
        let comp = &name[dot_pos + 1..];
        let full = select_base_field(observables, base)?;
        let idx = match comp {
            "x" => 0,
            "y" => 1,
            "z" => 2,
            _ => {
                return Err(RunError {
                    message: format!(
                        "snapshot '{}': unsupported component '{}' (use x, y, or z)",
                        name, comp
                    ),
                });
            }
        };
        return Ok(full.iter().map(|v| [v[idx], 0.0, 0.0]).collect());
    }
    select_base_field(observables, name)
}

fn select_base_field(
    observables: &StateObservables,
    name: &str,
) -> Result<Vec<[f64; 3]>, RunError> {
    match name {
        "m" => Ok(observables.magnetization.clone()),
        "H_ex" => Ok(observables.exchange_field.clone()),
        "H_demag" => Ok(observables.demag_field.clone()),
        "H_ext" => Ok(observables.external_field.clone()),
        "H_eff" => Ok(observables.effective_field.clone()),
        other => Err(RunError {
            message: format!(
                "CPU FDM snapshot: field '{}' is not available in this execution path \
                 (available: m, H_ex, H_demag, H_ext, H_eff)",
                other
            ),
        }),
    }
}

#[cfg(test)]
fn max_vector_norm(values: &[[f64; 3]]) -> f64 {
    values
        .iter()
        .map(|value| (value[0] * value[0] + value[1] * value[1] + value[2] * value[2]).sqrt())
        .fold(0.0, f64::max)
}

#[cfg(test)]
mod tests {
    use super::*;
    use fullmag_ir::{
        ExchangeBoundaryCondition, ExecutionPrecision, FdmMaterialIR, GridDimensions,
        IntegratorChoice, RelaxationAlgorithmIR, RelaxationControlIR,
    };

    fn make_test_plan() -> FdmPlanIR {
        FdmPlanIR {
            grid: GridDimensions { cells: [4, 4, 1] },
            cell_size: [2e-9, 2e-9, 2e-9],
            region_mask: vec![0; 16],
            active_mask: None,
            initial_magnetization: vec![[1.0, 0.0, 0.0]; 16],
            material: FdmMaterialIR {
                name: "Py".to_string(),
                saturation_magnetisation: 800e3,
                exchange_stiffness: 13e-12,
                damping: 0.5,
                ..Default::default()
            },
            gyromagnetic_ratio: 2.211e5,
            precision: ExecutionPrecision::Double,
            exchange_bc: ExchangeBoundaryCondition::Neumann,
            integrator: IntegratorChoice::Heun,
            fixed_timestep: Some(1e-14),
            adaptive_timestep: None,
            relaxation: None,
            boundary_correction: None,
            boundary_geometry: None,
            inter_region_exchange: vec![],
            enable_exchange: true,
            enable_demag: false,
            external_field: None,
            current_density: None,
            stt_degree: None,
            stt_beta: None,
            stt_spin_polarization: None,
            stt_lambda: None,
            stt_epsilon_prime: None,
            has_oersted_cylinder: false,
            oersted_current: None,
            oersted_radius: None,
            oersted_center: None,
            oersted_axis: None,
            oersted_time_dep_kind: 0,
            oersted_time_dep_freq: 0.0,
            oersted_time_dep_phase: 0.0,
            oersted_time_dep_offset: 0.0,
            oersted_time_dep_t_on: 0.0,
            oersted_time_dep_t_off: 0.0,
            temperature: None,
            interfacial_dmi: None,
            bulk_dmi: None,
            ..Default::default()
        }
    }

    fn make_relaxation_precession_test_plan() -> FdmPlanIR {
        FdmPlanIR {
            grid: GridDimensions { cells: [1, 1, 1] },
            cell_size: [5e-9, 5e-9, 5e-9],
            region_mask: vec![0],
            active_mask: None,
            initial_magnetization: vec![[1.0, 0.0, 0.0]],
            material: FdmMaterialIR {
                name: "Py".to_string(),
                saturation_magnetisation: 800e3,
                exchange_stiffness: 13e-12,
                damping: 0.1,
                ..Default::default()
            },
            gyromagnetic_ratio: 2.211e5,
            precision: ExecutionPrecision::Double,
            exchange_bc: ExchangeBoundaryCondition::Neumann,
            integrator: IntegratorChoice::Rk23,
            fixed_timestep: Some(1e-15),
            adaptive_timestep: None,
            relaxation: Some(RelaxationControlIR {
                algorithm: RelaxationAlgorithmIR::LlgOverdamped,
                torque_tolerance: 1e-6,
                energy_tolerance: None,
                max_steps: 10,
            }),
            enable_exchange: false,
            enable_demag: false,
            external_field: Some([0.0, 0.0, 8.0e5]),
            boundary_correction: None,
            boundary_geometry: None,
            inter_region_exchange: vec![],
            current_density: None,
            stt_degree: None,
            stt_beta: None,
            stt_spin_polarization: None,
            stt_lambda: None,
            stt_epsilon_prime: None,
            has_oersted_cylinder: false,
            oersted_current: None,
            oersted_radius: None,
            oersted_center: None,
            oersted_axis: None,
            oersted_time_dep_kind: 0,
            oersted_time_dep_freq: 0.0,
            oersted_time_dep_phase: 0.0,
            oersted_time_dep_offset: 0.0,
            oersted_time_dep_t_on: 0.0,
            oersted_time_dep_t_off: 0.0,
            temperature: None,
            interfacial_dmi: None,
            bulk_dmi: None,
            ..Default::default()
        }
    }

    #[test]
    fn uniform_relaxation_produces_stable_energy() {
        let plan = make_test_plan();
        let result =
            execute_reference_fdm(&plan, 1e-12, &[], None, None).expect("run should succeed");

        assert_eq!(result.result.status, RunStatus::Completed);
        assert!(!result.result.steps.is_empty());
        for step in &result.result.steps {
            assert!(
                step.e_ex.abs() < 1e-30,
                "uniform m should have zero exchange energy, got {}",
                step.e_ex
            );
        }
    }

    #[test]
    fn random_initial_relaxes_with_decreasing_energy() {
        let random_m0 = fullmag_plan::generate_random_unit_vectors(42, 16);

        let plan = FdmPlanIR {
            initial_magnetization: random_m0,
            ..make_test_plan()
        };

        let result =
            execute_reference_fdm(&plan, 5e-12, &[], None, None).expect("run should succeed");

        assert_eq!(result.result.status, RunStatus::Completed);
        let first_energy = result.result.steps.first().unwrap().e_ex;
        let last_energy = result.result.steps.last().unwrap().e_ex;
        assert!(
            last_energy <= first_energy,
            "exchange energy should decrease during relaxation: {} -> {}",
            first_energy,
            last_energy
        );
    }

    #[test]
    fn exchange_energy_respects_planned_material_parameters() {
        let random_m0 = fullmag_plan::generate_random_unit_vectors(42, 16);
        let base_plan = FdmPlanIR {
            initial_magnetization: random_m0.clone(),
            ..make_test_plan()
        };
        let stronger_exchange_plan = FdmPlanIR {
            initial_magnetization: random_m0,
            material: FdmMaterialIR {
                exchange_stiffness: base_plan.material.exchange_stiffness * 2.0,
                ..base_plan.material.clone()
            },
            ..make_test_plan()
        };

        let base_result = execute_reference_fdm(&base_plan, 1e-14, &[], None, None)
            .expect("base run should succeed");
        let stronger_result =
            execute_reference_fdm(&stronger_exchange_plan, 1e-14, &[], None, None)
                .expect("scaled run should succeed");

        let base_initial = base_result.result.steps.first().unwrap().e_ex;
        let stronger_initial = stronger_result.result.steps.first().unwrap().e_ex;
        let ratio = stronger_initial / base_initial;
        assert!(
            (ratio - 2.0).abs() < 1e-9,
            "exchange energy should scale with A: got ratio {}",
            ratio
        );
    }

    #[test]
    fn scheduled_fields_include_initial_and_final_snapshots() {
        let plan = FdmPlanIR {
            initial_magnetization: fullmag_plan::generate_random_unit_vectors(42, 16),
            enable_demag: true,
            external_field: Some([1e5, 0.0, 0.0]),
            ..make_test_plan()
        };
        let outputs = [
            OutputIR::Field {
                name: "m".to_string(),
                every_seconds: 100e-12,
            },
            OutputIR::Field {
                name: "H_ex".to_string(),
                every_seconds: 100e-12,
            },
            OutputIR::Field {
                name: "H_demag".to_string(),
                every_seconds: 100e-12,
            },
            OutputIR::Field {
                name: "H_ext".to_string(),
                every_seconds: 100e-12,
            },
            OutputIR::Field {
                name: "H_eff".to_string(),
                every_seconds: 100e-12,
            },
            OutputIR::Scalar {
                name: "E_total".to_string(),
                every_seconds: 100e-12,
            },
        ];

        let executed = execute_reference_fdm(&plan, 1e-12, &outputs, None, None)
            .expect("scheduled field run should succeed");

        for field_name in ["m", "H_ex", "H_demag", "H_ext", "H_eff"] {
            let snapshots = executed
                .field_snapshots
                .iter()
                .filter(|snapshot| snapshot.name == field_name)
                .collect::<Vec<_>>();
            assert_eq!(
                snapshots.len(),
                2,
                "{field_name} should have initial and final snapshots"
            );
            assert_eq!(snapshots[0].step, 0);
            assert!(snapshots[1].step > 0);
        }
    }

    #[test]
    fn demag_and_external_terms_produce_nonzero_observables() {
        let plan = FdmPlanIR {
            initial_magnetization: fullmag_plan::generate_random_unit_vectors(7, 16),
            enable_exchange: false,
            enable_demag: true,
            external_field: Some([5e4, 0.0, 0.0]),
            ..make_test_plan()
        };

        let executed =
            execute_reference_fdm(&plan, 1e-14, &[], None, None).expect("run should succeed");
        let stats = executed.result.steps.first().expect("scalar trace");

        assert!(stats.e_demag.is_finite());
        assert!(stats.e_ext.is_finite());
        assert!(stats.e_total.is_finite());
    }

    #[test]
    fn helper_max_vector_norm_handles_empty_input() {
        assert_eq!(max_vector_norm(&[]), 0.0);
    }

    #[test]
    fn active_mask_keeps_inactive_cells_zero_and_excludes_them_from_fields() {
        let active_mask = vec![
            true, true, false, false, true, true, false, false, true, true, false, false, true,
            true, false, false,
        ];
        let plan = FdmPlanIR {
            active_mask: Some(active_mask.clone()),
            initial_magnetization: vec![
                [1.0, 0.0, 0.0],
                [0.0, 1.0, 0.0],
                [0.5, 0.5, 0.5],
                [0.5, 0.5, 0.5],
                [1.0, 0.0, 0.0],
                [0.0, 1.0, 0.0],
                [0.5, 0.5, 0.5],
                [0.5, 0.5, 0.5],
                [1.0, 0.0, 0.0],
                [0.0, 1.0, 0.0],
                [0.5, 0.5, 0.5],
                [0.5, 0.5, 0.5],
                [1.0, 0.0, 0.0],
                [0.0, 1.0, 0.0],
                [0.5, 0.5, 0.5],
                [0.5, 0.5, 0.5],
            ],
            enable_demag: true,
            external_field: Some([1e5, 0.0, 0.0]),
            ..make_test_plan()
        };

        let outputs = [
            OutputIR::Field {
                name: "m".to_string(),
                every_seconds: 1e-13,
            },
            OutputIR::Field {
                name: "H_demag".to_string(),
                every_seconds: 1e-13,
            },
            OutputIR::Field {
                name: "H_ext".to_string(),
                every_seconds: 1e-13,
            },
        ];

        let executed = execute_reference_fdm(&plan, 2e-13, &outputs, None, None)
            .expect("masked run should succeed");

        let is_zero = |vector: [f64; 3]| vector.iter().all(|value| value.abs() <= 1e-12);

        for (index, is_active) in active_mask.iter().enumerate() {
            if !is_active {
                assert!(
                    is_zero(executed.result.final_magnetization[index]),
                    "inactive cell {index} should stay zero in final magnetization"
                );
            }
        }

        for snapshot in &executed.field_snapshots {
            if snapshot.name == "H_demag" || snapshot.name == "H_ext" || snapshot.name == "m" {
                for (index, is_active) in active_mask.iter().enumerate() {
                    if !is_active {
                        assert!(
                            is_zero(snapshot.values[index]),
                            "inactive cell {index} should stay zero in snapshot '{}'",
                            snapshot.name
                        );
                    }
                }
            }
        }
    }

    #[test]
    fn llg_overdamped_relaxation_stops_before_time_limit_on_uniform_state() {
        let plan = FdmPlanIR {
            relaxation: Some(RelaxationControlIR {
                algorithm: RelaxationAlgorithmIR::LlgOverdamped,
                torque_tolerance: 1e-6,
                energy_tolerance: None,
                max_steps: 1000,
            }),
            ..make_test_plan()
        };

        let executed = execute_reference_fdm(&plan, 1e-9, &[], None, None)
            .expect("relaxation run should succeed");

        assert!(executed.result.steps.len() <= 2);
        let final_time = executed.result.steps.last().expect("final stats").time;
        assert!(
            final_time < 1e-9,
            "relaxation should stop early, got final_time={final_time}"
        );
    }

    #[test]
    fn llg_overdamped_relaxation_uses_pure_damping_rhs() {
        let plan = make_relaxation_precession_test_plan();
        let executed = execute_reference_fdm(&plan, 1e-12, &[], None, None)
            .expect("relaxation should succeed");
        let final_m = executed.result.final_magnetization[0];

        assert!(
            final_m[1].abs() <= 1e-10,
            "pure-damping relaxation should not precess into y, got {:?}",
            final_m
        );
        assert!(
            final_m[2] > 0.0,
            "pure-damping relaxation should move toward +z field, got {:?}",
            final_m
        );
    }

    #[test]
    fn bb_relaxation_stops_on_uniform_state() {
        let plan = FdmPlanIR {
            relaxation: Some(RelaxationControlIR {
                algorithm: RelaxationAlgorithmIR::ProjectedGradientBb,
                torque_tolerance: 1e-6,
                energy_tolerance: None,
                max_steps: 1000,
            }),
            ..make_test_plan()
        };

        let executed = execute_reference_fdm(&plan, 1e-9, &[], None, None)
            .expect("BB relaxation should succeed");
        assert_eq!(executed.result.status, RunStatus::Completed);
        assert!(!executed.result.steps.is_empty());
    }

    #[test]
    fn ncg_relaxation_stops_on_uniform_state() {
        let plan = FdmPlanIR {
            relaxation: Some(RelaxationControlIR {
                algorithm: RelaxationAlgorithmIR::NonlinearCg,
                torque_tolerance: 1e-6,
                energy_tolerance: None,
                max_steps: 1000,
            }),
            ..make_test_plan()
        };

        let executed = execute_reference_fdm(&plan, 1e-9, &[], None, None)
            .expect("NCG relaxation should succeed");
        assert_eq!(executed.result.status, RunStatus::Completed);
        assert!(!executed.result.steps.is_empty());
    }

    #[test]
    fn bb_relaxation_decreases_energy_on_random_initial() {
        let random_m0 = fullmag_plan::generate_random_unit_vectors(42, 16);
        let plan = FdmPlanIR {
            initial_magnetization: random_m0,
            relaxation: Some(RelaxationControlIR {
                algorithm: RelaxationAlgorithmIR::ProjectedGradientBb,
                torque_tolerance: 1e-6,
                energy_tolerance: None,
                max_steps: 5000,
            }),
            ..make_test_plan()
        };

        let executed = execute_reference_fdm(&plan, 1e-9, &[], None, None)
            .expect("BB relaxation should succeed");
        assert!(
            executed.result.steps.len() >= 2,
            "should have initial + final stats"
        );
        let first_energy = executed.result.steps.first().unwrap().e_ex;
        let last_energy = executed.result.steps.last().unwrap().e_ex;
        assert!(
            last_energy <= first_energy + 1e-25,
            "BB should decrease exchange energy: {} -> {}",
            first_energy,
            last_energy
        );
    }

    #[test]
    fn ncg_relaxation_decreases_energy_on_random_initial() {
        let random_m0 = fullmag_plan::generate_random_unit_vectors(42, 16);
        let plan = FdmPlanIR {
            initial_magnetization: random_m0,
            relaxation: Some(RelaxationControlIR {
                algorithm: RelaxationAlgorithmIR::NonlinearCg,
                torque_tolerance: 1e-6,
                energy_tolerance: None,
                max_steps: 5000,
            }),
            ..make_test_plan()
        };

        let executed = execute_reference_fdm(&plan, 1e-9, &[], None, None)
            .expect("NCG relaxation should succeed");
        assert!(
            executed.result.steps.len() >= 2,
            "should have initial + final stats"
        );
        let first_energy = executed.result.steps.first().unwrap().e_ex;
        let last_energy = executed.result.steps.last().unwrap().e_ex;
        assert!(
            last_energy <= first_energy + 1e-25,
            "NCG should decrease exchange energy: {} -> {}",
            first_energy,
            last_energy
        );
    }

    #[test]
    fn all_algorithms_converge_to_similar_equilibrium() {
        let random_m0 = fullmag_plan::generate_random_unit_vectors(42, 16);
        let base = FdmPlanIR {
            initial_magnetization: random_m0,
            fixed_timestep: Some(5e-14), // larger dt for faster LLG convergence
            ..make_test_plan()
        };

        let mut energies = Vec::new();
        for algorithm in [
            RelaxationAlgorithmIR::LlgOverdamped,
            RelaxationAlgorithmIR::ProjectedGradientBb,
            RelaxationAlgorithmIR::NonlinearCg,
        ] {
            let plan = FdmPlanIR {
                relaxation: Some(RelaxationControlIR {
                    algorithm,
                    torque_tolerance: 1e-4,
                    energy_tolerance: None,
                    max_steps: 2000,
                }),
                ..base.clone()
            };
            let executed = execute_reference_fdm(&plan, 1e-9, &[], None, None)
                .expect(&format!("{:?} relaxation should succeed", algorithm));
            let final_energy = executed.result.steps.last().unwrap().e_total;
            energies.push((algorithm, final_energy));
        }

        // All algorithms should converge to similar energy (within 20% relative or 1e-25 absolute)
        let (_, ref_energy) = energies[0];
        for (algorithm, energy) in &energies[1..] {
            let delta = (energy - ref_energy).abs();
            let relative = if ref_energy.abs() > 1e-25 {
                delta / ref_energy.abs()
            } else {
                delta
            };
            assert!(
                relative < 0.2 || delta < 1e-25,
                "{:?} final energy {} differs from LLG reference {} by {:.1}%",
                algorithm,
                energy,
                ref_energy,
                relative * 100.0
            );
        }
    }
}
