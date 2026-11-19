//! Operator-only cancellation of the pinned unclaimed Universe task; never repair fingerprints.
use super::*;
use fullmag_session::{FmsRunCatalog, FmsTaskLifecycle};
use std::collections::BTreeMap;

const SCHEMA: &str = "runtime_service_failed_preclaim_cancellation.v1";
const RUN: &str = "run-live-a64208b634566c8860f02400cb9b0a7f78c0a5a2d116c94a7629e613b7ee223f";
const MAX: usize = 16 * 1024 * 1024;

#[derive(Deserialize)]
#[serde(deny_unknown_fields)]
struct Request {
    schema_version: String,
    cancellation_id: String,
    reason: String,
    store_id: String,
    project_id: String,
    config_sha256: String,
    owner_sha256: String,
    process_receipt_sha256: String,
    pid_namespace: String,
    boot_id: String,
    expected_catalog: FmsRunCatalog,
    run_files: BTreeMap<String, String>,
}

fn pin(bytes: &[u8], expected: &str) -> Result<()> {
    if expected.len() != 64 || !expected.bytes().all(|b| b.is_ascii_digit() || (b'a'..=b'f').contains(&b))
        || fullmag_session::hex_sha256(bytes) != expected {
        bail!("preclaim recovery immutable byte pin differs");
    }
    Ok(())
}

fn validate_request(r: &Request) -> Result<()> {
    validate_store_id(&r.cancellation_id)?;
    r.expected_catalog.validate()?;
    let tasks = &r.expected_catalog.tasks;
    if r.schema_version != SCHEMA || r.expected_catalog.run_id != RUN
        || tasks.len() != 1 || r.reason.trim().is_empty() || r.reason.len() > 4096
        || tasks[0].lifecycle != FmsTaskLifecycle::Accepted
        || tasks[0].attempt_id.is_some() || tasks[0].resource_id.is_some()
        || tasks[0].ownership_epoch.is_some() || tasks[0].resolved_input_fingerprint.is_some()
        || tasks[0].coordinator_genesis.is_some() || tasks[0].coordinator_watermark.is_some()
        || !tasks[0].artifact_ids.is_empty() || r.run_files.len() > 256 {
        bail!("preclaim recovery requires the exact single unclaimed accepted task");
    }
    for name in r.run_files.keys() {
        let first = name.split('/').next().unwrap_or("");
        if !matches!(first, "run_catalog.json" | "run_intent.json" | "task_preparation_receipts"
            | "preparation_process_exit_receipts" | "preparation_process_launches" | "preparation_resource_leases") {
            bail!("preclaim recovery contains execution or unsupported run evidence");
        }
    }
    if !r.run_files.contains_key("run_catalog.json") || !r.run_files.contains_key("run_intent.json") {
        bail!("preclaim recovery requires the original catalog and RunIntent pins");
    }
    Ok(())
}

fn catalog_matches(actual: &FmsRunCatalog, original: &FmsRunCatalog, has_intent: bool) -> Result<()> {
    let mut normalized = actual.clone();
    let increment = actual.revision.checked_sub(original.revision).context("catalog revision regressed")?;
    let lifecycle = &actual.tasks.first().context("task missing")?.lifecycle;
    let valid = if !has_intent {
        increment == 0 && *lifecycle == FmsTaskLifecycle::Accepted && actual.updated_at == original.updated_at
    } else {
        (increment <= 1 && *lifecycle == FmsTaskLifecycle::Accepted)
            || (increment == 2 && *lifecycle == FmsTaskLifecycle::Cancelled)
    };
    normalized.revision = original.revision;
    normalized.updated_at = original.updated_at;
    if let Some(task) = normalized.tasks.first_mut() { task.lifecycle = FmsTaskLifecycle::Accepted; }
    if !valid || (increment == 0 && actual.updated_at != original.updated_at) || serde_json::to_value(normalized)? != serde_json::to_value(original)? {
        bail!("catalog changed outside canonical cancellation lifecycle/revision");
    }
    Ok(())
}

