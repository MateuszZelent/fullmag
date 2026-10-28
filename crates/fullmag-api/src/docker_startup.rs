//! Internal Docker workspace startup-script activation.
//!
//! The host launcher admits one immutable source file and sends only its
//! bounded identity here.  This module performs the guest-side admission and
//! publishes a session through the existing live accepted-v2 pipeline.  It
//! never starts a solver and never uses the legacy scratch queue or CLI.

use axum::{extract::State, Json};
use fullmag_authoring::{normalize_scene_document_magnetization_assets, SceneDocument};
use fullmag_ir::OutputDataFormatIR;
use serde::{Deserialize, Serialize};
use serde_json::{json, Value};
use std::fs::{self, OpenOptions};
use std::io::{Read, Write};
use std::path::{Component, Path, PathBuf};
use std::sync::{atomic::Ordering, Arc};

use crate::error::ApiError;
use crate::session::{build_runtime_status_view, default_current_live_state};
use crate::types::{
    AppState, CurrentLiveRequestContext, CurrentLiveSnapshotRequest, RunManifest, SessionManifest,
};

pub(crate) const STARTUP_ENDPOINT: &str = "/v1/internal/live/current/startup";
pub(crate) const REQUEST_SCHEMA: &str = "fullmag.startup-script-activation-request.v1";
pub(crate) const RESPONSE_SCHEMA: &str = "fullmag.startup-script-activation.v1";
pub(crate) const AUTHORIZATION_KIND: &str = "explicit_startup_script";
pub(crate) const CONTAINER_SOURCE_ROOT: &str = "/opt/fullmag/source";
pub(crate) const MAX_SCRIPT_BYTES: usize = 1024 * 1024;
const SCRIPT_OUTPUT_ROOT_ENV: &str = "FULLMAG_SCRIPT_OUTPUT_ROOT";
const SCRIPT_OUTPUT_SOURCE_DIR_ENV: &str = "FULLMAG_SCRIPT_OUTPUT_SOURCE_DIR";
const CONTAINER_RUNTIME_ROOT: &str = "/opt/fullmag";

const STARTUP_METADATA_KEY: &str = "docker_startup";
const MAX_REQUEST_ID_BYTES: usize = 128;
const MAX_STARTUP_ERROR_CHARS: usize = 4096;
const MAX_PREPARATION_ERROR_CODE_CHARS: usize = 128;
const MAX_PREPARATION_ERROR_MESSAGE_CHARS: usize = 1024;
const MAX_PREPARATION_PROGRESS_LABEL_CHARS: usize = 256;
const MAX_PREPARATION_LOG_MESSAGE_CHARS: usize = 2048;
const CANONICAL_PREPARATION_STAGES: [(&str, &str); 9] = [
    ("runtime_startup", "Runtime startup"),
    ("script_materialization", "Script materialization"),
    ("validation", "Validation"),
    ("planning", "Planning"),
    ("domain_preparation", "Domain preparation"),
    ("meshing", "Meshing"),
    ("mesh_postprocessing", "Mesh postprocessing"),
    ("solver_initialization", "Solver initialization"),
    ("ready", "Ready"),
];

#[derive(Debug, Clone, Deserialize, Serialize, PartialEq, Eq)]
#[serde(deny_unknown_fields)]
pub(crate) struct DockerStartupRequest {
    pub schema: String,
    pub authorization: String,
    pub request_id: String,
    pub source: DockerStartupSource,
    pub execution: DockerStartupExecution,
}

#[derive(Debug, Clone, Deserialize, Serialize, PartialEq, Eq)]
#[serde(deny_unknown_fields)]
pub(crate) struct DockerStartupSource {
    pub path: String,
    pub root: String,
    pub relative: String,
    pub sha256: String,
    pub commit: Option<String>,
}

#[derive(Debug, Clone, Deserialize, Serialize, PartialEq, Eq)]
#[serde(deny_unknown_fields)]
pub(crate) struct DockerStartupExecution {
    pub mode: String,
    pub auto_study: bool,
    pub interactive: String,
    pub wait_for_solve: String,
    pub legacy_cli: bool,
}

#[derive(Debug, Clone, Serialize)]
pub(crate) struct DockerStartupResponse {
    pub schema: &'static str,
    pub authorization: &'static str,
    pub request_id: String,
    pub source_sha256: String,
    pub status: &'static str,
    pub execution: DockerStartupExecution,
    pub session_id: String,
    pub run_id: String,
    pub step_ids: Vec<String>,
    pub scene_revision: u64,
    pub runtime_metadata: DockerStartupRuntimeMetadata,
}

#[derive(Debug, Clone, Deserialize, Serialize, PartialEq, Eq)]
pub(crate) struct DockerStartupRuntimeMetadata {
    pub interactive: bool,
    pub wait_for_solve: bool,
}

#[derive(Debug, Clone)]
struct CapturedSource {
    path: PathBuf,
    sha256: String,
    size_bytes: usize,
    bytes: Vec<u8>,
}

struct SourceSnapshot {
    path: PathBuf,
}

impl Drop for SourceSnapshot {
    fn drop(&mut self) {
        let _ = fs::remove_file(&self.path);
    }
}

#[derive(Debug, Clone)]
struct LoadedStartupScene {
    source: CapturedSource,
    scene: SceneDocument,
    runtime: DockerStartupRuntimeMetadata,
    output_storage_binding: Value,
}

/// Activate one explicit Docker startup script through the current live API.
///
/// The route is internal and must be wired by `main.rs` beside the existing
/// `/v1/internal/live/current/*` runner bridge.  A first request is accepted
/// only for an actually empty current workspace.  Later calls are exact
/// request replays; a different request cannot replace the current session.
pub(crate) async fn activate_current_live_startup(
    State(state): State<Arc<AppState>>,
    Json(request): Json<DockerStartupRequest>,
) -> Result<Json<DockerStartupResponse>, ApiError> {
    validate_request(&request)?;
    let transition = state.current_live_session_transition.lock().await;

    if let Some(existing) = state.current_live_state.read().await.as_ref().cloned() {
        let source = capture_source(&request.source)?;
        return replay_or_reject(&request, &source, &existing);
    }

    let loaded = load_startup_scene(&state, &request).await?;
    let source_root = loaded
        .source
        .path
        .parent()
        .map(Path::to_path_buf)
        .ok_or_else(|| ApiError::internal("docker startup source path has no parent"))?;

    let session_id = startup_session_id(&request, &loaded.source);
    let initial_run_id = format!("run-{session_id}");
    let snapshot = build_startup_snapshot(&state, &request, &loaded, &session_id, &initial_run_id)?;
    {
        let mut presentation = state.current_display_presentation.write().await;
        crate::router_v2::handlers::visualization::display::initialize_scene_airbox_visualization(
            &loaded.scene, &mut presentation,
        )?;
    }
    let session_epoch = {
        let mut current = state.current_live_state.write().await;
        let epoch = state
            .current_live_session_epoch
            .fetch_add(1, Ordering::AcqRel)
            .saturating_add(1);
        *current = Some(snapshot);
        epoch
    };
    let context = CurrentLiveRequestContext {
        session_id: session_id.clone(),
        run_id: Some(initial_run_id),
        session_epoch,
        request_scope_epoch: format!("{}:{session_epoch}", state.request_scope_instance_id),
    };

    // Publish the temporary owner before doing any expensive Python/Gmsh
    // preparation.  Status and current-run reads can now observe `activating`
    // while the transition fence is available to other requests.
    if let Err(error) = publish_startup_placeholder(&state, &context).await {
        drop(transition);
        mark_startup_placeholder_failure(&state, &context, &request, &loaded, &error).await;
        return Err(error);
    }
    drop(transition);

    // Preparation is side-effect free with respect to accepted durable state:
    // it does not publish RunIntent, CAS, or the run catalog. Python/Gmsh may
    // still create bounded mesh/cache/staging artifacts in the workspace; the
    // temporary source snapshot is RAII-cleaned and those assets are not an
    // accepted execution by themselves. If this HTTP future is cancelled, the
    // blocking task cannot create a durable run behind the caller's back.
    let prepared = {
        let (progress_sender, mut progress_receiver) =
            tokio::sync::mpsc::channel::<crate::script::PythonHelperProgress>(16);
        let preparation = crate::live_accepted_execution::prepare_live_study_with_asset_root_and_progress(
            &state,
            &context,
            loaded.scene.clone(),
            request.request_id.clone(),
            loaded.source.sha256.clone(),
            false,
            Some(source_root),
            Some(loaded.source.path.clone()),
            progress_sender,
        );
        tokio::pin!(preparation);
        let mut progress_receiver_open = true;
        loop {
            tokio::select! {
                result = &mut preparation => {
                    while let Ok(progress) = progress_receiver.try_recv() {
                        record_startup_helper_progress(&state, &context, progress).await;
                    }
                    break result;
                }
                progress = progress_receiver.recv(), if progress_receiver_open => {
                    match progress {
                        Some(progress) => record_startup_helper_progress(&state, &context, progress).await,
                        None => progress_receiver_open = false,
                    }
                }
            }
        }
    };

    // Reacquire the fence only after preparation.  The exact placeholder
    // session/run/epoch and full SceneDocument content must still match before
    // any durable accepted RunIntent is created.
    let transition = state
        .current_live_session_transition
        .clone()
        .lock_owned()
        .await;
    if let Err(error) = crate::live_accepted_execution::validate_live_scene_for_context(
        &state,
        &context,
        &loaded.scene,
    )
    .await
    {
        // A replacement or scene edit won the fence. Keep the current scene
        // and its authoring metadata; terminalize only this placeholder.
        drop(transition);
        mark_startup_placeholder_failure(&state, &context, &request, &loaded, &error).await;
        return Err(error);
    }
    let prepared = match prepared {
        Ok(prepared) => prepared,
        Err(error) => {
            drop(transition);
            mark_startup_placeholder_failure(&state, &context, &request, &loaded, &error).await;
            return Err(error);
        }
    };

    // Validate the in-memory candidate while holding only a read guard. The
    // durable accepted-run commit below may hash and publish many CAS objects;
    // it must not make readers of the current-live snapshot wait behind a
    // write lock.
    let session_epoch = state.current_live_session_epoch.load(Ordering::Acquire);
    let startup_metadata = json!({
        STARTUP_METADATA_KEY: {
            "request": request,
            "request_id": request.request_id,
            "source_sha256": loaded.source.sha256,
            "source_size_bytes": loaded.source.size_bytes,
            "status": "waiting_for_compute",
            "run_id": &prepared.run_id,
            "step_ids": &prepared.step_ids,
            "scene_revision": loaded.scene.revision,
            "runtime_metadata": loaded.runtime,
            "output_storage_binding": loaded.output_storage_binding,
        }
    });
    let (placeholder_state_version, mut accepted_snapshot) = {
        let current = state.current_live_state.read().await;
        let snapshot = current
            .as_ref()
            .ok_or_else(|| ApiError::not_found("no active local live workspace"))?;
        crate::ensure_current_live_request_context(snapshot, &context, session_epoch)?;
        (snapshot.state_version, snapshot.clone())
    };
    if let Err(error) =
        crate::router_v2::handlers::simulation::commands::apply_accepted_live_study_snapshot(
            &mut accepted_snapshot,
            &context,
            session_epoch,
            &prepared.run_id,
            &prepared.step_ids,
            "waiting_for_compute",
            Some(startup_metadata),
        )
    {
        drop(transition);
        mark_startup_placeholder_failure(&state, &context, &request, &loaded, &error).await;
        return Err(error);
    }

    // Once spawned, this finalizer owns the transition fence through durable
    // commit and publication. A disconnected HTTP caller cannot abandon a
    // committed RunIntent before it is bound to the live snapshot. The commit
    // itself runs on Tokio's blocking pool without the current-live write lock.
    let finalizer_state = Arc::clone(&state);
    tokio::spawn(async move {
        finish_startup_acceptance(
            finalizer_state,
            context,
            request,
            loaded,
            prepared,
            placeholder_state_version,
            &mut accepted_snapshot,
            transition,
        )
        .await
    })
    .await
    .map_err(|error| {
        tracing::error!(error = %error, "startup acceptance finalizer task failed");
        ApiError::internal(format!("startup acceptance finalizer task failed: {error}"))
    })?
}

