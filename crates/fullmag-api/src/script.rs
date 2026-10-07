//! Script builder and Python helper invocation.

use crate::error::ApiError;
use crate::types::*;
use fullmag_authoring::{
    scene_document_problem_projection, scene_document_to_script_builder, SceneDocument,
    ScriptBuilderState,
};
use serde_json::Value;
use std::fs::{self, File, OpenOptions};
use std::io::{self, Read};
use std::path::{Path, PathBuf};
use std::process::{Child, Command as ProcessCommand, Output, Stdio};
use std::sync::Arc;
use std::thread;
use std::time::{Duration, Instant};

const BOUNDED_PYTHON_HELPER_TIMEOUT: Duration = Duration::from_secs(30);
const BOUNDED_PYTHON_HELPER_POLL_INTERVAL: Duration = Duration::from_millis(20);
const BOUNDED_PYTHON_HELPER_LOG_LIMIT: u64 = 1024 * 1024;

pub(crate) fn repo_root() -> PathBuf {
    if let Some(root) = std::env::current_exe().ok().and_then(|executable| {
        fullmag_runtime_control::python_runtime::packaged_windows_root(&executable)
    }) {
        return root;
    }
    if let Some(root) = std::env::var_os("FULLMAG_REPO_ROOT") {
        return PathBuf::from(root);
    }
    PathBuf::from(env!("CARGO_MANIFEST_DIR"))
        .parent()
        .expect("crate dir should have parent")
        .parent()
        .expect("workspace root should exist")
        .to_path_buf()
}

/// Resolve the writable per-user state root supplied by the launcher.  A
/// packaged install may live below Program Files, so generated live-workspace
/// files and mesh caches must not be placed next to the read-only binaries.
pub(crate) fn state_root(repo_root: &Path) -> Result<PathBuf, ApiError> {
    if let Some(configured) = fullmag_runtime_control::python_runtime::validated_state_override(
        std::env::var_os("FULLMAG_STATE_ROOT").map(PathBuf::from),
    )
    .map_err(|error| ApiError::internal(error.to_string()))?
    {
        return Ok(configured);
    }
    fullmag_runtime_control::python_runtime::packaged_windows_state_root(repo_root)
        .map(|root| root.unwrap_or_else(|| repo_root.join(".fullmag")))
        .map_err(|error| {
            ApiError::internal(format!(
                "Windows package state directory unavailable: {error}"
            ))
        })
}

pub(crate) const SCRIPT_ORIGIN_USER_FILE: &str = "user_file";
pub(crate) const SCRIPT_ORIGIN_GENERATED: &str = "generated";
pub(crate) const SCRIPT_ORIGIN_NONE: &str = "none";

/// Canonicalize the longest existing ancestor and re-append the missing tail,
/// so a path that does not exist yet still compares against canonical roots
/// (Windows canonical paths carry a `\\?\` prefix).
fn comparable_path(path: &Path) -> PathBuf {
    let mut existing = path;
    let mut tail = Vec::new();
    loop {
        if let Ok(canonical) = fs::canonicalize(existing) {
            return tail
                .iter()
                .rev()
                .fold(canonical, |joined, part| joined.join(part));
        }
        match (existing.parent(), existing.file_name()) {
            (Some(parent), Some(name)) if !parent.as_os_str().is_empty() => {
                tail.push(name.to_os_string());
                existing = parent;
            }
            _ => return path.to_path_buf(),
        }
    }
}

/// Classify the session script. A script inside the live workspace or the
/// session store is Fullmag-managed (`generated`); any other file is the
/// user's own (`user_file`) and must never be written by the application.
pub(crate) fn script_origin(workspace_root: &Path, script_path: &str) -> &'static str {
    let script_path = script_path.trim();
    if script_path.is_empty() {
        return SCRIPT_ORIGIN_NONE;
    }
    let script = comparable_path(Path::new(script_path));
    let mut managed_roots = vec![comparable_path(workspace_root)];
    if let Some(parent) = workspace_root.parent() {
        managed_roots.push(comparable_path(&parent.join("session-store")));
    }
    if managed_roots.iter().any(|root| script.starts_with(root)) {
        SCRIPT_ORIGIN_GENERATED
    } else {
        SCRIPT_ORIGIN_USER_FILE
    }
}

/// Managed export copy for a user script: `<workspace_root>/exports/<stem>.canonical.py`.
pub(crate) fn managed_export_copy_path(workspace_root: &Path, script_path: &Path) -> PathBuf {
    let stem = script_path
        .file_stem()
        .and_then(|stem| stem.to_str())
        .filter(|stem| !stem.is_empty())
        .unwrap_or("script");
    workspace_root
        .join("exports")
        .join(format!("{stem}.canonical.py"))
}

pub(crate) fn session_script_summary(
    workspace_root: &Path,
    script_path: &str,
    include_hash: bool,
) -> Option<SessionScriptSummary> {
    let origin = script_origin(workspace_root, script_path);
    if origin == SCRIPT_ORIGIN_NONE {
        return None;
    }
    let script_path = script_path.trim();
    let user_file = origin == SCRIPT_ORIGIN_USER_FILE;
    let sha256 = if include_hash {
        use sha2::{Digest, Sha256};
        fs::read(script_path).ok().map(|bytes| {
            Sha256::digest(&bytes)
                .iter()
                .map(|byte| format!("{byte:02x}"))
                .collect::<String>()
        })
    } else {
        None
    };
    Some(SessionScriptSummary {
        origin: origin.to_string(),
        path: script_path.to_string(),
        writable: !user_file,
        managed_copy_path: user_file.then(|| {
            managed_export_copy_path(workspace_root, Path::new(script_path))
                .display()
                .to_string()
        }),
        sha256,
    })
}

