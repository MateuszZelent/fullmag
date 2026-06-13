//! GET /v1/live/current/scalars — scalar history with optional windowing.

use std::sync::Arc;

use axum::extract::{Query, State};
use axum::Json;
use serde::Deserialize;

use crate::error::ApiError;
use crate::schemas::scalars::ScalarWindow;
use crate::types::AppState;

#[derive(Debug, Deserialize, Default)]
pub struct ScalarsQuery {
    #[serde(default)]
    pub since_revision: Option<u64>,
    #[serde(default)]
    pub limit: Option<u64>,
    #[serde(default)]
    pub columns: Option<String>,
}

#[utoipa::path(
    get,
    path = "/v2/sessions/current/data/scalars",
    params(
        ("since_revision" = Option<u64>, Query, description = "Only rows after this revision"),
        ("limit" = Option<u64>, Query, description = "Max rows to return"),
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
    let guard = state.current_live_state.read().await;
    let all_rows = guard.as_ref().map(|s| &s.scalar_rows[..]).unwrap_or(&[]);
    let total = all_rows.len() as u64;

    let since = query.since_revision.unwrap_or(0) as usize;
    let window = if since < all_rows.len() {
        &all_rows[since..]
    } else {
        &[]
    };
    let window = if let Some(limit) = query.limit {
        let limit = limit as usize;
        if window.len() > limit {
            &window[..limit]
        } else {
            window
        }
    } else {
        window
    };

    let all_columns = [
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
        "e_total",
        "max_dm_dt",
        "max_h_eff",
        "max_h_demag",
        "max_torque_Apm",
        "max_torque_T",
    ];
    let mut columns: Vec<&str> = Vec::new();
    columns.push("step");
    if let Some(requested_columns) = query.columns.as_deref() {
        for column in requested_columns
            .split(',')
            .map(str::trim)
            .filter(|value| !value.is_empty())
        {
            if all_columns.contains(&column) && !columns.contains(&column) {
                columns.push(column);
            }
        }
    } else {
        columns = all_columns.to_vec();
    }

    let rows: Vec<Vec<f64>> = window
        .iter()
        .map(|r| {
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
                    "e_total" => r.e_total,
                    "max_dm_dt" => r.max_dm_dt,
                    "max_h_eff" => r.max_h_eff,
                    "max_h_demag" => r.max_h_demag,
                    "max_torque_Apm" => r.max_torque_Apm,
                    "max_torque_T" => r.max_torque_T,
                    _ => 0.0,
                })
                .collect()
        })
        .collect();

    let returned = rows.len() as u64;

    Ok(Json(ScalarWindow {
        revision: total,
        total_rows: total,
        returned_rows: returned,
        columns: columns.into_iter().map(str::to_string).collect(),
        rows,
    }))
}
