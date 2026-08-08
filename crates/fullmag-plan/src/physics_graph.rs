use fullmag_ir::ProblemIR;
use serde_json::Value;
use std::collections::{BTreeMap, BTreeSet};

/// Validate the optional authored graph before backend-specific lowering.
///
/// An absent graph is accepted for legacy ProblemIR.  A present graph is
/// treated as a source-of-truth contract: malformed identity or an active
/// module with a missing/inactive dependency fails closed.
pub fn resolve_physics_graph(problem: &ProblemIR) -> Result<Option<Value>, Vec<String>> {
    let Some(graph) = problem.physics_graph.as_ref() else {
        return Ok(None);
    };
    let object = graph
        .as_object()
        .ok_or_else(|| vec!["physics_graph must be an object".to_string()])?;
    if object.get("schema_version").and_then(Value::as_str) != Some("physics_graph.v1") {
        return Err(vec![
            "physics_graph.schema_version must be 'physics_graph.v1'".to_string(),
        ]);
    }
    let modules = object
        .get("modules")
        .and_then(Value::as_array)
        .ok_or_else(|| vec!["physics_graph.modules must be an array".to_string()])?;
    let mut statuses = BTreeMap::new();
    let mut errors = Vec::new();
    for (index, module) in modules.iter().enumerate() {
        let Some(module_object) = module.as_object() else {
            errors.push(format!("physics_graph.modules[{index}] must be an object"));
            continue;
        };
        let Some(id) = module_object.get("id").and_then(Value::as_str) else {
            errors.push(format!(
                "physics_graph.modules[{index}].id must be a string"
            ));
            continue;
        };
        if id.trim().is_empty() {
            errors.push(format!(
                "physics_graph.modules[{index}].id must not be empty"
            ));
            continue;
        }
        if statuses.contains_key(id) {
            errors.push(format!("physics_graph contains duplicate module id '{id}'"));
        }
        let activation = module_object
            .get("activation")
            .and_then(Value::as_str)
            .unwrap_or("unsupported");
        statuses.insert(id.to_string(), activation.to_string());
        for field in ["applies_to", "solve_domain", "depends_on"] {
            if !module_object.get(field).is_some_and(Value::is_array) {
                errors.push(format!(
                    "physics_graph.modules[{index}].{field} must be an array"
                ));
            }
        }
    }
    for (index, module) in modules.iter().enumerate() {
        let Some(module_object) = module.as_object() else {
            continue;
        };
        if module_object.get("activation").and_then(Value::as_str) != Some("active") {
            continue;
        }
        let Some(dependencies) = module_object.get("depends_on").and_then(Value::as_array) else {
            continue;
        };
        for dependency in dependencies.iter().filter_map(Value::as_str) {
            match statuses.get(dependency) {
                None => errors.push(format!(
                    "physics_graph.modules[{index}] is active but dependency '{dependency}' is absent"
                )),
                Some(status) if status != "active" && status != "configured" => errors.push(
                    format!(
                        "physics_graph.modules[{index}] is active but dependency '{dependency}' is {status}"
                    ),
                ),
                _ => {}
            }
        }
    }
    let edges = object
        .get("edges")
        .and_then(Value::as_array)
        .ok_or_else(|| vec!["physics_graph.edges must be an array".to_string()])?;
    let module_ids: BTreeSet<&str> = statuses.keys().map(String::as_str).collect();
    for (index, edge) in edges.iter().enumerate() {
        let Some(edge_object) = edge.as_object() else {
            errors.push(format!("physics_graph.edges[{index}] must be an object"));
            continue;
        };
        let source = edge_object.get("source_id").and_then(Value::as_str);
        let target = edge_object.get("target_id").and_then(Value::as_str);
        let status = edge_object.get("status").and_then(Value::as_str);
        if target.is_none_or(|id| !module_ids.contains(id)) {
            errors.push(format!(
                "physics_graph.edges[{index}] target_id is not a module"
            ));
        }
        if status == Some("active") && source.is_none_or(|id| !module_ids.contains(id)) {
            errors.push(format!(
                "physics_graph.edges[{index}] is active but source_id is not a module"
            ));
        }
    }
    if errors.is_empty() {
        Ok(Some(graph.clone()))
    } else {
        Err(errors)
    }
}
