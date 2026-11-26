use std::{collections::VecDeque, sync::Arc};

use axum::{Json, extract::State};
use fullmag_workspace::{Workspace, WorkspaceError};
use serde::{Deserialize, Serialize};
use utoipa::ToSchema;

use crate::{
    error::ApiError,
    types::{AppState, CurrentLiveRequestContext},
};

const MAX_EVENTS_PER_REQUEST: usize = 20;
const MAX_ENTRIES: usize = 150;
const MAX_RECENT_EVENT_IDS: usize = 4096;
pub(crate) const MAX_REQUEST_BYTES: usize = 512 * 1024;
type WorkspaceResult<T> = Result<T, WorkspaceError>;

#[derive(Debug, Clone, Copy, Deserialize, Serialize, ToSchema)]
#[serde(rename_all = "snake_case")]
pub(crate) enum SessionErrorCategory {
    Frontend,
    Backend,
    Api,
    Model,
}

impl SessionErrorCategory {
    fn as_str(self) -> &'static str {
        match self {
            Self::Frontend => "frontend",
            Self::Backend => "backend",
            Self::Api => "api",
            Self::Model => "model",
        }
    }
}

#[derive(Debug, Clone, Copy, PartialEq, Eq, Deserialize, Serialize, ToSchema)]
#[serde(rename_all = "snake_case")]
pub(crate) enum SessionErrorSeverity {
    Error,
    Warning,
}

#[derive(Debug, Clone, Deserialize, Serialize, ToSchema)]
#[serde(rename_all = "camelCase")]
pub(crate) struct SessionErrorOccurrence {
    event_id: String,
    category: SessionErrorCategory,
    severity: SessionErrorSeverity,
    source: String,
    code: Option<String>,
    title: String,
    message: String,
    detail: Option<String>,
    path: Option<String>,
    request_id: Option<String>,
    first_seen_ms: u64,
    last_seen_ms: u64,
    count: u32,
}

#[derive(Debug, Deserialize, ToSchema)]
#[serde(rename_all = "camelCase")]
pub(crate) struct SessionErrorAppendRequest {
    clear_generation: u64,
    #[schema(min_items = 1, max_items = 20)]
    events: Vec<SessionErrorOccurrence>,
}

#[derive(Debug, Clone, Deserialize, Serialize, ToSchema)]
#[serde(rename_all = "camelCase")]
pub(crate) struct SessionErrorEntry {
    id: String,
    fingerprint: String,
    category: SessionErrorCategory,
    severity: SessionErrorSeverity,
    source: String,
    code: Option<String>,
    title: String,
    message: String,
    detail: Option<String>,
    path: Option<String>,
    request_id: Option<String>,
    first_seen_ms: u64,
    last_seen_ms: u64,
    count: u32,
    session_id: String,
}

#[derive(Debug, Clone, Deserialize, Serialize, ToSchema)]
#[serde(rename_all = "camelCase")]
pub(crate) struct SessionErrorHistoryResource {
    session_id: String,
    revision: u64,
    clear_generation: u64,
    entries: Vec<SessionErrorEntry>,
}

#[derive(Debug, Deserialize, Serialize)]
struct PersistedHistory {
    resource: SessionErrorHistoryResource,
    recent_event_ids: VecDeque<String>,
}

impl PersistedHistory {
    fn from_kv(session_id: &str, value: Option<serde_json::Value>) -> WorkspaceResult<Self> {
        if let Some(value) = value {
            let stored: Self = serde_json::from_value(value)?;
            if stored.resource.session_id != session_id {
                return Err(WorkspaceError::Invalid(
                    "session error history belongs to another session".into(),
                ));
            }
            return Ok(stored);
        }
        Ok(Self {
            resource: SessionErrorHistoryResource {
                session_id: session_id.into(),
                revision: 0,
                clear_generation: 0,
                entries: Vec::new(),
            },
            recent_event_ids: VecDeque::new(),
        })
    }

