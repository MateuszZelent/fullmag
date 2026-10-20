//! Read-only page over durable accepted runs and task catalogs.

use std::{path::Path, sync::Arc};

use axum::{
    extract::{Query, State},
    http::HeaderMap,
    response::Response,
};
use base64::{engine::general_purpose::URL_SAFE_NO_PAD, Engine as _};
use chrono::{DateTime, Utc};
use fullmag_application::RunSpecification;
use fullmag_session::{FmsTaskLifecycle, FmsTaskReadiness, SessionStore};
use serde::{Deserialize, Serialize};
use sha2::{Digest, Sha256};

use crate::{
    error::ApiError,
    router_v2::handlers::shared::{conditional_json_response, stable_strong_etag},
    schemas::compute_queue::{
        ComputeQueueItemResource, ComputeQueueItemState, ComputeQueuePageQuery,
        ComputeQueueResource,
    },
    types::AppState,
};

const MAX_QUEUE_PAGE_SIZE: u32 = 100;
const DEFAULT_QUEUE_PAGE_SIZE: u32 = 50;

#[derive(Debug, Serialize, Deserialize)]
#[serde(deny_unknown_fields)]
struct ComputeQueueCursor {
    revision: String,
    after_item_id: String,
}

#[utoipa::path(
    get,
    path = "/v2/platform/compute/queue",
    params(ComputeQueuePageQuery),
    responses(
        (status = 200, description = "Bounded read model of the existing durable run scheduler", body = ComputeQueueResource),
        (status = 304, description = "The requested compute queue page is unchanged"),
        (status = 400, description = "Invalid page size or cursor"),
        (status = 409, description = "The queue changed while paging; refresh from the first page"),
        (status = 503, description = "Managed accepted-run storage is unavailable")
    ),
    tag = "platform"
)]
pub async fn get_compute_queue(
    State(state): State<Arc<AppState>>,
    Query(query): Query<ComputeQueuePageQuery>,
    headers: HeaderMap,
) -> Result<Response, ApiError> {
    let limit = query.limit.unwrap_or(DEFAULT_QUEUE_PAGE_SIZE);
    if !(1..=MAX_QUEUE_PAGE_SIZE).contains(&limit) {
        return Err(ApiError::bad_request(format!(
            "compute queue page limit must be from 1 to {MAX_QUEUE_PAGE_SIZE}"
        )));
    }
    let cursor = query.cursor.map(parse_cursor).transpose()?;
    let store_root = state.submit_store_root.clone().ok_or_else(|| {
        ApiError::with_status_and_code(
            axum::http::StatusCode::SERVICE_UNAVAILABLE,
            "compute_queue_unavailable",
            "Managed accepted-run storage is not configured.",
        )
    })?;
    let instance_id = state.request_scope_instance_id.to_string();
    let resource = tokio::task::spawn_blocking(move || {
        let items = load_queue_items(&store_root)?;
        page_queue(items, limit as usize, cursor)
    })
    .await
    .map_err(|error| ApiError::internal(format!("compute queue read task failed: {error}")))??;

    let etag = stable_strong_etag(&format!(
        "compute-queue:{}:{}:{}",
        instance_id,
        resource.revision,
        query_page_identity(&resource)
    ));
    Ok(conditional_json_response(&headers, &etag, &resource))
}

