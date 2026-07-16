//! Runtime table-autosave support for scalar chart rows.

use std::fs;
use std::io::{self, Write};
use std::path::Path;

use crate::types::StepStats;

pub const DEFAULT_TABLE_ID: &str = "default";
pub const DEFAULT_TABLE_COLUMNS: &[&str] =
    &["step", "t", "mx", "my", "mz", "e_total", "max_torque"];

#[derive(Debug, Clone, PartialEq, Eq)]
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

#[derive(Debug, Clone, PartialEq)]
pub struct TableRow {
    pub cursor: u64,
    pub values: Vec<f64>,
    pub sample_policy: Option<String>,
}

#[derive(Debug, Clone, PartialEq)]
pub struct TableWindow {
    pub revision: u64,
    pub schema_revision: u64,
    pub cursor_start: u64,
    pub cursor_end: u64,
    pub total_rows: u64,
    pub returned_rows: u64,
    pub columns: Vec<TableColumnMeta>,
    pub rows: Vec<TableRow>,
    pub resync_required: bool,
}

#[derive(Debug, Clone)]
pub struct TableAutosaveConfig {
    pub table_id: String,
    pub sample_period_s: f64,
    pub columns: Vec<TableColumnMeta>,
    pub sampling_resolution: Option<serde_json::Value>,
}

impl TableAutosaveConfig {
    pub fn from_ir(ir: &fullmag_ir::TableAutosaveIR) -> Result<Self, String> {
        if ir.table_id.trim().is_empty() {
            return Err("table_autosave.table_id must not be empty".to_string());
        }
        let sample_period_s = ir
            .explicit_sample_period_s()
            .or(ir.resolved_sample_period_s)
            .ok_or_else(|| {
                if ir.requests_auto_sinc_cutoff() {
                    "table_autosave has unresolved automatic sampling; the planner must resolve it before runtime dispatch".to_string()
                } else {
                    "table_autosave sampling period is unresolved".to_string()
                }
            })?;
        if !sample_period_s.is_finite() || sample_period_s <= 0.0 {
            return Err("table_autosave.sample_period_s must be positive".to_string());
        }
        let quantity_ids: Vec<&str> = if ir.quantities.is_empty() {
            DEFAULT_TABLE_COLUMNS.to_vec()
        } else {
            ir.quantities.iter().map(String::as_str).collect()
        };
        let mut columns = Vec::with_capacity(quantity_ids.len());
        for quantity_id in quantity_ids {
            columns.push(
                table_column_meta(quantity_id).ok_or_else(|| {
                    format!("unsupported table_autosave quantity '{quantity_id}'")
                })?,
            );
        }
        Ok(Self {
            table_id: ir.table_id.clone(),
            sample_period_s,
            columns,
            sampling_resolution: None,
        })
    }

    pub fn with_sampling_resolution(
        mut self,
        sampling_resolution: Option<serde_json::Value>,
    ) -> Self {
        self.sampling_resolution = sampling_resolution;
        self
    }
}

#[derive(Debug, Clone)]
pub struct TableStore {
    config: TableAutosaveConfig,
    rows: Vec<TableRow>,
    next_sample_t: f64,
    schema_revision: u64,
}

impl TableStore {
    pub fn new(config: TableAutosaveConfig) -> Self {
        Self {
            config,
            rows: Vec::new(),
            next_sample_t: 0.0,
            schema_revision: 1,
        }
    }

    pub fn table_id(&self) -> &str {
        &self.config.table_id
    }

    pub fn revision(&self) -> u64 {
        self.rows.len() as u64
    }

    pub fn append_if_due(&mut self, stats: &StepStats) -> Result<bool, String> {
        let eps = self.config.sample_period_s.abs() * 1e-9;
        if stats.time + eps < self.next_sample_t {
            return Ok(false);
        }

        let sample_policy = if stats.time > self.next_sample_t + eps {
            Some("coalesced_to_step".to_string())
        } else {
            None
        };
        let values = self
            .config
            .columns
            .iter()
            .map(|column| table_column_value(stats, &column.column_id))
            .collect::<Result<Vec<_>, _>>()?;
        let cursor = self.rows.len() as u64 + 1;
        self.rows.push(TableRow {
            cursor,
            values,
            sample_policy,
        });
        while self.next_sample_t <= stats.time + eps {
            self.next_sample_t += self.config.sample_period_s;
        }
        Ok(true)
    }