async fn finish_startup_acceptance(
    state: Arc<AppState>,
    context: CurrentLiveRequestContext,
    request: DockerStartupRequest,
    loaded: LoadedStartupScene,
    prepared: crate::live_accepted_execution::PreparedLiveAcceptedStudy,
    placeholder_state_version: u64,
    accepted_snapshot: &mut crate::types::SessionStateResponse,
    transition: tokio::sync::OwnedMutexGuard<()>,
) -> Result<Json<DockerStartupResponse>, ApiError> {
    let prepared_run_id = prepared.run_id.clone();
    let accepted = match tokio::task::spawn_blocking(move || {
        crate::live_accepted_execution::commit_prepared_live_accepted(&prepared)
    })
    .await
    {
        Ok(Ok(accepted)) => accepted,
        Ok(Err(error)) => {
            // No durable RunIntent was proven. Terminalize only the temporary
            // owner; a failed pre-acceptance path must not invent a run.
            drop(transition);
            mark_startup_placeholder_failure(&state, &context, &request, &loaded, &error).await;
            return Err(error);
        }
        Err(error) => {
            // The blocking task may have crossed the durable boundary before
            // panicking. Leave the owner untouched rather than claiming that
            // the temporary activation failed with no accepted run.
            tracing::error!(
                run_id = %prepared_run_id,
                error = %error,
                "accepted startup commit task ended with an unknown durable outcome"
            );
            drop(transition);
            return Err(ApiError::internal(
                "accepted startup commit task ended with an unknown durable outcome",
            ));
        }
    };
    let session_epoch = state.current_live_session_epoch.load(Ordering::Acquire);
    if accepted.preparation_error.is_none() {
        advance_startup_preparation_progress(accepted_snapshot);
    }
    let accepted_context = CurrentLiveRequestContext {
        session_id: context.session_id.clone(),
        run_id: Some(accepted.run_id.clone()),
        session_epoch: context.session_epoch,
        request_scope_epoch: context.request_scope_epoch.clone(),
    };
    let preparation_error_message = accepted.preparation_error.as_ref().map(|preparation_error| {
        format!("{}: {}", preparation_error.code, preparation_error.message)
    });
    if let Some(preparation_error) = accepted.preparation_error.as_ref() {
        // Keep the accepted run and planned step identity in the candidate
        // snapshot. The existing waiting_for_compute state remains the public
        // run state; the preparation error is explicit in startup metadata.
        if !apply_accepted_preparation_failure_snapshot(
            accepted_snapshot,
            &accepted_context,
            session_epoch,
            preparation_error,
        ) {
            drop(transition);
            return Err(ApiError::conflict(
                "accepted_run_recovery_context_changed_before_publication",
            ));
        }
    }

    // The transition guard is still held, but the write guard was released
    // across the commit. Recheck the exact pre-acceptance owner before binding
    // the candidate, so a future writer that bypasses the transition fence
    // cannot have its newer live state overwritten.
    let mut current = state.current_live_state.write().await;
    let Some(snapshot) = current.as_mut() else {
        tracing::error!(
            run_id = %accepted.run_id,
            "accepted startup run committed after its live workspace disappeared"
        );
        drop(current);
        drop(transition);
        return Err(ApiError::conflict_with_code(
            "accepted_startup_publication_context_changed",
            "accepted run is durable but its live workspace disappeared before publication; execution remains blocked; inspect the runtime diagnostics",
        ));
    };
    if let Err(error) = crate::ensure_current_live_request_context(
        snapshot,
        &context,
        state.current_live_session_epoch.load(Ordering::Acquire),
    ) {
        tracing::error!(
            run_id = %accepted.run_id,
            error = %error,
            "accepted startup run committed after its live request context changed"
        );
        drop(current);
        drop(transition);
        return Err(ApiError::conflict_with_code(
            "accepted_startup_publication_context_changed",
            "accepted run is durable but its live owner changed before publication; execution remains blocked; inspect the runtime diagnostics",
        ));
    }
    if snapshot.scene_document.as_ref() != Some(&loaded.scene)
        || snapshot.run.is_some()
        || snapshot.session.status != "activating"
        || snapshot.state_version != placeholder_state_version
    {
        tracing::error!(
            run_id = %accepted.run_id,
            "accepted startup run committed after its placeholder scene changed"
        );
        drop(current);
        drop(transition);
        return Err(ApiError::conflict_with_code(
            "accepted_startup_publication_context_changed",
            "accepted run is durable but its placeholder scene changed before publication; execution remains blocked; inspect the runtime diagnostics",
        ));
    }
    *snapshot = accepted_snapshot.clone();
    let realtime_snapshot = snapshot.clone();
    drop(current);

    // Realtime publication is deliberately after the synchronous state bind:
    // a cancelled websocket publication cannot leave a durable accepted run
    // without the minimum current-live run/metadata/step_ids view.
    // Preserve event order against session replacement. The helper owns the
    // transition guard through the accepted event publication and releases it
    // only after the event has entered the realtime stream.
    if let Err(error) =
        publish_accepted_startup_realtime(&state, &realtime_snapshot, transition).await
    {
        mark_startup_failure(&state, &accepted_context, &request, &loaded, &error).await;
        return Err(error);
    }
    if let Some(message) = preparation_error_message {
        return Err(ApiError::unprocessable_with_code(
            "accepted_run_recovery_required",
            format!(
                "accepted run `{}` is durable but preparation is incomplete; no solve or retry was started: {message}",
                accepted.run_id
            ),
        ));
    }

    // Only the first dependency-ready stage is the active startup model/mesh.
    // Native preparation may take minutes, so the finalizer drops the session
    // transition before awaiting the preparation receipt publisher.
    let preparation =
        crate::live_scene_preparation::publish_accepted_frontier_preparation(
            &state,
            &accepted_context,
            "startup",
        )
        .await;

    let _transition = state.current_live_session_transition.lock().await;
    crate::validate_current_live_request_context(&state, &accepted_context).await?;
    {
        let current = state.current_live_state.read().await;
        let snapshot = current
            .as_ref()
            .ok_or_else(|| ApiError::not_found("no active local live workspace"))?;
        crate::live_scene_preparation::ensure_preparation_run_is_active(snapshot)?;
    }
    if let Err(error) = preparation {
        if error.code.as_deref() == Some("accepted_preparation_run_stopped") {
            return Err(error);
        }
        mark_startup_failure(&state, &accepted_context, &request, &loaded, &error).await;
        return Err(error);
    }

    if !loaded.runtime.wait_for_solve {
        let released =
            match crate::live_accepted_execution::release_accepted_live_study_with_transition(
                &state,
                &accepted_context,
                &request.request_id,
            )
            .await
            {
                Ok(Some(released)) if released.run_id == accepted.run_id => released,
                Ok(Some(_)) => {
                    let error = ApiError::conflict_with_code(
                        "accepted_startup_release_run_mismatch",
                        "accepted startup release returned a different run identity",
                    );
                    mark_startup_failure(&state, &accepted_context, &request, &loaded, &error)
                        .await;
                    return Err(error);
                }
                Ok(None) => {
                    let error = ApiError::conflict_with_code(
                        "accepted_startup_release_missing",
                        "accepted startup release did not return the accepted run",
                    );
                    mark_startup_failure(&state, &accepted_context, &request, &loaded, &error)
                        .await;
                    return Err(error);
                }
                Err(error) => {
                    mark_startup_failure(&state, &accepted_context, &request, &loaded, &error)
                        .await;
                    return Err(error);
                }
            };
        debug_assert_eq!(released.run_id, accepted.run_id);
    }

    let status = if loaded.runtime.wait_for_solve {
        "waiting_for_solve"
    } else {
        "waiting_for_compute"
    };
    let response = match publish_startup_result(
        &state,
        &accepted_context,
        &request,
        &loaded,
        accepted.run_id.clone(),
        accepted.step_ids.clone(),
        status,
    )
    .await
    {
        Ok(response) => response,
        Err(error) => {
            mark_startup_failure(&state, &accepted_context, &request, &loaded, &error).await;
            return Err(error);
        }
    };
    Ok(Json(response))
}

fn validate_request(request: &DockerStartupRequest) -> Result<(), ApiError> {
    if request.schema != REQUEST_SCHEMA {
        return Err(ApiError::bad_request(
            "docker startup request schema mismatch",
        ));
    }
    if request.authorization != AUTHORIZATION_KIND {
        return Err(ApiError::bad_request(
            "docker startup authorization kind mismatch",
        ));
    }
    if request.request_id.is_empty()
        || request.request_id.len() > MAX_REQUEST_ID_BYTES
        || !request
            .request_id
            .bytes()
            .all(|byte| byte.is_ascii_alphanumeric() || b"._:-".contains(&byte))
    {
        return Err(ApiError::bad_request(
            "docker startup request_id is invalid",
        ));
    }
    validate_source_identity(&request.source)?;
    if request.execution.mode != "canonical_live_v2"
        || !request.execution.auto_study
        || request.execution.interactive != "script_metadata"
        || request.execution.wait_for_solve != "script_metadata"
        || request.execution.legacy_cli
    {
        return Err(ApiError::unprocessable_with_code(
            "docker_startup_execution_policy_rejected",
            "Docker startup requires canonical live-v2 auto-study with script metadata and no legacy CLI",
        ));
    }
    Ok(())
}

fn validate_source_identity(source: &DockerStartupSource) -> Result<(), ApiError> {
    if source.root != CONTAINER_SOURCE_ROOT {
        return Err(ApiError::bad_request(
            "docker startup source root is not the immutable container checkout",
        ));
    }
    if source.path.as_bytes().contains(&0)
        || source.relative.as_bytes().contains(&0)
        || source.relative.contains('\\')
        || source.relative.is_empty()
        || !source.relative.to_ascii_lowercase().ends_with(".py")
    {
        return Err(ApiError::bad_request(
            "docker startup source relative path is invalid",
        ));
    }
    let root = Path::new(CONTAINER_SOURCE_ROOT);
    let path = Path::new(&source.path);
    if !path.is_absolute() || path.strip_prefix(root).is_err() {
        return Err(ApiError::bad_request(
            "docker startup source path is outside the immutable checkout",
        ));
    }
    let relative = Path::new(&source.relative);
    if relative.is_absolute()
        || relative
            .components()
            .any(|component| matches!(component, Component::CurDir | Component::ParentDir))
        || relative
            .components()
            .any(|component| matches!(component, Component::RootDir | Component::Prefix(_)))
        || path != root.join(relative)
    {
        return Err(ApiError::bad_request(
            "docker startup source path and relative path disagree",
        ));
    }
    if !is_lower_hex(source.sha256.as_str(), 64) {
        return Err(ApiError::bad_request(
            "docker startup source sha256 must be lowercase hexadecimal",
        ));
    }
    if let Some(commit) = source.commit.as_deref() {
        if !is_lower_hex(commit, 40) {
            return Err(ApiError::bad_request(
                "docker startup source commit must be a lowercase full SHA-1",
            ));
        }
    }
    Ok(())
}

fn is_lower_hex(value: &str, length: usize) -> bool {
    value.len() == length
        && value
            .bytes()
            .all(|byte| byte.is_ascii_digit() || (b'a'..=b'f').contains(&byte))
}

async fn load_startup_scene(
    state: &Arc<AppState>,
    request: &DockerStartupRequest,
) -> Result<LoadedStartupScene, ApiError> {
    let source = capture_source(&request.source)?;
    let repo_root = state.repo_root.clone();
    let workspace_root = state.current_workspace_root.clone();
    let script_path = source.path.clone();
    let source_snapshot = write_source_snapshot(&workspace_root, &source)?;
    let source_snapshot_path = source_snapshot.path.clone();
    let loaded = tokio::task::spawn_blocking(move || {
        let scene_args = vec![
            "-m".to_string(),
            "fullmag.runtime.helper".to_string(),
            "export-scene-document".to_string(),
            "--script".to_string(),
            script_path.display().to_string(),
            "--source-snapshot".to_string(),
            source_snapshot_path.display().to_string(),
        ];
        let scene_output =
            crate::script::run_python_helper_bounded(&repo_root, &workspace_root, &scene_args)
                .map_err(startup_helper_timeout_rejection)?;
        if !scene_output.status.success() {
            if let Some(message) =
                script_load_rejection(scene_output.status.code(), &scene_output.stdout)
            {
                // The script raised before any live state, RunIntent or catalog
                // entry exists, so this is a known terminal rejection.
                return Err(ApiError::unprocessable_with_code(
                    "validation_error",
                    message,
                ));
            }
            let stderr = String::from_utf8_lossy(&scene_output.stderr);
            return Err(ApiError::internal(format!(
                "python SceneDocument helper failed: {}",
                stderr.trim()
            )));
        }
        let mut scene: SceneDocument =
            serde_json::from_slice(&scene_output.stdout).map_err(|error| {
                ApiError::internal(format!(
                    "failed to deserialize SceneDocument response: {error}"
                ))
            })?;
        normalize_scene_document_magnetization_assets(&mut scene);
        fullmag_authoring::validate_scene_document_for_authoring(&scene)
            .map_err(|error| ApiError::bad_request(error.message))?;

        // Export the script-owned runtime metadata through the same canonical
        // Python loader.  This is a bounded read-only capture; it does not
        // import the script as a solver or start any runtime.
        let helper_args = vec![
            "-m".to_string(),
            "fullmag.runtime.helper".to_string(),
            "export-run-config".to_string(),
            "--script".to_string(),
            script_path.display().to_string(),
            "--source-snapshot".to_string(),
            source_snapshot_path.display().to_string(),
            "--skip-geometry-assets".to_string(),
        ];
        let output =
            crate::script::run_python_helper_bounded(&repo_root, &workspace_root, &helper_args)
                .map_err(startup_helper_timeout_rejection)?;
        if !output.status.success() {
            let stderr = String::from_utf8_lossy(&output.stderr);
            return Err(ApiError::bad_request(format!(
                "startup script runtime metadata helper failed: {}",
                stderr.trim()
            )));
        }
        let config: Value = serde_json::from_slice(&output.stdout).map_err(|error| {
            ApiError::internal(format!(
                "startup script runtime metadata response is invalid: {error}"
            ))
        })?;
        let runtime = runtime_metadata(&config)?;
        Ok::<_, ApiError>((scene, runtime))
    })
    .await
    .map_err(|error| ApiError::internal(format!("startup scene helper task failed: {error}")))??;
    drop(source_snapshot);

    let (scene, runtime) = loaded;
    let output_storage_binding = bind_docker_output_storage_for_source(&scene, &source.path)?;

    Ok(LoadedStartupScene {
        source,
        scene,
        runtime,
        output_storage_binding,
    })
}

/// A bounded helper that hit its deadline was killed and reaped before any
/// live state, RunIntent or catalog entry exists, so the startup request has a
/// known terminal outcome. Any other helper error keeps its classification.
fn startup_helper_timeout_rejection(error: ApiError) -> ApiError {
    if error.code.as_deref() != Some(crate::script::PYTHON_HELPER_TIMEOUT_CODE) {
        return error;
    }
    ApiError::unprocessable_with_code(
        "validation_error",
        format!(
            "startup script loading was not admitted: {}; retry with a new request",
            error.message
        ),
    )
}

/// Read the helper's typed script-load rejection from the last stdout line.
/// Any other non-zero helper exit stays an internal (outcome-unknown) failure.
fn script_load_rejection(exit_code: Option<i32>, stdout: &[u8]) -> Option<String> {
    if exit_code != Some(2) {
        return None;
    }
    let line = stdout
        .split(|byte| *byte == b'\n')
        .rev()
        .find(|line| !line.iter().all(u8::is_ascii_whitespace))?;
    let value = serde_json::from_slice::<Value>(line).ok()?;
    let envelope = value.as_object()?;
    if envelope.len() != 5
        || envelope.get("schema").and_then(Value::as_str)
            != Some("fullmag.script-load-rejection.v1")
        || envelope.get("code").and_then(Value::as_str) != Some("script_load_failed")
    {
        return None;
    }
    let error_type = envelope.get("error_type")?.as_str()?.trim();
    let message = envelope.get("message")?.as_str()?.trim();
    if error_type.is_empty() || message.is_empty() {
        return None;
    }
    let location = match envelope.get("script_line")? {
        Value::Null => String::new(),
        line => format!(" (script line {})", line.as_u64()?),
    };
    Some(format!(
        "startup script failed while loading{location}: {error_type}: {message}"
    ))
}

/// Resolve the Docker output policy for one admitted source path without
/// mutating the authored SceneDocument.  The accepted execution adapter uses
/// the same pure calculation after it has lowered the source into ProblemIR.
/// `FULLMAG_SCRIPT_OUTPUT_ROOT` is only the alias for the one approved writable
/// source directory selected by the host launcher. This function never creates
/// or writes that directory or any of its result children.
pub(crate) fn bind_docker_output_storage_for_source(
    scene: &SceneDocument,
    source_path: &Path,
) -> Result<Value, ApiError> {
    let alias_required = scene
        .study
        .output_storage
        .as_ref()
        .map(|storage| {
            storage
                .output_dir
                .as_deref()
                .map(|path| !Path::new(path).is_absolute())
                .unwrap_or(true)
                || storage
                    .temp_dir
                    .as_deref()
                    .is_some_and(|path| !Path::new(path).is_absolute())
        })
        .unwrap_or(true);
    let (alias_root, selected_source_directory) = if alias_required {
        let value = std::env::var_os(SCRIPT_OUTPUT_ROOT_ENV).ok_or_else(|| {
            ApiError::unprocessable_with_code(
                "docker_startup_output_mapping_required",
                format!(
                    "{SCRIPT_OUTPUT_ROOT_ENV} is required for default or relative script output paths"
                ),
            )
        })?;
        let root = PathBuf::from(value);
        validate_script_output_alias(&root)?;
        let selected = std::env::var_os(SCRIPT_OUTPUT_SOURCE_DIR_ENV).ok_or_else(|| {
            ApiError::unprocessable_with_code(
                "docker_startup_output_mapping_required",
                format!(
                    "{SCRIPT_OUTPUT_SOURCE_DIR_ENV} is required when Docker output mapping is active"
                ),
            )
        })?;
        let selected = PathBuf::from(selected);
        let selected = selected.strip_prefix(Path::new(CONTAINER_SOURCE_ROOT)).map_err(|_| {
            ApiError::unprocessable_with_code(
                "docker_startup_output_mapping_invalid",
                format!(
                    "{SCRIPT_OUTPUT_SOURCE_DIR_ENV} must select a child of {CONTAINER_SOURCE_ROOT}"
                ),
            )
        })?;
        let selected = selected.to_path_buf();
        validate_script_output_directory(&selected)?;
        (Some(root), Some(selected))
    } else {
        (None, None)
    };

    bind_docker_output_storage_with_alias(
        scene,
        source_path,
        alias_root.as_deref(),
        selected_source_directory.as_deref(),
    )
}

