//! Public accepted script producer; native execution belongs to the supervised worker.
use anyhow::{bail, Context, Result};
use base64::{engine::general_purpose::STANDARD, Engine};
use clap::Parser;
use fullmag_application::{FileProjectRepository, ImmutableAssetReference, OpaqueAsset, ProjectRepository, ProjectSnapshot, ProjectSource, RequestedExecution, RequestedResourceBudget, RunId, RunIntent, RunSpecification, StudyId, StudyReference};
use fullmag_authoring::StudyExecutionProfileReference;
use serde_json::{json,Value};
use std::collections::BTreeMap;
use std::io::Read;
use std::path::Path;

fn bounded_file(path:&Path, maximum:u64)->Result<Vec<u8>> {
    let file=std::fs::File::open(path)?;
    let metadata=file.metadata()?;
    if !metadata.is_file() || metadata.len()==0 || metadata.len()>maximum { bail!("accepted script input file exceeds its positive byte limit"); }
    let mut bytes=vec![0u8;usize::try_from(metadata.len())?];let mut reader=file.take(maximum.checked_add(1).context("input bound overflow")?);
    reader.read_exact(&mut bytes)?;let mut extra=[0u8;1];
    if reader.read(&mut extra)?!=0 { bail!("accepted script input grew during capture"); }
    Ok(bytes)
}

// Capture carries authored intent. The published profile supplies defaults;
// it must never erase the script's concrete backend/device or typed layers.
fn captured_problem_execution(
    problem: &fullmag_ir::ProblemIR,
    profile: &fullmag_ir::ExecutionProfileIR,
    resources: &RequestedResourceBudget,
) -> Result<(fullmag_ir::MaterializedExecutionRequestIR, RequestedExecution)> {
    fn request(problem: &fullmag_ir::ProblemIR, resources: &RequestedResourceBudget) -> Result<RequestedExecution> {
        let precision = serde_json::to_value(&problem.backend_policy.execution_precision)?;
        let mode = serde_json::to_value(&problem.validation_profile.execution_mode)?;
        RequestedExecution { backend: "auto".into(), device: "auto".into(),
            precision: precision.as_str().context("execution precision must serialize as a string")?.into(),
            mode: mode.as_str().context("execution mode must serialize as a string")?.into(),
            minimum_resources: Some(resources.clone()),
        }.for_problem(problem).map_err(anyhow::Error::new)
    }
    let metadata = &problem.problem_meta.runtime_metadata;
    let snapshot = if metadata.contains_key("execution_profile") || metadata.contains_key("execution_materialization") {
        let bound = fullmag_application::bind_declared_execution(problem, vec![]).map_err(anyhow::Error::msg)?;
        let snapshot: fullmag_ir::MaterializedExecutionRequestIR = serde_json::from_value(
            bound.problem_meta.runtime_metadata.get("execution_materialization")
                .context("declared execution produced no materialization")?.clone())?;
        fullmag_application::validate_execution_materialization(&snapshot).map_err(anyhow::Error::msg)?;
        if snapshot.profile.as_ref() != Some(profile) {
            bail!("execution_intent_conflict: captured script profile differs from the supplied published profile");
        }
        snapshot
    } else {
        if metadata.contains_key("execution_layers") { bail!("execution layers require an authored profile"); }
        let authored = request(problem, resources)?;
        let migration = fullmag_application::migrate_legacy_live_execution(problem, &authored,
            fullmag_ir::ExecutionOriginKindIR::Script, "script.accepted.authored_execution")
            .map_err(anyhow::Error::msg)?;
        // Only the canonical authored layer is imported; the caller's published
        // profile remains the immutable authority for default preferences.
        fullmag_application::materialize_execution_request(Some(profile.clone()), vec![migration.layer])
            .map_err(anyhow::Error::msg)?
    };
    let bound = fullmag_application::bind_materialized_execution(problem, &snapshot).map_err(anyhow::Error::msg)?;
    let requested = request(&bound, resources)?;
    Ok((snapshot, requested))
}

