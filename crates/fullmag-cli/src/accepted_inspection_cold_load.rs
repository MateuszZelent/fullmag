//! Thin CLI boundary for offline, pinned inspection integrity.
use anyhow::Result;
use fullmag_application::{ProjectId, RunId};
use std::path::Path;

pub(crate) fn verify(store: &Path, project: &str, run: &str, task: &str, attempt: &str, epoch: u64, object: &str) -> Result<()> {
    fullmag_session::repository_path::validate_store_id(task)?;
    fullmag_session::repository_path::validate_store_id(attempt)?;
    let store = fullmag_session::SessionStore::open_existing(store)?;
    let receipt = fullmag_runtime_control::verify_saved_inspection(&store,
        &ProjectId::parse(project).map_err(|error| anyhow::anyhow!(error.to_string()))?,
        &RunId::parse(run).map_err(|error| anyhow::anyhow!(error.to_string()))?, task, attempt, epoch, object)?;
    println!("{}", serde_json::to_string(&receipt)?);
    Ok(())
}
