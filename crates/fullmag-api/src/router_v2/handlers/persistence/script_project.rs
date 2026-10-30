//! Script to project: `POST /v2/persistence/projects/from-script`.
//!
//! The operation EXECUTES the supplied Python in the Fullmag helper (the same
//! trust model as a script run), so the request must carry an explicit consent
//! flag. The script is written to a private temporary directory in managed
//! storage, `export-scene-document` turns it into a `scene.v2` document and the
//! result is wrapped in a runtime-free project that embeds the original script
//! as opaque documents (`project/source/script.py`, `script.json`) and records
//! the import in `project/provenance.json`.
//!
//! The scene is an approximation of what the script does: scene to script round
//! trips fail for some real scripts. The response therefore carries a
//! `fidelity` verdict computed by re-rendering the scene to Python and
//! comparing the key physics fields of both lowerings.

use axum::{extract::State, http::StatusCode, Json};
use chrono::{SecondsFormat, Utc};
use fullmag_application::{
    CreateProjectRequest, FileProjectRepository, OpaqueDocument, ProjectApplication,
    RawJsonEnvelope,
};
use fullmag_authoring::{validate_scene_document_for_authoring, SceneDocument};
use serde_json::{json, Value};
use sha2::{Digest, Sha256};
use std::fs;
use std::path::{Path as FsPath, PathBuf};
use std::sync::Arc;

use super::projects::{encode_current, resource_from_application};
use crate::error::ApiError;
use crate::schemas::projects::{
    ProjectFromScriptRequest, ProjectFromScriptResource, ProjectScriptImportResource,
    ScriptFidelityResource, ScriptRoundTripState, PROJECT_ARCHIVE_MAX_BYTES,
    SCRIPT_IMPORT_MAX_BYTES,
};
use crate::types::AppState;

pub(crate) const EMBEDDED_SCRIPT_PATH: &str = "project/source/script.py";
pub(crate) const EMBEDDED_SCRIPT_META_PATH: &str = "project/source/script.json";
pub(crate) const PROVENANCE_PATH: &str = "project/provenance.json";
const DEFAULT_ORIGIN: &str = "script";
const MAX_ORIGIN_CHARS: usize = 200;
const MAX_NOTE_CHARS: usize = 400;
const MAX_STDERR_CHARS: usize = 2000;

#[utoipa::path(
    post,
    path = "/v2/persistence/projects/from-script",
    request_body = ProjectFromScriptRequest,
    responses(
        (status = 201, description = "Project created from the script, with the original script embedded and a fidelity verdict", body = ProjectFromScriptResource),
        (status = 400, description = "Missing consent, missing source, invalid name or unsupported script_item_id"),
        (status = 413, description = "Script text exceeds 1 MiB"),
        (status = 422, description = "The helper could not export a scene document from the script; nothing is kept")
    ),
    tag = "persistence"
)]
pub async fn from_script(
    State(state): State<Arc<AppState>>,
    Json(request): Json<ProjectFromScriptRequest>,
) -> Result<(StatusCode, Json<ProjectFromScriptResource>), ApiError> {
    if !request
        .consent
        .as_ref()
        .is_some_and(|consent| consent.executed_by_user)
    {
        return Err(ApiError::with_status_and_code(
            StatusCode::BAD_REQUEST,
            "consent_required",
            "creating a project from a script executes the script; \
             consent.executed_by_user must be true",
        ));
    }
    if request.script_item_id.is_some() {
        return Err(ApiError::with_status_and_code(
            StatusCode::BAD_REQUEST,
            "script_item_unsupported",
            "script_item_id is not supported by the API; send the script text as source",
        ));
    }
    let source = request.source.ok_or_else(|| {
        ApiError::with_status_and_code(
            StatusCode::BAD_REQUEST,
            "source_required",
            "source {name, text} is required",
        )
    })?;
    if source.name.trim().is_empty() {
        return Err(ApiError::bad_request("source.name must not be empty"));
    }
    if source.text.len() > SCRIPT_IMPORT_MAX_BYTES {
        return Err(ApiError::with_status_and_code(
            StatusCode::PAYLOAD_TOO_LARGE,
            "script_too_large",
            format!(
                "script text is {} bytes; the limit is {} bytes",
                source.text.len(),
                SCRIPT_IMPORT_MAX_BYTES
            ),
        ));
    }
    if source.text.contains('\0') {
        return Err(ApiError::bad_request(
            "source.text must not contain NUL characters",
        ));
    }
    let origin = request
        .origin
        .map(|value| value.trim().to_string())
        .filter(|value| !value.is_empty())
        .unwrap_or_else(|| DEFAULT_ORIGIN.to_string());
    if origin.chars().count() > MAX_ORIGIN_CHARS || origin.chars().any(char::is_control) {
        return Err(ApiError::bad_request("origin is too long or has control characters"));
    }
    let project_name = request
        .project_name
        .map(|value| value.trim().to_string())
        .filter(|value| !value.is_empty())
        .unwrap_or_else(|| script_stem(&source.name));

    let repo_root = state.repo_root.clone();
    let workspace_root = state.current_workspace_root.clone();
    let resource = tokio::task::spawn_blocking(move || {
        build_project_from_script(
            &repo_root,
            &workspace_root,
            &source.name,
            source.text.into_bytes(),
            &project_name,
            &origin,
        )
    })
    .await
    .map_err(|error| ApiError::internal(format!("script project task failed: {error}")))??;
    Ok((StatusCode::CREATED, Json(resource)))
}

