use crate::autosave_storage::{
    update_artifact_manifest, AutosaveTargetWriter, ContinuousIndexEntry, StageManifest,
};
use fullmag_ir::AutosaveLayoutIR;
use serde_json::json;
use std::fs::{self, OpenOptions};
use std::io::{BufWriter, Write};
use std::path::{Path, PathBuf};
use std::time::{Duration, Instant};

const ZARR_STAGE_BUFFER_CAPACITY_BYTES: usize = 256 * 1024;
const ZARR_STAGE_FLUSH_INTERVAL: Duration = Duration::from_secs(30);
const ZARR_FIELD_METADATA_BATCH_SAMPLES: usize = 8;

pub struct ZarrAutosaveWriter {
    root: PathBuf,
    current: Option<ZarrStage>,
    latest_provenance: Option<serde_json::Value>,
}

struct ZarrStage {
    manifest: StageManifest,
    path: PathBuf,
    table_samples: usize,
    table_pending_path: PathBuf,
    table_writer: Option<BufWriter<fs::File>>,
    table_last_flush: Option<Instant>,
    table_published: bool,
    append_failure: Option<String>,
    continuous_index_writer: Option<BufWriter<fs::File>>,
    continuous_index_last_flush: Option<Instant>,
    continuous_index_pending_path: PathBuf,
    continuous_index_entries: usize,
    continuous_index_published: bool,
    field_samples: std::collections::BTreeMap<String, usize>,
    field_widths: std::collections::BTreeMap<String, usize>,
    field_metadata_published: std::collections::BTreeMap<String, usize>,
    field_chunks_synced: std::collections::BTreeMap<String, usize>,
    field_metadata_pending_samples: usize,
    field_metadata_last_flush: Option<Instant>,
}

struct StageClaimGuard {
    root: PathBuf,
    stage_dir: PathBuf,
    stage_path: PathBuf,
    committed: bool,
}

impl StageClaimGuard {
    fn commit(&mut self) {
        self.committed = true;
    }
}

impl Drop for StageClaimGuard {
    fn drop(&mut self) {
        if !self.committed && !path_entry_exists(&self.stage_path).unwrap_or(true) {
            remove_empty_staging_dirs(&self.root, &self.stage_dir.join("claim"));
        }
    }
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
        if !current.manifest.table_quantities.is_empty() {
            update_json_property(
                &current.path.join("table").join(".zattrs"),
                "provenance",
                provenance.clone(),
            )?;
        }
        Ok(())
    }

    pub(crate) fn flush_field_metadata_due(&mut self, now: Instant) -> Result<(), String> {
        let Some(current) = self.current.as_mut() else {
            return Ok(());
        };
        if field_metadata_flush_due(current, now) {
            flush_field_metadata_at(current, now)?;
        }
        Ok(())
    }

    pub(crate) fn flush_field_metadata_pending(&mut self) -> Result<(), String> {
        let Some(current) = self.current.as_mut() else {
            return Ok(());
        };
        flush_field_metadata_at(current, Instant::now())
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
        if self.current.is_some() {
            return Err("Zarr autosave already has an active stage".into());
        }
        let mut effective_manifest = manifest.clone();
        if effective_manifest.provenance.is_none() {
            effective_manifest.provenance = self.latest_provenance.clone();
        }
        if let Some(provenance) = effective_manifest.provenance.clone() {
            self.latest_provenance = Some(provenance);
        }
        let store = self.store_path(&effective_manifest.target);
        let stage_path = store.join("stages").join(format!(
            "stage_{:04}_{}",
            effective_manifest.stage_index, effective_manifest.stage_id
        ));
        let mut stage_claim = claim_stage(&self.root, manifest, &stage_path)?;
        update_artifact_manifest(&self.root, &effective_manifest)?;
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
        initialize_group(&stage_path)?;
        write_json(&stage_path.join("manifest.json"), &effective_manifest)?;
        if !effective_manifest.table_quantities.is_empty() {
            let table = stage_path.join("table");
            initialize_array(&table, 0, effective_manifest.table_quantities.len())?;
            let mut table_attrs = json!({
                "quantities": effective_manifest.table_quantities,
                "dimension_order": ["sample", "quantity"],
            });
            if let Some(provenance) = effective_manifest.provenance.clone() {
                table_attrs["provenance"] = provenance;
            }
            write_json(&table.join(".zattrs"), &table_attrs)?;
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
            table_pending_path: table_pending_path(&self.root, manifest),
            table_writer: None,
            table_last_flush: None,
            table_published: false,
            append_failure: None,
            continuous_index_writer: None,
            continuous_index_last_flush: None,
            continuous_index_pending_path: continuous_index_pending_path(&self.root, manifest),
            continuous_index_entries: 0,
            continuous_index_published: false,
            field_samples: std::collections::BTreeMap::new(),
            field_widths: std::collections::BTreeMap::new(),
            field_metadata_published: std::collections::BTreeMap::new(),
            field_chunks_synced: std::collections::BTreeMap::new(),
            field_metadata_pending_samples: 0,
            field_metadata_last_flush: None,
        });
        stage_claim.commit();
        Ok(())
    }

    fn append_table_row(
        &mut self,
        entry: &ContinuousIndexEntry,
        values: &[f64],
    ) -> Result<(), String> {
        let current = self.current_mut()?;
        ensure_append_healthy(current)?;
        if values.len() != current.manifest.table_quantities.len() {
            return Err("Zarr table row does not match declared quantity count".into());
        }
        ensure_table_writer(current)?;
        let next_sample_count = current
            .table_samples
            .checked_add(1)
            .ok_or_else(|| "Zarr table sample count overflow".to_string())?;
        if let Err(error) = write_f64_row(
            current
                .table_writer
                .as_mut()
                .expect("table writer initialized before row write"),
            values,
        ) {
            return Err(record_append_failure(current, error));
        }
        if let Err(error) = append_continuous_index(current, entry) {
            return Err(record_append_failure(current, error));
        }
        current.table_samples = next_sample_count;
        if let Err(error) = flush_table_if_due(current, Instant::now()) {
            return Err(record_append_failure(current, error));
        }
        Ok(())
    }

    fn append_field_sample(
        &mut self,
        entry: &ContinuousIndexEntry,
        quantity: &str,
        values: &[f64],
    ) -> Result<(), String> {
        let current = self.current_mut()?;
        ensure_append_healthy(current)?;
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
        if let Some(width) = current.field_widths.get(quantity) {
            if *width != values.len() {
                return Err(format!(
                    "Zarr field '{quantity}' has width {}, received {} values",
                    width,
                    values.len()
                ));
            }
        }
        if sample == 0 {
            if let Err(error) = initialize_array(&field, 0, values.len()) {
                return Err(record_append_failure(current, error));
            }
            let mut attrs = json!({
                "quantity": quantity,
                "dimension_order": ["sample", "value"],
            });
            if let Some(provenance) = current.manifest.provenance.clone() {
                attrs["provenance"] = provenance;
            }
            if let Err(error) = write_json(&field.join(".zattrs"), &attrs) {
                return Err(record_append_failure(current, error));
            }
        }
        if let Err(error) = write_f64_chunk(&field.join(format!("{sample}.0")), values) {
            return Err(record_append_failure(current, error));
        }
        let sample_count = match sample.checked_add(1) {
            Some(sample_count) => sample_count,
            None => {
                return Err(record_append_failure(
                    current,
                    "Zarr field sample count overflow".into(),
                ));
            }
        };
        current
            .field_widths
            .entry(quantity.to_string())
            .or_insert(values.len());
        current
            .field_samples
            .insert(quantity.to_string(), sample_count);
        let next_pending_samples = match current.field_metadata_pending_samples.checked_add(1) {
            Some(pending_samples) => pending_samples,
            None => {
                return Err(record_append_failure(
                    current,
                    "Zarr field metadata pending sample count overflow".into(),
                ));
            }
        };
        current.field_metadata_pending_samples = next_pending_samples;
        if let Err(error) = append_continuous_index(current, entry) {
            return Err(record_append_failure(current, error));
        }
        let now = Instant::now();
        if field_metadata_flush_due(current, now) {
            flush_field_metadata_at(current, now)?;
        }
        if let Err(error) = flush_table_if_due(current, Instant::now()) {
            return Err(record_append_failure(current, error));
        }
        Ok(())
    }

    fn finish_stage(&mut self, manifest: &StageManifest) -> Result<(), String> {
        let root = self.root.clone();
        let latest_provenance = self.latest_provenance.clone();
        let current = self
            .current
            .as_mut()
            .ok_or_else(|| "Zarr autosave has no active stage".to_string())?;
        ensure_append_healthy(current)?;
        let mut effective_manifest = manifest.clone();
        if effective_manifest.provenance.is_none() {
            effective_manifest.provenance =
                current.manifest.provenance.clone().or(latest_provenance);
        }
        flush_field_metadata_at(current, Instant::now())?;
        publish_table(&root, current, &effective_manifest)?;
        publish_continuous_index(&root, current, &effective_manifest)?;
        remove_empty_staging_dirs(&root, &current.table_pending_path);
        write_json(&current.path.join("manifest.json"), &effective_manifest)?;
        update_artifact_manifest(&root, &effective_manifest)?;
        self.current = None;
        Ok(())
    }
}

