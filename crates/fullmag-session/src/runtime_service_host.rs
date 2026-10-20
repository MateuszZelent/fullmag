//! Explicit, versioned host binding for one runtime service configuration.
//!
//! Validation checks only the supplied policy and resource offers. It never
//! discovers hardware, opens the ledger, or infers placement from resource IDs.

use std::collections::{BTreeMap, BTreeSet};
use std::path::{Component, PathBuf};

use anyhow::{bail, Context, Result};
use serde::{Deserialize, Serialize};

use crate::host_resource_ledger::HostResourceLedgerPolicy;
use crate::repository_path::validate_store_id;
use crate::types::{FmsPreparationResourceOffer, FmsResourceKind, FmsSchedulerResourceOffer};

pub const RUNTIME_SERVICE_HOST_EXECUTION_SCHEMA_V1: &str = "runtime_service_host_execution.v1";

const MAX_HOST_SCHEDULER_CONCURRENCY: usize = 32;
const MAX_HOST_RESOURCE_PLACEMENTS: usize = 4096;

/// CPU and optional physical GPU placement for one compute-pool offer.
#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
#[serde(deny_unknown_fields)]
pub struct RuntimeServiceHostPlacement {
    pub cpu_ids: BTreeSet<u32>,
    pub gpu_uuid: Option<String>,
}

/// Immutable service-level binding to one configured host ledger and its
/// explicit resource placement and scheduler concurrency limits.
#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
#[serde(deny_unknown_fields)]
pub struct RuntimeServiceHostExecution {
    pub schema_version: String,
    pub ledger_root: PathBuf,
    pub policy: HostResourceLedgerPolicy,
    /// Digest of the canonical immutable host-readiness blob used by every
    /// strict runtime-readiness admission and launch. Legacy bindings may
    /// omit it so old archives remain readable; v2/v3 execution cannot.
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub runtime_generation_sha256: Option<String>,
    pub compute_max_concurrency: usize,
    pub preparation_max_concurrency: usize,
    pub compute_placements: BTreeMap<String, RuntimeServiceHostPlacement>,
    pub preparation_cpu_ids: BTreeMap<String, BTreeSet<u32>>,
}

