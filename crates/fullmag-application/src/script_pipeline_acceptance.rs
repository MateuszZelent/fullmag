//! Compile actual executions into accepted tasks; never reinterpret authored groups as work.
use anyhow::{bail, Context, Result};
use fullmag_authoring::{StudyAcceptancePolicy, StudyAcquisitionPolicy, StudyExecutionProfileReference, StudyInitialStateOverlay, StudyInputPort, StudyInputSource, StudyOutputPort, StudyPlan, StudyPortDataKind, StudyStep, StudyStepKind};
use fullmag_ir::{ExecutionProfileIR, ExecutionRequestLayerIR};
use fullmag_plan::{capture_study_input_references, StudyProblemCatalog, StudyProblemCatalogEntry};
use serde_json::{json, Value};
use std::collections::{BTreeMap, BTreeSet};
use crate::{ImmutableAssetReference, RunSpecification, ScriptPipelineNodeKind};
use crate::script_stage_contract::{ResolvedScriptStageAction, ScriptExecutionConfig, ScriptMagnetizationAssignment};
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
    let captured = crate::materialize_captured_study_input("script-base", config.ir, &profile, layers.clone(), lookup).map_err(anyhow::Error::msg)?;
    let mut snapshot_execution=BTreeMap::new();
    let explicit=!config.stages.is_empty();
    if explicit {
        let pinned=captured.execution.profile.clone().context("captured execution profile is missing")?;
        let pinned_layers=captured.execution.layers.clone();
        for stage in &mut config.stages {
            let id=stage.ir.problem_meta.runtime_metadata.get("active_stage_id").and_then(Value::as_str)
                .context("explicit snapshot has no authored stage identity")?.to_owned();
            if snapshot_execution.contains_key(&id) {bail!("duplicate explicit authored stage identity");}
            let bound=crate::materialize_captured_study_input("script-snapshot",stage.ir.clone(),&profile,pinned_layers.clone(),|id,version| {
                if id==pinned.profile_id && version==pinned.version {Ok(pinned.clone())} else {Err("pinned accepted profile reference changed".into())}
            }).map_err(anyhow::Error::msg)?;
            stage.ir=bound.problem;
            snapshot_execution.insert(id,bound.execution);
        }
    }
    config.ir = captured.problem;
    let compiled = crate::materialize_script_pipeline_with_output_policy_bounded(config, output_policy, MAX_EXECUTIONS)?;
    let mut steps = Vec::new();
    let mut entries = Vec::new();
    let mut bindings = Vec::new();
    let mut previous = None;
    let mut previous_state:Option<String> = None;
    let mut folded_inputs = BTreeSet::new();
    for execution in &compiled.executions {
        let source = execution.stage.provenance.as_ref().context("compiled execution has no authored identity")?;
        let node = crate::script_pipeline_compilation::authored_node(
            &compiled.authored_pipeline.nodes, &source.authored_step_id,
        ).context("compiled execution has no authored node")?;
        if crate::script_pipeline_compilation::is_input_configuration_node(node) {
            // The sequential producer already applied these declarations to
            // the physical snapshots. They have no worker task or state port.
            folded_inputs.insert(execution.execution_id.as_str());
            continue;
        }
        let (kind,until_seconds,mut inputs,initial_state_overlay,outputs)=match &execution.stage.action {
            Some(ResolvedScriptStageAction::AntennaClosedLoopInspection{input,requested_execution,output_id})=>{
                let operation=fullmag_plan::validate_closed_loop_operation(&execution.stage.ir,&input.stage.id,&input.port.id,output_id)?;
                let fullmag_plan::AntennaFieldSolveExecutionPlan::ClosedLoopInspection{input:replanned,requested_execution:request,output_id:selected}=operation else {bail!("compiled action is not a closed-loop inspection");};
                if replanned!=*input || request!=*requested_execution || selected!=*output_id {bail!("compiled action differs from canonical operation planning");}
                (StudyStepKind::ClosedLoopInspection{stage_id:input.stage.id.clone(),port_mode_id:input.port.id.clone(),output_id:output_id.clone()},None,vec![],None,vec![StudyOutputPort{port_id:"inspection".into(),data_kind:StudyPortDataKind::Artifact}])
            },
            None=>physical_step_contract(node,&execution.stage.ir,execution.stage.until_seconds,previous_state.as_deref(),
                compiled.magnetization_assignments.get(&source.authored_step_id).map(|batch| batch.ordered.as_slice()).unwrap_or_default())?,
            _=>bail!("unsupported enabled accepted script execution `{}`; no partial Submit",execution.execution_id),
        };
        if compiled.authored_pipeline.version == "study_pipeline.v2"
            && matches!(&kind, StudyStepKind::Primitive { .. })
            && inputs.is_empty()
        {
            inputs.push(authored_initial_state_port(&execution.execution_id, &execution.stage.ir)?);
        }
        let references = capture_study_input_references(&execution.execution_id, &execution.stage.ir)?;
        let step = StudyStep {
            step_id: execution.execution_id.clone(), label: source.label.clone(), enabled: true, notes: source.notes.clone(), source: None,
            kind,
            model: references.model, solver_config: references.solver_config, discretization: references.discretization,
            execution_profile: profile.clone(), until_seconds, inputs, initial_state_overlay, completion_dependencies: previous.into_iter().collect(),
            outputs,
            acceptance: StudyAcceptancePolicy::Any, acquisition: StudyAcquisitionPolicy::Exclusive, legacy_payload: None,
        };
        let execution_binding=if explicit {snapshot_execution.get(&source.authored_step_id).context("physical snapshot lost its pinned execution profile")?} else {&captured.execution};
        entries.push(StudyProblemCatalogEntry::from_captured_materialized_step(&step, execution.stage.ir.clone(), execution_binding.clone(), references.identity.clone()).with_context(||format!("unsupported execution-intent mutation in authored step `{}`; accepted v4 never rebinds the captured profile", source.authored_step_id))?);
        bindings.push(json!({"execution_id":execution.execution_id,"authored_step_id":source.authored_step_id,"expansion_index":source.expansion_index,"ancestor_group_ids":source.ancestor_group_ids,"label":source.label,"notes":source.notes,"source":source.source,"problem_sha256":references.identity.problem_sha256}));
        if matches!(&step.kind,StudyStepKind::Primitive{..}) {previous_state=Some(execution.execution_id.clone());}
        previous = Some(execution.execution_id.clone());
        steps.push(step);
    }
    if steps.is_empty() { bail!("accepted script has no actual execution"); }
    let study = StudyPlan { schema_version: fullmag_authoring::STUDY_PLAN_SCHEMA_VERSION_V4.into(), study_id, revision, source_pipeline_version: Some(compiled.authored_pipeline.version.clone()), steps };
    study.validate_for_execution()?;
    let catalog = StudyProblemCatalog::from_entries(&study, entries)?;
    let nodes: Vec<_> = compiled.nodes.iter().map(|node| {
        let kind = match node.kind {
            ScriptPipelineNodeKind::Primitive => "primitive",
            ScriptPipelineNodeKind::Macro => "macro",
            ScriptPipelineNodeKind::Group => "group",
        };
        let execution_ids: Vec<_> = node.execution_ids.iter()
            .filter(|id| !folded_inputs.contains(id.as_str()))
            .collect();
        json!({
            "authored_step_id": node.authored_step_id,
            "ancestor_group_ids": node.ancestor_group_ids,
            "kind": kind,
            "effectively_enabled": node.effectively_enabled,
            "execution_ids": execution_ids,
        })
    }).collect();
    let source = json!({"schema_version":SCRIPT_PIPELINE_SOURCE_SCHEMA,"authored_pipeline":compiled.authored_pipeline,"authored_pipeline_sha256":compiled.authored_pipeline_sha256,"antenna_inventory":inventory,"nodes":nodes,"executions":bindings,"capture":source_capture});
    let source_bytes = crate::run_spec::canonical_json_bytes(&source);
    if source_bytes.len()>MAX_SOURCE_BYTES { bail!("accepted pipeline source exceeds capture limit"); }
    let source_reference = ImmutableAssetReference { asset_id:SCRIPT_PIPELINE_SOURCE_ASSET_ID.into(),content_sha256:crate::study_artifact_content_sha256(&source_bytes) };
    validate_accepted_script_pipeline_source(&study,&catalog,&source_bytes)?;
    Ok(AcceptedScriptPipeline { study,catalog,source_bytes,source_reference })
}

