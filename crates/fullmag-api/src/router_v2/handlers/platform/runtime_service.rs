//! Read-only observation of the optional native application runtime service.

use std::{
    fs,
    path::{Path, PathBuf},
    sync::Arc,
};

use axum::{extract::State, http::HeaderMap, response::Response};
use sha2::{Digest, Sha256};

use crate::{
    error::ApiError,
    router_v2::handlers::shared::{conditional_json_response, stable_strong_etag},
    schemas::runtime_service::RuntimeServiceStatusResource,
    types::AppState,
};

const APPLICATION_CONFIG_PATH: &str = "runtime-services/APPLICATION.json";
const ORPHAN_MARKER_PATHS: [&str; 3] = [
    "runtime-services/OWNER.lock",
    "runtime-services/OWNER.json",
    "runtime-services/LAUNCH.json",
];

#[utoipa::path(
    get,
    path = "/v2/platform/runtime-service",
    responses(
        (
            status = 200,
            description = "Read-only native application runtime service status",
            body = RuntimeServiceStatusResource
        ),
        (
            status = 304,
            description = "Runtime service status not modified for the supplied ETag"
        ),
    ),
    tag = "platform"
)]
pub async fn get_runtime_service(
    State(state): State<Arc<AppState>>,
    headers: HeaderMap,
) -> Result<Response, ApiError> {
    // Resolve environment and accepted-store identity before moving the
    // observation onto the blocking pool.  No status read is allowed to create
    // a SessionStore or initialize APPLICATION.json.
    let explicit_config_path =
        std::env::var_os("FULLMAG_RUNTIME_SERVICE_CONFIG").map(PathBuf::from);
    let store_root = state.submit_store_root.clone();
    let body = tokio::task::spawn_blocking(move || {
        let config_path = resolve_config_path(store_root.as_deref(), explicit_config_path);
        let observation_root = store_root.unwrap_or_default();
        let observed = fullmag_runtime_control::application_service_status::observe(
            &observation_root,
            config_path.as_deref(),
        );
        RuntimeServiceStatusResource::from(observed)
    })
    .await
    .map_err(|error| {
        ApiError::internal(format!("runtime service observer task failed: {error}"))
    })?;

    let etag = status_etag(&body)?;
    Ok(conditional_json_response(&headers, &etag, &body))
}

/// Select the only configuration path that the read-only observer may inspect.
///
/// An explicit environment path wins, including an invalid path: the observer
/// must report that configuration error instead of silently falling back to a
/// persisted file.  Without the override, the persisted application config is
/// observed only when guarded metadata says that it exists.  Orphaned owner or
/// launch metadata also selects that path so a missing configuration is
/// reported as an error/unknown state rather than as `not_configured`.
fn resolve_config_path(
    store_root: Option<&Path>,
    explicit_config_path: Option<PathBuf>,
) -> Option<PathBuf> {
    if explicit_config_path.is_some() {
        return explicit_config_path;
    }

    let root = store_root?;
    let application_path = root.join(APPLICATION_CONFIG_PATH);
    let application_present = guarded_metadata_present(root, APPLICATION_CONFIG_PATH);
    let orphan_present = ORPHAN_MARKER_PATHS
        .iter()
        .any(|relative| guarded_metadata_present(root, relative));

    (application_present || orphan_present).then_some(application_path)
}

/// Read metadata through the repository path guard.
///
/// A valid accepted-store root may not exist yet on a fresh installation.  In
/// that one case the failed guard proves that there is no persisted metadata,
/// so the read-only endpoint must remain `not_configured` and must not create
/// the root as a side effect.  Existing-root guard failures remain unknown
/// evidence and therefore select the path for an honest observer error.
fn guarded_metadata_present(root: &Path, relative: &str) -> bool {
    let path = match fullmag_session::repository_path::checked_path(root, relative) {
        Ok(path) => path,
        Err(_) => {
            let root_is_absent = matches!(
                fs::symlink_metadata(root),
                Err(error) if error.kind() == std::io::ErrorKind::NotFound
            );
            let root_is_valid_future_store = root_is_absent
                && fullmag_runtime_control::accepted_store::writable_product_state_path(root)
                    .is_some();
            return !root_is_valid_future_store;
        }
    };
    match fs::symlink_metadata(path) {
        Ok(_) => true,
        Err(error) if error.kind() == std::io::ErrorKind::NotFound => false,
        Err(_) => true,
    }
}

fn status_etag(body: &RuntimeServiceStatusResource) -> Result<String, ApiError> {
    let bytes = serde_json::to_vec(body).map_err(|error| {
        ApiError::internal(format!("serialize runtime service status: {error}"))
    })?;
    let digest = Sha256::digest(bytes);
    Ok(stable_strong_etag(&format!("runtime-service:{digest:x}")))
}

#[cfg(test)]
mod tests {
    use super::*;

    fn test_root(label: &str) -> PathBuf {
        std::env::temp_dir().join(format!(
            "fullmag-runtime-service-handler-{label}-{}",
            uuid::Uuid::new_v4()
        ))
    }

    #[test]
    fn status_etag_is_stable_and_changes_with_observed_state() {
        use fullmag_runtime_control::application_service_status::{
            ApplicationServiceReason, ApplicationServiceReasonCode, ApplicationServiceState,
            ApplicationServiceStatus, APPLICATION_SERVICE_STATUS_SCHEMA,
        };
        let mut body = RuntimeServiceStatusResource::from(ApplicationServiceStatus {
            schema_version: APPLICATION_SERVICE_STATUS_SCHEMA.into(),
            configured: false,
            state: ApplicationServiceState::NotConfigured,
            reason: ApplicationServiceReason {
                code: ApplicationServiceReasonCode::ConfigurationAbsent,
                message: String::new(),
            },
        });
        let initial = status_etag(&body).unwrap();
        assert_eq!(initial, status_etag(&body).unwrap());
        body.configured = true;
        assert_ne!(initial, status_etag(&body).unwrap());
    }

    #[test]
    fn absent_persisted_configuration_without_orphan_markers_is_not_selected() {
        let root = test_root("absent");
        fs::create_dir_all(&root).unwrap();
        assert!(resolve_config_path(Some(&root), None).is_none());
        fs::remove_dir_all(root).unwrap();
    }

    #[test]
    fn valid_new_store_root_without_metadata_is_not_selected_or_created() {
        let root = test_root("new-root");
        assert!(!root.exists());
        assert!(
            fullmag_runtime_control::accepted_store::writable_product_state_path(&root).is_some()
        );

        assert!(resolve_config_path(Some(&root), None).is_none());
        assert!(!root.exists());
    }

    #[test]
    fn orphan_owner_metadata_selects_missing_application_config_for_honest_error() {
        let root = test_root("orphan");
        fs::create_dir_all(root.join("runtime-services")).unwrap();
        fs::write(root.join("runtime-services/OWNER.lock"), b"").unwrap();
        let selected = resolve_config_path(Some(&root), None);
        assert_eq!(selected, Some(root.join(APPLICATION_CONFIG_PATH)));
        fs::remove_dir_all(root).unwrap();
    }

    #[test]
    fn explicit_configuration_path_wins_over_persisted_state() {
        let root = test_root("override");
        fs::create_dir_all(root.join("runtime-services")).unwrap();
        fs::write(root.join(APPLICATION_CONFIG_PATH), b"{}").unwrap();
        let explicit = root.join("operator-config.json");
        assert_eq!(
            resolve_config_path(Some(&root), Some(explicit.clone())),
            Some(explicit)
        );
        fs::remove_dir_all(root).unwrap();
    }
}