    fn record(&mut self, event: SessionErrorOccurrence) -> bool {
        if self.recent_event_ids.contains(&event.event_id) {
            return false;
        }
        self.recent_event_ids.push_front(event.event_id.clone());
        self.recent_event_ids.truncate(MAX_RECENT_EVENT_IDS);
        let incoming = normalized_entry(&self.resource.session_id, event);
        let entries = &mut self.resource.entries;
        if let Some(existing) = entries
            .iter_mut()
            .find(|entry| entry.fingerprint == incoming.fingerprint)
        {
            existing.count = existing.count.saturating_add(incoming.count);
            existing.first_seen_ms = existing.first_seen_ms.min(incoming.first_seen_ms);
            if incoming.last_seen_ms >= existing.last_seen_ms {
                existing.last_seen_ms = incoming.last_seen_ms;
                existing.detail = incoming.detail.or(existing.detail.take());
                existing.request_id = incoming.request_id.or(existing.request_id.take());
            }
            if incoming.severity == SessionErrorSeverity::Error {
                existing.severity = incoming.severity;
            }
        } else {
            entries.push(incoming);
        }
        true
    }
}

fn normalized_entry(session_id: &str, event: SessionErrorOccurrence) -> SessionErrorEntry {
    let source = limit(&event.source, 120).unwrap_or_else(|| "unknown".into());
    let title = limit(&event.title, 200).unwrap_or_else(|| "Application error".into());
    let message = limit(&event.message, 1200).unwrap_or_else(|| title.clone());
    let code = event.code.as_deref().and_then(|value| limit(value, 80));
    let path = event.path.as_deref().and_then(|value| limit(value, 300));
    let fingerprint = [
        event.category.as_str().to_owned(),
        source.to_lowercase(),
        code.as_deref().unwrap_or_default().to_lowercase(),
        title.to_lowercase(),
        path.as_deref().unwrap_or_default().to_lowercase(),
        message.chars().take(240).collect::<String>().to_lowercase(),
    ]
    .join("|");
    SessionErrorEntry {
        id: event.event_id,
        fingerprint,
        category: event.category,
        severity: event.severity,
        source,
        code,
        title,
        message,
        detail: event.detail.as_deref().and_then(|value| limit(value, 2400)),
        path,
        request_id: event
            .request_id
            .as_deref()
            .and_then(|value| limit(value, 120)),
        first_seen_ms: event.first_seen_ms,
        last_seen_ms: event.last_seen_ms,
        count: event.count,
        session_id: session_id.into(),
    }
}

fn limit(value: &str, max_chars: usize) -> Option<String> {
    let value = value.trim();
    if value.is_empty() {
        return None;
    }
    if let Some((end, _)) = value.char_indices().nth(max_chars - 1) {
        if value[end..].chars().nth(1).is_some() {
            return Some(format!("{}…", &value[..end]));
        }
    }
    Some(value.into())
}

fn storage_key(session_id: &str) -> String {
    format!("diagnostics.session-errors.v1.{session_id}")
}

fn load(workspace: &Workspace, session_id: &str) -> WorkspaceResult<SessionErrorHistoryResource> {
    let stored =
        PersistedHistory::from_kv(session_id, workspace.get_kv(&storage_key(session_id))?)?;
    Ok(stored.resource)
}

fn update(
    workspace: &Workspace,
    session_id: &str,
    append: Option<SessionErrorAppendRequest>,
) -> WorkspaceResult<Option<SessionErrorHistoryResource>> {
    workspace.update_kv(&storage_key(session_id), move |existing| {
        let mut stored = PersistedHistory::from_kv(session_id, existing)?;
        let changed = if let Some(append) = append {
            if append.clear_generation != stored.resource.clear_generation {
                return Ok((None, None));
            }
            let mut changed = false;
            for event in append.events {
                changed |= stored.record(event);
            }
            changed
        } else {
            stored.resource.clear_generation = stored.resource.clear_generation.saturating_add(1);
            stored.resource.entries.clear();
            stored.recent_event_ids.clear();
            true
        };
        if changed {
            stored.resource.entries.sort_by(|left, right| {
                right
                    .last_seen_ms
                    .cmp(&left.last_seen_ms)
                    .then_with(|| left.id.cmp(&right.id))
            });
            stored.resource.entries.truncate(MAX_ENTRIES);
            stored.resource.revision = stored.resource.revision.saturating_add(1);
        }
        let replacement = changed.then(|| serde_json::to_value(&stored)).transpose()?;
        Ok((replacement, Some(stored.resource)))
    })
}

