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

pub(crate) fn submit_script(script:&Path, project:&Path, profile:&Path, resources:&Path, idempotency_key:&str, api_url:&str, submit_only:bool)->Result<Value> {
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
    let pipeline=fullmag_application::compile_accepted_closed_loop_pipeline(capture.config,study_id.clone(),0,profile_ref,vec![],capture.manifest,
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
        RequestedExecution {backend:"auto".into(),device:"auto".into(),precision:"double".into(),mode:"strict".into(),minimum_resources:Some(resources)});
    specification.run_id=RunId::parse(format!("run-{identity}"))?;specification.immutable_assets=assets;
    specification.validate()?;
    let archive=FileProjectRepository::new().encode_archive(&envelope)?;
    if archive.len()>64*1024*1024 { bail!("captured script archive exceeds public transport limit"); }
    let request=json!({"archive_base64":STANDARD.encode(archive),"run_intent":RunIntent::new(idempotency_key,specification),"study_plan":pipeline.study,"study_problem_catalog":pipeline.catalog,"asset_paths":paths});
    // The exact JSON including base64, not merely compressed archive size, must fit the public route.
    crate::accepted_run_transport::submit_run_request(&request,api_url,submit_only)
}
