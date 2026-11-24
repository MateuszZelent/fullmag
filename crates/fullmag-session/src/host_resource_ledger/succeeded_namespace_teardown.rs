//! Separate release authority for a successful task whose OS exit is unknown.
//! It never creates an exit receipt, changes task history, or reopens launch.
//! Engine receipts and typed journal/CAS verification belong to the native
//! recovery caller, executed under the host-before-store fence below.
use crate::repository_path::validate_store_id;
use super::*;

pub const SUCCEEDED_NAMESPACE_REQUEST_SCHEMA: &str = "host_succeeded_worker_namespace_teardown_request.v1";
pub const SUCCEEDED_NAMESPACE_INTENT_SCHEMA: &str = "host_succeeded_worker_namespace_teardown_intent.v1";
pub const SUCCEEDED_NAMESPACE_ATTESTATION_SCHEMA: &str = "docker_succeeded_worker_namespace_teardown_attestation.v1";
pub const SUCCEEDED_NAMESPACE_PROOF_SCHEMA: &str = "host_succeeded_worker_namespace_teardown_proof.v1";

#[derive(Debug, Clone, Serialize, Deserialize, PartialEq, Eq)]
#[serde(deny_unknown_fields)]
pub struct SucceededWorkerNamespaceTeardownRequest {
    pub schema_version: String,
    pub request_id: String,
    pub identity: HostReservationIdentity,
    pub host_id: String,
    pub reservation_request_sha256: String,
    pub reservation_before_sha256: String,
    pub lease_before_sha256: String,
    pub runtime_generation_sha256: String,
    pub worker_launch_token: String,
    pub expected_task: crate::FmsTaskCatalogEntry,
    pub catalog_revision: u64,
    pub journal_sha256: String,
    pub inbox_sha256: String,
    pub execution_started_sha256: String,
    pub execution_completed_sha256: String,
    pub artifacts_sha256: String,
    pub config_sha256: String,
    pub original_owner_sha256: String,
    pub producer_source_snapshot_sha256: String,
    pub producer_package_receipt_sha256: String,
    pub docker_engine_id_sha256: String,
    pub old_container_id: String,
    pub old_image_id: String,
    pub compose_project: String,
    pub private_volume_name: String,
    pub pid_namespace: String,
    pub boot_id: String,
    pub cgroup_sha256: String,
}

fn digest(value: &impl Serialize) -> Result<String> {
    Ok(canonical_json_sha256(&serde_json::to_value(value)?))
}
fn canonical_uuid(value: &str) -> Result<()> {
    let parsed = uuid::Uuid::parse_str(value)?;
    if parsed.is_nil() || parsed.hyphenated().to_string() != value {
        bail!("succeeded namespace identity requires a canonical UUID");
    }
    Ok(())
}
fn label(value: &str) -> Result<()> {
    if value.is_empty() || value.len() > 512 || value.chars().any(char::is_control) {
        bail!("succeeded namespace label is empty, unbounded, or contains control characters");
    }
    Ok(())
}
impl SucceededWorkerNamespaceTeardownRequest {
    pub fn validate(&self) -> Result<()> {
        if self.schema_version != SUCCEEDED_NAMESPACE_REQUEST_SCHEMA {
            bail!("unsupported succeeded namespace teardown request schema");
        }
        canonical_uuid(&self.request_id)?;
        canonical_uuid(&self.worker_launch_token)?;
        canonical_uuid(&self.boot_id)?;
        self.identity.validate()?;
        validate_sha256(&self.old_container_id, "old container ID")?;
        validate_sha256(self.old_image_id.strip_prefix("sha256:").context("old image requires sha256 prefix")?, "old image ID")?;
        for value in [&self.reservation_request_sha256, &self.reservation_before_sha256,
            &self.lease_before_sha256, &self.runtime_generation_sha256, &self.journal_sha256,
            &self.inbox_sha256, &self.execution_started_sha256, &self.execution_completed_sha256,
            &self.artifacts_sha256, &self.config_sha256, &self.original_owner_sha256,
            &self.producer_source_snapshot_sha256, &self.producer_package_receipt_sha256,
            &self.docker_engine_id_sha256, &self.cgroup_sha256] {
            validate_sha256(value, "succeeded namespace evidence pin")?;
        }
        for value in [&self.host_id, &self.compose_project, &self.private_volume_name, &self.pid_namespace] { label(value)?; }
        let (attempt, epoch) = self.attempt()?;
        self.expected_task.validate(&self.identity.run_id)?;
        if self.catalog_revision == 0 || self.expected_task.task_id != self.identity.task_id
            || self.expected_task.attempt_id.as_deref() != Some(attempt)
            || self.expected_task.ownership_epoch != Some(epoch)
            || self.expected_task.resource_id.as_deref() != Some(self.identity.resource_id.as_str())
            || self.expected_task.lifecycle != crate::FmsTaskLifecycle::Succeeded
            || self.expected_task.artifact_ids.is_empty() {
            bail!("succeeded namespace teardown requires the exact published successful task");
        }
        bounded_json_bytes(self, MAX_RELEASE_PROOF_BYTES, "succeeded namespace request")?;
        Ok(())
    }
    fn attempt(&self) -> Result<(&str, u64)> {
        match &self.identity.owner {
            HostReservationOwner::Solver { attempt_id, ownership_epoch } => Ok((attempt_id, *ownership_epoch)),
            _ => bail!("succeeded namespace teardown requires a solver reservation"),
        }
    }
    pub fn request_sha256(&self) -> Result<String> { self.validate()?; digest(self) }
    pub fn bounded_bytes(&self) -> Result<Vec<u8>> {
        self.validate()?;
        bounded_json_bytes(self, MAX_RELEASE_PROOF_BYTES, "succeeded namespace request")
    }
}