fn captured_execution_layers(
    config: &crate::types::ScriptExecutionConfig,
    profile: &fullmag_ir::ExecutionProfileIR,
    resources: &RequestedResourceBudget,
) -> Result<(Vec<fullmag_ir::ExecutionRequestLayerIR>, RequestedExecution)> {
    let (base, requested) = captured_problem_execution(&config.ir, profile, resources)?;
    for stage in &config.stages {
        let (snapshot, stage_requested) = captured_problem_execution(&stage.ir, profile, resources)?;
        if snapshot.profile != base.profile || snapshot.requested != base.requested
            || snapshot.layers != base.layers || stage_requested != requested {
            bail!("execution_intent_conflict: accepted v4 capture requires one consistent execution intent and layer provenance across base and every stage snapshot; heterogeneous authored intent cannot be rebound");
        }
    }
    Ok((base.layers, requested))
}

pub(crate) fn submit_script(script:&Path, project:&Path, profile:&Path, resources:&Path, idempotency_key:&str, api_url:Option<&str>, submit_only:bool, prepare_only:bool)->Result<Value> {
    let profile:fullmag_ir::ExecutionProfileIR=serde_json::from_slice(&bounded_file(profile,1024*1024)?)?;
    profile.validate().map_err(anyhow::Error::msg)?;
    let resources:RequestedResourceBudget=serde_json::from_slice(&bounded_file(resources,64*1024)?)?;
    let args=crate::args::ScriptCli::try_parse_from([std::ffi::OsString::from("fullmag"),script.as_os_str().to_owned()])?;
    let capture=crate::script_source_capture::capture_authored_script(script,&args)?;
    let opened=FileProjectRepository::new().open(ProjectSource::Bytes {display_name:"accepted-script-project.fms".into(),bytes:bounded_file(project,64*1024*1024)?})?;
    if opened.read_only_reason.is_some() || !opened.migration.can_write { bail!("accepted script requires an immutable writable project archive"); }
    let mut envelope=opened.envelope;
    let identity=fullmag_application::study_artifact_content_sha256(idempotency_key.as_bytes());
    let study_id=format!("script-study-{identity}");
    let profile_ref=StudyExecutionProfileReference {profile_id:profile.profile_id.clone(),version:profile.version.clone()};
    let (execution_layers, requested_execution) = captured_execution_layers(&capture.config, &profile, &resources)?;
    let pipeline=fullmag_application::compile_accepted_closed_loop_pipeline(capture.config,study_id.clone(),0,profile_ref,execution_layers,capture.manifest,
        |id,version|if id==profile.profile_id && version==profile.version {Ok(profile.clone())} else {Err("accepted profile reference changed".into())},
        fullmag_runner::project_storage::configure_project_autosave)?;
    let mut assets=Vec::new();let mut paths=BTreeMap::new();
    for (relative,bytes) in capture.files {
        let asset_id=format!("script-file-{}",fullmag_application::study_artifact_content_sha256(relative.as_bytes()));
        let content_sha256=fullmag_application::study_artifact_content_sha256(&bytes);
        let path=format!("project/assets/accepted-script/files/{relative}");
        if envelope.assets.iter().any(|asset|asset.path()==path) { bail!("captured source asset collides with existing project bytes"); }
        envelope.assets.push(OpaqueAsset::new(&path,bytes,None)?);
        paths.insert(asset_id.clone(),path);assets.push(ImmutableAssetReference {asset_id,content_sha256});
    }
    let source_path="project/assets/accepted-script/pipeline-source.json";
    if envelope.assets.iter().any(|asset|asset.path()==source_path) { bail!("compiled pipeline source collides with existing project asset"); }
    envelope.assets.push(OpaqueAsset::new(source_path,pipeline.source_bytes,None)?);
    paths.insert(pipeline.source_reference.asset_id.clone(),source_path.into());assets.push(pipeline.source_reference);
    assets.sort_by(|left,right|left.asset_id.cmp(&right.asset_id));
    let mut specification=RunSpecification::new(ProjectSnapshot::from_envelope(&envelope)?,StudyReference {study_id:StudyId::parse(study_id)?,plan_version:pipeline.study.schema_version.clone(),plan_sha256:pipeline.study.canonical_sha256()?},
        fullmag_ir::canonical_ir_json_sha256(&serde_json::to_value(&pipeline.catalog)?)?,json!({}),
        requested_execution);
    specification.run_id=RunId::parse(format!("run-{identity}"))?;specification.immutable_assets=assets;
    specification.validate()?;
    let archive=FileProjectRepository::new().encode_archive(&envelope)?;
    if archive.len()>64*1024*1024 { bail!("captured script archive exceeds public transport limit"); }
    let intent=RunIntent::new(idempotency_key,specification);
    intent.validate().context("validate accepted script intent")?;
    let request=json!({"archive_base64":STANDARD.encode(archive),"run_intent":intent,"study_plan":pipeline.study,"study_problem_catalog":pipeline.catalog,"asset_paths":paths});
    // Preparation shares capture, compilation and the full public transport bound.
    if prepare_only {
        crate::accepted_run_transport::validate_submit_request_size(&request)?;
        return Ok(request);
    }
    crate::accepted_run_transport::submit_run_request(&request,api_url.context("accepted script Submit requires --api-url")?,submit_only)
}