/// Bind the state and completion edges of an ordinary sequential physical
/// Study after each authored ProblemIR has been materialized.
pub fn bind_scene_study_physical_state_flow(
    study: &mut StudyPlan,
    pipeline: Option<&fullmag_authoring::StudyPipelineDocument>,
    inputs: &[crate::StudyStepExecutionInput],
) -> Result<()> {
    use crate::script_stage_contract::{
        parse_magnetization_assignment_batch, StageMagnetizationAssignments,
        MAGNETIZATION_ASSIGNMENTS_KEY, STAGE_MAGNETIZATION_ASSIGNMENTS_KEY,
    };
    use fullmag_authoring::StudyPrimitiveStageKind;
    let is_physical = |step: &StudyStep| matches!(
        &step.kind,
        StudyStepKind::Primitive {
            stage_kind: StudyPrimitiveStageKind::Run | StudyPrimitiveStageKind::Relax
        }
    );
    let assignments = if let Some(pipeline) = pipeline {
        let document: crate::script_stage_contract::StudyPipelineDocument =
            serde_json::from_value(serde_json::to_value(pipeline)?)?;
        document.magnetization_assignments_by_stage()?
    } else {
        let mut assignments = BTreeMap::new();
        let mut pending = Vec::new();
        let mut count = 0;
        for step in &study.steps {
            let independent = step.legacy_payload.as_ref()
                .and_then(|payload| payload.get(MAGNETIZATION_ASSIGNMENTS_KEY));
            let local = step.legacy_payload.as_ref()
                .and_then(|payload| payload.get(STAGE_MAGNETIZATION_ASSIGNMENTS_KEY));
            if !is_physical(step) {
                if independent.is_some() || local.is_some() {
                    bail!("magnetization assignments require a Run or Relax stage");
                }
                continue;
            }
            if let Some(batch) = independent {
                pending.extend(parse_magnetization_assignment_batch(batch, &mut count)?);
            }
            let local = local.map(|batch| parse_magnetization_assignment_batch(batch, &mut count))
                .transpose()?.unwrap_or_default();
            if step.enabled && (!pending.is_empty() || !local.is_empty()) {
                assignments.insert(step.step_id.clone(), StageMagnetizationAssignments::new(
                    std::mem::take(&mut pending), local,
                ));
            }
        }
        assignments
    };
    if !study.steps.iter().filter(|step| step.enabled).all(|step| {
        is_physical(step) || matches!(&step.kind, StudyStepKind::Group { .. })
    }) {
        if !assignments.is_empty() {
            bail!("magnetization assignments require an ordered physical Study");
        }
        return Ok(());
    }
    if study.steps.iter().filter(|step| step.enabled && is_physical(step)).count() < 2
        && assignments.is_empty()
    {
        return Ok(());
    }
    let inputs_by_id: BTreeMap<_, _> =
        inputs.iter().map(|input| (input.step_id.as_str(), &input.problem)).collect();
    if inputs_by_id.len() != inputs.len() {
        bail!("duplicate materialized input for physical Study");
    }
    let mut previous: Option<String> = None;
    for step in study.steps.iter_mut().filter(|step| step.enabled && is_physical(step)) {
        if !step.inputs.is_empty() || !step.completion_dependencies.is_empty() {
            bail!("physical Study graph already has authored state or ordering edges");
        }
        let problem = inputs_by_id.get(step.step_id.as_str())
            .with_context(|| format!("physical stage '{}' has no materialized input", step.step_id))?;
        let resets = assignments.get(&step.step_id).map(|batch| batch.ordered.as_slice()).unwrap_or_default();
        (step.inputs, step.initial_state_overlay) =
            physical_state_input(problem, previous.as_deref(), resets)?;
        step.completion_dependencies = previous.iter().cloned().collect();
        if !step.outputs.iter().any(|port| port.port_id == "final_state") {
            step.outputs.push(StudyOutputPort {
                port_id: "final_state".into(),
                data_kind: StudyPortDataKind::State,
            });
        }
        previous = Some(step.step_id.clone());
    }
    study.schema_version = fullmag_authoring::STUDY_PLAN_SCHEMA_VERSION.into();
    study.validate()?;
    Ok(())
}

