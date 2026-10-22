//! Preserve authored structure separately from actual script-stage expansion.
//! This application result is not a StudyPlan, accepted catalog, or readiness
//! certificate. State ports and qualified antenna bases require later lowering.

use anyhow::{bail, Context, Result};
use std::collections::{BTreeMap, BTreeSet};

use crate::script_stage_contract::{
    ResolvedScriptStage, ScriptExecutionConfig, StudyPipelineDocument, StudyPipelineNode, ScriptStageProvenance,
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
        let digest = fullmag_ir::canonical_ir_json_sha256(&serde_json::json!({
            "schema": "fullmag.script-execution-identity.v1",
            "authored_step_id": source.authored_step_id,
            "expansion_index": source.expansion_index,
        }))?;
        // The identity is also a durable repository component. Keep authored
        // text inside the digest, not in a platform-dependent path segment.
        let execution_id = format!("script-execution-{digest}");
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
    })
}

pub(crate) fn authored_node<'a>(nodes:&'a [StudyPipelineNode], id:&str) -> Option<&'a StudyPipelineNode> {
    for node in nodes {
        let node_id=match node {StudyPipelineNode::Primitive{id,..}|StudyPipelineNode::Macro{id,..}|StudyPipelineNode::Group{id,..}=>id};
        if node_id==id { return Some(node); }
        if let StudyPipelineNode::Group{children,..}=node { if let Some(found)=authored_node(children,id) {return Some(found);} }
    }
    None
}

/// Dual representations are accepted only for complete ordered physical snapshots.
/// The existing explicit materializer owns numerical state; final base IR is never replayed over it.
fn validate_physical_snapshot_coverage(document:&StudyPipelineDocument,nodes:&[ScriptPipelineNodeBinding],config:&ScriptExecutionConfig)->Result<()> {
    let reject=||anyhow::anyhow!("pipeline compilation cannot mix explicit stages with study_pipeline unless complete ordered Relax/Run snapshots match authored nodes");
    if document.version!="study_pipeline.v1" {return Err(reject());}
    let mut ids=BTreeSet::new();
    for node in nodes {
        if node.authored_step_id.trim().is_empty() || !ids.insert(&node.authored_step_id) {return Err(reject());}
        match authored_node(&document.nodes,&node.authored_step_id) {
            Some(StudyPipelineNode::Group{..})=>{},
            Some(StudyPipelineNode::Primitive{stage_kind,..}) if matches!(stage_kind.as_str(),"relax"|"run")=>{},
            _=>return Err(reject()),
        }
    }
    let expected:Vec<_>=nodes.iter().filter(|node|node.kind==ScriptPipelineNodeKind::Primitive && node.effectively_enabled).collect();
    if config.stages.len()!=expected.len() {return Err(reject());}
    for (snapshot,binding) in config.stages.iter().zip(expected) {
        if snapshot.action.is_some() || snapshot.ir.problem_meta.runtime_metadata.get("active_stage_id").and_then(serde_json::Value::as_str)!=Some(binding.authored_step_id.as_str()) {
            return Err(reject());
        }
        let Some(StudyPipelineNode::Primitive{stage_kind,..})=authored_node(&document.nodes,&binding.authored_step_id) else {return Err(reject());};
        if !matches!((stage_kind.as_str(),&snapshot.ir.study),("relax",fullmag_ir::StudyIR::Relaxation{..})|("run",fullmag_ir::StudyIR::TimeEvolution{..})) {return Err(reject());}
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
