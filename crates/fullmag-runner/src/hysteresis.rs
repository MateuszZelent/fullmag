#![allow(non_snake_case)]
use crate::dispatch;
use crate::fem;
use crate::types::{
    ExecutedRun, LiveStepConsumer, RunError, RunResult, RunStatus, StepAction, StepStats,
    StepUpdate,
};
use fullmag_ir::{
    AdaptiveRefinementIR, BackendPlanIR, ExecutionPlanIR, FieldOrientationIR, FieldScheduleIR,
    FieldWindowIR, HysteresisAngularFamilyIR, MeasurementAxisIR, ProblemIR, RelaxStopIR,
    RelaxationAlgorithmIR, RelaxationControlIR, SettlePipelineIR, SettleStepIR, StageStopReason,
    StudyIR,
};
use serde::{Deserialize, Serialize};
use std::collections::BTreeMap;
use std::fs;
use std::io::{BufRead, BufReader, BufWriter, Read, Write};
use std::path::Path;

const HYSTERESIS_SETTLE_STEP_DT_SECONDS: f64 = 1.0e-13;
const MU0_H_PER_M: f64 = 1.256_637_061_435_917_2e-6;
const HYSTERESIS_ZARR_STORE: &str = "hysteresis.zarr";
const HYSTERESIS_ZARR_M_FIELD: &str = "fields/m";

#[derive(Debug, Clone, Serialize, Deserialize)]
pub struct HysteresisPoint {
    pub point_id: usize,
    pub field_value_mT: f64,
    pub m_parallel: f64,
    pub m_oop: f64,
    pub m_ip: f64,
    pub m_avg: [f64; 3],
    pub status: String,
    pub run_status: String,
    pub settle_status: String,
    pub has_non_converged_steps: bool,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub terminal_settle_reason: Option<String>,
    pub warning_count: u32,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub snapshot_id: Option<String>,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub protocol_role: Option<String>,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub branch_id: Option<String>,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub branch_ids: Option<Vec<String>>,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub branch_index: Option<u32>,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub parent_branch_id: Option<String>,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub minor_loop_id: Option<String>,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub snapshot_resource_ref: Option<String>,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub snapshot_vector_resource_ref: Option<String>,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub snapshot_json_artifact_ref: Option<String>,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub snapshot_zarr_store_ref: Option<String>,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub snapshot_storage_format: Option<String>,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub field_vector_A_per_m: Option<[f64; 3]>,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub field_orientation: Option<serde_json::Value>,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub measurement_axis: Option<serde_json::Value>,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub field_display_unit: Option<String>,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub is_reversal_field: Option<bool>,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub reversal_index: Option<u32>,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub recoil_start_point_id: Option<usize>,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub adaptive_inserted: Option<bool>,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub refinement_reason: Option<Vec<String>>,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub refinement_parent_left_point_id: Option<usize>,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub refinement_parent_right_point_id: Option<usize>,
}

#[derive(Debug, Clone, PartialEq, Eq)]
struct HysteresisPointQuality {
    run_status: String,
    settle_status: String,
    has_non_converged_steps: bool,
    terminal_settle_reason: Option<String>,
    warning_count: u32,
}

#[derive(Debug, Clone, Serialize, Deserialize)]
pub struct HysteresisAdaptiveRefinementArtifact {
    pub kind: String,
    pub status: String,
    pub enabled: bool,
    pub source_point_count: usize,
    pub max_passes: u32,
    pub max_insertions_per_pass: u32,
    pub candidates: Vec<HysteresisAdaptiveRefinementCandidate>,
    #[serde(default, skip_serializing_if = "Vec::is_empty")]
    pub points: Vec<HysteresisPoint>,
    #[serde(default, skip_serializing_if = "Vec::is_empty")]
    pub settle_trace: Vec<HysteresisSettleTraceEntry>,
}

#[derive(Debug, Clone, Serialize, Deserialize)]
pub struct HysteresisAdaptiveRefinementCandidate {
    pub candidate_id: String,
    pub pass_index: u32,
    pub field_value_mT: f64,
    pub parent_left_point_id: usize,
    pub parent_right_point_id: usize,
    pub parent_left_field_mT: f64,
    pub parent_right_field_mT: f64,
    pub dm_dh_per_mT: f64,
    pub reasons: Vec<String>,
    pub status: String,
}

#[derive(Debug, Clone, Serialize, Deserialize)]
pub struct HysteresisAngularFamilyArtifact {
    pub kind: String,
    pub family_id: String,
    pub label: String,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub active_variant_id: Option<String>,
    pub variants: Vec<HysteresisAngularFamilyVariantArtifact>,
}

#[derive(Debug, Clone, Serialize, Deserialize)]
pub struct HysteresisAngularFamilyVariantArtifact {
    pub variant_id: String,
    pub label: String,
    pub orientation: serde_json::Value,
    pub measurement_axis: serde_json::Value,
    pub data_status: String,
    pub point_count: usize,
    pub points_resource_ref: String,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub points_path: Option<String>,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub metrics_path: Option<String>,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub settle_trace_path: Option<String>,
}

#[derive(Debug, Clone, Serialize, Deserialize)]
pub struct HysteresisMetrics {
    pub H_c_plus: Option<f64>,
    pub H_c_minus: Option<f64>,
    pub H_c: Option<f64>,
    pub H_eb: Option<f64>,
    pub M_r_plus: Option<f64>,
    pub M_r_minus: Option<f64>,
    pub loop_area: f64,
    pub magnetization_average_weighting: String,
    pub saturation_status: String,
    pub saturation_preparation_field_mT: Option<f64>,
    #[serde(default, skip_serializing_if = "BTreeMap::is_empty")]
    pub metric_statuses: BTreeMap<String, HysteresisMetricStatus>,
    pub loop_closure_summary: HysteresisLoopClosureSummary,
    pub max_differential_susceptibility: Option<f64>,
    #[serde(default, skip_serializing_if = "Vec::is_empty")]
    pub switching_field_candidates: Vec<HysteresisSwitchingFieldCandidate>,
    #[serde(default, skip_serializing_if = "Vec::is_empty")]
    pub warnings: Vec<String>,
    pub convergence_quality_summary: HysteresisConvergenceQualitySummary,
}

#[derive(Debug, Clone, Serialize, Deserialize)]
pub struct HysteresisMetricStatus {
    pub status: String,
    pub reason: String,
}

#[derive(Debug, Clone, Serialize, Deserialize)]
pub struct HysteresisLoopClosureSummary {
    pub status: String,
    pub field_gap_mT: f64,
    pub m_parallel_gap: f64,
    pub reason: String,
}

#[derive(Debug, Clone, Serialize, Deserialize)]
pub struct HysteresisSwitchingFieldCandidate {
    pub field_value_mT: f64,
    pub susceptibility_per_mT: f64,
    pub point_id_before: usize,
    pub point_id_after: usize,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub branch_id: Option<String>,
}

#[derive(Debug, Clone, Serialize, Deserialize)]
pub struct HysteresisConvergenceQualitySummary {
    pub status: String,
    pub total_points: usize,
    pub converged_points: usize,
    pub warning_points: usize,
    pub non_converged_points: usize,
}

#[derive(Debug, Clone, Serialize, Deserialize)]
pub struct HysteresisSaturationProbePoint {
    pub probe_index: usize,
    pub field_value_mT: f64,
    pub m_parallel: f64,
    pub m_transverse: f64,
    pub torque: Option<f64>,
    pub status: String,
}

#[derive(Debug, Clone, Serialize, Deserialize)]
pub struct HysteresisSaturationResult {
    pub status: String,
    pub reason: String,
    pub direction: i32,
    pub max_probe_field_mT: f64,
    pub preparation_field_mT: Option<f64>,
    pub susceptibility_threshold: f64,
    pub transverse_threshold: f64,
    pub points: Vec<HysteresisSaturationProbePoint>,
}

#[derive(Debug, Clone, Serialize, Deserialize)]
pub struct HysteresisMinorLoop {
    pub loop_id: String,
    pub reversal_field_mT: f64,
    pub return_field_mT: f64,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub parent_branch_id: Option<String>,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub reversal_point_id: Option<usize>,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub return_point_id: Option<usize>,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub policy: Option<String>,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub closure_status: Option<String>,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub closure_error_m_parallel: Option<f64>,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub recoil_susceptibility: Option<f64>,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub minor_loop_area: Option<f64>,
    #[serde(default, skip_serializing_if = "Vec::is_empty")]
    pub settle_trace: Vec<HysteresisSettleTraceEntry>,
    pub points: Vec<HysteresisPoint>,
}

#[derive(Debug, Clone, Serialize, Deserialize)]
pub struct HysteresisSettleTraceEntry {
    pub point_id: usize,
    pub field_value_mT: f64,
    pub step_index: usize,
    pub algorithm_id: String,
    pub method: String,
    pub status: String,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub stop_reason: Option<String>,
    pub fallback_reason: Option<String>,
    pub retry_attempt: u32,
    pub resolved_timestep_s: Option<f64>,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub resolved_parameters: Option<serde_json::Value>,
    pub torque: Option<f64>,
    pub energy: Option<f64>,
}

#[derive(Debug, Clone)]
struct PlannedSettleStep {
    step: SettleStepIR,
    run_condition: PlannedSettleStepCondition,
    fallback_reason: Option<String>,
}

#[derive(Debug, Clone, Copy, PartialEq, Eq)]
enum PlannedSettleStepCondition {
    Always,
    OnPreviousNonConverged,
}

#[derive(Debug)]
struct SettledFieldRun {
    executed_run: ExecutedRun,
    trace: Vec<HysteresisSettleTraceEntry>,
}

#[derive(Debug)]
struct HysteresisSaturationProbeRun {
    result: HysteresisSaturationResult,
    final_magnetization: Vec<[f64; 3]>,
    steps: Vec<StepStats>,
    status: RunStatus,
}

#[derive(Debug, Clone)]
struct HysteresisMajorPointState {
    point: HysteresisPoint,
    magnetization: Vec<[f64; 3]>,
}

#[derive(Debug)]
struct HysteresisMinorLoopRun {
    loops: Vec<HysteresisMinorLoop>,
    steps: Vec<StepStats>,
    status: RunStatus,
}

#[derive(Debug)]
struct HysteresisAngularFamilyVariantRun {
    point_count: usize,
    points_path: String,
    metrics_path: String,
    settle_trace_path: String,
    status: RunStatus,
    steps: Vec<StepStats>,
}

#[derive(Debug)]
struct HysteresisAdaptiveRefinementRun {
    artifact: HysteresisAdaptiveRefinementArtifact,
    steps: Vec<StepStats>,
    status: RunStatus,
}

#[derive(Debug, Clone)]
struct HysteresisAveragingContext {
    weights: Option<Vec<f64>>,
    weighting: String,
}

#[derive(Debug, Clone, Copy)]
struct HysteresisSnapshotDecisionContext {
    point_idx: usize,
    field_value_mT: f64,
    previous_field_value_mT: Option<f64>,
    next_field_value_mT: Option<f64>,
    m_parallel: f64,
    previous_m_parallel: Option<f64>,
    status: RunStatus,
    non_converged: bool,
}

#[derive(Debug, Clone, Copy, Default)]
struct HysteresisSnapshotIndexMetadata<'a> {
    branch_id: Option<&'a str>,
    protocol_role: Option<&'a str>,
}

#[derive(Debug, Serialize)]
struct HysteresisMagnetizationSnapshot<'a> {
    quantity_id: &'static str,
    snapshot_id: &'a str,
    point_id: usize,
    field_value_mT: f64,
    layout: HysteresisSnapshotLayout,
    values: &'a [[f64; 3]],
}

#[derive(Debug, Deserialize)]
struct HysteresisMagnetizationSnapshotOwned {
    quantity_id: String,
    snapshot_id: String,
    layout: HysteresisSnapshotLayout,
    values: Vec<[f64; 3]>,
}

#[derive(Debug, Clone, Copy, Serialize, Deserialize)]
struct HysteresisSnapshotLayout {
    grid_cells: [u32; 3],
}

#[derive(Debug)]
struct HysteresisZarrSampleRef {
    chunk_key: String,
    cell_count: usize,
}

pub(crate) fn run_planned_hysteresis(
    problem: &ProblemIR,
    plan: &ExecutionPlanIR,
    until_seconds: f64,
    output_dir: &Path,
    stage_id: Option<&str>,
) -> Result<RunResult, RunError> {
    let dummy_display = || crate::interactive::DisplaySelectionState::default();
    let mut default_on_step = |_| StepAction::Continue;
    run_planned_hysteresis_with_live_preview(
        problem,
        plan,
        until_seconds,
        output_dir,
        1,
        &dummy_display,
        None,
        true,
        stage_id,
        &mut default_on_step,
    )
}

pub(crate) fn run_planned_hysteresis_with_callback(
    problem: &ProblemIR,
    plan: &ExecutionPlanIR,
    until_seconds: f64,
    output_dir: &Path,
    field_every_n: u64,
    stage_id: Option<&str>,
    on_step: &mut (dyn FnMut(StepUpdate) -> StepAction + Send),
) -> Result<RunResult, RunError> {
    let dummy_display = || crate::interactive::DisplaySelectionState::default();
    run_planned_hysteresis_with_live_preview(
        problem,
        plan,
        until_seconds,
        output_dir,
        field_every_n,
        &dummy_display,
        None,
        true,
        stage_id,
        on_step,
    )
}

pub(crate) fn run_planned_hysteresis_with_live_preview(
    problem: &ProblemIR,
    plan: &ExecutionPlanIR,
    until_seconds: f64,
    output_dir: &Path,
    field_every_n: u64,
    display_selection: &(dyn Fn() -> crate::interactive::DisplaySelectionState + Send + Sync),
    interrupt_requested: Option<&std::sync::atomic::AtomicBool>,
    initial_snapshot: bool,
    stage_id: Option<&str>,
    on_step: &mut (dyn FnMut(StepUpdate) -> StepAction + Send),
) -> Result<RunResult, RunError> {
    let (
        field_min_mT,
        field_max_mT,
        field_step_mT,
        field_values_mT,
        direction,
        orientation,
        measurement_axis,
        angular_family,
        initial_protocol,
        initial_state_ref,
        saturation,
        branch_mode,
        settle_pipeline,
        storage,
        field_schedule,
        schedule_refinements,
        adaptive_refinement,
        minor_loops,
        _sampling,
    ) = if let StudyIR::Hysteresis {
        field_min_mT,
        field_max_mT,
        field_step_mT,
        field_values_mT,
        direction,
        orientation,
        measurement_axis,
        angular_family,
        initial_protocol,
        initial_state_ref,
        saturation,
        branch_mode,
        settle_pipeline,
        storage,
        field_schedule,
        schedule_refinements,
        adaptive_refinement,
        minor_loops,
        sampling,
        ..
    } = &problem.study
    {
        (
            field_min_mT,
            field_max_mT,
            field_step_mT,
            field_values_mT,
            direction,
            orientation,
            measurement_axis,
            angular_family,
            initial_protocol,
            initial_state_ref,
            saturation,
            branch_mode,
            settle_pipeline,
            storage,
            field_schedule,
            schedule_refinements,
            adaptive_refinement,
            minor_loops,
            sampling,
        )
    } else {
        return Err(RunError {
            message: "Expected Hysteresis study stage".to_string(),
        });
    };

    let u_H = hysteresis_field_axis(orientation.as_ref(), *direction);
    let u_meas = hysteresis_measurement_axis(measurement_axis, u_H, plan)?;

    let sweep_values_mT = materialize_hysteresis_field_values(
        *field_min_mT,
        *field_max_mT,
        *field_step_mT,
        field_values_mT.as_deref(),
        field_schedule.as_ref(),
        schedule_refinements.as_deref(),
        branch_mode,
    );

    let mut current_m = match &plan.backend_plan {
        BackendPlanIR::Fdm(fdm) => fdm.initial_magnetization.clone(),
        BackendPlanIR::Fem(fem) => fem.initial_magnetization.clone(),
        _ => {
            return Err(RunError {
                message: "Unsupported backend for hysteresis sweep".to_string(),
            });
        }
    };
    if initial_protocol == "checkpoint" {
        let Some(initial_state_ref) = initial_state_ref.as_deref() else {
            return Err(RunError {
                message: "Hysteresis checkpoint start requires initial_state_ref".to_string(),
            });
        };
        current_m = load_hysteresis_checkpoint_magnetization(
            output_dir,
            initial_state_ref,
            current_m.len(),
        )?;
    }
    let family_initial_m = current_m.clone();

    let mut hysteresis_points = Vec::new();
    let needs_branch_parent_states = minor_loops.is_some()
        || adaptive_refinement
            .as_ref()
            .is_some_and(|policy| policy.enabled);
    let mut major_point_states = needs_branch_parent_states.then(Vec::new);
    let mut settle_trace = Vec::new();
    let mut steps_stats = Vec::new();
    let mut global_step_count = 0;
    let mut final_status = RunStatus::Completed;
    let mut saturation_result: Option<HysteresisSaturationResult> = None;
    let mut stop_after_saturation_probe = false;
    let mut preparation_field_mT =
        hysteresis_preparation_field_mT(initial_protocol, saturation.as_ref(), &sweep_values_mT);
    let averaging = hysteresis_averaging_context(&plan.backend_plan);

    if matches!(
        initial_protocol.as_str(),
        "positive_saturation" | "negative_saturation"
    ) && saturation.is_some()
    {
        let sign = if initial_protocol == "negative_saturation" {
            -1.0
        } else {
            1.0
        };
        let probe_run = run_hysteresis_saturation_probe(
            &plan.backend_plan,
            problem,
            &current_m,
            u_H,
            sign,
            saturation.as_ref().expect("checked saturation is present"),
            settle_pipeline.as_ref(),
            until_seconds,
            display_selection,
            interrupt_requested,
            initial_snapshot,
            on_step,
        )?;
        current_m = probe_run.final_magnetization;
        final_status = probe_run.status;
        preparation_field_mT = probe_run.result.preparation_field_mT;
        append_stage_steps(&mut steps_stats, &mut global_step_count, probe_run.steps);
        stop_after_saturation_probe = saturation_probe_should_stop_stage(
            saturation.as_ref().expect("checked saturation is present"),
            &probe_run.result,
        );
        saturation_result = Some(probe_run.result);
    } else if let Some(preparation_field_mT) = preparation_field_mT {
        let preparation_field_Apm = field_mT_to_h_apm(preparation_field_mT);
        let solve_res = run_settle_at_field(
            &plan.backend_plan,
            problem,
            &current_m,
            [
                preparation_field_Apm * u_H[0],
                preparation_field_Apm * u_H[1],
                preparation_field_Apm * u_H[2],
            ],
            Some(HysteresisProgressContext {
                point_idx: None,
                field_m_t: preparation_field_mT,
                point_role: "preparation",
                branch_id: None,
            }),
            settle_pipeline.as_ref(),
            until_seconds,
            field_every_n,
            display_selection,
            interrupt_requested,
            initial_snapshot,
            on_step,
        )?;
        final_status = solve_res.executed_run.result.status;
        append_stage_steps(
            &mut steps_stats,
            &mut global_step_count,
            solve_res.executed_run.result.steps.clone(),
        );
        current_m = solve_res.executed_run.result.final_magnetization.clone();
    }

    if !stop_after_saturation_probe {
        for (point_idx, H_mT) in sweep_values_mT.iter().copied().enumerate() {
            let H_Apm = field_mT_to_h_apm(H_mT);
            let H_ext = [H_Apm * u_H[0], H_Apm * u_H[1], H_Apm * u_H[2]];
            let field_vector_A_per_m = H_ext;
            let index_metadata =
                primary_hysteresis_snapshot_index_metadata(&sweep_values_mT, point_idx);

            let point_run = run_settle_at_field(
                &plan.backend_plan,
                problem,
                &current_m,
                H_ext,
                Some(HysteresisProgressContext {
                    point_idx: Some(point_idx),
                    field_m_t: H_mT,
                    point_role: "major",
                    branch_id: index_metadata.branch_id.map(str::to_string),
                }),
                settle_pipeline.as_ref(),
                until_seconds,
                field_every_n,
                display_selection,
                interrupt_requested,
                initial_snapshot,
                on_step,
            )?;

            current_m = point_run.executed_run.result.final_magnetization.clone();
            final_status = point_run.executed_run.result.status;
            let point_non_converged = point_run
                .trace
                .iter()
                .any(|entry| entry.status == "non_converged");
            let point_quality =
                hysteresis_point_quality(point_run.executed_run.result.status, &point_run.trace);
            settle_trace.extend(point_run.trace);

            let m_avg = average_hysteresis_magnetization(&current_m, &averaging);
            let m_parallel = hysteresis_project_m_parallel(m_avg, u_meas);
            let (m_oop, m_ip) = hysteresis_oop_ip_components(m_avg, hysteresis_sample_normal());

            let point_stats = point_run
                .executed_run
                .result
                .steps
                .last()
                .cloned()
                .unwrap_or_else(|| StepStats {
                    step: global_step_count,
                    ..StepStats::default()
                });

            append_stage_steps(
                &mut steps_stats,
                &mut global_step_count,
                point_run.executed_run.result.steps.clone(),
            );

            let snapshot_context = HysteresisSnapshotDecisionContext {
                point_idx,
                field_value_mT: H_mT,
                previous_field_value_mT: point_idx
                    .checked_sub(1)
                    .and_then(|idx| sweep_values_mT.get(idx).copied()),
                next_field_value_mT: sweep_values_mT.get(point_idx + 1).copied(),
                m_parallel,
                previous_m_parallel: hysteresis_points
                    .last()
                    .map(|point: &HysteresisPoint| point.m_parallel),
                status: point_run.executed_run.result.status,
                non_converged: point_non_converged,
            };
            let snapshot_id =
                if should_store_hysteresis_snapshot(storage.as_ref(), snapshot_context) {
                    Some(format!("hysteresis_point_{:03}", point_idx + 1))
                } else {
                    None
                };
            if let Some(snapshot_id) = snapshot_id.as_deref() {
                write_hysteresis_magnetization_snapshot(
                    output_dir,
                    snapshot_id,
                    point_idx,
                    H_mT,
                    hysteresis_magnetization_grid(plan, &current_m),
                    &current_m,
                    &averaging.weighting,
                    averaging.weights.as_deref(),
                    storage
                        .as_ref()
                        .map(|policy| policy.magnetization.as_str())
                        .unwrap_or("unspecified"),
                    index_metadata,
                )?;
            }

            let point = HysteresisPoint {
                point_id: point_idx,
                field_value_mT: H_mT,
                m_parallel,
                m_oop,
                m_ip,
                m_avg,
                status: point_quality.run_status.clone(),
                run_status: point_quality.run_status,
                settle_status: point_quality.settle_status,
                has_non_converged_steps: point_quality.has_non_converged_steps,
                terminal_settle_reason: point_quality.terminal_settle_reason,
                warning_count: point_quality.warning_count,
                snapshot_id,
                protocol_role: None,
                branch_id: None,
                branch_ids: None,
                branch_index: None,
                parent_branch_id: None,
                minor_loop_id: None,
                snapshot_resource_ref: None,
                snapshot_vector_resource_ref: None,
                snapshot_json_artifact_ref: None,
                snapshot_zarr_store_ref: None,
                snapshot_storage_format: None,
                field_vector_A_per_m: Some(field_vector_A_per_m),
                field_orientation: Some(hysteresis_point_field_orientation_value(
                    orientation.as_ref(),
                    u_H,
                )),
                measurement_axis: Some(hysteresis_point_measurement_axis_value(measurement_axis)),
                field_display_unit: Some("mT".to_string()),
                is_reversal_field: None,
                reversal_index: None,
                recoil_start_point_id: None,
                adaptive_inserted: None,
                refinement_reason: None,
                refinement_parent_left_point_id: None,
                refinement_parent_right_point_id: None,
            };
            if let Some(states) = major_point_states.as_mut() {
                states.push(HysteresisMajorPointState {
                    point: point.clone(),
                    magnetization: current_m.clone(),
                });
            }
            hysteresis_points.push(point);

            let partial_metrics = calculate_metrics_with_weighting(
                &hysteresis_points,
                initial_protocol,
                saturation.as_ref(),
                preparation_field_mT,
                &averaging.weighting,
            );
            write_hysteresis_progress_artifacts(
                output_dir,
                &hysteresis_points,
                &partial_metrics,
                &settle_trace,
                adaptive_refinement.as_ref(),
                stage_id,
            )?;

            (*on_step)(StepUpdate {
                stats: StepStats {
                    step: global_step_count,
                    mx: m_avg[0],
                    my: m_avg[1],
                    mz: m_avg[2],
                    e_total: point_stats.e_total,
                    ..point_stats
                },
                grid: hysteresis_magnetization_grid(plan, &current_m),
                fem_mesh: None,
                magnetization: Some(current_m.iter().flat_map(|v| v.iter().copied()).collect()),
                preview_field: None,
                cached_preview_fields: None,
                hysteresis_field_m_t: Some(H_mT),
                hysteresis_point_index: Some(point_idx as u32),
                hysteresis_settle_step_index: None,
                hysteresis_settle_step_kind: None,
                hysteresis_settle_step_method: None,
                scalar_row_due: true,
                finished: point_idx == sweep_values_mT.len() - 1,
            });
        }
    }

    let mut metrics = calculate_metrics_with_weighting(
        &hysteresis_points,
        initial_protocol,
        saturation.as_ref(),
        preparation_field_mT,
        &averaging.weighting,
    );
    if let Some(result) = saturation_result.as_ref() {
        metrics.saturation_status = result.status.clone();
        metrics.saturation_preparation_field_mT = result.preparation_field_mT;
    }

    annotate_hysteresis_points_for_artifact(&mut hysteresis_points, stage_id);
    if let Some(states) = major_point_states.as_mut() {
        for state in states {
            if let Some(annotated) = hysteresis_points
                .iter()
                .find(|point| point.point_id == state.point.point_id)
            {
                state.point = annotated.clone();
            }
        }
    }

    write_hysteresis_progress_artifacts(
        output_dir,
        &hysteresis_points,
        &metrics,
        &settle_trace,
        adaptive_refinement.as_ref(),
        stage_id,
    )?;

    let mut angular_family_variant_runs: Vec<(String, HysteresisAngularFamilyVariantRun)> =
        Vec::new();
    if !stop_after_saturation_probe {
        if let Some(family) = angular_family.as_ref() {
            let active_variant_id =
                active_hysteresis_angular_variant_id(family, orientation.as_ref());
            for variant in &family.variants {
                if active_variant_id
                    .as_deref()
                    .is_some_and(|active_id| active_id == variant.variant_id)
                {
                    continue;
                }
                let variant_run = run_hysteresis_angular_family_variant(
                    variant,
                    plan,
                    problem,
                    output_dir,
                    &family_initial_m,
                    &sweep_values_mT,
                    measurement_axis,
                    storage.as_ref(),
                    settle_pipeline.as_ref(),
                    until_seconds,
                    field_every_n,
                    display_selection,
                    interrupt_requested,
                    stage_id,
                    on_step,
                )?;
                final_status = combine_run_status(final_status, variant_run.status);
                append_stage_steps(
                    &mut steps_stats,
                    &mut global_step_count,
                    variant_run.steps.clone(),
                );
                angular_family_variant_runs.push((variant.variant_id.clone(), variant_run));
            }
        }
    }

    if !stop_after_saturation_probe {
        if let (Some(policy), Some(states)) =
            (adaptive_refinement.as_ref(), major_point_states.as_deref())
        {
            let adaptive_run = run_hysteresis_adaptive_refinement(
                policy,
                states,
                plan,
                problem,
                output_dir,
                u_H,
                u_meas,
                &averaging,
                storage.as_ref(),
                settle_pipeline.as_ref(),
                until_seconds,
                field_every_n,
                display_selection,
                interrupt_requested,
                stage_id,
                on_step,
            )?;
            final_status = combine_run_status(final_status, adaptive_run.status);
            append_stage_steps(&mut steps_stats, &mut global_step_count, adaptive_run.steps);
            write_hysteresis_json_artifact(
                output_dir,
                "hysteresis_adaptive_refinement.json",
                &adaptive_run.artifact,
            )?;
        }
    }

    if !stop_after_saturation_probe {
        if let Some(minor_loops) = minor_loops.as_deref() {
            let artifact = if let Some(states) = major_point_states.as_deref() {
                let minor_run = run_hysteresis_minor_loops(
                    minor_loops,
                    states,
                    &plan,
                    problem,
                    output_dir,
                    u_H,
                    u_meas,
                    &averaging,
                    storage.as_ref(),
                    settle_pipeline.as_ref(),
                    until_seconds,
                    field_every_n,
                    display_selection,
                    interrupt_requested,
                    stage_id,
                    on_step,
                )?;
                final_status = minor_run.status;
                append_stage_steps(&mut steps_stats, &mut global_step_count, minor_run.steps);
                minor_run.loops
            } else {
                build_hysteresis_minor_loops(minor_loops, &hysteresis_points, stage_id)
            };
            if let Ok(json) = serde_json::to_string_pretty(&artifact) {
                fs::write(output_dir.join("hysteresis_minor_loops.json"), json).ok();
            }
        }
    }
    if let Some(saturation_result) = saturation_result {
        if let Ok(json) = serde_json::to_string_pretty(&saturation_result) {
            fs::write(output_dir.join("hysteresis_saturation.json"), json).ok();
        }
    }
    if let Some(family) = angular_family.as_ref() {
        let artifact = build_hysteresis_angular_family_artifact(
            family,
            orientation.as_ref(),
            measurement_axis,
            &hysteresis_points,
            &angular_family_variant_runs,
            stage_id,
        );
        write_hysteresis_json_artifact(output_dir, "hysteresis_angular_family.json", &artifact)?;
    }

    Ok(RunResult {
        status: final_status,
        steps: steps_stats,
        final_magnetization: current_m,
        completion: None,
    })
}

fn build_hysteresis_angular_family_artifact(
    family: &HysteresisAngularFamilyIR,
    active_orientation: Option<&FieldOrientationIR>,
    active_measurement_axis: &MeasurementAxisIR,
    points: &[HysteresisPoint],
    variant_runs: &[(String, HysteresisAngularFamilyVariantRun)],
    stage_id: Option<&str>,
) -> HysteresisAngularFamilyArtifact {
    let active_variant_id = active_hysteresis_angular_variant_id(family, active_orientation);
    let stage_resource_id = stage_id.unwrap_or("stage_0");
    let variants = family
        .variants
        .iter()
        .map(|variant| {
            let is_active = active_variant_id
                .as_deref()
                .is_some_and(|active_id| active_id == variant.variant_id);
            let variant_run = variant_runs
                .iter()
                .find(|(variant_id, _)| *variant_id == variant.variant_id)
                .map(|(_, run)| run);
            let measurement_axis = variant
                .measurement_axis
                .as_ref()
                .unwrap_or(active_measurement_axis);
            HysteresisAngularFamilyVariantArtifact {
                variant_id: variant.variant_id.clone(),
                label: variant.label.clone(),
                orientation: serde_json::to_value(&variant.orientation)
                    .unwrap_or(serde_json::Value::Null),
                measurement_axis: serde_json::to_value(measurement_axis)
                    .unwrap_or(serde_json::Value::Null),
                data_status: if is_active {
                    "computed_active_stage".to_string()
                } else if variant_run.is_some() {
                    "computed_variant_run".to_string()
                } else {
                    "pending_run".to_string()
                },
                point_count: if is_active {
                    points.len()
                } else {
                    variant_run.map(|run| run.point_count).unwrap_or(0)
                },
                points_resource_ref: hysteresis_family_variant_points_resource_ref(
                    stage_resource_id,
                    &variant.variant_id,
                ),
                points_path: if is_active {
                    Some("hysteresis_points.json".to_string())
                } else {
                    variant_run.map(|run| run.points_path.clone())
                },
                metrics_path: if is_active {
                    Some("hysteresis_metrics.json".to_string())
                } else {
                    variant_run.map(|run| run.metrics_path.clone())
                },
                settle_trace_path: if is_active {
                    Some("hysteresis_settle_trace.json".to_string())
                } else {
                    variant_run.map(|run| run.settle_trace_path.clone())
                },
            }
        })
        .collect();

    HysteresisAngularFamilyArtifact {
        kind: family.kind.clone(),
        family_id: family.family_id.clone(),
        label: family.label.clone(),
        active_variant_id,
        variants,
    }
}

fn hysteresis_family_variant_points_resource_ref(stage_id: &str, variant_id: &str) -> String {
    format!(
        "/v2/sessions/current/analysis/hysteresis-family/{stage_id}/variants/{variant_id}/points"
    )
}

fn active_hysteresis_angular_variant_id(
    family: &HysteresisAngularFamilyIR,
    active_orientation: Option<&FieldOrientationIR>,
) -> Option<String> {
    active_orientation.and_then(|orientation| {
        family
            .variants
            .iter()
            .find(|variant| variant.orientation == *orientation)
            .map(|variant| variant.variant_id.clone())
    })
}

fn write_hysteresis_progress_artifacts(
    output_dir: &Path,
    points: &[HysteresisPoint],
    metrics: &HysteresisMetrics,
    settle_trace: &[HysteresisSettleTraceEntry],
    adaptive_refinement: Option<&AdaptiveRefinementIR>,
    stage_id: Option<&str>,
) -> Result<(), RunError> {
    fs::create_dir_all(output_dir).map_err(|error| RunError {
        message: format!(
            "Failed to create hysteresis artifact directory '{}': {}",
            output_dir.display(),
            error
        ),
    })?;

    let mut annotated_points = points.to_vec();
    annotate_hysteresis_points_for_artifact(&mut annotated_points, stage_id);
    write_hysteresis_json_artifact(output_dir, "hysteresis_points.json", &annotated_points)?;
    write_hysteresis_json_artifact(output_dir, "hysteresis_metrics.json", metrics)?;
    write_hysteresis_json_artifact(output_dir, "hysteresis_settle_trace.json", settle_trace)?;
    if let Some(artifact) =
        build_hysteresis_adaptive_refinement_artifact(adaptive_refinement, &annotated_points)
    {
        write_hysteresis_json_artifact(
            output_dir,
            "hysteresis_adaptive_refinement.json",
            &artifact,
        )?;
    }
    Ok(())
}

