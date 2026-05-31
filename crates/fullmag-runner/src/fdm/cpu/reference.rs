//! CPU reference engine: executes FDM LLG via `fullmag-engine`.
//!
//! This remains the calibration baseline for terms that are not yet wired
//! into the native CUDA backend.

use fullmag_engine::{
    magnetoelastic::{MagnetoelasticParams, PrescribedStrainField},
    AdaptiveStepConfig, AxisBoundary, CellSize, CubicAnisotropyConfig, EffectiveFieldTerms,
    EngineError, EvaluationRequest, ExchangeLlgProblem, ExchangeLlgState, ExchangeLlgStateSoA,
    FdmBoundaryPolicy, FftWorkspace, GridShape, IntegratorBuffers, LlgConfig,
    MagnetoelasticTermConfig, MaterialParameters, OerstedCylinderConfig, SlonczewskiSttConfig,
    SotConfig, StepReport, TimeIntegrator, UniaxialAnisotropyConfig, Vector3, ZhangLiSttConfig,
};
use fullmag_ir::{
    ExecutionPrecision, FdmPlanIR, IntegratorChoice, OutputIR, RelaxationAlgorithmIR,
};

use crate::artifact_pipeline::{ArtifactPipelineSender, ArtifactRecorder};
use crate::derived_fields::{compute_torque_field, max_torque_residual_apm_from_field};
use crate::fdm::artifacts::select_state_observable_field;
use crate::interactive_runtime::{display_is_global_scalar, display_refresh_due};
use crate::preview::{
    build_grid_preview_field, build_grid_scalar_preview_field, flatten_vectors, select_observables,
};
use crate::quantities::normalized_quantity_name;
use crate::relaxation::{
    apply_energy_minimizer_provenance, execute_nonlinear_cg, execute_projected_gradient_bb,
    llg_overdamped_uses_pure_damping, relaxation_converged, RelaxationEnergyPlateauWindow,
    CPU_SOA_DIRECT_MINIMIZER_REALIZATION,
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

use std::{env, time::Instant};

pub(crate) const CPU_FFT_BACKEND_ENV: &str = "FULLMAG_CPU_FFT_BACKEND";

#[cfg(test)]
thread_local! {
    static OBSERVE_STATE_CALLS: std::cell::Cell<usize> = std::cell::Cell::new(0);
    static DIRECT_H_EFF_ASSEMBLIES: std::cell::Cell<usize> = std::cell::Cell::new(0);
}

#[cfg(test)]
pub(crate) fn reset_observe_state_calls() {
    OBSERVE_STATE_CALLS.with(|calls| calls.set(0));
}

#[cfg(test)]
pub(crate) fn reset_direct_field_assembly_calls() {
    DIRECT_H_EFF_ASSEMBLIES.with(|calls| calls.set(0));
}

#[cfg(test)]
pub(crate) fn observe_state_call_count() -> usize {
    OBSERVE_STATE_CALLS.with(|calls| calls.get())
}

#[cfg(test)]
pub(crate) fn direct_h_eff_assembly_call_count() -> usize {
    DIRECT_H_EFF_ASSEMBLIES.with(|calls| calls.get())
}

#[cfg(test)]
fn increment_observe_state_calls() {
    OBSERVE_STATE_CALLS.with(|calls| calls.set(calls.get() + 1));
}

#[cfg(test)]
fn increment_direct_h_eff_assembly_calls() {
    DIRECT_H_EFF_ASSEMBLIES.with(|calls| calls.set(calls.get() + 1));
}

#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub(crate) enum CpuFftBackend {
    RustFft,
}

impl CpuFftBackend {
    pub(crate) fn as_str(self) -> &'static str {
        match self {
            CpuFftBackend::RustFft => "rustfft",
        }
    }
}

pub(crate) fn requested_cpu_fft_backend_from_env() -> Option<String> {
    env::var(CPU_FFT_BACKEND_ENV)
        .ok()
        .map(|value| value.trim().to_string())
        .filter(|value| !value.is_empty())
}

pub(crate) fn resolve_cpu_fft_backend_for_demag(
    demag_enabled: bool,
    requested: Option<&str>,
) -> Result<Option<CpuFftBackend>, RunError> {
    if !demag_enabled {
        return Ok(None);
    }

    let normalized = requested
        .map(str::trim)
        .filter(|value| !value.is_empty())
        .unwrap_or("auto")
        .to_ascii_lowercase();

    match normalized.as_str() {
        "auto" | "rustfft" => Ok(Some(CpuFftBackend::RustFft)),
        other => Err(RunError {
            message: format!(
                "{CPU_FFT_BACKEND_ENV}='{other}' is not available for CPU FDM demag in this build; supported CPU FDM FFT backends: rustfft"
            ),
        }),
    }
}

pub(crate) fn resolve_cpu_fft_backend_name_for_demag(
    demag_enabled: bool,
) -> Result<Option<String>, RunError> {
    let requested = requested_cpu_fft_backend_from_env();
    resolve_cpu_fft_backend_for_demag(demag_enabled, requested.as_deref())
        .map(|backend| backend.map(|backend| backend.as_str().to_string()))
}

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

fn has_slonczewski_stt(plan: &FdmPlanIR) -> bool {
    plan.current_density.is_some()
        && plan.stt_degree.is_some()
        && plan.stt_spin_polarization.is_some()
        && plan.stt_lambda.is_some()
}

fn has_zhang_li_stt(plan: &FdmPlanIR) -> bool {
    plan.current_density.is_some() && plan.stt_degree.is_some() && !has_slonczewski_stt(plan)
}