#[derive(Debug, Clone, Serialize, Deserialize, PartialEq, Eq)]
#[serde(deny_unknown_fields)]
pub struct SucceededWorkerNamespaceTeardownIntent {
    pub schema_version: String,
    pub request_sha256: String,
    pub request: SucceededWorkerNamespaceTeardownRequest,
}
impl SucceededWorkerNamespaceTeardownIntent {
    pub fn from_request(request: SucceededWorkerNamespaceTeardownRequest) -> Result<Self> {
        Ok(Self { schema_version: SUCCEEDED_NAMESPACE_INTENT_SCHEMA.into(), request_sha256: request.request_sha256()?, request })
    }
    pub fn validate(&self) -> Result<()> {
        if self.schema_version != SUCCEEDED_NAMESPACE_INTENT_SCHEMA || self.request_sha256 != self.request.request_sha256()? {
            bail!("succeeded namespace intent differs from its exact request");
        }
        Ok(())
    }
    pub fn sha256(&self) -> Result<String> { self.validate()?; digest(self) }
}

#[derive(Debug, Clone, Serialize, Deserialize, PartialEq, Eq)]
#[serde(deny_unknown_fields)]
pub struct SucceededWorkerNamespaceTeardownAttestation {
    pub schema_version: String,
    pub request_sha256: String,
    pub intent_sha256: String,
    pub docker_engine_id_sha256: String,
    pub old_container_id: String,
    pub old_image_id: String,
    pub compose_project: String,
    pub private_volume_name: String,
    pub pid_namespace: String,
    pub boot_id: String,
    pub cgroup_sha256: String,
    pub before_inspect_sha256: String,
    pub stop_signal_receipt_sha256: String,
    pub stopped_inspect_sha256: String,
    pub remove_receipt_sha256: String,
    pub after_inspect_sha256: String,
    pub engine_transport: String,
    pub remove_exit_code: i32,
    pub after_inspect_exit_code: i32,
    pub after_inspect_error: String,
    pub stop_signal: String,
    pub stop_escalated: bool,
    pub stopped_pid: u32,
    pub descendant_count: u32,
    pub finished_at: String,
    pub new_container_id: String,
    pub new_pid_namespace: String,
    pub task_outcome: String,
    pub process_exit_status: String,
    pub solve_replay: bool,
}
impl SucceededWorkerNamespaceTeardownAttestation {
    pub fn validate_for_request(&self, request: &SucceededWorkerNamespaceTeardownRequest, intent_sha256: &str) -> Result<()> {
        request.validate()?;
        if self.schema_version != SUCCEEDED_NAMESPACE_ATTESTATION_SCHEMA
            || self.request_sha256 != request.request_sha256()? || self.intent_sha256 != intent_sha256
            || self.docker_engine_id_sha256 != request.docker_engine_id_sha256
            || self.old_container_id != request.old_container_id || self.old_image_id != request.old_image_id
            || self.compose_project != request.compose_project || self.private_volume_name != request.private_volume_name
            || self.pid_namespace != request.pid_namespace || self.boot_id != request.boot_id
            || self.cgroup_sha256 != request.cgroup_sha256 || self.new_container_id == self.old_container_id
            || self.new_pid_namespace == self.pid_namespace || self.engine_transport != "docker_cli"
            || self.remove_exit_code != 0 || self.after_inspect_exit_code != 1
            || self.after_inspect_error != "no_such_container" || self.stop_signal != "SIGTERM"
            || self.stop_escalated || self.stopped_pid != 0 || self.descendant_count != 0
            || self.task_outcome != "succeeded" || self.process_exit_status != "unknown" || self.solve_replay {
            bail!("succeeded namespace Docker removal attestation differs from the exact intent");
        }
        for value in [&self.intent_sha256, &self.new_container_id, &self.before_inspect_sha256,
            &self.stop_signal_receipt_sha256, &self.stopped_inspect_sha256, &self.remove_receipt_sha256, &self.after_inspect_sha256] {
            validate_sha256(value, "succeeded namespace Engine evidence")?;
        }
        label(&self.new_pid_namespace)?;
        label(&self.finished_at)?;
        let finished = chrono::DateTime::parse_from_rfc3339(&self.finished_at)?;
        if finished.timestamp() <= 0 { bail!("succeeded namespace finished_at is not an observed completion"); }
        Ok(())
    }
    pub fn sha256(&self) -> Result<String> { digest(self) }
    pub fn bounded_bytes(&self) -> Result<Vec<u8>> {
        bounded_json_bytes(self, MAX_RELEASE_PROOF_BYTES, "succeeded namespace Engine attestation")
    }
}

#[derive(Debug, Clone, Serialize, Deserialize, PartialEq, Eq)]
#[serde(deny_unknown_fields)]
pub struct SucceededWorkerNamespaceTeardownReleaseProof {
    pub schema_version: String,
    pub teardown_request_sha256: String,
    pub attestation_sha256: String,
    pub intent_sha256: String,
    pub task_outcome: String,
    pub process_exit_status: String,
    pub solve_replay: bool,
}