fn write_hysteresis_json_artifact<T: Serialize + ?Sized>(
    output_dir: &Path,
    filename: &str,
    value: &T,
) -> Result<(), RunError> {
    let json = serde_json::to_string_pretty(value).map_err(|error| RunError {
        message: format!("Failed to serialize hysteresis artifact '{filename}': {error}"),
    })?;
    fs::write(output_dir.join(filename), json).map_err(|error| RunError {
        message: format!("Failed to write hysteresis artifact '{filename}': {error}"),
    })
}

fn should_store_hysteresis_snapshot(
    storage: Option<&fullmag_ir::HysteresisStorageIR>,
    context: HysteresisSnapshotDecisionContext,
) -> bool {
    let Some(storage) = storage else {
        return false;
    };
    match storage.magnetization.as_str() {
        "every_step" => true,
        "every_n" | "selected" => {
            storage.every_n > 0 && context.point_idx % storage.every_n as usize == 0
        }
        "key_events" => storage.key_events && is_hysteresis_key_event(context, storage),
        "none" => false,
        _ => false,
    }
}

fn append_stage_steps(
    target: &mut Vec<StepStats>,
    global_step_count: &mut u64,
    steps: Vec<StepStats>,
) {
    for mut step in steps {
        step.step = *global_step_count;
        target.push(step);
        *global_step_count += 1;
    }
}

fn run_hysteresis_saturation_probe(
    backend_plan: &BackendPlanIR,
    problem: &ProblemIR,
    initial_m: &[[f64; 3]],
    u_H: [f64; 3],
    sign: f64,
    probe: &fullmag_ir::SaturationProbeIR,
    settle_pipeline: Option<&SettlePipelineIR>,
    until_seconds: f64,
    display_selection: &(dyn Fn() -> crate::interactive::DisplaySelectionState + Send + Sync),
    interrupt_requested: Option<&std::sync::atomic::AtomicBool>,
    initial_snapshot: bool,
    on_step: &mut (dyn FnMut(StepUpdate) -> StepAction + Send),
) -> Result<HysteresisSaturationProbeRun, RunError> {
    let mut current_m = initial_m.to_vec();
    let mut all_steps = Vec::new();
    let mut probe_points = Vec::new();
    let mut status = RunStatus::Completed;

    for (probe_index, field_value_mT) in materialize_saturation_probe_fields_mT(probe, sign)
        .into_iter()
        .enumerate()
    {
        let H_Apm = field_mT_to_h_apm(field_value_mT);
        let solve_res = run_settle_at_field(
            backend_plan,
            problem,
            &current_m,
            [H_Apm * u_H[0], H_Apm * u_H[1], H_Apm * u_H[2]],
            Some(HysteresisProgressContext {
                point_idx: None,
                field_m_t: field_value_mT,
                point_role: "saturation_probe",
                branch_id: None,
            }),
            settle_pipeline,
            until_seconds,
            1,
            display_selection,
            interrupt_requested,
            initial_snapshot,
            on_step,
        )?;
        status = solve_res.executed_run.result.status;
        current_m = solve_res.executed_run.result.final_magnetization.clone();
        let averaging = hysteresis_averaging_context(backend_plan);
        let m_avg = average_hysteresis_magnetization(&current_m, &averaging);
        let m_parallel = m_avg[0] * u_H[0] + m_avg[1] * u_H[1] + m_avg[2] * u_H[2];
        let transverse = [
            m_avg[0] - m_parallel * u_H[0],
            m_avg[1] - m_parallel * u_H[1],
            m_avg[2] - m_parallel * u_H[2],
        ];
        let m_transverse = (transverse[0] * transverse[0]
            + transverse[1] * transverse[1]
            + transverse[2] * transverse[2])
            .sqrt();
        let last_step = solve_res.executed_run.result.steps.last();
        let point_status = if status == RunStatus::Completed {
            settle_status(&solve_res.executed_run.result).to_string()
        } else {
            format!("{:?}", status)
        };
        probe_points.push(HysteresisSaturationProbePoint {
            probe_index,
            field_value_mT,
            m_parallel,
            m_transverse,
            torque: last_step.map(|step| step.max_torque_Apm),
            status: point_status,
        });
        all_steps.extend(solve_res.executed_run.result.steps);
    }

    let (classification, reason) = classify_hysteresis_saturation_probe(&probe_points, probe);
    let result = HysteresisSaturationResult {
        status: classification,
        reason,
        direction: if sign < 0.0 { -1 } else { 1 },
        max_probe_field_mT: probe.max_field_mT,
        preparation_field_mT: probe_points.last().map(|point| point.field_value_mT),
        susceptibility_threshold: probe.susceptibility_threshold,
        transverse_threshold: probe.transverse_threshold,
        points: probe_points,
    };

    Ok(HysteresisSaturationProbeRun {
        result,
        final_magnetization: current_m,
        steps: all_steps,
        status,
    })
}

fn materialize_saturation_probe_fields_mT(
    probe: &fullmag_ir::SaturationProbeIR,
    sign: f64,
) -> Vec<f64> {
    let max_field = probe.max_field_mT.abs();
    let sign = if sign < 0.0 { -1.0 } else { 1.0 };
    [max_field / 3.0, 2.0 * max_field / 3.0, max_field]
        .into_iter()
        .filter(|value| value.is_finite() && *value > 0.0)
        .map(|value| sign * value)
        .collect()
}

fn classify_hysteresis_saturation_probe(
    points: &[HysteresisSaturationProbePoint],
    probe: &fullmag_ir::SaturationProbeIR,
) -> (String, String) {
    let Some(last) = points.last() else {
        return (
            "not_evaluated".to_string(),
            "no saturation probe points were executed".to_string(),
        );
    };
    if matches!(
        last.status.as_str(),
        "non_converged" | "failed" | "cancelled" | "paused"
    ) {
        return (
            "capped_by_limit".to_string(),
            "last probe point did not converge before max_probe_field_mT".to_string(),
        );
    }
    let susceptibility = points
        .iter()
        .rev()
        .take(2)
        .collect::<Vec<_>>()
        .as_slice()
        .split_first()
        .and_then(|(last_point, rest)| {
            let previous = rest.first()?;
            let dH = last_point.field_value_mT - previous.field_value_mT;
            if dH.abs() <= 1e-15 {
                None
            } else {
                Some(((last_point.m_parallel - previous.m_parallel) / dH).abs())
            }
        });
    let transverse_ok = last.m_transverse <= probe.transverse_threshold;
    let near_saturation = (1.0 - last.m_parallel.abs()) <= probe.transverse_threshold;
    let susceptibility_ok =
        susceptibility.is_some_and(|value| value <= probe.susceptibility_threshold);

    if susceptibility_ok && transverse_ok && near_saturation {
        return (
            "saturated".to_string(),
            "susceptibility, transverse magnetization, and distance-to-saturation are below thresholds".to_string(),
        );
    }
    if susceptibility_ok && transverse_ok {
        return (
            "probably_saturated".to_string(),
            "susceptibility and transverse magnetization are below thresholds, but distance-to-saturation remains above threshold".to_string(),
        );
    }
    (
        "capped_by_limit".to_string(),
        "max_probe_field_mT reached before saturation criteria were satisfied".to_string(),
    )
}

fn saturation_probe_should_stop_stage(
    probe: &fullmag_ir::SaturationProbeIR,
    result: &HysteresisSaturationResult,
) -> bool {
    probe.on_failure == "stop_stage"
        && result.status != "saturated"
        && result.status != "probably_saturated"
}

fn is_hysteresis_key_event(
    context: HysteresisSnapshotDecisionContext,
    storage: &fullmag_ir::HysteresisStorageIR,
) -> bool {
    if context.status != RunStatus::Completed || context.non_converged {
        return true;
    }
    if context.field_value_mT.abs() <= 1e-9 {
        return true;
    }
    if is_turning_point(
        context.previous_field_value_mT,
        context.field_value_mT,
        context.next_field_value_mT,
    ) {
        return true;
    }
    if let Some(previous_m_parallel) = context.previous_m_parallel {
        if (context.m_parallel - previous_m_parallel).abs() >= storage.key_event_threshold_dm {
            return true;
        }
    }
    false
}

fn is_turning_point(previous: Option<f64>, current: f64, next: Option<f64>) -> bool {
    let (Some(previous), Some(next)) = (previous, next) else {
        return false;
    };
    let incoming = current - previous;
    let outgoing = next - current;
    incoming.abs() > 1e-9 && outgoing.abs() > 1e-9 && incoming.signum() != outgoing.signum()
}

fn hysteresis_magnetization_grid(plan: &ExecutionPlanIR, magnetization: &[[f64; 3]]) -> [u32; 3] {
    match &plan.backend_plan {
        BackendPlanIR::Fdm(fdm) => [fdm.grid.cells[0], fdm.grid.cells[1], fdm.grid.cells[2]],
        _ => [magnetization.len() as u32, 1, 1],
    }
}

fn hysteresis_preparation_field_mT(
    initial_protocol: &str,
    saturation: Option<&fullmag_ir::SaturationProbeIR>,
    sweep_values_mT: &[f64],
) -> Option<f64> {
    match initial_protocol {
        "zero_field_relaxed" => Some(0.0),
        "positive_saturation" => {
            hysteresis_saturation_preparation_amplitude_mT(saturation, sweep_values_mT)
        }
        "negative_saturation" => {
            hysteresis_saturation_preparation_amplitude_mT(saturation, sweep_values_mT)
                .map(|field| -field)
        }
        _ => None,
    }
}

fn hysteresis_saturation_preparation_amplitude_mT(
    saturation: Option<&fullmag_ir::SaturationProbeIR>,
    sweep_values_mT: &[f64],
) -> Option<f64> {
    if let Some(max_field_mT) = saturation
        .map(|probe| probe.max_field_mT)
        .filter(|value| value.is_finite() && *value > 0.0)
    {
        return Some(max_field_mT);
    }
    sweep_values_mT
        .iter()
        .copied()
        .filter(|value| value.is_finite())
        .map(f64::abs)
        .fold(None, |max_value, value| {
            Some(max_value.map_or(value, |current: f64| current.max(value)))
        })
        .filter(|value| *value > 0.0)
}

fn write_hysteresis_magnetization_snapshot(
    output_dir: &Path,
    snapshot_id: &str,
    point_id: usize,
    field_value_mT: f64,
    grid_cells: [u32; 3],
    magnetization: &[[f64; 3]],
    magnetization_average_weighting: &str,
    average_weights: Option<&[f64]>,
    magnetization_storage_policy: &str,
    index_metadata: HysteresisSnapshotIndexMetadata<'_>,
) -> Result<(), RunError> {
    let snapshot_dir = output_dir.join("hysteresis_snapshots").join(snapshot_id);
    fs::create_dir_all(&snapshot_dir).map_err(|error| RunError {
        message: format!(
            "Failed to create hysteresis snapshot directory '{}': {}",
            snapshot_dir.display(),
            error
        ),
    })?;
    let payload = HysteresisMagnetizationSnapshot {
        quantity_id: "m",
        snapshot_id,
        point_id,
        field_value_mT,
        layout: HysteresisSnapshotLayout { grid_cells },
        values: magnetization,
    };
    let json = serde_json::to_vec_pretty(&payload).map_err(|error| RunError {
        message: format!("Failed to serialize hysteresis snapshot '{snapshot_id}': {error}"),
    })?;
    fs::write(snapshot_dir.join("m.json"), json).map_err(|error| RunError {
        message: format!("Failed to write hysteresis snapshot '{snapshot_id}': {error}"),
    })?;
    write_hysteresis_magnetization_zarr_snapshot(
        output_dir,
        snapshot_id,
        point_id,
        field_value_mT,
        grid_cells,
        magnetization,
        magnetization_average_weighting,
        average_weights,
        magnetization_storage_policy,
        index_metadata,
    )
}

fn write_hysteresis_magnetization_zarr_snapshot(
    output_dir: &Path,
    snapshot_id: &str,
    point_id: usize,
    field_value_mT: f64,
    grid_cells: [u32; 3],
    magnetization: &[[f64; 3]],
    magnetization_average_weighting: &str,
    average_weights: Option<&[f64]>,
    magnetization_storage_policy: &str,
    index_metadata: HysteresisSnapshotIndexMetadata<'_>,
) -> Result<(), RunError> {
    let store_dir = output_dir.join(HYSTERESIS_ZARR_STORE);
    let field_dir = store_dir.join(HYSTERESIS_ZARR_M_FIELD);
    fs::create_dir_all(&field_dir).map_err(|error| RunError {
        message: format!(
            "Failed to create hysteresis Zarr field directory '{}': {}",
            field_dir.display(),
            error
        ),
    })?;

    write_hysteresis_zarr_metadata(
        &store_dir,
        &field_dir,
        magnetization.len(),
        magnetization_average_weighting,
        magnetization_storage_policy,
        average_weights.is_some(),
    )?;
    if let Some(weights) = average_weights {
        write_hysteresis_average_weights_zarr(&field_dir, weights, magnetization.len())?;
    }
    let samples_path = field_dir.join("samples.csv");
    let sample_index = next_hysteresis_zarr_sample_index(&samples_path)?;
    let field_revision = (sample_index + 1) as u64;
    let mesh_identity = hysteresis_snapshot_mesh_identity(grid_cells, magnetization.len());
    let chunk_key = format!("{sample_index}.0.0");
    let chunk_path = field_dir.join(&chunk_key);
    let mut chunk = BufWriter::new(fs::File::create(&chunk_path).map_err(|error| RunError {
        message: format!(
            "Failed to create hysteresis Zarr chunk '{}': {}",
            chunk_path.display(),
            error
        ),
    })?);
    for component in 0..3 {
        for vector in magnetization {
            chunk
                .write_all(&vector[component].to_le_bytes())
                .map_err(|error| RunError {
                    message: format!(
                        "Failed to write hysteresis Zarr chunk '{}': {}",
                        chunk_path.display(),
                        error
                    ),
                })?;
        }
    }
    chunk.flush().map_err(|error| RunError {
        message: format!(
            "Failed to flush hysteresis Zarr chunk '{}': {}",
            chunk_path.display(),
            error
        ),
    })?;

    append_hysteresis_zarr_sample_row(
        &samples_path,
        sample_index,
        snapshot_id,
        point_id,
        field_value_mT,
        &chunk_key,
        magnetization.len(),
        grid_cells,
        index_metadata,
        &mesh_identity,
        field_revision,
    )?;
    append_hysteresis_zarr_sample_row(
        &store_dir.join("points.csv"),
        sample_index,
        snapshot_id,
        point_id,
        field_value_mT,
        &format!("{HYSTERESIS_ZARR_M_FIELD}/{chunk_key}"),
        magnetization.len(),
        grid_cells,
        index_metadata,
        &mesh_identity,
        field_revision,
    )?;
    write_hysteresis_zarray_metadata(&field_dir, sample_index + 1, magnetization.len())
}

fn load_hysteresis_checkpoint_magnetization(
    output_dir: &Path,
    initial_state_ref: &str,
    expected_cell_count: usize,
) -> Result<Vec<[f64; 3]>, RunError> {
    let ref_value = initial_state_ref.trim();
    if ref_value.is_empty() {
        return Err(RunError {
            message: "Hysteresis checkpoint initial_state_ref must not be empty".to_string(),
        });
    }

    let snapshot_id = hysteresis_snapshot_id_from_ref(ref_value)?;
    if let Some(snapshot_id) = snapshot_id.as_deref() {
        if let Some(values) =
            load_hysteresis_zarr_checkpoint_magnetization(output_dir, snapshot_id)?
        {
            validate_hysteresis_checkpoint_cell_count(
                snapshot_id,
                values.len(),
                expected_cell_count,
            )?;
            return Ok(values);
        }
    }

    let json_path = hysteresis_checkpoint_json_path(output_dir, ref_value, snapshot_id.as_deref())?;
    let snapshot: HysteresisMagnetizationSnapshotOwned =
        serde_json::from_slice(&fs::read(&json_path).map_err(|error| RunError {
            message: format!(
                "Failed to read hysteresis checkpoint '{}': {}",
                json_path.display(),
                error
            ),
        })?)
        .map_err(|error| RunError {
            message: format!(
                "Failed to parse hysteresis checkpoint '{}': {}",
                json_path.display(),
                error
            ),
        })?;
    if snapshot.quantity_id != "m" {
        return Err(RunError {
            message: format!(
                "Hysteresis checkpoint '{}' contains quantity '{}', expected 'm'",
                snapshot.snapshot_id, snapshot.quantity_id
            ),
        });
    }
    let grid_cell_count = snapshot
        .layout
        .grid_cells
        .iter()
        .try_fold(1usize, |acc, value| acc.checked_mul(*value as usize))
        .ok_or_else(|| RunError {
            message: format!(
                "Hysteresis checkpoint '{}' grid dimensions overflow",
                snapshot.snapshot_id
            ),
        })?;
    if grid_cell_count != snapshot.values.len() {
        return Err(RunError {
            message: format!(
                "Hysteresis checkpoint '{}' grid does not match magnetization payload",
                snapshot.snapshot_id
            ),
        });
    }
    validate_hysteresis_checkpoint_cell_count(
        &snapshot.snapshot_id,
        snapshot.values.len(),
        expected_cell_count,
    )?;
    Ok(snapshot.values)
}

fn hysteresis_snapshot_id_from_ref(ref_value: &str) -> Result<Option<String>, RunError> {
    if let Some(query_start) = ref_value.find("snapshot_id=") {
        let value_start = query_start + "snapshot_id=".len();
        let value_end = ref_value[value_start..]
            .find(['&', '#'])
            .map(|offset| value_start + offset)
            .unwrap_or(ref_value.len());
        let snapshot_id = &ref_value[value_start..value_end];
        validate_hysteresis_snapshot_id(snapshot_id)?;
        return Ok(Some(snapshot_id.to_string()));
    }
    if let Some(rest) = ref_value.strip_prefix("hysteresis_snapshots/") {
        if let Some(snapshot_id) = rest.strip_suffix("/m.json") {
            validate_hysteresis_snapshot_id(snapshot_id)?;
            return Ok(Some(snapshot_id.to_string()));
        }
    }
    if !ref_value.contains('/') && !ref_value.contains('\\') && !ref_value.ends_with(".json") {
        validate_hysteresis_snapshot_id(ref_value)?;
        return Ok(Some(ref_value.to_string()));
    }
    Ok(None)
}

fn validate_hysteresis_snapshot_id(snapshot_id: &str) -> Result<(), RunError> {
    if snapshot_id.is_empty()
        || snapshot_id == "."
        || snapshot_id == ".."
        || snapshot_id.contains('/')
        || snapshot_id.contains('\\')
    {
        return Err(RunError {
            message: "Hysteresis checkpoint snapshot id must be a single path segment".to_string(),
        });
    }
    Ok(())
}

fn hysteresis_checkpoint_json_path(
    output_dir: &Path,
    ref_value: &str,
    snapshot_id: Option<&str>,
) -> Result<std::path::PathBuf, RunError> {
    if let Some(snapshot_id) = snapshot_id {
        return Ok(output_dir
            .join("hysteresis_snapshots")
            .join(snapshot_id)
            .join("m.json"));
    }
    if ref_value.starts_with("hysteresis_snapshots/")
        && ref_value.ends_with("/m.json")
        && !ref_value.contains("..")
        && !ref_value.contains('\\')
    {
        return Ok(output_dir.join(ref_value));
    }
    Err(RunError {
        message: format!(
            "Unsupported hysteresis checkpoint initial_state_ref '{}'",
            ref_value
        ),
    })
}

fn load_hysteresis_zarr_checkpoint_magnetization(
    output_dir: &Path,
    snapshot_id: &str,
) -> Result<Option<Vec<[f64; 3]>>, RunError> {
    let field_dir = output_dir
        .join(HYSTERESIS_ZARR_STORE)
        .join(HYSTERESIS_ZARR_M_FIELD);
    let Some(sample_ref) =
        find_hysteresis_zarr_checkpoint_sample(&field_dir.join("samples.csv"), snapshot_id)?
    else {
        return Ok(None);
    };
    let chunk_path = field_dir.join(&sample_ref.chunk_key);
    let mut raw = Vec::new();
    fs::File::open(&chunk_path)
        .map_err(|error| RunError {
            message: format!(
                "Failed to open hysteresis Zarr checkpoint chunk '{}': {}",
                chunk_path.display(),
                error
            ),
        })?
        .read_to_end(&mut raw)
        .map_err(|error| RunError {
            message: format!(
                "Failed to read hysteresis Zarr checkpoint chunk '{}': {}",
                chunk_path.display(),
                error
            ),
        })?;
    let expected_bytes = sample_ref.cell_count * 3 * std::mem::size_of::<f64>();
    if raw.len() != expected_bytes {
        return Err(RunError {
            message: format!(
                "Hysteresis Zarr checkpoint chunk '{}' has {} bytes, expected {}",
                chunk_path.display(),
                raw.len(),
                expected_bytes
            ),
        });
    }
    let mut values = vec![[0.0; 3]; sample_ref.cell_count];
    for component in 0..3 {
        for (cell, value) in values.iter_mut().enumerate() {
            let source_offset = (component * sample_ref.cell_count + cell) * 8;
            let mut bytes = [0_u8; 8];
            bytes.copy_from_slice(&raw[source_offset..source_offset + 8]);
            value[component] = f64::from_le_bytes(bytes);
        }
    }
    Ok(Some(values))
}

fn find_hysteresis_zarr_checkpoint_sample(
    samples_path: &Path,
    snapshot_id: &str,
) -> Result<Option<HysteresisZarrSampleRef>, RunError> {
    if !samples_path.exists() {
        return Ok(None);
    }
    let file = fs::File::open(samples_path).map_err(|error| RunError {
        message: format!(
            "Failed to open hysteresis Zarr sample index '{}': {}",
            samples_path.display(),
            error
        ),
    })?;
    for line in BufReader::new(file).lines().skip(1) {
        let line = line.map_err(|error| RunError {
            message: format!(
                "Failed to read hysteresis Zarr sample index '{}': {}",
                samples_path.display(),
                error
            ),
        })?;
        let columns: Vec<&str> = line.split(',').collect();
        if columns.len() < 12 || columns[1] != snapshot_id {
            continue;
        }
        let cell_count = columns[8].parse::<usize>().map_err(|error| RunError {
            message: format!(
                "Invalid hysteresis Zarr cell_count for checkpoint '{snapshot_id}': {error}"
            ),
        })?;
        return Ok(Some(HysteresisZarrSampleRef {
            chunk_key: columns[5].to_string(),
            cell_count,
        }));
    }
    Ok(None)
}

fn validate_hysteresis_checkpoint_cell_count(
    snapshot_id: &str,
    actual: usize,
    expected: usize,
) -> Result<(), RunError> {
    if actual != expected {
        return Err(RunError {
            message: format!(
                "Hysteresis checkpoint '{}' has {} magnetization vectors, expected {} for the current domain",
                snapshot_id, actual, expected
            ),
        });
    }
    Ok(())
}

fn write_hysteresis_zarr_metadata(
    store_dir: &Path,
    field_dir: &Path,
    cell_count: usize,
    magnetization_average_weighting: &str,
    magnetization_storage_policy: &str,
    has_average_weights: bool,
) -> Result<(), RunError> {
    fs::write(
        store_dir.join(".zgroup"),
        serde_json::to_vec_pretty(&serde_json::json!({
            "zarr_format": 2,
        }))
        .map_err(|error| RunError {
            message: format!("Failed to serialize hysteresis Zarr group metadata: {error}"),
        })?,
    )
    .map_err(|error| RunError {
        message: format!("Failed to write hysteresis Zarr group metadata: {error}"),
    })?;
    let mut root_attrs = serde_json::json!({
        "fullmag_kind": "hysteresis_field_sequence",
        "schema_version": 1,
        "preferred_container": "zarr",
        "quantity_ids": ["m"],
        "point_index_file": "points.csv",
        "magnetization_average_weighting": magnetization_average_weighting,
        "magnetization_storage_policy": magnetization_storage_policy,
    });
    let mut field_attrs = serde_json::json!({
        "quantity_id": "m",
        "unit": "1",
        "axes": ["point", "component", "spatial_sample"],
        "component_order": ["x", "y", "z"],
        "storage_layout": "soa_component_major",
        "sample_index_file": "samples.csv",
        "cell_count": cell_count,
        "magnetization_average_weighting": magnetization_average_weighting,
        "magnetization_storage_policy": magnetization_storage_policy,
    });
    if has_average_weights {
        root_attrs["average_weights_ref"] = serde_json::json!("fields/m/average_weights");
        field_attrs["average_weights_ref"] = serde_json::json!("average_weights");
    }

    fs::write(
        store_dir.join(".zattrs"),
        serde_json::to_vec_pretty(&root_attrs).map_err(|error| RunError {
            message: format!("Failed to serialize hysteresis Zarr attrs: {error}"),
        })?,
    )
    .map_err(|error| RunError {
        message: format!("Failed to write hysteresis Zarr attrs: {error}"),
    })?;
    fs::write(
        field_dir.join(".zattrs"),
        serde_json::to_vec_pretty(&field_attrs).map_err(|error| RunError {
            message: format!("Failed to serialize hysteresis Zarr field attrs: {error}"),
        })?,
    )
    .map_err(|error| RunError {
        message: format!("Failed to write hysteresis Zarr field attrs: {error}"),
    })
}

fn write_hysteresis_average_weights_zarr(
    field_dir: &Path,
    weights: &[f64],
    cell_count: usize,
) -> Result<(), RunError> {
    if weights.len() != cell_count {
        return Err(RunError {
            message: format!(
                "Hysteresis average weights length {} does not match magnetization cell count {}",
                weights.len(),
                cell_count
            ),
        });
    }
    let weights_dir = field_dir.join("average_weights");
    fs::create_dir_all(&weights_dir).map_err(|error| RunError {
        message: format!(
            "Failed to create hysteresis average weights directory '{}': {}",
            weights_dir.display(),
            error
        ),
    })?;
    fs::write(
        weights_dir.join(".zarray"),
        serde_json::to_vec_pretty(&serde_json::json!({
            "zarr_format": 2,
            "shape": [cell_count],
            "chunks": [cell_count],
            "dtype": "<f8",
            "compressor": serde_json::Value::Null,
            "fill_value": 0.0,
            "order": "C",
            "filters": serde_json::Value::Null,
            "dimension_separator": ".",
        }))
        .map_err(|error| RunError {
            message: format!(
                "Failed to serialize hysteresis average weights Zarr metadata: {error}"
            ),
        })?,
    )
    .map_err(|error| RunError {
        message: format!("Failed to write hysteresis average weights Zarr metadata: {error}"),
    })?;
    fs::write(
        weights_dir.join(".zattrs"),
        serde_json::to_vec_pretty(&serde_json::json!({
            "quantity_id": "magnetization_average_weight",
            "unit": "A/m*m^3",
            "axis": "spatial_sample",
            "storage_layout": "sample_weight",
            "sample_count": cell_count,
        }))
        .map_err(|error| RunError {
            message: format!("Failed to serialize hysteresis average weights Zarr attrs: {error}"),
        })?,
    )
    .map_err(|error| RunError {
        message: format!("Failed to write hysteresis average weights Zarr attrs: {error}"),
    })?;
    let mut chunk =
        BufWriter::new(
            fs::File::create(weights_dir.join("0")).map_err(|error| RunError {
                message: format!("Failed to create hysteresis average weights chunk: {error}"),
            })?,
        );
    for weight in weights {
        chunk
            .write_all(&weight.to_le_bytes())
            .map_err(|error| RunError {
                message: format!("Failed to write hysteresis average weights chunk: {error}"),
            })?;
    }
    chunk.flush().map_err(|error| RunError {
        message: format!("Failed to flush hysteresis average weights chunk: {error}"),
    })
}

fn write_hysteresis_zarray_metadata(
    field_dir: &Path,
    sample_count: usize,
    cell_count: usize,
) -> Result<(), RunError> {
    fs::write(
        field_dir.join(".zarray"),
        serde_json::to_vec_pretty(&serde_json::json!({
            "zarr_format": 2,
            "shape": [sample_count, 3, cell_count],
            "chunks": [1, 3, cell_count],
            "dtype": "<f8",
            "compressor": serde_json::Value::Null,
            "fill_value": 0.0,
            "order": "C",
            "filters": serde_json::Value::Null,
            "dimension_separator": ".",
        }))
        .map_err(|error| RunError {
            message: format!("Failed to serialize hysteresis Zarr array metadata: {error}"),
        })?,
    )
    .map_err(|error| RunError {
        message: format!("Failed to write hysteresis Zarr array metadata: {error}"),
    })
}

fn next_hysteresis_zarr_sample_index(samples_path: &Path) -> Result<usize, RunError> {
    if !samples_path.exists() {
        return Ok(0);
    }
    let file = fs::File::open(samples_path).map_err(|error| RunError {
        message: format!(
            "Failed to read hysteresis Zarr sample index '{}': {}",
            samples_path.display(),
            error
        ),
    })?;
    let reader = BufReader::new(file);
    Ok(reader
        .lines()
        .skip(1)
        .filter(|line| line.as_ref().is_ok_and(|row| !row.trim().is_empty()))
        .count())
}

fn hysteresis_snapshot_mesh_identity(grid_cells: [u32; 3], cell_count: usize) -> String {
    format!(
        "grid:{}x{}x{};cells:{}",
        grid_cells[0], grid_cells[1], grid_cells[2], cell_count
    )
}

fn append_hysteresis_zarr_sample_row(
    samples_path: &Path,
    sample_index: usize,
    snapshot_id: &str,
    point_id: usize,
    field_value_mT: f64,
    chunk_key: &str,
    cell_count: usize,
    grid_cells: [u32; 3],
    index_metadata: HysteresisSnapshotIndexMetadata<'_>,
    mesh_identity: &str,
    field_revision: u64,
) -> Result<(), RunError> {
    let new_file = !samples_path.exists();
    let file = fs::OpenOptions::new()
        .create(true)
        .append(true)
        .open(samples_path)
        .map_err(|error| RunError {
            message: format!(
                "Failed to open hysteresis Zarr sample index '{}': {}",
                samples_path.display(),
                error
            ),
        })?;
    let mut writer = BufWriter::new(file);
    if new_file {
        writeln!(
            writer,
            "sample_index,snapshot_id,point_id,field_value_mT,quantity_id,chunk_key,grid_x,grid_y,cell_count,grid_z,component_count,dtype,branch_id,protocol_role,mesh_identity,field_revision"
        )
        .map_err(|error| RunError {
            message: format!(
                "Failed to write hysteresis Zarr sample index header '{}': {}",
                samples_path.display(),
                error
            ),
        })?;
    }
    let branch_id = index_metadata.branch_id.unwrap_or("");
    let protocol_role = index_metadata.protocol_role.unwrap_or("");
    writeln!(
        writer,
        "{sample_index},{snapshot_id},{point_id},{field_value_mT:.15e},m,{chunk_key},{},{},{cell_count},{},3,<f8,{branch_id},{protocol_role},{mesh_identity},{field_revision}",
        grid_cells[0],
        grid_cells[1],
        grid_cells[2],
    )
    .map_err(|error| RunError {
        message: format!(
            "Failed to append hysteresis Zarr sample index '{}': {}",
            samples_path.display(),
            error
        ),
    })?;
    writer.flush().map_err(|error| RunError {
        message: format!(
            "Failed to flush hysteresis Zarr sample index '{}': {}",
            samples_path.display(),
            error
        ),
    })
}

fn fem_engine_kind(engine: dispatch::FemEngine) -> fem::engine::FemEngineKind {
    match engine {
        dispatch::FemEngine::CpuNative => fem::engine::FemEngineKind::CpuNative,
        dispatch::FemEngine::NativeGpu => fem::engine::FemEngineKind::NativeGpu,
    }
}

#[derive(Clone)]
struct HysteresisProgressContext {
    point_idx: Option<usize>,
    field_m_t: f64,
    point_role: &'static str,
    branch_id: Option<String>,
}

