//! FEM baseline helper: executes narrow FEM LLG via `fullmag-engine::fem`.
//!
//! This path is retained for tests, preview helpers, and provenance checks.
//! The public executable FEM CPU path routes through the MFEM/libCEED/hypre backend.
//!
//! Current narrow baseline slice:
//! - precomputed `MeshIR`
//! - `Exchange`, optional bootstrap `Demag`, and optional `Zeeman`
//! - `LLG(heun)`
//! - `double` precision

#![allow(dead_code)]

use fullmag_engine::fem::{
    FemBackendId, FemIntegratorWorkspace, FemLlgProblem, FemLlgState, MeshTopology,
};
use fullmag_engine::{
    dot, AdaptiveStepConfig, EffectiveFieldTerms, LlgConfig, MaterialParameters, TimeIntegrator,
    MU0,
};
use fullmag_ir::{ExecutionPrecision, FemObjectSegmentIR, FemPlanIR, IntegratorChoice, OutputIR};

use crate::antenna_fields::{
    combined_antenna_field_at_time, compute_per_unit_antenna_fields, has_time_varying_antenna,
};
use crate::artifact_pipeline::{ArtifactPipelineSender, ArtifactRecorder};
use crate::derived_fields::{compute_torque_field, max_torque_residual_apm_from_field};
use crate::interactive_runtime::{display_is_global_scalar, display_refresh_due};
use crate::preview::{
    build_mesh_preview_field_with_active_mask, build_mesh_scalar_preview_field_with_active_mask,
    flatten_vectors, mesh_quantity_active_mask, select_observables,
};
use crate::quantities::normalized_quantity_name;
use crate::relaxation::{
    llg_overdamped_uses_pure_damping, relaxation_converged, RelaxationEnergyPlateauWindow,
};
use crate::scalar_metrics::{
    apply_average_m_to_step_stats, average_magnetization_components,
    scalar_outputs_request_average_m, scalar_row_due, set_object_average_m, single_object_scalars,
    weighted_object_scalars,
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
    live: Option<LiveStepConsumer<'_>>,
    artifact_writer: Option<ArtifactPipelineSender>,
) -> Result<ExecutedRun, RunError> {
    execute_reference_fem_impl(plan, until_seconds, outputs, live, artifact_writer)
}

pub(crate) fn snapshot_preview(
    plan: &FemPlanIR,
    request: &LivePreviewRequest,
) -> Result<crate::LivePreviewField, RunError> {
    let (problem, state) = build_problem_and_state(plan)?;
    let antenna_field = problem
        .terms
        .per_node_field
        .clone()
        .unwrap_or_else(|| vec![[0.0, 0.0, 0.0]; state.magnetization().len()]);
    let observables = observe_state(&problem, &state, &antenna_field)?;
    build_fem_preview_field(
        request,
        &observables,
        &plan.mesh,
        problem.material.saturation_magnetisation,
    )
}

pub(crate) fn snapshot_vector_fields(
    plan: &FemPlanIR,
    quantities: &[&str],
    request: &LivePreviewRequest,
) -> Result<Vec<crate::LivePreviewField>, RunError> {
    let (problem, state) = build_problem_and_state(plan)?;
    let antenna_field = problem
        .terms
        .per_node_field
        .clone()
        .unwrap_or_else(|| vec![[0.0, 0.0, 0.0]; state.magnetization().len()]);
    let observables = observe_state(&problem, &state, &antenna_field)?;
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
        cached.push(build_fem_preview_field(
            &preview_request,
            &observables,
            &plan.mesh,
            problem.material.saturation_magnetisation,
        )?);
    }
    Ok(cached)
}

pub(crate) fn build_fem_preview_field(
    request: &LivePreviewRequest,
    observables: &StateObservables,
    mesh: &fullmag_ir::MeshIR,
    saturation_magnetisation: f64,
) -> Result<crate::LivePreviewField, RunError> {
    let quantity = normalized_quantity_name(&request.quantity)?;
    let active_mask = mesh_quantity_active_mask(quantity, mesh);
    if let Some(values) = fem_energy_density_values(
        observables,
        quantity,
        saturation_magnetisation,
        active_mask.as_deref(),
    )? {
        return Ok(build_mesh_scalar_preview_field_with_active_mask(
            request,
            &values,
            active_mask,
        ));
    }

    Ok(build_mesh_preview_field_with_active_mask(
        request,
        select_observables(observables, quantity)?,
        active_mask,
    ))
}

pub(crate) fn fem_energy_density_values(
    observables: &StateObservables,
    quantity: &str,
    saturation_magnetisation: f64,
    active_mask: Option<&[bool]>,
) -> Result<Option<Vec<f64>>, RunError> {
    let values = match quantity {
        "eden_ex" => field_dot_energy_density(
            &observables.magnetization,
            &observables.exchange_field,
            saturation_magnetisation,
            -0.5,
            active_mask,
            quantity,
        )?,
        "eden_demag" => field_dot_energy_density(
            &observables.magnetization,
            &observables.demag_field,
            saturation_magnetisation,
            -0.5,
            active_mask,
            quantity,
        )?,
        "eden_ext" => field_dot_energy_density(
            &observables.magnetization,
            &observables.external_field,
            saturation_magnetisation,
            -1.0,
            active_mask,
            quantity,
        )?,
        "eden_ani" => field_dot_energy_density(
            &observables.magnetization,
            &observables.anisotropy_field,
            saturation_magnetisation,
            -0.5,
            active_mask,
            quantity,
        )?,
        "eden_dmi" => field_dot_energy_density(
            &observables.magnetization,
            &observables.dmi_field,
            saturation_magnetisation,
            -0.5,
            active_mask,
            quantity,
        )?,
        "eden_total" => {
            let mut total = vec![0.0; observables.magnetization.len()];
            for term in ["eden_ex", "eden_demag", "eden_ext", "eden_ani", "eden_dmi"] {
                if let Some(values) = fem_energy_density_values(
                    observables,
                    term,
                    saturation_magnetisation,
                    active_mask,
                )? {
                    for (accum, value) in total.iter_mut().zip(values) {
                        *accum += value;
                    }
                }
            }
            total
        }
        _ => return Ok(None),
    };
    Ok(Some(values))
}

fn field_dot_energy_density(
    magnetization: &[[f64; 3]],
    field: &[[f64; 3]],
    saturation_magnetisation: f64,
    prefactor: f64,
    active_mask: Option<&[bool]>,
    quantity: &str,
) -> Result<Vec<f64>, RunError> {
    if field.is_empty() {
        return Ok(vec![0.0; magnetization.len()]);
    }
    if field.len() != magnetization.len() {
        return Err(RunError {
            message: format!(
                "FEM preview quantity '{}' requires a {}-node source field, got {} values",
                quantity,
                magnetization.len(),
                field.len()
            ),
        });
    }

    Ok(magnetization
        .iter()
        .zip(field.iter())
        .enumerate()
        .map(|(index, (m, h))| {
            if active_mask
                .and_then(|mask| mask.get(index))
                .is_some_and(|active| !*active)
            {
                0.0
            } else {
                prefactor * MU0 * saturation_magnetisation * dot(*m, *h)
            }
        })
        .collect())
}

pub(crate) fn fem_observables_for_magnetization(
    plan: &FemPlanIR,
    magnetization: &[[f64; 3]],
) -> Result<fullmag_engine::EffectiveFieldObservables, RunError> {
    let mut staged_plan = plan.clone();
    staged_plan.initial_magnetization = magnetization.to_vec();
    let (problem, state) = build_problem_and_state(&staged_plan)?;
    problem.observe(&state).map_err(|error| RunError {
        message: format!("FEM observe: {}", error),
    })
}

