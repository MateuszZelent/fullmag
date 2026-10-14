//! Eigen endpoints — spectrum, mode, dispersion, branches.

use std::path::PathBuf;
use std::sync::Arc;

use axum::extract::{Path, Query, State};
use axum::http::header;
use axum::response::{IntoResponse, Response};
use axum::Json;
use serde_json::Value;

use crate::artifacts::{
    parse_eigen_dispersion_csv, read_json_artifact_value, read_text_artifact_value,
    try_resolve_artifact_path,
};
use crate::error::ApiError;
use crate::session::current_artifact_dir;
use crate::types::{AppState, CurrentLiveRequestContext, EigenDispersionResponse, EigenModeQuery};

async fn current_artifact_dir_with_context(
    state: &Arc<AppState>,
) -> Result<(PathBuf, CurrentLiveRequestContext), ApiError> {
    let request_context = crate::capture_current_live_request_context(state).await?;
    let guard = state.current_live_state.read().await;
    let snapshot = guard
        .as_ref()
        .ok_or_else(|| ApiError::not_found("no active local live workspace"))?;
    let artifact_dir = current_artifact_dir(snapshot)
        .ok_or_else(|| ApiError::not_found("no artifact directory for the active workspace"))?;
    crate::ensure_current_live_request_context(
        snapshot,
        &request_context,
        state
            .current_live_session_epoch
            .load(std::sync::atomic::Ordering::Acquire),
    )?;
    Ok((artifact_dir, request_context))
}

#[utoipa::path(
    get,
    path = "/v2/sessions/current/analysis/eigenmodes/spectrum",
    responses(
        (status = 200, description = "Eigen spectrum"),
        (status = 404, description = "No eigen spectrum artifact"),
    ),
    tag = "analysis"
)]
pub async fn get_spectrum(State(state): State<Arc<AppState>>) -> Result<Json<Value>, ApiError> {
    let (artifact_dir, request_context) = current_artifact_dir_with_context(&state).await?;
    for candidate in ["eigen/spectrum.json", "eigen/metadata/eigen_summary.json"] {
        if try_resolve_artifact_path(&artifact_dir, candidate)?.is_some() {
            let value = read_json_artifact_value(&artifact_dir, candidate)?;
            crate::validate_current_live_request_context(&state, &request_context).await?;
            return Ok(Json(value));
        }
    }
    Err(ApiError::not_found(
        "no eigen spectrum artifact found in the active workspace",
    ))
}

#[utoipa::path(
    get,
    path = "/v2/sessions/current/analysis/eigen/spectrum.v2",
    responses(
        (status = 200, description = "Eigen spectrum artifact v2"),
        (status = 404, description = "No eigen spectrum v2 artifact"),
    ),
    tag = "analysis"
)]
pub async fn get_spectrum_v2(State(state): State<Arc<AppState>>) -> Result<Json<Value>, ApiError> {
    let (artifact_dir, request_context) = current_artifact_dir_with_context(&state).await?;
    let value = read_json_artifact_value(&artifact_dir, "eigen/spectrum.v2.json")?;
    crate::validate_current_live_request_context(&state, &request_context).await?;
    Ok(Json(value))
}

#[utoipa::path(
    get,
    path = "/v2/sessions/current/analysis/eigenmodes/modes/{mode_id}",
    params(
        ("index" = u32, Query, description = "Mode index"),
        ("sample_index" = Option<u32>, Query, description = "Optional k-sample index"),
    ),
    responses(
        (status = 200, description = "Eigen mode data"),
        (status = 404, description = "Mode not found"),
    ),
    tag = "analysis"
)]
pub async fn get_mode(
    State(state): State<Arc<AppState>>,
    Query(query): Query<EigenModeQuery>,
) -> Result<Json<Value>, ApiError> {
    let (artifact_dir, request_context) = current_artifact_dir_with_context(&state).await?;
    let value = read_selected_eigen_mode(&artifact_dir, query.sample_index, query.index)?;
    crate::validate_current_live_request_context(&state, &request_context).await?;
    Ok(Json(value))
}

