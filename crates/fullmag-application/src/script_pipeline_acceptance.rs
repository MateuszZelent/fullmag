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
    let mut previous_physical = None;
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
        if execution.stage.action.is_none() {
            validate_physical_state_predecessor(previous_physical, &execution.stage.ir)?;
        }
        let (kind,until_seconds,mut inputs,initial_state_overlay,outputs)=match &execution.stage.action {
            Some(ResolvedScriptStageAction::AntennaRetainedDirectInspection{plan})=>{
                let port_mode_id=plan.stage.port_mode_ids.first().context("retained-preparation port missing")?;
                let output_id=&plan.stage.outputs.first().context("retained-preparation output missing")?.id;
                let operation=fullmag_plan::validate_retained_direct_field_operation(&execution.stage.ir,&plan.stage.id,port_mode_id,output_id)?;
                if operation!=*plan {bail!("compiled retained-preparation action differs from canonical operation planning");}
                (StudyStepKind::RetainedCurrentFieldInspection{stage_id:plan.stage.id.clone(),port_mode_id:port_mode_id.clone(),output_id:output_id.clone()},None,vec![],None,vec![StudyOutputPort{port_id:"inspection".into(),data_kind:StudyPortDataKind::Artifact}])
            },
            Some(ResolvedScriptStageAction::AntennaRetainedPreparationInspection{plan})=>{
                let port_mode_id=plan.stage.port_mode_ids.first().context("retained-preparation port missing")?;
                let output_id=&plan.stage.outputs.first().context("retained-preparation output missing")?.id;
                let operation=fullmag_plan::validate_retained_preparation_field_operation(&execution.stage.ir,&plan.stage.id,port_mode_id,output_id)?;
                if operation!=*plan {bail!("compiled retained-preparation action differs from canonical operation planning");}
                (StudyStepKind::RetainedCurrentFieldInspection{stage_id:plan.stage.id.clone(),port_mode_id:port_mode_id.clone(),output_id:output_id.clone()},None,vec![],None,vec![StudyOutputPort{port_id:"inspection".into(),data_kind:StudyPortDataKind::Artifact}])
            },
            Some(ResolvedScriptStageAction::AntennaRetainedCurrentInspection{plan})=>{
                let port_mode_id=plan.stage.port_mode_ids.first().context("retained-current port missing")?;
                let output_id=&plan.stage.outputs.first().context("retained-current output missing")?.id;
                let operation=fullmag_plan::validate_retained_current_field_operation(&execution.stage.ir,&plan.stage.id,port_mode_id,output_id)?;
                if operation!=*plan {bail!("compiled retained-current action differs from canonical operation planning");}
                (StudyStepKind::RetainedCurrentFieldInspection{stage_id:plan.stage.id.clone(),port_mode_id:port_mode_id.clone(),output_id:output_id.clone()},None,vec![],None,vec![StudyOutputPort{port_id:"inspection".into(),data_kind:StudyPortDataKind::Artifact}])
            },
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
        if matches!(&step.kind,StudyStepKind::Primitive{..}) {previous_state=Some(execution.execution_id.clone());previous_physical=Some(&execution.stage.ir);}
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
    if bind_scene_study_authored_initial_state_ports(study, catalog.entries(), None)? {
        Ok(StudyProblemCatalog::from_entries(study, catalog.into_entries())?)
    } else {
        Ok(catalog)
    }
}