    pub fn window_after(&self, cursor: Option<u64>, limit: Option<u64>) -> TableWindow {
        let revision = self.revision();
        let resync_required = cursor.is_some_and(|cursor| cursor > revision);
        let start = if resync_required {
            self.rows.len()
        } else {
            cursor.unwrap_or(0).min(revision) as usize
        };
        let limit = limit.unwrap_or(5_000).max(1) as usize;
        let rows = self
            .rows
            .iter()
            .skip(start)
            .take(limit)
            .cloned()
            .collect::<Vec<_>>();
        let cursor_start = rows
            .first()
            .map(|row| row.cursor)
            .unwrap_or(cursor.unwrap_or(revision));
        let cursor_end = rows
            .last()
            .map(|row| row.cursor)
            .unwrap_or(cursor.unwrap_or(revision));
        TableWindow {
            revision,
            schema_revision: self.schema_revision,
            cursor_start,
            cursor_end,
            total_rows: revision,
            returned_rows: rows.len() as u64,
            columns: self.config.columns.clone(),
            rows,
            resync_required,
        }
    }

    pub fn write_artifacts(&self, artifact_dir: &Path) -> io::Result<()> {
        let table_dir = artifact_dir.join("tables").join(&self.config.table_id);
        fs::create_dir_all(&table_dir)?;
        write_table_csv(
            &table_dir.join("table.csv"),
            &self.config.columns,
            &self.rows,
        )?;
        write_table_json(&table_dir.join("table.json"), &self.rows)?;
        write_schema_json(&table_dir.join("schema.json"), &self.config)?;
        Ok(())
    }
}

pub fn table_column_meta(column: &str) -> Option<TableColumnMeta> {
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
        "e_drive" => (
            "e_drive",
            "E drive",
            "J",
            "energy",
            None,
            Some("sum"),
            "float",
        ),
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
        "max_torque" | "max_torque_Apm" => (
            "max_torque",
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
        column_id: quantity_id.to_string(),
        quantity_id: quantity_id.to_string(),
        label: label.to_string(),
        unit: unit.to_string(),
        dimension: dimension.to_string(),
        component: component.map(str::to_string),
        reduction: reduction.map(str::to_string),
        value_type: value_type.to_string(),
    })
}

pub fn table_column_value(stats: &StepStats, column: &str) -> Result<f64, String> {
    Ok(match column {
        "step" => stats.step as f64,
        "t" | "time" => stats.time,
        "dt" | "solver_dt" => stats.dt,
        "mx" => stats.mx,
        "my" => stats.my,
        "mz" => stats.mz,
        "e_ex" => stats.e_ex,
        "e_demag" => stats.e_demag,
        "e_ext" => stats.e_ext,
        "e_drive" => stats.e_drive,
        "e_ani" => stats.e_ani,
        "e_dmi" => stats.e_dmi,
        "e_total" => stats.e_total,
        "max_dm_dt" => stats.max_dm_dt,
        "max_h_eff" => stats.max_h_eff,
        "max_h_demag" => stats.max_h_demag,
        "max_torque" | "max_torque_Apm" => stats.max_torque_Apm,
        "max_torque_T" => stats.max_torque_T,
        _ => return Err(format!("unsupported table column '{column}'")),
    })
}

fn write_table_csv(path: &Path, columns: &[TableColumnMeta], rows: &[TableRow]) -> io::Result<()> {
    let mut file = fs::File::create(path)?;
    for (index, column) in columns.iter().enumerate() {
        if index > 0 {
            write!(file, ",")?;
        }
        write!(file, "{}", column.column_id)?;
    }
    writeln!(file)?;
    for row in rows {
        for (index, value) in row.values.iter().enumerate() {
            if index > 0 {
                write!(file, ",")?;
            }
            write!(file, "{value:.15e}")?;
        }
        writeln!(file)?;
    }
    Ok(())
}

