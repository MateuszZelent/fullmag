//! Preserve authored structure separately from actual script-stage expansion.
//! This application result is not a StudyPlan, accepted catalog, or readiness
//! certificate. State ports and qualified antenna bases require later lowering.

use anyhow::{bail, Context, Result};
use std::collections::{BTreeMap, BTreeSet};

use crate::script_stage_contract::{
    ResolvedScriptStage, ScriptExecutionConfig, ScriptExecutionStageAction, StageMagnetizationAssignments, StudyPipelineDocument, StudyPipelineNode, ScriptStageProvenance,
};
use crate::script_stage_materialization::{
    materialize_script_stages_with_output_policy_bounded, StageOutputPolicy,
};

#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub enum ScriptPipelineNodeKind {
    Primitive,
    Macro,
    Group,
}

#[derive(Debug, Clone)]
pub struct ScriptPipelineNodeBinding {
    pub authored_step_id: String,
    pub ancestor_group_ids: Vec<String>,
    pub kind: ScriptPipelineNodeKind,
    /// Includes ancestor enablement; the original local flag stays in the tree.
    pub effectively_enabled: bool,
    /// Empty for groups, in-place mutations, and disabled nodes.
    pub execution_ids: Vec<String>,
}

#[derive(Debug, Clone)]
pub struct CompiledScriptExecution {
    /// Separate from active_stage_id, which retains authored activation semantics.
    pub execution_id: String,
    pub stage: ResolvedScriptStage,
}

#[derive(Debug, Clone)]
pub struct ScriptPipelineCompilation {
    pub authored_pipeline: StudyPipelineDocument,
    pub authored_pipeline_sha256: String,
    pub nodes: Vec<ScriptPipelineNodeBinding>,
    pub executions: Vec<CompiledScriptExecution>,
    pub(crate) magnetization_assignments: BTreeMap<String, StageMagnetizationAssignments>,
}

/// Stable durable ID for one execution of an authored pipeline node.
pub fn script_execution_id(
    authored_step_id: &str,
    expansion_index: u64,
) -> Result<String, serde_json::Error> {
    let digest = fullmag_ir::canonical_ir_json_sha256(&serde_json::json!({
        "schema": "fullmag.script-execution-identity.v1",
        "authored_step_id": authored_step_id,
        "expansion_index": expansion_index,
    }))?;
    Ok(format!("script-execution-{digest}"))
}

