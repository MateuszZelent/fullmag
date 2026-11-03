//! Small adapters for the common runner entry points; numerical lanes stay unchanged.
use std::path::Path;
use std::{collections::HashSet, path::PathBuf, sync::{Mutex, OnceLock}};

use fullmag_ir::{ExecutionPlanIR, ProblemIR};

use crate::{run_performance::RunPerformanceRecorder, RunError, RunResult};

static ACTIVE_OUTPUTS: OnceLock<Mutex<HashSet<PathBuf>>> = OnceLock::new();

/// A nested runner adapter shares the owning execution's recorder rather than
/// opening the same artifacts twice. The registry is never used on a step.
pub(crate) struct PerformanceSession {
    recorder: Option<RunPerformanceRecorder>,
    owned_output: Option<PathBuf>,
    numeric_steps: HysteresisNumericSteps,
}

/// Observation-only accepted-step index across independent settle executions.
/// Initial states, repeated polls and terminal field snapshots are not steps.
#[derive(Default)]
struct HysteresisNumericSteps {
    total: u64,
    local: u64,
}
impl HysteresisNumericSteps {
    fn begin_segment(&mut self) { self.local = 0; }

    fn observe(&mut self, local: u64) -> Option<u64> {
        if local <= self.local { return None; }
        self.total = self.total.saturating_add(local - self.local);
        self.local = local;
        Some(self.total)
    }
}

impl PerformanceSession {
    pub(crate) fn disabled() -> Self {
        Self { recorder: None, owned_output: None, numeric_steps: Default::default() }
    }

    pub(crate) fn observe(&mut self, stats: &crate::StepStats) {
        if let Some(recorder) = &mut self.recorder { recorder.observe(stats); }
    }

    pub(crate) fn begin_hysteresis_segment(&mut self) {
        self.numeric_steps.begin_segment();
    }

    pub(crate) fn observe_hysteresis_numeric(&mut self, update: &crate::StepUpdate) {
        if update.terminal_field_snapshot { return; }
        let Some(step) = self.numeric_steps.observe(update.stats.step) else { return; };
        if let Some(recorder) = &mut self.recorder {
            let mut stats = update.stats.clone();
            stats.step = step;
            recorder.observe(&stats);
        }
    }
}
impl Drop for PerformanceSession {
    fn drop(&mut self) {
        self.recorder.take();
        if let Some(output) = &self.owned_output {
            if let Ok(mut active) = ACTIVE_OUTPUTS.get_or_init(Default::default).lock() {
                active.remove(output);
            }
        }
    }
}