pub fn intent_relative_path(request_sha256: &str) -> Result<String> {
    validate_sha256(request_sha256, "succeeded namespace request digest")?;
    Ok(format!("succeeded-namespace-teardowns/{request_sha256}.json"))
}
pub fn attestation_relative_path(attestation_sha256: &str) -> Result<String> {
    validate_sha256(attestation_sha256, "succeeded namespace attestation digest")?;
    Ok(format!("succeeded-namespace-teardowns/attestations/{attestation_sha256}.json"))
}
fn owner_intent_relative_path(request: &SucceededWorkerNamespaceTeardownRequest) -> Result<String> {
    Ok(format!("succeeded-namespace-teardowns/owners/{}.json", digest(&request.identity)?))
}
fn require_owner_intent(root: &Path, request: &SucceededWorkerNamespaceTeardownRequest) -> Result<()> {
    let bytes = read_bounded_regular_file(root, &owner_intent_relative_path(request)?, MAX_RELEASE_PROOF_BYTES)?;
    let intent: SucceededWorkerNamespaceTeardownIntent = serde_json::from_slice(&bytes)?;
    intent.validate()?;
    if intent.request != *request { bail!("succeeded namespace reservation is already bound to another immutable request"); }
    Ok(())
}
fn read_intent(root: &Path, request: &SucceededWorkerNamespaceTeardownRequest) -> Result<Option<SucceededWorkerNamespaceTeardownIntent>> {
    let owner_path = checked_path(root, &owner_intent_relative_path(request)?)?;
    match fs::symlink_metadata(&owner_path) {
        Ok(_) => require_owner_intent(root, request)?,
        Err(error) if error.kind() == std::io::ErrorKind::NotFound => (),
        Err(error) => return Err(error.into()),
    }
    let relative = intent_relative_path(&request.request_sha256()?)?;
    let path = checked_path(root, &relative)?;
    match fs::symlink_metadata(path) {
        Err(e) if e.kind() == std::io::ErrorKind::NotFound => return Ok(None),
        Err(e) => return Err(e.into()),
        Ok(_) => (),
    }
    let bytes = read_bounded_regular_file(root, &relative, MAX_RELEASE_PROOF_BYTES)?;
    let intent: SucceededWorkerNamespaceTeardownIntent = serde_json::from_slice(&bytes)?;
    intent.validate()?;
    if intent.request != *request { bail!("succeeded namespace replay changes immutable request pins"); }
    require_owner_intent(root, request)?;
    Ok(Some(intent))
}
fn validate_reservation(request: &SucceededWorkerNamespaceTeardownRequest, policy: &HostResourceLedgerPolicy, row: &HostResourceReservation) -> Result<()> {
    if row.identity != request.identity || row.host_id != request.host_id || row.host_id != policy.host_id
        || row.request_sha256 != request.reservation_request_sha256
        || row.runtime_generation_sha256.as_deref() != Some(request.runtime_generation_sha256.as_str())
        || row.worker_launch_gate != Some(HostWorkerLaunchGate::Consumed { token: request.worker_launch_token.clone() }) {
        bail!("succeeded namespace reservation identity or consumed gate differs");
    }
    let mut original = row.clone();
    if !matches!(original.state, HostResourceReservationState::Committed | HostResourceReservationState::Released) {
        bail!("succeeded namespace teardown requires a committed or exactly released reservation");
    }
    original.state = HostResourceReservationState::Committed;
    original.release_proof_sha256 = None;
    if digest(&original)? != request.reservation_before_sha256 {
        bail!("succeeded namespace reservation-before pin differs");
    }
    Ok(())
}
pub(super) fn validate_released_lease(request: &SucceededWorkerNamespaceTeardownRequest, lease: &FmsResourceLease) -> Result<()> {
    lease.validate()?;
    let (attempt, epoch) = request.attempt()?;
    if lease.run_id != request.identity.run_id || lease.task_id != request.identity.task_id
        || lease.resource_id != request.identity.resource_id || lease.lease_token != request.identity.lease_token
        || lease.attempt_id != attempt || lease.ownership_epoch != epoch {
        bail!("succeeded namespace local lease identity differs");
    }
    let mut original = lease.clone();
    original.state = FmsResourceLeaseState::Active;
    original.released_at = None;
    if digest(&original)? != request.lease_before_sha256 { bail!("succeeded namespace local lease-before pin differs"); }
    Ok(())
}
fn require_no_other_active_local_leases(store: &SessionStore, request: &SucceededWorkerNamespaceTeardownRequest) -> Result<()> {
    if !store.list_active_preparation_resource_leases()?.is_empty() {
        bail!("succeeded namespace recovery found an active preparation lease");
    }
    let runs = checked_path(store.root(), "runs")?;
    reject_link(&runs)?;
    let mut scanned = 0usize;
    for run in fs::read_dir(runs)? {
        let run = run?;
        reject_link(&run.path())?;
        if !run.file_type()?.is_dir() { bail!("succeeded namespace found a non-directory run"); }
        let run_id = run.file_name().into_string().map_err(|_| anyhow::anyhow!("run ID is not UTF-8"))?;
        validate_store_id(&run_id)?;
        scanned += 1;
        if scanned > MAX_LEDGER_RECORDS { bail!("succeeded namespace local inventory exceeds its bound"); }
        let lease_root = checked_path(store.root(), &format!("runs/{run_id}/resource_leases"))?;
        match fs::symlink_metadata(&lease_root) {
            Err(error) if error.kind() == std::io::ErrorKind::NotFound => continue,
            Err(error) => return Err(error.into()),
            Ok(metadata) if metadata.is_dir() && !metadata.file_type().is_symlink() => (),
            Ok(_) => bail!("succeeded namespace resource lease directory is invalid"),
        }
        for resource in fs::read_dir(lease_root)? {
            let resource = resource?;
            reject_link(&resource.path())?;
            if !resource.file_type()?.is_dir() { bail!("succeeded namespace resource entry is not a directory"); }
            let resource_id = resource.file_name().into_string().map_err(|_| anyhow::anyhow!("resource ID is not UTF-8"))?;
            validate_store_id(&resource_id)?;
            for entry in fs::read_dir(resource.path())? {
                let entry = entry?;
                scanned += 1;
                if scanned > MAX_LEDGER_RECORDS { bail!("succeeded namespace lease inventory exceeds its bound"); }
                let name = entry.file_name().into_string().map_err(|_| anyhow::anyhow!("lease filename is not UTF-8"))?;
                let token = name.strip_suffix(".json").context("succeeded namespace lease filename is not canonical")?;
                validate_store_id(token)?;
                let lease = store.read_resource_lease(&run_id, &resource_id, token)?.context("succeeded namespace enumerated lease disappeared")?;
                lease.validate()?;
                if lease.run_id != run_id || lease.resource_id != resource_id || lease.lease_token != token {
                    bail!("succeeded namespace lease path differs from its durable identity");
                }
                if lease.state == FmsResourceLeaseState::Active && worker_lease_identity(&request.identity.store_id, &lease) != request.identity {
                    bail!("succeeded namespace recovery found another active solver lease");
                }
            }
        }
    }
    Ok(())
}
fn validate_store_evidence(store: &SessionStore, request: &SucceededWorkerNamespaceTeardownRequest) -> Result<FmsResourceLease> {
    require_no_other_active_local_leases(store, request)?;
    let identity = &request.identity;
    let (attempt, epoch) = request.attempt()?;
    let catalog = store.read_run_catalog(&identity.run_id)?.context("succeeded namespace run catalog missing")?;
    catalog.validate()?;
    if catalog.run_id != identity.run_id || catalog.revision != request.catalog_revision || catalog.tasks != vec![request.expected_task.clone()] {
        bail!("succeeded namespace task catalog differs from its successful pin");
    }
    let artifacts = store.read_artifact_catalog(&identity.run_id)?.context("succeeded namespace artifact catalog missing")?;
    artifacts.validate()?;
    if artifacts.run_id != identity.run_id || digest(&artifacts.entries)? != request.artifacts_sha256 || artifacts.entries.is_empty()
        || artifacts.entries.iter().any(|entry| entry.task_id != identity.task_id || entry.attempt_id != attempt
            || entry.ownership_epoch != epoch || entry.status != crate::FmsArtifactStatus::Published)
        || artifacts.entries.iter().map(|entry| &entry.artifact_id).collect::<BTreeSet<_>>()
            != request.expected_task.artifact_ids.iter().collect::<BTreeSet<_>>() {
        bail!("succeeded namespace published artifact catalog differs from its exact task");
    }
    if store.list_worker_process_exit_receipts(&identity.run_id)?.iter().any(|exit| exit.task_id == identity.task_id) {
        bail!("succeeded namespace teardown cannot replace an existing process exit receipt");
    }
    let base = format!("runs/{}/worker-attempts/{}/{}/epoch-{}", identity.run_id, identity.task_id, attempt, epoch);
    let mut execution_identities = Vec::new();
    for (name, pin) in [("worker_execution_started.v1.json", &request.execution_started_sha256),
        ("worker_execution_completed.v1.json", &request.execution_completed_sha256)] {
        let bytes = read_bounded_regular_file(store.root(), &format!("{base}/{name}"), 1024 * 1024)?;
        if crate::hex_sha256(&bytes) != *pin { bail!("succeeded namespace execution receipt pin differs"); }
        let value: serde_json::Value = serde_json::from_slice(&bytes)?;
        let execution = value.get("identity").filter(|value| value.is_object()).context("succeeded namespace execution identity missing")?;
        if execution["claim"]["run_id"] != identity.run_id || execution["claim"]["task_id"] != identity.task_id
            || execution["claim"]["attempt_id"] != attempt || execution["claim"]["ownership_epoch"].as_u64() != Some(epoch) {
            bail!("succeeded namespace Started/Completed identity differs");
        }
        if execution["claim"]["lease"]["resource_id"] != identity.resource_id
            || execution["claim"]["lease"]["lease_token"] != identity.lease_token
            || execution["schema_version"] != "fullmag.accepted_worker_execution.v1"
            || (name == "worker_execution_completed.v1.json"
                && (value["status"] != "completed" || value["completed_step_count"].as_u64().unwrap_or(0) == 0)) {
            bail!("succeeded namespace Started/Completed claim or completion status differs");
        }
        execution_identities.push(execution.clone());
    }
    if execution_identities[0] != execution_identities[1] { bail!("succeeded namespace Started and Completed execution identities differ"); }
    let lease = store.read_resource_lease(&identity.run_id, &identity.resource_id, &identity.lease_token)?
        .context("succeeded namespace exact local lease missing")?;
    validate_released_lease(request, &lease)?;
    Ok(lease)
}
fn outer_proof(request: &SucceededWorkerNamespaceTeardownRequest, attestation: &SucceededWorkerNamespaceTeardownAttestation, intent: &SucceededWorkerNamespaceTeardownIntent) -> Result<HostResourceReleaseProof> {
    attestation.validate_for_request(request, &intent.sha256()?)?;
    Ok(HostResourceReleaseProof {
        schema_version: HOST_RESOURCE_RELEASE_PROOF_SCHEMA_V3.into(),
        kind: HostResourceReleaseProofKind::SucceededWorkerNamespaceTeardown,
        host_id: request.host_id.clone(), store_id: request.identity.store_id.clone(),
        request_sha256: request.reservation_request_sha256.clone(),
        worker_receipt: None, released_worker_lease: None, preparation_receipt: None,
        released_preparation_lease: None, unadmitted_task: None, preparation_launch_owner: None,
        orphan_teardown: None,
        claimed_interruption: None,
        succeeded_namespace_teardown: Some(SucceededWorkerNamespaceTeardownReleaseProof {
            schema_version: SUCCEEDED_NAMESPACE_PROOF_SCHEMA.into(), teardown_request_sha256: request.request_sha256()?,
            attestation_sha256: attestation.sha256()?, intent_sha256: intent.sha256()?,
            task_outcome: "succeeded".into(), process_exit_status: "unknown".into(), solve_replay: false,
        }),
    })
}