fn bind_docker_output_storage_with_alias(
    scene: &SceneDocument,
    source_path: &Path,
    alias_root: Option<&Path>,
    selected_source_directory: Option<&Path>,
) -> Result<Value, ApiError> {
    if let Some(alias_root) = alias_root {
        validate_script_output_alias(alias_root)?;
    }
    if let Some(selected_source_directory) = selected_source_directory {
        validate_script_output_directory(selected_source_directory)?;
    }

    let mut storage = scene.study.output_storage.clone().unwrap_or_default();
    storage.validate().map_err(|errors| {
        ApiError::bad_request(format!(
            "Docker startup OutputStorage policy is invalid: {}",
            errors.join("; ")
        ))
    })?;

    let source_parent = source_path
        .parent()
        .ok_or_else(|| ApiError::bad_request("Docker startup source path has no parent"))?;
    let source_relative = source_path
        .strip_prefix(Path::new(CONTAINER_SOURCE_ROOT))
        .map_err(|_| {
            ApiError::bad_request(
                "Docker startup source path cannot be mapped to the output alias",
            )
        })?;
    if source_relative.components().any(|component| {
        matches!(component, Component::CurDir | Component::ParentDir | Component::Prefix(_))
    }) {
        return Err(ApiError::bad_request(
            "Docker startup source path contains unsafe components",
        ));
    }

    let source_original_dir = source_parent.to_string_lossy().into_owned();
    let requested_output_dir = storage.output_dir.clone();
    let requested_temp_dir = storage.temp_dir.clone();
    let mut mapped_source_dir = source_parent.to_path_buf();
    let mut output_dir = storage.output_dir.clone();
    let mut temp_dir = storage.temp_dir.clone();

    if let Some(alias_root) = alias_root {
        let selected_source_directory = selected_source_directory.ok_or_else(|| {
            ApiError::unprocessable_with_code(
                "docker_startup_output_mapping_invalid",
                "Docker output mapping has no selected source directory",
            )
        })?;
        let source_parent_relative = source_relative.parent().unwrap_or(Path::new(""));
        let output_relative_parent = source_parent_relative
            .strip_prefix(selected_source_directory)
            .map_err(|_| {
                ApiError::unprocessable_with_code(
                    "docker_startup_output_mapping_required",
                    format!(
                        "Docker startup source must be under the selected source directory `{}`",
                        selected_source_directory.display()
                    ),
                )
            })?;
        mapped_source_dir = if output_relative_parent.as_os_str().is_empty() {
            alias_root.to_path_buf()
        } else {
            alias_root.join(output_relative_parent)
        };
        ensure_output_alias_child(&mapped_source_dir, alias_root)?;

        output_dir = Some(match requested_output_dir.as_deref() {
            Some(path) if Path::new(path).is_absolute() => {
                reject_immutable_source_path(Path::new(path), "output_dir")?;
                reject_output_alias_parent(Path::new(path), alias_root, "output_dir")?;
                path.to_owned()
            }
            Some(path) => {
                let mapped = mapped_source_dir.join(path);
                ensure_output_alias_child(&mapped, alias_root)?;
                reject_output_alias_parent(&mapped, alias_root, "output_dir")?;
                mapped.to_string_lossy().into_owned()
            }
            None => mapped_source_dir
                .join(default_script_output_name(source_path, storage.data_format)?)
                .to_string_lossy()
                .into_owned(),
        });
        temp_dir = Some(match requested_temp_dir.as_deref() {
            Some(path) if Path::new(path).is_absolute() => {
                reject_immutable_source_path(Path::new(path), "temp_dir")?;
                reject_output_alias_parent(Path::new(path), alias_root, "temp_dir")?;
                path.to_owned()
            }
            Some(path) => {
                let mapped = mapped_source_dir.join(path);
                ensure_output_alias_child(&mapped, alias_root)?;
                reject_output_alias_parent(&mapped, alias_root, "temp_dir")?;
                mapped.to_string_lossy().into_owned()
            }
            None => mapped_source_dir
                .join(".fullmag-tmp")
                .to_string_lossy()
                .into_owned(),
        });
    } else {
        if let Some(path) = output_dir.as_deref() {
            reject_immutable_source_path(Path::new(path), "output_dir")?;
        }
        if let Some(path) = temp_dir.as_deref() {
            reject_immutable_source_path(Path::new(path), "temp_dir")?;
        }
    }

    storage.output_dir = output_dir.clone();
    storage.temp_dir = temp_dir.clone();
    storage.validate().map_err(|errors| {
        ApiError::unprocessable(format!(
            "Docker startup resolved OutputStorage policy is invalid: {}",
            errors.join("; ")
        ))
    })?;
    let resolved_output_storage = serde_json::to_value(&storage).map_err(|error| {
        ApiError::internal(format!("failed to serialize resolved Docker output policy: {error}"))
    })?;
    Ok(json!({
        "schema": "fullmag.docker_script_output_binding.v1",
        "binding": if alias_root.is_some() { "docker_script_output_alias" } else { "explicit_output_paths" },
        "source_path": source_path.to_string_lossy(),
        "source_original_dir": source_original_dir,
        "source_dir": mapped_source_dir.to_string_lossy(),
        "alias_root": alias_root.map(|path| path.to_string_lossy().into_owned()),
        "selected_source_directory": selected_source_directory
            .map(|path| path.to_string_lossy().into_owned()),
        "requested_output_dir": requested_output_dir,
        "requested_temp_dir": requested_temp_dir,
        "output_storage": resolved_output_storage,
        "output_dir": output_dir,
        "temp_dir": temp_dir,
        "data_format": storage.data_format,
    }))
}

fn validate_script_output_alias(alias_root: &Path) -> Result<(), ApiError> {
    if !alias_root.is_absolute()
        || alias_root.as_os_str().to_string_lossy().is_empty()
        || alias_root
            .components()
            .any(|component| matches!(component, Component::CurDir | Component::ParentDir | Component::Prefix(_)))
    {
        return Err(ApiError::unprocessable_with_code(
            "docker_startup_output_mapping_invalid",
            "FULLMAG_SCRIPT_OUTPUT_ROOT must be an absolute canonical alias path",
        ));
    }
    let runtime_root = Path::new(CONTAINER_RUNTIME_ROOT);
    if alias_root == runtime_root
        || alias_root.strip_prefix(runtime_root).is_err()
        || alias_root == Path::new(CONTAINER_SOURCE_ROOT)
        || alias_root.starts_with(Path::new(CONTAINER_SOURCE_ROOT))
    {
        return Err(ApiError::unprocessable_with_code(
            "docker_startup_output_mapping_invalid",
            "FULLMAG_SCRIPT_OUTPUT_ROOT must be under /opt/fullmag and outside the immutable source checkout",
        ));
    }
    Ok(())
}

fn validate_script_output_directory(directory: &Path) -> Result<(), ApiError> {
    if directory.as_os_str().to_string_lossy().is_empty()
        || directory.is_absolute()
        || directory.components().any(|component| {
            matches!(
                component,
                Component::CurDir
                    | Component::ParentDir
                    | Component::RootDir
                    | Component::Prefix(_)
            )
        })
    {
        return Err(ApiError::unprocessable_with_code(
            "docker_startup_output_mapping_invalid",
            format!(
                "{SCRIPT_OUTPUT_SOURCE_DIR_ENV} must select a nonempty relative source directory"
            ),
        ));
    }
    Ok(())
}

fn ensure_output_alias_child(child: &Path, alias_root: &Path) -> Result<(), ApiError> {
    if child.strip_prefix(alias_root).is_err() {
        return Err(ApiError::unprocessable_with_code(
            "docker_startup_output_mapping_invalid",
            "script output mapping escaped its alias parent",
        ));
    }
    Ok(())
}

fn reject_output_alias_parent(
    path: &Path,
    alias_root: &Path,
    field: &str,
) -> Result<(), ApiError> {
    if path == alias_root {
        return Err(ApiError::unprocessable_with_code(
            "docker_startup_output_mapping_invalid",
            format!(
                "OutputStorage {field} cannot use the output alias parent as a writable result"
            ),
        ));
    }
    Ok(())
}

fn reject_immutable_source_path(path: &Path, field: &str) -> Result<(), ApiError> {
    if path == Path::new(CONTAINER_SOURCE_ROOT) || path.starts_with(Path::new(CONTAINER_SOURCE_ROOT)) {
        return Err(ApiError::unprocessable_with_code(
            "docker_startup_output_mapping_invalid",
            format!("OutputStorage {field} cannot target the immutable source checkout"),
        ));
    }
    Ok(())
}

fn default_script_output_name(source_path: &Path, format: OutputDataFormatIR) -> Result<String, ApiError> {
    let stem = source_path
        .file_stem()
        .and_then(|value| value.to_str())
        .filter(|value| !value.is_empty())
        .ok_or_else(|| ApiError::bad_request("Docker startup source path has no valid script stem"))?;
    Ok(match format {
        OutputDataFormatIR::Zarr => format!("{stem}.zarr"),
        // The existing HDF5 runtime owns the `.results` bundle and writes
        // `.h5` stage files inside it; preserve that container contract here.
        OutputDataFormatIR::Hdf5 => format!("{stem}.results"),
    })
}

fn write_source_snapshot(
    workspace_root: &Path,
    source: &CapturedSource,
) -> Result<SourceSnapshot, ApiError> {
    let path = workspace_root.join(format!(
        ".docker-startup-source-{}.py",
        crate::uuid_v4_hex()
    ));
    let mut options = OpenOptions::new();
    options.write(true).create_new(true);
    #[cfg(unix)]
    {
        use std::os::unix::fs::OpenOptionsExt;
        options.custom_flags(libc::O_CLOEXEC | libc::O_NOFOLLOW);
    }
    #[cfg(windows)]
    {
        use std::os::windows::fs::OpenOptionsExt;
        const FILE_FLAG_OPEN_REPARSE_POINT: u32 = 0x0020_0000;
        options.custom_flags(FILE_FLAG_OPEN_REPARSE_POINT);
    }
    let write_result = (|| {
        let mut file = options.open(&path).map_err(|error| {
            ApiError::internal(format!(
                "failed to create Docker startup source snapshot: {error}"
            ))
        })?;
        file.write_all(&source.bytes).map_err(|error| {
            ApiError::internal(format!(
                "failed to write Docker startup source snapshot: {error}"
            ))
        })?;
        file.sync_all().map_err(|error| {
            ApiError::internal(format!(
                "failed to fsync Docker startup source snapshot: {error}"
            ))
        })?;
        #[cfg(unix)]
        {
            use std::os::unix::fs::PermissionsExt;
            fs::set_permissions(&path, fs::Permissions::from_mode(0o400)).map_err(|error| {
                ApiError::internal(format!(
                    "failed to restrict Docker startup source snapshot: {error}"
                ))
            })?;
        }
        Ok::<(), ApiError>(())
    })();
    if let Err(error) = write_result {
        let _ = fs::remove_file(&path);
        return Err(error);
    }
    Ok(SourceSnapshot { path })
}

fn runtime_metadata(config: &Value) -> Result<DockerStartupRuntimeMetadata, ApiError> {
    let metadata = config
        .pointer("/ir/problem_meta/runtime_metadata")
        .and_then(Value::as_object)
        .ok_or_else(|| {
            ApiError::unprocessable("startup script did not publish canonical runtime metadata")
        })?;
    let interactive = metadata
        .get("interactive_session_requested")
        .and_then(Value::as_bool)
        .unwrap_or(false);
    let wait_for_solve = metadata
        .get("wait_for_solve")
        .and_then(Value::as_bool)
        .unwrap_or(false);
    if wait_for_solve && !interactive {
        return Err(ApiError::unprocessable(
            "startup script requested wait_for_solve without an interactive session",
        ));
    }
    Ok(DockerStartupRuntimeMetadata {
        interactive,
        wait_for_solve,
    })
}

fn capture_source(source: &DockerStartupSource) -> Result<CapturedSource, ApiError> {
    validate_source_identity(source)?;
    let root = Path::new(CONTAINER_SOURCE_ROOT);
    let path = Path::new(&source.path);
    reject_reparse_chain(root, path)?;
    let bytes = read_bounded_source(path)?;
    let text = std::str::from_utf8(&bytes)
        .map_err(|_| ApiError::bad_request("docker startup source must be UTF-8"))?;
    if text.is_empty() {
        return Err(ApiError::bad_request(
            "docker startup source must not be empty",
        ));
    }
    let sha256 = fullmag_session::hex_sha256(&bytes);
    if sha256 != source.sha256 {
        return Err(ApiError::conflict(
            "docker startup source hash differs from host attestation",
        ));
    }
    Ok(CapturedSource {
        path: path.to_path_buf(),
        sha256,
        size_bytes: bytes.len(),
        bytes,
    })
}

fn reject_reparse_chain(root: &Path, leaf: &Path) -> Result<(), ApiError> {
    let mut current = leaf.to_path_buf();
    loop {
        let metadata = fs::symlink_metadata(&current).map_err(|error| {
            ApiError::bad_request(format!(
                "docker startup source path is unavailable: {}: {error}",
                current.display()
            ))
        })?;
        if metadata.file_type().is_symlink() || is_windows_reparse(&metadata) {
            return Err(ApiError::bad_request(
                "docker startup source traverses a symlink or reparse point",
            ));
        }
        if current == root {
            if !metadata.is_dir() {
                return Err(ApiError::bad_request(
                    "docker startup source root is not a directory",
                ));
            }
            return Ok(());
        }
        if !current.starts_with(root) {
            return Err(ApiError::bad_request(
                "docker startup source escaped the immutable root",
            ));
        }
        current.pop();
    }
}

#[cfg(windows)]
fn is_windows_reparse(metadata: &std::fs::Metadata) -> bool {
    use std::os::windows::fs::MetadataExt;
    metadata.file_attributes() & 0x400 != 0
}

