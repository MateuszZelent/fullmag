//! Fresh test-local authority and real numerical source; no imported active history.
use super::*;
use anyhow::{Context, Result};
use fullmag_application::{AcceptedPreparationReceipt, ClosedLoopPreparationReceipt, DurableWorkerCoordinator,
    ImmutableAssetReference, ProjectId, ProjectSnapshot, RequestedExecution, RequestedResourceBudget, ResourceBudget, ResourceKind,
    ResourceLease, RunSpecification, StudyId, StudyReference, TaskClaim, TaskId, TaskRecord, WorkerCommand,
    WorkerCoordinator, WorkerEvent};
use fullmag_session::{FmsRunCatalog, FmsTaskCatalogEntry, FmsTaskLifecycle, FmsTaskReadiness};
use serde_json::{json, Value};

const BUNDLE_MAX: usize = 16 * 1024 * 1024;

fn generated_input(owned: &Path, name: &str, document: Option<(&Path, &Path)>) -> Result<(PathBuf, Value)> {
    let generator = PathBuf::from(std::env::var_os("FULLMAG_DTQ_SOURCE_GENERATOR").context("source generator required")?).canonicalize()?;
    let python = std::env::var_os("FULLMAG_DTQ_FIXTURE_PYTHON").context("fixture Python required")?;
    let root = std::env::var_os("FULLMAG_DTQ_CI_SOURCE_ROOT").context("CI source root required")?;
    let destination = owned.join(name);
    let mut command = std::process::Command::new(python);
    command.arg("-B").arg(generator).arg("--source-root").arg(root).arg("--destination").arg(&destination);
    if let Some((asset, locator)) = document { command.arg("--document").arg(asset).arg("--locator").arg(locator); }
    let output = command.output()?;
    anyhow::ensure!(output.status.success(), "canonical source input generation refused: {}", String::from_utf8_lossy(&output.stderr));
    let path = destination.join("input.json");
    let input: Value = serde_json::from_slice(&std::fs::read(path)?)?;
    anyhow::ensure!(input["schema_version"] == "fullmag.dtq.generated_input.v1", "generated input schema differs");
    Ok((destination.canonicalize()?, input))
}