fn load_queue_items(store_root: &Path) -> Result<Vec<QueueItemWithTime>, ApiError> {
    if !store_root.exists() {
        return Ok(Vec::new());
    }
    let store = SessionStore::open_existing(store_root)
        .map_err(|error| ApiError::internal(format!("open accepted-run store: {error}")))?;
    let intents = store
        .list_run_intents()
        .map_err(|error| ApiError::internal(format!("read accepted run intents: {error}")))?;
    let mut items = Vec::new();
    for intent in intents {
        let specification: RunSpecification = serde_json::from_value(intent.specification.clone())
            .map_err(|error| ApiError::internal(format!("invalid durable RunSpec: {error}")))?;
        if specification.run_id.as_str() != intent.run_id
            || specification
                .fingerprint()
                .map_err(|error| ApiError::internal(error.to_string()))?
                != intent.payload_sha256
        {
            return Err(ApiError::internal(
                "durable run identity or fingerprint is inconsistent",
            ));
        }
        let project_id = specification.snapshot.project_id.as_str().to_owned();
        let accepted_at = intent.accepted_at;
        let Some(catalog) = store
            .read_run_catalog(&intent.run_id)
            .map_err(|error| ApiError::internal(format!("read run task catalog: {error}")))?
        else {
            items.push(QueueItemWithTime {
                accepted_at: accepted_at.clone(),
                item: ComputeQueueItemResource {
                    item_id: format!("run/{}/materialization", intent.run_id),
                    project_id,
                    run_id: intent.run_id,
                    task_id: None,
                    accepted_at: accepted_at.to_rfc3339(),
                    scheduling_priority: specification.scheduling_priority,
                    state: ComputeQueueItemState::PendingMaterialization,
                    blocking_reason: None,
                    attempt_id: None,
                    ownership_epoch: None,
                    resource_id: None,
                },
            });
            continue;
        };

        if catalog.tasks.is_empty() {
            items.push(QueueItemWithTime {
                accepted_at: accepted_at.clone(),
                item: ComputeQueueItemResource {
                    item_id: format!("run/{}/materialization", intent.run_id),
                    project_id,
                    run_id: intent.run_id,
                    task_id: None,
                    accepted_at: accepted_at.to_rfc3339(),
                    scheduling_priority: specification.scheduling_priority,
                    state: ComputeQueueItemState::PendingMaterialization,
                    blocking_reason: None,
                    attempt_id: None,
                    ownership_epoch: None,
                    resource_id: None,
                },
            });
            continue;
        }

        for task in catalog.tasks {
            let state = match task.lifecycle {
                FmsTaskLifecycle::Accepted => ComputeQueueItemState::Accepted,
                FmsTaskLifecycle::Queued => ComputeQueueItemState::Queued,
                FmsTaskLifecycle::Preparing => ComputeQueueItemState::Preparing,
                FmsTaskLifecycle::Running => ComputeQueueItemState::Running,
                FmsTaskLifecycle::Stopping => ComputeQueueItemState::Stopping,
                FmsTaskLifecycle::Succeeded
                | FmsTaskLifecycle::Failed
                | FmsTaskLifecycle::Cancelled
                | FmsTaskLifecycle::Interrupted => continue,
            };
            let blocking_reason = match task.readiness {
                FmsTaskReadiness::Ready => None,
                FmsTaskReadiness::Blocked { reason } => Some(reason),
            };
            items.push(QueueItemWithTime {
                accepted_at: accepted_at.clone(),
                item: ComputeQueueItemResource {
                    item_id: format!("run/{}/task/{}", intent.run_id, task.task_id),
                    project_id: project_id.clone(),
                    run_id: intent.run_id.clone(),
                    task_id: Some(task.task_id),
                    accepted_at: accepted_at.to_rfc3339(),
                    scheduling_priority: specification.scheduling_priority,
                    state,
                    blocking_reason,
                    attempt_id: task.attempt_id,
                    ownership_epoch: task.ownership_epoch,
                    resource_id: task.resource_id,
                },
            });
        }
    }
    items.sort_by(|left, right| {
        left.accepted_at
            .cmp(&right.accepted_at)
            .then_with(|| left.item.item_id.cmp(&right.item.item_id))
    });
    Ok(items)
}

struct QueueItemWithTime {
    accepted_at: DateTime<Utc>,
    item: ComputeQueueItemResource,
}