#[cfg(not(windows))]
fn is_windows_reparse(_metadata: &std::fs::Metadata) -> bool {
    false
}

fn read_bounded_source(path: &Path) -> Result<Vec<u8>, ApiError> {
    let mut options = OpenOptions::new();
    options.read(true);
    #[cfg(unix)]
    {
        use std::os::unix::fs::OpenOptionsExt;
        options.custom_flags(libc::O_CLOEXEC | libc::O_NOFOLLOW | libc::O_NONBLOCK);
    }
    #[cfg(windows)]
    {
        use std::os::windows::fs::OpenOptionsExt;
        const FILE_FLAG_OPEN_REPARSE_POINT: u32 = 0x0020_0000;
        options.custom_flags(FILE_FLAG_OPEN_REPARSE_POINT);
    }
    let file = options.open(path).map_err(|error| {
        ApiError::bad_request(format!("docker startup source cannot be opened: {error}"))
    })?;
    let metadata = file.metadata().map_err(|error| {
        ApiError::internal(format!(
            "docker startup source handle cannot be inspected: {error}"
        ))
    })?;
    if !metadata.is_file()
        || is_windows_reparse(&metadata)
        || metadata.len() > MAX_SCRIPT_BYTES as u64
    {
        return Err(ApiError::bad_request(
            "docker startup source is not a bounded regular file",
        ));
    }
    let mut bytes = Vec::new();
    file.take((MAX_SCRIPT_BYTES + 1) as u64)
        .read_to_end(&mut bytes)
        .map_err(|error| {
            ApiError::bad_request(format!("docker startup source read failed: {error}"))
        })?;
    if bytes.len() > MAX_SCRIPT_BYTES {
        return Err(ApiError::bad_request(
            "docker startup source exceeds the 1 MiB limit",
        ));
    }
    Ok(bytes)
}

fn build_startup_snapshot(
    state: &AppState,
    request: &DockerStartupRequest,
    loaded: &LoadedStartupScene,
    session_id: &str,
    run_id: &str,
) -> Result<crate::types::SessionStateResponse, ApiError> {
    let mut snapshot = default_current_live_state(&CurrentLiveSnapshotRequest {
        session_id: session_id.to_string(),
        session: None,
        session_status: Some("activating".to_string()),
        metadata: None,
        mesh_workspace: None,
        stage_execution: None,
        simulation_preparation: None,
        run: None,
        live_state: None,
        frozen_spins_runtime_status: None,
        coupled_checkpoint: None,
        latest_scalar_row: None,
        latest_fields: None,
        replace_latest_fields: false,
        field_generation: None,
        preview_fields: None,
        clear_preview_cache: true,
        engine_log: None,
        solver_profile: None,
        fem_mesh: None,
    });
    snapshot.session = SessionManifest {
        session_id: session_id.to_string(),
        run_id: run_id.to_string(),
        status: "activating".to_string(),
        interactive_session_requested: loaded.runtime.interactive,
        script_path: loaded.source.path.display().to_string(),
        problem_name: loaded.scene.scene.name.clone(),
        requested_backend: loaded.scene.study.requested_backend.clone(),
        explicit_selection: loaded.scene.study.requested_backend != "auto"
            || loaded.scene.study.requested_device != "auto",
        authored_requested_device: loaded.scene.study.requested_device.clone(),
        requested_device: loaded.scene.study.requested_device.clone(),
        requested_precision: loaded.scene.study.requested_precision.clone(),
        requested_mode: loaded.scene.study.requested_mode.clone(),
        requested_cpu_threads: loaded.scene.study.requested_cpu_threads,
        execution_mode: loaded.scene.study.requested_mode.clone(),
        precision: loaded.scene.study.requested_precision.clone(),
        resolved_backend: None,
        resolved_device: None,
        resolved_precision: None,
        resolved_mode: None,
        resolved_runtime_family: None,
        resolved_engine_id: None,
        resolved_worker: None,
        resolved_cpu_threads: None,
        resolved_fallback: None,
        fem_crossover_decision: None,
        artifact_dir: state
            .current_workspace_root
            .join("runs")
            .join(run_id)
            .display()
            .to_string(),
        started_at_unix_ms: crate::unix_time_millis_now(),
        finished_at_unix_ms: 0,
        plan_summary: json!({
            "requested_execution": {
                "backend": loaded.scene.study.requested_backend,
                "device": loaded.scene.study.requested_device,
                "precision": loaded.scene.study.requested_precision,
                "mode": loaded.scene.study.requested_mode,
            },
            "startup": {
                "request_id": request.request_id,
                "source_sha256": loaded.source.sha256,
                "interactive": loaded.runtime.interactive,
                "wait_for_solve": loaded.runtime.wait_for_solve,
            },
        }),
    };
    snapshot.scene_document = Some(loaded.scene.clone());
    snapshot.metadata = Some(json!({
        // The placeholder carries the complete request identity from its first
        // publication so an identical replay during preparation can be
        // recognised as the same activation instead of a source change.
        STARTUP_METADATA_KEY: {
            "request": request,
            "request_id": request.request_id,
            "source_sha256": loaded.source.sha256,
            "status": "activating",
            "runtime_metadata": loaded.runtime,
            "output_storage_binding": loaded.output_storage_binding,
            "source_size_bytes": loaded.source.size_bytes,
            "scene_revision": loaded.scene.revision,
        }
    }).into());
    snapshot.runtime_status = build_runtime_status_view("activating");
    snapshot.simulation_preparation_revision = 1;
    snapshot.simulation_preparation = Some(build_startup_preparation_progress(&snapshot));
    Ok(snapshot)
}

fn startup_session_id(request: &DockerStartupRequest, source: &CapturedSource) -> String {
    let identity = format!("{}\0{}", request.request_id, source.sha256);
    format!(
        "docker-startup-{}",
        fullmag_session::hex_sha256(identity.as_bytes())
    )
}

fn replay_or_reject(
    request: &DockerStartupRequest,
    source: &CapturedSource,
    existing: &crate::types::SessionStateResponse,
) -> Result<Json<DockerStartupResponse>, ApiError> {
    let record = existing
        .metadata
        .as_ref()
        .and_then(|metadata| metadata.get(STARTUP_METADATA_KEY))
        .ok_or_else(|| {
            ApiError::conflict_with_code(
                "docker_startup_workspace_not_empty",
                "Docker startup requires an empty current live workspace",
            )
        })?;
    let stored_request = record.get("request").ok_or_else(|| {
        ApiError::conflict("Docker startup owner record is missing its request identity")
    })?;
    let incoming = serde_json::to_value(request)
        .map_err(|error| ApiError::internal(format!("startup request encoding failed: {error}")))?;
    if stored_request != &incoming {
        return Err(ApiError::conflict_with_code(
            "docker_startup_request_conflict",
            "a different Docker startup request already owns the current workspace",
        ));
    }
    let stored_hash = record
        .get("source_sha256")
        .and_then(Value::as_str)
        .unwrap_or_default();
    if stored_hash != source.sha256 {
        return Err(ApiError::conflict(
            "Docker startup source hash changed on replay",
        ));
    }
    let stored_size = record
        .get("source_size_bytes")
        .and_then(Value::as_u64)
        .ok_or_else(|| ApiError::conflict("Docker startup replay has no source size"))?;
    if stored_size != source.size_bytes as u64 {
        return Err(ApiError::conflict(
            "Docker startup source size changed on replay",
        ));
    }
    if record.get("status").and_then(Value::as_str) == Some("activating") {
        // The same request still owns the temporary placeholder: preparation
        // has not committed an accepted RunIntent yet. Report a typed,
        // retryable in-progress state and never start a second activation.
        // HTTP 409 keeps the host helper on its outcome-unknown path.
        if existing.session.session_id != startup_session_id(request, source)
            || existing.run.is_some()
        {
            return Err(ApiError::conflict_with_code(
                "docker_startup_request_conflict",
                "the activating Docker startup placeholder does not match this request identity",
            ));
        }
        return Err(ApiError::conflict_with_code(
            "docker_startup_activation_in_progress",
            format!(
                "Docker startup request `{}` is still preparing in session `{}`; no second run was started",
                request.request_id, existing.session.session_id
            ),
        ));
    }
    let run_id = record
        .get("run_id")
        .and_then(Value::as_str)
        .ok_or_else(|| ApiError::conflict("Docker startup replay has no accepted run identity"))?;
    if record.get("preparation_status").and_then(Value::as_str) == Some("failed") {
        let code = record
            .get("preparation_error_code")
            .and_then(Value::as_str)
            .unwrap_or("accepted_run_recovery_required");
        let message = record
            .get("preparation_error")
            .and_then(Value::as_str)
            .unwrap_or("accepted run preparation requires operator recovery");
        return Err(ApiError::unprocessable_with_code(
            "accepted_run_recovery_required",
            format!(
                "accepted run `{run_id}` remains bound but requires recovery before another compute: {code}: {message}"
            ),
        ));
    }
    let step_ids = record
        .get("step_ids")
        .and_then(Value::as_array)
        .ok_or_else(|| ApiError::conflict("Docker startup replay has no accepted step identity"))?
        .iter()
        .map(|value| {
            value
                .as_str()
                .map(ToOwned::to_owned)
                .ok_or_else(|| ApiError::conflict("Docker startup replay contains an invalid step"))
        })
        .collect::<Result<Vec<_>, _>>()?;
    let status = record
        .get("status")
        .and_then(Value::as_str)
        .ok_or_else(|| ApiError::conflict("Docker startup replay has no status"))?;
    let status = match status {
        "waiting_for_solve" => "waiting_for_solve",
        "waiting_for_compute" => "accepted",
        _ => {
            return Err(ApiError::conflict(
                "Docker startup replay has an unsupported status",
            ))
        }
    };
    let scene_revision = record
        .get("scene_revision")
        .and_then(Value::as_u64)
        .ok_or_else(|| ApiError::conflict("Docker startup replay has no scene revision"))?;
    let runtime_metadata = record
        .get("runtime_metadata")
        .cloned()
        .ok_or_else(|| ApiError::conflict("Docker startup replay has no runtime metadata"))
        .and_then(|value| {
            serde_json::from_value::<DockerStartupRuntimeMetadata>(value).map_err(|error| {
                ApiError::conflict(format!(
                    "Docker startup replay contains invalid runtime metadata: {error}"
                ))
            })
        })?;
    Ok(Json(DockerStartupResponse {
        schema: RESPONSE_SCHEMA,
        authorization: AUTHORIZATION_KIND,
        request_id: request.request_id.clone(),
        source_sha256: source.sha256.clone(),
        status,
        execution: request.execution.clone(),
        session_id: existing.session.session_id.clone(),
        run_id: run_id.to_string(),
        step_ids,
        scene_revision,
        runtime_metadata,
    }))
}

/// Make the temporary startup owner visible before Python/Gmsh preparation.
/// This keeps the browser on a truthful `activating` state while the
/// transition mutex is free for status and replacement/recovery context checks.
/// Startup activation has no accepted run yet, so command admission remains
/// bounded until the accepted snapshot is published.
async fn publish_startup_placeholder(
    state: &Arc<AppState>,
    context: &CurrentLiveRequestContext,
) -> Result<(), ApiError> {
    let snapshot = state
        .current_live_state
        .read()
        .await
        .as_ref()
        .cloned()
        .ok_or_else(|| ApiError::not_found("no active local live workspace"))?;
    crate::ensure_current_live_request_context(
        &snapshot,
        context,
        state.current_live_session_epoch.load(Ordering::Acquire),
    )?;
    let display_revision = state.current_display_selection.read().await.revision;
    let realtime =
        crate::current_live_realtime_state_from_snapshot(state, &snapshot, display_revision).await;
    crate::publish_current_live_realtime_batch_changed(state, &realtime, false, 0).await
}

async fn publish_accepted_startup_realtime(
    state: &Arc<AppState>,
    snapshot: &crate::types::SessionStateResponse,
    transition: tokio::sync::OwnedMutexGuard<()>,
) -> Result<(), ApiError> {
    let display_revision = state.current_display_selection.read().await.revision;
    let realtime_state =
        crate::current_live_realtime_state_from_snapshot(state, snapshot, display_revision).await;
    let result =
        crate::publish_current_live_realtime_batch_changed(state, &realtime_state, false, 0).await;
    drop(transition);
    result
}

/// Metadata members written by the prepared domain publication.
const PREPARED_DOMAIN_METADATA_KEYS: [&str; 2] = ["execution_plan", "artifact_layout"];

async fn publish_startup_result(
    state: &Arc<AppState>,
    context: &CurrentLiveRequestContext,
    request: &DockerStartupRequest,
    loaded: &LoadedStartupScene,
    run_id: String,
    step_ids: Vec<String>,
    status: &'static str,
) -> Result<DockerStartupResponse, ApiError> {
    let mut current = state.current_live_state.write().await;
    let snapshot = current
        .as_mut()
        .ok_or_else(|| ApiError::not_found("no active local live workspace"))?;
    crate::ensure_current_live_request_context(
        snapshot,
        context,
        state.current_live_session_epoch.load(Ordering::Acquire),
    )?;
    let artifact_dir = snapshot.session.artifact_dir.clone();
    snapshot.session.run_id = run_id.clone();
    // The accepted run keeps the durable wait gate, while the current live
    // read model remains command-capable. `waiting_for_solve` is a run-level
    // protocol state; the public runtime lifecycle uses `awaiting_command`.
    let session_status = if status == "waiting_for_solve" {
        "awaiting_command"
    } else {
        status
    };
    snapshot.session.status = session_status.to_string();
    snapshot.session.finished_at_unix_ms = 0;
    snapshot.runtime_status = build_runtime_status_view(session_status);
    snapshot.run = Some(RunManifest {
        run_id: run_id.clone(),
        session_id: context.session_id.clone(),
        status: status.to_string(),
        total_steps: step_ids.len(),
        final_time: None,
        final_e_ex: None,
        final_e_demag: None,
        final_e_ext: None,
        final_e_ani: None,
        final_e_dmi: None,
        final_e_rotated_dmi: None,
        final_e_total: None,
        artifact_dir,
    });
    let mut metadata = json!({
        STARTUP_METADATA_KEY: {
            "request": request,
            "request_id": request.request_id,
            "source_sha256": loaded.source.sha256,
            "source_size_bytes": loaded.source.size_bytes,
            "status": status,
            "run_id": run_id,
            "step_ids": step_ids,
            "scene_revision": loaded.scene.revision,
            "runtime_metadata": loaded.runtime,
            "output_storage_binding": loaded.output_storage_binding,
        }
    });
    // Keep the prepared domain published for this session. An FDM grid
    // exists only as this plan/layout (FEM keeps its mesh separately), so
    // dropping it left FDM sessions with an empty domain: no geometry in the
    // viewport and material fields that never qualified.
    if let (Some(previous), Some(object)) = (snapshot.metadata.as_deref(), metadata.as_object_mut()) {
        for key in PREPARED_DOMAIN_METADATA_KEYS {
            if let Some(value) = previous.get(key) {
                object.insert(key.to_string(), value.clone());
            }
        }
    }
    snapshot.metadata = Some(metadata.into());
    snapshot.state_version = snapshot.state_version.saturating_add(1);
    let response = DockerStartupResponse {
        schema: RESPONSE_SCHEMA,
        authorization: AUTHORIZATION_KIND,
        request_id: request.request_id.clone(),
        source_sha256: loaded.source.sha256.clone(),
        status: if status == "waiting_for_solve" {
            "waiting_for_solve"
        } else {
            "accepted"
        },
        execution: request.execution.clone(),
        session_id: context.session_id.clone(),
        run_id,
        step_ids,
        scene_revision: loaded.scene.revision,
        runtime_metadata: loaded.runtime.clone(),
    };
    let display_revision = state.current_display_selection.read().await.revision;
    let realtime =
        crate::current_live_realtime_state_from_snapshot(state, snapshot, display_revision).await;
    drop(current);
    crate::publish_current_live_realtime_batch_changed(state, &realtime, false, 0).await?;
    Ok(response)
}