#[cfg(test)]
mod execution_capture_tests {
    use super::*;
    fn resources() -> RequestedResourceBudget {
        serde_json::from_value(json!({"cpu_millis": 2000, "memory_bytes": 4294967296u64,
            "storage_bytes": 1073741824u64, "gpu_memory_bytes": 0})).unwrap()
    }
    fn problem() -> fullmag_ir::ProblemIR {
        let mut problem = fullmag_ir::ProblemIR::bootstrap_example();
        problem.backend_policy.requested_backend = fullmag_ir::BackendTarget::Fem;
        problem.problem_meta.runtime_metadata.insert("runtime_selection".into(), json!({"device": "cpu", "gpu_count": 0}));
        problem
    }
    #[test]
    fn legacy_authored_fem_cpu_survives_an_empty_default_profile() {
        let profile = fullmag_application::legacy_live_execution_profile();
        let (snapshot, request) = captured_problem_execution(&problem(), &profile, &resources()).unwrap();
        assert_eq!(snapshot.profile, Some(profile));
        assert_eq!(request.backend, "fem"); assert_eq!(request.device, "cpu");
        assert_eq!(request.precision, "double"); assert_eq!(request.mode, "strict");
        assert_eq!(snapshot.layers.len(), 1);
        assert_eq!(snapshot.layers[0].origin.kind, fullmag_ir::ExecutionOriginKindIR::Script);
        let mut extended = problem(); extended.validation_profile.execution_mode = fullmag_ir::ExecutionMode::Extended;
        let (_, request) = captured_problem_execution(&extended,
            &fullmag_application::legacy_live_execution_profile(), &resources()).unwrap();
        assert_eq!(request.mode, "extended");
    }
    #[test]
    fn typed_profile_layers_are_preserved_and_foreign_profile_is_refused() {
        let profile = fullmag_application::legacy_live_execution_profile();
        let (authored, _) = captured_problem_execution(&problem(), &profile, &resources()).unwrap();
        let mut declared = problem();
        declared.problem_meta.runtime_metadata.insert("execution_profile".into(), serde_json::to_value(&profile).unwrap());
        declared.problem_meta.runtime_metadata.insert("execution_layers".into(), serde_json::to_value(&authored.layers).unwrap());
        let (snapshot, _) = captured_problem_execution(&declared, &profile, &resources()).unwrap();
        assert_eq!(snapshot.layers, authored.layers);
        let materialized = fullmag_application::bind_declared_execution(&declared, vec![]).unwrap();
        assert_eq!(captured_problem_execution(&materialized, &profile, &resources()).unwrap().0, snapshot);
        let mut foreign = profile; foreign.version = "foreign".into();
        assert!(captured_problem_execution(&declared, &foreign, &resources()).is_err());
    }
    #[test]
    fn heterogeneous_stage_intent_is_refused_before_rebinding() {
        let base = problem();
        let mut stage = base.clone(); stage.validation_profile.execution_mode = fullmag_ir::ExecutionMode::Extended;
        let config: crate::types::ScriptExecutionConfig = serde_json::from_value(json!({
            "ir": base, "default_until_seconds": null,
            "stages": [{"ir": stage, "entrypoint_kind": "flat_antenna_field_solve", "default_until_seconds": null}]
        })).unwrap();
        assert!(captured_execution_layers(&config, &fullmag_application::legacy_live_execution_profile(), &resources())
            .err().unwrap().to_string().contains("heterogeneous authored intent"));
    }
}