/// File stem of a user-supplied name, reduced to a safe project name.
fn script_stem(name: &str) -> String {
    let leaf = name.rsplit(['/', '\\']).next().unwrap_or(name);
    let stem = leaf.rsplit_once('.').map_or(leaf, |(stem, _)| stem).trim();
    if stem.is_empty() {
        "script".to_string()
    } else {
        stem.to_string()
    }
}

/// A file name that is safe inside the private directory and keeps the stem
/// the script would have had (helper metadata derives names from it).
fn safe_script_file_name(name: &str) -> String {
    let stem: String = script_stem(name)
        .chars()
        .map(|character| {
            if character.is_alphanumeric() || character == '_' || character == '-' {
                character
            } else {
                '_'
            }
        })
        .collect();
    let stem = stem.trim_matches('_');
    format!("{}.py", if stem.is_empty() { "script" } else { stem })
}

struct PrivateDirGuard(PathBuf);

impl Drop for PrivateDirGuard {
    fn drop(&mut self) {
        // The directory is created by this request with a unique name and only
        // holds the script, helper logs and helper outputs.
        let _ = fs::remove_dir_all(&self.0);
    }
}

fn tail_chars(text: &str, limit: usize) -> String {
    let trimmed = text.trim();
    let count = trimmed.chars().count();
    if count <= limit {
        trimmed.to_string()
    } else {
        let skipped: String = trimmed.chars().skip(count - limit).collect();
        format!("...{skipped}")
    }
}

/// The last non-empty line of a Python traceback is the exception itself; a
/// round-trip note quotes that line, not the whole stack.
fn exception_summary(text: &str) -> String {
    let line = text
        .lines()
        .rev()
        .map(str::trim)
        .find(|line| !line.is_empty())
        .unwrap_or("no message");
    head_chars(line, MAX_NOTE_CHARS)
}

fn head_chars(text: &str, limit: usize) -> String {
    let count = text.chars().count();
    if count <= limit {
        text.to_string()
    } else {
        format!("{}...", text.chars().take(limit).collect::<String>())
    }
}

/// Map a failed helper invocation. Script faults (non-zero exit, deadline, log
/// overflow) become a typed 422; a missing interpreter stays a server error.
fn script_failure_from_run_error(error: ApiError, action: &str) -> ApiError {
    let message = error.message.clone();
    if message.contains("deadline") {
        return ApiError::with_status_and_code(
            StatusCode::UNPROCESSABLE_ENTITY,
            "script_export_timeout",
            format!("{action}: {message}"),
        );
    }
    if message.contains("log") && message.contains("limit") {
        return ApiError::with_status_and_code(
            StatusCode::UNPROCESSABLE_ENTITY,
            "script_export_too_large",
            format!("{action}: {message}"),
        );
    }
    error
}

/// Parse the helper's JSON answer. A script that prints to stdout must not
/// break the export, so the last non-empty line is the answer.
fn parse_helper_json(stdout: &[u8]) -> Result<Value, String> {
    let text = String::from_utf8_lossy(stdout);
    let line = text
        .lines()
        .rev()
        .find(|line| !line.trim().is_empty())
        .ok_or_else(|| "the helper printed nothing".to_string())?;
    serde_json::from_str(line).map_err(|error| format!("the helper answer is not JSON ({error})"))
}

fn helper_args(subcommand: &str, script: &FsPath, extra: &[&str]) -> Vec<String> {
    let mut args = vec![
        "-m".to_string(),
        "fullmag.runtime.helper".to_string(),
        subcommand.to_string(),
        "--script".to_string(),
        script.display().to_string(),
    ];
    args.extend(extra.iter().map(|value| (*value).to_string()));
    args
}

/// Run a script-executing helper command. `Ok(Err(stderr))` is a script fault.
fn run_script_helper(
    repo_root: &FsPath,
    private_dir: &FsPath,
    args: &[String],
    action: &str,
) -> Result<Result<Value, String>, ApiError> {
    let output = crate::script::run_python_helper_bounded(repo_root, private_dir, args)
        .map_err(|error| script_failure_from_run_error(error, action))?;
    if !output.status.success() {
        let stderr = String::from_utf8_lossy(&output.stderr);
        return Ok(Err(tail_chars(&stderr, MAX_STDERR_CHARS)));
    }
    match parse_helper_json(&output.stdout) {
        Ok(value) => Ok(Ok(value)),
        Err(reason) => Ok(Err(reason)),
    }
}

