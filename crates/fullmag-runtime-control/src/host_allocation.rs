//! Translate exact local leases and explicit physical placement into host requests.
//! This adapter does not discover hardware or create a host policy.

use std::collections::{BTreeMap, BTreeSet};

use anyhow::{bail, Context, Result};
use fullmag_application::{ResourceKind, TaskClaim};
use fullmag_session::host_resource_ledger::{
    HostReservationIdentity, HostReservationOwner, HostReservationRequest, HostResourceLedger,
};
use fullmag_session::{FmsPreparationResourceLease, FmsResourceBudget, SessionStore};
/// Placement supplied by the configured topology owner. Empty CPU IDs mean
/// aggregate budgeting, not evidence of affinity or OS enforcement.
pub type HostTaskPlacement = fullmag_session::runtime_service_host::RuntimeServiceHostPlacement;

/// Preserve the authored ordinal. Its physical identity must have been captured
/// in the importing process before the child receives a UUID visibility mask.
pub fn legacy_cuda_device_index(problem: &fullmag_ir::ProblemIR) -> Result<Option<usize>> {
    let index = problem
        .problem_meta
        .runtime_metadata
        .get("runtime_selection")
        .and_then(|selection| selection.get("device_index"))
        .filter(|index| !index.is_null());
    index
        .map(|value| {
            let ordinal = value.as_u64().ok_or_else(|| {
                anyhow::anyhow!("legacy CUDA device_index must be a nonnegative integer")
            })?;
            usize::try_from(ordinal).map_err(anyhow::Error::from)
        })
        .transpose()
}

#[derive(serde::Deserialize)]
#[serde(deny_unknown_fields)]
struct LegacyCudaBinding {
    schema_version: String,
    ordinal: usize,
    cuda_visible_devices: Option<String>,
    gpu_uuid: Option<String>,
    #[serde(default)]
    resolution_error: Option<String>,
}

/// A different eligible offer is a scheduling mismatch, not an intent rewrite.
/// Require the importer's frozen UUID; scheduler ordering may have changed.
pub fn host_gpu_ordinal_matches_placement(
    problem: &fullmag_ir::ProblemIR,
    visible_uuids: &[String],
    policy_uuids: &BTreeMap<String, u64>,
    placement: &HostTaskPlacement,
) -> Result<bool> {
    let Some(ordinal) = legacy_cuda_device_index(problem)? else {
        return Ok(true);
    };
    let value = problem.problem_meta.runtime_metadata
        .get("runtime_selection")
        .and_then(|selection| selection.get("legacy_cuda_binding"))
        .ok_or_else(|| anyhow::anyhow!("legacy CUDA ordinal {ordinal} has no importer UUID binding; choose a physical GPU explicitly"))?;
    if !value
        .as_object()
        .is_some_and(|object| object.contains_key("cuda_visible_devices"))
    {
        bail!("legacy CUDA binding is missing the importing process visibility mask");
    }
    let binding: LegacyCudaBinding = serde_json::from_value(value.clone())?;
    if binding.schema_version != "legacy_cuda_binding.v1" || binding.ordinal != ordinal {
        bail!("legacy CUDA binding differs from the authored ordinal or schema");
    }
    // The mask is provenance for the import, not an environment override.
    let _import_visibility = binding.cuda_visible_devices;
    if binding.resolution_error.is_some() {
        bail!("legacy CUDA ordinal {ordinal} could not be resolved by the importer; choose a physical GPU explicitly");
    }
    let uuid = binding
        .gpu_uuid
        .context("legacy CUDA importer binding has no physical UUID")?;
    let suffix = uuid
        .strip_prefix("GPU-")
        .context("legacy CUDA binding requires a full GPU UUID")?;
    if uuid::Uuid::parse_str(suffix)?.to_string() != suffix {
        bail!("legacy CUDA importer UUID must be canonical and complete");
    }
    if !visible_uuids.contains(&uuid) {
        bail!(
            "imported CUDA ordinal {ordinal} is pinned to {uuid}, which is not currently visible"
        );
    }
    if !policy_uuids.contains_key(&uuid) {
        bail!("legacy CUDA ordinal {ordinal} resolves to {uuid}, which is excluded from the physical host policy");
    }
    Ok(placement.gpu_uuid.as_ref() == Some(&uuid))
}

