//! Accepted CAS results enter the existing artifact field provider, with no extraction or solver execution.
use std::{path::PathBuf, sync::{Arc, atomic::Ordering}};
use fullmag_application::{ProjectId, RunId, RunSpecification};
use sha2::{Digest, Sha256};
use crate::{error::ApiError, types::AppState, schemas::fields::{AcceptedInspectionArtifactOwner, ArtifactFieldOwnerBinding}};
use super::inspection_field_provider::VerifiedInspectionFields;

fn invalid(message: impl ToString) -> ApiError {
    ApiError::conflict_with_code("accepted_inspection_owner_invalid", message.to_string())
}

struct InspectionBinding {
    artifact: AcceptedInspectionArtifactOwner,
    runtime_stage_id: String,
}

fn discover(root: PathBuf, run_id: &str, closure: Option<&str>) -> Result<Vec<InspectionBinding>, ApiError> {
    if !root.exists() { return Ok(Vec::new()); }
    let store = fullmag_session::SessionStore::open_existing(root).map_err(invalid)?;
    let run = RunId::parse(run_id).map_err(invalid)?;
    let (accepted, tasks, imported_artifacts) = if let Some(closure) = closure {
        let Some(evidence) = fullmag_runtime_control::load_imported_study_evidence(&store, &run, closure).map_err(invalid)? else { return Ok(Vec::new()); };
        (evidence.accepted, evidence.catalog, evidence.artifacts)
    } else {
        let Some(intent) = store.read_run_intent(run_id).map_err(invalid)? else { return Ok(Vec::new()); };
        let spec: RunSpecification = serde_json::from_value(intent.specification).map_err(invalid)?;
        if spec.run_id.as_str() != run_id || spec.fingerprint().map_err(invalid)? != intent.payload_sha256 {
            return Err(invalid("accepted run intent identity differs"));
        }
        let accepted = fullmag_runtime_control::load_accepted_study_snapshot(&store, &run, &spec.snapshot.project_id).map_err(invalid)?;
        let tasks = store.read_run_catalog(run_id).map_err(invalid)?.ok_or_else(|| invalid("accepted run catalog absent"))?;
        (accepted, tasks, None)
    };
    let mut has_inspection = false;
    for step in &accepted.study.steps {
        if step.enabled && matches!(&step.kind, fullmag_authoring::StudyStepKind::ClosedLoopInspection { .. }) {
            let task_id = fullmag_session::task_id_for_study_step(run_id, &step.step_id).map_err(invalid)?;
            has_inspection |= tasks.tasks.iter().any(|task| task.task_id == task_id
                && task.lifecycle == fullmag_session::FmsTaskLifecycle::Succeeded);
        }
    }
    if !has_inspection { return Ok(Vec::new()); }
    let artifacts = if closure.is_some() { imported_artifacts } else { store.read_artifact_catalog(run_id).map_err(invalid)? }
        .ok_or_else(|| invalid("accepted artifact catalog absent"))?;
    let mut owners = Vec::new();
    for step in &accepted.study.steps {
        if !step.enabled || !matches!(&step.kind, fullmag_authoring::StudyStepKind::ClosedLoopInspection { .. }) { continue; }
        let task_id = fullmag_session::task_id_for_study_step(run_id, &step.step_id).map_err(invalid)?;
        let Some(task) = tasks.tasks.iter().find(|task| task.task_id == task_id) else { continue; };
        if task.lifecycle != fullmag_session::FmsTaskLifecycle::Succeeded { continue; }
        let attempt = task.attempt_id.as_deref().ok_or_else(|| invalid("successful inspection attempt absent"))?;
        let epoch = task.ownership_epoch.ok_or_else(|| invalid("successful inspection epoch absent"))?;
        let outputs = artifacts.entries.iter().filter(|artifact| artifact.task_id == task_id
            && artifact.attempt_id == attempt && artifact.ownership_epoch == epoch
            && artifact.status == fullmag_session::FmsArtifactStatus::Published
            && artifact.artifact_type == "artifact" && artifact.study_output.is_some()
            && task.artifact_ids.contains(&artifact.artifact_id)).collect::<Vec<_>>();
        if outputs.len() != 1 { return Err(invalid("successful inspection requires one exact published artifact")); }
        let artifact = outputs[0];
        let object = artifact.object_ref.as_ref().ok_or_else(|| invalid("inspection CAS reference absent"))?;
        if object != &artifact.content_sha256 { return Err(invalid("inspection artifact CAS digest differs")); }
        owners.push(InspectionBinding { runtime_stage_id: step.step_id.clone(),
            artifact: AcceptedInspectionArtifactOwner { project_id: accepted.run.specification.snapshot.project_id.as_str().into(),
            task_id, attempt_id: attempt.into(), ownership_epoch: epoch.to_string(),
            artifact_id: artifact.artifact_id.clone(), object_ref: object.clone() } });
        if owners.len() > 64 { return Err(invalid("inspection field discovery exceeds 64 owners; select a bounded run")); }
    }
    Ok(owners)
}

