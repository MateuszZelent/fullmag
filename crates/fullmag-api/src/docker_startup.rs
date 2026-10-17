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

    // Commit the complete Study with the immutable manual gate first.  The
    // accepted preparation scheduler can only produce native FEM evidence for
    // a durable RunIntent; direct current-scene materialization would either
    // fabricate that evidence or reject FEM before the accepted run exists.
    let accepted =
        match crate::live_accepted_execution::submit_live_study_with_transition_with_asset_root(
            &state,
            &context,
            loaded.scene.clone(),
            request.request_id.clone(),
            loaded.source.sha256.clone(),
            false,
            Some(source_root),
        )
        .await
        {
            Ok(accepted) => accepted,
            Err(error) => {
                // Preserve the failed owner record and its source identity.  A
                // later request must not silently replace a possibly partially
                // committed accepted run after an unknown failure.
                mark_startup_failure(&state, &context, &request, &loaded, &error).await;
                return Err(error);
            }
        };

    if let Err(error) =
        crate::router_v2::handlers::simulation::commands::publish_accepted_live_study_under_transition(
        &state,
        &context,
        &accepted.run_id,
        &accepted.step_ids,
        "waiting_for_compute",
    )
    .await
    {
        // The accepted run is durable, but it has not yet been rebound to the
        // live read model.  Keep the temporary startup owner fenced so a retry
        // cannot publish a second RunIntent after an unknown failure.
        mark_startup_failure(&state, &context, &request, &loaded, &error).await;
        return Err(error);
    }

    // Publication changes the live run identity from the temporary startup
    // placeholder to the accepted durable run.  Every subsequent read and
    // write must carry that new identity through the same transition fence.
    let accepted_context = CurrentLiveRequestContext {
        session_id: context.session_id.clone(),
        run_id: Some(accepted.run_id.clone()),
        session_epoch: context.session_epoch,
        request_scope_epoch: context.request_scope_epoch.clone(),
    };

    // Only the first dependency-ready stage is the active startup model/mesh.
    // The shared accepted-frontier helper keeps later authored stages in the
    // immutable Study and waits for the admitted native preparation receipt.
    // Native preparation may take minutes.  Do not hold the current-session
    // transition while waiting: Stop, replacement, and recovery must be able
    // to acquire the same owner fence.  The preparation helper takes that
    // fence only around each bounded publication attempt.
    drop(transition);
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
    let response = publish_startup_result(
        &state,
        &accepted_context,
        &request,
        &loaded,
        accepted.run_id,
        accepted.step_ids,
        status,
    )
    .await?;
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

async fn mark_startup_failure(
    state: &Arc<AppState>,
    context: &CurrentLiveRequestContext,
    request: &DockerStartupRequest,
    loaded: &LoadedStartupScene,
    error: &ApiError,
) {
    let Ok(mut current) = state.current_live_state.try_write() else {
        return;
    };
    let Some(snapshot) = current.as_mut() else {
        return;
    };
    if crate::ensure_current_live_request_context(
        snapshot,
        context,
        state.current_live_session_epoch.load(Ordering::Acquire),
    )
    .is_err()
    {
        return;
    }
    snapshot.session.status = "startup_failed".to_string();
    snapshot.runtime_status = build_runtime_status_view("startup_failed");
    snapshot.metadata = Some(json!({
        STARTUP_METADATA_KEY: {
            "request": request,
            "request_id": request.request_id,
            "source_sha256": loaded.source.sha256,
            "source_size_bytes": loaded.source.size_bytes,
            "status": "startup_failed",
            "error": error.message,
            "runtime_metadata": loaded.runtime,
        }
    }));
    snapshot.state_version = snapshot.state_version.saturating_add(1);
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
}