pub(crate) async fn sync_current_live_script_with_request(
    state: &Arc<AppState>,
    req: ScriptSyncRequest,
) -> Result<ScriptSyncResponse, ApiError> {
    let workspace_root = state.current_workspace_root.clone();
    let (script_path, scene_document, has_input_script, origin) = {
        let current = state.current_live_state.read().await;
        let snapshot = current
            .as_ref()
            .ok_or_else(|| ApiError::not_found("no active local live workspace"))?;
        let authored_script_path = snapshot.session.script_path.trim();
        let has_input_script = !authored_script_path.is_empty();
        let script_path = if has_input_script {
            PathBuf::from(authored_script_path)
        } else {
            workspace_root.join("scene_document.py")
        };
        (
            script_path,
            snapshot.scene_document.clone(),
            has_input_script,
            script_origin(&workspace_root, authored_script_path),
        )
    };

    eprintln!(
        "[fullmag-api] RX <- frontend script sync {}",
        script_path.display()
    );
    let user_file = origin == SCRIPT_ORIGIN_USER_FILE;
    let managed_copy = user_file.then(|| managed_export_copy_path(&workspace_root, &script_path));
    if !has_input_script && req.overrides.is_some() {
        return Err(ApiError::bad_request(
            "explicit script overrides require an existing input script",
        ));
    }
    let render_scene = scene_document.is_some()
        && matches!(origin, SCRIPT_ORIGIN_GENERATED | SCRIPT_ORIGIN_NONE)
        && req.overrides.is_none();
    let mut response = if has_input_script && !render_scene {
        if !script_path.is_file() {
            return Err(ApiError::bad_request(format!(
                "script path does not exist: {}",
                script_path.display()
            )));
        }
        let overrides = if let Some(overrides) = req.overrides.clone() {
            Some(overrides)
        } else if let Some(scene_document) = scene_document.as_ref() {
            Some(scene_document_overrides(scene_document)?)
        } else {
            None
        };
        let repo_root = state.repo_root.clone();
        let workspace_root = workspace_root.clone();
        let script_path_for_helper = script_path.clone();
        let managed_copy_for_helper = managed_copy.clone();
        run_blocking_script_operation(move || {
            rewrite_script_via_python_helper_with_policy(
                &repo_root,
                &workspace_root,
                &script_path_for_helper,
                overrides.as_ref(),
                managed_copy_for_helper.as_deref(),
                PythonHelperOutputPolicy::Bounded {
                    workspace_root: &workspace_root,
                },
            )
        })
        .await?
    } else {
        let scene_document = scene_document.as_ref().ok_or_else(|| {
            ApiError::bad_request(
                "scratch workspace has no SceneDocument to render as a canonical script",
            )
        })?;
        let repo_root = state.repo_root.clone();
        let workspace_root = workspace_root.clone();
        let script_path_for_helper = script_path.clone();
        let scene_document = scene_document.clone();
        run_blocking_script_operation(move || {
            render_scene_document_via_python_helper_bounded(
                &repo_root,
                &workspace_root,
                &script_path_for_helper,
                &scene_document,
            )
        })
        .await?
    };
    if let Some(copy) = managed_copy.as_ref() {
        // The helper wrote the canonical copy; the user's script was only read.
        response.script_path = copy.display().to_string();
        response.written_to = "export_copy".to_string();
        response.source_script_modified = false;
        response.managed_copy_path = Some(copy.display().to_string());
    } else {
        response.written_to = "script".to_string();
        response.source_script_modified = has_input_script;
    }
    if !has_input_script {
        let mut current = state.current_live_state.write().await;
        if let Some(snapshot) = current.as_mut() {
            if snapshot.session.script_path.trim().is_empty() {
                snapshot.session.script_path = response.script_path.clone();
            }
        }
    }
    eprintln!(
        "[fullmag-api] TX -> frontend script sync ok {}",
        response.script_path
    );
    Ok(response)
}

pub(crate) async fn get_current_live_script_source(
    state: &Arc<AppState>,
) -> Result<ScriptSourceResponse, ApiError> {
    let script_path = {
        let current = state.current_live_state.read().await;
        let snapshot = current
            .as_ref()
            .ok_or_else(|| ApiError::not_found("no active local live workspace"))?;
        let script_path = snapshot.session.script_path.trim();
        if script_path.is_empty() {
            return Err(ApiError::bad_request(
                "active local live workspace does not expose a script path",
            ));
        }
        PathBuf::from(script_path)
    };
    let origin = script_origin(
        &state.current_workspace_root,
        &script_path.to_string_lossy(),
    );
    let mut managed_copy_path = None;
    let script_path = if origin == SCRIPT_ORIGIN_USER_FILE {
        let copy = managed_export_copy_path(&state.current_workspace_root, &script_path);
        managed_copy_path = Some(copy.display().to_string());
        // Prefer the canonical copy; without one the original is only read.
        if copy.is_file() {
            copy
        } else {
            script_path
        }
    } else {
        script_path
    };

    if !script_path.is_file() {
        return Err(ApiError::bad_request(format!(
            "script path does not exist: {}",
            script_path.display()
        )));
    }

    let script_display = script_path.display().to_string();
    let source_path = script_path.clone();
    let source = run_blocking_script_operation(move || {
        std::fs::read_to_string(&source_path).map_err(|error| {
            ApiError::internal(format!(
                "failed to read current live script '{}': {}",
                source_path.display(),
                error
            ))
        })
    })
    .await?;

    Ok(ScriptSourceResponse {
        script_path: script_display,
        bytes: source.len(),
        source,
        origin: origin.to_string(),
        managed_copy_path,
    })
}

async fn run_blocking_script_operation<T, F>(operation: F) -> Result<T, ApiError>
where
    T: Send + 'static,
    F: FnOnce() -> Result<T, ApiError> + Send + 'static,
{
    tokio::task::spawn_blocking(operation)
        .await
        .map_err(|error| ApiError::internal(format!("script helper task failed: {error}")))?
}

fn rewrite_script_via_python_helper_with_policy(
    repo_root: &Path,
    workspace_root: &Path,
    script_path: &Path,
    overrides: Option<&Value>,
    export_copy: Option<&Path>,
    policy: PythonHelperOutputPolicy<'_>,
) -> Result<ScriptSyncResponse, ApiError> {
    let mut helper_args = vec![
        "-m".to_string(),
        "fullmag.runtime.helper".to_string(),
        "rewrite-script".to_string(),
        "--script".to_string(),
        script_path.display().to_string(),
    ];
    // A user-owned script is never rewritten: the canonical script goes to the
    // managed export copy instead (`--output` leaves the source untouched).
    match export_copy {
        Some(copy) => {
            helper_args.push("--output".to_string());
            helper_args.push(copy.display().to_string());
        }
        None => helper_args.push("--write".to_string()),
    }

    let overrides_path = if let Some(overrides) = overrides {
        std::fs::create_dir_all(workspace_root).map_err(|error| {
            ApiError::internal(format!("failed to prepare workspace: {}", error))
        })?;
        let path = workspace_root.join(format!("script-sync-{}.json", uuid_v4_hex()));
        let body = serde_json::to_string_pretty(overrides).map_err(|error| {
            ApiError::internal(format!("failed to serialize overrides: {}", error))
        })?;
        std::fs::write(&path, body).map_err(|error| {
            ApiError::internal(format!("failed to persist overrides: {}", error))
        })?;
        helper_args.push("--overrides-json".to_string());
        helper_args.push(path.display().to_string());
        Some(path)
    } else {
        None
    };

    let output = run_python_helper_with_policy(repo_root, &helper_args, policy);
    if let Some(path) = overrides_path {
        let _ = std::fs::remove_file(path);
    }
    let output = output?;
    if !output.status.success() {
        let stderr = String::from_utf8_lossy(&output.stderr);
        return Err(ApiError::internal(format!(
            "python rewrite helper failed: {}",
            stderr.trim()
        )));
    }

    serde_json::from_slice::<ScriptSyncResponse>(&output.stdout).map_err(|error| {
        ApiError::internal(format!(
            "failed to deserialize rewrite helper response: {}",
            error
        ))
    })
}

