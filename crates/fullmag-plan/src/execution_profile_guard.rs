//! Reject unresolved declarations and later mutations of bound requested intent.
//! This validates binding only; application owns merge/replay and host admission
//! owns resource allocations. Auto can narrow to a concrete execution choice.

use fullmag_ir::{
    BackendTarget, ComputeResourcesIR, ExecutionDevice, MaterializedExecutionRequestIR, ProblemIR,
};

pub(crate) fn validate_bound_intent(problem: &ProblemIR) -> Result<(), String> {
    let metadata = &problem.problem_meta.runtime_metadata;
    if metadata.contains_key("execution_profile") || metadata.contains_key("execution_layers") {
        return Err("execution_profile_requires_materialization: bind declared profile intent through the shared application resolver before planning".into());
    }
    let Some(value) = metadata.get("execution_materialization") else {
        return Ok(());
    };
    let snapshot: MaterializedExecutionRequestIR = serde_json::from_value(value.clone())
        .map_err(|error| format!("invalid execution materialization: {error}"))?;
    snapshot.validate_shape()?;
    let requested = &snapshot.requested;
    let selection = metadata
        .get("runtime_selection")
        .and_then(serde_json::Value::as_object)
        .ok_or("bound execution is missing runtime_selection")?;
    let device = match selection.get("device").and_then(serde_json::Value::as_str) {
        Some("auto") => ExecutionDevice::Auto,
        Some("cpu") => ExecutionDevice::Cpu,
        Some("gpu" | "cuda") => ExecutionDevice::Gpu,
        Some(value) if value.starts_with("cuda:") => ExecutionDevice::Gpu,
        _ => return Err("bound execution has invalid runtime_selection.device".into()),
    };
    if (requested.backend != BackendTarget::Auto
        && requested.backend != problem.backend_policy.requested_backend)
        || (requested.device != ExecutionDevice::Auto && requested.device != device)
        || requested.precision != problem.backend_policy.execution_precision
        || requested.mode != problem.validation_profile.execution_mode
        || ComputeResourcesIR::from_problem(problem)?.as_ref() != Some(&requested.resources)
    {
        return Err("execution_intent_conflict: immutable bound execution differs from planner input; apply explicit changes through the shared resolver".into());
    }
    Ok(())
}

#[cfg(test)]
mod tests {
    use super::*;
    #[test]
    fn unresolved_profile_and_malformed_binding_fail_closed() {
        let mut problem = ProblemIR::bootstrap_example();
        problem
            .problem_meta
            .runtime_metadata
            .insert("execution_profile".into(), serde_json::json!({}));
        assert!(validate_bound_intent(&problem)
            .unwrap_err()
            .contains("requires_materialization"));
        problem
            .problem_meta
            .runtime_metadata
            .remove("execution_profile");
        problem
            .problem_meta
            .runtime_metadata
            .insert("execution_materialization".into(), serde_json::json!({}));
        assert!(validate_bound_intent(&problem)
            .unwrap_err()
            .contains("invalid execution materialization"));
    }
}
