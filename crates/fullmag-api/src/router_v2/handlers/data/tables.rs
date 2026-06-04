//! Session table resources for live scalar charting.

use std::collections::BTreeSet;
use std::sync::Arc;

use axum::extract::{Path, Query, State};
use axum::http::{header, HeaderValue};
use axum::response::IntoResponse;
use axum::Json;
use serde::Deserialize;

use crate::error::ApiError;
use crate::schemas::tables::{
    TableColumnMeta, TableDecimationMeta, TableListResource, TableResource,
    TableRowsBinaryDescriptor, TableRowsResource,
};
use crate::types::{AppState, ScalarRow};

const DEFAULT_TABLE_LIMIT: u64 = 5_000;
const MAX_TABLE_LIMIT: u64 = 50_000;
const MAX_TARGET_POINTS: u64 = 10_000;
const TABLE_ROWS_BINARY_MAGIC: &[u8; 4] = b"FMTB";
const TABLE_ROWS_BINARY_VERSION: u16 = 1;

#[derive(Debug, Deserialize, Default)]
pub struct TableRowsQuery {
    #[serde(default)]
    pub columns: Option<String>,
    #[serde(default)]
    pub cursor: Option<u64>,
    #[serde(default)]
    pub from_row: Option<u64>,
    #[serde(default)]
    pub to_row: Option<u64>,
    #[serde(default)]
    pub from_t: Option<f64>,
    #[serde(default)]
    pub to_t: Option<f64>,
    #[serde(default)]
    pub limit: Option<u64>,
    #[serde(default)]
    pub target_points: Option<u64>,
    #[serde(default)]
    pub decimation: Option<String>,
    #[serde(default)]
    pub include_tail: Option<bool>,
}

#[utoipa::path(
    get,
    path = "/v2/sessions/current/data/tables",
    responses((status = 200, description = "Available table resources", body = TableListResource)),
    tag = "data"
)]
pub async fn list_tables(
    State(state): State<Arc<AppState>>,
) -> Result<Json<TableListResource>, ApiError> {
    let guard = state.current_live_state.read().await;
    let all_rows = guard.as_ref().map(|s| &s.scalar_rows[..]).unwrap_or(&[]);
    Ok(Json(TableListResource {
        revision: all_rows.len() as u64,
        tables: vec![default_table_resource(all_rows)],
    }))
}

#[utoipa::path(
    get,
    path = "/v2/sessions/current/data/tables/{table_id}",
    params(("table_id" = String, Path, description = "Table resource id")),
    responses(
        (status = 200, description = "Table resource metadata", body = TableResource),
        (status = 404, description = "Unknown table id"),
    ),
    tag = "data"
)]
pub async fn get_table(
    State(state): State<Arc<AppState>>,
    Path(table_id): Path<String>,
) -> Result<Json<TableResource>, ApiError> {
    ensure_default_table(&table_id)?;
    let guard = state.current_live_state.read().await;
    let all_rows = guard.as_ref().map(|s| &s.scalar_rows[..]).unwrap_or(&[]);
    Ok(Json(default_table_resource(all_rows)))
}

#[utoipa::path(
    get,
    path = "/v2/sessions/current/data/tables/{table_id}/columns",
    params(("table_id" = String, Path, description = "Table resource id")),
    responses(
        (status = 200, description = "Table column metadata", body = [TableColumnMeta]),
        (status = 404, description = "Unknown table id"),
    ),
    tag = "data"
)]
pub async fn get_table_columns(
    Path(table_id): Path<String>,
) -> Result<Json<Vec<TableColumnMeta>>, ApiError> {
    ensure_default_table(&table_id)?;
    Ok(Json(default_table_columns()))
}

