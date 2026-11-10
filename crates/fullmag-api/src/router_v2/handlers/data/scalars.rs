//! Current scalar buffer with optional windowing.

use std::sync::Arc;

use axum::extract::{Query, State};
use axum::Json;
use serde::Deserialize;

use crate::error::ApiError;
use crate::router_v2::handlers::sessions::status::domain_generation_id;
use crate::schemas::common::AcceptedObservationFrameRef;
use crate::schemas::scalars::{HistoricalScalarCoverage, HistoricalScalarWindow, ScalarWindow};
use crate::types::{AppState, ScalarRow};

#[derive(Debug, Deserialize, Default)]
pub struct ScalarsQuery {
    #[serde(default)]
    pub since_revision: Option<u64>,
    #[serde(default)]
    pub limit: Option<u64>,
    #[serde(default)]
    pub tail: Option<bool>,
    #[serde(default)]
    pub columns: Option<String>,
}

#[utoipa::path(
    get,
    path = "/v2/sessions/current/data/scalars",
    params(
        ("since_revision" = Option<u64>, Query, description = "Only rows after this revision"),
        ("limit" = Option<u64>, Query, description = "Max rows to return"),
        ("tail" = Option<bool>, Query, description = "Return the newest rows instead of the oldest rows in the selected window"),
        ("columns" = Option<String>, Query, description = "Comma-separated scalar columns to return, e.g. step,time,e_total"),
    ),
    responses(
        (status = 200, description = "Scalar history window", body = ScalarWindow),
    ),
    tag = "data"
)]
pub async fn get_scalars(
    State(state): State<Arc<AppState>>,
    Query(query): Query<ScalarsQuery>,
) -> Result<Json<ScalarWindow>, ApiError> {
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
    let series = snapshot
        .latest_scalar_source
        .as_ref()
        .and_then(|source| source.series.as_ref());
    let series_is_current = series.is_none_or(|series| {
        request_context.run_id.as_deref() == Some(series.identity.run_id.as_str())
    });
    let all_rows = if series_is_current {
        &snapshot.scalar_rows[..]
    } else {
        &[]
    };
    let revision = snapshot.scalar_revision;
    let total = all_rows.len() as u64;

    let since = query.since_revision.map_or(0, |revision| {
        series
            .filter(|series| series.row_revisions.len() == all_rows.len())
            .map_or_else(
                || usize::try_from(revision).unwrap_or(usize::MAX),
                |series| {
                    series
                        .row_revisions
                        .partition_point(|row_revision| *row_revision <= revision)
                },
            )
    });
    let window = if since < all_rows.len() {
        &all_rows[since..]
    } else {
        &[]
    };
    // Filter diagnostics before tail/limit selection. Original revision and
    // source cursor offsets are preserved; persisted rows are not rewritten.
    let physical_window: Vec<_> = window
        .iter()
        .filter(|row| row.is_physical_observation())
        .collect();
    let window = &physical_window[..];
    let window = if query.tail.unwrap_or(false) {
        let limit = query.limit.unwrap_or(1) as usize;
        let start = window.len().saturating_sub(limit);
        &window[start..]
    } else if let Some(limit) = query.limit {
        let limit = limit as usize;
        if window.len() > limit {
            &window[..limit]
        } else {
            window
        }
    } else {
        window
    };

    let columns = scalar_columns(query.columns.as_deref());
    let rows: Vec<_> = window
        .iter()
        .map(|row| scalar_values(row, &columns))
        .collect();

    let returned = rows.len() as u64;
    let generation_id = domain_generation_id(snapshot);
    let observation_frames = window
        .iter()
        .map(|row| {
            row.observation_frame.clone().unwrap_or_else(|| {
                AcceptedObservationFrameRef::for_snapshot(
                    &snapshot.session.session_id,
                    snapshot.session.started_at_unix_ms,
                    generation_id.clone(),
                    snapshot.mesh_revision,
                    row.step,
                    Some(row.time),
                )
            })
        })
        .collect();

    // A source pin is useful only for the exact current accepted row. A
    // multi-row history may cross run lineages and must not acquire one run
    // identity merely because it was read through the current-session route.
    let current_observation = snapshot
        .latest_scalar_source
        .as_ref()
        .and_then(|state| state.public_source.as_ref())
        .filter(|source| {
            source.session_id == snapshot.session.session_id
                && source.run_id
                    == snapshot
                        .run
                        .as_ref()
                        .map(|run| run.run_id.as_str())
                        .unwrap_or("")
                && source.request_scope_epoch == request_context.request_scope_epoch
                && source.scalar_revision == revision
                && window.len() == 1
                && window[0].step == source.source_step
                && snapshot
                    .scalar_rows
                    .last()
                    .is_some_and(|last| std::ptr::eq(window[0], last))
        })
        .cloned();

    Ok(Json(ScalarWindow {
        revision,
        total_rows: total,
        returned_rows: returned,
        columns: columns.into_iter().map(str::to_string).collect(),
        rows,
        observation_frames,
        series: series
            .filter(|_| series_is_current)
            .map(|series| series.identity.clone()),
        current_observation,
    }))
}