pub(crate) fn render_scene_document_via_python_helper(
    repo_root: &Path,
    workspace_root: &Path,
    output_path: &Path,
    scene_document: &SceneDocument,
) -> Result<ScriptSyncResponse, ApiError> {
    render_scene_document_via_python_helper_with_policy(
        repo_root,
        workspace_root,
        output_path,
        scene_document,
        PythonHelperOutputPolicy::Capture,
        false,
    )
}

/// Render an authoring document through the Python helper with bounded,
/// file-backed process output.  The authoring endpoint owns the private
/// workspace, so the helper cannot leave an unbounded `Command::output`
/// buffer on the API worker.
pub(crate) fn render_scene_document_via_python_helper_bounded(
    repo_root: &Path,
    workspace_root: &Path,
    output_path: &Path,
    scene_document: &SceneDocument,
) -> Result<ScriptSyncResponse, ApiError> {
    render_scene_document_via_python_helper_with_policy(
        repo_root,
        workspace_root,
        output_path,
        scene_document,
        PythonHelperOutputPolicy::Bounded { workspace_root },
        false,
    )
}

/// Persistence may keep an authoring-valid scene with no enabled physics.
/// Such a document has no executable source yet; runtime synchronization stays strict.
pub(crate) fn try_render_scene_document_for_persistence(
    repo_root: &Path,
    workspace_root: &Path,
    output_path: &Path,
    scene_document: &SceneDocument,
) -> Result<Option<ScriptSyncResponse>, ApiError> {
    let response = render_scene_document_via_python_helper_with_policy(
        repo_root,
        workspace_root,
        output_path,
        scene_document,
        PythonHelperOutputPolicy::Bounded { workspace_root },
        true,
    )?;
    if response.written {
        return Ok(Some(response));
    }
    if response.bytes_written != 0 || output_path.exists() {
        return Err(ApiError::internal(
            "incomplete authoring render unexpectedly produced executable source",
        ));
    }
    Ok(None)
}

struct TemporaryFileGuard(PathBuf);

impl Drop for TemporaryFileGuard {
    fn drop(&mut self) {
        let _ = fs::remove_file(&self.0);
    }
}

fn render_scene_document_via_python_helper_with_policy(
    repo_root: &Path,
    workspace_root: &Path,
    output_path: &Path,
    scene_document: &SceneDocument,
    policy: PythonHelperOutputPolicy<'_>,
    allow_incomplete: bool,
) -> Result<ScriptSyncResponse, ApiError> {
    std::fs::create_dir_all(workspace_root)
        .map_err(|error| ApiError::internal(format!("failed to prepare workspace: {}", error)))?;
    let scene_path = workspace_root.join(format!("scene-export-{}.json", uuid_v4_hex()));
    let _scene_guard = TemporaryFileGuard(scene_path.clone());
    let scene_body = serde_json::to_string_pretty(scene_document).map_err(|error| {
        ApiError::internal(format!("failed to serialize SceneDocument: {}", error))
    })?;
    std::fs::write(&scene_path, scene_body).map_err(|error| {
        ApiError::internal(format!("failed to persist SceneDocument: {}", error))
    })?;
    let mut helper_args = vec![
        "-m".to_string(),
        "fullmag.runtime.helper".to_string(),
        "render-scene-document".to_string(),
        "--scene-json".to_string(),
        scene_path.display().to_string(),
        "--output".to_string(),
        output_path.display().to_string(),
    ];
    if allow_incomplete {
        helper_args.push("--allow-incomplete".to_string());
    }
    let output = run_python_helper_with_policy(repo_root, &helper_args, policy);
    let output = output?;
    if !output.status.success() {
        let stderr = String::from_utf8_lossy(&output.stderr);
        return Err(ApiError::internal(format!(
            "python SceneDocument render helper failed: {}",
            stderr.trim()
        )));
    }
    serde_json::from_slice::<ScriptSyncResponse>(&output.stdout).map_err(|error| {
        ApiError::internal(format!(
            "failed to deserialize SceneDocument render response: {}",
            error
        ))
    })
}

pub(crate) fn load_scene_document_state(
    repo_root: &Path,
    _workspace_root: &Path,
    script_path: &Path,
) -> Result<SceneDocument, ApiError> {
    let helper_args = vec![
        "-m".to_string(),
        "fullmag.runtime.helper".to_string(),
        "export-scene-document".to_string(),
        "--script".to_string(),
        script_path.display().to_string(),
    ];
    let output = run_python_helper(repo_root, &helper_args)?;
    if !output.status.success() {
        let stderr = String::from_utf8_lossy(&output.stderr);
        return Err(ApiError::internal(format!(
            "python scene document helper failed: {}",
            stderr.trim()
        )));
    }
    serde_json::from_slice::<SceneDocument>(&output.stdout).map_err(|error| {
        ApiError::internal(format!(
            "failed to deserialize scene document response: {}",
            error
        ))
    })
}

