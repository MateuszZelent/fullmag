//! Internal Docker workspace startup-script activation.
//!
//! The host launcher admits one immutable source file and sends only its
//! bounded identity here.  This module performs the guest-side admission and
//! publishes a session through the existing live accepted-v2 pipeline.  It
//! never starts a solver and never uses the legacy scratch queue or CLI.

use axum::{extract::State, Json};
use fullmag_authoring::{normalize_scene_document_magnetization_assets, SceneDocument};
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

const STARTUP_METADATA_KEY: &str = "docker_startup";
const MAX_REQUEST_ID_BYTES: usize = 128;
const MAX_STARTUP_ERROR_CHARS: usize = 4096;
const MAX_PREPARATION_ERROR_CODE_CHARS: usize = 128;
const MAX_PREPARATION_ERROR_MESSAGE_CHARS: usize = 1024;
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
    *state.current_live_state.write().await = Some(snapshot);
    let session_epoch = state
        .current_live_session_epoch
        .fetch_add(1, Ordering::AcqRel)
        .saturating_add(1);
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
    let prepared =
        crate::live_accepted_execution::prepare_live_study_with_asset_root(
            &state,
            &context,
            loaded.scene.clone(),
            request.request_id.clone(),
            loaded.source.sha256.clone(),
            false,
            Some(source_root),
        )
        .await;

    // Reacquire the fence only after preparation.  The exact placeholder
    // session/run/epoch and full SceneDocument content must still match before
    // any durable accepted RunIntent is created.
    let transition = state.current_live_session_transition.lock().await;
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

    // Acquire the current-live write guard before the synchronous durable
    // commit. Prepare the complete in-memory candidate first; after the
    // commit succeeds, assigning this already validated value is infallible
    // and happens before any further await.
    let mut current = state.current_live_state.write().await;
    let snapshot = current
        .as_mut()
        .ok_or_else(|| ApiError::not_found("no active local live workspace"))?;
    let session_epoch = state.current_live_session_epoch.load(Ordering::Acquire);
    crate::ensure_current_live_request_context(snapshot, &context, session_epoch)?;
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
        }
    });
    let mut accepted_snapshot = snapshot.clone();
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
        drop(current);
        drop(transition);
        mark_startup_placeholder_failure(&state, &context, &request, &loaded, &error).await;
        return Err(error);
    }

    let accepted = match crate::live_accepted_execution::commit_prepared_live_accepted(&prepared)
    {
        Ok(accepted) => accepted,
        Err(error) => {
            // No durable RunIntent was proven. Terminalize only the temporary
            // owner; a failed pre-acceptance path must not invent a run.
            drop(current);
            drop(transition);
            mark_startup_placeholder_failure(&state, &context, &request, &loaded, &error).await;
            return Err(error);
        }
    };
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
            &mut accepted_snapshot,
            &accepted_context,
            session_epoch,
            preparation_error,
        ) {
            drop(current);
            return Err(ApiError::conflict(
                "accepted_run_recovery_context_changed_before_publication",
            ));
        }
    }
    *snapshot = accepted_snapshot;
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

    // The synchronous publication above changes the live run identity from
    // the temporary startup placeholder to the accepted durable run. Every
    // subsequent read and write carries that new identity through the same
    // transition fence.

    // Only the first dependency-ready stage is the active startup model/mesh.
    // The shared accepted-frontier helper keeps later authored stages in the
    // immutable Study and waits for the admitted native preparation receipt.
    // Native preparation may take minutes.  Do not hold the current-session
    // transition while waiting: Stop, replacement, and recovery must be able
    // to acquire the same owner fence.  The preparation helper takes that
    // fence only around each bounded publication attempt.
    let preparation =
        crate::live_scene_preparation::publish_accepted_frontier_preparation(
            &state,
            &accepted_context,
            "startup",
        )
        .await;

    // Reacquire the fence before touching the accepted run again.  A Stop or
    // replacement during preparation must win and must never be overwritten
    // by the stale startup request.
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
        // Preserve stopping/cancelled/terminal owner state.  The preparation
        // helper already reported the active-run fence failure, so marking a
        // second startup_failed state would overwrite the legitimate owner.
        if error.code.as_deref() == Some("accepted_preparation_run_stopped") {
            return Err(error);
        }
        // Keep the accepted run and any durable receipts visible for recovery;
        // never release its compute gate after a missing or invalid receipt.
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
        // Keep the binding explicit in source so a future release helper cannot
        // silently return a different accepted run after a storage replay.
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
            crate::script::run_python_helper_bounded(&repo_root, &workspace_root, &scene_args)?;
        if !scene_output.status.success() {
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
            crate::script::run_python_helper_bounded(&repo_root, &workspace_root, &helper_args)?;
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

    Ok(LoadedStartupScene {
        source,
        scene: loaded.0,
        runtime: loaded.1,
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
        STARTUP_METADATA_KEY: {
            "request": request,
            "status": "activating",
            "runtime_metadata": loaded.runtime,
            "source_size_bytes": loaded.source.size_bytes,
        }
    }));
    snapshot.runtime_status = build_runtime_status_view("activating");
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
    transition: tokio::sync::MutexGuard<'_, ()>,
) -> Result<(), ApiError> {
    let display_revision = state.current_display_selection.read().await.revision;
    let realtime_state =
        crate::current_live_realtime_state_from_snapshot(state, snapshot, display_revision).await;
    let result =
        crate::publish_current_live_realtime_batch_changed(state, &realtime_state, false, 0).await;
    drop(transition);
    result
}

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
    snapshot.metadata = Some(json!({
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
        }
    }));
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
    let _ = apply_startup_failure_snapshot(
        snapshot,
        context,
        state.current_live_session_epoch.load(Ordering::Acquire),
        request,
        loaded,
        error,
    );
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
    let _ = apply_startup_failure_snapshot(
        snapshot,
        context,
        state.current_live_session_epoch.load(Ordering::Acquire),
        request,
        loaded,
        error,
    );
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
                preparation.status = "failed".to_string();
                preparation.active_stage_id = None;
                preparation.completed_at_unix_ms = Some(timestamp_unix_ms);
                if !has_failure {
                    preparation.failure = Some(
                        crate::types::SimulationPreparationFailureSnapshot {
                            error_code: bounded_code,
                            summary: bounded_summary.clone(),
                            detail: None,
                            stage_id: "runtime_startup".to_string(),
                            diagnostics_correlation_id: None,
                        },
                    );
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
    let mut metadata = snapshot.metadata.take().unwrap_or_else(|| json!({}));
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
    snapshot.metadata = Some(metadata);
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
    let mut metadata = snapshot.metadata.take().unwrap_or_else(|| json!({}));
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
        if let Some(run) = snapshot.run.as_ref() {
            startup_object.insert("accepted_run".to_string(), json!(true));
            startup_object.insert("run_id".to_string(), json!(run.run_id.clone()));
        }
    }
    snapshot.metadata = Some(metadata);
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
        }
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
        }));
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
        }));
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
        }));
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
        }));

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
        let transition = state.current_live_session_transition.lock().await;
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