async fn mark_startup_placeholder_failure(
    state: &Arc<AppState>,
    context: &CurrentLiveRequestContext,
    request: &DockerStartupRequest,
    loaded: &LoadedStartupScene,
    error: &ApiError,
) {
    let mut current = state.current_live_state.write().await;
    let Some(snapshot) = current.as_mut() else {
        return;
    };
    // Only the temporary pre-acceptance owner may use this path. An accepted
    // durable run is handled by mark_startup_failure, which preserves identity.
    if snapshot.session.status != "activating" || snapshot.run.is_some() {
        return;
    }
    if !apply_startup_failure_snapshot(
        snapshot,
        context,
        state.current_live_session_epoch.load(Ordering::Acquire),
        request,
        loaded,
        error,
    ) {
        return;
    }
    publish_startup_failure(state, current).await;
}

async fn mark_startup_failure(
    state: &Arc<AppState>,
    context: &CurrentLiveRequestContext,
    request: &DockerStartupRequest,
    loaded: &LoadedStartupScene,
    error: &ApiError,
) {
    let mut current = state.current_live_state.write().await;
    let Some(snapshot) = current.as_mut() else {
        return;
    };
    if !apply_startup_failure_snapshot(
        snapshot,
        context,
        state.current_live_session_epoch.load(Ordering::Acquire),
        request,
        loaded,
        error,
    ) {
        return;
    }
    publish_startup_failure(state, current).await;
}

/// Publish an applied startup failure to current-session subscribers after
/// the write lock is released, so the workspace refreshes without polling.
async fn publish_startup_failure(
    state: &Arc<AppState>,
    current: tokio::sync::RwLockWriteGuard<'_, Option<crate::types::SessionStateResponse>>,
) {
    let Some(snapshot) = current.as_ref() else {
        return;
    };
    let display_revision = state.current_display_selection.read().await.revision;
    let realtime =
        crate::current_live_realtime_state_from_snapshot(state, snapshot, display_revision).await;
    drop(current);
    if let Err(publication_error) =
        crate::publish_current_live_realtime_batch_changed(state, &realtime, false, 0).await
    {
        tracing::warn!(
            error = %publication_error,
            "failed to publish startup failure to current-session subscribers"
        );
    }
}

fn bounded_startup_error(message: &str) -> String {
    let mut bounded = message.chars().take(MAX_STARTUP_ERROR_CHARS).collect::<String>();
    if message.chars().count() > MAX_STARTUP_ERROR_CHARS {
        bounded.push_str("...");
    }
    bounded
}

fn bounded_preparation_value(value: &str, max_chars: usize) -> String {
    value.chars().take(max_chars).collect()
}

fn startup_progress_preparation_id(snapshot: &crate::types::SessionStateResponse) -> String {
    format!(
        "docker-startup-progress-{}",
        fullmag_session::hex_sha256(snapshot.session.session_id.as_bytes())
    )
}

async fn record_startup_helper_progress(
    state: &Arc<AppState>,
    context: &CurrentLiveRequestContext,
    progress: crate::script::PythonHelperProgress,
) {
    let session_epoch = state.current_live_session_epoch.load(Ordering::Acquire);
    let mut current = state.current_live_state.write().await;
    let Some(snapshot) = current.as_mut() else {
        return;
    };
    if crate::ensure_current_live_request_context(snapshot, context, session_epoch).is_err() {
        return;
    }
    let expected_id = startup_progress_preparation_id(snapshot);
    let Some(preparation) = snapshot.simulation_preparation.as_mut() else {
        return;
    };
    if preparation.preparation_id != expected_id
        || preparation.status != "running"
        || preparation.active_stage_id.as_deref() != Some("script_materialization")
    {
        return;
    }
    let Some(stage) = preparation
        .stages
        .iter_mut()
        .find(|stage| stage.id == "script_materialization" && stage.status == "active")
    else {
        return;
    };

    let label =
        bounded_preparation_value(&progress.label, MAX_PREPARATION_PROGRESS_LABEL_CHARS);
    let message = bounded_preparation_value(&progress.message, MAX_PREPARATION_LOG_MESSAGE_CHARS);
    if stage.progress_label.as_deref() == Some(label.as_str())
        && stage.detail == message
        && preparation.log_tail.last().is_some_and(|entry| entry.message == message)
    {
        return;
    }
    stage.progress_label = Some(label);
    stage.detail = message.clone();

    let timestamp_unix_ms = u64::try_from(crate::unix_time_millis_now()).unwrap_or(u64::MAX);
    preparation.revision = snapshot
        .simulation_preparation_revision
        .max(preparation.revision)
        .saturating_add(1)
        .max(1);
    preparation
        .log_tail
        .push(crate::types::SimulationPreparationLogEntrySnapshot {
            timestamp_unix_ms,
            level: "info".into(),
            stage_id: "script_materialization".into(),
            message,
        });
    if preparation.log_tail.len() > 128 {
        preparation.log_tail.drain(..preparation.log_tail.len() - 128);
    }
    let revision = preparation.revision;
    snapshot.simulation_preparation_revision = revision;
    drop(current);

    if let Err(error) = crate::publish_current_live_realtime_resource_changes(
        state,
        context.session_id.clone(),
        context.run_id.clone(),
        vec![crate::schemas::realtime::RealtimeResourceChange {
            resource: crate::schemas::realtime::RealtimeResourceName::Simulation,
            revision,
            resource_id: Some("preparation".into()),
            quantity_ids: Vec::new(),
            broad: false,
            domain_generation_id: None,
            recommended_fetch: Some(
                "/v2/sessions/current/simulation/preparation".into(),
            ),
        }],
        true,
        100,
    )
    .await
    {
        tracing::warn!(error = %error, "failed to publish startup mesh progress revision");
    }
}

fn build_startup_preparation_progress(
    snapshot: &crate::types::SessionStateResponse,
) -> crate::types::SimulationPreparationSnapshot {
    let now = u64::try_from(snapshot.session.started_at_unix_ms).unwrap_or(u64::MAX);
    let detail = match snapshot.session.requested_backend.as_str() {
        "fem" => "Materializing the model and Python/Gmsh mesh assets. The FEM mesh is not published yet; no solver has started.",
        "fdm" => "Materializing the model and FDM grid inputs. The grid is not published yet; no solver has started.",
        _ => "Materializing the model and domain inputs. Backend resolution and domain publication are pending; no solver has started.",
    };
    let stages = CANONICAL_PREPARATION_STAGES
        .into_iter()
        .map(|(id, label)| {
            let mut stage = canonical_preparation_stage(id, label);
            if id == "runtime_startup" {
                stage.status = "completed".into();
                stage.detail = "The API received the script and published its authored scene".into();
            } else if id == "script_materialization" {
                stage.status = "active".into();
                stage.detail = detail.into();
                stage.started_at_unix_ms = Some(now);
                stage.progress_label = Some("Materializing model".into());
            }
            stage
        })
        .collect();
    crate::types::SimulationPreparationSnapshot {
        preparation_id: startup_progress_preparation_id(snapshot),
        revision: 1,
        status: "running".into(),
        active_stage_id: Some("script_materialization".into()),
        started_at_unix_ms: now,
        completed_at_unix_ms: None,
        stages,
        log_tail: vec![crate::types::SimulationPreparationLogEntrySnapshot {
            timestamp_unix_ms: now,
            level: "info".into(),
            stage_id: "script_materialization".into(),
            message: detail.into(),
        }],
        failure: None,
    }
}

fn advance_startup_preparation_progress(snapshot: &mut crate::types::SessionStateResponse) {
    let expected_id = startup_progress_preparation_id(snapshot);
    let now = u64::try_from(crate::unix_time_millis_now()).unwrap_or(u64::MAX);
    let detail = match snapshot.session.requested_backend.as_str() {
        "fem" => "The Study is accepted. Waiting for its native FEM mesh preparation receipt; Compute has not started.",
        "fdm" => "The Study is accepted. Waiting for its FDM grid preparation receipt; Compute has not started.",
        _ => "The Study is accepted. Waiting for its resolved domain preparation receipt; Compute has not started.",
    };
    let Some(preparation) = snapshot.simulation_preparation.as_mut() else { return };
    if preparation.preparation_id != expected_id || preparation.status != "running" {
        return;
    }
    for stage in &mut preparation.stages {
        if stage.id == "script_materialization" {
            stage.status = "completed".into();
            stage.completed_at_unix_ms = Some(now);
            stage.duration_ms = stage.started_at_unix_ms.and_then(|start| now.checked_sub(start));
            stage.progress_label = None;
        } else if matches!(stage.id.as_str(), "validation" | "planning") {
            stage.status = "completed".into();
            stage.detail = "Accepted Study validation and planning completed".into();
            stage.completed_at_unix_ms = Some(now);
        } else if stage.id == "domain_preparation" {
            stage.status = "active".into();
            stage.detail = detail.into();
            stage.started_at_unix_ms = Some(now);
            stage.progress_label = Some("Waiting for domain receipt".into());
        }
    }
    preparation.active_stage_id = Some("domain_preparation".into());
    preparation.revision = snapshot.simulation_preparation_revision.max(preparation.revision).saturating_add(1);
    preparation.log_tail.push(crate::types::SimulationPreparationLogEntrySnapshot {
        timestamp_unix_ms: now,
        level: "info".into(),
        stage_id: "domain_preparation".into(),
        message: detail.into(),
    });
    snapshot.simulation_preparation_revision = preparation.revision;
}

/// Rebind only the transient startup diagnostics to the exact selected task.
/// A durable receipt is never replaced or inferred from this progress state.
pub(crate) async fn bind_startup_frontier_progress_under_transition(
    state: &Arc<AppState>,
    context: &CurrentLiveRequestContext,
    run_id: &str,
    step_id: &str,
) -> Result<(), ApiError> {
    let has_durable_receipt = state.current_live_preparation_receipt.read().await.is_some();
    let mut current = state.current_live_state.write().await;
    let snapshot = current.as_mut().ok_or_else(|| ApiError::not_found("no active local live workspace"))?;
    crate::ensure_current_live_request_context(snapshot, context, state.current_live_session_epoch.load(Ordering::Acquire))?;
    crate::live_scene_preparation::ensure_preparation_run_is_active(snapshot)?;
    if snapshot.run.as_ref().map(|run| run.run_id.as_str()) != Some(run_id) {
        return Err(ApiError::conflict("startup preparation progress run changed"));
    }
    let expected_id = startup_progress_preparation_id(snapshot);
    if snapshot.simulation_preparation.as_ref().is_none_or(|preparation| {
        preparation.preparation_id != expected_id || preparation.status != "running"
    }) {
        return Ok(());
    }
    if has_durable_receipt {
        return Err(ApiError::conflict("transient startup progress has a durable preparation anchor"));
    }
    let task_id = fullmag_session::task_id_for_study_step(run_id, step_id)
        .map_err(|error| ApiError::bad_request(format!("startup preparation step is invalid: {error}")))?;
    let preparation = snapshot.simulation_preparation.as_mut().expect("transient progress checked above");
    preparation.preparation_id = format!("prep-{task_id}");
    preparation.revision = snapshot.simulation_preparation_revision.max(preparation.revision).saturating_add(1);
    snapshot.simulation_preparation_revision = preparation.revision;
    let realtime_snapshot = snapshot.clone();
    drop(current);
    let display_revision = state.current_display_selection.read().await.revision;
    let realtime = crate::current_live_realtime_state_from_snapshot(state, &realtime_snapshot, display_revision).await;
    crate::publish_current_live_realtime_batch_changed(state, &realtime, false, 0).await
}

fn startup_failure_preparation_id(snapshot: &crate::types::SessionStateResponse) -> String {
    let identity = format!("{}\0{}", snapshot.session.session_id, snapshot.session.run_id);
    format!(
        "docker-startup-prep-{}",
        fullmag_session::hex_sha256(identity.as_bytes())
    )
}

fn canonical_preparation_stage_index(id: &str) -> Option<usize> {
    CANONICAL_PREPARATION_STAGES
        .iter()
        .position(|(canonical_id, _)| *canonical_id == id)
}

fn canonical_preparation_stage(id: &str, label: &str) -> crate::types::SimulationPreparationStageSnapshot {
    crate::types::SimulationPreparationStageSnapshot {
        id: id.to_string(),
        label: label.to_string(),
        detail: String::new(),
        status: "pending".to_string(),
        started_at_unix_ms: None,
        completed_at_unix_ms: None,
        duration_ms: None,
        clock_adjustment: None,
        progress_percent: None,
        progress_label: None,
    }
}

fn has_canonical_preparation_stage_order(
    stages: &[crate::types::SimulationPreparationStageSnapshot],
) -> bool {
    stages.len() == CANONICAL_PREPARATION_STAGES.len()
        && stages
            .iter()
            .map(|stage| stage.id.as_str())
            .eq(CANONICAL_PREPARATION_STAGES.iter().map(|(id, _)| *id))
}

fn normalize_preparation_stages(
    stages: &[crate::types::SimulationPreparationStageSnapshot],
) -> Vec<crate::types::SimulationPreparationStageSnapshot> {
    if has_canonical_preparation_stage_order(stages) {
        return stages.to_vec();
    }
    let mut normalized = CANONICAL_PREPARATION_STAGES
        .iter()
        .map(|(id, label)| canonical_preparation_stage(id, label))
        .collect::<Vec<_>>();
    let mut populated = [false; CANONICAL_PREPARATION_STAGES.len()];
    let mut unknown_stage = None;
    for stage in stages {
        if let Some(index) = canonical_preparation_stage_index(&stage.id) {
            if !populated[index] {
                normalized[index] = stage.clone();
                populated[index] = true;
            }
        } else if unknown_stage.is_none() {
            unknown_stage = Some(stage.clone());
        }
    }
    if !populated[0] {
        if let Some(mut stage) = unknown_stage {
            stage.id = "runtime_startup".to_string();
            normalized[0] = stage;
        }
    }
    normalized
}