impl ZarrAutosaveWriter {
    fn current_mut(&mut self) -> Result<&mut ZarrStage, String> {
        self.current
            .as_mut()
            .ok_or_else(|| "Zarr autosave has no active stage".to_string())
    }

    pub fn flush_due(&mut self, now: Instant) -> Result<(), String> {
        let Some(current) = self.current.as_mut() else {
            return Ok(());
        };
        ensure_append_healthy(current)?;
        if let Err(error) = flush_table_if_due(current, now) {
            return Err(record_append_failure(current, error));
        }
        if let Err(error) = flush_continuous_index_if_due(current, now) {
            return Err(record_append_failure(current, error));
        }
        Ok(())
    }
}

fn initialize_group(path: &Path) -> Result<(), String> {
    fs::create_dir_all(path).map_err(|error| error.to_string())?;
    write_json(&path.join(".zgroup"), &json!({"zarr_format": 2}))
}

fn initialize_array(path: &Path, sample_count: usize, width: usize) -> Result<(), String> {
    initialize_array_with_chunk_rows(path, sample_count, width, 1)
}

fn initialize_array_with_chunk_rows(
    path: &Path,
    sample_count: usize,
    width: usize,
    chunk_rows: usize,
) -> Result<(), String> {
    fs::create_dir_all(path).map_err(|error| error.to_string())?;
    write_json(
        &path.join(".zarray"),
        &json!({
            "zarr_format": 2,
            "shape": [sample_count, width],
            "chunks": [chunk_rows.max(1), width.max(1)],
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
    write_bytes_atomic(path, &bytes)
}

/// Atomically replace metadata while preserving exact bytes for rollback.
pub(crate) fn write_bytes_atomic(path: &Path, bytes: &[u8]) -> Result<(), String> {
    // Each concurrent publication must own its temporary file.
    let temporary = path.with_extension(format!(
        "tmp.{}.{}",
        std::process::id(),
        uuid::Uuid::new_v4()
    ));
    let file = fs::File::create(&temporary).map_err(|error| error.to_string())?;
    let mut writer = BufWriter::new(file);
    writer.write_all(bytes).map_err(|error| error.to_string())?;
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
    let file = OpenOptions::new()
        .write(true)
        .create_new(true)
        .open(path)
        .map_err(|error| {
            format!(
                "failed to create Zarr field chunk '{}': {error}",
                path.display()
            )
        })?;
    let mut writer = BufWriter::with_capacity(ZARR_STAGE_BUFFER_CAPACITY_BYTES, file);
    for value in values {
        writer.write_all(&value.to_le_bytes()).map_err(|error| {
            format!(
                "failed to write Zarr field chunk '{}': {error}",
                path.display()
            )
        })?;
    }
    writer.flush().map_err(|error| {
        format!(
            "failed to flush Zarr field chunk '{}': {error}",
            path.display()
        )
    })
}

fn field_metadata_flush_due(current: &ZarrStage, now: Instant) -> bool {
    current.field_metadata_pending_samples > 0
        && (current.field_metadata_last_flush.is_none()
            || current.field_metadata_pending_samples >= ZARR_FIELD_METADATA_BATCH_SAMPLES
            || current.field_metadata_last_flush.is_some_and(|last_flush| {
                now.saturating_duration_since(last_flush) >= ZARR_STAGE_FLUSH_INTERVAL
            }))
}

fn flush_field_metadata_at(current: &mut ZarrStage, now: Instant) -> Result<(), String> {
    ensure_append_healthy(current)?;
    let has_unpublished_samples = current.manifest.field_quantities.iter().any(|quantity| {
        current.field_samples.get(quantity).copied().unwrap_or(0)
            > current
                .field_metadata_published
                .get(quantity)
                .copied()
                .unwrap_or(0)
    });
    if !has_unpublished_samples {
        current.field_metadata_pending_samples = 0;
        return Ok(());
    }

    let result = (|| {
        // Sync only chunk files created since the previous metadata publication.
        // The directory sync makes their names durable before the new shape is visible.
        for quantity in &current.manifest.field_quantities {
            let synced_count = current
                .field_chunks_synced
                .get(quantity)
                .copied()
                .unwrap_or(0);
            let sample_count = current.field_samples.get(quantity).copied().unwrap_or(0);
            if sample_count <= synced_count {
                continue;
            }
            let field = current.path.join("fields").join(quantity);
            for sample in synced_count..sample_count {
                let chunk = field.join(format!("{sample}.0"));
                OpenOptions::new()
                    .write(true)
                    .open(&chunk)
                    .and_then(|file| file.sync_all())
                    .map_err(|error| {
                        format!(
                            "failed to sync Zarr field chunk '{}': {error}",
                            chunk.display()
                        )
                    })?;
            }
            current
                .field_chunks_synced
                .insert(quantity.clone(), sample_count);
            sync_directory(&field)?;
        }

        // Publish shapes only after every newly referenced payload is durable.
        for quantity in &current.manifest.field_quantities {
            let sample_count = current.field_samples.get(quantity).copied().unwrap_or(0);
            let published_count = current
                .field_metadata_published
                .get(quantity)
                .copied()
                .unwrap_or(0);
            if sample_count <= published_count {
                continue;
            }
            let width =
                current.field_widths.get(quantity).copied().ok_or_else(|| {
                    format!("Zarr field '{quantity}' is missing its declared width")
                })?;
            let field = current.path.join("fields").join(quantity);
            initialize_array(&field, sample_count, width)?;
            current
                .field_metadata_published
                .insert(quantity.clone(), sample_count);
        }
        Ok(())
    })();

    if let Err(error) = result {
        return Err(record_append_failure(current, error));
    }
    current.field_metadata_pending_samples = 0;
    current.field_metadata_last_flush = Some(now);
    Ok(())
}

fn table_pending_path(root: &Path, manifest: &StageManifest) -> PathBuf {
    stage_staging_dir(root, manifest).join("table.bin")
}

fn continuous_index_pending_path(root: &Path, manifest: &StageManifest) -> PathBuf {
    stage_staging_dir(root, manifest).join("continuous-index.jsonl")
}

fn stage_staging_dir(root: &Path, manifest: &StageManifest) -> PathBuf {
    root.join(".autosave-staging")
        .join(&manifest.target)
        .join(format!(
            "stage_{:04}_{}",
            manifest.stage_index, manifest.stage_id
        ))
}

fn path_entry_exists(path: &Path) -> Result<bool, String> {
    match fs::symlink_metadata(path) {
        Ok(_) => Ok(true),
        Err(error) if error.kind() == std::io::ErrorKind::NotFound => Ok(false),
        Err(error) => Err(format!("failed to inspect '{}': {error}", path.display())),
    }
}

fn claim_stage(
    root: &Path,
    manifest: &StageManifest,
    stage_path: &Path,
) -> Result<StageClaimGuard, String> {
    let stage_dir = stage_staging_dir(root, manifest);
    if path_entry_exists(stage_path)? || path_entry_exists(&stage_dir)? {
        return Err(format!(
            "Zarr autosave stage '{}' already has published or pending data; refusing to overwrite it",
            stage_path.display()
        ));
    }
    let parent = stage_dir
        .parent()
        .ok_or_else(|| "Zarr stage claim path has no parent".to_string())?;
    fs::create_dir_all(parent).map_err(|error| error.to_string())?;
    fs::create_dir(&stage_dir).map_err(|error| {
        format!(
            "failed to claim Zarr autosave stage '{}': {error}",
            stage_path.display()
        )
    })?;
    Ok(StageClaimGuard {
        root: root.to_path_buf(),
        stage_dir,
        stage_path: stage_path.to_path_buf(),
        committed: false,
    })
}

fn ensure_append_healthy(current: &ZarrStage) -> Result<(), String> {
    if let Some(error) = &current.append_failure {
        return Err(format!(
            "Zarr autosave stage is poisoned after an append failure and cannot append or publish: {error}"
        ));
    }
    Ok(())
}

fn record_append_failure(current: &mut ZarrStage, error: String) -> String {
    let error = current.append_failure.get_or_insert(error);
    format!("Zarr autosave stage was poisoned after an append failure: {error}")
}

fn ensure_table_writer(current: &mut ZarrStage) -> Result<(), String> {
    if current.table_writer.is_some() {
        return Ok(());
    }
    let parent = current
        .table_pending_path
        .parent()
        .ok_or_else(|| "Zarr table staging path has no parent".to_string())?;
    fs::create_dir_all(parent).map_err(|error| error.to_string())?;
    let file = OpenOptions::new()
        .write(true)
        .create_new(true)
        .open(&current.table_pending_path)
        .map_err(|error| {
            format!(
                "failed to create Zarr table staging file '{}': {error}",
                current.table_pending_path.display()
            )
        })?;
    current.table_writer = Some(BufWriter::with_capacity(
        ZARR_STAGE_BUFFER_CAPACITY_BYTES,
        file,
    ));
    current.table_last_flush = Some(Instant::now());
    Ok(())
}

fn write_f64_row(writer: &mut impl Write, values: &[f64]) -> Result<(), String> {
    for value in values {
        writer
            .write_all(&value.to_le_bytes())
            .map_err(|error| error.to_string())?;
    }
    Ok(())
}

fn flush_table_if_due(current: &mut ZarrStage, now: Instant) -> Result<(), String> {
    let Some(writer) = current.table_writer.as_mut() else {
        return Ok(());
    };
    if writer.buffer().is_empty()
        || current.table_last_flush.is_some_and(|last_flush| {
            now.saturating_duration_since(last_flush) < ZARR_STAGE_FLUSH_INTERVAL
        })
    {
        return Ok(());
    }
    writer.flush().map_err(|error| {
        format!(
            "failed to flush Zarr table staging file '{}': {error}",
            current.table_pending_path.display()
        )
    })?;
    current.table_last_flush = Some(now);
    Ok(())
}

fn publish_table(
    root: &Path,
    current: &mut ZarrStage,
    manifest: &StageManifest,
) -> Result<(), String> {
    let width = manifest.table_quantities.len();
    let sample_count = current.table_samples;
    if current.table_samples as u64 != manifest.table_sample_count {
        return Err(format!(
            "Zarr table has {} staged rows, but the stage manifest declares {}",
            current.table_samples, manifest.table_sample_count
        ));
    }
    if width == 0 {
        if sample_count != 0 || current.table_writer.is_some() {
            return Err("Zarr table samples exist without declared quantities".into());
        }
        return Ok(());
    }

    let table = current.path.join("table");
    if sample_count == 0 {
        if let Some(mut writer) = current.table_writer.take() {
            writer.flush().map_err(|error| error.to_string())?;
            writer
                .get_ref()
                .sync_all()
                .map_err(|error| error.to_string())?;
        }
        if current.table_pending_path.exists() {
            let size = fs::metadata(&current.table_pending_path)
                .map_err(|error| error.to_string())?
                .len();
            if size != 0 {
                return Err("empty Zarr table stage has nonempty staged bytes".into());
            }
            fs::remove_file(&current.table_pending_path).map_err(|error| error.to_string())?;
            remove_empty_staging_dirs(root, &current.table_pending_path);
        }
        return initialize_array_with_chunk_rows(&table, 0, width, 1);
    }

    let expected_bytes = sample_count
        .checked_mul(width)
        .and_then(|values| values.checked_mul(std::mem::size_of::<f64>()))
        .and_then(|bytes| u64::try_from(bytes).ok())
        .ok_or_else(|| "Zarr table payload size overflow".to_string())?;
    if let Some(mut writer) = current.table_writer.take() {
        writer.flush().map_err(|error| {
            format!(
                "failed to flush Zarr table staging file '{}': {error}",
                current.table_pending_path.display()
            )
        })?;
        writer.get_ref().sync_all().map_err(|error| {
            format!(
                "failed to sync Zarr table staging file '{}': {error}",
                current.table_pending_path.display()
            )
        })?;
    }

    let chunk = table.join("0.0");
    if current.table_published {
        let size = fs::metadata(&chunk)
            .map_err(|error| format!("published Zarr table chunk is unavailable: {error}"))?
            .len();
        if size != expected_bytes {
            return Err("published Zarr table chunk has an unexpected byte length".into());
        }
    } else {
        if chunk.exists() {
            return Err("Zarr table chunk already exists before stage publication".into());
        }
        let size = fs::metadata(&current.table_pending_path)
            .map_err(|error| format!("Zarr table staging file is unavailable: {error}"))?
            .len();
        if size != expected_bytes {
            return Err(format!(
                "Zarr table staging file has {size} bytes, expected {expected_bytes}"
            ));
        }
        fs::rename(&current.table_pending_path, &chunk).map_err(|error| {
            format!(
                "failed to publish Zarr table chunk '{}': {error}",
                chunk.display()
            )
        })?;
        current.table_published = true;
        sync_directory(&table)?;
        remove_empty_staging_dirs(root, &current.table_pending_path);
    }
    initialize_array_with_chunk_rows(&table, sample_count, width, sample_count)?;
    sync_directory(&table)
}

fn remove_empty_staging_dirs(root: &Path, staging_file: &Path) {
    let mut directory = staging_file.parent();
    while let Some(path) = directory {
        if path == root || !path.starts_with(root) || fs::remove_dir(path).is_err() {
            break;
        }
        directory = path.parent();
    }
}

#[cfg(unix)]
fn sync_directory(path: &Path) -> Result<(), String> {
    fs::File::open(path)
        .and_then(|directory| directory.sync_all())
        .map_err(|error| format!("failed to sync directory '{}': {error}", path.display()))
}

#[cfg(not(unix))]
fn sync_directory(_: &Path) -> Result<(), String> {
    Ok(())
}

fn append_continuous_index(
    current: &mut ZarrStage,
    entry: &ContinuousIndexEntry,
) -> Result<(), String> {
    if current.manifest.layout != AutosaveLayoutIR::Continuous {
        return Ok(());
    }
    if current.continuous_index_writer.is_none() {
        fs::create_dir_all(
            current
                .continuous_index_pending_path
                .parent()
                .ok_or_else(|| "continuous index staging path has no parent".to_string())?,
        )
        .map_err(|error| error.to_string())?;
        let file = OpenOptions::new()
            .write(true)
            .create(true)
            .append(true)
            .open(&current.continuous_index_pending_path)
            .map_err(|error| error.to_string())?;
        current.continuous_index_writer = Some(BufWriter::with_capacity(
            ZARR_STAGE_BUFFER_CAPACITY_BYTES,
            file,
        ));
        current.continuous_index_last_flush = Some(Instant::now());
    }
    let writer = current
        .continuous_index_writer
        .as_mut()
        .expect("continuous index writer initialized before append");
    serde_json::to_writer(&mut *writer, entry).map_err(|error| error.to_string())?;
    writer.write_all(b"\n").map_err(|error| error.to_string())?;
    current.continuous_index_entries = current
        .continuous_index_entries
        .checked_add(1)
        .ok_or_else(|| "continuous index entry count overflow".to_string())?;
    flush_continuous_index_if_due(current, Instant::now())
}

fn flush_continuous_index_if_due(current: &mut ZarrStage, now: Instant) -> Result<(), String> {
    let Some(writer) = current.continuous_index_writer.as_mut() else {
        return Ok(());
    };
    if writer.buffer().is_empty()
        || current
            .continuous_index_last_flush
            .is_some_and(|last_flush| {
                now.saturating_duration_since(last_flush) < ZARR_STAGE_FLUSH_INTERVAL
            })
    {
        return Ok(());
    }
    writer
        .flush()
        .map_err(|error| format!("failed to flush staged continuous index: {error}"))?;
    current.continuous_index_last_flush = Some(now);
    Ok(())
}

fn publish_continuous_index(
    root: &Path,
    current: &mut ZarrStage,
    manifest: &StageManifest,
) -> Result<(), String> {
    if current.manifest.layout != AutosaveLayoutIR::Continuous {
        return Ok(());
    }
    if current.continuous_index_published {
        if current.continuous_index_pending_path.exists() {
            fs::remove_file(&current.continuous_index_pending_path)
                .map_err(|error| error.to_string())?;
            remove_empty_staging_dirs(root, &current.continuous_index_pending_path);
        }
        return Ok(());
    }
    let expected_entries = manifest
        .table_sample_count
        .checked_add(manifest.field_sample_count)
        .ok_or_else(|| "continuous index sample count overflow".to_string())?;
    if current.continuous_index_entries as u64 != expected_entries {
        return Err(format!(
            "continuous index has {} staged entries, but the stage manifest declares {expected_entries} samples",
            current.continuous_index_entries
        ));
    }
    let index_path = root
        .join(format!("{}.zarr", current.manifest.target))
        .join("continuous/index.jsonl");
    if expected_entries == 0 {
        let index_file = OpenOptions::new()
            .create(true)
            .append(true)
            .open(&index_path)
            .map_err(|error| error.to_string())?;
        index_file
            .sync_all()
            .map_err(|error| format!("failed to sync empty continuous index: {error}"))?;
        sync_directory(
            index_path
                .parent()
                .ok_or_else(|| "continuous index path has no parent".to_string())?,
        )?;
        return Ok(());
    }

    if let Some(mut writer) = current.continuous_index_writer.take() {
        writer
            .flush()
            .map_err(|error| format!("failed to flush staged continuous index: {error}"))?;
        writer
            .get_ref()
            .sync_all()
            .map_err(|error| format!("failed to sync staged continuous index: {error}"))?;
    }
    let pending = OpenOptions::new()
        .read(true)
        .write(true)
        .open(&current.continuous_index_pending_path)
        .map_err(|error| format!("staged continuous index is unavailable: {error}"))?;
    pending
        .sync_all()
        .map_err(|error| format!("failed to sync staged continuous index: {error}"))?;
    let pending_size = pending.metadata().map_err(|error| error.to_string())?.len();
    drop(pending);

    let previous_size = match fs::metadata(&index_path) {
        Ok(metadata) => metadata.len(),
        Err(error) if error.kind() == std::io::ErrorKind::NotFound => 0,
        Err(error) => return Err(error.to_string()),
    };
    let index_file = OpenOptions::new()
        .create(true)
        .append(true)
        .open(&index_path)
        .map_err(|error| error.to_string())?;
    let mut output = BufWriter::with_capacity(ZARR_STAGE_BUFFER_CAPACITY_BYTES, index_file);
    let append_result = (|| {
        let mut input = fs::File::open(&current.continuous_index_pending_path)
            .map_err(|error| error.to_string())?;
        let copied = std::io::copy(&mut input, &mut output).map_err(|error| error.to_string())?;
        if copied != pending_size {
            return Err(format!(
                "copied {copied} bytes from staged continuous index, expected {pending_size}"
            ));
        }
        output
            .flush()
            .map_err(|error| format!("failed to flush published continuous index: {error}"))?;
        output
            .get_ref()
            .sync_all()
            .map_err(|error| format!("failed to sync published continuous index: {error}"))?;
        sync_directory(
            index_path
                .parent()
                .ok_or_else(|| "continuous index path has no parent".to_string())?,
        )?;
        Ok(())
    })();
    drop(output);
    if let Err(error) = append_result {
        if let Err(rollback_error) = rollback_continuous_index(&index_path, previous_size) {
            return Err(format!(
                "failed to publish continuous index: {error}; failed to restore its previous length: {rollback_error}"
            ));
        }
        return Err(format!("failed to publish continuous index: {error}"));
    }

    current.continuous_index_published = true;
    fs::remove_file(&current.continuous_index_pending_path).map_err(|error| error.to_string())?;
    remove_empty_staging_dirs(root, &current.continuous_index_pending_path);
    Ok(())
}

fn rollback_continuous_index(path: &Path, previous_size: u64) -> Result<(), String> {
    let file = OpenOptions::new()
        .write(true)
        .open(path)
        .map_err(|error| error.to_string())?;
    file.set_len(previous_size)
        .map_err(|error| error.to_string())?;
    file.sync_all().map_err(|error| error.to_string())
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
    fn metadata_atomic_replace_preserves_exact_bytes() {
        let root = temp_root();
        fs::create_dir_all(&root).unwrap();
        let path = root.join(".zattrs");
        let original = b"{ \"retained\": true }\n";
        // Exercise replacing an existing destination, including Windows' adapter.
        write_bytes_atomic(&path, original).unwrap();
        write_json_atomic(&path, &json!({"completion": null})).unwrap();
        write_bytes_atomic(&path, original).unwrap();
        assert_eq!(fs::read(&path).unwrap(), original);
        fs::remove_dir_all(root).unwrap();
    }

    #[test]
    fn interleaved_field_references_resolve_real_quantity_local_chunks() {
        let root = temp_root();
        let mut writer = ZarrAutosaveWriter::new(&root);
        let mut state = AutosaveTargetState::new("main");
        state
            .begin_stage(
                &mut writer,
                "relax",
                AutosaveLayoutIR::Continuous,
                AutosaveFormatIR::Zarr,
                vec![],
                vec!["m".into(), "H_eff".into()],
            )
            .unwrap();
        let samples = [
            (0, "m", 10.0),
            (0, "H_eff", 20.0),
            (1, "m", 11.0),
            (2, "m", 12.0),
            (2, "H_eff", 22.0),
        ];
        for (step, quantity, value) in samples {
            state
                .append_field_sample(
                    &mut writer,
                    StageSampleCoordinate::AcceptedStep {
                        accepted_step: step,
                    },
                    quantity,
                    &[value],
                )
                .unwrap();
        }
        assert_eq!(
            state.finish_stage(&mut writer).unwrap().field_sample_count,
            5
        );
        let store = root.join("main.zarr");
        let index = read_logical_index(&store).unwrap();
        for (entry, (_, _, value)) in index.iter().zip(samples) {
            let bytes = fs::read(store.join(format!("{}.0", entry.payload_ref))).unwrap();
            assert_eq!(bytes, value.to_le_bytes());
        }
        assert_eq!(
            index
                .iter()
                .map(|e| e.stage_sample_index)
                .collect::<Vec<_>>(),
            [0, 1, 2, 3, 4]
        );
        assert_eq!(
            index
                .iter()
                .map(|e| e.target_sample_index)
                .collect::<Vec<_>>(),
            [0, 1, 2, 3, 4]
        );
        fs::remove_dir_all(root).unwrap();
    }

    #[test]
    fn stage_field_metadata_batches_shapes_after_payload_chunks() {
        let root = temp_root();
        let mut writer = ZarrAutosaveWriter::new(&root);
        let mut state = AutosaveTargetState::new("main");
        state
            .begin_stage(
                &mut writer,
                "run",
                AutosaveLayoutIR::Continuous,
                AutosaveFormatIR::Zarr,
                vec![],
                vec!["m".into()],
            )
            .unwrap();

        state
            .append_field_sample(
                &mut writer,
                StageSampleCoordinate::AcceptedStep { accepted_step: 0 },
                "m",
                &[0.0, 1.0, 2.0],
            )
            .unwrap();
        let stage = root.join("main.zarr/stages/stage_0000_run");
        let metadata_path = stage.join("fields/m/.zarray");
        let first_metadata: serde_json::Value =
            serde_json::from_slice(&fs::read(&metadata_path).unwrap()).unwrap();
        assert_eq!(first_metadata["shape"], json!([1, 3]));

        for accepted_step in 1..=7 {
            state
                .append_field_sample(
                    &mut writer,
                    StageSampleCoordinate::AcceptedStep { accepted_step },
                    "m",
                    &[accepted_step as f64, 1.0, 2.0],
                )
                .unwrap();
        }
        let pending_metadata: serde_json::Value =
            serde_json::from_slice(&fs::read(&metadata_path).unwrap()).unwrap();
        assert_eq!(pending_metadata["shape"], json!([1, 3]));
        assert!(stage.join("fields/m/7.0").is_file());

        state
            .append_field_sample(
                &mut writer,
                StageSampleCoordinate::AcceptedStep { accepted_step: 8 },
                "m",
                &[8.0, 1.0, 2.0],
            )
            .unwrap();
        let batched_metadata: serde_json::Value =
            serde_json::from_slice(&fs::read(&metadata_path).unwrap()).unwrap();
        assert_eq!(batched_metadata["shape"], json!([9, 3]));

        // A rejected width change must not create a chunk or poison the stage.
        assert!(state
            .append_field_sample(
                &mut writer,
                StageSampleCoordinate::AcceptedStep { accepted_step: 9 },
                "m",
                &[9.0, 1.0],
            )
            .is_err());
        assert!(!stage.join("fields/m/9.0").exists());
        assert_eq!(
            state.finish_stage(&mut writer).unwrap().field_sample_count,
            9
        );

        let store = root.join("main.zarr");
        let index = read_logical_index(&store).unwrap();
        assert_eq!(index.len(), 9);
        assert_eq!(index.last().unwrap().stage_sample_index, 8);
        fs::remove_dir_all(root).unwrap();
    }

    #[test]
    fn stage_field_metadata_deadline_flushes_sparse_samples() {
        let root = temp_root();
        let mut writer = ZarrAutosaveWriter::new(&root);
        let mut state = AutosaveTargetState::new("main");
        state
            .begin_stage(
                &mut writer,
                "run",
                AutosaveLayoutIR::Continuous,
                AutosaveFormatIR::Zarr,
                vec![],
                vec!["m".into()],
            )
            .unwrap();
        for accepted_step in 0..2 {
            state
                .append_field_sample(
                    &mut writer,
                    StageSampleCoordinate::AcceptedStep { accepted_step },
                    "m",
                    &[accepted_step as f64, 0.0, 0.0],
                )
                .unwrap();
        }
        let stage = root.join("main.zarr/stages/stage_0000_run");
        let metadata_path = stage.join("fields/m/.zarray");
        let before: serde_json::Value =
            serde_json::from_slice(&fs::read(&metadata_path).unwrap()).unwrap();
        assert_eq!(before["shape"], json!([1, 3]));
        let due = writer
            .current
            .as_ref()
            .unwrap()
            .field_metadata_last_flush
            .unwrap()
            + ZARR_STAGE_FLUSH_INTERVAL;
        writer.flush_field_metadata_due(due).unwrap();
        let after: serde_json::Value =
            serde_json::from_slice(&fs::read(&metadata_path).unwrap()).unwrap();
        assert_eq!(after["shape"], json!([2, 3]));
        state.finish_stage(&mut writer).unwrap();
        fs::remove_dir_all(root).unwrap();
    }

    #[test]
    fn zero_sample_continuous_stage_finishes_without_field_metadata() {
        let root = temp_root();
        let mut writer = ZarrAutosaveWriter::new(&root);
        let mut state = AutosaveTargetState::new("main");
        state
            .begin_stage(
                &mut writer,
                "run",
                AutosaveLayoutIR::Continuous,
                AutosaveFormatIR::Zarr,
                vec![],
                vec!["m".into()],
            )
            .unwrap();
        state.finish_stage(&mut writer).unwrap();
        let store = root.join("main.zarr");
        assert!(store.join("continuous/index.jsonl").is_file());
        assert!(read_logical_index(&store).unwrap().is_empty());
        assert!(!store
            .join("stages/stage_0000_run/fields/m/.zarray")
            .exists());
        fs::remove_dir_all(root).unwrap();
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
        assert!(!root.join("main.zarr/continuous/index.jsonl").exists());
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
        assert_eq!(index[0].payload_ref, "stages/stage_0000_relax/table/0");
        assert_eq!(index[1].payload_ref, "stages/stage_0000_relax/fields/m/0");
        assert_eq!(
            fs::read(stage.join("table/0.0")).unwrap(),
            0.25_f64.to_le_bytes()
        );
        let field_chunk = fs::read(stage.join("fields/m/0.0")).unwrap();
        assert_eq!(field_chunk.len(), 3 * std::mem::size_of::<f64>());
        assert_eq!(
            field_chunk
                .chunks_exact(8)
                .map(|bytes| f64::from_le_bytes(bytes.try_into().unwrap()))
                .collect::<Vec<_>>(),
            [1.0, 0.0, 0.0]
        );
        fs::remove_dir_all(root).unwrap();
    }

    #[test]
    fn zarr_table_20k_by_5_is_buffered_then_published_as_one_chunk_with_provenance() {
        const ROWS: usize = 20_000;
        const WIDTH: usize = 5;
        let root = temp_root();
        let mut writer = ZarrAutosaveWriter::new(&root);
        let mut state = AutosaveTargetState::new("main");
        state
            .begin_stage(
                &mut writer,
                "run",
                AutosaveLayoutIR::Continuous,
                AutosaveFormatIR::Zarr,
                vec![
                    "step".into(),
                    "mx".into(),
                    "my".into(),
                    "mz".into(),
                    "e_total".into(),
                ],
                vec![],
            )
            .unwrap();

        let provenance = json!({
            "execution_engine": "fdm_gpu",
            "requested_device": "gpu",
            "resolved_device": "gpu",
            "table_writer": "buffered_zarr_v2_single_chunk",
        });
        state.update_active_provenance(provenance.clone()).unwrap();
        writer.update_provenance(&provenance).unwrap();

        let stage = root.join("main.zarr/stages/stage_0000_run");
        let table = stage.join("table");
        let pending = root.join(".autosave-staging/main/stage_0000_run/table.bin");
        let error = state
            .append_table_row(
                &mut writer,
                StageSampleCoordinate::AcceptedStep { accepted_step: 0 },
                &[1.0],
            )
            .expect_err("a short table row must fail before creating staging data");
        assert!(error.contains("does not match declared quantity count"));
        assert!(!pending.exists());

        for sample in 0..ROWS {
            let step = sample as u64;
            let index = sample as f64;
            let values = [
                index,
                index + 0.125,
                -index,
                (sample % 97) as f64,
                index * 1e-3,
            ];
            state
                .append_table_row(
                    &mut writer,
                    StageSampleCoordinate::AcceptedStep {
                        accepted_step: step,
                    },
                    &values,
                )
                .unwrap();
        }

        let staged_size = fs::metadata(&pending).unwrap().len();
        assert!(
            staged_size >= (2 * ZARR_STAGE_BUFFER_CAPACITY_BYTES) as u64,
            "long-lived stage should flush bounded batches before completion"
        );
        assert!(!table.join("0.0").exists());
        assert!(!root.join("main.zarr/continuous/index.jsonl").exists());
        let active_array: serde_json::Value =
            serde_json::from_slice(&fs::read(table.join(".zarray")).unwrap()).unwrap();
        assert_eq!(active_array["shape"], json!([0, WIDTH]));
        assert_eq!(active_array["chunks"], json!([1, WIDTH]));

        let completed = state.finish_stage(&mut writer).unwrap();
        assert_eq!(completed.table_sample_count, ROWS as u64);
        assert!(completed.complete);

        let array: serde_json::Value =
            serde_json::from_slice(&fs::read(table.join(".zarray")).unwrap()).unwrap();
        assert_eq!(array["shape"], json!([ROWS, WIDTH]));
        assert_eq!(array["chunks"], json!([ROWS, WIDTH]));
        let chunk = fs::read(table.join("0.0")).unwrap();
        assert_eq!(chunk.len(), ROWS * WIDTH * std::mem::size_of::<f64>());
        for (sample, row) in chunk
            .chunks_exact(WIDTH * std::mem::size_of::<f64>())
            .enumerate()
        {
            let index = sample as f64;
            let expected = [
                index,
                index + 0.125,
                -index,
                (sample % 97) as f64,
                index * 1e-3,
            ];
            for (column, bytes) in row.chunks_exact(8).enumerate() {
                assert_eq!(
                    f64::from_le_bytes(bytes.try_into().unwrap()),
                    expected[column],
                    "sample {sample}, column {column}"
                );
            }
        }
        let table_files = fs::read_dir(&table)
            .unwrap()
            .map(|entry| entry.unwrap().file_name().to_string_lossy().into_owned())
            .collect::<std::collections::BTreeSet<_>>();
        let expected_table_files = [".zarray", ".zattrs", "0.0"]
            .into_iter()
            .map(str::to_string)
            .collect::<std::collections::BTreeSet<_>>();
        assert_eq!(table_files, expected_table_files);
        assert!(!root.join(".autosave-staging").exists());

        let table_attrs: serde_json::Value =
            serde_json::from_slice(&fs::read(table.join(".zattrs")).unwrap()).unwrap();
        let root_attrs: serde_json::Value =
            serde_json::from_slice(&fs::read(root.join("main.zarr/.zattrs")).unwrap()).unwrap();
        let stage_manifest: StageManifest =
            serde_json::from_slice(&fs::read(stage.join("manifest.json")).unwrap()).unwrap();
        let artifact_manifest: serde_json::Value =
            serde_json::from_slice(&fs::read(root.join("main.autosave.json")).unwrap()).unwrap();
        assert_eq!(table_attrs["provenance"], provenance);
        assert_eq!(root_attrs["provenance"], provenance);
        assert_eq!(stage_manifest.provenance, Some(provenance.clone()));
        assert_eq!(artifact_manifest["stages"][0]["provenance"], provenance);
        assert_eq!(artifact_manifest["stages"][0]["table_sample_count"], ROWS);

        let index = read_logical_index(&root.join("main.zarr")).unwrap();
        assert_eq!(index.len(), ROWS);
        assert_eq!(index[0].payload_ref, "stages/stage_0000_run/table/0");
        assert_eq!(index[0].stage_sample_index, 0);
        assert_eq!(
            index[ROWS - 1].payload_ref,
            format!("stages/stage_0000_run/table/{}", ROWS - 1)
        );
        assert_eq!(index[ROWS - 1].target_sample_index, (ROWS - 1) as u64);
        for (sample, entry) in index.iter().enumerate() {
            assert_eq!(entry.target_sample_index, sample as u64);
            assert_eq!(entry.stage_sample_index, sample as u64);
            assert_eq!(
                entry.payload_ref,
                format!("stages/stage_0000_run/table/{sample}")
            );
            let row_start = sample * WIDTH * std::mem::size_of::<f64>();
            let row_end = row_start + WIDTH * std::mem::size_of::<f64>();
            let row = &chunk[row_start..row_end];
            let value = sample as f64;
            let expected = [
                value,
                value + 0.125,
                -value,
                (sample % 97) as f64,
                value * 1e-3,
            ];
            for (column, bytes) in row.chunks_exact(8).enumerate() {
                assert_eq!(
                    f64::from_le_bytes(bytes.try_into().unwrap()),
                    expected[column],
                    "logical index sample {sample}, column {column}"
                );
            }
        }

        if std::env::var_os("FULLMAG_KEEP_ZARR_TEST_OUTPUT").is_some() {
            println!("ZARR_TEST_TABLE_PATH={}", table.display());
        } else {
            fs::remove_dir_all(root).unwrap();
        }
    }

    #[test]
    fn zarr_table_and_index_flush_when_active_age_bound_is_reached() {
        let root = temp_root();
        let mut writer = ZarrAutosaveWriter::new(&root);
        let mut state = AutosaveTargetState::new("main");
        state
            .begin_stage(
                &mut writer,
                "run",
                AutosaveLayoutIR::Continuous,
                AutosaveFormatIR::Zarr,
                vec!["mx".into()],
                vec![],
            )
            .unwrap();
        state
            .append_table_row(
                &mut writer,
                StageSampleCoordinate::AcceptedStep { accepted_step: 0 },
                &[0.25],
            )
            .unwrap();

        let pending = writer.current.as_ref().unwrap().table_pending_path.clone();
        let index_pending = writer
            .current
            .as_ref()
            .unwrap()
            .continuous_index_pending_path
            .clone();
        assert_eq!(fs::metadata(&pending).unwrap().len(), 0);
        assert_eq!(fs::metadata(&index_pending).unwrap().len(), 0);
        let now = Instant::now();
        {
            let current = writer.current.as_mut().unwrap();
            let expired = Some(now - ZARR_STAGE_FLUSH_INTERVAL - Duration::from_millis(1));
            current.table_last_flush = expired;
            current.continuous_index_last_flush = expired;
        }
        writer.flush_due(now).unwrap();
        assert_eq!(fs::metadata(&pending).unwrap().len(), 8);
        assert!(fs::metadata(&index_pending).unwrap().len() > 0);
        assert!(!root.join("main.zarr/continuous/index.jsonl").exists());
        state
            .append_table_row(
                &mut writer,
                StageSampleCoordinate::AcceptedStep { accepted_step: 1 },
                &[0.5],
            )
            .unwrap();
        // The first flush starts a new interval. The second row stays buffered
        // until finalization drains it, even when there are no more samples.
        assert_eq!(fs::read(&pending).unwrap(), 0.25_f64.to_le_bytes());

        state.finish_stage(&mut writer).unwrap();
        let table = root.join("main.zarr/stages/stage_0000_run/table");
        assert_eq!(
            fs::read(table.join("0.0")).unwrap(),
            [0.25_f64.to_le_bytes(), 0.5_f64.to_le_bytes()].concat()
        );
        let array: serde_json::Value =
            serde_json::from_slice(&fs::read(table.join(".zarray")).unwrap()).unwrap();
        assert_eq!(array["shape"], json!([2, 1]));
        assert_eq!(array["chunks"], json!([2, 1]));
        assert_eq!(
            read_logical_index(&root.join("main.zarr")).unwrap().len(),
            2
        );
        fs::remove_dir_all(root).unwrap();
    }

    #[test]
    fn zarr_empty_table_stage_publishes_an_empty_array_without_a_chunk() {
        let root = temp_root();
        let mut writer = ZarrAutosaveWriter::new(&root);
        let mut state = AutosaveTargetState::new("main");
        state
            .begin_stage(
                &mut writer,
                "empty",
                AutosaveLayoutIR::Separate,
                AutosaveFormatIR::Zarr,
                vec!["mx".into()],
                vec![],
            )
            .unwrap();
        assert!(state.finish_stage(&mut writer).unwrap().complete);

        let table = root.join("main.zarr/stages/stage_0000_empty/table");
        let array: serde_json::Value =
            serde_json::from_slice(&fs::read(table.join(".zarray")).unwrap()).unwrap();
        assert_eq!(array["shape"], json!([0, 1]));
        assert_eq!(array["chunks"], json!([1, 1]));
        assert!(!table.join("0.0").exists());
        assert_eq!(fs::read_dir(&table).unwrap().count(), 2);
        assert!(!root.join(".autosave-staging").exists());
        fs::remove_dir_all(root).unwrap();
    }

    #[test]
    fn zarr_empty_continuous_stage_publishes_an_empty_index_file() {
        let root = temp_root();
        let mut writer = ZarrAutosaveWriter::new(&root);
        let mut state = AutosaveTargetState::new("main");
        state
            .begin_stage(
                &mut writer,
                "empty",
                AutosaveLayoutIR::Continuous,
                AutosaveFormatIR::Zarr,
                vec!["mx".into()],
                vec![],
            )
            .unwrap();

        assert!(state.finish_stage(&mut writer).unwrap().complete);
        let index = root.join("main.zarr/continuous/index.jsonl");
        assert!(index.is_file());
        assert_eq!(fs::metadata(index).unwrap().len(), 0);
        assert!(!root.join(".autosave-staging").exists());
        fs::remove_dir_all(root).unwrap();
    }

    #[test]
    fn zarr_finish_retry_after_artifact_manifest_failure_does_not_duplicate_index() {
        let root = temp_root();
        let mut writer = ZarrAutosaveWriter::new(&root);
        let mut state = AutosaveTargetState::new("main");
        state
            .begin_stage(
                &mut writer,
                "retry",
                AutosaveLayoutIR::Continuous,
                AutosaveFormatIR::Zarr,
                vec!["mx".into()],
                vec![],
            )
            .unwrap();
        state
            .append_table_row(
                &mut writer,
                StageSampleCoordinate::AcceptedStep { accepted_step: 0 },
                &[0.75],
            )
            .unwrap();

        let artifact_path = root.join("main.autosave.json");
        let incomplete_artifact = fs::read(&artifact_path).unwrap();
        fs::write(&artifact_path, b"{").unwrap();
        assert!(state.finish_stage(&mut writer).is_err());
        assert!(state.recover_incomplete_stage().is_some());

        let store = root.join("main.zarr");
        assert_eq!(read_logical_index(&store).unwrap().len(), 1);
        let chunk = fs::read(store.join("stages/stage_0000_retry/table/0.0")).unwrap();
        assert_eq!(chunk, 0.75_f64.to_le_bytes());
        fs::write(&artifact_path, incomplete_artifact).unwrap();

        assert!(state.finish_stage(&mut writer).unwrap().complete);
        let index = read_logical_index(&store).unwrap();
        assert_eq!(index.len(), 1);
        assert_eq!(index[0].payload_ref, "stages/stage_0000_retry/table/0");
        let artifact: serde_json::Value =
            serde_json::from_slice(&fs::read(&artifact_path).unwrap()).unwrap();
        assert_eq!(artifact["stages"][0]["complete"], true);
        assert!(!root.join(".autosave-staging").exists());
        fs::remove_dir_all(root).unwrap();
    }

    #[test]
    fn zarr_append_failure_poison_blocks_retry_and_complete_publication() {
        let root = temp_root();
        let mut writer = ZarrAutosaveWriter::new(&root);
        let mut state = AutosaveTargetState::new("main");
        state
            .begin_stage(
                &mut writer,
                "failed_append",
                AutosaveLayoutIR::Continuous,
                AutosaveFormatIR::Zarr,
                vec!["mx".into()],
                vec![],
            )
            .unwrap();
        state
            .append_table_row(
                &mut writer,
                StageSampleCoordinate::AcceptedStep { accepted_step: 0 },
                &[0.25],
            )
            .unwrap();

        // Simulate an I/O error after bytes for a second row reached the private
        // staging buffer, but before the logical append could be committed.
        let current = writer.current.as_mut().unwrap();
        write_f64_row(current.table_writer.as_mut().unwrap(), &[0.5]).unwrap();
        record_append_failure(current, "injected staging write failure".into());

        let append_error = state
            .append_table_row(
                &mut writer,
                StageSampleCoordinate::AcceptedStep { accepted_step: 1 },
                &[0.5],
            )
            .unwrap_err();
        assert!(append_error.contains("poisoned"));
        assert!(state.finish_stage(&mut writer).is_err());
        assert!(state.recover_incomplete_stage().is_some());

        let stage = root.join("main.zarr/stages/stage_0000_failed_append");
        let table_meta: serde_json::Value =
            serde_json::from_slice(&fs::read(stage.join("table/.zarray")).unwrap()).unwrap();
        assert_eq!(table_meta["shape"], json!([0, 1]));
        assert!(!stage.join("table/0.0").exists());
        assert!(!root.join("main.zarr/continuous/index.jsonl").exists());
        let artifact: serde_json::Value =
            serde_json::from_slice(&fs::read(root.join("main.autosave.json")).unwrap()).unwrap();
        assert_eq!(artifact["stages"][0]["complete"], false);
        drop(writer);
        fs::remove_dir_all(root).unwrap();
    }

    #[test]
    fn zarr_stage_claim_allows_only_one_concurrent_writer_for_an_identity() {
        use std::sync::{Arc, Barrier};

        let root = temp_root();
        let start = Arc::new(Barrier::new(2));
        let workers = (0..2)
            .map(|_| {
                let root = root.clone();
                let start = Arc::clone(&start);
                std::thread::spawn(move || {
                    let mut writer = ZarrAutosaveWriter::new(&root);
                    let mut state = AutosaveTargetState::new("main");
                    start.wait();
                    state
                        .begin_stage(
                            &mut writer,
                            "shared",
                            AutosaveLayoutIR::Continuous,
                            AutosaveFormatIR::Zarr,
                            vec!["mx".into()],
                            vec![],
                        )
                        .map(|_| true)
                })
            })
            .collect::<Vec<_>>();
        let outcomes = workers
            .into_iter()
            .map(|worker| worker.join().unwrap())
            .collect::<Vec<_>>();
        assert_eq!(outcomes.iter().filter(|result| result.is_ok()).count(), 1);
        assert_eq!(outcomes.iter().filter(|result| result.is_err()).count(), 1);

        let artifact: serde_json::Value =
            serde_json::from_slice(&fs::read(root.join("main.autosave.json")).unwrap()).unwrap();
        assert_eq!(artifact["stages"].as_array().unwrap().len(), 1);
        let stage_dir = root.join(".autosave-staging/main/stage_0000_shared");
        assert!(stage_dir.is_dir());
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