#[utoipa::path(
    get,
    path = "/v2/sessions/current/analysis/eigen/modes/{sample_index}/{mode_index}",
    params(
        ("sample_index" = u32, Path, description = "K-path sample index"),
        ("mode_index" = u32, Path, description = "Raw mode index within the sample"),
    ),
    responses(
        (status = 200, description = "Eigen mode artifact v2"),
        (status = 404, description = "Mode not found"),
    ),
    tag = "analysis"
)]
pub async fn get_mode_v2(
    State(state): State<Arc<AppState>>,
    Path((sample_index, mode_index)): Path<(u32, u32)>,
) -> Result<Json<Value>, ApiError> {
    let (artifact_dir, request_context) = current_artifact_dir_with_context(&state).await?;
    let value = read_selected_eigen_mode(&artifact_dir, Some(sample_index), mode_index)?;
    crate::validate_current_live_request_context(&state, &request_context).await?;
    Ok(Json(value))
}

// An explicit sample is authoritative. Missing, unreadable or malformed
// sample artifacts must preserve their error instead of selecting a legacy mode.
fn read_selected_eigen_mode(
    artifact_dir: &std::path::Path,
    sample_index: Option<u32>,
    mode_index: u32,
) -> Result<Value, ApiError> {
    let relative_path = match sample_index {
        Some(sample) => format!("eigen/modes/sample_{sample:04}/mode_{mode_index:04}.json"),
        None => format!("eigen/modes/mode_{mode_index:04}.json"),
    };
    read_json_artifact_value(artifact_dir, &relative_path)
}

#[utoipa::path(
    get,
    path = "/v2/sessions/current/analysis/eigenmodes/dispersion",
    responses(
        (status = 200, description = "Eigen dispersion data"),
        (status = 404, description = "No dispersion data"),
    ),
    tag = "analysis"
)]
pub async fn get_dispersion(
    State(state): State<Arc<AppState>>,
) -> Result<Json<EigenDispersionResponse>, ApiError> {
    let (artifact_dir, request_context) = current_artifact_dir_with_context(&state).await?;
    let csv_path = if try_resolve_artifact_path(&artifact_dir, "eigen/dispersion.csv")?.is_some() {
        "eigen/dispersion.csv"
    } else {
        "eigen/dispersion/branch_table.csv"
    };
    let csv_content = read_text_artifact_value(&artifact_dir, csv_path)?;
    let path_metadata =
        if try_resolve_artifact_path(&artifact_dir, "eigen/dispersion/path.json")?.is_some() {
            Some(read_json_artifact_value(
                &artifact_dir,
                "eigen/dispersion/path.json",
            )?)
        } else {
            None
        };
    let response = EigenDispersionResponse {
        csv_path: csv_path.to_string(),
        path_metadata,
        rows: parse_eigen_dispersion_csv(&csv_content)?,
    };
    crate::validate_current_live_request_context(&state, &request_context).await?;
    Ok(Json(response))
}

#[utoipa::path(
    get,
    path = "/v2/sessions/current/analysis/eigen/dispersion.csv",
    responses(
        (status = 200, description = "Eigen dispersion CSV v2"),
        (status = 404, description = "No dispersion CSV"),
    ),
    tag = "analysis"
)]
pub async fn get_dispersion_csv(State(state): State<Arc<AppState>>) -> Result<Response, ApiError> {
    let (artifact_dir, request_context) = current_artifact_dir_with_context(&state).await?;
    let csv = read_text_artifact_value(&artifact_dir, "eigen/dispersion.csv")?;
    crate::validate_current_live_request_context(&state, &request_context).await?;
    Ok(([(header::CONTENT_TYPE, "text/csv; charset=utf-8")], csv).into_response())
}

#[utoipa::path(
    get,
    path = "/v2/sessions/current/analysis/eigenmodes/branches",
    responses(
        (status = 200, description = "Tracked branches"),
        (status = 404, description = "No branches data"),
    ),
    tag = "analysis"
)]
pub async fn get_branches(State(state): State<Arc<AppState>>) -> Result<Json<Value>, ApiError> {
    let (artifact_dir, request_context) = current_artifact_dir_with_context(&state).await?;
    match try_resolve_artifact_path(&artifact_dir, "eigen/branches.json")? {
        Some(_) => {
            let value = read_json_artifact_value(&artifact_dir, "eigen/branches.json")?;
            crate::validate_current_live_request_context(&state, &request_context).await?;
            Ok(Json(value))
        }
        None => Err(ApiError::not_found(
            "no eigen/branches.json artifact found (single-k solve or legacy run)",
        )),
    }
}