/// Materialize through the existing sequential owner exactly once. The binding
/// traversal below only inventories authored identities; it never applies a
/// payload, expands a macro, or creates a physical ProblemIR.
pub fn materialize_script_pipeline_with_output_policy_bounded(
    config: ScriptExecutionConfig,
    output_policy: StageOutputPolicy,
    max_stages: usize,
) -> Result<ScriptPipelineCompilation> {
    let authored_pipeline = config
        .study_pipeline
        .as_ref()
        .context("pipeline compilation requires an authored study_pipeline")?
        .clone();
    let magnetization_assignments = authored_pipeline.magnetization_assignments_by_stage()?;
    let explicit = !config.stages.is_empty();
    let mut nodes = Vec::new();
    collect_node_bindings(&authored_pipeline.nodes, &[], true, &mut nodes);
    if explicit { validate_physical_snapshot_coverage(&authored_pipeline, &nodes, &config)?; }
    let authored_pipeline_sha256 =
        fullmag_ir::canonical_ir_json_sha256(&serde_json::to_value(&authored_pipeline)?)?;
    let mut stages =
        materialize_script_stages_with_output_policy_bounded(config, output_policy, max_stages)?;
    if explicit {
        let expected: Vec<_> = nodes.iter().filter(|node| node.kind == ScriptPipelineNodeKind::Primitive && node.effectively_enabled).collect();
        if stages.len() != expected.len() { bail!("explicit physical snapshot coverage changed during materialization"); }
        for (stage,binding) in stages.iter_mut().zip(expected) {
            if stage.ir.problem_meta.runtime_metadata.get("active_stage_id").and_then(serde_json::Value::as_str) != Some(binding.authored_step_id.as_str()) {
                bail!("materialized snapshot changed its authored stage identity");
            }
            let Some(StudyPipelineNode::Primitive {label,notes,source,..}) = authored_node(&authored_pipeline.nodes,&binding.authored_step_id) else {
                bail!("explicit physical snapshot has no primitive authored owner");
            };
            stage.provenance=Some(ScriptStageProvenance {authored_step_id:binding.authored_step_id.clone(),expansion_index:0,
                ancestor_group_ids:binding.ancestor_group_ids.clone(),label:label.clone(),notes:notes.clone(),source:source.clone()});
        }
    }
    let mut physical_clock = None;
    for stage in &mut stages {
        if stage.action.is_none() && matches!(stage.ir.study, fullmag_ir::StudyIR::TimeEvolution { .. }) {
            let start = physical_clock.unwrap_or(read_physical_stage_start(&stage.ir)?);
            physical_clock = Some(advance_physical_clock(start, stage.until_seconds)?);
            stage.ir.problem_meta.runtime_metadata.insert("stage_start_time_s".into(), serde_json::json!(start));
        }
    }
    let by_id: BTreeMap<_, _> = nodes
        .iter()
        .enumerate()
        .map(|(index, node)| (node.authored_step_id.clone(), index))
        .collect();
    let mut execution_ids = BTreeSet::new();
    let mut executions = Vec::with_capacity(stages.len());
    for stage in stages {
        let source = stage
            .provenance
            .as_ref()
            .context("pipeline execution is missing authored provenance")?;
        let index = by_id
            .get(&source.authored_step_id)
            .context("pipeline execution references an unknown authored node")?;
        let node = &mut nodes[*index];
        if !node.effectively_enabled
            || node.kind == ScriptPipelineNodeKind::Group
            || node.ancestor_group_ids != source.ancestor_group_ids
            || source.expansion_index != node.execution_ids.len()
            || (node.kind == ScriptPipelineNodeKind::Primitive && source.expansion_index != 0)
        {
            bail!("pipeline execution provenance disagrees with its authored node");
        }
        let execution_id = script_execution_id(
            &source.authored_step_id,
            u64::try_from(source.expansion_index)?,
        )?;
        if !execution_ids.insert(execution_id.clone()) {
            bail!("duplicate generated script execution identity");
        }
        node.execution_ids.push(execution_id.clone());
        executions.push(CompiledScriptExecution {
            execution_id,
            stage,
        });
    }
    Ok(ScriptPipelineCompilation {
        authored_pipeline,
        authored_pipeline_sha256,
        nodes,
        executions,
        magnetization_assignments,
    })
}

pub(crate) fn read_physical_stage_start(problem: &fullmag_ir::ProblemIR) -> Result<f64> {
    let start = match problem.problem_meta.runtime_metadata.get("stage_start_time_s") {
        None => 0.0,
        Some(value) => value.as_f64().context("physical stage start must be numeric")?,
    };
    if !start.is_finite() || start < 0.0 { bail!("physical stage start must be finite and nonnegative"); }
    Ok(start)
}

pub(crate) fn advance_physical_clock(start: f64, duration: f64) -> Result<f64> {
    let end = start + duration;
    if !duration.is_finite() || duration <= 0.0 || !end.is_finite() || end <= start {
        bail!("physical Run duration must advance a finite clock");
    }
    Ok(end)
}

pub(crate) fn authored_node<'a>(nodes:&'a [StudyPipelineNode], id:&str) -> Option<&'a StudyPipelineNode> {
    for node in nodes {
        let node_id=match node {StudyPipelineNode::Primitive{id,..}|StudyPipelineNode::Macro{id,..}|StudyPipelineNode::Group{id,..}=>id};
        if node_id==id { return Some(node); }
        if let StudyPipelineNode::Group{children,..}=node { if let Some(found)=authored_node(children,id) {return Some(found);} }
    }
    None
}

pub(crate) fn is_input_configuration_node(node: &StudyPipelineNode) -> bool {
    let StudyPipelineNode::Primitive { stage_kind, .. } = node else {
        return false;
    };
    serde_json::from_value::<fullmag_authoring::StudyPrimitiveStageKind>(
        serde_json::Value::String(stage_kind.clone()),
    ).is_ok_and(|kind| kind.is_pipeline_input_configuration())
}