pub(crate) fn scene_document_to_problem_ir(
    repo_root: &Path,
    workspace_root: &Path,
    scene_document: &SceneDocument,
    requested_execution: &fullmag_application::RequestedExecution,
) -> Result<fullmag_ir::ProblemIR, ApiError> {
    requested_execution
        .validate()
        .map_err(|error| ApiError::bad_request(error.to_string()))?;
    if !matches!(requested_execution.backend.as_str(), "auto" | "fdm") {
        return Err(ApiError::bad_request(
            "current live preparation materialization supports requested backend 'fdm' or 'auto'",
        ));
    }
    let problem = scene_document_to_authored_problem_ir(
        repo_root,
        workspace_root,
        scene_document,
        requested_execution,
    )?;
    let problem =
        fullmag_application::bind_declared_execution(&problem, vec![]).map_err(|error| {
            ApiError::bad_request(format!(
                "declared execution profile could not be bound: {error}"
            ))
        })?;
    problem.validate().map_err(|errors| {
        ApiError::internal(format!(
            "canonical SceneDocument lowering produced invalid ProblemIR: {}",
            errors.join("; ")
        ))
    })?;
    Ok(problem)
}

/// Capture canonical authored IR without resolving its declared profile.
/// Whole-Study callers must bind the published catalogue exactly once through
/// the application materializer. This does not generate per-step inputs or
/// evaluate host admission, and the caller owns the captured source/asset root.
/// Validation/binding remain at the caller's existing materialization boundary.
pub(crate) fn scene_document_to_authored_problem_ir(
    repo_root: &Path,
    workspace_root: &Path,
    scene_document: &SceneDocument,
    requested_execution: &fullmag_application::RequestedExecution,
) -> Result<fullmag_ir::ProblemIR, ApiError> {
    capture_authored_scene(
        repo_root,
        workspace_root,
        scene_document,
        requested_execution,
        SceneCaptureKind::ProblemIr,
    )
}

/// Capture actual authored stage IR/actions through the same Python helper as
/// script execution. This does not bind profiles or create execution readiness.
pub(crate) fn scene_document_to_authored_script_config(
    repo_root: &Path,
    workspace_root: &Path,
    scene_document: &SceneDocument,
    requested_execution: &fullmag_application::RequestedExecution,
) -> Result<fullmag_application::script_stage_contract::ScriptExecutionConfig, ApiError> {
    capture_authored_scene(
        repo_root,
        workspace_root,
        scene_document,
        requested_execution,
        SceneCaptureKind::ExecutionConfig,
    )
}

/// Project actual authored stages through the shared canonical producer.
/// Pure output-policy configuration is sufficient here: writer availability,
/// profile binding, state-port compilation and admission remain separate gates.
pub(crate) fn scene_document_to_authored_stages(
    repo_root: &Path,
    workspace_root: &Path,
    scene_document: &SceneDocument,
    requested_execution: &fullmag_application::RequestedExecution,
) -> Result<Vec<fullmag_application::script_stage_contract::ResolvedScriptStage>, ApiError> {
    let config = scene_document_to_authored_script_config(
        repo_root,
        workspace_root,
        scene_document,
        requested_execution,
    )?;
    fullmag_application::script_stage_materialization::materialize_script_stages_with_output_policy_bounded(
        config,
        fullmag_ir::configure_project_autosave_policy,
        256,
    )
    .map_err(|error| {
        ApiError::bad_request(format!(
            "SceneDocument stage materialization failed: {error:#}"
        ))
    })
}

#[derive(Clone, Copy)]
enum SceneCaptureKind {
    ProblemIr,
    ExecutionConfig,
}

impl SceneCaptureKind {
    fn helper_command(self) -> &'static str {
        match self {
            Self::ProblemIr => "export-scene-ir",
            Self::ExecutionConfig => "export-scene-config",
        }
    }

    fn label(self) -> &'static str {
        match self {
            Self::ProblemIr => "ProblemIR",
            Self::ExecutionConfig => "ScriptExecutionConfig",
        }
    }
}

fn capture_authored_scene<T: serde::de::DeserializeOwned>(
    repo_root: &Path,
    workspace_root: &Path,
    scene_document: &SceneDocument,
    requested_execution: &fullmag_application::RequestedExecution,
    kind: SceneCaptureKind,
) -> Result<T, ApiError> {
    requested_execution
        .validate()
        .map_err(|error| ApiError::bad_request(error.to_string()))?;
    scene_document_problem_projection(scene_document)
        .map_err(|error| ApiError::bad_request(error.message))?;
    std::fs::create_dir_all(workspace_root)
        .map_err(|error| ApiError::internal(format!("failed to prepare workspace: {error}")))?;

    let scene_path = workspace_root.join(format!("preparation-scene-{}.json", uuid_v4_hex()));
    let scene_body = serde_json::to_vec(scene_document).map_err(|error| {
        ApiError::internal(format!(
            "failed to serialize preparation SceneDocument: {error}"
        ))
    })?;
    if let Err(error) = std::fs::write(&scene_path, scene_body) {
        let _ = std::fs::remove_file(&scene_path);
        return Err(ApiError::internal(format!(
            "failed to persist preparation SceneDocument: {error}"
        )));
    }

    let helper_args = vec![
        "-m".to_string(),
        "fullmag.runtime.helper".to_string(),
        kind.helper_command().to_string(),
        "--scene-json".to_string(),
        scene_path.display().to_string(),
        "--backend".to_string(),
        requested_execution.backend.clone(),
        "--device".to_string(),
        requested_execution.device.clone(),
        "--precision".to_string(),
        requested_execution.precision.clone(),
        "--mode".to_string(),
        requested_execution.mode.clone(),
        "--asset-root".to_string(),
        workspace_root.display().to_string(),
    ];
    let output = run_python_helper(repo_root, &helper_args);
    let _ = std::fs::remove_file(&scene_path);
    let output = output?;
    if !output.status.success() {
        let stderr = String::from_utf8_lossy(&output.stderr);
        return Err(ApiError::bad_request(format!(
            "SceneDocument could not be lowered to {}: {}",
            kind.label(),
            stderr.trim()
        )));
    }

    serde_json::from_slice(&output.stdout).map_err(|error| {
        ApiError::internal(format!(
            "failed to decode generated {}: {error}",
            kind.label()
        ))
    })
}

pub(crate) fn scene_document_builder_projection(
    scene_document: &SceneDocument,
) -> Result<ScriptBuilderState, ApiError> {
    scene_document_to_script_builder(scene_document)
        .map_err(|error| ApiError::bad_request(error.message))
}

pub(crate) fn scene_document_overrides(scene_document: &SceneDocument) -> Result<Value, ApiError> {
    Ok(scene_document_problem_projection(scene_document)
        .map_err(|error| ApiError::bad_request(error.message))?
        .rewrite_overrides)
}

