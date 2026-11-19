//! Operator-requested cancellation for one unclaimed accepted task.
//!
//! This command publishes only the existing durable cancellation intent and
//! asks the host ledger to project it when the normal ownership checks permit.
//! It never changes runtime ownership or starts a solver.

use anyhow::{Context, Result, bail};
use fullmag_session::{
    FmsRunCatalog, FmsTaskCancellationIntent, FmsTaskCatalogEntry, FmsTaskLifecycle, SessionStore,
    repository_path::validate_store_id,
    runtime_service::{
        RUNTIME_SERVICE_OWNER_DESCRIPTOR_PATH, RuntimeServiceConfig, RuntimeServiceLaunchGuard,
        RuntimeServiceOwnerDescriptor, RuntimeServiceOwnerLockGuard, RuntimeServiceState,
        validate_descriptor,
    },
    runtime_service_startup::RuntimeServiceStartupGuard,
};
use serde::{Deserialize, Serialize};
use std::{ffi::OsString, path::PathBuf};

const REQUEST_SCHEMA: &str = "runtime_service_unclaimed_cancellation_request.v1";
const MAX_REQUEST_BYTES: usize = 16 * 1024 * 1024;
const MAX_CATALOG_BYTES: usize = 16 * 1024 * 1024;
const MAX_REASON_BYTES: usize = 4096;

#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
#[serde(deny_unknown_fields)]
struct UnclaimedCancellationRequest {
    schema_version: String,
    request_id: String,
    config_sha256: String,
    owner_sha256: String,
    expected_owner: RuntimeServiceOwnerDescriptor,
    run_id: String,
    task_id: String,
    expected_catalog_revision: u64,
    expected_catalog_sha256: String,
    expected_task: FmsTaskCatalogEntry,
    reason: String,
}

impl UnclaimedCancellationRequest {
    fn validate(&self) -> Result<()> {
        if self.schema_version != REQUEST_SCHEMA {
            bail!("unsupported unclaimed cancellation request schema");
        }
        let request_id = uuid::Uuid::parse_str(&self.request_id)
            .context("unclaimed cancellation request id is not a UUID")?;
        if request_id.is_nil() || request_id.to_string() != self.request_id {
            bail!("unclaimed cancellation request id must be canonical and nonzero");
        }
        for (digest, field) in [
            (&self.config_sha256, "config_sha256"),
            (&self.owner_sha256, "owner_sha256"),
            (&self.expected_catalog_sha256, "expected_catalog_sha256"),
        ] {
            if digest.len() != 64
                || !digest
                    .bytes()
                    .all(|byte| byte.is_ascii_digit() || (b'a'..=b'f').contains(&byte))
            {
                bail!("{field} must be a lowercase SHA-256 digest");
            }
        }
        validate_store_id(&self.run_id).context("unclaimed cancellation run id")?;
        validate_store_id(&self.task_id).context("unclaimed cancellation task id")?;
        if self.expected_catalog_revision == 0 {
            bail!("unclaimed cancellation expected catalog revision must be positive");
        }
        validate_descriptor(&self.expected_owner)?;
        if !matches!(
            self.expected_owner.state,
            RuntimeServiceState::Unknown | RuntimeServiceState::Failed
        ) {
            bail!("unclaimed cancellation requires an Unknown or Failed owner descriptor");
        }
        if self.expected_owner.target_id.trim().is_empty() {
            bail!("unclaimed cancellation owner target id is empty");
        }
        if self.reason.trim().is_empty()
            || self.reason.len() > MAX_REASON_BYTES
            || self.reason.chars().any(char::is_control)
        {
            bail!("unclaimed cancellation reason is empty, too long, or unsafe");
        }
        if self.expected_task.task_id != self.task_id
            || !matches!(
                self.expected_task.lifecycle,
                FmsTaskLifecycle::Accepted | FmsTaskLifecycle::Queued
            )
            || self.expected_task.attempt_id.is_some()
            || self.expected_task.resource_id.is_some()
            || self.expected_task.resolved_input_fingerprint.is_some()
            || self.expected_task.coordinator_watermark.is_some()
            || self.expected_task.coordinator_genesis.is_some()
        {
            bail!(
                "unclaimed cancellation expected task is not an unclaimed accepted or queued task"
            );
        }
        Ok(())
    }
}

fn parse_args(mut args: impl Iterator<Item = OsString>) -> Result<(PathBuf, PathBuf)> {
    let mut config = None;
    let mut request = None;
    while let Some(argument) = args.next() {
        match argument.to_str() {
            Some("--config") => {
                if config.is_some() {
                    bail!("unclaimed cancellation received duplicate --config");
                }
                config = Some(PathBuf::from(args.next().context("missing --config path")?));
            }
            Some("--request") => {
                if request.is_some() {
                    bail!("unclaimed cancellation received duplicate --request");
                }
                request = Some(PathBuf::from(
                    args.next().context("missing --request path")?,
                ));
            }
            Some(value) => bail!("unknown unclaimed cancellation option `{value}`"),
            None => bail!("unclaimed cancellation option is not UTF-8"),
        }
    }
    Ok((
        config.context("unclaimed cancellation requires --config")?,
        request.context("unclaimed cancellation requires --request")?,
    ))
}

