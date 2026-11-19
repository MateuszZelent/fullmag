//! Explicit recovery of already completed inspection output; never executes a Start.
use super::*;
use fullmag_application::{ProjectId, RunId, TaskLifecycle, WorkerCommand};
use fullmag_session::{FmsResourceLeaseState, FmsTaskLifecycle, ReadTransaction};
use std::ffi::OsString;

const REQUEST_SCHEMA: &str = "fullmag.completed_inspection_publication_recovery_request.v1";
const EVIDENCE_SCHEMA: &str = "fullmag.completed_inspection_publication_recovery.v1";

#[derive(Clone, Serialize, Deserialize)]
#[serde(deny_unknown_fields)]
struct Request {
    schema_version: String,
    project_id: String,
    run_id: String,
    task_id: String,
    attempt_id: String,
    ownership_epoch: u64,
    package_object_ref: String,
    exit_receipt_id: String,
    reason: String,
    expected_evidence: BTreeMap<String, String>,
}

fn hash(value: &impl Serialize) -> Result<String> {
    Ok(fullmag_session::canonical_json_sha256(&serde_json::to_value(value)?))
}

fn require_digest(value: &str) -> Result<()> {
    if value.len() != 64 || !value.bytes().all(|b| matches!(b, b'0'..=b'9' | b'a'..=b'f')) {
        bail!("inspection recovery requires lowercase SHA-256 pins");
    }
    Ok(())
}

impl Request {
    fn validate(&self) -> Result<()> {
        if self.schema_version != REQUEST_SCHEMA || self.ownership_epoch == 0
            || self.reason.trim().is_empty() || self.reason.len() > 1024
            || self.reason.chars().any(char::is_control) {
            bail!("invalid completed inspection recovery request");
        }
        for id in [&self.project_id, &self.run_id, &self.task_id, &self.attempt_id, &self.exit_receipt_id] {
            fullmag_session::repository_path::validate_store_id(id)?;
        }
        require_digest(&self.package_object_ref)?;
        for value in self.expected_evidence.values() { require_digest(value)?; }
        Ok(())
    }
}

struct Verified {
    accepted: fullmag_runtime_control::AcceptedStudySnapshot,
    claim: fullmag_application::TaskClaim,
    step_id: String,
    output: StudyOutputPayload,
    evidence: serde_json::Value,
}

/// Confirm the persisted release, not a heartbeat issued before its ACK.
/// Only the returned local proof changes; journal/lease/worker receipts stay immutable.
fn released_publication_claim(
    genesis: &fullmag_application::TaskClaim,
    replayed: &fullmag_application::TaskClaim,
    lease: &fullmag_session::FmsResourceLease,
    exit_sequence: u64,
) -> Result<fullmag_application::TaskClaim> {
    let genesis_sequence = genesis.lease.heartbeat_sequence;
    if !genesis.is_same_or_renewed_by(replayed)
        || lease.state != FmsResourceLeaseState::Released || lease.released_at.is_none()
        || lease.run_id != replayed.run_id.as_str()
        || lease.task_id != replayed.task_id.as_str()
        || lease.attempt_id != replayed.attempt_id.as_str()
        || lease.ownership_epoch != replayed.ownership_epoch.value()
        || lease.resource_id != replayed.lease.resource_id
        || lease.lease_token != replayed.lease.lease_token.as_str()
        || replayed.lease.kind != fullmag_application::ResourceKind::Cpu
        || lease.kind != fullmag_session::FmsResourceKind::Cpu
        || lease.budget.cpu_millis != replayed.lease.budget.cpu_millis
        || lease.budget.memory_bytes != replayed.lease.budget.memory_bytes
        || lease.budget.gpu_memory_bytes != replayed.lease.budget.gpu_memory_bytes
        || lease.budget.storage_bytes != replayed.lease.budget.storage_bytes
        || lease.heartbeat_sequence < genesis_sequence
        || lease.heartbeat_sequence > replayed.lease.heartbeat_sequence
        || exit_sequence != lease.heartbeat_sequence {
        bail!("inspection recovery requires the exact persisted released CPU lease within the replayed heartbeat range");
    }
    let mut proof = replayed.clone();
    proof.lease.heartbeat_sequence = lease.heartbeat_sequence;
    Ok(proof)
}

