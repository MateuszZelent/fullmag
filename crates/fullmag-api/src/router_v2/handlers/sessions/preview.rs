//! Read-only authored scenes live beside the one execution workspace.
//! Preview admission has no path to the current session, scheduler or native runtime.

use std::{collections::BTreeMap, sync::Arc};

use axum::{
    body::Bytes,
    extract::{Path, State},
    http::{header, StatusCode},
    Json,
};
use fullmag_authoring::SceneDocument;
use serde::Deserialize;
use serde_json::Value;
use tokio::sync::{OwnedSemaphorePermit, RwLock, Semaphore};
use utoipa::ToSchema;

use crate::{
    schemas::{
        authoring::SceneResource, projects::ProjectFromScriptRequest,
        sessions::SessionSummaryResource,
    },
    types::AppState,
    ApiError,
};

pub(crate) const MAX_SCENE_BYTES: usize = 8 * 1024 * 1024;
const MAX_PREVIEWS: usize = 16;
const MAX_RETAINED_BYTES: usize = 32 * 1024 * 1024;

#[derive(Debug)]
pub(crate) struct SessionPreviews {
    entries: RwLock<BTreeMap<String, Preview>>,
    script_captures: Arc<Semaphore>,
}

impl Default for SessionPreviews {
    fn default() -> Self {
        Self {
            entries: RwLock::default(),
            script_captures: Arc::new(Semaphore::new(2)),
        }
    }
}

#[derive(Debug)]
struct Preview {
    name: String,
    scene: Bytes,
}

impl SessionPreviews {
    pub(crate) async fn summaries(&self) -> Vec<SessionSummaryResource> {
        self.entries
            .read()
            .await
            .iter()
            .map(|(id, preview)| preview.summary(id))
            .collect()
    }

    async fn admit_script_capture(&self) -> Result<OwnedSemaphorePermit, ApiError> {
        let entries = self.entries.read().await;
        check_capacity(&entries, 1)?;
        self.script_captures
            .clone()
            .try_acquire_owned()
            .map_err(|_| {
                ApiError::too_many_requests_with_code(
                    "session_preview_capture_busy",
                    "Wait for an in-progress preview to load.",
                )
            })
    }

    async fn insert(&self, document: SceneDocument) -> Result<SessionSummaryResource, ApiError> {
        let id = format!("preview-{}", uuid::Uuid::new_v4().simple());
        let name = document.scene.name.clone();
        let scene = SceneResource::from_scene_document(document)
            .and_then(|resource| serde_json::to_vec(&resource))
            .map_err(|error| ApiError::internal(format!("failed to serialize preview: {error}")))?;
        if scene.len() > MAX_SCENE_BYTES {
            return Err(ApiError::with_status_and_code(
                StatusCode::PAYLOAD_TOO_LARGE,
                "session_preview_too_large",
                "The preview scene exceeds 8 MiB.",
            ));
        }
        let mut previews = self.entries.write().await;
        check_capacity(&previews, scene.len())?;
        let preview = Preview {
            name,
            scene: scene.into(),
        };
        let summary = preview.summary(&id);
        previews.insert(id, preview);
        Ok(summary)
    }
}

fn check_capacity(entries: &BTreeMap<String, Preview>, added_bytes: usize) -> Result<(), ApiError> {
    let total: usize = entries.values().map(|entry| entry.scene.len()).sum();
    if entries.len() >= MAX_PREVIEWS || total + added_bytes > MAX_RETAINED_BYTES {
        return Err(ApiError::too_many_requests_with_code(
            "session_preview_capacity",
            "Close an existing preview to open another one.",
        ));
    }
    Ok(())
}

impl Preview {
    fn summary(&self, id: &str) -> SessionSummaryResource {
        SessionSummaryResource {
            session_id: id.to_string(),
            name: self.name.clone(),
            status: "preview".into(),
            current: false,
        }
    }
}

#[derive(Debug, Deserialize, ToSchema)]
pub(crate) struct CreateSessionPreviewRequest {
    /// A captured authored SceneDocument (scene.v2).
    #[schema(value_type = Object, additional_properties)]
    scene_document: Value,
}