fn validate_append(append: &SessionErrorAppendRequest) -> Result<(), ApiError> {
    if append.events.is_empty() || append.events.len() > MAX_EVENTS_PER_REQUEST {
        return Err(ApiError::bad_request(
            "session error batch must contain 1–20 events",
        ));
    }
    if append.events.iter().any(|event| {
        event.event_id.is_empty()
            || event.event_id.len() > 160
            || !event
                .event_id
                .bytes()
                .all(|byte| byte.is_ascii_alphanumeric() || b"-_:".contains(&byte))
            || event.count == 0
            || event.first_seen_ms > event.last_seen_ms
            || event.last_seen_ms > 9_007_199_254_740_991
    }) {
        return Err(ApiError::bad_request(
            "invalid session error event identity, count or timestamp",
        ));
    }
    Ok(())
}

async fn workspace_operation<T: Send + 'static>(
    state: &Arc<AppState>,
    context: CurrentLiveRequestContext,
    operation: impl FnOnce(&Workspace, &str) -> WorkspaceResult<T> + Send + 'static,
) -> Result<T, ApiError> {
    let id = context.session_id.clone();
    let result = tokio::task::spawn_blocking(move || {
        let (workspace, outcome) = Workspace::open_default()?;
        fullmag_workspace::log_outcome(&outcome);
        operation(&workspace, &id)
    })
    .await
    .map_err(|error| {
        tracing::warn!(%error, "session error history storage task failed");
        ApiError::internal("Session error history storage unavailable")
    })?
    .map_err(|error| {
        tracing::warn!(%error, "session error history storage unavailable");
        ApiError::internal("Session error history storage unavailable")
    })?;
    let current = crate::capture_current_live_read_context(state).await?;
    if current.session_id != context.session_id
        || current.session_epoch != context.session_epoch
        || current.request_scope_epoch != context.request_scope_epoch
    {
        return Err(ApiError::conflict("request_context_stale"));
    }
    Ok(result)
}

async fn scoped_context(state: &Arc<AppState>) -> Result<CurrentLiveRequestContext, ApiError> {
    if crate::router_v2::middleware::session_scope::current_expected_session_scope().is_none() {
        return Err(ApiError::bad_request(
            "session error history requires X-Fullmag-Session-Scope",
        ));
    }
    crate::capture_current_live_read_context(state).await
}

#[utoipa::path(
    get,
    path = "/v2/sessions/current/diagnostics/session-errors",
    params(("X-Fullmag-Session-Scope" = String, Header, description = "Canonical current session scope")),
    responses(
        (status = 200, description = "Durable session error history", body = SessionErrorHistoryResource),
        (status = 400, description = "Missing or malformed session scope"),
        (status = 404, description = "No active session"),
        (status = 409, description = "Session scope changed"),
    ),
    tag = "diagnostics"
)]
pub(crate) async fn get_session_errors(
    State(state): State<Arc<AppState>>,
) -> Result<Json<SessionErrorHistoryResource>, ApiError> {
    let context = scoped_context(&state).await?;
    workspace_operation(&state, context, load).await.map(Json)
}

#[utoipa::path(
    post,
    path = "/v2/sessions/current/diagnostics/session-errors",
    params(("X-Fullmag-Session-Scope" = String, Header, description = "Canonical current session scope")),
    request_body = SessionErrorAppendRequest,
    responses(
        (status = 200, description = "Durable history after recording events", body = SessionErrorHistoryResource),
        (status = 400, description = "Invalid event batch or session scope"),
        (status = 404, description = "No active session"),
        (status = 409, description = "Session scope changed or history was cleared"),
    ),
    tag = "diagnostics"
)]
pub(crate) async fn append_session_errors(
    State(state): State<Arc<AppState>>,
    Json(append): Json<SessionErrorAppendRequest>,
) -> Result<Json<SessionErrorHistoryResource>, ApiError> {
    let context = scoped_context(&state).await?;
    validate_append(&append)?;
    workspace_operation(&state, context, move |workspace, id| {
        update(workspace, id, Some(append))
    })
    .await?
    .map(Json)
    .ok_or_else(|| {
        ApiError::conflict_with_code(
            "session_error_history_cleared",
            "Session error history was cleared before this batch was recorded",
        )
    })
}