/// Resolve the one Fullmag Python interpreter for `repo_root` (see
/// `fullmag_runtime_control::python_runtime::resolve_interpreter`).
pub(crate) fn resolve_python(
    repo_root: &Path,
) -> Result<fullmag_runtime_control::python_runtime::ResolvedInterpreter, ApiError> {
    let real_root = python_workspace_root(repo_root);
    fullmag_runtime_control::python_runtime::resolve_interpreter(&real_root)
        .map_err(|error| ApiError::internal(error.to_string()))
}

#[cfg(test)]
pub(crate) fn python_executable(repo_root: &Path) -> Result<String, ApiError> {
    Ok(resolve_python(repo_root)?.path.display().to_string())
}

/// A command for the resolved interpreter, already carrying its flags, the
/// UTF-8 switch and (for the packaged bundle) the isolation environment.
pub(crate) fn python_command(repo_root: &Path) -> Result<ProcessCommand, ApiError> {
    let real_root = python_workspace_root(repo_root);
    resolve_python(repo_root)?
        .command(&real_root)
        .map_err(|error| {
            ApiError::internal(format!(
                "bundled Python runtime is incomplete or invalid: {error}"
            ))
        })
}

pub(crate) fn python_workspace_root(root: &Path) -> PathBuf {
    if root.join("packages/fullmag-py/src/fullmag").exists()
        || fullmag_runtime_control::python_runtime::packaged_windows_python(root).is_some()
    {
        root.to_path_buf()
    } else {
        self::repo_root()
    }
}

#[derive(Clone, Copy)]
enum PythonHelperOutputPolicy<'a> {
    Capture,
    Bounded { workspace_root: &'a Path },
}

pub(crate) fn run_python_helper(repo_root: &Path, args: &[String]) -> Result<Output, ApiError> {
    run_python_helper_with_policy(repo_root, args, PythonHelperOutputPolicy::Capture)
}

/// Run a helper command with file-backed bounded output and the 30 second
/// deadline. `workspace_root` is a private directory that receives the logs.
pub(crate) fn run_python_helper_bounded(
    repo_root: &Path,
    workspace_root: &Path,
    args: &[String],
) -> Result<Output, ApiError> {
    run_python_helper_with_policy(
        repo_root,
        args,
        PythonHelperOutputPolicy::Bounded { workspace_root },
    )
}

fn run_python_helper_with_policy(
    repo_root: &Path,
    args: &[String],
    policy: PythonHelperOutputPolicy<'_>,
) -> Result<Output, ApiError> {
    let real_root = python_workspace_root(repo_root);
    let interpreter = resolve_python(repo_root)?;
    let uses_bundle = interpreter.isolated;

    let pythonpath = real_root.join("packages").join("fullmag-py").join("src");
    let packaged_site_packages = real_root.join("python").join("site-packages");
    let python_extension_root = real_root.join(".fullmag").join("local");
    let fem_mesh_cache_dir = state_root(&real_root)?
        .join("local")
        .join("cache")
        .join("fem_mesh_assets");
    let inherited_pythonpath = std::env::var("PYTHONPATH").ok();
    {
        let mut command = python_command(repo_root)?;
        command.args(args);
        command.env("PYTHONUNBUFFERED", "1");
        command.env("FULLMAG_FEM_MESH_CACHE_DIR", &fem_mesh_cache_dir);
        let mut python_paths = Vec::new();
        if pythonpath.is_dir() {
            python_paths.push(pythonpath.display().to_string());
        }
        if packaged_site_packages.is_dir() {
            python_paths.push(packaged_site_packages.display().to_string());
        }
        if python_extension_root.is_dir() {
            python_paths.push(python_extension_root.display().to_string());
        }
        if let Some(existing) = &inherited_pythonpath {
            if !existing.is_empty() {
                python_paths.push(existing.clone());
            }
        }
        if !uses_bundle && !python_paths.is_empty() {
            command.env(
                "PYTHONPATH",
                python_paths.join(if cfg!(windows) { ";" } else { ":" }),
            );
        }

        match policy {
            PythonHelperOutputPolicy::Capture => command.output().map_err(|error| {
                ApiError::internal(format!(
                    "failed to spawn python helper ({}): {error}",
                    interpreter.path.display()
                ))
            }),
            PythonHelperOutputPolicy::Bounded { workspace_root } => {
                match run_bounded_python_helper(command, workspace_root) {
                    Ok(output) => Ok(output),
                    Err(BoundedHelperError::Spawn(error)) => Err(ApiError::internal(format!(
                        "failed to spawn python helper ({}): {error}",
                        interpreter.path.display()
                    ))),
                    Err(BoundedHelperError::Started(error)) => Err(error),
                }
            }
        }
    }
}

enum BoundedHelperError {
    Spawn(io::Error),
    Started(ApiError),
}

struct BoundedHelperLogGuard {
    stdout_path: PathBuf,
    stderr_path: PathBuf,
}

impl Drop for BoundedHelperLogGuard {
    fn drop(&mut self) {
        let _ = fs::remove_file(&self.stdout_path);
        let _ = fs::remove_file(&self.stderr_path);
    }
}

fn run_bounded_python_helper(
    mut command: ProcessCommand,
    workspace_root: &Path,
) -> Result<Output, BoundedHelperError> {
    let (stdout, stderr, logs) = match create_bounded_helper_logs(workspace_root) {
        Ok(logs) => logs,
        Err(error) => return Err(BoundedHelperError::Started(error)),
    };
    let stdout_path = logs.stdout_path.clone();
    let stderr_path = logs.stderr_path.clone();
    command
        .stdin(Stdio::null())
        .stdout(Stdio::from(stdout))
        .stderr(Stdio::from(stderr));
    let mut child = match command.spawn() {
        Ok(child) => child,
        Err(error) => return Err(BoundedHelperError::Spawn(error)),
    };
    let deadline = Instant::now() + BOUNDED_PYTHON_HELPER_TIMEOUT;
    let status = loop {
        if let Err(error) = bounded_helper_log_size(&stdout_path, &stderr_path) {
            let cleanup = stop_bounded_helper(&mut child);
            return Err(BoundedHelperError::Started(combine_bounded_error(
                "Python helper log inspection failed",
                error,
                cleanup,
            )));
        }
        match child.try_wait() {
            Ok(Some(status)) => break status,
            Ok(None) => {
                let now = Instant::now();
                if now >= deadline {
                    let cleanup = stop_bounded_helper(&mut child);
                    return Err(BoundedHelperError::Started(
                        bounded_helper_failure_with_cleanup(
                            "Python helper exceeded the 30 second deadline",
                            cleanup,
                        ),
                    ));
                }
                let remaining = deadline.saturating_duration_since(now);
                thread::sleep(std::cmp::min(
                    BOUNDED_PYTHON_HELPER_POLL_INTERVAL,
                    remaining,
                ));
            }
            Err(error) => {
                let cleanup = stop_bounded_helper(&mut child);
                return Err(BoundedHelperError::Started(combine_bounded_error(
                    "Python helper status polling failed",
                    error,
                    cleanup,
                )));
            }
        }
    };
    if let Err(error) = bounded_helper_log_size(&stdout_path, &stderr_path) {
        return Err(BoundedHelperError::Started(ApiError::internal(format!(
            "Python helper log inspection failed after exit: {error}"
        ))));
    }
    let stdout = match read_bounded_helper_log(&stdout_path) {
        Ok(bytes) => bytes,
        Err(error) => return Err(BoundedHelperError::Started(error)),
    };
    let stderr = match read_bounded_helper_log(&stderr_path) {
        Ok(bytes) => bytes,
        Err(error) => return Err(BoundedHelperError::Started(error)),
    };
    drop(logs);
    Ok(Output {
        status,
        stdout,
        stderr,
    })
}

