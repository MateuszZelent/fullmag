use crate::autosave_storage::{AutosaveTargetWriter, ContinuousIndexEntry, StageManifest};
use fullmag_ir::AutosaveLayoutIR;
use hdf5::{File, Group};
use std::collections::BTreeMap;
use std::path::PathBuf;

pub struct Hdf5AutosaveWriter {
    root: PathBuf,
    current: Option<BufferedStage>,
}

struct BufferedStage {
    manifest: StageManifest,
    table_rows: Vec<Vec<f64>>,
    fields: BTreeMap<String, Vec<Vec<f64>>>,
    index: Vec<ContinuousIndexEntry>,
}

impl Hdf5AutosaveWriter {
    pub fn new(root: impl Into<PathBuf>) -> Self {
        Self {
            root: root.into(),
            current: None,
        }
    }

    pub fn file_path(&self, target: &str) -> PathBuf {
        self.root.join(format!("{target}.h5"))
    }
}

impl AutosaveTargetWriter for Hdf5AutosaveWriter {
    fn begin_stage(&mut self, manifest: &StageManifest) -> Result<(), String> {
        if self.current.is_some() {
            return Err("HDF5 autosave already has an active stage".into());
        }
        self.current = Some(BufferedStage {
            manifest: manifest.clone(),
            table_rows: Vec::new(),
            fields: BTreeMap::new(),
            index: Vec::new(),
        });
        Ok(())
    }

    fn append_table_row(
        &mut self,
        entry: &ContinuousIndexEntry,
        values: &[f64],
    ) -> Result<(), String> {
        let current = self.current_mut()?;
        if values.len() != current.manifest.table_quantities.len() {
            return Err("HDF5 table row does not match declared quantity count".into());
        }
        current.table_rows.push(values.to_vec());
        current.index.push(entry.clone());
        Ok(())
    }

    fn append_field_sample(
        &mut self,
        entry: &ContinuousIndexEntry,
        quantity: &str,
        values: &[f64],
    ) -> Result<(), String> {
        let current = self.current_mut()?;
        if !current
            .manifest
            .field_quantities
            .iter()
            .any(|value| value == quantity)
        {
            return Err(format!("HDF5 field '{quantity}' was not declared"));
        }
        let rows = current.fields.entry(quantity.to_string()).or_default();
        if rows.first().is_some_and(|row| row.len() != values.len()) {
            return Err(format!(
                "HDF5 field '{quantity}' shape changed within a stage"
            ));
        }
        rows.push(values.to_vec());
        current.index.push(entry.clone());
        Ok(())
    }

    fn finish_stage(&mut self, manifest: &StageManifest) -> Result<(), String> {
        let current = self
            .current
            .take()
            .ok_or_else(|| "HDF5 autosave has no active stage".to_string())?;
        std::fs::create_dir_all(&self.root).map_err(|error| error.to_string())?;
        let path = self.file_path(&manifest.target);
        let file = if path.exists() {
            File::open_rw(&path).map_err(|error| error.to_string())?
        } else {
            File::create(&path).map_err(|error| error.to_string())?
        };
        let stages = require_group(&file, "stages")?;
        let stage = stages
            .create_group(&format!(
                "stage_{:04}_{}",
                manifest.stage_index, manifest.stage_id
            ))
            .map_err(|error| error.to_string())?;
        write_json_bytes(&stage, "manifest_json", manifest)?;
        if !current.table_rows.is_empty() {
            write_matrix(&stage, "table", &current.table_rows)?;
            write_json_bytes(&stage, "table_quantities_json", &manifest.table_quantities)?;
        }
        if !current.fields.is_empty() {
            let fields = stage
                .create_group("fields")
                .map_err(|error| error.to_string())?;
            for (quantity, rows) in &current.fields {
                write_matrix(&fields, quantity, rows)?;
            }
        }
        if manifest.layout == AutosaveLayoutIR::Continuous {
            let continuous = require_group(&file, "continuous")?;
            let name = format!("stage_{:04}_index_json", manifest.stage_index);
            write_json_bytes(&continuous, &name, &current.index)?;
        }
        file.flush().map_err(|error| error.to_string())
    }
}

impl Hdf5AutosaveWriter {
    fn current_mut(&mut self) -> Result<&mut BufferedStage, String> {
        self.current
            .as_mut()
            .ok_or_else(|| "HDF5 autosave has no active stage".to_string())
    }
}

fn require_group(file: &File, name: &str) -> Result<Group, String> {
    if file.link_exists(name) {
        file.group(name).map_err(|error| error.to_string())
    } else {
        file.create_group(name).map_err(|error| error.to_string())
    }
}

fn write_matrix(group: &Group, name: &str, rows: &[Vec<f64>]) -> Result<(), String> {
    let width = rows.first().map(Vec::len).unwrap_or(0);
    if rows.iter().any(|row| row.len() != width) {
        return Err(format!("HDF5 dataset '{name}' has ragged rows"));
    }
    let flat = rows.iter().flatten().copied().collect::<Vec<_>>();
    let dataset = group
        .new_dataset::<f64>()
        .shape((rows.len(), width))
        .create(name)
        .map_err(|error| error.to_string())?;
    dataset.write_raw(&flat).map_err(|error| error.to_string())
}

fn write_json_bytes(
    group: &Group,
    name: &str,
    value: &impl serde::Serialize,
) -> Result<(), String> {
    let bytes = serde_json::to_vec(value).map_err(|error| error.to_string())?;
    group
        .new_dataset_builder()
        .with_data(&bytes)
        .create(name)
        .map_err(|error| error.to_string())?;
    Ok(())
}

#[cfg(test)]
mod tests {
    use super::*;
    use crate::autosave_storage::{AutosaveTargetState, StageSampleCoordinate};
    use fullmag_ir::{AutosaveFormatIR, AutosaveLayoutIR};

    #[test]
    fn hdf5_preserves_stage_payload_and_metadata_only_continuous_index() {
        let root =
            std::env::temp_dir().join(format!("fullmag-autosave-h5-{}", uuid::Uuid::new_v4()));
        let mut writer = Hdf5AutosaveWriter::new(&root);
        let mut state = AutosaveTargetState::new("main");
        state
            .begin_stage(
                &mut writer,
                "run",
                AutosaveLayoutIR::Continuous,
                AutosaveFormatIR::Hdf5,
                vec!["mx".into()],
                vec!["m".into()],
            )
            .unwrap();
        state
            .append_table_row(
                &mut writer,
                StageSampleCoordinate::PhysicalTime { time_s: 1e-12 },
                &[0.5],
            )
            .unwrap();
        state
            .append_field_sample(
                &mut writer,
                StageSampleCoordinate::PhysicalTime { time_s: 1e-12 },
                "m",
                &[1.0, 0.0, 0.0],
            )
            .unwrap();
        state.finish_stage(&mut writer).unwrap();

        let file = File::open(root.join("main.h5")).unwrap();
        assert_eq!(
            file.dataset("stages/stage_0000_run/table").unwrap().shape(),
            [1, 1]
        );
        assert_eq!(
            file.dataset("stages/stage_0000_run/fields/m")
                .unwrap()
                .shape(),
            [1, 3]
        );
        assert!(file.dataset("continuous/stage_0000_index_json").is_ok());
        assert!(file.dataset("continuous/table").is_err());
        std::fs::remove_dir_all(root).unwrap();
    }
}