fn verify(store: &SessionStore, request: &Request, transaction: Option<&ReadTransaction>, apply: bool) -> Result<Verified> {
    let project = ProjectId::parse(request.project_id.clone()).map_err(|error| anyhow::anyhow!(error.to_string()))?;
    let run = RunId::parse(request.run_id.clone()).map_err(|error| anyhow::anyhow!(error.to_string()))?;
    let accepted = fullmag_runtime_control::load_accepted_study_snapshot(store, &run, &project)?;
    let catalog = store.read_run_catalog(&request.run_id)?.context("recovery run catalog absent")?;
    let task = catalog.tasks.iter().find(|task| task.task_id == request.task_id).context("recovery task absent")?;
    if task.lifecycle != FmsTaskLifecycle::Failed
        || task.attempt_id.as_deref() != Some(&request.attempt_id)
        || task.ownership_epoch != Some(request.ownership_epoch) {
        bail!("inspection recovery requires the exact current Failed attempt");
    }
    let genesis = task.coordinator_genesis.as_ref().context("recovery task has no genesis")?;
    let checkpoint: fullmag_application::CoordinatorCheckpoint = serde_json::from_value(genesis.checkpoint.clone())?;
    let genesis_claim = checkpoint.claim;
    let claim = &genesis_claim;
    if claim.run_id != run || claim.task_id.as_str() != request.task_id
        || claim.attempt_id.as_str() != request.attempt_id || claim.ownership_epoch.value() != request.ownership_epoch {
        bail!("recovery genesis identity differs");
    }
    let recovered = match transaction {
        Some(transaction) => fullmag_runtime_control::recover_coordinator_readonly(store, claim, transaction)?,
        None => fullmag_runtime_control::recover_coordinator(store, claim)?,
    };
    if recovered.coordinator.task().lifecycle != TaskLifecycle::Failed
        || recovered.commands.iter().any(|command| matches!(&command.command, WorkerCommand::Stop { .. })) {
        bail!("inspection recovery refuses non-Failed or stopped attempts");
    }
    if store.read_task_cancellation_intent(&request.run_id, &request.task_id)?.is_some() {
        bail!("inspection recovery refuses a durable cancellation");
    }
    let claim = recovered.coordinator.claim().clone();
    let lease = store.read_resource_lease(&request.run_id, &claim.lease.resource_id, claim.lease.lease_token.as_str())?
        .context("recovery lease absent")?;
    if lease.state != FmsResourceLeaseState::Released || lease.task_id != request.task_id
        || lease.attempt_id != request.attempt_id || lease.ownership_epoch != request.ownership_epoch {
        bail!("inspection recovery requires exact Released lease");
    }
    let exit = store.read_worker_process_exit_receipt(&request.run_id, &request.exit_receipt_id)?
        .context("recovery process exit proof absent")?;
    if exit.run_id != request.run_id || exit.task_id != request.task_id || exit.attempt_id != request.attempt_id
        || exit.ownership_epoch != request.ownership_epoch || exit.lease_token != claim.lease.lease_token.as_str()
        || exit.resource_id != claim.lease.resource_id || exit.status_success || exit.exit_code != Some(1)
        || exit.timed_out || exit.stop_requested
        || !exit.failure_reason.as_deref().is_some_and(|reason| reason.contains("session store writer is busy:")) {
        bail!("inspection recovery requires the exact reaped publication-store conflict");
    }
    let claim = released_publication_claim(&genesis_claim, &claim, &lease, exit.lease_heartbeat_sequence)?;
    let step = accepted.study.steps.iter().find(|step|
        fullmag_session::task_id_for_study_step(&request.run_id, &step.step_id)
            .is_ok_and(|task| task == request.task_id)).context("recovery accepted step absent")?;
    if !step.enabled || !matches!(&step.kind, fullmag_authoring::StudyStepKind::ClosedLoopInspection { .. }) {
        bail!("recovery requires an enabled typed closed-loop inspection");
    }
    validate_inspection_run_parameters(&accepted.run.specification, &step.step_id, true)?;
    let lowered = accepted.lowered.steps.iter().find(|value| value.step_id == step.step_id)
        .context("recovery lowered step absent")?;
    if task.input_fingerprint != fullmag_application::study_task_input_fingerprint(&accepted.run.specification, lowered)? {
        bail!("recovery task input differs from immutable acceptance");
    }
    let preparation = accepted.read_task_preparation(store, &request.task_id)?;
    let fullmag_application::AcceptedPreparationReceipt::ClosedLoop(preparation) = preparation else {
        bail!("recovery preparation is not closed-loop");
    };
    let plan = lowered.execution_plan.as_ref().context("recovery execution plan absent")?;
    let attempt = existing_private_attempt_output_dir(store, &claim)?;
    let started: WorkerExecutionStartedReceipt = read_attempt_receipt(&attempt, WORKER_EXECUTION_STARTED_RECEIPT)?
        .context("recovery Started absent")?;
    let start = recovered.commands.iter().find(|command| command.message_id == started.identity.start_message_id)
        .context("recovery Started has no durable command")?;
    if !matches!(&start.command, WorkerCommand::Start)
        || start.schema_version != fullmag_application::CLOSED_LOOP_WORKER_PROTOCOL_SCHEMA {
        bail!("recovery Started is not its typed durable Start");
    }
    let expected = worker_execution_identity_from_plan(start, &claim, plan, "default")?;
    if !started.identity.matches_same_attempt(&expected) {
        bail!("recovery Started plan or command differs");
    }
    refuse_known_prelaunch_failure(&attempt, &expected)?;
    let maximum = fullmag_runtime_control::study_inspection::inspection_bundle_budget(&claim)?;
    let result = recover_completed_worker_execution(store, &attempt, &expected, &step.outputs, maximum as u64, None, None)?;
    if result.completed_step_count != 1 || result.outputs.len() != 1
        || result.terminal_publication.is_some() || result.accepted_state_ref.is_some() || result.observation_source.is_some() {
        bail!("recovery receipt has another execution shape");
    }
    let output = result.outputs.into_iter().next().context("recovery output absent")?;
    if output.port_id != "inspection" || output.case_id != "default"
        || output.codec_id != fullmag_application::ANTENNA_INSPECTION_BUNDLE_CODEC_ID
        || output.codec_version != fullmag_application::ANTENNA_INSPECTION_BUNDLE_CODEC_VERSION
        || fullmag_session::hex_sha256(&output.bytes) != request.package_object_ref {
        bail!("recovery output differs from the pinned inspection bundle");
    }
    let problem = accepted.catalog.entries().iter().find(|entry| entry.step_id() == step.step_id)
        .context("recovery accepted ProblemIR absent")?.problem();
    fullmag_runtime_control::study_inspection::validate_accepted_inspection_bytes(problem, step, &output.bytes, maximum)?;
    let completed: serde_json::Value = read_attempt_receipt(&attempt, WORKER_EXECUTION_COMPLETED_RECEIPT)?
        .context("recovery Completed absent")?;
    let intent = store.read_run_intent(&request.run_id)?.context("recovery intent absent")?;
    let durable_preparation = store.read_task_preparation_receipt(&request.run_id, &request.task_id)?
        .context("recovery durable preparation absent")?;
    let mut journal = match transaction {
        Some(transaction) => store.read_coordinator_journal_readonly(&request.run_id, transaction)?,
        None => store.read_coordinator_journal(&request.run_id)?,
    };
    journal.sort_by(|a, b| a.entry_id.cmp(&b.entry_id));
    let observed = BTreeMap::from([
        ("run_spec_sha256".to_string(), accepted.run.specification.fingerprint()?),
        ("plan_sha256".to_string(), hash(plan)?),
        ("preparation_sha256".to_string(), hash(&preparation)?),
        ("durable_preparation_sha256".to_string(), hash(&durable_preparation)?),
        ("run_intent_sha256".to_string(), hash(&intent)?),
        ("task_sha256".to_string(), hash(task)?),
        ("lease_sha256".to_string(), hash(&lease)?),
        ("journal_sha256".to_string(), hash(&journal)?),
        ("started_sha256".to_string(), hash(&started)?),
        ("completed_sha256".to_string(), hash(&completed)?),
        ("exit_receipt_sha256".to_string(), hash(&exit)?),
        ("output_sha256".to_string(), request.package_object_ref.clone()),
    ]);
    if (apply || !request.expected_evidence.is_empty()) && request.expected_evidence != observed {
        bail!("recovery proof differs from its preview pins");
    }
    let mut pinned = request.clone();
    pinned.expected_evidence = observed.clone();
    let evidence = serde_json::json!({
        "schema_version": EVIDENCE_SCHEMA, "request_sha256": hash(&pinned)?, "request": pinned,
        "run_id":request.run_id, "task_id":request.task_id, "attempt_id":request.attempt_id,
        "ownership_epoch":request.ownership_epoch, "package_object_ref":request.package_object_ref,
        "output_byte_count":output.bytes.len(), "verified_evidence":observed,
        "original_task_status":"failed", "action":"recover_inspection_only",
        "scientific_assessment":"unassessed",
    });
    let step_id = step.step_id.clone();
    Ok(Verified { accepted, claim, step_id, output, evidence })
}