pub(crate) fn start(problem: &ProblemIR, plan: &ExecutionPlanIR, output: &Path, capture: &str) -> PerformanceSession {
    // Only the hysteresis core sees the actual numerical callback boundary.
    // Outer adapters also receive UI progress and globally numbered summaries.
    if matches!(problem.study, fullmag_ir::StudyIR::Hysteresis { .. })
        && capture != "hysteresis_numeric_callbacks" {
        return PerformanceSession::disabled();
    }
    let key = std::fs::canonicalize(output).unwrap_or_else(|_| {
        if output.is_absolute() { output.to_path_buf() } else {
            std::env::current_dir().unwrap_or_default().join(output)
        }
    });
    let acquired = ACTIVE_OUTPUTS.get_or_init(Default::default).lock()
        .map(|mut active| active.insert(key.clone())).unwrap_or(false);
    if !acquired { return PerformanceSession::disabled(); }
    let requested = crate::solver_runtime::selection::runtime_device_override(problem)
        .or(crate::solver_runtime::selection::runtime_device(problem))
        .unwrap_or("unspecified");
    let backend = match &plan.backend_plan {
        fullmag_ir::BackendPlanIR::Fdm(_) | fullmag_ir::BackendPlanIR::FdmMultilayer(_) => "fdm",
        fullmag_ir::BackendPlanIR::Fem(_) | fullmag_ir::BackendPlanIR::FemEigen(_)
            | fullmag_ir::BackendPlanIR::FemFrequencyResponse(_) => "fem",
        _ => "other",
    };
    let realization = format!("{backend}_{requested}");
    let cumulative_bb = matches!(&plan.backend_plan, fullmag_ir::BackendPlanIR::FdmMultilayer(p)
        if p.relaxation.as_ref().is_some_and(|r| r.algorithm == fullmag_ir::RelaxationAlgorithmIR::ProjectedGradientBb));
    let recorder = RunPerformanceRecorder::start(output, serde_json::json!({
        "problem_name": problem.problem_meta.name,
        "source_hash": problem.problem_meta.source_hash,
        "backend_revision": problem.problem_meta.backend_revision,
        "plan_common": {
            "ir_version": plan.common.ir_version,
            "requested_backend": plan.common.requested_backend,
            "resolved_backend": plan.common.resolved_backend,
            "execution_mode": plan.common.execution_mode,
        },
        "accepted_identity": problem.problem_meta.runtime_metadata.get("performance_execution_identity"),
        "requested_runtime": problem.problem_meta.runtime_metadata.get("runtime_selection"),
        "device_override": problem.problem_meta.runtime_metadata.get("runtime_device_override"),
        "output_directory": output.to_string_lossy(),
        "step_capture": capture,
        "step_index_semantics": if capture == "hysteresis_numeric_callbacks" {
            "sum_of_observed_local_accepted_step_increments_across_settle_executions; initial_states_and_progress_excluded"
        } else { "backend_reported" },
        "solver_wall_time_semantics": if cumulative_bb { "cumulative" } else { "backend_dependent_unknown" },
        "execution_provenance": "../metadata.json#/execution_provenance",
        "realization_label_semantics": "requested override; executed engine is authoritative in execution provenance",
    }), &realization);
    PerformanceSession { recorder: Some(recorder), owned_output: Some(key), numeric_steps: Default::default() }
}

pub(crate) fn finish(session: &mut PerformanceSession, result: &Result<RunResult, RunError>) {
    let Some(recorder) = &mut session.recorder else { return; };
    recorder.finish(match result {
        Ok(run) => match run.status {
            crate::RunStatus::Completed => "completed",
            crate::RunStatus::Failed => "failed",
            crate::RunStatus::Cancelled => "cancelled",
            crate::RunStatus::Paused => "paused",
        },
        Err(_) => "error",
    });
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn segmented_numeric_callbacks_preserve_later_timings_and_rejections_once() {
        let output = tempfile::tempdir().unwrap();
        let mut session = PerformanceSession {
            recorder: Some(RunPerformanceRecorder::start(output.path(), serde_json::json!({}), "fdm_cpu")),
            owned_output: None,
            numeric_steps: Default::default(),
        };
        // Two points and a repeated settle/retry; no initial snapshot is
        // required for a new segment, and duplicate polls never add work.
        for segment in 0..3 {
            session.begin_hysteresis_segment();
            for local in [0, 1, 1, 2, 2] {
                let stats = crate::StepStats {
                    step: local,
                    rejected_attempts: segment + 1,
                    relaxation_line_search_wall_time_ns: u64::from(segment + 1) * 100,
                    ..Default::default()
                };
                let update = serde_json::from_value(serde_json::json!({
                    "stats": stats, "grid": [1, 1, 1],
                })).unwrap();
                session.observe_hysteresis_numeric(&update);
            }
        }
        session.recorder.as_mut().unwrap().finish("completed");
        let summary: serde_json::Value = serde_json::from_slice(
            &std::fs::read(output.path().join("performance/summary.json")).unwrap()).unwrap();
        assert_eq!(summary["coverage"]["unique_step_callback_records"], 6);
        assert_eq!(summary["coverage"]["last_step_index"], 6);
        assert_eq!(summary["step_reported_counters"]["sum_step_reported_rejected_attempts"], 12);
        assert_eq!(summary["terminal_stats_snapshot"]["timings_ns"]["relaxation_line_search_wall_time_ns"], 300);
        let csv = std::fs::read_to_string(output.path().join("performance/steps.csv")).unwrap();
        let rows = csv.lines().skip(1).collect::<Vec<_>>();
        assert_eq!(rows.len(), 6);
        assert!(rows.last().unwrap().contains(",300,"), "the last retry's timing is retained");
    }
}
