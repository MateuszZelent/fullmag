use crate::autosave_storage::{
    update_artifact_manifest, AutosaveTargetWriter, ContinuousIndexEntry, StageManifest,
    StageSampleCoordinate,
};
use fullmag_ir::AutosaveLayoutIR;
use serde_json::json;
use std::fs::{self, OpenOptions};
use std::io::{BufWriter, Seek, SeekFrom, Write};
use std::path::{Path, PathBuf};

pub struct ZarrAutosaveWriter {
    root: PathBuf,
    current: Option<ZarrStage>,
    latest_provenance: Option<serde_json::Value>,
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
            latest_provenance: None,
        }
    }

    pub fn store_path(&self, target: &str) -> PathBuf {
        self.root.join(format!("{target}.zarr"))
    }

    pub fn update_provenance(&mut self, provenance: &serde_json::Value) -> Result<(), String> {
        self.latest_provenance = Some(provenance.clone());
        let root = self.root.clone();
        let current = self
            .current
            .as_mut()
            .ok_or_else(|| "Zarr autosave has no active stage".to_string())?;
        current.manifest.provenance = Some(provenance.clone());
        update_json_property(
            &root
                .join(format!("{}.zarr", current.manifest.target))
                .join(".zattrs"),
            "provenance",
            provenance.clone(),
        )?;
        update_json_property(
            &current.path.join("manifest.json"),
            "provenance",
            provenance.clone(),
        )?;
        for quantity in &current.manifest.field_quantities {
            let path = current.path.join("fields").join(quantity).join(".zattrs");
            if path.is_file() {
                update_json_property(&path, "provenance", provenance.clone())?;
            }
        }
        Ok(())
    }
}

fn update_json_property(
    path: &Path,
    property: &str,
    value: serde_json::Value,
) -> Result<(), String> {
    let mut document: serde_json::Value = serde_json::from_slice(
        &fs::read(path).map_err(|error| format!("failed to read '{}': {error}", path.display()))?,
    )
    .map_err(|error| format!("failed to decode '{}': {error}", path.display()))?;
    document[property] = value;
    write_json(path, &document)
}

