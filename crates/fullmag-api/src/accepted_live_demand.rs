//! Live observation demand channel: current-live projector -> accepted worker.
//!
//! The Control Room visualization state decides which spatial quantities are
//! displayed (`CurrentDisplaySelection::observation_quantities`). The API
//! projector writes that list beside the run (`runs/<run>/live_demand.v1.json`)
//! and the accepted worker installs it in the runner, whose live capture then
//! copies `m` plus those quantities instead of the whole active catalog.
//!
//! The file is advisory and bounded. A missing, oversized or foreign file keeps
//! the full active catalog, so an older API or a run without a Control Room
//! client behaves exactly as before. Terminal bundles never consult it.

use std::fs;
use std::path::{Path, PathBuf};
use std::time::{Duration, Instant};

use anyhow::{Context, Result};
use serde::{Deserialize, Serialize};

pub(crate) const ACCEPTED_LIVE_DEMAND_FILE: &str = "live_demand.v1.json";
const ACCEPTED_LIVE_DEMAND_SCHEMA: &str = "fullmag.accepted_live_demand.v1";
const ACCEPTED_LIVE_DEMAND_MAX_BYTES: u64 = 64 * 1024;
const ACCEPTED_LIVE_DEMAND_MAX_QUANTITIES: usize = 64;
/// Half the projector poll period: a new selection reaches the runner before
/// the projector's next read of the live sidecar.
const ACCEPTED_LIVE_DEMAND_REFRESH: Duration = Duration::from_millis(250);

#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
#[serde(deny_unknown_fields)]
struct AcceptedLiveDemand {
    schema_version: String,
    run_id: String,
    quantities: Vec<String>,
}

#[cfg_attr(not(test), allow(dead_code))] // Used by the API binary only.
fn run_dir(store_root: &Path, run_id: &str) -> Result<PathBuf> {
    fullmag_session::repository_path::validate_store_id(run_id)
        .context("accepted live demand run id is invalid")?;
    Ok(store_root.join("runs").join(run_id))
}

/// Publish the displayed quantities for one run. Returns `false` while the run
/// directory does not exist yet; the next projector tick then tries again.
#[cfg_attr(not(test), allow(dead_code))] // Used by the API binary only.
pub(crate) fn write_accepted_live_demand(
    store_root: &Path,
    run_id: &str,
    quantities: &[String],
) -> Result<bool> {
    let dir = run_dir(store_root, run_id)?;
    match fs::symlink_metadata(&dir) {
        Ok(metadata) if metadata.is_dir() && !metadata.file_type().is_symlink() => {}
        Ok(_) => anyhow::bail!("accepted run directory must be a real directory"),
        Err(error) if error.kind() == std::io::ErrorKind::NotFound => return Ok(false),
        Err(error) => return Err(error).context("inspect accepted run directory"),
    }
    let demand = AcceptedLiveDemand {
        schema_version: ACCEPTED_LIVE_DEMAND_SCHEMA.to_owned(),
        run_id: run_id.to_owned(),
        quantities: quantities
            .iter()
            .take(ACCEPTED_LIVE_DEMAND_MAX_QUANTITIES)
            .cloned()
            .collect(),
    };
    let bytes = serde_json::to_vec(&demand).context("serialize accepted live demand")?;
    crate::accepted_study_worker::write_live_file_atomically(&dir, ACCEPTED_LIVE_DEMAND_FILE, &bytes)?;
    Ok(true)
}

fn read_accepted_live_demand(run_dir: &Path, run_id: &str) -> Option<Vec<String>> {
    let path = run_dir.join(ACCEPTED_LIVE_DEMAND_FILE);
    let metadata = fs::symlink_metadata(&path).ok()?;
    if !metadata.is_file() || metadata.len() > ACCEPTED_LIVE_DEMAND_MAX_BYTES {
        return None;
    }
    let bytes = fs::read(&path).ok()?;
    let demand: AcceptedLiveDemand = serde_json::from_slice(&bytes).ok()?;
    if demand.schema_version != ACCEPTED_LIVE_DEMAND_SCHEMA
        || demand.run_id != run_id
        || demand.quantities.len() > ACCEPTED_LIVE_DEMAND_MAX_QUANTITIES
    {
        return None;
    }
    Some(demand.quantities)
}

/// Worker-side reader. It installs the demand in the runner when it changes
/// and restores the full catalog when the worker finishes its task.
pub(crate) struct AcceptedLiveDemandReader {
    run_dir: Option<PathBuf>,
    run_id: String,
    last_check: Option<Instant>,
    installed: Option<Vec<String>>,
}

impl AcceptedLiveDemandReader {
    /// `attempt_output_dir` is `runs/<run>/worker-attempts/<task>/<attempt>/epoch-<n>`.
    pub(crate) fn new(attempt_output_dir: &Path, run_id: &str) -> Self {
        let run_dir = attempt_output_dir
            .ancestors()
            .nth(3)
            .filter(|worker_root| {
                worker_root.file_name().and_then(|name| name.to_str()) == Some("worker-attempts")
            })
            .and_then(Path::parent)
            .filter(|run_dir| run_dir.file_name().and_then(|name| name.to_str()) == Some(run_id))
            .map(Path::to_path_buf);
        let mut reader = Self {
            run_dir,
            run_id: run_id.to_owned(),
            last_check: None,
            installed: None,
        };
        // Always install this task's state, also clearing a demand left by an
        // earlier task of the same worker process.
        fullmag_runner::set_live_quantity_demand(None);
        reader.refresh();
        reader
    }

    pub(crate) fn refresh(&mut self) {
        let now = Instant::now();
        if self
            .last_check
            .is_some_and(|last| now.duration_since(last) < ACCEPTED_LIVE_DEMAND_REFRESH)
        {
            return;
        }
        self.last_check = Some(now);
        let demand = self
            .run_dir
            .as_deref()
            .and_then(|dir| read_accepted_live_demand(dir, &self.run_id));
        if demand != self.installed {
            fullmag_runner::set_live_quantity_demand(demand.clone());
            self.installed = demand;
        }
    }

    pub(crate) fn finish(self) {
        fullmag_runner::set_live_quantity_demand(None);
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn demand_round_trips_only_for_its_own_run() {
        let store = tempfile::tempdir().unwrap();
        let run_root = store.path().join("runs").join("run-a");
        fs::create_dir_all(&run_root).unwrap();
        assert!(write_accepted_live_demand(store.path(), "run-a", &["H_demag".to_string()]).unwrap());
        assert_eq!(
            read_accepted_live_demand(&run_root, "run-a"),
            Some(vec!["H_demag".to_string()])
        );
        assert_eq!(read_accepted_live_demand(&run_root, "run-b"), None);
        // A run that has no directory yet is skipped, not created.
        assert!(!write_accepted_live_demand(store.path(), "run-missing", &[]).unwrap());
        assert!(!store.path().join("runs").join("run-missing").exists());
    }
}
