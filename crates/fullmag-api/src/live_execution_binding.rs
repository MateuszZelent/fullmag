//! Compatibility between an authored document and immutable accepted input.

use crate::error::ApiError;
use crate::types::{AppState, SessionStateResponse};
use fullmag_application::RunSpecification;
use fullmag_authoring::{
    scene_execution_input_identity, SceneDocument, SceneExecutionInputIdentity,
    SCENE_EXECUTION_INPUT_SCHEMA,
};
use serde_json::{json, Value};

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
            {
                return Err(ApiError::conflict_with_code(
                    "accepted_execution_input_invalid",
                    "accepted execution input identity has an unsupported schema or malformed digest",
                ));
            }
            if &identity != current_identity {
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

/// Reconstruct the authored scene projection from an accepted immutable
/// definition. Historical acceptance may have injected the legacy default
/// profile into the stored effective scene after pinning authored input. Only
/// that exact profile may be projected away, and only when the complete
/// versioned input identity then matches the immutable RunSpecification.
pub(crate) fn recover_scene_projection(
    scene: SceneDocument,
    specification: &RunSpecification,
) -> Result<SceneDocument, ApiError> {
    let binding = json!({ "parameters": specification.parameters.clone() });
    let current_identity = input_identity(&scene)?;
    let mismatch = match validate_input_binding(&binding, &current_identity, scene.revision) {
        Ok(()) => return Ok(scene),
        Err(error)
            if error.code.as_deref() == Some("accepted_execution_input_mismatch") =>
        {
            error
        }
        Err(error) => return Err(error),
    };

    let legacy_profile = fullmag_application::legacy_live_execution_profile();
    if scene.study.execution_profile.as_ref() != Some(&legacy_profile) {
        return Err(mismatch);
    }

    let mut authored_projection = scene;
    authored_projection.study.execution_profile = None;
    let projected_identity = input_identity(&authored_projection)?;
    validate_input_binding(&binding, &projected_identity, authored_projection.revision)?;
    Ok(authored_projection)
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

#[cfg(test)]
mod tests {
    use super::*;
    use fullmag_application::{
        ProjectId, ProjectSnapshot, RequestedExecution, RequestedResourceBudget, StudyId,
        StudyReference,
    };
    use serde_json::json;

    fn specification(parameters: Value) -> fullmag_application::RunSpecification {
        fullmag_application::RunSpecification::new(
            ProjectSnapshot {
                project_id: ProjectId::parse("project-binding-test").unwrap(),
                definition_revision: 7,
                definition_sha256: "a".repeat(64),
            },
            StudyReference {
                study_id: StudyId::parse("study-binding-test").unwrap(),
                plan_version: "study_plan.v1".into(),
                plan_sha256: "b".repeat(64),
            },
            "c".repeat(64),
            parameters,
            RequestedExecution {
                backend: "fdm".into(),
                device: "cpu".into(),
                precision: "double".into(),
                mode: "strict".into(),
                minimum_resources: Some(RequestedResourceBudget {
                    cpu_millis: 100,
                    memory_bytes: 1,
                    gpu_memory_bytes: 0,
                    storage_bytes: 1,
                }),
            },
        )
    }

    fn versioned_specification(identity: Value) -> fullmag_application::RunSpecification {
        specification(json!({
            "live_workspace": { "execution_input": identity }
        }))
    }

    #[test]
    fn exact_authored_input_is_restored_unchanged() {
        let scene = SceneDocument::default();
        let identity = serde_json::to_value(input_identity(&scene).unwrap()).unwrap();
        let restored =
            recover_scene_projection(scene.clone(), &versioned_specification(identity)).unwrap();

        assert_eq!(restored, scene);
        assert!(restored.study.execution_profile.is_none());
    }

    #[test]
    fn historical_injected_legacy_profile_is_removed_for_authored_projection() {
        let authored = SceneDocument::default();
        let identity = serde_json::to_value(input_identity(&authored).unwrap()).unwrap();
        let mut stored = authored;
        stored.study.execution_profile =
            Some(fullmag_application::legacy_live_execution_profile());

        let restored =
            recover_scene_projection(stored.clone(), &versioned_specification(identity)).unwrap();

        stored.study.execution_profile = None;
        assert_eq!(restored, stored);
    }

    #[test]
    fn explicitly_authored_legacy_profile_is_preserved_when_exactly_pinned() {
        let mut scene = SceneDocument::default();
        scene.study.execution_profile =
            Some(fullmag_application::legacy_live_execution_profile());
        let identity = serde_json::to_value(input_identity(&scene).unwrap()).unwrap();

        let restored =
            recover_scene_projection(scene.clone(), &versioned_specification(identity)).unwrap();

        assert_eq!(restored, scene);
    }

    #[test]
    fn custom_profile_mismatch_is_not_reconstructed_as_legacy_absence() {
        let authored = SceneDocument::default();
        let identity = serde_json::to_value(input_identity(&authored).unwrap()).unwrap();
        let mut candidate = authored;
        let mut custom = fullmag_application::legacy_live_execution_profile();
        custom.profile_id = "exec:custom".into();
        candidate.study.execution_profile = Some(custom);

        let error = recover_scene_projection(candidate, &versioned_specification(identity))
            .unwrap_err();

        assert_eq!(error.code.as_deref(), Some("accepted_execution_input_mismatch"));
    }

    #[test]
    fn physics_change_still_mismatches_after_legacy_profile_projection() {
        let authored = SceneDocument::default();
        let identity = serde_json::to_value(input_identity(&authored).unwrap()).unwrap();
        let mut candidate = authored;
        candidate.study.external_field = Some([0.0, 0.0, 1.0]);
        candidate.study.execution_profile =
            Some(fullmag_application::legacy_live_execution_profile());

        let error = recover_scene_projection(candidate, &versioned_specification(identity))
            .unwrap_err();

        assert_eq!(error.code.as_deref(), Some("accepted_execution_input_mismatch"));
    }

    #[test]
    fn malformed_versioned_identity_is_rejected_without_projection_guessing() {
        let mut candidate = SceneDocument::default();
        candidate.study.execution_profile =
            Some(fullmag_application::legacy_live_execution_profile());
        for identity in [
            json!({
                "schema_version": "fullmag.scene_execution_input.v0",
                "sha256": "a".repeat(64)
            }),
            json!({
                "schema_version": SCENE_EXECUTION_INPUT_SCHEMA,
                "sha256": "not-a-digest"
            }),
        ] {
            let error =
                recover_scene_projection(candidate.clone(), &versioned_specification(identity))
                    .unwrap_err();
            assert_eq!(error.code.as_deref(), Some("accepted_execution_input_invalid"));
        }
    }

    #[test]
    fn legacy_revision_binding_preserves_the_candidate_without_profile_guessing() {
        let mut candidate = SceneDocument::default();
        candidate.revision = 7;
        candidate.study.execution_profile =
            Some(fullmag_application::legacy_live_execution_profile());
        let specification = specification(json!({
            "live_workspace": { "scene_revision": 7 }
        }));

        let restored = recover_scene_projection(candidate.clone(), &specification).unwrap();

        assert_eq!(restored, candidate);
    }

    #[test]
    fn stale_legacy_revision_binding_is_rejected() {
        let mut candidate = SceneDocument::default();
        candidate.revision = 7;
        candidate.study.execution_profile =
            Some(fullmag_application::legacy_live_execution_profile());
        let specification = specification(json!({
            "live_workspace": { "scene_revision": 6 }
        }));

        let error = recover_scene_projection(candidate, &specification).unwrap_err();

        assert_eq!(error.code.as_deref(), Some("accepted_execution_input_legacy_revision"));
    }
}
