//! Compile actual executions into accepted tasks; never reinterpret authored groups as work.
use anyhow::{bail, Context, Result};
use fullmag_authoring::{StudyAcceptancePolicy, StudyAcquisitionPolicy, StudyExecutionProfileReference, StudyOutputPort, StudyPlan, StudyPortDataKind, StudyStep, StudyStepKind};
use fullmag_ir::{ExecutionProfileIR, ExecutionRequestLayerIR};
use fullmag_plan::{capture_study_input_references, StudyProblemCatalog, StudyProblemCatalogEntry};
use serde_json::{json, Value};
use std::collections::BTreeSet;
use crate::{ImmutableAssetReference, RunSpecification, ScriptPipelineNodeKind};
use crate::script_stage_contract::{ResolvedScriptStageAction, ScriptExecutionConfig};
use crate::script_stage_materialization::StageOutputPolicy;

pub const SCRIPT_PIPELINE_SOURCE_ASSET_ID: &str = "script-pipeline-source";
pub const SCRIPT_PIPELINE_SOURCE_SCHEMA: &str = "script_pipeline_source.v1";
const MAX_EXECUTIONS: usize = 256;
const MAX_SOURCE_BYTES: usize = 16 * 1024 * 1024;

pub struct AcceptedScriptPipeline {
    pub study: StudyPlan,
    pub catalog: StudyProblemCatalog,
    pub source_bytes: Vec<u8>,
    pub source_reference: ImmutableAssetReference,
}

/// Bind the shared declared profile once, then use the sole existing sequential materializer.
pub fn compile_accepted_closed_loop_pipeline(
    mut config: ScriptExecutionConfig,
    study_id: String,
    revision: u64,
    profile: StudyExecutionProfileReference,
    layers: Vec<ExecutionRequestLayerIR>,
    source_capture: Value,
    lookup: impl FnMut(&str, &str) -> std::result::Result<ExecutionProfileIR, String>,
    output_policy: StageOutputPolicy,
) -> Result<AcceptedScriptPipeline> {
    validate_capture_shape(&source_capture)?;
    let inventory = config.antenna_inventory.clone();
    let captured = crate::materialize_captured_study_input("script-base", config.ir, &profile, layers, lookup).map_err(anyhow::Error::msg)?;
    config.ir = captured.problem;
    let compiled = crate::materialize_script_pipeline_with_output_policy_bounded(config, output_policy, MAX_EXECUTIONS)?;
    if compiled.executions.is_empty() { bail!("accepted script has no actual inspection execution"); }
    let mut steps = Vec::new();
    let mut entries = Vec::new();
    let mut bindings = Vec::new();
    let mut previous = None;
    for execution in &compiled.executions {
        let Some(ResolvedScriptStageAction::AntennaClosedLoopInspection { input, requested_execution, output_id }) = &execution.stage.action else {
            bail!("unsupported enabled accepted script execution `{}`; no partial Submit", execution.execution_id);
        };
        let source = execution.stage.provenance.as_ref().context("compiled execution has no authored identity")?;
        let references = capture_study_input_references(&execution.execution_id, &execution.stage.ir)?;
        let step = StudyStep {
            step_id: execution.execution_id.clone(), label: source.label.clone(), enabled: true, notes: source.notes.clone(), source: None,
            kind: StudyStepKind::ClosedLoopInspection { stage_id: input.stage.id.clone(), port_mode_id: input.port.id.clone(), output_id: output_id.clone() },
            model: references.model, solver_config: references.solver_config, discretization: references.discretization,
            execution_profile: profile.clone(), until_seconds: None, inputs: vec![], completion_dependencies: previous.into_iter().collect(),
            outputs: vec![StudyOutputPort { port_id: "inspection".into(), data_kind: StudyPortDataKind::Artifact }],
            acceptance: StudyAcceptancePolicy::Any, acquisition: StudyAcquisitionPolicy::Exclusive, legacy_payload: None,
        };
        let operation = fullmag_plan::validate_closed_loop_operation(&execution.stage.ir, &input.stage.id, &input.port.id, output_id)?;
        let fullmag_plan::AntennaFieldSolveExecutionPlan::ClosedLoopInspection { input: replanned, requested_execution: request, output_id: selected } = operation else { bail!("compiled action is not a closed-loop inspection"); };
        if replanned != *input || request != *requested_execution || selected != *output_id { bail!("compiled action differs from canonical operation planning"); }
        entries.push(StudyProblemCatalogEntry::from_captured_materialized_step(&step, execution.stage.ir.clone(), captured.execution.clone(), references.identity.clone()).with_context(||format!("unsupported execution-intent mutation in authored step `{}`; accepted v4 preserves sampling mutations but never rebinds the captured profile", source.authored_step_id))?);
        bindings.push(json!({"execution_id":execution.execution_id,"authored_step_id":source.authored_step_id,"expansion_index":source.expansion_index,"ancestor_group_ids":source.ancestor_group_ids,"label":source.label,"notes":source.notes,"source":source.source,"problem_sha256":references.identity.problem_sha256}));
        previous = Some(execution.execution_id.clone());
        steps.push(step);
    }
    let study = StudyPlan { schema_version: fullmag_authoring::STUDY_PLAN_SCHEMA_VERSION_V4.into(), study_id, revision, source_pipeline_version: Some(compiled.authored_pipeline.version.clone()), steps };
    study.validate_for_execution()?;
    let catalog = StudyProblemCatalog::from_entries(&study, entries)?;
    let nodes = compiled.nodes.iter().map(|node| json!({"authored_step_id":node.authored_step_id,"ancestor_group_ids":node.ancestor_group_ids,"kind":match node.kind { ScriptPipelineNodeKind::Primitive=>"primitive",ScriptPipelineNodeKind::Macro=>"macro",ScriptPipelineNodeKind::Group=>"group" },"effectively_enabled":node.effectively_enabled,"execution_ids":node.execution_ids})).collect::<Vec<_>>();
    let source = json!({"schema_version":SCRIPT_PIPELINE_SOURCE_SCHEMA,"authored_pipeline":compiled.authored_pipeline,"authored_pipeline_sha256":compiled.authored_pipeline_sha256,"antenna_inventory":inventory,"nodes":nodes,"executions":bindings,"capture":source_capture});
    let source_bytes = crate::run_spec::canonical_json_bytes(&source);
    if source_bytes.len()>MAX_SOURCE_BYTES { bail!("accepted pipeline source exceeds capture limit"); }
    let source_reference = ImmutableAssetReference { asset_id:SCRIPT_PIPELINE_SOURCE_ASSET_ID.into(),content_sha256:crate::study_artifact_content_sha256(&source_bytes) };
    validate_accepted_script_pipeline_source(&study,&catalog,&source_bytes)?;
    Ok(AcceptedScriptPipeline { study,catalog,source_bytes,source_reference })
}

