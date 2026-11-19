//! Retire an importer-owned observation without claiming native completion.
//!
//! Callers retain mutation admission and the current-session transition guard.
//! This module reads only the private import; it never opens the execution store,
//! releases reservations, changes leases, or grants permission to start a solver.

use std::path::{Path, PathBuf};

use anyhow::{bail, Context, Result};
use fullmag_application::RunId;
use fullmag_runner::RuntimeStatus;
use fullmag_session::{repository_path, FmsTaskLifecycle, SessionStore};
use serde::{Deserialize, Serialize};

use crate::types::{
    AppState, LiveState, RunManifest, RuntimeStatusView, SessionManifest,
    SessionStateResponse, StageExecutionState, StageLifecycleState,
};

#[derive(Debug, Clone, Serialize, Deserialize, PartialEq, Eq)]
#[serde(deny_unknown_fields)]
pub(crate) struct ImportedObservationEvidence {
    pub(crate) import_id: String,
    pub(crate) session_id: String,
    pub(crate) run_id: String,
    /// SHA-256 of the exact importer-written snapshot bytes, without a prefix.
    pub(crate) snapshot_sha256: String,
    /// Canonical accepted closure reference, including its `sha256:` prefix.
    pub(crate) closure_sha256: String,
    pub(crate) historical_terminal_outcome: String,
    pub(crate) historical_catalog_revision: u64,
}

#[derive(Deserialize)]
struct ImportedSnapshot {
    session: SessionManifest,
    run: Option<RunManifest>,
    runtime_status: RuntimeStatusView,
    live_state: Option<LiveState>,
    stage_execution: Option<StageExecutionState>,
    scene_document: Option<fullmag_authoring::SceneDocument>,
    metadata: Option<serde_json::Value>,
}

pub(crate) fn collect(
    state: &AppState,
    current: &SessionStateResponse,
) -> Result<ImportedObservationEvidence> {
    validate_idle_observation(
        &current.session, current.run.as_ref(), &current.runtime_status,
        current.live_state.as_ref(), current.stage_execution.as_ref(),
    )?;
    let script = Path::new(&current.session.script_path);
    let root = script.parent().and_then(Path::parent).context("import root is absent")?;
    let import_id = root.file_name().and_then(|name| name.to_str())
        .context("import identity is absent")?;
    let expected_root = private_import_root(state, import_id)?;
    if root != expected_root || script != expected_root.join("project/main.py") {
        bail!("observation source is not the exact private import");
    }
    let store = SessionStore::open_existing(&expected_root)?;
    let _transaction = store.read_transaction()?;
    let (evidence, imported) = read_evidence(&store, import_id)?;
    if current.session.session_id != imported.session.session_id
        || current.session.run_id != imported.session.run_id
        || current.session.script_path != imported.session.script_path
        || current.session.artifact_dir != imported.session.artifact_dir
        || current.run.as_ref().map(|run| &run.artifact_dir)
            != imported.run.as_ref().map(|run| &run.artifact_dir)
        || serde_json::to_value(current.scene_document.as_ref())?
            != serde_json::to_value(imported.scene_document.as_ref())?
    {
        bail!("current observation differs from its importer-written identity or scene");
    }
    let marker = current.metadata.as_ref()
        .and_then(|metadata| metadata.get("imported_accepted_evidence"))
        .context("current observation has no imported accepted evidence")?;
    validate_marker(marker, &evidence.run_id, &evidence.closure_sha256)?;
    Ok(evidence)
}

/// Keep the private store's native read fence through the synchronous pointer
/// transition. Replay reads the same immutable import even after `current` clears.
pub(crate) fn with_revalidated<T>(
    state: &AppState,
    evidence: &ImportedObservationEvidence,
    operation: impl FnOnce() -> Result<T>,
) -> Result<T> {
    let root = private_import_root(state, &evidence.import_id)?;
    let store = SessionStore::open_existing(root)?;
    let _transaction = store.read_transaction()?;
    let (observed, _) = read_evidence(&store, &evidence.import_id)?;
    if &observed != evidence {
        bail!("imported observation evidence changed before retirement");
    }
    operation()
}

fn private_import_root(state: &AppState, import_id: &str) -> Result<PathBuf> {
    repository_path::validate_store_id(import_id)?;
    let root = crate::session_persistence::session_store_root(state);
    repository_path::checked_path(&root, &format!("imports/{import_id}"))
}