fn scalar_columns(requested: Option<&str>) -> Vec<&'static str> {
    const ALL_COLUMNS: [&str; 20] = [
        "step",
        "time",
        "solver_dt",
        "pseudo_time_s",
        "active_runtime_s",
        "mx",
        "my",
        "mz",
        "e_ex",
        "e_demag",
        "e_ext",
        "e_ani",
        "e_dmi",
        "e_rotated_dmi",
        "e_total",
        "max_dm_dt",
        "max_h_eff",
        "max_h_demag",
        "max_torque_Apm",
        "max_torque_T",
    ];
    let mut columns: Vec<&'static str> = Vec::new();
    columns.push("step");
    if let Some(requested_columns) = requested {
        for column in requested_columns
            .split(',')
            .map(str::trim)
            .filter(|value| !value.is_empty())
        {
            if let Some(&known) = ALL_COLUMNS.iter().find(|known| **known == column) {
                if !columns.contains(&known) {
                    columns.push(known);
                }
            }
        }
    } else {
        columns = ALL_COLUMNS.to_vec();
    }

    columns
}

fn scalar_values(r: &ScalarRow, columns: &[&str]) -> Vec<f64> {
    columns
        .iter()
        .map(|column| match *column {
            "step" => r.step as f64,
            "time" => r.time,
            "solver_dt" => r.solver_dt,
            "pseudo_time_s" => r.pseudo_time_s.unwrap_or(0.0),
            "active_runtime_s" => r.active_runtime_s.unwrap_or(0.0),
            "mx" => r.mx,
            "my" => r.my,
            "mz" => r.mz,
            "e_ex" => r.e_ex,
            "e_demag" => r.e_demag,
            "e_ext" => r.e_ext,
            "e_ani" => r.e_ani,
            "e_dmi" => r.e_dmi,
            "e_rotated_dmi" => r.e_rotated_dmi.unwrap_or(0.0),
            "e_total" => r.e_total,
            "max_dm_dt" => r.max_dm_dt,
            "max_h_eff" => r.max_h_eff,
            "max_h_demag" => r.max_h_demag,
            "max_torque_Apm" => r.max_torque_Apm,
            "max_torque_T" => r.max_torque_T,
            _ => 0.0,
        })
        .collect()
}

#[derive(Debug, Deserialize)]
#[serde(deny_unknown_fields)]
pub struct HistoricalScalarsQuery {
    run_id: String,
    step_id: String,
    case_id: String,
    attempt_id: String,
    ownership_epoch: u64,
    columns: Option<String>,
    start: Option<u64>,
    limit: Option<u64>,
}

#[utoipa::path(
    get,
    path = "/v2/sessions/current/simulation/stages/results/scalars",
    params(
        ("run_id" = String, Query, description = "Exact accepted run"),
        ("step_id" = String, Query, description = "Exact accepted Study step"),
        ("case_id" = String, Query, description = "Exact output case"),
        ("attempt_id" = String, Query, description = "Succeeded worker attempt"),
        ("ownership_epoch" = u64, Query, description = "Succeeded worker ownership epoch"),
        ("columns" = Option<String>, Query, description = "Comma-separated scalar columns"),
        ("start" = Option<u64>, Query, description = "First archived row ordinal"),
        ("limit" = Option<u64>, Query, description = "Number of rows, 1 to 2048"),
    ),
    responses(
        (status = 200, description = "Archived scalar samples and their exact source", body = HistoricalScalarWindow),
        (status = 404, description = "Qualified scalar history unavailable"),
    ),
    tag = "data"
)]
pub async fn get_historical_scalars(
    State(state): State<Arc<AppState>>,
    Query(query): Query<HistoricalScalarsQuery>,
) -> Result<Json<HistoricalScalarWindow>, ApiError> {
    if query
        .limit
        .is_some_and(|limit| !(1..=2048).contains(&limit))
    {
        return Err(ApiError::bad_request(
            "historical scalar limit must be in 1..=2048",
        ));
    }
    let context = crate::capture_current_live_read_context(&state).await?;
    let root = state.submit_store_root.clone().ok_or_else(|| {
        ApiError::with_status_and_code(
            axum::http::StatusCode::SERVICE_UNAVAILABLE,
            "historical_scalar_store_unavailable",
            "historical scalar reads require the configured durable run store",
        )
    })?;
    let session_id = context.session_id.clone();
    let session_epoch = context.session_epoch;
    let result = tokio::task::spawn_blocking(move || {
        let store = fullmag_session::SessionStore::open_existing(root).map_err(|error| {
            ApiError::internal(format!("open historical scalar store: {error}"))
        })?;
        load_historical_scalars(&store, &session_id, session_epoch, query)
    })
    .await
    .map_err(|error| ApiError::internal(format!("historical scalar read failed: {error}")))?;

    // The requested result has its own run identity. Only replacing the owning
    // session invalidates an in-flight read; binding another live run does not.
    let current = crate::capture_current_live_read_context(&state).await?;
    if current.session_id != context.session_id
        || current.session_epoch != context.session_epoch
        || current.request_scope_epoch != context.request_scope_epoch
    {
        return Err(ApiError::conflict("request_context_stale"));
    }
    result.map(Json)
}

