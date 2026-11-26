//! Explicit readonly source export: no session startup, solver dispatch or history mutation.
use anyhow::{bail, Context, Result};
use fullmag_application::ProjectId;
use fullmag_ir::AntennaRetainedCurrentSourceIR;
use std::{fs::OpenOptions, io::{Read, Write}, path::{Path, PathBuf}};

const MAX_LOCATOR_BYTES: usize = 16 * 1024;

fn parse_locator(bytes: &[u8]) -> Result<AntennaRetainedCurrentSourceIR> {
    if bytes.is_empty() || bytes.len() > MAX_LOCATOR_BYTES {
        bail!("antenna source locator exceeds its positive 16 KiB metadata bound");
    }
    let source: AntennaRetainedCurrentSourceIR = serde_json::from_slice(bytes)
        .context("antenna source locator must be its exact closed typed JSON")?;
    let errors = source.validation_errors("source");
    if !errors.is_empty() { bail!("invalid antenna source locator: {}", errors.join("; ")); }
    Ok(source)
}

fn read_locator(path: &Path) -> Result<AntennaRetainedCurrentSourceIR> {
    let metadata = std::fs::symlink_metadata(path).context("read antenna source locator metadata")?;
    if !metadata.is_file() || metadata.file_type().is_symlink() || metadata.len() > MAX_LOCATOR_BYTES as u64 {
        bail!("antenna source locator must be a bounded regular file");
    }
    let mut bytes = Vec::new();
    std::fs::File::open(path)?.take(MAX_LOCATOR_BYTES as u64 + 1).read_to_end(&mut bytes)?;
    parse_locator(&bytes)
}

fn resolved_store_path(store: &Path) -> Result<PathBuf> {
    let absolute = if store.is_absolute() { store.to_owned() } else { std::env::current_dir()?.join(store) };
    let root = fullmag_runtime_control::accepted_store::writable_product_state_path(&absolute)
        .context("antenna source export store fails the managed product path resolver")?;
    fullmag_runtime_control::accepted_store::store_binding(&root)
        .context("antenna source export store has no canonical managed binding")?;
    Ok(root)
}

fn write_new_output(path: &Path, bytes: &[u8]) -> Result<()> {
    // Opening happens only after the complete input asset has passed its 8 MiB encoder.
    // create_new is the atomic no-overwrite fence, including dangling symlinks.
    let mut output = OpenOptions::new().write(true).create_new(true).open(path)
        .context("create new antenna source preparation asset (existing targets are preserved)")?;
    output.write_all(bytes).context("write antenna source preparation asset")?;
    output.sync_all().context("sync antenna source preparation asset")?;
    Ok(())
}

pub(crate) fn export(store: &Path, source: &Path, output: &Path) -> Result<()> {
    let source = read_locator(source)?;
    let root = resolved_store_path(store)?;
    let store = fullmag_session::SessionStore::open_existing(root)
        .context("open existing managed source store without creating history")?;
    // The canonical reader's SH acquisition retains the existing filesystem/delegation admission.
    let AntennaRetainedCurrentSourceIR::PublishedInspection { project_id, .. } = &source;
    let project = ProjectId::parse(project_id.clone()).map_err(|error| anyhow::anyhow!(error.to_string()))?;
    let parent = output.parent().filter(|parent| !parent.as_os_str().is_empty()).unwrap_or(Path::new("."));
    let parent = std::fs::canonicalize(parent).context("antenna source output parent must already exist")?;
    if parent.starts_with(store.root()) {
        bail!("antenna source preparation output cannot mutate the accepted store");
    }
    let name = output.file_name().context("antenna source output requires a filename")?;
    let output = parent.join(name);
    if std::fs::symlink_metadata(&output).is_ok() {
        bail!("antenna source preparation output already exists; refusing replacement");
    }
    let encoded = fullmag_runtime_control::encode_saved_antenna_source_preparation(&store, &project, &source)?;
    write_new_output(&output, &encoded.bytes)?;
    println!("{}", serde_json::to_string(&encoded.receipt)?);
    Ok(())
}

#[cfg(test)]
mod tests {
    use super::*;
    fn locator() -> serde_json::Value {
        serde_json::json!({"kind":"published_inspection", "project_id":"project-parent",
            "run_id":"run-parent", "task_id":"task-parent", "attempt_id":"attempt-parent",
            "ownership_epoch":"18446744073709551615", "artifact_id":"artifact-parent", "object_ref":"a".repeat(64)})
    }
    #[test]
    fn locator_refuses_unknown_duplicate_and_noncanonical_pins() {
        let valid = serde_json::to_vec(&locator()).unwrap();
        parse_locator(&valid).unwrap();
        let mut extra = locator(); extra["lease"] = serde_json::json!({});
        assert!(parse_locator(&serde_json::to_vec(&extra).unwrap()).is_err());
        for epoch in ["0", "01", "+1", "18446744073709551616"] {
            let mut source = locator(); source["ownership_epoch"] = epoch.into();
            assert!(parse_locator(&serde_json::to_vec(&source).unwrap()).is_err());
        }
        let duplicate = String::from_utf8(valid).unwrap().replacen("{", "{\"project_id\":\"project-other\",", 1);
        assert!(parse_locator(duplicate.as_bytes()).is_err());
        assert!(parse_locator(&vec![b' '; MAX_LOCATOR_BYTES + 1]).is_err());
    }
    #[test]
    fn explicit_export_never_overwrites_or_creates_missing_parent() {
        let directory = tempfile::tempdir().unwrap();
        let output = directory.path().join("source.json");
        write_new_output(&output, b"first").unwrap();
        assert!(write_new_output(&output, b"second").is_err());
        assert_eq!(std::fs::read(&output).unwrap(), b"first");
        assert!(write_new_output(&directory.path().join("absent/source.json"), b"unused").is_err());
        assert!(!directory.path().join("absent").exists());
    }
}