impl RuntimeServiceHostExecution {
    pub fn validate(
        &self,
        compute_offers: &[FmsSchedulerResourceOffer],
        preparation_offers: &[FmsPreparationResourceOffer],
    ) -> Result<()> {
        if self.schema_version != RUNTIME_SERVICE_HOST_EXECUTION_SCHEMA_V1 {
            bail!("unsupported runtime service host execution schema");
        }
        if !self.ledger_root.is_absolute()
            || self
                .ledger_root
                .components()
                .any(|component| matches!(component, Component::ParentDir))
        {
            bail!("host ledger root must be absolute without parent traversal");
        }
        self.policy.validate()?;
        if let Some(digest) = self.runtime_generation_sha256.as_deref() {
            crate::types::validate_runtime_generation_sha256(digest)?;
        } else if self.policy.requires_runtime_readiness() {
            bail!("runtime-readiness host execution requires its pinned runtime_generation_sha256");
        }
        if !(1..=MAX_HOST_SCHEDULER_CONCURRENCY).contains(&self.compute_max_concurrency)
            || !(1..=MAX_HOST_SCHEDULER_CONCURRENCY).contains(&self.preparation_max_concurrency)
        {
            bail!("host scheduler concurrency limits must be positive and no greater than 32");
        }
        if self.compute_placements.len() > MAX_HOST_RESOURCE_PLACEMENTS
            || self.preparation_cpu_ids.len() > MAX_HOST_RESOURCE_PLACEMENTS
        {
            bail!("host resource placement maps exceed their bounded entry limit");
        }

        let compute_offer_ids = compute_offers
            .iter()
            .map(|offer| offer.resource_id.as_str())
            .collect::<BTreeSet<_>>();
        let compute_placement_ids = self
            .compute_placements
            .keys()
            .map(String::as_str)
            .collect::<BTreeSet<_>>();
        if compute_offer_ids != compute_placement_ids {
            bail!("compute placement keys must exactly match configured compute offers");
        }
        for offer in compute_offers {
            offer.validate()?;
            validate_offer_budget(
                &self.policy,
                offer.budget.cpu_millis,
                offer.budget.memory_bytes,
                offer.budget.storage_bytes,
                "compute",
                &offer.resource_id,
            )?;
            let placement = self
                .compute_placements
                .get(&offer.resource_id)
                .context("compute offer has no matching host placement")?;
            validate_cpu_placement(
                &self.policy,
                offer.budget.cpu_millis,
                &placement.cpu_ids,
                &offer.resource_id,
            )?;
            match offer.kind {
                FmsResourceKind::Cpu => {
                    if placement.gpu_uuid.is_some() {
                        bail!(
                            "CPU compute offer `{}` cannot have a GPU placement",
                            offer.resource_id
                        );
                    }
                }
                FmsResourceKind::Gpu => {
                    let gpu_uuid = placement
                        .gpu_uuid
                        .as_deref()
                        .context("GPU compute offer requires one explicit physical GPU UUID")?;
                    let capacity = self
                        .policy
                        .gpu_vram_bytes_by_uuid
                        .get(gpu_uuid)
                        .with_context(|| {
                            format!("GPU placement `{gpu_uuid}` is absent from the host policy")
                        })?;
                    if offer.budget.gpu_memory_bytes > *capacity {
                        bail!(
                            "GPU offer `{}` exceeds its configured per-GPU VRAM capacity",
                            offer.resource_id
                        );
                    }
                }
                FmsResourceKind::Storage | FmsResourceKind::Meshing => {
                    bail!("compute offers support only CPU or GPU resources")
                }
            }
        }

        let preparation_offer_ids = preparation_offers
            .iter()
            .map(|offer| offer.resource_id.as_str())
            .collect::<BTreeSet<_>>();
        let preparation_placement_ids = self
            .preparation_cpu_ids
            .keys()
            .map(String::as_str)
            .collect::<BTreeSet<_>>();
        if preparation_offer_ids != preparation_placement_ids {
            bail!("preparation CPU placement keys must exactly match preparation offers");
        }
        for offer in preparation_offers {
            offer.validate()?;
            validate_offer_budget(
                &self.policy,
                offer.budget.cpu_millis,
                offer.budget.memory_bytes,
                offer.budget.storage_bytes,
                "preparation",
                &offer.resource_id,
            )?;
            let cpu_ids = self
                .preparation_cpu_ids
                .get(&offer.resource_id)
                .context("preparation offer has no matching CPU placement")?;
            validate_cpu_placement(
                &self.policy,
                offer.budget.cpu_millis,
                cpu_ids,
                &offer.resource_id,
            )?;
        }
        Ok(())
    }
}

fn validate_offer_budget(
    policy: &HostResourceLedgerPolicy,
    cpu_millis: u64,
    memory_bytes: u64,
    storage_bytes: u64,
    role: &str,
    resource_id: &str,
) -> Result<()> {
    validate_store_id(resource_id)?;
    if cpu_millis > policy.total_budget.cpu_millis
        || memory_bytes > policy.total_budget.memory_bytes
        || storage_bytes > policy.total_budget.storage_bytes
    {
        bail!(
            "{role} offer `{resource_id}` exceeds an aggregate host CPU, RAM, or scratch capacity"
        );
    }
    Ok(())
}

fn validate_cpu_placement(
    policy: &HostResourceLedgerPolicy,
    cpu_millis: u64,
    cpu_ids: &BTreeSet<u32>,
    resource_id: &str,
) -> Result<()> {
    if !cpu_ids.is_subset(&policy.allowed_cpu_ids) {
        bail!("CPU placement for `{resource_id}` exceeds the configured host CPU ID set");
    }
    if !cpu_ids.is_empty() {
        let pinned_capacity = u64::try_from(cpu_ids.len())
            .context("CPU placement ID count does not fit in u64")?
            .checked_mul(1000)
            .context("CPU placement capacity overflowed")?;
        if cpu_millis > pinned_capacity {
            bail!("CPU offer `{resource_id}` exceeds its pinned CPU-millis capacity");
        }
    }
    Ok(())
}