/// Pin the claim's local offer, attempt and budget to one physical host request.
/// A GPU UUID must be supplied explicitly, even if the local offer label embeds
/// a UUID. Its identity and capacity are checked by the host ledger at admission.
/// For a fresh claim, `expected_runtime_generation_sha256` is the immutable
/// service pin; once a durable lease exists, its binding is authoritative.
pub fn host_request_for_task_claim(
    store: &SessionStore,
    ledger: &HostResourceLedger,
    claim: &TaskClaim,
    placement: &HostTaskPlacement,
    expected_runtime_generation_sha256: Option<&str>,
) -> Result<HostReservationRequest> {
    let runtime_generation_sha256 =
        task_claim_runtime_generation(store, claim, expected_runtime_generation_sha256)?;
    let gpu = match claim.lease.kind {
        ResourceKind::Cpu => {
            if placement.gpu_uuid.is_some() || claim.lease.budget.gpu_memory_bytes != 0 {
                bail!("CPU host allocation cannot carry a GPU placement or VRAM budget");
            }
            None
        }
        ResourceKind::Gpu => {
            let uuid = placement.gpu_uuid.as_ref().ok_or_else(|| {
                anyhow::anyhow!("GPU host allocation requires an explicit physical UUID")
            })?;
            if claim.lease.budget.gpu_memory_bytes == 0 {
                bail!("GPU host allocation requires a positive per-device VRAM budget");
            }
            Some((uuid.clone(), claim.lease.budget.gpu_memory_bytes))
        }
        _ => bail!("solver host allocation requires a CPU or GPU lease"),
    };
    request(
        ledger,
        HostReservationIdentity {
            store_id: HostResourceLedger::store_id(store.root())?,
            run_id: claim.run_id.as_str().to_owned(),
            task_id: claim.task_id.as_str().to_owned(),
            resource_id: claim.lease.resource_id.clone(),
            lease_token: claim.lease.lease_token.as_str().to_owned(),
            owner: HostReservationOwner::Solver {
                attempt_id: claim.attempt_id.as_str().to_owned(),
                ownership_epoch: claim.ownership_epoch.value(),
            },
        },
        FmsResourceBudget {
            cpu_millis: claim.lease.budget.cpu_millis,
            memory_bytes: claim.lease.budget.memory_bytes,
            storage_bytes: claim.lease.budget.storage_bytes,
            gpu_memory_bytes: 0,
        },
        placement.cpu_ids.clone(),
        gpu,
        runtime_generation_sha256,
    )
}

/// Preparation retains its own process attempt instead of borrowing the solver
/// claim epoch. The host policy and CPU capacity are shared with solver requests.
pub fn host_request_for_preparation_lease(
    store: &SessionStore,
    ledger: &HostResourceLedger,
    lease: &FmsPreparationResourceLease,
    cpu_ids: &BTreeSet<u32>,
) -> Result<HostReservationRequest> {
    lease.validate()?;
    if lease.budget.gpu_memory_bytes != 0 {
        bail!("preparation host allocation cannot reserve solver GPU memory");
    }
    let runtime_generation_sha256 = lease
        .host_launch_binding
        .as_ref()
        .and_then(|binding| binding.runtime_generation_sha256.clone());
    request(
        ledger,
        HostReservationIdentity {
            store_id: HostResourceLedger::store_id(store.root())?,
            run_id: lease.run_id.clone(),
            task_id: lease.task_id.clone(),
            resource_id: lease.resource_id.clone(),
            lease_token: lease.lease_token.clone(),
            owner: HostReservationOwner::Preparation {
                preparation_attempt_id: lease.preparation_attempt_id.clone(),
            },
        },
        lease.budget.clone(),
        cpu_ids.clone(),
        None,
        runtime_generation_sha256,
    )
}

/// Prefer the durable lease binding over any caller-supplied fallback. A
/// current ledger read is intentionally not a source of execution identity.
fn task_claim_runtime_generation(
    store: &SessionStore,
    claim: &TaskClaim,
    expected_runtime_generation_sha256: Option<&str>,
) -> Result<Option<String>> {
    let durable_lease = store.read_resource_lease(
        claim.run_id.as_str(),
        claim.lease.resource_id.as_str(),
        claim.lease.lease_token.as_str(),
    )?;
    let Some(lease) = durable_lease else {
        return Ok(expected_runtime_generation_sha256.map(str::to_owned));
    };
    if lease.task_id != claim.task_id.as_str()
        || lease.attempt_id != claim.attempt_id.as_str()
        || lease.ownership_epoch != claim.ownership_epoch.value()
    {
        bail!("durable task lease differs from the host allocation claim");
    }
    let Some(binding) = lease.host_launch_binding else {
        // A fresh local lease is durable before host admission attaches its
        // binding. Preserve the immutable service pin for that first request;
        // only an already-attached binding can supersede the caller pin.
        return Ok(expected_runtime_generation_sha256.map(str::to_owned));
    };
    if binding.policy.schema_version
        == fullmag_session::host_resource_ledger::HOST_RESOURCE_LEDGER_POLICY_SCHEMA_V2
    {
        return Ok(Some(
            binding
                .require_runtime_generation_sha256()?
                .to_owned(),
        ));
    }
    Ok(binding.runtime_generation_sha256)
}

