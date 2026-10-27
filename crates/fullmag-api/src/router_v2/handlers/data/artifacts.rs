//! Artifact endpoints — list and get.

use std::sync::Arc;

use sha2::{Digest, Sha256};

use axum::extract::{Path as AxumPath, State};
use axum::http::header::CONTENT_TYPE;
use axum::http::HeaderMap;
use axum::response::IntoResponse;

use crate::artifacts::{
    read_stage_autosave_metadata, sanitize_artifact_relative_path, try_resolve_artifact_path,
};
use crate::error::ApiError;
use crate::session::{current_artifact_dir, read_artifacts_from_dir};
use crate::types::{AppState, ArtifactResource};

#[utoipa::path(
    get,
    path = "/v2/sessions/current/data/artifacts",
    responses(
        (status = 200, description = "List of artifacts", body = Vec<crate::types::ArtifactResource>),
        (status = 304, description = "Artifact list not modified for the supplied ETag"),
        (status = 404, description = "No active workspace"),
    ),
    tag = "data"
)]
pub async fn list_artifacts(
    State(state): State<Arc<AppState>>,
    headers: HeaderMap,
) -> Result<axum::response::Response, ApiError> {
    let request_context = crate::capture_current_live_request_context(&state).await?;
    let guard = state.current_live_state.read().await;
    let snapshot = guard
        .as_ref()
        .ok_or_else(|| ApiError::not_found("no active local live workspace"))?;
    crate::ensure_current_live_request_context(
        snapshot,
        &request_context,
        state
            .current_live_session_epoch
            .load(std::sync::atomic::Ordering::Acquire),
    )?;
    let artifact_dir = current_artifact_dir(snapshot);
    let stage_execution = snapshot.stage_execution.clone();
    let provenance_by_path = snapshot
        .artifacts
        .iter()
        .filter_map(|entry| {
            entry
                .region_owned_provenance
                .clone()
                .map(|provenance| (entry.path.clone(), provenance))
        })
        .collect::<std::collections::BTreeMap<_, _>>();
    let mut entries = snapshot.artifacts.clone();
    if let Some(artifact_dir) = artifact_dir.as_deref() {
        for disk_entry in read_artifacts_from_dir(Some(artifact_dir))?
            .into_iter()
            .filter(|entry| entry.kind == "stage_autosave")
        {
            if !entries.iter().any(|entry| entry.path == disk_entry.path) {
                entries.push(disk_entry);
            }
        }
    }
    entries.sort_by(|left, right| left.path.cmp(&right.path));
    let mut body = entries
        .into_iter()
        .map(|entry| {
            let mut resource = ArtifactResource::from(entry);
            if resource.region_owned_provenance.is_none() {
                resource.region_owned_provenance = provenance_by_path.get(&resource.path).cloned();
            }
            resource
        })
        .collect::<Vec<_>>();
    if let Some(artifact_dir) = artifact_dir {
        for artifact in &mut body {
            if artifact.kind != "stage_autosave" {
                continue;
            }
            let relative = sanitize_artifact_relative_path(&artifact.path)?;
            let mut metadata = read_stage_autosave_metadata(&artifact_dir.join(relative))?;
            for stage in &mut metadata.stages {
                if stage.complete {
                    continue;
                }
                if let Some(runtime_stage) = stage_execution.as_ref().and_then(|execution| {
                    execution.stages.iter().find(|runtime| {
                        runtime.stage_id.as_deref() == Some(stage.stage_id.as_str())
                    })
                }) {
                    stage.status = runtime_stage.status.as_str().to_string();
                }
            }
            artifact.stage_autosave = Some(metadata);
        }
    }
    // Hash the complete response, including provenance, instead of placing
    // every artifact path in an HTTP header. Signed sweeps otherwise exceed
    // the frontend proxy's header budget before their body can be read.
    let serialized = serde_json::to_vec(&body)
        .map_err(|error| ApiError::internal(format!("serialize artifact catalog: {error}")))?;
    let etag = crate::router_v2::handlers::shared::stable_strong_etag(&format!(
        "artifacts:sha256:{:x}",
        Sha256::digest(&serialized)
    ));
    Ok(crate::router_v2::handlers::shared::conditional_json_response(&headers, &etag, &body))
}

