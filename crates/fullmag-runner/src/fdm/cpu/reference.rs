//! CPU reference engine: executes FDM LLG via `fullmag-engine`.
//!
//! This remains the calibration baseline for terms that are not yet wired
//! into the native CUDA backend.

use fullmag_engine::{
    magnetoelastic::{MagnetoelasticParams, PrescribedStrainField},
    AdaptiveStepConfig, AxisBoundary, CellSize, CubicAnisotropyConfig, EffectiveFieldTerms,
    EngineError, EvaluationRequest, ExchangeLlgProblem, ExchangeLlgState, ExchangeLlgStateSoA,
    ExternalStageTerms, FdmBoundaryPolicy, FftWorkspace, GridShape, IntegratorBuffers, LlgConfig,
    MagnetoelasticTermConfig, MaterialParameters, OerstedCylinderConfig, RegionalFieldDriveTerm,
    ResolvedFdmPeriodicWorkspace, SlonczewskiSttConfig, SotConfig, SotFormula, StepReport,
    TimeIntegrator, UniaxialAnisotropyConfig, Vector3, ZhangLiFormula, ZhangLiSttConfig,
};
use fullmag_ir::{
    ExecutionPrecision, FdmPlanIR, IntegratorChoice, OutputIR, RelaxationAlgorithmIR,
    RelaxationControlIR, StageCompletionIR,
};