pub(crate) fn build_problem_and_state(
    plan: &FemPlanIR,
) -> Result<(FemLlgProblem, FemLlgState), RunError> {
    if !plan.mesh.periodic_node_pairs.is_empty()
        && (plan.enable_demag
            || plan.interfacial_dmi.is_some()
            || plan.bulk_dmi.is_some()
            || has_time_varying_antenna(plan))
    {
        return Err(RunError {
            message: format!(
                "FEM reference runner cannot execute mesh '{}' with {} periodic_node_pairs and \
                 demag/DMI/per-node drive terms: this time-domain path currently supports \
                 static periodic constraints only for exchange, uniform Zeeman field, and local \
                 anisotropy terms. Use the FEM eigen runner with spin_wave_bc='periodic'/'floquet' \
                 or disable the unsupported terms.",
                plan.mesh.mesh_name,
                plan.mesh.periodic_node_pairs.len()
            ),
        });
    }

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
    let integrator = match plan.integrator.unwrap_or(IntegratorChoice::Heun) {
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
        // Reject adaptive fields not supported by the internal FEM baseline engine.
        let mut unsupported = Vec::new();
        if adaptive.max_spin_rotation.is_some() {
            unsupported.push("max_spin_rotation".to_string());
        }
        if adaptive.norm_tolerance.is_some() {
            unsupported.push("norm_tolerance".to_string());
        }
        if !unsupported.is_empty() {
            return Err(RunError {
                message: format!(
                    "Internal FEM baseline engine does not support adaptive parameters: {}; \
                     supported: atol, rtol, dt_min, dt_max, safety, growth_limit, shrink_limit",
                    unsupported.join(", ")
                ),
            });
        }
        dynamics = dynamics.with_adaptive(AdaptiveStepConfig {
            max_error: adaptive.atol,
            dt_min: adaptive.dt_min,
            dt_max: adaptive.dt_max.unwrap_or(crate::DEFAULT_ADAPTIVE_DT_MAX),
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
    // FEM-010 fix: reject interactions not supported by the internal FEM baseline engine
    // instead of silently ignoring them.
    {
        let mut unsupported_terms = Vec::new();
        if plan.material.uniaxial_anisotropy.is_some()
            || plan.material.uniaxial_anisotropy_k2.is_some()
            || plan.material.ku_field.is_some()
            || plan.material.ku2_field.is_some()
        {
            unsupported_terms.push("uniaxial_anisotropy");
        }
        if plan.material.cubic_anisotropy_kc1.is_some()
            || plan.material.cubic_anisotropy_kc2.is_some()
            || plan.material.cubic_anisotropy_kc3.is_some()
            || plan.material.kc1_field.is_some()
            || plan.material.kc2_field.is_some()
            || plan.material.kc3_field.is_some()
        {
            unsupported_terms.push("cubic_anisotropy");
        }
        if plan.dind_field.is_some() {
            unsupported_terms.push("dind_field");
        }
        if plan.dbulk_field.is_some() {
            unsupported_terms.push("dbulk_field");
        }
        if plan.current_density.is_some() || plan.stt_degree.is_some() || plan.stt_beta.is_some() {
            unsupported_terms.push("zhang_li_stt");
        }
        if plan.stt_spin_polarization.is_some()
            || plan.stt_lambda.is_some()
            || plan.stt_epsilon_prime.is_some()
        {
            unsupported_terms.push("slonczewski_stt");
        }
        if plan.magnetoelastic.is_some() {
            unsupported_terms.push("magnetoelastic");
        }
        if !unsupported_terms.is_empty() {
            return Err(RunError {
                message: format!(
                    "Internal FEM baseline engine does not support the following interaction terms: {}; \
                     supported: exchange, demag (poisson), zeeman, interfacial_dmi, bulk_dmi. \
                     Use the native FEM GPU backend for these interactions.",
                    unsupported_terms.join(", ")
                ),
            });
        }
    }

    let per_unit_fields = compute_per_unit_antenna_fields(plan)?;
    let initial_antenna_field = if per_unit_fields.is_empty() {
        None
    } else {
        Some(combined_antenna_field_at_time(plan, &per_unit_fields, 0.0))
    };
    let terms = EffectiveFieldTerms {
        exchange: plan.enable_exchange,
        demag: plan.enable_demag,
        external_field: plan.external_field,
        per_node_field: initial_antenna_field,
        magnetoelastic: None,
        uniaxial_anisotropy: None,
        cubic_anisotropy: None,
        interfacial_dmi: plan.interfacial_dmi,
        bulk_dmi: plan.bulk_dmi,
        zhang_li_stt: None,
        slonczewski_stt: None,
        sot: None,
        oersted_cylinder: None,
    };
    let resolved_demag_realization = if !plan.enable_demag {
        None
    } else {
        plan.demag_realization
    };
    let mut problem = match resolved_demag_realization {
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
        Some(r) => {
            return Err(RunError {
                message: format!(
                    "FEM reference runner: demag model '{}' is not yet implemented",
                    r.model_name(),
                ),
            });
        }
        None => FemLlgProblem::with_terms(topology, material, dynamics, terms),
    };
    if let Some(normal) = plan.dmi_interface_normal {
        problem.set_dmi_interface_normal(normal);
    }
    // Wire user-configurable CG solver parameters from the plan.
    if let Some(ref policy) = plan.demag_solver_policy {
        problem.sparse_cg_tol = Some(policy.rtol);
        problem.sparse_cg_max_iter = Some(policy.max_iterations as usize);
    }
    problem
        .validate_reference_semantics()
        .map_err(|e| RunError {
            message: format!("FEM reference semantics: {}", e),
        })?;
    let state = problem
        .new_state(plan.initial_magnetization.clone())
        .map_err(|e| RunError {
            message: format!("State: {}", e),
        })?;
    Ok((problem, state))
}

pub(crate) fn execution_provenance(plan: &FemPlanIR) -> ExecutionProvenance {
    let resolved_demag_realization = reference_demag_provenance_name(plan);
    let dt_policy = if plan.adaptive_timestep.is_some() {
        Some("adaptive".to_string())
    } else if plan.fixed_timestep.is_some() {
        Some("user".to_string())
    } else {
        // No fallback: execute_reference_fem_impl returns an error
        // if neither fixed nor adaptive timestep is configured.
        None
    };
    let mut provenance = ExecutionProvenance {
        execution_engine: FemBackendId::CpuBaseline.provenance_name().to_string(),
        precision: "double".to_string(),
        demag_operator_kind: resolved_demag_realization.clone(),
        fft_backend: None,
        device_name: None,
        compute_capability: None,
        cuda_driver_version: None,
        cuda_runtime_version: None,
        requested_integrator: plan.integrator.map(|integrator| format!("{integrator:?}")),
        resolved_integrator: plan.integrator.map(|integrator| format!("{integrator:?}")),
        requested_demag_realization: plan
            .demag_realization
            .map(|r| r.provenance_name().to_string()),
        resolved_demag_realization,
        dt_policy,
        ..Default::default()
    };
    crate::relaxation::apply_energy_minimizer_provenance(&mut provenance, plan.relaxation.as_ref());
    provenance
}

fn reference_demag_provenance_name(plan: &FemPlanIR) -> Option<String> {
    if !plan.enable_demag {
        return None;
    }
    Some(
        plan.demag_realization
            .map(|realization| realization.provenance_name().to_string())
            .unwrap_or_else(|| "fem_poisson".to_string()),
    )
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

    let (mut problem, mut state) = build_problem_and_state(plan)?;
    // Precompute per-unit-current Biot-Savart fields for time-varying updates.
    let per_unit_antenna_fields = if has_time_varying_antenna(plan) {
        compute_per_unit_antenna_fields(plan)?
    } else {
        vec![]
    };
    let has_time_varying = !per_unit_antenna_fields.is_empty();
    // For the observation parameter we use the field already baked into the problem.
    let antenna_field_at = |p: &FemLlgProblem, n: usize| -> Vec<[f64; 3]> {
        p.terms
            .per_node_field
            .clone()
            .unwrap_or_else(|| vec![[0.0, 0.0, 0.0]; n])
    };
    let initial_magnetization = state.magnetization().to_vec();

    let mut dt =
        crate::resolve_initial_timestep(plan.fixed_timestep, plan.adaptive_timestep.as_ref())
            .ok_or_else(|| RunError {
                message: "no fixed_timestep or adaptive_timestep specified; \
                      please set an explicit timestep in your dynamics configuration"
                    .to_string(),
            })?;
    let mut steps = Vec::new();
    let mut step_count = 0u64;
    let provenance = execution_provenance(plan);
    let mut artifacts = if let Some(writer) = artifact_writer {
        ArtifactRecorder::streaming(provenance.clone(), writer)
    } else {
        ArtifactRecorder::in_memory(provenance.clone())
    };
    let mut scalar_schedules = collect_scalar_schedules(outputs)?;
    let mut field_schedules = collect_field_schedules(outputs)?;
    let default_scalar_trace = scalar_schedules.is_empty();

    if default_scalar_trace {
        let ant = antenna_field_at(&problem, state.magnetization().len());
        record_scalar_snapshot(
            &problem,
            &state,
            &ant,
            &plan.object_segments,
            &plan.mesh_parts,
            0,
            0.0,
            0,
            &mut steps,
            &mut artifacts,
        )?;
    } else {
        let ant = antenna_field_at(&problem, state.magnetization().len());
        record_due_outputs(
            &problem,
            &state,
            &ant,
            &plan.object_segments,
            &plan.mesh_parts,
            0,
            0.0,
            0,
            &mut scalar_schedules,
            &mut field_schedules,
            &mut steps,
            &mut artifacts,
            None,
            None,
        )?;
    }

    let mut energy_plateau = RelaxationEnergyPlateauWindow::default();
    let pure_damping_relax = llg_overdamped_uses_pure_damping(plan.relaxation.as_ref());
    let mut last_preview_revision: Option<u64> = None;
    let mut cancelled = false;
    let mut paused = false;
    let mut current_observables = {
        let ant = antenna_field_at(&problem, state.magnetization().len());
        observe_state(&problem, &state, &ant)?
    };
    let mut current_stats = make_step_stats(
        step_count,
        state.time_seconds,
        0.0,
        0,
        &current_observables,
        &plan.object_segments,
        &plan.mesh_parts,
    );

    let until_label = if until_seconds.is_finite() {
        format!("{until_seconds:.4e}")
    } else {
        "unbounded".to_string()
    };
    eprintln!(
        "[fullmag-runner] fem-baseline LLG loop: until={} dt_initial={:.4e} \
         max_steps={} torque_tol={}",
        until_label,
        dt,
        plan.relaxation
            .as_ref()
            .and_then(|c| c.stop.max_steps)
            .unwrap_or(0),
        plan.relaxation
            .as_ref()
            .and_then(|c| c.stop.torque_tolerance_apm)
            .map(|value| format!("{value:.4e}"))
            .unwrap_or_else(|| "none".to_string()),
    );

    let n_nodes = state.magnetization().len();
    let mut integrator_ws = FemIntegratorWorkspace::new(n_nodes);

    while state.time_seconds < until_seconds {
        if let Some(live) = live.as_mut() {
            if let Some(display_selection) = live.display_selection.map(|get| get()) {
                let preview_due = display_refresh_due(
                    last_preview_revision,
                    &display_selection,
                    current_stats.step,
                );
                let preview_targets_global_scalar = display_is_global_scalar(&display_selection);
                let preview_field = if preview_due && !preview_targets_global_scalar {
                    let request = display_selection.preview_request();
                    Some(build_mesh_preview_field_with_active_mask(
                        &request,
                        select_observables(&current_observables, &request.quantity)?,
                        mesh_quantity_active_mask(&request.quantity, &plan.mesh),
                    ))
                } else {
                    None
                };
                let action = (live.on_step)(StepUpdate {
            coupled_checkpoint: None,
                    stats: current_stats.clone(),
                    grid: live.grid,
                    fem_mesh: (current_stats.step == 0)
                        .then_some(crate::types::FemMeshPayload::from(plan)),
                    magnetization: None,
                    preview_field,
                    cached_preview_fields: None,
                    hysteresis_field_m_t: None,
                    hysteresis_point_index: None,
                    hysteresis_settle_step_index: None,
                    hysteresis_settle_step_kind: None,
                    hysteresis_settle_step_method: None,
                    scalar_row_due: preview_due && preview_targets_global_scalar,
                    finished: false,
                });
                if preview_due {
                    last_preview_revision = Some(display_selection.revision);
                }
                match action {
                    StepAction::Continue => {}
                    StepAction::Stop => {
                        cancelled = true;
                        break;
                    }
                    StepAction::Pause => {
                        paused = true;
                        break;
                    }
                }
            }
        }

        let dt_step = dt.min(until_seconds - state.time_seconds);
        // Update antenna field for time-varying drives (e.g. sinusoidal RF).
        if has_time_varying {
            problem.terms.per_node_field = Some(combined_antenna_field_at_time(
                plan,
                &per_unit_antenna_fields,
                state.time_seconds,
            ));
        }
        let wall_start = Instant::now();
        let report = problem
            .step_with_workspace(&mut state, dt_step, &mut integrator_ws)
            .map_err(|e| RunError {
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
            max_torque_Apm: report.max_torque_Apm,
            max_torque_T: report.max_torque_Apm * crate::MU0,
            wall_time_ns: wall_elapsed,
            ..StepStats::default()
        };
        current_stats = enrich_step_stats_from_magnetization(
            latest_stats.clone(),
            state.magnetization(),
            &plan.object_segments,
            &plan.mesh_parts,
        );

        if !default_scalar_trace || !field_schedules.is_empty() {
            let ant = antenna_field_at(&problem, state.magnetization().len());
            let field_due_now = field_schedules
                .iter()
                .any(|schedule| is_due(state.time_seconds, schedule.next_time));
            let display_selection = live
                .as_ref()
                .and_then(|handle| handle.display_selection.map(|get| get()));
            let preview_due = display_selection
                .as_ref()
                .map(|selection| display_refresh_due(last_preview_revision, selection, step_count))
                .unwrap_or(false);
            let preview_targets_global_scalar = display_selection
                .as_ref()
                .is_some_and(display_is_global_scalar);
            let need_observables_for_live_preview = preview_due && !preview_targets_global_scalar;
            let need_step_observables = field_due_now || need_observables_for_live_preview;
            let step_observables: Option<StateObservables> = if need_step_observables {
                let obs = observe_state(&problem, &state, &ant)?;
                current_observables = obs.clone();
                Some(obs)
            } else {
                None
            };
            record_due_outputs(
                &problem,
                &state,
                &ant,
                &plan.object_segments,
                &plan.mesh_parts,
                step_count,
                dt_step,
                wall_elapsed,
                &mut scalar_schedules,
                &mut field_schedules,
                &mut steps,
                &mut artifacts,
                step_observables.as_ref(),
                Some(&current_stats),
            )?;
            if let Some(live) = live.as_mut() {
                let heavy_payload_every = live.field_every_n.max(1);
                let display_selection = display_selection;
                let magnetization = if step_count % heavy_payload_every == 0 {
                    Some(flatten_vectors(state.magnetization()))
                } else {
                    None
                };
                let preview_field = if preview_due && !preview_targets_global_scalar {
                    let selection = display_selection.as_ref().expect("checked preview_due");
                    let request = selection.preview_request();
                    let observables = step_observables
                        .as_ref()
                        .expect("observables computed for non-scalar preview");
                    Some(build_mesh_preview_field_with_active_mask(
                        &request,
                        select_observables(observables, &request.quantity)?,
                        mesh_quantity_active_mask(&request.quantity, &plan.mesh),
                    ))
                } else {
                    None
                };
                let due_scalar_row = step_count <= 1
                    || step_count % heavy_payload_every == 0
                    || scalar_row_due(&scalar_schedules, state.time_seconds)
                    || (preview_due && preview_targets_global_scalar);
                let mut update_stats = latest_stats.clone();
                if due_scalar_row || scalar_outputs_request_average_m(&scalar_schedules) {
                    apply_average_m_to_step_stats(&mut update_stats, state.magnetization());
                }
                let action = (live.on_step)(StepUpdate {
            coupled_checkpoint: None,
                    stats: update_stats,
                    grid: live.grid,
                    fem_mesh: if step_count <= 1 {
                        Some(crate::types::FemMeshPayload::from(plan))
                    } else {
                        None
                    },
                    magnetization,
                    preview_field,
                    cached_preview_fields: None,
                    hysteresis_field_m_t: None,
                    hysteresis_point_index: None,
                    hysteresis_settle_step_index: None,
                    hysteresis_settle_step_kind: None,
                    hysteresis_settle_step_method: None,
                    scalar_row_due: due_scalar_row,
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
                match action {
                    StepAction::Continue => {}
                    StepAction::Stop => {
                        cancelled = true;
                    }
                    StepAction::Pause => {
                        paused = true;
                    }
                }
            }
        } else if let Some(live) = live.as_mut() {
            // No scheduled outputs, but live mode is active: compute observables once.
            let heavy_payload_every = live.field_every_n.max(1);
            let display_selection = live.display_selection.map(|get| get());
            let preview_due = display_selection
                .as_ref()
                .map(|selection| display_refresh_due(last_preview_revision, selection, step_count))
                .unwrap_or(false);
            let preview_targets_global_scalar = display_selection
                .as_ref()
                .is_some_and(display_is_global_scalar);
            let magnetization = if step_count % heavy_payload_every == 0 {
                Some(flatten_vectors(state.magnetization()))
            } else {
                None
            };
            let preview_field = if preview_due && !preview_targets_global_scalar {
                let selection = display_selection.as_ref().expect("checked preview_due");
                let request = selection.preview_request();
                let ant = antenna_field_at(&problem, state.magnetization().len());
                let observables = observe_state(&problem, &state, &ant)?;
                current_observables = observables.clone();
                Some(build_mesh_preview_field_with_active_mask(
                    &request,
                    select_observables(&current_observables, &request.quantity)?,
                    mesh_quantity_active_mask(&request.quantity, &plan.mesh),
                ))
            } else {
                None
            };
            let due_scalar_row = step_count <= 1
                || step_count % heavy_payload_every == 0
                || scalar_row_due(&scalar_schedules, state.time_seconds)
                || (preview_due && preview_targets_global_scalar);
            let mut update_stats = latest_stats.clone();
            if due_scalar_row || scalar_outputs_request_average_m(&scalar_schedules) {
                apply_average_m_to_step_stats(&mut update_stats, state.magnetization());
            }
            let action = (live.on_step)(StepUpdate {
            coupled_checkpoint: None,
                stats: update_stats,
                grid: live.grid,
                fem_mesh: if step_count <= 1 {
                    Some(crate::types::FemMeshPayload::from(plan))
                } else {
                    None
                },
                magnetization,
                preview_field,
                cached_preview_fields: None,
                hysteresis_field_m_t: None,
                hysteresis_point_index: None,
                hysteresis_settle_step_index: None,
                hysteresis_settle_step_kind: None,
                hysteresis_settle_step_method: None,
                scalar_row_due: due_scalar_row,
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
            match action {
                StepAction::Continue => {}
                StepAction::Stop => {
                    cancelled = true;
                }
                StepAction::Pause => {
                    paused = true;
                }
            }
        }

        if cancelled || paused {
            break;
        }

        let energy_plateau_range = energy_plateau.record(latest_stats.e_total);
        let stop_for_relaxation = plan.relaxation.as_ref().is_some_and(|control| {
            let max_steps_hit = step_count >= control.stop.max_steps.unwrap_or(u64::MAX);
            let converged = relaxation_converged(
                control,
                &latest_stats,
                energy_plateau_range,
                plan.gyromagnetic_ratio,
                plan.material.damping,
                pure_damping_relax,
            );
            if max_steps_hit || converged {
                eprintln!(
                    "[fullmag-runner] reference-fem relaxation stop at step {}: \
                     max_steps_hit={max_steps_hit} (step={} >= max_steps={}), \
                     converged={converged} \
                     (max_torque_T={:.4e} torque_tol={} energy_tol={})",
                    step_count,
                    step_count,
                    control
                        .stop
                        .max_steps
                        .map(|value| value.to_string())
                        .unwrap_or_else(|| "none".to_string()),
                    latest_stats.max_torque_T,
                    control
                        .stop
                        .torque_tolerance_apm
                        .map(|value| format!("{value:.4e}"))
                        .unwrap_or_else(|| "none".to_string()),
                    control
                        .stop
                        .energy_tolerance_j
                        .map(|value| format!("{value:.4e}"))
                        .unwrap_or_else(|| "none".to_string()),
                );
            }
            max_steps_hit || converged
        });
        if stop_for_relaxation {
            break;
        }
    }
    if !cancelled {
        let until_label = if until_seconds.is_finite() {
            format!("{until_seconds:.4e}")
        } else {
            "unbounded".to_string()
        };
        eprintln!(
            "[fullmag-runner] reference-fem loop exited: step={} time={:.4e} until={} (time_limit_reached={})",
            step_count,
            state.time_seconds,
            until_label,
            state.time_seconds >= until_seconds,
        );
    }

    let final_ant = antenna_field_at(&problem, state.magnetization().len());
    record_final_outputs(
        &problem,
        &state,
        &final_ant,
        &plan.object_segments,
        &plan.mesh_parts,
        step_count,
        dt,
        default_scalar_trace,
        &field_schedules,
        &mut steps,
        &mut artifacts,
        Some(&current_stats),
    )?;

    let (field_snapshots, field_snapshot_count, provenance) = artifacts.finish();
    let status = if paused {
        RunStatus::Paused
    } else if cancelled {
        RunStatus::Cancelled
    } else {
        RunStatus::Completed
    };
    let completion = crate::relaxation::resolve_stage_completion(
        status,
        plan.relaxation.as_ref(),
        crate::relaxation::RelaxationCompletionMetrics {
            max_torque_apm: Some(current_stats.max_torque_Apm),
            accepted_energy_plateau_range_j: energy_plateau.range(),
            steps: step_count,
            relaxation_time_s: Some(state.time_seconds),
            numerical_stagnation: false,
        },
    );

    Ok(ExecutedRun {
        result: RunResult {
            status,
            steps,
            final_magnetization: state.magnetization().to_vec(),
            completion: Some(completion),
        },
        initial_magnetization,
        field_snapshots,
        field_snapshot_count,
        auxiliary_artifacts: Vec::new(),
        provenance,
    })
}

fn record_due_outputs(
    problem: &FemLlgProblem,
    state: &FemLlgState,
    antenna_field: &[[f64; 3]],
    object_segments: &[FemObjectSegmentIR],
    mesh_parts: &[fullmag_ir::FemMeshPartIR],
    step: u64,
    solver_dt: f64,
    wall_time_ns: u64,
    scalar_schedules: &mut [OutputSchedule],
    field_schedules: &mut [OutputSchedule],
    steps: &mut Vec<StepStats>,
    artifacts: &mut ArtifactRecorder,
    precomputed_observables: Option<&StateObservables>,
    fallback_scalar_stats: Option<&StepStats>,
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

    if scalar_due && due_field_names.is_empty() {
        if let Some(stats) = fallback_scalar_stats {
            artifacts.record_scalar(stats)?;
            steps.push(stats.clone());
            advance_due_schedules(scalar_schedules, state.time_seconds);
            return Ok(());
        }
    }

    // Reuse pre-computed observables (from live block) to avoid a redundant observe call.
    let owned;
    let observables = match precomputed_observables {
        Some(obs) => obs,
        None => {
            owned = observe_state(problem, state, antenna_field)?;
            &owned
        }
    };

    if scalar_due {
        let stats = make_step_stats(
            step,
            state.time_seconds,
            solver_dt,
            wall_time_ns,
            &observables,
            object_segments,
            mesh_parts,
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
    problem: &FemLlgProblem,
    state: &FemLlgState,
    antenna_field: &[[f64; 3]],
    object_segments: &[FemObjectSegmentIR],
    mesh_parts: &[fullmag_ir::FemMeshPartIR],
    step: u64,
    solver_dt: f64,
    wall_time_ns: u64,
    steps: &mut Vec<StepStats>,
    artifacts: &mut ArtifactRecorder,
) -> Result<(), RunError> {
    let observables = observe_state(problem, state, antenna_field)?;
    let stats = make_step_stats(
        step,
        state.time_seconds,
        solver_dt,
        wall_time_ns,
        &observables,
        object_segments,
        mesh_parts,
    );
    artifacts.record_scalar(&stats)?;
    steps.push(stats);
    Ok(())
}

fn record_final_outputs(
    problem: &FemLlgProblem,
    state: &FemLlgState,
    antenna_field: &[[f64; 3]],
    object_segments: &[FemObjectSegmentIR],
    mesh_parts: &[fullmag_ir::FemMeshPartIR],
    step: u64,
    solver_dt: f64,
    default_scalar_trace: bool,
    field_schedules: &[OutputSchedule],
    steps: &mut Vec<StepStats>,
    artifacts: &mut ArtifactRecorder,
    fallback_scalar_stats: Option<&StepStats>,
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

    if need_scalar && missing_field_names.is_empty() {
        if let Some(stats) = fallback_scalar_stats {
            artifacts.record_scalar(stats)?;
            steps.push(stats.clone());
            return Ok(());
        }
    }

    let observables = observe_state(problem, state, antenna_field)?;
    if need_scalar {
        let stats = make_step_stats(
            step,
            state.time_seconds,
            solver_dt,
            0,
            &observables,
            object_segments,
            mesh_parts,
        );
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

fn enrich_step_stats_from_magnetization(
    mut stats: StepStats,
    magnetization: &[[f64; 3]],
    object_segments: &[FemObjectSegmentIR],
    mesh_parts: &[fullmag_ir::FemMeshPartIR],
) -> StepStats {
    apply_average_m_to_step_stats(&mut stats, magnetization);
    stats.per_object_scalars =
        fem_per_object_scalars(object_segments, mesh_parts, magnetization, &stats);
    stats
}

pub(crate) fn observe_state(
    problem: &FemLlgProblem,
    state: &FemLlgState,
    antenna_field: &[[f64; 3]],
) -> Result<StateObservables, RunError> {
    let observables = problem.observe(state).map_err(|e| RunError {
        message: format!("FEM engine observables: {}", e),
    })?;
    let torque_field = compute_torque_field(
        &observables.magnetization,
        &observables.effective_field,
        problem.material.damping,
        problem.dynamics.precession_enabled,
    );
    let max_torque_apm = max_torque_residual_apm_from_field(
        &observables.magnetization,
        &observables.effective_field,
    );

    Ok(StateObservables {
        magnetization: observables.magnetization,
        torque_field,
        exchange_field: observables.exchange_field,
        demag_field: observables.demag_field,
        external_field: observables.external_field,
        antenna_field: antenna_field.to_vec(),
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
        max_torque_Apm: max_torque_apm,
        per_object_scalars: std::collections::HashMap::new(),
    })
}

fn make_step_stats(
    step: u64,
    time: f64,
    solver_dt: f64,
    wall_time_ns: u64,
    observables: &StateObservables,
    object_segments: &[FemObjectSegmentIR],
    mesh_parts: &[fullmag_ir::FemMeshPartIR],
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
        max_torque_Apm: observables.max_torque_Apm,
        max_torque_T: observables.max_torque_Apm * crate::MU0,
        wall_time_ns,
        ..StepStats::default()
    };
    apply_average_m_to_step_stats(&mut stats, &observables.magnetization);
    stats.per_object_scalars = fem_per_object_scalars(
        object_segments,
        mesh_parts,
        &observables.magnetization,
        &stats,
    );
    stats
}

fn fem_per_object_scalars(
    object_segments: &[FemObjectSegmentIR],
    mesh_parts: &[fullmag_ir::FemMeshPartIR],
    magnetization: &[[f64; 3]],
    stats: &StepStats,
) -> std::collections::HashMap<String, std::collections::HashMap<String, f64>> {
    if object_segments.is_empty() {
        return single_object_scalars("free", stats);
    }

    let mut weights_by_object: std::collections::HashMap<String, f64> =
        std::collections::HashMap::new();
    for segment in object_segments {
        let weight = fem_segment_node_indices(mesh_parts, segment, magnetization.len())
            .len()
            .max(1) as f64;
        *weights_by_object
            .entry(segment.object_id.clone())
            .or_insert(0.0) += weight;
    }
    let weights = weights_by_object.into_iter().collect::<Vec<_>>();
    let mut per_object = weighted_object_scalars(stats, &weights);
    for segment in object_segments {
        let node_indices = fem_segment_node_indices(mesh_parts, segment, magnetization.len());
        if node_indices.is_empty() {
            set_object_average_m(
                &mut per_object,
                &segment.object_id,
                magnetization,
                segment.node_start as usize,
                segment.node_count as usize,
            );
        } else {
            set_object_average_m_by_indices(
                &mut per_object,
                &segment.object_id,
                magnetization,
                &node_indices,
            );
        }
    }
    if per_object.is_empty() {
        return single_object_scalars("free", stats);
    }
    per_object
}

fn runtime_object_ids_match(a: &str, b: &str) -> bool {
    if a == b {
        return true;
    }
    let clean_a = a.strip_suffix("_geom").unwrap_or(a);
    let clean_b = b.strip_suffix("_geom").unwrap_or(b);
    clean_a == clean_b
}

fn fem_mesh_part_matches_segment(
    part: &fullmag_ir::FemMeshPartIR,
    segment: &FemObjectSegmentIR,
) -> bool {
    part.role == fullmag_ir::FemMeshPartRole::MagneticObject
        && (part
            .object_id
            .as_deref()
            .is_some_and(|id| runtime_object_ids_match(id, &segment.object_id))
            || part
                .geometry_id
                .as_deref()
                .zip(segment.geometry_id.as_deref())
                .is_some_and(|(part_geometry, segment_geometry)| {
                    runtime_object_ids_match(part_geometry, segment_geometry)
                })
            || runtime_object_ids_match(&part.id, &segment.object_id))
}

fn fem_segment_node_indices(
    mesh_parts: &[fullmag_ir::FemMeshPartIR],
    segment: &FemObjectSegmentIR,
    total_nodes: usize,
) -> Vec<usize> {
    if let Some(part) = mesh_parts
        .iter()
        .find(|part| fem_mesh_part_matches_segment(part, segment))
    {
        let node_indices = part
            .node_indices
            .iter()
            .map(|index| *index as usize)
            .filter(|index| *index < total_nodes)
            .collect::<std::collections::BTreeSet<_>>()
            .into_iter()
            .collect::<Vec<_>>();
        if !node_indices.is_empty() {
            return node_indices;
        }
    }

    let start = segment.node_start as usize;
    let end = start
        .saturating_add(segment.node_count as usize)
        .min(total_nodes);
    (start..end).collect()
}

fn set_object_average_m_by_indices(
    per_object: &mut std::collections::HashMap<String, std::collections::HashMap<String, f64>>,
    object_id: &str,
    magnetization: &[[f64; 3]],
    node_indices: &[usize],
) {
    let values = node_indices
        .iter()
        .filter_map(|index| magnetization.get(*index).copied())
        .collect::<Vec<_>>();
    if values.is_empty() {
        return;
    }
    let [mx, my, mz] = average_magnetization_components(&values);
    let entry = per_object.entry(object_id.to_string()).or_default();
    entry.insert("mx".to_string(), mx);
    entry.insert("my".to_string(), my);
    entry.insert("mz".to_string(), mz);
}

fn select_field_values(
    observables: &StateObservables,
    name: &str,
) -> Result<Vec<[f64; 3]>, RunError> {
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
        "H_ant" => Ok(observables.antenna_field.clone()),
        "H_ext" => Ok(observables.external_field.clone()),
        "H_eff" => Ok(observables.effective_field.clone()),
        "torque" => Ok(observables.torque_field.clone()),
        other => Err(RunError {
            message: format!(
                "CPU FEM snapshot: field '{}' is not available in this execution path \
                 (available: m, H_ex, H_demag, H_ant, H_ext, H_eff)",
                other
            ),
        }),
    }
}

#[cfg(test)]
mod tests {
    use super::*;
    use fullmag_ir::{
        AirBoxConfigIR, ExchangeBoundaryCondition, ExecutionPrecision, FemMeshPartIR,
        FemMeshPartRole, FemMeshPartSelector, FemObjectSegmentIR, FemPlanIR, IntegratorChoice,
        MaterialIR, MeshIR, RelaxationAlgorithmIR, RelaxationControlIR,
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
                periodic_boundary_pairs: Vec::new(),
                periodic_node_pairs: Vec::new(),
                per_domain_quality: std::collections::HashMap::new(),
            },
            object_segments: Vec::new(),
            mesh_parts: Vec::new(),
            mesh_build_report: None,
            domain_mesh_mode: fullmag_ir::FemDomainMeshModeIR::MergedMagneticMesh,
            domain_frame: None,
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
                uniaxial_anisotropy_k2: None,
                cubic_anisotropy_kc1: None,
                cubic_anisotropy_kc2: None,
                cubic_anisotropy_kc3: None,
                cubic_anisotropy_axis1: None,
                cubic_anisotropy_axis2: None,
                ms_field: None,
                a_field: None,
                alpha_field: None,
                ku_field: None,
                ku2_field: None,
                kc1_field: None,
                kc2_field: None,
                kc3_field: None,
                interfacial_dmi: None,
                bulk_dmi: None,
                dind_field: None,
                dbulk_field: None,
            },
            anisotropy_axis_field: None,
            ms_element_field: None,
            a_element_field: None,
            region_materials: Vec::new(),
            enable_exchange: true,
            enable_demag,
            external_field: None,
            antenna_zeeman_masks: Vec::new(),
            current_modules: vec![],
            gyromagnetic_ratio: 2.211e5,
            precision: ExecutionPrecision::Double,
            exchange_bc: ExchangeBoundaryCondition::Neumann,
            integrator: Some(IntegratorChoice::Heun),
            fixed_timestep: Some(1e-13),
            adaptive_timestep: None,
            field_refresh: None,
            relaxation: None,
            demag_realization: None,
            air_box_config: None,
            interfacial_dmi: None,
            bulk_dmi: None,
            dind_field: None,
            dbulk_field: None,
            temperature: None,
            current_density: None,
            stt_degree: None,
            stt_beta: None,
            stt_spin_polarization: None,
            stt_lambda: None,
            stt_epsilon_prime: None,
            stt_thickness: None,
            stt_fixed_layer_position: None,
            spin_torque_contract: None,
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
            magnetoelastic: None,
            mechanics: None,
            demag_solver_policy: None,
            thermal_seed_config: None,
            oersted_realization: None,
            gpu_device_index: None,
            mfem_device_string: None,
            dmi_interface_normal: None,
            use_consistent_mass: None,
        }
    }

    fn add_periodic_pair(plan: &mut FemPlanIR) {
        plan.mesh.periodic_boundary_pairs = vec![fullmag_ir::MeshPeriodicBoundaryPairIR {
            pair_id: "x_periodic".to_string(),
            source_marker: None,
            destination_marker: None,
            marker_a: 1,
            marker_b: 1,
            translation: Some([1.0, 0.0, 0.0]),
            tolerance: Some(1e-12),
            axis_hint: None,
            orientation: None,
            pairing_policy: None,
        }];
        plan.mesh.periodic_node_pairs = vec![fullmag_ir::MeshPeriodicNodePairIR {
            pair_id: "x_periodic".to_string(),
            node_a: 0,
            node_b: 1,
        }];
    }

    #[test]
    fn reference_runner_accepts_exchange_only_static_periodic_mesh_pairs() {
        let mut plan = make_test_plan(false);
        plan.initial_magnetization[1] = [0.0, 1.0, 0.0];
        add_periodic_pair(&mut plan);

        let (_problem, state) =
            build_problem_and_state(&plan).expect("exchange-only static PBC should build");
        assert_eq!(state.magnetization()[0], state.magnetization()[1]);
    }

    #[test]
    fn reference_runner_rejects_periodic_demag_mesh_pairs() {
        let mut plan = make_test_plan(true);
        add_periodic_pair(&mut plan);

        let err = build_problem_and_state(&plan)
            .expect_err("reference FEM runner must reject unreduced periodic demag");
        assert!(
            err.message.contains("periodic_node_pairs")
                && err.message.contains("demag/DMI/per-node drive terms"),
            "unexpected error: {}",
            err.message
        );
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
                periodic_boundary_pairs: Vec::new(),
                periodic_node_pairs: Vec::new(),
                per_domain_quality: std::collections::HashMap::new(),
            },
            object_segments: Vec::new(),
            mesh_parts: Vec::new(),
            mesh_build_report: None,
            domain_mesh_mode: fullmag_ir::FemDomainMeshModeIR::MergedMagneticMesh,
            domain_frame: None,
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
                uniaxial_anisotropy_k2: None,
                cubic_anisotropy_kc1: None,
                cubic_anisotropy_kc2: None,
                cubic_anisotropy_kc3: None,
                cubic_anisotropy_axis1: None,
                cubic_anisotropy_axis2: None,
                ms_field: None,
                a_field: None,
                alpha_field: None,
                ku_field: None,
                ku2_field: None,
                kc1_field: None,
                kc2_field: None,
                kc3_field: None,
                interfacial_dmi: None,
                bulk_dmi: None,
                dind_field: None,
                dbulk_field: None,
            },
            anisotropy_axis_field: None,
            ms_element_field: None,
            a_element_field: None,
            region_materials: Vec::new(),
            enable_exchange: true,
            enable_demag: true,
            external_field: None,
            antenna_zeeman_masks: Vec::new(),
            current_modules: vec![],
            gyromagnetic_ratio: 2.211e5,
            precision: ExecutionPrecision::Double,
            exchange_bc: ExchangeBoundaryCondition::Neumann,
            integrator: Some(IntegratorChoice::Heun),
            fixed_timestep: Some(1e-13),
            adaptive_timestep: None,
            field_refresh: None,
            relaxation: None,
            demag_realization: None,
            air_box_config: None,
            interfacial_dmi: None,
            bulk_dmi: None,
            dind_field: None,
            dbulk_field: None,
            temperature: None,
            current_density: None,
            stt_degree: None,
            stt_beta: None,
            stt_spin_polarization: None,
            stt_lambda: None,
            stt_epsilon_prime: None,
            stt_thickness: None,
            stt_fixed_layer_position: None,
            spin_torque_contract: None,
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
            magnetoelastic: None,
            mechanics: None,
            demag_solver_policy: None,
            thermal_seed_config: None,
            oersted_realization: None,
            gpu_device_index: None,
            mfem_device_string: None,
            dmi_interface_normal: None,
            use_consistent_mass: None,
        }
    }

    fn structured_node_index(i: usize, j: usize, k: usize, divisions: usize) -> usize {
        let stride = divisions + 1;
        k * stride * stride + j * stride + i
    }

    fn collect_boundary_faces(elements: &[[u32; 4]]) -> Vec<[u32; 3]> {
        let mut counts = std::collections::BTreeMap::<[u32; 3], usize>::new();
        for element in elements {
            let [a, b, c, d] = *element;
            for mut face in [[a, b, c], [a, b, d], [a, c, d], [b, c, d]] {
                face.sort_unstable();
                *counts.entry(face).or_default() += 1;
            }
        }
        counts
            .into_iter()
            .filter_map(|(face, count)| (count == 1).then_some(face))
            .collect()
    }

    fn build_structured_shared_domain_airbox_mesh() -> MeshIR {
        let box_size_m = [6.0, 6.0, 6.0];
        let divisions = 3usize;
        let dx = box_size_m[0] / divisions as f64;
        let dy = box_size_m[1] / divisions as f64;
        let dz = box_size_m[2] / divisions as f64;

        let mut nodes = Vec::with_capacity((divisions + 1).pow(3));
        for k in 0..=divisions {
            let z = -0.5 * box_size_m[2] + k as f64 * dz;
            for j in 0..=divisions {
                let y = -0.5 * box_size_m[1] + j as f64 * dy;
                for i in 0..=divisions {
                    let x = -0.5 * box_size_m[0] + i as f64 * dx;
                    nodes.push([x, y, z]);
                }
            }
        }

        let mut elements = Vec::with_capacity(divisions * divisions * divisions * 6);
        for k in 0..divisions {
            for j in 0..divisions {
                for i in 0..divisions {
                    let n0 = structured_node_index(i, j, k, divisions) as u32;
                    let n1 = structured_node_index(i + 1, j, k, divisions) as u32;
                    let n2 = structured_node_index(i + 1, j + 1, k, divisions) as u32;
                    let n3 = structured_node_index(i, j + 1, k, divisions) as u32;
                    let n4 = structured_node_index(i, j, k + 1, divisions) as u32;
                    let n5 = structured_node_index(i + 1, j, k + 1, divisions) as u32;
                    let n6 = structured_node_index(i + 1, j + 1, k + 1, divisions) as u32;
                    let n7 = structured_node_index(i, j + 1, k + 1, divisions) as u32;
                    elements.extend_from_slice(&[
                        [n0, n1, n2, n6],
                        [n0, n2, n3, n6],
                        [n0, n3, n7, n6],
                        [n0, n7, n4, n6],
                        [n0, n4, n5, n6],
                        [n0, n5, n1, n6],
                    ]);
                }
            }
        }

        let mut element_markers = vec![0u32; elements.len()];
        for (element_index, element) in elements.iter().enumerate() {
            let centroid = element.iter().fold([0.0; 3], |acc, node| {
                let coord = nodes[*node as usize];
                [acc[0] + coord[0], acc[1] + coord[1], acc[2] + coord[2]]
            });
            let centroid = [centroid[0] * 0.25, centroid[1] * 0.25, centroid[2] * 0.25];
            if centroid[0] < -1.0 && centroid[1] < -1.0 && centroid[2] < -1.0 {
                element_markers[element_index] = 1;
            }
        }

        let boundary_faces = collect_boundary_faces(&elements);
        let boundary_markers = vec![99u32; boundary_faces.len()];
        MeshIR {
            mesh_name: "shared_domain_airbox_structured".to_string(),
            nodes,
            elements,
            element_markers,
            boundary_faces,
            boundary_markers,
            periodic_boundary_pairs: Vec::new(),
            periodic_node_pairs: Vec::new(),
            per_domain_quality: std::collections::HashMap::new(),
        }
    }

    fn make_shared_domain_airbox_demag_plan() -> FemPlanIR {
        let mesh = build_structured_shared_domain_airbox_mesh();
        FemPlanIR {
            mesh_name: mesh.mesh_name.clone(),
            mesh_source: None,
            mesh,
            object_segments: Vec::new(),
            mesh_parts: Vec::new(),
            mesh_build_report: None,
            domain_mesh_mode: fullmag_ir::FemDomainMeshModeIR::SharedDomainMeshWithAir,
            domain_frame: None,
            fe_order: 1,
            hmax: 10e-9,
            initial_magnetization: vec![[0.0, 0.0, 1.0]; 64],
            material: MaterialIR {
                name: "Py".to_string(),
                saturation_magnetisation: 800e3,
                exchange_stiffness: 13e-12,
                damping: 0.5,
                uniaxial_anisotropy: None,
                anisotropy_axis: None,
                uniaxial_anisotropy_k2: None,
                cubic_anisotropy_kc1: None,
                cubic_anisotropy_kc2: None,
                cubic_anisotropy_kc3: None,
                cubic_anisotropy_axis1: None,
                cubic_anisotropy_axis2: None,
                ms_field: None,
                a_field: None,
                alpha_field: None,
                ku_field: None,
                ku2_field: None,
                kc1_field: None,
                kc2_field: None,
                kc3_field: None,
                interfacial_dmi: None,
                bulk_dmi: None,
                dind_field: None,
                dbulk_field: None,
            },
            anisotropy_axis_field: None,
            ms_element_field: None,
            a_element_field: None,
            region_materials: Vec::new(),
            enable_exchange: true,
            enable_demag: true,
            external_field: None,
            antenna_zeeman_masks: Vec::new(),
            current_modules: vec![],
            gyromagnetic_ratio: 2.211e5,
            precision: ExecutionPrecision::Double,
            exchange_bc: ExchangeBoundaryCondition::Neumann,
            integrator: Some(IntegratorChoice::Heun),
            fixed_timestep: Some(1e-13),
            adaptive_timestep: None,
            field_refresh: None,
            relaxation: None,
            demag_realization: Some(fullmag_ir::ResolvedFemDemagIR::PoissonRobin),
            air_box_config: Some(AirBoxConfigIR {
                factor: 1.5,
                grading: 1.0,
                boundary_marker: 99,
                bc_kind: Some("dirichlet".to_string()),
                robin_beta_mode: None,
                robin_beta_factor: None,
                shape: Some("bbox".to_string()),
                factor_source: None,
                boundary_marker_source: None,
            }),
            interfacial_dmi: None,
            bulk_dmi: None,
            dind_field: None,
            dbulk_field: None,
            temperature: None,
            current_density: None,
            stt_degree: None,
            stt_beta: None,
            stt_spin_polarization: None,
            stt_lambda: None,
            stt_epsilon_prime: None,
            stt_thickness: None,
            stt_fixed_layer_position: None,
            spin_torque_contract: None,
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
            magnetoelastic: None,
            mechanics: None,
            demag_solver_policy: None,
            thermal_seed_config: None,
            oersted_realization: None,
            gpu_device_index: None,
            mfem_device_string: None,
            dmi_interface_normal: None,
            use_consistent_mass: None,
        }
    }

    #[test]
    fn uniform_fem_relaxation_produces_near_zero_exchange_energy() {
        let plan = make_test_plan(false);
        let result =
            execute_reference_fem(&plan, 1e-12, &[], None, None).expect("FEM run should succeed");
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
        let result = execute_reference_fem(&plan, 1e-12, &[], None, None)
            .expect("FEM demag run should succeed");
        assert_eq!(result.result.status, RunStatus::Completed);
        let last = result.result.steps.last().expect("at least one step");
        assert!(last.e_demag >= 0.0);
        assert!(last.max_h_demag > 0.0);
    }

    #[test]
    fn dmi_terms_are_supported_in_fem_baseline() {
        let mut plan = make_test_plan(false);
        plan.interfacial_dmi = Some(3e-3);
        plan.bulk_dmi = Some(2e-3);
        plan.dmi_interface_normal = Some([1.0, 0.0, 0.0]);
        plan.initial_magnetization = vec![
            [0.0, 0.0, 1.0],
            [1.0, 0.0, 0.0],
            [0.0, 1.0, 0.0],
            [1.0, 0.0, 0.0],
        ];

        let result = execute_reference_fem(&plan, 1e-12, &[], None, None)
            .expect("FEM DMI run should succeed");
        assert_eq!(result.result.status, RunStatus::Completed);
        let last = result.result.steps.last().expect("at least one step");
        assert!(
            last.max_h_eff > 1e-6,
            "DMI terms should contribute to H_eff, got {}",
            last.max_h_eff
        );
    }

    #[test]
    fn fem_snapshot_vector_cache_contains_nonzero_demag_related_fields() {
        let plan = make_box_demag_plan();
        let fields = snapshot_vector_fields(
            &plan,
            &["H_ex", "H_demag", "H_eff"],
            &crate::LivePreviewRequest::default(),
        )
        .expect("FEM preview cache snapshot should succeed");

        assert_eq!(fields.len(), 3);
        let h_demag = fields
            .iter()
            .find(|field| field.quantity == "H_demag")
            .expect("H_demag preview should be present");
        let h_eff = fields
            .iter()
            .find(|field| field.quantity == "H_eff")
            .expect("H_eff preview should be present");
        assert_eq!(h_demag.spatial_kind, "mesh");
        assert_eq!(h_eff.spatial_kind, "mesh");
        assert!(
            h_demag
                .vector_field_values
                .iter()
                .any(|value| value.abs() > 0.0),
            "expected FEM cached H_demag preview to contain nonzero values"
        );
        assert!(
            h_eff
                .vector_field_values
                .iter()
                .any(|value| value.abs() > 0.0),
            "expected FEM cached H_eff preview to contain nonzero values"
        );
    }

    #[test]
    fn fem_snapshot_exposes_energy_density_scalar_fields() {
        let mut plan = make_box_demag_plan();
        plan.external_field = Some([0.0, 0.0, 1.0]);
        plan.initial_magnetization = vec![[0.0, 0.0, 1.0]; plan.mesh.nodes.len()];

        let fields = snapshot_vector_fields(
            &plan,
            &["eden_ex", "eden_demag", "eden_ext", "eden_total"],
            &crate::LivePreviewRequest::default(),
        )
        .expect("FEM energy density preview snapshot should succeed");

        let total = fields
            .iter()
            .find(|field| field.quantity == "eden_total")
            .expect("eden_total preview should be present");
        assert_eq!(fields.len(), 4);
        assert_eq!(total.spatial_kind, "mesh");
        assert_eq!(total.unit, "J/m³");
        assert_eq!(total.vector_field_values.len(), plan.mesh.nodes.len());
        assert!(
            total
                .vector_field_values
                .iter()
                .any(|value| value.abs() > 0.0),
            "expected FEM eden_total preview to contain nonzero scalar values"
        );
    }

    #[test]
    fn fem_airbox_plan_uses_airbox_demag_operator_in_reference_runner() {
        let plan = make_shared_domain_airbox_demag_plan();
        let (_problem, _state) = build_problem_and_state(&plan)
            .expect("shared-domain FEM airbox problem should build in reference runner");
        let provenance = execution_provenance(&plan);

        assert_eq!(
            provenance.demag_operator_kind.as_deref(),
            Some("fem_poisson_robin"),
        );

        let fields =
            snapshot_vector_fields(&plan, &["H_demag"], &crate::LivePreviewRequest::default())
                .expect("shared-domain FEM demag preview should succeed");
        let h_demag = fields
            .iter()
            .find(|field| field.quantity == "H_demag")
            .expect("H_demag preview should be present");
        assert_eq!(h_demag.quantity_domain, "full_domain");
        assert_eq!(h_demag.vector_field_values.len(), plan.mesh.nodes.len() * 3);
    }

    #[test]
    fn baseline_provenance_defaults_implicit_demag_to_fem_poisson() {
        let plan = make_test_plan(true);
        let provenance = execution_provenance(&plan);

        assert_eq!(provenance.execution_engine, "fem_cpu_baseline_internal");
        assert_eq!(provenance.requested_demag_realization, None);
        assert_eq!(
            provenance.resolved_demag_realization.as_deref(),
            Some("fem_poisson")
        );
        assert_eq!(
            provenance.demag_operator_kind.as_deref(),
            Some("fem_poisson")
        );
    }

    #[test]
    fn fem_per_object_scalars_uses_mesh_part_node_indices_for_shared_nodes() {
        let segment = FemObjectSegmentIR {
            object_id: "body".to_string(),
            geometry_id: Some("body".to_string()),
            node_start: 0,
            node_count: 3,
            element_start: 0,
            element_count: 1,
            boundary_face_start: 0,
            boundary_face_count: 1,
        };
        let mesh_part = FemMeshPartIR {
            id: "body".to_string(),
            label: "body".to_string(),
            role: FemMeshPartRole::MagneticObject,
            object_id: Some("body".to_string()),
            geometry_id: Some("body".to_string()),
            material_id: None,
            element_selector: FemMeshPartSelector::ElementRange { start: 0, count: 1 },
            boundary_face_selector: FemMeshPartSelector::BoundaryFaceRange { start: 0, count: 1 },
            node_selector: FemMeshPartSelector::NodeRange { start: 0, count: 3 },
            boundary_face_indices: Vec::new(),
            node_indices: vec![1, 3, 5],
            surface_faces: Vec::new(),
            bounds_min: None,
            bounds_max: None,
            parent_id: None,
        };
        let stats = StepStats {
            e_total: 100.0,
            ..StepStats::default()
        };
        let magnetization = vec![
            [10.0, 0.0, 0.0],
            [1.0, 0.0, 0.0],
            [20.0, 0.0, 0.0],
            [3.0, 0.0, 0.0],
            [30.0, 0.0, 0.0],
            [5.0, 0.0, 0.0],
        ];

        let per_object = fem_per_object_scalars(&[segment], &[mesh_part], &magnetization, &stats);

        assert_eq!(per_object["body"]["mx"], 3.0);
    }

    #[test]
    fn fem_callback_emits_live_updates() {
        let plan = make_test_plan(true);
        let mut seen = 0usize;
        let mut on_step = |update: StepUpdate| -> StepAction {
            seen += 1;
            assert_eq!(update.grid, [0, 0, 0]);
            StepAction::Continue
        };
        let result = execute_reference_fem(
            &plan,
            5e-13,
            &[],
            Some(LiveStepConsumer {
                grid: [0, 0, 0],
                field_every_n: 2,
                initial_snapshot: false,
                display_selection: None,
                interrupt_requested: None,
                on_step: &mut on_step,
            }),
            None,
        )
        .expect("callback FEM run should succeed");

        assert_eq!(result.result.status, RunStatus::Completed);
        assert!(seen > 0, "expected at least one live FEM callback update");
    }

    #[test]
    fn llg_overdamped_relaxation_stops_before_time_limit_on_uniform_fem_state() {
        let plan = FemPlanIR {
            relaxation: Some(RelaxationControlIR {
                algorithm: RelaxationAlgorithmIR::LlgOverdamped,
                stop: fullmag_ir::RelaxStopIR {
                    torque_tolerance_apm: Some(1e-6),
                    energy_tolerance_j: None,
                    max_steps: Some(1000),
                    max_relaxation_time_s: None,
                },
            }),
            ..make_test_plan(false)
        };

        let executed = execute_reference_fem(&plan, 1e-9, &[], None, None)
            .expect("FEM relaxation run should succeed");

        assert!(executed.result.steps.len() <= 2);
        let final_time = executed.result.steps.last().expect("final stats").time;
        assert!(
            final_time < 1e-9,
            "FEM relaxation should stop early, got final_time={final_time}"
        );
    }
}