fn build_zl_stt(plan: &FdmPlanIR) -> Option<ZhangLiSttConfig> {
    if !has_zhang_li_stt(plan) {
        return None;
    }
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
    if !has_slonczewski_stt(plan) {
        return None;
    }
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
    // Use explicit thickness if provided, otherwise fall back to cell_dz (like amumax)
    let thickness = plan.stt_thickness.unwrap_or(cell_dz);
    // Fixed layer position controls current sign: "top" → +1, "bottom" → -1
    let current_sign = match plan.stt_fixed_layer_position.as_deref().unwrap_or("top") {
        "bottom" => -1.0,
        _ => 1.0, // "top" or unset
    };
    Some(SlonczewskiSttConfig {
        current_density_magnitude: j_mag,
        spin_polarization_axis: p_axis,
        lambda: lam,
        epsilon_prime: plan.stt_epsilon_prime.unwrap_or(0.0),
        degree: plan.stt_degree.unwrap_or(1.0),
        thickness,
        current_sign,
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
    resolve_cpu_fft_backend_name_for_demag(plan.enable_demag)?;
    let (problem, state) = build_snapshot_problem_and_state(plan)?;
    snapshot_preview_from_state(
        &problem,
        &state,
        request,
        plan.grid.cells,
        plan.active_mask.as_deref(),
    )
}

pub(crate) fn snapshot_preview_from_state(
    problem: &ExchangeLlgProblem,
    state: &ExchangeLlgState,
    request: &LivePreviewRequest,
    grid: [u32; 3],
    active_mask: Option<&[bool]>,
) -> Result<crate::LivePreviewField, RunError> {
    let mut direct_fields = DirectFieldSnapshotCache::new(problem, state);
    if let Some(values) = select_direct_preview_values(&mut direct_fields, &request.quantity)? {
        return Ok(match values {
            DirectPreviewValues::Vector(values) => {
                build_grid_preview_field(request, &values, grid, active_mask)
            }
            DirectPreviewValues::Scalar(values) => {
                build_grid_scalar_preview_field(request, &values, grid, active_mask)
            }
        });
    }

    let observables = observe_state(problem, state)?;
    Ok(build_grid_preview_field(
        request,
        select_observables(&observables, &request.quantity)?,
        grid,
        active_mask,
    ))
}

pub(crate) fn snapshot_vector_fields(
    plan: &FdmPlanIR,
    quantities: &[&str],
    request: &LivePreviewRequest,
) -> Result<Vec<crate::LivePreviewField>, RunError> {
    resolve_cpu_fft_backend_name_for_demag(plan.enable_demag)?;
    let (problem, state) = build_snapshot_problem_and_state(plan)?;
    snapshot_vector_fields_from_state(
        &problem,
        &state,
        quantities,
        request,
        plan.grid.cells,
        plan.active_mask.as_deref(),
    )
}

pub(crate) fn snapshot_vector_fields_from_state(
    problem: &ExchangeLlgProblem,
    state: &ExchangeLlgState,
    quantities: &[&str],
    request: &LivePreviewRequest,
    grid: [u32; 3],
    active_mask: Option<&[bool]>,
) -> Result<Vec<crate::LivePreviewField>, RunError> {
    let mut direct_fields = DirectFieldSnapshotCache::new(problem, state);
    let mut observables = None;
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
        if let Some(values) = select_direct_preview_values(&mut direct_fields, quantity)? {
            cached.push(match values {
                DirectPreviewValues::Vector(values) => {
                    build_grid_preview_field(&preview_request, &values, grid, active_mask)
                }
                DirectPreviewValues::Scalar(values) => {
                    build_grid_scalar_preview_field(&preview_request, &values, grid, active_mask)
                }
            });
        } else {
            if observables.is_none() {
                observables = Some(observe_state(problem, state)?);
            }
            let values =
                select_observables(observables.as_ref().expect("observables"), quantity)?.to_vec();
            cached.push(build_grid_preview_field(
                &preview_request,
                &values,
                grid,
                active_mask,
            ));
        }
    }

    Ok(cached)
}

fn build_direct_preview_field_if_available(
    problem: &ExchangeLlgProblem,
    state: &ExchangeLlgState,
    request: &LivePreviewRequest,
    grid: [u32; 3],
    active_mask: Option<&[bool]>,
) -> Result<Option<crate::LivePreviewField>, RunError> {
    let mut direct_fields = DirectFieldSnapshotCache::new(problem, state);
    let Some(values) = select_direct_preview_values(&mut direct_fields, &request.quantity)? else {
        return Ok(None);
    };
    Ok(Some(match values {
        DirectPreviewValues::Vector(values) => {
            build_grid_preview_field(request, &values, grid, active_mask)
        }
        DirectPreviewValues::Scalar(values) => {
            build_grid_scalar_preview_field(request, &values, grid, active_mask)
        }
    }))
}

enum DirectPreviewValues {
    Vector(Vec<Vector3>),
    Scalar(Vec<f64>),
}

fn select_direct_preview_values(
    direct_fields: &mut DirectFieldSnapshotCache<'_>,
    quantity: &str,
) -> Result<Option<DirectPreviewValues>, RunError> {
    let quantity = normalized_quantity_name(quantity)?;
    if direct_field_values_available(quantity) {
        return direct_fields
            .select(quantity)
            .map(DirectPreviewValues::Vector)
            .map(Some);
    }
    if direct_scalar_values_available(quantity) {
        return direct_fields
            .select_scalar(quantity)
            .map(DirectPreviewValues::Scalar)
            .map(Some);
    }
    Ok(None)
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
            per_node_field: plan.oersted_field_xyz.clone(),
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
            per_node_field: plan.oersted_field_xyz.clone(),
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
    let fft_backend = resolve_cpu_fft_backend_name_for_demag(plan.enable_demag)?;
    let mut provenance = ExecutionProvenance {
        execution_engine: "cpu_reference".to_string(),
        precision: "double".to_string(),
        demag_operator_kind: if plan.enable_demag {
            Some("tensor_fft_newell".to_string())
        } else {
            None
        },
        fft_backend,
        device_name: None,
        compute_capability: None,
        cuda_driver_version: None,
        cuda_runtime_version: None,
        ..Default::default()
    };
    apply_energy_minimizer_provenance(&mut provenance, plan.relaxation.as_ref());
    let is_direct_minimization = plan.relaxation.as_ref().is_some_and(|control| {
        matches!(
            control.algorithm,
            RelaxationAlgorithmIR::ProjectedGradientBb | RelaxationAlgorithmIR::NonlinearCg
        )
    });
    if is_direct_minimization && problem.soa_fast_path_supported() {
        provenance.energy_minimizer_realization =
            Some(CPU_SOA_DIRECT_MINIMIZER_REALIZATION.to_string());
    }
    let mut artifacts = if let Some(writer) = artifact_writer {
        ArtifactRecorder::streaming(provenance.clone(), writer)
    } else {
        ArtifactRecorder::in_memory(provenance)
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
            None,
            &mut scalar_schedules,
            &mut field_schedules,
            &mut steps,
            &mut artifacts,
        )?;
    }

    // --- Create FFT workspace once for the entire simulation ---
    let mut fft_workspace = problem.create_workspace();
    let mut integrator_bufs = problem.create_integrator_buffers();
    let mut state_soa = if problem.soa_fast_path_supported() {
        Some(state.to_soa())
    } else {
        None
    };
    let mut energy_plateau = RelaxationEnergyPlateauWindow::default();
    let mut last_preview_revision: Option<u64> = None;
    let mut cancelled = false;
    let mut paused = false;
    let mut last_step_report: Option<StepReport> = None;

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
        let needs_initial_live_snapshot = live
            .as_ref()
            .is_some_and(|consumer| consumer.initial_snapshot);
        let mut current_observables = if needs_initial_live_snapshot {
            Some(observe_state(&problem, &state)?)
        } else {
            None
        };
        let mut current_observables_stale = false;
        let mut current_stats = current_observables
            .as_ref()
            .map(|observables| make_step_stats(step_count, state.time_seconds, 0.0, 0, observables))
            .unwrap_or_default();
        while state.time_seconds < until_seconds {
            if step_count == 0
                && live
                    .as_ref()
                    .is_some_and(|consumer| consumer.initial_snapshot)
            {
                if let Some(live) = live.as_mut() {
                    let display_selection = live.display_selection.map(|get| get());
                    let preview_due = display_selection
                        .as_ref()
                        .map(|selection| {
                            display_refresh_due(
                                last_preview_revision,
                                selection,
                                current_stats.step,
                            )
                        })
                        .unwrap_or(false);
                    let preview_targets_global_scalar = display_selection
                        .as_ref()
                        .is_some_and(display_is_global_scalar);
                    let preview_field = if preview_due && !preview_targets_global_scalar {
                        let selection = display_selection.as_ref().expect("checked preview_due");
                        let request = selection.preview_request();
                        if let Some(field) = build_direct_preview_field_if_available(
                            &problem,
                            &state,
                            &request,
                            live.grid,
                            plan.active_mask.as_deref(),
                        )? {
                            Some(field)
                        } else {
                            if current_observables_stale || current_observables.is_none() {
                                current_observables = Some(observe_state(&problem, &state)?);
                                current_observables_stale = false;
                            }
                            let current_observables = current_observables
                                .as_ref()
                                .expect("current observables should be initialized");
                            Some(build_grid_preview_field(
                                &request,
                                select_observables(current_observables, &request.quantity)?,
                                live.grid,
                                plan.active_mask.as_deref(),
                            ))
                        }
                    } else {
                        None
                    };
                    let action = (live.on_step)(StepUpdate {
                        stats: current_stats.clone(),
                        scalar_row_due: preview_due && preview_targets_global_scalar,
                        grid: live.grid,
                        fem_mesh: None,
                        magnetization: Some(flatten_vectors(state.magnetization())),
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
            let wall_start = Instant::now();
            let report = step_reference_fdm_problem(
                &problem,
                &mut state,
                &mut state_soa,
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
            last_step_report = Some(report);
            let latest_stats = StepStats {
                step: step_count,
                time: report.time_seconds,
                dt: report.dt_used,
                e_ex: report.exchange_energy_joules,
                e_demag: report.demag_energy_joules,
                e_ext: report.external_energy_joules,
                e_ani: report.anisotropy_energy_joules,
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
                    Some(&report),
                    &mut scalar_schedules,
                    &mut field_schedules,
                    &mut steps,
                    &mut artifacts,
                )?;
            }

            if let Some(live) = live.as_mut() {
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
                let heavy_payload_due = step_count % heavy_payload_every == 0;
                let mut preview_field = None;
                let direct_preview_satisfied = if preview_due && !preview_targets_global_scalar {
                    let selection = display_selection.as_ref().expect("checked preview_due");
                    let request = selection.preview_request();
                    preview_field = build_direct_preview_field_if_available(
                        &problem,
                        &state,
                        &request,
                        live.grid,
                        plan.active_mask.as_deref(),
                    )?;
                    preview_field.is_some()
                } else {
                    false
                };
                let needs_observables =
                    preview_due && !preview_targets_global_scalar && !direct_preview_satisfied;
                let observables = if needs_observables {
                    let observables = observe_state(&problem, &state)?;
                    current_observables = Some(observables.clone());
                    current_observables_stale = false;
                    Some(observables)
                } else {
                    None
                };
                let magnetization = if heavy_payload_due {
                    Some(flatten_vectors(state.magnetization()))
                } else {
                    None
                };
                if preview_field.is_none() && preview_due && !preview_targets_global_scalar {
                    let selection = display_selection.as_ref().expect("checked preview_due");
                    let request = selection.preview_request();
                    let observables = observables
                        .as_ref()
                        .expect("preview field marked observables as required");
                    preview_field = Some(build_grid_preview_field(
                        &request,
                        select_observables(observables, &request.quantity)?,
                        live.grid,
                        plan.active_mask.as_deref(),
                    ));
                }
                let due_scalar_row = step_count <= 1
                    || step_count % heavy_payload_every == 0
                    || scalar_row_due(&scalar_schedules, state.time_seconds)
                    || (preview_due && preview_targets_global_scalar);
                let mut update_stats = make_step_stats_from_report(
                    step_count,
                    &report,
                    wall_elapsed,
                    state.magnetization(),
                );
                if due_scalar_row || scalar_outputs_request_average_m(&scalar_schedules) {
                    apply_average_m_to_step_stats(&mut update_stats, state.magnetization());
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
                match action {
                    StepAction::Continue => {}
                    StepAction::Stop => {
                        cancelled = true;
                    }
                    StepAction::Pause => {
                        paused = true;
                    }
                }
                if !needs_observables {
                    current_observables_stale = true;
                }
            }

            if cancelled || paused {
                break;
            }

            let energy_plateau_range = energy_plateau.record(latest_stats.e_total);
            let stop_for_relaxation = plan.relaxation.as_ref().is_some_and(|control| {
                step_count >= control.stop.max_steps.unwrap_or(u64::MAX)
                    || relaxation_converged(
                        control,
                        &latest_stats,
                        energy_plateau_range,
                        plan.gyromagnetic_ratio,
                        plan.material.damping,
                        pure_damping_relax,
                    )
            });
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
        last_step_report.as_ref(),
        &field_schedules,
        &mut steps,
        &mut artifacts,
    )?;

    let (field_snapshots, field_snapshot_count, provenance) = artifacts.finish();
    let status = if paused {
        RunStatus::Paused
    } else if cancelled {
        RunStatus::Cancelled
    } else {
        RunStatus::Completed
    };
    let completion = crate::relaxation::infer_stage_completion(
        status,
        plan.relaxation.as_ref(),
        &steps,
        plan.gyromagnetic_ratio,
        plan.material.damping,
        pure_damping_relax,
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

fn step_reference_fdm_problem(
    problem: &ExchangeLlgProblem,
    state: &mut ExchangeLlgState,
    state_soa: &mut Option<ExchangeLlgStateSoA>,
    dt_step: f64,
    fft_workspace: &mut FftWorkspace,
    integrator_bufs: &mut IntegratorBuffers,
) -> Result<StepReport, EngineError> {
    if state_soa.is_none() && problem.soa_fast_path_supported() {
        *state_soa = Some(state.to_soa());
    }

    if let Some(soa) = state_soa.as_mut() {
        let report = problem.step_soa_with_buffers_evaluation(
            soa,
            dt_step,
            fft_workspace,
            integrator_bufs,
            EvaluationRequest::Full,
        )?;
        soa.write_back_to(state);
        Ok(report)
    } else {
        problem.step_with_buffers(state, dt_step, fft_workspace, integrator_bufs)
    }
}

fn record_due_outputs(
    problem: &ExchangeLlgProblem,
    state: &ExchangeLlgState,
    step: u64,
    solver_dt: f64,
    wall_time_ns: u64,
    step_report: Option<&StepReport>,
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
    let has_due_fields = !due_field_names.is_empty();

    if !scalar_due && due_field_names.is_empty() {
        return Ok(());
    }

    if due_field_names
        .iter()
        .all(|name| direct_field_values_available(name))
        && (!scalar_due || step_report.is_some())
    {
        if let Some(report) = step_report.filter(|_| scalar_due) {
            let stats =
                make_step_stats_from_report(step, report, wall_time_ns, state.magnetization());
            artifacts.record_scalar(&stats)?;
            steps.push(stats);
            advance_due_schedules(scalar_schedules, state.time_seconds);
        }

        let mut direct_fields = DirectFieldSnapshotCache::new(problem, state);
        for name in due_field_names {
            artifacts.record_field_snapshot(FieldSnapshot {
                name: name.clone(),
                step,
                time: state.time_seconds,
                solver_dt,
                values: direct_fields.select(&name)?,
            })?;
        }
        if has_due_fields {
            advance_due_schedules(field_schedules, state.time_seconds);
        }
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
                values: select_state_observable_field(&observables, &name, true)?,
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
    final_step_report: Option<&StepReport>,
    field_schedules: &[OutputSchedule],
    steps: &mut Vec<StepStats>,
    artifacts: &mut ArtifactRecorder,
) -> Result<(), RunError> {
    let has_current_scalar = steps
        .last()
        .map(|stats| same_time(stats.time, state.time_seconds))
        .unwrap_or(false);
    let need_scalar = !has_current_scalar
        && (default_scalar_trace
            || steps
                .last()
                .map(|stats| !same_time(stats.time, state.time_seconds))
                .unwrap_or(true));

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

    if !need_scalar
        && missing_field_names
            .iter()
            .all(|name| direct_field_values_available(name))
    {
        let mut direct_fields = DirectFieldSnapshotCache::new(problem, state);
        for name in missing_field_names {
            artifacts.record_field_snapshot(FieldSnapshot {
                name: name.clone(),
                step,
                time: state.time_seconds,
                solver_dt,
                values: direct_fields.select(&name)?,
            })?;
        }
        return Ok(());
    }

    if need_scalar
        && final_step_report
            .is_some_and(|report| same_time(report.time_seconds, state.time_seconds))
        && missing_field_names
            .iter()
            .all(|name| direct_field_values_available(name))
    {
        let report = final_step_report.expect("checked final step report");
        let stats = make_step_stats_from_report(step, report, 0, state.magnetization());
        artifacts.record_scalar(&stats)?;
        steps.push(stats);

        let mut direct_fields = DirectFieldSnapshotCache::new(problem, state);
        for name in missing_field_names {
            artifacts.record_field_snapshot(FieldSnapshot {
                name: name.clone(),
                step,
                time: state.time_seconds,
                solver_dt,
                values: direct_fields.select(&name)?,
            })?;
        }
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
            values: select_state_observable_field(&observables, &name, true)?,
        })?;
    }

    Ok(())
}

pub(crate) fn observe_state(
    problem: &ExchangeLlgProblem,
    state: &ExchangeLlgState,
) -> Result<StateObservables, RunError> {
    #[cfg(test)]
    increment_observe_state_calls();

    let observables = problem.observe(state).map_err(|e| RunError {
        message: format!("Engine observables: {}", e),
    })?;
    let uniform_external = if let Some(field) = problem.terms.external_field {
        state
            .magnetization()
            .iter()
            .enumerate()
            .map(|(index, _)| {
                if problem
                    .active_mask
                    .as_ref()
                    .is_some_and(|mask| !mask[index])
                {
                    [0.0, 0.0, 0.0]
                } else {
                    field
                }
            })
            .collect()
    } else {
        vec![[0.0, 0.0, 0.0]; state.magnetization().len()]
    };
    let oersted_field = problem
        .terms
        .per_node_field
        .clone()
        .unwrap_or_else(|| vec![[0.0, 0.0, 0.0]; state.magnetization().len()]);
    let anisotropy_field = problem.anisotropy_field(state.magnetization());

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
        external_field: uniform_external,
        antenna_field: vec![[0.0, 0.0, 0.0]; state.magnetization().len()],
        effective_field: observables.effective_field,
        anisotropy_field,
        dmi_field: observables.dmi_field,
        magnetoelastic_field: Vec::new(),
        cubic_anisotropy_field: Vec::new(),
        bulk_dmi_field: Vec::new(),
        oersted_field,
        thermal_field: Vec::new(),
        exchange_energy: observables.exchange_energy_joules,
        demag_energy: observables.demag_energy_joules,
        external_energy: observables.external_energy_joules,
        anisotropy_energy: observables.anisotropy_energy_joules,
        dmi_energy: observables.dmi_energy_joules,
        total_energy: observables.total_energy_joules,
        max_dm_dt: observables.max_rhs_amplitude,
        max_h_eff: observables.max_effective_field_amplitude,
        max_h_demag: observables.max_demag_field_amplitude,
        max_torque_Apm: max_torque_apm,
        per_object_scalars: std::collections::HashMap::new(),
    })
}

fn make_step_stats_from_report(
    step: u64,
    report: &StepReport,
    wall_time_ns: u64,
    magnetization: &[Vector3],
) -> StepStats {
    let mut stats = StepStats {
        step,
        time: report.time_seconds,
        dt: report.dt_used,
        e_ex: report.exchange_energy_joules,
        e_demag: report.demag_energy_joules,
        e_ext: report.external_energy_joules,
        e_ani: report.anisotropy_energy_joules,
        e_dmi: report.dmi_energy_joules,
        e_total: report.total_energy_joules,
        max_dm_dt: report.max_rhs_amplitude,
        max_h_eff: report.max_effective_field_amplitude,
        max_h_demag: report.max_demag_field_amplitude,
        max_torque_Apm: report.max_torque_Apm,
        max_torque_T: report.max_torque_Apm * crate::MU0,
        wall_time_ns,
        ..StepStats::default()
    };
    apply_average_m_to_step_stats(&mut stats, magnetization);
    stats.per_object_scalars = single_object_scalars("free", &stats);
    stats
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

fn direct_field_values_available(name: &str) -> bool {
    let (base, component) = match name.split_once('.') {
        Some((base, component)) => (base, Some(component)),
        None => (name, None),
    };
    matches!(
        base,
        "m" | "H_ex" | "H_demag" | "H_ext" | "H_ani" | "H_dmi" | "H_OE" | "H_eff" | "torque"
    ) && component.map_or(true, |component| matches!(component, "x" | "y" | "z"))
}

fn direct_scalar_values_available(name: &str) -> bool {
    matches!(
        name,
        "eden_ex" | "eden_demag" | "eden_ext" | "eden_ani" | "eden_dmi" | "eden_total"
    )
}

struct DirectFieldSnapshotCache<'a> {
    problem: &'a ExchangeLlgProblem,
    state: &'a ExchangeLlgState,
    magnetization: Option<Vec<Vector3>>,
    exchange_field: Option<Vec<Vector3>>,
    demag_field: Option<Vec<Vector3>>,
    external_field: Option<Vec<Vector3>>,
    anisotropy_field: Option<Vec<Vector3>>,
    dmi_field: Option<Vec<Vector3>>,
    oersted_field: Option<Vec<Vector3>>,
    effective_field: Option<Vec<Vector3>>,
    torque_field: Option<Vec<Vector3>>,
}

impl<'a> DirectFieldSnapshotCache<'a> {
    fn new(problem: &'a ExchangeLlgProblem, state: &'a ExchangeLlgState) -> Self {
        Self {
            problem,
            state,
            magnetization: None,
            exchange_field: None,
            demag_field: None,
            external_field: None,
            anisotropy_field: None,
            dmi_field: None,
            oersted_field: None,
            effective_field: None,
            torque_field: None,
        }
    }

    fn select(&mut self, name: &str) -> Result<Vec<Vector3>, RunError> {
        let (base, component) = match name.split_once('.') {
            Some((base, component)) => (base, Some(component)),
            None => (name, None),
        };
        let values = self.base_values(base, name)?;
        project_component(values, component, name)
    }

    fn select_scalar(&mut self, name: &str) -> Result<Vec<f64>, RunError> {
        match name {
            "eden_ex" => {
                let magnetization = self.base_values("m", name)?.to_vec();
                let field = self.base_values("H_ex", name)?.to_vec();
                Ok(self
                    .problem
                    .exchange_energy_density_from_field(&magnetization, &field))
            }
            "eden_demag" => {
                let magnetization = self.base_values("m", name)?.to_vec();
                let field = self.base_values("H_demag", name)?.to_vec();
                Ok(self
                    .problem
                    .demag_energy_density_from_fields(&magnetization, &field))
            }
            "eden_ext" => {
                let magnetization = self.base_values("m", name)?.to_vec();
                let field = self.base_values("H_ext", name)?.to_vec();
                Ok(self
                    .problem
                    .external_energy_density_from_fields(&magnetization, &field))
            }
            "eden_ani" => {
                let magnetization = self.base_values("m", name)?.to_vec();
                let field = self.base_values("H_ani", name)?.to_vec();
                Ok(self
                    .problem
                    .anisotropy_energy_density_from_field(&magnetization, &field))
            }
            "eden_dmi" => self
                .problem
                .dmi_energy_density(self.state)
                .map_err(|error| RunError {
                    message: format!("CPU FDM snapshot '{}': DMI energy density: {}", name, error),
                }),
            "eden_total" => {
                let mut total = vec![0.0; self.state.magnetization().len()];
                for quantity in ["eden_ex", "eden_demag", "eden_ext", "eden_ani", "eden_dmi"] {
                    let values = self.select_scalar(quantity)?;
                    for (accum, value) in total.iter_mut().zip(values) {
                        *accum += value;
                    }
                }
                Ok(total)
            }
            _ => Err(RunError {
                message: format!("snapshot '{}': scalar quantity not available", name),
            }),
        }
    }

    fn base_values(&mut self, base: &str, name: &str) -> Result<&[Vector3], RunError> {
        match base {
            "m" => {
                if self.magnetization.is_none() {
                    self.magnetization = Some(self.state.magnetization().to_vec());
                }
                Ok(self.magnetization.as_deref().expect("cached magnetization"))
            }
            "H_ex" => {
                if self.exchange_field.is_none() {
                    self.exchange_field =
                        Some(self.problem.exchange_field(self.state).map_err(|error| {
                            RunError {
                                message: format!(
                                    "CPU FDM snapshot '{}': exchange field: {}",
                                    name, error
                                ),
                            }
                        })?);
                }
                Ok(self
                    .exchange_field
                    .as_deref()
                    .expect("cached exchange field"))
            }
            "H_demag" => {
                if self.demag_field.is_none() {
                    self.demag_field = Some(self.problem.demag_field(self.state).map_err(
                        |error| RunError {
                            message: format!("CPU FDM snapshot '{}': demag field: {}", name, error),
                        },
                    )?);
                }
                Ok(self.demag_field.as_deref().expect("cached demag field"))
            }
            "H_ext" => {
                if self.external_field.is_none() {
                    self.external_field =
                        Some(self.problem.external_field(self.state).map_err(|error| {
                            RunError {
                                message: format!(
                                    "CPU FDM snapshot '{}': external field: {}",
                                    name, error
                                ),
                            }
                        })?);
                }
                Ok(self
                    .external_field
                    .as_deref()
                    .expect("cached external field"))
            }
            "H_ani" => {
                if self.anisotropy_field.is_none() {
                    self.anisotropy_field =
                        Some(self.problem.anisotropy_field(self.state.magnetization()));
                }
                Ok(self
                    .anisotropy_field
                    .as_deref()
                    .expect("cached anisotropy field"))
            }
            "H_dmi" => {
                if self.dmi_field.is_none() {
                    self.dmi_field =
                        Some(
                            self.problem
                                .dmi_field(self.state)
                                .map_err(|error| RunError {
                                    message: format!(
                                        "CPU FDM snapshot '{}': DMI field: {}",
                                        name, error
                                    ),
                                })?,
                        );
                }
                Ok(self.dmi_field.as_deref().expect("cached DMI field"))
            }
            "H_OE" => {
                if self.oersted_field.is_none() {
                    self.oersted_field = Some(
                        self.problem
                            .terms
                            .per_node_field
                            .clone()
                            .unwrap_or_else(|| {
                                vec![[0.0, 0.0, 0.0]; self.state.magnetization().len()]
                            }),
                    );
                }
                Ok(self.oersted_field.as_deref().expect("cached Oersted field"))
            }
            "H_eff" => self.observable_effective_field(name),
            "torque" => self.torque_field(name),
            _ => Err(RunError {
                message: format!("snapshot '{}': not available directly from state", name),
            }),
        }
    }

    fn observable_effective_field(&mut self, name: &str) -> Result<&[Vector3], RunError> {
        if self.effective_field.is_none() {
            #[cfg(test)]
            increment_direct_h_eff_assembly_calls();
            self.effective_field = Some(
                self.problem
                    .observable_effective_field(self.state)
                    .map_err(|error| RunError {
                        message: format!("CPU FDM snapshot '{}': effective field: {}", name, error),
                    })?,
            );
        }
        Ok(self
            .effective_field
            .as_deref()
            .expect("cached effective field"))
    }

    fn torque_field(&mut self, name: &str) -> Result<&[Vector3], RunError> {
        if self.torque_field.is_none() {
            let torque = {
                let h_eff = self.observable_effective_field(name)?.to_vec();
                compute_torque_field(
                    self.state.magnetization(),
                    &h_eff,
                    self.problem.material.damping,
                    self.problem.dynamics.precession_enabled,
                )
            };
            self.torque_field = Some(torque);
        }
        Ok(self.torque_field.as_deref().expect("cached torque field"))
    }
}

fn project_component(
    values: &[Vector3],
    component: Option<&str>,
    name: &str,
) -> Result<Vec<Vector3>, RunError> {
    let Some(component) = component else {
        return Ok(values.to_vec());
    };
    let idx = match component {
        "x" => 0,
        "y" => 1,
        "z" => 2,
        _ => {
            return Err(RunError {
                message: format!(
                    "snapshot '{}': unsupported component '{}' (use x, y, or z)",
                    name, component
                ),
            });
        }
    };
    Ok(values.iter().map(|value| [value[idx], 0.0, 0.0]).collect())
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
            oersted_field_xyz: None,
            oersted_time_dep_kind: 0,
            oersted_time_dep_freq: 0.0,
            oersted_time_dep_phase: 0.0,
            oersted_time_dep_offset: 0.0,
            oersted_time_dep_t_on: 0.0,
            oersted_time_dep_t_off: 0.0,
            oersted_realization: None,
            temperature: None,
            interfacial_dmi: None,
            bulk_dmi: None,
            ..Default::default()
        }
    }

    fn cpu_fft_env_lock() -> std::sync::MutexGuard<'static, ()> {
        static LOCK: std::sync::OnceLock<std::sync::Mutex<()>> = std::sync::OnceLock::new();
        LOCK.get_or_init(|| std::sync::Mutex::new(()))
            .lock()
            .expect("CPU FFT backend env lock should not be poisoned")
    }

    struct EnvVarGuard {
        key: &'static str,
        previous: Option<String>,
    }

    impl EnvVarGuard {
        fn set(key: &'static str, value: &str) -> Self {
            let previous = std::env::var(key).ok();
            std::env::set_var(key, value);
            Self { key, previous }
        }
    }

    impl Drop for EnvVarGuard {
        fn drop(&mut self) {
            if let Some(previous) = &self.previous {
                std::env::set_var(self.key, previous);
            } else {
                std::env::remove_var(self.key);
            }
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
            field_refresh: None,
            relaxation: Some(RelaxationControlIR {
                algorithm: RelaxationAlgorithmIR::LlgOverdamped,
                stop: fullmag_ir::RelaxStopIR {
                    torque_tolerance_apm: Some(1e-6),
                    energy_tolerance_j: None,
                    max_steps: Some(10),
                    max_pseudotime_s: None,
                    max_physical_time_s: None,
                },
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
            oersted_field_xyz: None,
            oersted_time_dep_kind: 0,
            oersted_time_dep_freq: 0.0,
            oersted_time_dep_phase: 0.0,
            oersted_time_dep_offset: 0.0,
            oersted_time_dep_t_on: 0.0,
            oersted_time_dep_t_off: 0.0,
            oersted_realization: None,
            temperature: None,
            interfacial_dmi: None,
            bulk_dmi: None,
            ..Default::default()
        }
    }

    #[test]
    fn snapshot_preview_m_uses_direct_state_without_reobserving_state() {
        reset_observe_state_calls();

        let plan = FdmPlanIR {
            initial_magnetization: vec![
                [1.0, 0.0, 0.0],
                [0.0, 1.0, 0.0],
                [0.0, 0.0, 1.0],
                [-1.0, 0.0, 0.0],
                [0.0, -1.0, 0.0],
                [0.0, 0.0, -1.0],
                [1.0, 1.0, 0.0],
                [0.0, 1.0, 1.0],
                [1.0, 0.0, 1.0],
                [-1.0, -1.0, 0.0],
                [0.0, -1.0, -1.0],
                [-1.0, 0.0, -1.0],
                [1.0, -1.0, 0.0],
                [0.0, 1.0, -1.0],
                [-1.0, 0.0, 1.0],
                [1.0, 1.0, 1.0],
            ],
            ..make_test_plan()
        };

        let preview = snapshot_preview(
            &plan,
            &LivePreviewRequest {
                quantity: "m".to_string(),
                auto_scale_enabled: false,
                ..Default::default()
            },
        )
        .expect("magnetization preview should build");

        assert_eq!(preview.quantity, "m");
        assert_eq!(preview.vector_field_values.len(), 16 * 3);
        assert_eq!(
            observe_state_call_count(),
            0,
            "magnetization preview should read the state directly"
        );
    }

    #[test]
    fn snapshot_preview_rejects_unimplemented_cpu_fft_backend_for_demag() {
        let _lock = cpu_fft_env_lock();
        let _env = EnvVarGuard::set(CPU_FFT_BACKEND_ENV, "fftw");
        let plan = FdmPlanIR {
            enable_exchange: false,
            enable_demag: true,
            ..make_test_plan()
        };

        let err = match snapshot_preview(
            &plan,
            &LivePreviewRequest {
                quantity: "H_demag".to_string(),
                auto_scale_enabled: false,
                ..Default::default()
            },
        ) {
            Ok(_) => panic!("demag preview should reject unimplemented CPU FFT backend"),
            Err(err) => err,
        };

        assert!(err.message.contains(CPU_FFT_BACKEND_ENV));
        assert!(err.message.contains("fftw"));
        assert!(err
            .message
            .contains("supported CPU FDM FFT backends: rustfft"));
    }

    #[test]
    fn snapshot_vector_fields_share_direct_effective_field_cache_without_reobserving_state() {
        reset_observe_state_calls();
        reset_direct_field_assembly_calls();

        let fields = snapshot_vector_fields(
            &make_test_plan(),
            &["H_eff", "torque"],
            &LivePreviewRequest {
                auto_scale_enabled: false,
                ..Default::default()
            },
        )
        .expect("direct vector previews should build");

        assert_eq!(
            fields
                .iter()
                .map(|field| field.quantity.as_str())
                .collect::<Vec<_>>(),
            vec!["H_eff", "torque"]
        );
        assert_eq!(
            observe_state_call_count(),
            0,
            "direct vector previews should not force a full observables pass"
        );
        assert_eq!(
            direct_h_eff_assembly_call_count(),
            1,
            "H_eff and torque preview should share one direct effective-field assembly"
        );
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
    fn scalar_only_due_outputs_use_step_report_without_reobserving_state() {
        let grid = GridShape::new(1, 1, 1).expect("valid grid");
        let problem = ExchangeLlgProblem::with_terms(
            grid,
            CellSize::new(1.0, 1.0, 1.0).expect("valid cell size"),
            MaterialParameters::new(1.0, 0.5 * crate::MU0, 0.2).expect("valid material"),
            LlgConfig::new(1.0, TimeIntegrator::Heun).expect("valid llg config"),
            EffectiveFieldTerms {
                exchange: false,
                demag: false,
                magnetoelastic: None,
                ..Default::default()
            },
        );
        let state = problem
            .new_state(vec![[1.0, 0.0, 0.0]])
            .expect("state should build");
        let report = StepReport {
            time_seconds: state.time_seconds,
            dt_used: 2e-15,
            step_rejected: false,
            suggested_next_dt: None,
            exchange_energy_joules: 1.0,
            demag_energy_joules: 2.0,
            external_energy_joules: 3.0,
            anisotropy_energy_joules: 7.0,
            dmi_energy_joules: 11.0,
            total_energy_joules: 24.0,
            max_effective_field_amplitude: 11.0,
            max_demag_field_amplitude: 5.0,
            max_rhs_amplitude: 17.0,
            max_torque_Apm: 19.0,
        };
        let mut scalar_schedules = vec![OutputSchedule {
            name: "E_total".to_string(),
            every_seconds: 1.0,
            next_time: 0.0,
            last_sampled_time: None,
        }];
        let mut field_schedules = Vec::new();
        let mut steps = Vec::new();
        let mut artifacts = ArtifactRecorder::in_memory(ExecutionProvenance {
            execution_engine: "cpu_reference".to_string(),
            precision: "double".to_string(),
            ..Default::default()
        });

        record_due_outputs(
            &problem,
            &state,
            4,
            report.dt_used,
            23,
            Some(&report),
            &mut scalar_schedules,
            &mut field_schedules,
            &mut steps,
            &mut artifacts,
        )
        .expect("scalar row should record");

        let stats = steps.first().expect("recorded scalar row");
        assert_eq!(stats.step, 4);
        assert_eq!(stats.dt, report.dt_used);
        assert_eq!(stats.e_ex, report.exchange_energy_joules);
        assert_eq!(stats.e_demag, report.demag_energy_joules);
        assert_eq!(stats.e_ext, report.external_energy_joules);
        assert_eq!(stats.e_ani, report.anisotropy_energy_joules);
        assert_eq!(stats.e_dmi, report.dmi_energy_joules);
        assert_eq!(stats.e_total, report.total_energy_joules);
        assert_eq!(stats.max_dm_dt, report.max_rhs_amplitude);
        assert_eq!(stats.max_torque_Apm, report.max_torque_Apm);
        assert_eq!(stats.mx, 1.0);
        assert_eq!(stats.my, 0.0);
        assert_eq!(stats.mz, 0.0);
    }

    #[test]
    fn live_scalar_updates_use_step_report_without_reobserving_every_step() {
        reset_observe_state_calls();

        let plan = FdmPlanIR {
            initial_magnetization: fullmag_plan::generate_random_unit_vectors(13, 16),
            ..make_test_plan()
        };
        let mut live_updates = 0usize;
        let mut on_step = |update: StepUpdate| -> StepAction {
            live_updates += 1;
            assert!(update.magnetization.is_none());
            assert!(update.preview_field.is_none());
            assert!(update.cached_preview_fields.is_none());
            StepAction::Continue
        };

        let executed = execute_reference_fdm(
            &plan,
            3e-14,
            &[],
            Some(LiveStepConsumer {
                grid: plan.grid.cells,
                field_every_n: u64::MAX,
                initial_snapshot: false,
                display_selection: None,
                interrupt_requested: None,
                on_step: &mut on_step,
            }),
            None,
        )
        .expect("live scalar-only CPU FDM run should succeed");

        assert_eq!(executed.result.status, RunStatus::Completed);
        assert!(live_updates >= 2, "expected per-step live updates");

        let observe_calls = observe_state_call_count();
        assert!(
            observe_calls <= 3,
            "scalar-only live updates should reuse StepReport instead of reobserving every step; observe_state calls: {observe_calls}"
        );
    }

    #[test]
    fn live_direct_preview_uses_state_without_reobserving_every_refresh() {
        reset_observe_state_calls();

        let plan = FdmPlanIR {
            initial_magnetization: fullmag_plan::generate_random_unit_vectors(19, 16),
            ..make_test_plan()
        };
        let display_selection = || {
            let mut state = crate::DisplaySelectionState::default();
            state.selection.quantity = "m".to_string();
            state.selection.every_n = 1;
            state
        };
        let mut preview_updates = 0usize;
        let mut on_step = |update: StepUpdate| -> StepAction {
            if update.preview_field.is_some() {
                preview_updates += 1;
            }
            assert!(update.magnetization.is_none());
            assert!(update.cached_preview_fields.is_none());
            StepAction::Continue
        };

        let executed = execute_reference_fdm(
            &plan,
            3e-14,
            &[],
            Some(LiveStepConsumer {
                grid: plan.grid.cells,
                field_every_n: u64::MAX,
                initial_snapshot: false,
                display_selection: Some(&display_selection),
                interrupt_requested: None,
                on_step: &mut on_step,
            }),
            None,
        )
        .expect("live direct-preview CPU FDM run should succeed");

        assert_eq!(executed.result.status, RunStatus::Completed);
        assert!(preview_updates >= 2, "expected repeated preview updates");
        let observe_calls = observe_state_call_count();
        assert!(
            observe_calls <= 2,
            "direct live previews should not force full observables every refresh; observe_state calls: {observe_calls}"
        );
    }

    #[test]
    fn live_magnetization_payload_reads_state_without_reobserving_every_refresh() {
        reset_observe_state_calls();

        let plan = FdmPlanIR {
            initial_magnetization: fullmag_plan::generate_random_unit_vectors(29, 16),
            ..make_test_plan()
        };
        let mut magnetization_updates = 0usize;
        let mut on_step = |update: StepUpdate| -> StepAction {
            if let Some(values) = update.magnetization.as_ref() {
                magnetization_updates += 1;
                assert_eq!(values.len(), plan.initial_magnetization.len() * 3);
            }
            assert!(update.preview_field.is_none());
            assert!(update.cached_preview_fields.is_none());
            StepAction::Continue
        };

        let executed = execute_reference_fdm(
            &plan,
            3e-14,
            &[],
            Some(LiveStepConsumer {
                grid: plan.grid.cells,
                field_every_n: 1,
                initial_snapshot: false,
                display_selection: None,
                interrupt_requested: None,
                on_step: &mut on_step,
            }),
            None,
        )
        .expect("live magnetization payload CPU FDM run should succeed");

        assert_eq!(executed.result.status, RunStatus::Completed);
        assert!(
            magnetization_updates >= 2,
            "expected repeated live magnetization payloads"
        );
        let observe_calls = observe_state_call_count();
        assert!(
            observe_calls <= 1,
            "live magnetization payload should read state directly instead of full observables per refresh; observe_state calls: {observe_calls}"
        );
    }

    #[test]
    fn live_initial_snapshot_emits_step_zero_magnetization_before_first_step() {
        let plan = FdmPlanIR {
            initial_magnetization: fullmag_plan::generate_random_unit_vectors(19, 16),
            ..make_test_plan()
        };
        let expected_initial: Vec<f64> = plan
            .initial_magnetization
            .iter()
            .flat_map(|value| {
                let norm = (value[0] * value[0] + value[1] * value[1] + value[2] * value[2]).sqrt();
                [value[0] / norm, value[1] / norm, value[2] / norm]
            })
            .collect();
        let display_selection = || {
            let mut state = crate::DisplaySelectionState::default();
            state.selection.quantity = "m".to_string();
            state.selection.every_n = 1;
            state
        };
        let mut first_update: Option<StepUpdate> = None;
        let mut on_step = |update: StepUpdate| -> StepAction {
            if first_update.is_none() {
                first_update = Some(update);
                return StepAction::Stop;
            }
            StepAction::Stop
        };

        let executed = execute_reference_fdm(
            &plan,
            3e-14,
            &[],
            Some(LiveStepConsumer {
                grid: plan.grid.cells,
                field_every_n: u64::MAX,
                initial_snapshot: true,
                display_selection: Some(&display_selection),
                interrupt_requested: None,
                on_step: &mut on_step,
            }),
            None,
        )
        .expect("initial live snapshot CPU FDM run should stop cleanly");

        assert_eq!(executed.result.status, RunStatus::Cancelled);
        let first_update = first_update.expect("expected initial live update");
        assert_eq!(first_update.stats.step, 0);
        assert_eq!(first_update.stats.time, 0.0);
        let actual_initial = first_update
            .magnetization
            .as_deref()
            .expect("initial live snapshot should include magnetization");
        assert_eq!(actual_initial.len(), expected_initial.len());
        for (actual, expected) in actual_initial.iter().zip(expected_initial.iter()) {
            assert!(
                (actual - expected).abs() <= 1e-12,
                "initial magnetization component differs: actual={actual}, expected={expected}"
            );
        }
        assert!(first_update.preview_field.is_some());
        assert!(!first_update.finished);
    }

    #[test]
    fn live_callback_pause_returns_paused_status_and_stops_stepping() {
        let plan = make_test_plan();
        let mut update_steps = Vec::new();
        let mut on_step = |update: StepUpdate| -> StepAction {
            update_steps.push(update.stats.step);
            StepAction::Pause
        };

        let executed = execute_reference_fdm(
            &plan,
            5e-14,
            &[],
            Some(LiveStepConsumer {
                grid: plan.grid.cells,
                field_every_n: 1,
                initial_snapshot: false,
                display_selection: None,
                interrupt_requested: None,
                on_step: &mut on_step,
            }),
            None,
        )
        .expect("pause callback CPU FDM run should pause cleanly");

        assert_eq!(executed.result.status, RunStatus::Paused);
        assert_eq!(
            update_steps,
            vec![1],
            "runner should stop after the first live pause callback instead of continuing"
        );
        assert!(
            executed
                .result
                .steps
                .last()
                .is_some_and(|stats| stats.step <= 1),
            "paused run should not advance to the requested final time"
        );
    }

    #[test]
    fn default_final_scalar_trace_uses_last_step_report_without_reobserving_state() {
        reset_observe_state_calls();

        let plan = FdmPlanIR {
            initial_magnetization: fullmag_plan::generate_random_unit_vectors(17, 16),
            ..make_test_plan()
        };

        let executed = execute_reference_fdm(&plan, 2e-14, &[], None, None)
            .expect("default scalar trace CPU FDM run should succeed");

        assert_eq!(executed.result.status, RunStatus::Completed);
        assert_eq!(
            executed.result.steps.len(),
            2,
            "default scalar trace should keep initial and final scalar rows"
        );
        assert!(
            same_time(
                executed.result.steps.last().expect("final scalar row").time,
                2e-14
            ),
            "final scalar row should remain at the requested final time"
        );

        let observe_calls = observe_state_call_count();
        assert!(
            observe_calls <= 1,
            "default scalar trace should reuse the initial scalar snapshot and last StepReport without extra full observables; observe_state calls: {observe_calls}"
        );
    }

    #[test]
    fn magnetization_only_due_outputs_read_state_without_reobserving_state() {
        reset_observe_state_calls();

        let grid = GridShape::new(1, 1, 2).expect("valid grid");
        let problem = ExchangeLlgProblem::with_terms(
            grid,
            CellSize::new(1.0, 1.0, 1.0).expect("valid cell size"),
            MaterialParameters::new(1.0, 0.5 * crate::MU0, 0.2).expect("valid material"),
            LlgConfig::new(1.0, TimeIntegrator::Heun).expect("valid llg config"),
            EffectiveFieldTerms {
                exchange: false,
                demag: false,
                magnetoelastic: None,
                ..Default::default()
            },
        );
        let mut state = problem
            .new_state(vec![[1.0, 0.0, 0.0], [0.0, 0.0, 1.0]])
            .expect("state should build");
        state.time_seconds = 2e-12;
        let report = StepReport {
            time_seconds: state.time_seconds,
            dt_used: 1e-14,
            step_rejected: false,
            suggested_next_dt: None,
            exchange_energy_joules: 1.0,
            demag_energy_joules: 2.0,
            external_energy_joules: 3.0,
            anisotropy_energy_joules: 4.0,
            dmi_energy_joules: 5.0,
            total_energy_joules: 15.0,
            max_effective_field_amplitude: 6.0,
            max_demag_field_amplitude: 7.0,
            max_rhs_amplitude: 8.0,
            max_torque_Apm: 9.0,
        };
        let mut scalar_schedules = vec![OutputSchedule {
            name: "E_total".to_string(),
            every_seconds: 1e-12,
            next_time: 0.0,
            last_sampled_time: None,
        }];
        let mut field_schedules = vec![
            OutputSchedule {
                name: "m".to_string(),
                every_seconds: 1e-12,
                next_time: 0.0,
                last_sampled_time: None,
            },
            OutputSchedule {
                name: "m.z".to_string(),
                every_seconds: 1e-12,
                next_time: 0.0,
                last_sampled_time: None,
            },
        ];
        let mut steps = Vec::new();
        let mut artifacts = ArtifactRecorder::in_memory(ExecutionProvenance {
            execution_engine: "cpu_reference".to_string(),
            precision: "double".to_string(),
            ..Default::default()
        });

        record_due_outputs(
            &problem,
            &state,
            5,
            report.dt_used,
            37,
            Some(&report),
            &mut scalar_schedules,
            &mut field_schedules,
            &mut steps,
            &mut artifacts,
        )
        .expect("magnetization-only outputs should record");

        let observe_calls = observe_state_call_count();
        assert_eq!(
            observe_calls, 0,
            "magnetization-only field outputs should use state values and StepReport scalars"
        );
        assert_eq!(steps.len(), 1);
        assert_eq!(steps[0].e_total, report.total_energy_joules);
        let (field_snapshots, field_snapshot_count, _) = artifacts.finish();
        assert_eq!(field_snapshot_count, 2);
        let field_names = field_snapshots
            .iter()
            .map(|snapshot| snapshot.name.as_str())
            .collect::<Vec<_>>();
        assert_eq!(field_names, vec!["m", "m.z"]);
        assert_eq!(field_snapshots[0].values, state.magnetization());
        assert_eq!(
            field_snapshots[1].values,
            vec![[0.0, 0.0, 0.0], [1.0, 0.0, 0.0]]
        );
    }

    #[test]
    fn external_field_due_outputs_read_problem_field_without_reobserving_state() {
        reset_observe_state_calls();

        let grid = GridShape::new(1, 1, 2).expect("valid grid");
        let problem = ExchangeLlgProblem::with_terms_and_mask(
            grid,
            CellSize::new(1.0, 1.0, 1.0).expect("valid cell size"),
            MaterialParameters::new(1.0, 0.5 * crate::MU0, 0.2).expect("valid material"),
            LlgConfig::new(1.0, TimeIntegrator::Heun).expect("valid llg config"),
            EffectiveFieldTerms {
                exchange: false,
                demag: false,
                external_field: Some([2.0, 3.0, 4.0]),
                per_node_field: Some(vec![[0.5, 0.25, 0.125], [9.0, 9.0, 9.0]]),
                magnetoelastic: None,
                ..Default::default()
            },
            Some(vec![true, false]),
        )
        .expect("masked problem should build");
        let mut state = problem
            .new_state(vec![[1.0, 0.0, 0.0], [0.0, 0.0, 1.0]])
            .expect("state should build");
        state.time_seconds = 2e-12;
        let mut scalar_schedules = Vec::new();
        let mut field_schedules = vec![
            OutputSchedule {
                name: "H_ext".to_string(),
                every_seconds: 1e-12,
                next_time: 0.0,
                last_sampled_time: None,
            },
            OutputSchedule {
                name: "H_ext.y".to_string(),
                every_seconds: 1e-12,
                next_time: 0.0,
                last_sampled_time: None,
            },
        ];
        let mut steps = Vec::new();
        let mut artifacts = ArtifactRecorder::in_memory(ExecutionProvenance {
            execution_engine: "cpu_reference".to_string(),
            precision: "double".to_string(),
            ..Default::default()
        });

        record_due_outputs(
            &problem,
            &state,
            6,
            1e-14,
            41,
            None,
            &mut scalar_schedules,
            &mut field_schedules,
            &mut steps,
            &mut artifacts,
        )
        .expect("external-field outputs should record");

        let observe_calls = observe_state_call_count();
        assert_eq!(
            observe_calls, 0,
            "H_ext outputs should use the direct external-field accessor instead of full observables"
        );
        let (field_snapshots, field_snapshot_count, _) = artifacts.finish();
        assert_eq!(field_snapshot_count, 2);
        assert_eq!(field_snapshots[0].name, "H_ext");
        assert_eq!(
            field_snapshots[0].values,
            vec![[2.5, 3.25, 4.125], [0.0, 0.0, 0.0]]
        );
        assert_eq!(field_snapshots[1].name, "H_ext.y");
        assert_eq!(
            field_snapshots[1].values,
            vec![[3.25, 0.0, 0.0], [0.0, 0.0, 0.0]]
        );
    }

    #[test]
    fn oersted_field_due_outputs_read_per_node_field_without_reobserving_state() {
        reset_observe_state_calls();

        let grid = GridShape::new(1, 1, 2).expect("valid grid");
        let problem = ExchangeLlgProblem::with_terms(
            grid,
            CellSize::new(1.0, 1.0, 1.0).expect("valid cell size"),
            MaterialParameters::new(1.0, 0.5 * crate::MU0, 0.2).expect("valid material"),
            LlgConfig::new(1.0, TimeIntegrator::Heun).expect("valid llg config"),
            EffectiveFieldTerms {
                exchange: false,
                demag: false,
                per_node_field: Some(vec![[0.0, 0.0, 2.0], [1.0, 0.5, 0.25]]),
                magnetoelastic: None,
                ..Default::default()
            },
        );
        let mut state = problem
            .new_state(vec![[1.0, 0.0, 0.0], [0.0, 0.0, 1.0]])
            .expect("state should build");
        state.time_seconds = 2e-12;
        let mut scalar_schedules = Vec::new();
        let mut field_schedules = vec![
            OutputSchedule {
                name: "H_OE".to_string(),
                every_seconds: 1e-12,
                next_time: 0.0,
                last_sampled_time: None,
            },
            OutputSchedule {
                name: "H_OE.z".to_string(),
                every_seconds: 1e-12,
                next_time: 0.0,
                last_sampled_time: None,
            },
        ];
        let mut steps = Vec::new();
        let mut artifacts = ArtifactRecorder::in_memory(ExecutionProvenance {
            execution_engine: "cpu_reference".to_string(),
            precision: "double".to_string(),
            ..Default::default()
        });

        record_due_outputs(
            &problem,
            &state,
            7,
            1e-14,
            43,
            None,
            &mut scalar_schedules,
            &mut field_schedules,
            &mut steps,
            &mut artifacts,
        )
        .expect("Oersted-field outputs should record");

        let observe_calls = observe_state_call_count();
        assert_eq!(
            observe_calls, 0,
            "H_OE outputs should use the direct per-node field instead of full observables"
        );
        let (field_snapshots, field_snapshot_count, _) = artifacts.finish();
        assert_eq!(field_snapshot_count, 2);
        assert_eq!(field_snapshots[0].name, "H_OE");
        assert_eq!(
            field_snapshots[0].values,
            vec![[0.0, 0.0, 2.0], [1.0, 0.5, 0.25]]
        );
        assert_eq!(field_snapshots[1].name, "H_OE.z");
        assert_eq!(
            field_snapshots[1].values,
            vec![[2.0, 0.0, 0.0], [0.25, 0.0, 0.0]]
        );
    }

    #[test]
    fn exchange_field_due_outputs_read_problem_field_without_reobserving_state() {
        reset_observe_state_calls();

        let grid = GridShape::new(3, 1, 1).expect("valid grid");
        let problem = ExchangeLlgProblem::with_terms(
            grid,
            CellSize::new(1.0, 1.0, 1.0).expect("valid cell size"),
            MaterialParameters::new(1.0, 0.5 * crate::MU0, 0.2).expect("valid material"),
            LlgConfig::new(1.0, TimeIntegrator::Heun).expect("valid llg config"),
            EffectiveFieldTerms {
                exchange: true,
                demag: false,
                magnetoelastic: None,
                ..Default::default()
            },
        );
        let mut state = problem
            .new_state(vec![[1.0, 0.0, 0.0], [0.0, 1.0, 0.0], [0.0, 0.0, 1.0]])
            .expect("state should build");
        state.time_seconds = 2e-12;
        let expected_exchange = problem
            .exchange_field(&state)
            .expect("exchange field should assemble");
        let mut scalar_schedules = Vec::new();
        let mut field_schedules = vec![
            OutputSchedule {
                name: "H_ex".to_string(),
                every_seconds: 1e-12,
                next_time: 0.0,
                last_sampled_time: None,
            },
            OutputSchedule {
                name: "H_ex.y".to_string(),
                every_seconds: 1e-12,
                next_time: 0.0,
                last_sampled_time: None,
            },
        ];
        let mut steps = Vec::new();
        let mut artifacts = ArtifactRecorder::in_memory(ExecutionProvenance {
            execution_engine: "cpu_reference".to_string(),
            precision: "double".to_string(),
            ..Default::default()
        });

        record_due_outputs(
            &problem,
            &state,
            8,
            1e-14,
            47,
            None,
            &mut scalar_schedules,
            &mut field_schedules,
            &mut steps,
            &mut artifacts,
        )
        .expect("exchange-field outputs should record");

        let observe_calls = observe_state_call_count();
        assert_eq!(
            observe_calls, 0,
            "H_ex outputs should use the direct exchange-field accessor instead of full observables"
        );
        let (field_snapshots, field_snapshot_count, _) = artifacts.finish();
        assert_eq!(field_snapshot_count, 2);
        assert_eq!(field_snapshots[0].name, "H_ex");
        assert_eq!(field_snapshots[0].values, expected_exchange);
        assert_eq!(field_snapshots[1].name, "H_ex.y");
        assert_eq!(
            field_snapshots[1].values,
            expected_exchange
                .iter()
                .map(|value| [value[1], 0.0, 0.0])
                .collect::<Vec<_>>()
        );
    }

    #[test]
    fn demag_field_due_outputs_read_problem_field_without_reobserving_state() {
        reset_observe_state_calls();

        let grid = GridShape::new(2, 1, 1).expect("valid grid");
        let problem = ExchangeLlgProblem::with_terms(
            grid,
            CellSize::new(1.0, 1.0, 1.0).expect("valid cell size"),
            MaterialParameters::new(1.0, 0.5 * crate::MU0, 0.2).expect("valid material"),
            LlgConfig::new(1.0, TimeIntegrator::Heun).expect("valid llg config"),
            EffectiveFieldTerms {
                exchange: false,
                demag: true,
                magnetoelastic: None,
                ..Default::default()
            },
        );
        let mut state = problem
            .new_state(vec![[1.0, 0.0, 0.0], [0.0, 1.0, 0.0]])
            .expect("state should build");
        state.time_seconds = 2e-12;
        let expected_demag = problem
            .demag_field(&state)
            .expect("demag field should assemble");
        let mut scalar_schedules = Vec::new();
        let mut field_schedules = vec![
            OutputSchedule {
                name: "H_demag".to_string(),
                every_seconds: 1e-12,
                next_time: 0.0,
                last_sampled_time: None,
            },
            OutputSchedule {
                name: "H_demag.x".to_string(),
                every_seconds: 1e-12,
                next_time: 0.0,
                last_sampled_time: None,
            },
        ];
        let mut steps = Vec::new();
        let mut artifacts = ArtifactRecorder::in_memory(ExecutionProvenance {
            execution_engine: "cpu_reference".to_string(),
            precision: "double".to_string(),
            ..Default::default()
        });

        record_due_outputs(
            &problem,
            &state,
            9,
            1e-14,
            53,
            None,
            &mut scalar_schedules,
            &mut field_schedules,
            &mut steps,
            &mut artifacts,
        )
        .expect("demag-field outputs should record");

        let observe_calls = observe_state_call_count();
        assert_eq!(
            observe_calls, 0,
            "H_demag outputs should use the direct demag-field accessor instead of full observables"
        );
        let (field_snapshots, field_snapshot_count, _) = artifacts.finish();
        assert_eq!(field_snapshot_count, 2);
        assert_eq!(field_snapshots[0].name, "H_demag");
        assert_eq!(field_snapshots[0].values, expected_demag);
        assert_eq!(field_snapshots[1].name, "H_demag.x");
        assert_eq!(
            field_snapshots[1].values,
            expected_demag
                .iter()
                .map(|value| [value[0], 0.0, 0.0])
                .collect::<Vec<_>>()
        );
    }

    #[test]
    fn dmi_field_due_outputs_read_problem_field_without_reobserving_state() {
        let grid = GridShape::new(3, 3, 3).expect("valid grid");
        let problem = ExchangeLlgProblem::with_terms(
            grid,
            CellSize::new(1.0, 1.5, 2.0).expect("valid cell size"),
            MaterialParameters::new(1.0, 0.5 * crate::MU0, 0.2).expect("valid material"),
            LlgConfig::new(1.0, TimeIntegrator::Heun).expect("valid llg config"),
            EffectiveFieldTerms {
                exchange: false,
                demag: false,
                interfacial_dmi: Some(0.04 * crate::MU0),
                bulk_dmi: Some(-0.02 * crate::MU0),
                magnetoelastic: None,
                ..Default::default()
            },
        );
        let mut state = problem
            .new_state(
                (0..grid.cell_count())
                    .map(|i| {
                        let x = i % grid.nx;
                        let y = (i / grid.nx) % grid.ny;
                        let z = i / (grid.nx * grid.ny);
                        [
                            1.0 + 0.11 * x as f64 - 0.03 * z as f64,
                            0.2 + 0.07 * y as f64 + 0.02 * z as f64,
                            0.4 - 0.05 * x as f64 + 0.09 * z as f64,
                        ]
                    })
                    .collect(),
            )
            .expect("state should build");
        state.time_seconds = 2e-12;
        let expected_dmi = problem
            .observe(&state)
            .expect("observables should assemble")
            .effective_field;
        reset_observe_state_calls();

        let mut scalar_schedules = Vec::new();
        let mut field_schedules = vec![
            OutputSchedule {
                name: "H_dmi".to_string(),
                every_seconds: 1e-12,
                next_time: 0.0,
                last_sampled_time: None,
            },
            OutputSchedule {
                name: "H_dmi.x".to_string(),
                every_seconds: 1e-12,
                next_time: 0.0,
                last_sampled_time: None,
            },
        ];
        let mut steps = Vec::new();
        let mut artifacts = ArtifactRecorder::in_memory(ExecutionProvenance {
            execution_engine: "cpu_reference".to_string(),
            precision: "double".to_string(),
            ..Default::default()
        });

        record_due_outputs(
            &problem,
            &state,
            10,
            1e-14,
            59,
            None,
            &mut scalar_schedules,
            &mut field_schedules,
            &mut steps,
            &mut artifacts,
        )
        .expect("DMI-field outputs should record");

        let observe_calls = observe_state_call_count();
        assert_eq!(
            observe_calls, 0,
            "H_dmi outputs should use the direct DMI-field accessor instead of full observables"
        );
        let (field_snapshots, field_snapshot_count, _) = artifacts.finish();
        assert_eq!(field_snapshot_count, 2);
        assert_eq!(field_snapshots[0].name, "H_dmi");
        assert_eq!(field_snapshots[0].values, expected_dmi);
        assert_eq!(field_snapshots[1].name, "H_dmi.x");
        assert_eq!(
            field_snapshots[1].values,
            expected_dmi
                .iter()
                .map(|value| [value[0], 0.0, 0.0])
                .collect::<Vec<_>>()
        );
    }

    #[test]
    fn anisotropy_field_due_outputs_read_problem_field_without_reobserving_state() {
        let grid = GridShape::new(2, 1, 1).expect("valid grid");
        let problem = ExchangeLlgProblem::with_terms(
            grid,
            CellSize::new(1.0, 1.0, 1.0).expect("valid cell size"),
            MaterialParameters::new(1.0, 1.0, 0.2).expect("valid material"),
            LlgConfig::new(1.0, TimeIntegrator::Heun).expect("valid llg config"),
            EffectiveFieldTerms {
                exchange: false,
                demag: false,
                uniaxial_anisotropy: Some(UniaxialAnisotropyConfig {
                    ku1: 0.5 * crate::MU0,
                    ku2: 0.25 * crate::MU0,
                    axis: [0.0, 0.0, 1.0],
                }),
                ..Default::default()
            },
        );
        let mut state = problem
            .new_state(vec![[0.6, 0.0, 0.8], [0.8, 0.0, 0.6]])
            .expect("state should build");
        state.time_seconds = 2e-12;
        let expected_anisotropy = problem
            .observe(&state)
            .expect("observables should assemble")
            .effective_field;
        reset_observe_state_calls();

        let mut scalar_schedules = Vec::new();
        let mut field_schedules = vec![
            OutputSchedule {
                name: "H_ani".to_string(),
                every_seconds: 1e-12,
                next_time: 0.0,
                last_sampled_time: None,
            },
            OutputSchedule {
                name: "H_ani.z".to_string(),
                every_seconds: 1e-12,
                next_time: 0.0,
                last_sampled_time: None,
            },
        ];
        let mut steps = Vec::new();
        let mut artifacts = ArtifactRecorder::in_memory(ExecutionProvenance {
            execution_engine: "cpu_reference".to_string(),
            precision: "double".to_string(),
            ..Default::default()
        });

        record_due_outputs(
            &problem,
            &state,
            11,
            1e-14,
            61,
            None,
            &mut scalar_schedules,
            &mut field_schedules,
            &mut steps,
            &mut artifacts,
        )
        .expect("anisotropy-field outputs should record");

        let observe_calls = observe_state_call_count();
        assert_eq!(
            observe_calls, 0,
            "H_ani outputs should use the direct anisotropy-field accessor instead of full observables"
        );
        let (field_snapshots, field_snapshot_count, _) = artifacts.finish();
        assert_eq!(field_snapshot_count, 2);
        assert_eq!(field_snapshots[0].name, "H_ani");
        assert_eq!(field_snapshots[0].values, expected_anisotropy);
        assert_eq!(field_snapshots[1].name, "H_ani.z");
        assert_eq!(
            field_snapshots[1].values,
            expected_anisotropy
                .iter()
                .map(|value| [value[2], 0.0, 0.0])
                .collect::<Vec<_>>()
        );
    }

    #[test]
    fn effective_field_due_outputs_read_observable_field_without_reobserving_state() {
        let grid = GridShape::new(2, 1, 1).expect("valid grid");
        let problem = ExchangeLlgProblem::with_terms(
            grid,
            CellSize::new(1.0, 1.0, 1.0).expect("valid cell size"),
            MaterialParameters::new(1.0, 0.5 * crate::MU0, 0.2).expect("valid material"),
            LlgConfig::new(1.0, TimeIntegrator::Heun).expect("valid llg config"),
            EffectiveFieldTerms {
                exchange: false,
                demag: false,
                external_field: Some([1.0, 2.0, 3.0]),
                oersted_cylinder: Some(OerstedCylinderConfig {
                    current: 1.0,
                    radius: 1.0,
                    center: [0.0, 0.0, 0.0],
                    axis: [0.0, 0.0, 1.0],
                    time_dep_kind: 0,
                    time_dep_freq: 0.0,
                    time_dep_phase: 0.0,
                    time_dep_offset: 0.0,
                    time_dep_t_on: 0.0,
                    time_dep_t_off: 0.0,
                }),
                magnetoelastic: None,
                ..Default::default()
            },
        );
        let mut state = problem
            .new_state(vec![[1.0, 0.0, 0.0], [0.0, 1.0, 0.0]])
            .expect("state should build");
        state.time_seconds = 2e-12;
        let expected_effective = problem
            .observe(&state)
            .expect("observables should assemble")
            .effective_field;
        assert_ne!(
            expected_effective,
            problem
                .effective_field(&state)
                .expect("public effective field should assemble"),
            "this regression preserves the current H_eff artifact contract, not the broader stepping helper"
        );
        reset_observe_state_calls();

        let mut scalar_schedules = Vec::new();
        let mut field_schedules = vec![
            OutputSchedule {
                name: "H_eff".to_string(),
                every_seconds: 1e-12,
                next_time: 0.0,
                last_sampled_time: None,
            },
            OutputSchedule {
                name: "H_eff.y".to_string(),
                every_seconds: 1e-12,
                next_time: 0.0,
                last_sampled_time: None,
            },
        ];
        let mut steps = Vec::new();
        let mut artifacts = ArtifactRecorder::in_memory(ExecutionProvenance {
            execution_engine: "cpu_reference".to_string(),
            precision: "double".to_string(),
            ..Default::default()
        });

        record_due_outputs(
            &problem,
            &state,
            10,
            1e-14,
            59,
            None,
            &mut scalar_schedules,
            &mut field_schedules,
            &mut steps,
            &mut artifacts,
        )
        .expect("effective-field outputs should record");

        let observe_calls = observe_state_call_count();
        assert_eq!(
            observe_calls, 0,
            "H_eff outputs should use the observable effective-field accessor instead of full observables"
        );
        let (field_snapshots, field_snapshot_count, _) = artifacts.finish();
        assert_eq!(field_snapshot_count, 2);
        assert_eq!(field_snapshots[0].name, "H_eff");
        assert_eq!(field_snapshots[0].values, expected_effective);
        assert_eq!(field_snapshots[1].name, "H_eff.y");
        assert_eq!(
            field_snapshots[1].values,
            expected_effective
                .iter()
                .map(|value| [value[1], 0.0, 0.0])
                .collect::<Vec<_>>()
        );
    }

    #[test]
    fn torque_due_outputs_read_observable_effective_field_without_reobserving_state() {
        let grid = GridShape::new(2, 1, 1).expect("valid grid");
        let problem = ExchangeLlgProblem::with_terms(
            grid,
            CellSize::new(1.0, 1.0, 1.0).expect("valid cell size"),
            MaterialParameters::new(1.0, 0.5 * crate::MU0, 0.2).expect("valid material"),
            LlgConfig::new(1.0, TimeIntegrator::Heun).expect("valid llg config"),
            EffectiveFieldTerms {
                exchange: false,
                demag: false,
                external_field: Some([1.0, 2.0, 3.0]),
                oersted_cylinder: Some(OerstedCylinderConfig {
                    current: 1.0,
                    radius: 1.0,
                    center: [0.0, 0.0, 0.0],
                    axis: [0.0, 0.0, 1.0],
                    time_dep_kind: 0,
                    time_dep_freq: 0.0,
                    time_dep_phase: 0.0,
                    time_dep_offset: 0.0,
                    time_dep_t_on: 0.0,
                    time_dep_t_off: 0.0,
                }),
                magnetoelastic: None,
                ..Default::default()
            },
        );
        let mut state = problem
            .new_state(vec![[1.0, 0.0, 0.0], [0.0, 1.0, 0.0]])
            .expect("state should build");
        state.time_seconds = 2e-12;
        let observables = problem
            .observe(&state)
            .expect("observables should assemble");
        let expected_torque = compute_torque_field(
            &observables.magnetization,
            &observables.effective_field,
            problem.material.damping,
            problem.dynamics.precession_enabled,
        );
        reset_observe_state_calls();

        let mut scalar_schedules = Vec::new();
        let mut field_schedules = vec![
            OutputSchedule {
                name: "torque".to_string(),
                every_seconds: 1e-12,
                next_time: 0.0,
                last_sampled_time: None,
            },
            OutputSchedule {
                name: "torque.z".to_string(),
                every_seconds: 1e-12,
                next_time: 0.0,
                last_sampled_time: None,
            },
        ];
        let mut steps = Vec::new();
        let mut artifacts = ArtifactRecorder::in_memory(ExecutionProvenance {
            execution_engine: "cpu_reference".to_string(),
            precision: "double".to_string(),
            ..Default::default()
        });

        record_due_outputs(
            &problem,
            &state,
            11,
            1e-14,
            61,
            None,
            &mut scalar_schedules,
            &mut field_schedules,
            &mut steps,
            &mut artifacts,
        )
        .expect("torque outputs should record");

        let observe_calls = observe_state_call_count();
        assert_eq!(
            observe_calls, 0,
            "torque outputs should derive from observable effective field instead of full observables"
        );
        let (field_snapshots, field_snapshot_count, _) = artifacts.finish();
        assert_eq!(field_snapshot_count, 2);
        assert_eq!(field_snapshots[0].name, "torque");
        assert_eq!(field_snapshots[0].values, expected_torque);
        assert_eq!(field_snapshots[1].name, "torque.z");
        assert_eq!(
            field_snapshots[1].values,
            expected_torque
                .iter()
                .map(|value| [value[2], 0.0, 0.0])
                .collect::<Vec<_>>()
        );
    }

    #[test]
    fn effective_field_and_torque_due_outputs_share_direct_effective_field_cache() {
        let grid = GridShape::new(2, 1, 1).expect("valid grid");
        let problem = ExchangeLlgProblem::with_terms(
            grid,
            CellSize::new(1.0, 1.0, 1.0).expect("valid cell size"),
            MaterialParameters::new(1.0, 0.5 * crate::MU0, 0.2).expect("valid material"),
            LlgConfig::new(1.0, TimeIntegrator::Heun).expect("valid llg config"),
            EffectiveFieldTerms {
                exchange: false,
                demag: false,
                external_field: Some([1.0, 2.0, 3.0]),
                oersted_cylinder: Some(OerstedCylinderConfig {
                    current: 1.0,
                    radius: 1.0,
                    center: [0.0, 0.0, 0.0],
                    axis: [0.0, 0.0, 1.0],
                    time_dep_kind: 0,
                    time_dep_freq: 0.0,
                    time_dep_phase: 0.0,
                    time_dep_offset: 0.0,
                    time_dep_t_on: 0.0,
                    time_dep_t_off: 0.0,
                }),
                magnetoelastic: None,
                ..Default::default()
            },
        );
        let mut state = problem
            .new_state(vec![[1.0, 0.0, 0.0], [0.0, 1.0, 0.0]])
            .expect("state should build");
        state.time_seconds = 2e-12;
        let observables = problem
            .observe(&state)
            .expect("observables should assemble");
        let expected_torque = compute_torque_field(
            &observables.magnetization,
            &observables.effective_field,
            problem.material.damping,
            problem.dynamics.precession_enabled,
        );
        reset_observe_state_calls();
        reset_direct_field_assembly_calls();

        let mut scalar_schedules = Vec::new();
        let mut field_schedules = vec![
            OutputSchedule {
                name: "H_eff".to_string(),
                every_seconds: 1e-12,
                next_time: 0.0,
                last_sampled_time: None,
            },
            OutputSchedule {
                name: "H_eff.y".to_string(),
                every_seconds: 1e-12,
                next_time: 0.0,
                last_sampled_time: None,
            },
            OutputSchedule {
                name: "torque".to_string(),
                every_seconds: 1e-12,
                next_time: 0.0,
                last_sampled_time: None,
            },
            OutputSchedule {
                name: "torque.z".to_string(),
                every_seconds: 1e-12,
                next_time: 0.0,
                last_sampled_time: None,
            },
        ];
        let mut steps = Vec::new();
        let mut artifacts = ArtifactRecorder::in_memory(ExecutionProvenance {
            execution_engine: "cpu_reference".to_string(),
            precision: "double".to_string(),
            ..Default::default()
        });

        record_due_outputs(
            &problem,
            &state,
            12,
            1e-14,
            67,
            None,
            &mut scalar_schedules,
            &mut field_schedules,
            &mut steps,
            &mut artifacts,
        )
        .expect("direct outputs should record");

        assert_eq!(
            observe_state_call_count(),
            0,
            "direct H_eff/torque outputs should not assemble full observables"
        );
        assert_eq!(
            direct_h_eff_assembly_call_count(),
            1,
            "one output pass should assemble observable H_eff once and reuse it for H_eff siblings and torque"
        );
        let (field_snapshots, field_snapshot_count, _) = artifacts.finish();
        assert_eq!(field_snapshot_count, 4);
        assert_eq!(field_snapshots[0].name, "H_eff");
        assert_eq!(field_snapshots[0].values, observables.effective_field);
        assert_eq!(field_snapshots[1].name, "H_eff.y");
        assert_eq!(
            field_snapshots[1].values,
            observables
                .effective_field
                .iter()
                .map(|value| [value[1], 0.0, 0.0])
                .collect::<Vec<_>>()
        );
        assert_eq!(field_snapshots[2].name, "torque");
        assert_eq!(field_snapshots[2].values, expected_torque);
        assert_eq!(field_snapshots[3].name, "torque.z");
        assert_eq!(
            field_snapshots[3].values,
            expected_torque
                .iter()
                .map(|value| [value[2], 0.0, 0.0])
                .collect::<Vec<_>>()
        );
    }

    #[test]
    fn final_magnetization_only_outputs_read_state_without_reobserving_state() {
        reset_observe_state_calls();

        let grid = GridShape::new(1, 1, 2).expect("valid grid");
        let problem = ExchangeLlgProblem::with_terms(
            grid,
            CellSize::new(1.0, 1.0, 1.0).expect("valid cell size"),
            MaterialParameters::new(1.0, 0.5 * crate::MU0, 0.2).expect("valid material"),
            LlgConfig::new(1.0, TimeIntegrator::Heun).expect("valid llg config"),
            EffectiveFieldTerms {
                exchange: false,
                demag: false,
                magnetoelastic: None,
                ..Default::default()
            },
        );
        let mut state = problem
            .new_state(vec![[0.0, 1.0, 0.0], [0.0, 0.0, 1.0]])
            .expect("state should build");
        state.time_seconds = 4e-12;
        let mut steps = vec![StepStats {
            step: 7,
            time: state.time_seconds,
            dt: 1e-14,
            ..StepStats::default()
        }];
        let field_schedules = vec![OutputSchedule {
            name: "m.y".to_string(),
            every_seconds: 1e-12,
            next_time: 5e-12,
            last_sampled_time: None,
        }];
        let mut artifacts = ArtifactRecorder::in_memory(ExecutionProvenance {
            execution_engine: "cpu_reference".to_string(),
            precision: "double".to_string(),
            ..Default::default()
        });

        record_final_outputs(
            &problem,
            &state,
            7,
            1e-14,
            false,
            None,
            &field_schedules,
            &mut steps,
            &mut artifacts,
        )
        .expect("final magnetization-only output should record");

        let observe_calls = observe_state_call_count();
        assert_eq!(
            observe_calls, 0,
            "final magnetization-only snapshots should use state values when no scalar row is due"
        );
        let (field_snapshots, field_snapshot_count, _) = artifacts.finish();
        assert_eq!(field_snapshot_count, 1);
        assert_eq!(field_snapshots[0].name, "m.y");
        assert_eq!(
            field_snapshots[0].values,
            vec![[1.0, 0.0, 0.0], [0.0, 0.0, 0.0]]
        );
    }

    #[test]
    fn final_outputs_do_not_duplicate_current_time_scalar_row_or_reobserve_state() {
        reset_observe_state_calls();

        let grid = GridShape::new(1, 1, 1).expect("valid grid");
        let problem = ExchangeLlgProblem::with_terms(
            grid,
            CellSize::new(1.0, 1.0, 1.0).expect("valid cell size"),
            MaterialParameters::new(1.0, 0.5 * crate::MU0, 0.2).expect("valid material"),
            LlgConfig::new(1.0, TimeIntegrator::Heun).expect("valid llg config"),
            EffectiveFieldTerms {
                exchange: false,
                demag: false,
                magnetoelastic: None,
                ..Default::default()
            },
        );
        let mut state = problem
            .new_state(vec![[1.0, 0.0, 0.0]])
            .expect("state should build");
        state.time_seconds = 5e-12;
        let mut steps = vec![StepStats {
            step: 9,
            time: state.time_seconds,
            dt: 1e-14,
            e_total: 42.0,
            ..StepStats::default()
        }];
        let field_schedules = Vec::new();
        let mut artifacts = ArtifactRecorder::in_memory(ExecutionProvenance {
            execution_engine: "cpu_reference".to_string(),
            precision: "double".to_string(),
            ..Default::default()
        });

        record_final_outputs(
            &problem,
            &state,
            9,
            1e-14,
            true,
            None,
            &field_schedules,
            &mut steps,
            &mut artifacts,
        )
        .expect("final output pass should not duplicate an existing final scalar row");

        assert_eq!(
            observe_state_call_count(),
            0,
            "final outputs should not reobserve when a scalar row already exists at the current time"
        );
        assert_eq!(steps.len(), 1);
        assert_eq!(steps[0].e_total, 42.0);
    }

    #[test]
    fn standalone_cpu_reference_step_keeps_supported_segment_on_persistent_soa_state() {
        let plan = FdmPlanIR {
            initial_magnetization: fullmag_plan::generate_random_unit_vectors(11, 16),
            enable_demag: true,
            ..make_test_plan()
        };
        let (problem, mut state) = build_snapshot_problem_and_state(&plan).expect("problem");
        let mut state_soa = if problem.soa_fast_path_supported() {
            Some(state.to_soa())
        } else {
            None
        };
        assert!(state_soa.is_some());

        let mut fft_workspace = problem.create_workspace();
        let mut integrator_bufs = problem.create_integrator_buffers();
        let report = step_reference_fdm_problem(
            &problem,
            &mut state,
            &mut state_soa,
            1e-14,
            &mut fft_workspace,
            &mut integrator_bufs,
        )
        .expect("step should execute");

        assert!(state_soa.is_some());
        assert!(report.total_energy_joules.is_finite());
        assert_eq!(state.time_seconds, report.time_seconds);
    }

    #[test]
    fn cpu_fft_backend_selection_defaults_and_auto_resolve_to_rustfft_for_demag() {
        let default_backend =
            resolve_cpu_fft_backend_for_demag(true, None).expect("default backend should resolve");
        let auto_backend = resolve_cpu_fft_backend_for_demag(true, Some(" auto "))
            .expect("auto backend should resolve");
        let rustfft_backend = resolve_cpu_fft_backend_for_demag(true, Some("RustFFT"))
            .expect("rustfft backend should resolve");

        assert_eq!(
            default_backend.map(|backend| backend.as_str()),
            Some("rustfft")
        );
        assert_eq!(
            auto_backend.map(|backend| backend.as_str()),
            Some("rustfft")
        );
        assert_eq!(
            rustfft_backend.map(|backend| backend.as_str()),
            Some("rustfft")
        );
    }

    #[test]
    fn cpu_fft_backend_selection_rejects_unimplemented_backend_for_demag() {
        let err = resolve_cpu_fft_backend_for_demag(true, Some("fftw"))
            .expect_err("fftw is not implemented in this build");

        assert!(err.message.contains("FULLMAG_CPU_FFT_BACKEND"));
        assert!(err.message.contains("fftw"));
        assert!(err
            .message
            .contains("supported CPU FDM FFT backends: rustfft"));
    }

    #[test]
    fn cpu_fft_backend_selection_is_none_when_demag_is_disabled() {
        let backend = resolve_cpu_fft_backend_for_demag(false, Some("fftw"))
            .expect("demag-disabled plans should not resolve an FFT backend");

        assert!(backend.is_none());
    }

    #[test]
    fn generalized_oersted_field_reaches_cpu_reference_observables() {
        let plan = FdmPlanIR {
            enable_exchange: false,
            external_field: Some([2.0, -1.0, 0.5]),
            oersted_field_xyz: Some(vec![
                [0.0, 0.0, 1.0],
                [0.0, 1.0, 0.0],
                [1.0, 0.0, 0.0],
                [0.5, 0.5, 0.5],
                [0.0, 0.0, 0.0],
                [0.0, -1.0, 0.0],
                [-1.0, 0.0, 0.0],
                [-0.5, -0.5, -0.5],
                [0.25, 0.0, 0.0],
                [0.0, 0.25, 0.0],
                [0.0, 0.0, 0.25],
                [0.25, 0.25, 0.0],
                [0.0, 0.25, 0.25],
                [0.25, 0.0, 0.25],
                [0.1, 0.2, 0.3],
                [0.0, 0.0, 0.0],
            ]),
            oersted_realization: Some(fullmag_ir::OerstedRealization::BiotSavartMidpoint),
            ..make_test_plan()
        };

        let (problem, state) = build_snapshot_problem_and_state(&plan).expect("snapshot problem");
        let observables = observe_state(&problem, &state).expect("observables");

        assert_eq!(observables.external_field[0], [2.0, -1.0, 0.5]);
        assert_eq!(observables.oersted_field[0], [0.0, 0.0, 1.0]);
        assert_eq!(observables.oersted_field[1], [0.0, 1.0, 0.0]);
        assert_eq!(
            select_state_observable_field(&observables, "H_OE", true).unwrap(),
            observables.oersted_field
        );
        for component in 0..3 {
            assert!(
                (observables.effective_field[0][component]
                    - (observables.exchange_field[0][component]
                        + observables.demag_field[0][component]
                        + observables.external_field[0][component]
                        + observables.oersted_field[0][component]))
                    .abs()
                    < 1e-12
            );
        }
    }

    #[test]
    fn slonczewski_does_not_enable_zhang_li_builder() {
        let mut plan = make_test_plan();
        plan.current_density = Some([5.0e10, 0.0, 0.0]);
        plan.stt_degree = Some(0.6);
        plan.stt_spin_polarization = Some([0.0, 0.0, 1.0]);
        plan.stt_lambda = Some(1.5);
        plan.stt_epsilon_prime = Some(0.0);

        assert!(build_zl_stt(&plan).is_none());
        assert!(build_slon_stt(&plan, plan.cell_size[2]).is_some());
    }

    #[test]
    fn slonczewski_bottom_flips_torque_direction() {
        let mut plan_top = make_test_plan();
        plan_top.current_density = Some([0.0, 0.0, 8.0e10]);
        plan_top.stt_degree = Some(0.55);
        plan_top.stt_spin_polarization = Some([0.0, 0.0, 1.0]);
        plan_top.stt_lambda = Some(1.4);
        plan_top.stt_epsilon_prime = Some(0.0);
        plan_top.stt_fixed_layer_position = Some("top".to_string());

        let mut plan_bottom = plan_top.clone();
        plan_bottom.stt_fixed_layer_position = Some("bottom".to_string());

        let top = build_slon_stt(&plan_top, plan_top.cell_size[2])
            .expect("top Slonczewski config should build");
        let bottom = build_slon_stt(&plan_bottom, plan_bottom.cell_size[2])
            .expect("bottom Slonczewski config should build");

        assert_eq!(top.current_sign, 1.0);
        assert_eq!(bottom.current_sign, -1.0);
    }

    #[test]
    fn helper_max_vector_norm_handles_empty_input() {
        assert_eq!(crate::derived_fields::max_vector_norm(&[]), 0.0);
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
                stop: fullmag_ir::RelaxStopIR {
                    torque_tolerance_apm: Some(1e-6),
                    energy_tolerance_j: None,
                    max_steps: Some(1000),
                    max_pseudotime_s: None,
                    max_physical_time_s: None,
                },
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
                stop: fullmag_ir::RelaxStopIR {
                    torque_tolerance_apm: Some(1e-6),
                    energy_tolerance_j: None,
                    max_steps: Some(1000),
                    max_pseudotime_s: None,
                    max_physical_time_s: None,
                },
            }),
            ..make_test_plan()
        };

        let executed = execute_reference_fdm(&plan, 1e-9, &[], None, None)
            .expect("BB relaxation should succeed");
        assert_eq!(executed.result.status, RunStatus::Completed);
        assert!(!executed.result.steps.is_empty());
    }

    #[test]
    fn direct_minimization_provenance_names_cpu_minimizer_realization() {
        let plan = FdmPlanIR {
            relaxation: Some(RelaxationControlIR {
                algorithm: RelaxationAlgorithmIR::ProjectedGradientBb,
                stop: fullmag_ir::RelaxStopIR {
                    torque_tolerance_apm: Some(1e-6),
                    energy_tolerance_j: None,
                    max_steps: Some(1000),
                    max_pseudotime_s: None,
                    max_physical_time_s: None,
                },
            }),
            ..make_test_plan()
        };

        let executed = execute_reference_fdm(&plan, 1e-9, &[], None, None)
            .expect("BB relaxation should succeed");

        assert_eq!(
            executed.provenance.requested_energy_minimizer.as_deref(),
            Some("projected_gradient_bb")
        );
        assert_eq!(
            executed.provenance.resolved_energy_minimizer.as_deref(),
            Some("projected_gradient_bb")
        );
        assert_eq!(
            executed.provenance.energy_minimizer_realization.as_deref(),
            Some("cpu_soa_tangent_gradient")
        );
        assert!(executed.provenance.resolved_integrator.is_none());
    }

    #[test]
    fn ncg_relaxation_stops_on_uniform_state() {
        let plan = FdmPlanIR {
            relaxation: Some(RelaxationControlIR {
                algorithm: RelaxationAlgorithmIR::NonlinearCg,
                stop: fullmag_ir::RelaxStopIR {
                    torque_tolerance_apm: Some(1e-6),
                    energy_tolerance_j: None,
                    max_steps: Some(1000),
                    max_pseudotime_s: None,
                    max_physical_time_s: None,
                },
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
                stop: fullmag_ir::RelaxStopIR {
                    torque_tolerance_apm: Some(1e-6),
                    energy_tolerance_j: None,
                    max_steps: Some(5000),
                    max_pseudotime_s: None,
                    max_physical_time_s: None,
                },
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
                stop: fullmag_ir::RelaxStopIR {
                    torque_tolerance_apm: Some(1e-6),
                    energy_tolerance_j: None,
                    max_steps: Some(5000),
                    max_pseudotime_s: None,
                    max_physical_time_s: None,
                },
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
                    stop: fullmag_ir::RelaxStopIR {
                        torque_tolerance_apm: Some(1e-4),
                        energy_tolerance_j: None,
                        max_steps: Some(2000),
                        max_pseudotime_s: None,
                        max_physical_time_s: None,
                    },
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
