//! Immutable authoring profiles in the configured accepted-run store.

use std::{path::PathBuf, sync::Arc};

use axum::{
    extract::{Query, State},
    http::{HeaderMap, StatusCode},
    response::Response,
    Json,
};
use fullmag_session::{
    execution_profiles::{
        ExecutionProfileCatalog, ExecutionProfileCatalogEntry, ProfileCatalogError,
        ProfilePublicationDisposition,
    },
    SessionStore,
};
use sha2::{Digest, Sha256};

use crate::{
    error::ApiError,
    router_v2::handlers::shared::{conditional_json_response, stable_strong_etag},
    schemas::compute_profiles::{
        ExecutionProfileCatalogResource, ExecutionProfileVersionResource, ProfileCatalogQuery,
        ProfilePublicationDispositionSchema, PublishExecutionProfileRequest,
        PublishExecutionProfileResource,
    },
    types::AppState,
};

#[utoipa::path(
    get,
    path = "/v2/platform/compute/profiles",
    params(ProfileCatalogQuery),
    responses(
        (status = 200, description = "Immutable profile versions and catalogue revision", body = ExecutionProfileCatalogResource),
        (status = 304, description = "Profile catalogue page is unchanged"),
        (status = 400, description = "Invalid catalogue query"),
        (status = 409, description = "Catalogue revision changed while paging"),
        (status = 503, description = "No configured profile store"),
    ),
    tag = "platform"
)]
pub async fn get_compute_profiles(
    State(state): State<Arc<AppState>>,
    Query(query): Query<ProfileCatalogQuery>,
    headers: HeaderMap,
) -> Result<Response, ApiError> {
    let root = configured_root(&state)?;
    let resource =
        tokio::task::spawn_blocking(move || catalog_page(read_validated_catalog(root)?, query))
            .await
            .map_err(|error| {
                ApiError::internal(format!("profile catalogue read failed: {error}"))
            })??;
    let bytes = serde_json::to_vec(&resource)
        .map_err(|error| ApiError::internal(format!("encode profile catalogue: {error}")))?;
    let etag = stable_strong_etag(&format!(
        "compute-profiles:{}:{:x}",
        state.request_scope_instance_id,
        Sha256::digest(bytes)
    ));
    Ok(conditional_json_response(&headers, &etag, &resource))
}

#[utoipa::path(
    post,
    path = "/v2/platform/compute/profiles",
    request_body = PublishExecutionProfileRequest,
    responses(
        (status = 201, description = "Immutable profile version published", body = PublishExecutionProfileResource),
        (status = 200, description = "Identical publication intent replayed", body = PublishExecutionProfileResource),
        (status = 400, description = "Invalid profile or publication identity"),
        (status = 409, description = "Revision, intent, version or catalogue capacity conflict"),
        (status = 503, description = "No configured profile store"),
    ),
    tag = "platform"
)]
pub async fn post_compute_profile(
    State(state): State<Arc<AppState>>,
    Json(request): Json<PublishExecutionProfileRequest>,
) -> Result<(StatusCode, Json<PublishExecutionProfileResource>), ApiError> {
    let root = configured_root(&state)?;
    // Publication validates semantic defaults with the same resolver as Submit.
    // It neither probes a device nor admits execution of this profile.
    fullmag_application::materialize_execution_request(Some(request.profile.clone()), vec![])
        .map_err(ApiError::bad_request)?;
    fullmag_session::repository_path::validate_store_id(&request.client_intent_id)
        .map_err(|error| ApiError::bad_request(format!("invalid publication intent: {error}")))?;
    let published = tokio::task::spawn_blocking(move || {
        let store = match std::fs::symlink_metadata(&root) {
            Err(error) if error.kind() == std::io::ErrorKind::NotFound => SessionStore::open(root),
            Ok(_) => SessionStore::open_existing(root),
            Err(error) => {
                return Err(ApiError::internal(format!(
                    "inspect profile store: {error}"
                )))
            }
        };
        store
            .map_err(|error| ApiError::internal(format!("open profile store: {error}")))?
            .publish_execution_profile(
                request.expected_revision,
                &request.client_intent_id,
                request.profile,
            )
            .map_err(publication_error)
    })
    .await
    .map_err(|error| ApiError::internal(format!("profile publication task failed: {error}")))??;
    let (status, disposition) = match published.disposition {
        ProfilePublicationDisposition::Published => (
            StatusCode::CREATED,
            ProfilePublicationDispositionSchema::Published,
        ),
        ProfilePublicationDisposition::Existing => (
            StatusCode::OK,
            ProfilePublicationDispositionSchema::Existing,
        ),
    };
    Ok((
        status,
        Json(PublishExecutionProfileResource {
            disposition,
            revision: published.catalog.revision,
            entry: version_resource(published.entry),
        }),
    ))
}

pub(super) fn read_validated_catalog(root: PathBuf) -> Result<ExecutionProfileCatalog, ApiError> {
    let catalog = match std::fs::symlink_metadata(&root) {
        Err(error) if error.kind() == std::io::ErrorKind::NotFound => {
            ExecutionProfileCatalog::default()
        }
        Err(error) => {
            return Err(ApiError::internal(format!(
                "inspect profile store: {error}"
            )))
        }
        Ok(_) => SessionStore::open_existing(root)
            .map_err(|error| ApiError::internal(format!("open profile store: {error}")))?
            .read_execution_profile_catalog()
            .map_err(|error| ApiError::internal(format!("read profile catalogue: {error}")))?,
    };
    for entry in &catalog.entries {
        fullmag_application::materialize_execution_request(Some(entry.profile.clone()), vec![])
            .map_err(|error| {
                ApiError::internal(format!("saved execution profile is invalid: {error}"))
            })?;
    }
    Ok(catalog)
}