fn read_catalog_snapshot(store: &SessionStore, run_id: &str) -> Result<(Vec<u8>, FmsRunCatalog)> {
    let relative = format!("runs/{run_id}/run_catalog.json");
    let bytes = super::read_stable_store_operational_file(store, &relative, MAX_CATALOG_BYTES)?;
    let parsed: FmsRunCatalog = serde_json::from_slice(&bytes)
        .context("parse pinned unclaimed-cancellation run catalog")?;
    parsed.validate()?;
    if parsed.run_id != run_id {
        bail!("unclaimed cancellation run catalog identity differs from its path");
    }
    let typed = store
        .read_run_catalog(run_id)?
        .context("unclaimed cancellation run catalog is missing")?;
    if parsed != typed {
        bail!("raw and typed unclaimed-cancellation run catalogs differ");
    }
    Ok((bytes, typed))
}

fn find_task<'a>(catalog: &'a FmsRunCatalog, task_id: &str) -> Result<&'a FmsTaskCatalogEntry> {
    catalog
        .tasks
        .iter()
        .find(|task| task.task_id == task_id)
        .context("unclaimed cancellation task is missing from its run catalog")
}

fn task_is_snapshot_or_cancelled(
    current: &FmsTaskCatalogEntry,
    expected: &FmsTaskCatalogEntry,
) -> bool {
    if current == expected {
        return true;
    }
    let mut cancelled = expected.clone();
    cancelled.lifecycle = FmsTaskLifecycle::Cancelled;
    current == &cancelled
}

fn validate_intent_matches_request(
    request: &UnclaimedCancellationRequest,
    intent: &FmsTaskCancellationIntent,
) -> Result<()> {
    if intent.cancellation_id != request.request_id
        || intent.run_id != request.run_id
        || intent.task.task_id != request.task_id
        || intent.expected_catalog_revision != request.expected_catalog_revision
        || intent.reason != request.reason
        || intent.task != request.expected_task
    {
        bail!("existing cancellation intent differs from the exact request");
    }
    Ok(())
}

fn validate_replay_scope(
    request: &UnclaimedCancellationRequest,
    intent: &FmsTaskCancellationIntent,
    raw_catalog: &[u8],
    catalog: &FmsRunCatalog,
) -> Result<()> {
    validate_intent_matches_request(request, intent)?;
    if catalog.revision < request.expected_catalog_revision {
        bail!("unclaimed cancellation catalog revision moved backwards");
    }
    let current = find_task(catalog, &request.task_id)?;
    if !task_is_snapshot_or_cancelled(current, &request.expected_task) {
        bail!("unclaimed cancellation task drifted from the exact request snapshot");
    }
    let expected_after_intent = request
        .expected_catalog_revision
        .checked_add(1)
        .context("unclaimed cancellation catalog revision exhausted")?;
    let expected_after_projection = expected_after_intent
        .checked_add(1)
        .context("unclaimed cancellation catalog revision exhausted")?;
    match (catalog.revision, current.lifecycle) {
        (revision, FmsTaskLifecycle::Accepted | FmsTaskLifecycle::Queued)
            if revision == request.expected_catalog_revision
                && fullmag_session::hex_sha256(raw_catalog) == request.expected_catalog_sha256 => {}
        (revision, FmsTaskLifecycle::Accepted | FmsTaskLifecycle::Queued)
            if revision == expected_after_intent => {}
        (revision, FmsTaskLifecycle::Cancelled) if revision == expected_after_projection => {}
        _ => bail!("unclaimed cancellation replay contains unrelated catalog drift"),
    }
    Ok(())
}