impl AutosaveTargetWriter for ZarrAutosaveWriter {
    fn begin_stage(&mut self, manifest: &StageManifest) -> Result<(), String> {
        let mut effective_manifest = manifest.clone();
        if effective_manifest.provenance.is_none() {
            effective_manifest.provenance = self.latest_provenance.clone();
        }
        if let Some(provenance) = effective_manifest.provenance.clone() {
            self.latest_provenance = Some(provenance);
        }
        update_artifact_manifest(&self.root, &effective_manifest)?;
        let store = self.store_path(&effective_manifest.target);
        initialize_group(&store)?;
        let mut root_attrs = json!({
            "schema_version": "fullmag.stage_autosave.v1",
            "target": effective_manifest.target,
        });
        if let Some(provenance) = effective_manifest.provenance.clone() {
            root_attrs["provenance"] = provenance;
        }
        write_json(&store.join(".zattrs"), &root_attrs)?;
        initialize_group(&store.join("stages"))?;
        let stage_path = store.join("stages").join(format!(
            "stage_{:04}_{}",
            effective_manifest.stage_index, effective_manifest.stage_id
        ));
        initialize_group(&stage_path)?;
        write_json(&stage_path.join("manifest.json"), &effective_manifest)?;
        if !effective_manifest.table_quantities.is_empty() {
            let table = stage_path.join("table");
            fs::create_dir_all(&table).map_err(|error| error.to_string())?;
            write_json(
                &table.join(".zattrs"),
                &json!({"quantities": effective_manifest.table_quantities, "dimension_order": ["sample", "quantity"], "sample_publication": SAMPLE_PUBLICATION_SCHEMA}),
            )?;
            initialize_publication(&table)?;
            initialize_array(&table, 0, effective_manifest.table_quantities.len())?;
        }
        let fields = stage_path.join("fields");
        if !effective_manifest.field_quantities.is_empty() {
            initialize_group(&fields)?;
        }
        if effective_manifest.layout == AutosaveLayoutIR::Continuous {
            let continuous = store.join("continuous");
            initialize_group(&continuous)?;
            write_json(
                &continuous.join(".zattrs"),
                &json!({"payload_policy": "references_only", "index": "index.jsonl"}),
            )?;
        }
        self.current = Some(ZarrStage {
            manifest: effective_manifest,
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
        validate_sample(entry, values)?;
        let root = self.root.clone();
        let current = self.current_mut()?;
        if values.len() != current.manifest.table_quantities.len() {
            return Err("Zarr table row does not match declared quantity count".into());
        }
        let table = current.path.join("table");
        write_f64_chunk(&table.join(format!("{}.0", current.table_samples)), values)?;
        let count = current.table_samples + 1;
        initialize_array(&table, count, values.len())?;
        append_continuous_index(&root, &current.manifest, entry)?;
        publish_sample(&table, current.table_samples, entry.coordinate)?;
        current.table_samples = count;
        Ok(())
    }

    fn append_field_sample(
        &mut self,
        entry: &ContinuousIndexEntry,
        quantity: &str,
        values: &[f64],
    ) -> Result<(), String> {
        validate_sample(entry, values)?;
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
            fs::create_dir_all(&field).map_err(|error| error.to_string())?;
            let mut attrs = json!({
                "quantity": quantity,
                "dimension_order": ["sample", "value"],
                "sample_publication": SAMPLE_PUBLICATION_SCHEMA,
            });
            if let Some(provenance) = current.manifest.provenance.clone() {
                attrs["provenance"] = provenance;
            }
            write_json(&field.join(".zattrs"), &attrs)?;
            initialize_publication(&field)?;
            initialize_array(&field, 0, values.len())?;
        } else {
            let metadata: serde_json::Value = serde_json::from_slice(
                &fs::read(field.join(".zarray")).map_err(|error| error.to_string())?,
            )
            .map_err(|error| error.to_string())?;
            if metadata["shape"][1].as_u64() != Some(values.len() as u64) {
                return Err("Zarr field width changed within a stage".into());
            }
        }
        write_f64_chunk(&field.join(format!("{sample}.0")), values)?;
        let sample_count = sample + 1;
        initialize_array(&field, sample_count, values.len())?;
        append_continuous_index(&root, &current.manifest, entry)?;
        publish_sample(&field, sample, entry.coordinate)?;
        current
            .field_samples
            .insert(quantity.to_string(), sample_count);
        Ok(())
    }

    fn finish_stage(&mut self, manifest: &StageManifest) -> Result<(), String> {
        let current = self
            .current
            .take()
            .ok_or_else(|| "Zarr autosave has no active stage".to_string())?;
        let mut effective_manifest = manifest.clone();
        if effective_manifest.provenance.is_none() {
            effective_manifest.provenance = current
                .manifest
                .provenance
                .or_else(|| self.latest_provenance.clone());
        }
        write_json(&current.path.join("manifest.json"), &effective_manifest)?;
        update_artifact_manifest(&self.root, &effective_manifest)
    }
}

impl ZarrAutosaveWriter {
    fn current_mut(&mut self) -> Result<&mut ZarrStage, String> {
        self.current
            .as_mut()
            .ok_or_else(|| "Zarr autosave has no active stage".to_string())
    }
}

// This is an array-local commit boundary, not an accepted-run ownership receipt.
const SAMPLE_PUBLICATION_SCHEMA: &str = "fullmag.zarr.sample_publication.v1";
const SAMPLE_PUBLICATION_FILE: &str = ".fullmag-samples.json";
const SAMPLE_COORDINATE_HEADER: &str = "sample,physical_time_s,accepted_step\n";

fn validate_sample(entry: &ContinuousIndexEntry, values: &[f64]) -> Result<(), String> {
    if values.is_empty() || values.iter().any(|value| !value.is_finite()) {
        return Err("Zarr sample must contain finite values".into());
    }
    if matches!(entry.coordinate, StageSampleCoordinate::PhysicalTime { time_s } if !time_s.is_finite())
    {
        return Err("Zarr sample time must be finite".into());
    }
    Ok(())
}

fn initialize_publication(directory: &Path) -> Result<(), String> {
    let mut file =
        fs::File::create(directory.join("samples.csv")).map_err(|error| error.to_string())?;
    file.write_all(SAMPLE_COORDINATE_HEADER.as_bytes())
        .map_err(|error| error.to_string())?;
    file.sync_all().map_err(|error| error.to_string())?;
    write_json(
        &directory.join(SAMPLE_PUBLICATION_FILE),
        &json!({
            "schema_version": SAMPLE_PUBLICATION_SCHEMA,
            "committed_samples": 0,
            "coordinate_bytes": SAMPLE_COORDINATE_HEADER.len(),
        }),
    )
}

fn publish_sample(
    directory: &Path,
    sample: usize,
    coordinate: StageSampleCoordinate,
) -> Result<(), String> {
    let publication: serde_json::Value = serde_json::from_slice(
        &fs::read(directory.join(SAMPLE_PUBLICATION_FILE)).map_err(|error| error.to_string())?,
    )
    .map_err(|error| error.to_string())?;
    if publication["schema_version"].as_str() != Some(SAMPLE_PUBLICATION_SCHEMA)
        || publication["committed_samples"].as_u64() != Some(sample as u64)
    {
        return Err("Zarr publication does not match writer sample position".into());
    }
    let committed_bytes = publication["coordinate_bytes"]
        .as_u64()
        .ok_or("Zarr publication coordinate length is missing")?;
    let row = match coordinate {
        StageSampleCoordinate::PhysicalTime { time_s } => format!("{sample},{time_s},\n"),
        StageSampleCoordinate::AcceptedStep { accepted_step } => {
            format!("{sample},,{accepted_step}\n")
        }
    };
    let mut file = OpenOptions::new()
        .write(true)
        .open(directory.join("samples.csv"))
        .map_err(|error| error.to_string())?;
    if file.metadata().map_err(|error| error.to_string())?.len() < committed_bytes {
        return Err("Zarr committed coordinates were truncated".into());
    }
    // A failed append may have left an uncommitted suffix. Only the producer's
    // committed prefix is retained on retry; committed samples are immutable.
    file.set_len(committed_bytes)
        .map_err(|error| error.to_string())?;
    file.seek(SeekFrom::Start(committed_bytes))
        .map_err(|error| error.to_string())?;
    file.write_all(row.as_bytes())
        .map_err(|error| error.to_string())?;
    file.sync_all().map_err(|error| error.to_string())?;
    write_json(
        &directory.join(SAMPLE_PUBLICATION_FILE),
        &json!({
            "schema_version": SAMPLE_PUBLICATION_SCHEMA,
            "committed_samples": sample + 1,
            "coordinate_bytes": committed_bytes + row.len() as u64,
        }),
    )
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

pub(crate) fn write_json_atomic(path: &Path, value: &impl serde::Serialize) -> Result<(), String> {
    let bytes = serde_json::to_vec_pretty(value).map_err(|error| error.to_string())?;
    // Each concurrent publication must own its temporary file.
    let temporary = path.with_extension(format!(
        "tmp.{}.{}",
        std::process::id(),
        uuid::Uuid::new_v4()
    ));
    let file = fs::File::create(&temporary).map_err(|error| error.to_string())?;
    let mut writer = BufWriter::new(file);
    writer
        .write_all(&bytes)
        .map_err(|error| error.to_string())?;
    writer.flush().map_err(|error| error.to_string())?;
    writer
        .get_ref()
        .sync_all()
        .map_err(|error| error.to_string())?;
    drop(writer);
    replace_file_atomically(&temporary, path)?;
    Ok(())
}

#[cfg(not(windows))]
fn replace_file_atomically(temporary: &Path, destination: &Path) -> Result<(), String> {
    fs::rename(temporary, destination).map_err(|error| error.to_string())
}

#[cfg(windows)]
fn replace_file_atomically(temporary: &Path, destination: &Path) -> Result<(), String> {
    use std::os::windows::ffi::OsStrExt;
    if !destination.exists() {
        return fs::rename(temporary, destination).map_err(|error| error.to_string());
    }
    #[link(name = "kernel32")]
    unsafe extern "system" {
        fn ReplaceFileW(
            replaced: *const u16,
            replacement: *const u16,
            backup: *const u16,
            flags: u32,
            exclude: *mut std::ffi::c_void,
            reserved: *mut std::ffi::c_void,
        ) -> i32;
    }
    let replaced = destination
        .as_os_str()
        .encode_wide()
        .chain(std::iter::once(0))
        .collect::<Vec<_>>();
    let replacement = temporary
        .as_os_str()
        .encode_wide()
        .chain(std::iter::once(0))
        .collect::<Vec<_>>();
    let replaced_ok = unsafe {
        ReplaceFileW(
            replaced.as_ptr(),
            replacement.as_ptr(),
            std::ptr::null(),
            0,
            std::ptr::null_mut(),
            std::ptr::null_mut(),
        )
    };
    if replaced_ok == 0 {
        return Err(std::io::Error::last_os_error().to_string());
    }
    Ok(())
}

fn write_json(path: &Path, value: &impl serde::Serialize) -> Result<(), String> {
    write_json_atomic(path, value)
}

fn write_f64_chunk(path: &Path, values: &[f64]) -> Result<(), String> {
    let mut bytes = Vec::with_capacity(values.len() * 8);
    for value in values {
        bytes.extend_from_slice(&value.to_le_bytes());
    }
    let mut file = fs::File::create(path).map_err(|error| error.to_string())?;
    file.write_all(&bytes).map_err(|error| error.to_string())?;
    file.sync_all().map_err(|error| error.to_string())
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

    #[test]
    fn publication_uses_field_local_coordinates_and_survives_separate_layout() {
        let root = temp_root();
        let mut writer = ZarrAutosaveWriter::new(&root);
        let mut state = AutosaveTargetState::new("main");
        state
            .begin_stage(
                &mut writer,
                "run",
                AutosaveLayoutIR::Separate,
                AutosaveFormatIR::Zarr,
                vec!["mx".into()],
                vec!["m".into(), "H_eff".into()],
            )
            .unwrap();
        state
            .append_table_row(
                &mut writer,
                StageSampleCoordinate::AcceptedStep {
                    accepted_step: 9007199254740993,
                },
                &[0.25],
            )
            .unwrap();
        for time_s in [0.0, 0.25] {
            for quantity in ["m", "H_eff"] {
                state
                    .append_field_sample(
                        &mut writer,
                        StageSampleCoordinate::PhysicalTime { time_s },
                        quantity,
                        &[1.0, 2.0, 3.0],
                    )
                    .unwrap();
            }
        }
        let stage = root.join("main.zarr/stages/stage_0000_run");
        for relative in ["fields/m", "fields/H_eff", "table"] {
            let directory = stage.join(relative);
            let publication: serde_json::Value =
                serde_json::from_slice(&fs::read(directory.join(SAMPLE_PUBLICATION_FILE)).unwrap())
                    .unwrap();
            let csv = fs::read_to_string(directory.join("samples.csv")).unwrap();
            assert_eq!(publication["coordinate_bytes"], csv.len());
            if relative == "table" {
                assert_eq!(publication["committed_samples"], 1);
                assert_eq!(
                    csv,
                    format!("{SAMPLE_COORDINATE_HEADER}0,,9007199254740993\n")
                );
            } else {
                assert_eq!(publication["committed_samples"], 2);
                assert_eq!(csv, format!("{SAMPLE_COORDINATE_HEADER}0,0,\n1,0.25,\n"));
            }
        }
        let before = fs::read(stage.join("fields/m/.zarray")).unwrap();
        assert!(state
            .append_field_sample(
                &mut writer,
                StageSampleCoordinate::PhysicalTime { time_s: 0.5 },
                "m",
                &[1.0]
            )
            .is_err());
        assert_eq!(fs::read(stage.join("fields/m/.zarray")).unwrap(), before);
        assert!(state
            .append_field_sample(
                &mut writer,
                StageSampleCoordinate::PhysicalTime { time_s: f64::NAN },
                "m",
                &[1.0, 2.0, 3.0]
            )
            .is_err());
        fs::remove_dir_all(root).unwrap();
    }

    #[test]
    fn failed_coordinate_append_does_not_publish_sample() {
        let root = temp_root();
        let mut writer = ZarrAutosaveWriter::new(&root);
        let mut state = AutosaveTargetState::new("main");
        state
            .begin_stage(
                &mut writer,
                "run",
                AutosaveLayoutIR::Separate,
                AutosaveFormatIR::Zarr,
                vec!["mx".into()],
                vec![],
            )
            .unwrap();
        let table = root.join("main.zarr/stages/stage_0000_run/table");
        let before = fs::read(table.join(SAMPLE_PUBLICATION_FILE)).unwrap();
        // Preserve the initial committed header, but make the coordinate path unwritable.
        fs::rename(table.join("samples.csv"), table.join("saved.csv")).unwrap();
        fs::create_dir(table.join("samples.csv")).unwrap();
        assert!(state
            .append_table_row(
                &mut writer,
                StageSampleCoordinate::PhysicalTime { time_s: 0.0 },
                &[0.25]
            )
            .is_err());
        assert!(table.join("0.0").exists());
        assert_eq!(
            fs::read(table.join(SAMPLE_PUBLICATION_FILE)).unwrap(),
            before
        );
        fs::remove_dir(table.join("samples.csv")).unwrap();
        fs::rename(table.join("saved.csv"), table.join("samples.csv")).unwrap();
        state
            .append_table_row(
                &mut writer,
                StageSampleCoordinate::PhysicalTime { time_s: 0.0 },
                &[0.25],
            )
            .unwrap();
        let publication: serde_json::Value =
            serde_json::from_slice(&fs::read(table.join(SAMPLE_PUBLICATION_FILE)).unwrap())
                .unwrap();
        assert_eq!(publication["committed_samples"], 1);
        fs::remove_dir_all(root).unwrap();
    }

    #[test]
    fn lazy_field_after_provenance_update_keeps_full_provenance_through_finish() {
        let root = std::env::temp_dir().join(format!(
            "fullmag-zarr-lazy-provenance-{}",
            uuid::Uuid::new_v4()
        ));
        let mut state = AutosaveTargetState::resume(&root, "main").unwrap();
        let mut writer = ZarrAutosaveWriter::new(&root);
        state
            .begin_stage(
                &mut writer,
                "relax",
                AutosaveLayoutIR::Separate,
                AutosaveFormatIR::Zarr,
                vec![],
                vec!["m".into()],
            )
            .unwrap();
        let provenance = json!({
            "execution_engine": "fem_native_gpu",
            "fem_gpu_execution_receipt": {"executed": "cuda_fem"},
            "requested_backend": "fem",
        });
        state.update_active_provenance(provenance.clone()).unwrap();
        writer.update_provenance(&provenance).unwrap();
        state
            .append_field_sample(
                &mut writer,
                StageSampleCoordinate::AcceptedStep { accepted_step: 1 },
                "m",
                &[1.0, 0.0, 0.0],
            )
            .unwrap();
        state.finish_stage(&mut writer).unwrap();

        let store = root.join("main.zarr");
        let stage = store.join("stages/stage_0000_relax");
        let root_attrs: serde_json::Value =
            serde_json::from_slice(&fs::read(store.join(".zattrs")).unwrap()).unwrap();
        let field_attrs: serde_json::Value =
            serde_json::from_slice(&fs::read(stage.join("fields/m/.zattrs")).unwrap()).unwrap();
        let final_manifest: StageManifest =
            serde_json::from_slice(&fs::read(stage.join("manifest.json")).unwrap()).unwrap();
        assert_eq!(root_attrs["provenance"], provenance);
        assert_eq!(field_attrs["provenance"], provenance);
        assert_eq!(final_manifest.provenance, Some(provenance.clone()));

        state
            .begin_stage(
                &mut writer,
                "run",
                AutosaveLayoutIR::Separate,
                AutosaveFormatIR::Zarr,
                vec![],
                vec!["m".into()],
            )
            .unwrap();
        state
            .append_field_sample(
                &mut writer,
                StageSampleCoordinate::AcceptedStep { accepted_step: 1 },
                "m",
                &[0.0, 1.0, 0.0],
            )
            .unwrap();
        state.finish_stage(&mut writer).unwrap();

        let inherited_stage = store.join("stages/stage_0001_run");
        let inherited_field_attrs: serde_json::Value =
            serde_json::from_slice(&fs::read(inherited_stage.join("fields/m/.zattrs")).unwrap())
                .unwrap();
        let inherited_manifest: StageManifest =
            serde_json::from_slice(&fs::read(inherited_stage.join("manifest.json")).unwrap())
                .unwrap();
        assert_eq!(inherited_field_attrs["provenance"], provenance);
        assert_eq!(inherited_manifest.provenance, Some(provenance));
        fs::remove_dir_all(root).unwrap();
    }
}