#[utoipa::path(
    get,
    path = "/v2/sessions/current/data/tables/{table_id}/rows",
    params(
        ("table_id" = String, Path, description = "Table resource id"),
        ("cursor" = Option<u64>, Query, description = "Only rows after this cursor"),
        ("from_row" = Option<u64>, Query, description = "Inclusive one-based row cursor lower bound"),
        ("to_row" = Option<u64>, Query, description = "Inclusive one-based row cursor upper bound"),
        ("from_t" = Option<f64>, Query, description = "Inclusive simulation-time lower bound in seconds"),
        ("to_t" = Option<f64>, Query, description = "Inclusive simulation-time upper bound in seconds"),
        ("limit" = Option<u64>, Query, description = "Max rows to return"),
        ("target_points" = Option<u64>, Query, description = "Display point budget for server-side decimation"),
        ("decimation" = Option<String>, Query, description = "Server-side decimation mode"),
        ("include_tail" = Option<bool>, Query, description = "Preserve the latest row in decimated windows"),
        ("columns" = Option<String>, Query, description = "Comma-separated table columns to return"),
    ),
    responses(
        (status = 200, description = "Table row window", body = TableRowsResource),
        (status = 404, description = "Unknown table id"),
    ),
    tag = "data"
)]
pub async fn get_table_rows(
    State(state): State<Arc<AppState>>,
    Path(table_id): Path<String>,
    Query(query): Query<TableRowsQuery>,
) -> Result<Json<TableRowsResource>, ApiError> {
    ensure_default_table(&table_id)?;

    let guard = state.current_live_state.read().await;
    let all_rows = guard.as_ref().map(|s| &s.scalar_rows[..]).unwrap_or(&[]);
    let window = build_table_rows_resource(table_id, all_rows, &query);

    Ok(Json(window))
}

#[utoipa::path(
    get,
    path = "/v2/sessions/current/data/tables/{table_id}/rows.bin",
    params(
        ("table_id" = String, Path, description = "Table resource id"),
        ("cursor" = Option<u64>, Query, description = "Only rows after this cursor"),
        ("from_row" = Option<u64>, Query, description = "Inclusive one-based row cursor lower bound"),
        ("to_row" = Option<u64>, Query, description = "Inclusive one-based row cursor upper bound"),
        ("from_t" = Option<f64>, Query, description = "Inclusive simulation-time lower bound in seconds"),
        ("to_t" = Option<f64>, Query, description = "Inclusive simulation-time upper bound in seconds"),
        ("limit" = Option<u64>, Query, description = "Max rows to return"),
        ("target_points" = Option<u64>, Query, description = "Display point budget for server-side decimation"),
        ("decimation" = Option<String>, Query, description = "Server-side decimation mode"),
        ("include_tail" = Option<bool>, Query, description = "Preserve the latest row in decimated windows"),
        ("columns" = Option<String>, Query, description = "Comma-separated table columns to return"),
    ),
    responses(
        (status = 200, description = "Binary table row window", content_type = "application/vnd.fullmag.table-rows.v1+octet-stream", body = TableRowsBinaryDescriptor),
        (status = 404, description = "Unknown table id"),
    ),
    tag = "data"
)]
pub async fn get_table_rows_binary(
    State(state): State<Arc<AppState>>,
    Path(table_id): Path<String>,
    Query(query): Query<TableRowsQuery>,
) -> Result<impl IntoResponse, ApiError> {
    ensure_default_table(&table_id)?;

    let guard = state.current_live_state.read().await;
    let all_rows = guard.as_ref().map(|s| &s.scalar_rows[..]).unwrap_or(&[]);
    let window = build_table_rows_resource(table_id, all_rows, &query);
    let payload = encode_table_rows_binary(&window);
    let mut headers = axum::http::HeaderMap::new();
    headers.insert(
        header::CONTENT_TYPE,
        HeaderValue::from_static("application/vnd.fullmag.table-rows.v1+octet-stream"),
    );
    headers.insert(
        "x-fullmag-table-rows-format",
        HeaderValue::from_static("FMTB.v1.row-major-f64le"),
    );
    Ok((headers, payload))
}

fn ensure_default_table(table_id: &str) -> Result<(), ApiError> {
    if table_id == "default" {
        return Ok(());
    }
    Err(ApiError::not_found(format!("table '{table_id}' not found")))
}

