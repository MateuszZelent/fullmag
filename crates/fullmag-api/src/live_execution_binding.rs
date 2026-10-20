//! Compatibility between an authored document and immutable accepted input.

use crate::error::ApiError;
use crate::types::{AppState, SessionStateResponse};
use fullmag_authoring::{
    scene_execution_input_identity, SceneDocument, SceneExecutionInputIdentity,
    SCENE_EXECUTION_INPUT_SCHEMA,
};
use serde_json::Value;

pub(crate) fn input_identity(scene: &SceneDocument) -> Result<SceneExecutionInputIdentity, ApiError> {
    scene_execution_input_identity(scene)
        .map_err(|error| ApiError::internal(format!("encode authored execution identity: {error}")))
}

/// New intents declare the complete authored configuration identity. Old
/// intents keep exact scene-revision binding; never retrofit a current scene
/// digest onto an immutable historical run.
pub(crate) fn validate_input_binding(
    specification: &Value,
    current_identity: &SceneExecutionInputIdentity,
    scene_revision: u64,
) -> Result<(), ApiError> {
    let live = specification.pointer("/parameters/live_workspace").ok_or_else(|| {
        ApiError::conflict_with_code(
            "accepted_execution_input_unavailable",
            "accepted run has no live workspace binding",
        )
    })?;
    match live.get("execution_input") {
        Some(value) => {
            let identity: SceneExecutionInputIdentity = serde_json::from_value(value.clone())
                .map_err(|error| ApiError::conflict_with_code(
                    "accepted_execution_input_invalid",
                    format!("accepted execution input identity is invalid: {error}"),
                ))?;
            if identity.schema_version != SCENE_EXECUTION_INPUT_SCHEMA
                || identity.sha256.len() != 64
                || !identity.sha256.bytes().all(|byte| byte.is_ascii_hexdigit())
                || &identity != current_identity
            {
                return Err(ApiError::conflict_with_code(
                    "accepted_execution_input_mismatch",
                    "current authored input differs from the immutable accepted run",
                ));
            }
        }
        None if live.get("scene_revision").and_then(Value::as_u64) == Some(scene_revision) => {}
        None => return Err(ApiError::conflict_with_code(
            "accepted_execution_input_legacy_revision",
            "this accepted run has no versioned input identity and requires its exact scene revision",
        )),
    }
    Ok(())
}

/// Called under the live transition fence and scene write lock, before the
/// authoring commit changes any resource. Store access runs on the blocking
/// pool and never reads or writes the live state itself.
pub(crate) async fn validate_active_scene_mutation(
    state: &AppState,
    snapshot: &SessionStateResponse,
    next: &SceneDocument,
) -> Result<(), ApiError> {
    if !crate::live_accepted_execution::docker_api_only_runtime() {
        return Ok(());
    }
    let Some(run) = snapshot.run.as_ref() else { return Ok(()); };
    if matches!(run.status.as_str(), "completed" | "succeeded" | "failed" | "cancelled" | "stopped" | "closed") {
        return Ok(());
    }
    let current = snapshot.scene_document.as_ref().ok_or_else(|| {
        ApiError::conflict("active accepted run has no authored document")
    })?;
    let current_identity = input_identity(current)?;
    if input_identity(next)? != current_identity {
        return Err(ApiError::conflict_with_code(
            "accepted_execution_input_locked",
            "finish or stop the accepted run before changing geometry, materials, initial state, stages, runtime, or outputs; your draft has not been applied",
        ));
    }
    let store_root = state.submit_store_root.clone().ok_or_else(|| {
        ApiError::conflict("accepted input binding store is unavailable")
    })?;
    let run_id = run.run_id.clone();
    let specification = tokio::task::spawn_blocking(move || {
        let store = fullmag_session::SessionStore::open_existing(&store_root)
            .map_err(|error| ApiError::conflict(format!("open accepted input store: {error}")))?;
        let intent = store.read_run_intent(&run_id)
            .map_err(|error| ApiError::conflict(format!("read accepted input binding: {error}")))?
            .ok_or_else(|| ApiError::conflict("accepted input binding is unavailable"))?;
        intent.validate().map_err(|error| ApiError::conflict(format!("invalid accepted input binding: {error}")))?;
        Ok::<_, ApiError>(intent.specification)
    }).await.map_err(|error| ApiError::internal(format!("accepted input lookup failed: {error}")))??;
    let live = specification.pointer("/parameters/live_workspace");
    if live.and_then(|value| value.get("api_instance_id")).and_then(Value::as_str)
        != Some(state.request_scope_instance_id.as_str())
        || live.and_then(|value| value.get("session_id")).and_then(Value::as_str)
            != Some(snapshot.session.session_id.as_str())
        || live.and_then(|value| value.get("session_epoch")).and_then(Value::as_u64)
            != Some(state.current_live_session_epoch.load(std::sync::atomic::Ordering::Acquire))
    {
        return Err(ApiError::conflict_with_code(
            "accepted_execution_input_owner_mismatch",
            "accepted input is not bound to the current live session owner",
        ));
    }
    validate_input_binding(&specification, &current_identity, current.revision)?;
    if specification.pointer("/parameters/live_workspace/execution_input").is_none() {
        return Err(ApiError::conflict_with_code(
            "accepted_execution_input_legacy_revision",
            "this accepted run predates metadata-independent input binding; finish or stop it before editing the document",
        ));
    }
    Ok(())
}
