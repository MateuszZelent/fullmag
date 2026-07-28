use crate::autosave_storage::{
    update_artifact_manifest, AutosaveTargetWriter, ContinuousIndexEntry, StageManifest,
};
use fullmag_ir::AutosaveLayoutIR;
use serde_json::json;
use std::fs::{self, OpenOptions};
use std::io::Write;
use std::path::{Path, PathBuf};

pub struct ZarrAutosaveWriter {
    root: PathBuf,
    current: Option<ZarrStage>,
}

struct ZarrStage {
    manifest: StageManifest,
    path: PathBuf,
    table_samples: usize,
    field_samples: std::collections::BTreeMap<String, usize>,
}

impl ZarrAutosaveWriter {
    pub fn new(root: impl Into<PathBuf>) -> Self {
        Self {
            root: root.into(),
            current: None,
        }
    }

    pub fn store_path(&self, target: &str) -> PathBuf {
        self.root.join(format!("{target}.zarr"))
    }
}

impl AutosaveTargetWriter for ZarrAutosaveWriter {
    fn begin_stage(&mut self, manifest: &StageManifest) -> Result<(), String> {
        update_artifact_manifest(&self.root, manifest)?;
        let store = self.store_path(&manifest.target);
        initialize_group(&store)?;
        write_json(
            &store.join(".zattrs"),
            &json!({"schema_version": "fullmag.stage_autosave.v1", "target": manifest.target}),
        )?;
        initialize_group(&store.join("stages"))?;
        let stage_path = store.join("stages").join(format!(
            "stage_{:04}_{}",
            manifest.stage_index, manifest.stage_id
        ));
        initialize_group(&stage_path)?;
        write_json(&stage_path.join("manifest.json"), manifest)?;
        if !manifest.table_quantities.is_empty() {
            let table = stage_path.join("table");
            initialize_array(&table, 0, manifest.table_quantities.len())?;
            write_json(
                &table.join(".zattrs"),
                &json!({"quantities": manifest.table_quantities, "dimension_order": ["sample", "quantity"]}),
            )?;
        }
        let fields = stage_path.join("fields");
        if !manifest.field_quantities.is_empty() {
            initialize_group(&fields)?;
        }
        if manifest.layout == AutosaveLayoutIR::Continuous {
            let continuous = store.join("continuous");
            initialize_group(&continuous)?;
            write_json(
                &continuous.join(".zattrs"),
                &json!({"payload_policy": "references_only", "index": "index.jsonl"}),
            )?;
        }
        self.current = Some(ZarrStage {
            manifest: manifest.clone(),
            path: stage_path,
            table_samples: 0,
            field_samples: std::collections::BTreeMap::new(),
        });
        Ok(())
    }

    fn append_table_row(
        &mut self,
        entry: &ContinuousIndexEntry,
        values: &[f64],
    ) -> Result<(), String> {
        let root = self.root.clone();
        let current = self.current_mut()?;
        if values.len() != current.manifest.table_quantities.len() {
            return Err("Zarr table row does not match declared quantity count".into());
        }
        let table = current.path.join("table");
        write_f64_chunk(&table.join(format!("{}.0", current.table_samples)), values)?;
        current.table_samples += 1;
        initialize_array(&table, current.table_samples, values.len())?;
        append_continuous_index(&root, &current.manifest, entry)
    }

    fn append_field_sample(
        &mut self,
        entry: &ContinuousIndexEntry,
        quantity: &str,
        values: &[f64],
    ) -> Result<(), String> {
        let root = self.root.clone();
        let current = self.current_mut()?;
        if !current
            .manifest
            .field_quantities
            .iter()
            .any(|declared| declared == quantity)
        {
            return Err(format!(
                "Zarr field '{quantity}' was not declared for this stage"
            ));
        }
        let field = current.path.join("fields").join(quantity);
        let sample = *current.field_samples.get(quantity).unwrap_or(&0);
        if sample == 0 {
            initialize_array(&field, 0, values.len())?;
            write_json(
                &field.join(".zattrs"),
                &json!({"quantity": quantity, "dimension_order": ["sample", "value"]}),
            )?;
        }
        write_f64_chunk(&field.join(format!("{sample}.0")), values)?;
        let sample_count = sample + 1;
        current
            .field_samples
            .insert(quantity.to_string(), sample_count);
        initialize_array(&field, sample_count, values.len())?;
        append_continuous_index(&root, &current.manifest, entry)
    }

    fn finish_stage(&mut self, manifest: &StageManifest) -> Result<(), String> {
        let current = self
            .current
            .take()
            .ok_or_else(|| "Zarr autosave has no active stage".to_string())?;
        write_json(&current.path.join("manifest.json"), manifest)?;
        update_artifact_manifest(&self.root, manifest)
    }
}