#[utoipa::path(
    delete,
    path = "/v2/sessions/current/diagnostics/session-errors",
    params(("X-Fullmag-Session-Scope" = String, Header, description = "Canonical current session scope")),
    responses(
        (status = 200, description = "Durably cleared session error history", body = SessionErrorHistoryResource),
        (status = 400, description = "Missing or malformed session scope"),
        (status = 404, description = "No active session"),
        (status = 409, description = "Session scope changed"),
    ),
    tag = "diagnostics"
)]
pub(crate) async fn clear_session_errors(
    State(state): State<Arc<AppState>>,
) -> Result<Json<SessionErrorHistoryResource>, ApiError> {
    let context = scoped_context(&state).await?;
    workspace_operation(&state, context, |workspace, id| update(workspace, id, None))
        .await?
        .map(Json)
        .ok_or_else(|| ApiError::internal("Session error history clear did not complete"))
}

#[cfg(test)]
mod tests {
    use super::*;

    fn event(id: &str, time: u64, count: u32) -> SessionErrorOccurrence {
        SessionErrorOccurrence {
            event_id: id.into(),
            category: SessionErrorCategory::Api,
            severity: SessionErrorSeverity::Error,
            source: "http".into(),
            code: Some("HTTP_500".into()),
            title: "API HTTP 500".into(),
            message: "Request failed".into(),
            detail: None,
            path: Some("GET /example".into()),
            request_id: None,
            first_seen_ms: time,
            last_seen_ms: time,
            count,
        }
    }

    fn batch(
        clear_generation: u64,
        events: Vec<SessionErrorOccurrence>,
    ) -> Option<SessionErrorAppendRequest> {
        Some(SessionErrorAppendRequest {
            clear_generation,
            events,
        })
    }

    #[test]
    fn reopening_preserves_session_history_and_replay_does_not_increment_count() {
        let directory = tempfile::tempdir().unwrap();
        let database = directory.path().join("workspace.db");
        let (workspace, _) = Workspace::open(&database).unwrap();
        let saved = update(&workspace, "session-a", batch(0, vec![event("id-1", 2, 3)]))
            .unwrap()
            .unwrap();
        drop(workspace);

        let (workspace, _) = Workspace::open(&database).unwrap();
        let reloaded = load(&workspace, "session-a").unwrap();
        assert_eq!(reloaded.revision, saved.revision);
        assert_eq!(reloaded.entries[0].count, 3);
        assert!(load(&workspace, "session-b").unwrap().entries.is_empty());
        let replay = update(&workspace, "session-a", batch(0, vec![event("id-1", 2, 3)]))
            .unwrap()
            .unwrap();
        assert_eq!(replay.revision, saved.revision);
        let accumulated = update(&workspace, "session-a", batch(0, vec![event("id-2", 1, 1)]))
            .unwrap()
            .unwrap();
        let entry = &accumulated.entries[0];
        assert_eq!(
            (entry.count, entry.first_seen_ms, entry.last_seen_ms),
            (4, 1, 2)
        );
    }

    #[test]
    fn clear_fences_queued_events_from_the_old_generation() {
        let directory = tempfile::tempdir().unwrap();
        let (workspace, _) = Workspace::open(directory.path().join("workspace.db")).unwrap();
        update(&workspace, "session-a", batch(0, vec![event("id-1", 1, 1)])).unwrap();
        let cleared = update(&workspace, "session-a", None).unwrap().unwrap();
        assert_eq!(cleared.clear_generation, 1);
        assert!(cleared.entries.is_empty());
        assert!(
            update(&workspace, "session-a", batch(0, vec![event("id-2", 2, 1)]))
                .unwrap()
                .is_none()
        );
        let new = update(&workspace, "session-a", batch(1, vec![event("id-3", 3, 1)]))
            .unwrap()
            .unwrap();
        assert_eq!(new.entries[0].id, "id-3");
        assert_eq!(new.entries[0].count, 1);
    }
}