fn create_bounded_helper_logs(
    workspace_root: &Path,
) -> Result<(File, File, BoundedHelperLogGuard), ApiError> {
    let stdout_path = workspace_root.join(format!("python-helper-{}-stdout.log", uuid_v4_hex()));
    let stderr_path = workspace_root.join(format!("python-helper-{}-stderr.log", uuid_v4_hex()));
    let stdout = OpenOptions::new()
        .write(true)
        .create_new(true)
        .open(&stdout_path)
        .map_err(|error| {
            ApiError::internal(format!(
                "failed to create bounded Python helper stdout log: {error}"
            ))
        })?;
    let stderr = match OpenOptions::new()
        .write(true)
        .create_new(true)
        .open(&stderr_path)
    {
        Ok(file) => file,
        Err(error) => {
            let _ = fs::remove_file(&stdout_path);
            return Err(ApiError::internal(format!(
                "failed to create bounded Python helper stderr log: {error}"
            )));
        }
    };
    Ok((
        stdout,
        stderr,
        BoundedHelperLogGuard {
            stdout_path,
            stderr_path,
        },
    ))
}

fn bounded_helper_log_size(stdout_path: &Path, stderr_path: &Path) -> Result<u64, ApiError> {
    let stdout_size = bounded_helper_log_metadata(stdout_path, "stdout")?;
    let stderr_size = bounded_helper_log_metadata(stderr_path, "stderr")?;
    let combined = stdout_size
        .checked_add(stderr_size)
        .ok_or_else(|| ApiError::internal("Python helper log size overflow"))?;
    if combined > BOUNDED_PYTHON_HELPER_LOG_LIMIT {
        return Err(ApiError::internal(format!(
            "Python helper output exceeded the {} byte combined log limit",
            BOUNDED_PYTHON_HELPER_LOG_LIMIT
        )));
    }
    Ok(combined)
}

fn bounded_helper_log_metadata(path: &Path, stream: &str) -> Result<u64, ApiError> {
    let metadata = fs::symlink_metadata(path).map_err(|error| {
        ApiError::internal(format!(
            "failed to inspect bounded Python helper {stream} log: {error}"
        ))
    })?;
    if !metadata.file_type().is_file() {
        return Err(ApiError::internal(format!(
            "bounded Python helper {stream} log is not a regular file"
        )));
    }
    Ok(metadata.len())
}

fn read_bounded_helper_log(path: &Path) -> Result<Vec<u8>, ApiError> {
    bounded_helper_log_metadata(path, "captured")?;
    let mut file = File::open(path).map_err(|error| {
        ApiError::internal(format!("failed to read bounded Python helper log: {error}"))
    })?;
    let mut bytes = Vec::new();
    file.take(BOUNDED_PYTHON_HELPER_LOG_LIMIT + 1)
        .read_to_end(&mut bytes)
        .map_err(|error| {
            ApiError::internal(format!("failed to read Python helper log: {error}"))
        })?;
    if bytes.len() as u64 > BOUNDED_PYTHON_HELPER_LOG_LIMIT {
        return Err(ApiError::internal(
            "Python helper log exceeded the bounded read limit",
        ));
    }
    Ok(bytes)
}

fn stop_bounded_helper(child: &mut Child) -> Result<(), String> {
    let kill_error = match child.kill() {
        Ok(()) => None,
        Err(error) if error.kind() == io::ErrorKind::NotFound => None,
        Err(error) => Some(format!("kill failed: {error}")),
    };
    let wait_error = child
        .wait()
        .err()
        .map(|error| format!("wait failed: {error}"));
    match (kill_error, wait_error) {
        (None, None) => Ok(()),
        (Some(kill), None) => Err(kill),
        (None, Some(wait)) => Err(wait),
        (Some(kill), Some(wait)) => Err(format!("{kill}; {wait}")),
    }
}

fn bounded_helper_failure_with_cleanup(message: &str, cleanup: Result<(), String>) -> ApiError {
    match cleanup {
        Ok(()) => ApiError::internal(message),
        Err(cleanup) => ApiError::internal(format!("{message}; process cleanup failed: {cleanup}")),
    }
}

fn combine_bounded_error<E: std::fmt::Display>(
    message: &str,
    error: E,
    cleanup: Result<(), String>,
) -> ApiError {
    match cleanup {
        Ok(()) => ApiError::internal(format!("{message}: {error}")),
        Err(cleanup) => ApiError::internal(format!(
            "{message}: {error}; process cleanup failed: {cleanup}"
        )),
    }
}

#[cfg(test)]
mod tests {
    use super::*;
    use crate::artifacts::{parse_eigen_dispersion_csv, sanitize_artifact_relative_path};
    use axum::http::StatusCode;

