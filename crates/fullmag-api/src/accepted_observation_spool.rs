//! Private terminal observations, streamed one complete quantity at a time.
//! The manifest is metadata only; these files are not restart checkpoints.

use std::{fs::OpenOptions, io::{Read, Write}, path::Path};
use anyhow::{bail, Context, Result};
use fullmag_runner::{AcceptedMaterializedField, CapturedSolverObservables, StepUpdate};
use serde::{Deserialize, Serialize};
use sha2::{Digest, Sha256};

pub(crate) const MANIFEST_FILE: &str = "accepted_observables_stream.v1.json";
pub(crate) const MAX_MANIFEST_BYTES: u64 = 16 * 1024 * 1024;

#[derive(Debug, Serialize, Deserialize)]
#[serde(deny_unknown_fields)]
pub(crate) struct SpoolField {
    pub metadata: AcceptedMaterializedField,
    pub file_name: String,
    pub value_count: usize,
    pub values_sha256: String,
}

#[derive(Debug, Serialize, Deserialize)]
#[serde(deny_unknown_fields)]
pub(crate) struct TerminalObservationSpool {
    pub schema_version: String,
    /// No field arrays: common clock, M digest, map and scalar energies only.
    pub capture: CapturedSolverObservables,
    pub fields: Vec<SpoolField>,
}

pub(crate) fn write_fragment(
    root: &Path, accumulated: &mut Option<TerminalObservationSpool>,
    update: &StepUpdate, storage_budget: u64, field_budget: u64,
) -> Result<()> {
    if update.preview_field.is_some()
        || update.cached_preview_fields.as_ref().map_or(0, Vec::len) != 1 {
        bail!("terminal observation requires exactly one complete quantity per fragment");
    }
    let source_field = &update.cached_preview_fields.as_ref().context("terminal field missing")?[0];
    let source_bytes = u64::try_from(source_field.vector_field_values.len())?
        .checked_mul(8).context("terminal field size overflow")?;
    if source_bytes > field_budget {
        bail!("terminal quantity exceeds its memory budget before capture");
    }
    let Some(mut capture) = fullmag_runner::capture_solver_observables(update)
        .map_err(anyhow::Error::msg)? else { return Ok(()); };
    let fields = std::mem::take(&mut capture.fields);
    let manifest = accumulated.get_or_insert_with(|| TerminalObservationSpool {
        schema_version: "fullmag.terminal_observation_spool.v1".into(),
        capture: capture.clone(), fields: Vec::new(),
    });
    if manifest.capture.carrier != capture.carrier
        || manifest.capture.magnetization_values_sha256 != capture.magnetization_values_sha256
        || manifest.capture.energies != capture.energies
        || manifest.capture.evaluator_build_identity != capture.evaluator_build_identity {
        bail!("terminal observation fragments have different accepted sources");
    }
    for mut field in fields {
        let count = field.values.len();
        let byte_count = u64::try_from(count)?.checked_mul(8).context("field byte count overflow")?;
        if byte_count > field_budget { bail!("terminal quantity {} exceeds its per-field memory budget", field.quantity_id); }
        let hash = fullmag_runner::live_preview_values_sha256(&field.values);
        if let Some(existing) = manifest.fields.iter().find(|item|
            item.metadata.quantity_id == field.quantity_id && item.metadata.role == field.role) {
            if existing.values_sha256 != hash || existing.value_count != count {
                bail!("terminal quantity {} changed within one generation", field.quantity_id);
            }
            continue;
        }
        let stored_bytes = manifest.fields.iter().try_fold(0_u64, |total, item|
            total.checked_add((item.value_count as u64).checked_mul(8)?))
            .context("terminal observation size overflow")?;
        if stored_bytes.checked_add(byte_count).is_none_or(|bytes| bytes > storage_budget) {
            bail!("terminal observations exceed the reserved storage budget");
        }
        fullmag_session::repository_path::validate_store_id(&field.quantity_id)?;
        let name = format!("accepted-observable-{}-{hash}.f64le", field.quantity_id);
        let path = fullmag_session::repository_path::checked_path(root, &name)?;
        match OpenOptions::new().write(true).create_new(true).open(&path) {
            Ok(mut file) => {
                let mut buffer = [0_u8; 64 * 1024];
                for values in field.values.chunks(buffer.len() / 8) {
                    for (value, bytes) in values.iter().zip(buffer.chunks_exact_mut(8)) {
                        bytes.copy_from_slice(&value.to_le_bytes());
                    }
                    file.write_all(&buffer[..values.len() * 8])?;
                }
                file.sync_all()?;
            }
            Err(error) if error.kind() == std::io::ErrorKind::AlreadyExists => {
                // A replay may reuse immutable bytes, never a partial write.
                let mut file = std::fs::File::open(&path)?;
                if file.metadata()?.len() != byte_count { bail!("terminal observation file length changed"); }
                let mut digest = Sha256::new();
                let mut buffer = [0_u8; 64 * 1024];
                loop {
                    let count = file.read(&mut buffer)?;
                    if count == 0 { break; }
                    digest.update(&buffer[..count]);
                }
                if format!("{:x}", digest.finalize()) != hash { bail!("terminal observation replay digest differs"); }
            }
            Err(error) => return Err(error).context("create terminal binary quantity"),
        }
        field.values.clear();
        field.values.shrink_to_fit();
        manifest.fields.push(SpoolField { metadata: field, file_name: name,
            value_count: count, values_sha256: hash });
    }
    let bytes = serde_json::to_vec(manifest)?;
    if bytes.len() as u64 > MAX_MANIFEST_BYTES { bail!("terminal observation metadata exceeds its budget"); }
    crate::accepted_study_worker::write_live_file_atomically(root, MANIFEST_FILE, &bytes)
}