fn canonical_or_runtime_stage_id(id: &str) -> String {
    if canonical_preparation_stage_index(id).is_some() {
        id.to_string()
    } else {
        "runtime_startup".to_string()
    }
}

fn normalize_preparation_diagnostics(
    preparation: &mut crate::types::SimulationPreparationSnapshot,
) -> bool {
    let mut changed = false;
    if !has_canonical_preparation_stage_order(&preparation.stages) {
        preparation.stages = normalize_preparation_stages(&preparation.stages);
        changed = true;
    }
    for entry in &mut preparation.log_tail {
        let stage_id = canonical_or_runtime_stage_id(&entry.stage_id);
        if stage_id != entry.stage_id {
            entry.stage_id = stage_id;
            changed = true;
        }
    }
    if let Some(failure) = preparation.failure.as_mut() {
        let stage_id = canonical_or_runtime_stage_id(&failure.stage_id);
        if stage_id != failure.stage_id {
            failure.stage_id = stage_id;
            changed = true;
        }
    }
    changed
}

fn build_failed_preparation_snapshot(
    preparation_id: String,
    revision: u64,
    timestamp_unix_ms: u64,
    error_code: &str,
    error_message: &str,
) -> crate::types::SimulationPreparationSnapshot {
    let error_code = bounded_preparation_value(error_code, MAX_PREPARATION_ERROR_CODE_CHARS);
    let summary = bounded_preparation_value(
        error_message,
        MAX_PREPARATION_ERROR_MESSAGE_CHARS,
    );
    let stage_id = "runtime_startup";
    let stages = CANONICAL_PREPARATION_STAGES
        .into_iter()
        .map(|(id, label)| {
            let failed = id == stage_id;
            let mut stage = canonical_preparation_stage(id, label);
            if failed {
                stage.detail = summary.clone();
                stage.status = "failed".to_string();
                stage.started_at_unix_ms = Some(timestamp_unix_ms);
                stage.completed_at_unix_ms = Some(timestamp_unix_ms);
                stage.duration_ms = Some(0);
            }
            stage
        })
        .collect();
    crate::types::SimulationPreparationSnapshot {
        preparation_id,
        revision,
        status: "failed".to_string(),
        active_stage_id: None,
        started_at_unix_ms: timestamp_unix_ms,
        completed_at_unix_ms: Some(timestamp_unix_ms),
        stages,
        log_tail: vec![crate::types::SimulationPreparationLogEntrySnapshot {
            timestamp_unix_ms,
            level: "error".to_string(),
            stage_id: stage_id.to_string(),
            message: bounded_preparation_value(
                error_message,
                MAX_PREPARATION_LOG_MESSAGE_CHARS,
            ),
        }],
        failure: Some(crate::types::SimulationPreparationFailureSnapshot {
            error_code,
            summary: summary.clone(),
            detail: None,
            stage_id: stage_id.to_string(),
            diagnostics_correlation_id: None,
        }),
    }
}

fn apply_preparation_failure_snapshot(
    snapshot: &mut crate::types::SessionStateResponse,
    error_code: &str,
    error_message: &str,
) {
    let timestamp_unix_ms = u64::try_from(crate::unix_time_millis_now()).unwrap_or(u64::MAX);
    let bounded_code = bounded_preparation_value(error_code, MAX_PREPARATION_ERROR_CODE_CHARS);
    let bounded_summary = bounded_preparation_value(
        error_message,
        MAX_PREPARATION_ERROR_MESSAGE_CHARS,
    );
    let current_revision = snapshot.simulation_preparation_revision;
    if snapshot.simulation_preparation.is_some() {
        let next_revision = {
            let preparation = snapshot
                .simulation_preparation
                .as_mut()
                .expect("preparation presence checked above");
            let mut changed = normalize_preparation_diagnostics(preparation);
            let next_revision = current_revision
                .max(preparation.revision)
                .saturating_add(1)
                .max(1);
            let has_failure = preparation.failure.is_some();
            let already_failed = preparation.status == "failed"
                && preparation.active_stage_id.is_none()
                && preparation.completed_at_unix_ms.is_some()
                && has_failure;
            if !already_failed {
                changed = true;
                let failed_stage = preparation.active_stage_id.as_deref()
                    .filter(|id| canonical_preparation_stage_index(id).is_some())
                    .unwrap_or("runtime_startup").to_string();
                preparation.status = "failed".to_string();
                preparation.active_stage_id = None;
                preparation.completed_at_unix_ms = Some(timestamp_unix_ms);
                if let Some(stage) = preparation.stages.iter_mut().find(|stage| stage.id == failed_stage) {
                    stage.status = "failed".into();
                    stage.detail = bounded_summary.clone();
                    stage.completed_at_unix_ms = Some(timestamp_unix_ms);
                    stage.duration_ms = stage.started_at_unix_ms.and_then(|start| timestamp_unix_ms.checked_sub(start));
                    stage.progress_percent = None;
                    stage.progress_label = None;
                }
                if !has_failure {
                    preparation.failure = Some(
                        crate::types::SimulationPreparationFailureSnapshot {
                            error_code: bounded_code,
                            summary: bounded_summary.clone(),
                            detail: None,
                            stage_id: failed_stage.clone(),
                            diagnostics_correlation_id: None,
                        },
                    );
                }
                preparation.log_tail.push(crate::types::SimulationPreparationLogEntrySnapshot {
                    timestamp_unix_ms,
                    level: "error".into(),
                    stage_id: failed_stage,
                    message: bounded_summary.clone(),
                });
                if preparation.log_tail.len() > 128 {
                    preparation.log_tail.drain(..preparation.log_tail.len() - 128);
                }
            }
            if changed {
                preparation.revision = next_revision;
                Some(next_revision)
            } else {
                None
            }
        };
        if let Some(next_revision) = next_revision {
            snapshot.simulation_preparation_revision = next_revision;
        }
        return;
    }

    let revision = current_revision.saturating_add(1).max(1);
    let preparation_id = startup_failure_preparation_id(snapshot);
    snapshot.simulation_preparation = Some(build_failed_preparation_snapshot(
        preparation_id,
        revision,
        timestamp_unix_ms,
        &bounded_code,
        &bounded_summary,
    ));
    snapshot.simulation_preparation_revision = revision;
}

fn apply_accepted_preparation_failure_snapshot(
    snapshot: &mut crate::types::SessionStateResponse,
    context: &CurrentLiveRequestContext,
    session_epoch: u64,
    preparation_error: &crate::live_accepted_execution::AcceptedLiveStudyPreparationError,
) -> bool {
    apply_accepted_recovery_snapshot(
        snapshot,
        context,
        session_epoch,
        &preparation_error.code,
        &preparation_error.message,
        None,
    )
}

fn apply_accepted_recovery_snapshot(
    snapshot: &mut crate::types::SessionStateResponse,
    context: &CurrentLiveRequestContext,
    session_epoch: u64,
    error_code: &str,
    error_message: &str,
    stale_failure: Option<Value>,
) -> bool {
    if crate::ensure_current_live_request_context(snapshot, context, session_epoch).is_err() {
        return false;
    }
    apply_preparation_failure_snapshot(snapshot, error_code, error_message);
    let mut metadata = snapshot
        .metadata
        .take()
        .map(crate::shared_json::SharedJson::into_value)
        .unwrap_or_else(|| json!({}));
    if !metadata.is_object() {
        metadata = json!({"previous_metadata": metadata});
    }
    let metadata_object = metadata
        .as_object_mut()
        .expect("accepted recovery metadata must be an object");
    if let Some(stale_failure) = stale_failure {
        metadata_object.insert("docker_startup_failure".to_string(), stale_failure);
    }
    let startup = metadata_object
        .entry(STARTUP_METADATA_KEY.to_string())
        .or_insert_with(|| json!({}));
    if !startup.is_object() {
        *startup = json!({});
    }
    let startup_object = startup
        .as_object_mut()
        .expect("accepted startup metadata must be an object");
    startup_object.insert("preparation_status".to_string(), json!("failed"));
    if !startup_object.contains_key("preparation_error_code") {
        startup_object.insert(
            "preparation_error_code".to_string(),
            json!(error_code),
        );
    }
    if !startup_object.contains_key("preparation_error") {
        startup_object.insert(
            "preparation_error".to_string(),
            json!(bounded_startup_error(error_message)),
        );
    } else if startup_object
        .get("preparation_error_code")
        .and_then(Value::as_str)
        != Some(error_code)
    {
        startup_object.insert(
            "recovery_followup_error".to_string(),
            json!({
                "code": error_code,
                "message": bounded_startup_error(error_message),
            }),
        );
    }
    // Preserve the original request, source, status and step_ids. They are
    // the accepted immutable owner record; recovery metadata is additive.
    if !startup_object.contains_key("status") {
        startup_object.insert("status".to_string(), json!("waiting_for_compute"));
    }
    if let Some(run) = snapshot.run.as_ref() {
        startup_object
            .entry("accepted_run".to_string())
            .or_insert_with(|| json!(true));
        startup_object
            .entry("run_id".to_string())
            .or_insert_with(|| json!(run.run_id.clone()));
    }
    snapshot.metadata = Some(metadata.into());
    snapshot.session.status = "waiting_for_compute".to_string();
    snapshot.runtime_status = build_runtime_status_view("waiting_for_compute");
    if let Some(run) = snapshot.run.as_mut() {
        run.status = "waiting_for_compute".to_string();
    }
    snapshot.state_version = snapshot.state_version.saturating_add(1);
    true
}

fn apply_startup_failure_snapshot(
    snapshot: &mut crate::types::SessionStateResponse,
    context: &CurrentLiveRequestContext,
    session_epoch: u64,
    request: &DockerStartupRequest,
    loaded: &LoadedStartupScene,
    error: &ApiError,
) -> bool {
    if crate::ensure_current_live_request_context(snapshot, context, session_epoch).is_err() {
        return false;
    }
    let scene_matches = snapshot
        .scene_document
        .as_ref()
        .map(|scene| scene == &loaded.scene)
        .unwrap_or(true);
    let current_scene_revision = snapshot
        .scene_document
        .as_ref()
        .map(|scene| scene.revision);
    let failure = json!({
        "request_id": request.request_id.clone(),
        "source_sha256": loaded.source.sha256.clone(),
        "source_size_bytes": loaded.source.size_bytes,
        "status": "startup_failed",
        "error_code": error.code.clone(),
        "error": bounded_startup_error(&error.message),
        "captured_scene_revision": loaded.scene.revision,
        "current_scene_revision": current_scene_revision,
        "output_storage_binding": loaded.output_storage_binding,
    });

    // Once a RunIntent was accepted, every later failure is recovery-required.
    // Keep its immutable request/steps/status metadata and add only the
    // bounded recovery detail. A scene edit still gets a separate stale
    // diagnostic so it cannot overwrite the user's newer authoring state.
    if snapshot.run.is_some() {
        return apply_accepted_recovery_snapshot(
            snapshot,
            context,
            session_epoch,
            error.code
                .as_deref()
                .unwrap_or("accepted_run_recovery_required"),
            &error.message,
            (!scene_matches).then_some(failure),
        );
    }

    // A scene edit can retain the same session/run/epoch. Preserve the current
    // authoring metadata and record this stale attempt separately.
    let mut metadata = snapshot
        .metadata
        .take()
        .map(crate::shared_json::SharedJson::into_value)
        .unwrap_or_else(|| json!({}));
    if !metadata.is_object() {
        metadata = json!({"previous_metadata": metadata});
    }
    let metadata_object = metadata
        .as_object_mut()
        .expect("startup failure metadata must be an object");
    if !scene_matches {
        metadata_object.insert("docker_startup_failure".to_string(), failure);
    } else {
        let startup = metadata_object
            .entry(STARTUP_METADATA_KEY.to_string())
            .or_insert_with(|| json!({}));
        if !startup.is_object() {
            *startup = json!({});
        }
        let startup_object = startup
            .as_object_mut()
            .expect("startup metadata must be an object");
        startup_object.insert("request".to_string(), json!(request));
        startup_object.insert("request_id".to_string(), json!(request.request_id.clone()));
        startup_object.insert("source_sha256".to_string(), json!(loaded.source.sha256.clone()));
        startup_object.insert("source_size_bytes".to_string(), json!(loaded.source.size_bytes));
        startup_object.insert("status".to_string(), json!("startup_failed"));
        startup_object.insert("error_code".to_string(), json!(error.code.clone()));
        startup_object.insert(
            "error".to_string(),
            json!(bounded_startup_error(&error.message)),
        );
        startup_object.insert("runtime_metadata".to_string(), json!(loaded.runtime.clone()));
        startup_object.insert(
            "output_storage_binding".to_string(),
            loaded.output_storage_binding.clone(),
        );
        if let Some(run) = snapshot.run.as_ref() {
            startup_object.insert("accepted_run".to_string(), json!(true));
            startup_object.insert("run_id".to_string(), json!(run.run_id.clone()));
        }
    }
    snapshot.metadata = Some(metadata.into());
    if scene_matches {
        apply_preparation_failure_snapshot(
            snapshot,
            error.code
                .as_deref()
                .unwrap_or("docker_startup_failed"),
            &error.message,
        );
        snapshot.session.status = "startup_failed".to_string();
        snapshot.runtime_status = build_runtime_status_view("startup_failed");
    } else {
        // The placeholder no longer owns the edited scene. Leave the
        // authoring workspace commandable and expose only the stale attempt.
        snapshot.session.status = "awaiting_command".to_string();
        snapshot.runtime_status = build_runtime_status_view("awaiting_command");
    }
    snapshot.state_version = snapshot.state_version.saturating_add(1);
    true
}

#[cfg(test)]
mod tests {
    use super::*;

    fn request() -> DockerStartupRequest {
        DockerStartupRequest {
            schema: REQUEST_SCHEMA.to_string(),
            authorization: AUTHORIZATION_KIND.to_string(),
            request_id: "startup-test-1".to_string(),
            source: DockerStartupSource {
                path: "/opt/fullmag/source/examples/scene.py".to_string(),
                root: CONTAINER_SOURCE_ROOT.to_string(),
                relative: "examples/scene.py".to_string(),
                sha256: "a".repeat(64),
                commit: Some("b".repeat(40)),
            },
            execution: DockerStartupExecution {
                mode: "canonical_live_v2".to_string(),
                auto_study: true,
                interactive: "script_metadata".to_string(),
                wait_for_solve: "script_metadata".to_string(),
                legacy_cli: false,
            },
        }
    }

    fn loaded_scene_for_test(scene: SceneDocument) -> LoadedStartupScene {
        LoadedStartupScene {
            source: CapturedSource {
                path: PathBuf::from("/opt/fullmag/source/examples/scene.py"),
                sha256: "a".repeat(64),
                size_bytes: 1,
                bytes: Vec::new(),
            },
            scene,
            runtime: DockerStartupRuntimeMetadata {
                interactive: true,
                wait_for_solve: true,
            },
            output_storage_binding: json!({
                "schema": "fullmag.docker_script_output_binding.v1",
                "binding": "test",
            }),
        }
    }