fn strict_keys(value:&Value,expected:&[&str])->Result<()> {
    let object=value.as_object().context("source capture must be an object")?;
    if object.len()!=expected.len() || expected.iter().any(|key| !object.contains_key(*key)) { bail!("unknown or missing immutable source fields"); }
    Ok(())
}
fn safe_relative(value:&str)->bool {
    !value.is_empty() && value.len()<=1024 && value.is_ascii() && !value.contains('\\') && !value.contains(':') && value.split('/').all(|part| !part.is_empty() && part!="." && part!=".." && !part.chars().any(char::is_control))
}
fn digest(value:&str)->bool { value.len()==64 && value.bytes().all(|b| b.is_ascii_digit() || (b'a'..=b'f').contains(&b)) }
fn validate_capture_shape(capture:&Value)->Result<()> {
    strict_keys(capture,&["schema_version","entry_relative_path","runtime","records","observed_reads","inventory_sha256"])?;
    if capture["schema_version"]!="fullmag.script-source-capture.v1" { bail!("unsupported script capture schema"); }
    let entry=capture["entry_relative_path"].as_str().context("capture entry missing")?;
    let runtime=&capture["runtime"];
    strict_keys(runtime,&["python_version","implementation","executable_sha256","numpy_version","fullmag_source_tree_sha256","fullmag_version_binding","capture_policy","native_io_completeness","source_bytes","runtime_bytes"])?;
    if !safe_relative(entry) || runtime["implementation"]!="cpython" || runtime["fullmag_version_binding"]!="source_tree_only" || runtime["capture_policy"]!="trusted_readonly_dsl_observed_io.v1" || runtime["native_io_completeness"]!="NOT_VERIFIED" || runtime["python_version"].as_str().is_none() || !runtime["numpy_version"].is_null() && runtime["numpy_version"].as_str().is_none() { bail!("unsupported pinned capture runtime contract"); }
    for field in ["executable_sha256","fullmag_source_tree_sha256"] { if !runtime[field].as_str().is_some_and(digest) { bail!("capture runtime digest missing"); } }
    if !capture["inventory_sha256"].as_str().is_some_and(digest) { bail!("capture preflight digest missing"); }
    let files=capture["records"].as_array().context("capture files missing")?;
    if files.is_empty() || files.len()>8192 { bail!("capture file inventory bound"); }
    let mut paths=BTreeSet::new();let mut assets=BTreeSet::new();let mut source_total=0u64;let mut runtime_total=0u64;let mut found_entry=false;let mut interpreter=false;let mut fullmag=Vec::new();
    for file in files {
        strict_keys(file,&["relative_path","asset_id","sha256","byte_count","role"])?;
        let path=file["relative_path"].as_str().context("capture path missing")?;
        let id=file["asset_id"].as_str().context("capture asset ID missing")?;
        let sha=file["sha256"].as_str().context("capture digest missing")?;
        let expected_id=format!("script-file-{}",crate::study_artifact_content_sha256(path.as_bytes()));
        if !safe_relative(path) || !paths.insert(path.to_ascii_lowercase()) || id!=expected_id || !assets.insert(id) || !digest(sha) { bail!("unsafe/duplicate capture path or asset identity"); }
        let size=file["byte_count"].as_u64().context("capture size missing")?;
        if size>32*1024*1024 { bail!("capture individual file limit"); }
        match file["role"].as_str() {
            Some("source") if path.starts_with("source/") => { source_total=source_total.checked_add(size).context("source capture overflow")?; },
            Some("runtime") if ["fullmag/","stdlib/","numpy/","numpy-libs/","numpy-dist-info/","interpreter/"].iter().any(|prefix|path.starts_with(prefix)) => {
                runtime_total=runtime_total.checked_add(size).context("runtime capture overflow")?;
                interpreter|=path.starts_with("interpreter/") && file["sha256"]==runtime["executable_sha256"];
                if path.starts_with("fullmag/") { fullmag.push(json!({"relative_path":path,"sha256":sha,"byte_count":size})); }
            },
            _=>bail!("unsupported capture role or namespace"),
        }
        found_entry |= path==entry && file["role"]=="source";
    }
    fullmag.sort_by(|a,b|a["relative_path"].as_str().cmp(&b["relative_path"].as_str()));
    if !found_entry || !interpreter || fullmag.is_empty() || source_total>8*1024*1024 || runtime_total>128*1024*1024 || runtime["runtime_bytes"]!=runtime_total || runtime["source_bytes"].as_u64().is_none_or(|preflight|preflight<source_total || preflight>8*1024*1024) || fullmag_ir::canonical_ir_json_sha256(&json!(fullmag))?!=runtime["fullmag_source_tree_sha256"] { bail!("capture entry/runtime identity or aggregate budget"); }
    let reads=capture["observed_reads"].as_array().context("capture reads missing")?;
    if reads.iter().any(|path|!path.as_str().is_some_and(|path|paths.contains(&path.to_ascii_lowercase()))) { bail!("observed read missing from capture"); }
    Ok(())
}