pub(super) fn cancel_unclaimed(args: impl Iterator<Item = OsString>) -> Result<()> {
    let (config_path, request_path) = parse_args(args)?;
    let config_bytes = super::read_stable_absolute_operational_file(&config_path, 65_536)?;
    let config: RuntimeServiceConfig = serde_json::from_slice(&config_bytes)
        .context("parse unclaimed cancellation service config")?;
    config.validate()?;

    let request_bytes =
        super::read_stable_absolute_operational_file(&request_path, MAX_REQUEST_BYTES)?;
    let request: UnclaimedCancellationRequest =
        serde_json::from_slice(&request_bytes).context("parse unclaimed cancellation request")?;
    request.validate()?;
    if fullmag_session::hex_sha256(&config_bytes) != request.config_sha256 {
        bail!("raw runtime service config bytes differ from the cancellation request pin");
    }
    if config.host_execution.is_none() {
        bail!("unclaimed cancellation requires a configured host execution binding");
    }

    let store = SessionStore::open_existing(&config.store_root)?;
    if config.store_root != store.root() {
        bail!("unclaimed cancellation config store root is not the canonical opened store");
    }
    let _startup_guard = fullmag_runtime_control::retry_store_writer_busy(|| {
        RuntimeServiceStartupGuard::try_acquire(store.root())
    })?
    .context("unclaimed cancellation startup gate is busy")?;
    let _launch_guard = fullmag_runtime_control::retry_store_writer_busy(|| {
        RuntimeServiceLaunchGuard::try_acquire(store.root())
    })?
    .context("unclaimed cancellation launch gate is busy")?;
    let _owner_lock_guard = RuntimeServiceOwnerLockGuard::try_acquire_existing(store.root())?
        .context("unclaimed cancellation owner lock is busy or missing")?;

    let owner_bytes = super::read_stable_store_operational_file(
        &store,
        RUNTIME_SERVICE_OWNER_DESCRIPTOR_PATH,
        MAX_REQUEST_BYTES,
    )?;
    let owner: RuntimeServiceOwnerDescriptor = serde_json::from_slice(&owner_bytes)
        .context("parse unclaimed cancellation runtime owner descriptor")?;
    validate_descriptor(&owner)?;
    if owner != request.expected_owner
        || fullmag_session::hex_sha256(&owner_bytes) != request.owner_sha256
        || owner.target_id != config.target_id
        || !matches!(
            owner.state,
            RuntimeServiceState::Unknown | RuntimeServiceState::Failed
        )
    {
        bail!("runtime owner differs from the exact Unknown or Failed cancellation pin");
    }

    // Cancellation does not admit execution. A repaired package may have
    // published a newer readiness generation than the failed owner's config.
    // Keep the configured application/ledger/policy binding, but do not require
    // the obsolete execution generation merely to cancel an unclaimed task.
    let binding = config
        .host_execution
        .as_ref()
        .context("unclaimed cancellation requires a host execution binding")?;
    let ledger = fullmag_runtime_control::retry_store_writer_busy(|| {
        fullmag_session::host_resource_ledger::HostResourceLedger::open_for_current_application(
            &binding.ledger_root,
            binding.policy.clone(),
        )
    })
    .context("open the exact configured ledger for unclaimed cancellation")?;

    let (catalog_bytes, catalog) = read_catalog_snapshot(&store, &request.run_id)?;
    let existing_intent = store.read_task_cancellation_intent(&request.run_id, &request.task_id)?;
    match existing_intent.as_ref() {
        None => {
            if fullmag_session::hex_sha256(&catalog_bytes) != request.expected_catalog_sha256
                || catalog.revision != request.expected_catalog_revision
                || find_task(&catalog, &request.task_id)? != &request.expected_task
            {
                bail!("initial run catalog differs from the exact cancellation request pin");
            }
        }
        Some(intent) => validate_replay_scope(&request, intent, &catalog_bytes, &catalog)?,
    }

    // Let this operation acquire its own store writer. Do not carry a store
    // writer into the subsequent ledger call: its lock order is host, store.
    let (_, intent, _) = store.request_task_cancellation_intent(
        &request.run_id,
        &request.task_id,
        &request.request_id,
        request.expected_catalog_revision,
        &request.reason,
    )?;
    if intent.cancellation_id != request.request_id
        || intent.run_id != request.run_id
        || intent.expected_catalog_revision != request.expected_catalog_revision
        || intent.task != request.expected_task
        || intent.reason != request.reason
    {
        bail!("published cancellation intent differs from the exact request");
    }

    // The ledger method acquires its host and store writers internally. A
    // false result is an intentional defer when an owner/lease remains.
    let projected = ledger.project_unclaimed_task_cancellation(
        &store,
        &request.run_id,
        &request.task_id,
    )?;
    let (_, final_catalog) = read_catalog_snapshot(&store, &request.run_id)?;
    let final_intent = store
        .read_task_cancellation_intent(&request.run_id, &request.task_id)?
        .context("unclaimed cancellation intent disappeared after publication")?;
    validate_intent_matches_request(&request, &final_intent)?;
    let final_task = find_task(&final_catalog, &request.task_id)?;
    let expected_after_projection = request
        .expected_catalog_revision
        .checked_add(2)
        .context("unclaimed cancellation catalog revision exhausted")?;
    let exact_cancelled_projection = final_task.lifecycle == FmsTaskLifecycle::Cancelled
        && task_is_snapshot_or_cancelled(final_task, &request.expected_task)
        && final_catalog.revision == expected_after_projection;
    let disposition = if projected {
        if !exact_cancelled_projection {
            bail!("cancellation projector reported success without the exact Cancelled projection");
        }
        "cancelled"
    } else if exact_cancelled_projection {
        "cancelled"
    } else {
        // The intent is durable even when an admission or owner wins a race
        // after the preflight. The ledger has refused projection, so report a
        // deferred request without treating changed task state as cancellation.
        "cancellation_requested_projection_deferred"
    };
    println!(
        "{}",
        serde_json::to_string(&serde_json::json!({
            "schema_version": REQUEST_SCHEMA,
            "request_id": request.request_id,
            "disposition": disposition,
            "run_id": request.run_id,
            "task_id": request.task_id,
            "catalog_revision": final_catalog.revision,
        }))?
    );
    Ok(())
}
