//! Read-only validation of a retained native runtime snapshot.
//!
//! This entry point composes the existing exact retained-run/CAS validator
//! with the runtime namespace and scheduler checkpoint checks. It deliberately
//! owns no recovery locks and never changes owner, ledger, or session state.

use std::fs;

use anyhow::{bail, Context, Result};

use crate::runtime_service::retained_held_manual_runs::RetainedHeldManualRunPin;
use crate::runtime_service::retained_terminal_runs::RetainedTerminalRunPin;
use crate::runtime_service::{
    require_retained_runtime_store_for_run_ids, validate_manual_held_union,
    RuntimeServiceConfig,
};
use crate::store::SessionStore;

/// Validate a retained snapshot against an already-opened, existing session
/// store. The caller must use `SessionStore::open_existing`; this function
/// performs read-only store operations and requires the config to name the
/// same canonical store.
pub fn validate_retained_snapshot(
    store: &SessionStore,
    config: &RuntimeServiceConfig,
    terminal: &[RetainedTerminalRunPin],
    held: &[RetainedHeldManualRunPin],
) -> Result<Vec<String>> {
    config.validate()?;
    let configured_store_root = fs::canonicalize(&config.store_root)
        .context("canonicalize retained snapshot config store root")?;
    if configured_store_root != store.root() {
        bail!("retained snapshot config does not name the opened session store");
    }

    let run_ids = validate_manual_held_union(store, terminal, held)?;
    require_retained_runtime_store_for_run_ids(store, config, &run_ids)?;
    Ok(run_ids.into_iter().collect())
}
