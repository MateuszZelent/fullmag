//! System endpoints — health, capabilities, engine_log, gpu_telemetry.

use std::path::{Component, Path, PathBuf};
use std::sync::Arc;

use axum::extract::State;
use axum::http::HeaderMap;
use axum::Json;

use crate::error::ApiError;
use crate::schemas::common::{HealthResponse, RuntimeCapabilityMatrix};
use crate::schemas::diagnostics::SolverProfileResource;
use crate::schemas::logs::EngineLogResource;
use crate::types::{AppState, CpuTelemetryResponse, GpuTelemetryResponse};

#[utoipa::path(
    get,
    path = "/v2/platform/health",
    responses(
        (status = 200, description = "Health check", body = HealthResponse),
    ),
    tag = "platform"
)]
pub async fn get_health(State(state): State<Arc<AppState>>) -> Json<HealthResponse> {
    let active = state.current_live_state.read().await.is_some();
    let uptime = std::time::SystemTime::now()
        .duration_since(std::time::UNIX_EPOCH)
        .map(|d| d.as_secs())
        .unwrap_or(0);

    Json(HealthResponse {
        status: "ok".into(),
        uptime_seconds: uptime,
        api_contract_version: "1.0.0".into(),
        active_session: active,
    })
}

#[utoipa::path(
    get,
    path = "/v2/platform/capabilities",
    responses(
        (status = 200, description = "Runtime capabilities", body = RuntimeCapabilityMatrix),
        (status = 500, description = "Invalid runtime package root configuration"),
    ),
    tag = "platform"
)]
pub async fn get_capabilities(
    State(state): State<Arc<AppState>>,
) -> Result<Json<fullmag_runner::HostCapabilityMatrix>, ApiError> {
    let configured_runtime_root =
        std::env::var_os("FULLMAG_RUNTIME_PACKAGE_ROOT").map(PathBuf::from);
    let runtime_root = resolve_runtime_root(&state.repo_root, configured_runtime_root.as_deref())?;
    let runtimes_dir = runtime_root.join("runtimes");
    Ok(Json(
        fullmag_runner::RuntimeRegistry::discover(&runtimes_dir).capability_matrix(),
    ))
}

fn resolve_runtime_root(repo_root: &Path, configured: Option<&Path>) -> Result<PathBuf, ApiError> {
    let Some(path) = configured else {
        return Ok(repo_root.to_path_buf());
    };
    if !path.is_absolute()
        || path
            .components()
            .any(|component| matches!(component, Component::ParentDir))
    {
        return Err(ApiError::internal(
            "FULLMAG_RUNTIME_PACKAGE_ROOT must be an absolute path without parent traversal",
        ));
    }
    if !path.is_dir() {
        return Err(ApiError::internal(
            "FULLMAG_RUNTIME_PACKAGE_ROOT must point to an existing package directory",
        ));
    }
    let runtimes_dir = path.join("runtimes");
    if !runtimes_dir.is_dir() {
        return Err(ApiError::internal(
            "FULLMAG_RUNTIME_PACKAGE_ROOT must contain a runtimes directory",
        ));
    }
    std::fs::read_dir(&runtimes_dir).map_err(|_| {
        ApiError::internal("FULLMAG_RUNTIME_PACKAGE_ROOT runtimes directory is not readable")
    })?;
    Ok(path.to_path_buf())
}

#[utoipa::path(
    get,
    path = "/v2/sessions/current/diagnostics/engine-log",
    responses(
        (status = 200, description = "Engine log entries", body = EngineLogResource),
        (status = 304, description = "Engine log not modified for the supplied ETag"),
        (status = 404, description = "No active workspace"),
    ),
    tag = "diagnostics"
)]
pub async fn get_engine_log(
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

    let body = EngineLogResource {
        revision: snapshot.engine_log.len() as u64,
        total: snapshot.engine_log.len(),
        entries: snapshot.engine_log.clone(),
    };
    let etag = crate::router_v2::handlers::shared::stable_strong_etag(&format!(
        "engine-log:{}:{}",
        snapshot.engine_log.len(),
        snapshot
            .engine_log
            .last()
            .map(|entry| entry.timestamp_unix_ms)
            .unwrap_or(0)
    ));
    crate::ensure_current_live_request_context(
        snapshot,
        &request_context,
        state
            .current_live_session_epoch
            .load(std::sync::atomic::Ordering::Acquire),
    )?;
    Ok(crate::router_v2::handlers::shared::conditional_json_response(&headers, &etag, &body))
}

#[utoipa::path(
    get,
    path = "/v2/sessions/current/diagnostics/gpu",
    responses(
        (status = 200, description = "GPU telemetry or degraded unavailable response", body = GpuTelemetryResponse),
    ),
    tag = "diagnostics"
)]
pub async fn get_gpu_telemetry() -> Result<Json<GpuTelemetryResponse>, ApiError> {
    // Reuse existing GPU telemetry sampling
    let output = tokio::task::spawn_blocking(crate::sample_gpu_telemetry)
        .await
        .map_err(|e| ApiError::internal(format!("gpu telemetry task join failed: {e}")))?;
    match output {
        Ok(telemetry) => Ok(Json(telemetry)),
        Err(error) => Ok(Json(GpuTelemetryResponse {
            status: "unavailable".into(),
            reason: Some(error.message),
            sample_time_unix_ms: std::time::SystemTime::now()
                .duration_since(std::time::UNIX_EPOCH)
                .map(|duration| duration.as_millis())
                .unwrap_or(0),
            devices: Vec::new(),
        })),
    }
}