/// Attach authored-state references after binding the immutable ProblemIR.
pub fn bind_scene_study_authored_initial_states(
    study: &mut StudyPlan,
    catalog: StudyProblemCatalog,
) -> Result<StudyProblemCatalog> {
    if study.source_pipeline_version.as_deref() != Some("study_pipeline.v2") {
        return Ok(catalog);
    }
    let mut changed = false;
    for step in study.steps.iter_mut().filter(|step| step.enabled && step.inputs.is_empty()) {
        if !matches!(&step.kind, StudyStepKind::Primitive {
            stage_kind: fullmag_authoring::StudyPrimitiveStageKind::Run
                | fullmag_authoring::StudyPrimitiveStageKind::Relax,
        }) {
            continue;
        }
        let problem = catalog.entries().iter().find(|entry| entry.step_id() == step.step_id)
            .with_context(|| format!("authored stage '{}' has no bound ProblemIR", step.step_id))?
            .problem();
        step.inputs.push(authored_initial_state_port(&step.step_id, problem)?);
        changed = true;
    }
    if changed {
        Ok(StudyProblemCatalog::from_entries(study, catalog.into_entries())?)
    } else {
        Ok(catalog)
    }
}

fn authored_initial_state_port(step_id: &str, problem: &fullmag_ir::ProblemIR) -> Result<StudyInputPort> {
    Ok(StudyInputPort {
        port_id: "initial_state".into(),
        data_kind: StudyPortDataKind::State,
        required: true,
        source: StudyInputSource::AuthoredInitialState {
            reference: fullmag_plan::authored_initial_state_reference(step_id, problem)?,
        },
    })
}

fn physical_state_input(
    problem: &fullmag_ir::ProblemIR,
    previous_state: Option<&str>,
    assignments: &[ScriptMagnetizationAssignment],
) -> Result<(Vec<StudyInputPort>, Option<StudyInitialStateOverlay>)> {
    let full_reset = ScriptMagnetizationAssignment::captures_full_reset(assignments, problem)?;
    let Some(step_id) = previous_state.filter(|_| !full_reset) else {
        return Ok((Vec::new(), None));
    };
    let overlay = if assignments.is_empty() {
        None
    } else {
        let scopes = assignments.iter()
            .map(|assignment| (&assignment.object_id, &assignment.region_id))
            .collect::<BTreeSet<_>>()
            .into_iter()
            .map(|(object_id, region_id)| fullmag_ir::RegionRefIR {
                object_id: object_id.clone(),
                region_id: region_id.clone(),
            })
            .collect();
        Some(StudyInitialStateOverlay::Scoped { scopes })
    };
    let input = StudyInputPort {
        port_id: "initial_state".into(),
        data_kind: StudyPortDataKind::State,
        required: true,
        source: StudyInputSource::StepOutput {
            step_id: step_id.into(),
            port: "final_state".into(),
            case_id: "default".into(),
        },
    };
    Ok((vec![input], overlay))
}