// Imported observations never consult the original accepted store, even if it
// happens to contain the same run. The importer owns this private root and pin.
async fn observation_source(state: &Arc<AppState>, context: &crate::types::CurrentLiveRequestContext)
    -> Result<Option<(PathBuf, Option<String>)>, ApiError> {
    let current = state.current_live_state.read().await;
    let snapshot = current.as_ref().ok_or_else(|| invalid("inspection observation absent"))?;
    crate::ensure_current_live_request_context(snapshot, context, state.current_live_session_epoch.load(Ordering::Acquire))?;
    if snapshot.runtime_status.code != "imported_read_only" {
        return Ok(state.submit_store_root.clone().map(|root| (root, None)));
    }
    let Some(marker) = snapshot.metadata.as_ref().and_then(|metadata| metadata.get("imported_accepted_evidence")) else {
        return Ok(None); // Historical FMS without accepted CAS uses its registered artifacts.
    };
    if marker["run_id"].as_str() != context.run_id.as_deref() { return Err(invalid("imported run pin differs")); }
    let closure = marker["closure_sha256"].as_str().ok_or_else(|| invalid("imported closure pin absent"))?.to_owned();
    let script = PathBuf::from(&snapshot.session.script_path);
    let root = script.parent().and_then(|parent| parent.parent()).ok_or_else(|| invalid("imported root absent"))?;
    if script != root.join("project/main.py") { return Err(invalid("imported source path differs")); }
    let imports = crate::session_persistence::session_store_root(state).join("imports");
    if root.parent() != Some(imports.as_path()) { return Err(invalid("inspection root is not a private session import")); }
    fullmag_session::repository_path::checked_path(&imports,
        root.file_name().and_then(|name| name.to_str()).ok_or_else(|| invalid("import identity absent"))?).map_err(invalid)?;
    Ok(Some((root.to_owned(), Some(closure))))
}

pub(crate) async fn stage_ids(state: &Arc<AppState>) -> Result<Vec<String>, ApiError> {
    let context = crate::capture_current_live_request_context(state).await?;
    let Some((root, closure)) = observation_source(state, &context).await? else { return Ok(Vec::new()); };
    let Some(run) = context.run_id.clone() else { return Ok(Vec::new()); };
    let permit = Arc::clone(&state.quantity_data_plane.accepted_inspection_admission).acquire_owned().await
        .map_err(|_| ApiError::internal("inspection admission closed"))?;
    let owners = tokio::task::spawn_blocking(move || {
        let _permit = permit;
        discover(root, &run, closure.as_deref())
    }).await
        .map_err(|e| ApiError::internal(format!("accepted inspection discovery: {e}")))??;
    crate::validate_current_live_request_context(state, &context).await?;
    Ok(owners.into_iter().map(|owner| owner.runtime_stage_id).collect())
}