fn request(
    ledger: &HostResourceLedger,
    identity: HostReservationIdentity,
    budget: FmsResourceBudget,
    cpu_ids: BTreeSet<u32>,
    gpu: Option<(String, u64)>,
    runtime_generation_sha256: Option<String>,
) -> Result<HostReservationRequest> {
    let policy = ledger.policy();
    let node_policy_revision = ledger
        .read()?
        .node_policy
        .map(|node_policy| node_policy.revision)
        .ok_or_else(|| anyhow::anyhow!("compute host has no configured node policy"))?;
    let compute_node_owner = ledger.current_compute_node_owner_for_admission()?;
    let (exclusive_gpu_uuids, gpu_vram_bytes_by_uuid) = match gpu {
        Some((uuid, bytes)) => (
            BTreeSet::from([uuid.clone()]),
            BTreeMap::from([(uuid, bytes)]),
        ),
        None => (BTreeSet::new(), BTreeMap::new()),
    };
    Ok(HostReservationRequest {
        identity,
        expected_host_id: policy.host_id.clone(),
        expected_policy_revision: policy.revision,
        expected_node_policy_revision: node_policy_revision,
        expected_owner_epoch: policy.owner_epoch,
        expected_compute_node_owner_id: Some(compute_node_owner.host_owner_id),
        expected_compute_node_owner_epoch: Some(compute_node_owner.host_owner_epoch),
        expected_topology_sha256: policy.topology_sha256.clone(),
        runtime_generation_sha256,
        budget,
        exclusive_gpu_uuids,
        gpu_vram_bytes_by_uuid,
        cpu_ids,
        scheduling_priority: 0,
        parallelism: fullmag_ir::compute_resources::ComputeParallelismIR::SingleProcess,
    })
}

#[cfg(test)]
mod tests {
    use super::*;
    use fullmag_application::{
        AttemptId, OwnershipEpoch, ResourceBudget, ResourceLease, RunId, TaskId,
    };
    use fullmag_session::host_resource_ledger::{
        HostResourceLedgerPolicy, HOST_RESOURCE_LEDGER_POLICY_SCHEMA_V1,
    };

    const GPU: &str = "GPU-00000000-0000-4000-8000-000000000001";

    fn fixture() -> (
        tempfile::TempDir,
        SessionStore,
        HostResourceLedger,
        fullmag_session::host_resource_ledger::HostInventoryOwner,
    ) {
        let directory = tempfile::tempdir().unwrap();
        let store = SessionStore::open(directory.path().join("store")).unwrap();
        let application_state_root = directory.path().join("application-state");
        std::fs::create_dir(&application_state_root).unwrap();
        let ledger = HostResourceLedger::initialize_for_application(
            &application_state_root,
            directory.path().join("host"),
            HostResourceLedgerPolicy {
                schema_version: HOST_RESOURCE_LEDGER_POLICY_SCHEMA_V1.into(),
                host_id: "host-1".into(),
                topology_sha256: "a".repeat(64),
                revision: 1,
                owner_epoch: 1,
                total_budget: FmsResourceBudget {
                    cpu_millis: 4000,
                    memory_bytes: 8192,
                    storage_bytes: 8192,
                    gpu_memory_bytes: 0,
                },
                allowed_cpu_ids: BTreeSet::new(),
                gpu_vram_bytes_by_uuid: BTreeMap::from([(GPU.into(), 8192)]),
            },
        )
        .unwrap();
        let inventory_owner = ledger.try_acquire_inventory_owner().unwrap().unwrap();
        let sample = crate::compute_node_probe::sample_compute_node_for_owner(
            &ledger,
            inventory_owner.descriptor(),
            None,
        )
        .unwrap();
        ledger
            .publish_compute_node_snapshot_with_owner(&inventory_owner, &sample)
            .unwrap();
        (directory, store, ledger, inventory_owner)
    }

    fn claim(kind: ResourceKind, gpu_memory_bytes: u64) -> TaskClaim {
        TaskClaim {
            run_id: RunId::parse("run-1").unwrap(),
            task_id: TaskId::parse("task-1").unwrap(),
            attempt_id: AttemptId::parse("attempt-1").unwrap(),
            ownership_epoch: OwnershipEpoch::INITIAL,
            lease: ResourceLease::new(
                format!("local.gpu.{GPU}"),
                kind,
                ResourceBudget {
                    cpu_millis: 1000,
                    memory_bytes: 1024,
                    storage_bytes: 1024,
                    gpu_memory_bytes,
                },
            )
            .unwrap(),
        }
    }