#[utoipa::path(
    post,
    path = "/v2/sessions/previews",
    operation_id = "sessions_create_preview",
    request_body = CreateSessionPreviewRequest,
    responses(
        (status = 201, description = "Read-only session preview created", body = SessionSummaryResource),
        (status = 400, description = "Invalid authored scene"),
        (status = 413, description = "Preview scene exceeds 8 MiB"),
        (status = 429, description = "Preview capacity exhausted")
    ),
    tag = "sessions"
)]
pub(crate) async fn create_preview(
    State(state): State<Arc<AppState>>,
    Json(request): Json<CreateSessionPreviewRequest>,
) -> Result<(StatusCode, Json<SessionSummaryResource>), ApiError> {
    let document: SceneDocument = serde_json::from_value(request.scene_document)
        .map_err(|error| ApiError::bad_request(format!("invalid preview scene: {error}")))?;
    save_preview(&state, document).await
}

#[utoipa::path(
    post,
    path = "/v2/sessions/previews/from-script",
    operation_id = "sessions_create_preview_from_script",
    request_body = ProjectFromScriptRequest,
    responses(
        (status = 201, description = "Model preview created after explicit consent to evaluate Python", body = SessionSummaryResource),
        (status = 400, description = "Missing consent, source or valid model"),
        (status = 413, description = "Script or preview scene exceeds its size bound"),
        (status = 422, description = "The helper could not export an authored scene"),
        (status = 429, description = "Preview capacity exhausted")
    ),
    tag = "sessions"
)]
pub(crate) async fn create_preview_from_script(
    State(state): State<Arc<AppState>>,
    Json(request): Json<ProjectFromScriptRequest>,
) -> Result<(StatusCode, Json<SessionSummaryResource>), ApiError> {
    let capture_slot = state.session_previews.admit_script_capture().await?;
    let document = crate::router_v2::handlers::persistence::script_project::capture_script_preview(
        &state,
        request,
        capture_slot,
    )
    .await?;
    save_preview(&state, document).await
}

async fn save_preview(
    state: &AppState,
    mut document: SceneDocument,
) -> Result<(StatusCode, Json<SessionSummaryResource>), ApiError> {
    let name = document.scene.name.trim();
    if document.version != "scene.v2" || name.is_empty() || name.len() > 512 {
        return Err(ApiError::bad_request(
            "A scene.v2 document with a name of 1 to 512 UTF-8 bytes is required.",
        ));
    }
    document.scene.name = name.to_owned();
    // Preview renders the typed scene without checking execution readiness.
    // Exported study stages may omit parameters that the authoring workspace requires.
    let preview = state.session_previews.insert(document).await?;
    Ok((StatusCode::CREATED, Json(preview)))
}

#[utoipa::path(
    get,
    path = "/v2/sessions/previews/{session_id}",
    operation_id = "sessions_get_preview",
    params(("session_id" = String, Path, description = "Read-only preview session ID")),
    responses(
        (status = 200, description = "Authored preview scene", body = SceneResource),
        (status = 404, description = "Preview session not found")
    ),
    tag = "sessions"
)]
pub(crate) async fn get_preview(
    State(state): State<Arc<AppState>>,
    Path(session_id): Path<String>,
) -> Result<([(header::HeaderName, &'static str); 2], Bytes), ApiError> {
    let scene = state
        .session_previews
        .entries
        .read()
        .await
        .get(&session_id)
        .map(|preview| preview.scene.clone())
        .ok_or_else(|| ApiError::not_found("Preview session not found."))?;
    Ok((
        [
            (header::CONTENT_TYPE, "application/json"),
            (header::CACHE_CONTROL, "no-store"),
        ],
        scene,
    ))
}

#[utoipa::path(
    delete,
    path = "/v2/sessions/previews/{session_id}",
    operation_id = "sessions_close_preview",
    params(("session_id" = String, Path, description = "Read-only preview session ID")),
    responses(
        (status = 204, description = "Preview session closed"),
        (status = 404, description = "Preview session not found")
    ),
    tag = "sessions"
)]
pub(crate) async fn close_preview(
    State(state): State<Arc<AppState>>,
    Path(session_id): Path<String>,
) -> Result<StatusCode, ApiError> {
    state
        .session_previews
        .entries
        .write()
        .await
        .remove(&session_id)
        .ok_or_else(|| ApiError::not_found("Preview session not found."))?;
    Ok(StatusCode::NO_CONTENT)
}

#[cfg(test)]
mod tests {
    use super::*;

    #[tokio::test]
    async fn script_capture_admission_is_bounded() {
        let previews = SessionPreviews::default();
        let first = previews.admit_script_capture().await.unwrap();
        let second = previews.admit_script_capture().await.unwrap();
        let busy = previews.admit_script_capture().await.unwrap_err();
        assert_eq!(busy.code.as_deref(), Some("session_preview_capture_busy"));
        drop(first);
        previews.admit_script_capture().await.unwrap();
        drop(second);
    }
}