    #[tokio::test]
    async fn generated_scene_sync_reexports_new_run_stage_and_preserves_explicit_rewrite() {
        let mut state = crate::router_v2::tests::test_app_state_with_live_session().await;
        let workspace =
            std::env::temp_dir().join(format!("fullmag-generated-sync-{}", uuid_v4_hex()));
        {
            let state_mut = Arc::get_mut(&mut state).expect("unique test state");
            state_mut.repo_root = repo_root();
            state_mut.current_workspace_root = workspace.clone();
        }
        {
            let mut current = state.current_live_state.write().await;
            let snapshot = current.as_mut().expect("live snapshot");
            snapshot.session.script_path.clear();
            snapshot.scene_document = Some(
                serde_json::from_value(serde_json::json!({
                    "version": "scene.v2", "revision": 1,
                    "scene": {"name": "generated_sync_waveguide"},
                    "objects": [{
                        "id": "waveguide", "name": "waveguide", "role": "magnet",
                        "geometry": {"geometry_kind": "Box",
                            "geometry_params": {"size": [100e-9, 40e-9, 10e-9]}},
                        "material_ref": "permalloy", "magnetization_ref": "uniform"
                    }],
                    "materials": [{"id": "permalloy", "name": "Permalloy",
                        "properties": {"Ms": 800e3, "Aex": 13e-12, "alpha": 0.02}}],
                    "magnetization_assets": [{"id": "uniform", "name": "Uniform",
                        "kind": "preset_texture", "preset_kind": "uniform",
                        "preset_params": {"direction": [1.0, 0.0, 0.0]}, "preset_version": 1}],
                    "study": {"backend": "fdm", "requested_backend": "fdm",
                        "requested_device": "cpu", "requested_precision": "double",
                        "fdm": {"default_cell": [10e-9, 10e-9, 10e-9]}}
                }))
                .expect("FDM waveguide authoring scene"),
            );
        }
        let first =
            sync_current_live_script_with_request(&state, ScriptSyncRequest { overrides: None })
                .await
                .expect("initial generated sync");
        assert_eq!(first.source_kind, "scene_document");
        {
            let mut current = state.current_live_state.write().await;
            let scene = current.as_mut().unwrap().scene_document.as_mut().unwrap();
            scene.revision += 1;
            scene.study.stages = serde_json::from_value(serde_json::json!([{
                "kind": "run", "entrypoint_kind": "flat_run",
                "until_seconds": "1e-12", "fixed_timestep": "1e-13"
            }]))
            .expect("Run stage");
        }
        let second =
            sync_current_live_script_with_request(&state, ScriptSyncRequest { overrides: None })
                .await
                .expect("generated re-export");
        assert_eq!(second.source_kind, "scene_document");
        assert_eq!(second.script_path, first.script_path);
        assert!(fs::read_to_string(&second.script_path)
            .unwrap()
            .contains("study.stages.add_run("));
        let explicit = sync_current_live_script_with_request(
            &state,
            ScriptSyncRequest {
                overrides: Some(serde_json::json!({})),
            },
        )
        .await
        .expect("explicit overrides must use rewrite");
        assert_eq!(explicit.source_kind, "flat_script");
        assert!(explicit.source_script_modified);
        fs::remove_dir_all(workspace).expect("remove test workspace");
    }

    #[tokio::test]
    async fn explicit_overrides_without_input_script_are_rejected() {
        let state = crate::router_v2::tests::test_app_state_with_live_session().await;
        state
            .current_live_state
            .write()
            .await
            .as_mut()
            .unwrap()
            .session
            .script_path
            .clear();
        let error = sync_current_live_script_with_request(
            &state,
            ScriptSyncRequest {
                overrides: Some(serde_json::json!({})),
            },
        )
        .await
        .expect_err("overrides cannot be silently ignored without a source script");
        assert_eq!(error.status, StatusCode::BAD_REQUEST);
    }

    #[test]
    fn sanitize_artifact_relative_path_rejects_parent_segments() {
        let error = sanitize_artifact_relative_path("../secret.json")
            .expect_err("parent segments must be rejected");
        assert_eq!(error.status, StatusCode::BAD_REQUEST);
    }

    #[test]
    fn parse_eigen_dispersion_csv_decodes_rows() {
        let csv =
            "mode_index,kx,ky,kz,frequency_hz,angular_frequency_rad_per_s\n0,0.0,1.0,2.0,3.0,4.0\n";
        let rows = parse_eigen_dispersion_csv(csv).expect("csv should parse");
        assert_eq!(
            rows,
            vec![EigenDispersionRow {
                mode_index: 0,
                kx: 0.0,
                ky: 1.0,
                kz: 2.0,
                frequency_hz: 3.0,
                angular_frequency_rad_per_s: 4.0,
            }]
        );
    }

    #[test]
    fn parse_eigen_dispersion_csv_decodes_canonical_v2_rows() {
        let csv = "sample_index,path_s_rad_per_m,kx_rad_per_m,ky_rad_per_m,kz_rad_per_m,label,raw_mode_index,branch_id,frequency_hz,omega_rad_s,line_width_hz,residual_norm,overlap_score\n3,1.0,1.0,2.0,3.0,X,7,4,1500000000.0,9424777960.77,0.0,1e-9,0.99\n";
        let rows = parse_eigen_dispersion_csv(csv).expect("csv should parse");
        assert_eq!(
            rows,
            vec![EigenDispersionRow {
                mode_index: 7,
                kx: 1.0,
                ky: 2.0,
                kz: 3.0,
                frequency_hz: 1.5e9,
                angular_frequency_rad_per_s: 9424777960.77,
            }]
        );
    }

    #[test]
    fn parse_eigen_dispersion_csv_rejects_short_rows() {
        let error = parse_eigen_dispersion_csv(
            "mode_index,kx,ky,kz,frequency_hz,angular_frequency_rad_per_s\n0,1,2\n",
        )
        .expect_err("short rows must fail");
        assert_eq!(error.status, StatusCode::INTERNAL_SERVER_ERROR);
    }

    #[test]
    fn script_builder_state_deserializes_mesh_without_adaptive_fields() {
        let builder: ScriptBuilderState = serde_json::from_value(serde_json::json!({
            "revision": 1,
            "solver": {
                "integrator": "rk45",
                "fixed_timestep": "",
                "relax_algorithm": "llg_overdamped",
                "torque_tolerance": "1e-4",
                "energy_tolerance": "",
                "max_relax_steps": "1000"
            },
            "mesh": {
                "algorithm_2d": 6,
                "algorithm_3d": 1,
                "hmax": "",
                "hmin": "",
                "size_factor": 1.0,
                "size_from_curvature": 0,
                "smoothing_steps": 1,
                "optimize": "",
                "optimize_iterations": 1,
                "compute_quality": false,
                "per_element_quality": false
            },
            "geometries": []
        }))
        .expect("builder draft without adaptive fields should deserialize");

        assert!(!builder.mesh.adaptive_enabled);
        assert_eq!(builder.mesh.adaptive_policy, "manual");
        assert_eq!(builder.mesh.adaptive_theta, 0.3);
        assert_eq!(builder.mesh.adaptive_max_passes, 5);
        assert_eq!(builder.mesh.growth_rate, "");
        assert_eq!(builder.mesh.narrow_regions, 0);
    }