impl HostResourceLedger {
    fn succeeded_namespace_store_id(&self, store: &SessionStore, request: &SucceededWorkerNamespaceTeardownRequest,
        candidate: Option<&crate::SucceededRecoveryCandidateStorage>) -> Result<String> {
        let id = match candidate {
            Some(candidate) => candidate.authorize_succeeded_namespace(store.root(), request)?,
            None => Self::store_id(store.root())?,
        };
        if id != request.identity.store_id { bail!("succeeded namespace request belongs to another store"); }
        Ok(id)
    }
    /// The callback MUST validate typed Completed journal, drained inbox, immutable
    /// Engine receipts (when supplied), and native owner/launch/startup fences.
    /// It executes inside host-before-store locks and cannot acquire host again.
    pub fn verify_succeeded_worker_namespace_teardown(&self, store: &SessionStore,
        request: &SucceededWorkerNamespaceTeardownRequest, attestation: Option<&SucceededWorkerNamespaceTeardownAttestation>,
        candidate: Option<&crate::SucceededRecoveryCandidateStorage>, validate: impl FnOnce() -> Result<()>) -> Result<HostResourceReservation> {
        request.validate()?;
        let _host_writer = self.writer.acquire()?;
        let _store_writer = store.write_transaction()?;
        self.succeeded_namespace_store_id(store, request, candidate)?;
        let document = self.read_document_locked()?;
        ensure_worker_orphan_quiescence_locked(self, &document, &request.identity)?;
        let row = document.reservations.iter().find(|row| row.identity == request.identity).context("succeeded namespace exact reservation missing")?;
        validate_reservation(request, document.policy_for_reservation(row)?, row)?;
        let lease = validate_store_evidence(store, request)?;
        validate_reservation_host_binding(&self.root, document.policy_for_reservation(row)?, row, lease.host_launch_binding.as_ref(), "succeeded namespace")?;
        let intent = read_intent(&self.root, request)?;
        if row.state == HostResourceReservationState::Released && lease.state != FmsResourceLeaseState::Released {
            bail!("released succeeded namespace reservation has an active local lease");
        }
        if let Some(attestation) = attestation {
            let intent = intent.as_ref().context("succeeded namespace removal lacks its prior durable intent")?;
            attestation.validate_for_request(request, &intent.sha256()?)?;
            if row.state == HostResourceReservationState::Released || lease.state == FmsResourceLeaseState::Released {
                require_exact_proof_file(&self.root, request, attestation, intent, row)?;
            }
        } else if row.state != HostResourceReservationState::Committed || lease.state != FmsResourceLeaseState::Active {
            bail!("succeeded namespace partial release requires the exact removal attestation");
        }
        validate()?;
        Ok(row.clone())
    }
    /// Archive only after the exact proof-backed local and host release is durable.
    /// The callback owns slot identity checks and archive publication; it executes
    /// while the same host-before-store authority remains held.
    pub fn with_succeeded_namespace_teardown_release_fence<T>(&self, store: &SessionStore,
        request: &SucceededWorkerNamespaceTeardownRequest, attestation: &SucceededWorkerNamespaceTeardownAttestation,
        candidate: Option<&crate::SucceededRecoveryCandidateStorage>,
        operation: impl FnOnce(&HostResourceReservation) -> Result<T>) -> Result<T> {
        request.validate()?;
        let _host_writer = self.writer.acquire()?;
        let _store_writer = store.write_transaction()?;
        self.succeeded_namespace_store_id(store, request, candidate)?;
        let document = self.read_document_locked()?;
        ensure_worker_orphan_quiescence_locked(self, &document, &request.identity)?;
        let row = document.reservations.iter().find(|row| row.identity == request.identity)
            .context("succeeded namespace archive reservation missing")?;
        validate_reservation(request, document.policy_for_reservation(row)?, row)?;
        let lease = validate_store_evidence(store, request)?;
        if row.state != HostResourceReservationState::Released || lease.state != FmsResourceLeaseState::Released {
            bail!("succeeded namespace archive requires durable local and host release");
        }
        validate_reservation_host_binding(&self.root, document.policy_for_reservation(row)?, row,
            lease.host_launch_binding.as_ref(), "succeeded namespace archive")?;
        let intent = read_intent(&self.root, request)?.context("succeeded namespace archive intent missing")?;
        attestation.validate_for_request(request, &intent.sha256()?)?;
        require_exact_proof_file(&self.root, request, attestation, &intent, row)?;
        let proof = read_validated_release_proof(&self.root, document.policy_for_reservation(row)?, row)?;
        if proof.kind != HostResourceReleaseProofKind::SucceededWorkerNamespaceTeardown {
            bail!("succeeded namespace archive has a different release proof kind");
        }
        operation(row)
    }
    /// Publish the immutable intent while retaining committed capacity and all history.
    pub fn begin_succeeded_worker_namespace_teardown(&self, store: &SessionStore,
        request: &SucceededWorkerNamespaceTeardownRequest, candidate: Option<&crate::SucceededRecoveryCandidateStorage>,
        validate: impl FnOnce() -> Result<()>) -> Result<SucceededWorkerNamespaceTeardownIntent> {
        request.validate()?;
        let _host_writer = self.writer.acquire()?;
        let _store_writer = store.write_transaction()?;
        self.succeeded_namespace_store_id(store, request, candidate)?;
        let document = self.read_document_locked()?;
        ensure_worker_orphan_quiescence_locked(self, &document, &request.identity)?;
        let row = document.reservations.iter().find(|row| row.identity == request.identity).context("succeeded namespace reservation missing")?;
        validate_reservation(request, document.policy_for_reservation(row)?, row)?;
        let lease = validate_store_evidence(store, request)?;
        if row.state != HostResourceReservationState::Committed || lease.state != FmsResourceLeaseState::Active {
            bail!("succeeded namespace begin cannot replace a partial or completed release");
        }
        validate_reservation_host_binding(&self.root, document.policy_for_reservation(row)?, row, lease.host_launch_binding.as_ref(), "succeeded namespace")?;
        validate()?;
        let intent = SucceededWorkerNamespaceTeardownIntent::from_request(request.clone())?;
        let owner_relative = owner_intent_relative_path(request)?;
        crate::repository_path::create_parent(&self.root, &owner_relative)?;
        publish_immutable_exact(&self.root, &owner_relative, &bounded_json_bytes(&intent, MAX_RELEASE_PROOF_BYTES, "succeeded namespace owner intent")?, MAX_RELEASE_PROOF_BYTES)?;
        let relative = intent_relative_path(&intent.request_sha256)?;
        crate::repository_path::create_parent(&self.root, &relative)?;
        publish_immutable_exact(&self.root, &relative, &bounded_json_bytes(&intent, MAX_RELEASE_PROOF_BYTES, "succeeded namespace intent")?, MAX_RELEASE_PROOF_BYTES)?;
        Ok(intent)
    }
    /// Durable order: existing intent -> attestation -> proof -> local lease ->
    /// host reservation. Every partial replay requires identical immutable pins.
    pub fn complete_succeeded_worker_namespace_teardown(&self, store: &SessionStore,
        request: &SucceededWorkerNamespaceTeardownRequest, attestation: &SucceededWorkerNamespaceTeardownAttestation,
        candidate: Option<&crate::SucceededRecoveryCandidateStorage>, validate: impl FnOnce() -> Result<()>) -> Result<HostResourceReservation> {
        request.validate()?;
        let _host_writer = self.writer.acquire()?;
        let _store_writer = store.write_transaction()?;
        self.succeeded_namespace_store_id(store, request, candidate)?;
        let mut document = self.read_document_locked()?;
        ensure_worker_orphan_quiescence_locked(self, &document, &request.identity)?;
        let index = document.reservations.iter().position(|row| row.identity == request.identity).context("succeeded namespace reservation missing")?;
        let row = &document.reservations[index];
        validate_reservation(request, document.policy_for_reservation(row)?, row)?;
        let intent = read_intent(&self.root, request)?.context("succeeded namespace immutable intent missing")?;
        attestation.validate_for_request(request, &intent.sha256()?)?;
        let lease = validate_store_evidence(store, request)?;
        validate_reservation_host_binding(&self.root, document.policy_for_reservation(row)?, row, lease.host_launch_binding.as_ref(), "succeeded namespace")?;
        validate()?;
        let proof = outer_proof(request, attestation, &intent)?;
        let proof_bytes = bounded_json_bytes(&proof, MAX_RELEASE_PROOF_BYTES, "succeeded namespace release proof")?;
        let proof_sha256 = crate::hex_sha256(&proof_bytes);
        if row.state == HostResourceReservationState::Released || lease.state == FmsResourceLeaseState::Released {
            require_exact_proof_file(&self.root, request, attestation, &intent, row)?;
            if row.state == HostResourceReservationState::Released {
                if lease.state != FmsResourceLeaseState::Released { bail!("released host reservation has an active local lease"); }
                validate_release_proof(&self.root, document.policy_for_reservation(row)?, row)?;
                return Ok(row.clone());
            }
        }
        let attestation_relative = attestation_relative_path(&attestation.sha256()?)?;
        crate::repository_path::create_parent(&self.root, &attestation_relative)?;
        publish_immutable_exact(&self.root, &attestation_relative, &attestation.bounded_bytes()?, MAX_RELEASE_PROOF_BYTES)?;
        let relative = release_proof_relative_path(&proof_sha256)?;
        crate::repository_path::create_parent(&self.root, &relative)?;
        publish_immutable_exact(&self.root, &relative, &proof_bytes, MAX_RELEASE_PROOF_BYTES)?;
        if lease.state == FmsResourceLeaseState::Active { store.release_resource_lease_unlocked(&lease)?; }
        document.reservations[index].release_proof_sha256 = Some(proof_sha256);
        document.reservations[index].state = HostResourceReservationState::Released;
        validate_ledger_document(&document, &self.root)?;
        self.publish_document_locked(&document)?;
        // Ordinary reader, not a producer-only interpretation, must accept v3.
        validate_release_proof(&self.root, document.policy_for_reservation(&document.reservations[index])?, &document.reservations[index])?;
        Ok(document.reservations[index].clone())
    }
}
fn require_exact_proof_file(root: &Path, request: &SucceededWorkerNamespaceTeardownRequest,
    attestation: &SucceededWorkerNamespaceTeardownAttestation, intent: &SucceededWorkerNamespaceTeardownIntent,
    row: &HostResourceReservation) -> Result<()> {
    let proof = outer_proof(request, attestation, intent)?;
    let bytes = bounded_json_bytes(&proof, MAX_RELEASE_PROOF_BYTES, "succeeded namespace release proof")?;
    let sha = crate::hex_sha256(&bytes);
    if read_bounded_regular_file(root, &attestation_relative_path(&attestation.sha256()?)?, MAX_RELEASE_PROOF_BYTES)? != attestation.bounded_bytes()?
        || read_bounded_regular_file(root, &release_proof_relative_path(&sha)?, MAX_RELEASE_PROOF_BYTES)? != bytes
        || (row.state == HostResourceReservationState::Released && row.release_proof_sha256.as_deref() != Some(sha.as_str())) {
        bail!("succeeded namespace partial replay differs from the durable release proof");
    }
    Ok(())
}
pub(super) fn validate_release_proof_identity(root: &Path, policy: &HostResourceLedgerPolicy,
    row: &HostResourceReservation, nested: &SucceededWorkerNamespaceTeardownReleaseProof) -> Result<()> {
    let relative = intent_relative_path(&nested.teardown_request_sha256)?;
    let bytes = read_bounded_regular_file(root, &relative, MAX_RELEASE_PROOF_BYTES)?;
    let intent: SucceededWorkerNamespaceTeardownIntent = serde_json::from_slice(&bytes)?;
    intent.validate()?;
    require_owner_intent(root, &intent.request)?;
    if intent.request_sha256 != nested.teardown_request_sha256 || intent.sha256()? != nested.intent_sha256 {
        bail!("succeeded namespace proof lost its exact immutable intent");
    }
    validate_reservation(&intent.request, policy, row)?;
    let bytes = read_bounded_regular_file(root, &attestation_relative_path(&nested.attestation_sha256)?, MAX_RELEASE_PROOF_BYTES)?;
    let attestation: SucceededWorkerNamespaceTeardownAttestation = serde_json::from_slice(&bytes)?;
    attestation.validate_for_request(&intent.request, &nested.intent_sha256)?;
    if attestation.sha256()? != nested.attestation_sha256 || nested.schema_version != SUCCEEDED_NAMESPACE_PROOF_SCHEMA
        || nested.task_outcome != "succeeded" || nested.process_exit_status != "unknown" || nested.solve_replay {
        bail!("succeeded namespace proof differs from its immutable removal evidence");
    }
    Ok(())
}