pub(crate) fn run() -> Result<()> {
    let mut options = BTreeMap::<String, OsString>::new();
    let mut verify_only = false;
    let mut args = std::env::args_os().skip(2);
    while let Some(flag) = args.next() {
        let flag = flag.into_string().map_err(|_| anyhow::anyhow!("recovery option must be UTF-8"))?;
        if flag == "--verify-only" && !verify_only { verify_only = true; continue; }
        if !["--store-root", "--request", "--request-sha256"].contains(&flag.as_str()) {
            bail!("unknown or duplicate recovery option: {flag}");
        }
        let value = args.next().context("recovery option requires a value")?;
        if options.insert(flag, value).is_some() { bail!("duplicate recovery option"); }
    }
    let root = PathBuf::from(options.remove("--store-root").context("recovery requires store-root")?);
    let request_path = PathBuf::from(options.remove("--request").context("recovery requires request")?);
    let pin = options.remove("--request-sha256").context("recovery requires request SHA256")?
        .into_string().map_err(|_| anyhow::anyhow!("request pin is not UTF-8"))?;
    require_digest(&pin)?;
    if !root.is_absolute() || !request_path.is_absolute() { bail!("recovery paths must be absolute"); }
    let raw = fullmag_session::repository_path::read_bounded_regular_file(
        request_path.parent().context("request has no parent")?,
        request_path.file_name().and_then(|name| name.to_str()).context("request filename invalid")?, 256 * 1024)?;
    let value: serde_json::Value = serde_json::from_slice(&raw)?;
    if fullmag_session::canonical_json_sha256(&value) != pin { bail!("recovery request SHA256 differs"); }
    let request: Request = serde_json::from_value(value)?;
    request.validate()?;
    let store = SessionStore::open_existing(&root)?;
    if verify_only {
        let transaction = store.read_transaction()?;
        let verified = verify(&store, &request, Some(&transaction), false)?;
        println!("{}", serde_json::to_string(&serde_json::json!({
            "status":"verified", "read_only":true, "solver_executed":false,
            "proposed_request":verified.evidence["request"], "request_sha256":verified.evidence["request_sha256"],
            "evidence":verified.evidence,
        }))?);
    } else {
        let _transaction = store.write_transaction()?;
        let verified = verify(&store, &request, None, true)?;
        let solution = fullmag_runtime_control::publish_recovered_inspection_solution(
            &store, &verified.accepted, &verified.claim, &verified.step_id, &verified.output, &verified.evidence)?;
        println!("{}", serde_json::to_string(&serde_json::json!({
            "status":"published", "solver_executed":false, "solution":solution,
            "request_sha256":verified.evidence["request_sha256"],
        }))?);
    }
    Ok(())
}