fn run_settle_at_field(
    backend_plan: &BackendPlanIR,
    problem: &ProblemIR,
    initial_m: &[[f64; 3]],
    H_ext: [f64; 3],
    hysteresis_progress: Option<HysteresisProgressContext>,
    pipeline: Option<&SettlePipelineIR>,
    until_seconds: f64,
    field_every_n: u64,
    display_selection: &(dyn Fn() -> crate::interactive::DisplaySelectionState + Send + Sync),
    interrupt_requested: Option<&std::sync::atomic::AtomicBool>,
    initial_snapshot: bool,
    on_step: &mut (dyn FnMut(StepUpdate) -> StepAction + Send),
) -> Result<SettledFieldRun, RunError> {
    let steps = materialize_settle_steps(pipeline);

    let mut current_magnetization = initial_m.to_vec();
    let mut accumulated_steps = Vec::new();
    let mut final_status = RunStatus::Completed;
    let mut final_provenance = crate::types::ExecutionProvenance::default();
    let mut trace = Vec::new();
    let mut previous_non_converged = false;
    let mut pending_fallback_reason: Option<String> = None;

    for (settle_idx, planned_step) in steps.into_iter().enumerate() {
        if planned_step.run_condition == PlannedSettleStepCondition::OnPreviousNonConverged
            && !previous_non_converged
        {
            continue;
        }
        let step = planned_step.step;
        if let Some(progress) = hysteresis_progress.as_ref() {
            if !settle_step_applies_to_context(&step, progress) {
                if let Some(point_idx) = progress.point_idx {
                    trace.push(settle_trace_entry(
                        point_idx,
                        progress.field_m_t,
                        settle_idx,
                        &step,
                        "skipped".to_string(),
                        Some(format!("applies_to_not_matching_{}", progress.point_role)),
                        0,
                        Some(resolved_settle_timestep(backend_plan, &step, None)),
                        None,
                    ));
                }
                continue;
            }
        }
        let fallback_reason = planned_step.fallback_reason.clone().or_else(|| {
            if previous_non_converged {
                pending_fallback_reason.take()
            } else {
                None
            }
        });
        if let Some(progress) = hysteresis_progress.as_ref() {
            let averaging = hysteresis_averaging_context(backend_plan);
            let stats = pre_solver_hysteresis_stats(&current_magnetization, H_ext, &averaging);
            let action = (*on_step)(hysteresis_progress_update(
                backend_plan,
                progress.point_idx,
                progress.field_m_t,
                settle_idx,
                &step,
                Some(&current_magnetization),
                Some(&stats),
            ));
            match action {
                StepAction::Continue => {}
                StepAction::Stop => {
                    final_status = RunStatus::Cancelled;
                    if let Some(point_idx) = progress.point_idx {
                        trace.push(settle_trace_entry(
                            point_idx,
                            progress.field_m_t,
                            settle_idx,
                            &step,
                            "cancelled".to_string(),
                            fallback_reason.clone(),
                            0,
                            Some(resolved_settle_timestep(backend_plan, &step, None)),
                            None,
                        ));
                    }
                    break;
                }
                StepAction::Pause => {
                    final_status = RunStatus::Paused;
                    if let Some(point_idx) = progress.point_idx {
                        trace.push(settle_trace_entry(
                            point_idx,
                            progress.field_m_t,
                            settle_idx,
                            &step,
                            "paused".to_string(),
                            fallback_reason.clone(),
                            0,
                            Some(resolved_settle_timestep(backend_plan, &step, None)),
                            None,
                        ));
                    }
                    break;
                }
            }
        }
        let control = settle_step_relaxation_control(&step)?;

        let step_input_magnetization = current_magnetization.clone();
        let mut retry_attempt = 0;
        let mut retry_timestep_override = None;
        let mut last_fallback_reason = fallback_reason;
        let executed_run = loop {
            let step_until_seconds =
                settle_step_until_seconds(&step, until_seconds, retry_timestep_override);
            let resolved_timestep =
                resolved_settle_timestep(backend_plan, &step, retry_timestep_override);
            let timestep_override =
                retry_timestep_override.or_else(|| settle_step_timestep_s(&step));
            let executed_run = execute_settle_step_at_field(
                backend_plan,
                problem,
                &step_input_magnetization,
                H_ext,
                control.clone(),
                step_until_seconds,
                timestep_override,
                field_every_n,
                display_selection,
                interrupt_requested,
                initial_snapshot && settle_idx == 0 && retry_attempt == 0,
                hysteresis_progress
                    .as_ref()
                    .map(|progress| (progress.point_idx, progress.field_m_t, settle_idx, &step)),
                on_step,
            )?;
            let settle_status = settle_status(&executed_run.result);
            if let Some(progress) = hysteresis_progress.as_ref() {
                if let Some(point_idx) = progress.point_idx {
                    trace.push(settle_trace_entry(
                        point_idx,
                        progress.field_m_t,
                        settle_idx,
                        &step,
                        settle_status.to_string(),
                        last_fallback_reason.clone(),
                        retry_attempt,
                        Some(resolved_timestep),
                        executed_run.result.steps.last(),
                    ));
                }
            }
            if settle_status != "non_converged"
                || settle_step_on_non_convergence(&step) != "retry_with_smaller_dt"
                || retry_attempt >= settle_step_retry_max_attempts(&step)
            {
                break executed_run;
            }
            retry_attempt += 1;
            retry_timestep_override =
                Some(resolved_timestep * settle_step_retry_timestep_scale(&step)?);
            last_fallback_reason = Some("retry_with_smaller_dt".to_string());
        };

        current_magnetization = executed_run.result.final_magnetization.clone();
        if let Some(progress) = hysteresis_progress.as_ref() {
            let action = (*on_step)(hysteresis_progress_update(
                backend_plan,
                progress.point_idx,
                progress.field_m_t,
                settle_idx,
                &step,
                Some(&current_magnetization),
                executed_run.result.steps.last(),
            ));
            match action {
                StepAction::Continue => {}
                StepAction::Stop => {
                    final_status = RunStatus::Cancelled;
                    break;
                }
                StepAction::Pause => {
                    final_status = RunStatus::Paused;
                    break;
                }
            }
        }
        accumulated_steps.extend(executed_run.result.steps.clone());
        final_status = executed_run.result.status;
        let settle_status = settle_status(&executed_run.result);
        previous_non_converged = settle_status == "non_converged";
        final_provenance = executed_run.provenance;

        if previous_non_converged {
            match settle_step_on_non_convergence(&step) {
                "continue_with_warning" => break,
                "run_next_algorithm" => {
                    pending_fallback_reason = Some("previous_step_non_converged".to_string());
                }
                "retry_with_smaller_dt" => break,
                "stop_stage" => {
                    return Err(RunError {
                        message: format!(
                            "Hysteresis settle step {} did not converge and requested stop_stage",
                            settle_idx
                        ),
                    });
                }
                other => {
                    return Err(RunError {
                        message: format!(
                            "Unsupported hysteresis on_non_convergence policy '{}'",
                            other
                        ),
                    });
                }
            }
        }
    }

    Ok(SettledFieldRun {
        executed_run: ExecutedRun {
            result: RunResult {
                status: final_status,
                steps: accumulated_steps,
                final_magnetization: current_magnetization,
                completion: None,
            },
            initial_magnetization: initial_m.to_vec(),
            field_snapshots: Vec::new(),
            field_snapshot_count: 0,
            auxiliary_artifacts: Vec::new(),
            provenance: final_provenance,
        },
        trace,
    })
}

fn settle_step_relaxation_control(step: &SettleStepIR) -> Result<RelaxationControlIR, RunError> {
    match step {
        SettleStepIR::Relax {
            method,
            torque_tolerance,
            max_steps,
            max_pseudotime_s,
            max_physical_time_s,
            ..
        } => Ok(RelaxationControlIR {
            algorithm: settle_relaxation_algorithm(method)?,
            stop: RelaxStopIR {
                torque_tolerance_apm: Some(*torque_tolerance),
                energy_tolerance_j: None,
                max_steps: Some(*max_steps as u64),
                max_pseudotime_s: *max_pseudotime_s,
                max_physical_time_s: *max_physical_time_s,
            },
        }),
        SettleStepIR::Minimize {
            method,
            torque_tolerance,
            energy_tolerance,
            max_steps,
            max_pseudotime_s,
            max_physical_time_s,
            ..
        } => Ok(RelaxationControlIR {
            algorithm: settle_minimize_algorithm(method)?,
            stop: RelaxStopIR {
                torque_tolerance_apm: Some(*torque_tolerance),
                energy_tolerance_j: Some(*energy_tolerance),
                max_steps: Some(*max_steps as u64),
                max_pseudotime_s: *max_pseudotime_s,
                max_physical_time_s: *max_physical_time_s,
            },
        }),
        SettleStepIR::DynamicsSettle {
            method,
            max_steps,
            max_pseudotime_s,
            max_physical_time_s,
            ..
        } => Ok(RelaxationControlIR {
            algorithm: settle_dynamics_algorithm(method)?,
            stop: RelaxStopIR {
                torque_tolerance_apm: None,
                energy_tolerance_j: None,
                max_steps: Some(*max_steps as u64),
                max_pseudotime_s: *max_pseudotime_s,
                max_physical_time_s: *max_physical_time_s,
            },
        }),
    }
}

fn settle_relaxation_algorithm(method: &str) -> Result<RelaxationAlgorithmIR, RunError> {
    match method {
        "llg_overdamped" => Ok(RelaxationAlgorithmIR::LlgOverdamped),
        "projected_gradient_bb" => Ok(RelaxationAlgorithmIR::ProjectedGradientBb),
        "nonlinear_cg" => Ok(RelaxationAlgorithmIR::NonlinearCg),
        "tangent_plane_implicit" => Ok(RelaxationAlgorithmIR::TangentPlaneImplicit),
        other => Err(RunError {
            message: format!("unsupported hysteresis relax method '{other}'"),
        }),
    }
}

fn settle_minimize_algorithm(method: &str) -> Result<RelaxationAlgorithmIR, RunError> {
    match method {
        "projected_gradient_bb" => Ok(RelaxationAlgorithmIR::ProjectedGradientBb),
        "nonlinear_cg" => Ok(RelaxationAlgorithmIR::NonlinearCg),
        "tangent_plane_implicit" => Ok(RelaxationAlgorithmIR::TangentPlaneImplicit),
        other => Err(RunError {
            message: format!("unsupported hysteresis minimize method '{other}'"),
        }),
    }
}

fn settle_dynamics_algorithm(method: &str) -> Result<RelaxationAlgorithmIR, RunError> {
    match method {
        "heun_dynamics_settle" | "llg_overdamped" => Ok(RelaxationAlgorithmIR::LlgOverdamped),
        other => Err(RunError {
            message: format!("unsupported hysteresis dynamics_settle method '{other}'"),
        }),
    }
}

fn ensure_fdm_settle_timestep(plan: &mut fullmag_ir::FdmPlanIR) {
    if plan.fixed_timestep.is_none() && plan.adaptive_timestep.is_none() {
        plan.fixed_timestep = Some(HYSTERESIS_SETTLE_STEP_DT_SECONDS);
    }
}

fn ensure_fem_settle_timestep(plan: &mut fullmag_ir::FemPlanIR) {
    if plan.fixed_timestep.is_none() && plan.adaptive_timestep.is_none() {
        plan.fixed_timestep = Some(HYSTERESIS_SETTLE_STEP_DT_SECONDS);
    }
}

fn execute_settle_step_at_field(
    backend_plan: &BackendPlanIR,
    problem: &ProblemIR,
    initial_magnetization: &[[f64; 3]],
    H_ext: [f64; 3],
    control: RelaxationControlIR,
    until_seconds: f64,
    timestep_override: Option<f64>,
    field_every_n: u64,
    display_selection: &(dyn Fn() -> crate::interactive::DisplaySelectionState + Send + Sync),
    interrupt_requested: Option<&std::sync::atomic::AtomicBool>,
    initial_snapshot: bool,
    hysteresis_progress: Option<(Option<usize>, f64, usize, &SettleStepIR)>,
    on_step: &mut (dyn FnMut(StepUpdate) -> StepAction + Send),
) -> Result<ExecutedRun, RunError> {
    match backend_plan {
        BackendPlanIR::Fdm(fdm) => {
            let mut mutated_fdm = fdm.clone();
            mutated_fdm.initial_magnetization = initial_magnetization.to_vec();
            mutated_fdm.external_field = Some(H_ext);
            mutated_fdm.relaxation = Some(control);
            ensure_fdm_settle_timestep(&mut mutated_fdm);
            if let Some(dt) = timestep_override {
                mutated_fdm.fixed_timestep = Some(dt);
                mutated_fdm.adaptive_timestep = None;
            }

            let engine = dispatch::resolve_fdm_engine(problem)?;
            let mut live_on_step = |update: StepUpdate| {
                let update = annotate_hysteresis_live_update(update, hysteresis_progress);
                (*on_step)(update)
            };
            let grid = [fdm.grid.cells[0], fdm.grid.cells[1], fdm.grid.cells[2]];
            let live = LiveStepConsumer {
                grid,
                field_every_n,
                initial_snapshot,
                display_selection: Some(display_selection),
                interrupt_requested,
                on_step: &mut live_on_step,
            };
            dispatch::execute_fdm(engine, &mutated_fdm, until_seconds, &[], Some(live), None)
        }
        BackendPlanIR::Fem(fem) => {
            let mut mutated_fem = fem.clone();
            mutated_fem.initial_magnetization = initial_magnetization.to_vec();
            mutated_fem.external_field = Some(H_ext);
            mutated_fem.relaxation = Some(control);
            ensure_fem_settle_timestep(&mut mutated_fem);
            if let Some(dt) = timestep_override {
                mutated_fem.fixed_timestep = Some(dt);
                mutated_fem.adaptive_timestep = None;
            }

            let resolution =
                dispatch::resolve_fem_engine_for_plan_with_trail(problem, &mutated_fem)?;
            let mut live_on_step = |update: StepUpdate| {
                let update = annotate_hysteresis_live_update(update, hysteresis_progress);
                (*on_step)(update)
            };
            let grid = [mutated_fem.initial_magnetization.len() as u32, 1, 1];
            let live = LiveStepConsumer {
                grid,
                field_every_n,
                initial_snapshot,
                display_selection: Some(display_selection),
                interrupt_requested,
                on_step: &mut live_on_step,
            };
            fem::relax::execute_fem_relax(
                fem_engine_kind(resolution.engine),
                &mutated_fem,
                until_seconds,
                &[],
                Some(live),
                None,
            )
        }
        _ => Err(RunError {
            message: "Unsupported backend plan in settle step".to_string(),
        }),
    }
}

fn resolved_settle_timestep(
    backend_plan: &BackendPlanIR,
    step: &SettleStepIR,
    timestep_override: Option<f64>,
) -> f64 {
    if let Some(dt) = timestep_override {
        return dt;
    }
    if let Some(dt) = settle_step_timestep_s(step) {
        return dt;
    }
    match backend_plan {
        BackendPlanIR::Fdm(fdm) => fdm
            .fixed_timestep
            .or_else(|| {
                fdm.adaptive_timestep
                    .as_ref()
                    .and_then(|adaptive| adaptive.dt_initial)
            })
            .unwrap_or(HYSTERESIS_SETTLE_STEP_DT_SECONDS),
        BackendPlanIR::Fem(fem) => fem
            .fixed_timestep
            .or_else(|| {
                fem.adaptive_timestep
                    .as_ref()
                    .and_then(|adaptive| adaptive.dt_initial)
            })
            .unwrap_or(HYSTERESIS_SETTLE_STEP_DT_SECONDS),
        _ => HYSTERESIS_SETTLE_STEP_DT_SECONDS,
    }
}

fn annotate_hysteresis_live_update(
    mut update: StepUpdate,
    hysteresis_progress: Option<(Option<usize>, f64, usize, &SettleStepIR)>,
) -> StepUpdate {
    let Some((point_idx, H_mT, settle_idx, step)) = hysteresis_progress else {
        return update;
    };
    update.hysteresis_field_m_t.get_or_insert(H_mT);
    if let Some(point_idx) = point_idx {
        update
            .hysteresis_point_index
            .get_or_insert(point_idx as u32);
    }
    update
        .hysteresis_settle_step_index
        .get_or_insert(settle_idx as u32);
    update
        .hysteresis_settle_step_kind
        .get_or_insert_with(|| hysteresis_settle_step_kind(step).to_string());
    update
        .hysteresis_settle_step_method
        .get_or_insert_with(|| hysteresis_settle_step_method(step).to_string());
    update
}

fn settle_step_until_seconds(
    step: &SettleStepIR,
    requested_until_seconds: f64,
    timestep_override: Option<f64>,
) -> f64 {
    let step_limit = if let Some(max_physical_time_s) = settle_step_max_physical_time_s(step) {
        max_physical_time_s
    } else if let Some(max_pseudotime_s) = settle_step_max_pseudotime_s(step) {
        max_pseudotime_s
    } else {
        f64::from(settle_step_max_steps(step).max(1))
            * timestep_override
                .or_else(|| settle_step_timestep_s(step))
                .unwrap_or(HYSTERESIS_SETTLE_STEP_DT_SECONDS)
    };

    if requested_until_seconds > 0.0 {
        return requested_until_seconds.min(step_limit);
    }

    step_limit
}

fn settle_step_max_steps(step: &SettleStepIR) -> u32 {
    match step {
        SettleStepIR::Relax { max_steps, .. }
        | SettleStepIR::Minimize { max_steps, .. }
        | SettleStepIR::DynamicsSettle { max_steps, .. } => *max_steps,
    }
}

fn settle_step_timestep_s(step: &SettleStepIR) -> Option<f64> {
    match step {
        SettleStepIR::Relax { timestep_s, .. }
        | SettleStepIR::Minimize { timestep_s, .. }
        | SettleStepIR::DynamicsSettle { timestep_s, .. } => *timestep_s,
    }
}

fn settle_step_max_pseudotime_s(step: &SettleStepIR) -> Option<f64> {
    match step {
        SettleStepIR::Relax {
            max_pseudotime_s, ..
        }
        | SettleStepIR::Minimize {
            max_pseudotime_s, ..
        }
        | SettleStepIR::DynamicsSettle {
            max_pseudotime_s, ..
        } => *max_pseudotime_s,
    }
}

fn settle_step_max_physical_time_s(step: &SettleStepIR) -> Option<f64> {
    match step {
        SettleStepIR::Relax {
            max_physical_time_s,
            ..
        }
        | SettleStepIR::Minimize {
            max_physical_time_s,
            ..
        }
        | SettleStepIR::DynamicsSettle {
            max_physical_time_s,
            ..
        } => *max_physical_time_s,
    }
}

fn settle_step_on_non_convergence(step: &SettleStepIR) -> &str {
    match step {
        SettleStepIR::Relax {
            on_non_convergence, ..
        }
        | SettleStepIR::Minimize {
            on_non_convergence, ..
        }
        | SettleStepIR::DynamicsSettle {
            on_non_convergence, ..
        } => on_non_convergence,
    }
}

fn settle_step_applies_to(step: &SettleStepIR) -> Option<&serde_json::Value> {
    match step {
        SettleStepIR::Relax { applies_to, .. }
        | SettleStepIR::Minimize { applies_to, .. }
        | SettleStepIR::DynamicsSettle { applies_to, .. } => applies_to.as_ref(),
    }
}

#[cfg(test)]
fn settle_step_applies_to_point_role(step: &SettleStepIR, point_role: &'static str) -> bool {
    settle_applies_to_matches_context(
        settle_step_applies_to(step),
        &HysteresisProgressContext {
            point_idx: None,
            field_m_t: 0.0,
            point_role,
            branch_id: None,
        },
    )
}

fn settle_step_applies_to_context(
    step: &SettleStepIR,
    context: &HysteresisProgressContext,
) -> bool {
    settle_applies_to_matches_context(settle_step_applies_to(step), context)
}

fn settle_applies_to_matches_context(
    applies_to: Option<&serde_json::Value>,
    context: &HysteresisProgressContext,
) -> bool {
    let Some(applies_to) = applies_to else {
        return true;
    };
    match applies_to {
        serde_json::Value::String(selector) => {
            settle_selector_matches_point_role(selector, context.point_role)
        }
        serde_json::Value::Array(selectors) => selectors
            .iter()
            .any(|selector| settle_applies_to_matches_context(Some(selector), context)),
        serde_json::Value::Object(object) => {
            settle_applies_to_object_matches_context(object, context)
        }
        _ => true,
    }
}

fn settle_applies_to_object_matches_context(
    object: &serde_json::Map<String, serde_json::Value>,
    context: &HysteresisProgressContext,
) -> bool {
    let Some(kind) = object.get("kind").and_then(|value| value.as_str()) else {
        return true;
    };
    match kind {
        "branch_id" => object
            .get("branch_id")
            .and_then(|value| value.as_str())
            .is_some_and(|branch_id| context.branch_id.as_deref() == Some(branch_id)),
        "point_selector" => object
            .get("point_ids")
            .and_then(|value| value.as_array())
            .is_some_and(|point_ids| {
                let Some(point_idx) = context.point_idx else {
                    return false;
                };
                point_ids
                    .iter()
                    .filter_map(|value| value.as_u64())
                    .any(|selected| selected == point_idx as u64)
            }),
        _ => settle_selector_matches_point_role(kind, context.point_role),
    }
}

fn settle_selector_matches_point_role(selector: &str, point_role: &str) -> bool {
    match selector {
        "all_points" => true,
        "major" => matches!(point_role, "major" | "major_descending" | "major_ascending"),
        "minor" => point_role == "minor",
        "recoil" => point_role == "recoil",
        "key_events" => point_role == "key_event",
        "preparation" => point_role == "preparation",
        "saturation_probe" => point_role == "saturation_probe",
        "branch_id" | "point_selector" => true,
        _ => true,
    }
}

fn settle_step_retry_timestep_scale(step: &SettleStepIR) -> Result<f64, RunError> {
    let scale = match step {
        SettleStepIR::Relax {
            retry_timestep_scale,
            ..
        }
        | SettleStepIR::Minimize {
            retry_timestep_scale,
            ..
        }
        | SettleStepIR::DynamicsSettle {
            retry_timestep_scale,
            ..
        } => *retry_timestep_scale,
    };
    scale.ok_or_else(|| RunError {
        message: "retry_with_smaller_dt requires retry_timestep_scale".to_string(),
    })
}

fn settle_step_retry_max_attempts(step: &SettleStepIR) -> u32 {
    match step {
        SettleStepIR::Relax {
            retry_max_attempts, ..
        }
        | SettleStepIR::Minimize {
            retry_max_attempts, ..
        }
        | SettleStepIR::DynamicsSettle {
            retry_max_attempts, ..
        } => retry_max_attempts.unwrap_or(1),
    }
}

fn settle_status(result: &RunResult) -> &'static str {
    match result.status {
        RunStatus::Failed => return "failed",
        RunStatus::Cancelled => return "cancelled",
        RunStatus::Paused => return "paused",
        RunStatus::Completed => {}
    }

    match result
        .completion
        .as_ref()
        .and_then(|completion| completion.reason)
    {
        Some(StageStopReason::Torque | StageStopReason::Energy | StageStopReason::Gradient) => {
            "converged"
        }
        Some(
            StageStopReason::MaxSteps
            | StageStopReason::MaxPseudotime
            | StageStopReason::MaxPhysicalTime
            | StageStopReason::UserCancelled
            | StageStopReason::BackendError,
        ) => "non_converged",
        None => "completed",
    }
}

fn hysteresis_point_quality(
    run_status: RunStatus,
    trace: &[HysteresisSettleTraceEntry],
) -> HysteresisPointQuality {
    let warning_count = trace
        .iter()
        .filter(|entry| entry.status == "non_converged")
        .count() as u32;
    let terminal_settle_reason = trace.last().map(|entry| entry.status.clone());
    let settle_status = if warning_count > 0 {
        "non_converged".to_string()
    } else {
        terminal_settle_reason
            .clone()
            .unwrap_or_else(|| run_status_debug(run_status))
    };

    HysteresisPointQuality {
        run_status: run_status_debug(run_status),
        settle_status,
        has_non_converged_steps: warning_count > 0,
        terminal_settle_reason,
        warning_count,
    }
}

fn run_status_debug(status: RunStatus) -> String {
    format!("{:?}", status)
}

fn settle_trace_entry(
    point_id: usize,
    field_value_mT: f64,
    step_index: usize,
    step: &SettleStepIR,
    status: String,
    fallback_reason: Option<String>,
    retry_attempt: u32,
    resolved_timestep_s: Option<f64>,
    stats: Option<&StepStats>,
) -> HysteresisSettleTraceEntry {
    let stop_reason = Some(status.clone());
    let resolved_parameters = Some(settle_trace_resolved_parameters(step, resolved_timestep_s));
    HysteresisSettleTraceEntry {
        point_id,
        field_value_mT,
        step_index,
        algorithm_id: format!(
            "settle_step_{:03}_{}",
            step_index,
            hysteresis_settle_step_kind(step)
        ),
        method: hysteresis_settle_step_method(step).to_string(),
        status,
        stop_reason,
        fallback_reason,
        retry_attempt,
        resolved_timestep_s,
        resolved_parameters,
        torque: stats.map(|stats| stats.max_torque_Apm),
        energy: stats.map(|stats| stats.e_total),
    }
}

fn settle_trace_resolved_parameters(
    step: &SettleStepIR,
    resolved_timestep_s: Option<f64>,
) -> serde_json::Value {
    match step {
        SettleStepIR::Relax {
            method,
            alpha,
            torque_tolerance,
            max_steps,
            applies_to,
            stop_criteria,
            timestep_s,
            max_pseudotime_s,
            max_physical_time_s,
            on_non_convergence,
            retry_timestep_scale,
            retry_max_attempts,
        } => serde_json::json!({
            "kind": "relax",
            "method": method,
            "alpha": alpha,
            "torque_tolerance": torque_tolerance,
            "max_steps": max_steps,
            "applies_to": applies_to.as_ref().cloned().unwrap_or(serde_json::Value::Null),
            "stop_criteria": stop_criteria.as_ref().cloned().unwrap_or(serde_json::Value::Null),
            "timestep_s": timestep_s,
            "resolved_timestep_s": resolved_timestep_s,
            "max_pseudotime_s": max_pseudotime_s,
            "max_physical_time_s": max_physical_time_s,
            "on_non_convergence": on_non_convergence,
            "retry_timestep_scale": retry_timestep_scale,
            "retry_max_attempts": retry_max_attempts,
        }),
        SettleStepIR::Minimize {
            method,
            torque_tolerance,
            energy_tolerance,
            max_steps,
            applies_to,
            stop_criteria,
            timestep_s,
            max_pseudotime_s,
            max_physical_time_s,
            on_non_convergence,
            retry_timestep_scale,
            retry_max_attempts,
        } => serde_json::json!({
            "kind": "minimize",
            "method": method,
            "torque_tolerance": torque_tolerance,
            "energy_tolerance": energy_tolerance,
            "max_steps": max_steps,
            "applies_to": applies_to.as_ref().cloned().unwrap_or(serde_json::Value::Null),
            "stop_criteria": stop_criteria.as_ref().cloned().unwrap_or(serde_json::Value::Null),
            "timestep_s": timestep_s,
            "resolved_timestep_s": resolved_timestep_s,
            "max_pseudotime_s": max_pseudotime_s,
            "max_physical_time_s": max_physical_time_s,
            "on_non_convergence": on_non_convergence,
            "retry_timestep_scale": retry_timestep_scale,
            "retry_max_attempts": retry_max_attempts,
        }),
        SettleStepIR::DynamicsSettle {
            method,
            damping,
            max_steps,
            applies_to,
            stop_criteria,
            timestep_s,
            max_pseudotime_s,
            max_physical_time_s,
            on_non_convergence,
            retry_timestep_scale,
            retry_max_attempts,
        } => serde_json::json!({
            "kind": "dynamics_settle",
            "method": method,
            "damping": damping,
            "max_steps": max_steps,
            "applies_to": applies_to.as_ref().cloned().unwrap_or(serde_json::Value::Null),
            "stop_criteria": stop_criteria.as_ref().cloned().unwrap_or(serde_json::Value::Null),
            "timestep_s": timestep_s,
            "resolved_timestep_s": resolved_timestep_s,
            "max_pseudotime_s": max_pseudotime_s,
            "max_physical_time_s": max_physical_time_s,
            "on_non_convergence": on_non_convergence,
            "retry_timestep_scale": retry_timestep_scale,
            "retry_max_attempts": retry_max_attempts,
        }),
    }
}

fn hysteresis_progress_update(
    backend_plan: &BackendPlanIR,
    point_idx: Option<usize>,
    H_mT: f64,
    settle_idx: usize,
    step: &SettleStepIR,
    magnetization: Option<&[[f64; 3]]>,
    stats: Option<&StepStats>,
) -> StepUpdate {
    StepUpdate {
        stats: stats.cloned().unwrap_or_default(),
        grid: hysteresis_progress_grid(backend_plan, magnetization),
        fem_mesh: None,
        magnetization: magnetization
            .map(|values| values.iter().flat_map(|v| v.iter().copied()).collect()),
        preview_field: None,
        cached_preview_fields: None,
        hysteresis_field_m_t: Some(H_mT),
        hysteresis_point_index: point_idx.map(|idx| idx as u32),
        hysteresis_settle_step_index: Some(settle_idx as u32),
        hysteresis_settle_step_kind: Some(hysteresis_settle_step_kind(step).to_string()),
        hysteresis_settle_step_method: Some(hysteresis_settle_step_method(step).to_string()),
        scalar_row_due: false,
        finished: false,
    }
}

fn hysteresis_progress_grid(
    backend_plan: &BackendPlanIR,
    magnetization: Option<&[[f64; 3]]>,
) -> [u32; 3] {
    if let Some(magnetization) = magnetization {
        return match backend_plan {
            BackendPlanIR::Fdm(fdm) => [fdm.grid.cells[0], fdm.grid.cells[1], fdm.grid.cells[2]],
            _ => [magnetization.len() as u32, 1, 1],
        };
    }
    hysteresis_backend_grid(backend_plan)
}

fn hysteresis_backend_grid(backend_plan: &BackendPlanIR) -> [u32; 3] {
    match backend_plan {
        BackendPlanIR::Fdm(fdm) => [fdm.grid.cells[0], fdm.grid.cells[1], fdm.grid.cells[2]],
        BackendPlanIR::Fem(_) => [0, 0, 0],
        _ => [0, 0, 0],
    }
}

fn hysteresis_averaging_context(backend_plan: &BackendPlanIR) -> HysteresisAveragingContext {
    match backend_plan {
        BackendPlanIR::Fdm(fdm) => fdm_hysteresis_averaging_context(fdm),
        BackendPlanIR::Fem(fem) => fem_hysteresis_averaging_context(fem),
        _ => HysteresisAveragingContext {
            weights: None,
            weighting: "uniform_sample_average".to_string(),
        },
    }
}

fn fdm_hysteresis_averaging_context(fdm: &fullmag_ir::FdmPlanIR) -> HysteresisAveragingContext {
    let cell_count = fdm.initial_magnetization.len();
    let base_ms = fdm.material.saturation_magnetisation;
    if cell_count == 0 || !base_ms.is_finite() || base_ms <= 0.0 {
        return uniform_hysteresis_averaging_context();
    }

    let volume_fraction = fdm
        .boundary_geometry
        .as_ref()
        .map(|geometry| geometry.volume_fraction.as_slice());
    if volume_fraction.is_some_and(|values| values.len() != cell_count) {
        return uniform_hysteresis_averaging_context();
    }
    if fdm
        .active_mask
        .as_ref()
        .is_some_and(|values| values.len() != cell_count)
    {
        return uniform_hysteresis_averaging_context();
    }
    if fdm
        .material
        .ms_field
        .as_ref()
        .is_some_and(|values| values.len() != cell_count)
    {
        return uniform_hysteresis_averaging_context();
    }

    let mut weights = Vec::with_capacity(cell_count);
    for idx in 0..cell_count {
        if fdm.active_mask.as_ref().is_some_and(|mask| !mask[idx]) {
            weights.push(0.0);
            continue;
        }
        let ms = fdm
            .material
            .ms_field
            .as_ref()
            .map(|values| values[idx])
            .unwrap_or(base_ms);
        let phi = volume_fraction.map(|values| values[idx]).unwrap_or(1.0);
        if !ms.is_finite() || ms <= 0.0 || !phi.is_finite() || phi <= 0.0 {
            weights.push(0.0);
        } else {
            weights.push(ms * phi);
        }
    }

    if weights.iter().any(|weight| *weight > 0.0) {
        HysteresisAveragingContext {
            weights: Some(weights),
            weighting: "moment_weighted_fdm_ms_volume".to_string(),
        }
    } else {
        uniform_hysteresis_averaging_context()
    }
}

fn fem_hysteresis_averaging_context(fem: &fullmag_ir::FemPlanIR) -> HysteresisAveragingContext {
    let node_count = fem.initial_magnetization.len();
    let base_ms = fem.material.saturation_magnetisation;
    if node_count == 0
        || fem.mesh.nodes.len() != node_count
        || !base_ms.is_finite()
        || base_ms <= 0.0
    {
        return uniform_hysteresis_averaging_context();
    }
    if fem
        .ms_element_field
        .as_ref()
        .is_some_and(|values| values.len() != fem.mesh.elements.len())
    {
        return uniform_hysteresis_averaging_context();
    }

    let mut weights = vec![0.0; node_count];
    for (element_idx, element) in fem.mesh.elements.iter().enumerate() {
        if fem
            .mesh
            .element_markers
            .get(element_idx)
            .is_some_and(|marker| *marker == 0)
        {
            continue;
        }
        let ms = fem
            .ms_element_field
            .as_ref()
            .map(|values| values[element_idx])
            .unwrap_or(base_ms);
        if !ms.is_finite() || ms <= 0.0 {
            continue;
        }
        let Some(volume) = tetra_volume(&fem.mesh.nodes, *element) else {
            return uniform_hysteresis_averaging_context();
        };
        if volume <= 0.0 {
            continue;
        }
        let contribution = ms * volume / 4.0;
        for node_idx in element {
            weights[*node_idx as usize] += contribution;
        }
    }

    if weights.iter().any(|weight| *weight > 0.0) {
        HysteresisAveragingContext {
            weights: Some(weights),
            weighting: "moment_weighted_fem_p1_lumped_ms_volume".to_string(),
        }
    } else {
        uniform_hysteresis_averaging_context()
    }
}