fn build_project_from_script(
    repo_root: &FsPath,
    workspace_root: &FsPath,
    script_name: &str,
    script_bytes: Vec<u8>,
    project_name: &str,
    origin: &str,
) -> Result<ProjectFromScriptResource, ApiError> {
    fs::create_dir_all(workspace_root).map_err(|error| {
        ApiError::internal(format!("failed to prepare script import workspace: {error}"))
    })?;
    let private_dir = workspace_root.join(format!(".fullmag-script-import-{}", crate::uuid_v4_hex()));
    fs::create_dir(&private_dir).map_err(|error| {
        ApiError::internal(format!("failed to create private script import directory: {error}"))
    })?;
    let _guard = PrivateDirGuard(private_dir.clone());
    let script_path = private_dir.join(safe_script_file_name(script_name));
    fs::write(&script_path, &script_bytes).map_err(|error| {
        ApiError::internal(format!("failed to write the private script copy: {error}"))
    })?;
    // Both evaluations of the original read these accepted bytes, so a script
    // that rewrites its own file cannot change what the second helper runs.
    // `--script` stays the logical origin (asset root, `__file__`).
    let source_snapshot = private_dir.join(".fullmag-source-snapshot.bin");
    fs::write(&source_snapshot, &script_bytes).map_err(|error| {
        ApiError::internal(format!("failed to write the private source snapshot: {error}"))
    })?;
    let source_snapshot_arg = source_snapshot.display().to_string();

    // 1. Export the scene. This executes the script: failure keeps nothing.
    let export_args = helper_args(
        "export-scene-document",
        &script_path,
        &["--source-snapshot", &source_snapshot_arg],
    );
    let scene_value = match run_script_helper(
        repo_root,
        &private_dir,
        &export_args,
        "scene export",
    )? {
        Ok(value) => value,
        Err(stderr) => {
            return Err(ApiError::with_status_and_code(
                StatusCode::UNPROCESSABLE_ENTITY,
                "script_export_failed",
                format!("the script could not be exported to a scene document: {stderr}"),
            ));
        }
    };
    if scene_value.get("version").and_then(Value::as_str) != Some("scene.v2") {
        return Err(ApiError::with_status_and_code(
            StatusCode::UNPROCESSABLE_ENTITY,
            "script_export_failed",
            "the helper did not return a scene.v2 document",
        ));
    }
    let scene_document: SceneDocument =
        serde_json::from_value(scene_value.clone()).map_err(|error| {
            ApiError::with_status_and_code(
                StatusCode::UNPROCESSABLE_ENTITY,
                "script_export_failed",
                format!("the exported scene document is not valid: {error}"),
            )
        })?;

    // 2. Fidelity: a verdict, never an assumption.
    let mut fidelity = check_round_trip(
        repo_root,
        &private_dir,
        &script_path,
        &source_snapshot,
        &scene_document,
    );
    if let Err(error) = validate_scene_document_for_authoring(&scene_document) {
        fidelity.notes.push(format!(
            "the exported scene does not pass authoring validation: {}",
            head_chars(&error.to_string(), MAX_NOTE_CHARS)
        ));
    }

    // Return the canonical scene without a parallel browser ZIP parser.
    let activation_scene = scene_value.as_object()
        .ok_or_else(|| ApiError::internal("exported scene is not an object"))?
        .iter().map(|(key, value)| (key.clone(), value.clone())).collect();

    // 3. Build the project: scene, embedded script, metadata, provenance.
    let sha256 = format!("{:x}", Sha256::digest(&script_bytes));
    let sha12 = &sha256[..12];
    let exported_at = Utc::now().to_rfc3339_opts(SecondsFormat::Secs, true);
    let script_leaf = script_name.rsplit(['/', '\\']).next().unwrap_or(script_name);

    let mut application = ProjectApplication::new(FileProjectRepository::new());
    let created = application
        .create(CreateProjectRequest::new(project_name.to_string()))
        .map_err(|error| ApiError::bad_request(format!("invalid_project_document: {error}")))?;
    let mut draft = application
        .current_document()
        .cloned()
        .ok_or_else(|| ApiError::internal("project application has no current document"))?;
    draft
        .replace_scene(
            RawJsonEnvelope::from_value(scene_value)
                .map_err(|error| ApiError::bad_request(format!("invalid scene document: {error}")))?,
        )
        .map_err(|error| ApiError::bad_request(format!("invalid scene document: {error}")))?;

    let fidelity_json = json!({
        "scene_exported": fidelity.scene_exported,
        "round_trip": fidelity.round_trip,
        "notes": fidelity.notes,
    });
    let script_meta = json!({
        "schema": "fullmag.script_source.v1",
        "sha256": sha256,
        "name": script_leaf,
        "origin": origin,
        "exported_at": exported_at,
        "fidelity": fidelity_json,
    });
    let provenance = json!({
        "authors": [],
        "history": [{
            "revision": created.revision,
            "at": exported_at,
            "kind": "import",
            "summary": format!("Created from script {script_leaf} ({sha12})"),
        }],
        "runs": [],
    });
    let to_bytes = |value: &Value| {
        serde_json::to_vec_pretty(value)
            .map_err(|error| ApiError::internal(format!("failed to serialize metadata: {error}")))
    };
    for (path, bytes) in [
        (EMBEDDED_SCRIPT_PATH, script_bytes.clone()),
        (EMBEDDED_SCRIPT_META_PATH, to_bytes(&script_meta)?),
        (PROVENANCE_PATH, to_bytes(&provenance)?),
    ] {
        draft.opaque_documents.push(
            OpaqueDocument::new(path, bytes)
                .map_err(|error| ApiError::internal(format!("invalid entry path: {error}")))?,
        );
    }
    draft
        .validate_for_save()
        .map_err(|error| ApiError::bad_request(format!("invalid project archive: {error}")))?;
    let view = application
        .replace_draft(draft, created.revision)
        .map_err(super::projects::map_authoring_application_error)?;
    let archive = encode_current(&application)?;
    if archive.len() > PROJECT_ARCHIVE_MAX_BYTES {
        return Err(ApiError::bad_request(format!(
            "project archive exceeds {PROJECT_ARCHIVE_MAX_BYTES} byte transport limit"
        )));
    }
    let project = resource_from_application(&application, view, archive)?;
    Ok(ProjectFromScriptResource {
        scene_document: Some(activation_scene),
        project,
        script_import: ProjectScriptImportResource {
            name: script_leaf.to_string(),
            sha256,
            origin: origin.to_string(),
            exported_at,
            script_path: EMBEDDED_SCRIPT_PATH.to_string(),
            fidelity,
        },
    })
}