pub(crate) fn read_manifest(root: &Path) -> Result<Option<TerminalObservationSpool>> {
    let path = fullmag_session::repository_path::checked_path(root, MANIFEST_FILE)?;
    match std::fs::symlink_metadata(&path) {
        Err(error) if error.kind() == std::io::ErrorKind::NotFound => return Ok(None),
        Err(error) => return Err(error.into()),
        Ok(_) => {}
    }
    let bytes = crate::accepted_study_worker::read_explicit_runner_artifact(root, MANIFEST_FILE, MAX_MANIFEST_BYTES)?;
    let manifest: TerminalObservationSpool = serde_json::from_slice(&bytes)?;
    if manifest.schema_version != "fullmag.terminal_observation_spool.v1"
        || !manifest.capture.fields.is_empty() || manifest.fields.is_empty() {
        bail!("terminal binary observation manifest is invalid");
    }
    Ok(Some(manifest))
}

pub(crate) fn read_field(root: &Path, field: &SpoolField, budget: u64) -> Result<AcceptedMaterializedField> {
    if !field.metadata.values.is_empty() { bail!("spool metadata contains inline field values"); }
    let bytes_expected = (field.value_count as u64).checked_mul(8).context("spool field size overflow")?;
    if bytes_expected > budget { bail!("terminal quantity exceeds its admitted per-field read budget"); }
    let bytes = crate::accepted_study_worker::read_explicit_runner_artifact(root, &field.file_name, budget)?;
    if bytes.len() as u64 != bytes_expected || fullmag_session::hex_sha256(&bytes) != field.values_sha256 {
        bail!("terminal binary quantity size or SHA-256 differs");
    }
    let mut output = field.metadata.clone();
    output.values = bytes.chunks_exact(8).map(|bytes| f64::from_le_bytes(bytes.try_into().expect("8 bytes"))).collect();
    if output.values.iter().any(|value| !value.is_finite()) { bail!("terminal binary quantity is nonfinite"); }
    Ok(output)
}
