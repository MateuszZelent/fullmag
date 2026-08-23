use axum::{extract::State, http::StatusCode, Json};
use fullmag_authoring::{SceneDocument, SceneMetadata};
use serde_json::json;
use std::sync::{atomic::Ordering, Arc};

use crate::{
    current_live_realtime_state_from_snapshot, default_current_live_state,
    publish_current_live_realtime_batch_changed, reset_current_live_session_resources,
    schemas::{
        authoring::SceneResource,
        sessions::{
            CreateSessionRequest, CreateSessionResponse, ScratchSceneDocumentResource,
            ScratchSessionRevisionsResource, ScratchSessionStatusResource,
            SessionExecutionResource,
        },
    },
    types::{AppState, CurrentLiveSnapshotRequest, SessionManifest},
    unix_time_millis_now, uuid_v4_hex, ApiError,
};

#[utoipa::path(
    post,
    path = "/v2/sessions",
    request_body = CreateSessionRequest,
    responses((status = 201, body = CreateSessionResponse), (status = 400), (status = 409)),
    tag = "sessions"
)]
pub async fn create(
    State(state): State<Arc<AppState>>,
    Json(request): Json<CreateSessionRequest>,
) -> Result<(StatusCode, Json<CreateSessionResponse>), ApiError> {
    let name = request.name.trim();
    if name.is_empty() {
        return Err(ApiError::bad_request("session name must not be empty"));
    }
    let execution = validated_execution(&request)?;
    let scene_document = create_empty_scene_document(&request)?;
    let session_id = scene_document.scene.id.clone();
    let snapshot = scratch_snapshot(&session_id, name, &execution, scene_document.clone());

    let _transition = state.current_live_session_transition.lock().await;
    let replacing = state.current_live_state.read().await.is_some();
    if replacing && !request.replace_current {
        return Err(ApiError {
            status: StatusCode::CONFLICT,
            message: "an active local session already exists; set replace_current to replace it"
                .to_string(),
            diagnostics: Vec::new(),
        });
    }
    if replacing {
        reset_current_live_session_resources(&state).await;
    }
    state
        .current_live_session_epoch
        .fetch_add(1, Ordering::Relaxed);
    *state.current_live_state.write().await = Some(snapshot.clone());

    let display_revision = state.current_display_selection.read().await.revision;
    let realtime_state =
        current_live_realtime_state_from_snapshot(state.as_ref(), &snapshot, display_revision).await;
    publish_current_live_realtime_batch_changed(state.as_ref(), &realtime_state, false, 0)
        .await?;

    let scene = SceneResource::from_scene_document(scene_document).map_err(|error| {
        ApiError::internal(format!("failed to serialize empty authoring scene: {error}"))
    })?;
    Ok((
        StatusCode::CREATED,
        Json(CreateSessionResponse {
            session_id,
            status: ScratchSessionStatusResource {
                requested_execution: execution.clone(),
                effective_execution: execution,
                fallback: None,
            },
            scene_document: ScratchSceneDocumentResource {
                schema_version: "0.3".to_string(),
                version: scene.version,
                revision: scene.revision,
                scene: scene.scene,
                objects: scene.objects,
            },
            revisions: ScratchSessionRevisionsResource {
                state_version: snapshot.state_version,
                scene_revision: snapshot
                    .scene_document
                    .as_ref()
                    .map(|scene| scene.revision)
                    .unwrap_or_default(),
            },
        }),
    ))
}

fn validated_execution(
    request: &CreateSessionRequest,
) -> Result<SessionExecutionResource, ApiError> {
    let supported_backend = matches!(request.backend.as_str(), "fdm" | "fem");
    if !supported_backend || request.device != "cpu" || request.precision != "double" {
        return Err(ApiError::bad_request(
            "supported scratch execution is exactly fdm|fem with cpu device and double precision",
        ));
    }
    Ok(SessionExecutionResource {
        backend: request.backend.clone(),
        device: request.device.clone(),
        precision: request.precision.clone(),
    })
}