fn tetra_volume(nodes: &[[f64; 3]], element: [u32; 4]) -> Option<f64> {
    let a = *nodes.get(element[0] as usize)?;
    let b = *nodes.get(element[1] as usize)?;
    let c = *nodes.get(element[2] as usize)?;
    let d = *nodes.get(element[3] as usize)?;
    let ab = [b[0] - a[0], b[1] - a[1], b[2] - a[2]];
    let ac = [c[0] - a[0], c[1] - a[1], c[2] - a[2]];
    let ad = [d[0] - a[0], d[1] - a[1], d[2] - a[2]];
    let cross_ac_ad = cross(ac, ad);
    let det = ab[0] * cross_ac_ad[0] + ab[1] * cross_ac_ad[1] + ab[2] * cross_ac_ad[2];
    Some(det.abs() / 6.0)
}

fn uniform_hysteresis_averaging_context() -> HysteresisAveragingContext {
    HysteresisAveragingContext {
        weights: None,
        weighting: "uniform_sample_average".to_string(),
    }
}

fn average_hysteresis_magnetization(
    magnetization: &[[f64; 3]],
    averaging: &HysteresisAveragingContext,
) -> [f64; 3] {
    let Some(weights) = averaging.weights.as_ref() else {
        return crate::scalar_metrics::average_magnetization_components(magnetization);
    };
    if weights.len() != magnetization.len() {
        return crate::scalar_metrics::average_magnetization_components(magnetization);
    }

    let mut total = [0.0; 3];
    let mut weight_sum = 0.0;
    for (m, weight) in magnetization.iter().zip(weights.iter()) {
        if !weight.is_finite()
            || *weight <= 0.0
            || !m[0].is_finite()
            || !m[1].is_finite()
            || !m[2].is_finite()
        {
            continue;
        }
        total[0] += m[0] * weight;
        total[1] += m[1] * weight;
        total[2] += m[2] * weight;
        weight_sum += weight;
    }
    if weight_sum <= 0.0 {
        return crate::scalar_metrics::average_magnetization_components(magnetization);
    }
    [
        total[0] / weight_sum,
        total[1] / weight_sum,
        total[2] / weight_sum,
    ]
}

fn pre_solver_hysteresis_stats(
    magnetization: &[[f64; 3]],
    H_ext: [f64; 3],
    averaging: &HysteresisAveragingContext,
) -> StepStats {
    let m_avg = average_hysteresis_magnetization(magnetization, averaging);
    let h_norm = vector_norm(H_ext);
    let torque = magnetization
        .iter()
        .map(|m| vector_norm(cross(*m, H_ext)))
        .fold(0.0, f64::max);

    StepStats {
        mx: m_avg[0],
        my: m_avg[1],
        mz: m_avg[2],
        max_h_eff: h_norm,
        max_torque_Apm: torque,
        max_torque_T: torque * crate::MU0,
        ..StepStats::default()
    }
}

fn cross(a: [f64; 3], b: [f64; 3]) -> [f64; 3] {
    [
        a[1] * b[2] - a[2] * b[1],
        a[2] * b[0] - a[0] * b[2],
        a[0] * b[1] - a[1] * b[0],
    ]
}

fn vector_norm(v: [f64; 3]) -> f64 {
    (v[0] * v[0] + v[1] * v[1] + v[2] * v[2]).sqrt()
}

fn hysteresis_settle_step_kind(step: &SettleStepIR) -> &'static str {
    match step {
        SettleStepIR::Relax { .. } => "relax",
        SettleStepIR::Minimize { .. } => "minimize",
        SettleStepIR::DynamicsSettle { .. } => "dynamics_settle",
    }
}

fn hysteresis_settle_step_method(step: &SettleStepIR) -> &str {
    match step {
        SettleStepIR::Relax { method, .. }
        | SettleStepIR::Minimize { method, .. }
        | SettleStepIR::DynamicsSettle { method, .. } => method,
    }
}

fn hysteresis_measurement_axis(
    measurement_axis: &MeasurementAxisIR,
    field_axis: [f64; 3],
    plan: &ExecutionPlanIR,
) -> Result<[f64; 3], RunError> {
    match measurement_axis {
        MeasurementAxisIR::Named(axis) if axis == "field_axis" => Ok(field_axis),
        MeasurementAxisIR::Named(axis) if axis == "sample_normal" => Ok([0.0, 0.0, 1.0]),
        MeasurementAxisIR::Named(axis) if axis == "easy_axis" => Ok(hysteresis_easy_axis(plan)),
        MeasurementAxisIR::Custom { vector, .. } => Ok(normalize_axis(*vector, [0.0, 0.0, 1.0])),
        MeasurementAxisIR::Named(other) => Err(RunError {
            message: format!("unsupported hysteresis measurement_axis '{other}'"),
        }),
    }
}

fn hysteresis_easy_axis(plan: &ExecutionPlanIR) -> [f64; 3] {
    let default_axis = [0.0, 0.0, 1.0];
    match &plan.backend_plan {
        BackendPlanIR::Fdm(fdm) => normalize_axis(
            fdm.material.anisotropy_axis.unwrap_or(default_axis),
            default_axis,
        ),
        BackendPlanIR::Fem(fem) => normalize_axis(
            fem.material.anisotropy_axis.unwrap_or(default_axis),
            default_axis,
        ),
        _ => default_axis,
    }
}

fn hysteresis_field_axis(
    orientation: Option<&FieldOrientationIR>,
    direction: Option<[f64; 3]>,
) -> [f64; 3] {
    let default_axis = [0.0, 0.0, 1.0];
    if let Some(orient) = orientation {
        return match orient {
            FieldOrientationIR::Preset { preset_name } => match preset_name.as_str() {
                "oop_positive" => [0.0, 0.0, 1.0],
                "oop_negative" => [0.0, 0.0, -1.0],
                "in_plane_x" => [1.0, 0.0, 0.0],
                "in_plane_y" => [0.0, 1.0, 0.0],
                _ => default_axis,
            },
            FieldOrientationIR::Sample { theta, phi } => {
                let theta_rad = theta * std::f64::consts::PI / 180.0;
                let phi_rad = phi * std::f64::consts::PI / 180.0;
                [
                    theta_rad.sin() * phi_rad.cos(),
                    theta_rad.sin() * phi_rad.sin(),
                    theta_rad.cos(),
                ]
            }
            FieldOrientationIR::Global { vector } => normalize_axis(*vector, default_axis),
        };
    }

    direction
        .map(|axis| normalize_axis(axis, default_axis))
        .unwrap_or(default_axis)
}

fn normalize_axis(axis: [f64; 3], default_axis: [f64; 3]) -> [f64; 3] {
    let norm = vector_norm(axis);
    if norm > 1e-15 {
        [axis[0] / norm, axis[1] / norm, axis[2] / norm]
    } else {
        default_axis
    }
}

fn hysteresis_project_m_parallel(m_avg: [f64; 3], measurement_axis: [f64; 3]) -> f64 {
    m_avg[0] * measurement_axis[0] + m_avg[1] * measurement_axis[1] + m_avg[2] * measurement_axis[2]
}

fn hysteresis_sample_normal() -> [f64; 3] {
    [0.0, 0.0, 1.0]
}

fn hysteresis_oop_ip_components(m_avg: [f64; 3], sample_normal: [f64; 3]) -> (f64, f64) {
    let normal = normalize_axis(sample_normal, hysteresis_sample_normal());
    let m_oop = hysteresis_project_m_parallel(m_avg, normal);
    let transverse = [
        m_avg[0] - m_oop * normal[0],
        m_avg[1] - m_oop * normal[1],
        m_avg[2] - m_oop * normal[2],
    ];
    (m_oop, vector_norm(transverse))
}

fn hysteresis_point_field_orientation_value(
    orientation: Option<&FieldOrientationIR>,
    field_axis: [f64; 3],
) -> serde_json::Value {
    orientation
        .and_then(|value| serde_json::to_value(value).ok())
        .unwrap_or_else(|| {
            serde_json::json!({
                "kind": "global",
                "vector": field_axis,
                "source": "resolved_field_axis"
            })
        })
}

fn hysteresis_point_measurement_axis_value(
    measurement_axis: &MeasurementAxisIR,
) -> serde_json::Value {
    serde_json::to_value(measurement_axis).unwrap_or_else(|_| serde_json::Value::Null)
}

fn materialize_hysteresis_field_values(
    field_min_mT: Option<f64>,
    field_max_mT: Option<f64>,
    field_step_mT: Option<f64>,
    field_values_mT: Option<&[f64]>,
    field_schedule: Option<&FieldScheduleIR>,
    schedule_refinements: Option<&[FieldWindowIR]>,
    branch_mode: &str,
) -> Vec<f64> {
    let base_values = if let Some(explicit_values) = field_values_mT {
        explicit_values.to_vec()
    } else if let Some(schedule) = field_schedule {
        materialize_piecewise_field_schedule(schedule)
    } else {
        materialize_regular_field_schedule(field_min_mT, field_max_mT, field_step_mT, branch_mode)
    };

    if field_values_mT.is_some() {
        base_values
    } else {
        apply_dense_field_windows(base_values, schedule_refinements.unwrap_or(&[]))
    }
}

fn materialize_piecewise_field_schedule(schedule: &FieldScheduleIR) -> Vec<f64> {
    let mut values = Vec::new();
    for segment in &schedule.segments {
        let segment_values = materialize_field_segment(segment.start, segment.stop, segment.step);
        for (idx, value) in segment_values.into_iter().enumerate() {
            let include = match segment.endpoint_policy.as_str() {
                "skip_start" => idx > 0,
                "include_both" => true,
                _ => {
                    idx > 0
                        || !values
                            .last()
                            .is_some_and(|last| same_field_value(*last, value))
                }
            };
            if include {
                values.push(value);
            }
        }
    }
    values
}

fn materialize_field_segment(start: f64, stop: f64, step: f64) -> Vec<f64> {
    let abs_step = step.abs();
    if abs_step <= 1e-15 {
        return vec![start, stop];
    }
    let direction = if stop >= start { 1.0 } else { -1.0 };
    let signed_step = abs_step * direction;
    let mut values = Vec::new();
    let mut value = start;
    values.push(start);
    loop {
        let next = value + signed_step;
        if (direction > 0.0 && next >= stop - 1e-9) || (direction < 0.0 && next <= stop + 1e-9) {
            break;
        }
        values.push(next);
        value = next;
    }
    if !values
        .last()
        .is_some_and(|last| same_field_value(*last, stop))
    {
        values.push(stop);
    }
    values
}

fn materialize_regular_field_schedule(
    field_min_mT: Option<f64>,
    field_max_mT: Option<f64>,
    field_step_mT: Option<f64>,
    branch_mode: &str,
) -> Vec<f64> {
    let min = field_min_mT.unwrap_or(-100.0);
    let max = field_max_mT.unwrap_or(100.0);
    let step = field_step_mT.unwrap_or(5.0).abs();

    if branch_mode == "major_loop" || branch_mode == "major_with_minor_loops" {
        let mut values = materialize_field_segment(max, min, -step);
        values.extend(
            materialize_field_segment(min, max, step)
                .into_iter()
                .skip(1),
        );
        values
    } else if branch_mode == "virgin_curve" {
        materialize_field_segment(0.0, max, step)
    } else if branch_mode == "virgin_then_major_loop" {
        let mut values = materialize_field_segment(0.0, max, step);
        values.extend(
            materialize_field_segment(max, min, -step)
                .into_iter()
                .skip(1),
        );
        values.extend(
            materialize_field_segment(min, max, step)
                .into_iter()
                .skip(1),
        );
        values
    } else {
        materialize_field_segment(min, max, step)
    }
}

fn apply_dense_field_windows(values: Vec<f64>, windows: &[FieldWindowIR]) -> Vec<f64> {
    if values.len() < 2 || windows.is_empty() {
        return values;
    }

    let mut refined = Vec::new();
    for pair in values.windows(2) {
        let start = pair[0];
        let stop = pair[1];
        if refined
            .last()
            .is_none_or(|last| !same_field_value(*last, start))
        {
            refined.push(start);
        }

        let direction = if stop >= start { 1.0 } else { -1.0 };
        let lo = start.min(stop);
        let hi = start.max(stop);
        let mut inserted = Vec::new();
        for window in windows {
            let window_lo = window.center_mT - window.half_width_mT;
            let window_hi = window.center_mT + window.half_width_mT;
            let overlap_lo = lo.max(window_lo);
            let overlap_hi = hi.min(window_hi);
            if overlap_lo > overlap_hi {
                continue;
            }
            inserted.extend(materialize_field_segment(
                if direction > 0.0 {
                    overlap_lo
                } else {
                    overlap_hi
                },
                if direction > 0.0 {
                    overlap_hi
                } else {
                    overlap_lo
                },
                window.step_mT * direction,
            ));
        }
        inserted.sort_by(|left, right| {
            if direction > 0.0 {
                left.total_cmp(right)
            } else {
                right.total_cmp(left)
            }
        });
        for value in inserted {
            if !same_field_value(value, start)
                && !same_field_value(value, stop)
                && refined
                    .last()
                    .is_none_or(|last| !same_field_value(*last, value))
            {
                refined.push(value);
            }
        }
    }

    if let Some(last) = values.last().copied() {
        if refined
            .last()
            .is_none_or(|existing| !same_field_value(*existing, last))
        {
            refined.push(last);
        }
    }

    refined
}

fn same_field_value(left: f64, right: f64) -> bool {
    (left - right).abs() <= 1e-9
}

fn build_hysteresis_adaptive_refinement_artifact(
    policy: Option<&AdaptiveRefinementIR>,
    points: &[HysteresisPoint],
) -> Option<HysteresisAdaptiveRefinementArtifact> {
    let policy = policy?;
    let mut artifact = HysteresisAdaptiveRefinementArtifact {
        kind: "adaptive_refinement".to_string(),
        status: if policy.enabled {
            "waiting_for_points".to_string()
        } else {
            "disabled".to_string()
        },
        enabled: policy.enabled,
        source_point_count: points.len(),
        max_passes: policy.max_passes,
        max_insertions_per_pass: policy.max_insertions_per_pass,
        candidates: Vec::new(),
        points: Vec::new(),
        settle_trace: Vec::new(),
    };

    if !policy.enabled || points.len() < 2 {
        return Some(artifact);
    }

    let max_candidates = policy.max_insertions_per_pass as usize;
    for pair in points.windows(2) {
        if artifact.candidates.len() >= max_candidates {
            break;
        }
        let left = &pair[0];
        let right = &pair[1];
        let d_h = right.field_value_mT - left.field_value_mT;
        let abs_d_h = d_h.abs();
        if !d_h.is_finite() || abs_d_h <= policy.min_step_mT {
            continue;
        }

        let dm_dh = (right.m_parallel - left.m_parallel) / d_h;
        let branch_event =
            left.is_reversal_field == Some(true) || right.is_reversal_field == Some(true);
        let non_converged = left.has_non_converged_steps || right.has_non_converged_steps;
        if policy.include_zero_crossings
            && field_interval_contains_zero(left.field_value_mT, right.field_value_mT)
            && !same_field_value(left.field_value_mT, 0.0)
            && !same_field_value(right.field_value_mT, 0.0)
        {
            push_hysteresis_adaptive_candidate(
                &mut artifact.candidates,
                max_candidates,
                left,
                right,
                0.0,
                dm_dh,
                vec!["zero_crossing".to_string()],
            );
        }

        let high_susceptibility =
            policy.include_high_susceptibility && dm_dh.abs() >= policy.dm_dh_threshold_per_mT;
        if high_susceptibility || abs_d_h > policy.max_step_mT || branch_event || non_converged {
            let insert_count = ((abs_d_h / policy.max_step_mT).ceil() as usize)
                .saturating_sub(1)
                .max(if high_susceptibility || branch_event || non_converged {
                    1
                } else {
                    0
                });
            for insert_idx in 1..=insert_count {
                if artifact.candidates.len() >= max_candidates {
                    break;
                }
                let fraction = insert_idx as f64 / (insert_count + 1) as f64;
                let field_value_mT = left.field_value_mT + d_h * fraction;
                if (field_value_mT - left.field_value_mT).abs() < policy.min_step_mT
                    || (field_value_mT - right.field_value_mT).abs() < policy.min_step_mT
                {
                    continue;
                }
                let mut reasons = Vec::new();
                if high_susceptibility {
                    reasons.push("high_susceptibility".to_string());
                }
                if abs_d_h > policy.max_step_mT {
                    reasons.push("max_step".to_string());
                }
                if branch_event {
                    reasons.push("reversal_field".to_string());
                }
                if non_converged {
                    reasons.push("non_convergence".to_string());
                }
                push_hysteresis_adaptive_candidate(
                    &mut artifact.candidates,
                    max_candidates,
                    left,
                    right,
                    field_value_mT,
                    dm_dh,
                    reasons,
                );
            }
        }
    }

    artifact.status = if artifact.candidates.is_empty() {
        "no_candidates".to_string()
    } else {
        "proposed".to_string()
    };
    Some(artifact)
}

fn field_interval_contains_zero(left: f64, right: f64) -> bool {
    (left < 0.0 && right > 0.0) || (left > 0.0 && right < 0.0)
}

fn push_hysteresis_adaptive_candidate(
    candidates: &mut Vec<HysteresisAdaptiveRefinementCandidate>,
    max_candidates: usize,
    left: &HysteresisPoint,
    right: &HysteresisPoint,
    field_value_mT: f64,
    dm_dh_per_mT: f64,
    reasons: Vec<String>,
) {
    if candidates.len() >= max_candidates {
        return;
    }
    if reasons.is_empty() || !field_value_mT.is_finite() || !dm_dh_per_mT.is_finite() {
        return;
    }
    if candidates.iter().any(|candidate| {
        same_field_value(candidate.field_value_mT, field_value_mT)
            && candidate.parent_left_point_id == left.point_id
            && candidate.parent_right_point_id == right.point_id
    }) {
        return;
    }
    candidates.push(HysteresisAdaptiveRefinementCandidate {
        candidate_id: format!("adaptive_candidate_{:03}", candidates.len() + 1),
        pass_index: 1,
        field_value_mT,
        parent_left_point_id: left.point_id,
        parent_right_point_id: right.point_id,
        parent_left_field_mT: left.field_value_mT,
        parent_right_field_mT: right.field_value_mT,
        dm_dh_per_mT,
        reasons,
        status: "proposed".to_string(),
    });
}

fn field_mT_to_h_apm(field_mT: f64) -> f64 {
    field_mT * 1.0e-3 / MU0_H_PER_M
}

fn materialize_settle_steps(pipeline: Option<&SettlePipelineIR>) -> Vec<PlannedSettleStep> {
    match pipeline {
        Some(SettlePipelineIR::Sequence { steps }) => steps
            .iter()
            .cloned()
            .map(|step| PlannedSettleStep {
                step,
                run_condition: PlannedSettleStepCondition::Always,
                fallback_reason: None,
            })
            .collect(),
        Some(SettlePipelineIR::Tree { default, branches }) => {
            let mut steps = vec![PlannedSettleStep {
                step: default.clone(),
                run_condition: PlannedSettleStepCondition::Always,
                fallback_reason: None,
            }];
            for branch in branches {
                match branch.when.as_str() {
                    "always" => steps.push(PlannedSettleStep {
                        step: branch.run.clone(),
                        run_condition: PlannedSettleStepCondition::Always,
                        fallback_reason: None,
                    }),
                    "non_converged" | "fallback" | "run_next_algorithm" => {
                        steps.push(PlannedSettleStep {
                            step: branch.run.clone(),
                            run_condition: PlannedSettleStepCondition::OnPreviousNonConverged,
                            fallback_reason: Some("previous_step_non_converged".to_string()),
                        });
                    }
                    _ => {}
                }
            }
            steps
        }
        None => vec![PlannedSettleStep {
            step: SettleStepIR::Relax {
                method: "llg_overdamped".to_string(),
                alpha: 1.0,
                torque_tolerance: 1e-5,
                max_steps: 10000,
                applies_to: None,
                stop_criteria: None,
                timestep_s: None,
                max_pseudotime_s: None,
                max_physical_time_s: None,
                on_non_convergence: "continue_with_warning".to_string(),
                retry_timestep_scale: None,
                retry_max_attempts: None,
            },
            run_condition: PlannedSettleStepCondition::Always,
            fallback_reason: None,
        }],
    }
}

fn annotate_hysteresis_points_for_artifact(points: &mut [HysteresisPoint], stage_id: Option<&str>) {
    let segments = infer_hysteresis_branch_segments(points);
    let mut branch_ids_by_point: std::collections::BTreeMap<usize, Vec<String>> =
        std::collections::BTreeMap::new();
    let mut primary_branch_by_point: std::collections::BTreeMap<usize, (String, String, u32)> =
        std::collections::BTreeMap::new();

    for (branch_index, direction, point_ids) in segments {
        let branch_id = branch_id_for_direction(direction).to_string();
        let branch_role = branch_role_for_direction(direction).to_string();
        for point_id in point_ids {
            let branch_ids = branch_ids_by_point.entry(point_id).or_default();
            if !branch_ids.iter().any(|existing| existing == &branch_id) {
                branch_ids.push(branch_id.clone());
                branch_ids.sort();
            }
            primary_branch_by_point
                .entry(point_id)
                .or_insert_with(|| (branch_id.clone(), branch_role.clone(), branch_index));
        }
    }

    for point in points {
        if let Some(branch_ids) = branch_ids_by_point.get(&point.point_id) {
            if point.branch_ids.is_none() {
                point.branch_ids = Some(branch_ids.clone());
            }
        }
        if let Some((branch_id, branch_role, branch_index)) =
            primary_branch_by_point.get(&point.point_id)
        {
            point.branch_id.get_or_insert_with(|| branch_id.clone());
            point
                .protocol_role
                .get_or_insert_with(|| branch_role.clone());
            point.branch_index.get_or_insert(*branch_index);
        }
        if let Some(snapshot_id) = point.snapshot_id.clone() {
            annotate_hysteresis_snapshot_refs(point, &snapshot_id, stage_id);
        }
        point.is_reversal_field.get_or_insert(false);
    }
}

fn annotate_hysteresis_snapshot_refs(
    point: &mut HysteresisPoint,
    snapshot_id: &str,
    stage_id: Option<&str>,
) {
    let stage_param = stage_id
        .filter(|stage_id| !stage_id.trim().is_empty())
        .map(|stage_id| format!("&stage_id={stage_id}"))
        .unwrap_or_default();
    let vector_resource_ref = format!(
        "/v2/sessions/current/data/fields/m/samples/vector?component=full&scope_kind=full&snapshot_id={snapshot_id}{stage_param}"
    );
    point.snapshot_resource_ref = Some(vector_resource_ref.clone());
    point.snapshot_vector_resource_ref = Some(vector_resource_ref);
    point.snapshot_json_artifact_ref = Some(format!("hysteresis_snapshots/{snapshot_id}/m.json"));
    point.snapshot_zarr_store_ref = Some(HYSTERESIS_ZARR_STORE.to_string());
    point.snapshot_storage_format = Some("zarr_v2_json_fallback".to_string());
}

fn infer_hysteresis_branch_segments(points: &[HysteresisPoint]) -> Vec<(u32, i32, Vec<usize>)> {
    if points.is_empty() {
        return Vec::new();
    }
    if points.len() == 1 {
        return vec![(0, 0, vec![points[0].point_id])];
    }

    let mut segments = Vec::new();
    let mut branch_start = 0usize;
    let mut active_direction = 0i32;

    for index in 1..points.len() {
        let delta = points[index].field_value_mT - points[index - 1].field_value_mT;
        let direction = if same_field_value(delta, 0.0) {
            active_direction
        } else if delta > 0.0 {
            1
        } else {
            -1
        };

        if active_direction == 0 {
            active_direction = direction;
        } else if direction != 0 && direction != active_direction {
            segments.push((active_direction, branch_start, index - 1));
            branch_start = index - 1;
            active_direction = direction;
        }
    }

    segments.push((active_direction, branch_start, points.len() - 1));
    segments
        .into_iter()
        .enumerate()
        .map(|(branch_index, (direction, start, end))| {
            (
                branch_index as u32,
                direction,
                points[start..=end]
                    .iter()
                    .map(|point| point.point_id)
                    .collect(),
            )
        })
        .collect()
}

fn primary_hysteresis_snapshot_index_metadata(
    field_values_mT: &[f64],
    point_idx: usize,
) -> HysteresisSnapshotIndexMetadata<'static> {
    let Some((_, direction, _, _)) = infer_hysteresis_field_value_branch_segments(field_values_mT)
        .into_iter()
        .find(|(_, _, start, end)| point_idx >= *start && point_idx <= *end)
    else {
        return HysteresisSnapshotIndexMetadata::default();
    };
    HysteresisSnapshotIndexMetadata {
        branch_id: Some(branch_id_for_direction(direction)),
        protocol_role: Some(branch_role_for_direction(direction)),
    }
}

fn infer_hysteresis_field_value_branch_segments(
    field_values_mT: &[f64],
) -> Vec<(u32, i32, usize, usize)> {
    if field_values_mT.is_empty() {
        return Vec::new();
    }
    if field_values_mT.len() == 1 {
        return vec![(0, 0, 0, 0)];
    }

    let mut segments = Vec::new();
    let mut branch_start = 0usize;
    let mut active_direction = 0i32;

    for index in 1..field_values_mT.len() {
        let delta = field_values_mT[index] - field_values_mT[index - 1];
        let direction = if same_field_value(delta, 0.0) {
            active_direction
        } else if delta > 0.0 {
            1
        } else {
            -1
        };

        if active_direction == 0 {
            active_direction = direction;
        } else if direction != 0 && direction != active_direction {
            segments.push((active_direction, branch_start, index - 1));
            branch_start = index - 1;
            active_direction = direction;
        }
    }

    segments.push((active_direction, branch_start, field_values_mT.len() - 1));
    segments
        .into_iter()
        .enumerate()
        .map(|(branch_index, (direction, start, end))| (branch_index as u32, direction, start, end))
        .collect()
}

fn branch_id_for_direction(direction: i32) -> &'static str {
    match direction {
        -1 => "descending",
        1 => "ascending",
        _ => "stationary",
    }
}

fn branch_role_for_direction(direction: i32) -> &'static str {
    match direction {
        -1 => "major_descending",
        1 => "major_ascending",
        _ => "stationary",
    }
}

fn combine_run_status(left: RunStatus, right: RunStatus) -> RunStatus {
    match (left, right) {
        (RunStatus::Failed, _) | (_, RunStatus::Failed) => RunStatus::Failed,
        (RunStatus::Cancelled, _) | (_, RunStatus::Cancelled) => RunStatus::Cancelled,
        (RunStatus::Paused, _) | (_, RunStatus::Paused) => RunStatus::Paused,
        _ => RunStatus::Completed,
    }
}

fn run_hysteresis_angular_family_variant(
    variant: &fullmag_ir::HysteresisAngularVariantIR,
    plan: &ExecutionPlanIR,
    problem: &ProblemIR,
    output_dir: &Path,
    initial_m: &[[f64; 3]],
    sweep_values_mT: &[f64],
    active_measurement_axis: &MeasurementAxisIR,
    storage: Option<&fullmag_ir::HysteresisStorageIR>,
    settle_pipeline: Option<&SettlePipelineIR>,
    until_seconds: f64,
    field_every_n: u64,
    display_selection: &(dyn Fn() -> crate::interactive::DisplaySelectionState + Send + Sync),
    interrupt_requested: Option<&std::sync::atomic::AtomicBool>,
    stage_id: Option<&str>,
    on_step: &mut (dyn FnMut(StepUpdate) -> StepAction + Send),
) -> Result<HysteresisAngularFamilyVariantRun, RunError> {
    let variant_dir = output_dir
        .join("hysteresis_angular_family")
        .join(sanitize_hysteresis_variant_id(&variant.variant_id));
    fs::create_dir_all(&variant_dir).map_err(|error| RunError {
        message: format!(
            "Failed to create hysteresis angular-family variant directory '{}': {}",
            variant_dir.display(),
            error
        ),
    })?;

    let u_H = hysteresis_field_axis(Some(&variant.orientation), None);
    let measurement_axis = variant
        .measurement_axis
        .as_ref()
        .unwrap_or(active_measurement_axis);
    let u_meas = hysteresis_measurement_axis(measurement_axis, u_H, plan)?;
    let averaging = hysteresis_averaging_context(&plan.backend_plan);
    let mut current_m = initial_m.to_vec();
    let mut points = Vec::new();
    let mut settle_trace = Vec::new();
    let mut steps = Vec::new();
    let mut global_step_count = 0;
    let mut status = RunStatus::Completed;

    for (point_idx, H_mT) in sweep_values_mT.iter().copied().enumerate() {
        let H_Apm = field_mT_to_h_apm(H_mT);
        let field_vector_A_per_m = [H_Apm * u_H[0], H_Apm * u_H[1], H_Apm * u_H[2]];
        let point_run = run_settle_at_field(
            &plan.backend_plan,
            problem,
            &current_m,
            field_vector_A_per_m,
            Some(HysteresisProgressContext {
                point_idx: Some(point_idx),
                field_m_t: H_mT,
                point_role: "major",
                branch_id: primary_hysteresis_snapshot_index_metadata(sweep_values_mT, point_idx)
                    .branch_id
                    .map(str::to_string),
            }),
            settle_pipeline,
            until_seconds,
            field_every_n,
            display_selection,
            interrupt_requested,
            false,
            on_step,
        )?;
        current_m = point_run.executed_run.result.final_magnetization.clone();
        status = combine_run_status(status, point_run.executed_run.result.status);
        let point_non_converged = point_run
            .trace
            .iter()
            .any(|entry| entry.status == "non_converged");
        let point_quality =
            hysteresis_point_quality(point_run.executed_run.result.status, &point_run.trace);
        settle_trace.extend(point_run.trace);
        append_stage_steps(
            &mut steps,
            &mut global_step_count,
            point_run.executed_run.result.steps,
        );

        let m_avg = average_hysteresis_magnetization(&current_m, &averaging);
        let m_parallel = hysteresis_project_m_parallel(m_avg, u_meas);
        let (m_oop, m_ip) = hysteresis_oop_ip_components(m_avg, hysteresis_sample_normal());
        let snapshot_context = HysteresisSnapshotDecisionContext {
            point_idx,
            field_value_mT: H_mT,
            previous_field_value_mT: point_idx
                .checked_sub(1)
                .and_then(|idx| sweep_values_mT.get(idx).copied()),
            next_field_value_mT: sweep_values_mT.get(point_idx + 1).copied(),
            m_parallel,
            previous_m_parallel: points
                .last()
                .map(|point: &HysteresisPoint| point.m_parallel),
            status,
            non_converged: point_non_converged,
        };
        let snapshot_id = if should_store_hysteresis_snapshot(storage, snapshot_context) {
            Some(format!(
                "hysteresis_angular_{}_point_{:03}",
                sanitize_hysteresis_variant_id(&variant.variant_id),
                point_idx + 1
            ))
        } else {
            None
        };
        if let Some(snapshot_id) = snapshot_id.as_deref() {
            let index_metadata =
                primary_hysteresis_snapshot_index_metadata(sweep_values_mT, point_idx);
            write_hysteresis_magnetization_snapshot(
                &variant_dir,
                snapshot_id,
                point_idx,
                H_mT,
                hysteresis_magnetization_grid(plan, &current_m),
                &current_m,
                &averaging.weighting,
                averaging.weights.as_deref(),
                storage
                    .map(|policy| policy.magnetization.as_str())
                    .unwrap_or("unspecified"),
                index_metadata,
            )?;
        }
        points.push(HysteresisPoint {
            point_id: point_idx,
            field_value_mT: H_mT,
            m_parallel,
            m_oop,
            m_ip,
            m_avg,
            status: point_quality.run_status.clone(),
            run_status: point_quality.run_status,
            settle_status: point_quality.settle_status,
            has_non_converged_steps: point_quality.has_non_converged_steps,
            terminal_settle_reason: point_quality.terminal_settle_reason,
            warning_count: point_quality.warning_count,
            snapshot_id,
            protocol_role: None,
            branch_id: None,
            branch_ids: None,
            branch_index: None,
            parent_branch_id: None,
            minor_loop_id: None,
            snapshot_resource_ref: None,
            snapshot_vector_resource_ref: None,
            snapshot_json_artifact_ref: None,
            snapshot_zarr_store_ref: None,
            snapshot_storage_format: None,
            field_vector_A_per_m: Some(field_vector_A_per_m),
            field_orientation: Some(hysteresis_point_field_orientation_value(
                Some(&variant.orientation),
                u_H,
            )),
            measurement_axis: Some(hysteresis_point_measurement_axis_value(measurement_axis)),
            field_display_unit: Some("mT".to_string()),
            is_reversal_field: None,
            reversal_index: None,
            recoil_start_point_id: None,
            adaptive_inserted: None,
            refinement_reason: None,
            refinement_parent_left_point_id: None,
            refinement_parent_right_point_id: None,
        });
    }

    let metrics = calculate_metrics_with_weighting(
        &points,
        "angular_family_variant",
        None,
        None,
        &averaging.weighting,
    );
    annotate_hysteresis_points_for_artifact(&mut points, stage_id);
    write_hysteresis_progress_artifacts(
        &variant_dir,
        &points,
        &metrics,
        &settle_trace,
        None,
        stage_id,
    )?;

    let variant_dir_name = sanitize_hysteresis_variant_id(&variant.variant_id);
    Ok(HysteresisAngularFamilyVariantRun {
        point_count: points.len(),
        points_path: format!("hysteresis_angular_family/{variant_dir_name}/hysteresis_points.json"),
        metrics_path: format!(
            "hysteresis_angular_family/{variant_dir_name}/hysteresis_metrics.json"
        ),
        settle_trace_path: format!(
            "hysteresis_angular_family/{variant_dir_name}/hysteresis_settle_trace.json"
        ),
        status,
        steps,
    })
}

fn sanitize_hysteresis_variant_id(variant_id: &str) -> String {
    let sanitized: String = variant_id
        .chars()
        .map(|ch| {
            if ch.is_ascii_alphanumeric() || ch == '_' || ch == '-' {
                ch
            } else {
                '_'
            }
        })
        .collect();
    if sanitized.is_empty() {
        "variant".to_string()
    } else {
        sanitized
    }
}