fn accepted(store: &SessionStore, project: &ProjectId, root: &Path, input: &Value, name: &str)
    -> Result<crate::AcceptedStudySnapshot> {
    let config = serde_json::from_value(input["config"].clone())?;
    let profile = fullmag_ir::ExecutionProfileIR { profile_id:"task4-ci-cpu".into(),version:"v1".into(),
        defaults: fullmag_ir::ExecutionRequestPatchIR {
            backend:fullmag_ir::FieldPatch::Value(fullmag_ir::BackendTarget::Fem),
            device:fullmag_ir::FieldPatch::Value(fullmag_ir::ExecutionDevice::Cpu),
            precision:fullmag_ir::FieldPatch::Value(fullmag_ir::ExecutionPrecision::Double),
            mode:fullmag_ir::FieldPatch::Value(fullmag_ir::ExecutionMode::Strict),..Default::default() },..Default::default() };
    let reference = fullmag_authoring::StudyExecutionProfileReference {profile_id:profile.profile_id.clone(),version:profile.version.clone()};
    let compiled = fullmag_application::compile_accepted_closed_loop_pipeline(config, name.into(), 1, reference,
        vec![],input["capture"].clone(),|_,_|Ok(profile.clone()),fullmag_ir::configure_project_autosave_policy)?;
    anyhow::ensure!(compiled.study.steps.len()==1, "fixture must compile exactly one static operation");
    let definition = store.cas().put(&serde_json::to_vec(&input["config"]["ir"])?)?;
    let study = store.cas().put(&compiled.study.canonical_json_bytes()?)?;
    let catalog = store.cas().put(&fullmag_session::canonical_json_bytes(&serde_json::to_value(&compiled.catalog)?))?;
    let mut specification = RunSpecification::new(ProjectSnapshot {project_id:project.clone(),definition_revision:1,definition_sha256:definition.clone()},
        StudyReference {study_id:StudyId::parse(name)?,plan_version:fullmag_authoring::STUDY_PLAN_SCHEMA_VERSION_V4.into(),plan_sha256:study.clone()},
        catalog.clone(),json!({}),RequestedExecution {backend:"fem".into(),device:"cpu".into(),precision:"double".into(),mode:"strict".into(),
            minimum_resources:Some(RequestedResourceBudget {cpu_millis:1000,memory_bytes:(BUNDLE_MAX as u64)*16,
                gpu_memory_bytes:0,storage_bytes:BUNDLE_MAX as u64})});
    let source = store.cas().put(&compiled.source_bytes)?;
    anyhow::ensure!(source==compiled.source_reference.content_sha256, "compiled source CAS differs");
    specification.immutable_assets.push(compiled.source_reference);
    for file in input["files"].as_array().context("captured files absent")? {
        let relative = PathBuf::from(file["path"].as_str().context("captured file path absent")?);
        let bytes = std::fs::read(input_path(root,&relative)?)?;
        let object = store.cas().put(&bytes)?;
        anyhow::ensure!(Some(object.as_str())==file["sha256"].as_str(), "captured file SHA differs");
        specification.immutable_assets.push(ImmutableAssetReference {asset_id:file["asset_id"].as_str().context("capture asset id absent")?.into(),content_sha256:object});
    }
    specification.validate()?;
    let mut intent = fullmag_session::FmsRunIntent::new(specification.run_id.as_str(),"task4-source-only-ci",serde_json::to_value(&specification)?);
    intent.definition_object_ref=Some(definition);intent.study_object_ref=Some(study);intent.study_catalog_object_ref=Some(catalog);
    intent.asset_object_refs=specification.immutable_assets.iter().map(|a|(a.asset_id.clone(),a.content_sha256.clone())).collect();
    store.commit_run_intent(&intent)?;
    let accepted=crate::load_accepted_study_snapshot(store,&specification.run_id,project)?;
    let step=&accepted.lowered.steps[0];
    let task=fullmag_session::task_id_for_study_step(specification.run_id.as_str(),&step.step_id)?;
    store.commit_run_catalog(&FmsRunCatalog {schema_version:fullmag_session::FMS_RUN_CATALOG_SCHEMA.into(),run_id:specification.run_id.as_str().into(),
        revision:1,updated_at:chrono::Utc::now(),tasks:vec![FmsTaskCatalogEntry {task_id:task,
        input_fingerprint:fullmag_application::study_task_input_fingerprint(&specification,step)?,lifecycle:FmsTaskLifecycle::Queued,
        readiness:FmsTaskReadiness::Ready,observation:None,attempt_id:None,ownership_epoch:None,resolved_input_fingerprint:None,
        artifact_ids:vec![],resource_id:None,coordinator_watermark:None,coordinator_genesis:None}]})?;
    Ok(accepted)
}

fn preparation(store:&SessionStore, accepted:&crate::AcceptedStudySnapshot, receipt:AcceptedPreparationReceipt) -> Result<fullmag_session::FmsTaskPreparationReceipt> {
    let step=&accepted.lowered.steps[0];
    let payload=receipt.payload()?;
    let durable=fullmag_session::FmsTaskPreparationReceipt::new(accepted.run.specification.run_id.as_str(),&step.step_id,
        fullmag_application::study_task_input_fingerprint(&accepted.run.specification,step)?,receipt.preparation_id(),receipt.plan_fingerprint(),payload.clone())?;
    store.commit_preparation_receipt(&fullmag_session::FmsPreparationReceipt::new(receipt.preparation_id(),
        accepted.run.specification.run_id.as_str(),receipt.plan_fingerprint(),payload))?;
    store.commit_task_preparation_receipt(&durable)?;
    accepted.read_task_preparation(store,&durable.task_id)?;
    Ok(durable)
}