fn inventory(root: &Path, path: &Path, result: &mut BTreeMap<String,String>, budget: &mut usize, allowed: &BTreeMap<String,String>) -> Result<()> {
    let relative_path = path.strip_prefix(root)?.to_str().context("non UTF-8 run path")?;
    // The public resolver checks links/reparse points and containment at every level.
    checked_path(root, if relative_path.is_empty() { "run_catalog.json" } else { relative_path })?;
    for row in std::fs::read_dir(path)? {
        let row = row?;
        let relative = row.path().strip_prefix(root)?.to_str().context("non UTF-8 run path")?.to_owned();
        checked_path(root, &relative)?;
        if row.file_type()?.is_dir() {
            if (!allowed.keys().any(|name| name.starts_with(&(relative.clone()+"/")))
                && relative != "task_cancellation_intents")
                || std::fs::read_dir(row.path())?.next().is_none() {
                bail!("run directory is not a nonempty ancestor of pinned evidence");
            }
            inventory(root, &row.path(), result, budget, allowed)?;
        } else {
            if !row.file_type()?.is_file() || result.len() >= 257 { bail!("unsupported run entry"); }
            let data = fullmag_session::repository_path::read_bounded_regular_file(root, &relative, MAX)?;
            *budget = budget.checked_add(data.len()).context("inventory overflow")?;
            if *budget > MAX { bail!("run evidence exceeds bounded recovery budget"); }
            result.insert(relative, fullmag_session::hex_sha256(&data));
        }
    }
    Ok(())
}

fn no_processes(owner: &RuntimeServiceOwnerDescriptor, process: &serde_json::Value) -> Result<()> {
    let api = process["api_pid"].as_u64().context("missing API PID")?;
    let mut forbidden = vec![api, u64::from(owner.pid)];
    forbidden.extend(owner.children.iter().map(|c| u64::from(c.pid)));
    for entry in std::fs::read_dir("/proc")? {
        let entry = entry?;
        let Some(pid) = entry.file_name().to_str().and_then(|s| s.parse::<u64>().ok()) else { continue };
        if pid == u64::from(std::process::id()) { continue; }
        if forbidden.contains(&pid) { bail!("pinned native/API PID still exists"); }
        let command = match std::fs::read(entry.path().join("cmdline")) {
            Ok(value) => value,
            Err(error) if error.kind() == std::io::ErrorKind::NotFound => continue,
            Err(error) => return Err(error.into()),
        };
        let program = std::str::from_utf8(command.split(|b| *b == 0).next().unwrap_or(&[]))?;
        let name = Path::new(program).file_name().and_then(|s| s.to_str()).unwrap_or("");
        if name.starts_with("fullmag") || matches!(name, "cargo" | "rustc" | "make" | "cmake" | "ninja" | "nvcc") {
            bail!("another native Fullmag/build process is alive");
        }
    }
    Ok(())
}