/// Re-render the scene to Python and compare the lowering of the original
/// script with the lowering of the re-rendered one. Both go through the
/// lightweight `export-run-config` so grid, materials and study stages are
/// comparable. The study pipeline document is not compared: it carries import
/// metadata that a scene-derived script never reproduces; the stage list covers
/// what it describes.
fn check_round_trip(
    repo_root: &FsPath,
    private_dir: &FsPath,
    script_path: &FsPath,
    source_snapshot: &FsPath,
    scene_document: &SceneDocument,
) -> ScriptFidelityResource {
    let mut fidelity = ScriptFidelityResource {
        scene_exported: true,
        round_trip: ScriptRoundTripState::NotChecked,
        notes: Vec::new(),
    };
    let lowered_original = match lower_script(
        repo_root,
        private_dir,
        script_path,
        Some(source_snapshot),
        "original script",
    ) {
        Ok(value) => value,
        Err(message) => {
            fidelity.notes.push(format!(
                "round trip not checked: the original script could not be lowered to ProblemIR ({message})"
            ));
            return fidelity;
        }
    };

    let rendered_path = private_dir.join("roundtrip_rendered.py");
    if let Err(error) = crate::script::render_scene_document_via_python_helper_bounded(
        repo_root,
        private_dir,
        &rendered_path,
        scene_document,
    ) {
        fidelity.round_trip = ScriptRoundTripState::Failed;
        fidelity.notes.push(format!(
            "the scene could not be rendered back to Python: {}",
            exception_summary(&error.message)
        ));
        return fidelity;
    }
    let lowered_rendered = match lower_script(
        repo_root,
        private_dir,
        &rendered_path,
        None,
        "rendered script",
    ) {
        Ok(value) => value,
        Err(message) => {
            fidelity.round_trip = ScriptRoundTripState::Failed;
            fidelity.notes.push(format!(
                "the scene rendered back to Python does not load: {message}"
            ));
            return fidelity;
        }
    };

    let mismatches = compare_lowered(&lowered_original, &lowered_rendered);
    if mismatches.is_empty() {
        fidelity.round_trip = ScriptRoundTripState::Verified;
        fidelity.notes.push(
            "compared with a second evaluation of the original script: geometry, materials, magnets and initial state, regions, FDM grid, FEM mesh policy, runtime request, study dynamics and stages; exact antenna and transport declarations in the model, stages and authoring inventory"
                .to_string(),
        );
    } else {
        fidelity.round_trip = ScriptRoundTripState::Failed;
        fidelity.notes.extend(mismatches);
    }
    fidelity
}

fn lower_script(
    repo_root: &FsPath,
    private_dir: &FsPath,
    script: &FsPath,
    source_snapshot: Option<&FsPath>,
    label: &str,
) -> Result<Value, String> {
    let snapshot_arg = source_snapshot.map(|path| path.display().to_string());
    let mut extra = vec!["--skip-geometry-assets"];
    if let Some(snapshot) = snapshot_arg.as_deref() {
        extra.extend(["--source-snapshot", snapshot]);
    }
    let args = helper_args("export-run-config", script, &extra);
    match run_script_helper(repo_root, private_dir, &args, label) {
        Ok(Ok(value)) => Ok(value),
        Ok(Err(stderr)) => Err(exception_summary(&stderr)),
        Err(error) => Err(exception_summary(&error.message)),
    }
}

fn numbers_close(a: f64, b: f64) -> bool {
    let scale = a.abs().max(b.abs());
    (a - b).abs() <= 1e-9 * scale.max(f64::MIN_POSITIVE)
}

/// Structural JSON equality with a relative tolerance for numbers; keys in
/// `ignored` (such as generated names) are skipped in objects.
fn json_close(a: &Value, b: &Value, ignored: &[&str]) -> bool {
    match (a, b) {
        (Value::Number(x), Value::Number(y)) => match (x.as_f64(), y.as_f64()) {
            (Some(x), Some(y)) => numbers_close(x, y),
            _ => x == y,
        },
        (Value::Array(x), Value::Array(y)) => {
            x.len() == y.len() && x.iter().zip(y).all(|(x, y)| json_close(x, y, ignored))
        }
        (Value::Object(x), Value::Object(y)) => {
            let keys = |map: &serde_json::Map<String, Value>| {
                map.keys()
                    .filter(|key| !ignored.contains(&key.as_str()))
                    .cloned()
                    .collect::<std::collections::BTreeSet<_>>()
            };
            let (kx, ky) = (keys(x), keys(y));
            kx == ky && kx.iter().all(|key| json_close(&x[key], &y[key], ignored))
        }
        _ => a == b,
    }
}