/// Bind authored v2 state ports without validating the unreduced execution graph.
/// A selected-stage caller must rebind inherited inputs before graph validation.
pub fn bind_scene_study_authored_initial_state_ports(
    study: &mut StudyPlan,
    entries: &[StudyProblemCatalogEntry],
    selected_step_id: Option<&str>,
) -> Result<bool> {
    if study.source_pipeline_version.as_deref() != Some("study_pipeline.v2") {
        return Ok(false);
    }
    let mut changed = false;
    for step in study.steps.iter_mut().filter(|step| step.enabled && step.inputs.is_empty()
        && selected_step_id.map_or(true, |id| step.step_id == id)) {
        if !matches!(&step.kind, StudyStepKind::Primitive {
            stage_kind: fullmag_authoring::StudyPrimitiveStageKind::Run
                | fullmag_authoring::StudyPrimitiveStageKind::Relax,
        }) {
            continue;
        }
        let problem = entries.iter().find(|entry| entry.step_id() == step.step_id)
            .with_context(|| format!("authored stage '{}' has no bound ProblemIR", step.step_id))?
            .problem();
        step.inputs.push(authored_initial_state_port(&step.step_id, problem)?);
        changed = true;
    }
    Ok(changed)
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

fn validate_physical_state_predecessor(previous: Option<&fullmag_ir::ProblemIR>, current: &fullmag_ir::ProblemIR) -> Result<()> {
    if previous.is_some_and(|previous| !crate::script_stage_materialization::compatible_physical_state_topology(previous, current)) {
        bail!("accepted physical state chain requires compatible runtime topology");
    }
    Ok(())
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
        if expected.effectively_enabled && matches!(crate::script_pipeline_compilation::authored_node(&authored.nodes,&expected.authored_step_id),
            Some(crate::script_stage_contract::StudyPipelineNode::Primitive{stage_kind,..}) if stage_kind=="antenna_field_solve") && ids.len()!=1 {
            bail!("enabled antenna primitive must own exactly one captured execution");
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
    let mut previous_physical = None;
    let mut physical_clock = None;
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
            StudyStepKind::RetainedCurrentFieldInspection{stage_id,port_mode_id,output_id}=>{
                if step.until_seconds.is_some() || !step.inputs.is_empty() || step.outputs!=vec![StudyOutputPort{port_id:"inspection".into(),data_kind:StudyPortDataKind::Artifact}]
                    || !step.enabled || step.acceptance!=StudyAcceptancePolicy::Any || step.acquisition!=StudyAcquisitionPolicy::Exclusive || step.legacy_payload.is_some() {
                    bail!("retained-current source requires an enabled static Artifact operation with Any/Exclusive and no legacy payload");
                }
                let authored_node=crate::script_pipeline_compilation::authored_node(&authored.nodes,execution["authored_step_id"].as_str().context("retained-current source ID missing")?)
                    .context("retained-current authored node missing")?;
                let crate::script_stage_contract::StudyPipelineNode::Primitive{stage_kind,payload,..}=authored_node else {
                    bail!("retained-current operation requires its authored antenna primitive; no H-only macro expansion is supported");
                };
                if stage_kind!="antenna_field_solve" {bail!("retained-current operation must retain its authored antenna action");}
                let (authored_stage,authored_port)=crate::script_stage_materialization::parse_antenna_solve_selection(payload)?;
                if &authored_stage!=stage_id || &authored_port!=port_mode_id {bail!("retained-current source selectors differ from its authored antenna action");}
                if entry.problem().antenna_field_solve_stages.iter().any(|stage| stage.id==*stage_id && stage.oersted_realization==fullmag_ir::AntennaOerstedRealizationIR::DirectTetraQuadrature) {
                    fullmag_plan::validate_retained_direct_field_operation(entry.problem(),stage_id,port_mode_id,output_id)?;
                } else if entry.problem().antenna_field_solve_stages.iter().any(|stage| stage.id==*stage_id && stage.retained_source_preparation.is_some()) {
                    fullmag_plan::validate_retained_preparation_field_operation(entry.problem(),stage_id,port_mode_id,output_id)?;
                } else {
                    fullmag_plan::validate_retained_current_field_operation(entry.problem(),stage_id,port_mode_id,output_id)?;
                }
            },
            StudyStepKind::ClosedLoopInspection{stage_id,port_mode_id,output_id}=>{
                if step.until_seconds.is_some() || !step.inputs.is_empty() || step.outputs!=vec![StudyOutputPort{port_id:"inspection".into(),data_kind:StudyPortDataKind::Artifact}] {bail!("closed-loop source cannot carry physical state ports or a horizon");}
                fullmag_plan::validate_closed_loop_operation(entry.problem(),stage_id,port_mode_id,output_id)?;
            },
            StudyStepKind::Primitive{..}=>{
                validate_physical_state_predecessor(previous_physical, entry.problem())?;
                let authored_id = execution["authored_step_id"].as_str().context("physical source ID missing")?;
                let node=crate::script_pipeline_compilation::authored_node(&authored.nodes,authored_id).context("physical source node missing")?;
                let (kind,horizon,mut inputs,overlay,outputs)=physical_step_contract(node,entry.problem(),step.until_seconds.unwrap_or(0.0),previous_state.as_deref(),
                    magnetization_assignments.get(authored_id).map(|batch| batch.ordered.as_slice()).unwrap_or_default())?;
                if authored.version == "study_pipeline.v2" && inputs.is_empty() {
                    inputs.push(authored_initial_state_port(&step.step_id, entry.problem())?);
                }
                if let Some(duration) = horizon {
                    let start = crate::script_pipeline_compilation::read_physical_stage_start(entry.problem())?;
                    if physical_clock.is_some_and(|expected| expected != start) {
                        bail!("physical Run clock differs from its sequential predecessor");
                    }
                    physical_clock = Some(crate::script_pipeline_compilation::advance_physical_clock(start, duration)?);
                }
                if step.kind!=kind || step.until_seconds!=horizon || step.inputs!=inputs || step.initial_state_overlay!=overlay || step.outputs!=outputs
                    || !step.enabled || step.acceptance!=StudyAcceptancePolicy::Any || step.acquisition!=StudyAcquisitionPolicy::Exclusive || step.legacy_payload.is_some() {
                    bail!("physical source operation, horizon or exact predecessor state chain differs");
                }
                previous_state=Some(step.step_id.clone());
                previous_physical=Some(entry.problem());
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
    fn physical_runs_keep_cumulative_clock_and_saved_waveform_origin() {
        let mut config = physical_config();
        config.stages[0].ir.problem_meta.runtime_metadata.insert("stage_start_time_s".into(), json!(4e-12));
        config.stages[1].ir.problem_meta.runtime_metadata.insert("stage_start_time_s".into(), json!(5e-12));
        config.stages[1].ir.problem_meta.runtime_metadata.insert("stage_waveform_origin_time_s".into(), json!(2e-12));
        let compiled = compile_physical(config).unwrap();
        let entries = compiled.catalog.entries();
        assert_eq!(entries[0].problem().problem_meta.runtime_metadata["stage_start_time_s"], json!(4e-12));
        assert_eq!(entries[1].problem().problem_meta.runtime_metadata["stage_start_time_s"], json!(4e-12 + 1e-12));
        assert_eq!(entries[1].problem().problem_meta.runtime_metadata["stage_waveform_origin_time_s"], json!(2e-12));
        validate_accepted_script_pipeline_source(&compiled.study, &compiled.catalog, &compiled.source_bytes).unwrap();
    }
    #[test]
    fn physical_clock_rejects_invalid_seed_overflow_and_lost_increment() {
        for seed in [json!(-1.0), json!("bad"), json!(1e300)] {
            let mut config = physical_config();
            config.stages[0].ir.problem_meta.runtime_metadata.insert("stage_start_time_s".into(), seed);
            assert!(compile_physical(config).is_err());
        }
        assert!(crate::script_pipeline_compilation::advance_physical_clock(1e308, 1e308).is_err());
    }
    #[test]
    fn cold_source_refuses_reset_clock_even_with_valid_capture_hashes() {
        let compiled=compile_physical(physical_config()).unwrap();
        let mut study=compiled.study.clone();
        let old=&compiled.catalog.entries()[1];
        let mut problem=old.problem().clone();
        problem.problem_meta.runtime_metadata.insert("stage_start_time_s".into(),json!(0.0));
        let refs=capture_study_input_references(&study.steps[1].step_id,&problem).unwrap();
        study.steps[1].model=refs.model;
        study.steps[1].solver_config=refs.solver_config;
        study.steps[1].discretization=refs.discretization;
        let entry=StudyProblemCatalogEntry::from_captured_materialized_step(&study.steps[1],problem,
            old.execution_materialization().unwrap().clone(),refs.identity.clone()).unwrap();
        let catalog=StudyProblemCatalog::from_entries(&study,vec![compiled.catalog.entries()[0].clone(),entry]).unwrap();
        let mut source:Value=serde_json::from_slice(&compiled.source_bytes).unwrap();
        source["executions"][1]["problem_sha256"]=json!(refs.identity.problem_sha256);
        let error=validate_accepted_script_pipeline_source(&study,&catalog,&serde_json::to_vec(&source).unwrap()).unwrap_err();
        assert!(error.to_string().contains("physical Run clock"),"{error:#}");
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
        let crate::script_stage_contract::StudyPipelineNode::Primitive { enabled: enabled_b, .. } =
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
    fn relax_region_reset_round_trip_keeps_local_and_independent_owners_distinct() {
        use crate::script_stage_contract::StudyPipelineNode;

        let mut config = physical_config();
        config.ir = fullmag_ir::ProblemIR::bootstrap_example();
        config.stages.clear();

        let global = fullmag_ir::InitialMagnetizationIR::Uniform { value: [1.0, 0.0, 0.0] };
        let independent = fullmag_ir::InitialMagnetizationIR::Uniform { value: [0.0, 1.0, 0.0] };
        let local = fullmag_ir::InitialMagnetizationIR::Uniform { value: [0.0, 0.0, 1.0] };
        let region_id = "strip:core";
        config.ir.magnets[0].initial_magnetization = Some(global.clone());
        config.ir.object_regions.push(serde_json::from_value(json!({
            "region_id": region_id,
            "owner_object": "strip",
            "name": "core",
            "shape": {
                "kind": "box",
                "size": [80e-9, 20e-9, 6e-9],
                "center": [0.0, 0.0, 0.0]
            }
        })).unwrap());

        let batch = |initializer: &fullmag_ir::InitialMagnetizationIR| json!({
            "schema_version": "fullmag.magnetization-assignments.v1",
            "assignments": [{
                "object_id": "strip",
                "region_id": region_id,
                "initializer": initializer,
            }],
        });
        let relax_node = |id: &str, payload| json!({
            "id": id,
            "label": id,
            "node_kind": "primitive",
            "stage_kind": "relax",
            "enabled": true,
            "payload": payload,
        });
        let mut b_payload = json!({
            "kind": "relax",
            "algorithm": "llg_overdamped",
            "max_steps": 2,
        });
        b_payload["magnetization_assignments"] = batch(&independent);
        b_payload["stage_magnetization_assignments"] = batch(&local);
        config.study_pipeline = Some(serde_json::from_value(json!({
            "version": "study_pipeline.v2",
            "nodes": [
                relax_node("a", json!({"kind": "relax", "max_steps": 2})),
                relax_node("b", b_payload),
                relax_node("c", json!({"kind": "relax", "max_steps": 2})),
            ],
        })).unwrap());

        // These checks cover authored/materialized ProblemIR and state-port
        // semantics. They do not assert native grid-cell samples.
        let assert_textures = |compiled: &AcceptedScriptPipeline,
                               index: usize,
                               expected_region: Option<&fullmag_ir::InitialMagnetizationIR>| {
            let problem = compiled.catalog.entries()[index].problem();
            assert_eq!(problem.magnets[0].initial_magnetization.as_ref(), Some(&global));
            let region_texture = problem.object_regions[0]
                .texture_override
                .as_ref()
                .map(|texture| &texture.initial_magnetization);
            assert_eq!(region_texture, expected_region);
        };

        let enabled = compile_physical(config.clone()).unwrap();
        let [a, b, c] = enabled.study.steps.as_slice() else {
            panic!("expected Relax stages A, B, C");
        };
        assert!(matches!(
            &b.inputs[0].source,
            StudyInputSource::StepOutput { step_id, .. } if step_id == &a.step_id
        ));
        assert_eq!(b.initial_state_overlay.as_ref().unwrap().scopes(), &[
            fullmag_ir::RegionRefIR {
                object_id: "strip".into(),
                region_id: Some(region_id.into()),
            },
        ]);
        assert!(matches!(
            &c.inputs[0].source,
            StudyInputSource::StepOutput { step_id, .. } if step_id == &b.step_id
        ));
        assert!(c.initial_state_overlay.is_none());
        assert_textures(&enabled, 0, None);
        assert_textures(&enabled, 1, Some(&local));
        assert_textures(&enabled, 2, Some(&independent));
        let enabled_source: Value = serde_json::from_slice(&enabled.source_bytes).unwrap();
        assert_eq!(enabled_source["nodes"][1]["authored_step_id"], "b");
        assert_eq!(enabled_source["nodes"][1]["execution_ids"], json!([b.step_id]));
        validate_accepted_script_pipeline_source(
            &enabled.study,
            &enabled.catalog,
            &enabled.source_bytes,
        )
        .unwrap();
        let b_step_id = b.step_id.clone();
        let c_step_id = c.step_id.clone();

        let StudyPipelineNode::Primitive { enabled, .. } =
            &mut config.study_pipeline.as_mut().unwrap().nodes[1]
        else {
            panic!("expected Relax B");
        };
        *enabled = false;

        let disabled = compile_physical(config.clone()).unwrap();
        let [a, c] = disabled.study.steps.as_slice() else {
            panic!("expected A and C when B is disabled");
        };
        assert_eq!(c.step_id, c_step_id);
        assert_eq!(c.completion_dependencies, vec![a.step_id.clone()]);
        assert!(matches!(
            &c.inputs[0].source,
            StudyInputSource::StepOutput { step_id, .. } if step_id == &a.step_id
        ));
        assert_eq!(c.initial_state_overlay.as_ref().unwrap().scopes(), &[
            fullmag_ir::RegionRefIR {
                object_id: "strip".into(),
                region_id: Some(region_id.into()),
            },
        ]);
        assert_textures(&disabled, 0, None);
        assert_textures(&disabled, 1, Some(&independent));
        let disabled_source: Value = serde_json::from_slice(&disabled.source_bytes).unwrap();
        assert_eq!(disabled_source["nodes"][1]["authored_step_id"], "b");
        assert_eq!(disabled_source["nodes"][1]["execution_ids"], json!([]));
        validate_accepted_script_pipeline_source(
            &disabled.study,
            &disabled.catalog,
            &disabled.source_bytes,
        )
        .unwrap();

        let StudyPipelineNode::Primitive { enabled, .. } =
            &mut config.study_pipeline.as_mut().unwrap().nodes[1]
        else {
            panic!("expected Relax B");
        };
        *enabled = true;

        let reenabled = compile_physical(config).unwrap();
        let [a, b, c] = reenabled.study.steps.as_slice() else {
            panic!("expected Relax stages A, B, C after re-enabling B");
        };
        assert_eq!(b.step_id, b_step_id);
        assert_eq!(c.step_id, c_step_id);
        assert!(matches!(
            &b.inputs[0].source,
            StudyInputSource::StepOutput { step_id, .. } if step_id == &a.step_id
        ));
        assert_eq!(b.initial_state_overlay.as_ref().unwrap().scopes(), &[
            fullmag_ir::RegionRefIR {
                object_id: "strip".into(),
                region_id: Some(region_id.into()),
            },
        ]);
        assert!(matches!(
            &c.inputs[0].source,
            StudyInputSource::StepOutput { step_id, .. } if step_id == &b.step_id
        ));
        assert_textures(&reenabled, 1, Some(&local));
        assert_textures(&reenabled, 2, Some(&independent));
        validate_accepted_script_pipeline_source(
            &reenabled.study,
            &reenabled.catalog,
            &reenabled.source_bytes,
        )
        .unwrap();
    }

    #[test]
    fn physical_chain_refuses_incompatible_topology_before_acceptance() {
        let mut config=physical_config();
        if let fullmag_ir::GeometryEntryIR::Box {size,..}=&mut config.stages[1].ir.geometry.entries[0] {
            size[0] *= 2.0;
        } else {panic!("expected box fixture");}
        config.stages[1].ir.validate().unwrap();
        config.ir=config.stages[1].ir.clone();
        let error=compile_physical(config).err().expect("incompatible state chain must refuse");
        assert!(error.to_string().contains("compatible runtime topology"),"{error:#}");
    }
    #[test]
    fn cold_source_refuses_incompatible_physical_state_even_with_valid_capture_hashes() {
        let compiled=compile_physical(physical_config()).unwrap();
        let mut study=compiled.study.clone();
        let old=&compiled.catalog.entries()[1];
        let mut problem=old.problem().clone();
        if let fullmag_ir::GeometryEntryIR::Box {size,..}=&mut problem.geometry.entries[0] {size[0]*=2.0;}
        let refs=capture_study_input_references(&study.steps[1].step_id,&problem).unwrap();
        study.steps[1].model=refs.model;
        study.steps[1].solver_config=refs.solver_config;
        study.steps[1].discretization=refs.discretization;
        let entry=StudyProblemCatalogEntry::from_captured_materialized_step(&study.steps[1],problem,
            old.execution_materialization().unwrap().clone(),refs.identity.clone()).unwrap();
        let catalog=StudyProblemCatalog::from_entries(&study,vec![compiled.catalog.entries()[0].clone(),entry]).unwrap();
        let mut source:Value=serde_json::from_slice(&compiled.source_bytes).unwrap();
        source["executions"][1]["problem_sha256"]=json!(refs.identity.problem_sha256);
        let error=validate_accepted_script_pipeline_source(&study,&catalog,&serde_json::to_vec(&source).unwrap()).unwrap_err();
        assert!(error.to_string().contains("compatible runtime topology"),"{error:#}");
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

    fn retained_config() -> ScriptExecutionConfig {
        // Shape/planning fixture only; no durable parent is authenticated here.
        let mut wire:Value=serde_json::from_str(include_str!("../../../tests/fixtures/runtime/antenna-standalone-pipeline.json")).unwrap();
        wire["ir"]["geometry_assets"]["fem_mesh_assets"].as_array_mut().unwrap().retain(|asset|asset["geometry_name"]=="probe");
        let stage=&mut wire["ir"]["antenna_field_solve_stages"][0];
        stage["retained_current_source"]=json!({"kind":"published_inspection","project_id":"project-source","run_id":"run-source",
            "task_id":"task-source","attempt_id":"attempt-source","ownership_epoch":"1","artifact_id":"artifact-source","object_ref":"a".repeat(64)});
        stage["oersted_realization"]=json!("analytic_rt0_surface");
        stage["surface_field_policy"]=json!({
            "policy_version":fullmag_ir::ANTENNA_SURFACE_FIELD_POLICY_VERSION,
            "limits":{"total":vec![1_000_000_u64;14],"per_target":vec![100_000_u64;14],
                "maximum_raw_integer_bits":8192,"maximum_reduced_fraction_bits":8192,
                "maximum_lifetime_peak_rss_bytes":268435456,"guard_interval_events":128,
                "maximum_total_seconds":600.0,"maximum_target_seconds":120.0},
            "tolerances":{"absolute_field_apm":1e-9,"relative_field":1e-5,"cancellation_floor_apm":1e-6,
                "scalar_relative_80":1e-45,"scalar_relative_120":1e-55,"angle_relative_80":1e-45,"angle_relative_120":1e-55,
                "binary_scalar_epsilon_factor":16.0,"binary_roundoff_epsilon_factor":64.0,
                "binary_cancellation_limit":1e8,"highprecision_cancellation_limit":1e40}});
        serde_json::from_value(wire).unwrap()
    }

    fn compile_retained() -> AcceptedScriptPipeline {
        let config=retained_config();
        let mut profile=physical_profile();
        profile.profile_id="retained".into();
        profile.defaults.backend=fullmag_ir::FieldPatch::Value(fullmag_ir::BackendTarget::Fem);
        compile_accepted_closed_loop_pipeline(config,"retained-study".into(),0,
            StudyExecutionProfileReference{profile_id:profile.profile_id.clone(),version:profile.version.clone()},vec![],capture(),
            |_,_|Ok(profile.clone()),fullmag_ir::configure_project_autosave_policy).unwrap()
    }

    #[test]
    fn retained_materialization_uses_a_static_action_without_magnetic_transfer() {
        let compiled=crate::materialize_script_pipeline_with_output_policy_bounded(
            retained_config(),fullmag_ir::configure_project_autosave_policy,16).unwrap();
        assert_eq!(compiled.executions.len(),2);
        assert!(compiled.executions[1].stage.incoming_transition.is_some());
        for execution in &compiled.executions {
            let Some(ResolvedScriptStageAction::AntennaRetainedCurrentInspection{plan})=&execution.stage.action else {panic!("retained current must not enter fresh transport")};
            assert_eq!(plan.stage.id,"inspect_antenna");
            assert_eq!(plan.field_sampling.positions_xyz_m.len(),4);
            if let Some(transition)=&execution.stage.incoming_transition {
                assert_eq!(transition.kind,crate::script_stage_contract::StageTransitionKind::AntennaRetainedCurrentInspection);
                assert_eq!(transition.reason,crate::script_stage_contract::StageTransitionReason::AntennaRetainedCurrentInspection);
                assert!(transition.transfer_operator.is_none());
                assert!(!transition.legacy_state_transition_label().contains("computed"));
            }
            assert!(execution.stage.ir.magnets.is_empty());
        }
    }

    #[test]
    fn retained_compiler_preserves_completion_order_without_state_ports() {
        let compiled=compile_retained();
        assert_eq!(compiled.study.steps.len(),2);
        assert!(compiled.study.steps[0].completion_dependencies.is_empty());
        assert_eq!(compiled.study.steps[1].completion_dependencies,vec![compiled.study.steps[0].step_id.clone()]);
        for step in &compiled.study.steps {
            assert!(matches!(&step.kind,StudyStepKind::RetainedCurrentFieldInspection{stage_id,port_mode_id,output_id}
                if stage_id=="inspect_antenna" && port_mode_id=="port" && output_id=="inspection"));
            assert!(step.inputs.is_empty());assert!(step.until_seconds.is_none());
            assert_eq!(step.outputs,vec![StudyOutputPort{port_id:"inspection".into(),data_kind:StudyPortDataKind::Artifact}]);
        }
        let lowered=fullmag_plan::lower_study_plan_with_catalog(&compiled.study,&compiled.catalog).unwrap();
        for step in &lowered.steps {assert!(matches!(&step.execution_plan.as_ref().unwrap().backend_plan,
            fullmag_ir::BackendPlanIR::AntennaRetainedCurrentFieldInspection(_)));}
        validate_accepted_script_pipeline_source(&compiled.study,&compiled.catalog,&compiled.source_bytes).unwrap();
    }

    fn retained_preparation_config() -> ScriptExecutionConfig {
        // Public producer shape fixture; only runtime can authenticate the historical parent.
        let mut config=retained_config();
        let original:Value=serde_json::from_str(include_str!("../../../tests/fixtures/runtime/antenna-standalone-pipeline.json")).unwrap();
        let mut wire=serde_json::to_value(&config.ir).unwrap();
        wire["geometry_assets"]=original["ir"]["geometry_assets"].clone();
        let mut mesh:fullmag_ir::MeshIR=serde_json::from_value(wire["geometry_assets"]["fem_mesh_assets"][0]["mesh"].clone()).unwrap();
        for (index,marker) in mesh.element_markers.iter_mut().enumerate() {*marker=(index%4+1) as u32;}
        wire["geometry_assets"]["fem_mesh_assets"][0]["mesh"]=serde_json::to_value(&mesh).unwrap();
        wire["geometry_assets"]["fem_mesh_assets"][0].as_object_mut().unwrap().remove("mesh_source");
        let task=format!("task-{}",crate::study_artifact_content_sha256(b"run-source\0source-step"));
        let reference=json!({"asset_id":format!("script-file-{}","a".repeat(64)),"content_sha256":"b".repeat(64)});
        let pin=|c:char|format!("sha256:{}",c.to_string().repeat(64));
        let observations=["signal","return"].iter().flat_map(|part|["in","out"].map(move |end|
            json!({"id":format!("{part}-{end}"),"part_id":part,"selector":if end=="in" {"local_u_min"} else {"local_u_max"},
                "faces":[{"face_vertex_ids":[1,2,3],"part_cell_ordinal":0,"bridge_cell_ordinal":1}],"normal_convention":"outward_from_part"}))).collect::<Vec<_>>();
        let parts=["signal","return","inlet","outlet"].iter().enumerate().map(|(index,id)|
            json!({"part_id":id,"element_ordinals":(index..mesh.cell_count()).step_by(4).map(|n|n as u64).collect::<Vec<_>>(),"material_assignment_index":0})).collect::<Vec<_>>();
        wire["current_modules"][0]["gauge"]=json!("zero_mean");
        wire["current_modules"][0]["conservative_current_source"]=json!({"kind":"retained_preparation_asset",
            "schema_version":"retained_preparation_asset_source.v1","object_id":"antenna","geometry_id":"antenna","preparation_asset":reference,
            "historical_prepared_source":{"schema_version":"conservative_current_source.v2","revision":pin('1'),"object_id":"antenna","geometry_id":"antenna",
                "mesh_digest":mesh.mixed_topology_fingerprint_v3().unwrap(),"authored_input_digest":pin('1'),"materials_digest":pin('2'),
                "stable_vertex_ids":(1..=mesh.nodes.len() as u64).collect::<Vec<_>>(),"material_parts":parts,"terminal_observations":observations,
                "closure":{"kind":"closed_geometry","operator_version":"fem_closed_current_geometry.v2","revision":pin('1'),"digest":pin('1'),
                    "source_cuts":[{"id":"cut","translation_m":[0.,0.,0.],"potential_drop_v":1.,"face_pairs":[{"minus_face_vertex_ids":[1,2,3],"plus_face_vertex_ids":[4,5,6]}]}]}},
            "historical_preparation":{"receipt_schema_version":"task_preparation_receipt.v1","run_id":"run-source","step_id":"source-step","task_id":task,
                "preparation_id":format!("prep-{task}"),"input_fingerprint":"c".repeat(64),"plan_fingerprint":pin('3'),"payload_sha256":"d".repeat(64),"receipt_sha256":"e".repeat(64)},
            "authored_closure":{"kind":"closed_geometry","schema_version":"structured_current_closure.v2","closure_id":"loop","source_cuts":[{
                "source_cut_id":"cut","circuit_id":"loop","region":{"object_id":"antenna","region_id":"inlet"},
                "plane":{"coordinate_frame":"object","axis":"x","offset_m":0.,"normal":"positive_axis"},
                "drive":{"kind":"impressed_potential_jump","schema_version":"impressed_potential_jump.v1","drive_id":"drive","potential_jump_V":1.}}]}});
        wire["antenna_port_modes"][0]["schema_version"]=json!("antenna_port_mode.v3");
        wire["antenna_port_modes"][0]["normalization"]=json!({"kind":"source_cut_rt0","source_cut_ref":"cut","orientation":"minus_outward"});
        wire["antenna_field_solve_stages"][0]["retained_current_source"]["task_id"]=json!(task);
        wire["antenna_field_solve_stages"][0]["retained_source_preparation"]=reference;
        config.ir=serde_json::from_value(wire).unwrap();
        config
    }

    fn retained_preparation_execution(config:&ScriptExecutionConfig)->Result<fullmag_ir::MaterializedExecutionRequestIR> {
        let mut profile=physical_profile();profile.profile_id="retained-preparation".into();
        profile.defaults.backend=fullmag_ir::FieldPatch::Value(fullmag_ir::BackendTarget::Fem);
        let precision=serde_json::to_value(config.ir.backend_policy.execution_precision)?;
        let mode=serde_json::to_value(config.ir.validation_profile.execution_mode)?;
        let requested=crate::RequestedExecution {backend:"auto".into(),device:"auto".into(),
            precision:precision.as_str().context("execution precision must serialize as a string")?.into(),
            mode:mode.as_str().context("execution mode must serialize as a string")?.into(),minimum_resources:None}
            .for_problem(&config.ir)?;
        // Match the accepted producer: the profile supplies defaults, the Script layer carries intent.
        let migration=crate::migrate_legacy_live_execution(&config.ir,&requested,
            fullmag_ir::ExecutionOriginKindIR::Script,"script.accepted.authored_execution")
            .map_err(anyhow::Error::msg)?;
        crate::materialize_execution_request(Some(profile),vec![migration.layer]).map_err(anyhow::Error::msg)
    }

    fn compile_retained_preparation(config:ScriptExecutionConfig)->Result<AcceptedScriptPipeline> {
        let execution=retained_preparation_execution(&config)?;
        let profile=execution.profile.context("retained-preparation profile is missing")?;
        compile_accepted_closed_loop_pipeline(config,"retained-preparation-study".into(),0,
            StudyExecutionProfileReference{profile_id:profile.profile_id.clone(),version:profile.version.clone()},execution.layers,capture(),
            |_,_|Ok(profile.clone()),fullmag_ir::configure_project_autosave_policy)
    }

    fn retained_dtq_config() -> ScriptExecutionConfig {
        let mut config = retained_preparation_config();
        let stage = &mut config.ir.antenna_field_solve_stages[0];
        stage.oersted_realization = fullmag_ir::AntennaOerstedRealizationIR::DirectTetraQuadrature;
        stage.surface_field_policy = None;
        config
    }

    #[test]
    fn public_retained_dtq_materializes_compiles_and_replays_v2() {
        let config = retained_dtq_config();
        let materialized = crate::materialize_script_pipeline_with_output_policy_bounded(
            config.clone(), fullmag_ir::configure_project_autosave_policy, 16).unwrap();
        for execution in &materialized.executions {
            let Some(ResolvedScriptStageAction::AntennaRetainedDirectInspection { plan }) = &execution.stage.action
                else { panic!("DTQ must retain its dedicated typed action"); };
            assert_eq!(plan.stage.retained_source_preparation.as_ref(), Some(&plan.preparation_asset));
        }
        let compiled = compile_retained_preparation(config).unwrap();
        for entry in compiled.catalog.entries() {
            let execution:fullmag_ir::MaterializedExecutionRequestIR=serde_json::from_value(
                entry.problem().problem_meta.runtime_metadata["execution_materialization"].clone()).unwrap();
            assert_eq!(execution.requested.backend,fullmag_ir::BackendTarget::Fem);
            assert_eq!(execution.requested.device,fullmag_ir::ExecutionDevice::Cpu);
            assert_eq!(execution.requested.precision,fullmag_ir::ExecutionPrecision::Double);
            assert_eq!(execution.requested.mode,fullmag_ir::ExecutionMode::Strict);
            assert_eq!(execution.origins["device"].kind,fullmag_ir::ExecutionOriginKindIR::Script);
            assert_eq!(entry.problem().problem_meta.runtime_metadata["runtime_selection"]["device"],"cpu");
        }
        let lowered = fullmag_plan::lower_study_plan_with_catalog(&compiled.study, &compiled.catalog).unwrap();
        #[derive(serde::Deserialize)]
        #[serde(tag = "kind", rename_all = "snake_case")]
        enum SurfaceWorkerBackend {
            AntennaRetainedPreparationFieldInspection(fullmag_ir::AntennaRetainedPreparationFieldPlanIR),
        }
        for step in &lowered.steps {
            assert!(step.until_seconds.is_none());
            assert!(step.inputs.is_empty());
            assert_eq!(step.outputs, vec![StudyOutputPort { port_id: "inspection".into(), data_kind: StudyPortDataKind::Artifact }]);
            let backend = &step.execution_plan.as_ref().unwrap().backend_plan;
            let old = serde_json::from_value::<SurfaceWorkerBackend>(serde_json::to_value(backend).unwrap());
            if let Ok(SurfaceWorkerBackend::AntennaRetainedPreparationFieldInspection(surface)) = &old {
                panic!("old surface worker unexpectedly accepted {}", surface.schema_version);
            }
            assert!(old.is_err());
            let fullmag_ir::BackendPlanIR::AntennaRetainedDirectFieldInspection(plan) = backend else { panic!() };
            let replay: fullmag_ir::AntennaRetainedDirectFieldPlanV2 = serde_json::from_slice(&serde_json::to_vec(plan).unwrap()).unwrap();
            assert_eq!(&replay, plan);
            assert!(serde_json::from_value::<fullmag_ir::AntennaRetainedPreparationFieldPlanIR>(serde_json::to_value(plan).unwrap()).is_err());
            assert!(serde_json::from_value::<fullmag_ir::AntennaRetainedCurrentFieldPlanIR>(serde_json::to_value(plan).unwrap()).is_err());
        }
        validate_accepted_script_pipeline_source(&compiled.study, &compiled.catalog, &compiled.source_bytes).unwrap();
    }

    #[test]
    fn retained_dtq_rejects_cross_family_receipt_and_mutated_asset() {
        use fullmag_antenna_artifacts::retained_current::*;
        let compiled = compile_retained_preparation(retained_dtq_config()).unwrap();
        let lowered = fullmag_plan::lower_study_plan_with_catalog(&compiled.study, &compiled.catalog).unwrap();
        let step = &lowered.steps[0];
        let problem = compiled.catalog.entries().iter().find(|entry| entry.step_id() == step.step_id).unwrap().problem();
        let fullmag_ir::BackendPlanIR::AntennaRetainedDirectFieldInspection(operation) = &step.execution_plan.as_ref().unwrap().backend_plan else { panic!() };
        let fullmag_ir::AntennaRetainedCurrentSourceIR::PublishedInspection { project_id, run_id, task_id, attempt_id, ownership_epoch, artifact_id, object_ref } = operation.stage.retained_current_source.as_ref().unwrap();
        let fullmag_ir::CurrentModuleIR::CurrentTransport { definition: Some(definition), .. } = &problem.current_modules[0] else { panic!() };
        let Some(fullmag_ir::ConservativeCurrentSourceIR::RetainedPreparationAsset(source)) = &definition.conservative_current_source else { panic!() };
        let pins = source.historical_preparation.clone();
        // Structural receipt fixture only: durable readers must still authenticate all parent bytes.
        let parent = RetainedCurrentParent {
            owner: ParentInspectionOwner { project_id: project_id.clone(), run_id: run_id.clone(),
                study_step_id: pins.step_id.clone(), native_stage_id: "historical-source".into(), task_id: task_id.clone(),
                attempt_id: attempt_id.clone(), ownership_epoch: ownership_epoch.clone(), artifact_id: artifact_id.clone(),
                package: CasObjectRef { object_ref: object_ref.clone(), byte_count: 4096 },
                package_codec_id: PARENT_CODEC_ID.into(), package_codec_version: PARENT_CODEC_VERSION.into(),
                manifest_schema: PARENT_MANIFEST_SCHEMA.into(), output_manifest_artifact_id: "source-manifest".into(),
                output_manifest: CasObjectRef { object_ref: "b".repeat(64), byte_count: 1024 } },
            source: ParentCurrentDigests { prepared_execution_digest: format!("sha256:{}", "1".repeat(64)),
                accepted_charge_field_digest: format!("sha256:{}", "2".repeat(64)), accepted_source_state_digest: format!("sha256:{}", "3".repeat(64)),
                view_identity_digest: format!("sha256:{}", "4".repeat(64)), current_balance_certificate_digest: format!("sha256:{}", "5".repeat(64)) },
            evidence_capsule: CasObjectRef { object_ref: "c".repeat(64), byte_count: 2048 },
        };
        let mut specification = crate::RunSpecification::new(
            crate::ProjectSnapshot { project_id: crate::ProjectId::parse(project_id.clone()).unwrap(), definition_revision: 1, definition_sha256: "d".repeat(64) },
            crate::StudyReference { study_id: crate::StudyId::parse(compiled.study.study_id.clone()).unwrap(),
                plan_version: fullmag_authoring::STUDY_PLAN_SCHEMA_VERSION_V4.into(), plan_sha256: "e".repeat(64) },
            "f".repeat(64), json!({}), crate::RequestedExecution { backend: "fem".into(), device: "cpu".into(),
                precision: "double".into(), mode: "strict".into(), minimum_resources: Some(crate::RequestedResourceBudget {
                    cpu_millis:1000,memory_bytes:1,gpu_memory_bytes:0,storage_bytes:1 }) });
        specification.immutable_assets.push(crate::ImmutableAssetReference { asset_id: operation.preparation_asset.asset_id.clone(),
            content_sha256: operation.preparation_asset.content_sha256.clone() });
        specification.validate().unwrap();
        specification.requested_execution.validate_problem_resources(problem).unwrap();
        assert_eq!(specification.schema_version,crate::RUN_SPEC_SCHEMA);
        assert_eq!(specification.requested_execution.minimum_resources.as_ref().unwrap().gpu_memory_bytes,0);
        let mut incomplete=specification.clone();incomplete.requested_execution.minimum_resources=None;
        let error=incomplete.validate().unwrap_err().to_string();
        assert!(error.contains("run_spec.v2 requires requested_execution.minimum_resources"),"{error}");
        let error=crate::RetainedAssetFieldPreparationReceipt::ready(
            &incomplete,"task-dtq-child",step,problem,parent.clone(),pins.clone()).err().expect("incomplete v2 must refuse readiness");
        assert!(format!("{error:#}").contains("run_spec.v2 requires requested_execution.minimum_resources"),"{error:#}");
        let receipt = crate::RetainedAssetFieldPreparationReceipt::ready(&specification, "task-dtq-child", step, problem, parent.clone(), pins.clone()).unwrap();
        receipt.validate_for(&specification, "task-dtq-child", step, problem, &parent, &pins).unwrap();
        assert_eq!(receipt.schema_version, crate::RETAINED_ASSET_FIELD_PREPARATION_SCHEMA);
        let binding = receipt.binding().unwrap();
        assert_eq!(binding.schema_version, crate::RETAINED_ASSET_FIELD_PREPARATION_BINDING_SCHEMA);
        let mut surface = problem.clone();
        surface.antenna_field_solve_stages[0].oersted_realization = fullmag_ir::AntennaOerstedRealizationIR::AnalyticRt0Surface;
        surface.antenna_field_solve_stages[0].surface_field_policy = retained_preparation_config().ir.antenna_field_solve_stages[0].surface_field_policy.clone();
        let mut surface_step = step.clone(); surface_step.execution_plan = Some(fullmag_plan::plan(&surface).unwrap());
        assert!(receipt.validate_for(&specification, "task-dtq-child", &surface_step, &surface, &parent, &pins).is_err());
        for mutation in ["asset", "parent", "source", "operation"] {
            let mut changed = receipt.clone();
            match mutation {
                "asset" => changed.plan.preparation_asset.content_sha256 = "0".repeat(64),
                "parent" => changed.plan.parent.owner.attempt_id = "other-attempt".into(),
                "source" => changed.plan.source_preparation.receipt_sha256 = "0".repeat(64),
                "operation" => changed.plan.operation_fingerprint = format!("sha256:{}", "0".repeat(64)),
                _ => unreachable!(),
            }
            changed.plan_fingerprint = crate::preparation::fingerprint_json(&changed.plan).unwrap();
            changed.validate().unwrap();
            assert_ne!(changed.binding().unwrap(), binding);
            assert!(changed.validate_for(&specification, "task-dtq-child", step, problem, &parent, &pins).is_err(), "rehash {mutation}");
        }
        for mutation in ["asset", "parent", "source", "physics", "missing_asset"] {
            let mut altered_problem = problem.clone(); let mut altered_specification = specification.clone();
            let mut altered_parent = parent.clone(); let mut altered_pins = pins.clone();
            match mutation {
                "asset" => altered_specification.immutable_assets[0].content_sha256 = "0".repeat(64),
                "parent" => altered_parent.owner.attempt_id = "other-attempt".into(),
                "source" => altered_pins.receipt_sha256 = "0".repeat(64),
                "physics" => { let fullmag_ir::CurrentModuleIR::CurrentTransport { definition: Some(definition), .. } = &mut altered_problem.current_modules[0] else { panic!() }; definition.materials[0].material.sigma_spm *= 2.0; },
                "missing_asset" => altered_specification.immutable_assets.clear(),
                _ => unreachable!(),
            }
            assert!(receipt.validate_for(&altered_specification, "task-dtq-child", step, &altered_problem, &altered_parent, &altered_pins).is_err(), "{mutation}");
        }
    }

    #[test]
    fn source_preparation_timeout_does_not_submit_or_retry() {
        // Inject failure at the canonical bounded helper boundary; never launch Python or a solver.
        let root = tempfile::tempdir().unwrap();
        let script = root.path().join("source.py"); std::fs::write(&script, b"pass").unwrap();
        let fullmag = root.path().join("fullmag"); std::fs::create_dir(&fullmag).unwrap();
        let mut phases = Vec::new();
        let result = crate::script_source_capture::capture_authored_script(&script, &fullmag,
            &crate::script_source_capture::CaptureOptions::default(), |args, _, _| {
                let phase = &args[args.iter().position(|arg| arg == "--phase").unwrap() + 1]; phases.push(phase.clone());
                if phase == "export" { anyhow::bail!("python_helper_timeout: source preparation deadline"); }
                let inventory = json!({"capture": {"schema_version":"fullmag.script-source-capture.v1", "entry_relative_path":"source/source.py",
                    "records":[{"relative_path":"source/source.py", "asset_id":format!("script-file-{}", crate::study_artifact_content_sha256(b"source/source.py")),
                        "sha256":crate::study_artifact_content_sha256(b"pass"), "byte_count":4, "role":"source", "absolute_path":script}],
                    "runtime":{}, "inventory_sha256":"a".repeat(64)}});
                #[cfg(unix)] let status = { use std::os::unix::process::ExitStatusExt; std::process::ExitStatus::from_raw(0) };
                #[cfg(windows)] let status = { use std::os::windows::process::ExitStatusExt; std::process::ExitStatus::from_raw(0) };
                Ok(std::process::Output { status, stdout: serde_json::to_vec(&inventory).unwrap(), stderr: vec![] })
            });
        let mut accepted_source_available = false;
        let result = result.map(|source| { accepted_source_available = true; source });
        assert!(format!("{:#}", result.err().unwrap()).contains("python_helper_timeout"));
        assert_eq!(phases, ["inventory", "export"]);
        assert!(!accepted_source_available);
        assert_eq!(std::fs::read_dir(root.path()).unwrap().count(), 2);
    }

    #[test]
    fn retained_dtq_never_resolves_fresh_transport() {
        for case in ["asset", "locator", "surface", "gpu", "single", "auto"] {
            let mut config = retained_dtq_config();
            match case {
                "asset" => config.ir.antenna_field_solve_stages[0].retained_source_preparation = None,
                "locator" => config.ir.antenna_field_solve_stages[0].retained_current_source = None,
                "surface" => config.ir.antenna_field_solve_stages[0].surface_field_policy = retained_preparation_config().ir.antenna_field_solve_stages[0].surface_field_policy.clone(),
                "gpu" | "auto" => { config.ir.problem_meta.runtime_metadata.insert("runtime_selection".into(), json!({"device":case})); },
                "single" => {
                    config.ir.backend_policy.execution_precision = fullmag_ir::ExecutionPrecision::Single;
                    config.ir.problem_meta.runtime_metadata.get_mut("runtime_selection").unwrap()["execution_precision"]=json!("single");
                },
                _ => unreachable!(),
            }
            if matches!(case,"gpu"|"single"|"auto") {
                let execution=retained_preparation_execution(&config).unwrap();
                let device=match case {
                    "gpu"=>fullmag_ir::ExecutionDevice::Gpu,
                    "auto"=>fullmag_ir::ExecutionDevice::Auto,
                    _=>fullmag_ir::ExecutionDevice::Cpu,
                };
                let precision=if case=="single" {fullmag_ir::ExecutionPrecision::Single} else {fullmag_ir::ExecutionPrecision::Double};
                assert_eq!(execution.requested.backend,fullmag_ir::BackendTarget::Fem,"{case}");
                assert_eq!(execution.requested.device,device,"{case}");
                assert_eq!(execution.requested.precision,precision,"{case}");
                assert_eq!(execution.requested.mode,fullmag_ir::ExecutionMode::Strict,"{case}");
                for field in ["device","precision"] {
                    assert_eq!(execution.origins[field].kind,fullmag_ir::ExecutionOriginKindIR::Script,"{case}: {field}");
                }
                let bound=crate::bind_materialized_execution(&config.ir,&execution).unwrap();
                assert_eq!(bound.problem_meta.runtime_metadata["runtime_selection"]["device"],serde_json::to_value(device).unwrap(),"{case}");
                assert_eq!(bound.backend_policy.execution_precision,precision,"{case}");
            }
            let error=compile_retained_preparation(config).err().expect(case);
            if matches!(case,"gpu"|"single"|"auto") {
                assert!(format!("{error:#}").contains("retained DTQ requires explicit FEM CPU strict double without fallback"),"{case}: {error:#}");
            }
        }
    }

    #[test]
    fn preparation_asset_public_producer_compiles_and_cold_validates_its_own_family() {
        let config=retained_preparation_config();
        let materialized=crate::materialize_script_pipeline_with_output_policy_bounded(
            config.clone(),fullmag_ir::configure_project_autosave_policy,16).unwrap();
        assert_eq!(materialized.executions.len(),2);
        for execution in &materialized.executions {
            let Some(ResolvedScriptStageAction::AntennaRetainedPreparationInspection{plan})=&execution.stage.action else {panic!("preparation asset must not enter old or fresh transport planning")};
            assert_eq!(plan.preparation_asset,plan.stage.retained_source_preparation.clone().unwrap());
            if let Some(transition)=&execution.stage.incoming_transition {
                assert_eq!(transition.kind,crate::script_stage_contract::StageTransitionKind::AntennaRetainedCurrentInspection);
                assert!(transition.transfer_operator.is_none());
            }
        }
        let compiled=compile_retained_preparation(config).unwrap();
        assert_eq!(compiled.study.steps[1].completion_dependencies,vec![compiled.study.steps[0].step_id.clone()]);
        for step in &compiled.study.steps {
            assert!(matches!(step.kind,StudyStepKind::RetainedCurrentFieldInspection{..}));
            assert!(step.inputs.is_empty());assert!(step.until_seconds.is_none());
            assert_eq!(step.outputs,vec![StudyOutputPort{port_id:"inspection".into(),data_kind:StudyPortDataKind::Artifact}]);
        }
        let lowered=fullmag_plan::lower_study_plan_with_catalog(&compiled.study,&compiled.catalog).unwrap();
        for step in &lowered.steps {assert!(matches!(&step.execution_plan.as_ref().unwrap().backend_plan,
            fullmag_ir::BackendPlanIR::AntennaRetainedPreparationFieldInspection(_)));}
        validate_accepted_script_pipeline_source(&compiled.study,&compiled.catalog,&compiled.source_bytes).unwrap();
    }

    #[test]
    fn preparation_asset_explicit_public_snapshots_preserve_the_new_family() {
        let mut config=retained_preparation_config();
        for id in ["first-inspection","repeat-inspection"] {
            let mut ir=config.ir.clone();ir.problem_meta.runtime_metadata.insert("active_stage_id".into(),json!(id));
            config.stages.push(crate::script_stage_contract::ScriptExecutionStage {ir,default_until_seconds:None,
                entrypoint_kind:"flat_antenna_field_solve".into(),action:Some(crate::script_stage_contract::ScriptExecutionStageAction::AntennaFieldSolve {
                    stage_id:"inspect_antenna".into(),port_mode_id:Some("port".into()),port_mode_ids:vec![]})});
        }
        let compiled=compile_retained_preparation(config).unwrap();
        let lowered=fullmag_plan::lower_study_plan_with_catalog(&compiled.study,&compiled.catalog).unwrap();
        assert_eq!(lowered.steps.len(),2);
        assert!(lowered.steps.iter().all(|step|matches!(&step.execution_plan.as_ref().unwrap().backend_plan,
            fullmag_ir::BackendPlanIR::AntennaRetainedPreparationFieldInspection(_))));
    }

    #[test]
    fn public_producer_refuses_mixed_preparation_families_and_missing_frozen_mesh() {
        for case in ["missing_stage_asset","old_source","mismatched_asset","missing_mesh"] {
            let mut config=retained_preparation_config();
            match case {
                "missing_stage_asset"=>config.ir.antenna_field_solve_stages[0].retained_source_preparation=None,
                "old_source"=>config.ir.current_modules=retained_config().ir.current_modules,
                "mismatched_asset"=>config.ir.antenna_field_solve_stages[0].retained_source_preparation.as_mut().unwrap().content_sha256="0".repeat(64),
                "missing_mesh"=>config.ir.geometry_assets.as_mut().unwrap().fem_mesh_assets[0].mesh=None,
                _=>unreachable!(),
            }
            assert!(compile_retained_preparation(config).is_err(),"{case}");
        }
    }

    #[test]
    fn cold_retained_source_refuses_changed_authored_kind_or_selectors() {
        let compiled=compile_retained();
        for (key,value) in [("stage_kind",json!("export")),("stage_id",json!("other")),("port_mode_id",json!("other"))] {
            let mut source:Value=serde_json::from_slice(&compiled.source_bytes).unwrap();
            let node=&mut source["authored_pipeline"]["nodes"][0]["children"][0];
            if key=="stage_kind" {node[key]=value;} else {node["payload"][key]=value;}
            source["authored_pipeline_sha256"]=json!(fullmag_ir::canonical_ir_json_sha256(&source["authored_pipeline"]).unwrap());
            assert!(validate_accepted_script_pipeline_source(&compiled.study,&compiled.catalog,&serde_json::to_vec(&source).unwrap()).is_err(),"{key}");
        }
    }

    #[test]
    fn cold_retained_source_refuses_unsupported_macro_ownership() {
        let compiled=compile_retained();
        let mut source:Value=serde_json::from_slice(&compiled.source_bytes).unwrap();
        let node=source["authored_pipeline"]["nodes"][0]["children"][0].as_object_mut().unwrap();
        let id=node["id"].as_str().unwrap().to_owned();
        node.insert("node_kind".into(),json!("macro"));
        node.remove("stage_kind");node.remove("payload");
        node.insert("macro_kind".into(),json!("relax_run"));node.insert("config".into(),json!({}));
        for binding in source["nodes"].as_array_mut().unwrap() {
            if binding["authored_step_id"]==id {binding["kind"]=json!("macro");}
        }
        source["authored_pipeline_sha256"]=json!(fullmag_ir::canonical_ir_json_sha256(&source["authored_pipeline"]).unwrap());
        let error=validate_accepted_script_pipeline_source(&compiled.study,&compiled.catalog,&serde_json::to_vec(&source).unwrap()).unwrap_err();
        assert!(error.to_string().contains("authored antenna primitive"),"{error:#}");
    }

    #[test]
    fn cold_retained_source_cannot_drop_an_enabled_antenna_execution() {
        let compiled=compile_retained();let mut study=compiled.study.clone();
        study.steps.remove(0);study.steps[0].completion_dependencies.clear();
        let remaining=study.steps[0].step_id.clone();
        let entries=compiled.catalog.entries().iter().filter(|entry|entry.step_id()==remaining).cloned().collect();
        let catalog=StudyProblemCatalog::from_entries(&study,entries).unwrap();
        let mut source:Value=serde_json::from_slice(&compiled.source_bytes).unwrap();
        source["nodes"][1]["execution_ids"]=json!([]);source["executions"].as_array_mut().unwrap().remove(0);
        let error=validate_accepted_script_pipeline_source(&study,&catalog,&serde_json::to_vec(&source).unwrap()).unwrap_err();
        assert!(error.to_string().contains("enabled antenna primitive must own exactly one"));
    }
}