#[cfg(test)]
mod released_publication_claim_tests {
    use super::*;

    fn fixture() -> (fullmag_application::TaskClaim, fullmag_application::TaskClaim, fullmag_session::FmsResourceLease) {
        let genesis: fullmag_application::TaskClaim = serde_json::from_value(serde_json::json!({
            "run_id": "run-proof", "task_id": "task-proof", "attempt_id": "attempt-proof", "ownership_epoch": 1,
            "lease": { "resource_id": "cpu-proof", "kind": "cpu", "lease_token": "lease-proof",
                "heartbeat_sequence": 0, "budget": { "cpu_millis": 1000, "memory_bytes": 4096,
                    "gpu_memory_bytes": 0, "storage_bytes": 8192 } }
        })).unwrap();
        let mut replayed = genesis.clone();
        replayed.lease.heartbeat_sequence = 686;
        let lease: fullmag_session::FmsResourceLease = serde_json::from_value(serde_json::json!({
            "schema_version": fullmag_session::FMS_RESOURCE_LEASE_SCHEMA,
            "run_id": "run-proof", "task_id": "task-proof", "attempt_id": "attempt-proof", "ownership_epoch": 1,
            "resource_id": "cpu-proof", "kind": "cpu", "lease_token": "lease-proof", "state": "released",
            "heartbeat_sequence": 685, "budget": { "cpu_millis": 1000, "memory_bytes": 4096,
                "gpu_memory_bytes": 0, "storage_bytes": 8192 },
            "acquired_at": "2026-10-27T00:00:00Z", "heartbeat_at": "2026-10-27T00:10:00Z",
            "released_at": "2026-10-27T00:10:01Z"
        })).unwrap();
        (genesis, replayed, lease)
    }

