//! Bind portable authoring declarations before passing a problem to a planner.

use fullmag_ir::{
    ExecutionProfileIR, ExecutionRequestLayerIR, MaterializedExecutionRequestIR, ProblemIR,
};

/// A declared profile never resolves through host/environment defaults.
/// Explicit caller layers (for example CLI overrides) use the same resolver
/// and conflict rules as Study materialization. Ordinary legacy inputs retain
/// their byte-equivalent serialized model.
pub fn bind_declared_execution(
    problem: &ProblemIR,
    additional_layers: Vec<ExecutionRequestLayerIR>,
) -> Result<ProblemIR, String> {
    let metadata = &problem.problem_meta.runtime_metadata;
    let (profile, mut layers) = if let Some(value) = metadata.get("execution_profile") {
        if metadata.contains_key("execution_materialization") {
            return Err(
                "execution_intent_conflict: declared and materialized execution are both present"
                    .into(),
            );
        }
        let profile: ExecutionProfileIR = serde_json::from_value(value.clone())
            .map_err(|error| format!("invalid declared execution profile: {error}"))?;
        let layers = metadata
            .get("execution_layers")
            .map(|value| serde_json::from_value(value.clone()))
            .transpose()
            .map_err(|error| format!("invalid declared execution layers: {error}"))?
            .unwrap_or_default();
        (Some(profile), layers)
    } else if !additional_layers.is_empty() {
        let value = metadata
            .get("execution_materialization")
            .ok_or("no execution profile is declared for these override layers")?;
        let snapshot: MaterializedExecutionRequestIR = serde_json::from_value(value.clone())
            .map_err(|error| format!("invalid execution materialization: {error}"))?;
        crate::validate_execution_materialization(&snapshot)?;
        (snapshot.profile, snapshot.layers)
    } else {
        if metadata.contains_key("execution_layers") {
            return Err("execution layers require a declared profile".into());
        }
        if let Some(value) = metadata.get("execution_materialization") {
            let snapshot: MaterializedExecutionRequestIR = serde_json::from_value(value.clone())
                .map_err(|error| format!("invalid execution materialization: {error}"))?;
            crate::validate_execution_materialization(&snapshot)?;
        }
        return Ok(problem.clone());
    };
    layers.extend(additional_layers);
    let snapshot = crate::materialize_execution_request(profile, layers)?;
    let mut bound = crate::bind_materialized_execution(problem, &snapshot)?;
    let metadata = &mut bound.problem_meta.runtime_metadata;
    metadata.remove("execution_profile");
    metadata.remove("execution_layers");
    metadata.insert(
        "execution_materialization".into(),
        serde_json::to_value(&snapshot).map_err(|error| error.to_string())?,
    );
    Ok(bound)
}

#[cfg(test)]
#[path = "declared_execution_tests.rs"]
mod tests;