fn read_evidence(
    store: &SessionStore,
    import_id: &str,
) -> Result<(ImportedObservationEvidence, ImportedSnapshot)> {
    let bytes = repository_path::read_bounded_regular_file(
        store.root(), "project/current_live_snapshot.json",
        usize::try_from(fullmag_session::MAX_TERMINAL_CATALOG_METADATA_BYTES)?,
    )?;
    let imported: ImportedSnapshot = serde_json::from_slice(&bytes)
        .context("decode importer-written observation")?;
    validate_idle_observation(
        &imported.session, imported.run.as_ref(), &imported.runtime_status,
        imported.live_state.as_ref(), imported.stage_execution.as_ref(),
    )?;
    let expected_script = store.root().join("project/main.py");
    let expected_artifacts = store.root().join("runs")
        .join(&imported.session.run_id).join("artifacts");
    if Path::new(&imported.session.script_path) != expected_script
        || Path::new(&imported.session.artifact_dir) != expected_artifacts
        || imported.run.as_ref().is_none_or(|run|
            Path::new(&run.artifact_dir) != expected_artifacts)
        || imported.scene_document.as_ref().is_none_or(|scene|
            scene.scene.id.trim().is_empty() || scene.scene.id.trim() != scene.scene.id)
    {
        bail!("private observation source, artifact directory, or scene is invalid");
    }
    let session = store.current_session()?.context("private import session manifest is absent")?;
    if session.session_id != imported.session.session_id {
        bail!("private import session differs from its snapshot");
    }
    let reference = session.accepted_provenance_ref
        .context("legacy observation has no accepted closure")?;
    reference.validate()?;
    if reference.accepted_run_id != imported.session.run_id {
        bail!("private import accepted run differs from its snapshot");
    }
    let marker = imported.metadata.as_ref()
        .and_then(|metadata| metadata.get("imported_accepted_evidence"))
        .context("private observation has no importer-issued closure marker")?;
    validate_marker(marker, &reference.accepted_run_id, &reference.closure_sha256)?;
    let run = RunId::parse(&reference.accepted_run_id)?;
    let historical = fullmag_runtime_control::load_imported_study_evidence(
        store, &run, &reference.closure_sha256,
    )?.context("imported accepted closure has no Study")?;
    let catalog = historical.catalog;
    catalog.validate()?;
    if catalog.run_id != imported.session.run_id || catalog.tasks.is_empty()
        || catalog.tasks.iter().any(|task| !matches!(task.lifecycle,
            FmsTaskLifecycle::Succeeded | FmsTaskLifecycle::Failed
                | FmsTaskLifecycle::Cancelled | FmsTaskLifecycle::Interrupted))
    {
        bail!("imported historical run catalog is not terminal or has another identity");
    }
    let outcome = if catalog.tasks.iter().any(|task| task.lifecycle == FmsTaskLifecycle::Failed) {
        "failed"
    } else if catalog.tasks.iter().any(|task| task.lifecycle == FmsTaskLifecycle::Interrupted) {
        "interrupted"
    } else if catalog.tasks.iter().any(|task| task.lifecycle == FmsTaskLifecycle::Cancelled) {
        "cancelled"
    } else {
        "completed"
    };
    let evidence = ImportedObservationEvidence {
        import_id: import_id.to_owned(),
        session_id: imported.session.session_id.clone(),
        run_id: imported.session.run_id.clone(),
        snapshot_sha256: fullmag_session::hex_sha256(&bytes),
        closure_sha256: reference.closure_sha256,
        historical_terminal_outcome: outcome.to_owned(),
        historical_catalog_revision: catalog.revision,
    };
    Ok((evidence, imported))
}

fn validate_marker(marker: &serde_json::Value, run_id: &str, closure: &str) -> Result<()> {
    if marker["run_id"].as_str() != Some(run_id)
        || marker["closure_sha256"].as_str() != Some(closure)
    {
        bail!("imported observation closure marker differs");
    }
    Ok(())
}

fn validate_idle_observation(
    session: &SessionManifest,
    run: Option<&RunManifest>,
    runtime: &RuntimeStatusView,
    live: Option<&LiveState>,
    stage: Option<&StageExecutionState>,
) -> Result<()> {
    repository_path::validate_store_id(&session.session_id)?;
    repository_path::validate_store_id(&session.run_id)?;
    let run = run.context("imported observation has no run manifest")?;
    if runtime.code != "imported_read_only" || runtime.kind != RuntimeStatus::Completed
        || runtime.is_busy || runtime.can_accept_commands
        || session.status != "completed" || run.status != "completed"
        || run.run_id != session.run_id || run.session_id != session.session_id
        || live.is_some_and(|live| live.status != "completed" || !live.latest_step.finished)
        || stage.is_some_and(|stage|
            stage.runtime_state.as_str() != "completed"
                || stage.active_stage_index.is_some() || stage.active_stage_kind.is_some()
                || stage.stage_statuses.len() != stage.total_stages
                || stage.completed_stage_indexes.len() != stage.total_stages
                || stage.completed_stage_indexes.iter().enumerate().any(|(index, value)| *value != index)
                || stage.stages.len() > stage.total_stages
                || stage.stage_statuses.iter().any(|status| *status != StageLifecycleState::Completed)
                || stage.stages.iter().any(|record| record.status != StageLifecycleState::Completed))
    {
        bail!("workspace is not a coherent idle imported observation");
    }
    Ok(())
}
