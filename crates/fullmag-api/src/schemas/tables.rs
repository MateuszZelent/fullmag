use serde::{Deserialize, Serialize};
use utoipa::ToSchema;

#[derive(Debug, Serialize, Deserialize, ToSchema)]
pub struct TableColumnMeta {
    pub column_id: String,
    pub quantity_id: String,
    pub label: String,
    pub unit: String,
    pub dimension: String,
    pub component: Option<String>,
    pub reduction: Option<String>,
    pub value_type: String,
}

#[derive(Debug, Serialize, Deserialize, ToSchema)]
pub struct TableListResource {
    pub revision: u64,
    pub tables: Vec<TableResource>,
}

#[derive(Debug, Serialize, Deserialize, ToSchema)]
pub struct TableResource {
    pub table_id: String,
    pub revision: u64,
    pub schema_revision: u64,
    pub total_rows: u64,
    pub columns: Vec<TableColumnMeta>,
    pub rows_href: String,
    pub columns_href: String,
    pub binary_rows_href: String,
}

#[derive(Debug, Serialize, Deserialize, ToSchema)]
pub struct TableRowsResource {
    pub table_id: String,
    pub revision: u64,
    pub schema_revision: u64,
    pub cursor_start: u64,
    pub cursor_end: u64,
    pub total_rows: u64,
    pub returned_rows: u64,
    pub columns: Vec<TableColumnMeta>,
    pub rows: Vec<Vec<f64>>,
    pub decimation: Option<TableDecimationMeta>,
    pub resync_required: bool,
}

#[derive(Debug, Serialize, Deserialize, ToSchema)]
pub struct TableDecimationMeta {
    pub mode: String,
    pub source_rows: u64,
    pub target_points: u64,
    pub returned_points: u64,
    pub endpoints_preserved: bool,
    pub extrema_preserved: bool,
}

#[derive(Debug, Serialize, Deserialize, ToSchema)]
pub struct TableRowsBinaryDescriptor {
    pub format: String,
    pub version: u16,
    pub layout: String,
    pub value_type: String,
    pub endianness: String,
}
