//! Read-only, generation-bound observation of the native development watcher.

use std::{path::PathBuf, sync::Arc, time::SystemTime};

use axum::{extract::State, http::HeaderMap, response::Response};
use serde::Deserialize;
use sha2::{Digest, Sha256};

use crate::{
    error::ApiError,
    router_v2::handlers::shared::{conditional_json_response, stable_strong_etag},
    schemas::development_backend::{
        DevelopmentBackendReason as Reason, DevelopmentBackendResource,
        DevelopmentBackendState as BuildState, DevelopmentBuildIdentity,
    },
    types::AppState,
};

const PRIVATE_SCHEMA: &str = "fullmag.backend-watch.v2";
const MAX_STATUS_BYTES: usize = 8192;
const MAX_AGE_MS: u64 = 10_000;
const MAX_FUTURE_MS: u64 = 5_000;
const ENV_KEYS: [&str; 6] = [
    "FULLMAG_DEVELOPMENT_BACKEND_GENERATION",
    "FULLMAG_DEVELOPMENT_BACKEND_STATUS_FILE",
    "FULLMAG_DEVELOPMENT_BACKEND_SOURCE",
    "FULLMAG_DEVELOPMENT_BACKEND_VERSION",
    "FULLMAG_PROJECT_STORAGE_ROOT",
    "FULLMAG_WORKTREE_ID",
];

/// Frozen at API startup. A partial launcher configuration must never look disabled.
#[derive(Debug, Clone)]
pub(crate) enum DevelopmentBackendConfig {
    Disabled,
    Invalid,
    Managed {
        storage_root: PathBuf,
        relative_status: String,
        generation: String,
        worktree: String,
        current: DevelopmentBuildIdentity,
    },
}

impl DevelopmentBackendConfig {
    pub(crate) fn from_environment() -> Self {
        let values = ENV_KEYS.map(std::env::var_os);
        // Storage/worktree variables also exist in non-development launchers.
        if values[..4].iter().all(Option::is_none) {
            return Self::Disabled;
        }
        let Some(values) = values
            .into_iter()
            .map(|value| value.and_then(|value| value.into_string().ok()))
            .collect::<Option<Vec<_>>>()
        else {
            return Self::Invalid;
        };
        Self::from_values(&values)
    }

    fn from_values(values: &[String]) -> Self {
        let [generation, status_file, source, version, storage_root, worktree] = values else {
            return Self::Invalid;
        };
        if !hex(generation, 32)
            || !hex(source, 64)
            || version.is_empty()
            || version.len() > 128
            || !version
                .bytes()
                .all(|byte| byte.is_ascii_alphanumeric() || b".-+".contains(&byte))
            || worktree.is_empty()
            || worktree.len() > 80
            || fullmag_session::repository_path::validate_store_id(worktree).is_err()
        {
            return Self::Invalid;
        }
        let storage_root = PathBuf::from(storage_root);
        let status_file = PathBuf::from(status_file);
        if !storage_root.is_absolute() || !status_file.is_absolute() {
            return Self::Invalid;
        }
        let Some(root) =
            fullmag_runtime_control::accepted_store::writable_product_state_path(&storage_root)
        else {
            return Self::Invalid;
        };
        let Some(parent) = status_file
            .parent()
            .and_then(fullmag_runtime_control::accepted_store::writable_product_state_path)
        else {
            return Self::Invalid;
        };
        let expected_parent = root.join("builds").join(worktree);
        // Only one profile component below the launcher's own worktree is accepted.
        let Ok(profile) = parent.strip_prefix(expected_parent) else {
            return Self::Invalid;
        };
        if profile.components().count() != 1
            || status_file.file_name().and_then(|value| value.to_str())
                != Some("backend-watch-status.json")
        {
            return Self::Invalid;
        }
        let Ok(relative) = parent
            .join("backend-watch-status.json")
            .strip_prefix(&root)
            .map(PathBuf::from)
        else {
            return Self::Invalid;
        };
        let Some(relative) = relative.to_str() else {
            return Self::Invalid;
        };
        let relative = relative.replace('\\', "/");
        if fullmag_session::repository_path::validate_relative_path(&relative).is_err() {
            return Self::Invalid;
        }
        Self::Managed {
            storage_root: root,
            relative_status: relative,
            generation: generation.clone(),
            worktree: worktree.clone(),
            current: DevelopmentBuildIdentity {
                id: version.clone(),
                source_sha256: source.clone(),
            },
        }
    }