fn page_queue(
    items: Vec<QueueItemWithTime>,
    limit: usize,
    cursor: Option<ComputeQueueCursor>,
) -> Result<ComputeQueueResource, ApiError> {
    let items = items.into_iter().map(|row| row.item).collect::<Vec<_>>();
    let bytes = serde_json::to_vec(&items)
        .map_err(|error| ApiError::internal(format!("serialize compute queue: {error}")))?;
    let revision = format!("sha256:{:x}", Sha256::digest(bytes));
    let start = if let Some(cursor) = cursor {
        if cursor.revision != revision {
            return Err(ApiError::conflict(
                "the compute queue changed while paging; refresh from the first page",
            ));
        }
        items
            .iter()
            .position(|item| item.item_id == cursor.after_item_id)
            .map(|position| position + 1)
            .ok_or_else(|| ApiError::bad_request("compute queue cursor is not in this revision"))?
    } else {
        0
    };
    let mut page = items
        .into_iter()
        .skip(start)
        .take(limit + 1)
        .collect::<Vec<_>>();
    let has_more = page.len() > limit;
    if has_more {
        page.pop();
    }
    let next_cursor = if has_more {
        page.last()
            .map(|item| encode_cursor(&revision, &item.item_id))
            .transpose()?
    } else {
        None
    };
    Ok(ComputeQueueResource {
        schema_version: "compute_queue.v1".into(),
        revision,
        items: page,
        next_cursor,
    })
}

fn parse_cursor(value: String) -> Result<ComputeQueueCursor, ApiError> {
    if value.is_empty() || value.len() > 4096 {
        return Err(ApiError::bad_request("invalid compute queue cursor size"));
    }
    let bytes = URL_SAFE_NO_PAD
        .decode(value)
        .map_err(|_| ApiError::bad_request("invalid compute queue cursor encoding"))?;
    let cursor: ComputeQueueCursor = serde_json::from_slice(&bytes)
        .map_err(|_| ApiError::bad_request("invalid compute queue cursor payload"))?;
    if !cursor.revision.starts_with("sha256:") || cursor.after_item_id.is_empty() {
        return Err(ApiError::bad_request("invalid compute queue cursor fields"));
    }
    Ok(cursor)
}

fn encode_cursor(revision: &str, after_item_id: &str) -> Result<String, ApiError> {
    let bytes = serde_json::to_vec(&ComputeQueueCursor {
        revision: revision.to_owned(),
        after_item_id: after_item_id.to_owned(),
    })
    .map_err(|error| ApiError::internal(format!("serialize compute queue cursor: {error}")))?;
    Ok(URL_SAFE_NO_PAD.encode(bytes))
}

fn query_page_identity(resource: &ComputeQueueResource) -> String {
    resource
        .items
        .first()
        .map(|item| item.item_id.as_str())
        .unwrap_or("empty")
        .to_owned()
        + ":"
        + resource
            .items
            .last()
            .map(|item| item.item_id.as_str())
            .unwrap_or("empty")
}

#[cfg(test)]
mod tests {
    use super::*;

    fn item(item_id: &str, accepted_at: DateTime<Utc>) -> QueueItemWithTime {
        QueueItemWithTime {
            accepted_at,
            item: ComputeQueueItemResource {
                item_id: item_id.into(),
                project_id: "project-1".into(),
                run_id: "run-1".into(),
                task_id: Some(item_id.into()),
                accepted_at: "2026-10-16T00:00:00+00:00".into(),
                scheduling_priority: 0,
                state: ComputeQueueItemState::Queued,
                blocking_reason: None,
                attempt_id: None,
                ownership_epoch: None,
                resource_id: None,
            },
        }
    }

    #[test]
    fn queue_cursor_pages_one_revision_and_rejects_a_changed_snapshot() {
        let accepted_at = Utc::now();
        let rows = vec![
            item("task-a", accepted_at.clone()),
            item("task-b", accepted_at.clone()),
        ];
        let first = page_queue(rows, 1, None).unwrap();
        let cursor = parse_cursor(first.next_cursor.clone().unwrap()).unwrap();
        let second = page_queue(
            vec![
                item("task-a", accepted_at.clone()),
                item("task-b", accepted_at.clone()),
            ],
            1,
            Some(cursor),
        )
        .unwrap();

        assert_eq!(first.items[0].item_id, "task-a");
        assert_eq!(second.items[0].item_id, "task-b");
        assert!(second.next_cursor.is_none());

        let cursor = parse_cursor(first.next_cursor.unwrap()).unwrap();
        let changed = page_queue(
            vec![
                item("task-a", accepted_at.clone()),
                item("task-c", accepted_at.clone()),
            ],
            1,
            Some(cursor),
        )
        .err()
        .expect("a cursor must reject a changed queue revision");
        assert!(changed.to_string().contains("queue changed"));
    }
}