pub(crate) fn create_empty_scene_document(
    request: &CreateSessionRequest,
) -> Result<SceneDocument, ApiError> {
    let name = request.name.trim();
    if name.is_empty() {
        return Err(ApiError::bad_request("session name must not be empty"));
    }
    Ok(SceneDocument {
        version: "scene.v2".to_string(),
        revision: 0,
        scene: SceneMetadata {
            id: format!("session-{}", uuid_v4_hex()),
            name: name.to_string(),
            source_of_truth: "ui".to_string(),
            authoring_schema: "0.3".to_string(),
        },
        universe: None,
        objects: Vec::new(),
        couplings: Vec::new(),
        materials: Vec::new(),
        magnetization_assets: Vec::new(),
        field_drives: Default::default(),
        monitors: Default::default(),
        selections: Vec::new(),
        magnetization_constraints: Vec::new(),
        current_modules: Default::default(),
        current_transports: Vec::new(),
        spin_transports: Vec::new(),
        spin_torques: Vec::new(),
        oersted_fields: Vec::new(),
        study: Default::default(),
        outputs: Default::default(),
        editor: Default::default(),
    })
}

fn scratch_snapshot(
    session_id: &str,
    name: &str,
    execution: &SessionExecutionResource,
    scene_document: SceneDocument,
) -> crate::types::SessionStateResponse {
    let now = unix_time_millis_now();
    let manifest = SessionManifest {
        session_id: session_id.to_string(),
        run_id: format!("run-{session_id}"),
        status: "awaiting_command".to_string(),
        interactive_session_requested: true,
        script_path: String::new(),
        problem_name: name.to_string(),
        requested_backend: execution.backend.clone(),
        explicit_selection: true,
        authored_requested_device: execution.device.clone(),
        requested_device: execution.device.clone(),
        requested_precision: execution.precision.clone(),
        requested_mode: "strict".to_string(),
        requested_cpu_threads: None,
        execution_mode: "strict".to_string(),
        precision: execution.precision.clone(),
        resolved_backend: Some(execution.backend.clone()),
        resolved_device: Some(execution.device.clone()),
        resolved_precision: Some(execution.precision.clone()),
        resolved_mode: Some("strict".to_string()),
        resolved_runtime_family: Some(format!("{}_cpu_reference", execution.backend)),
        resolved_engine_id: None,
        resolved_worker: None,
        resolved_cpu_threads: None,
        resolved_fallback: None,
        fem_crossover_decision: None,
        artifact_dir: String::new(),
        started_at_unix_ms: now,
        finished_at_unix_ms: 0,
        plan_summary: json!({
            "requested_execution": execution,
            "effective_execution": execution,
            "fallback": null,
        }),
    };
    let mut snapshot = default_current_live_state(&CurrentLiveSnapshotRequest {
        session_id: session_id.to_string(),
        session: Some(manifest),
        session_status: None,
        metadata: None,
        mesh_workspace: None,
        stage_execution: None,
        simulation_preparation: None,
        run: None,
        live_state: None,
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
    snapshot.metadata = Some(json!({
        "requested_execution": execution,
        "effective_execution": execution,
        "fallback": null,
    }));
    snapshot.scene_document = Some(scene_document);
    snapshot
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn create_empty_scene_document_uses_request_name_and_generates_session_id() {
        let request = CreateSessionRequest {
            name: " Scratch ".to_string(),
            backend: "fdm".to_string(),
            device: "cpu".to_string(),
            precision: "double".to_string(),
            replace_current: false,
        };

        let scene = create_empty_scene_document(&request).expect("request must create a scene");

        assert_eq!(scene.scene.name, "Scratch");
        assert!(scene.scene.id.starts_with("session-"));
        assert!(scene.objects.is_empty());
    }
}