fn running(store:&SessionStore, accepted:&crate::AcceptedStudySnapshot) -> Result<(TaskClaim,DurableWorkerCoordinator)> {
    let step=&accepted.lowered.steps[0];
    let mut task=TaskRecord::new(accepted.run.specification.run_id.clone(),fullmag_application::study_task_input_fingerprint(&accepted.run.specification,step)?)?;
    task.task_id=TaskId::parse(fullmag_session::task_id_for_study_step(task.run_id.as_str(),&step.step_id)?)?;task.queue()?;
    let offer=ResourceLease::new(format!("task4-cpu-{}",uuid::Uuid::new_v4()),ResourceKind::Cpu,
        ResourceBudget {cpu_millis:1000,memory_bytes:(BUNDLE_MAX as u64)*16,gpu_memory_bytes:0,storage_bytes:BUNDLE_MAX as u64})?;
    let claim=task.claim(offer)?;
    crate::claim::commit_claimed_task_admission_with_frozen_context(store,&task,&claim,&BTreeMap::new(),None,accepted)?;
    let proof=accepted.read_task_preparation(store,claim.task_id.as_str())?;
    let resolved_input=accepted.resolve_task_input_from_store(store,&task,&claim,&step.step_id,BTreeMap::new())?;
    let mut coordinator=DurableWorkerCoordinator::new(WorkerCoordinator::new(task,claim.clone())?);
    crate::commit_coordinator_genesis(store,&coordinator.checkpoint())?;
    coordinator.commit_command(WorkerCommand::Prepare {resolved_input},Some(&proof),|transition|
        crate::commit_transition(store,transition).map(|_|()).map_err(|e|fullmag_application::CoordinatorError::Invalid(e.to_string())))?;
    commit_event(store,&mut coordinator,WorkerEvent::Accepted)?;
    commit_event(store,&mut coordinator,WorkerEvent::Prepared)?;
    coordinator.commit_command(WorkerCommand::Start,None,|transition|crate::commit_transition(store,transition).map(|_|()).map_err(|e|
        fullmag_application::CoordinatorError::Invalid(e.to_string())))?;
    commit_event(store,&mut coordinator,WorkerEvent::Started)?;
    Ok((claim,coordinator))
}