pub(super) async fn load(state: &Arc<AppState>, requested_stage: Option<&str>)
    -> Result<Option<Arc<VerifiedInspectionFields>>, ApiError> {
    let context = crate::capture_current_live_request_context(state).await?;
    let Some((root, closure)) = observation_source(state, &context).await? else { return Ok(None); };
    let Some(run_id) = context.run_id.clone() else { return Ok(None); };
    let (epoch, revision, mesh_revision, topology_revision) = {
        let _transition = state.current_live_session_transition.lock().await;
        let current = state.current_live_state.read().await;
        let snapshot = current.as_ref().ok_or_else(|| invalid("inspection observation absent"))?;
        crate::ensure_current_live_request_context(snapshot, &context, state.current_live_session_epoch.load(Ordering::Acquire))?;
        (crate::router_v2::handlers::sessions::current_live_session_epoch(snapshot), snapshot.state_version,
            snapshot.mesh_revision, crate::router_v2::handlers::sessions::status::domain_generation_revision(snapshot))
    };
    let request = requested_stage.map(str::to_owned);
    let session = context.session_id.clone(); let scope = context.request_scope_epoch.clone();
    let discovery_root = root.clone();
    let discovery_run = run_id.clone();
    let discovery_closure = closure.clone();
    let permit = Arc::clone(&state.quantity_data_plane.accepted_inspection_admission).acquire_owned().await
        .map_err(|_| ApiError::internal("inspection admission closed"))?;
    let (binding, permit) = tokio::task::spawn_blocking(move || {
        let mut owners = discover(discovery_root, &discovery_run, discovery_closure.as_deref())?;
        if let Some(stage) = request { owners.retain(|owner| owner.runtime_stage_id == stage); }
        if owners.is_empty() { return Ok((None, permit)); }
        if owners.len() != 1 { return Err(ApiError::conflict_with_code("ambiguous_artifact_field_owner", "select one exact accepted task before reading inspection fields")); }
        Ok((Some(owners.pop().expect("one owner")), permit))
    }).await.map_err(|e| ApiError::internal(format!("accepted inspection discovery: {e}")))??;
    let Some(binding) = binding else { return Ok(None); };
    let data_plane = Arc::clone(&state.quantity_data_plane);
    // Discovery and materialization share admission, including detached metadata.
    let fields = tokio::task::spawn_blocking(move || {
        // The worker retains admission even if its awaiting HTTP request is cancelled.
        let _permit = permit;
        let accepted = binding.artifact;
        let store = fullmag_session::SessionStore::open_existing(root).map_err(invalid)?;
        let project = ProjectId::parse(&accepted.project_id).map_err(invalid)?;
        let run = RunId::parse(&run_id).map_err(invalid)?;
        let ownership_epoch = accepted.ownership_epoch.parse::<u64>().map_err(invalid)?;
        let (evidence, loaded) = if let Some(closure) = closure.as_deref() {
            fullmag_runtime_control::load_imported_inspection(&store, &run, closure,
                &accepted.task_id, &accepted.attempt_id, ownership_epoch, &accepted.object_ref)
        } else {
            fullmag_runtime_control::load_saved_inspection(&store, &project, &run,
                &accepted.task_id, &accepted.attempt_id, ownership_epoch, &accepted.object_ref)
        }.map_err(invalid)?;
        if evidence["artifact_id"].as_str() != Some(accepted.artifact_id.as_str()) { return Err(invalid("inspection artifact changed during cold read")); }
        let text = |path: &[&str]| -> Result<String, ApiError> {
            let mut value = &loaded.metadata; for key in path { value = &value[*key]; }
            value.as_str().filter(|s| !s.trim().is_empty() && s.len() <= 4096 && !s.contains('\0'))
                .map(str::to_owned).ok_or_else(|| invalid("verified inspection owner label absent"))
        };
        let owner = ArtifactFieldOwnerBinding { session_id: session, session_epoch: epoch, request_scope_epoch: scope,
            run_id, runtime_stage_id: binding.runtime_stage_id, authored_stage_id: text(&["stage_id"] )?,
            module_id: text(&["current_transport_id"] )?, object_id: text(&["source_object_id"] )?,
            output_id: text(&["solution_id"] )?, source_digest: text(&["source", "accepted_source_state_digest"] )?,
            content_digest: text(&["content_digest"] )?, observation_mesh_revision: mesh_revision,
            observation_topology_revision: topology_revision, historical_inspection: true,
            native_mesh_identity: text(&["resolved_execution", "mesh_revision"] )?,
            native_topology_identity: text(&["resolved_execution", "topology_revision"] )?, accepted_artifact: Some(accepted) };
        // Fresh durable completion/preparation/CAS validation above is never skipped on a cache hit.
        // Cache only the expensive derived geometry for this exact immutable owner and observation.
        let key_bytes = serde_json::to_vec(&("accepted-inspection-fields-v1", &owner, revision))
            .map_err(|e| ApiError::internal(e.to_string()))?;
        let key = format!("{:x}", Sha256::digest(&key_bytes));
        if let Some(cached) = data_plane.verified_inspection_cache.lock()
            .map_err(|_| ApiError::internal("inspection cache poisoned"))?.get(&key) {
            return Ok(Some(cached));
        }
        let fields = Arc::new(super::inspection_field_provider::from_closed(owner, loaded, revision)?);
        if fields.retained_bytes > 128 * 1024 * 1024 - 4096 {
            return Err(invalid("accepted inspection field views exceed the 128 MiB admission budget"));
        }
        data_plane.verified_inspection_cache.lock().map_err(|_| ApiError::internal("inspection cache poisoned"))?
            .insert(key, Arc::clone(&fields))?;
        Ok(Some(fields))
    }).await.map_err(|e| ApiError::internal(format!("accepted inspection field reader: {e}")))??;
    let _transition = state.current_live_session_transition.lock().await;
    let current = state.current_live_state.read().await;
    let snapshot = current.as_ref().ok_or_else(|| invalid("inspection observation disappeared"))?;
    crate::ensure_current_live_request_context(snapshot, &context,
        state.current_live_session_epoch.load(Ordering::Acquire))?;
    if snapshot.state_version != revision || snapshot.mesh_revision != mesh_revision
        || crate::router_v2::handlers::sessions::status::domain_generation_revision(snapshot) != topology_revision {
        return Err(ApiError::conflict_with_code("inspection_observation_changed", "session observation changed during accepted inspection read"));
    }
    Ok(fields)
}