#[cfg(test)]
mod tests {
    use super::*;
    use serde_json::json;
    fn request() -> SucceededWorkerNamespaceTeardownRequest {
        let mut value = json!({
            "schema_version": SUCCEEDED_NAMESPACE_REQUEST_SCHEMA,
            "request_id": "11111111-1111-4111-8111-111111111111",
            "identity": {"store_id": format!("sha256:{}", "a".repeat(64)), "run_id":"run-test",
                "task_id":"task-test", "resource_id":"docker-all.compute.cpu", "lease_token":"lease-test",
                "owner":{"kind":"solver","attempt_id":"attempt-test","ownership_epoch":1}},
            "host_id":"host-test", "worker_launch_token":"22222222-2222-4222-8222-222222222222",
            "expected_task":{"task_id":"task-test","input_fingerprint":"a".repeat(64),"lifecycle":"succeeded",
                "attempt_id":"attempt-test","ownership_epoch":1,"resource_id":"docker-all.compute.cpu","artifact_ids":["artifact-test"]},
            "catalog_revision":1,"old_container_id":"b".repeat(64),"old_image_id":format!("sha256:{}", "c".repeat(64)),
            "compose_project":"fullmag-worktree-test","private_volume_name":"volume-test",
            "pid_namespace":"pid:[123]","boot_id":"33333333-3333-4333-8333-333333333333"
        });
        for field in ["reservation_request_sha256","reservation_before_sha256","lease_before_sha256","runtime_generation_sha256",
            "journal_sha256","inbox_sha256","execution_started_sha256","execution_completed_sha256","artifacts_sha256",
            "config_sha256","original_owner_sha256","producer_source_snapshot_sha256","producer_package_receipt_sha256",
            "docker_engine_id_sha256","cgroup_sha256"] { value[field] = json!("d".repeat(64)); }
        serde_json::from_value(value).unwrap()
    }
    fn attestation(request: &SucceededWorkerNamespaceTeardownRequest) -> SucceededWorkerNamespaceTeardownAttestation {
        let intent = SucceededWorkerNamespaceTeardownIntent::from_request(request.clone()).unwrap();
        let mut value = serde_json::to_value(request).unwrap();
        let mut result = json!({"schema_version":SUCCEEDED_NAMESPACE_ATTESTATION_SCHEMA,
            "request_sha256":request.request_sha256().unwrap(),"intent_sha256":intent.sha256().unwrap(),
            "engine_transport":"docker_cli","remove_exit_code":0,"after_inspect_exit_code":1,"after_inspect_error":"no_such_container",
            "stop_signal":"SIGTERM","stop_escalated":false,"stopped_pid":0,"descendant_count":0,
            "finished_at":"2026-11-04T12:00:00Z","new_container_id":"e".repeat(64),"new_pid_namespace":"pid:[456]",
            "task_outcome":"succeeded","process_exit_status":"unknown","solve_replay":false});
        for field in ["docker_engine_id_sha256","old_container_id","old_image_id","compose_project","private_volume_name","pid_namespace","boot_id","cgroup_sha256"] {
            result[field] = value.as_object_mut().unwrap().remove(field).unwrap();
        }
        for field in ["before_inspect_sha256","stop_signal_receipt_sha256","stopped_inspect_sha256","remove_receipt_sha256","after_inspect_sha256"] { result[field] = json!("f".repeat(64)); }
        serde_json::from_value(result).unwrap()
    }
    #[test]
    fn task_success_and_os_exit_are_separate_and_every_removal_pin_is_exact() {
        let request = request(); request.validate().unwrap();
        let intent = SucceededWorkerNamespaceTeardownIntent::from_request(request.clone()).unwrap();
        let attestation = attestation(&request);
        attestation.validate_for_request(&request,&intent.sha256().unwrap()).unwrap();
        let mut missing_signal_receipt = serde_json::to_value(&attestation).unwrap();
        missing_signal_receipt.as_object_mut().unwrap().remove("stop_signal_receipt_sha256");
        assert!(serde_json::from_value::<SucceededWorkerNamespaceTeardownAttestation>(missing_signal_receipt).is_err());
        for field in ["old_container_id","docker_engine_id_sha256","intent_sha256","private_volume_name","pid_namespace",
            "boot_id","cgroup_sha256","task_outcome","process_exit_status","stop_signal","engine_transport","stop_signal_receipt_sha256"] {
            let mut changed = serde_json::to_value(&attestation).unwrap(); changed[field] = json!("changed");
            let changed: SucceededWorkerNamespaceTeardownAttestation = serde_json::from_value(changed).unwrap();
            assert!(changed.validate_for_request(&request,&intent.sha256().unwrap()).is_err(), "{field}");
        }
        for field in ["stop_escalated","solve_replay"] {
            let mut changed = serde_json::to_value(&attestation).unwrap(); changed[field] = json!(true);
            let changed: SucceededWorkerNamespaceTeardownAttestation = serde_json::from_value(changed).unwrap();
            assert!(changed.validate_for_request(&request,&intent.sha256().unwrap()).is_err());
        }
    }
    #[test]
    fn partial_operation_cannot_be_reauthorized_by_a_different_request_id() {
        let root = tempfile::tempdir().unwrap(); let request = request();
        let intent = SucceededWorkerNamespaceTeardownIntent::from_request(request.clone()).unwrap();
        let path = owner_intent_relative_path(&request).unwrap();
        crate::repository_path::create_parent(root.path(), &path).unwrap();
        publish_immutable_exact(root.path(), &path, &serde_json::to_vec(&intent).unwrap(), MAX_RELEASE_PROOF_BYTES).unwrap();
        require_owner_intent(root.path(),&request).unwrap();
        let mut changed = request; changed.request_id = "44444444-4444-4444-8444-444444444444".into();
        assert!(require_owner_intent(root.path(),&changed).is_err());
    }
    #[test]
    fn refused_success_and_same_restartable_container_are_not_removal_evidence() {
        let mut request = request();
        request.expected_task.lifecycle = crate::FmsTaskLifecycle::Failed;
        assert!(request.validate().is_err());
        request.expected_task.lifecycle = crate::FmsTaskLifecycle::Succeeded;
        let mut attestation = attestation(&request);
        let intent = SucceededWorkerNamespaceTeardownIntent::from_request(request.clone()).unwrap();
        attestation.new_container_id = request.old_container_id.clone();
        assert!(attestation.validate_for_request(&request,&intent.sha256().unwrap()).is_err());
        let mut value = serde_json::to_value(&request).unwrap();value["unknown_legacy_fallback"] = json!(true);
        assert!(serde_json::from_value::<SucceededWorkerNamespaceTeardownRequest>(value).is_err());
    }
    #[test]
    fn ordinary_release_reader_accepts_exact_v3_and_refuses_legacy_schema_relabel() {
        let root = tempfile::tempdir().unwrap();
        let mut request = request();
        let policy: HostResourceLedgerPolicy = serde_json::from_value(json!({
            "schema_version":HOST_RESOURCE_LEDGER_POLICY_SCHEMA_V1,"host_id":"host-test",
            "topology_sha256":"1".repeat(64),"revision":1,"owner_epoch":1,
            "total_budget":{"cpu_millis":1000,"memory_bytes":1024,"gpu_memory_bytes":0,"storage_bytes":0}
        })).unwrap();
        let mut row: HostResourceReservation = serde_json::from_value(json!({
            "identity":request.identity,"request_sha256":request.reservation_request_sha256,
            "host_id":"host-test","policy_revision":1,"host_owner_epoch":1,
            "runtime_generation_sha256":request.runtime_generation_sha256,"topology_sha256":"1".repeat(64),
            "budget":{"cpu_millis":1000,"memory_bytes":1024,"gpu_memory_bytes":0,"storage_bytes":0},
            "state":"committed","worker_launch_gate":{"state":"consumed","token":request.worker_launch_token}
        })).unwrap();
        request.reservation_before_sha256 = digest(&row).unwrap();
        let intent = SucceededWorkerNamespaceTeardownIntent::from_request(request.clone()).unwrap();
        let attestation = attestation(&request);
        for relative in [intent_relative_path(&intent.request_sha256).unwrap(), owner_intent_relative_path(&request).unwrap()] {
            crate::repository_path::create_parent(root.path(), &relative).unwrap();
            publish_immutable_exact(root.path(), &relative, &serde_json::to_vec(&intent).unwrap(),MAX_RELEASE_PROOF_BYTES).unwrap();
        }
        let relative = attestation_relative_path(&attestation.sha256().unwrap()).unwrap();
        crate::repository_path::create_parent(root.path(), &relative).unwrap();
        publish_immutable_exact(root.path(), &relative,&attestation.bounded_bytes().unwrap(),MAX_RELEASE_PROOF_BYTES).unwrap();
        let mut proof = outer_proof(&request,&attestation,&intent).unwrap();
        for (schema, accepted) in [(HOST_RESOURCE_RELEASE_PROOF_SCHEMA_V3,true),
            (HOST_RESOURCE_RELEASE_PROOF_SCHEMA_V1,false),(HOST_RESOURCE_RELEASE_PROOF_SCHEMA_V2,false)] {
            proof.schema_version = schema.into();
            let bytes = bounded_json_bytes(&proof,MAX_RELEASE_PROOF_BYTES,"fixture proof").unwrap();
            let sha = crate::hex_sha256(&bytes);
            let relative = release_proof_relative_path(&sha).unwrap();
            crate::repository_path::create_parent(root.path(),&relative).unwrap();
            publish_immutable_exact(root.path(),&relative,&bytes,MAX_RELEASE_PROOF_BYTES).unwrap();
            row.state = HostResourceReservationState::Released;
            row.release_proof_sha256 = Some(sha);
            assert_eq!(read_validated_release_proof(root.path(),&policy,&row).is_ok(),accepted,"{schema}");
        }
    }

}