    #[test]
    fn issued_heartbeat_after_confirmed_release_changes_only_local_proof() {
        let (genesis, replayed, lease) = fixture();
        let before = (genesis.clone(), replayed.clone(), lease.clone());
        let proof = released_publication_claim(&genesis, &replayed, &lease, 685).unwrap();
        assert_eq!(proof.lease.heartbeat_sequence, 685);
        let mut expected = replayed.clone();
        expected.lease.heartbeat_sequence = 685;
        assert_eq!(proof, expected);
        assert_eq!((genesis, replayed, lease), before);
    }

    #[test]
    fn exit_sequence_and_genesis_replay_range_are_required() {
        let (genesis, replayed, lease) = fixture();
        for exit in [684, 686] {
            assert!(released_publication_claim(&genesis, &replayed, &lease, exit).is_err());
        }
        let mut newer_genesis = genesis.clone();
        newer_genesis.lease.heartbeat_sequence = 686;
        assert!(released_publication_claim(&newer_genesis, &replayed, &lease, 685).is_err());
        let mut future_release = lease.clone();
        future_release.heartbeat_sequence = 687;
        assert!(released_publication_claim(&genesis, &replayed, &future_release, 687).is_err());
        let proof = released_publication_claim(&genesis, &replayed, &lease, 685).unwrap();
        let boundary = proof.clone();
        assert!(released_publication_claim(&boundary, &boundary, &lease, 685).is_ok());
    }

    #[test]
    fn receipt_claim_newer_than_confirmed_release_is_rejected() {
        let (genesis, replayed, lease) = fixture();
        let proof = released_publication_claim(&genesis, &replayed, &lease, 685).unwrap();
        let identity = |claim| WorkerExecutionReceiptIdentity {
            schema_version: WORKER_EXECUTION_RECEIPT_SCHEMA.into(), claim,
            start_message_id: "start-proof".into(), start_sequence: 0,
            case_id: "default".into(), plan_fingerprint: "a".repeat(64),
        };
        let expected = identity(proof);
        // Started and Completed both use this exact shared identity predicate.
        assert!(identity(genesis).matches_same_attempt(&expected));
        assert!(!identity(replayed).matches_same_attempt(&expected));
    }

    #[test]
    fn foreign_released_identity_kind_budget_and_unreleased_lease_are_rejected() {
        let (genesis, replayed, lease) = fixture();
        for field in ["run_id", "task_id", "attempt_id", "ownership_epoch", "resource_id",
            "lease_token", "kind", "cpu_millis", "memory_bytes", "gpu_memory_bytes",
            "storage_bytes", "state", "released_at"] {
            let mut changed = serde_json::to_value(&lease).unwrap();
            match field {
                "ownership_epoch" => changed[field] = serde_json::json!(2),
                "kind" => changed[field] = serde_json::json!("gpu"),
                "state" => changed[field] = serde_json::json!("active"),
                "released_at" => changed[field] = serde_json::Value::Null,
                "cpu_millis" | "memory_bytes" | "gpu_memory_bytes" | "storage_bytes" =>
                    changed["budget"][field] = serde_json::json!(999),
                _ => changed[field] = serde_json::json!("foreign"),
            }
            let changed = serde_json::from_value(changed).unwrap();
            assert!(released_publication_claim(&genesis, &replayed, &changed, 685).is_err(), "{field}");
        }
        let mut foreign_replay = replayed.clone();
        foreign_replay.lease.kind = fullmag_application::ResourceKind::Gpu;
        assert!(released_publication_claim(&genesis, &foreign_replay, &lease, 685).is_err());
        foreign_replay = replayed.clone();
        foreign_replay.lease.budget.memory_bytes += 1;
        assert!(released_publication_claim(&genesis, &foreign_replay, &lease, 685).is_err());
    }
}