impl ZarrAutosaveWriter {
    fn current_mut(&mut self) -> Result<&mut ZarrStage, String> {
        self.current
            .as_mut()
            .ok_or_else(|| "Zarr autosave has no active stage".to_string())
    }
}

fn initialize_group(path: &Path) -> Result<(), String> {
    fs::create_dir_all(path).map_err(|error| error.to_string())?;
    write_json(&path.join(".zgroup"), &json!({"zarr_format": 2}))
}

fn initialize_array(path: &Path, sample_count: usize, width: usize) -> Result<(), String> {
    fs::create_dir_all(path).map_err(|error| error.to_string())?;
    write_json(
        &path.join(".zarray"),
        &json!({
            "zarr_format": 2,
            "shape": [sample_count, width],
            "chunks": [1, width.max(1)],
            "dtype": "<f8",
            "compressor": null,
            "fill_value": null,
            "order": "C",
            "filters": null,
            "dimension_separator": "."
        }),
    )
}

fn write_json(path: &Path, value: &impl serde::Serialize) -> Result<(), String> {
    let bytes = serde_json::to_vec_pretty(value).map_err(|error| error.to_string())?;
    fs::write(path, bytes).map_err(|error| error.to_string())
}

fn write_f64_chunk(path: &Path, values: &[f64]) -> Result<(), String> {
    let mut bytes = Vec::with_capacity(values.len() * 8);
    for value in values {
        bytes.extend_from_slice(&value.to_le_bytes());
    }
    fs::write(path, bytes).map_err(|error| error.to_string())
}

fn append_continuous_index(
    root: &Path,
    manifest: &StageManifest,
    entry: &ContinuousIndexEntry,
) -> Result<(), String> {
    if manifest.layout != AutosaveLayoutIR::Continuous {
        return Ok(());
    }
    let path = root
        .join(format!("{}.zarr", manifest.target))
        .join("continuous/index.jsonl");
    let mut file = OpenOptions::new()
        .create(true)
        .append(true)
        .open(path)
        .map_err(|error| error.to_string())?;
    serde_json::to_writer(&mut file, entry).map_err(|error| error.to_string())?;
    writeln!(file).map_err(|error| error.to_string())
}

pub fn read_logical_index(store: &Path) -> Result<Vec<ContinuousIndexEntry>, String> {
    let text = fs::read_to_string(store.join("continuous/index.jsonl"))
        .map_err(|error| error.to_string())?;
    text.lines()
        .filter(|line| !line.trim().is_empty())
        .map(|line| serde_json::from_str(line).map_err(|error| error.to_string()))
        .collect()
}

#[cfg(test)]
mod tests {
    use super::*;
    use crate::autosave_storage::{AutosaveSampleKind, AutosaveTargetState, StageSampleCoordinate};
    use fullmag_ir::AutosaveFormatIR;

    fn temp_root() -> PathBuf {
        std::env::temp_dir().join(format!("fullmag-autosave-zarr-{}", uuid::Uuid::new_v4()))
    }

    #[test]
    fn zarr_layout_is_time_first_and_continuous_contains_metadata_only() {
        let root = temp_root();
        let mut writer = ZarrAutosaveWriter::new(&root);
        let mut state = AutosaveTargetState::new("main");
        state
            .begin_stage(
                &mut writer,
                "relax",
                AutosaveLayoutIR::Continuous,
                AutosaveFormatIR::Zarr,
                vec!["mx".into()],
                vec!["m".into()],
            )
            .unwrap();
        state
            .append_table_row(
                &mut writer,
                StageSampleCoordinate::AcceptedStep { accepted_step: 10 },
                &[0.25],
            )
            .unwrap();
        state
            .append_field_sample(
                &mut writer,
                StageSampleCoordinate::AcceptedStep { accepted_step: 10 },
                "m",
                &[1.0, 0.0, 0.0],
            )
            .unwrap();
        state.finish_stage(&mut writer).unwrap();

        let store = root.join("main.zarr");
        let stage = store.join("stages/stage_0000_relax");
        let table_meta: serde_json::Value =
            serde_json::from_slice(&fs::read(stage.join("table/.zarray")).unwrap()).unwrap();
        let field_meta: serde_json::Value =
            serde_json::from_slice(&fs::read(stage.join("fields/m/.zarray")).unwrap()).unwrap();
        assert_eq!(table_meta["shape"], json!([1, 1]));
        assert_eq!(field_meta["shape"], json!([1, 3]));
        assert!(stage.join("table/0.0").exists());
        assert!(stage.join("fields/m/0.0").exists());
        assert!(!store.join("continuous/0.0").exists());
        let index = read_logical_index(&store).unwrap();
        assert_eq!(index.len(), 2);
        assert_eq!(index[0].sample_kind, AutosaveSampleKind::Table);
        assert_eq!(index[1].payload_ref, "stages/stage_0000_relax/fields/m/0");
        fs::remove_dir_all(root).unwrap();
    }
}