pub(super) fn run(args: impl Iterator<Item=OsString>) -> Result<()> {
    let mut options = BTreeMap::new();
    let mut verify = false;
    let mut args = args;
    while let Some(key) = args.next() {
        let key = key.into_string().map_err(|_| anyhow::anyhow!("non UTF-8 option"))?;
        if key == "--verify-only" && !verify { verify = true; continue; }
        if !matches!(key.as_str(), "--config" | "--request" | "--request-sha256") || options.contains_key(&key) {
            bail!("unknown or duplicate preclaim recovery option");
        }
        options.insert(key, args.next().context("missing option value")?);
    }
    let config_path = PathBuf::from(options.remove("--config").context("config required")?);
    let request_path = PathBuf::from(options.remove("--request").context("request required")?);
    let request_sha = options.remove("--request-sha256").context("request pin required")?
        .into_string().map_err(|_| anyhow::anyhow!("non UTF-8 request pin"))?;
    let raw = read_stable_absolute_operational_file(&request_path, MAX)?;
    pin(&raw, &request_sha)?;
    let r: Request = serde_json::from_slice(&raw)?;
    validate_request(&r)?;
    let config_raw = read_stable_absolute_operational_file(&config_path, 65_536)?;
    pin(&config_raw, &r.config_sha256)?;
    let config: ServiceConfig = serde_json::from_slice(&config_raw)?;
    config.validate()?;
    let store = SessionStore::open_existing(&config.store_root)?;
    let _startup = RuntimeServiceStartupGuard::try_acquire(store.root())?.context("startup gate busy")?;
    let _launch = RuntimeServiceLaunchGuard::try_acquire(store.root())?.context("launch gate busy")?;
    let _owner = RuntimeServiceOwnerLockGuard::try_acquire_existing(store.root())?.context("owner lock busy")?;
    let owner_raw = read_stable_store_operational_file(&store, RUNTIME_SERVICE_OWNER_DESCRIPTOR_PATH, MAX)?;
    pin(&owner_raw, &r.owner_sha256)?;
    let owner: RuntimeServiceOwnerDescriptor = serde_json::from_slice(&owner_raw)?;
    validate_descriptor(&owner)?;
    if owner.state != RuntimeServiceState::Failed || owner.target_id != config.target_id
        || owner.children.len() != 2
        || owner.children.iter().map(|c| c.role.as_str()).collect::<BTreeSet<_>>() != BTreeSet::from(["compute","preparation"])
        || owner.children.iter().any(|c| !matches!(c.status.as_str(),"exited_success"|"exited_failure"))
        || HostResourceLedger::store_id(store.root())? != r.store_id
        || std::fs::read_link("/proc/self/ns/pid")?.to_string_lossy() != r.pid_namespace
        || std::fs::read_to_string("/proc/sys/kernel/random/boot_id")?.trim() != r.boot_id
        || std::env::var("HOSTNAME").ok().as_deref() != Some(owner.host.as_str()) {
        bail!("exact Failed owner, namespace or store identity differs");
    }
    let process_raw = read_stable_absolute_operational_file(
        &config_path.parent().context("config parent missing")?.join("process-tree.json"), MAX)?;
    pin(&process_raw, &r.process_receipt_sha256)?;
    let process: serde_json::Value = serde_json::from_slice(&process_raw)?;
    let ready: RuntimeServiceOwnerDescriptor = serde_json::from_value(process["service_owner"].clone())?;
    let mut expected = owner.clone();
    expected.state = RuntimeServiceState::Ready;
    expected.heartbeat_at = ready.heartbeat_at;
    for child in &mut expected.children { child.status = "running".into(); }
    if ready != expected || ready.heartbeat_at > owner.heartbeat_at
        || process["schema"] != "fullmag.docker-process-tree.v1"
        || process["state"] != "failed_outcome_retained"
        || process["api_exit_code"].as_i64().is_none()
        || process["runtime_pid"] != serde_json::Value::Null
        || process["accepted_store"].as_str() != store.root().to_str() {
        bail!("process receipt differs from the exact failed service");
    }
    no_processes(&owner, &process)?;
    let admission = fullmag_runtime_control::host_runtime::HostRuntimeAdmission::open(&config)?
        .context("physical host admission missing")?;
    admission.ledger().with_container_runtime_recovery_quiescence(|_| {
        let _writer = store.write_transaction()?;
        no_processes(&owner, &process)?;
        let run = &r.expected_catalog.run_id;
        let task = &r.expected_catalog.tasks[0].task_id;
        if !store.list_active_preparation_resource_leases()?.is_empty()
            || store.read_active_resource_lease_for_task(run,task)?.is_some() {
            bail!("active local resources remain");
        }
        let mut files = BTreeMap::new();
        let mut inventory_bytes = 0;
        inventory(&checked_path(store.root(), &format!("runs/{run}"))?,
            &checked_path(store.root(), &format!("runs/{run}"))?, &mut files, &mut inventory_bytes, &r.run_files)?;
        let cancel_path = format!("task_cancellation_intents/{task}.json");
        files.remove(&cancel_path);
        let original_catalog_pin = files.remove("run_catalog.json").context("catalog missing")?;
        let mut expected_files = r.run_files.clone();
        let expected_pin = expected_files.remove("run_catalog.json").context("catalog pin missing")?;
        if files != expected_files { bail!("run evidence inventory changed"); }
        let intent = store.read_task_cancellation_intent(run,task)?;
        let catalog = store.read_run_catalog(run)?.context("catalog missing")?;
        catalog_matches(&catalog,&r.expected_catalog,intent.is_some())?;
        if let Some(intent) = &intent {
            if intent.cancellation_id != r.cancellation_id || intent.reason != r.reason
                || intent.expected_catalog_revision != r.expected_catalog.revision
                || intent.task != r.expected_catalog.tasks[0] {
                bail!("another cancellation intent exists");
            }
            intent.validate_task_scope(&store,&catalog.tasks[0],catalog.revision)?;
        } else if original_catalog_pin != expected_pin { bail!("original catalog bytes changed"); }
        // Validate immutable RunSpec, Study, source/assets and CAS without the task fingerprint guard.
        let accepted = fullmag_runtime_control::load_accepted_study_snapshot(&store,
            &fullmag_application::RunId::parse(run)?, &fullmag_application::ProjectId::parse(&r.project_id)?)?;
        let step = accepted.lowered.steps.iter().find(|step|
            fullmag_session::task_id_for_study_step(run,&step.step_id).ok().as_deref() == Some(task.as_str()))
            .context("accepted task has no canonical lowered step")?;
        let expected_fingerprint = fullmag_application::study_task_input_fingerprint(&accepted.run.specification,step)?;
        let persisted_fingerprint = &r.expected_catalog.tasks[0].input_fingerprint;
        let fingerprint_matches = expected_fingerprint == *persisted_fingerprint;
        if !verify && fingerprint_matches {
            bail!("corrected fingerprint matches: preserve this Run; cancellation is not authorized by this recovery contract");
        }
        store.read_task_preparation_receipt(run,task)?.context("successful preparation receipt missing")?;
        if !verify {
            store.request_task_cancellation_intent(run,task,&r.cancellation_id,r.expected_catalog.revision,&r.reason)?;
            if catalog.tasks[0].lifecycle != FmsTaskLifecycle::Cancelled
                && !admission.ledger().project_unclaimed_task_cancellation(&store,run,task)? {
                bail!("cancellation retained for explicit recovery; projection refused");
            }
            let after = store.read_run_catalog(run)?.context("cancelled catalog missing")?;
            catalog_matches(&after,&r.expected_catalog,true)?;
            if after.tasks[0].lifecycle != FmsTaskLifecycle::Cancelled { bail!("terminal cancellation missing"); }
        }
        println!("{}",serde_json::json!({"schema_version":SCHEMA,"request_sha256":request_sha,
            "run_id":run,"task_id":task,"state":if verify {"verified"} else {"cancelled"},
            "owner_archived":false,"runtime_started":false,"solve_replayed":false,
            "persisted_fingerprint":persisted_fingerprint,"expected_fingerprint":expected_fingerprint,
            "fingerprint_matches":fingerprint_matches}));
        Ok(())
    })
}