/// Immutable source ties real compiled IDs to exact captured catalog bytes.
pub fn validate_accepted_script_pipeline_source(study:&StudyPlan,catalog:&StudyProblemCatalog,bytes:&[u8])->Result<Value> {
    if study.schema_version!=fullmag_authoring::STUDY_PLAN_SCHEMA_VERSION_V4 || bytes.len()>MAX_SOURCE_BYTES { bail!("source validation requires bounded v4 pipeline"); }
    catalog.validate_for(study)?;
    let source:Value=serde_json::from_slice(bytes)?;
    strict_keys(&source,&["schema_version","authored_pipeline","authored_pipeline_sha256","antenna_inventory","nodes","executions","capture"])?;
    if source["schema_version"]!=SCRIPT_PIPELINE_SOURCE_SCHEMA || source["authored_pipeline_sha256"]!=fullmag_ir::canonical_ir_json_sha256(&source["authored_pipeline"])? { bail!("authored pipeline digest mismatch"); }
    let inventory:crate::script_stage_contract::ScriptAntennaAuthoringInventory=serde_json::from_value(source["antenna_inventory"].clone())?;
    inventory.validate().map_err(anyhow::Error::msg)?;
    validate_capture_shape(&source["capture"])?;
    let authored:crate::script_stage_contract::StudyPipelineDocument=serde_json::from_value(source["authored_pipeline"].clone())?;
    if serde_json::to_value(&authored)?!=source["authored_pipeline"] { bail!("authored pipeline has unknown or noncanonical fields"); }
    let mut expected_nodes=Vec::new();
    crate::script_pipeline_compilation::collect_node_bindings(&authored.nodes,&[],true,&mut expected_nodes);
    let nodes=source["nodes"].as_array().context("source nodes missing")?;
    let executions=source["executions"].as_array().context("source executions missing")?;
    if executions.len()!=study.steps.len() || executions.len()>MAX_EXECUTIONS { bail!("source execution coverage mismatch"); }
    let mut node_ids=BTreeSet::new();
    for node in nodes { strict_keys(node,&["authored_step_id","ancestor_group_ids","kind","effectively_enabled","execution_ids"])?;let id=node["authored_step_id"].as_str().context("authored ID missing")?;if id.trim().is_empty() || !node_ids.insert(id) { bail!("duplicate authored ID including disabled"); } }
    if nodes.len()!=expected_nodes.len() { bail!("authored inventory coverage differs from tree"); }
    let mut all_execution_ids=Vec::new();
    for (node,expected) in nodes.iter().zip(&expected_nodes) {
        let kind=match expected.kind { ScriptPipelineNodeKind::Primitive=>"primitive", ScriptPipelineNodeKind::Macro=>"macro", ScriptPipelineNodeKind::Group=>"group" };
        let ids=node["execution_ids"].as_array().context("node execution IDs missing")?;
        if node["authored_step_id"]!=expected.authored_step_id || node["ancestor_group_ids"]!=json!(expected.ancestor_group_ids) || node["kind"]!=kind || node["effectively_enabled"]!=expected.effectively_enabled || (!expected.effectively_enabled || kind=="group") && !ids.is_empty() || kind=="primitive" && ids.len()>1 { bail!("authored activation, ancestry or node kind differs from captured tree"); }
        all_execution_ids.extend(ids.iter().cloned());
    }
    if all_execution_ids!=executions.iter().map(|execution|execution["execution_id"].clone()).collect::<Vec<_>>() { bail!("execution inventory is not a total ordered bijection"); }
    fn authored_metadata<'a>(nodes:&'a [crate::script_stage_contract::StudyPipelineNode], id:&str)->Option<(&'a String,&'a Option<String>,&'a Option<String>)> {
        use crate::script_stage_contract::StudyPipelineNode;
        for node in nodes {
            let (node_id,label,notes,source)=match node {
                StudyPipelineNode::Primitive{id,label,notes,source,..}|StudyPipelineNode::Macro{id,label,notes,source,..}|StudyPipelineNode::Group{id,label,notes,source,..}=>(id,label,notes,source),
            };
            if node_id==id { return Some((label,notes,source)); }
            if let StudyPipelineNode::Group{children,..}=node { if let Some(found)=authored_metadata(children,id) { return Some(found); } }
        }
        None
    }
    let mut previous:Option<String>=None;
    for (step,execution) in study.steps.iter().zip(executions) {
        strict_keys(execution,&["execution_id","authored_step_id","expansion_index","ancestor_group_ids","label","notes","source","problem_sha256"])?;
        let node=nodes.iter().find(|n| n["authored_step_id"]==execution["authored_step_id"]).context("source execution owner missing")?;
        let index=execution["expansion_index"].as_u64().context("source macro index missing")?;
        let expected=fullmag_ir::canonical_ir_json_sha256(&json!({"schema":"fullmag.script-execution-identity.v1","authored_step_id":execution["authored_step_id"],"expansion_index":index}))?;
        if execution["execution_id"]!=step.step_id || step.step_id!=format!("script-execution-{expected}") || node["effectively_enabled"]!=true || node["kind"]=="group" || node["ancestor_group_ids"]!=execution["ancestor_group_ids"] || node["execution_ids"].as_array().and_then(|ids| usize::try_from(index).ok().and_then(|index|ids.get(index)))!=Some(&execution["execution_id"]) || step.completion_dependencies!=previous.clone().into_iter().collect::<Vec<_>>() { bail!("source execution identity, activation, macro ownership or completion sequence mismatch"); }
        let entry=catalog.entries().iter().find(|entry| entry.step_id()==step.step_id).context("source catalog entry missing")?;
        let identity=entry.captured_input_identity().context("source catalog input not captured")?;
        if execution["problem_sha256"]!=identity.problem_sha256 || identity.source_id!=step.step_id || !matches!(step.kind,StudyStepKind::ClosedLoopInspection{..}) { bail!("source captures another input or operation"); }
        let (label,notes,authored_source)=authored_metadata(&authored.nodes,execution["authored_step_id"].as_str().context("source authored ID missing")?).context("source authored metadata missing")?;
        if execution["label"]!=json!(label) || execution["notes"]!=json!(notes) || execution["source"]!=json!(authored_source) || step.label!=*label || step.notes!=*notes || step.source.is_some() { bail!("source authored metadata differs from accepted execution"); }
        if let StudyStepKind::ClosedLoopInspection{stage_id,port_mode_id,output_id}=&step.kind { fullmag_plan::validate_closed_loop_operation(entry.problem(),stage_id,port_mode_id,output_id)?; }
        previous=Some(step.step_id.clone());
    }
    Ok(source)
}