pub(super) fn create(owned:&Path) -> Result<Fixture> {
    anyhow::ensure!(std::env::var("FULLMAG_DTQ_MANAGED_CI").ok().as_deref()==Some("1"),"source-only fixture requires managed CI");
    let project=ProjectId::new();
    let store=SessionStore::open(owned.join("accepted-source"))?;
    let (parent_root,parent_input)=generated_input(owned,"parent-input",None)?;
    let parent=accepted(&store,&project,&parent_root,&parent_input,"task4-parent-study")?;
    let problem=parent.catalog.entries()[0].problem();let lowered=&parent.lowered.steps[0];
    let fullmag_authoring::StudyStepKind::ClosedLoopInspection {stage_id,port_mode_id,output_id}=&parent.study.steps[0].kind
        else {anyhow::bail!("parent compiler did not produce closed-loop inspection");};
    let fullmag_plan::AntennaFieldSolveExecutionPlan::ClosedLoopInspection {input,requested_execution,..}=
        fullmag_plan::validate_closed_loop_operation(problem,stage_id,port_mode_id,output_id)?
        else {anyhow::bail!("parent selected another source family");};
    anyhow::ensure!(input.source_mesh.cell_count()<=4096 && input.field_sampling.positions_xyz_m.len()<=64,
        "source-only fixture is too large; do not raise existing numerical limits");
    let task_id=fullmag_session::task_id_for_study_step(parent.run.specification.run_id.as_str(),&lowered.step_id)?;
    let native=fullmag_runner::prepare_fem_mesh_space(&input.source_mesh,1).map_err(anyhow::Error::msg)?;
    let receipt=ClosedLoopPreparationReceipt::ready(&parent.run.specification,&task_id,lowered,problem,native)?;
    let durable=preparation(&store,&parent,AcceptedPreparationReceipt::ClosedLoop(receipt))?;
    let (claim,mut coordinator)=running(&store,&parent)?;
    let artifacts=fullmag_runner::execute_antenna_closed_loop_inspection_typed(&input,&requested_execution,output_id,None)?;
    let path=format!("antenna/field_solutions/{output_id}/manifest.v2.json");
    let manifest=artifacts.iter().find(|a|a.relative_path==path).context("parent manifest absent")?.bytes.clone();
    let metadata:Value=serde_json::from_slice(&manifest)?;
    fullmag_runner::verify_retained_current_source_content(&manifest,&artifacts,stage_id,output_id,port_mode_id,
        metadata["content_digest"].as_str().context("parent digest absent")?,BUNDLE_MAX)?;
    let payloads=artifacts.into_iter().filter(|a|a.relative_path!=path).map(|a|(a.relative_path,a.bytes)).collect();
    let bytes=fullmag_application::encode_antenna_inspection_bundle(&manifest,&payloads,BUNDLE_MAX)?;
    commit_event(&store,&mut coordinator,WorkerEvent::Completing)?;
    let published=crate::publish_study_outputs(&store,&parent,&claim,&lowered.step_id,&[crate::StudyOutputPayload {
        port_id:"inspection".into(),case_id:"default".into(),codec_id:fullmag_application::ANTENNA_INSPECTION_BUNDLE_CODEC_ID.into(),
        codec_version:fullmag_application::ANTENNA_INSPECTION_BUNDLE_CODEC_VERSION.into(),bytes}],None,None)?;
    commit_event(&store,&mut coordinator,WorkerEvent::Completed {assessment:fullmag_application::ScientificAssessment::Unassessed})?;
    let artifact=published.entries.iter().find(|e|e.task_id==task_id && e.artifact_type=="artifact" && e.study_output.is_some()).context("published parent package absent")?;
    let locator=fullmag_ir::AntennaRetainedCurrentSourceIR::PublishedInspection {project_id:project.as_str().into(),run_id:claim.run_id.as_str().into(),
        task_id:task_id.clone(),attempt_id:claim.attempt_id.as_str().into(),ownership_epoch:claim.ownership_epoch.value().to_string(),
        artifact_id:artifact.artifact_id.clone(),object_ref:artifact.object_ref.clone().context("parent CAS absent")?};
    let evidence=crate::load_saved_retained_current_with_store_evidence(&store,&project,&locator)?;
    for (pin,bytes) in evidence.metadata_objects() {anyhow::ensure!(&store.cas().put(bytes)?==pin,"parent metadata CAS changed");}
    let raw_receipt=std::fs::read(store.root().join(durable.relative_path()?))?;
    let pins=fullmag_ir::AntennaSourcePreparationReceiptPinsIR {receipt_schema_version:durable.schema_version.clone(),run_id:durable.run_id.clone(),
        task_id:durable.task_id.clone(),step_id:durable.step_id.clone(),input_fingerprint:durable.input_fingerprint.clone(),preparation_id:durable.preparation_id.clone(),
        plan_fingerprint:durable.plan_fingerprint.clone(),payload_sha256:durable.payload_sha256.clone(),receipt_sha256:fullmag_session::hex_sha256(&raw_receipt)};
    let document=fullmag_antenna_artifacts::source_preparation::AntennaSourcePreparationAssetDocument {
        schema_version:fullmag_antenna_artifacts::source_preparation::ANTENNA_SOURCE_PREPARATION_ASSET_SCHEMA.into(),
        parent_owner:evidence.parent().owner.clone(),source_pins:evidence.parent().source.clone(),source_mesh:input.source_mesh.clone(),
        source_object_segments:input.source_object_segments.clone(),prepared_source:input.source.clone(),authored_input_preimage:input.authored_input_preimage.clone(),source_preparation:pins.clone()};
    let asset=owned.join("test-source.json");std::fs::write(&asset,document.encode().map_err(|e|anyhow::anyhow!(e.to_string()))?)?;
    let locator_path=owned.join("test-locator.json");std::fs::write(&locator_path,serde_json::to_vec(&locator)?)?;
    let (child_root,child_input)=generated_input(owned,"child-input",Some((&asset,&locator_path)))?;
    let child=accepted(&store,&project,&child_root,&child_input,"task4-child-study")?;
    let problem=child.catalog.entries()[0].problem();let step=&child.lowered.steps[0];
    let stage=&problem.antenna_field_solve_stages[0];
    let plan=fullmag_plan::validate_retained_direct_field_operation(problem,&stage.id,&stage.port_mode_ids[0],&stage.outputs[0].id)?;
    let task_id=fullmag_session::task_id_for_study_step(child.run.specification.run_id.as_str(),&step.step_id)?;
    preparation(&store,&child,AcceptedPreparationReceipt::RetainedAssetField(fullmag_application::RetainedAssetFieldPreparationReceipt::ready(
        &child.run.specification,&task_id,step,problem,evidence.parent().clone(),pins.clone())?))?;
    let (claim,_coordinator)=running(&store,&child)?;
    let mut profile=fullmag_runner::SolverProfileState::new(Default::default());
    let produced=fullmag_runner::execute_retained_direct_field_inspection_observed_typed(problem,evidence.verified_parent(),&plan,
        evidence.capsule_bytes(),None,None,&mut profile,None)?;
    let bytes=fullmag_antenna_artifacts::retained_current::encode_retained_current_field_bundle_v2(&serde_json::to_vec(&produced.manifest)?,&produced.payloads,BUNDLE_MAX)
        .map_err(|e|anyhow::anyhow!(e.to_string()))?;
    let child_object_ref=fullmag_session::hex_sha256(&bytes);std::fs::write(owned.join("candidate.bundle"),bytes)?;
    std::fs::create_dir(owned.join("expected"))?;
    let mut expected_payloads=BTreeMap::new();
    for (key,bytes) in &produced.payloads {let path=PathBuf::from(format!("expected/{key}.bin"));std::fs::write(owned.join(&path),bytes)?;
        expected_payloads.insert(key.clone(),ExpectedPayload {path,sha256:fullmag_session::hex_sha256(bytes)});}
    let capture_path=child_input["capture"]["entry_relative_path"].as_str().context("entry source absent")?;
    let record=child_input["capture"]["records"].as_array().context("capture records absent")?.iter().find(|r|r["relative_path"]==capture_path).context("entry record absent")?;
    let file=child_input["files"].as_array().context("files absent")?.iter().find(|f|f["asset_id"]==record["asset_id"]).context("entry bytes absent")?;
    let script=std::fs::read(input_path(&child_root,&PathBuf::from(file["path"].as_str().context("entry path absent")?))?)?;
    std::fs::copy(child_root.join("source/probe.npz"),owned.join("probe.npz"))?;
    std::fs::write(owned.join("main.py"),&script)?;std::fs::write(owned.join("ui.json"),b"{}")?;std::fs::write(owned.join("scene.json"),b"{}")?;
    SessionStore::open(owned.join("archive-source"))?;
    let mut session=FmsSessionManifest::new(format!("task4-ci-{}",uuid::Uuid::new_v4()),"Task4 CI",SaveProfile::Archive);
    session.format=fullmag_session::FMS_SESSION_FORMAT_V2.into();session.run_refs=vec![format!("runs/{}/run_manifest.json",claim.run_id.as_str())];
    Ok(Fixture {prepublication_store:"accepted-source".into(),archive_source_store:"archive-source".into(),candidate_bundle:"candidate.bundle".into(),expected_payloads,
        project_id:project.as_str().into(),run_id:claim.run_id.as_str().into(),task_id,attempt_id:claim.attempt_id.as_str().into(),ownership_epoch:claim.ownership_epoch.value(),
        child_object_ref,expected_parent:evidence.parent().clone(),expected_source_preparation:pins,expected_sample_carrier:produced.manifest.sample_carrier,
        expected_child_content_digest:produced.manifest.content_digest,expected_run_spec_fingerprint:child.run.specification.fingerprint()?,
        provenance_context:AcceptedProvenanceContext {source_store_binding:format!("sha256:{}",crate::accepted_store::store_binding(store.root()).context("owned store binding absent")?),
            accepted_run_id:claim.run_id.as_str().into(),captured_live_session_id:session.session_id.clone(),captured_live_session_epoch:1,captured_scene_revision:"task4-ci".into()},
        archive_workspace:FmsWorkspaceManifest {workspace_id:session.session_id.clone(),problem_name:"task4-ci".into(),project_ref:"project/".into(),script_ref:"project/main.py".into(),
            script_sha256:fullmag_session::hex_sha256(&script),ui_state_ref:"project/ui_state.json".into(),scene_document_ref:"project/scene_document.json".into(),
            script_builder_ref:None,model_builder_graph_ref:None,asset_index_ref:None},archive_session:session,
        archive_documents:BTreeMap::from([("main.py".into(),"main.py".into()),("ui_state.json".into(),"ui.json".into()),("scene_document.json".into(),"scene.json".into()),("source.json".into(),"test-source.json".into()),("probe.npz".into(),"probe.npz".into())])})
}

pub(super) fn completed_archive(store:&SessionStore, run:&str) -> Result<()> {
    let now=chrono::Utc::now();
    store.commit_run(&fullmag_session::FmsRunManifest {run_id:run.into(),status:fullmag_session::RunStatus::Completed,study_kind:"antenna_field_solve".into(),
        backend:"fem".into(),precision:"double".into(),started_at:now,finished_at:Some(now),total_steps:1,total_time_s:0.,
        plan_ref:None,live_state_ref:None,latest_checkpoint_ref:None,artifact_index_ref:None})?;
    Ok(())
}
