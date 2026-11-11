//! Nonexecuted BB pipeline carrier validation. This never authorizes planning
//! the carrier's TimeEvolution study as a BB solver.
use crate::{BackendTarget, ProblemIR, StudyIR};
use serde_json::Value;
use std::collections::BTreeSet;

pub fn is_gpu_bb_only_pipeline(value: &Value) -> bool {
    fn visit(
        value: &Value,
        parent_enabled: bool,
        depth: usize,
        seen: &mut BTreeSet<String>,
        count: &mut usize,
    ) -> bool {
        let Some(nodes) = value.as_array() else {
            return false;
        };
        if depth > 64 {
            return false;
        }
        for value in nodes {
            let Some(node) = value.as_object() else {
                return false;
            };
            let kind = node.get("node_kind").and_then(Value::as_str);
            let common = ["node_kind", "id", "label", "enabled", "notes", "source"];
            let extra: &[&str] = match kind {
                Some("primitive") => &["stage_kind", "payload"],
                Some("group") => &["children", "collapsed"],
                _ => return false,
            };
            if node
                .keys()
                .any(|key| !common.contains(&key.as_str()) && !extra.contains(&key.as_str()))
            {
                return false;
            }
            let Some(id) = node.get("id").and_then(Value::as_str) else {
                return false;
            };
            if id.trim().is_empty()
                || seen.len() >= 4096
                || !seen.insert(id.to_owned())
                || node.get("label").and_then(Value::as_str).is_none()
                || ["notes", "source"].iter().any(|key| {
                    node.get(*key)
                        .is_some_and(|v| !v.is_null() && !v.is_string())
                })
            {
                return false;
            }
            let enabled = match node.get("enabled") {
                None => true,
                Some(v) => match v.as_bool() {
                    Some(b) => b,
                    None => return false,
                },
            } && parent_enabled;
            if kind == Some("group") {
                if node.get("collapsed").is_some_and(|v| !v.is_boolean()) {
                    return false;
                }
                let empty = Value::Array(vec![]);
                if !visit(
                    node.get("children").unwrap_or(&empty),
                    enabled,
                    depth + 1,
                    seen,
                    count,
                ) {
                    return false;
                }
            } else {
                let Some(stage_kind) = node.get("stage_kind").and_then(Value::as_str) else {
                    return false;
                };
                let empty = serde_json::Map::new();
                let payload = match node.get("payload") {
                    None => &empty,
                    Some(v) => match v.as_object() {
                        Some(p) => p,
                        None => return false,
                    },
                };
                if enabled {
                    let algorithms = ["algorithm", "relax_algorithm"]
                        .iter()
                        .filter_map(|key| payload.get(*key))
                        .collect::<Vec<_>>();
                    if stage_kind != "relax"
                        || algorithms.is_empty()
                        || algorithms
                            .iter()
                            .any(|v| v.as_str() != Some("projected_gradient_bb"))
                        || payload
                            .get("kind")
                            .is_some_and(|v| v.as_str() != Some("relax"))
                        || payload.get("entrypoint_kind").is_some_and(|v| {
                            !matches!(
                                v.as_str(),
                                Some("flat_relax" | "study_pipeline_relax" | "build")
                            )
                        })
                        || payload
                            .get("enabled")
                            .is_some_and(|v| v.as_bool() != Some(true))
                    {
                        return false;
                    }
                    *count += 1;
                }
            }
        }
        true
    }
    let Some(object) = value.as_object() else {
        return false;
    };
    if object.keys().any(|key| key != "version" && key != "nodes")
        || !matches!(
            object.get("version").and_then(Value::as_str),
            Some("study_pipeline.v1" | "study_pipeline.v2")
        )
    {
        return false;
    }
    let mut count = 0;
    object
        .get("nodes")
        .is_some_and(|nodes| visit(nodes, true, 0, &mut BTreeSet::new(), &mut count))
        && count > 0
}

pub fn is_gpu_bb_pipeline_carrier(problem: &ProblemIR) -> bool {
    let metadata = &problem.problem_meta.runtime_metadata;
    problem
        .backend_policy
        .discretization_hints
        .as_ref()
        .and_then(|hints| hints.fem.as_ref())
        .and_then(|fem| fem.gpu_bb_preconditioner)
        .is_some()
        && problem.backend_policy.requested_backend == BackendTarget::Fem
        && problem.problem_meta.entrypoint_kind == "flat_workspace"
        && matches!(&problem.study, StudyIR::TimeEvolution { .. })
        && !metadata.contains_key("active_stage_id")
        && metadata
            .get("runtime_selection")
            .and_then(|v| v.get("device"))
            .and_then(Value::as_str)
            == Some("gpu")
        && metadata
            .get("study_pipeline")
            .is_some_and(is_gpu_bb_only_pipeline)
}