    fn captured_source(path: &str) -> PathBuf {
        PathBuf::from(path)
    }

    #[test]
    fn docker_default_output_maps_to_selected_source_alias_without_parent_write() {
        let scene = SceneDocument::default();
        let binding = bind_docker_output_storage_with_alias(
            &scene,
            &captured_source("/opt/fullmag/source/examples/model.py"),
            Some(Path::new("/opt/fullmag/script-output")),
            Some(Path::new("examples")),
        )
        .expect("selected source directory should map to the alias");
        assert!(scene.study.output_storage.is_none());
        assert_eq!(binding["output_dir"], json!("/opt/fullmag/script-output/model.zarr"));
        assert_eq!(
            binding["temp_dir"],
            json!("/opt/fullmag/script-output/.fullmag-tmp")
        );
        assert_eq!(binding["source_original_dir"], json!("/opt/fullmag/source/examples"));
        assert_eq!(binding["source_dir"], json!("/opt/fullmag/script-output"));
        assert_eq!(binding["selected_source_directory"], json!("examples"));
    }

    #[test]
    fn docker_default_output_uses_source_filename_not_display_name() {
        let mut scene = SceneDocument::default();
        scene.scene.name = "Display name from authoring".to_string();
        let binding = bind_docker_output_storage_with_alias(
            &scene,
            &captured_source("/opt/fullmag/source/examples/authored_filename.py"),
            Some(Path::new("/opt/fullmag/script-output")),
            Some(Path::new("examples")),
        )
        .expect("source filename should determine the default output name");
        assert_eq!(binding["output_dir"], json!(
            "/opt/fullmag/script-output/authored_filename.zarr"
        ));
    }

    #[test]
    fn docker_relative_output_preserves_explicit_policy_under_selected_alias() {
        let mut scene = SceneDocument::default();
        scene.study.output_storage = Some(fullmag_ir::OutputStorageIR {
            output_dir: Some("custom.zarr".to_string()),
            temp_dir: Some("scratch".to_string()),
            ..Default::default()
        });
        let binding = bind_docker_output_storage_with_alias(
            &scene,
            &captured_source("/opt/fullmag/source/examples/sub/model.py"),
            Some(Path::new("/opt/fullmag/script-output")),
            Some(Path::new("examples")),
        )
        .expect("relative explicit paths should map below the selected alias");
        assert_eq!(
            binding["output_dir"],
            json!("/opt/fullmag/script-output/sub/custom.zarr")
        );
        assert_eq!(
            binding["temp_dir"],
            json!("/opt/fullmag/script-output/sub/scratch")
        );
        assert_eq!(
            binding["output_storage"]["output_dir"],
            json!("/opt/fullmag/script-output/sub/custom.zarr")
        );
        assert_eq!(
            binding["output_storage"]["temp_dir"],
            json!("/opt/fullmag/script-output/sub/scratch")
        );
        let storage = scene.study.output_storage.as_ref().unwrap();
        assert_eq!(
            storage.output_dir.as_deref(),
            Some("custom.zarr")
        );
        assert_eq!(
            storage.temp_dir.as_deref(),
            Some("scratch")
        );
    }

    #[test]
    fn docker_output_mapping_rejects_off_prefix_and_immutable_source_paths() {
        let source = captured_source("/opt/fullmag/source/examples/model.py");
        let mut off_prefix = SceneDocument::default();
        assert!(bind_docker_output_storage_with_alias(
            &off_prefix,
            &source,
            Some(Path::new("/opt/fullmag/script-output")),
            Some(Path::new("other")),
        )
        .is_err());

        let mut immutable = SceneDocument::default();
        immutable.study.output_storage = Some(fullmag_ir::OutputStorageIR {
            output_dir: Some("/opt/fullmag/source/model.zarr".to_string()),
            temp_dir: Some("/opt/fullmag/source/.fullmag-tmp".to_string()),
            ..Default::default()
        });
        assert!(bind_docker_output_storage_with_alias(
            &immutable,
            &source,
            None,
            None,
        )
        .is_err());

        let mut alias_parent_result = SceneDocument::default();
        alias_parent_result.study.output_storage = Some(fullmag_ir::OutputStorageIR {
            output_dir: Some(".".to_string()),
            ..Default::default()
        });
        assert!(bind_docker_output_storage_with_alias(
            &alias_parent_result,
            &source,
            Some(Path::new("/opt/fullmag/script-output")),
            Some(Path::new("examples")),
        )
        .is_err());
    }

    #[test]
    fn docker_explicit_absolute_output_does_not_require_alias() {
        let mut scene = SceneDocument::default();
        scene.study.output_storage = Some(fullmag_ir::OutputStorageIR {
            output_dir: Some("/opt/fullmag/prepared/model.zarr".to_string()),
            ..Default::default()
        });
        let binding = bind_docker_output_storage_with_alias(
            &scene,
            &captured_source("/opt/fullmag/source/examples/model.py"),
            None,
            None,
        )
        .expect("explicit absolute output should remain authoritative");
        let storage = scene.study.output_storage.as_ref().unwrap();
        assert_eq!(
            storage.output_dir.as_deref(),
            Some("/opt/fullmag/prepared/model.zarr")
        );
        assert_eq!(storage.temp_dir, None);
        assert_eq!(binding["binding"], json!("explicit_output_paths"));
    }

    fn placeholder_context(snapshot: &crate::types::SessionStateResponse) -> CurrentLiveRequestContext {
        CurrentLiveRequestContext {
            session_id: snapshot.session.session_id.clone(),
            run_id: Some(snapshot.session.run_id.clone()),
            session_epoch: 17,
            request_scope_epoch: "scope:17".to_string(),
        }
    }

    #[test]
    fn stale_placeholder_failure_keeps_new_scene_metadata_separate() {
        let snapshot_request: CurrentLiveSnapshotRequest =
            serde_json::from_value(json!({"session_id": "startup-scene-edit"}))
                .expect("minimal startup snapshot request should deserialize");
        let mut snapshot = default_current_live_state(&snapshot_request);
        snapshot.session.status = "activating".to_string();
        snapshot.session.run_id = "run-startup-placeholder".to_string();
        snapshot.runtime_status = build_runtime_status_view("activating");
        let mut captured_scene = SceneDocument::default();
        captured_scene.revision = 1;
        let mut edited_scene = captured_scene.clone();
        edited_scene.revision = 2;
        edited_scene.scene.name = "edited while preparing".to_string();
        snapshot.scene_document = Some(edited_scene.clone());
        snapshot.metadata = Some(json!({
            "editor": {"draft": "keep"},
            STARTUP_METADATA_KEY: {"request": "current-placeholder"}
        }).into());
        let context = placeholder_context(&snapshot);
        let error = ApiError::conflict("startup_scene_revision_or_content_changed");

        assert!(apply_startup_failure_snapshot(
            &mut snapshot,
            &context,
            17,
            &request(),
            &loaded_scene_for_test(captured_scene),
            &error,
        ));
        assert_eq!(snapshot.scene_document, Some(edited_scene));
        assert_eq!(snapshot.session.status, "awaiting_command");
        assert_eq!(
            snapshot.metadata.as_ref().and_then(|metadata| metadata
                .pointer("/editor/draft")
                .and_then(Value::as_str)),
            Some("keep")
        );
        assert_eq!(
            snapshot.metadata.as_ref().and_then(|metadata| metadata
                .pointer("/docker_startup/request")
                .and_then(Value::as_str)),
            Some("current-placeholder")
        );
        assert_eq!(
            snapshot.metadata.as_ref().and_then(|metadata| metadata
                .pointer("/docker_startup_failure/error")
                .and_then(Value::as_str)),
            Some("startup_scene_revision_or_content_changed")
        );
    }

    #[test]
    fn accepted_preparation_failure_keeps_run_identity_and_step_ids() {
        let snapshot_request: CurrentLiveSnapshotRequest =
            serde_json::from_value(json!({"session_id": "startup-accepted-recovery"}))
                .expect("minimal startup snapshot request should deserialize");
        let mut snapshot = default_current_live_state(&snapshot_request);
        snapshot.session.status = "waiting_for_compute".to_string();
        snapshot.session.run_id = "run-accepted-recovery".to_string();
        snapshot.runtime_status = build_runtime_status_view("waiting_for_compute");
        snapshot.run = Some(RunManifest {
            run_id: "run-accepted-recovery".to_string(),
            session_id: snapshot.session.session_id.clone(),
            status: "waiting_for_compute".to_string(),
            total_steps: 1,
            final_time: None,
            final_e_ex: None,
            final_e_demag: None,
            final_e_ext: None,
            final_e_ani: None,
            final_e_dmi: None,
            final_e_rotated_dmi: None,
            final_e_total: None,
            artifact_dir: ".".to_string(),
        });
        snapshot.scene_document = Some(SceneDocument::default());
        snapshot.metadata = Some(json!({
            STARTUP_METADATA_KEY: {
                "status": "waiting_for_compute",
                "run_id": "run-accepted-recovery",
                "step_ids": ["step-recovery"]
            }
        }).into());
        let context = placeholder_context(&snapshot);
        let preparation_error =
            crate::live_accepted_execution::AcceptedLiveStudyPreparationError {
                code: "accepted_run_catalog_failed".to_string(),
                message: "catalog materialization failed after RunIntent acceptance".to_string(),
            };

        assert!(apply_accepted_preparation_failure_snapshot(
            &mut snapshot,
            &context,
            17,
            &preparation_error,
        ));
        assert_eq!(snapshot.session.status, "waiting_for_compute");
        assert_eq!(
            snapshot.run.as_ref().map(|run| run.run_id.as_str()),
            Some("run-accepted-recovery")
        );
        assert_eq!(
            snapshot.metadata.as_ref().and_then(|metadata| metadata
                .pointer("/docker_startup/run_id")
                .and_then(Value::as_str)),
            Some("run-accepted-recovery")
        );
        assert_eq!(
            snapshot.metadata.as_ref().and_then(|metadata| metadata
                .pointer("/docker_startup/step_ids/0")
                .and_then(Value::as_str)),
            Some("step-recovery")
        );
        assert_eq!(
            snapshot.metadata.as_ref().and_then(|metadata| metadata
                .pointer("/docker_startup/preparation_status")
                .and_then(Value::as_str)),
            Some("failed")
        );
        assert_eq!(
            snapshot.metadata.as_ref().and_then(|metadata| metadata
                .pointer("/docker_startup/preparation_error_code")
                .and_then(Value::as_str)),
            Some("accepted_run_catalog_failed")
        );
        let preparation = snapshot
            .simulation_preparation
            .as_ref()
            .expect("accepted preparation failures must publish the preparation resource");
        assert_eq!(preparation.status, "failed");
        assert_eq!(preparation.stages.len(), CANONICAL_PREPARATION_STAGES.len());
        assert_eq!(
            preparation
                .stages
                .iter()
                .map(|stage| stage.id.as_str())
                .collect::<Vec<_>>(),
            CANONICAL_PREPARATION_STAGES
                .iter()
                .map(|(id, _)| *id)
                .collect::<Vec<_>>()
        );
        let failure = preparation
            .failure
            .as_ref()
            .expect("accepted preparation failure must be visible in its resource");
        assert_eq!(failure.error_code, "accepted_run_catalog_failed");
        assert_eq!(failure.stage_id, "runtime_startup");
        assert!(failure.summary.contains("catalog materialization failed"));
    }

    #[test]
    fn accepted_failure_normalizes_legacy_preparation_for_resource() {
        let snapshot_request: CurrentLiveSnapshotRequest =
            serde_json::from_value(json!({"session_id": "startup-legacy-preparation"}))
                .expect("minimal startup snapshot request should deserialize");
        let mut snapshot = default_current_live_state(&snapshot_request);
        snapshot.session.status = "waiting_for_compute".to_string();
        snapshot.session.run_id = "run-legacy-preparation".to_string();
        snapshot.runtime_status = build_runtime_status_view("waiting_for_compute");
        snapshot.run = Some(RunManifest {
            run_id: "run-legacy-preparation".to_string(),
            session_id: snapshot.session.session_id.clone(),
            status: "waiting_for_compute".to_string(),
            total_steps: 1,
            final_time: None,
            final_e_ex: None,
            final_e_demag: None,
            final_e_ext: None,
            final_e_ani: None,
            final_e_dmi: None,
            final_e_rotated_dmi: None,
            final_e_total: None,
            artifact_dir: ".".to_string(),
        });
        snapshot.scene_document = Some(SceneDocument::default());
        snapshot.simulation_preparation_revision = 7;
        snapshot.simulation_preparation = Some(crate::types::SimulationPreparationSnapshot {
            preparation_id: "legacy-preparation-id".to_string(),
            revision: 7,
            status: "completed".to_string(),
            active_stage_id: None,
            started_at_unix_ms: 10,
            completed_at_unix_ms: Some(11),
            stages: vec![crate::types::SimulationPreparationStageSnapshot {
                id: "startup".to_string(),
                label: "Legacy startup".to_string(),
                detail: "legacy stage detail".to_string(),
                status: "completed".to_string(),
                started_at_unix_ms: Some(10),
                completed_at_unix_ms: Some(11),
                duration_ms: Some(1),
                clock_adjustment: None,
                progress_percent: Some(100),
                progress_label: Some("legacy ready".to_string()),
            }],
            log_tail: vec![crate::types::SimulationPreparationLogEntrySnapshot {
                timestamp_unix_ms: 11,
                level: "error".to_string(),
                stage_id: "startup".to_string(),
                message: "legacy failure message".to_string(),
            }],
            failure: Some(crate::types::SimulationPreparationFailureSnapshot {
                error_code: "legacy_failure".to_string(),
                summary: "legacy failure summary".to_string(),
                detail: Some("legacy failure detail".to_string()),
                stage_id: "startup".to_string(),
                diagnostics_correlation_id: Some("diag-legacy".to_string()),
            }),
        });
        let context = placeholder_context(&snapshot);
        let preparation_error =
            crate::live_accepted_execution::AcceptedLiveStudyPreparationError {
                code: "replacement_error".to_string(),
                message: "a later error must not erase the original preparation failure"
                    .to_string(),
            };

        assert!(apply_accepted_preparation_failure_snapshot(
            &mut snapshot,
            &context,
            17,
            &preparation_error,
        ));
        let preparation = snapshot
            .simulation_preparation
            .as_ref()
            .expect("legacy preparation should remain available");
        assert_eq!(preparation.preparation_id, "legacy-preparation-id");
        assert_eq!(preparation.stages.len(), CANONICAL_PREPARATION_STAGES.len());
        assert_eq!(
            preparation
                .stages
                .iter()
                .map(|stage| stage.id.as_str())
                .collect::<Vec<_>>(),
            CANONICAL_PREPARATION_STAGES
                .iter()
                .map(|(id, _)| *id)
                .collect::<Vec<_>>()
        );
        let failure = preparation
            .failure
            .as_ref()
            .expect("legacy failure should be preserved");
        assert_eq!(failure.error_code, "legacy_failure");
        assert_eq!(failure.summary, "legacy failure summary");
        assert_eq!(failure.detail.as_deref(), Some("legacy failure detail"));
        assert_eq!(failure.stage_id, "runtime_startup");
        assert_eq!(failure.diagnostics_correlation_id.as_deref(), Some("diag-legacy"));
        assert_eq!(preparation.log_tail[0].stage_id, "runtime_startup");
        assert_eq!(preparation.log_tail[0].message, "legacy failure message");
    }