#[utoipa::path(
    get,
    path = "/v2/sessions/current/data/artifacts/{artifact_id}",
    params(
        ("artifact_id" = String, Path, description = "Artifact relative path"),
    ),
    responses(
        (status = 200, description = "Artifact content"),
        (status = 404, description = "Artifact not found"),
    ),
    tag = "data"
)]
pub async fn get_artifact(
    State(state): State<Arc<AppState>>,
    AxumPath(artifact_id): AxumPath<String>,
) -> Result<axum::response::Response, ApiError> {
    let request_context = crate::capture_current_live_request_context(&state).await?;
    let guard = state.current_live_state.read().await;
    let snapshot = guard
        .as_ref()
        .ok_or_else(|| ApiError::not_found("no active local live workspace"))?;
    crate::ensure_current_live_request_context(
        snapshot,
        &request_context,
        state
            .current_live_session_epoch
            .load(std::sync::atomic::Ordering::Acquire),
    )?;
    let artifact_dir = current_artifact_dir(snapshot)
        .ok_or_else(|| ApiError::not_found("no artifact directory for the active workspace"))?;
    drop(guard);

    let relative = sanitize_artifact_relative_path(&artifact_id)?;
    let resolved = try_resolve_artifact_path(&artifact_dir, &relative.display().to_string())?
        .ok_or_else(|| ApiError::not_found(format!("artifact '{}' not found", artifact_id)))?;

    let content_type = match resolved.extension().and_then(|ext| ext.to_str()) {
        Some("json") => "application/json; charset=utf-8",
        Some("csv") => "text/csv; charset=utf-8",
        Some("txt") => "text/plain; charset=utf-8",
        _ => "application/octet-stream",
    };
    let bytes = std::fs::read(&resolved)
        .map_err(|e| ApiError::internal(format!("failed to read artifact: {e}")))?;
    crate::validate_current_live_request_context(&state, &request_context).await?;
    Ok(([(CONTENT_TYPE, content_type)], bytes).into_response())
}

#[cfg(test)]
mod tests {
    use super::*;
    use axum::http::{header, StatusCode};

    #[tokio::test]
    async fn bounded_catalog_etag_preserves_large_body_and_invalidates_changes() {
        let state = crate::router_v2::tests::test_app_state_with_live_session().await;
        {
            let mut current = state.current_live_state.write().await;
            let snapshot = current.as_mut().unwrap();
            snapshot.session.artifact_dir.clear();
            if let Some(run) = snapshot.run.as_mut() {
                run.artifact_dir.clear();
            }
            snapshot.artifacts = (0..250).map(|index| crate::types::ArtifactEntry {
                path: format!("frequency_domain/generations/{}/eigen/modes/sample_{index:04}/mode_0000.json", "a".repeat(64)),
                kind: "eigen_mode".into(),
                region_owned_provenance: None,
            }).collect();
        }
        let first = list_artifacts(State(state.clone()), HeaderMap::new()).await.unwrap();
        assert_eq!(first.status(), StatusCode::OK);
        let etag = first.headers()[header::ETAG].clone();
        assert!(etag.as_bytes().len() < 128, "catalog size must not grow HTTP headers");
        let body = axum::body::to_bytes(first.into_body(), usize::MAX).await.unwrap();
        assert!(body.len() > 16 * 1024, "exercise a sweep larger than the proxy header limit");
        let decoded: Vec<ArtifactResource> = serde_json::from_slice(&body).unwrap();
        assert_eq!(decoded.len(), 250, "the bounded ETag must not truncate results");
        let mut headers = HeaderMap::new();
        headers.insert(header::IF_NONE_MATCH, etag.clone());
        let cached = list_artifacts(State(state.clone()), headers.clone()).await.unwrap();
        assert_eq!(cached.status(), StatusCode::NOT_MODIFIED);
        assert!(axum::body::to_bytes(cached.into_body(), usize::MAX).await.unwrap().is_empty());
        state.current_live_state.write().await.as_mut().unwrap().artifacts[0].kind = "updated_kind".into();
        let changed = list_artifacts(State(state), headers).await.unwrap();
        assert_eq!(changed.status(), StatusCode::OK);
        assert_ne!(changed.headers()[header::ETAG], etag, "metadata changes must invalidate cache");
    }
}
