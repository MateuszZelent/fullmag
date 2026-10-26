//! Operator maintenance for an exact observed failed worker. No service owner,
//! scheduler, worker, solver or solution publication is started by this path.
use anyhow::{bail, Context, Result};
use fullmag_session::{
    host_resource_ledger::{FailedWorkerExitReconciliation, HostResourceLedger},
    runtime_service::{
        validate_descriptor, RuntimeServiceConfig, RuntimeServiceLaunchGuard,
        RuntimeServiceOwnerDescriptor, RuntimeServiceOwnerLockGuard, RuntimeServiceState,
        RUNTIME_SERVICE_OWNER_DESCRIPTOR_PATH,
    },
    runtime_service_startup::RuntimeServiceStartupGuard,
    SessionStore,
};
use serde::{Deserialize, Serialize};
use std::{ffi::OsString, path::PathBuf};

const SCHEMA: &str = "runtime_service_failed_worker_exit_reconciliation_request.v1";
const MAX_BYTES: usize = 16 * 1024 * 1024;

#[derive(Debug, Clone, Serialize, Deserialize)]
#[serde(deny_unknown_fields)]
struct Request {
    schema_version: String,
    request_id: String,
    config_sha256: String,
    owner_sha256: String,
    expected_owner: RuntimeServiceOwnerDescriptor,
    expected_catalog_sha256: String,
    expected_lease_sha256: String,
    expected_receipt_sha256: String,
    reconciliation: FailedWorkerExitReconciliation,
}

impl Request {
    fn validate(&self) -> Result<()> {
        if self.schema_version != SCHEMA {
            bail!("unsupported failed-worker reconciliation schema");
        }
        let id = uuid::Uuid::parse_str(&self.request_id)?;
        if id.is_nil() || id.to_string() != self.request_id {
            bail!("request_id must be a canonical nonzero UUID");
        }
        for digest in [
            &self.config_sha256,
            &self.owner_sha256,
            &self.expected_catalog_sha256,
            &self.expected_lease_sha256,
            &self.expected_receipt_sha256,
        ] {
            if digest.len() != 64
                || !digest
                    .bytes()
                    .all(|b| b.is_ascii_digit() || (b'a'..=b'f').contains(&b))
            {
                bail!("failed-worker reconciliation requires lowercase SHA-256 pins");
            }
        }
        self.reconciliation.expected_lease.validate()?;
        self.reconciliation.expected_receipt.validate()?;
        validate_descriptor(&self.expected_owner)?;
        if self.expected_owner.state != RuntimeServiceState::Failed {
            bail!("failed-worker maintenance requires the exact Failed service owner");
        }
        Ok(())
    }
}

fn parse_args(args: impl Iterator<Item = OsString>) -> Result<(PathBuf, PathBuf, bool)> {
    let mut args = args;
    let mut config = None;
    let mut request = None;
    let mut apply = false;
    while let Some(flag) = args.next() {
        match flag.to_str() {
            Some("--config") if config.is_none() => {
                config = Some(PathBuf::from(
                    args.next().context("missing --config value")?,
                ))
            }
            Some("--request") if request.is_none() => {
                request = Some(PathBuf::from(
                    args.next().context("missing --request value")?,
                ))
            }
            Some("--apply") if !apply => apply = true,
            _ => bail!("invalid or duplicate failed-worker reconciliation argument"),
        }
    }
    let config: PathBuf = config.context("missing --config")?;
    let request: PathBuf = request.context("missing --request")?;
    if !config.is_absolute() || !request.is_absolute() {
        bail!("maintenance paths must be absolute");
    }
    Ok((config, request, apply))
}