fn default_table_resource(all_rows: &[ScalarRow]) -> TableResource {
    TableResource {
        table_id: "default".to_string(),
        revision: all_rows.len() as u64,
        schema_revision: 1,
        total_rows: all_rows.len() as u64,
        columns: default_table_columns(),
        rows_href: "/v2/sessions/current/data/tables/default/rows".to_string(),
        columns_href: "/v2/sessions/current/data/tables/default/columns".to_string(),
        binary_rows_href: "/v2/sessions/current/data/tables/default/rows.bin".to_string(),
    }
}

fn default_table_columns() -> Vec<TableColumnMeta> {
    resolve_table_columns(None)
        .into_iter()
        .filter_map(|column| table_column_meta(&column))
        .collect()
}

fn build_table_rows_resource(
    table_id: String,
    all_rows: &[ScalarRow],
    query: &TableRowsQuery,
) -> TableRowsResource {
    let total_rows = all_rows.len() as u64;
    let selection = select_table_rows(all_rows, query);
    let decimation_mode = query.decimation.as_deref().unwrap_or("none");
    let decimated_indices = decimated_row_indices(
        &selection.indices,
        all_rows,
        query.target_points,
        decimation_mode,
        query.include_tail.unwrap_or(true),
    );
    let rows_source_count = selection.indices.len() as u64;
    let decimation = decimation_meta(
        rows_source_count,
        decimated_indices.len() as u64,
        query.target_points,
        decimation_mode,
    );

    let column_ids = resolve_table_columns(query.columns.as_deref());
    let columns: Vec<TableColumnMeta> = column_ids
        .iter()
        .filter_map(|column| table_column_meta(column))
        .collect();
    let rows: Vec<Vec<f64>> = decimated_indices
        .iter()
        .map(|index| {
            let row = &all_rows[*index];
            column_ids
                .iter()
                .map(|column| table_column_value(row, column).unwrap_or(0.0))
                .collect()
        })
        .collect();

    let returned_rows = rows.len() as u64;
    let cursor_start = decimated_indices
        .first()
        .map(|index| *index as u64 + 1)
        .unwrap_or(selection.cursor_floor);
    let cursor_end = decimated_indices
        .last()
        .map(|index| *index as u64 + 1)
        .unwrap_or(selection.cursor_floor);

    TableRowsResource {
        table_id,
        revision: total_rows,
        schema_revision: 1,
        cursor_start,
        cursor_end,
        total_rows,
        returned_rows,
        columns,
        rows,
        decimation,
        resync_required: selection.resync_required,
    }
}

fn encode_table_rows_binary(window: &TableRowsResource) -> Vec<u8> {
    let column_count = window.columns.len() as u32;
    let row_count = window.rows.len() as u64;
    let mut payload =
        Vec::with_capacity(4 + 2 + 2 + 8 * 6 + 4 + window.rows.len() * window.columns.len() * 8);
    payload.extend_from_slice(TABLE_ROWS_BINARY_MAGIC);
    payload.extend_from_slice(&TABLE_ROWS_BINARY_VERSION.to_le_bytes());
    let flags = if window.resync_required { 1_u16 } else { 0_u16 };
    payload.extend_from_slice(&flags.to_le_bytes());
    payload.extend_from_slice(&window.revision.to_le_bytes());
    payload.extend_from_slice(&window.schema_revision.to_le_bytes());
    payload.extend_from_slice(&window.cursor_start.to_le_bytes());
    payload.extend_from_slice(&window.cursor_end.to_le_bytes());
    payload.extend_from_slice(&window.total_rows.to_le_bytes());
    payload.extend_from_slice(&row_count.to_le_bytes());
    payload.extend_from_slice(&column_count.to_le_bytes());
    for row in &window.rows {
        for value in row {
            payload.extend_from_slice(&value.to_le_bytes());
        }
    }
    payload
}

struct TableRowSelection {
    indices: Vec<usize>,
    cursor_floor: u64,
    resync_required: bool,
}

