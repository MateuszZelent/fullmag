//! Private constructor for the authoring snapshot used by the pre-listen
//! development restore adapter.
//!
//! This is not an HTTP route or a process-restart implementation. The adapter
//! supplies the canonical scene and old session identity before the API starts
//! listening; a separate coordinator still owns process handoff.

use fullmag_authoring::{
    scene_document_has_unresolved_solve_prerequisites, validate_scene_document_for_authoring,
    SceneDocument,
};

use crate::{
    default_current_live_state,
    script::scene_document_builder_projection,
    types::{CurrentLiveSnapshotRequest, SessionManifest, SessionStateResponse},
    unix_time_millis_now, uuid_v4_hex, ApiError,
};

pub(crate) fn restore_authoring_snapshot(
    scene_document: SceneDocument,
    old_session_id: &str,
) -> Result<SessionStateResponse, ApiError> {
    validate_old_session_id(old_session_id)?;
    validate_model_identity(&scene_document)?;
    validate_requested_intent(&scene_document)?;
    validate_scene_document_for_authoring(&scene_document)
        .map_err(|error| ApiError::bad_request(error.message))?;

    let requested_backend = scene_document.study.requested_backend.as_str();
    let requested_device = scene_document.study.requested_device.as_str();
    let requested_precision = scene_document.study.requested_precision.as_str();
    let requested_mode = scene_document.study.requested_mode.as_str();
    let session_id = fresh_session_id(old_session_id, &scene_document.scene.id);
    let now = unix_time_millis_now();
    let session = SessionManifest {
        session_id: session_id.clone(),
        run_id: format!("run-{session_id}"),
        status: "awaiting_command".to_string(),
        interactive_session_requested: true,
        script_path: String::new(),
        problem_name: scene_document.scene.name.clone(),
        requested_backend: requested_backend.to_string(),
        explicit_selection: requested_backend != "auto"
            || requested_device != "auto"
            || requested_precision != "double"
            || requested_mode != "strict"
            || scene_document.study.requested_cpu_threads.is_some(),
        authored_requested_device: requested_device.to_string(),
        requested_device: requested_device.to_string(),
        requested_precision: requested_precision.to_string(),
        requested_mode: requested_mode.to_string(),
        requested_cpu_threads: scene_document.study.requested_cpu_threads,
        execution_mode: requested_mode.to_string(),
        precision: requested_precision.to_string(),
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
        artifact_dir: String::new(),
        started_at_unix_ms: now,
        finished_at_unix_ms: 0,
        plan_summary: serde_json::json!({}),
    };

    let builder_adapter = match scene_document_builder_projection(&scene_document) {
        Ok(adapter) => Some(adapter),
        Err(_) if scene_document_has_unresolved_solve_prerequisites(&scene_document) => None,
        Err(error) => return Err(error),
    };
    let mut snapshot = default_current_live_state(&CurrentLiveSnapshotRequest {
        session_id,
        session: Some(session),
        session_status: None,
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
    snapshot.capabilities = scratch_capabilities_for_explicit_cpu_double(
        requested_backend,
        requested_device,
        requested_precision,
    );
    snapshot.scene_document = Some(scene_document);
    snapshot.builder_adapter = builder_adapter;
    Ok(snapshot)
}

fn validate_old_session_id(old_session_id: &str) -> Result<(), ApiError> {
    if old_session_id.is_empty()
        || old_session_id.len() > 128
        || !old_session_id
            .bytes()
            .all(|byte| byte.is_ascii_alphanumeric() || matches!(byte, b'.' | b'_' | b'-'))
    {
        return Err(ApiError::bad_request(
            "old session identity must be 1-128 ASCII letters, digits, '.', '_' or '-'",
        ));
    }
    Ok(())
}

fn validate_model_identity(scene_document: &SceneDocument) -> Result<(), ApiError> {
    let scene_id = scene_document.scene.id.as_str();
    if scene_id.trim().is_empty() || scene_id.trim() != scene_id {
        return Err(ApiError::bad_request(
            "model identity must be nonempty and trimmed",
        ));
    }
    let scene_name = scene_document.scene.name.as_str();
    if scene_name.trim().is_empty() {
        return Err(ApiError::bad_request("model name must not be empty"));
    }
    Ok(())
}

fn validate_requested_intent(scene_document: &SceneDocument) -> Result<(), ApiError> {
    let study = &scene_document.study;
    if !matches!(study.requested_backend.as_str(), "auto" | "fdm" | "fem") {
        return Err(ApiError::bad_request(
            "requested backend must be auto, fdm, or fem",
        ));
    }
    if !matches!(study.requested_device.as_str(), "auto" | "cpu" | "gpu") {
        return Err(ApiError::bad_request(
            "requested device must be auto, cpu, or gpu",
        ));
    }
    if !matches!(study.requested_precision.as_str(), "single" | "double") {
        return Err(ApiError::bad_request(
            "requested precision must be single or double",
        ));
    }
    if !matches!(
        study.requested_mode.as_str(),
        "strict" | "extended" | "hybrid"
    ) {
        return Err(ApiError::bad_request(
            "requested mode must be strict, extended, or hybrid",
        ));
    }
    Ok(())
}

fn fresh_session_id(old_session_id: &str, scene_id: &str) -> String {
    loop {
        let session_id = format!("session-{}", uuid_v4_hex());
        if session_id != old_session_id && session_id != scene_id {
            return session_id;
        }
    }
}

fn scratch_capabilities_for_explicit_cpu_double(
    backend: &str,
    device: &str,
    precision: &str,
) -> Option<fullmag_runner::BackendCapabilities> {
    if device != "cpu" || precision != "double" {
        return None;
    }
    match backend {
        "fdm" | "fem" => fullmag_runner::scratch_authoring_capabilities(backend),
        _ => None,
    }
}

#[cfg(test)]
mod tests {
    use super::*;
    use crate::{
        router_v2::handlers::sessions::create::create_empty_scene_document,
        schemas::sessions::CreateSessionRequest,
    };
    use serde_json::json;

    fn scene_with_requested_intent() -> SceneDocument {
        let mut scene = create_empty_scene_document(&CreateSessionRequest {
            name: "restore fixture".to_string(),
            backend: "fdm".to_string(),
            device: "cpu".to_string(),
            precision: "double".to_string(),
            replace_current: false,
        })
        .expect("fixture scene should be created");
        scene.revision = 19;
        scene.scene.id = "model-identity-19".to_string();
        scene.scene.name = "Restored authoring model ".to_string();
        scene.study.requested_backend = "auto".to_string();
        scene.study.requested_device = "gpu".to_string();
        scene.study.requested_precision = "single".to_string();
        scene.study.requested_mode = "hybrid".to_string();
        scene.study.requested_cpu_threads = Some(7);
        scene.editor.selected_entity_id = Some("editor-selection-4".to_string());
        scene.editor.gizmo_mode = Some("translate".to_string());
        scene
    }

    #[test]
    fn restore_preserves_the_full_scene_and_requested_intent_without_runtime_claims() {
        let original = scene_with_requested_intent();
        let snapshot = restore_authoring_snapshot(original.clone(), "old-session-18")
            .expect("valid authoring scene should produce a fresh idle snapshot");

        assert_eq!(snapshot.scene_document.as_ref(), Some(&original));
        assert!(snapshot.session.session_id.starts_with("session-"));
        assert!(snapshot.session.session_id.len() > "session-".len());
        assert_ne!(snapshot.session.session_id, "old-session-18");
        assert_ne!(snapshot.session.session_id, original.scene.id);
        assert_eq!(snapshot.session.problem_name, "Restored authoring model ");
        assert_eq!(snapshot.session.status, "awaiting_command");
        assert_eq!(snapshot.session.requested_backend, "auto");
        assert_eq!(snapshot.session.authored_requested_device, "gpu");
        assert_eq!(snapshot.session.requested_device, "gpu");
        assert_eq!(snapshot.session.requested_precision, "single");
        assert_eq!(snapshot.session.requested_mode, "hybrid");
        assert_eq!(snapshot.session.requested_cpu_threads, Some(7));
        assert!(snapshot.session.explicit_selection);
        assert_eq!(snapshot.session.execution_mode, "hybrid");
        assert_eq!(snapshot.session.precision, "single");
        assert!(snapshot.session.resolved_backend.is_none());
        assert!(snapshot.session.resolved_device.is_none());
        assert!(snapshot.session.resolved_precision.is_none());
        assert!(snapshot.session.resolved_mode.is_none());
        assert!(snapshot.session.resolved_runtime_family.is_none());
        assert!(snapshot.session.resolved_engine_id.is_none());
        assert!(snapshot.session.resolved_worker.is_none());
        assert!(snapshot.session.resolved_cpu_threads.is_none());
        assert!(snapshot.session.resolved_fallback.is_none());
        assert!(snapshot.session.fem_crossover_decision.is_none());
        assert!(snapshot.metadata.is_none());
        assert!(snapshot.capabilities.is_none());
        assert_eq!(snapshot.session.plan_summary, json!({}));
        assert!(snapshot.run.is_none());
        assert!(snapshot.live_state.is_none());
        assert!(snapshot.mesh_workspace.is_none());
        assert!(snapshot.stage_execution.is_none());
        assert!(snapshot.simulation_preparation.is_none());
        assert!(snapshot.fem_mesh.is_none());
        assert!(snapshot.coupled_checkpoint.is_none());
        assert!(snapshot.preview.is_none());
        assert!(snapshot.artifacts.is_empty());
        assert!(snapshot.engine_log.is_empty());
        assert!(snapshot.scalar_rows.is_empty());
        assert!(snapshot.quantities.is_empty());
        assert_eq!(snapshot.latest_fields.len(), 0);
        assert!(snapshot.field_publication_bundles.is_empty());
        assert!(snapshot.field_quantity_revisions.is_empty());
        assert_eq!(snapshot.runtime_status.code, "awaiting_command");
    }

    #[test]
    fn automatic_default_intent_does_not_claim_explicit_selection() {
        let mut scene = scene_with_requested_intent();
        scene.study.requested_backend = "auto".into();
        scene.study.requested_device = "auto".into();
        scene.study.requested_precision = "double".into();
        scene.study.requested_mode = "strict".into();
        scene.study.requested_cpu_threads = None;
        let snapshot = restore_authoring_snapshot(scene, "old-session-18").unwrap();
        assert!(!snapshot.session.explicit_selection);
    }

    #[test]
    fn explicit_cpu_double_lane_alone_gets_scratch_capabilities() {
        let mut scene = scene_with_requested_intent();
        scene.study.requested_backend = "fem".to_string();
        scene.study.requested_device = "cpu".to_string();
        scene.study.requested_precision = "double".to_string();
        let snapshot = restore_authoring_snapshot(scene, "old-session-18")
            .expect("known intent should restore");
        assert!(snapshot.capabilities.is_some());
        assert!(snapshot.session.resolved_backend.is_none());
        assert!(snapshot.metadata.is_none());
    }

    #[test]
    fn incomplete_solve_prerequisites_keep_the_canonical_scene_and_empty_adapter() {
        let mut scene = scene_with_requested_intent();
        scene.objects.push(
            serde_json::from_value(json!({
                "id": "magnet-1",
                "name": "Film",
                "geometry": {"geometry_kind": "box", "geometry_params": {"size": [1.0, 1.0, 1.0]}},
                "material_ref": "missing-material"
            }))
            .expect("typed draft object should deserialize"),
        );
        let original = scene.clone();

        let snapshot = restore_authoring_snapshot(scene, "old-session-18")
            .expect("authoring-valid drafts do not need solve prerequisites");

        assert_eq!(snapshot.scene_document.as_ref(), Some(&original));
        assert!(snapshot.builder_adapter.is_none());
    }

    #[test]
    fn invalid_identity_and_requested_intent_are_rejected_without_normalization() {
        let mut invalid_id = scene_with_requested_intent();
        invalid_id.scene.id = " model-identity-19".to_string();
        assert!(restore_authoring_snapshot(invalid_id, "old-session-18").is_err());

        let mut invalid_name = scene_with_requested_intent();
        invalid_name.scene.name = "  ".to_string();
        assert!(restore_authoring_snapshot(invalid_name, "old-session-18").is_err());
        assert!(restore_authoring_snapshot(scene_with_requested_intent(), " old-session").is_err());
        assert!(
            restore_authoring_snapshot(scene_with_requested_intent(), &"a".repeat(129)).is_err()
        );
        assert!(restore_authoring_snapshot(scene_with_requested_intent(), "old/session").is_err());

        for (field, invalid_value) in [
            ("backend", "future"),
            ("device", "metal"),
            ("precision", "mixed"),
            ("mode", "permissive"),
        ] {
            let mut scene = scene_with_requested_intent();
            match field {
                "backend" => scene.study.requested_backend = invalid_value.to_string(),
                "device" => scene.study.requested_device = invalid_value.to_string(),
                "precision" => scene.study.requested_precision = invalid_value.to_string(),
                "mode" => scene.study.requested_mode = invalid_value.to_string(),
                _ => unreachable!(),
            }
            assert!(restore_authoring_snapshot(scene, "old-session-18").is_err());
        }
    }
}
