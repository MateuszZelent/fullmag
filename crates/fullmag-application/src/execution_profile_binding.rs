//! Apply a verified execution snapshot to a new immutable planner input.
//! The authored source is retained by the caller; no active run is modified.

use fullmag_ir::{
    ExecutionDevice, FdmPrecisionPolicyIR, MaterializedExecutionRequestIR, ProblemIR,
};
use serde_json::{json, Value};

pub fn bind_materialized_execution(
    problem: &ProblemIR,
    materialization: &MaterializedExecutionRequestIR,
) -> Result<ProblemIR, String> {
    crate::validate_execution_materialization(materialization)?;
    let requested = &materialization.requested;
    let mut bound = problem.clone();
    bound.backend_policy.requested_backend = requested.backend;
    bound.backend_policy.execution_precision = requested.precision;
    if bound.backend_policy.fdm_precision_policy.is_some() {
        bound.backend_policy.fdm_precision_policy =
            Some(FdmPrecisionPolicyIR::resolve(requested.precision));
    }
    bound.validation_profile.execution_mode = requested.mode;
    let metadata = &mut bound.problem_meta.runtime_metadata;
    let selection = metadata
        .entry("runtime_selection".into())
        .or_insert_with(|| json!({}));
    let selection = selection
        .as_object_mut()
        .ok_or("runtime_selection must be an object before profile binding")?;
    for (key, value) in [
        ("backend", serde_json::to_value(requested.backend)),
        ("execution_mode", serde_json::to_value(requested.mode)),
        (
            "execution_precision",
            serde_json::to_value(requested.precision),
        ),
    ] {
        selection.insert(key.into(), value.map_err(|error| error.to_string())?);
    }
    if selection.contains_key("precision") {
        selection.insert(
            "precision".into(),
            serde_json::to_value(requested.precision).map_err(|error| error.to_string())?,
        );
    }
    selection.insert(
        "device".into(),
        Value::String(
            match requested.device {
                ExecutionDevice::Auto => "auto",
                ExecutionDevice::Cpu => "cpu",
                ExecutionDevice::Gpu => "gpu",
            }
            .into(),
        ),
    );
    // This is a newly materialized input, not an environment mutation. The
    // canonical request retains explicit Auto while the legacy adapter omits
    // its numeric-only field so it cannot contradict that request.
    if let Some(threads) = requested.resources.cpu.threads.count() {
        selection.insert("cpu_threads".into(), json!(threads));
    } else {
        selection.remove("cpu_threads");
    }
    metadata.insert(
        "compute_resources".into(),
        serde_json::to_value(&requested.resources).map_err(|error| error.to_string())?,
    );
    bound.validate().map_err(|errors| errors.join("; "))?;
    Ok(bound)
}