/// Dual representations require complete ordered snapshots with matching authored selections.
/// The existing explicit materializer owns numerical state; final base IR is never replayed over it.
fn validate_physical_snapshot_coverage(document:&StudyPipelineDocument,nodes:&[ScriptPipelineNodeBinding],config:&ScriptExecutionConfig)->Result<()> {
    let reject=||anyhow::anyhow!("pipeline compilation cannot mix explicit stages with study_pipeline unless complete ordered physical and supported configuration snapshots match authored nodes");
    let mut ids=BTreeSet::new();
    for node in nodes {
        if node.authored_step_id.trim().is_empty() || !ids.insert(&node.authored_step_id) {return Err(reject());}
        match authored_node(&document.nodes,&node.authored_step_id) {
            Some(StudyPipelineNode::Group{..})=>{},
            Some(StudyPipelineNode::Primitive{stage_kind,..}) if matches!(stage_kind.as_str(),"relax"|"run"|"antenna_field_solve")=>{},
            Some(node) if is_input_configuration_node(node)=>{},
            _=>return Err(reject()),
        }
    }
    let expected:Vec<_>=nodes.iter().filter(|node|node.kind==ScriptPipelineNodeKind::Primitive && node.effectively_enabled).collect();
    if config.stages.len()!=expected.len() {return Err(reject());}
    for (snapshot,binding) in config.stages.iter().zip(expected) {
        if snapshot.ir.problem_meta.runtime_metadata.get("active_stage_id").and_then(serde_json::Value::as_str)!=Some(binding.authored_step_id.as_str()) {
            return Err(reject());
        }
        let Some(StudyPipelineNode::Primitive{stage_kind,payload,..})=authored_node(&document.nodes,&binding.authored_step_id) else {return Err(reject());};
        match (stage_kind.as_str(), snapshot.action.as_ref(), &snapshot.ir.study) {
            ("relax", None, fullmag_ir::StudyIR::Relaxation { .. })
            | ("run", None, fullmag_ir::StudyIR::TimeEvolution { .. }) => {},
            ("antenna_field_solve", Some(crate::script_stage_contract::ScriptExecutionStageAction::AntennaFieldSolve {
                stage_id, port_mode_id, port_mode_ids,
            }), _) => {
                let (authored_stage_id, authored_port_id) =
                    crate::script_stage_materialization::parse_antenna_solve_selection(payload)?;
                let snapshot_port_id = crate::script_stage_materialization::select_antenna_port_reference(
                    port_mode_id.as_deref(), port_mode_ids)?;
                if stage_id != &authored_stage_id || snapshot_port_id != authored_port_id { return Err(reject()); }
            },
            (_, Some(action), _) if matches!(action,
                ScriptExecutionStageAction::TableAutosave { .. }
                | ScriptExecutionStageAction::Autosave { .. }
                | ScriptExecutionStageAction::AddFieldDrive { .. }
                | ScriptExecutionStageAction::RemoveFieldDrive { .. }
            ) => {
                let mut authored = serde_json::to_value(payload)?;
                authored["kind"] = serde_json::Value::String(stage_kind.clone());
                let expected: ScriptExecutionStageAction = serde_json::from_value(authored)
                    .with_context(|| format!("invalid authored configuration for '{}'", binding.authored_step_id))?;
                if action != &expected {
                    bail!("configuration snapshot for '{}' differs from its authored payload", binding.authored_step_id);
                }
            },
            _ => return Err(reject()),
        }
    }
    Ok(())
}

pub(crate) fn collect_node_bindings(
    authored: &[StudyPipelineNode],
    ancestors: &[String],
    parent_enabled: bool,
    out: &mut Vec<ScriptPipelineNodeBinding>,
) {
    for node in authored {
        let (id, enabled, kind) = match node {
            StudyPipelineNode::Primitive { id, enabled, .. } => {
                (id, enabled, ScriptPipelineNodeKind::Primitive)
            }
            StudyPipelineNode::Macro { id, enabled, .. } => {
                (id, enabled, ScriptPipelineNodeKind::Macro)
            }
            StudyPipelineNode::Group { id, enabled, .. } => {
                (id, enabled, ScriptPipelineNodeKind::Group)
            }
        };
        let effectively_enabled = parent_enabled && *enabled;
        out.push(ScriptPipelineNodeBinding {
            authored_step_id: id.clone(),
            ancestor_group_ids: ancestors.to_vec(),
            kind,
            effectively_enabled,
            execution_ids: Vec::new(),
        });
        if let StudyPipelineNode::Group { children, .. } = node {
            let mut path = ancestors.to_vec();
            path.push(id.clone());
            collect_node_bindings(children, &path, effectively_enabled, out);
        }
    }
}

#[cfg(test)]
#[path = "script_pipeline_compilation_tests.rs"]
mod tests;