pub(super) fn reconcile(args: impl Iterator<Item = OsString>) -> Result<()> {
    let (config_path, request_path, apply) = parse_args(args)?;
    let request_raw = super::read_stable_absolute_operational_file(&request_path, MAX_BYTES)?;
    let request: Request = serde_json::from_slice(&request_raw)?;
    request.validate()?;
    let config_raw = super::read_stable_absolute_operational_file(&config_path, 65536)?;
    if fullmag_session::hex_sha256(&config_raw) != request.config_sha256 {
        bail!("service config pin changed");
    }
    let config: RuntimeServiceConfig = serde_json::from_slice(&config_raw)?;
    config.validate()?;
    let store = SessionStore::open_existing(&config.store_root)?;
    if config.store_root != store.root() {
        bail!("maintenance store is not canonical");
    }
    let _startup = fullmag_runtime_control::retry_store_writer_busy(|| {
        RuntimeServiceStartupGuard::try_acquire(store.root())
    })?
    .context("maintenance startup gate busy")?;
    let _launch = fullmag_runtime_control::retry_store_writer_busy(|| {
        RuntimeServiceLaunchGuard::try_acquire(store.root())
    })?
    .context("maintenance launch gate busy")?;
    let _owner = RuntimeServiceOwnerLockGuard::try_acquire_existing(store.root())?
        .context("maintenance requires the original native owner to have exited")?;
    let owner_raw = super::read_stable_store_operational_file(
        &store,
        RUNTIME_SERVICE_OWNER_DESCRIPTOR_PATH,
        MAX_BYTES,
    )?;
    let owner: RuntimeServiceOwnerDescriptor = serde_json::from_slice(&owner_raw)?;
    if owner != request.expected_owner
        || owner.target_id != config.target_id
        || fullmag_session::hex_sha256(&owner_raw) != request.owner_sha256
    {
        bail!("failed runtime owner pin changed");
    }
    let r = &request.reconciliation;
    let lease = &r.expected_lease;
    let catalog_path = format!("runs/{}/run_catalog.json", lease.run_id);
    let catalog_raw = super::read_stable_store_operational_file(&store, &catalog_path, MAX_BYTES)?;
    if fullmag_session::hex_sha256(&catalog_raw) != request.expected_catalog_sha256 {
        bail!("failed-worker reconciliation catalog bytes changed");
    }
    let receipt_raw = super::read_stable_store_operational_file(
        &store,
        &r.expected_receipt.relative_path()?,
        MAX_BYTES,
    )?;
    if fullmag_session::hex_sha256(&receipt_raw) != request.expected_receipt_sha256 {
        bail!("failed-worker reconciliation exit receipt bytes changed");
    }
    let current_lease = store
        .read_resource_lease(&lease.run_id, &lease.resource_id, &lease.lease_token)?
        .context("failed-worker reconciliation local lease missing")?;
    if current_lease.state == fullmag_session::FmsResourceLeaseState::Active {
        let path = format!(
            "runs/{}/resource_leases/{}/{}.json",
            lease.run_id, lease.resource_id, lease.lease_token
        );
        let raw = super::read_stable_store_operational_file(&store, &path, MAX_BYTES)?;
        if fullmag_session::hex_sha256(&raw) != request.expected_lease_sha256 {
            bail!("active local lease bytes changed");
        }
    }
    let binding = config
        .host_execution
        .as_ref()
        .context("maintenance has no host ledger binding")?;
    // Cleanup is not execution admission. Keep the configured application and
    // historical policy binding; do not replace it with a candidate generation.
    let ledger = fullmag_runtime_control::retry_store_writer_busy(|| {
        HostResourceLedger::open_for_current_application(
            &binding.ledger_root,
            binding.policy.clone(),
        )
    })?;
    ledger.preview_failed_worker_exit_reconciliation(&store, r)?;
    let proof = if apply {
        let released = ledger.reconcile_failed_worker_after_exit(&store, r)?;
        Some(
            released
                .release_proof_sha256
                .context("normal release proof was not published")?,
        )
    } else {
        None
    };
    if super::read_stable_store_operational_file(&store, &catalog_path, MAX_BYTES)? != catalog_raw {
        bail!("catalog changed during cleanup; retain the request and inspect outcome");
    }
    println!(
        "{}",
        serde_json::json!({
            "schema_version": SCHEMA,
            "request_id": request.request_id,
            "request_sha256": fullmag_session::hex_sha256(&request_raw),
            "disposition": if apply { "released" } else { "validated" },
            "run_id": lease.run_id, "task_id": lease.task_id, "lease_token": lease.lease_token,
            "receipt_id": r.expected_receipt.receipt_id,
            "release_proof_sha256": proof, "task_lifecycle": "failed",
            "solver_replayed": false, "artifacts_requalified": false,
        })
    );
    Ok(())
}

#[cfg(test)]
mod tests {
    use super::*;
    #[test]
    fn maintenance_defaults_to_preview_and_rejects_ambiguous_arguments() {
        let args = [
            "--config",
            "/state/config.json",
            "--request",
            "/control/request.json",
        ];
        assert!(!parse_args(args.into_iter().map(OsString::from)).unwrap().2);
        assert!(
            parse_args(args.into_iter().chain(["--apply"]).map(OsString::from))
                .unwrap()
                .2
        );
        assert!(parse_args(
            args.into_iter()
                .chain(["--apply", "--apply"])
                .map(OsString::from)
        )
        .is_err());
        assert!(parse_args(
            ["--config", "relative", "--request", "/control/request.json"]
                .into_iter()
                .map(OsString::from)
        )
        .is_err());
    }
}