    fn observe(&self, now_ms: u64) -> DevelopmentBackendResource {
        let mut result = DevelopmentBackendResource {
            schema_version: "1.0.0".into(),
            configured: !matches!(self, Self::Disabled),
            revision: 0,
            state: BuildState::Unknown,
            current_build: None,
            ready_build: None,
            restart_available: false,
            reason: Reason::ConfigurationInvalid,
        };
        let Self::Managed {
            storage_root,
            relative_status,
            generation,
            worktree,
            current,
        } = self
        else {
            if matches!(self, Self::Disabled) {
                result.state = BuildState::Disabled;
                result.reason = Reason::Disabled;
            }
            return result;
        };
        result.current_build = Some(current.clone());
        // Recheck ancestors on every observation; a valid startup path may have been replaced.
        if fullmag_runtime_control::accepted_store::writable_product_state_path(storage_root)
            .as_ref()
            != Some(storage_root)
        {
            result.reason = Reason::ObservationUnavailable;
            return result;
        }
        let Ok(bytes) = fullmag_session::repository_path::read_bounded_regular_file(
            storage_root,
            relative_status,
            MAX_STATUS_BYTES,
        ) else {
            result.reason = Reason::ObservationUnavailable;
            return result;
        };
        let Ok(frame) = serde_json::from_slice::<PrivateFrame>(&bytes) else {
            result.reason = Reason::ObservationInvalid;
            return result;
        };
        if frame.schema != PRIVATE_SCHEMA
            || &frame.generation_id != generation
            || &frame.worktree_id != worktree
            || frame.revision == 0
            || !hex(&frame.source_sha256, 64)
            || (frame.state == PrivateState::Ready
                && (!frame
                    .ready_build_id
                    .as_deref()
                    .is_some_and(|id| hex(id, 64))
                    || frame.ready_source_sha256.as_deref() != Some(frame.source_sha256.as_str())))
            || (frame.state != PrivateState::Ready
                && (frame.ready_build_id.is_some() || frame.ready_source_sha256.is_some()))
        {
            result.reason = Reason::ObservationInvalid;
            return result;
        }
        result.revision = frame.revision;
        if frame.updated_unix_ms > now_ms.saturating_add(MAX_FUTURE_MS)
            || now_ms.saturating_sub(frame.updated_unix_ms) > MAX_AGE_MS
        {
            result.reason = Reason::ObservationStale;
            return result;
        }
        (result.state, result.reason) = match frame.state {
            PrivateState::Waiting => (BuildState::Waiting, Reason::BuildPending),
            PrivateState::Building => (BuildState::Building, Reason::BuildPending),
            PrivateState::Ready => (BuildState::Ready, Reason::RestartIntegrationPending),
            PrivateState::Failed => (BuildState::Failed, Reason::BuildFailed),
            PrivateState::Superseded => (BuildState::Superseded, Reason::BuildPending),
            PrivateState::Stopped => (BuildState::Stopped, Reason::WatcherStopped),
        };
        if frame.state == PrivateState::Ready {
            result.ready_build = Some(DevelopmentBuildIdentity {
                id: frame
                    .ready_build_id
                    .expect("validated ready build identity"),
                source_sha256: frame.source_sha256,
            });
        }
        result
    }
}

fn hex(value: &str, length: usize) -> bool {
    value.len() == length
        && value
            .bytes()
            .all(|byte| byte.is_ascii_digit() || (b'a'..=b'f').contains(&byte))
}

#[derive(Debug, Deserialize)]
#[serde(deny_unknown_fields)]
struct PrivateFrame {
    schema: String,
    generation_id: String,
    worktree_id: String,
    state: PrivateState,
    source_sha256: String,
    revision: u64,
    updated_unix_ms: u64,
    ready_build_id: Option<String>,
    ready_source_sha256: Option<String>,
}

#[derive(Debug, Clone, Copy, PartialEq, Eq, Deserialize)]
#[serde(rename_all = "snake_case")]
enum PrivateState {
    Waiting,
    Building,
    Ready,
    Failed,
    Superseded,
    Stopped,
}

#[utoipa::path(
    get, path = "/v2/platform/development-backend",
    responses(
        (status = 200, description = "Read-only native development compilation status", body = DevelopmentBackendResource),
        (status = 304, description = "Development backend status has not changed"),
    ), tag = "platform"
)]
pub async fn get_development_backend(
    State(state): State<Arc<AppState>>,
    headers: HeaderMap,
) -> Result<Response, ApiError> {
    let config = state.development_backend.clone();
    let body = tokio::task::spawn_blocking(move || {
        let now_ms = SystemTime::now()
            .duration_since(SystemTime::UNIX_EPOCH)
            .map(|value| value.as_millis().min(u64::MAX as u128) as u64)
            .unwrap_or(0);
        config.observe(now_ms)
    })
    .await
    .map_err(|_| ApiError::internal("development observer task failed"))?;
    let bytes = serde_json::to_vec(&body)
        .map_err(|_| ApiError::internal("development observer serialization failed"))?;
    let etag = stable_strong_etag(&format!("development-backend:{:x}", Sha256::digest(bytes)));
    Ok(conditional_json_response(&headers, &etag, &body))
}