#[cfg(test)]
mod tests {
    use super::*;
    fn original() -> FmsRunCatalog { serde_json::from_str(r#"{
  "schema_version": "run_catalog.v1",
  "run_id": "run-live-a64208b634566c8860f02400cb9b0a7f78c0a5a2d116c94a7629e613b7ee223f",
  "revision": 2,
  "updated_at": "2026-10-23T21:59:39.093174003Z",
  "tasks": [
    {
      "task_id": "task-124c948b20ed0b0dd72f6dea2894b5439d75dfa9d35299445963dfadded8bccf",
      "input_fingerprint": "2118aec25de60892d810e3e4999bc6365b1d4cf43695d3c336fcc8332cc32899",
      "lifecycle": "accepted",
      "readiness": {
        "state": "blocked",
        "reason": "awaiting dependency resolution and runtime admission"
      },
      "artifact_ids": []
    }
  ]
}"#).unwrap() }
    #[test]
    fn only_canonical_cancel_changes_are_accepted() {
        let before=original();
        assert!(catalog_matches(&before,&before,false).is_ok());
        let mut after=before.clone();
        after.revision+=2;
        after.tasks[0].lifecycle=FmsTaskLifecycle::Cancelled;
        assert!(catalog_matches(&after,&before,true).is_ok());
        assert!(catalog_matches(&after,&before,false).is_err());
        after.tasks[0].input_fingerprint="f".repeat(64);
        assert!(catalog_matches(&after,&before,true).is_err());
    }
    #[test]
    fn partial_intent_replay_is_bounded_to_two_canonical_revisions() {
        let before=original();
        assert!(catalog_matches(&before,&before,true).is_ok());
        let mut after=before.clone();
        after.revision+=1;
        assert!(catalog_matches(&after,&before,true).is_ok());
        after.tasks[0].lifecycle=FmsTaskLifecycle::Cancelled;
        assert!(catalog_matches(&after,&before,true).is_err());
        after.revision+=1;
        assert!(catalog_matches(&after,&before,true).is_ok());
    }
    #[test]
    fn input_and_readiness_changes_never_become_cancellation() {
        let before=original();
        for lifecycle in [FmsTaskLifecycle::Running,FmsTaskLifecycle::Preparing,FmsTaskLifecycle::Failed] {
            let mut after=before.clone();
            after.tasks[0].lifecycle=lifecycle;
            assert!(catalog_matches(&after,&before,true).is_err());
        }
        let mut after=before.clone();
        after.tasks[0].resource_id=Some("invented-resource".into());
        assert!(catalog_matches(&after,&before,false).is_err());
        after=before.clone();
        after.tasks[0].artifact_ids.push("invented-artifact".into());
        assert!(catalog_matches(&after,&before,false).is_err());
    }
    #[test]
    fn revision_and_attempt_drift_are_rejected() {
        let before=original();
        let mut after=before.clone();
        after.revision+=3;
        assert!(catalog_matches(&after,&before,true).is_err());
        after=before.clone();
        after.tasks[0].attempt_id=Some("invented".into());
        assert!(catalog_matches(&after,&before,false).is_err());
    }
}