    #[test]
    fn accepted_later_failure_preserves_startup_owner_metadata() {
        let snapshot_request: CurrentLiveSnapshotRequest =
            serde_json::from_value(json!({"session_id": "startup-frontier-recovery"}))
                .expect("minimal startup snapshot request should deserialize");
        let mut snapshot = default_current_live_state(&snapshot_request);
        snapshot.session.status = "waiting_for_compute".to_string();
        snapshot.session.run_id = "run-frontier-recovery".to_string();
        snapshot.runtime_status = build_runtime_status_view("waiting_for_compute");
        snapshot.run = Some(RunManifest {
            run_id: "run-frontier-recovery".to_string(),
            session_id: snapshot.session.session_id.clone(),
            status: "waiting_for_compute".to_string(),
            total_steps: 2,
            final_time: None,
            final_e_ex: None,
            final_e_demag: None,
            final_e_ext: None,
            final_e_ani: None,
            final_e_dmi: None,
            final_e_rotated_dmi: None,
            final_e_total: None,
            artifact_dir: ".".to_string(),
        });
        let scene = SceneDocument::default();
        snapshot.scene_document = Some(scene.clone());
        let owner_request = request();
        snapshot.metadata = Some(json!({
            STARTUP_METADATA_KEY: {
                "request": owner_request,
                "request_id": "startup-test-1",
                "source_sha256": "a".repeat(64),
                "source_size_bytes": 1,
                "status": "waiting_for_compute",
                "run_id": "run-frontier-recovery",
                "step_ids": ["step-first", "step-second"],
                "scene_revision": scene.revision,
                "runtime_metadata": {"interactive": true, "wait_for_solve": true},
            }
        }).into());
        let context = placeholder_context(&snapshot);
        let error = ApiError::conflict_with_code(
            "accepted_frontier_preparation_failed",
            "frontier receipt is unavailable",
        );

        assert!(apply_startup_failure_snapshot(
            &mut snapshot,
            &context,
            17,
            &request(),
            &loaded_scene_for_test(scene),
            &error,
        ));
        assert_eq!(snapshot.session.status, "waiting_for_compute");
        assert_eq!(snapshot.run.as_ref().map(|run| run.run_id.as_str()), Some("run-frontier-recovery"));
        assert_eq!(snapshot.run.as_ref().map(|run| run.status.as_str()), Some("waiting_for_compute"));
        assert_eq!(
            snapshot.metadata.as_ref().and_then(|metadata| metadata
                .pointer("/docker_startup/request_id")
                .and_then(Value::as_str)),
            Some("startup-test-1")
        );
        assert_eq!(
            snapshot.metadata.as_ref().and_then(|metadata| metadata
                .pointer("/docker_startup/step_ids/1")
                .and_then(Value::as_str)),
            Some("step-second")
        );
        assert_eq!(
            snapshot.metadata.as_ref().and_then(|metadata| metadata
                .pointer("/docker_startup/status")
                .and_then(Value::as_str)),
            Some("waiting_for_compute")
        );
        assert_eq!(
            snapshot.metadata.as_ref().and_then(|metadata| metadata
                .pointer("/docker_startup/preparation_status")
                .and_then(Value::as_str)),
            Some("failed")
        );
        assert_eq!(
            snapshot.metadata.as_ref().and_then(|metadata| metadata
                .pointer("/docker_startup/preparation_error_code")
                .and_then(Value::as_str)),
            Some("accepted_frontier_preparation_failed")
        );
        assert!(snapshot
            .metadata
            .as_ref()
            .and_then(|metadata| metadata.get("docker_startup_failure"))
            .is_none());

        let followup = ApiError::conflict_with_code(
            "realtime_publication_failed",
            "realtime publication failed after recovery was recorded",
        );
        assert!(apply_startup_failure_snapshot(
            &mut snapshot,
            &context,
            17,
            &request(),
            &loaded_scene_for_test(SceneDocument::default()),
            &followup,
        ));
        assert_eq!(
            snapshot.metadata.as_ref().and_then(|metadata| metadata
                .pointer("/docker_startup/preparation_error_code")
                .and_then(Value::as_str)),
            Some("accepted_frontier_preparation_failed")
        );
        assert_eq!(
            snapshot.metadata.as_ref().and_then(|metadata| metadata
                .pointer("/docker_startup/recovery_followup_error/code")
                .and_then(Value::as_str)),
            Some("realtime_publication_failed")
        );
    }

    #[test]
    fn startup_replay_does_not_report_success_after_accepted_preparation_failure() {
        let request = request();
        let source = CapturedSource {
            path: PathBuf::from(request.source.path.clone()),
            sha256: request.source.sha256.clone(),
            size_bytes: 1,
            bytes: Vec::new(),
        };
        let snapshot_request: CurrentLiveSnapshotRequest =
            serde_json::from_value(json!({"session_id": "startup-replay-recovery"}))
                .expect("minimal startup snapshot request should deserialize");
        let mut snapshot = default_current_live_state(&snapshot_request);
        snapshot.session.run_id = "run-replay-recovery".to_string();
        snapshot.session.status = "waiting_for_compute".to_string();
        snapshot.metadata = Some(json!({
            STARTUP_METADATA_KEY: {
                "request": request,
                "source_sha256": source.sha256,
                "source_size_bytes": source.size_bytes,
                "status": "waiting_for_compute",
                "run_id": "run-replay-recovery",
                "step_ids": [123],
                "scene_revision": 0,
                "runtime_metadata": {"interactive": true, "wait_for_solve": true},
                "preparation_status": "failed",
                "preparation_error_code": "accepted_run_catalog_failed",
                "preparation_error": "catalog materialization failed",
            }
        }).into());

        let error = replay_or_reject(&request, &source, &snapshot)
            .expect_err("a preparation failure must not replay as accepted");
        assert_eq!(error.code.as_deref(), Some("accepted_run_recovery_required"));
    }

    #[test]
    fn request_policy_is_exact_and_legacy_cli_is_rejected() {
        let request = request();
        assert!(validate_request(&request).is_ok());
        let mut legacy = request.clone();
        legacy.execution.legacy_cli = true;
        assert!(validate_request(&legacy).is_err());
        let mut noncanonical = request.clone();
        noncanonical.execution.auto_study = false;
        assert!(validate_request(&noncanonical).is_err());
        noncanonical = request;
        noncanonical.execution.interactive = "caller_override".to_string();
        assert!(validate_request(&noncanonical).is_err());
    }

    #[test]
    fn only_a_reaped_helper_timeout_is_a_terminal_startup_rejection() {
        let mut timeout = ApiError::internal("Python helper exceeded the 30 second deadline");
        timeout.code = Some(crate::script::PYTHON_HELPER_TIMEOUT_CODE.to_string());
        let rejected = startup_helper_timeout_rejection(timeout);
        assert_eq!(
            rejected.status,
            axum::http::StatusCode::UNPROCESSABLE_ENTITY
        );
        assert_eq!(rejected.code.as_deref(), Some("validation_error"));
        assert!(rejected.message.contains("30 second deadline"));

        // An uncoded timeout (cleanup failed) or another failure stays unknown.
        let unreaped = startup_helper_timeout_rejection(ApiError::internal(
            "Python helper exceeded the 30 second deadline; process cleanup failed: wait failed",
        ));
        assert_eq!(
            unreaped.status,
            axum::http::StatusCode::INTERNAL_SERVER_ERROR
        );
        assert_eq!(unreaped.code, None);
    }

    #[test]
    fn only_the_typed_script_load_envelope_is_a_terminal_rejection() {
        let envelope = json!({
            "schema": "fullmag.script-load-rejection.v1",
            "code": "script_load_failed",
            "error_type": "ValueError",
            "message": "LLG relaxation requires an explicit timestep policy",
            "script_line": 38,
        })
        .to_string();
        let stdout = format!("user print\n\n{envelope}\n");
        assert_eq!(
            script_load_rejection(Some(2), stdout.as_bytes()).as_deref(),
            Some(
                "startup script failed while loading (script line 38): \
                 ValueError: LLG relaxation requires an explicit timestep policy"
            )
        );
        let without_line = envelope.replace("38", "null");
        assert_eq!(
            script_load_rejection(Some(2), without_line.as_bytes()).as_deref(),
            Some(
                "startup script failed while loading: \
                 ValueError: LLG relaxation requires an explicit timestep policy"
            )
        );
        // Another exit code, schema or shape keeps the unknown 500 outcome.
        assert!(script_load_rejection(Some(1), envelope.as_bytes()).is_none());
        assert!(script_load_rejection(None, envelope.as_bytes()).is_none());
        assert!(script_load_rejection(Some(2), b"Traceback (most recent call last):\n").is_none());
        let other_schema = envelope.replace("script-load-rejection", "scene-render-rejection");
        assert!(script_load_rejection(Some(2), other_schema.as_bytes()).is_none());
        let empty_message =
            envelope.replace("LLG relaxation requires an explicit timestep policy", " ");
        assert!(script_load_rejection(Some(2), empty_message.as_bytes()).is_none());
    }

    #[test]
    fn source_path_cannot_escape_or_use_reparse_components() {
        let mut request = request();
        request.source.relative = "../scene.py".to_string();
        request.source.path = "/opt/fullmag/scene.py".to_string();
        assert!(validate_source_identity(&request.source).is_err());
        request.source.relative = "examples\\scene.py".to_string();
        request.source.path = "/opt/fullmag/source/examples\\scene.py".to_string();
        assert!(validate_source_identity(&request.source).is_err());
    }

    #[test]
    fn runtime_metadata_rejects_wait_without_interactive() {
        let config = serde_json::json!({
            "ir": {"problem_meta": {"runtime_metadata": {
                "interactive_session_requested": false,
                "wait_for_solve": true
            }}}
        });
        assert!(runtime_metadata(&config).is_err());
    }

    #[test]
    fn runtime_metadata_preserves_script_owned_flags() {
        let config = serde_json::json!({
            "ir": {"problem_meta": {"runtime_metadata": {
                "interactive_session_requested": true,
                "wait_for_solve": true
            }}}
        });
        assert_eq!(
            runtime_metadata(&config).unwrap(),
            DockerStartupRuntimeMetadata {
                interactive: true,
                wait_for_solve: true
            }
        );
    }

    #[tokio::test]
    async fn accepted_startup_realtime_publication_blocks_replacement_until_send() {
        let state = crate::router_v2::tests::test_app_state_with_live_session().await;
        let mut accepted_snapshot = state
            .current_live_state
            .read()
            .await
            .as_ref()
            .cloned()
            .expect("accepted startup fixture must have a current snapshot");
        let accepted_run_id = "accepted-startup-run".to_string();
        accepted_snapshot.session.run_id = accepted_run_id.clone();
        accepted_snapshot.session.status = "awaiting_command".to_string();
        accepted_snapshot.run = Some(RunManifest {
            run_id: accepted_run_id.clone(),
            session_id: accepted_snapshot.session.session_id.clone(),
            status: "waiting_for_compute".to_string(),
            total_steps: 1,
            final_time: None,
            final_e_ex: None,
            final_e_demag: None,
            final_e_ext: None,
            final_e_ani: None,
            final_e_dmi: None,
            final_e_rotated_dmi: None,
            final_e_total: None,
            artifact_dir: ".".to_string(),
        });
        accepted_snapshot.state_version = accepted_snapshot.state_version.saturating_add(1);
        *state.current_live_state.write().await = Some(accepted_snapshot.clone());

        let hook = crate::types::CurrentLiveRealtimeBeforeSendHook {
            admitted: Arc::new(tokio::sync::Notify::new()),
            resume: Arc::new(tokio::sync::Notify::new()),
        };
        *state.current_live_realtime_before_send_hook.lock().await = Some(hook.clone());
        let mut events = state.current_live_realtime_events.subscribe();

        // This is the same transition guard held by startup while it binds
        // the accepted snapshot and publishes its first realtime event.
        let transition = state.current_live_session_transition.clone().lock_owned().await;
        let mut publication = Box::pin(publish_accepted_startup_realtime(
            &state,
            &accepted_snapshot,
            transition,
        ));
        tokio::select! {
            _ = hook.admitted.notified() => {}
            result = &mut publication => {
                panic!("accepted startup publication must pause before sending: {result:?}");
            }
        }
        assert!(
            state.current_live_session_transition.try_lock().is_err(),
            "startup transition must remain held until the accepted event is sent"
        );

        let replacement_state = state.clone();
        let replacement_started = Arc::new(tokio::sync::Notify::new());
        let replacement_started_signal = replacement_started.clone();
        let replacement = tokio::spawn(async move {
            replacement_started_signal.notify_one();
            crate::router_v2::handlers::sessions::create(
                axum::extract::State(replacement_state),
                axum::Json(crate::schemas::sessions::CreateSessionRequest {
                    name: "Replacement".to_string(),
                    backend: "fem".to_string(),
                    device: "cpu".to_string(),
                    precision: "double".to_string(),
                    replace_current: true,
                    output_storage: None,
                }),
            )
            .await
        });
        tokio::time::timeout(
            std::time::Duration::from_millis(100),
            replacement_started.notified(),
        )
        .await
        .expect("replacement must start while accepted publication is paused");

        hook.resume.notify_one();
        publication
            .await
            .expect("accepted startup realtime publication must succeed");

        let accepted_event =
            tokio::time::timeout(std::time::Duration::from_millis(100), events.recv())
                .await
                .expect("accepted startup event must be published")
                .expect("realtime channel must remain open");
        let accepted_event: crate::schemas::realtime::LiveRealtimeServerEvent =
            serde_json::from_str(&accepted_event.json)
                .expect("accepted startup event must serialize");
        match accepted_event {
            crate::schemas::realtime::LiveRealtimeServerEvent::ResourceBatchChanged {
                session_id,
                run_id,
                ..
            } => {
                assert_eq!(session_id, accepted_snapshot.session.session_id);
                assert_eq!(run_id.as_deref(), Some(accepted_run_id.as_str()));
            }
            other => panic!("expected accepted startup resource event, got {other:?}"),
        }

        let replacement = tokio::time::timeout(std::time::Duration::from_millis(100), replacement)
            .await
            .expect("replacement must proceed after accepted startup publication")
            .expect("replacement task must complete")
            .expect("replacement must be admitted");
        assert_eq!(replacement.0, axum::http::StatusCode::CREATED);
    }
}