fn build_hysteresis_minor_loops(
    configured_loops: &[fullmag_ir::MinorLoopIR],
    points: &[HysteresisPoint],
    stage_id: Option<&str>,
) -> Vec<HysteresisMinorLoop> {
    let mut annotated_points = points.to_vec();
    annotate_hysteresis_points_for_artifact(&mut annotated_points, stage_id);

    configured_loops
        .iter()
        .enumerate()
        .map(|(idx, configured)| {
            let selected_points = select_minor_loop_points(
                &annotated_points,
                configured.reversal_mT,
                configured.return_mT,
            );
            enrich_hysteresis_minor_loop(
                format!("minor_loop_{:03}", idx + 1),
                configured.reversal_mT,
                configured.return_mT,
                selected_points,
                &annotated_points,
                stage_id,
            )
        })
        .collect()
}

fn run_hysteresis_adaptive_refinement(
    policy: &AdaptiveRefinementIR,
    major_states: &[HysteresisMajorPointState],
    plan: &ExecutionPlanIR,
    problem: &ProblemIR,
    output_dir: &Path,
    u_H: [f64; 3],
    u_meas: [f64; 3],
    averaging: &HysteresisAveragingContext,
    storage: Option<&fullmag_ir::HysteresisStorageIR>,
    settle_pipeline: Option<&SettlePipelineIR>,
    until_seconds: f64,
    field_every_n: u64,
    display_selection: &(dyn Fn() -> crate::interactive::DisplaySelectionState + Send + Sync),
    interrupt_requested: Option<&std::sync::atomic::AtomicBool>,
    stage_id: Option<&str>,
    on_step: &mut (dyn FnMut(StepUpdate) -> StepAction + Send),
) -> Result<HysteresisAdaptiveRefinementRun, RunError> {
    let backend_plan = &plan.backend_plan;
    let source_points: Vec<HysteresisPoint> = major_states
        .iter()
        .map(|state| state.point.clone())
        .collect();
    let mut artifact = build_hysteresis_adaptive_refinement_artifact(Some(policy), &source_points)
        .expect("adaptive refinement policy should produce an artifact");
    let mut all_steps = Vec::new();
    let mut status = RunStatus::Completed;

    if !policy.enabled || artifact.candidates.is_empty() {
        return Ok(HysteresisAdaptiveRefinementRun {
            artifact,
            steps: all_steps,
            status,
        });
    }

    let candidates = artifact.candidates.clone();
    for (computed_index, candidate) in candidates.iter().enumerate() {
        let Some(parent) = major_states
            .iter()
            .find(|state| state.point.point_id == candidate.parent_left_point_id)
        else {
            continue;
        };

        let point_id = major_states.len() + computed_index;
        let field_Apm = field_mT_to_h_apm(candidate.field_value_mT);
        let field_vector_A_per_m = [field_Apm * u_H[0], field_Apm * u_H[1], field_Apm * u_H[2]];
        let solve_res = run_settle_at_field(
            backend_plan,
            problem,
            &parent.magnetization,
            field_vector_A_per_m,
            Some(HysteresisProgressContext {
                point_idx: Some(point_id),
                field_m_t: candidate.field_value_mT,
                point_role: "key_event",
                branch_id: parent.point.branch_id.clone(),
            }),
            settle_pipeline,
            until_seconds,
            field_every_n,
            display_selection,
            interrupt_requested,
            false,
            on_step,
        )?;
        status = combine_run_status(status, solve_res.executed_run.result.status);

        let magnetization = solve_res.executed_run.result.final_magnetization.clone();
        let point_quality =
            hysteresis_point_quality(solve_res.executed_run.result.status, &solve_res.trace);
        let m_avg = average_hysteresis_magnetization(&magnetization, averaging);
        let m_parallel = hysteresis_project_m_parallel(m_avg, u_meas);
        let (m_oop, m_ip) = hysteresis_oop_ip_components(m_avg, hysteresis_sample_normal());
        let point_non_converged = solve_res
            .trace
            .iter()
            .any(|entry| entry.status == "non_converged");
        let snapshot_context = HysteresisSnapshotDecisionContext {
            point_idx: point_id,
            field_value_mT: candidate.field_value_mT,
            previous_field_value_mT: Some(candidate.parent_left_field_mT),
            next_field_value_mT: Some(candidate.parent_right_field_mT),
            m_parallel,
            previous_m_parallel: Some(parent.point.m_parallel),
            status: solve_res.executed_run.result.status,
            non_converged: point_non_converged,
        };
        let snapshot_id = if should_store_hysteresis_snapshot(storage, snapshot_context) {
            Some(format!("hysteresis_adaptive_{:03}", computed_index + 1))
        } else {
            None
        };
        if let Some(snapshot_id) = snapshot_id.as_deref() {
            write_hysteresis_magnetization_snapshot(
                output_dir,
                snapshot_id,
                point_id,
                candidate.field_value_mT,
                hysteresis_magnetization_grid(plan, &magnetization),
                &magnetization,
                &averaging.weighting,
                averaging.weights.as_deref(),
                storage
                    .map(|policy| policy.magnetization.as_str())
                    .unwrap_or("unspecified"),
                HysteresisSnapshotIndexMetadata {
                    branch_id: parent.point.branch_id.as_deref(),
                    protocol_role: Some("adaptive"),
                },
            )?;
        }

        let point = HysteresisPoint {
            point_id,
            field_value_mT: candidate.field_value_mT,
            m_parallel,
            m_oop,
            m_ip,
            m_avg,
            status: point_quality.run_status.clone(),
            run_status: point_quality.run_status,
            settle_status: point_quality.settle_status,
            has_non_converged_steps: point_quality.has_non_converged_steps,
            terminal_settle_reason: point_quality.terminal_settle_reason,
            warning_count: point_quality.warning_count,
            snapshot_id,
            protocol_role: Some("adaptive".to_string()),
            branch_id: parent.point.branch_id.clone(),
            branch_ids: parent.point.branch_ids.clone(),
            branch_index: parent.point.branch_index,
            parent_branch_id: parent.point.branch_id.clone(),
            minor_loop_id: None,
            snapshot_resource_ref: None,
            snapshot_vector_resource_ref: None,
            snapshot_json_artifact_ref: None,
            snapshot_zarr_store_ref: None,
            snapshot_storage_format: None,
            field_vector_A_per_m: Some(field_vector_A_per_m),
            field_orientation: parent.point.field_orientation.clone(),
            measurement_axis: parent.point.measurement_axis.clone(),
            field_display_unit: Some("mT".to_string()),
            is_reversal_field: None,
            reversal_index: None,
            recoil_start_point_id: Some(parent.point.point_id),
            adaptive_inserted: Some(true),
            refinement_reason: Some(candidate.reasons.clone()),
            refinement_parent_left_point_id: Some(candidate.parent_left_point_id),
            refinement_parent_right_point_id: Some(candidate.parent_right_point_id),
        };

        artifact.points.push(point);
        artifact.settle_trace.extend(solve_res.trace);
        all_steps.extend(solve_res.executed_run.result.steps);
    }

    annotate_hysteresis_points_for_artifact(&mut artifact.points, stage_id);

    artifact.status = if artifact.points.is_empty() {
        "no_computed_points".to_string()
    } else {
        "computed".to_string()
    };

    Ok(HysteresisAdaptiveRefinementRun {
        artifact,
        steps: all_steps,
        status,
    })
}

fn run_hysteresis_minor_loops(
    configured_loops: &[fullmag_ir::MinorLoopIR],
    major_states: &[HysteresisMajorPointState],
    plan: &ExecutionPlanIR,
    problem: &ProblemIR,
    output_dir: &Path,
    u_H: [f64; 3],
    u_meas: [f64; 3],
    averaging: &HysteresisAveragingContext,
    storage: Option<&fullmag_ir::HysteresisStorageIR>,
    settle_pipeline: Option<&SettlePipelineIR>,
    until_seconds: f64,
    field_every_n: u64,
    display_selection: &(dyn Fn() -> crate::interactive::DisplaySelectionState + Send + Sync),
    interrupt_requested: Option<&std::sync::atomic::AtomicBool>,
    stage_id: Option<&str>,
    on_step: &mut (dyn FnMut(StepUpdate) -> StepAction + Send),
) -> Result<HysteresisMinorLoopRun, RunError> {
    let mut loops = Vec::new();
    let mut all_steps = Vec::new();
    let mut status = RunStatus::Completed;

    for (idx, configured) in configured_loops.iter().enumerate() {
        let Some(parent) = nearest_hysteresis_major_state(major_states, configured.reversal_mT)
        else {
            continue;
        };
        let loop_id = format!("minor_loop_{:03}", idx + 1);
        let reversal_field_mT = configured.reversal_mT;
        let reversal_field_Apm = field_mT_to_h_apm(reversal_field_mT);
        let reversal_field_vector_A_per_m = [
            reversal_field_Apm * u_H[0],
            reversal_field_Apm * u_H[1],
            reversal_field_Apm * u_H[2],
        ];
        let (reversal_magnetization, reversal_point, mut settle_trace) =
            if same_field_value(parent.point.field_value_mT, reversal_field_mT) {
                let mut point = parent.point.clone();
                point.point_id = 0;
                point.minor_loop_id = Some(loop_id.clone());
                point.parent_branch_id = parent.point.branch_id.clone();
                point.recoil_start_point_id = Some(parent.point.point_id);
                point.protocol_role = Some("minor".to_string());
                (parent.magnetization.clone(), point, Vec::new())
            } else {
                let reversal_res = run_settle_at_field(
                    &plan.backend_plan,
                    problem,
                    &parent.magnetization,
                    reversal_field_vector_A_per_m,
                    Some(HysteresisProgressContext {
                        point_idx: Some(0),
                        field_m_t: reversal_field_mT,
                        point_role: "minor",
                        branch_id: parent.point.branch_id.clone(),
                    }),
                    settle_pipeline,
                    until_seconds,
                    field_every_n,
                    display_selection,
                    interrupt_requested,
                    false,
                    on_step,
                )?;
                status = combine_run_status(status, reversal_res.executed_run.result.status);

                let magnetization = reversal_res.executed_run.result.final_magnetization.clone();
                let point_quality = hysteresis_point_quality(
                    reversal_res.executed_run.result.status,
                    &reversal_res.trace,
                );
                let m_avg = average_hysteresis_magnetization(&magnetization, averaging);
                let m_parallel = hysteresis_project_m_parallel(m_avg, u_meas);
                let (m_oop, m_ip) = hysteresis_oop_ip_components(m_avg, hysteresis_sample_normal());
                let point_non_converged = reversal_res
                    .trace
                    .iter()
                    .any(|entry| entry.status == "non_converged");
                let snapshot_context = HysteresisSnapshotDecisionContext {
                    point_idx: 0,
                    field_value_mT: reversal_field_mT,
                    previous_field_value_mT: Some(parent.point.field_value_mT),
                    next_field_value_mT: Some(configured.return_mT),
                    m_parallel,
                    previous_m_parallel: Some(parent.point.m_parallel),
                    status: reversal_res.executed_run.result.status,
                    non_converged: point_non_converged,
                };
                let snapshot_id = if should_store_hysteresis_snapshot(storage, snapshot_context) {
                    Some(format!("hysteresis_{}_reversal_{:03}", loop_id, 1))
                } else {
                    None
                };
                if let Some(snapshot_id) = snapshot_id.as_deref() {
                    write_hysteresis_magnetization_snapshot(
                        output_dir,
                        snapshot_id,
                        0,
                        reversal_field_mT,
                        hysteresis_magnetization_grid(plan, &magnetization),
                        &magnetization,
                        &averaging.weighting,
                        averaging.weights.as_deref(),
                        storage
                            .map(|policy| policy.magnetization.as_str())
                            .unwrap_or("unspecified"),
                        HysteresisSnapshotIndexMetadata {
                            branch_id: parent.point.branch_id.as_deref(),
                            protocol_role: Some("minor"),
                        },
                    )?;
                }

                let point = HysteresisPoint {
                    point_id: 0,
                    field_value_mT: reversal_field_mT,
                    m_parallel,
                    m_oop,
                    m_ip,
                    m_avg,
                    status: point_quality.run_status.clone(),
                    run_status: point_quality.run_status,
                    settle_status: point_quality.settle_status,
                    has_non_converged_steps: point_quality.has_non_converged_steps,
                    terminal_settle_reason: point_quality.terminal_settle_reason,
                    warning_count: point_quality.warning_count,
                    snapshot_id,
                    protocol_role: Some("minor".to_string()),
                    branch_id: parent.point.branch_id.clone(),
                    branch_ids: parent.point.branch_ids.clone(),
                    branch_index: parent.point.branch_index,
                    parent_branch_id: parent.point.branch_id.clone(),
                    minor_loop_id: Some(loop_id.clone()),
                    snapshot_resource_ref: None,
                    snapshot_vector_resource_ref: None,
                    snapshot_json_artifact_ref: None,
                    snapshot_zarr_store_ref: None,
                    snapshot_storage_format: None,
                    field_vector_A_per_m: Some(reversal_field_vector_A_per_m),
                    field_orientation: parent.point.field_orientation.clone(),
                    measurement_axis: parent.point.measurement_axis.clone(),
                    field_display_unit: Some("mT".to_string()),
                    is_reversal_field: Some(true),
                    reversal_index: Some(0),
                    recoil_start_point_id: Some(parent.point.point_id),
                    adaptive_inserted: None,
                    refinement_reason: None,
                    refinement_parent_left_point_id: None,
                    refinement_parent_right_point_id: None,
                };
                all_steps.extend(reversal_res.executed_run.result.steps);
                (magnetization, point, reversal_res.trace)
            };
        let return_field_mT = configured.return_mT;
        let return_field_Apm = field_mT_to_h_apm(return_field_mT);
        let field_vector_A_per_m = [
            return_field_Apm * u_H[0],
            return_field_Apm * u_H[1],
            return_field_Apm * u_H[2],
        ];
        let solve_res = run_settle_at_field(
            &plan.backend_plan,
            problem,
            &reversal_magnetization,
            field_vector_A_per_m,
            Some(HysteresisProgressContext {
                point_idx: Some(1),
                field_m_t: return_field_mT,
                point_role: "minor",
                branch_id: parent.point.branch_id.clone(),
            }),
            settle_pipeline,
            until_seconds,
            field_every_n,
            display_selection,
            interrupt_requested,
            false,
            on_step,
        )?;
        status = combine_run_status(status, solve_res.executed_run.result.status);

        let return_magnetization = solve_res.executed_run.result.final_magnetization.clone();
        let point_quality =
            hysteresis_point_quality(solve_res.executed_run.result.status, &solve_res.trace);
        let m_avg = average_hysteresis_magnetization(&return_magnetization, averaging);
        let m_parallel = hysteresis_project_m_parallel(m_avg, u_meas);
        let (m_oop, m_ip) = hysteresis_oop_ip_components(m_avg, hysteresis_sample_normal());
        let point_non_converged = solve_res
            .trace
            .iter()
            .any(|entry| entry.status == "non_converged");
        let snapshot_context = HysteresisSnapshotDecisionContext {
            point_idx: 1,
            field_value_mT: return_field_mT,
            previous_field_value_mT: Some(reversal_field_mT),
            next_field_value_mT: None,
            m_parallel,
            previous_m_parallel: Some(reversal_point.m_parallel),
            status: solve_res.executed_run.result.status,
            non_converged: point_non_converged,
        };
        let snapshot_id = if should_store_hysteresis_snapshot(storage, snapshot_context) {
            Some(format!("hysteresis_{}_return_{:03}", loop_id, 1))
        } else {
            None
        };
        if let Some(snapshot_id) = snapshot_id.as_deref() {
            write_hysteresis_magnetization_snapshot(
                output_dir,
                snapshot_id,
                1,
                return_field_mT,
                hysteresis_magnetization_grid(plan, &return_magnetization),
                &return_magnetization,
                &averaging.weighting,
                averaging.weights.as_deref(),
                storage
                    .map(|policy| policy.magnetization.as_str())
                    .unwrap_or("unspecified"),
                HysteresisSnapshotIndexMetadata {
                    branch_id: parent.point.branch_id.as_deref(),
                    protocol_role: Some("minor"),
                },
            )?;
        }

        let mut return_point = HysteresisPoint {
            point_id: 1,
            field_value_mT: return_field_mT,
            m_parallel,
            m_oop,
            m_ip,
            m_avg,
            status: point_quality.run_status.clone(),
            run_status: point_quality.run_status,
            settle_status: point_quality.settle_status,
            has_non_converged_steps: point_quality.has_non_converged_steps,
            terminal_settle_reason: point_quality.terminal_settle_reason,
            warning_count: point_quality.warning_count,
            snapshot_id,
            protocol_role: Some("minor".to_string()),
            branch_id: parent.point.branch_id.clone(),
            branch_ids: parent.point.branch_ids.clone(),
            branch_index: parent.point.branch_index,
            parent_branch_id: parent.point.branch_id.clone(),
            minor_loop_id: Some(loop_id.clone()),
            snapshot_resource_ref: None,
            snapshot_vector_resource_ref: None,
            snapshot_json_artifact_ref: None,
            snapshot_zarr_store_ref: None,
            snapshot_storage_format: None,
            field_vector_A_per_m: Some(field_vector_A_per_m),
            field_orientation: parent.point.field_orientation.clone(),
            measurement_axis: parent.point.measurement_axis.clone(),
            field_display_unit: Some("mT".to_string()),
            is_reversal_field: None,
            reversal_index: None,
            recoil_start_point_id: Some(parent.point.point_id),
            adaptive_inserted: None,
            refinement_reason: None,
            refinement_parent_left_point_id: None,
            refinement_parent_right_point_id: None,
        };

        let mut points = vec![reversal_point, return_point.clone()];
        annotate_hysteresis_points_for_artifact(&mut points, stage_id);
        return_point = points[1].clone();
        settle_trace.extend(solve_res.trace);
        let loop_artifact = HysteresisMinorLoop {
            loop_id,
            reversal_field_mT,
            return_field_mT,
            parent_branch_id: parent.point.branch_id.clone(),
            reversal_point_id: Some(0),
            return_point_id: Some(return_point.point_id),
            policy: Some("branch_only".to_string()),
            closure_status: Some("returned".to_string()),
            closure_error_m_parallel: minor_loop_closure_error_m_parallel(&points),
            recoil_susceptibility: minor_loop_recoil_susceptibility(&points),
            minor_loop_area: minor_loop_area_m_parallel(&points),
            settle_trace,
            points,
        };

        all_steps.extend(solve_res.executed_run.result.steps);
        loops.push(loop_artifact);
    }

    Ok(HysteresisMinorLoopRun {
        loops,
        steps: all_steps,
        status,
    })
}

fn nearest_hysteresis_major_state<'a>(
    states: &'a [HysteresisMajorPointState],
    field_mT: f64,
) -> Option<&'a HysteresisMajorPointState> {
    states.iter().min_by(|left, right| {
        let left_delta = (left.point.field_value_mT - field_mT).abs();
        let right_delta = (right.point.field_value_mT - field_mT).abs();
        left_delta.total_cmp(&right_delta)
    })
}

fn enrich_hysteresis_minor_loop(
    loop_id: String,
    reversal_field_mT: f64,
    return_field_mT: f64,
    mut selected_points: Vec<HysteresisPoint>,
    stage_points: &[HysteresisPoint],
    stage_id: Option<&str>,
) -> HysteresisMinorLoop {
    annotate_hysteresis_points_for_artifact(&mut selected_points, stage_id);

    let reversal_point_id = selected_points.first().map(|point| point.point_id);
    let return_point_id = selected_points.last().map(|point| point.point_id);
    let parent_branch_id = reversal_point_id
        .and_then(|point_id| {
            stage_points
                .iter()
                .find(|point| point.point_id == point_id)
                .and_then(|point| point.branch_id.clone())
        })
        .or_else(|| {
            selected_points
                .first()
                .and_then(|point| point.branch_id.clone())
        });

    for point in &mut selected_points {
        point.minor_loop_id = Some(loop_id.clone());
        point.protocol_role = Some("minor".to_string());
    }

    HysteresisMinorLoop {
        loop_id,
        reversal_field_mT,
        return_field_mT,
        parent_branch_id,
        reversal_point_id,
        return_point_id,
        policy: Some("derived_from_major_loop_window".to_string()),
        closure_status: selected_points.last().map(|point| {
            if same_field_value(point.field_value_mT, return_field_mT) {
                "returned"
            } else {
                "open"
            }
            .to_string()
        }),
        closure_error_m_parallel: minor_loop_closure_error_m_parallel(&selected_points),
        recoil_susceptibility: minor_loop_recoil_susceptibility(&selected_points),
        minor_loop_area: minor_loop_area_m_parallel(&selected_points),
        settle_trace: Vec::new(),
        points: selected_points,
    }
}

fn minor_loop_closure_error_m_parallel(points: &[HysteresisPoint]) -> Option<f64> {
    let first = points.first()?;
    let last = points.last()?;
    Some((last.m_parallel - first.m_parallel).abs())
}

fn minor_loop_recoil_susceptibility(points: &[HysteresisPoint]) -> Option<f64> {
    let first = points.first()?;
    let second = points.get(1)?;
    let field_delta = second.field_value_mT - first.field_value_mT;
    if field_delta.abs() <= 1e-15 {
        return None;
    }
    Some((second.m_parallel - first.m_parallel) / field_delta)
}

fn minor_loop_area_m_parallel(points: &[HysteresisPoint]) -> Option<f64> {
    if points.len() < 2 {
        return None;
    }

    let area = points
        .windows(2)
        .map(|window| {
            0.5 * (window[0].m_parallel + window[1].m_parallel)
                * (window[1].field_value_mT - window[0].field_value_mT)
        })
        .sum::<f64>()
        .abs();
    Some(area)
}

fn select_minor_loop_points(
    points: &[HysteresisPoint],
    reversal_mT: f64,
    return_mT: f64,
) -> Vec<HysteresisPoint> {
    if points.is_empty() {
        return Vec::new();
    }

    let mut best: Option<(usize, usize, f64)> = None;
    for start in 0..points.len() {
        for end in start..points.len() {
            let score = (points[start].field_value_mT - reversal_mT).abs()
                + (points[end].field_value_mT - return_mT).abs();
            if best.is_none_or(|(_, _, best_score)| score < best_score) {
                best = Some((start, end, score));
            }
        }
    }

    let Some((start, end, _)) = best else {
        return Vec::new();
    };
    points[start..=end].to_vec()
}

pub fn calculate_metrics(
    points: &[HysteresisPoint],
    initial_protocol: &str,
    saturation: Option<&fullmag_ir::SaturationProbeIR>,
    preparation_field_mT: Option<f64>,
) -> HysteresisMetrics {
    calculate_metrics_with_weighting(
        points,
        initial_protocol,
        saturation,
        preparation_field_mT,
        "uniform_sample_average",
    )
}

fn calculate_metrics_with_weighting(
    points: &[HysteresisPoint],
    initial_protocol: &str,
    saturation: Option<&fullmag_ir::SaturationProbeIR>,
    preparation_field_mT: Option<f64>,
    magnetization_average_weighting: &str,
) -> HysteresisMetrics {
    let mut H_c_plus = None;
    let mut H_c_minus = None;
    let mut M_r_plus = None;
    let mut M_r_minus = None;
    let mut loop_area = 0.0;

    for i in 1..points.len() {
        let p0 = &points[i - 1];
        let p1 = &points[i];

        loop_area +=
            0.5 * (p0.m_parallel + p1.m_parallel) * (p1.field_value_mT - p0.field_value_mT);

        if p0.m_parallel * p1.m_parallel <= 0.0 && (p1.m_parallel - p0.m_parallel).abs() > 1e-15 {
            let t = (0.0 - p0.m_parallel) / (p1.m_parallel - p0.m_parallel);
            let H_cross = p0.field_value_mT + t * (p1.field_value_mT - p0.field_value_mT);
            if p1.field_value_mT > p0.field_value_mT {
                H_c_plus = Some(H_cross);
            } else {
                H_c_minus = Some(H_cross);
            }
        }

        if p0.field_value_mT * p1.field_value_mT <= 0.0
            && (p1.field_value_mT - p0.field_value_mT).abs() > 1e-15
        {
            let t = (0.0 - p0.field_value_mT) / (p1.field_value_mT - p0.field_value_mT);
            let M_rem = p0.m_parallel + t * (p1.m_parallel - p0.m_parallel);
            if p1.field_value_mT > p0.field_value_mT {
                M_r_plus = Some(M_rem);
            } else {
                M_r_minus = Some(M_rem);
            }
        }
    }

    let H_c = match (H_c_plus, H_c_minus) {
        (Some(hp), Some(hm)) => Some((hp - hm) / 2.0),
        _ => None,
    };

    let H_eb = match (H_c_plus, H_c_minus) {
        (Some(hp), Some(hm)) => Some((hp + hm) / 2.0),
        _ => None,
    };

    let (max_differential_susceptibility, switching_field_candidates) =
        hysteresis_differential_susceptibility(points);
    let convergence_quality_summary = hysteresis_convergence_quality_summary(points);
    let loop_closure_summary = hysteresis_loop_closure_summary(points);
    let saturation_status =
        hysteresis_saturation_status(initial_protocol, saturation, preparation_field_mT);
    let warnings = hysteresis_metric_warnings(
        points,
        H_c_plus,
        H_c_minus,
        M_r_plus,
        M_r_minus,
        &saturation_status,
        &convergence_quality_summary,
        &loop_closure_summary,
    );
    let metric_statuses = hysteresis_metric_statuses(
        H_c_plus,
        H_c_minus,
        H_c,
        H_eb,
        M_r_plus,
        M_r_minus,
        if points.len() >= 2 {
            Some(loop_area)
        } else {
            None
        },
        max_differential_susceptibility,
        &saturation_status,
        &convergence_quality_summary,
        &loop_closure_summary,
    );

    HysteresisMetrics {
        H_c_plus,
        H_c_minus,
        H_c,
        H_eb,
        M_r_plus,
        M_r_minus,
        loop_area,
        magnetization_average_weighting: magnetization_average_weighting.to_string(),
        saturation_status,
        saturation_preparation_field_mT: preparation_field_mT,
        metric_statuses,
        loop_closure_summary,
        max_differential_susceptibility,
        switching_field_candidates,
        warnings,
        convergence_quality_summary,
    }
}

fn hysteresis_metric_statuses(
    H_c_plus: Option<f64>,
    H_c_minus: Option<f64>,
    H_c: Option<f64>,
    H_eb: Option<f64>,
    M_r_plus: Option<f64>,
    M_r_minus: Option<f64>,
    loop_area: Option<f64>,
    max_differential_susceptibility: Option<f64>,
    saturation_status: &str,
    convergence: &HysteresisConvergenceQualitySummary,
    loop_closure: &HysteresisLoopClosureSummary,
) -> BTreeMap<String, HysteresisMetricStatus> {
    let interpretive_warning =
        saturation_status != "saturated" && saturation_status != "not_requested";
    let convergence_warning = convergence.status == "warning";
    let mut statuses = BTreeMap::new();
    insert_metric_status(
        &mut statuses,
        "H_c_plus",
        H_c_plus,
        "positive coercive crossing",
        interpretive_warning,
        convergence_warning,
    );
    insert_metric_status(
        &mut statuses,
        "H_c_minus",
        H_c_minus,
        "negative coercive crossing",
        interpretive_warning,
        convergence_warning,
    );
    insert_metric_status(
        &mut statuses,
        "H_c",
        H_c,
        "both coercive crossings",
        interpretive_warning,
        convergence_warning,
    );
    insert_metric_status(
        &mut statuses,
        "H_eb",
        H_eb,
        "both coercive crossings",
        interpretive_warning,
        convergence_warning,
    );
    insert_metric_status(
        &mut statuses,
        "M_r_plus",
        M_r_plus,
        "positive branch zero-field interpolation",
        interpretive_warning,
        convergence_warning,
    );
    insert_metric_status(
        &mut statuses,
        "M_r_minus",
        M_r_minus,
        "negative branch zero-field interpolation",
        interpretive_warning,
        convergence_warning,
    );
    insert_loop_area_metric_status(&mut statuses, loop_area, convergence_warning, loop_closure);
    insert_metric_status(
        &mut statuses,
        "max_differential_susceptibility",
        max_differential_susceptibility,
        "at least one finite field interval",
        false,
        convergence_warning,
    );
    statuses
}

fn hysteresis_loop_closure_summary(points: &[HysteresisPoint]) -> HysteresisLoopClosureSummary {
    let Some(first) = points.first() else {
        return HysteresisLoopClosureSummary {
            status: "unavailable".to_string(),
            field_gap_mT: 0.0,
            m_parallel_gap: 0.0,
            reason: "Loop closure requires at least two settled points.".to_string(),
        };
    };
    let Some(last) = points.last() else {
        return HysteresisLoopClosureSummary {
            status: "unavailable".to_string(),
            field_gap_mT: 0.0,
            m_parallel_gap: 0.0,
            reason: "Loop closure requires at least two settled points.".to_string(),
        };
    };
    if points.len() < 2 {
        return HysteresisLoopClosureSummary {
            status: "unavailable".to_string(),
            field_gap_mT: 0.0,
            m_parallel_gap: 0.0,
            reason: "Loop closure requires at least two settled points.".to_string(),
        };
    }
    let field_gap_mT = last.field_value_mT - first.field_value_mT;
    let m_parallel_gap = last.m_parallel - first.m_parallel;
    let field_returned = field_gap_mT.abs() <= 1.0e-9;
    let magnetization_returned = m_parallel_gap.abs() <= 5.0e-2;
    let (status, reason) = if field_returned && magnetization_returned {
        (
            "closed",
            "First and last points return to the same field with small m_parallel closure error.",
        )
    } else if field_returned {
        (
            "open",
            "First and last points return to the same field, but m_parallel closure error remains large.",
        )
    } else {
        (
            "open",
            "First and last points do not return to the same applied field.",
        )
    };
    HysteresisLoopClosureSummary {
        status: status.to_string(),
        field_gap_mT,
        m_parallel_gap,
        reason: reason.to_string(),
    }
}

fn insert_loop_area_metric_status(
    statuses: &mut BTreeMap<String, HysteresisMetricStatus>,
    value: Option<f64>,
    convergence_warning: bool,
    loop_closure: &HysteresisLoopClosureSummary,
) {
    let finite = value.is_some_and(f64::is_finite);
    let (status, reason) = if !finite {
        (
            "unavailable",
            "Metric requires at least two settled points, which are unavailable in this loop."
                .to_string(),
        )
    } else if convergence_warning {
        (
            "warning",
            "Metric value exists, but one or more field points have convergence warnings."
                .to_string(),
        )
    } else if loop_closure.status != "closed" {
        (
            "warning",
            format!(
                "Metric value exists, but loop closure is '{}': {}",
                loop_closure.status, loop_closure.reason
            ),
        )
    } else {
        ("available", "Metric value is available.".to_string())
    };
    statuses.insert(
        "loop_area".to_string(),
        HysteresisMetricStatus {
            status: status.to_string(),
            reason,
        },
    );
}

fn insert_metric_status(
    statuses: &mut BTreeMap<String, HysteresisMetricStatus>,
    metric_id: &str,
    value: Option<f64>,
    requirement: &str,
    interpretive_warning: bool,
    convergence_warning: bool,
) {
    let finite = value.is_some_and(f64::is_finite);
    let (status, reason) = if !finite {
        (
            "unavailable",
            format!("Metric requires {requirement}, which is unavailable in this loop."),
        )
    } else if convergence_warning {
        (
            "warning",
            "Metric value exists, but one or more field points have convergence warnings."
                .to_string(),
        )
    } else if interpretive_warning {
        (
            "warning",
            "Metric value exists, but saturation was not verified for this loop.".to_string(),
        )
    } else {
        ("available", "Metric value is available.".to_string())
    };
    statuses.insert(
        metric_id.to_string(),
        HysteresisMetricStatus {
            status: status.to_string(),
            reason,
        },
    );
}

fn hysteresis_differential_susceptibility(
    points: &[HysteresisPoint],
) -> (Option<f64>, Vec<HysteresisSwitchingFieldCandidate>) {
    let mut candidates = Vec::new();
    let mut max_abs = None::<f64>;
    for pair in points.windows(2) {
        let p0 = &pair[0];
        let p1 = &pair[1];
        let d_h = p1.field_value_mT - p0.field_value_mT;
        if !d_h.is_finite() || d_h.abs() <= 1.0e-15 {
            continue;
        }
        let susceptibility = (p1.m_parallel - p0.m_parallel) / d_h;
        if !susceptibility.is_finite() {
            continue;
        }
        let abs_susceptibility = susceptibility.abs();
        max_abs = Some(max_abs.map_or(abs_susceptibility, |current| {
            current.max(abs_susceptibility)
        }));
        candidates.push(HysteresisSwitchingFieldCandidate {
            field_value_mT: 0.5 * (p0.field_value_mT + p1.field_value_mT),
            susceptibility_per_mT: susceptibility,
            point_id_before: p0.point_id,
            point_id_after: p1.point_id,
            branch_id: p0.branch_id.clone().or_else(|| p1.branch_id.clone()),
        });
    }
    candidates.sort_by(|a, b| {
        b.susceptibility_per_mT
            .abs()
            .partial_cmp(&a.susceptibility_per_mT.abs())
            .unwrap_or(std::cmp::Ordering::Equal)
    });
    candidates.truncate(5);
    (max_abs, candidates)
}