pub(super) fn configured_root(state: &AppState) -> Result<PathBuf, ApiError> {
    state
        .submit_store_root
        .clone()
        .filter(|root| root.is_absolute())
        .ok_or_else(|| ApiError {
            status: StatusCode::SERVICE_UNAVAILABLE,
            code: Some("execution_profile_store_unavailable".into()),
            message: "Execution profiles require a configured accepted-run store.".into(),
            diagnostics: vec![],
        })
}

fn catalog_page(
    catalog: ExecutionProfileCatalog,
    query: ProfileCatalogQuery,
) -> Result<ExecutionProfileCatalogResource, ApiError> {
    let limit = query.limit.unwrap_or(50);
    if limit == 0 || limit > 100 {
        return Err(ApiError::bad_request(
            "profile catalogue limit must be between 1 and 100",
        ));
    }
    if query.version.is_some() && query.profile_id.is_none() {
        return Err(ApiError::bad_request(
            "profile version filter requires profile_id",
        ));
    }
    if query
        .revision
        .is_some_and(|revision| revision != catalog.revision)
    {
        return Err(ApiError::conflict_with_code(
            "execution_profile_revision_conflict",
            "Profile catalogue changed. Refresh before continuing.",
        ));
    }
    let revision = catalog.revision;
    let filtered = catalog
        .entries
        .into_iter()
        .filter(|entry| {
            query
                .profile_id
                .as_ref()
                .is_none_or(|id| *id == entry.profile.profile_id)
                && query
                    .version
                    .as_ref()
                    .is_none_or(|version| *version == entry.profile.version)
                && query
                    .client_intent_id
                    .as_ref()
                    .is_none_or(|id| *id == entry.client_intent_id)
        })
        .collect::<Vec<_>>();
    let total = filtered.len() as u32;
    let offset = query.offset.unwrap_or(0);
    let entries = filtered
        .into_iter()
        .skip(offset as usize)
        .take(limit as usize)
        .map(version_resource)
        .collect::<Vec<_>>();
    let next = offset.saturating_add(entries.len() as u32);
    Ok(ExecutionProfileCatalogResource {
        schema_version: "execution_profile_catalog.v1".into(),
        revision,
        total,
        offset,
        next_offset: (next < total).then_some(next),
        entries,
    })
}

fn version_resource(entry: ExecutionProfileCatalogEntry) -> ExecutionProfileVersionResource {
    ExecutionProfileVersionResource {
        profile: entry.profile,
        profile_sha256: entry.profile_sha256,
        client_intent_id: entry.client_intent_id,
        published_at: entry.published_at,
        revision: entry.revision,
    }
}

fn publication_error(error: ProfileCatalogError) -> ApiError {
    match error {
        ProfileCatalogError::Invalid(message) => ApiError::bad_request(message),
        ProfileCatalogError::RevisionConflict { expected, actual } => ApiError::conflict_with_code(
            "execution_profile_revision_conflict",
            format!("Profile catalogue revision {actual} differs from expected {expected}. Refresh before publishing."),
        ),
        ProfileCatalogError::IntentConflict => ApiError::conflict_with_code("execution_profile_intent_conflict", "Publication intent already refers to different profile content."),
        ProfileCatalogError::VersionConflict => ApiError::conflict_with_code("execution_profile_version_conflict", "This profile version is immutable. Publish a new version."),
        ProfileCatalogError::CapacityExceeded => ApiError::conflict_with_code("execution_profile_catalog_full", "Profile catalogue capacity has been reached."),
        ProfileCatalogError::Storage(message) => ApiError::internal(format!("Profile publication failed: {message}")),
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    fn catalog() -> ExecutionProfileCatalog {
        ExecutionProfileCatalog {
            revision: 3,
            entries: (1..=3)
                .map(|revision| ExecutionProfileCatalogEntry {
                    profile: fullmag_ir::ExecutionProfileIR {
                        profile_id: "exec:test".into(),
                        version: revision.to_string(),
                        ..Default::default()
                    },
                    profile_sha256: "a".repeat(64),
                    client_intent_id: format!("intent-{revision}"),
                    published_at: "2026-10-05T00:00:00Z".into(),
                    revision,
                })
                .collect(),
            ..Default::default()
        }
    }

    fn query(value: serde_json::Value) -> ProfileCatalogQuery {
        serde_json::from_value(value).unwrap()
    }

    #[test]
    fn paging_is_revision_pinned_and_lookup_can_reconcile_a_publication() {
        let first = catalog_page(catalog(), query(serde_json::json!({"limit": 2}))).unwrap();
        assert_eq!(first.total, 3);
        assert_eq!(first.next_offset, Some(2));
        let last = catalog_page(
            catalog(),
            query(serde_json::json!({"offset": 2, "revision": 3})),
        )
        .unwrap();
        assert_eq!(last.entries.len(), 1);
        assert_eq!(last.next_offset, None);
        let replay = catalog_page(
            catalog(),
            query(serde_json::json!({"client_intent_id": "intent-2"})),
        )
        .unwrap();
        assert_eq!(replay.entries.len(), 1);
        assert_eq!(replay.entries[0].profile.version, "2");
        assert!(catalog_page(catalog(), query(serde_json::json!({"revision": 2}))).is_err());
    }

    #[test]
    fn invalid_page_size_and_unscoped_versions_are_rejected() {
        for value in [
            serde_json::json!({"limit": 0}),
            serde_json::json!({"limit": 101}),
            serde_json::json!({"version": "1"}),
        ] {
            assert!(catalog_page(catalog(), query(value)).is_err());
        }
    }
}
