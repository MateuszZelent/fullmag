use anyhow::{bail, Result};
use fullmag_session::solution_tensor_source::PinnedSolutionTensorSource;
use std::{io::Read, path::Path};

pub(crate) fn verify(store: &Path, source: &Path, source_artifact_id: &str) -> Result<()> {
    const MAX_PINNED_SOURCE_BYTES: u64 = 16 * 1024;
    let mut bytes = Vec::new();
    std::fs::File::open(source)?
        .take(MAX_PINNED_SOURCE_BYTES + 1)
        .read_to_end(&mut bytes)?;
    if bytes.len() as u64 > MAX_PINNED_SOURCE_BYTES {
        bail!("pinned tensor source exceeds metadata budget");
    }
    let pinned: PinnedSolutionTensorSource = serde_json::from_slice(&bytes)?;
    pinned.validate()?;
    let store = fullmag_session::SessionStore::open_existing(store)?;
    let receipt = fullmag_runtime_control::verify_pinned_native_fem_snapshot(
        &store,
        &pinned,
        source_artifact_id,
    )?;
    println!(
        "{}",
        serde_json::to_string_pretty(&serde_json::json!({
            "schema": "fullmag.saved_native_fem_snapshot_integrity.v1",
            "status": "pass",
            "source": pinned,
            "source_artifact_id": source_artifact_id,
            "native_snapshot_receipt": receipt,
            "scientific_qualification": "not_verified",
            "archive_roundtrip": "not_verified"
        }))?
    );
    Ok(())
}
