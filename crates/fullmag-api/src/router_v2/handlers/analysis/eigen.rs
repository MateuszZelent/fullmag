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
    let relative_path = if let Some(sample_idx) = query.sample_index {
        format!(
            "eigen/modes/sample_{:04}/mode_{:04}.json",
            sample_idx, query.index
        )
    } else {
        format!("eigen/modes/mode_{:04}.json", query.index)
    };
    let value = match read_json_artifact_value(&artifact_dir, &relative_path) {
        Ok(value) => value,
        Err(_) if query.sample_index.is_some() => {
            let legacy_path = format!("eigen/modes/mode_{:04}.json", query.index);
            read_json_artifact_value(&artifact_dir, &legacy_path)?
        }
        Err(err) => return Err(err),
    };
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
    let relative_path = format!(
        "eigen/modes/sample_{:04}/mode_{:04}.json",
        sample_index, mode_index
    );
    let value = read_json_artifact_value(&artifact_dir, &relative_path)?;
    crate::validate_current_live_request_context(&state, &request_context).await?;
    Ok(Json(value))
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