fn select_table_rows(all_rows: &[ScalarRow], query: &TableRowsQuery) -> TableRowSelection {
    let total_rows = all_rows.len() as u64;
    let limit = query
        .limit
        .unwrap_or(DEFAULT_TABLE_LIMIT)
        .min(MAX_TABLE_LIMIT)
        .max(1);
    let resync_required = query.cursor.is_some_and(|cursor| cursor > total_rows);
    let mut indices: Vec<usize> = Vec::new();

    if !resync_required {
        for (index, row) in all_rows.iter().enumerate() {
            let cursor = index as u64 + 1;
            if let Some(after_cursor) = query.cursor {
                if cursor <= after_cursor {
                    continue;
                }
            }
            if query.cursor.is_none() {
                if let Some(from_row) = query.from_row {
                    if cursor < from_row.max(1) {
                        continue;
                    }
                }
                if let Some(to_row) = query.to_row {
                    if cursor > to_row {
                        continue;
                    }
                }
            }
            if let Some(from_t) = query.from_t {
                if row.time < from_t {
                    continue;
                }
            }
            if let Some(to_t) = query.to_t {
                if row.time > to_t {
                    continue;
                }
            }
            indices.push(index);
        }
    }

    if indices.len() as u64 > limit {
        if query.cursor.is_some() {
            indices.truncate(limit as usize);
        } else {
            let keep_from = indices.len() - limit as usize;
            indices = indices[keep_from..].to_vec();
        }
    }

    let cursor_floor = query.cursor.unwrap_or_else(|| {
        indices
            .first()
            .map(|index| *index as u64)
            .unwrap_or(total_rows)
    });

    TableRowSelection {
        indices,
        cursor_floor,
        resync_required,
    }
}

fn decimated_row_indices(
    indices: &[usize],
    all_rows: &[ScalarRow],
    target_points: Option<u64>,
    mode: &str,
    include_tail: bool,
) -> Vec<usize> {
    let Some(target_points) = target_points else {
        return indices.to_vec();
    };
    let target_points = target_points.min(MAX_TARGET_POINTS).max(2) as usize;
    if indices.len() <= target_points || mode == "none" {
        return indices.to_vec();
    }

    let mut keep = BTreeSet::new();
    if let Some(first) = indices.first() {
        keep.insert(*first);
    }
    if let Some(last) = indices.last() {
        keep.insert(*last);
    }
    if include_tail {
        if let Some(last) = indices.last() {
            keep.insert(*last);
        }
    }

    let bucket_count = ((target_points.saturating_sub(2)) / 2).max(1);
    let bucket_width = (indices.len() as f64 / bucket_count as f64).ceil() as usize;
    for bucket in indices.chunks(bucket_width.max(1)) {
        if keep.len() >= target_points {
            break;
        }
        let min_index = bucket.iter().copied().min_by(|left, right| {
            all_rows[*left]
                .e_total
                .partial_cmp(&all_rows[*right].e_total)
                .unwrap_or(std::cmp::Ordering::Equal)
        });
        let max_index = bucket.iter().copied().max_by(|left, right| {
            all_rows[*left]
                .e_total
                .partial_cmp(&all_rows[*right].e_total)
                .unwrap_or(std::cmp::Ordering::Equal)
        });
        if let Some(index) = min_index {
            keep.insert(index);
        }
        if keep.len() >= target_points {
            break;
        }
        if let Some(index) = max_index {
            keep.insert(index);
        }
    }

    keep.into_iter().take(target_points).collect()
}

fn decimation_meta(
    source_rows: u64,
    returned_points: u64,
    target_points: Option<u64>,
    mode: &str,
) -> Option<TableDecimationMeta> {
    let target_points = target_points?;
    if source_rows <= returned_points || mode == "none" {
        return None;
    }
    Some(TableDecimationMeta {
        mode: mode.to_string(),
        source_rows,
        target_points,
        returned_points,
        endpoints_preserved: true,
        extrema_preserved: true,
    })
}