fn hysteresis_convergence_quality_summary(
    points: &[HysteresisPoint],
) -> HysteresisConvergenceQualitySummary {
    let total_points = points.len();
    let is_warning = |point: &HysteresisPoint| {
        point.warning_count > 0 || point.status.eq_ignore_ascii_case("warning")
    };
    let is_non_converged = |point: &HysteresisPoint| {
        point.has_non_converged_steps
            || point.settle_status.eq_ignore_ascii_case("failed")
            || point.run_status.eq_ignore_ascii_case("failed")
    };
    let warning_points = points.iter().filter(|point| is_warning(point)).count();
    let non_converged_points = points
        .iter()
        .filter(|point| is_non_converged(point))
        .count();
    let converged_points = points
        .iter()
        .filter(|point| !is_warning(point) && !is_non_converged(point))
        .count();
    let status = if total_points == 0 {
        "empty"
    } else if non_converged_points > 0 {
        "warning"
    } else if warning_points > 0 {
        "warning"
    } else {
        "converged"
    }
    .to_string();
    HysteresisConvergenceQualitySummary {
        status,
        total_points,
        converged_points,
        warning_points,
        non_converged_points,
    }
}

fn hysteresis_metric_warnings(
    points: &[HysteresisPoint],
    H_c_plus: Option<f64>,
    H_c_minus: Option<f64>,
    M_r_plus: Option<f64>,
    M_r_minus: Option<f64>,
    saturation_status: &str,
    convergence: &HysteresisConvergenceQualitySummary,
    loop_closure: &HysteresisLoopClosureSummary,
) -> Vec<String> {
    let mut warnings = Vec::new();
    if points.len() < 3 {
        warnings.push(
            "At least three settled field points are recommended for hysteresis metrics."
                .to_string(),
        );
    }
    if H_c_plus.is_none() {
        warnings.push("Positive coercive crossing is unavailable.".to_string());
    }
    if H_c_minus.is_none() {
        warnings.push("Negative coercive crossing is unavailable.".to_string());
    }
    if M_r_plus.is_none() {
        warnings.push("Positive-branch remanence interpolation is unavailable.".to_string());
    }
    if M_r_minus.is_none() {
        warnings.push("Negative-branch remanence interpolation is unavailable.".to_string());
    }
    if saturation_status != "saturated" && saturation_status != "not_requested" {
        warnings.push(format!(
            "Saturation status is '{saturation_status}', so coercivity and remanence interpretation is limited."
        ));
    }
    if convergence.non_converged_points > 0 {
        warnings.push(format!(
            "{} field point(s) include non-converged settle steps.",
            convergence.non_converged_points
        ));
    } else if convergence.warning_points > 0 {
        warnings.push(format!(
            "{} field point(s) include settle warnings.",
            convergence.warning_points
        ));
    }
    if loop_closure.status != "closed" {
        warnings.push(format!(
            "Loop area is reported with '{}' closure status: {}",
            loop_closure.status, loop_closure.reason
        ));
    }
    warnings
}