#[utoipa::path(
    get,
    path = "/v2/sessions/current/analysis/eigen/branches.v2",
    responses(
        (status = 200, description = "Tracked eigen branches v2"),
        (status = 404, description = "No branches v2 data"),
    ),
    tag = "analysis"
)]
pub async fn get_branches_v2(State(state): State<Arc<AppState>>) -> Result<Json<Value>, ApiError> {
    let (artifact_dir, request_context) = current_artifact_dir_with_context(&state).await?;
    let value = read_json_artifact_value(&artifact_dir, "eigen/branches.v2.json")?;
    crate::validate_current_live_request_context(&state, &request_context).await?;
    Ok(Json(value))
}

#[cfg(test)]
mod sample_selection_tests {
    use super::read_selected_eigen_mode;
    use axum::http::StatusCode;
    use serde_json::json;
    use std::path::PathBuf;
    use std::sync::atomic::{AtomicU64, Ordering};

    struct ModeFixture(PathBuf);

    impl ModeFixture {
        fn new() -> Self {
            static NEXT: AtomicU64 = AtomicU64::new(0);
            let nonce = std::time::SystemTime::now()
                .duration_since(std::time::UNIX_EPOCH)
                .unwrap()
                .as_nanos();
            let path = std::env::temp_dir().join(format!(
                "fullmag-eigen-sample-{}-{nonce}-{}",
                std::process::id(),
                NEXT.fetch_add(1, Ordering::Relaxed),
            ));
            std::fs::create_dir(&path).unwrap();
            Self(path)
        }

        fn write(&self, relative: &str, content: &str) {
            let path = self.0.join(relative);
            std::fs::create_dir_all(path.parent().unwrap()).unwrap();
            std::fs::write(path, content).unwrap();
        }
    }

    impl Drop for ModeFixture {
        fn drop(&mut self) {
            // This directory is created exclusively by this fixture.
            let _ = std::fs::remove_dir_all(&self.0);
        }
    }

    #[test]
    fn missing_explicit_sample_does_not_read_existing_legacy_mode() {
        let fixture = ModeFixture::new();
        fixture.write("eigen/modes/mode_0000.json", r#"{"source":"legacy"}"#);
        for sample in [0, 1] {
            let error = read_selected_eigen_mode(&fixture.0, Some(sample), 0).unwrap_err();
            assert_eq!(error.status, StatusCode::NOT_FOUND);
            assert!(error.message.contains(&format!("sample_{sample:04}")));
        }
        assert_eq!(
            read_selected_eigen_mode(&fixture.0, None, 0).unwrap()["source"],
            "legacy"
        );
    }

    #[test]
    fn corrupt_explicit_sample_preserves_parse_error_with_legacy_present() {
        let fixture = ModeFixture::new();
        fixture.write("eigen/modes/mode_0000.json", r#"{"source":"legacy"}"#);
        fixture.write("eigen/modes/sample_0001/mode_0000.json", "{broken");
        let error = read_selected_eigen_mode(&fixture.0, Some(1), 0).unwrap_err();
        assert_eq!(error.status, StatusCode::INTERNAL_SERVER_ERROR);
        assert!(error.message.contains("failed to parse artifact"));
        assert!(error.message.contains("sample_0001/mode_0000.json"));
    }

    #[test]
    fn identical_raw_indices_keep_distinct_sample_coordinates() {
        let fixture = ModeFixture::new();
        for (sample, k) in [(0, -2.0e6), (1, 2.0e6)] {
            let mode = json!({"sample_index":sample, "raw_mode_index":0, "ky_rad_per_m":k});
            fixture.write(
                &format!("eigen/modes/sample_{sample:04}/mode_0000.json"),
                &mode.to_string(),
            );
            assert_eq!(
                read_selected_eigen_mode(&fixture.0, Some(sample), 0).unwrap(),
                mode
            );
        }
        assert_eq!(
            read_selected_eigen_mode(&fixture.0, None, 0)
                .unwrap_err()
                .status,
            StatusCode::NOT_FOUND
        );
    }

    #[test]
    fn selected_mode_is_read_only_from_supplied_artifact_root() {
        let run_a = ModeFixture::new();
        let run_b = ModeFixture::new();
        let relative = "eigen/modes/sample_0001/mode_0000.json";
        run_a.write(relative, r#"{"run_id":"A"}"#);
        run_b.write(relative, r#"{"run_id":"B"}"#);
        assert_eq!(
            read_selected_eigen_mode(&run_a.0, Some(1), 0).unwrap()["run_id"],
            "A"
        );
        assert_eq!(
            read_selected_eigen_mode(&run_b.0, Some(1), 0).unwrap()["run_id"],
            "B"
        );
    }
}