    #[test]
    fn planar_monitor_round_trip_survives_api_scene_projection() {
        let scene: SceneDocument = serde_json::from_value(serde_json::json!({
            "version": "scene.v2",
            "revision": 7,
            "monitors": {
                "planar": [{
                    "id": "domain-plane",
                    "name": "Domain plane",
                    "target": {"kind": "domain"},
                    "frame": {
                        "origin_m": [0.0, 0.0, 0.0],
                        "u_axis": [1.0, 0.0, 0.0],
                        "v_axis": [0.0, 1.0, 0.0],
                        "normal": [0.0, 0.0, 1.0],
                        "preset": "xy",
                        "normalization_version": "planar_frame_v1",
                        "extent": {"kind": "universe", "padding_m": 0.0}
                    },
                    "operator": {
                        "kind": "depth_projection",
                        "reduction": "mean_occupied",
                        "empty_policy": "exclude_empty"
                    }
                }]
            }
        }))
        .expect("planar scene should deserialize");

        let builder =
            scene_document_builder_projection(&scene).expect("scene projection should validate");
        let overrides = scene_document_overrides(&scene).expect("overrides should build");

        assert_eq!(builder.revision, 7);
        assert_eq!(builder.planar_monitors, scene.monitors.planar);
        assert_eq!(
            overrides["planar_monitors"][0]["id"],
            serde_json::json!("domain-plane")
        );
        assert!(overrides["planar_monitors"][0].get("quantity").is_none());
        assert!(overrides["planar_monitors"][0].get("resolution").is_none());
    }

    #[test]
    fn load_scene_document_state_preserves_script_object_regions() {
        let root = repo_root();
        let script_path =
            std::env::temp_dir().join(format!("fullmag-region-export-{}.py", uuid_v4_hex()));
        std::fs::write(
            &script_path,
            r#"
import fullmag as fm

study = fm.study("region_export")
study.engine("fem")
body = study.geometry(
    fm.Box(300e-9, 1000e-9, 30e-9) - fm.Cylinder(radius=40e-9, height=30e-9),
    name="permalloy_box",
)
body.Ms = 800e3
body.Aex = 13e-12
body.alpha = 0.5
body.mesh(minimum_element_size=8e-9, maximum_element_size=50e-9, order=1)
hole_refinement = body.add_region(
    "hole_refinement",
    fm.Cylinder(radius=70e-9, height=30e-9),
    priority=10,
    realization_policy="conformal",
)
hole_refinement.mesh(minimum_element_size=0.5e-9, maximum_element_size=1e-9, order=1)
"#,
        )
        .expect("failed to write region export fixture");
        let scene = load_scene_document_state(&root, &root, &script_path)
            .expect("permalloy script should export a scene document");
        let _ = std::fs::remove_file(&script_path);
        let object = scene
            .objects
            .iter()
            .find(|object| object.id == "permalloy_box")
            .expect("permalloy_box object should be exported");
        let region = object
            .regions
            .iter()
            .find(|region| region.name == "hole_refinement")
            .expect("hole_refinement region should be exported");

        assert_eq!(region.region_id, "permalloy_box:r1");
        assert_eq!(region.owner_object, "permalloy_box");
        assert_eq!(
            region.realization_policy,
            fullmag_authoring::SceneRegionRealizationPolicy::Conformal
        );
        assert_eq!(
            region
                .mesh_policy
                .as_ref()
                .expect("hole_refinement region should include mesh policy")
                .maximum_element_size,
            Some(1.0e-9)
        );
    }

    #[test]
    fn load_scene_document_state_accepts_frequency_response_stage() {
        let root = repo_root();
        let script_path = root.join("examples/fem_frequency_response_smoke.py");
        let scene = load_scene_document_state(&root, &root, &script_path)
            .expect("frequency-response script should export a scene document");

        assert!(
            scene
                .study
                .stages
                .iter()
                .any(|stage| stage.kind == "frequency_response"),
            "scene document should preserve the frequency_response stage"
        );
        let pipeline = scene
            .study
            .study_pipeline
            .as_ref()
            .expect("frequency-response scene should include a study pipeline");
        assert!(
            pipeline.nodes.iter().any(|node| {
                matches!(
                    node,
                    fullmag_authoring::StudyPipelineNode::Primitive(stage)
                        if stage.stage_kind
                            == fullmag_authoring::StudyPrimitiveStageKind::FrequencyResponse
                )
            }),
            "study pipeline should deserialize frequency_response primitive stage"
        );
    }

    #[test]
    fn load_scene_document_state_accepts_change_device_stage() {
        let root = repo_root();
        let script_path =
            std::env::temp_dir().join(format!("fullmag-change-device-{}.py", uuid_v4_hex()));
        std::fs::write(
            &script_path,
            r#"
import fullmag as fm

study = fm.study("stage_change_device")
study.engine("fem")
study.device("gpu", precision="double")
body = study.geometry(fm.Box(100e-9, 20e-9, 5e-9), name="track")
body.Ms = 800e3
body.Aex = 13e-12
body.alpha = 0.1
body.m = fm.texture.uniform(1, 0, 0)
study.stages.add_relax(max_steps=25, dt=1e-15)
study.stages.change_device("cpu")
study.stages.add_eigenmodes(count=4)
"#,
        )
        .expect("failed to write change-device fixture");
        let scene = load_scene_document_state(&root, &root, &script_path)
            .expect("change-device script should export a scene document");
        let _ = std::fs::remove_file(&script_path);

        let pipeline = scene
            .study
            .study_pipeline
            .as_ref()
            .expect("change-device scene should include a study pipeline");
        assert!(
            pipeline.nodes.iter().any(|node| {
                matches!(
                    node,
                    fullmag_authoring::StudyPipelineNode::Primitive(stage)
                        if stage.stage_kind
                            == fullmag_authoring::StudyPrimitiveStageKind::ChangeDevice
                            && stage
                                .payload
                                .get("device")
                                .and_then(|value| value.as_str())
                                == Some("cpu")
                )
            }),
            "study pipeline should deserialize change_device primitive stage"
        );
    }
}