    #[test]
    fn explicit_legacy_ordinals_select_only_the_matching_physical_offer() {
        let other = "GPU-00000000-0000-4000-8000-000000000002".to_owned();
        let visible = vec![GPU.to_owned(), other.clone()];
        let allowed = BTreeMap::from([(GPU.to_owned(), 8192), (other.clone(), 8192)]);
        let placement = HostTaskPlacement {
            cpu_ids: BTreeSet::new(),
            gpu_uuid: Some(GPU.to_owned()),
        };
        for ordinal in [0, 1] {
            let mut problem = fullmag_ir::ProblemIR::bootstrap_example();
            problem.problem_meta.runtime_metadata.insert(
                "runtime_selection".into(),
                serde_json::json!({
                    "device": "cuda", "device_index": ordinal, "gpu_count": 1,
                    "legacy_cuda_binding": {
                        "schema_version": "legacy_cuda_binding.v1",
                        "ordinal": ordinal,
                        "cuda_visible_devices": null,
                        "gpu_uuid": visible[ordinal],
                    }
                }),
            );
            assert_eq!(
                host_gpu_ordinal_matches_placement(&problem, &visible, &allowed, &placement)
                    .unwrap(),
                ordinal == 0
            );
            let reordered = vec![other.clone(), GPU.to_owned()];
            assert_eq!(
                host_gpu_ordinal_matches_placement(&problem, &reordered, &allowed, &placement)
                    .unwrap(),
                ordinal == 0
            );
            assert!(host_gpu_ordinal_matches_placement(
                &problem,
                &visible,
                &BTreeMap::new(),
                &placement
            )
            .is_err());
            assert!(
                host_gpu_ordinal_matches_placement(&problem, &[], &allowed, &placement).is_err()
            );
        }
        let mut problem = fullmag_ir::ProblemIR::bootstrap_example();
        problem.problem_meta.runtime_metadata.insert(
            "runtime_selection".into(),
            serde_json::json!({"device": "gpu", "device_index": null}),
        );
        assert!(host_gpu_ordinal_matches_placement(&problem, &[], &allowed, &placement).unwrap());
    }

    #[test]
    fn indexed_requests_cannot_be_reinterpreted_without_a_successful_import_binding() {
        let mut problem = fullmag_ir::ProblemIR::bootstrap_example();
        let visible = vec![GPU.to_owned()];
        let allowed = BTreeMap::from([(GPU.to_owned(), 8192)]);
        let placement = HostTaskPlacement {
            cpu_ids: BTreeSet::new(),
            gpu_uuid: Some(GPU.to_owned()),
        };
        let bindings = [
            serde_json::Value::Null,
            serde_json::json!({"schema_version": "legacy_cuda_binding.v1", "ordinal": 1,
                "cuda_visible_devices": null, "gpu_uuid": GPU}),
            serde_json::json!({"schema_version": "legacy_cuda_binding.v1", "ordinal": 0,
                "cuda_visible_devices": null, "gpu_uuid": null, "resolution_error": "no driver"}),
            serde_json::json!({"schema_version": "legacy_cuda_binding.v1", "ordinal": 0,
                "gpu_uuid": GPU}),
        ];
        for binding in bindings {
            problem.problem_meta.runtime_metadata.insert(
                "runtime_selection".into(),
                serde_json::json!({"device": "cuda", "device_index": 0,
                    "legacy_cuda_binding": binding}),
            );
            assert!(
                host_gpu_ordinal_matches_placement(&problem, &visible, &allowed, &placement)
                    .is_err()
            );
        }
    }

    #[test]
    fn gpu_offer_label_cannot_replace_explicit_physical_placement() {
        let (_directory, store, ledger, _inventory_owner) = fixture();
        let claim = claim(ResourceKind::Gpu, 2048);
        let mut placement = HostTaskPlacement {
            cpu_ids: BTreeSet::new(),
            gpu_uuid: None,
        };
        assert!(host_request_for_task_claim(&store, &ledger, &claim, &placement, None).is_err());
        placement.gpu_uuid = Some(GPU.into());
        let request =
            host_request_for_task_claim(&store, &ledger, &claim, &placement, None).unwrap();
        assert_eq!(request.budget.gpu_memory_bytes, 0);
        assert_eq!(request.gpu_vram_bytes_by_uuid.get(GPU), Some(&2048));
        assert_eq!(request.identity.resource_id, claim.lease.resource_id);
        assert_eq!(
            request.identity.lease_token,
            claim.lease.lease_token.as_str()
        );
        ledger.reserve(&request).unwrap();
    }

    #[test]
    fn cpu_claim_cannot_acquire_gpu_capacity_from_placement() {
        let (_directory, store, ledger, _inventory_owner) = fixture();
        let placement = HostTaskPlacement {
            cpu_ids: BTreeSet::new(),
            gpu_uuid: Some(GPU.into()),
        };
        assert!(host_request_for_task_claim(
            &store,
            &ledger,
            &claim(ResourceKind::Cpu, 0),
            &placement,
            None
        )
        .is_err());
    }
}
