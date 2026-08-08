use fullmag_ir::{BackendTarget, ProblemIR};
use serde_json::Value;
use sha2::{Digest, Sha256};
use std::collections::{BTreeMap, BTreeSet};

/// Backend-neutral result of resolving one authored graph module for a lane.
///
/// The resolver carries semantic scope separately from the family payload.
/// `fem_marker_ids` and `fdm_cell_mask_id` are stable semantic identities; a
/// backend may replace them with realized topology identities only after it
/// validates the corresponding mesh/grid certificate.
#[derive(Debug, Clone, serde::Serialize, serde::Deserialize, PartialEq, Eq)]
pub struct ResolvedPhysicsModule {
    pub module_id: String,
    pub kind: String,
    pub requested_lane: String,
    pub resolved_lane: String,
    pub status: String,
    pub scope_key: String,
    #[serde(default, skip_serializing_if = "Vec::is_empty")]
    pub fem_marker_ids: Vec<u32>,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub fdm_cell_mask_id: Option<String>,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub reason: Option<String>,
}

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

/// Resolve the validated graph into lane-neutral semantic markers.
///
/// This function never infers scope from list position. It is usable before a
/// concrete mesh/grid exists, so the runner can carry module identity and
/// activation state into later topology realization.
pub fn resolve_physics_modules(
    problem: &ProblemIR,
    resolved_lane: BackendTarget,
) -> Result<Vec<ResolvedPhysicsModule>, Vec<String>> {
    let Some(graph) = resolve_physics_graph(problem)? else {
        return Ok(Vec::new());
    };
    let scene_revision = graph
        .get("scene_revision")
        .and_then(Value::as_u64)
        .unwrap_or_default();
    let modules = graph
        .get("modules")
        .and_then(Value::as_array)
        .expect("validated physics graph modules");
    let mut resolved = Vec::with_capacity(modules.len());
    for module in modules {
        let module_object = module
            .as_object()
            .expect("validated physics graph module");
        let module_id = module_object
            .get("id")
            .and_then(Value::as_str)
            .expect("validated physics graph module id")
            .to_string();
        let kind = module_object
            .get("kind")
            .and_then(Value::as_str)
            .unwrap_or("unsupported")
            .to_string();
        let authored_status = module_object
            .get("activation")
            .and_then(Value::as_str)
            .unwrap_or("unsupported")
            .to_string();
        let scope_key = module_scope_key(module_object);
        let requested_lane = requested_lane(module_object, problem);
        let mut status = authored_status.clone();
        let mut reason = None;
        if requested_lane != "auto"
            && requested_lane != resolved_lane.as_str()
            && status == "active"
        {
            status = "unsupported".to_string();
            reason = Some(format!(
                "module requests lane '{requested_lane}' but resolved lane is '{}'",
                resolved_lane.as_str()
            ));
        } else if matches!(
            status.as_str(),
            "blocked" | "inactive" | "unsupported" | "unresolved"
        ) {
            reason = module_object
                .get("family_payload")
                .and_then(Value::as_object)
                .and_then(|payload| payload.get("reason"))
                .and_then(Value::as_str)
                .map(str::to_string);
            if reason.is_none() {
                reason = Some(format!(
                    "activation status '{status}' retained from authored graph"
                ));
            }
        }
        let active = matches!(status.as_str(), "active" | "configured");
        let marker = active.then(|| {
            stable_marker_id(&format!("{scene_revision}:{module_id}:{scope_key}"))
        });
        let fdm_cell_mask_id = (active && resolved_lane == BackendTarget::Fdm).then(|| {
            format!(
                "physics-mask.v1:{module_id}:{}",
                scope_key.replace(':', "/")
            )
        });
        resolved.push(ResolvedPhysicsModule {
            module_id,
            kind,
            requested_lane,
            resolved_lane: resolved_lane.as_str().to_string(),
            status,
            scope_key,
            fem_marker_ids: marker.into_iter().collect(),
            fdm_cell_mask_id,
            reason,
        });
    }
    Ok(resolved)
}

/// Convert the resolved graph into compact, stable plan provenance notes.
///
/// `ProvenancePlanIR` predates the graph contract and remains source-compatible;
/// notes provide a backwards-compatible bridge until the next typed
/// provenance schema revision.
pub fn physics_graph_provenance_notes(
    problem: &ProblemIR,
    resolved_lane: BackendTarget,
) -> Result<Vec<String>, Vec<String>> {
    let Some(graph) = resolve_physics_graph(problem)? else {
        return Ok(Vec::new());
    };
    let scene_revision = graph
        .get("scene_revision")
        .and_then(Value::as_u64)
        .unwrap_or_default();
    let modules = resolve_physics_modules(problem, resolved_lane)?;
    Ok(modules
        .into_iter()
        .map(|module| {
            format!(
                "physics_graph.v1 scene_revision={scene_revision} module_id={} kind={} activation={} scope={} requested_lane={} resolved_lane={}{}",
                module.module_id,
                module.kind,
                module.status,
                module.scope_key,
                module.requested_lane,
                module.resolved_lane,
                module
                    .reason
                    .as_deref()
                    .map(|reason| format!(" reason={reason}"))
                    .unwrap_or_default(),
            )
        })
        .collect())
}

fn requested_lane(module: &serde_json::Map<String, Value>, problem: &ProblemIR) -> String {
    module
        .get("family_payload")
        .and_then(Value::as_object)
        .and_then(|payload| payload.get("requested_execution"))
        .and_then(Value::as_object)
        .and_then(|execution| execution.get("discretization"))
        .and_then(Value::as_str)
        .unwrap_or_else(|| problem.backend_policy.requested_backend.as_str())
        .to_string()
}

fn module_scope_key(module: &serde_json::Map<String, Value>) -> String {
    let Some(scopes) = module.get("applies_to").and_then(Value::as_array) else {
        return "unresolved".to_string();
    };
    if scopes.is_empty() {
        return "global".to_string();
    }
    let mut keys = scopes.iter().map(scope_key).collect::<Vec<_>>();
    keys.sort();
    keys.dedup();
    keys.join("+")
}

fn scope_key(scope: &Value) -> String {
    let Some(scope) = scope.as_object() else {
        return "unresolved".to_string();
    };
    match scope.get("kind").and_then(Value::as_str) {
        Some("global") => "global".to_string(),
        Some("object") => format!(
            "object:{}",
            scope
                .get("object_id")
                .and_then(Value::as_str)
                .unwrap_or("unresolved")
        ),
        Some("region") => format!(
            "region:{}:{}",
            scope
                .get("object_id")
                .and_then(Value::as_str)
                .unwrap_or("unresolved"),
            scope
                .get("region_id")
                .and_then(Value::as_str)
                .unwrap_or("unresolved")
        ),
        Some("cross_object") => {
            let mut ids = scope
                .get("object_ids")
                .and_then(Value::as_array)
                .into_iter()
                .flatten()
                .filter_map(Value::as_str)
                .collect::<Vec<_>>();
            ids.sort_unstable();
            format!("cross_object:{}", ids.join(","))
        }
        Some(kind) => format!("{kind}:{}", serde_json::to_string(scope).unwrap_or_default()),
        None => "unresolved".to_string(),
    }
}

fn stable_marker_id(value: &str) -> u32 {
    let digest = Sha256::digest(value.as_bytes());
    u32::from_be_bytes([digest[0], digest[1], digest[2], digest[3]])
}