pub fn validate_script_source_assets(specification:&RunSpecification,source:&Value,mut read:impl FnMut(&str,u64)->Result<Vec<u8>>)->Result<()> {
    validate_capture_shape(&source["capture"])?;
    for file in source["capture"]["records"].as_array().context("capture files missing")? {
        let id=file["asset_id"].as_str().context("asset ID missing")?;let sha=file["sha256"].as_str().context("asset digest missing")?;
        let reference=specification.immutable_assets.iter().find(|asset| asset.asset_id==id).context("capture file missing from immutable RunSpec assets")?;
        if reference.content_sha256!=sha { bail!("source asset digest differs from RunSpec"); }
        let bytes=read(sha,file["byte_count"].as_u64().context("capture byte count missing")?.max(1))?;
        if bytes.len() as u64!=file["byte_count"].as_u64().context("capture byte count missing")? || crate::study_artifact_content_sha256(&bytes)!=sha { bail!("captured asset bytes changed or missing"); }
    }
    Ok(())
}

#[cfg(test)]
mod tests {
    use super::*;
    fn capture() -> Value {
        let records=[("source/main.py","source",b"pass".as_slice()),("fullmag/__init__.py","runtime",b"fullmag".as_slice()),("interpreter/python","runtime",b"python".as_slice())].map(|(path,role,bytes)|json!({"relative_path":path,"asset_id":format!("script-file-{}",crate::study_artifact_content_sha256(path.as_bytes())),"sha256":crate::study_artifact_content_sha256(bytes),"byte_count":bytes.len(),"role":role}));
        let fullmag=json!([{"relative_path":"fullmag/__init__.py","sha256":crate::study_artifact_content_sha256(b"fullmag"),"byte_count":7}]);
        json!({"schema_version":"fullmag.script-source-capture.v1","entry_relative_path":"source/main.py","records":records,"runtime":{"python_version":"3.10.12","implementation":"cpython","numpy_version":null,"executable_sha256":crate::study_artifact_content_sha256(b"python"),"fullmag_source_tree_sha256":fullmag_ir::canonical_ir_json_sha256(&fullmag).unwrap(),"fullmag_version_binding":"source_tree_only","capture_policy":"trusted_readonly_dsl_observed_io.v1","native_io_completeness":"NOT_VERIFIED","source_bytes":4,"runtime_bytes":13},"observed_reads":["source/main.py"],"inventory_sha256":"a".repeat(64)})
    }
    #[test]
    fn capture_identity_refuses_tampered_runtime_and_false_native_io_proof() {
        let valid=capture();validate_capture_shape(&valid).unwrap();
        for field in ["executable_sha256","fullmag_source_tree_sha256"] { let mut invalid=valid.clone();invalid["runtime"][field]=json!("b".repeat(64));assert!(validate_capture_shape(&invalid).is_err()); }
        let mut invalid=valid;invalid["runtime"]["native_io_completeness"]=json!("PASS");assert!(validate_capture_shape(&invalid).is_err());
    }
    #[test]
    fn capture_refuses_path_aliases_missing_read_and_asset_rebinding() {
        let valid=capture();
        let mut invalid=valid.clone();invalid["records"][0]["relative_path"]=json!("source/../main.py");assert!(validate_capture_shape(&invalid).is_err());
        let mut invalid=valid.clone();invalid["records"][0]["asset_id"]=json!("other");assert!(validate_capture_shape(&invalid).is_err());
        let mut invalid=valid.clone();invalid["observed_reads"]=json!(["source/not-retained.py"]);assert!(validate_capture_shape(&invalid).is_err());
        let mut invalid=valid;let alias=invalid["records"][0].clone();invalid["records"].as_array_mut().unwrap().push(alias);assert!(validate_capture_shape(&invalid).is_err());
    }
    #[test]
    fn capture_refuses_oversized_payload_and_unknown_contract_fields() {
        let mut invalid=capture();invalid["records"][0]["byte_count"]=json!(8*1024*1024+1);assert!(validate_capture_shape(&invalid).is_err());
        let mut invalid=capture();invalid["unrecognized"]=json!(true);assert!(validate_capture_shape(&invalid).is_err());
    }
}