#[utoipa::path(
    get,
    path = "/v2/sessions/current/diagnostics/cpu",
    responses(
        (status = 200, description = "CPU telemetry or degraded unavailable response", body = CpuTelemetryResponse),
    ),
    tag = "diagnostics"
)]
pub async fn get_cpu_telemetry() -> Result<Json<CpuTelemetryResponse>, ApiError> {
    let output = tokio::task::spawn_blocking(crate::sample_cpu_telemetry)
        .await
        .map_err(|e| ApiError::internal(format!("cpu telemetry task join failed: {e}")))?;
    match output {
        Ok(telemetry) => Ok(Json(telemetry)),
        Err(error) => Ok(Json(CpuTelemetryResponse {
            status: "unavailable".into(),
            reason: Some(error.message),
            sample_time_unix_ms: std::time::SystemTime::now()
                .duration_since(std::time::UNIX_EPOCH)
                .map(|duration| duration.as_millis())
                .unwrap_or(0),
            logical_cpus: std::thread::available_parallelism()
                .map(|value| value.get() as u32)
                .unwrap_or(0),
            utilization_cpu_percent: 0.0,
            process_cpu_percent: 0.0,
            memory_used_mb: 0.0,
            memory_total_mb: 0.0,
            process_rss_mb: 0.0,
            process_threads: 0,
            load_average_1m: None,
            load_average_5m: None,
            load_average_15m: None,
            model_name: None,
        })),
    }
}

#[utoipa::path(
    get,
    path = "/v2/sessions/current/diagnostics/solver-profile",
    responses(
        (status = 200, description = "Opt-in FEM solver phase profile", body = SolverProfileResource),
        (status = 304, description = "Solver profile not modified for the supplied ETag"),
        (status = 404, description = "No active workspace"),
    ),
    tag = "diagnostics"
)]
pub async fn get_solver_profile(
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
    let body = snapshot.solver_profile.clone();
    let qualification_etag = body
        .timestep_qualification
        .as_ref()
        .map(|qualification| {
            format!(
                "{}:{}",
                qualification.validation_state.as_str(),
                qualification.qualification_registry_version
            )
        })
        .unwrap_or_else(|| "not-applicable".to_string());
    let etag = crate::router_v2::handlers::shared::stable_strong_etag(&format!(
        "solver-profile:{}:{}:{}:{}",
        body.revision,
        body.latest_samples.len(),
        body.state,
        qualification_etag,
    ));
    crate::ensure_current_live_request_context(
        snapshot,
        &request_context,
        state
            .current_live_session_epoch
            .load(std::sync::atomic::Ordering::Acquire),
    )?;
    Ok(crate::router_v2::handlers::shared::conditional_json_response(&headers, &etag, &body))
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn runtime_root_without_configuration_uses_repo_root() {
        let repo_root = PathBuf::from(env!("CARGO_MANIFEST_DIR"));
        assert_eq!(resolve_runtime_root(&repo_root, None).unwrap(), repo_root);
    }

    #[test]
    fn runtime_root_accepts_absolute_configured_package_root() {
        let repo_root = PathBuf::from(env!("CARGO_MANIFEST_DIR"));
        let fixture = tempfile::tempdir().unwrap();
        let package_root = fixture.path().join("immutable-package");
        std::fs::create_dir_all(package_root.join("runtimes")).unwrap();
        assert_eq!(
            resolve_runtime_root(&repo_root, Some(&package_root)).unwrap(),
            package_root
        );
    }

    #[test]
    fn runtime_root_rejects_relative_and_parent_traversal_configuration() {
        let repo_root = PathBuf::from(env!("CARGO_MANIFEST_DIR"));
        for configured in [
            PathBuf::from("immutable-package"),
            repo_root.join("..").join("immutable-package"),
        ] {
            assert!(resolve_runtime_root(&repo_root, Some(&configured)).is_err());
        }
    }

    #[test]
    fn runtime_root_rejects_missing_configured_package_root() {
        let repo_root = PathBuf::from(env!("CARGO_MANIFEST_DIR"));
        let fixture = tempfile::tempdir().unwrap();
        let missing = fixture.path().join("missing-package");
        assert!(resolve_runtime_root(&repo_root, Some(&missing)).is_err());
    }

    #[test]
    fn runtime_root_rejects_configured_file() {
        let repo_root = PathBuf::from(env!("CARGO_MANIFEST_DIR"));
        let fixture = tempfile::tempdir().unwrap();
        let file = fixture.path().join("package-file");
        std::fs::write(&file, b"fixture").unwrap();
        assert!(resolve_runtime_root(&repo_root, Some(&file)).is_err());
    }

    #[test]
    fn runtime_root_rejects_package_without_runtimes_directory() {
        let repo_root = PathBuf::from(env!("CARGO_MANIFEST_DIR"));
        let fixture = tempfile::tempdir().unwrap();
        let package_root = fixture.path().join("immutable-package");
        std::fs::create_dir(&package_root).unwrap();
        assert!(resolve_runtime_root(&repo_root, Some(&package_root)).is_err());
    }
}