fn pointer<'a>(value: &'a Value, path: &str) -> &'a Value {
    value.pointer(path).unwrap_or(&Value::Null)
}

fn mismatch(field: &str, original: &Value, rendered: &Value) -> String {
    format!(
        "{field} differs: original {} versus re-rendered {}",
        head_chars(&original.to_string(), MAX_NOTE_CHARS / 2),
        head_chars(&rendered.to_string(), MAX_NOTE_CHARS / 2)
    )
}

/// Canonicalisation 1: a `translate` wrapper whose offset is the zero vector
/// does not move anything, so it is replaced by its base geometry. The scene
/// renderer writes geometries without such a no-op wrapper.
fn strip_zero_translations(value: &Value) -> Value {
    match value {
        Value::Object(map) => {
            let is_zero_translate = map.get("kind").and_then(Value::as_str) == Some("translate")
                && map
                    .get("by")
                    .and_then(Value::as_array)
                    .is_some_and(|by| by.iter().all(|item| item.as_f64() == Some(0.0)));
            if is_zero_translate {
                if let Some(base) = map.get("base") {
                    return strip_zero_translations(base);
                }
            }
            Value::Object(
                map.iter()
                    .map(|(key, item)| (key.clone(), strip_zero_translations(item)))
                    .collect(),
            )
        }
        Value::Array(items) => Value::Array(items.iter().map(strip_zero_translations).collect()),
        other => other.clone(),
    }
}

/// Canonicalisation 2: a Zeeman term with the zero field vector contributes no
/// field and no energy, so it equals the absence of the term. A script that
/// never sets an external field and a scene whose external field is zero must
/// not be reported as different. Non-zero fields are always compared.
fn without_zero_zeeman(terms: &Value) -> Value {
    match terms.as_array() {
        Some(items) => Value::Array(
            items
                .iter()
                .filter(|term| {
                    let is_zeeman = term.get("kind").and_then(Value::as_str) == Some("zeeman");
                    let zero_field = term
                        .get("B")
                        .and_then(Value::as_array)
                        .is_some_and(|b| b.iter().all(|item| item.as_f64() == Some(0.0)));
                    !(is_zeeman && zero_field)
                })
                .cloned()
                .collect(),
        ),
        None => terms.clone(),
    }
}

/// Preserve authored source identities, parameter values and field presence.
/// Both inputs are canonical Python helper exports: missing, null and empty
/// collections are distinct, and integer identifiers never pass through f64.
fn antenna_transport_summary(document: &Value) -> Value {
    let ir = pointer(document, "/ir");
    let fields = [
        "field_drives",
        "antenna_port_modes",
        "antenna_field_solve_stages",
        "antenna_target_projections",
        "solved_antenna_drives",
        "antenna_spectrum_requests",
        "current_modules",
        "spin_transport_modules",
        "spin_torque_modules",
        "current_density",
        "stt_degree",
        "stt_spin_polarization",
        "stt_lambda",
        "stt_epsilon_prime",
        "stt_fixed_layer_position",
        "stt_thickness",
        "stt_beta",
        "material_parameter_fields",
        "physics_graph",
        "physics_objects",
        "excitation_analysis",
    ]
    .into_iter()
    .filter_map(|key| ir.get(key).map(|value| (key.to_string(), value.clone())))
    .collect::<serde_json::Map<String, Value>>();
    let mut summary = serde_json::Map::new();
    summary.insert("ir".to_string(), Value::Object(fields));
    if let Some(inventory) = document.get("antenna_inventory") {
        summary.insert("antenna_inventory".to_string(), inventory.clone());
    }
    Value::Object(summary)
}

fn stage_summary(stage: &Value) -> Value {
    json!({
        "default_until_seconds": stage.get("default_until_seconds"),
        "action": stage.get("action"),
        "study_kind": stage.pointer("/ir/study/kind"),
        "study_dynamics": stage.pointer("/ir/study/dynamics"),
        "runtime_request": runtime_request_summary(stage),
        "energy_terms": without_zero_zeeman(pointer(stage, "/ir/energy_terms")),
    })
}

/// Requested execution intent: backend, device, mode and precision, with
/// `auto` kept verbatim.
fn runtime_request_summary(document: &Value) -> Value {
    let selection = pointer(document, "/ir/problem_meta/runtime_metadata/runtime_selection");
    json!({
        "requested_backend": pointer(document, "/ir/backend_policy/requested_backend"),
        "execution_precision": pointer(document, "/ir/backend_policy/execution_precision"),
        "device": selection.get("device"),
        "device_index": selection.get("device_index"),
        "execution_mode": selection.get("execution_mode"),
    })
}

fn stage_list(document: &Value) -> Vec<Value> {
    pointer(document, "/stages")
        .as_array()
        .cloned()
        .unwrap_or_default()
}

