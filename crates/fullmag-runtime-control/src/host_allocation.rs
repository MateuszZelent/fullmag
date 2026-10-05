//! Translate exact local leases and explicit physical placement into host requests.
//! This adapter does not discover hardware or create a host policy.

use std::collections::{BTreeMap, BTreeSet};

use anyhow::{bail, Result};
use fullmag_application::{ResourceKind, TaskClaim};
use fullmag_session::host_resource_ledger::{
    HostReservationIdentity, HostReservationOwner, HostReservationRequest, HostResourceLedger,
};
use fullmag_session::{FmsPreparationResourceLease, FmsResourceBudget, SessionStore};
use serde::{Deserialize, Serialize};

/// Placement supplied by the configured topology owner. Empty CPU IDs mean
/// aggregate budgeting, not evidence of affinity or OS enforcement.
#[derive(Clone, Debug, PartialEq, Eq, Serialize, Deserialize)]
#[serde(deny_unknown_fields)]
pub struct HostTaskPlacement {
    pub cpu_ids: BTreeSet<u32>,
    pub gpu_uuid: Option<String>,
}

/// Pin the claim's local offer, attempt and budget to one physical host request.
/// A GPU UUID must be supplied explicitly, even if the local offer label embeds
/// a UUID. Its identity and capacity are checked by the host ledger at admission.
pub fn host_request_for_task_claim(
    store: &SessionStore,
    ledger: &HostResourceLedger,
    claim: &TaskClaim,
    placement: &HostTaskPlacement,
) -> Result<HostReservationRequest> {
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
    Ok(request(
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
    ))
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
    Ok(request(
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
    ))
}

fn request(
    ledger: &HostResourceLedger,
    identity: HostReservationIdentity,
    budget: FmsResourceBudget,
    cpu_ids: BTreeSet<u32>,
    gpu: Option<(String, u64)>,
) -> HostReservationRequest {
    let policy = ledger.policy();
    let (exclusive_gpu_uuids, gpu_vram_bytes_by_uuid) = match gpu {
        Some((uuid, bytes)) => (
            BTreeSet::from([uuid.clone()]),
            BTreeMap::from([(uuid, bytes)]),
        ),
        None => (BTreeSet::new(), BTreeMap::new()),
    };
    HostReservationRequest {
        identity,
        expected_host_id: policy.host_id.clone(),
        expected_policy_revision: policy.revision,
        expected_owner_epoch: policy.owner_epoch,
        expected_topology_sha256: policy.topology_sha256.clone(),
        budget,
        exclusive_gpu_uuids,
        gpu_vram_bytes_by_uuid,
        cpu_ids,
    }
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

    fn fixture() -> (tempfile::TempDir, SessionStore, HostResourceLedger) {
        let directory = tempfile::tempdir().unwrap();
        let store = SessionStore::open(directory.path().join("store")).unwrap();
        let ledger = HostResourceLedger::initialize(
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
        (directory, store, ledger)
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
    fn gpu_offer_label_cannot_replace_explicit_physical_placement() {
        let (_directory, store, ledger) = fixture();
        let claim = claim(ResourceKind::Gpu, 2048);
        let mut placement = HostTaskPlacement {
            cpu_ids: BTreeSet::new(),
            gpu_uuid: None,
        };
        assert!(host_request_for_task_claim(&store, &ledger, &claim, &placement).is_err());
        placement.gpu_uuid = Some(GPU.into());
        let request = host_request_for_task_claim(&store, &ledger, &claim, &placement).unwrap();
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
        let (_directory, store, ledger) = fixture();
        let placement = HostTaskPlacement {
            cpu_ids: BTreeSet::new(),
            gpu_uuid: Some(GPU.into()),
        };
        assert!(host_request_for_task_claim(
            &store,
            &ledger,
            &claim(ResourceKind::Cpu, 0),
            &placement
        )
        .is_err());
    }
}