fn load_historical_scalars(
    store: &fullmag_session::SessionStore,
    session_id: &str,
    session_epoch: u64,
    query: HistoricalScalarsQuery,
) -> Result<HistoricalScalarWindow, ApiError> {
    let binding = crate::live_accepted_continuation::load_exact_step_final_state_binding(
        store,
        &query.run_id,
        session_id,
        session_epoch,
        &query.step_id,
        &query.case_id,
    )
    .map_err(|_| historical_series_unavailable())?;
    if binding.identity.attempt_id != query.attempt_id
        || binding.identity.ownership_epoch != query.ownership_epoch
    {
        return Err(historical_series_unavailable());
    }
    read_bound_historical_scalars(store, binding, query.start, query.limit, query.columns.as_deref())
}

fn historical_series_unavailable() -> ApiError {
    ApiError::with_status_and_code(
        axum::http::StatusCode::NOT_FOUND,
        "historical_scalar_series_unavailable",
        "no qualified archived scalar series for the requested run, step, case and attempt",
    )
}

/// The project-owned and workspace-owned routes have distinct admission
/// checks and share the same exact output binding and archived data reader.
pub(crate) fn read_bound_historical_scalars(
    store: &fullmag_session::SessionStore,
    binding: crate::study_execution_contract::ExactStepFinalStateBinding,
    start: Option<u64>,
    limit: Option<u64>,
    columns: Option<&str>,
) -> Result<HistoricalScalarWindow, ApiError> {
    use crate::accepted_field_materialization_worker::{
        read_terminal_scalar_stats, TERMINAL_SCALAR_ARTIFACT_TYPE,
    };

    let start = start.unwrap_or(0);
    let limit = limit.unwrap_or(512);
    if !(1..=2048).contains(&limit) {
        return Err(ApiError::bad_request("historical scalar limit must be in 1..=2048"));
    }
    if let Some(window) = crate::accepted_study_worker::scalar_history::read_archived_scalar_window(
        store,
        &binding,
        start,
        limit,
        columns,
    )
    .map_err(|error| ApiError::conflict(format!("invalid archived scalar series: {error}")))?
    {
        return Ok(window);
    }
    // The legacy terminal scalar artifact predates a case field. The
    // ordinary accepted worker writes it for its single, default case.
    if binding.identity.case_id != crate::accepted_study_worker::DEFAULT_ACCEPTED_CASE_ID {
        return Err(historical_series_unavailable());
    }
    let source = binding
        .accepted_state_ref
        .as_ref()
        .ok_or_else(historical_series_unavailable)?;
    let mut scalar_artifacts = binding.artifact_catalog.entries.iter().filter(|artifact| {
        binding.task.artifact_ids.contains(&artifact.artifact_id)
            && artifact.artifact_type == TERMINAL_SCALAR_ARTIFACT_TYPE
            && artifact.task_id == binding.identity.task_id
            && artifact.attempt_id == binding.identity.attempt_id
            && artifact.ownership_epoch == binding.identity.ownership_epoch
            && artifact.status == fullmag_session::FmsArtifactStatus::Published
    });
    let artifact = scalar_artifacts.next().ok_or_else(historical_series_unavailable)?;
    if scalar_artifacts.next().is_some() {
        return Err(ApiError::conflict(
            "archived terminal scalar artifact is ambiguous",
        ));
    }
    let terminal = read_terminal_scalar_stats(store, artifact).map_err(|error| {
        ApiError::conflict(format!(
            "invalid archived terminal scalar artifact: {error}"
        ))
    })?;
    if terminal.source != *source
        || terminal.state_object_ref != binding.output.object_ref
        || terminal.run_id != binding.identity.run_id
        || terminal.step_id != binding.identity.step_id
    {
        return Err(ApiError::conflict(
            "archived scalar source differs from its final state binding",
        ));
    }
    let columns = scalar_columns(columns);
    let row = ScalarRow::from_accepted_stats(&terminal.stats);
    Ok(HistoricalScalarWindow {
        series: binding.identity,
        artifact_id: artifact.artifact_id.clone(),
        content_sha256: artifact.content_sha256.clone(),
        coverage: HistoricalScalarCoverage::TerminalSample,
        total_rows: 1,
        next_start: None,
        rows: if start == 0 {
            vec![scalar_values(&row, &columns)]
        } else {
            Vec::new()
        },
        columns: columns.into_iter().map(str::to_string).collect(),
    })
}