/// Physical ports reuse the existing State payload; the input name is not its data kind.
fn physical_step_contract(node:&crate::script_stage_contract::StudyPipelineNode,problem:&fullmag_ir::ProblemIR,until:f64,previous_state:Option<&str>,
    assignments:&[ScriptMagnetizationAssignment])
    ->Result<(StudyStepKind,Option<f64>,Vec<StudyInputPort>,Option<StudyInitialStateOverlay>,Vec<StudyOutputPort>)> {
    use crate::script_stage_contract::StudyPipelineNode;
    use fullmag_authoring::StudyPrimitiveStageKind;
    let StudyPipelineNode::Primitive{id,stage_kind,payload,..}=node else {bail!("accepted physical execution requires an authored primitive");};
    if problem.problem_meta.runtime_metadata.get("active_stage_id").and_then(Value::as_str)!=Some(id.as_str()) {
        bail!("physical execution activation ID differs from its authored node");
    }
    let (stage_kind,horizon)=match (stage_kind.as_str(),&problem.study) {
        ("relax",fullmag_ir::StudyIR::Relaxation{..})=>(StudyPrimitiveStageKind::Relax,None),
        ("run",fullmag_ir::StudyIR::TimeEvolution{..})=>{
            let authored=match payload.get("until_seconds") {
                Some(Value::Number(value))=>value.as_f64(),
                Some(Value::String(value))=>value.trim().parse::<f64>().ok(),
                _=>None,
            }.context("accepted Run requires an explicit authored duration")?;
            if !authored.is_finite() || authored<=0.0 || authored!=until {bail!("accepted Run duration differs from its actual authored execution");}
            (StudyPrimitiveStageKind::Run,Some(until))
        },
        _=>bail!("accepted physical execution kind differs from its captured Relax/Run IR"),
    };
    let (inputs, overlay) = physical_state_input(problem, previous_state, assignments)?;
    Ok((StudyStepKind::Primitive{stage_kind},horizon,inputs,overlay,vec![StudyOutputPort{port_id:"final_state".into(),data_kind:StudyPortDataKind::State}]))
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
    if !safe_relative(entry) || runtime["implementation"]!="cpython" || runtime["fullmag_version_binding"]!="source_tree_only" || !matches!(runtime["capture_policy"].as_str(),Some("trusted_readonly_dsl_observed_io.v1"|"trusted_readonly_dsl_observed_io.v2")) || runtime["native_io_completeness"]!="NOT_VERIFIED" || runtime["python_version"].as_str().is_none() || !runtime["numpy_version"].is_null() && runtime["numpy_version"].as_str().is_none() { bail!("unsupported pinned capture runtime contract"); }
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
    let magnetization_assignments = authored.magnetization_assignments_by_stage()?;
    if study.source_pipeline_version.as_deref()!=Some(authored.version.as_str()) {
        bail!("accepted source pipeline version differs from its supported captured StudyPlan");
    }
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
        if expected.effectively_enabled && matches!(crate::script_pipeline_compilation::authored_node(&authored.nodes,&expected.authored_step_id),
            Some(crate::script_stage_contract::StudyPipelineNode::Primitive{stage_kind,..}) if matches!(stage_kind.as_str(),"relax"|"run")) && ids.len()!=1 {
            bail!("enabled physical primitive must own exactly one captured execution");
        }
        if crate::script_pipeline_compilation::authored_node(&authored.nodes, &expected.authored_step_id)
            .is_some_and(crate::script_pipeline_compilation::is_input_configuration_node)
            && !ids.is_empty()
        {
            bail!("pipeline input configuration cannot own an accepted worker task");
        }
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
    let mut previous_state:Option<String>=None;
    for (step,execution) in study.steps.iter().zip(executions) {
        strict_keys(execution,&["execution_id","authored_step_id","expansion_index","ancestor_group_ids","label","notes","source","problem_sha256"])?;
        let node=nodes.iter().find(|n| n["authored_step_id"]==execution["authored_step_id"]).context("source execution owner missing")?;
        let index=execution["expansion_index"].as_u64().context("source macro index missing")?;
        let authored_id = execution["authored_step_id"].as_str().context("source authored ID missing")?;
        let expected = crate::script_pipeline_compilation::script_execution_id(authored_id, index)?;
        if execution["execution_id"]!=step.step_id || step.step_id!=expected || node["effectively_enabled"]!=true || node["kind"]=="group" || node["ancestor_group_ids"]!=execution["ancestor_group_ids"] || node["execution_ids"].as_array().and_then(|ids| usize::try_from(index).ok().and_then(|index|ids.get(index)))!=Some(&execution["execution_id"]) || step.completion_dependencies!=previous.clone().into_iter().collect::<Vec<_>>() { bail!("source execution identity, activation, macro ownership or completion sequence mismatch"); }
        let entry=catalog.entries().iter().find(|entry| entry.step_id()==step.step_id).context("source catalog entry missing")?;
        let identity=entry.captured_input_identity().context("source catalog input not captured")?;
        if execution["problem_sha256"]!=identity.problem_sha256 || identity.source_id!=step.step_id { bail!("source captures another input or operation"); }
        let (label,notes,authored_source)=authored_metadata(&authored.nodes,execution["authored_step_id"].as_str().context("source authored ID missing")?).context("source authored metadata missing")?;
        if execution["label"]!=json!(label) || execution["notes"]!=json!(notes) || execution["source"]!=json!(authored_source) || step.label!=*label || step.notes!=*notes || step.source.is_some() { bail!("source authored metadata differs from accepted execution"); }
        let authored_physical=matches!(crate::script_pipeline_compilation::authored_node(&authored.nodes,execution["authored_step_id"].as_str().context("source authored ID missing")?),
            Some(crate::script_stage_contract::StudyPipelineNode::Primitive{stage_kind,..}) if matches!(stage_kind.as_str(),"relax"|"run"));
        if authored_physical && !matches!(&step.kind,StudyStepKind::Primitive{..}) {bail!("authored physical node cannot become a closed-loop or other operation");}
        match &step.kind {
            StudyStepKind::ClosedLoopInspection{stage_id,port_mode_id,output_id}=>{
                if step.until_seconds.is_some() || !step.inputs.is_empty() || step.outputs!=vec![StudyOutputPort{port_id:"inspection".into(),data_kind:StudyPortDataKind::Artifact}] {bail!("closed-loop source cannot carry physical state ports or a horizon");}
                fullmag_plan::validate_closed_loop_operation(entry.problem(),stage_id,port_mode_id,output_id)?;
            },
            StudyStepKind::Primitive{..}=>{
                let authored_id = execution["authored_step_id"].as_str().context("physical source ID missing")?;
                let node=crate::script_pipeline_compilation::authored_node(&authored.nodes,authored_id).context("physical source node missing")?;
                let (kind,horizon,mut inputs,overlay,outputs)=physical_step_contract(node,entry.problem(),step.until_seconds.unwrap_or(0.0),previous_state.as_deref(),
                    magnetization_assignments.get(authored_id).map(|batch| batch.ordered.as_slice()).unwrap_or_default())?;
                if authored.version == "study_pipeline.v2" && inputs.is_empty() {
                    inputs.push(authored_initial_state_port(&step.step_id, entry.problem())?);
                }
                if step.kind!=kind || step.until_seconds!=horizon || step.inputs!=inputs || step.initial_state_overlay!=overlay || step.outputs!=outputs
                    || !step.enabled || step.acceptance!=StudyAcceptancePolicy::Any || step.acquisition!=StudyAcquisitionPolicy::Exclusive || step.legacy_payload.is_some() {
                    bail!("physical source operation, horizon or exact predecessor state chain differs");
                }
                previous_state=Some(step.step_id.clone());
            },
            _=>bail!("unsupported accepted source operation"),
        }
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
    fn physical_config() -> ScriptExecutionConfig {
        let mut first=fullmag_ir::ProblemIR::bootstrap_example();
        first.current_density=Some([1.0,0.0,0.0]);
        first.problem_meta.runtime_metadata.insert("active_stage_id".into(),json!("first"));
        let mut second=first.clone();second.current_density=Some([2.0,0.0,0.0]);
        second.problem_meta.runtime_metadata.insert("active_stage_id".into(),json!("second"));
        ScriptExecutionConfig {ir:second.clone(),antenna_inventory:Default::default(),shared_geometry_assets:None,default_until_seconds:Some(1e-12),
            study_pipeline:Some(serde_json::from_value(json!({"version":"study_pipeline.v1","nodes":[
                {"node_kind":"primitive","id":"first","label":"First","stage_kind":"run","payload":{"until_seconds":1e-12}},
                {"node_kind":"primitive","id":"second","label":"Second","stage_kind":"run","payload":{"until_seconds":1e-12}}
            ]})).unwrap()),stages:vec![
                crate::script_stage_contract::ScriptExecutionStage {ir:first,default_until_seconds:Some(1e-12),entrypoint_kind:"flat_run".into(),action:None},
                crate::script_stage_contract::ScriptExecutionStage {ir:second,default_until_seconds:Some(1e-12),entrypoint_kind:"flat_run".into(),action:None},
            ]}
    }
    fn physical_profile()->ExecutionProfileIR {
        ExecutionProfileIR {profile_id:"physical".into(),version:"v1".into(),defaults:fullmag_ir::ExecutionRequestPatchIR {
            backend:fullmag_ir::FieldPatch::Value(fullmag_ir::BackendTarget::Fdm),device:fullmag_ir::FieldPatch::Value(fullmag_ir::ExecutionDevice::Cpu),
            precision:fullmag_ir::FieldPatch::Value(fullmag_ir::ExecutionPrecision::Double),mode:fullmag_ir::FieldPatch::Value(fullmag_ir::ExecutionMode::Strict),
            ..Default::default()},..Default::default()}
    }
    fn compile_physical(config:ScriptExecutionConfig)->Result<AcceptedScriptPipeline> {
        let profile=physical_profile();
        compile_accepted_closed_loop_pipeline(config,"physical-study".into(),0,
            StudyExecutionProfileReference {profile_id:profile.profile_id.clone(),version:profile.version.clone()},vec![],capture(),
            |_,_|Ok(profile.clone()),fullmag_ir::configure_project_autosave_policy)
    }
    #[test]
    fn physical_snapshots_bind_once_pinned_profile_and_exact_state_chain() {
        let profile=physical_profile();let calls=std::cell::Cell::new(0);
        let compiled=compile_accepted_closed_loop_pipeline(physical_config(),"physical-study".into(),0,
            StudyExecutionProfileReference {profile_id:profile.profile_id.clone(),version:profile.version.clone()},vec![],capture(),
            |_,_| {calls.set(calls.get()+1);Ok(profile.clone())},fullmag_ir::configure_project_autosave_policy).unwrap();
        assert_eq!(calls.get(),1);
        assert_eq!(compiled.catalog.entries()[0].problem().current_density,Some([1.0,0.0,0.0]));
        assert_eq!(compiled.catalog.entries()[1].problem().current_density,Some([2.0,0.0,0.0]));
        assert!(compiled.study.steps[0].inputs.is_empty());
        assert_eq!(compiled.study.steps[1].inputs[0],StudyInputPort {port_id:"initial_state".into(),data_kind:StudyPortDataKind::State,required:true,
            source:StudyInputSource::StepOutput {step_id:compiled.study.steps[0].step_id.clone(),port:"final_state".into(),case_id:"default".into()}});
        assert_eq!(compiled.study.steps[1].completion_dependencies,vec![compiled.study.steps[0].step_id.clone()]);
        for step in &compiled.study.steps {assert_eq!(step.outputs,vec![StudyOutputPort{port_id:"final_state".into(),data_kind:StudyPortDataKind::State}]);}
        validate_accepted_script_pipeline_source(&compiled.study,&compiled.catalog,&compiled.source_bytes).unwrap();
    }
    #[test]
    fn repeated_authored_texture_breaks_only_the_immediate_state_dependency() {
        use crate::script_stage_contract::StudyPipelineNode;

        let mut config = physical_config();
        let initializer = fullmag_ir::InitialMagnetizationIR::Uniform {
            value: [1.0, 0.0, 0.0],
        };
        for stage in &mut config.stages {
            stage.ir.magnets[0].initial_magnetization = Some(initializer.clone());
        }
        let magnet = &config.stages[1].ir.magnets[0];
        let object_id = magnet.object_id.as_deref().unwrap_or(&magnet.name).to_owned();
        let mut third = config.stages[1].clone();
        third.ir.problem_meta.runtime_metadata.insert("active_stage_id".into(), json!("third"));
        config.stages.push(third);

        let pipeline = config.study_pipeline.as_mut().unwrap();
        pipeline.version = "study_pipeline.v2".into();
        let mut third_node = pipeline.nodes[1].clone();
        let StudyPipelineNode::Primitive { id, label, .. } = &mut third_node else {
            panic!("expected physical primitive");
        };
        *id = "third".into();
        *label = "Third".into();
        pipeline.nodes.push(third_node);
        let StudyPipelineNode::Primitive { payload, .. } = &mut pipeline.nodes[1] else {
            panic!("expected physical primitive");
        };
        payload.insert(
            "magnetization_assignments".into(),
            json!({
                "schema_version": "fullmag.magnetization-assignments.v1",
                "assignments": [{
                    "object_id": object_id,
                    "region_id": null,
                    "initializer": initializer,
                }],
            }),
        );

        let compiled = compile_physical(config).unwrap();
        let [first, second, third] = compiled.study.steps.as_slice() else {
            panic!("expected exactly three physical stages");
        };
        assert_eq!(second.completion_dependencies, vec![first.step_id.clone()]);
        assert_eq!(second.inputs.len(), 1);
        assert!(second.inputs[0].required);
        assert!(matches!(&second.inputs[0].source, StudyInputSource::AuthoredInitialState { .. }));
        assert_eq!(third.completion_dependencies, vec![second.step_id.clone()]);
        assert!(third.inputs.iter().any(|port| matches!(
            &port.source, StudyInputSource::StepOutput { step_id, .. }
                if step_id == &second.step_id
        )));
        validate_accepted_script_pipeline_source(&compiled.study, &compiled.catalog, &compiled.source_bytes)
            .unwrap();
    }

    #[test]
    fn table_configuration_preserves_snapshot_and_scene_reset_inputs() {
        use crate::script_stage_contract::{ScriptExecutionStage, ScriptExecutionStageAction};

        let mut config = physical_config();
        let initial = fullmag_ir::InitialMagnetizationIR::Uniform { value: [1.0, 0.0, 0.0] };
        let reset = fullmag_ir::InitialMagnetizationIR::Uniform { value: [0.0, 1.0, 0.0] };
        let table: fullmag_ir::TableAutosaveIR = serde_json::from_value(json!({
            "sample_period_s": 5e-14,
            "quantities": ["mx", "my"],
        })).unwrap();
        config.ir.magnets[0].initial_magnetization = Some(initial.clone());
        config.stages[0].ir.magnets[0].initial_magnetization = Some(initial.clone());
        config.stages[0].ir.study.sampling_mut().table_autosave = None;
        config.stages[1].ir.magnets[0].initial_magnetization = Some(reset.clone());
        config.stages[1].ir.study.sampling_mut().table_autosave = Some(table.clone());
        let magnet = &config.ir.magnets[0];
        let object_id = magnet.object_id.as_deref().unwrap_or(&magnet.name);
        let pipeline = config.study_pipeline.as_mut().unwrap();
        pipeline.version = "study_pipeline.v2".into();
        let crate::script_stage_contract::StudyPipelineNode::Primitive { payload, .. } =
            &mut pipeline.nodes[1] else { panic!("expected Run") };
        payload.insert("magnetization_assignments".into(), json!({
            "schema_version": "fullmag.magnetization-assignments.v1",
            "assignments": [{"object_id": object_id, "region_id": null, "initializer": reset}],
        }));
        pipeline.nodes.insert(1, serde_json::from_value(json!({
            "node_kind": "primitive", "id": "table", "label": "Configure table",
            "stage_kind": "table_autosave", "payload": {"table_autosave": table},
        })).unwrap());
        let mut before_configuration = config.stages[0].ir.clone();
        before_configuration.problem_meta.runtime_metadata.insert("active_stage_id".into(), json!("table"));
        config.stages.insert(1, ScriptExecutionStage {
            ir: before_configuration,
            default_until_seconds: None,
            entrypoint_kind: "flat_table_autosave".into(),
            action: Some(ScriptExecutionStageAction::TableAutosave {
                enabled: true, table_autosave: Some(table.clone()),
            }),
        });

        let mut different = config.clone();
        different.stages[1].action = Some(ScriptExecutionStageAction::TableAutosave {
            enabled: false, table_autosave: None,
        });
        assert!(format!("{:#}", compile_physical(different).err().unwrap())
            .contains("differs from its authored payload"));
        let mut unsupported = config.clone();
        unsupported.study_pipeline.as_mut().unwrap().nodes[1] = serde_json::from_value(json!({
            "node_kind": "primitive", "id": "table", "label": "Save state",
            "stage_kind": "save_state",
        })).unwrap();
        unsupported.stages[1].action = Some(ScriptExecutionStageAction::SaveState {
            artifact_name: "state_snapshot".into(), format: None, dataset: None,
        });
        assert!(format!("{:#}", compile_physical(unsupported).err().unwrap())
            .contains("cannot mix explicit stages"));

        let mut reconstructed = config.clone();
        reconstructed.stages.clear();
        for input in [config, reconstructed] {
            let compiled = compile_physical(input).unwrap();
            let [first, second] = compiled.study.steps.as_slice() else {
                panic!("only the two Run stages should become worker tasks");
            };
            assert_eq!(second.completion_dependencies, vec![first.step_id.clone()]);
            assert!(matches!(&second.inputs[0].source, StudyInputSource::AuthoredInitialState { .. }));
            let before = compiled.catalog.entries()[0].problem();
            let after = compiled.catalog.entries()[1].problem();
            assert_eq!(before.magnets[0].initial_magnetization.as_ref(), Some(&initial));
            assert_eq!(after.magnets[0].initial_magnetization.as_ref(), Some(&reset));
            assert!(before.study.sampling().table_autosave.is_none());
            assert_eq!(after.study.sampling().table_autosave.as_ref(), Some(&table));
            let source = validate_accepted_script_pipeline_source(
                &compiled.study, &compiled.catalog, &compiled.source_bytes,
            ).unwrap();
            assert_eq!(source["nodes"][1]["authored_step_id"], "table");
            assert_eq!(source["nodes"][1]["execution_ids"], json!([]));
        }
    }

    #[test]
    fn scoped_script_reset_pins_one_predecessor_and_is_checked_on_cold_load() {
        let mut config = physical_config();
        let region_id = "strip:changed";
        let mut region: fullmag_ir::ObjectRegionIR = serde_json::from_value(json!({
            "region_id": region_id, "owner_object": "strip", "name": "changed",
            "shape": {"kind": "box", "size": [80e-9, 20e-9, 6e-9], "center": [0.0, 0.0, 0.0]},
        })).unwrap();
        config.stages[0].ir.object_regions.push(region.clone());
        let initializer = fullmag_ir::InitialMagnetizationIR::Uniform { value: [0.0, 1.0, 0.0] };
        region.texture_override = Some(fullmag_ir::RegionTextureOverrideIR {
            initial_magnetization: initializer.clone(),
        });
        config.stages[1].ir.object_regions.push(region);
        let document = config.study_pipeline.as_mut().unwrap();
        document.version = "study_pipeline.v2".into();
        let crate::script_stage_contract::StudyPipelineNode::Primitive { payload, .. } = &mut document.nodes[1] else {
            panic!("expected Run");
        };
        payload.insert("magnetization_assignments".into(), json!({
            "schema_version": "fullmag.magnetization-assignments.v1",
            "assignments": [{"object_id": "strip", "region_id": region_id, "initializer": initializer}],
        }));

        let mut compiled = compile_physical(config).unwrap();
        let step = &compiled.study.steps[1];
        assert_eq!(step.inputs.len(), 1);
        assert!(matches!(&step.inputs[0].source, StudyInputSource::StepOutput { .. }));
        assert_eq!(step.initial_state_overlay.as_ref().unwrap().scopes(), &[
            fullmag_ir::RegionRefIR { object_id: "strip".into(), region_id: Some(region_id.into()) },
        ]);
        validate_accepted_script_pipeline_source(&compiled.study, &compiled.catalog, &compiled.source_bytes)
            .unwrap();
        compiled.study.steps[1].initial_state_overlay = None;
        assert!(validate_accepted_script_pipeline_source(
            &compiled.study, &compiled.catalog, &compiled.source_bytes
        ).is_err());
    }

    #[test]
    fn scene_materialization_applies_ordered_resets_only_to_reachable_stages() {
        let mut config = physical_config();
        let first_m = fullmag_ir::InitialMagnetizationIR::Uniform { value: [1.0, 0.0, 0.0] };
        let second_m = fullmag_ir::InitialMagnetizationIR::Uniform { value: [0.0, 1.0, 0.0] };
        let skipped_m = fullmag_ir::InitialMagnetizationIR::Uniform { value: [0.0, 0.0, 1.0] };
        config.ir.magnets[0].initial_magnetization = Some(first_m.clone());
        let magnet = &config.ir.magnets[0];
        let object_id = magnet.object_id.as_deref().unwrap_or(&magnet.name);
        let node = |id: &str, enabled: bool, initializer: Option<&fullmag_ir::InitialMagnetizationIR>| {
            let mut payload = json!({"until_seconds": 1e-12});
            if let Some(initializer) = initializer {
                payload["magnetization_assignments"] = json!({
                    "schema_version": "fullmag.magnetization-assignments.v1",
                    "assignments": [{
                        "object_id": object_id,
                        "region_id": null,
                        "initializer": initializer,
                    }],
                });
            }
            json!({
                "node_kind": "primitive", "id": id, "label": id,
                "stage_kind": "run", "enabled": enabled, "payload": payload,
            })
        };
        config.study_pipeline = Some(serde_json::from_value(json!({
            "version": "study_pipeline.v2",
            "nodes": [
                node("a", true, None),
                node("b", false, Some(&second_m)),
                {"node_kind": "group", "id": "disabled", "label": "Disabled",
                 "enabled": false, "children": [node("skipped", true, Some(&skipped_m))]},
                node("c", true, None),
                node("d", true, None),
            ],
        })).unwrap());
        config.stages.clear();

        let stages = crate::script_stage_materialization::materialize_script_stages_with_output_policy(
            config, fullmag_ir::configure_project_autosave_policy,
        ).unwrap();
        assert_eq!(
            stages.iter().map(|stage| stage.provenance.as_ref().unwrap().authored_step_id.as_str())
                .collect::<Vec<_>>(),
            vec!["a", "c", "d"],
        );
        assert_eq!(stages[0].ir.magnets[0].initial_magnetization.as_ref(), Some(&first_m));
        for stage in &stages[1..] {
            assert_eq!(stage.ir.magnets[0].initial_magnetization.as_ref(), Some(&second_m));
        }
    }

    #[test]
    fn stage_local_region_reset_stays_with_its_enabled_owner() {
        let mut config = physical_config();
        let independent = fullmag_ir::InitialMagnetizationIR::Uniform { value: [0.0, 1.0, 0.0] };
        let local = fullmag_ir::InitialMagnetizationIR::Uniform { value: [0.0, 0.0, 1.0] };
        config.ir.object_regions.push(serde_json::from_value(json!({
            "region_id": "strip:core", "owner_object": "strip", "name": "core",
            "shape": {"kind": "box", "size": [80e-9, 20e-9, 6e-9], "center": [0.0, 0.0, 0.0]},
        })).unwrap());
        let batch = |initializer: &fullmag_ir::InitialMagnetizationIR| json!({
            "schema_version": "fullmag.magnetization-assignments.v1",
            "assignments": [{
                "object_id": "strip", "region_id": "strip:core", "initializer": initializer,
            }],
        });
        let node = |id: &str, payload| json!({
            "id": id, "label": id, "node_kind": "primitive",
            "stage_kind": "run", "payload": payload,
        });
        config.study_pipeline = Some(serde_json::from_value(json!({
            "version": "study_pipeline.v2",
            "nodes": [
                node("a", json!({"until_seconds": 1e-12})),
                node("b", json!({
                    "until_seconds": 1e-12,
                    "magnetization_assignments": batch(&independent),
                    "stage_magnetization_assignments": batch(&local),
                })),
                node("c", json!({"until_seconds": 1e-12})),
            ],
        })).unwrap());
        config.stages.clear();

        let enabled = compile_physical(config.clone()).unwrap();
        let [a, b, c] = enabled.study.steps.as_slice() else { panic!("expected A, B, C"); };
        assert!(matches!(&b.inputs[0].source, StudyInputSource::StepOutput { step_id, .. } if step_id == &a.step_id));
        assert_eq!(b.initial_state_overlay.as_ref().unwrap().scopes(), &[
            fullmag_ir::RegionRefIR { object_id: "strip".into(), region_id: Some("strip:core".into()) },
        ]);
        assert!(matches!(&c.inputs[0].source, StudyInputSource::StepOutput { step_id, .. } if step_id == &b.step_id));
        assert!(c.initial_state_overlay.is_none());

        let texture = |index: usize| enabled.catalog.entries()[index].problem()
            .object_regions[0].texture_override.as_ref().unwrap().initial_magnetization.clone();
        assert_eq!(texture(1), local);
        assert_eq!(texture(2), independent);

        // The reimported Python snapshots carry the independent setter and
        // the canonical payload supplies the local override at materialization.
        let mut captured = config.clone();
        captured.stages = enabled.catalog.entries().iter().map(|entry| {
            crate::script_stage_contract::ScriptExecutionStage {
                ir: entry.problem().clone(),
                default_until_seconds: Some(1e-12),
                entrypoint_kind: "flat_run".into(),
                action: None,
            }
        }).collect();
        captured.stages[1].ir.object_regions[0].texture_override.as_mut().unwrap()
            .initial_magnetization = independent.clone();
        let reimported = compile_physical(captured).unwrap();
        assert_eq!(
            reimported.catalog.entries()[1].problem().object_regions[0]
                .texture_override.as_ref().unwrap().initial_magnetization, local,
        );
        let StudyPipelineNode::Primitive { enabled: enabled_b, .. } =
            &mut config.study_pipeline.as_mut().unwrap().nodes[1] else { panic!("expected B"); };
        *enabled_b = false;

        let disabled = compile_physical(config).unwrap();
        let [a, c] = disabled.study.steps.as_slice() else { panic!("expected A, C"); };
        assert!(matches!(&c.inputs[0].source, StudyInputSource::StepOutput { step_id, .. } if step_id == &a.step_id));
        assert!(c.initial_state_overlay.is_some());
        assert_eq!(
            disabled.catalog.entries()[1].problem().object_regions[0]
                .texture_override.as_ref().unwrap().initial_magnetization, independent,
        );
    }

    #[test]
    fn physical_contract_refuses_another_activation_identity() {
        let mut config=physical_config();
        config.stages[0].ir.problem_meta.runtime_metadata.insert("active_stage_id".into(),json!("another"));
        let node=crate::script_pipeline_compilation::authored_node(&config.study_pipeline.as_ref().unwrap().nodes,"first").unwrap();
        assert!(physical_step_contract(node,&config.stages[0].ir,1e-12,None,&[]).is_err());
    }
    #[test]
    fn cold_source_refuses_relabeling_physical_node_as_closed_loop() {
        let compiled=compile_physical(physical_config()).unwrap();let mut study=compiled.study.clone();
        study.steps[0].kind=StudyStepKind::ClosedLoopInspection{stage_id:"stage".into(),port_mode_id:"port".into(),output_id:"inspection".into()};
        study.steps[0].until_seconds=None;study.steps[0].inputs.clear();
        study.steps[0].outputs=vec![StudyOutputPort{port_id:"inspection".into(),data_kind:StudyPortDataKind::Artifact}];
        assert!(validate_accepted_script_pipeline_source(&study,&compiled.catalog,&compiled.source_bytes).is_err());
    }
    #[test]
    fn physical_authored_identity_is_not_used_as_a_temporary_catalog_path() {
        let mut config=physical_config();
        let id="physical stage / źródło";
        if let crate::script_stage_contract::StudyPipelineNode::Primitive{id:node_id,..}=&mut config.study_pipeline.as_mut().unwrap().nodes[0] {*node_id=id.into();}
        config.stages[0].ir.problem_meta.runtime_metadata.insert("active_stage_id".into(),json!(id));
        let compiled=compile_physical(config).unwrap();
        assert!(compiled.study.steps[0].step_id.starts_with("script-execution-"));
        assert_eq!(compiled.catalog.entries()[0].problem().problem_meta.runtime_metadata["active_stage_id"],id);
    }
    #[test]
    fn cold_source_refuses_authored_and_study_version_mismatch() {
        let compiled=compile_physical(physical_config()).unwrap();
        let mut study=compiled.study.clone();study.source_pipeline_version=Some("future".into());
        assert!(validate_accepted_script_pipeline_source(&study,&compiled.catalog,&compiled.source_bytes).is_err());
        let mut source:Value=serde_json::from_slice(&compiled.source_bytes).unwrap();
        source["authored_pipeline"]["version"]=json!("future");
        source["authored_pipeline_sha256"]=json!(fullmag_ir::canonical_ir_json_sha256(&source["authored_pipeline"]).unwrap());
        assert!(validate_accepted_script_pipeline_source(&compiled.study,&compiled.catalog,&serde_json::to_vec(&source).unwrap()).is_err());
    }
    #[test]
    fn physical_snapshot_cannot_replace_carried_profile() {
        let mut config=physical_config();let mut foreign=physical_profile();foreign.version="foreign".into();
        config.stages[0].ir.problem_meta.runtime_metadata.insert("execution_profile".into(),serde_json::to_value(foreign).unwrap());
        assert!(compile_physical(config).err().unwrap().to_string().contains("execution_intent_conflict"));
    }
    #[test]
    fn cold_physical_source_refuses_changed_state_case_and_duration() {
        let compiled=compile_physical(physical_config()).unwrap();
        let mut study=compiled.study.clone();
        let StudyInputSource::StepOutput{case_id,..}=&mut study.steps[1].inputs[0].source else {panic!("physical State source missing");};
        *case_id="other".into();
        assert!(validate_accepted_script_pipeline_source(&study,&compiled.catalog,&compiled.source_bytes).is_err());
        let mut study=compiled.study.clone();study.steps[1].until_seconds=Some(2e-12);
        assert!(validate_accepted_script_pipeline_source(&study,&compiled.catalog,&compiled.source_bytes).is_err());
    }
    #[test]
    fn cold_source_cannot_drop_an_enabled_physical_execution() {
        let compiled=compile_physical(physical_config()).unwrap();let mut study=compiled.study.clone();
        study.steps.remove(0);study.steps[0].completion_dependencies.clear();study.steps[0].inputs.clear();
        let remaining=study.steps[0].step_id.clone();
        let entries=compiled.catalog.entries().iter().filter(|entry|entry.step_id()==remaining).cloned().collect();
        let catalog=StudyProblemCatalog::from_entries(&study,entries).unwrap();
        let mut source:Value=serde_json::from_slice(&compiled.source_bytes).unwrap();
        source["nodes"][0]["execution_ids"]=json!([]);source["executions"].as_array_mut().unwrap().remove(0);
        let error=validate_accepted_script_pipeline_source(&study,&catalog,&serde_json::to_vec(&source).unwrap()).unwrap_err();
        assert!(error.to_string().contains("enabled physical primitive must own exactly one"));
    }

    #[test]
    fn capture_policy_preserves_legacy_and_accepts_explicit_bootstrap_version() {
        let mut value = capture();
        validate_capture_shape(&value).unwrap();
        value["runtime"]["capture_policy"] = json!("trusted_readonly_dsl_observed_io.v2");
        validate_capture_shape(&value).unwrap();
        value["runtime"]["capture_policy"] = json!("trusted_readonly_dsl_observed_io.v3");
        assert!(validate_capture_shape(&value).is_err());
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
