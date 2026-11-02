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
}
impl PerformanceSession {
    pub(crate) fn observe(&mut self, stats: &crate::StepStats) {
        if let Some(recorder) = &mut self.recorder { recorder.observe(stats); }
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
    let key = std::fs::canonicalize(output).unwrap_or_else(|_| {
        if output.is_absolute() { output.to_path_buf() } else {
            std::env::current_dir().unwrap_or_default().join(output)
        }
    });
    let acquired = ACTIVE_OUTPUTS.get_or_init(Default::default).lock()
        .map(|mut active| active.insert(key.clone())).unwrap_or(false);
    if !acquired { return PerformanceSession { recorder: None, owned_output: None }; }
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
        "solver_wall_time_semantics": if cumulative_bb { "cumulative" } else { "backend_dependent_unknown" },
        "execution_provenance": "../metadata.json#/execution_provenance",
        "realization_label_semantics": "requested override; executed engine is authoritative in execution provenance",
    }), &realization);
    PerformanceSession { recorder: Some(recorder), owned_output: Some(key) }
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