use super::spin_transport::{
    FdmCoupledCheckpoint, FdmSpinTransportEvaluation, FdmSpinTransportWorkflow,
};
use crate::artifact_pipeline::{ArtifactPipelineSender, ArtifactRecorder};
use crate::derived_fields::{compute_torque_field, max_torque_residual_apm_from_field};
use crate::fdm::{artifacts::select_state_observable_field, validate_single_grid_budget};
use crate::interactive_runtime::{display_is_global_scalar, display_refresh_due};
use crate::preview::{
    build_grid_preview_field, build_grid_scalar_preview_field, flatten_vectors, select_observables,
};
use crate::quantities::normalized_quantity_name;
use crate::quantities::{active_fdm_preview_quantities, field_materialization_quantity_ids};
use crate::relaxation::{
    apply_energy_minimizer_provenance, execute_nonlinear_cg, execute_projected_gradient_bb,
    llg_overdamped_uses_pure_damping, RelaxationEnergyPlateauWindow, RelaxationTorqueConfirmation,
    CPU_SOA_DIRECT_MINIMIZER_REALIZATION,
};
use crate::scalar_metrics::{
    apply_average_m_to_step_stats_with_active_mask, scalar_outputs_request_average_m,
    scalar_row_due, single_object_scalars,
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
        formula: match plan.sot_formula_version.as_deref() {
            Some("prescribed_sot.fullmag.v1") => SotFormula::FullmagV1,
            _ => SotFormula::LegacyFullmagV0,
        },
        current_density: je,
        xi_dl: plan.sot_xi_dl.unwrap_or(0.0),
        xi_fl: plan.sot_xi_fl.unwrap_or(0.0),
        sigma,
        thickness,
        active_mask: plan.sot_active_mask.clone(),
        envelope: plan.sot_envelope.clone(),
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
        formula: match plan.zhang_li_formula_version.as_deref() {
            Some("zhang_li.mumax3.v1") => ZhangLiFormula::Mumax3V1,
            Some("zhang_li.fullmag.v1") => ZhangLiFormula::FullmagV1,
            _ => ZhangLiFormula::LegacyFullmagV0,
        },
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
    let (current_density_magnitude, current_sign, active_mask) = match plan
        .slonczewski_formula_version
        .as_deref()
        .unwrap_or("slonczewski.legacy_fullmag.v0")
    {
        "slonczewski.fullmag.v2" => {
            let n = plan.slonczewski_stack_normal?;
            let active_mask = plan.slonczewski_active_mask.clone()?;
            let n_norm = (n[0] * n[0] + n[1] * n[1] + n[2] * n[2]).sqrt();
            let signed_normal_current = (j[0] * n[0] + j[1] * n[1] + j[2] * n[2]) / n_norm;
            if !signed_normal_current.is_finite() || signed_normal_current == 0.0 {
                return None;
            }
            (
                signed_normal_current.abs(),
                signed_normal_current.signum(),
                Some(active_mask),
            )
        }
        "slonczewski.legacy_fullmag.v0" => (
            j_mag,
            match plan.stt_fixed_layer_position.as_deref().unwrap_or("top") {
                "bottom" => -1.0,
                _ => 1.0,
            },
            None,
        ),
        _ => return None,
    };
    Some(SlonczewskiSttConfig {
        formula: match plan.slonczewski_formula_version.as_deref() {
            Some("slonczewski.fullmag.v2") => fullmag_engine::SlonczewskiFormula::FullmagV2,
            _ => fullmag_engine::SlonczewskiFormula::LegacyFullmagV0,
        },
        current_density_magnitude,
        spin_polarization_axis: p_axis,
        lambda: lam,
        epsilon_prime: plan.stt_epsilon_prime.unwrap_or(0.0),
        degree: plan.stt_degree.unwrap_or(1.0),
        thickness,
        current_sign,
        active_mask,
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

fn resolved_per_node_external_field(plan: &FdmPlanIR, time_seconds: f64) -> Option<Vec<Vector3>> {
    resolved_per_node_external_field_for_count(plan, plan.initial_magnetization.len(), time_seconds)
}

pub(crate) fn resolved_per_node_external_field_for_count(
    plan: &FdmPlanIR,
    sample_count: usize,
    time_seconds: f64,
) -> Option<Vec<Vector3>> {
    let antenna = if plan.antenna_zeeman_masks.is_empty() {
        None
    } else {
        Some(
            crate::antenna_fields::combined_antenna_zeeman_mask_field_at_time(
                &plan.antenna_zeeman_masks,
                sample_count,
                time_seconds,
            ),
        )
    };
    match (plan.oersted_field_xyz.as_ref(), antenna) {
        (None, None) => None,
        (Some(field), None) => Some(field.clone()),
        (None, Some(field)) => Some(field),
        (Some(oersted), Some(mut field)) => {
            for (index, value) in oersted.iter().enumerate().take(field.len()) {
                field[index][0] += value[0];
                field[index][1] += value[1];
                field[index][2] += value[2];
            }
            Some(field)
        }
    }
}

fn resolved_antenna_zeeman_field(plan: &FdmPlanIR, time_seconds: f64) -> Vec<Vector3> {
    resolved_antenna_zeeman_field_for_count(plan, plan.initial_magnetization.len(), time_seconds)
}

pub(crate) fn resolved_antenna_zeeman_field_for_count(
    plan: &FdmPlanIR,
    sample_count: usize,
    time_seconds: f64,
) -> Vec<Vector3> {
    crate::antenna_fields::combined_antenna_zeeman_mask_field_at_time(
        &plan.antenna_zeeman_masks,
        sample_count,
        time_seconds,
    )
}

pub(crate) fn resolved_oersted_visual_field_for_count(
    problem: &ExchangeLlgProblem,
    plan: &FdmPlanIR,
    sample_count: usize,
    time_seconds: f64,
    antenna_field: &[Vector3],
) -> Vec<Vector3> {
    // The engine's Oersted accessor starts from the aggregate per-node field,
    // which also carries antenna Zeeman values. Separate the sources again for
    // publication, while retaining explicit Oersted samples in Airbox cells.
    let mut field = problem.oersted_field_at_time(time_seconds);
    field.resize(sample_count, [0.0, 0.0, 0.0]);
    field.truncate(sample_count);
    let explicit_oersted = plan.oersted_field_xyz.as_deref().unwrap_or(&[]);

    for (index, value) in field.iter_mut().enumerate() {
        if plan
            .active_mask
            .as_ref()
            .is_some_and(|mask| !mask.get(index).copied().unwrap_or(false))
        {
            *value = explicit_oersted
                .get(index)
                .copied()
                .unwrap_or([0.0, 0.0, 0.0]);
            continue;
        }
        if let Some(antenna) = antenna_field.get(index) {
            value[0] -= antenna[0];
            value[1] -= antenna[1];
            value[2] -= antenna[2];
        }
    }
    field
}

pub(crate) fn resolved_regional_field_drives(
    plan: &FdmPlanIR,
    stage_start_time_s: f64,
) -> Vec<RegionalFieldDriveTerm> {
    plan.regional_field_drive_bases
        .iter()
        .map(|resolved| RegionalFieldDriveTerm {
            basis_field: resolved.field_xyz.clone(),
            waveform: resolved.drive.waveform.clone(),
            time_offset_s: match resolved.drive.time_origin {
                fullmag_ir::FieldTimeOriginIR::StageLocal => stage_start_time_s,
                fullmag_ir::FieldTimeOriginIR::Absolute => 0.0,
            },
            enabled: resolved.drive.enabled,
        })
        .collect()
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
    let (mut problem, state) = build_snapshot_problem_and_state(plan)?;
    problem.terms.per_node_field = resolved_per_node_external_field(plan, state.time_seconds);
    let antenna_field = resolved_antenna_zeeman_field(plan, state.time_seconds);
    let oersted_field = resolved_oersted_visual_field_for_count(
        &problem,
        plan,
        state.magnetization().len(),
        state.time_seconds,
        &antenna_field,
    );
    snapshot_vector_fields_from_state(
        &problem,
        &state,
        quantities,
        request,
        plan.grid.cells,
        plan.active_mask.as_deref(),
        Some(&oersted_field),
        Some(&antenna_field),
    )
}

pub(crate) fn snapshot_vector_fields_from_state(
    problem: &ExchangeLlgProblem,
    state: &ExchangeLlgState,
    quantities: &[&str],
    request: &LivePreviewRequest,
    grid: [u32; 3],
    active_mask: Option<&[bool]>,
    oersted_field: Option<&[Vector3]>,
    antenna_field: Option<&[Vector3]>,
) -> Result<Vec<crate::LivePreviewField>, RunError> {
    let mut direct_fields = DirectFieldSnapshotCache::new_with_source_fields(
        problem,
        state,
        oersted_field,
        antenna_field,
    );
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
                observables = Some(observe_state_with_antenna_field(
                    problem,
                    state,
                    antenna_field.map(<[_]>::to_vec),
                )?);
            }
            let values =
                select_observables(observables.as_ref().expect("observables"), quantity)?.to_vec();
            let expected_len = grid[0] as usize * grid[1] as usize * grid[2] as usize;
            if values.len() != expected_len {
                return Err(RunError {
                    message: format!(
                        "CPU FDM snapshot '{}': expected {} grid values, received {}",
                        quantity,
                        expected_len,
                        values.len()
                    ),
                });
            }
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

fn materialize_reference_problem(
    mut problem: ExchangeLlgProblem,
    plan: &FdmPlanIR,
) -> Result<ExchangeLlgProblem, RunError> {
    problem.regional_field_drives =
        resolved_regional_field_drives(plan, plan.time_stage.start_time_s);
    if let Some(ref pbc) = plan.periodicity {
        let map_axis = |axis: &fullmag_ir::AxisBoundary| match axis {
            fullmag_ir::AxisBoundary::Periodic => AxisBoundary::Periodic,
            fullmag_ir::AxisBoundary::Open => AxisBoundary::Open,
        };
        problem.boundary_policy = FdmBoundaryPolicy {
            x: map_axis(&pbc.axes[0]),
            y: map_axis(&pbc.axes[1]),
            z: map_axis(&pbc.axes[2]),
        };
        if let Some(image_counts) = pbc.image_counts {
            problem.demag_image_counts = image_counts;
        }
    }
    problem.set_demag_boundary(crate::fdm::resolve_fdm_demag_boundary(plan)?);
    problem.set_resolved_periodic_workspace(plan.resolved_periodic_images.as_ref().map(
        |resolved| ResolvedFdmPeriodicWorkspace {
            image_counts: resolved.resolved_image_counts,
            padded_counts: resolved.padded_counts,
            image_terms: resolved.image_terms,
            estimated_bytes: resolved.estimated_bytes,
        },
    ));
    problem.temperature = plan.temperature.unwrap_or(0.0);
    if problem.temperature > 0.0 {
        problem.thermal_seed = plan
            .thermal_seed_config
            .as_ref()
            .and_then(|config| config.seed)
            .unwrap_or_else(|| (uuid::Uuid::new_v4().as_u128() as u64).max(1));
    }
    if let Some(dt) = plan.fixed_timestep {
        problem.thermal_dt = dt;
    }
    problem
        .with_spatial_fields(
            plan.material.ms_field.clone(),
            plan.material.a_field.clone(),
            plan.material.alpha_field.clone(),
        )
        .map_err(|e| RunError {
            message: format!("Spatial fields: {}", e),
        })
}

fn build_reference_problem(plan: &FdmPlanIR) -> Result<ExchangeLlgProblem, RunError> {
    validate_single_grid_budget(plan)?;
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
        dynamics = dynamics.with_adaptive(AdaptiveStepConfig {
            max_error: adaptive.atol,
            dt_min: adaptive.dt_min,
            dt_max: adaptive.dt_max.ok_or_else(|| RunError {
                message: "adaptive timestep requires explicit dt_max".to_string(),
            })?,
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

    let problem = ExchangeLlgProblem::with_terms_and_mask(
        grid,
        cell_size,
        material,
        dynamics,
        EffectiveFieldTerms {
            exchange: plan.enable_exchange,
            demag: plan.enable_demag,
            external_field: plan.external_field,
            per_node_field: resolved_per_node_external_field(plan, 0.0),
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
                .or(plan.material.cubic_anisotropy_kc2)
                .or(plan.material.cubic_anisotropy_kc3)
                .map(|_| CubicAnisotropyConfig {
                    kc1: plan.material.cubic_anisotropy_kc1.unwrap_or(0.0),
                    kc2: plan.material.cubic_anisotropy_kc2.unwrap_or(0.0),
                    kc3: plan.material.cubic_anisotropy_kc3.unwrap_or(0.0),
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
    materialize_reference_problem(problem, plan)
}

pub(crate) fn build_snapshot_problem_and_state(
    plan: &FdmPlanIR,
) -> Result<(ExchangeLlgProblem, ExchangeLlgState), RunError> {
    let problem = build_reference_problem(plan)?;
    let mut state = problem
        .new_state(plan.initial_magnetization.clone())
        .map_err(|e| RunError {
            message: format!("State: {}", e),
        })?;
    state.time_seconds = plan.time_stage.start_time_s;
    Ok((problem, state))
}

/// Execute an FDM plan on the CPU reference engine.
///
/// Pass `live: Some(LiveStepConsumer { .. })` for per-step callbacks /
/// live preview, and `artifact_writer: Some(sender)` for streaming artifacts.
pub(crate) fn execute_coupled_ars_trial(
    problem: &ExchangeLlgProblem,
    state: &mut ExchangeLlgState,
    workflow: &mut FdmSpinTransportWorkflow,
    dt: f64,
    fft_workspace: &mut FftWorkspace,
    integrator_bufs: &mut IntegratorBuffers,
) -> Result<StepReport, RunError> {
    let mut trial_state = state.clone();
    let mut trial_workflow = workflow.clone();
    let mut candidate: Option<FdmSpinTransportEvaluation> = None;
    trial_workflow.begin_attempt()?;
    let result = problem.coupled_imex_ark2_fixed_step_with_external_stage_terms(
        &mut trial_state,
        dt,
        fft_workspace,
        integrator_bufs,
        EvaluationRequest::Full,
        |magnetization, time_s, stage| {
            let previous_stage = candidate.as_ref();
            let evaluation = trial_workflow
                .evaluate_coupled_ars_stage(magnetization, time_s, dt, stage, previous_stage)
                .map_err(|error| EngineError::new(error.message))?;
            let terms = ExternalStageTerms {
                additional_field_apm: evaluation
                    .combined_oersted_field_apm
                    .clone()
                    .unwrap_or_else(|| vec![[0.0; 3]; magnetization.len()]),
                direct_torque_per_s: evaluation.combined_transport_torque_per_s.clone(),
            };
            candidate = Some(evaluation);
            Ok(terms)
        },
    );
    match result {
        Ok(report) => {
            let accepted = candidate.ok_or_else(|| RunError {
                message: "coupled ARS step produced no final spin-transport evaluation".into(),
            })?;
            trial_workflow.commit(accepted)?;
            *state = trial_state;
            *workflow = trial_workflow;
            Ok(report)
        }
        Err(error) => Err(RunError {
            message: error.to_string(),
        }),
    }
}

pub(crate) fn execute_reference_fdm(
    plan: &FdmPlanIR,
    until_seconds: f64,
    outputs: &[OutputIR],
    live: Option<LiveStepConsumer<'_>>,
    artifact_writer: Option<ArtifactPipelineSender>,
) -> Result<ExecutedRun, RunError> {
    execute_reference_fdm_with_coupled_checkpoint(
        plan,
        until_seconds,
        outputs,
        live,
        artifact_writer,
        None,
    )
}

pub(crate) fn execute_reference_fdm_with_coupled_checkpoint(
    plan: &FdmPlanIR,
    until_seconds: f64,
    outputs: &[OutputIR],
    mut live: Option<LiveStepConsumer<'_>>,
    artifact_writer: Option<ArtifactPipelineSender>,
    coupled_checkpoint: Option<serde_json::Value>,
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
    let mut spin_transport = FdmSpinTransportWorkflow::from_plan(plan)?;
    if spin_transport.is_some() {
        let transient = spin_transport
            .as_ref()
            .is_some_and(FdmSpinTransportWorkflow::has_transient);
        if !transient && plan.integrator.unwrap_or(IntegratorChoice::Heun) != IntegratorChoice::Heun
        {
            return Err(RunError {
                message: "FDM CPU-double spin transport currently requires the fixed-step Heun integrator; integrator fallback is forbidden".to_string(),
            });
        }
        if !transient && plan.adaptive_timestep.is_some() {
            return Err(RunError {
                message: "FDM CPU-double spin transport does not yet support adaptive-step rejection; use a fixed timestep".to_string(),
            });
        }
        if plan.relaxation.as_ref().is_some_and(|control| {
            matches!(
                control.algorithm,
                RelaxationAlgorithmIR::ProjectedGradientBb | RelaxationAlgorithmIR::NonlinearCg
            )
        }) {
            return Err(RunError {
                message: "direct energy minimization cannot execute a dynamic spin-transport coupling; use LLG/Heun".to_string(),
            });
        }
    }

    let pure_damping_relax = llg_overdamped_uses_pure_damping(plan.relaxation.as_ref());
    let stage_end_time_s = plan.time_stage.start_time_s + until_seconds;
    let is_direct_minimization = plan.relaxation.as_ref().is_some_and(|control| {
        matches!(
            control.algorithm,
            RelaxationAlgorithmIR::ProjectedGradientBb | RelaxationAlgorithmIR::NonlinearCg
        )
    });
    let timestep_policy = if is_direct_minimization || spin_transport.is_some() {
        None
    } else {
        Some(crate::resolve_timestep_policy(
            plan.integrator,
            plan.fixed_timestep,
            plan.adaptive_timestep.as_ref(),
            crate::types::TimestepExecutionLane::fdm_cpu(),
        )?)
    };
    let initial_dt = timestep_policy.as_ref().map(|policy| policy.initial_dt());

    let (mut problem, mut state) = build_snapshot_problem_and_state(plan)?;
    let mut restored_checkpoint = coupled_checkpoint
        .map(|value| {
            super::spin_transport::validate_coupled_m3_checkpoint_value(
                &value,
                plan.grid
                    .cells
                    .iter()
                    .map(|cells| *cells as usize)
                    .product(),
            )?;
            serde_json::from_value::<FdmCoupledCheckpoint>(value).map_err(|error| RunError {
                message: format!("invalid coupled M3 checkpoint payload: {error}"),
            })
        })
        .transpose()?;
    let mut resume_timestep = None;
    let mut resume_previous_timestep = None;
    let mut resume_step_count = None;
    if let Some(checkpoint) = restored_checkpoint.take() {
        let workflow = spin_transport.as_mut().ok_or_else(|| RunError {
            message: "coupled M3 checkpoint requires a transient spin-transport plan".into(),
        })?;
        if checkpoint.thermal_seed != problem.thermal_seed {
            return Err(RunError {
                message: "coupled checkpoint thermal RNG seed does not match the planned problem"
                    .into(),
            });
        }
        let checkpoint = workflow.restore_coupled_checkpoint(checkpoint)?;
        resume_timestep = Some(checkpoint.error_controller.next_dt_s);
        resume_previous_timestep = Some(checkpoint.previous_dt_s);
        resume_step_count = Some(checkpoint.accepted_steps);
        state
            .restore_exact_checkpoint(checkpoint.magnetization, checkpoint.time_s)
            .map_err(|error| RunError {
                message: format!("restoring coupled checkpoint magnetization: {error}"),
            })?;
        problem.restore_thermal_step(checkpoint.thermal_counter);
    }
    let initial_magnetization = state.magnetization().to_vec();

    let mut dt = resume_timestep.unwrap_or_else(|| {
        initial_dt
            .or(plan.fixed_timestep)
            .or_else(|| {
                plan.adaptive_timestep
                    .as_ref()
                    .map(|adaptive| adaptive.dt_initial.unwrap_or(adaptive.dt_min))
            })
            .unwrap_or(crate::NON_LLG_RELAXATION_ABI_DT_PLACEHOLDER)
    });
    let mut last_solver_dt = resume_previous_timestep.unwrap_or(0.0);
    let mut steps: Vec<StepStats> = Vec::new();
    let mut step_count: u64 = resume_step_count.unwrap_or(0);
    let mut final_coupled_checkpoint = None;
    let fft_backend = resolve_cpu_fft_backend_name_for_demag(plan.enable_demag)?;
    let mut provenance = ExecutionProvenance {
        execution_engine: "cpu_reference".to_string(),
        precision: "double".to_string(),
        transport_modules: super::spin_transport::fdm_transport_execution_provenance(plan),
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
        timestep_policy,
        random_seed: (problem.temperature > 0.0).then_some(problem.thermal_seed),
        executed_physics_kinds: if !is_direct_minimization
            && (plan.zhang_li_formula_version.is_some()
                || plan.slonczewski_formula_version.is_some()
                || plan.sot_formula_version.is_some())
        {
            vec!["spin_torque".to_string()]
        } else {
            Vec::new()
        },
        ..Default::default()
    };
    apply_energy_minimizer_provenance(&mut provenance, plan.relaxation.as_ref());
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
    let time_events = crate::time_events::build_resolved_stage_event_schedule(
        &plan.field_drives,
        plan.time_stage.start_time_s,
        stage_end_time_s,
        outputs,
        crate::schedules::OUTPUT_TIME_TOLERANCE,
    );
    let default_scalar_trace = scalar_schedules.is_empty();

    if default_scalar_trace {
        record_scalar_snapshot(
            &problem,
            &state,
            0,
            state.time_seconds,
            0,
            &mut steps,
            &mut artifacts,
        )?;
    } else {
        record_due_outputs(
            &problem,
            &state,
            Some(resolved_antenna_zeeman_field(plan, state.time_seconds)),
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
    let mut state_soa = if spin_transport.is_none() && problem.soa_fast_path_supported() {
        Some(state.to_soa())
    } else {
        None
    };
    let mut direct_minimizer_completion: Option<StageCompletionIR> = None;
    let mut energy_plateau = RelaxationEnergyPlateauWindow::default();
    let mut torque_confirmation = RelaxationTorqueConfirmation::default();
    let mut completion_metrics = crate::relaxation::RelaxationCompletionMetrics::default();
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
        artifacts.observe_energy_evaluation();

        let wall_elapsed = wall_start.elapsed().as_nanos() as u64;

        // Update state with result
        state
            .set_magnetization(result.final_magnetization)
            .map_err(|e| RunError {
                message: format!("Setting relaxation result: {}", e),
            })?;
        step_count = result.steps_taken;

        // Record final observables
        let observables = observe_state_with_antenna_field(
            &problem,
            &state,
            Some(resolved_antenna_zeeman_field(plan, state.time_seconds)),
        )?;
        let mut final_stats = make_step_stats(
            step_count,
            state.time_seconds,
            0.0,
            wall_elapsed,
            &observables,
            problem.active_mask.as_deref(),
        );
        final_stats.pseudo_time_s = None;
        let direct_metrics = final_stats
            .per_object_scalars
            .entry("free".to_string())
            .or_default();
        if let Some(step_size) = result.last_accepted_step_m_per_a {
            direct_metrics.insert("accepted_step_m_per_A".to_string(), step_size);
        }
        direct_metrics.insert(
            "line_search_backtracks".to_string(),
            result.line_search_backtracks as f64,
        );
        direct_metrics.insert(
            "energy_evaluations".to_string(),
            result.energy_evaluations as f64,
        );
        direct_metrics.insert(
            "field_evaluations".to_string(),
            result.field_evaluations as f64,
        );
        direct_metrics.insert("rhs_evaluations".to_string(), result.rhs_evaluations as f64);
        direct_metrics.insert("accepted_steps".to_string(), result.steps_taken as f64);

        steps.push(final_stats);
        direct_minimizer_completion = Some(infer_direct_minimizer_completion(
            control,
            result.converged,
            result.steps_taken,
            result.numerical_stagnation,
            result.numerical_error,
            result.final_energy_plateau_range_j,
            result.final_max_torque,
        ));
    } else {
        // LLG overdamped (or no relaxation): existing time-stepping loop
        let needs_initial_live_snapshot = live
            .as_ref()
            .is_some_and(|consumer| consumer.initial_snapshot);
        let mut current_observables = if needs_initial_live_snapshot {
            Some(observe_state_with_antenna_field(
                &problem,
                &state,
                Some(resolved_antenna_zeeman_field(plan, state.time_seconds)),
            )?)
        } else {
            None
        };
        let mut current_observables_stale = false;
        let mut current_stats = current_observables
            .as_ref()
            .map(|observables| {
                make_step_stats(
                    step_count,
                    state.time_seconds,
                    0.0,
                    0,
                    observables,
                    problem.active_mask.as_deref(),
                )
            })
            .unwrap_or_default();
        while state.time_seconds < stage_end_time_s {
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
                                current_observables = Some(observe_state_with_antenna_field(
                                    &problem,
                                    &state,
                                    Some(resolved_antenna_zeeman_field(plan, state.time_seconds)),
                                )?);
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
                        coupled_checkpoint: None,
                        stats: current_stats.clone(),
                        scalar_row_due: preview_due && preview_targets_global_scalar,
                        grid: live.grid,
                        fem_mesh_generation_id: None,
                        magnetization: Some(flatten_vectors(state.magnetization())),
                        preview_field,
                        cached_preview_fields: None,
                        hysteresis_field_m_t: None,
                        hysteresis_point_index: None,
                        hysteresis_settle_step_index: None,
                        hysteresis_settle_step_kind: None,
                        hysteresis_settle_step_method: None,
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

            let remaining = stage_end_time_s - state.time_seconds;
            let transient_coupling = spin_transport
                .as_ref()
                .is_some_and(FdmSpinTransportWorkflow::has_transient);
            let canonical_fixed_target = transient_coupling
                .then_some(())
                .and(plan.fixed_timestep)
                .and_then(|fixed_dt| {
                    spin_transport.as_ref().map(|workflow| {
                        plan.time_stage.start_time_s
                            + (workflow.accepted_steps().saturating_add(1) as f64) * fixed_dt
                    })
                });
            let endpoint_roundoff =
                32.0 * f64::EPSILON * stage_end_time_s.abs().max(dt.abs()).max(f64::MIN_POSITIVE);
            let dt_step = canonical_fixed_target
                .filter(|target| *target <= stage_end_time_s + endpoint_roundoff)
                .and(plan.fixed_timestep)
                .unwrap_or_else(|| {
                    crate::time_events::cap_timestep_to_next_event(
                        state.time_seconds,
                        dt.min(remaining),
                        &time_events.times_s,
                        crate::schedules::OUTPUT_TIME_TOLERANCE,
                    )
                });
            if crate::antenna_fields::has_time_varying_antenna_zeeman_masks(
                &plan.antenna_zeeman_masks,
            ) {
                problem.terms.per_node_field =
                    resolved_per_node_external_field(plan, state.time_seconds);
            }
            let wall_start = Instant::now();
            let previous_magnetization = state.magnetization().to_vec();
            let mut report = if let Some(workflow) = spin_transport.as_mut() {
                let transient = workflow.has_transient();
                if transient {
                    if let Some(adaptive) = plan.adaptive_timestep.as_ref() {
                        let committed_state = state.clone();
                        let committed_workflow = workflow.clone();
                        let accepted_before = committed_workflow.accepted_steps();
                        let rejected_before = committed_workflow.rejected_steps();
                        let mut rejected_trials = 0u64;
                        let mut attempted_dt = dt_step;
                        loop {
                            let mut full_state = committed_state.clone();
                            let mut full_workflow = committed_workflow.clone();
                            let _full_report = execute_coupled_ars_trial(
                                &problem,
                                &mut full_state,
                                &mut full_workflow,
                                attempted_dt,
                                &mut fft_workspace,
                                &mut integrator_bufs,
                            )?;
                            let mut half_state = committed_state.clone();
                            let mut half_workflow = committed_workflow.clone();
                            execute_coupled_ars_trial(
                                &problem,
                                &mut half_state,
                                &mut half_workflow,
                                0.5 * attempted_dt,
                                &mut fft_workspace,
                                &mut integrator_bufs,
                            )?;
                            let mut half_report = execute_coupled_ars_trial(
                                &problem,
                                &mut half_state,
                                &mut half_workflow,
                                0.5 * attempted_dt,
                                &mut fft_workspace,
                                &mut integrator_bufs,
                            )?;
                            let error = full_workflow.normalized_coupled_difference(
                                &half_workflow,
                                full_state.magnetization(),
                                half_state.magnetization(),
                                adaptive.atol,
                                adaptive.rtol,
                            )?;
                            let factor = if error == 0.0 {
                                adaptive.growth_limit
                            } else {
                                (adaptive.safety * error.powf(-1.0 / 3.0))
                                    .clamp(adaptive.shrink_limit, adaptive.growth_limit)
                            };
                            let next_dt = (attempted_dt * factor)
                                .max(adaptive.dt_min)
                                .min(adaptive.dt_max.unwrap_or(f64::INFINITY));
                            if error <= 1.0 {
                                *workflow = half_workflow;
                                workflow.set_step_counters(
                                    accepted_before.saturating_add(1),
                                    rejected_before.saturating_add(rejected_trials),
                                );
                                workflow.set_error_controller(next_dt, error);
                                state = half_state;
                                half_report.dt_used = attempted_dt;
                                half_report.suggested_next_dt = Some(next_dt);
                                problem.commit_coupled_imex_ark2_step();
                                break half_report;
                            }
                            rejected_trials = rejected_trials.saturating_add(1);
                            if attempted_dt <= adaptive.dt_min {
                                return Err(RunError {
                                    message: format!(
                                        "Step {step_count}: coupled ARS LTE {error:.6e} exceeds 1 at dt_min"
                                    ),
                                });
                            }
                            attempted_dt = next_dt;
                        }
                    } else {
                        let report = execute_coupled_ars_trial(
                            &problem,
                            &mut state,
                            workflow,
                            dt_step,
                            &mut fft_workspace,
                            &mut integrator_bufs,
                        )
                        .map_err(|error| RunError {
                            message: format!("Step {step_count}: {}", error.message),
                        })?;
                        problem.commit_coupled_imex_ark2_step();
                        report
                    }
                } else {
                    let mut candidate: Option<FdmSpinTransportEvaluation> = None;
                    workflow.begin_attempt()?;
                    let result = problem.heun_step_with_external_stage_terms_and_lte(
                        &mut state,
                        dt_step,
                        &mut fft_workspace,
                        &mut integrator_bufs,
                        EvaluationRequest::Full,
                        |magnetization, time_s, stage_error_budget| {
                            let previous_stage = candidate.as_ref();
                            let evaluation = workflow
                                .evaluate_stage_with_lte(
                                    magnetization,
                                    time_s,
                                    stage_error_budget,
                                    previous_stage,
                                )
                                .map_err(|error| EngineError::new(error.message))?;
                            let terms = ExternalStageTerms {
                                additional_field_apm: evaluation
                                    .combined_oersted_field_apm
                                    .clone()
                                    .unwrap_or_else(|| vec![[0.0; 3]; magnetization.len()]),
                                direct_torque_per_s: evaluation
                                    .combined_transport_torque_per_s
                                    .clone(),
                            };
                            candidate = Some(evaluation);
                            Ok(terms)
                        },
                    );
                    match result {
                        Ok(report) => {
                            let accepted = candidate.take().ok_or_else(|| RunError {
                                message:
                                    "coupled Heun step produced no final spin-transport evaluation"
                                        .to_string(),
                            })?;
                            workflow.commit(accepted)?;
                            report
                        }
                        Err(error) => {
                            workflow.rollback();
                            return Err(RunError {
                                message: format!("Step {}: {}", step_count, error),
                            });
                        }
                    }
                }
            } else {
                step_reference_fdm_problem(
                    &problem,
                    &mut state,
                    &mut state_soa,
                    dt_step,
                    &mut fft_workspace,
                    &mut integrator_bufs,
                )
                .map_err(|e| RunError {
                    message: format!("Step {}: {}", step_count, e),
                })?
            };
            if let (Some(target), Some(workflow)) =
                (canonical_fixed_target, spin_transport.as_mut())
            {
                let canonical_dt = plan.fixed_timestep.ok_or_else(|| RunError {
                    message: "canonical coupled fixed-step target requires fixed_timestep".into(),
                })?;
                state.time_seconds = target;
                workflow.canonicalize_fixed_step_time(target, canonical_dt)?;
                report.time_seconds = target;
                report.dt_used = canonical_dt;
            }
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
                max_rhs_norm_per_s: report.max_rhs_amplitude,
                max_h_eff: report.max_effective_field_amplitude,
                max_h_demag: report.max_demag_field_amplitude,
                max_torque_Apm: report.max_torque_Apm,
                max_torque_T: report.max_torque_Apm * crate::MU0,
                wall_time_ns: wall_elapsed,
                ..StepStats::default()
            };
            current_stats = latest_stats.clone();
            // Preserve every accepted adaptive/fixed controller step for the
            // solver diagnostics trace.  User-visible scalar schedules remain
            // independent and may be sparse.
            artifacts.record_solver_step(&latest_stats);

            final_coupled_checkpoint = spin_transport
                .as_ref()
                .filter(|workflow| workflow.has_transient())
                .map(|workflow| {
                    workflow
                        .coupled_checkpoint(
                            state.magnetization(),
                            &previous_magnetization,
                            report.dt_used,
                            problem.thermal_seed,
                            problem.thermal_step(),
                        )
                        .and_then(|checkpoint| {
                            serde_json::to_value(checkpoint).map_err(|error| RunError {
                                message: format!("serializing coupled M3 checkpoint: {error}"),
                            })
                        })
                })
                .transpose()?;

            if !default_scalar_trace || !field_schedules.is_empty() {
                record_due_outputs(
                    &problem,
                    &state,
                    Some(resolved_antenna_zeeman_field(plan, state.time_seconds)),
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
                    let observables = observe_state_with_antenna_field(
                        &problem,
                        &state,
                        Some(resolved_antenna_zeeman_field(plan, state.time_seconds)),
                    )?;
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
                    &problem,
                );
                if due_scalar_row || scalar_outputs_request_average_m(&scalar_schedules) {
                    apply_average_m_to_step_stats_with_active_mask(
                        &mut update_stats,
                        state.magnetization(),
                        problem.active_mask.as_deref(),
                    );
                }
                let action = (live.on_step)(StepUpdate {
                    coupled_checkpoint: final_coupled_checkpoint.clone(),
                    stats: update_stats,
                    scalar_row_due: due_scalar_row,
                    grid: live.grid,
                    fem_mesh_generation_id: None,
                    magnetization,
                    preview_field,
                    cached_preview_fields: None,
                    hysteresis_field_m_t: None,
                    hysteresis_point_index: None,
                    hysteresis_settle_step_index: None,
                    hysteresis_settle_step_kind: None,
                    hysteresis_settle_step_method: None,
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
                    || torque_confirmation.observe_stats(
                        control,
                        &latest_stats,
                        energy_plateau_range,
                        plan.gyromagnetic_ratio,
                        plan.material.damping,
                        pure_damping_relax,
                    )
            });
            completion_metrics = crate::relaxation::RelaxationCompletionMetrics {
                max_torque_apm: Some(latest_stats.max_torque_Apm),
                torque_confirmed: torque_confirmation.confirmed(),
                accepted_energy_plateau_range_j: energy_plateau_range,
                steps: step_count,
                relaxation_time_s: Some(state.time_seconds),
                numerical_stagnation: false,
            };
            if stop_for_relaxation {
                break;
            }
        }
    }

    record_final_outputs(
        &problem,
        &state,
        Some(resolved_antenna_zeeman_field(plan, state.time_seconds)),
        step_count,
        last_solver_dt,
        default_scalar_trace,
        last_step_report.as_ref(),
        &field_schedules,
        &mut steps,
        &mut artifacts,
    )?;

    if !paused && !cancelled {
        if let Some(live) = live.as_mut() {
            if let Some(final_stats) = steps.last().cloned() {
                let display_selection = live.display_selection.map(|get| get());
                let materialization_quantities = field_materialization_quantity_ids();
                let materialization_quantities = active_fdm_preview_quantities(
                    crate::dispatch::FdmEngine::CpuReference,
                    plan,
                    &materialization_quantities,
                );
                let config_revision = display_selection
                    .as_ref()
                    .map(|selection| selection.revision)
                    .unwrap_or(0);
                let antenna_field = resolved_antenna_zeeman_field(plan, state.time_seconds);
                let oersted_field = resolved_oersted_visual_field_for_count(
                    &problem,
                    plan,
                    state.magnetization().len(),
                    state.time_seconds,
                    &antenna_field,
                );
                let mut cached_preview_fields = snapshot_vector_fields_from_state(
                    &problem,
                    &state,
                    &materialization_quantities,
                    &LivePreviewRequest {
                        revision: config_revision,
                        quantity: "m".to_string(),
                        component: "3D".to_string(),
                        layer: 0,
                        all_layers: true,
                        every_n: 1,
                        x_chosen_size: 0,
                        y_chosen_size: 0,
                        auto_scale_enabled: false,
                        max_points: 0,
                    },
                    live.grid,
                    plan.active_mask.as_deref(),
                    Some(&oersted_field),
                    Some(&antenna_field),
                )?;
                let materialized_at_unix_ms = std::time::SystemTime::now()
                    .duration_since(std::time::UNIX_EPOCH)
                    .unwrap_or_default()
                    .as_millis() as u64;
                for field in &mut cached_preview_fields {
                    field.source_step = final_stats.step;
                    field.source_time_seconds = Some(final_stats.time);
                    field.source_revision = final_stats.step;
                    field.materialized_at_unix_ms = materialized_at_unix_ms;
                }
                let preview_field = if let Some(selection) = display_selection.as_ref() {
                    let preview_field = if !display_is_global_scalar(selection) {
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
                            let observables = observe_state_with_antenna_field(
                                &problem,
                                &state,
                                Some(antenna_field.clone()),
                            )?;
                            Some(build_grid_preview_field(
                                &request,
                                select_observables(&observables, &request.quantity)?,
                                live.grid,
                                plan.active_mask.as_deref(),
                            ))
                        }
                    } else {
                        None
                    };
                    preview_field
                } else {
                    None
                };
                let _ = (live.on_step)(StepUpdate {
                    coupled_checkpoint: final_coupled_checkpoint.clone(),
                    stats: final_stats,
                    scalar_row_due: true,
                    grid: live.grid,
                    fem_mesh_generation_id: None,
                    magnetization: Some(flatten_vectors(state.magnetization())),
                    preview_field,
                    cached_preview_fields: Some(cached_preview_fields),
                    hysteresis_field_m_t: None,
                    hysteresis_point_index: None,
                    hysteresis_settle_step_index: None,
                    hysteresis_settle_step_kind: None,
                    hysteresis_settle_step_method: None,
                    finished: false,
                });
            }
        }
    }

    let diagnostic_trace = artifacts.take_solver_steps();
    let (field_snapshots, field_snapshot_count, provenance) = artifacts.finish();
    let mut status = if paused {
        RunStatus::Paused
    } else if cancelled {
        RunStatus::Cancelled
    } else {
        RunStatus::Completed
    };
    let completion = direct_minimizer_completion.unwrap_or_else(|| {
        crate::relaxation::resolve_stage_completion(
            status,
            plan.relaxation.as_ref(),
            completion_metrics,
        )
    });
    if completion.status == "failed" {
        status = RunStatus::Failed;
    }
    let mut auxiliary_artifacts: Vec<_> = spin_transport
        .as_ref()
        .and_then(FdmSpinTransportWorkflow::accepted)
        .map(|evaluation| {
            let transient = spin_transport
                .as_ref()
                .is_some_and(FdmSpinTransportWorkflow::has_transient);
            let accepted_steps = spin_transport
                .as_ref()
                .map_or(0, FdmSpinTransportWorkflow::accepted_steps);
            let rejected_steps = spin_transport
                .as_ref()
                .map_or(0, FdmSpinTransportWorkflow::rejected_steps);
            serde_json::to_vec_pretty(&serde_json::json!({
                "schema": "fullmag.fdm.spin_transport.accepted.v1",
                "integrator_version": transient.then_some("coupled_imex_ark2.v1"),
                "integrator_implementation_revision": transient.then_some("imex_ars_232_step_doubling.fullmag.v1"),
                "timestep_mode": transient.then_some(if plan.adaptive_timestep.is_some() { "adaptive" } else { "fixed" }),
                "accepted_steps": accepted_steps,
                "rejected_steps": rejected_steps,
                "evaluation": evaluation,
            }))
            .map(|bytes| crate::types::AuxiliaryArtifact {
                relative_path: "transport/spin_transport_accepted.json".to_string(),
                bytes,
            })
            .map_err(|error| RunError {
                message: format!("serializing accepted spin-transport artifact: {error}"),
            })
        })
        .transpose()?
        .into_iter()
        .collect();
    if let Some(trace) = crate::artifacts::solver_diagnostic_trace_artifact(diagnostic_trace) {
        auxiliary_artifacts.push(trace);
    }
    if let Some(checkpoint) = final_coupled_checkpoint {
        auxiliary_artifacts.push(crate::types::AuxiliaryArtifact {
            relative_path: "transport/coupled_checkpoint.json".to_string(),
            bytes: serde_json::to_vec_pretty(&checkpoint).map_err(|error| RunError {
                message: format!("serializing final coupled M3 checkpoint artifact: {error}"),
            })?,
        });
    }

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
        auxiliary_artifacts,
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

fn infer_direct_minimizer_completion(
    control: &RelaxationControlIR,
    converged: bool,
    steps_taken: u64,
    numerical_stagnation: bool,
    numerical_error: bool,
    final_energy_plateau_range_j: Option<f64>,
    final_max_torque: f64,
) -> StageCompletionIR {
    let max_steps_hit = control
        .stop
        .max_steps
        .is_some_and(|limit| steps_taken >= limit);
    let status = if numerical_error || (!converged && !max_steps_hit && !numerical_stagnation) {
        RunStatus::Failed
    } else {
        RunStatus::Completed
    };
    crate::relaxation::resolve_stage_completion(
        status,
        Some(control),
        crate::relaxation::RelaxationCompletionMetrics {
            max_torque_apm: final_max_torque.is_finite().then_some(final_max_torque),
            torque_confirmed: converged,
            accepted_energy_plateau_range_j: final_energy_plateau_range_j
                .map(|value| crate::relaxation::EnergyPlateauRangeJ { value }),
            steps: steps_taken,
            relaxation_time_s: None,
            numerical_stagnation,
        },
    )
}

fn record_due_outputs(
    problem: &ExchangeLlgProblem,
    state: &ExchangeLlgState,
    antenna_field: Option<Vec<Vector3>>,
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
            let stats = make_step_stats_from_report(
                step,
                report,
                wall_time_ns,
                state.magnetization(),
                problem,
            );
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
                component_count: 3,
                component_order: "xyz".into(),
                location: "sample".into(),
                scope: "full".into(),
                revision: step.saturating_add(1),
                values: FieldSnapshot::flatten_vec3(direct_fields.select(&name)?),
            })?;
        }
        if has_due_fields {
            advance_due_schedules(field_schedules, state.time_seconds);
        }
        return Ok(());
    }

    let observables = observe_state_with_antenna_field(problem, state, antenna_field)?;

    if scalar_due {
        let stats = make_step_stats(
            step,
            state.time_seconds,
            solver_dt,
            wall_time_ns,
            &observables,
            problem.active_mask.as_deref(),
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
                component_count: 3,
                component_order: "xyz".into(),
                location: "sample".into(),
                scope: "full".into(),
                revision: step.saturating_add(1),
                values: FieldSnapshot::flatten_vec3(select_state_observable_field(
                    &observables,
                    &name,
                    true,
                )?),
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
        problem.active_mask.as_deref(),
    );
    artifacts.record_scalar(&stats)?;
    steps.push(stats);
    Ok(())
}

fn record_final_outputs(
    problem: &ExchangeLlgProblem,
    state: &ExchangeLlgState,
    antenna_field: Option<Vec<Vector3>>,
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
                component_count: 3,
                component_order: "xyz".into(),
                location: "sample".into(),
                scope: "full".into(),
                revision: step.saturating_add(1),
                values: FieldSnapshot::flatten_vec3(direct_fields.select(&name)?),
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
        let stats = make_step_stats_from_report(step, report, 0, state.magnetization(), problem);
        artifacts.record_scalar(&stats)?;
        steps.push(stats);

        let mut direct_fields = DirectFieldSnapshotCache::new(problem, state);
        for name in missing_field_names {
            artifacts.record_field_snapshot(FieldSnapshot {
                name: name.clone(),
                step,
                time: state.time_seconds,
                solver_dt,
                component_count: 3,
                component_order: "xyz".into(),
                location: "sample".into(),
                scope: "full".into(),
                revision: step.saturating_add(1),
                values: FieldSnapshot::flatten_vec3(direct_fields.select(&name)?),
            })?;
        }
        return Ok(());
    }

    let observables = observe_state_with_antenna_field(problem, state, antenna_field)?;

    if need_scalar {
        let stats = make_step_stats(
            step,
            state.time_seconds,
            solver_dt,
            0,
            &observables,
            problem.active_mask.as_deref(),
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
            component_count: 3,
            component_order: "xyz".into(),
            location: "sample".into(),
            scope: "full".into(),
            revision: step.saturating_add(1),
            values: FieldSnapshot::flatten_vec3(select_state_observable_field(
                &observables,
                &name,
                true,
            )?),
        })?;
    }

    Ok(())
}

pub(crate) fn observe_state(
    problem: &ExchangeLlgProblem,
    state: &ExchangeLlgState,
) -> Result<StateObservables, RunError> {
    observe_state_with_antenna_field(problem, state, None)
}

fn observe_state_with_antenna_field(
    problem: &ExchangeLlgProblem,
    state: &ExchangeLlgState,
    antenna_field_override: Option<Vec<Vector3>>,
) -> Result<StateObservables, RunError> {
    #[cfg(test)]
    increment_observe_state_calls();

    let observables = problem.observe(state).map_err(|e| RunError {
        message: format!("Engine observables: {}", e),
    })?;
    let uniform_external = if let Some(field) = problem.terms.external_field {
        state.magnetization().iter().map(|_| field).collect()
    } else {
        vec![[0.0, 0.0, 0.0]; state.magnetization().len()]
    };
    let oersted_field = problem.oersted_field_at_time(state.time_seconds);
    let antenna_field = antenna_field_override
        .unwrap_or_else(|| vec![[0.0, 0.0, 0.0]; state.magnetization().len()]);
    let drive_field = problem.regional_drive_field_at_time(state.time_seconds);
    let drive_energy = -crate::MU0
        * problem.material.saturation_magnetisation
        * problem.cell_size.volume()
        * state
            .magnetization()
            .iter()
            .zip(&drive_field)
            .enumerate()
            .filter(|(index, _)| {
                !problem
                    .active_mask
                    .as_ref()
                    .is_some_and(|mask| !mask[*index])
            })
            .map(|(_, (m, h))| m[0] * h[0] + m[1] * h[1] + m[2] * h[2])
            .sum::<f64>();
    let mut effective_field = observables.effective_field;
    for (total, drive) in effective_field.iter_mut().zip(&drive_field) {
        total[0] += drive[0];
        total[1] += drive[1];
        total[2] += drive[2];
    }
    if let Some(active_mask) = problem.active_mask.as_deref() {
        reconstruct_inactive_fdm_visual_effective_field(
            &mut effective_field,
            &observables.demag_field,
            &uniform_external,
            &oersted_field,
            &antenna_field,
            active_mask,
        );
    }
    let anisotropy_field = problem.anisotropy_field(state.magnetization());

    let torque_field = compute_torque_field(
        &observables.magnetization,
        &effective_field,
        problem.material.damping,
        problem.dynamics.precession_enabled,
    );
    let max_torque_apm =
        max_torque_residual_apm_from_field(&observables.magnetization, &effective_field);

    Ok(StateObservables {
        magnetization: observables.magnetization,
        torque_field,
        exchange_field: observables.exchange_field,
        demag_field: observables.demag_field,
        external_field: uniform_external,
        antenna_field,
        drive_field,
        effective_field,
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
        drive_energy,
        anisotropy_energy: observables.anisotropy_energy_joules,
        dmi_energy: observables.dmi_energy_joules,
        total_energy: observables.total_energy_joules + drive_energy,
        max_dm_dt: observables.max_rhs_amplitude,
        max_h_eff: observables.max_effective_field_amplitude,
        max_h_demag: observables.max_demag_field_amplitude,
        max_torque_Apm: max_torque_apm,
        per_object_scalars: std::collections::HashMap::new(),
    })
}

fn reconstruct_inactive_fdm_visual_effective_field(
    effective_field: &mut [Vector3],
    demag_field: &[Vector3],
    external_field: &[Vector3],
    oersted_field: &[Vector3],
    antenna_field: &[Vector3],
    active_mask: &[bool],
) {
    for (index, total) in effective_field.iter_mut().enumerate() {
        if active_mask.get(index).copied().unwrap_or(true) {
            continue;
        }
        for component in 0..3 {
            total[component] = demag_field
                .get(index)
                .map(|value| value[component])
                .unwrap_or(0.0)
                + external_field
                    .get(index)
                    .map(|value| value[component])
                    .unwrap_or(0.0)
                + oersted_field
                    .get(index)
                    .map(|value| value[component])
                    .unwrap_or(0.0)
                + antenna_field
                    .get(index)
                    .map(|value| value[component])
                    .unwrap_or(0.0);
        }
    }
}

fn make_step_stats_from_report(
    step: u64,
    report: &StepReport,
    wall_time_ns: u64,
    magnetization: &[Vector3],
    problem: &ExchangeLlgProblem,
) -> StepStats {
    let drive_field = problem.regional_drive_field_at_time(report.time_seconds);
    let drive_energy = -crate::MU0
        * problem.material.saturation_magnetisation
        * problem.cell_size.volume()
        * magnetization
            .iter()
            .zip(&drive_field)
            .enumerate()
            .filter(|(index, _)| {
                !problem
                    .active_mask
                    .as_ref()
                    .is_some_and(|mask| !mask[*index])
            })
            .map(|(_, (m, h))| m[0] * h[0] + m[1] * h[1] + m[2] * h[2])
            .sum::<f64>();
    let mut stats = StepStats {
        step,
        time: report.time_seconds,
        dt: report.dt_used,
        e_ex: report.exchange_energy_joules,
        e_demag: report.demag_energy_joules,
        e_ext: report.external_energy_joules,
        e_drive: drive_energy,
        e_ani: report.anisotropy_energy_joules,
        e_dmi: report.dmi_energy_joules,
        e_total: report.total_energy_joules + drive_energy,
        max_dm_dt: report.max_rhs_amplitude,
        max_rhs_norm_per_s: report.max_rhs_amplitude,
        max_h_eff: report.max_effective_field_amplitude,
        max_h_demag: report.max_demag_field_amplitude,
        max_torque_Apm: report.max_torque_Apm,
        max_torque_T: report.max_torque_Apm * crate::MU0,
        wall_time_ns,
        ..StepStats::default()
    };
    apply_average_m_to_step_stats_with_active_mask(
        &mut stats,
        magnetization,
        problem.active_mask.as_deref(),
    );
    stats.per_object_scalars = single_object_scalars("free", &stats);
    stats
}

fn make_step_stats(
    step: u64,
    time: f64,
    solver_dt: f64,
    wall_time_ns: u64,
    observables: &StateObservables,
    active_mask: Option<&[bool]>,
) -> StepStats {
    let mut stats = StepStats {
        step,
        time,
        dt: solver_dt,
        e_ex: observables.exchange_energy,
        e_demag: observables.demag_energy,
        e_ext: observables.external_energy,
        e_drive: observables.drive_energy,
        e_ani: observables.anisotropy_energy,
        e_dmi: observables.dmi_energy,
        e_total: observables.total_energy,
        max_dm_dt: observables.max_dm_dt,
        max_rhs_norm_per_s: observables.max_dm_dt,
        max_h_eff: observables.max_h_eff,
        max_h_demag: observables.max_h_demag,
        max_torque_Apm: observables.max_torque_Apm,
        max_torque_T: observables.max_torque_Apm * crate::MU0,
        wall_time_ns,
        ..StepStats::default()
    };
    apply_average_m_to_step_stats_with_active_mask(
        &mut stats,
        &observables.magnetization,
        active_mask,
    );
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
        "m" | "H_ex"
            | "H_demag"
            | "H_ext"
            | "H_ani"
            | "H_dmi"
            | "H_oe"
            | "H_OE"
            | "H_eff"
            | "torque"
    ) && component.map_or(true, |component| matches!(component, "x" | "y" | "z"))
}

fn direct_scalar_values_available(name: &str) -> bool {
    matches!(
        name,
        "eden_ex"
            | "eden_demag"
            | "eden_ext"
            | "eden_ani"
            | "eden_dmi"
            | "eden_total"
            | "mat_ms"
            | "mat_aex"
            | "mat_alpha"
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
    oersted_field_override: Option<&'a [Vector3]>,
    antenna_field: Option<&'a [Vector3]>,
}

impl<'a> DirectFieldSnapshotCache<'a> {
    fn new(problem: &'a ExchangeLlgProblem, state: &'a ExchangeLlgState) -> Self {
        Self::new_with_source_fields(problem, state, None, None)
    }

    fn new_with_source_fields(
        problem: &'a ExchangeLlgProblem,
        state: &'a ExchangeLlgState,
        oersted_field_override: Option<&'a [Vector3]>,
        antenna_field: Option<&'a [Vector3]>,
    ) -> Self {
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
            oersted_field_override,
            antenna_field,
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
                Ok(self
                    .problem
                    .anisotropy_energy_density_from_vectors(&magnetization))
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
            "mat_ms" => Ok((0..self.state.magnetization().len())
                .map(|index| self.problem.ms_at(index))
                .collect()),
            "mat_aex" => Ok((0..self.state.magnetization().len())
                .map(|index| self.problem.a_at(index))
                .collect()),
            "mat_alpha" => Ok((0..self.state.magnetization().len())
                .map(|index| self.problem.alpha_at(index))
                .collect()),
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
                    self.demag_field = Some(
                        self.problem
                            .observable_demag_field(self.state)
                            .map_err(|error| RunError {
                                message: format!(
                                    "CPU FDM snapshot '{}': demag field: {}",
                                    name, error
                                ),
                            })?,
                    );
                }
                Ok(self.demag_field.as_deref().expect("cached demag field"))
            }
            "H_ext" => {
                if self.external_field.is_none() {
                    self.external_field = Some(vec![
                        self.problem
                            .terms
                            .external_field
                            .unwrap_or([0.0, 0.0, 0.0]);
                        self.state.magnetization().len()
                    ]);
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
            "H_oe" | "H_OE" => {
                if self.oersted_field.is_none() {
                    self.oersted_field = Some(
                        self.oersted_field_override
                            .map(<[_]>::to_vec)
                            .unwrap_or_else(|| {
                                self.problem.oersted_field_at_time(self.state.time_seconds)
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
            let mut effective_field = self
                .problem
                .observable_effective_field(self.state)
                .map_err(|error| RunError {
                    message: format!("CPU FDM snapshot '{}': effective field: {}", name, error),
                })?;
            if let Some(active_mask) = self.problem.active_mask.as_deref() {
                let demag_field = self.base_values("H_demag", name)?.to_vec();
                let external_field = self.base_values("H_ext", name)?.to_vec();
                let oersted_field = self.base_values("H_oe", name)?.to_vec();
                reconstruct_inactive_fdm_visual_effective_field(
                    &mut effective_field,
                    &demag_field,
                    &external_field,
                    &oersted_field,
                    self.antenna_field.unwrap_or(&[]),
                    active_mask,
                );
            }
            self.effective_field = Some(effective_field);
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
        AdaptiveTimeStepIR, AdaptiveToleranceModeIR, AxisBoundary as IrAxisBoundary,
        DriveActivationIR, ExchangeBoundaryCondition, ExecutionPrecision, FdmDemagPeriodicityIR,
        FdmMaterialIR, FdmPeriodicityIR, FieldDriveKindIR, FieldSpatialProfileIR, FieldTargetIR,
        FieldTimeOriginIR, GridDimensions, IntegratorChoice, RegionalFieldDriveIR, RelaxStopIR,
        RelaxationAlgorithmIR, RelaxationControlIR, ResolvedRegionalFieldDriveBasisIR,
        StageStopReason, TimeDependenceIR,
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
            integrator: Some(IntegratorChoice::Heun),
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

    #[test]
    fn reference_construction_preserves_fixed_vs_adaptive_embedded_rk_policy() {
        let fixed = FdmPlanIR {
            integrator: Some(IntegratorChoice::Rk45),
            ..make_test_plan()
        };
        let (fixed_problem, _) = build_snapshot_problem_and_state(&fixed).expect("fixed problem");
        assert!(!fixed_problem.dynamics.adaptive_enabled);

        let adaptive = FdmPlanIR {
            fixed_timestep: None,
            adaptive_timestep: Some(AdaptiveTimeStepIR {
                tolerance_mode: AdaptiveToleranceModeIR::MaxError,
                atol: 1e-6,
                rtol: 0.0,
                dt_initial: Some(1e-15),
                dt_min: 1e-16,
                dt_max: Some(1e-14),
                safety: 0.9,
                growth_limit: 2.0,
                shrink_limit: 0.2,
                max_spin_rotation: None,
                norm_tolerance: None,
            }),
            ..fixed
        };
        let (adaptive_problem, _) =
            build_snapshot_problem_and_state(&adaptive).expect("adaptive problem");
        assert!(adaptive_problem.dynamics.adaptive_enabled);
        assert_eq!(adaptive_problem.dynamics.adaptive.dt_min, 1e-16);
        assert_eq!(adaptive_problem.dynamics.adaptive.dt_max, 1e-14);
    }

    #[test]
    fn batch_and_snapshot_share_plan_materialization_errors() {
        let mut plan = make_test_plan();
        plan.material.ms_field = Some(vec![800e3; 15]);

        let snapshot_error = build_snapshot_problem_and_state(&plan)
            .expect_err("snapshot construction must validate spatial material fields");
        let batch_error = execute_reference_fdm(&plan, 1e-14, &[], None, None)
            .expect_err("batch execution must validate the same spatial material fields");

        assert_eq!(batch_error.message, snapshot_error.message);
        assert!(
            batch_error.message.contains("Spatial fields"),
            "{batch_error:?}"
        );
        assert!(
            batch_error.message.contains("ms_field length"),
            "{batch_error:?}"
        );
    }

    #[test]
    fn reference_problem_keeps_kc3_only_cubic_anisotropy() {
        let mut plan = make_test_plan();
        plan.material.cubic_anisotropy_kc3 = Some(4.2e4);

        let (problem, _) = build_snapshot_problem_and_state(&plan).expect("materialized problem");
        let cubic = problem
            .terms
            .cubic_anisotropy
            .expect("Kc3 alone must enable cubic anisotropy");
        assert_eq!(cubic.kc1, 0.0);
        assert_eq!(cubic.kc2, 0.0);
        assert_eq!(cubic.kc3, 4.2e4);
    }

    #[test]
    fn reference_problem_materializes_thermal_spatial_and_periodic_plan_data() {
        let mut plan = make_test_plan();
        plan.enable_demag = true;
        plan.temperature = Some(321.0);
        plan.thermal_seed_config = Some(fullmag_ir::ThermalSeedConfig {
            policy: fullmag_ir::SeedPolicy::Fixed,
            seed: Some(77),
        });
        plan.fixed_timestep = Some(2e-14);
        plan.material.ms_field = Some(vec![800e3; 16]);
        plan.material.a_field = Some(vec![13e-12; 16]);
        plan.material.alpha_field = Some(vec![0.25; 16]);
        plan.periodicity = Some(FdmPeriodicityIR {
            axes: [
                IrAxisBoundary::Periodic,
                IrAxisBoundary::Open,
                IrAxisBoundary::Open,
            ],
            demag: FdmDemagPeriodicityIR::TruncatedImages,
            image_counts: Some([2, 0, 0]),
        });
        plan.resolved_periodic_images = plan
            .periodicity
            .as_ref()
            .expect("periodicity")
            .resolve_periodic_images(plan.grid.cells, plan.precision)
            .expect("resolved periodic workspace");

        let (problem, _) = build_snapshot_problem_and_state(&plan).expect("materialized problem");

        assert_eq!(problem.temperature, 321.0);
        assert_eq!(problem.thermal_dt, 2e-14);
        assert_eq!(problem.thermal_seed, 77);
        assert_eq!(problem.ms_field, plan.material.ms_field);
        assert_eq!(problem.a_field, plan.material.a_field);
        assert_eq!(problem.alpha_field, plan.material.alpha_field);
        assert_eq!(problem.boundary_policy.x, AxisBoundary::Periodic);
        assert_eq!(
            problem
                .resolved_periodic_workspace
                .expect("periodic workspace")
                .image_counts,
            [2, 0, 0]
        );
    }

    #[test]
    fn regional_drive_produces_distinct_field_and_energy_outputs() {
        let drive = RegionalFieldDriveIR {
            id: "drive".into(),
            name: "Drive".into(),
            kind: FieldDriveKindIR::Regional,
            enabled: true,
            target: FieldTargetIR::Global {},
            amplitude_b_t: 1e-3,
            direction: [0.0, 1.0, 0.0],
            spatial_profile: FieldSpatialProfileIR::Uniform {},
            waveform: TimeDependenceIR::Constant,
            time_origin: FieldTimeOriginIR::StageLocal,
            activation: DriveActivationIR::AllTimeEvolution {},
            migration: None,
        };
        let h = 1e-3 / crate::MU0;
        let plan = FdmPlanIR {
            enable_exchange: false,
            regional_field_drive_bases: vec![ResolvedRegionalFieldDriveBasisIR {
                drive: drive.clone(),
                field_xyz: vec![[0.0, h, 0.0]; 16],
                projection_signature: "test".into(),
            }],
            time_stage: Default::default(),
            field_drives: vec![drive],
            ..make_test_plan()
        };
        let outputs = [
            OutputIR::Field {
                name: "H_drive".into(),
                every_seconds: 1e-14,
            },
            OutputIR::Scalar {
                name: "E_drive".into(),
                every_seconds: 1e-14,
            },
        ];

        let executed = execute_reference_fdm(&plan, 1e-14, &outputs, None, None)
            .expect("regional drive reference run should succeed");
        let field = executed
            .field_snapshots
            .iter()
            .find(|snapshot| snapshot.name == "H_drive")
            .expect("H_drive snapshot");
        assert_eq!(field.component_count, 3);
        assert!(field
            .values
            .chunks_exact(3)
            .all(|value| { value[0] == 0.0 && value[1] == h && value[2] == 0.0 }));
        assert!(executed.result.steps.iter().any(|step| step.e_drive != 0.0));
        assert!(executed.result.steps.iter().all(|step| step.e_ext == 0.0));
    }

    #[test]
    fn regional_drive_stage_local_restart_and_absolute_clock_are_distinct() {
        let mut plan = make_test_plan();
        plan.time_stage.start_time_s = 10.0;
        let make_basis = |time_origin, waveform| ResolvedRegionalFieldDriveBasisIR {
            drive: RegionalFieldDriveIR {
                id: "clock".into(),
                name: "Clock".into(),
                kind: FieldDriveKindIR::Regional,
                enabled: true,
                target: FieldTargetIR::Global {},
                amplitude_b_t: 1e-3,
                direction: [0.0, 1.0, 0.0],
                spatial_profile: FieldSpatialProfileIR::Uniform {},
                waveform,
                time_origin,
                activation: DriveActivationIR::AllTimeEvolution {},
                migration: None,
            },
            field_xyz: vec![[0.0, 1.0, 0.0]; 16],
            projection_signature: "clock".into(),
        };
        plan.regional_field_drive_bases = vec![make_basis(
            FieldTimeOriginIR::StageLocal,
            TimeDependenceIR::Pulse {
                t_on: 1.0,
                t_off: 2.0,
            },
        )];
        let local = resolved_regional_field_drives(&plan, plan.time_stage.start_time_s);
        assert_eq!(local[0].multiplier_at(11.5), 1.0);
        assert_eq!(local[0].multiplier_at(10.5), 0.0);

        plan.regional_field_drive_bases = vec![make_basis(
            FieldTimeOriginIR::Absolute,
            TimeDependenceIR::Pulse {
                t_on: 11.0,
                t_off: 12.0,
            },
        )];
        let absolute = resolved_regional_field_drives(&plan, plan.time_stage.start_time_s);
        assert_eq!(absolute[0].multiplier_at(11.5), 1.0);
        assert_eq!(absolute[0].multiplier_at(1.5), 0.0);
    }

    fn cpu_fft_env_lock() -> std::sync::MutexGuard<'static, ()> {
        static LOCK: std::sync::OnceLock<std::sync::Mutex<()>> = std::sync::OnceLock::new();
        LOCK.get_or_init(|| std::sync::Mutex::new(()))
            .lock()
            .expect("CPU FFT backend env lock should not be poisoned")
    }

    fn direct_minimizer_test_control() -> RelaxationControlIR {
        RelaxationControlIR {
            algorithm: RelaxationAlgorithmIR::ProjectedGradientBb,
            stop: RelaxStopIR {
                torque_tolerance_apm: Some(1.0e-3),
                energy_tolerance_j: None,
                max_steps: Some(10),
                max_relaxation_time_s: Some(1.0e-6),
            },
        }
    }

    #[test]
    fn direct_minimizer_completion_reports_torque_convergence() {
        let completion = infer_direct_minimizer_completion(
            &direct_minimizer_test_control(),
            true,
            2,
            false,
            false,
            None,
            5.0e-4,
        );

        assert_eq!(completion.reason, Some(StageStopReason::Torque));
        assert_eq!(completion.metric_name.as_deref(), Some("max_torque_apm"));
        assert_eq!(completion.metric_value, Some(5.0e-4));
        assert_eq!(completion.threshold, Some(1.0e-3));
    }

    #[test]
    fn direct_minimizer_energy_plateau_does_not_replace_torque_convergence() {
        let control = RelaxationControlIR {
            stop: RelaxStopIR {
                torque_tolerance_apm: None,
                energy_tolerance_j: Some(1.0e-18),
                max_steps: Some(10),
                max_relaxation_time_s: None,
            },
            ..direct_minimizer_test_control()
        };
        let completion =
            infer_direct_minimizer_completion(&control, true, 8, false, false, Some(5.0e-19), 2.0);

        assert_eq!(completion.status, "completed");
        assert!(!completion.converged);
        assert_eq!(completion.reason, None);
        assert_eq!(completion.metric_name, None);
        assert_eq!(completion.metric_value, None);
        assert_eq!(completion.threshold, None);
    }

    #[test]
    fn direct_minimizer_completion_reports_gradient_when_torque_threshold_is_not_met() {
        let completion = infer_direct_minimizer_completion(
            &direct_minimizer_test_control(),
            false,
            2,
            true,
            false,
            None,
            2.0,
        );

        assert_eq!(completion.status, "failed");
        assert!(!completion.converged);
        assert_eq!(completion.reason, Some(StageStopReason::Gradient));
        assert_eq!(
            completion.metric_name.as_deref(),
            Some("numerical_stagnation")
        );
        assert_eq!(completion.metric_value, Some(1.0));
        assert_eq!(completion.threshold, Some(0.0));
    }

    #[test]
    fn direct_minimizer_completion_reports_max_steps() {
        let completion = infer_direct_minimizer_completion(
            &direct_minimizer_test_control(),
            false,
            10,
            false,
            false,
            None,
            2.0,
        );

        assert_eq!(completion.reason, Some(StageStopReason::MaxSteps));
        assert_eq!(completion.metric_name.as_deref(), Some("steps"));
        assert_eq!(completion.metric_value, Some(10.0));
        assert_eq!(completion.threshold, Some(10.0));
    }

    #[test]
    fn direct_minimizer_completion_reports_failed_descent() {
        let completion = infer_direct_minimizer_completion(
            &direct_minimizer_test_control(),
            false,
            0,
            false,
            false,
            None,
            2.0,
        );

        assert_eq!(completion.status, "failed");
        assert!(!completion.converged);
        assert_eq!(completion.reason, Some(StageStopReason::BackendError));
        assert_eq!(completion.metric_name, None);
    }

    #[test]
    fn direct_minimizer_nonfinite_gradient_reports_backend_error() {
        let completion = infer_direct_minimizer_completion(
            &direct_minimizer_test_control(),
            false,
            0,
            false,
            true,
            None,
            f64::NAN,
        );

        assert_eq!(completion.status, "failed");
        assert!(!completion.converged);
        assert_eq!(completion.reason, Some(StageStopReason::BackendError));
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
            integrator: Some(IntegratorChoice::Rk23),
            fixed_timestep: Some(1e-15),
            adaptive_timestep: None,
            field_refresh: None,
            relaxation: Some(RelaxationControlIR {
                algorithm: RelaxationAlgorithmIR::LlgOverdamped,
                stop: fullmag_ir::RelaxStopIR {
                    torque_tolerance_apm: Some(1e-6),
                    energy_tolerance_j: None,
                    max_steps: Some(10),
                    max_relaxation_time_s: None,
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
    fn snapshot_vector_fields_exposes_resolved_fdm_material_scalars() {
        reset_observe_state_calls();

        let plan = FdmPlanIR {
            material: FdmMaterialIR {
                ms_field: Some(vec![
                    8.0e5, 7.0e5, 6.0e5, 5.0e5, 4.0e5, 3.0e5, 2.0e5, 1.0e5, 8.1e5, 7.1e5, 6.1e5,
                    5.1e5, 4.1e5, 3.1e5, 2.1e5, 1.1e5,
                ]),
                a_field: Some(vec![
                    1.0e-11, 1.1e-11, 1.2e-11, 1.3e-11, 1.4e-11, 1.5e-11, 1.6e-11, 1.7e-11,
                    1.8e-11, 1.9e-11, 2.0e-11, 2.1e-11, 2.2e-11, 2.3e-11, 2.4e-11, 2.5e-11,
                ]),
                alpha_field: Some(vec![
                    0.01, 0.02, 0.03, 0.04, 0.05, 0.06, 0.07, 0.08, 0.09, 0.10, 0.11, 0.12, 0.13,
                    0.14, 0.15, 0.16,
                ]),
                ..make_test_plan().material
            },
            ..make_test_plan()
        };

        let fields = snapshot_vector_fields(
            &plan,
            &["mat_ms", "mat_aex", "mat_alpha"],
            &LivePreviewRequest {
                auto_scale_enabled: false,
                ..Default::default()
            },
        )
        .expect("material scalar previews should build");

        assert_eq!(
            fields
                .iter()
                .map(|field| field.quantity.as_str())
                .collect::<Vec<_>>(),
            vec!["mat_ms", "mat_aex", "mat_alpha"]
        );
        assert_eq!(
            fields[0].vector_field_values,
            plan.material.ms_field.as_ref().expect("ms field").clone()
        );
        assert_eq!(
            fields[1].vector_field_values,
            plan.material.a_field.as_ref().expect("a field").clone()
        );
        assert_eq!(
            fields[2].vector_field_values,
            plan.material
                .alpha_field
                .as_ref()
                .expect("alpha field")
                .clone()
        );
        assert_eq!(
            observe_state_call_count(),
            0,
            "material scalar previews should not force a full observables pass"
        );
    }

    #[test]
    fn snapshot_h_demag_keeps_stray_field_in_inactive_fdm_cells() {
        let mut plan = make_test_plan();
        plan.enable_demag = true;
        plan.enable_exchange = false;
        plan.active_mask = Some(
            std::iter::once(true)
                .chain(std::iter::repeat_n(false, 15))
                .collect(),
        );
        plan.initial_magnetization = std::iter::once([1.0, 0.0, 0.0])
            .chain(std::iter::repeat_n([0.0, 0.0, 0.0], 15))
            .collect();

        let fields = snapshot_vector_fields(
            &plan,
            &["H_demag"],
            &LivePreviewRequest {
                auto_scale_enabled: false,
                ..Default::default()
            },
        )
        .expect("H_demag preview should build");
        let field = fields.first().expect("H_demag preview should be present");

        assert_eq!(field.quantity, "H_demag");
        assert_eq!(field.active_mask, plan.active_mask);
        assert!(
            field.vector_field_values[3..6]
                .iter()
                .any(|component| component.abs() > 0.0),
            "inactive FDM cells should retain H_demag for airbox vectors"
        );
    }

    #[test]
    fn snapshot_h_ext_keeps_zeeman_field_in_inactive_fdm_cells() {
        let mut plan = make_test_plan();
        plan.enable_demag = false;
        plan.enable_exchange = false;
        plan.external_field = Some([2.0, -3.0, 4.0]);
        plan.active_mask = Some(
            std::iter::once(true)
                .chain(std::iter::repeat_n(false, 15))
                .collect(),
        );

        let fields = snapshot_vector_fields(
            &plan,
            &["H_ext"],
            &LivePreviewRequest {
                auto_scale_enabled: false,
                ..Default::default()
            },
        )
        .expect("H_ext preview should build");
        let field = fields.first().expect("H_ext preview should be present");

        assert_eq!(field.quantity, "H_ext");
        assert_eq!(&field.vector_field_values[3..6], &[2.0, -3.0, 4.0]);
    }

    #[test]
    fn snapshot_h_eff_composes_full_domain_demag_and_zeeman_in_inactive_cells() {
        let mut plan = make_test_plan();
        plan.enable_demag = true;
        plan.enable_exchange = false;
        plan.external_field = Some([2.0, -3.0, 4.0]);
        plan.active_mask = Some(
            std::iter::once(true)
                .chain(std::iter::repeat_n(false, 15))
                .collect(),
        );
        plan.initial_magnetization = std::iter::once([1.0, 0.0, 0.0])
            .chain(std::iter::repeat_n([0.0, 0.0, 0.0], 15))
            .collect();

        let fields = snapshot_vector_fields(
            &plan,
            &["H_demag", "H_eff"],
            &LivePreviewRequest {
                auto_scale_enabled: false,
                ..Default::default()
            },
        )
        .expect("full-domain field previews should build");
        let demag = fields
            .iter()
            .find(|field| field.quantity == "H_demag")
            .expect("H_demag preview should be present");
        let effective = fields
            .iter()
            .find(|field| field.quantity == "H_eff")
            .expect("H_eff preview should be present");

        for component in 0..3 {
            assert_eq!(
                effective.vector_field_values[3 + component],
                demag.vector_field_values[3 + component] + [2.0, -3.0, 4.0][component],
            );
        }
    }

    #[test]
    fn snapshot_vector_fields_materializes_energy_density_quantities_for_frontend() {
        let plan = FdmPlanIR {
            enable_demag: true,
            interfacial_dmi: Some(1.0e-3),
            external_field: Some([0.0, 0.0, 1.0]),
            material: fullmag_ir::FdmMaterialIR {
                uniaxial_anisotropy_ku1: Some(1.0e5),
                ..make_test_plan().material
            },
            ..make_test_plan()
        };
        let quantities = crate::quantities::field_materialization_quantity_ids();
        let active = crate::quantities::active_fdm_preview_quantities(
            crate::dispatch::FdmEngine::CpuReference,
            &plan,
            &quantities,
        );
        assert_eq!(
            active,
            vec![
                "m",
                "H_ex",
                "H_demag",
                "H_ext",
                "H_eff",
                "torque",
                "H_ani",
                "H_dmi",
                "eden_ex",
                "eden_demag",
                "eden_ext",
                "eden_ani",
                "eden_dmi",
                "eden_total",
                "mat_ms",
                "mat_aex",
                "mat_alpha",
            ]
        );

        let fields = snapshot_vector_fields(
            &plan,
            &active,
            &LivePreviewRequest {
                auto_scale_enabled: false,
                ..Default::default()
            },
        )
        .expect("field materialization should build frontend payloads");
        let field_ids = fields
            .iter()
            .map(|field| field.quantity.as_str())
            .collect::<Vec<_>>();
        assert_eq!(field_ids, active);

        for id in [
            "eden_ex",
            "eden_demag",
            "eden_ext",
            "eden_ani",
            "eden_dmi",
            "eden_total",
        ] {
            assert!(
                field_ids.contains(&id),
                "{id} should be returned by explicit field materialization"
            );
            let field = fields
                .iter()
                .find(|field| field.quantity == id)
                .expect("checked field id should exist");
            assert_eq!(field.unit, "J/m³");
            assert_eq!(field.vector_field_values.len(), 16);
        }
        assert!(!field_ids.contains(&"E_total"));
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
            None,
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
        assert_eq!(stats.max_rhs_norm_per_s, report.max_rhs_amplitude);
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
            if update.magnetization.is_some() {
                return StepAction::Continue;
            }
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
            if update.magnetization.is_some() {
                assert!(update.cached_preview_fields.is_some());
                return StepAction::Continue;
            }
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
        let mut terminal_cache_updates = 0usize;
        let mut on_step = |update: StepUpdate| -> StepAction {
            if let Some(values) = update.magnetization.as_ref() {
                magnetization_updates += 1;
                assert_eq!(values.len(), plan.initial_magnetization.len() * 3);
            }
            assert!(update.preview_field.is_none());
            if update.cached_preview_fields.is_some() {
                terminal_cache_updates += 1;
                assert!(update.magnetization.is_some());
            }
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
        assert_eq!(
            terminal_cache_updates, 1,
            "only the terminal live update should materialize cached vector fields"
        );
        let observe_calls = observe_state_call_count();
        assert!(
            observe_calls <= 2,
            "live magnetization payload should read state directly between refreshes and observe only for final outputs and the terminal cache; observe_state calls: {observe_calls}"
        );
    }

    #[test]
    fn direct_minimizer_terminal_update_contains_final_state_and_cached_fields() {
        let plan = FdmPlanIR {
            enable_demag: true,
            initial_magnetization: vec![[1.0, 0.1, 0.0]; 16],
            relaxation: Some(direct_minimizer_test_control()),
            ..make_test_plan()
        };
        let display_selection = || {
            let mut state = crate::DisplaySelectionState::default();
            state.selection.quantity = "m".to_string();
            state.selection.every_n = 1;
            state
        };
        let mut terminal_update = None;
        let mut on_step = |update: StepUpdate| -> StepAction {
            if update.magnetization.is_some() {
                terminal_update = Some(update);
            }
            StepAction::Continue
        };

        execute_reference_fdm(
            &plan,
            1e-12,
            &[],
            Some(LiveStepConsumer {
                grid: plan.grid.cells,
                field_every_n: 1,
                initial_snapshot: false,
                display_selection: Some(&display_selection),
                interrupt_requested: None,
                on_step: &mut on_step,
            }),
            None,
        )
        .expect("direct minimizer should emit a terminal live update");

        let update = terminal_update.expect("terminal update should carry final magnetization");
        assert_eq!(
            update.magnetization.as_ref().map(Vec::len),
            Some(plan.initial_magnetization.len() * 3)
        );
        let cached_quantities = update
            .cached_preview_fields
            .as_ref()
            .expect("terminal update should materialize cached vector fields")
            .iter()
            .map(|field| field.quantity.as_str())
            .collect::<Vec<_>>();
        assert!(cached_quantities.contains(&"H_demag"));
        assert!(cached_quantities.contains(&"H_eff"));
        for field in update.cached_preview_fields.as_ref().unwrap() {
            assert_eq!(field.preview_grid, plan.grid.cells);
            assert_eq!(field.original_grid, plan.grid.cells);
            assert_eq!(
                field.vector_field_values.len(),
                plan.initial_magnetization.len() * 3
            );
            assert!(!field.auto_downscaled);
        }
    }

    #[test]
    fn llg_terminal_update_contains_final_state_and_cached_fields() {
        let plan = FdmPlanIR {
            enable_demag: true,
            external_field: Some([0.0, 0.0, 1.0]),
            ..make_test_plan()
        };
        let display_selection = || {
            let mut state = crate::DisplaySelectionState::default();
            state.selection.quantity = "m".to_string();
            state.selection.every_n = 1;
            state
        };
        let mut terminal_update = None;
        let mut on_step = |update: StepUpdate| -> StepAction {
            if update.cached_preview_fields.is_some() {
                terminal_update = Some(update);
            }
            StepAction::Continue
        };

        execute_reference_fdm(
            &plan,
            2e-14,
            &[],
            Some(LiveStepConsumer {
                grid: plan.grid.cells,
                field_every_n: 1,
                initial_snapshot: false,
                display_selection: Some(&display_selection),
                interrupt_requested: None,
                on_step: &mut on_step,
            }),
            None,
        )
        .expect("LLG should emit a terminal live update");

        let update = terminal_update.expect("terminal update should materialize cached fields");
        assert!(update.magnetization.is_some());
        let cached_quantities = update
            .cached_preview_fields
            .as_ref()
            .expect("terminal update should materialize cached vector fields")
            .iter()
            .map(|field| field.quantity.as_str())
            .collect::<Vec<_>>();
        assert!(cached_quantities.contains(&"H_demag"));
        assert!(cached_quantities.contains(&"H_eff"));
        assert!(cached_quantities.contains(&"H_ext"));
        for quantity in ["eden_ex", "eden_demag", "eden_ext", "eden_total"] {
            let field = update
                .cached_preview_fields
                .as_ref()
                .unwrap()
                .iter()
                .find(|field| field.quantity == quantity)
                .unwrap_or_else(|| panic!("terminal cache must contain {quantity}"));
            assert_eq!(field.unit, "J/m³");
            assert_eq!(
                field.vector_field_values.len(),
                plan.initial_magnetization.len()
            );
        }
        for field in update.cached_preview_fields.as_ref().unwrap() {
            assert_eq!(field.source_step, update.stats.step);
            assert_eq!(field.source_time_seconds, Some(update.stats.time));
            assert_eq!(field.source_revision, update.stats.step);
            assert!(field.materialized_at_unix_ms > 0);
        }
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
            None,
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
        assert_eq!(
            field_snapshots[0].vec3_values().unwrap(),
            state.magnetization()
        );
        assert_eq!(
            field_snapshots[1].vec3_values().unwrap(),
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
            None,
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
            field_snapshots[0].vec3_values().unwrap(),
            vec![[2.0, 3.0, 4.0], [2.0, 3.0, 4.0]]
        );
        assert_eq!(field_snapshots[1].name, "H_ext.y");
        assert_eq!(
            field_snapshots[1].vec3_values().unwrap(),
            vec![[3.0, 0.0, 0.0], [3.0, 0.0, 0.0]]
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
            None,
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
            field_snapshots[0].vec3_values().unwrap(),
            vec![[0.0, 0.0, 2.0], [1.0, 0.5, 0.25]]
        );
        assert_eq!(field_snapshots[1].name, "H_OE.z");
        assert_eq!(
            field_snapshots[1].vec3_values().unwrap(),
            vec![[2.0, 0.0, 0.0], [0.25, 0.0, 0.0]]
        );
    }

    #[test]
    fn dynamic_oersted_cylinder_is_materialized_at_the_committed_state_time() {
        let problem = ExchangeLlgProblem::with_terms(
            GridShape::new(1, 1, 1).expect("valid grid"),
            CellSize::new(1.0, 1.0, 1.0).expect("valid cell size"),
            MaterialParameters::new(1.0, 1.0e-30, 0.1).expect("valid material"),
            LlgConfig::new(1.0, TimeIntegrator::Heun).expect("valid dynamics"),
            EffectiveFieldTerms {
                exchange: false,
                demag: false,
                oersted_cylinder: Some(OerstedCylinderConfig {
                    current: 2.0,
                    radius: 0.25,
                    center: [0.0, 0.5, 0.5],
                    axis: [0.0, 0.0, 1.0],
                    time_dep_kind: 2,
                    time_dep_freq: 0.0,
                    time_dep_phase: 0.0,
                    time_dep_offset: 0.0,
                    time_dep_t_on: 1.0e-12,
                    time_dep_t_off: 3.0e-12,
                }),
                ..Default::default()
            },
        );
        let mut state = problem
            .new_state(vec![[1.0, 0.0, 0.0]])
            .expect("state should build");
        state.time_seconds = 2.0e-12;

        let observables = observe_state(&problem, &state).expect("observables should build");
        let expected = 2.0 / std::f64::consts::PI;
        assert!((observables.oersted_field[0][1] - expected).abs() <= 1.0e-12);
        assert!((observables.effective_field[0][1] - expected).abs() <= 1.0e-12);

        state.time_seconds = 0.0;
        let inactive = observe_state(&problem, &state).expect("inactive observables should build");
        assert_eq!(inactive.oersted_field[0], [0.0, 0.0, 0.0]);
        assert_eq!(inactive.effective_field[0], [0.0, 0.0, 0.0]);
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
            None,
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
        assert_eq!(field_snapshots[0].vec3_values().unwrap(), expected_exchange);
        assert_eq!(field_snapshots[1].name, "H_ex.y");
        assert_eq!(
            field_snapshots[1].vec3_values().unwrap(),
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
            None,
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
        assert_eq!(field_snapshots[0].vec3_values().unwrap(), expected_demag);
        assert_eq!(field_snapshots[1].name, "H_demag.x");
        assert_eq!(
            field_snapshots[1].vec3_values().unwrap(),
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
            None,
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
        assert_eq!(field_snapshots[0].vec3_values().unwrap(), expected_dmi);
        assert_eq!(field_snapshots[1].name, "H_dmi.x");
        assert_eq!(
            field_snapshots[1].vec3_values().unwrap(),
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
            None,
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
        assert_eq!(
            field_snapshots[0].vec3_values().unwrap(),
            expected_anisotropy
        );
        assert_eq!(field_snapshots[1].name, "H_ani.z");
        assert_eq!(
            field_snapshots[1].vec3_values().unwrap(),
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
        assert_eq!(
            expected_effective,
            problem
                .effective_field(&state)
                .expect("public effective field should assemble"),
            "public H_eff and observable H_eff must use the same committed-time Oersted field"
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
            None,
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
        assert_eq!(
            field_snapshots[0].vec3_values().unwrap(),
            expected_effective
        );
        assert_eq!(field_snapshots[1].name, "H_eff.y");
        assert_eq!(
            field_snapshots[1].vec3_values().unwrap(),
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
            None,
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
        assert_eq!(field_snapshots[0].vec3_values().unwrap(), expected_torque);
        assert_eq!(field_snapshots[1].name, "torque.z");
        assert_eq!(
            field_snapshots[1].vec3_values().unwrap(),
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
            None,
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
        assert_eq!(
            field_snapshots[0].vec3_values().unwrap(),
            observables.effective_field
        );
        assert_eq!(field_snapshots[1].name, "H_eff.y");
        assert_eq!(
            field_snapshots[1].vec3_values().unwrap(),
            observables
                .effective_field
                .iter()
                .map(|value| [value[1], 0.0, 0.0])
                .collect::<Vec<_>>()
        );
        assert_eq!(field_snapshots[2].name, "torque");
        assert_eq!(field_snapshots[2].vec3_values().unwrap(), expected_torque);
        assert_eq!(field_snapshots[3].name, "torque.z");
        assert_eq!(
            field_snapshots[3].vec3_values().unwrap(),
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
            None,
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
            field_snapshots[0].vec3_values().unwrap(),
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
            None,
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
        assert_eq!(
            top.formula,
            fullmag_engine::SlonczewskiFormula::LegacyFullmagV0
        );
        assert_eq!(
            bottom.formula,
            fullmag_engine::SlonczewskiFormula::LegacyFullmagV0
        );
    }

    #[test]
    fn canonical_slonczewski_uses_signed_stack_normal_projection_and_target_mask() {
        let mut plan = make_test_plan();
        plan.current_density = Some([3.0e10, 4.0e10, 0.0]);
        plan.stt_degree = Some(0.55);
        plan.stt_spin_polarization = Some([0.0, 0.0, 1.0]);
        plan.stt_lambda = Some(1.4);
        plan.stt_epsilon_prime = Some(0.0);
        plan.slonczewski_formula_version = Some("slonczewski.fullmag.v2".to_string());
        plan.slonczewski_stack_normal = Some([0.0, 2.0, 0.0]);
        plan.slonczewski_active_mask = Some(vec![true; plan.initial_magnetization.len()]);

        let forward = build_slon_stt(&plan, plan.cell_size[2])
            .expect("canonical Slonczewski config should build");
        let mut reversed_plan = plan.clone();
        reversed_plan.current_density = Some([-3.0e10, -4.0e10, 0.0]);
        let reversed = build_slon_stt(&reversed_plan, reversed_plan.cell_size[2])
            .expect("reversed canonical Slonczewski config should build");

        assert_eq!(forward.current_density_magnitude, 4.0e10);
        assert_eq!(reversed.current_density_magnitude, 4.0e10);
        assert_eq!(forward.current_sign, 1.0);
        assert_eq!(reversed.current_sign, -1.0);
        assert_eq!(
            forward.formula,
            fullmag_engine::SlonczewskiFormula::FullmagV2
        );
        assert_eq!(
            reversed.formula,
            fullmag_engine::SlonczewskiFormula::FullmagV2
        );
        assert_eq!(forward.active_mask, plan.slonczewski_active_mask);
    }

    #[test]
    fn prescribed_sot_builder_preserves_formula_mask_and_constant_envelope() {
        let mut plan = make_test_plan();
        plan.sot_formula_version = Some("prescribed_sot.fullmag.v1".to_string());
        plan.sot_current_density = Some(-4.0e11);
        plan.sot_xi_dl = Some(0.12);
        plan.sot_xi_fl = Some(-0.03);
        plan.sot_sigma = Some([0.0, 1.0, 0.0]);
        plan.sot_thickness = Some(1.5e-9);
        plan.sot_active_mask = Some(vec![true; plan.initial_magnetization.len()]);
        plan.sot_envelope = Some(fullmag_ir::TimeEnvelopeIR::Constant { value: 0.25 });

        let config = build_sot(&plan).expect("complete SOT plan must build");
        assert_eq!(config.formula, SotFormula::FullmagV1);
        assert_eq!(config.current_density, -4.0e11);
        assert_eq!(config.active_mask, plan.sot_active_mask);
        assert_eq!(config.envelope, plan.sot_envelope);
    }

    #[test]
    fn helper_max_vector_norm_handles_empty_input() {
        assert_eq!(crate::derived_fields::max_vector_norm(&[]), 0.0);
    }

    #[test]
    fn active_mask_keeps_inactive_m_zero_and_preserves_full_domain_fields() {
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

        let magnetization_snapshots = executed
            .field_snapshots
            .iter()
            .filter(|snapshot| snapshot.name == "m")
            .collect::<Vec<_>>();
        assert!(!magnetization_snapshots.is_empty());
        for snapshot in magnetization_snapshots {
            for (index, is_active) in active_mask.iter().enumerate() {
                if !is_active {
                    assert!(
                        is_zero(snapshot.vec3_values().unwrap()[index]),
                        "inactive cell {index} should stay zero in snapshot '{}'",
                        snapshot.name
                    );
                }
            }
        }

        let demag_snapshots = executed
            .field_snapshots
            .iter()
            .filter(|snapshot| snapshot.name == "H_demag")
            .collect::<Vec<_>>();
        assert!(!demag_snapshots.is_empty());
        assert!(demag_snapshots.iter().any(|snapshot| {
            snapshot
                .vec3_values()
                .unwrap()
                .iter()
                .zip(&active_mask)
                .any(|(value, is_active)| !is_active && !is_zero(*value))
        }));

        let external_field_snapshots = executed
            .field_snapshots
            .iter()
            .filter(|snapshot| snapshot.name == "H_ext")
            .collect::<Vec<_>>();
        assert!(!external_field_snapshots.is_empty());
        for snapshot in external_field_snapshots {
            for (value, is_active) in snapshot.vec3_values().unwrap().iter().zip(&active_mask) {
                if !is_active {
                    assert_eq!(*value, [1e5, 0.0, 0.0]);
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
                    max_relaxation_time_s: None,
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
                    max_relaxation_time_s: None,
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
            fixed_timestep: None,
            adaptive_timestep: None,
            relaxation: Some(RelaxationControlIR {
                algorithm: RelaxationAlgorithmIR::ProjectedGradientBb,
                stop: fullmag_ir::RelaxStopIR {
                    torque_tolerance_apm: Some(1e-6),
                    energy_tolerance_j: None,
                    max_steps: Some(1000),
                    max_relaxation_time_s: None,
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
        assert_eq!(executed.provenance.timestep_policy, None);
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
                    max_relaxation_time_s: None,
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
                    max_relaxation_time_s: None,
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
                    max_relaxation_time_s: None,
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
                        max_relaxation_time_s: None,
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