fn resolve_table_columns(columns: Option<&str>) -> Vec<String> {
    let mut resolved = vec!["step".to_string()];
    if let Some(columns) = columns {
        for column in columns
            .split(',')
            .map(str::trim)
            .filter(|value| !value.is_empty())
        {
            if table_column_meta(column).is_some() && !resolved.iter().any(|value| value == column)
            {
                resolved.push(column.to_string());
            }
        }
    } else {
        resolved.extend(["t", "mx", "my", "mz", "e_total", "max_torque"].map(str::to_string));
    }
    resolved
}

fn table_column_meta(column: &str) -> Option<TableColumnMeta> {
    let (quantity_id, label, unit, dimension, component, reduction, value_type) = match column {
        "step" => ("step", "step", "1", "count", None, None, "integer"),
        "t" | "time" => ("t", "t", "s", "time", None, None, "float"),
        "dt" | "solver_dt" => ("dt", "dt", "s", "time", None, None, "float"),
        "mx" => (
            "mx",
            "mx",
            "1",
            "normalized_magnetization",
            Some("x"),
            Some("average"),
            "float",
        ),
        "my" => (
            "my",
            "my",
            "1",
            "normalized_magnetization",
            Some("y"),
            Some("average"),
            "float",
        ),
        "mz" => (
            "mz",
            "mz",
            "1",
            "normalized_magnetization",
            Some("z"),
            Some("average"),
            "float",
        ),
        "e_ex" => ("e_ex", "E ex", "J", "energy", None, Some("sum"), "float"),
        "e_demag" => (
            "e_demag",
            "E demag",
            "J",
            "energy",
            None,
            Some("sum"),
            "float",
        ),
        "e_ext" => ("e_ext", "E ext", "J", "energy", None, Some("sum"), "float"),
        "e_ani" => ("e_ani", "E ani", "J", "energy", None, Some("sum"), "float"),
        "e_dmi" => ("e_dmi", "E dmi", "J", "energy", None, Some("sum"), "float"),
        "e_total" => (
            "e_total",
            "E total",
            "J",
            "energy",
            None,
            Some("sum"),
            "float",
        ),
        "max_dm_dt" => (
            "max_dm_dt",
            "max dm/dt",
            "1/s",
            "rate",
            None,
            Some("max"),
            "float",
        ),
        "max_h_eff" => (
            "max_h_eff",
            "max H eff",
            "A/m",
            "effective_field",
            None,
            Some("max"),
            "float",
        ),
        "max_h_demag" => (
            "max_h_demag",
            "max H demag",
            "A/m",
            "effective_field",
            None,
            Some("max"),
            "float",
        ),
        "max_torque" => (
            "max_torque_Apm",
            "max torque",
            "A/m",
            "effective_field",
            None,
            Some("max"),
            "float",
        ),
        "max_torque_T" => (
            "max_torque_T",
            "max torque (T)",
            "T",
            "effective_field",
            None,
            Some("max"),
            "float",
        ),
        _ => return None,
    };
    Some(TableColumnMeta {
        column_id: column.to_string(),
        quantity_id: quantity_id.to_string(),
        label: label.to_string(),
        unit: unit.to_string(),
        dimension: dimension.to_string(),
        component: component.map(str::to_string),
        reduction: reduction.map(str::to_string),
        value_type: value_type.to_string(),
    })
}

fn table_column_value(row: &ScalarRow, column: &str) -> Option<f64> {
    Some(match column {
        "step" => row.step as f64,
        "t" | "time" => row.time,
        "dt" | "solver_dt" => row.solver_dt,
        "mx" => row.mx,
        "my" => row.my,
        "mz" => row.mz,
        "e_ex" => row.e_ex,
        "e_demag" => row.e_demag,
        "e_ext" => row.e_ext,
        "e_ani" => row.e_ani,
        "e_dmi" => row.e_dmi,
        "e_total" => row.e_total,
        "max_dm_dt" => row.max_dm_dt,
        "max_h_eff" => row.max_h_eff,
        "max_h_demag" => row.max_h_demag,
        "max_torque" => row.max_torque_Apm,
        "max_torque_T" => row.max_torque_T,
        _ => return None,
    })
}