fn write_table_json(path: &Path, rows: &[TableRow]) -> io::Result<()> {
    let rows_json = rows
        .iter()
        .map(|row| {
            serde_json::json!({
                "cursor": row.cursor,
                "sample_policy": row.sample_policy,
                "values": row.values,
            })
        })
        .collect::<Vec<_>>();
    fs::write(
        path,
        serde_json::to_string_pretty(&serde_json::json!({ "rows": rows_json }))?,
    )
}

fn write_schema_json(path: &Path, config: &TableAutosaveConfig) -> io::Result<()> {
    let columns = config
        .columns
        .iter()
        .map(|column| {
            serde_json::json!({
                "column_id": column.column_id,
                "quantity_id": column.quantity_id,
                "label": column.label,
                "unit": column.unit,
                "dimension": column.dimension,
                "component": column.component,
                "reduction": column.reduction,
                "value_type": column.value_type,
            })
        })
        .collect::<Vec<_>>();
    fs::write(
        path,
        serde_json::to_string_pretty(&serde_json::json!({
            "kind": "table_autosave.schema",
            "table_id": config.table_id,
            "sample_period_s": config.sample_period_s,
            "sampling_resolution": config.sampling_resolution,
            "columns": columns,
        }))?,
    )
}

#[cfg(test)]
mod tests {
    use std::time::{SystemTime, UNIX_EPOCH};

    use super::*;

    fn stats(step: u64, time: f64) -> StepStats {
        StepStats {
            step,
            time,
            dt: 1e-12,
            mx: 0.1 * step as f64,
            my: 0.2 * step as f64,
            mz: 0.9,
            e_ex: 1.0,
            e_demag: 2.0,
            e_ext: 3.0,
            e_ani: 0.4,
            e_dmi: 0.5,
            e_total: step as f64,
            max_dm_dt: 0.01,
            max_h_eff: 100.0,
            max_h_demag: 10.0,
            max_torque_Apm: 2.0,
            max_torque_T: 0.002,
            ..StepStats::default()
        }
    }

    fn config(period: f64) -> TableAutosaveConfig {
        TableAutosaveConfig::from_ir(&fullmag_ir::TableAutosaveIR {
            kind: "table_autosave".to_string(),
            table_id: DEFAULT_TABLE_ID.to_string(),
            sample_period_s: Some(period),
            sample_period_policy: None,
            resolved_sample_period_s: None,
            quantities: DEFAULT_TABLE_COLUMNS
                .iter()
                .map(|value| value.to_string())
                .collect(),
        })
        .expect("default table config should resolve")
    }

    #[test]
    fn table_store_appends_on_simulation_time_cadence() {
        let mut store = TableStore::new(config(1e-12));

        assert!(store.append_if_due(&stats(0, 0.0)).unwrap());
        assert!(!store.append_if_due(&stats(1, 0.5e-12)).unwrap());
        assert!(store.append_if_due(&stats(2, 1.2e-12)).unwrap());

        let window = store.window_after(None, None);
        assert_eq!(window.revision, 2);
        assert_eq!(window.rows[0].values[0], 0.0);
        assert_eq!(window.rows[1].values[1], 1.2e-12);
        assert_eq!(
            window.rows[1].sample_policy.as_deref(),
            Some("coalesced_to_step")
        );
    }

    #[test]
    fn regional_drive_energy_is_a_supported_table_quantity() {
        let config = TableAutosaveConfig::from_ir(&fullmag_ir::TableAutosaveIR {
            kind: "table_autosave".to_string(),
            table_id: DEFAULT_TABLE_ID.to_string(),
            sample_period_s: Some(1e-12),
            sample_period_policy: None,
            resolved_sample_period_s: None,
            quantities: vec!["e_drive".to_string()],
        })
        .expect("regional drive energy should be accepted");
        assert_eq!(config.columns[0].quantity_id, "e_drive");
        let mut step = stats(1, 1e-12);
        step.e_drive = -7.5e-20;
        assert_eq!(table_column_value(&step, "e_drive").unwrap(), -7.5e-20);
    }

