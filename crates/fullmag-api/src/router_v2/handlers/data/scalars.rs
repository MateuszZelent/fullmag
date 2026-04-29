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
}

#[utoipa::path(
    get,
    path = "/v2/sessions/current/data/scalars",
    params(
        ("since_revision" = Option<u64>, Query, description = "Only rows after this revision"),
        ("limit" = Option<u64>, Query, description = "Max rows to return"),
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

    let columns = vec![
        "step".into(),
        "time".into(),
        "solver_dt".into(),
        "mx".into(),
        "my".into(),
        "mz".into(),
        "e_ex".into(),
        "e_demag".into(),
        "e_ext".into(),
        "e_ani".into(),
        "e_dmi".into(),
        "e_total".into(),
        "max_dm_dt".into(),
        "max_h_eff".into(),
        "max_h_demag".into(),
        "max_torque_Apm".into(),
        "max_torque_T".into(),
    ];

    let rows: Vec<Vec<f64>> = window
        .iter()
        .map(|r| {
            vec![
                r.step as f64,
                r.time,
                r.solver_dt,
                r.mx,
                r.my,
                r.mz,
                r.e_ex,
                r.e_demag,
                r.e_ext,
                r.e_ani,
                r.e_dmi,
                r.e_total,
                r.max_dm_dt,
                r.max_h_eff,
                r.max_h_demag,
                r.max_torque_Apm,
                r.max_torque_T,
            ]
        })
        .collect();

    let returned = rows.len() as u64;

    Ok(Json(ScalarWindow {
        revision: total,
        total_rows: total,
        returned_rows: returned,
        columns,
        rows,
    }))
}