fn hysteresis_saturation_status(
    initial_protocol: &str,
    saturation: Option<&fullmag_ir::SaturationProbeIR>,
    preparation_field_mT: Option<f64>,
) -> String {
    match initial_protocol {
        "positive_saturation" | "negative_saturation" => {
            if preparation_field_mT.is_none() {
                "not_evaluated".to_string()
            } else if saturation.is_some() {
                "preparation_applied_unverified".to_string()
            } else {
                "preparation_from_schedule_unverified".to_string()
            }
        }
        _ => "not_requested".to_string(),
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn hysteresis_settle_step_method_selects_runtime_algorithm() {
        let relax_ncg = SettleStepIR::Relax {
            method: "nonlinear_cg".to_string(),
            alpha: 1.0,
            torque_tolerance: 1e-5,
            max_steps: 100,
            applies_to: None,
            stop_criteria: None,
            timestep_s: None,
            max_pseudotime_s: None,
            max_physical_time_s: None,
            on_non_convergence: "continue_with_warning".to_string(),
            retry_timestep_scale: None,
            retry_max_attempts: None,
        };
        assert_eq!(
            settle_step_relaxation_control(&relax_ncg)
                .expect("nonlinear_cg relax step should map")
                .algorithm,
            RelaxationAlgorithmIR::NonlinearCg
        );

        let minimize_tpi = SettleStepIR::Minimize {
            method: "tangent_plane_implicit".to_string(),
            torque_tolerance: 1e-5,
            energy_tolerance: 1e-20,
            max_steps: 100,
            applies_to: None,
            stop_criteria: None,
            timestep_s: None,
            max_pseudotime_s: None,
            max_physical_time_s: None,
            on_non_convergence: "continue_with_warning".to_string(),
            retry_timestep_scale: None,
            retry_max_attempts: None,
        };
        assert_eq!(
            settle_step_relaxation_control(&minimize_tpi)
                .expect("tangent_plane_implicit minimize step should map")
                .algorithm,
            RelaxationAlgorithmIR::TangentPlaneImplicit
        );

        let dynamics = SettleStepIR::DynamicsSettle {
            method: "heun_dynamics_settle".to_string(),
            damping: 1.0,
            max_steps: 100,
            applies_to: None,
            stop_criteria: None,
            timestep_s: None,
            max_pseudotime_s: None,
            max_physical_time_s: None,
            on_non_convergence: "continue_with_warning".to_string(),
            retry_timestep_scale: None,
            retry_max_attempts: None,
        };
        assert_eq!(
            settle_step_relaxation_control(&dynamics)
                .expect("heun dynamics settle should map")
                .algorithm,
            RelaxationAlgorithmIR::LlgOverdamped
        );
    }

    #[test]
    fn hysteresis_settle_step_method_rejects_unknown_runtime_algorithm() {
        let step = SettleStepIR::Minimize {
            method: "unknown_method".to_string(),
            torque_tolerance: 1e-5,
            energy_tolerance: 1e-20,
            max_steps: 100,
            applies_to: None,
            stop_criteria: None,
            timestep_s: None,
            max_pseudotime_s: None,
            max_physical_time_s: None,
            on_non_convergence: "continue_with_warning".to_string(),
            retry_timestep_scale: None,
            retry_max_attempts: None,
        };

        let error = settle_step_relaxation_control(&step)
            .expect_err("unknown settle method should fail explicitly");
        assert_eq!(
            error.message,
            "unsupported hysteresis minimize method 'unknown_method'"
        );
    }

    fn minimal_fdm_hysteresis_problem() -> ProblemIR {
        let mut problem = ProblemIR::bootstrap_example();
        problem.problem_meta.entrypoint_kind = "flat_hysteresis".to_string();
        problem.geometry = fullmag_ir::GeometryIR {
            entries: vec![fullmag_ir::GeometryEntryIR::Box {
                name: "cell".to_string(),
                size: [2e-9, 2e-9, 2e-9],
            }],
        };
        problem.regions = vec![fullmag_ir::RegionIR {
            name: "cell".to_string(),
            geometry: "cell".to_string(),
        }];
        problem.magnets = vec![fullmag_ir::MagnetIR {
            name: "cell".to_string(),
            region: "cell".to_string(),
            material: "Py".to_string(),
            initial_magnetization: Some(fullmag_ir::InitialMagnetizationIR::Uniform {
                value: [1.0, 0.0, 0.0],
            }),
        }];
        problem.energy_terms = vec![fullmag_ir::EnergyTermIR::Exchange];
        problem.backend_policy.requested_backend = fullmag_ir::BackendTarget::Fdm;
        problem.backend_policy.discretization_hints = Some(fullmag_ir::DiscretizationHintsIR {
            fdm: Some(fullmag_ir::FdmHintsIR {
                cell: [2e-9, 2e-9, 2e-9],
                default_cell: None,
                per_magnet: None,
                demag: None,
                boundary_correction: None,
                boundary_phi_floor: None,
                boundary_delta_min: None,
            }),
            fem: None,
            hybrid: None,
        });
        problem.study = StudyIR::Hysteresis {
            field_min_mT: Some(100.0),
            field_max_mT: Some(100.0),
            field_step_mT: Some(100.0),
            field_values_mT: Some(vec![100.0]),
            field_unit_provenance: None,
            direction: None,
            orientation: Some(FieldOrientationIR::Preset {
                preset_name: "oop_positive".to_string(),
            }),
            measurement_axis: MeasurementAxisIR::field_axis(),
            angular_family: None,
            initial_protocol: "as_authored".to_string(),
            initial_state_ref: None,
            saturation: None,
            branch_mode: "major_loop".to_string(),
            settle_pipeline: Some(SettlePipelineIR::Sequence {
                steps: vec![SettleStepIR::Relax {
                    method: "llg_overdamped".to_string(),
                    alpha: 1.0,
                    torque_tolerance: 1.0e-3,
                    max_steps: 4,
                    applies_to: None,
                    stop_criteria: None,
                    timestep_s: None,
                    max_pseudotime_s: None,
                    max_physical_time_s: None,
                    on_non_convergence: "continue_with_warning".to_string(),
                    retry_timestep_scale: None,
                    retry_max_attempts: None,
                }],
            }),
            storage: Some(fullmag_ir::HysteresisStorageIR {
                scalar_history: true,
                magnetization: "none".to_string(),
                every_n: 1,
                key_events: false,
                key_event_threshold_dm: 0.02,
            }),
            field_schedule: None,
            schedule_refinements: None,
            adaptive_refinement: None,
            minor_loops: None,
            sampling: fullmag_ir::SamplingIR {
                table_autosave: None,
                outputs: vec![fullmag_ir::OutputIR::Scalar {
                    name: "mz".to_string(),
                    every_seconds: 1.0e-13,
                }],
            },
        };
        problem
    }

    fn test_hysteresis_point(
        point_id: usize,
        field_value_mT: f64,
        m_parallel: f64,
        snapshot_id: Option<&str>,
    ) -> HysteresisPoint {
        HysteresisPoint {
            point_id,
            field_value_mT,
            m_parallel,
            m_oop: m_parallel,
            m_ip: 0.0,
            m_avg: [0.0, 0.0, m_parallel],
            status: "Completed".to_string(),
            run_status: "Completed".to_string(),
            settle_status: "converged".to_string(),
            has_non_converged_steps: false,
            terminal_settle_reason: Some("converged".to_string()),
            warning_count: 0,
            snapshot_id: snapshot_id.map(str::to_string),
            protocol_role: None,
            branch_id: None,
            branch_ids: None,
            branch_index: None,
            parent_branch_id: None,
            minor_loop_id: None,
            snapshot_resource_ref: None,
            snapshot_vector_resource_ref: None,
            snapshot_json_artifact_ref: None,
            snapshot_zarr_store_ref: None,
            snapshot_storage_format: None,
            field_vector_A_per_m: None,
            field_orientation: None,
            measurement_axis: None,
            field_display_unit: None,
            is_reversal_field: None,
            reversal_index: None,
            recoil_start_point_id: None,
            adaptive_inserted: None,
            refinement_reason: None,
            refinement_parent_left_point_id: None,
            refinement_parent_right_point_id: None,
        }
    }

    fn assert_axis_close(actual: [f64; 3], expected: [f64; 3]) {
        for i in 0..3 {
            assert!(
                (actual[i] - expected[i]).abs() < 1.0e-12,
                "axis component {i} mismatch: actual={actual:?} expected={expected:?}"
            );
        }
    }

    #[test]
    fn hysteresis_field_axis_resolves_oop_in_plane_and_global_vectors() {
        assert_axis_close(
            hysteresis_field_axis(
                Some(&FieldOrientationIR::Preset {
                    preset_name: "oop_positive".to_string(),
                }),
                None,
            ),
            [0.0, 0.0, 1.0],
        );
        assert_axis_close(
            hysteresis_field_axis(
                Some(&FieldOrientationIR::Preset {
                    preset_name: "oop_negative".to_string(),
                }),
                None,
            ),
            [0.0, 0.0, -1.0],
        );
        assert_axis_close(
            hysteresis_field_axis(
                Some(&FieldOrientationIR::Preset {
                    preset_name: "in_plane_x".to_string(),
                }),
                None,
            ),
            [1.0, 0.0, 0.0],
        );
        assert_axis_close(
            hysteresis_field_axis(
                Some(&FieldOrientationIR::Preset {
                    preset_name: "in_plane_y".to_string(),
                }),
                None,
            ),
            [0.0, 1.0, 0.0],
        );
        assert_axis_close(
            hysteresis_field_axis(
                Some(&FieldOrientationIR::Global {
                    vector: [0.0, 3.0, 4.0],
                }),
                None,
            ),
            [0.0, 0.6, 0.8],
        );
        assert_axis_close(
            hysteresis_field_axis(None, Some([2.0, 0.0, 0.0])),
            [1.0, 0.0, 0.0],
        );
    }

    #[test]
    fn hysteresis_field_axis_resolves_custom_sample_angles_in_degrees() {
        let axis = hysteresis_field_axis(
            Some(&FieldOrientationIR::Sample {
                theta: 90.0,
                phi: 35.0,
            }),
            None,
        );
        let phi_rad = 35.0_f64.to_radians();

        assert_axis_close(axis, [phi_rad.cos(), phi_rad.sin(), 0.0]);
        assert!(
            (vector_norm(axis) - 1.0).abs() < 1.0e-12,
            "custom-angle axis must stay normalized, got {axis:?}"
        );
    }

    #[test]
    fn custom_angle_measurement_projection_uses_selected_axis() {
        let problem = minimal_fdm_hysteresis_problem();
        let plan = fullmag_plan::plan(&problem).expect("minimal hysteresis plan");
        let field_axis = hysteresis_field_axis(
            Some(&FieldOrientationIR::Sample {
                theta: 90.0,
                phi: 35.0,
            }),
            None,
        );
        let sample_normal = hysteresis_measurement_axis(
            &MeasurementAxisIR::Named("sample_normal".to_string()),
            field_axis,
            &plan,
        )
        .expect("sample_normal measurement axis should resolve");

        assert!(
            (hysteresis_project_m_parallel(field_axis, field_axis) - 1.0).abs() < 1.0e-12,
            "field-axis measurement should project a field-aligned state to one"
        );
        assert!(
            hysteresis_project_m_parallel(field_axis, sample_normal).abs() < 1.0e-12,
            "sample-normal measurement should remain independent from an in-plane custom field"
        );
    }

    #[test]
    fn easy_axis_measurement_projection_uses_material_anisotropy_axis() {
        let mut problem = minimal_fdm_hysteresis_problem();
        let material = problem
            .materials
            .iter_mut()
            .find(|material| material.name == "Py")
            .expect("minimal problem should contain Py material");
        material.anisotropy_axis = Some([0.0, 2.0, 0.0]);
        let plan = fullmag_plan::plan(&problem).expect("minimal hysteresis plan");
        let field_axis = [1.0, 0.0, 0.0];
        let easy_axis = hysteresis_measurement_axis(
            &MeasurementAxisIR::Named("easy_axis".to_string()),
            field_axis,
            &plan,
        )
        .expect("easy_axis measurement axis should resolve");

        assert_axis_close(easy_axis, [0.0, 1.0, 0.0]);
        assert!(
            hysteresis_project_m_parallel(field_axis, easy_axis).abs() < 1.0e-12,
            "easy-axis measurement should not alias to field_axis"
        );
    }

    #[test]
    fn custom_measurement_axis_uses_explicit_ir_vector() {
        let problem = minimal_fdm_hysteresis_problem();
        let plan = fullmag_plan::plan(&problem).expect("minimal hysteresis plan");
        let custom_axis = hysteresis_measurement_axis(
            &MeasurementAxisIR::Custom {
                kind: "custom".to_string(),
                vector: [0.0, 3.0, 4.0],
            },
            [1.0, 0.0, 0.0],
            &plan,
        )
        .expect("custom measurement axis should resolve");

        assert_axis_close(custom_axis, [0.0, 0.6, 0.8]);
        assert!(
            hysteresis_project_m_parallel([0.0, 0.6, 0.8], custom_axis) > 0.999_999_999,
            "custom measurement axis should project against its explicit vector"
        );
    }

    #[test]
    fn oop_ip_components_use_resolved_sample_normal() {
        let m_avg = [0.0, 0.6, 0.8];

        let default_components = hysteresis_oop_ip_components(m_avg, hysteresis_sample_normal());
        assert!((default_components.0 - 0.8).abs() < 1.0e-12);
        assert!((default_components.1 - 0.6).abs() < 1.0e-12);

        let tilted_components = hysteresis_oop_ip_components(m_avg, [0.0, 1.0, 0.0]);
        assert!((tilted_components.0 - 0.6).abs() < 1.0e-12);
        assert!((tilted_components.1 - 0.8).abs() < 1.0e-12);
    }

    #[test]
    fn hysteresis_field_mT_converts_to_backend_h_apm() {
        let converted = field_mT_to_h_apm(100.0);

        assert!((converted - 79_577.471_545_947_67).abs() < 1.0e-9);
        assert_eq!(field_mT_to_h_apm(0.0), 0.0);
        assert!((field_mT_to_h_apm(-50.0) + 39_788.735_772_973_84).abs() < 1.0e-9);
    }

    #[test]
    fn hysteresis_live_update_adapter_preserves_backend_payload_and_adds_progress() {
        let step = SettleStepIR::Relax {
            method: "llg_overdamped".to_string(),
            alpha: 1.0,
            torque_tolerance: 1e-5,
            max_steps: 10000,
            applies_to: None,
            stop_criteria: None,
            timestep_s: None,
            max_pseudotime_s: None,
            max_physical_time_s: None,
            on_non_convergence: "continue_with_warning".to_string(),
            retry_timestep_scale: None,
            retry_max_attempts: None,
        };
        let update = StepUpdate {
            stats: StepStats {
                step: 42,
                ..StepStats::default()
            },
            grid: [4, 1, 1],
            fem_mesh: None,
            magnetization: Some(vec![1.0, 0.0, 0.0, 0.0, 1.0, 0.0]),
            preview_field: None,
            cached_preview_fields: None,
            hysteresis_field_m_t: None,
            hysteresis_point_index: None,
            hysteresis_settle_step_index: None,
            hysteresis_settle_step_kind: None,
            hysteresis_settle_step_method: None,
            scalar_row_due: false,
            finished: false,
        };

        let annotated =
            annotate_hysteresis_live_update(update.clone(), Some((Some(3), -25.0, 1, &step)));

        assert_eq!(annotated.stats.step, 42);
        assert_eq!(annotated.grid, [4, 1, 1]);
        assert_eq!(annotated.magnetization.as_ref().map(Vec::len), Some(6));
        assert_eq!(annotated.hysteresis_field_m_t, Some(-25.0));
        assert_eq!(annotated.hysteresis_point_index, Some(3));
        assert_eq!(annotated.hysteresis_settle_step_index, Some(1));
        assert_eq!(
            annotated.hysteresis_settle_step_kind.as_deref(),
            Some("relax")
        );
        assert_eq!(
            annotated.hysteresis_settle_step_method.as_deref(),
            Some("llg_overdamped")
        );

        let saturation = annotate_hysteresis_live_update(update, Some((None, 300.0, 0, &step)));
        assert_eq!(saturation.hysteresis_field_m_t, Some(300.0));
        assert_eq!(saturation.hysteresis_point_index, None);
        assert_eq!(saturation.hysteresis_settle_step_index, Some(0));
    }

    #[test]
    fn hysteresis_pre_solver_update_reports_active_field_and_magnetization() {
        let step = SettleStepIR::Minimize {
            method: "projected_gradient_bb".to_string(),
            torque_tolerance: 5e-5,
            energy_tolerance: 1e-20,
            max_steps: 2000,
            applies_to: Some(serde_json::json!(["key_events", "minor"])),
            stop_criteria: Some(serde_json::json!({
                "kind": "any_of",
                "criteria": ["energy_delta_below", "m_delta_below"],
            })),
            timestep_s: None,
            max_pseudotime_s: None,
            max_physical_time_s: None,
            on_non_convergence: "run_next_algorithm".to_string(),
            retry_timestep_scale: None,
            retry_max_attempts: None,
        };
        let magnetization = vec![[1.0, 0.0, 0.0], [0.0, 1.0, 0.0]];
        let h_ext = [0.0, field_mT_to_h_apm(100.0), 0.0];
        let averaging = uniform_hysteresis_averaging_context();
        let stats = pre_solver_hysteresis_stats(&magnetization, h_ext, &averaging);
        let problem = minimal_fdm_hysteresis_problem();
        let plan = fullmag_plan::plan(&problem).expect("minimal hysteresis plan");
        let backend_plan = &plan.backend_plan;

        let update = hysteresis_progress_update(
            backend_plan,
            Some(0),
            100.0,
            0,
            &step,
            Some(&magnetization),
            Some(&stats),
        );

        assert_eq!(update.hysteresis_field_m_t, Some(100.0));
        assert_eq!(update.hysteresis_point_index, Some(0));
        assert_eq!(
            update.hysteresis_settle_step_kind.as_deref(),
            Some("minimize")
        );
        assert_eq!(
            update.hysteresis_settle_step_method.as_deref(),
            Some("projected_gradient_bb")
        );
        assert_eq!(update.grid, [1, 1, 1]);
        assert_eq!(update.magnetization.as_ref().map(Vec::len), Some(6));
        assert!(update.stats.max_h_eff > 79_000.0);
        assert!(update.stats.max_torque_Apm > 79_000.0);
        assert!(update.stats.max_torque_T > 0.09);
        assert_eq!(update.stats.mx, 0.5);
        assert_eq!(update.stats.my, 0.5);
    }

    #[test]
    fn hysteresis_fdm_average_uses_ms_and_volume_fraction_weights() {
        let mut plan = fullmag_ir::FdmPlanIR {
            grid: fullmag_ir::GridDimensions { cells: [2, 1, 1] },
            initial_magnetization: vec![[1.0, 0.0, 0.0], [0.0, 1.0, 0.0]],
            material: fullmag_ir::FdmMaterialIR {
                saturation_magnetisation: 2.0,
                ..fullmag_ir::FdmMaterialIR::default()
            },
            ..fullmag_ir::FdmPlanIR::default()
        };
        plan.material.ms_field = Some(vec![2.0, 6.0]);
        plan.boundary_geometry = Some(fullmag_ir::BoundaryGeometryIR {
            volume_fraction: vec![1.0, 0.5],
            face_link_xp: vec![1.0; 2],
            face_link_xm: vec![1.0; 2],
            face_link_yp: vec![1.0; 2],
            face_link_ym: vec![1.0; 2],
            face_link_zp: vec![1.0; 2],
            face_link_zm: vec![1.0; 2],
            delta_xp: vec![0.0; 2],
            delta_xm: vec![0.0; 2],
            delta_yp: vec![0.0; 2],
            delta_ym: vec![0.0; 2],
            delta_zp: vec![0.0; 2],
            delta_zm: vec![0.0; 2],
            demag_corr_target_idx: Vec::new(),
            demag_corr_source_idx: Vec::new(),
            demag_corr_tensor: Vec::new(),
            demag_corr_stencil_size: 0,
        });

        let averaging = hysteresis_averaging_context(&BackendPlanIR::Fdm(plan));
        let m_avg =
            average_hysteresis_magnetization(&[[1.0, 0.0, 0.0], [0.0, 1.0, 0.0]], &averaging);

        assert_eq!(averaging.weighting, "moment_weighted_fdm_ms_volume");
        assert!((m_avg[0] - 0.4).abs() < 1.0e-12);
        assert!((m_avg[1] - 0.6).abs() < 1.0e-12);
        assert_eq!(m_avg[2], 0.0);
    }

    #[test]
    fn hysteresis_fem_average_uses_p1_lumped_ms_volume_weights() {
        let plan = fullmag_ir::FemPlanIR {
            mesh_name: "two_tets".to_string(),
            mesh_source: None,
            mesh: fullmag_ir::MeshIR {
                mesh_name: "two_tets".to_string(),
                nodes: vec![
                    [0.0, 0.0, 0.0],
                    [1.0, 0.0, 0.0],
                    [0.0, 1.0, 0.0],
                    [0.0, 0.0, 1.0],
                    [2.0, 0.0, 0.0],
                ],
                elements: vec![[0, 1, 2, 3], [1, 2, 3, 4]],
                element_markers: vec![1, 1],
                boundary_faces: Vec::new(),
                boundary_markers: Vec::new(),
                periodic_boundary_pairs: Vec::new(),
                periodic_node_pairs: Vec::new(),
                per_domain_quality: std::collections::HashMap::new(),
            },
            object_segments: Vec::new(),
            mesh_parts: Vec::new(),
            domain_mesh_mode: fullmag_ir::FemDomainMeshModeIR::MergedMagneticMesh,
            domain_frame: None,
            fe_order: 1,
            hmax: 1.0,
            initial_magnetization: vec![[1.0, 0.0, 0.0]; 5],
            material: fullmag_ir::MaterialIR {
                name: "mat".to_string(),
                saturation_magnetisation: 1.0,
                exchange_stiffness: 1.0e-11,
                damping: 0.01,
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
            ms_element_field: Some(vec![1.0, 3.0]),
            a_element_field: None,
            region_materials: Vec::new(),
            enable_exchange: true,
            enable_demag: false,
            external_field: None,
            antenna_zeeman_masks: Vec::new(),
            current_modules: Vec::new(),
            gyromagnetic_ratio: 2.211e5,
            precision: fullmag_ir::ExecutionPrecision::Double,
            exchange_bc: fullmag_ir::ExchangeBoundaryCondition::Neumann,
            integrator: fullmag_ir::IntegratorChoice::Heun,
            fixed_timestep: Some(1.0e-13),
            adaptive_timestep: None,
            field_refresh: None,
            relaxation: None,
            demag_realization: None,
            air_box_config: None,
            interfacial_dmi: None,
            dmi_interface_normal: None,
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
            use_consistent_mass: None,
        };

        let averaging = hysteresis_averaging_context(&BackendPlanIR::Fem(plan));
        let m_avg = average_hysteresis_magnetization(
            &[
                [1.0, 0.0, 0.0],
                [1.0, 0.0, 0.0],
                [1.0, 0.0, 0.0],
                [1.0, 0.0, 0.0],
                [0.0, 1.0, 0.0],
            ],
            &averaging,
        );

        assert_eq!(
            averaging.weighting,
            "moment_weighted_fem_p1_lumped_ms_volume"
        );
        assert!((m_avg[0] - 13.0 / 16.0).abs() < 1.0e-12);
        assert!((m_avg[1] - 3.0 / 16.0).abs() < 1.0e-12);
        assert_eq!(m_avg[2], 0.0);
    }

    #[test]
    fn hysteresis_metrics_report_runtime_average_weighting() {
        let points = vec![
            test_hysteresis_point(0, 100.0, 1.0, None),
            test_hysteresis_point(1, -100.0, -1.0, None),
        ];

        let metrics = calculate_metrics_with_weighting(
            &points,
            "major_loop",
            None,
            None,
            "moment_weighted_fdm_ms_volume",
        );

        assert_eq!(
            metrics.magnetization_average_weighting,
            "moment_weighted_fdm_ms_volume"
        );
    }

    #[test]
    fn hysteresis_metrics_report_switching_candidates_and_warnings() {
        let points = vec![
            test_hysteresis_point(0, 100.0, 0.95, None),
            test_hysteresis_point(1, 20.0, 0.90, None),
            test_hysteresis_point(2, 10.0, 0.10, None),
            test_hysteresis_point(3, 0.0, -0.85, None),
            test_hysteresis_point(4, -100.0, -0.95, None),
        ];

        let metrics = calculate_metrics_with_weighting(
            &points,
            "positive_saturation",
            None,
            None,
            "uniform_sample_average",
        );

        assert!(
            (metrics.max_differential_susceptibility.unwrap() - 0.095).abs() < 1.0e-12,
            "expected strongest finite dm/dH across 10 mT switching interval"
        );
        assert_eq!(metrics.switching_field_candidates[0].point_id_before, 2);
        assert_eq!(metrics.switching_field_candidates[0].point_id_after, 3);
        assert_eq!(metrics.convergence_quality_summary.status, "converged");
        assert_eq!(metrics.metric_statuses["H_c_plus"].status, "unavailable");
        assert_eq!(metrics.metric_statuses["H_c_minus"].status, "warning");
        assert_eq!(
            metrics.metric_statuses["max_differential_susceptibility"].status,
            "available"
        );
        assert_eq!(metrics.loop_closure_summary.status, "open");
        assert_eq!(metrics.metric_statuses["loop_area"].status, "warning");
        assert!(metrics
            .warnings
            .iter()
            .any(|warning| warning.contains("Positive coercive crossing")));
        assert!(metrics
            .warnings
            .iter()
            .any(|warning| warning.contains("Saturation status is 'not_evaluated'")));
        assert!(metrics
            .warnings
            .iter()
            .any(|warning| warning.contains("Loop area is reported with 'open'")));
    }

    #[test]
    fn hysteresis_metrics_mark_loop_area_available_for_closed_loop() {
        let points = vec![
            test_hysteresis_point(0, 100.0, 0.8, None),
            test_hysteresis_point(1, 0.0, 0.0, None),
            test_hysteresis_point(2, -100.0, -0.8, None),
            test_hysteresis_point(3, 0.0, 0.0, None),
            test_hysteresis_point(4, 100.0, 0.82, None),
        ];

        let metrics = calculate_metrics_with_weighting(
            &points,
            "major_loop",
            None,
            None,
            "uniform_sample_average",
        );

        assert_eq!(metrics.loop_closure_summary.status, "closed");
        assert_eq!(metrics.metric_statuses["loop_area"].status, "available");
    }

    #[test]
    fn fdm_hysteresis_injects_field_and_changes_magnetization() {
        let problem = minimal_fdm_hysteresis_problem();
        let output_dir = std::env::temp_dir().join(format!(
            "fullmag-hysteresis-runner-test-{}",
            std::process::id()
        ));
        let _ = std::fs::remove_dir_all(&output_dir);
        let mut live_fields = Vec::new();

        let result = crate::run_problem_with_callback(&problem, 0.0, &output_dir, 1, |update| {
            if let Some(field) = update.hysteresis_field_m_t {
                live_fields.push(field);
            }
            StepAction::Continue
        })
        .expect("minimal hysteresis run should complete");

        assert!(
            live_fields
                .iter()
                .any(|field| (*field - 100.0).abs() < 1.0e-12),
            "live hysteresis updates must expose the active applied field, got {live_fields:?}"
        );
        assert!(
            result.steps.iter().any(|step| step.max_h_eff > 1.0),
            "nonzero hysteresis field must reach the backend H_eff path: {:?}",
            result.steps
        );
        assert!(
            result.final_magnetization[0][2] > 1.0e-6,
            "magnetization should rotate toward +z under positive OOP field, got {:?}",
            result.final_magnetization[0]
        );

        let _ = std::fs::remove_dir_all(&output_dir);
    }

    #[test]
    fn hysteresis_saturation_stop_stage_blocks_main_sweep_when_capped_by_limit() {
        let mut problem = minimal_fdm_hysteresis_problem();
        if let StudyIR::Hysteresis {
            initial_protocol,
            saturation,
            ..
        } = &mut problem.study
        {
            *initial_protocol = "positive_saturation".to_string();
            *saturation = Some(fullmag_ir::SaturationProbeIR {
                mode: "auto".to_string(),
                max_field_mT: 1.0,
                susceptibility_threshold: 1.0e-12,
                transverse_threshold: 1.0e-12,
                on_failure: "stop_stage".to_string(),
            });
        } else {
            panic!("minimal problem must be hysteresis");
        }

        let output_dir = std::env::temp_dir().join(format!(
            "fullmag-hysteresis-saturation-stop-stage-test-{}",
            std::process::id()
        ));
        let _ = std::fs::remove_dir_all(&output_dir);

        crate::run_problem_with_callback(&problem, 0.0, &output_dir, 1, |_| StepAction::Continue)
            .expect("capped saturation probe with stop_stage should end the stage cleanly");

        let saturation: HysteresisSaturationResult = serde_json::from_str(
            &std::fs::read_to_string(output_dir.join("hysteresis_saturation.json"))
                .expect("saturation artifact should be written"),
        )
        .expect("saturation artifact should decode");
        assert_eq!(saturation.status, "capped_by_limit");

        let points: Vec<HysteresisPoint> = serde_json::from_str(
            &std::fs::read_to_string(output_dir.join("hysteresis_points.json"))
                .expect("points artifact should be written"),
        )
        .expect("points artifact should decode");
        assert!(
            points.is_empty(),
            "stop_stage should not write ordinary major-loop points after capped saturation: {points:?}"
        );

        let metrics: HysteresisMetrics = serde_json::from_str(
            &std::fs::read_to_string(output_dir.join("hysteresis_metrics.json"))
                .expect("metrics artifact should be written"),
        )
        .expect("metrics artifact should decode");
        assert_eq!(metrics.saturation_status, "capped_by_limit");
        assert_eq!(metrics.saturation_preparation_field_mT, Some(1.0));

        let _ = std::fs::remove_dir_all(&output_dir);
    }

    #[test]
    fn hysteresis_runtime_writes_angular_family_manifest_for_active_variant() {
        let mut problem = minimal_fdm_hysteresis_problem();
        if let StudyIR::Hysteresis {
            orientation,
            angular_family,
            ..
        } = &mut problem.study
        {
            let active_orientation = FieldOrientationIR::Preset {
                preset_name: "oop_positive".to_string(),
            };
            *orientation = Some(active_orientation.clone());
            *angular_family = Some(fullmag_ir::HysteresisAngularFamilyIR {
                kind: "angular_family".to_string(),
                family_id: "oop_ip_family".to_string(),
                label: "OOP/IP comparison".to_string(),
                variants: vec![
                    fullmag_ir::HysteresisAngularVariantIR {
                        variant_id: "oop".to_string(),
                        orientation: active_orientation,
                        label: "OOP".to_string(),
                        measurement_axis: None,
                    },
                    fullmag_ir::HysteresisAngularVariantIR {
                        variant_id: "ip_x".to_string(),
                        orientation: FieldOrientationIR::Preset {
                            preset_name: "in_plane_x".to_string(),
                        },
                        label: "IP x".to_string(),
                        measurement_axis: None,
                    },
                ],
            });
        } else {
            panic!("minimal problem must be hysteresis");
        }

        let output_dir = std::env::temp_dir().join(format!(
            "fullmag-hysteresis-angular-family-test-{}",
            std::process::id()
        ));
        let _ = std::fs::remove_dir_all(&output_dir);

        crate::run_problem_with_callback(&problem, 0.0, &output_dir, 1, |_| StepAction::Continue)
            .expect("angular-family hysteresis run should complete");

        let artifact: HysteresisAngularFamilyArtifact = serde_json::from_str(
            &std::fs::read_to_string(output_dir.join("hysteresis_angular_family.json"))
                .expect("angular-family artifact should be written"),
        )
        .expect("angular-family artifact should decode");

        assert_eq!(artifact.family_id, "oop_ip_family");
        assert_eq!(artifact.active_variant_id.as_deref(), Some("oop"));
        assert_eq!(artifact.variants.len(), 2);
        let active = artifact
            .variants
            .iter()
            .find(|variant| variant.variant_id == "oop")
            .expect("active variant should be present");
        assert_eq!(active.data_status, "computed_active_stage");
        assert_eq!(active.point_count, 1);
        assert_eq!(
            active.points_path.as_deref(),
            Some("hysteresis_points.json")
        );
        assert_eq!(
            active.points_resource_ref,
            "/v2/sessions/current/analysis/hysteresis-family/stage_0/variants/oop/points"
        );
        assert_eq!(
            active.metrics_path.as_deref(),
            Some("hysteresis_metrics.json")
        );
        assert_eq!(
            active.settle_trace_path.as_deref(),
            Some("hysteresis_settle_trace.json")
        );

        let pending = artifact
            .variants
            .iter()
            .find(|variant| variant.variant_id == "ip_x")
            .expect("additional variant should be present");
        assert_eq!(pending.data_status, "computed_variant_run");
        assert_eq!(pending.point_count, 1);
        assert!(pending.points_path.is_some());
        assert_eq!(
            pending.points_resource_ref,
            "/v2/sessions/current/analysis/hysteresis-family/stage_0/variants/ip_x/points"
        );

        let _ = std::fs::remove_dir_all(&output_dir);
    }

    #[test]
    fn hysteresis_runtime_computes_additional_angular_family_variants() {
        let mut problem = minimal_fdm_hysteresis_problem();
        if let StudyIR::Hysteresis {
            orientation,
            angular_family,
            ..
        } = &mut problem.study
        {
            let active_orientation = FieldOrientationIR::Preset {
                preset_name: "oop_positive".to_string(),
            };
            *orientation = Some(active_orientation.clone());
            *angular_family = Some(fullmag_ir::HysteresisAngularFamilyIR {
                kind: "angular_family".to_string(),
                family_id: "oop_ip_family".to_string(),
                label: "OOP/IP comparison".to_string(),
                variants: vec![
                    fullmag_ir::HysteresisAngularVariantIR {
                        variant_id: "oop".to_string(),
                        orientation: active_orientation,
                        label: "OOP".to_string(),
                        measurement_axis: None,
                    },
                    fullmag_ir::HysteresisAngularVariantIR {
                        variant_id: "ip_x".to_string(),
                        orientation: FieldOrientationIR::Preset {
                            preset_name: "in_plane_x".to_string(),
                        },
                        label: "IP x".to_string(),
                        measurement_axis: None,
                    },
                ],
            });
        } else {
            panic!("minimal problem must be hysteresis");
        }

        let output_dir = std::env::temp_dir().join(format!(
            "fullmag-hysteresis-angular-family-multirun-test-{}",
            std::process::id()
        ));
        let _ = std::fs::remove_dir_all(&output_dir);

        crate::run_problem_with_callback(&problem, 0.0, &output_dir, 1, |_| StepAction::Continue)
            .expect("angular-family hysteresis run should complete");

        let artifact: HysteresisAngularFamilyArtifact = serde_json::from_str(
            &std::fs::read_to_string(output_dir.join("hysteresis_angular_family.json"))
                .expect("angular-family artifact should be written"),
        )
        .expect("angular-family artifact should decode");
        let ip_x = artifact
            .variants
            .iter()
            .find(|variant| variant.variant_id == "ip_x")
            .expect("additional variant should be present");

        assert_eq!(ip_x.data_status, "computed_variant_run");
        assert_eq!(ip_x.point_count, 1);
        assert_eq!(
            ip_x.points_resource_ref,
            "/v2/sessions/current/analysis/hysteresis-family/stage_0/variants/ip_x/points"
        );
        let points_path = ip_x
            .points_path
            .as_deref()
            .expect("additional variant should reference its points artifact");
        let points: Vec<HysteresisPoint> = serde_json::from_str(
            &std::fs::read_to_string(output_dir.join(points_path))
                .expect("additional variant points artifact should be written"),
        )
        .expect("additional variant points should decode");
        assert_eq!(points.len(), 1);
        assert!(
            points[0].m_parallel > 0.0,
            "additional in-plane variant should project magnetization on its own field axis: {:?}",
            points[0]
        );

        let _ = std::fs::remove_dir_all(&output_dir);
    }

    #[test]
    fn sample_normal_measurement_axis_projects_independently_from_field_axis() {
        let mut problem = minimal_fdm_hysteresis_problem();
        if let StudyIR::Hysteresis {
            orientation,
            measurement_axis,
            ..
        } = &mut problem.study
        {
            *orientation = Some(FieldOrientationIR::Preset {
                preset_name: "in_plane_x".to_string(),
            });
            *measurement_axis = MeasurementAxisIR::Named("sample_normal".to_string());
        } else {
            panic!("minimal problem must be hysteresis");
        }
        let output_dir = std::env::temp_dir().join(format!(
            "fullmag-hysteresis-measurement-axis-test-{}",
            std::process::id()
        ));
        let _ = std::fs::remove_dir_all(&output_dir);

        crate::run_problem_with_callback(&problem, 0.0, &output_dir, 1, |_update| {
            StepAction::Continue
        })
        .expect("minimal hysteresis run should complete");

        let points: Vec<HysteresisPoint> = serde_json::from_str(
            &std::fs::read_to_string(output_dir.join("hysteresis_points.json"))
                .expect("hysteresis points should be written"),
        )
        .expect("hysteresis points should decode");

        assert_eq!(points.len(), 1);
        assert!(
            points[0].m_parallel.abs() < 1.0e-9,
            "sample_normal projection should use z, not the in-plane field axis: {:?}",
            points[0]
        );
        assert_eq!(
            points[0].field_orientation.as_ref(),
            Some(&serde_json::json!({"kind": "preset", "preset_name": "in_plane_x"}))
        );
        assert_eq!(
            points[0].measurement_axis.as_ref(),
            Some(&serde_json::json!("sample_normal"))
        );
        assert_eq!(points[0].field_display_unit.as_deref(), Some("mT"));
        let field_vector = points[0]
            .field_vector_A_per_m
            .expect("point should preserve resolved field vector");
        assert!(field_vector[0].is_finite());
        assert!(field_vector[1].abs() < 1.0e-12);
        assert!(field_vector[2].abs() < 1.0e-12);

        let _ = std::fs::remove_dir_all(&output_dir);
    }

    #[test]
    fn hysteresis_points_artifact_preserves_component_averages_for_charts() {
        let mut problem = minimal_fdm_hysteresis_problem();
        if let StudyIR::Hysteresis {
            field_values_mT,
            orientation,
            measurement_axis,
            settle_pipeline,
            ..
        } = &mut problem.study
        {
            *field_values_mT = Some(vec![25.0, 0.0, -25.0]);
            *orientation = Some(FieldOrientationIR::Preset {
                preset_name: "in_plane_x".to_string(),
            });
            *measurement_axis = MeasurementAxisIR::field_axis();
            *settle_pipeline = Some(SettlePipelineIR::Sequence {
                steps: vec![SettleStepIR::Minimize {
                    method: "projected_gradient_bb".to_string(),
                    torque_tolerance: 5e-5,
                    energy_tolerance: 1e-20,
                    max_steps: 200,
                    applies_to: None,
                    stop_criteria: None,
                    timestep_s: None,
                    max_pseudotime_s: None,
                    max_physical_time_s: None,
                    on_non_convergence: "continue_with_warning".to_string(),
                    retry_timestep_scale: None,
                    retry_max_attempts: None,
                }],
            });
        } else {
            panic!("minimal problem must be hysteresis");
        }

        let output_dir = std::env::temp_dir().join(format!(
            "fullmag-hysteresis-chart-data-test-{}",
            std::process::id()
        ));
        let _ = std::fs::remove_dir_all(&output_dir);

        crate::run_problem_with_callback(&problem, 0.0, &output_dir, 1, |_update| {
            StepAction::Continue
        })
        .expect("minimal hysteresis chart-data run should complete");

        let points: Vec<HysteresisPoint> = serde_json::from_str(
            &std::fs::read_to_string(output_dir.join("hysteresis_points.json"))
                .expect("hysteresis points should be written"),
        )
        .expect("hysteresis points should decode");

        assert_eq!(points.len(), 3);
        for point in &points {
            assert!(
                point.m_avg.iter().all(|component| component.is_finite()),
                "m_avg components must be finite for chart data: {point:?}"
            );
            assert!(
                (point.m_parallel - point.m_avg[0]).abs() < 1.0e-9,
                "field-axis x projection must match m_avg.x for in-plane-x loop: {point:?}"
            );
            let (expected_m_oop, expected_m_ip) =
                hysteresis_oop_ip_components(point.m_avg, hysteresis_sample_normal());
            assert!(
                (point.m_oop - expected_m_oop).abs() < 1.0e-12,
                "m_oop must be the sample-normal projection for chart data: {point:?}"
            );
            assert!(
                (point.m_ip - expected_m_ip).abs() < 1.0e-12,
                "m_ip must be the in-sample-plane magnitude for chart data: {point:?}"
            );
        }

        let _ = std::fs::remove_dir_all(&output_dir);
    }

    #[test]
    fn configured_minor_loop_executes_branch_from_parent_reversal_state() {
        let mut problem = minimal_fdm_hysteresis_problem();
        if let StudyIR::Hysteresis {
            branch_mode,
            minor_loops,
            storage,
            ..
        } = &mut problem.study
        {
            *branch_mode = "major_with_minor_loops".to_string();
            *minor_loops = Some(vec![fullmag_ir::MinorLoopIR {
                reversal_mT: 100.0,
                return_mT: -100.0,
            }]);
            *storage = Some(fullmag_ir::HysteresisStorageIR {
                scalar_history: true,
                magnetization: "every_step".to_string(),
                every_n: 1,
                key_events: false,
                key_event_threshold_dm: 0.02,
            });
        } else {
            panic!("minimal problem must be hysteresis");
        }
        let output_dir = std::env::temp_dir().join(format!(
            "fullmag-hysteresis-minor-loop-runner-test-{}",
            std::process::id()
        ));
        let _ = std::fs::remove_dir_all(&output_dir);

        crate::run_problem_with_callback(&problem, 0.0, &output_dir, 1, |_| StepAction::Continue)
            .expect("minor loop hysteresis run should complete");

        let minor_loops_json =
            std::fs::read_to_string(output_dir.join("hysteresis_minor_loops.json"))
                .expect("minor loop artifact should be written");
        let minor_loops: Vec<HysteresisMinorLoop> =
            serde_json::from_str(&minor_loops_json).expect("minor loop artifact should decode");

        assert_eq!(minor_loops.len(), 1);
        assert_eq!(minor_loops[0].policy.as_deref(), Some("branch_only"));
        assert_eq!(
            minor_loops[0]
                .points
                .iter()
                .map(|point| point.field_value_mT)
                .collect::<Vec<_>>(),
            vec![100.0, -100.0],
        );
        assert_eq!(minor_loops[0].reversal_point_id, Some(0));
        assert_eq!(minor_loops[0].return_point_id, Some(1));
        let return_point = minor_loops[0]
            .points
            .iter()
            .find(|point| point.point_id == 1)
            .expect("minor-loop return point should be present");
        assert_eq!(
            return_point.snapshot_id.as_deref(),
            Some("hysteresis_minor_loop_001_return_001")
        );
        assert_eq!(
            return_point.snapshot_zarr_store_ref.as_deref(),
            Some("hysteresis.zarr")
        );
        assert_eq!(
            return_point.snapshot_storage_format.as_deref(),
            Some("zarr_v2_json_fallback")
        );
        assert_eq!(minor_loops[0].settle_trace.len(), 1);
        assert_eq!(minor_loops[0].settle_trace[0].field_value_mT, -100.0);

        let _ = std::fs::remove_dir_all(&output_dir);
    }

    #[test]
    fn configured_minor_loop_computes_off_grid_reversal_state() {
        let mut problem = minimal_fdm_hysteresis_problem();
        if let StudyIR::Hysteresis {
            branch_mode,
            field_values_mT,
            minor_loops,
            storage,
            ..
        } = &mut problem.study
        {
            *field_values_mT = Some(vec![100.0, -100.0]);
            *branch_mode = "major_with_minor_loops".to_string();
            *minor_loops = Some(vec![fullmag_ir::MinorLoopIR {
                reversal_mT: 50.0,
                return_mT: -100.0,
            }]);
            *storage = Some(fullmag_ir::HysteresisStorageIR {
                scalar_history: true,
                magnetization: "every_step".to_string(),
                every_n: 1,
                key_events: false,
                key_event_threshold_dm: 0.02,
            });
        } else {
            panic!("minimal problem must be hysteresis");
        }
        let output_dir = std::env::temp_dir().join(format!(
            "fullmag-hysteresis-minor-loop-off-grid-test-{}",
            std::process::id()
        ));
        let _ = std::fs::remove_dir_all(&output_dir);

        crate::run_problem_with_callback(&problem, 0.0, &output_dir, 1, |_| StepAction::Continue)
            .expect("off-grid minor loop hysteresis run should complete");

        let minor_loops_json =
            std::fs::read_to_string(output_dir.join("hysteresis_minor_loops.json"))
                .expect("minor loop artifact should be written");
        let minor_loops: Vec<HysteresisMinorLoop> =
            serde_json::from_str(&minor_loops_json).expect("minor loop artifact should decode");

        assert_eq!(minor_loops.len(), 1);
        assert_eq!(minor_loops[0].policy.as_deref(), Some("branch_only"));
        assert_eq!(minor_loops[0].reversal_field_mT, 50.0);
        assert_eq!(
            minor_loops[0]
                .points
                .iter()
                .map(|point| point.field_value_mT)
                .collect::<Vec<_>>(),
            vec![50.0, -100.0],
        );
        assert_eq!(minor_loops[0].reversal_point_id, Some(0));
        assert_eq!(minor_loops[0].return_point_id, Some(1));
        assert_eq!(minor_loops[0].points[0].recoil_start_point_id, Some(0));
        assert_eq!(
            minor_loops[0].points[0].snapshot_id.as_deref(),
            Some("hysteresis_minor_loop_001_reversal_001")
        );
        assert_eq!(
            minor_loops[0]
                .settle_trace
                .iter()
                .map(|entry| entry.field_value_mT)
                .collect::<Vec<_>>(),
            vec![50.0, -100.0],
        );
        let samples =
            std::fs::read_to_string(output_dir.join("hysteresis.zarr/fields/m/samples.csv"))
                .expect("minor-loop Zarr sample index should be written");
        assert!(
            samples.contains("hysteresis_minor_loop_001_reversal_001"),
            "minor-loop reversal snapshot must be indexed in Zarr samples.csv:\n{samples}"
        );
        assert!(
            samples.contains("hysteresis_minor_loop_001_return_001"),
            "minor-loop return snapshot must be indexed in Zarr samples.csv:\n{samples}"
        );
        assert!(
            samples.contains(",descending,minor,"),
            "minor-loop snapshots must preserve branch/protocol metadata in samples.csv:\n{samples}"
        );
        let points_index = std::fs::read_to_string(output_dir.join("hysteresis.zarr/points.csv"))
            .expect("minor-loop Zarr root point index should be written");
        assert!(
            points_index.contains("hysteresis_minor_loop_001_reversal_001"),
            "minor-loop reversal snapshot must be indexed in root points.csv:\n{points_index}"
        );
        assert!(
            points_index.contains("hysteresis_minor_loop_001_return_001"),
            "minor-loop return snapshot must be indexed in root points.csv:\n{points_index}"
        );

        let _ = std::fs::remove_dir_all(&output_dir);
    }

    #[test]
    fn piecewise_schedule_respects_skip_start_boundary_policy() {
        let values = materialize_piecewise_field_schedule(&FieldScheduleIR {
            segments: vec![
                fullmag_ir::FieldSegmentIR {
                    segment_id: "coarse".to_string(),
                    start: 100.0,
                    stop: 0.0,
                    step: 50.0,
                    label: "coarse".to_string(),
                    endpoint_policy: "include_stop".to_string(),
                    reason: "test".to_string(),
                },
                fullmag_ir::FieldSegmentIR {
                    segment_id: "dense".to_string(),
                    start: 0.0,
                    stop: -100.0,
                    step: 25.0,
                    label: "dense".to_string(),
                    endpoint_policy: "skip_start".to_string(),
                    reason: "test".to_string(),
                },
            ],
        });

        assert_eq!(values, vec![100.0, 50.0, 0.0, -25.0, -50.0, -75.0, -100.0]);
    }

    #[test]
    fn piecewise_schedule_preserves_explicit_turning_point_with_include_both() {
        let values = materialize_piecewise_field_schedule(&FieldScheduleIR {
            segments: vec![
                fullmag_ir::FieldSegmentIR {
                    segment_id: "forward".to_string(),
                    start: 100.0,
                    stop: 0.0,
                    step: 50.0,
                    label: "forward".to_string(),
                    endpoint_policy: "include_stop".to_string(),
                    reason: "test".to_string(),
                },
                fullmag_ir::FieldSegmentIR {
                    segment_id: "return".to_string(),
                    start: 0.0,
                    stop: 100.0,
                    step: 50.0,
                    label: "return".to_string(),
                    endpoint_policy: "include_both".to_string(),
                    reason: "turning_point".to_string(),
                },
            ],
        });

        assert_eq!(values, vec![100.0, 50.0, 0.0, 0.0, 50.0, 100.0]);
    }

    #[test]
    fn dense_window_inserts_smaller_steps_without_reordering_branch() {
        let values = materialize_hysteresis_field_values(
            Some(-100.0),
            Some(100.0),
            Some(50.0),
            None,
            None,
            Some(&[FieldWindowIR {
                center_mT: 0.0,
                half_width_mT: 25.0,
                step_mT: 10.0,
                reason: "remanence".to_string(),
                priority: Some(1),
            }]),
            "major_loop",
        );

        assert_eq!(
            values,
            vec![
                100.0, 50.0, 25.0, 15.0, 5.0, 0.0, -10.0, -20.0, -25.0, -50.0, -100.0, -50.0,
                -25.0, -15.0, -5.0, 0.0, 10.0, 20.0, 25.0, 50.0, 100.0,
            ]
        );
    }

    #[test]
    fn major_with_minor_loops_materializes_major_loop_base_schedule() {
        let values = materialize_hysteresis_field_values(
            Some(-100.0),
            Some(100.0),
            Some(100.0),
            None,
            None,
            None,
            "major_with_minor_loops",
        );

        assert_eq!(values, vec![100.0, 0.0, -100.0, 0.0, 100.0]);
    }

    #[test]
    fn settle_tree_materializes_fallback_branch_after_default_step() {
        let steps = materialize_settle_steps(Some(&SettlePipelineIR::Tree {
            default: SettleStepIR::Relax {
                method: "llg_overdamped".to_string(),
                alpha: 0.8,
                torque_tolerance: 2e-5,
                max_steps: 5000,
                applies_to: None,
                stop_criteria: None,
                timestep_s: None,
                max_pseudotime_s: None,
                max_physical_time_s: None,
                on_non_convergence: "run_next_algorithm".to_string(),
                retry_timestep_scale: None,
                retry_max_attempts: None,
            },
            branches: vec![
                fullmag_ir::SettleBranchIR {
                    when: "non_converged".to_string(),
                    run: SettleStepIR::Relax {
                        method: "llg_overdamped".to_string(),
                        alpha: 1.0,
                        torque_tolerance: 1e-5,
                        max_steps: 12000,
                        applies_to: None,
                        stop_criteria: None,
                        timestep_s: None,
                        max_pseudotime_s: None,
                        max_physical_time_s: None,
                        on_non_convergence: "continue_with_warning".to_string(),
                        retry_timestep_scale: None,
                        retry_max_attempts: None,
                    },
                },
                fullmag_ir::SettleBranchIR {
                    when: "key_event".to_string(),
                    run: SettleStepIR::Minimize {
                        method: "projected_gradient_bb".to_string(),
                        torque_tolerance: 5e-6,
                        energy_tolerance: 1e-20,
                        max_steps: 2000,
                        applies_to: None,
                        stop_criteria: None,
                        timestep_s: None,
                        max_pseudotime_s: None,
                        max_physical_time_s: None,
                        on_non_convergence: "continue_with_warning".to_string(),
                        retry_timestep_scale: None,
                        retry_max_attempts: None,
                    },
                },
            ],
        }));

        assert_eq!(steps.len(), 2);
        assert_eq!(steps[0].fallback_reason, None);
        assert_eq!(steps[0].run_condition, PlannedSettleStepCondition::Always);
        assert_eq!(
            steps[1].run_condition,
            PlannedSettleStepCondition::OnPreviousNonConverged
        );
        assert_eq!(
            steps[1].fallback_reason.as_deref(),
            Some("previous_step_non_converged")
        );
        match &steps[0].step {
            SettleStepIR::Relax { max_steps, .. } => assert_eq!(*max_steps, 5000),
            other => panic!("expected default relax step, got {other:?}"),
        }
        match &steps[1].step {
            SettleStepIR::Relax { max_steps, .. } => assert_eq!(*max_steps, 12000),
            other => panic!("expected fallback relax step, got {other:?}"),
        }
    }

    #[test]
    fn settle_step_applies_to_filters_by_point_role() {
        let major_step = SettleStepIR::Relax {
            method: "llg_overdamped".to_string(),
            alpha: 1.0,
            torque_tolerance: 1e-5,
            max_steps: 100,
            applies_to: Some(serde_json::json!("major")),
            stop_criteria: None,
            timestep_s: None,
            max_pseudotime_s: None,
            max_physical_time_s: None,
            on_non_convergence: "continue_with_warning".to_string(),
            retry_timestep_scale: None,
            retry_max_attempts: None,
        };
        let key_event_step = SettleStepIR::Minimize {
            method: "projected_gradient_bb".to_string(),
            torque_tolerance: 5e-5,
            energy_tolerance: 1e-20,
            max_steps: 25,
            applies_to: Some(serde_json::json!(["key_events", "minor"])),
            stop_criteria: None,
            timestep_s: None,
            max_pseudotime_s: None,
            max_physical_time_s: None,
            on_non_convergence: "continue_with_warning".to_string(),
            retry_timestep_scale: None,
            retry_max_attempts: None,
        };

        assert!(settle_step_applies_to_point_role(&major_step, "major"));
        assert!(settle_step_applies_to_point_role(
            &major_step,
            "major_descending"
        ));
        assert!(!settle_step_applies_to_point_role(&major_step, "minor"));
        assert!(!settle_step_applies_to_point_role(&key_event_step, "major"));
        assert!(settle_step_applies_to_point_role(
            &key_event_step,
            "key_event"
        ));
        assert!(settle_step_applies_to_point_role(&key_event_step, "minor"));

        let skipped = settle_trace_entry(
            7,
            25.0,
            1,
            &key_event_step,
            "skipped".to_string(),
            Some("applies_to_not_matching_major".to_string()),
            0,
            Some(HYSTERESIS_SETTLE_STEP_DT_SECONDS),
            None,
        );
        assert_eq!(skipped.status, "skipped");
        assert_eq!(
            skipped.fallback_reason.as_deref(),
            Some("applies_to_not_matching_major")
        );
        assert_eq!(
            skipped
                .resolved_parameters
                .as_ref()
                .and_then(|params| params.get("applies_to")),
            Some(&serde_json::json!(["key_events", "minor"]))
        );

        let branch_step = SettleStepIR::Relax {
            method: "llg_overdamped".to_string(),
            alpha: 1.0,
            torque_tolerance: 1e-5,
            max_steps: 100,
            applies_to: Some(serde_json::json!({
                "kind": "branch_id",
                "branch_id": "descending",
            })),
            stop_criteria: None,
            timestep_s: None,
            max_pseudotime_s: None,
            max_physical_time_s: None,
            on_non_convergence: "continue_with_warning".to_string(),
            retry_timestep_scale: None,
            retry_max_attempts: None,
        };
        let point_step = SettleStepIR::Relax {
            method: "llg_overdamped".to_string(),
            alpha: 1.0,
            torque_tolerance: 1e-5,
            max_steps: 100,
            applies_to: Some(serde_json::json!({
                "kind": "point_selector",
                "point_ids": [2, 4],
            })),
            stop_criteria: None,
            timestep_s: None,
            max_pseudotime_s: None,
            max_physical_time_s: None,
            on_non_convergence: "continue_with_warning".to_string(),
            retry_timestep_scale: None,
            retry_max_attempts: None,
        };
        let descending_context = HysteresisProgressContext {
            point_idx: Some(2),
            field_m_t: 50.0,
            point_role: "major_descending",
            branch_id: Some("descending".to_string()),
        };
        let ascending_context = HysteresisProgressContext {
            point_idx: Some(3),
            field_m_t: -50.0,
            point_role: "major_ascending",
            branch_id: Some("ascending".to_string()),
        };

        assert!(settle_step_applies_to_context(
            &branch_step,
            &descending_context
        ));
        assert!(!settle_step_applies_to_context(
            &branch_step,
            &ascending_context
        ));
        assert!(settle_step_applies_to_context(
            &point_step,
            &descending_context
        ));
        assert!(!settle_step_applies_to_context(
            &point_step,
            &ascending_context
        ));
    }

    #[test]
    fn settle_sequence_runs_all_steps_in_order() {
        let steps = materialize_settle_steps(Some(&SettlePipelineIR::Sequence {
            steps: vec![
                SettleStepIR::Minimize {
                    method: "projected_gradient_bb".to_string(),
                    torque_tolerance: 5e-5,
                    energy_tolerance: 1e-20,
                    max_steps: 2000,
                    applies_to: None,
                    stop_criteria: None,
                    timestep_s: None,
                    max_pseudotime_s: None,
                    max_physical_time_s: None,
                    on_non_convergence: "run_next_algorithm".to_string(),
                    retry_timestep_scale: None,
                    retry_max_attempts: None,
                },
                SettleStepIR::Relax {
                    method: "llg_overdamped".to_string(),
                    alpha: 1.0,
                    torque_tolerance: 1e-5,
                    max_steps: 10000,
                    applies_to: None,
                    stop_criteria: None,
                    timestep_s: None,
                    max_pseudotime_s: None,
                    max_physical_time_s: None,
                    on_non_convergence: "continue_with_warning".to_string(),
                    retry_timestep_scale: None,
                    retry_max_attempts: None,
                },
            ],
        }));

        assert_eq!(steps.len(), 2);
        assert_eq!(steps[0].run_condition, PlannedSettleStepCondition::Always);
        assert_eq!(steps[0].fallback_reason, None);
        assert_eq!(steps[1].run_condition, PlannedSettleStepCondition::Always);
        assert_eq!(steps[1].fallback_reason, None);
    }

    #[test]
    fn settle_status_marks_max_steps_as_non_converged() {
        let result = RunResult {
            status: RunStatus::Completed,
            steps: Vec::new(),
            final_magnetization: Vec::new(),
            completion: Some(fullmag_ir::StageCompletionIR {
                status: "completed".to_string(),
                reason: Some(StageStopReason::MaxSteps),
                metric_name: Some("steps".to_string()),
                metric_value: Some(2.0),
                threshold: Some(2.0),
            }),
        };

        assert_eq!(settle_status(&result), "non_converged");
    }

    #[test]
    fn settle_status_marks_torque_as_converged() {
        let result = RunResult {
            status: RunStatus::Completed,
            steps: Vec::new(),
            final_magnetization: Vec::new(),
            completion: Some(fullmag_ir::StageCompletionIR {
                status: "completed".to_string(),
                reason: Some(StageStopReason::Torque),
                metric_name: Some("max_torque_Apm".to_string()),
                metric_value: Some(1e-6),
                threshold: Some(1e-5),
            }),
        };

        assert_eq!(settle_status(&result), "converged");
    }

    #[test]
    fn hysteresis_point_quality_reports_non_converged_settle_steps() {
        let trace = vec![
            settle_trace_entry(
                2,
                -50.0,
                0,
                &SettleStepIR::Minimize {
                    method: "projected_gradient_bb".to_string(),
                    torque_tolerance: 5e-5,
                    energy_tolerance: 1e-20,
                    max_steps: 2000,
                    applies_to: None,
                    stop_criteria: None,
                    timestep_s: None,
                    max_pseudotime_s: None,
                    max_physical_time_s: None,
                    on_non_convergence: "run_next_algorithm".to_string(),
                    retry_timestep_scale: None,
                    retry_max_attempts: None,
                },
                "non_converged".to_string(),
                None,
                0,
                Some(HYSTERESIS_SETTLE_STEP_DT_SECONDS),
                None,
            ),
            settle_trace_entry(
                2,
                -50.0,
                1,
                &SettleStepIR::Relax {
                    method: "llg_overdamped".to_string(),
                    alpha: 1.0,
                    torque_tolerance: 1e-5,
                    max_steps: 10000,
                    applies_to: None,
                    stop_criteria: None,
                    timestep_s: None,
                    max_pseudotime_s: None,
                    max_physical_time_s: None,
                    on_non_convergence: "continue_with_warning".to_string(),
                    retry_timestep_scale: None,
                    retry_max_attempts: None,
                },
                "converged".to_string(),
                Some("previous_step_non_converged".to_string()),
                0,
                Some(HYSTERESIS_SETTLE_STEP_DT_SECONDS),
                None,
            ),
        ];

        let quality = hysteresis_point_quality(RunStatus::Completed, &trace);

        assert_eq!(quality.run_status, "Completed");
        assert_eq!(quality.settle_status, "non_converged");
        assert!(quality.has_non_converged_steps);
        assert_eq!(quality.terminal_settle_reason.as_deref(), Some("converged"));
        assert_eq!(quality.warning_count, 1);
    }

    #[test]
    fn settle_trace_entry_records_fallback_reason_and_metrics() {
        let step = SettleStepIR::Minimize {
            method: "projected_gradient_bb".to_string(),
            torque_tolerance: 5e-5,
            energy_tolerance: 1e-20,
            max_steps: 2000,
            applies_to: Some(serde_json::json!(["key_events", "minor"])),
            stop_criteria: Some(serde_json::json!({
                "kind": "any_of",
                "criteria": ["energy_delta_below", "m_delta_below"],
            })),
            timestep_s: None,
            max_pseudotime_s: None,
            max_physical_time_s: None,
            on_non_convergence: "continue_with_warning".to_string(),
            retry_timestep_scale: None,
            retry_max_attempts: None,
        };
        let stats = StepStats {
            max_torque_Apm: 7.0,
            e_total: -3.5,
            ..StepStats::default()
        };

        let entry = settle_trace_entry(
            4,
            -25.0,
            1,
            &step,
            "non_converged".to_string(),
            Some("previous_step_non_converged".to_string()),
            1,
            Some(5e-14),
            Some(&stats),
        );

        assert_eq!(entry.point_id, 4);
        assert_eq!(entry.field_value_mT, -25.0);
        assert_eq!(entry.step_index, 1);
        assert_eq!(entry.algorithm_id, "settle_step_001_minimize");
        assert_eq!(entry.method, "projected_gradient_bb");
        assert_eq!(entry.status, "non_converged");
        assert_eq!(
            entry.fallback_reason.as_deref(),
            Some("previous_step_non_converged")
        );
        assert_eq!(entry.retry_attempt, 1);
        assert_eq!(entry.resolved_timestep_s, Some(5e-14));
        assert_eq!(entry.stop_reason.as_deref(), Some("non_converged"));
        assert_eq!(
            entry
                .resolved_parameters
                .as_ref()
                .and_then(|params| params.get("kind"))
                .and_then(|kind| kind.as_str()),
            Some("minimize")
        );
        assert_eq!(
            entry
                .resolved_parameters
                .as_ref()
                .and_then(|params| params.get("energy_tolerance"))
                .and_then(|value| value.as_f64()),
            Some(1e-20)
        );
        assert_eq!(
            entry
                .resolved_parameters
                .as_ref()
                .and_then(|params| params.get("applies_to")),
            Some(&serde_json::json!(["key_events", "minor"]))
        );
        assert_eq!(
            entry
                .resolved_parameters
                .as_ref()
                .and_then(|params| params.get("stop_criteria")),
            Some(&serde_json::json!({
                "kind": "any_of",
                "criteria": ["energy_delta_below", "m_delta_below"],
            }))
        );
        assert_eq!(entry.torque, Some(7.0));
        assert_eq!(entry.energy, Some(-3.5));
    }

    #[test]
    fn configured_minor_loop_selects_ordered_reversal_to_return_points() {
        let points = vec![
            test_hysteresis_point(0, 100.0, 1.0, None),
            test_hysteresis_point(1, 50.0, 0.5, None),
            test_hysteresis_point(2, -25.0, -0.2, Some("hysteresis_point_003")),
            test_hysteresis_point(3, 25.0, 0.2, Some("hysteresis_point_004")),
        ];

        let loops = build_hysteresis_minor_loops(
            &[fullmag_ir::MinorLoopIR {
                reversal_mT: -20.0,
                return_mT: 30.0,
            }],
            &points,
            None,
        );

        assert_eq!(loops.len(), 1);
        assert_eq!(loops[0].loop_id, "minor_loop_001");
        assert_eq!(loops[0].reversal_field_mT, -20.0);
        assert_eq!(loops[0].return_field_mT, 30.0);
        assert_eq!(
            loops[0]
                .points
                .iter()
                .map(|point| point.point_id)
                .collect::<Vec<_>>(),
            vec![2, 3],
        );
        assert_eq!(
            loops[0].points[0].snapshot_id.as_deref(),
            Some("hysteresis_point_003")
        );
        assert_eq!(loops[0].parent_branch_id.as_deref(), Some("descending"));
        assert_eq!(loops[0].reversal_point_id, Some(2));
        assert_eq!(loops[0].return_point_id, Some(3));
        assert_eq!(
            loops[0].policy.as_deref(),
            Some("derived_from_major_loop_window")
        );
        assert_eq!(loops[0].closure_status.as_deref(), Some("open"));
        assert_eq!(loops[0].closure_error_m_parallel, Some(0.4));
        assert_eq!(loops[0].recoil_susceptibility, Some(0.008));
        assert_eq!(loops[0].minor_loop_area, Some(0.0));
        assert_eq!(
            loops[0].points[0].minor_loop_id.as_deref(),
            Some("minor_loop_001")
        );
        assert_eq!(loops[0].points[0].protocol_role.as_deref(), Some("minor"));
        assert_eq!(
            loops[0].points[0].snapshot_resource_ref.as_deref(),
            Some(
                "/v2/sessions/current/data/fields/m/samples/vector?component=full&scope_kind=full&snapshot_id=hysteresis_point_003"
            )
        );
        assert_eq!(
            loops[0].points[0].snapshot_vector_resource_ref.as_deref(),
            Some(
                "/v2/sessions/current/data/fields/m/samples/vector?component=full&scope_kind=full&snapshot_id=hysteresis_point_003"
            )
        );
        assert_eq!(
            loops[0].points[0].snapshot_json_artifact_ref.as_deref(),
            Some("hysteresis_snapshots/hysteresis_point_003/m.json")
        );
        assert_eq!(
            loops[0].points[0].snapshot_zarr_store_ref.as_deref(),
            Some("hysteresis.zarr")
        );
        assert_eq!(
            loops[0].points[0].snapshot_storage_format.as_deref(),
            Some("zarr_v2_json_fallback")
        );
    }

    #[test]
    fn settle_step_until_seconds_uses_positive_stage_time_when_available() {
        let step = SettleStepIR::Relax {
            method: "llg_overdamped".to_string(),
            alpha: 1.0,
            torque_tolerance: 1e-5,
            max_steps: 10000,
            applies_to: None,
            stop_criteria: None,
            timestep_s: None,
            max_pseudotime_s: None,
            max_physical_time_s: None,
            on_non_convergence: "continue_with_warning".to_string(),
            retry_timestep_scale: None,
            retry_max_attempts: None,
        };

        assert_eq!(settle_step_until_seconds(&step, 2.5e-12, None), 2.5e-12);
    }

    #[test]
    fn settle_step_until_seconds_derives_positive_time_from_max_steps() {
        let step = SettleStepIR::Minimize {
            method: "projected_gradient_bb".to_string(),
            torque_tolerance: 5e-5,
            energy_tolerance: 1e-20,
            max_steps: 2000,
            applies_to: None,
            stop_criteria: None,
            timestep_s: None,
            max_pseudotime_s: None,
            max_physical_time_s: None,
            on_non_convergence: "run_next_algorithm".to_string(),
            retry_timestep_scale: None,
            retry_max_attempts: None,
        };

        assert_eq!(
            settle_step_until_seconds(&step, 0.0, None),
            2000.0 * HYSTERESIS_SETTLE_STEP_DT_SECONDS
        );
    }

    #[test]
    fn settle_step_until_seconds_uses_step_time_limit_before_max_steps() {
        let step = SettleStepIR::Relax {
            method: "llg_overdamped".to_string(),
            alpha: 1.0,
            torque_tolerance: 1e-5,
            max_steps: 10_000,
            applies_to: None,
            stop_criteria: None,
            on_non_convergence: "continue_with_warning".to_string(),
            retry_timestep_scale: None,
            retry_max_attempts: None,
            timestep_s: Some(2e-13),
            max_pseudotime_s: Some(4e-10),
            max_physical_time_s: Some(8e-10),
        };

        assert_eq!(settle_step_until_seconds(&step, 0.0, None), 8e-10);
    }

    #[test]
    fn settle_step_until_seconds_caps_global_stage_time_by_step_time_limit() {
        let step = SettleStepIR::Relax {
            method: "llg_overdamped".to_string(),
            alpha: 1.0,
            torque_tolerance: 1e-5,
            max_steps: 10_000,
            applies_to: None,
            stop_criteria: None,
            on_non_convergence: "continue_with_warning".to_string(),
            retry_timestep_scale: None,
            retry_max_attempts: None,
            timestep_s: Some(2e-13),
            max_pseudotime_s: Some(4e-10),
            max_physical_time_s: Some(8e-10),
        };

        assert_eq!(settle_step_until_seconds(&step, 2.5e-9, None), 8e-10);
    }

    #[test]
    fn settle_step_until_seconds_caps_global_stage_time_by_step_count_budget() {
        let step = SettleStepIR::Relax {
            method: "llg_overdamped".to_string(),
            alpha: 1.0,
            torque_tolerance: 1e-5,
            max_steps: 4,
            applies_to: None,
            stop_criteria: None,
            timestep_s: Some(2e-13),
            max_pseudotime_s: None,
            max_physical_time_s: None,
            on_non_convergence: "continue_with_warning".to_string(),
            retry_timestep_scale: None,
            retry_max_attempts: None,
        };

        assert_eq!(settle_step_until_seconds(&step, 2.5e-9, None), 8e-13);
    }

    #[test]
    fn resolved_settle_timestep_uses_step_override_before_backend_default() {
        let step = SettleStepIR::Minimize {
            method: "projected_gradient_bb".to_string(),
            torque_tolerance: 5e-5,
            energy_tolerance: 1e-20,
            max_steps: 2000,
            applies_to: None,
            stop_criteria: None,
            on_non_convergence: "run_next_algorithm".to_string(),
            retry_timestep_scale: None,
            retry_max_attempts: None,
            timestep_s: Some(3e-13),
            max_pseudotime_s: None,
            max_physical_time_s: None,
        };
        let problem = minimal_fdm_hysteresis_problem();
        let plan = fullmag_plan::plan(&problem).expect("minimal hysteresis plan");

        assert_eq!(
            resolved_settle_timestep(&plan.backend_plan, &step, None),
            3e-13
        );
        assert_eq!(
            resolved_settle_timestep(&plan.backend_plan, &step, Some(1e-13)),
            1e-13
        );
    }

    #[test]
    fn settle_step_until_seconds_uses_retry_timestep_override() {
        let step = SettleStepIR::Relax {
            method: "llg_overdamped".to_string(),
            alpha: 1.0,
            torque_tolerance: 1e-5,
            max_steps: 4,
            applies_to: None,
            stop_criteria: None,
            timestep_s: None,
            max_pseudotime_s: None,
            max_physical_time_s: None,
            on_non_convergence: "retry_with_smaller_dt".to_string(),
            retry_timestep_scale: Some(0.5),
            retry_max_attempts: Some(1),
        };

        assert_eq!(settle_step_until_seconds(&step, 0.0, Some(5e-14)), 2e-13);
        assert_eq!(settle_step_retry_timestep_scale(&step).unwrap(), 0.5);
        assert_eq!(settle_step_retry_max_attempts(&step), 1);
    }

    #[test]
    fn storage_policy_controls_hysteresis_snapshot_capture() {
        let context = |point_idx: usize, field_value_mT: f64| HysteresisSnapshotDecisionContext {
            point_idx,
            field_value_mT,
            previous_field_value_mT: None,
            next_field_value_mT: None,
            m_parallel: 0.0,
            previous_m_parallel: None,
            status: RunStatus::Completed,
            non_converged: false,
        };
        let none = fullmag_ir::HysteresisStorageIR {
            scalar_history: true,
            magnetization: "none".to_string(),
            every_n: 1,
            key_events: false,
            key_event_threshold_dm: 0.02,
        };
        assert!(!should_store_hysteresis_snapshot(
            Some(&none),
            context(0, 0.0)
        ));

        let every_step = fullmag_ir::HysteresisStorageIR {
            magnetization: "every_step".to_string(),
            ..none.clone()
        };
        assert!(should_store_hysteresis_snapshot(
            Some(&every_step),
            context(7, 100.0)
        ));

        let every_n = fullmag_ir::HysteresisStorageIR {
            magnetization: "every_n".to_string(),
            every_n: 3,
            ..none.clone()
        };
        assert!(should_store_hysteresis_snapshot(
            Some(&every_n),
            context(0, 100.0)
        ));
        assert!(!should_store_hysteresis_snapshot(
            Some(&every_n),
            context(1, 50.0)
        ));
        assert!(should_store_hysteresis_snapshot(
            Some(&every_n),
            context(3, -50.0)
        ));

        let key_events = fullmag_ir::HysteresisStorageIR {
            magnetization: "key_events".to_string(),
            key_events: true,
            key_event_threshold_dm: 0.02,
            ..none
        };
        assert!(should_store_hysteresis_snapshot(
            Some(&key_events),
            context(4, 0.0)
        ));
        assert!(should_store_hysteresis_snapshot(
            Some(&key_events),
            HysteresisSnapshotDecisionContext {
                point_idx: 1,
                field_value_mT: 100.0,
                previous_field_value_mT: Some(50.0),
                next_field_value_mT: Some(50.0),
                m_parallel: 0.0,
                previous_m_parallel: Some(0.0),
                status: RunStatus::Completed,
                non_converged: false,
            }
        ));
        assert!(should_store_hysteresis_snapshot(
            Some(&key_events),
            HysteresisSnapshotDecisionContext {
                point_idx: 2,
                field_value_mT: 25.0,
                previous_field_value_mT: Some(50.0),
                next_field_value_mT: Some(0.0),
                m_parallel: 0.05,
                previous_m_parallel: Some(0.0),
                status: RunStatus::Completed,
                non_converged: false,
            }
        ));
        assert!(should_store_hysteresis_snapshot(
            Some(&key_events),
            HysteresisSnapshotDecisionContext {
                point_idx: 3,
                field_value_mT: 75.0,
                previous_field_value_mT: Some(50.0),
                next_field_value_mT: Some(100.0),
                m_parallel: 0.0,
                previous_m_parallel: Some(0.0),
                status: RunStatus::Failed,
                non_converged: false,
            }
        ));
        assert!(should_store_hysteresis_snapshot(
            Some(&key_events),
            HysteresisSnapshotDecisionContext {
                point_idx: 4,
                field_value_mT: 75.0,
                previous_field_value_mT: Some(50.0),
                next_field_value_mT: Some(100.0),
                m_parallel: 0.0,
                previous_m_parallel: Some(0.0),
                status: RunStatus::Completed,
                non_converged: true,
            }
        ));
        assert!(!should_store_hysteresis_snapshot(
            Some(&key_events),
            HysteresisSnapshotDecisionContext {
                point_idx: 6,
                field_value_mT: 75.0,
                previous_field_value_mT: Some(50.0),
                next_field_value_mT: Some(100.0),
                m_parallel: 0.01,
                previous_m_parallel: Some(0.0),
                status: RunStatus::Completed,
                non_converged: false,
            }
        ));
    }

    #[test]
    fn initial_protocol_resolves_preparation_field_for_saturation_start() {
        let saturation = fullmag_ir::SaturationProbeIR {
            mode: "auto".to_string(),
            max_field_mT: 350.0,
            susceptibility_threshold: 1e-3,
            transverse_threshold: 1e-2,
            on_failure: "continue_with_warning".to_string(),
        };

        assert_eq!(
            hysteresis_preparation_field_mT(
                "positive_saturation",
                Some(&saturation),
                &[100.0, 0.0, -100.0],
            ),
            Some(350.0),
        );
        assert_eq!(
            hysteresis_preparation_field_mT(
                "negative_saturation",
                Some(&saturation),
                &[100.0, 0.0, -100.0],
            ),
            Some(-350.0),
        );
        assert_eq!(
            hysteresis_preparation_field_mT("positive_saturation", None, &[120.0, 40.0, -80.0],),
            Some(120.0),
        );
        assert_eq!(
            hysteresis_preparation_field_mT("zero_field_relaxed", None, &[120.0, 40.0, -80.0]),
            Some(0.0),
        );
        assert_eq!(
            hysteresis_preparation_field_mT("as_authored", Some(&saturation), &[120.0]),
            None,
        );
    }

    #[test]
    fn hysteresis_metrics_do_not_claim_saturation_without_probe_evidence() {
        let saturation = fullmag_ir::SaturationProbeIR {
            mode: "auto".to_string(),
            max_field_mT: 350.0,
            susceptibility_threshold: 1e-3,
            transverse_threshold: 1e-2,
            on_failure: "continue_with_warning".to_string(),
        };
        let points = vec![
            test_hysteresis_point(0, 100.0, 1.0, None),
            test_hysteresis_point(1, -100.0, -1.0, None),
        ];

        let as_authored = calculate_metrics(&points, "as_authored", None, None);
        assert_eq!(as_authored.saturation_status, "not_requested");
        assert_eq!(as_authored.saturation_preparation_field_mT, None);
        assert_eq!(
            as_authored.magnetization_average_weighting,
            "uniform_sample_average"
        );

        let positive_saturation = calculate_metrics(
            &points,
            "positive_saturation",
            Some(&saturation),
            Some(350.0),
        );
        assert_eq!(
            positive_saturation.saturation_status,
            "preparation_applied_unverified",
        );
        assert_eq!(
            positive_saturation.saturation_preparation_field_mT,
            Some(350.0),
        );

        let negative_saturation =
            calculate_metrics(&points, "negative_saturation", None, Some(-100.0));
        assert_eq!(
            negative_saturation.saturation_status,
            "preparation_from_schedule_unverified",
        );
        assert_eq!(
            negative_saturation.saturation_preparation_field_mT,
            Some(-100.0),
        );
    }

    #[test]
    fn saturation_probe_classification_uses_thresholds_and_limit_status() {
        let probe = fullmag_ir::SaturationProbeIR {
            mode: "auto".to_string(),
            max_field_mT: 300.0,
            susceptibility_threshold: 1e-3,
            transverse_threshold: 1e-2,
            on_failure: "continue_with_warning".to_string(),
        };
        let mut points = vec![
            HysteresisSaturationProbePoint {
                probe_index: 0,
                field_value_mT: 200.0,
                m_parallel: 0.998,
                m_transverse: 0.004,
                torque: Some(1.0),
                status: "converged".to_string(),
            },
            HysteresisSaturationProbePoint {
                probe_index: 1,
                field_value_mT: 300.0,
                m_parallel: 0.999,
                m_transverse: 0.004,
                torque: Some(1.0),
                status: "converged".to_string(),
            },
        ];

        assert_eq!(
            classify_hysteresis_saturation_probe(&points, &probe).0,
            "saturated",
        );
        points[1].status = "completed".to_string();
        assert_eq!(
            classify_hysteresis_saturation_probe(&points, &probe).0,
            "saturated",
        );

        points[1].m_parallel = 0.97;
        assert_eq!(
            classify_hysteresis_saturation_probe(&points, &probe).0,
            "probably_saturated",
        );

        points[1].m_transverse = 0.05;
        assert_eq!(
            classify_hysteresis_saturation_probe(&points, &probe).0,
            "capped_by_limit",
        );
    }

    #[test]
    fn stored_hysteresis_snapshot_contains_vector_magnetization_payload() {
        let output_dir = std::env::temp_dir().join(format!(
            "fullmag-hysteresis-snapshot-test-{}-{}",
            std::process::id(),
            std::time::SystemTime::now()
                .duration_since(std::time::UNIX_EPOCH)
                .expect("system time before unix epoch")
                .as_nanos(),
        ));
        let magnetization = vec![[1.0, 0.0, 0.0], [0.0, 1.0, 0.0]];

        write_hysteresis_magnetization_snapshot(
            &output_dir,
            "hysteresis_point_002",
            1,
            25.0,
            [2, 1, 1],
            &magnetization,
            "uniform_sample_average",
            None,
            "every_step",
            HysteresisSnapshotIndexMetadata {
                branch_id: Some("descending"),
                protocol_role: Some("major_descending"),
            },
        )
        .expect("snapshot write should succeed");

        let payload: serde_json::Value = serde_json::from_str(
            &std::fs::read_to_string(
                output_dir.join("hysteresis_snapshots/hysteresis_point_002/m.json"),
            )
            .expect("snapshot file should exist"),
        )
        .expect("snapshot file should be valid JSON");
        assert_eq!(payload["quantity_id"], "m");
        assert_eq!(payload["snapshot_id"], "hysteresis_point_002");
        assert_eq!(
            payload["layout"]["grid_cells"],
            serde_json::json!([2, 1, 1])
        );
        assert_eq!(
            payload["values"],
            serde_json::json!([[1.0, 0.0, 0.0], [0.0, 1.0, 0.0]])
        );
        let zarray: serde_json::Value = serde_json::from_str(
            &std::fs::read_to_string(output_dir.join("hysteresis.zarr/fields/m/.zarray"))
                .expect("Zarr metadata should exist"),
        )
        .expect("Zarr metadata should be valid JSON");
        let root_zattrs: serde_json::Value = serde_json::from_str(
            &std::fs::read_to_string(output_dir.join("hysteresis.zarr/.zattrs"))
                .expect("Zarr root attrs should exist"),
        )
        .expect("Zarr root attrs should be valid JSON");
        let field_zattrs: serde_json::Value = serde_json::from_str(
            &std::fs::read_to_string(output_dir.join("hysteresis.zarr/fields/m/.zattrs"))
                .expect("Zarr field attrs should exist"),
        )
        .expect("Zarr field attrs should be valid JSON");
        assert_eq!(
            root_zattrs["magnetization_average_weighting"],
            "uniform_sample_average"
        );
        assert_eq!(
            field_zattrs["magnetization_average_weighting"],
            "uniform_sample_average"
        );
        assert_eq!(root_zattrs["magnetization_storage_policy"], "every_step");
        assert_eq!(field_zattrs["magnetization_storage_policy"], "every_step");
        assert_eq!(zarray["shape"], serde_json::json!([1, 3, 2]));
        assert_eq!(zarray["chunks"], serde_json::json!([1, 3, 2]));
        assert_eq!(zarray["dtype"], "<f8");
        let samples =
            std::fs::read_to_string(output_dir.join("hysteresis.zarr/fields/m/samples.csv"))
                .expect("Zarr sample index should exist");
        assert!(samples.contains("hysteresis_point_002"));
        assert!(samples.contains("sample_index,snapshot_id,point_id,field_value_mT,quantity_id,chunk_key,grid_x,grid_y,cell_count,grid_z,component_count,dtype,branch_id,protocol_role,mesh_identity,field_revision"));
        assert!(samples.contains(",descending,major_descending,grid:2x1x1;cells:2,1"));
        let point_index = std::fs::read_to_string(output_dir.join("hysteresis.zarr/points.csv"))
            .expect("Zarr root point index should exist");
        assert!(point_index.contains("hysteresis_point_002"));
        assert!(point_index.contains("fields/m/0.0.0"));
        assert!(point_index.contains(",descending,major_descending,grid:2x1x1;cells:2,1"));
        let chunk = std::fs::read(output_dir.join("hysteresis.zarr/fields/m/0.0.0"))
            .expect("Zarr chunk should exist");
        let values = chunk
            .chunks_exact(8)
            .map(|bytes| {
                let mut array = [0_u8; 8];
                array.copy_from_slice(bytes);
                f64::from_le_bytes(array)
            })
            .collect::<Vec<_>>();
        assert_eq!(values, vec![1.0, 0.0, 0.0, 1.0, 0.0, 0.0]);

        std::fs::remove_dir_all(output_dir)
            .expect("temporary artifact directory should be removed");
    }

    #[test]
    fn stored_hysteresis_snapshot_records_average_weights_for_weighted_playback() {
        let output_dir = std::env::temp_dir().join(format!(
            "fullmag-hysteresis-weighted-snapshot-test-{}-{}",
            std::process::id(),
            std::time::SystemTime::now()
                .duration_since(std::time::UNIX_EPOCH)
                .expect("system time before unix epoch")
                .as_nanos(),
        ));
        let magnetization = vec![[1.0, 0.0, 0.0], [0.0, 1.0, 0.0], [0.0, 0.0, 0.0]];
        let weights = vec![2.0, 6.0, 0.0];

        write_hysteresis_magnetization_snapshot(
            &output_dir,
            "hysteresis_point_003",
            2,
            -25.0,
            [3, 1, 1],
            &magnetization,
            "moment_weighted_fem_p1_lumped_ms_volume",
            Some(weights.as_slice()),
            "every_step",
            HysteresisSnapshotIndexMetadata::default(),
        )
        .expect("weighted snapshot write should succeed");

        let root_zattrs: serde_json::Value = serde_json::from_str(
            &std::fs::read_to_string(output_dir.join("hysteresis.zarr/.zattrs"))
                .expect("Zarr root attrs should exist"),
        )
        .expect("Zarr root attrs should be valid JSON");
        let field_zattrs: serde_json::Value = serde_json::from_str(
            &std::fs::read_to_string(output_dir.join("hysteresis.zarr/fields/m/.zattrs"))
                .expect("Zarr field attrs should exist"),
        )
        .expect("Zarr field attrs should be valid JSON");
        assert_eq!(
            root_zattrs["average_weights_ref"],
            "fields/m/average_weights"
        );
        assert_eq!(field_zattrs["average_weights_ref"], "average_weights");

        let weights_zarray: serde_json::Value = serde_json::from_str(
            &std::fs::read_to_string(
                output_dir.join("hysteresis.zarr/fields/m/average_weights/.zarray"),
            )
            .expect("average weights Zarr metadata should exist"),
        )
        .expect("average weights Zarr metadata should be valid JSON");
        assert_eq!(weights_zarray["shape"], serde_json::json!([3]));
        assert_eq!(weights_zarray["dtype"], "<f8");
        let weight_chunk =
            std::fs::read(output_dir.join("hysteresis.zarr/fields/m/average_weights/0"))
                .expect("average weights chunk should exist");
        let weight_values = weight_chunk
            .chunks_exact(8)
            .map(|bytes| {
                let mut array = [0_u8; 8];
                array.copy_from_slice(bytes);
                f64::from_le_bytes(array)
            })
            .collect::<Vec<_>>();
        assert_eq!(weight_values, weights);

        std::fs::remove_dir_all(output_dir)
            .expect("temporary artifact directory should be removed");
    }

    #[test]
    fn checkpoint_initial_state_loads_hysteresis_zarr_snapshot() {
        let output_dir = std::env::temp_dir().join(format!(
            "fullmag-hysteresis-checkpoint-zarr-test-{}-{}",
            std::process::id(),
            std::time::SystemTime::now()
                .duration_since(std::time::UNIX_EPOCH)
                .expect("system time before unix epoch")
                .as_nanos(),
        ));
        let checkpoint_m = vec![[0.0, 0.0, 1.0], [0.0, 1.0, 0.0]];
        write_hysteresis_magnetization_snapshot(
            &output_dir,
            "hysteresis_point_007",
            6,
            -15.0,
            [2, 1, 1],
            &checkpoint_m,
            "uniform_sample_average",
            None,
            "every_step",
            HysteresisSnapshotIndexMetadata::default(),
        )
        .expect("checkpoint fixture should be written");

        let loaded = load_hysteresis_checkpoint_magnetization(
            &output_dir,
            "/v2/sessions/current/data/fields/m/samples/vector?component=full&scope_kind=full&snapshot_id=hysteresis_point_007",
            checkpoint_m.len(),
        )
        .expect("checkpoint state should load from Zarr snapshot");

        assert_eq!(loaded, checkpoint_m);

        std::fs::remove_dir_all(output_dir)
            .expect("temporary artifact directory should be removed");
    }

    #[test]
    fn checkpoint_initial_state_seeds_hysteresis_runtime() {
        let mut problem = minimal_fdm_hysteresis_problem();
        if let StudyIR::Hysteresis {
            field_values_mT,
            initial_protocol,
            initial_state_ref,
            settle_pipeline,
            ..
        } = &mut problem.study
        {
            *field_values_mT = Some(vec![0.0]);
            *initial_protocol = "checkpoint".to_string();
            *initial_state_ref = Some("hysteresis_point_009".to_string());
            *settle_pipeline = Some(SettlePipelineIR::Sequence {
                steps: vec![SettleStepIR::Relax {
                    method: "llg_overdamped".to_string(),
                    alpha: 1.0,
                    torque_tolerance: 1.0e-3,
                    max_steps: 1,
                    applies_to: None,
                    stop_criteria: None,
                    timestep_s: None,
                    max_pseudotime_s: None,
                    max_physical_time_s: None,
                    on_non_convergence: "continue_with_warning".to_string(),
                    retry_timestep_scale: None,
                    retry_max_attempts: None,
                }],
            });
        } else {
            panic!("minimal problem must be hysteresis");
        }
        let output_dir = std::env::temp_dir().join(format!(
            "fullmag-hysteresis-checkpoint-runtime-test-{}-{}",
            std::process::id(),
            std::time::SystemTime::now()
                .duration_since(std::time::UNIX_EPOCH)
                .expect("system time before unix epoch")
                .as_nanos(),
        ));
        let _ = std::fs::remove_dir_all(&output_dir);
        write_hysteresis_magnetization_snapshot(
            &output_dir,
            "hysteresis_point_009",
            8,
            0.0,
            [1, 1, 1],
            &[[0.0, 0.0, 1.0]],
            "uniform_sample_average",
            None,
            "every_step",
            HysteresisSnapshotIndexMetadata::default(),
        )
        .expect("checkpoint fixture should be written");

        crate::run_problem_with_callback(&problem, 0.0, &output_dir, 1, |_| StepAction::Continue)
            .expect("checkpoint hysteresis run should complete");

        let points: Vec<HysteresisPoint> = serde_json::from_str(
            &std::fs::read_to_string(output_dir.join("hysteresis_points.json"))
                .expect("hysteresis points should be written"),
        )
        .expect("hysteresis points should decode");

        assert_eq!(points.len(), 1);
        assert!(
            points[0].m_parallel > 0.9,
            "checkpoint z-oriented magnetization should seed the OOP point, got {:?}",
            points[0]
        );

        let _ = std::fs::remove_dir_all(&output_dir);
    }

    #[test]
    fn progress_artifact_writer_publishes_partial_points_with_snapshot_refs() {
        let output_dir = std::env::temp_dir().join(format!(
            "fullmag-hysteresis-progress-artifact-test-{}-{}",
            std::process::id(),
            std::time::SystemTime::now()
                .duration_since(std::time::UNIX_EPOCH)
                .expect("system time before unix epoch")
                .as_nanos(),
        ));
        let points = vec![test_hysteresis_point(
            0,
            25.0,
            0.8,
            Some("hysteresis_point_001"),
        )];
        let metrics = calculate_metrics(&points, "major_loop", None, None);
        let settle_trace = vec![HysteresisSettleTraceEntry {
            point_id: 0,
            field_value_mT: 25.0,
            step_index: 0,
            algorithm_id: "relax:0".to_string(),
            method: "llg_overdamped".to_string(),
            status: "Completed".to_string(),
            stop_reason: Some("Completed".to_string()),
            fallback_reason: None,
            retry_attempt: 0,
            resolved_timestep_s: Some(HYSTERESIS_SETTLE_STEP_DT_SECONDS),
            resolved_parameters: Some(serde_json::json!({
                "kind": "relax",
                "method": "llg_overdamped",
                "resolved_timestep_s": HYSTERESIS_SETTLE_STEP_DT_SECONDS
            })),
            torque: Some(1e-6),
            energy: Some(-1e-18),
        }];

        write_hysteresis_progress_artifacts(
            &output_dir,
            &points,
            &metrics,
            &settle_trace,
            None,
            Some("stage-000"),
        )
        .expect("progress artifacts should be written");

        let points_payload: serde_json::Value = serde_json::from_str(
            &std::fs::read_to_string(output_dir.join("hysteresis_points.json"))
                .expect("points artifact should exist"),
        )
        .expect("points artifact should be valid JSON");
        assert_eq!(
            points_payload[0]["snapshot_resource_ref"],
            "/v2/sessions/current/data/fields/m/samples/vector?component=full&scope_kind=full&snapshot_id=hysteresis_point_001&stage_id=stage-000",
        );
        assert_eq!(
            points_payload[0]["snapshot_vector_resource_ref"],
            "/v2/sessions/current/data/fields/m/samples/vector?component=full&scope_kind=full&snapshot_id=hysteresis_point_001&stage_id=stage-000",
        );
        assert_eq!(
            points_payload[0]["snapshot_json_artifact_ref"],
            "hysteresis_snapshots/hysteresis_point_001/m.json",
        );
        assert_eq!(
            points_payload[0]["snapshot_zarr_store_ref"],
            "hysteresis.zarr"
        );
        assert_eq!(
            points_payload[0]["snapshot_storage_format"],
            "zarr_v2_json_fallback",
        );
        assert!(output_dir.join("hysteresis_metrics.json").exists());
        assert!(output_dir.join("hysteresis_settle_trace.json").exists());

        std::fs::remove_dir_all(output_dir)
            .expect("temporary artifact directory should be removed");
    }

    #[test]
    fn adaptive_refinement_artifact_proposes_zero_and_high_susceptibility_points() {
        let points = vec![
            test_hysteresis_point(0, 10.0, 0.8, None),
            test_hysteresis_point(1, -10.0, -0.2, None),
        ];
        let policy = AdaptiveRefinementIR {
            kind: "adaptive_refinement".to_string(),
            enabled: true,
            max_passes: 2,
            max_insertions_per_pass: 8,
            dm_dh_threshold_per_mT: 0.01,
            max_step_mT: 5.0,
            min_step_mT: 0.1,
            include_zero_crossings: true,
            include_high_susceptibility: true,
        };

        let artifact = build_hysteresis_adaptive_refinement_artifact(Some(&policy), &points)
            .expect("adaptive policy should produce an artifact");

        assert_eq!(artifact.status, "proposed");
        assert!(artifact.candidates.iter().any(|candidate| same_field_value(
            candidate.field_value_mT,
            0.0
        ) && candidate.reasons
            == ["zero_crossing"]));
        assert!(artifact.candidates.iter().any(|candidate| {
            candidate
                .reasons
                .iter()
                .any(|reason| reason == "high_susceptibility")
        }));
    }

    #[test]
    fn adaptive_refinement_runtime_computes_branch_points_and_snapshots() {
        let mut problem = minimal_fdm_hysteresis_problem();
        if let StudyIR::Hysteresis {
            field_values_mT,
            adaptive_refinement,
            storage,
            ..
        } = &mut problem.study
        {
            *field_values_mT = Some(vec![10.0, -10.0]);
            *adaptive_refinement = Some(AdaptiveRefinementIR {
                kind: "adaptive_refinement".to_string(),
                enabled: true,
                max_passes: 1,
                max_insertions_per_pass: 4,
                dm_dh_threshold_per_mT: 10.0,
                max_step_mT: 5.0,
                min_step_mT: 0.1,
                include_zero_crossings: true,
                include_high_susceptibility: false,
            });
            *storage = Some(fullmag_ir::HysteresisStorageIR {
                scalar_history: true,
                magnetization: "every_step".to_string(),
                every_n: 1,
                key_events: false,
                key_event_threshold_dm: 0.02,
            });
        } else {
            panic!("minimal problem must be hysteresis");
        }
        let output_dir = std::env::temp_dir().join(format!(
            "fullmag-hysteresis-adaptive-runtime-test-{}",
            std::process::id()
        ));
        let _ = std::fs::remove_dir_all(&output_dir);

        crate::run_problem_with_callback(&problem, 0.0, &output_dir, 1, |_| StepAction::Continue)
            .expect("adaptive refinement hysteresis run should complete");

        let artifact_json =
            std::fs::read_to_string(output_dir.join("hysteresis_adaptive_refinement.json"))
                .expect("adaptive artifact should be written");
        let artifact: HysteresisAdaptiveRefinementArtifact =
            serde_json::from_str(&artifact_json).expect("adaptive artifact should decode");

        assert_eq!(artifact.status, "computed");
        assert!(
            !artifact.points.is_empty(),
            "adaptive refinement should compute at least one branch point"
        );
        assert_eq!(artifact.points[0].adaptive_inserted, Some(true));
        assert!(artifact.points[0]
            .refinement_reason
            .as_ref()
            .is_some_and(|reasons| reasons.iter().any(|reason| reason == "zero_crossing")));
        assert!(artifact.points[0].snapshot_id.is_some());
        assert_eq!(
            artifact.points[0].snapshot_vector_resource_ref.as_deref(),
            artifact.points[0].snapshot_resource_ref.as_deref()
        );
        assert!(artifact.points[0].snapshot_json_artifact_ref.is_some());
        assert_eq!(
            artifact.points[0].snapshot_zarr_store_ref.as_deref(),
            Some("hysteresis.zarr")
        );
        assert_eq!(
            artifact.points[0].snapshot_storage_format.as_deref(),
            Some("zarr_v2_json_fallback")
        );

        let _ = std::fs::remove_dir_all(&output_dir);
    }
}