    #[test]
    fn auto_sampling_unresolved_table_is_rejected_before_writer_construction() {
        let error = TableAutosaveConfig::from_ir(&fullmag_ir::TableAutosaveIR {
            kind: "table_autosave".to_string(),
            table_id: DEFAULT_TABLE_ID.to_string(),
            sample_period_s: None,
            sample_period_policy: Some(
                fullmag_ir::SamplingPeriodPolicyIR::AutoSincCutoff {
                    nyquist_guard_factor: fullmag_ir::AUTO_SINC_NYQUIST_GUARD_FACTOR,
                },
            ),
            resolved_sample_period_s: None,
            quantities: vec!["t".to_string(), "my".to_string()],
        })
        .expect_err("unresolved automatic table cadence must fail closed");

        assert!(error.contains("unresolved automatic sampling"));
    }

    #[test]
    fn table_store_returns_cursor_windows_and_resync_signal() {
        let mut store = TableStore::new(config(1e-12));
        for step in 0..5 {
            assert!(store
                .append_if_due(&stats(step, step as f64 * 1e-12))
                .unwrap());
        }

        let window = store.window_after(Some(2), Some(2));
        assert_eq!(window.cursor_start, 3);
        assert_eq!(window.cursor_end, 4);
        assert_eq!(window.returned_rows, 2);
        assert!(!window.resync_required);

        let stale = store.window_after(Some(20), Some(2));
        assert_eq!(stale.returned_rows, 0);
        assert!(stale.resync_required);
    }

    #[test]
    fn table_store_writes_csv_json_and_schema_artifacts() {
        let mut store = TableStore::new(config(1e-12));
        assert!(store.append_if_due(&stats(0, 0.0)).unwrap());

        let stamp = SystemTime::now()
            .duration_since(UNIX_EPOCH)
            .expect("system clock should be after UNIX_EPOCH")
            .as_nanos();
        let artifact_dir = std::env::temp_dir().join(format!(
            "fullmag-table-autosave-{}-{stamp}",
            std::process::id()
        ));
        store
            .write_artifacts(&artifact_dir)
            .expect("table artifacts should write");

        let table_dir = artifact_dir.join("tables").join(DEFAULT_TABLE_ID);
        assert!(table_dir.join("table.csv").exists());
        assert!(table_dir.join("table.json").exists());
        assert!(table_dir.join("schema.json").exists());
        let schema = fs::read_to_string(table_dir.join("schema.json"))
            .expect("schema artifact should be readable");
        assert!(schema.contains("\"table_id\": \"default\""));

        fs::remove_dir_all(artifact_dir).expect("temp artifacts should be removable");
    }

    #[test]
    fn auto_sampling_schema_preserves_complete_planner_resolution() {
        let resolution = serde_json::json!({
            "requested_policy": {
                "kind": "auto_sinc_cutoff",
                "nyquist_guard_factor": 1.3
            },
            "sample_period_s": 7.692307692307691e-11,
            "maximum_cutoff_hz": 5.0e9,
            "nyquist_guard_factor": 1.3,
            "target_nyquist_hz": 6.5e9,
            "sampling_frequency_hz": 13.0e9,
            "source_drive_ids": ["k0-sinc-antenna"],
            "target_stage_id": "excite"
        });
        let store = TableStore::new(config(1.0 / 13.0e9).with_sampling_resolution(
            Some(resolution.clone()),
        ));
        let artifact_dir = std::env::temp_dir().join(format!(
            "fullmag-table-auto-provenance-{}",
            std::process::id()
        ));

        store
            .write_artifacts(&artifact_dir)
            .expect("table schema should write");

        let schema: serde_json::Value = serde_json::from_slice(
            &fs::read(
                artifact_dir
                    .join("tables")
                    .join(DEFAULT_TABLE_ID)
                    .join("schema.json"),
            )
            .expect("schema artifact should be readable"),
        )
        .expect("schema artifact should be JSON");
        assert_eq!(schema["sampling_resolution"], resolution);
        let _ = fs::remove_dir_all(artifact_dir);
    }
}