/// Compare the key physics fields of two `export-run-config` documents.
/// Returns one note per differing field; an empty list means they agree.
///
/// Documented canonicalisations, each equivalence-preserving:
/// 1. no-op zero `translate` wrappers are dropped from geometries;
/// 2. a zero-field Zeeman term equals no Zeeman term (top level and per stage);
/// 3. a legacy script without a stage list (`Problem` with one study) equals
///    the scene's single explicit stage: the original is compared as one stage
///    built from its own study, energy terms and `default_until_seconds`.
fn compare_lowered(original: &Value, rendered: &Value) -> Vec<String> {
    const NAME_KEYS: &[&str] = &["name"];
    let original_stages = stage_list(original);
    let rendered_stages = stage_list(rendered);
    let legacy_single_stage = original_stages.is_empty() && rendered_stages.len() == 1;

    let mut notes = Vec::new();
    let mut check = |label: &str, a: &Value, b: &Value, ignored: &[&str]| {
        if !json_close(a, b, ignored) {
            notes.push(mismatch(label, a, b));
        }
    };
    check(
        "geometry",
        &strip_zero_translations(pointer(original, "/ir/geometry/entries")),
        &strip_zero_translations(pointer(rendered, "/ir/geometry/entries")),
        NAME_KEYS,
    );
    check(
        "materials",
        pointer(original, "/ir/materials"),
        pointer(rendered, "/ir/materials"),
        NAME_KEYS,
    );
    check(
        "FDM grid cell",
        pointer(original, "/ir/backend_policy/discretization_hints/fdm/cell"),
        pointer(rendered, "/ir/backend_policy/discretization_hints/fdm/cell"),
        &[],
    );
    check(
        "energy terms",
        &without_zero_zeeman(pointer(original, "/ir/energy_terms")),
        &without_zero_zeeman(pointer(rendered, "/ir/energy_terms")),
        &[],
    );
    // Magnets carry the initial magnetization (preset, seed, parameters);
    // names and generated references are compared through geometry/materials.
    check(
        "magnets and initial state",
        pointer(original, "/ir/magnets"),
        pointer(rendered, "/ir/magnets"),
        &["name", "object_id", "region", "material"],
    );
    check(
        "regions",
        pointer(original, "/ir/regions"),
        pointer(rendered, "/ir/regions"),
        NAME_KEYS,
    );
    check(
        "object regions",
        pointer(original, "/ir/object_regions"),
        pointer(rendered, "/ir/object_regions"),
        NAME_KEYS,
    );
    check(
        "runtime request",
        &runtime_request_summary(original),
        &runtime_request_summary(rendered),
        &[],
    );
    // The FEM mesh source path is private to each evaluation; order, size and
    // demag solver policy are the authored mesh policy.
    check(
        "FEM mesh policy",
        pointer(original, "/ir/backend_policy/discretization_hints/fem"),
        pointer(rendered, "/ir/backend_policy/discretization_hints/fem"),
        &["mesh"],
    );
    if !legacy_single_stage {
        check(
            "study kind",
            pointer(original, "/ir/study/kind"),
            pointer(rendered, "/ir/study/kind"),
            &[],
        );
        check(
            "study dynamics",
            pointer(original, "/ir/study/dynamics"),
            pointer(rendered, "/ir/study/dynamics"),
            &[],
        );
    }

    let summaries = |stages: &[Value]| Value::Array(stages.iter().map(stage_summary).collect());
    let original_summary = if legacy_single_stage {
        Value::Array(vec![stage_summary(&json!({
            "default_until_seconds": original.get("default_until_seconds"),
            "action": Value::Null,
            "ir": original.get("ir"),
        }))])
    } else {
        summaries(&original_stages)
    };
    let rendered_summary = summaries(&rendered_stages);
    check("study stages", &original_summary, &rendered_summary, &[]);

    let original_physics = antenna_transport_summary(original);
    let rendered_physics = antenna_transport_summary(rendered);
    if original_physics != rendered_physics {
        notes.push(mismatch(
            "antenna and transport declarations",
            &original_physics,
            &rendered_physics,
        ));
    }
    let original_stage_physics = if legacy_single_stage {
        vec![antenna_transport_summary(&json!({"ir": original.get("ir")}))]
    } else {
        original_stages.iter().map(antenna_transport_summary).collect()
    };
    let rendered_stage_physics: Vec<Value> = rendered_stages
        .iter()
        .map(antenna_transport_summary)
        .collect();
    if original_stage_physics != rendered_stage_physics {
        notes.push(mismatch(
            "stage antenna and transport declarations",
            &Value::Array(original_stage_physics),
            &Value::Array(rendered_stage_physics),
        ));
    }
    notes
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn comparison_checks_source_cut_and_stage_current_parameters_exactly() {
        let ir = json!({
            "antenna_port_modes": [{"id": "loop_port", "normalization": {
                "kind": "source_cut_rt0", "source_cut_ref": "inlet_cut",
                "orientation": "minus_outward"}}],
            "current_modules": [{"name": "antenna_charge", "structured_current_closure": {
                "source_cuts": [{"source_cut_id": "inlet_cut", "drive": {
                    "potential_jump_V": 0.25}}]}}]
        });
        let original = json!({"ir": ir, "stages": [{"ir": ir}]});
        assert!(compare_lowered(&original, &original).is_empty());
        let mut changed_cut = original.clone();
        changed_cut["ir"]["antenna_port_modes"][0]["normalization"]["source_cut_ref"] =
            json!("other_cut");
        assert!(compare_lowered(&original, &changed_cut)
            .iter().any(|note| note.starts_with("antenna and transport declarations differs")));
        let mut changed_stage = original.clone();
        // This is below the legacy relative float tolerance; authored intent
        // must still be preserved even when only a per-stage IR changes.
        changed_stage["stages"][0]["ir"]["current_modules"][0]
            ["structured_current_closure"]["source_cuts"][0]["drive"]["potential_jump_V"] =
            json!(0.250000000001);
        assert!(compare_lowered(&original, &changed_stage)
            .iter().any(|note| note.starts_with("stage antenna and transport declarations differs")));
    }

    #[test]
    fn comparison_checks_authoring_inventory_outside_execution_ir() {
        let original = json!({"ir": {"solved_antenna_drives": []},
            "antenna_inventory": {"solved_antenna_drives": [{
                "id": "drive", "peak_current_a": 0.001}]}});
        let mut changed = original.clone();
        changed["antenna_inventory"]["solved_antenna_drives"][0]["peak_current_a"] =
            json!(0.002);
        assert!(!compare_lowered(&original, &changed).is_empty());
        changed.as_object_mut().unwrap().remove("antenna_inventory");
        assert!(!compare_lowered(&original, &changed).is_empty());
    }

    #[test]
    fn comparison_keeps_global_inventory_out_of_legacy_stage_fallback() {
        let ir = json!({"antenna_port_modes": [], "current_modules": []});
        let inventory = json!({"solved_antenna_drives": [{
            "id": "drive", "peak_current_a": 0.001}]});
        let original = json!({"ir": ir, "antenna_inventory": inventory});
        let rendered = json!({"ir": ir, "antenna_inventory": inventory,
            "stages": [{"ir": ir}]});
        assert!(compare_lowered(&original, &rendered).is_empty());
    }

    #[test]
    fn comparison_preserves_empty_presence_and_prepared_integer_identities() {
        let absent = json!({"ir": {}});
        let null = json!({"ir": {"antenna_port_modes": null}});
        let empty = json!({"ir": {"antenna_port_modes": []}});
        for (left, right) in [(&absent, &null), (&absent, &empty), (&null, &empty)] {
            assert!(!compare_lowered(left, right).is_empty());
            assert!(!compare_lowered(right, left).is_empty());
        }
        let original = json!({"ir": {"current_modules": [{
            "name": "source", "conservative_current_view": {
                "stable_vertex_ids": [9007199254740992u64, 9007199254740996u64,
                    9007199254741000u64]}}]}});
        let mut changed = original.clone();
        changed["ir"]["current_modules"][0]["conservative_current_view"]
            ["stable_vertex_ids"][0] = json!(9007199254740993u64);
        assert!(!compare_lowered(&original, &changed).is_empty());
    }

    #[test]
    fn comparison_checks_runtime_request_of_each_stage() {
        let ir = json!({"backend_policy": {"requested_backend": "fem",
            "execution_precision": "double"}, "problem_meta": {
                "runtime_metadata": {"runtime_selection": {"device": "cpu",
                    "device_index": 0, "execution_mode": "strict"}}}});
        let original = json!({"ir": ir, "stages": [{"ir": ir}]});
        for (field, value) in [("device", json!("gpu")),
            ("execution_mode", Value::Null), ("device_index", json!(1))] {
            let mut changed = original.clone();
            changed["stages"][0]["ir"]["problem_meta"]["runtime_metadata"]
                ["runtime_selection"][field] = value;
            assert!(compare_lowered(&original, &changed)
                .iter().any(|note| note.starts_with("study stages differs")));
        }
        for (field, value) in [("requested_backend", json!("fdm")),
            ("execution_precision", json!("single"))] {
            let mut changed = original.clone();
            changed["stages"][0]["ir"]["backend_policy"][field] = value;
            assert!(compare_lowered(&original, &changed)
                .iter().any(|note| note.starts_with("study stages differs")));
        }
    }

    #[test]
    fn safe_file_name_keeps_the_stem_and_drops_unsafe_characters() {
        assert_eq!(safe_script_file_name("dir/my model.py"), "my_model.py");
        assert_eq!(safe_script_file_name("..\\..\\x.py"), "x.py");
        assert_eq!(safe_script_file_name("   "), "script.py");
        assert_eq!(safe_script_file_name("łąka.py"), "łąka.py");
    }

    #[test]
    fn exception_summary_quotes_only_the_last_traceback_line() {
        let trace = "Traceback (most recent call last):
  File \"x.py\", line 1
ValueError: no fixed timestep

";
        assert_eq!(exception_summary(trace), "ValueError: no fixed timestep");
        assert_eq!(exception_summary("  
"), "no message");
    }

    #[test]
    fn helper_json_ignores_script_prints_before_the_answer() {
        let value = parse_helper_json(b"hello\n{\"a\": 1}\n\n").unwrap();
        assert_eq!(value["a"], 1);
        assert!(parse_helper_json(b"  \n").is_err());
    }

    #[test]
    fn comparison_ignores_names_and_tiny_float_noise_but_reports_real_changes() {
        let original = json!({
            "ir": {"geometry": {"entries": [{"name": "a", "size": [1e-7, 1e-7, 1e-8]}]},
                   "materials": [{"name": "m", "Ms": 8e5}],
                   "backend_policy": {"discretization_hints": {"fdm": {"cell": [3e-9, 3e-9, 2e-9]}}},
                   "study": {"kind": "time_evolution", "dynamics": {"integrator": "rk45"}}},
            "study_pipeline": null,
            "stages": [{"default_until_seconds": 1e-9, "action": "run"}]
        });
        let mut rendered = original.clone();
        rendered["ir"]["geometry"]["entries"][0]["name"] = json!("other");
        rendered["ir"]["materials"][0]["Ms"] = json!(8e5 * (1.0 + 1e-12));
        assert!(compare_lowered(&original, &rendered).is_empty());
        rendered["ir"]["study"]["dynamics"]["integrator"] = json!("heun");
        rendered["stages"] = json!([]);
        let notes = compare_lowered(&original, &rendered);
        assert_eq!(notes.len(), 3, "{notes:?}");
        assert!(notes[0].starts_with("study dynamics differs"));
        assert!(notes[1].starts_with("study stages differs"));
        assert!(notes[2].starts_with("stage antenna and transport declarations differs"));
    }

    fn lowered_document(
        geometry: Value,
        energy_terms: Value,
        stages: Value,
        default_until: Value,
    ) -> Value {
        json!({
            "ir": {
                "geometry": {"entries": [geometry]},
                "materials": [{"name": "m", "Ms": 8e5}],
                "backend_policy": {"discretization_hints": {"fdm": {"cell": [3e-9, 3e-9, 2e-9]}}},
                "energy_terms": energy_terms,
                "study": {"kind": "time_evolution", "dynamics": {"integrator": "rk45"}}
            },
            "default_until_seconds": default_until,
            "stages": stages
        })
    }

    fn explicit_stage(kind: &str, until: Value, energy_terms: Value) -> Value {
        json!({
            "default_until_seconds": until,
            "action": null,
            "ir": {"energy_terms": energy_terms,
                   "study": {"kind": kind, "dynamics": {"integrator": "rk45"}}}
        })
    }

    #[test]
    fn comparison_treats_a_zero_translate_wrapper_as_the_base_geometry() {
        let base = json!({"name": "a", "kind": "cylinder", "radius": 5e-8, "height": 1e-8});
        let wrapped = json!({"name": "a", "kind": "translate", "base": base, "by": [0.0, 0.0, 0.0]});
        let moved = json!({"name": "a", "kind": "translate", "base": base, "by": [0.0, 1e-9, 0.0]});
        let terms = json!([{"kind": "exchange"}]);
        let plain = lowered_document(base.clone(), terms.clone(), json!([]), Value::Null);
        let with_zero = lowered_document(wrapped, terms.clone(), json!([]), Value::Null);
        let with_shift = lowered_document(moved, terms, json!([]), Value::Null);
        assert!(compare_lowered(&with_zero, &plain).is_empty());
        let notes = compare_lowered(&with_shift, &plain);
        assert_eq!(notes.len(), 1, "{notes:?}");
        assert!(notes[0].starts_with("geometry differs"));
    }

    #[test]
    fn comparison_treats_a_zero_zeeman_term_as_absent_but_not_a_real_field() {
        let geometry = json!({"name": "a", "kind": "box"});
        let none = json!([{"kind": "exchange"}]);
        let zero = json!([{"kind": "exchange"}, {"kind": "zeeman", "B": [0.0, 0.0, 0.0]}]);
        let real = json!([{"kind": "exchange"}, {"kind": "zeeman", "B": [2e-3, 0.0, 0.0]}]);
        let stage = |terms: &Value| {
            lowered_document(
                geometry.clone(),
                terms.clone(),
                json!([explicit_stage("time_evolution", json!(1e-9), terms.clone())]),
                Value::Null,
            )
        };
        assert!(compare_lowered(&stage(&none), &stage(&zero)).is_empty());
        let notes = compare_lowered(&stage(&real), &stage(&zero));
        assert!(notes.iter().any(|note| note.starts_with("energy terms differ")), "{notes:?}");
        assert!(notes.iter().any(|note| note.starts_with("study stages differ")), "{notes:?}");
    }

    #[test]
    fn comparison_maps_a_legacy_single_study_script_onto_one_explicit_stage() {
        let geometry = json!({"name": "a", "kind": "box"});
        let terms = json!([{"kind": "exchange"}]);
        let legacy = lowered_document(geometry.clone(), terms.clone(), json!([]), json!(5e-12));
        let scene = lowered_document(
            geometry.clone(),
            terms.clone(),
            json!([explicit_stage("time_evolution", json!(5e-12), terms.clone())]),
            Value::Null,
        );
        assert!(compare_lowered(&legacy, &scene).is_empty());
        // A different end time, study kind, or a second stage is still a difference.
        let later = lowered_document(
            geometry.clone(),
            terms.clone(),
            json!([explicit_stage("time_evolution", json!(9e-12), terms.clone())]),
            Value::Null,
        );
        assert_eq!(compare_lowered(&legacy, &later).len(), 1);
        let relax = lowered_document(
            geometry.clone(),
            terms.clone(),
            json!([explicit_stage("relaxation", json!(5e-12), terms.clone())]),
            Value::Null,
        );
        assert_eq!(compare_lowered(&legacy, &relax).len(), 1);
        let two = lowered_document(
            geometry,
            terms.clone(),
            json!([
                explicit_stage("time_evolution", json!(5e-12), terms.clone()),
                explicit_stage("time_evolution", json!(5e-12), terms)
            ]),
            Value::Null,
        );
        assert!(!compare_lowered(&legacy, &two).is_empty());
    }
}
