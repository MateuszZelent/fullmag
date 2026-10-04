//! Snapshot-only projection of run constraints onto an immutable study step.

use crate::{RequestedExecution, RunSpecError};
use fullmag_ir::{ExecutionMode, ExecutionPrecision, ProblemIR};

impl RequestedExecution {
    /// Resolve task intent without probing a host or changing the accepted run.
    /// A concrete run constraint may narrow Auto, but cannot replace a concrete
    /// authored choice. Profile snapshots have already been bound to ProblemIR.
    pub fn for_problem(&self, problem: &ProblemIR) -> Result<Self, RunSpecError> {
        self.validate()?;
        let selection = problem
            .problem_meta
            .runtime_metadata
            .get("runtime_selection")
            .map(|value| {
                value.as_object().ok_or_else(|| {
                    RunSpecError::Invalid("ProblemIR.runtime_selection must be an object".into())
                })
            })
            .transpose()?;
        let device = match selection.and_then(|value| value.get("device")) {
            None => "auto",
            Some(value) => match value.as_str() {
                Some("auto") => "auto",
                Some("cpu") => "cpu",
                Some("gpu" | "cuda") => "gpu",
                _ => {
                    return Err(RunSpecError::Invalid(
                        "ProblemIR.runtime_selection.device must be auto, cpu or gpu".into(),
                    ))
                }
            },
        };
        let precision = match problem.backend_policy.execution_precision {
            ExecutionPrecision::Single => "single",
            ExecutionPrecision::Double => "double",
        };
        let mode = match problem.validation_profile.execution_mode {
            ExecutionMode::Strict => "strict",
            ExecutionMode::Extended => "extended",
            ExecutionMode::Hybrid => "hybrid",
        };
        let mut task = Self {
            backend: constrained(
                "backend",
                &self.backend,
                problem.backend_policy.requested_backend.as_str(),
            )?,
            device: constrained("device", &self.device, device)?,
            precision: constrained("precision", &self.precision, precision)?,
            mode: constrained("mode", &self.mode, mode)?,
            minimum_resources: self.minimum_resources.clone(),
        };
        // An Auto run can contain CPU and GPU tasks. Its conservative GPU
        // minimum applies only to GPU-capable tasks, never to a CPU lease.
        if task.device == "cpu" {
            if let Some(budget) = &mut task.minimum_resources {
                budget.gpu_memory_bytes = 0;
            }
        }
        task.validate()?;
        task.validate_problem_resources(problem)?;
        Ok(task)
    }
}

fn constrained(field: &str, run: &str, step: &str) -> Result<String, RunSpecError> {
    if run != "auto" && step != "auto" && run != step {
        return Err(RunSpecError::Invalid(format!(
            "execution_intent_conflict: RunSpec.requested_execution.{field}={run} conflicts with ProblemIR.{field}={step}"
        )));
    }
    Ok(if step == "auto" { run } else { step }.into())
}
