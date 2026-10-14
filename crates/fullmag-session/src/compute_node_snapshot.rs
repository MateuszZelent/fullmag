//! Versioned compute-node inventory and observation snapshot.
//!
//! The inventory digest covers only durable CPU topology/OS constraints and
//! GPU identity, partition, and durable topology bindings. Telemetry and
//! runtime capabilities have separate freshness and revision semantics.

use anyhow::{bail, Context, Result};
use chrono::{DateTime, Duration, Utc};
use serde::{Deserialize, Serialize};
use std::collections::BTreeSet;

/// Schema version for the first public compute-node snapshot model.
pub const COMPUTE_NODE_SNAPSHOT_SCHEMA_V1: &str = "compute_node_snapshot.v1";
/// Schema version that pins samples to the shared-host inventory owner lease.
pub const COMPUTE_NODE_SNAPSHOT_SCHEMA_V2: &str = "compute_node_snapshot.v2";

/// Maximum age for a sample to be considered current.
pub const COMPUTE_NODE_SAMPLE_STALE_AFTER_SECONDS: i64 = 30;

/// Reasons that a probed value or data source may be unavailable.
#[derive(Debug, Clone, Copy, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "snake_case")]
pub enum UnavailableReason {
    /// The source did not report this value.
    NotReported,
    /// The host denied access to the source.
    PermissionDenied,
    /// The source does not provide this value.
    Unsupported,
    /// The probe failed.
    ProbeFailed,
    /// The source could not be reached.
    SourceUnavailable,
    /// The sample timestamp is later than the validation clock.
    FutureTimestamp,
}

/// A reported value that may retain explicitly marked last-known data.
///
/// `last_known` is descriptive only while the status is unavailable; consumers
/// must not treat it as a current measurement or an allocation guarantee.
#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
#[serde(tag = "status", rename_all = "snake_case", deny_unknown_fields)]
#[serde(bound(deserialize = "T: Deserialize<'de>"))]
pub enum Reported<T> {
    /// The value was available from this report.
    Available {
        /// Current value.
        value: T,
    },
    /// The current value could not be reported.
    Unavailable {
        /// Machine-readable reason; arbitrary diagnostic text is not exposed.
        reason: UnavailableReason,
        /// Last-known value, when one exists.
        #[serde(default, skip_serializing_if = "Option::is_none")]
        last_known: Option<T>,
    },
}

impl<T> Reported<T> {
    /// Returns the current or explicitly last-known value, if present.
    pub fn known_value(&self) -> Option<&T> {
        match self {
            Self::Available { value } => Some(value),
            Self::Unavailable { last_known, .. } => last_known.as_ref(),
        }
    }

    /// Returns whether the value is current in this report.
    pub fn is_available(&self) -> bool {
        matches!(self, Self::Available { .. })
    }
}

/// A measurement that is either present or explicitly unavailable.
#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
#[serde(tag = "status", rename_all = "snake_case", deny_unknown_fields)]
pub enum Observation<T> {
    /// A measurement collected from the source.
    Available {
        /// Measured value; zero remains valid only where the domain permits it.
        value: T,
    },
    /// The measurement was not available.
    Unavailable {
        /// Machine-readable reason; arbitrary diagnostic text is not exposed.
        reason: UnavailableReason,
    },
}

impl<T> Observation<T> {
    /// Returns the measured value when available.
    pub fn value(&self) -> Option<&T> {
        match self {
            Self::Available { value } => Some(value),
            Self::Unavailable { .. } => None,
        }
    }
}

/// Origin of a node sample.
#[derive(Debug, Clone, Copy, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "snake_case")]
pub enum SampleSource {
    /// Host operating-system discovery.
    HostOs,
    /// Container or cgroup discovery.
    Container,
    /// Runtime service discovery.
    Runtime,
}

/// Freshness state for a sample.
#[derive(Debug, Clone, Copy, PartialEq, Eq, Serialize, Deserialize)]
#[serde(tag = "status", content = "reason", rename_all = "snake_case")]
pub enum SampleFreshness {
    /// Sample is no more than 30 seconds old.
    Current,
    /// Sample is older than 30 seconds.
    Stale,
    /// Sample cannot be used as a current observation.
    Unavailable(UnavailableReason),
}

/// Time and source metadata for one coherent node sample.
#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
#[serde(deny_unknown_fields)]
pub struct ComputeNodeSample {
    /// Source that produced this sample.
    pub source: SampleSource,
    /// UTC time at which collection completed.
    pub collected_at: DateTime<Utc>,
    /// Freshness published with the sample.
    pub freshness: SampleFreshness,
    /// Probe-level failure, if collection did not complete successfully.
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub error: Option<UnavailableReason>,
}

impl ComputeNodeSample {
    /// Creates a sample and derives its freshness at `now`.
    pub fn new(
        source: SampleSource,
        collected_at: DateTime<Utc>,
        error: Option<UnavailableReason>,
        now: DateTime<Utc>,
    ) -> Self {
        let mut sample = Self {
            source,
            collected_at,
            freshness: SampleFreshness::Current,
            error,
        };
        sample.refresh_freshness_at(now);
        sample
    }

    /// Computes freshness without trusting the serialized freshness field.
    pub fn freshness_at(&self, now: DateTime<Utc>) -> SampleFreshness {
        if self.collected_at > now {
            SampleFreshness::Unavailable(UnavailableReason::FutureTimestamp)
        } else if let Some(reason) = self.error {
            SampleFreshness::Unavailable(reason)
        } else if now.signed_duration_since(self.collected_at.clone())
            > Duration::seconds(COMPUTE_NODE_SAMPLE_STALE_AFTER_SECONDS)
        {
            SampleFreshness::Stale
        } else {
            SampleFreshness::Current
        }
    }

    /// Recomputes the stored freshness from the timestamp and source error.
    pub fn refresh_freshness_at(&mut self, now: DateTime<Utc>) {
        self.freshness = self.freshness_at(now);
    }

    fn validate(&self) -> Result<()> {
        if self.error == Some(UnavailableReason::FutureTimestamp) {
            bail!("future timestamp is derived from collected_at, not a probe error");
        }
        if let Some(error) = self.error {
            match self.freshness {
                SampleFreshness::Unavailable(reason)
                    if reason == error || reason == UnavailableReason::FutureTimestamp => {}
                _ => bail!("sample error requires unavailable freshness"),
            }
        } else if matches!(
            self.freshness,
            SampleFreshness::Unavailable(reason)
                if reason != UnavailableReason::FutureTimestamp
        ) {
            bail!("unavailable sample freshness requires an error reason");
        }
        Ok(())
    }

    fn validate_at(&self, now: DateTime<Utc>) -> Result<()> {
        self.validate()?;
        if self.freshness != self.freshness_at(now) {
            bail!("sample freshness does not match collected_at and the validation time");
        }
        Ok(())
    }
}

/// CPU topology information for one logical processor.
#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
#[serde(deny_unknown_fields)]
pub struct CpuLogicalProcessor {
    /// Operating-system logical CPU identifier. Zero is a valid identifier.
    pub id: u32,
    /// Socket identifier when reported.
    pub socket_id: Option<u32>,
    /// NUMA node identifier when reported.
    pub numa_node_id: Option<u32>,
    /// Physical core identifier when reported.
    pub core_id: Option<u32>,
    /// Sorted logical CPU identifiers sharing this physical core, including `id`.
    pub smt_sibling_ids: Vec<u32>,
    /// Windows processor group identifier when applicable.
    pub processor_group: Option<u16>,
    /// Logical identifier within the Windows processor group when applicable.
    pub group_logical_cpu_id: Option<u16>,
}

/// Complete logical-processor topology available from the host source.
#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
#[serde(deny_unknown_fields)]
pub struct CpuTopology {
    /// Logical processors sorted by operating-system identifier.
    pub logical_cpus: Vec<CpuLogicalProcessor>,
}

impl CpuTopology {
    fn validate(&self) -> Result<()> {
        if self.logical_cpus.is_empty() {
            bail!("available CPU topology must contain at least one logical CPU");
        }
        if self
            .logical_cpus
            .windows(2)
            .any(|pair| pair[0].id >= pair[1].id)
        {
            bail!("CPU logical processors must be sorted and unique by id");
        }

        let ids: BTreeSet<u32> = self.logical_cpus.iter().map(|cpu| cpu.id).collect();
        let mut group_ids = BTreeSet::new();
        for cpu in &self.logical_cpus {
            if cpu.smt_sibling_ids.is_empty()
                || cpu.smt_sibling_ids.windows(2).any(|pair| pair[0] >= pair[1])
                || cpu.smt_sibling_ids.binary_search(&cpu.id).is_err()
            {
                bail!("CPU SMT sibling ids must be sorted, unique, and include the CPU itself");
            }
            if cpu
                .smt_sibling_ids
                .iter()
                .any(|sibling_id| !ids.contains(sibling_id))
            {
                bail!("CPU SMT sibling references an unknown logical CPU");
            }
            if cpu.processor_group.is_some() != cpu.group_logical_cpu_id.is_some() {
                bail!("Windows processor group and group-local CPU id must be supplied together");
            }
            if let (Some(group), Some(local_id)) =
                (cpu.processor_group, cpu.group_logical_cpu_id)
            {
                if !group_ids.insert((group, local_id)) {
                    bail!("Windows processor group logical CPU identities must be unique");
                }
            }
            for sibling_id in &cpu.smt_sibling_ids {
                let sibling = self
                    .logical_cpus
                    .binary_search_by_key(sibling_id, |candidate| candidate.id)
                    .map_err(|_| anyhow::anyhow!("unknown SMT sibling"))?;
                if self.logical_cpus[sibling]
                    .smt_sibling_ids
                    .binary_search(&cpu.id)
                    .is_err()
                {
                    bail!("CPU SMT sibling relationships must be symmetric");
                }
            }
        }
        Ok(())
    }
}

/// Whether the operating system leaves CPU quota unrestricted or applies a cap.
#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
#[serde(tag = "mode", rename_all = "snake_case", deny_unknown_fields)]
pub enum CpuQuota {
    /// No CPU quota is imposed by this source.
    Unlimited,
    /// CPU-equivalent capacity imposed by the source.
    Limited {
        /// Positive capacity in thousandths of one logical CPU.
        capacity_millis: u64,
    },
}

/// Operating-system CPU constraints relevant to placement.
#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
#[serde(deny_unknown_fields)]
pub struct CpuOsConstraints {
    /// Allowed logical CPU identifiers, or an explicit unavailable status.
    pub allowed_logical_cpu_ids: Reported<BTreeSet<u32>>,
    /// CPU quota imposed by the operating system or container runtime.
    pub quota: Reported<CpuQuota>,
}

impl CpuOsConstraints {
    fn validate(&self) -> Result<()> {
        if let Some(allowed_ids) = self.allowed_logical_cpu_ids.known_value() {
            if allowed_ids.is_empty() {
                bail!("an available CPU set must not be empty");
            }
        }
        if let Some(CpuQuota::Limited { capacity_millis }) = self.quota.known_value() {
            if *capacity_millis == 0 {
                bail!("a limited CPU quota must have positive capacity_millis");
            }
        }
        Ok(())
    }
}

/// CPU topology, OS constraints, and current effective capacity.
#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
#[serde(deny_unknown_fields)]
pub struct CpuSnapshot {
    /// Durable CPU topology, with last-known data explicitly marked when stale.
    pub topology: Reported<CpuTopology>,
    /// Durable CPU-set and quota constraints.
    pub os_constraints: CpuOsConstraints,
    /// Current effective CPU-equivalent capacity in thousandths of one logical CPU.
    pub effective_capacity_millis: Observation<u64>,
    /// Current aggregate CPU utilization as an integer percentage.
    pub load_percent: Observation<u8>,
}

impl CpuSnapshot {
    fn validate(&self) -> Result<()> {
        if let Some(topology) = self.topology.known_value() {
            topology.validate()?;
        }
        self.os_constraints.validate()?;
        if let (Some(topology), Some(allowed_ids)) = (
            self.topology.known_value(),
            self.os_constraints.allowed_logical_cpu_ids.known_value(),
        ) {
            let topology_ids: BTreeSet<u32> =
                topology.logical_cpus.iter().map(|cpu| cpu.id).collect();
            if allowed_ids.iter().any(|id| !topology_ids.contains(id)) {
                bail!("CPU OS constraint references an unknown logical CPU");
            }
        }
        if let Observation::Available { value } = &self.effective_capacity_millis {
            if *value == 0 {
                bail!("available effective CPU capacity must be positive");
            }
        }
        if let Observation::Available { value } = &self.load_percent {
            if *value > 100 {
                bail!("CPU load_percent must be between 0 and 100");
            }
        }
        Ok(())
    }
}

/// Memory measurements for the node.
#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
#[serde(deny_unknown_fields)]
pub struct MemorySnapshot {
    /// Total bytes visible to the process or container.
    pub total_bytes: Observation<u64>,
    /// Currently available bytes; zero is valid when the measurement is present.
    pub available_bytes: Observation<u64>,
}

impl MemorySnapshot {
    fn validate(&self) -> Result<()> {
        if matches!(&self.total_bytes, Observation::Available { value } if *value == 0) {
            bail!("available total memory must be positive");
        }
        if let (Some(total), Some(available)) =
            (self.total_bytes.value(), self.available_bytes.value())
        {
            if available > total {
                bail!("available memory exceeds total memory");
            }
        }
        Ok(())
    }
}

/// GPU partition identity.
#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
#[serde(tag = "kind", rename_all = "snake_case", deny_unknown_fields)]
pub enum GpuPartition {
    /// The UUID identifies a whole GPU rather than a partition.
    FullDevice,
    /// An explicit MIG partition and its parent GPU.
    Mig {
        /// Parent GPU UUID.
        parent_gpu_uuid: String,
        /// Stable partition identifier.
        partition_id: String,
    },
    /// The partition kind could not be determined; this is not a full GPU.
    Unknown,
}

/// Durable GPU topology associations.
#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
#[serde(deny_unknown_fields)]
pub struct GpuTopology {
    /// NUMA node identifier when reported.
    pub numa_node_id: Option<u32>,
    /// PCI root or equivalent durable topology identifier when reported.
    pub pci_root_id: Option<String>,
}

/// Public inventory and observation fields for one GPU or GPU partition.
#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
#[serde(deny_unknown_fields)]
pub struct GpuDeviceSnapshot {
    /// Stable full GPU or partition UUID.
    pub uuid: String,
    /// PCI identifier when reported; part of durable topology binding.
    pub pci_id: Reported<String>,
    /// Human-readable device name when reported.
    pub name: Reported<String>,
    /// Local enumeration ordinal; this is not a stable GPU identity.
    pub local_ordinal: Observation<u32>,
    /// Total VRAM bytes when reported.
    pub vram_bytes: Reported<u64>,
    /// Current GPU utilization as an integer percentage.
    pub utilization_percent: Observation<u8>,
    /// Current GPU temperature in thousandths of a degree Celsius.
    pub temperature_millicelsius: Observation<i32>,
    /// Partition identity, including an explicit unknown state.
    pub partition: Reported<GpuPartition>,
    /// NUMA/PCI topology binding when reported.
    pub topology: Reported<GpuTopology>,
    /// Runtime compatibility identifiers for this GPU.
    pub runtime_compatibility: Reported<Vec<String>>,
}

impl GpuDeviceSnapshot {
    fn validate(&self) -> Result<()> {
        validate_identifier(&self.uuid, "GPU UUID")?;
        if let Some(pci_id) = self.pci_id.known_value() {
            validate_public_text(pci_id, "GPU PCI id")?;
        }
        if let Some(name) = self.name.known_value() {
            validate_public_text(name, "GPU name")?;
        }
        if let Some(GpuPartition::Mig {
            parent_gpu_uuid,
            partition_id,
        }) = self.partition.known_value()
        {
            validate_identifier(parent_gpu_uuid, "GPU parent UUID")?;
            validate_identifier(partition_id, "GPU partition id")?;
        }
        if let Some(topology) = self.topology.known_value() {
            if let Some(pci_root_id) = &topology.pci_root_id {
                validate_public_text(pci_root_id, "GPU PCI root id")?;
            }
        }
        if let Some(compatibility) = self.runtime_compatibility.known_value() {
            validate_sorted_identifiers(compatibility, "GPU runtime compatibility")?;
        }
        if let Observation::Available { value } = &self.utilization_percent {
            if *value > 100 {
                bail!("GPU utilization_percent must be between 0 and 100");
            }
        }
        Ok(())
    }
}

/// Runtime capability identifiers reported by the local runtime.
///
/// Identifiers are stable, non-path tokens such as `fdm.gpu` or `fem.cpu`.
pub type RuntimeCapabilities = Reported<Vec<String>>;

/// Whether a resource-control mechanism is enforced by the host.
#[derive(Debug, Clone, Copy, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "snake_case")]
pub enum EnforcementStatus {
    /// The runtime enforces the requested limit or binding.
    Supported,
    /// The setting is advisory and can be exceeded.
    Advisory,
    /// The runtime does not provide this enforcement mechanism.
    Unavailable,
}

/// Enforcement support reported by the node runtime.
#[derive(Debug, Clone, Copy, PartialEq, Eq, Serialize, Deserialize)]
#[serde(deny_unknown_fields)]
pub struct EnforcementSnapshot {
    /// CPU affinity enforcement.
    pub cpu_affinity: EnforcementStatus,
    /// CPU quota enforcement.
    pub cpu_quota: EnforcementStatus,
    /// Memory-cap enforcement.
    pub memory_cap: EnforcementStatus,
    /// GPU visibility enforcement.
    pub gpu_visibility: EnforcementStatus,
    /// Storage-quota enforcement.
    pub storage_quota: EnforcementStatus,
}

/// Input data used to construct a validated snapshot.
#[derive(Debug, Clone, PartialEq, Eq)]
pub struct ComputeNodeSnapshotData {
    /// Stable node identity.
    pub node_id: String,
    /// Operating-system boot identity.
    pub boot_id: String,
    /// V1 stable host-ledger identity, never a PID or operational token.
    pub runtime_owner_id: String,
    /// V1 configured host-policy epoch; not a process or producer epoch.
    pub owner_epoch: u64,
    /// Stable identity of the exclusive shared-host inventory owner (v2).
    pub host_owner_id: Option<String>,
    /// Monotonic shared-host inventory owner lease epoch (v2).
    pub host_owner_epoch: Option<u64>,
    /// Monotonic revision of durable CPU/GPU inventory for this node/boot.
    pub inventory_revision: u64,
    /// Independent revision of runtime capabilities.
    pub capabilities_revision: u64,
    /// CPU topology, OS constraints, and effective capacity.
    pub cpu: CpuSnapshot,
    /// Current memory measurements.
    pub memory: MemorySnapshot,
    /// GPU inventory, sorted by full UUID when available.
    pub gpus: Reported<Vec<GpuDeviceSnapshot>>,
    /// Runtime capability identifiers.
    pub capabilities: RuntimeCapabilities,
    /// Sample source, collection time, and freshness.
    pub sample: ComputeNodeSample,
    /// Enforcement capabilities reported by the runtime.
    pub enforcement: EnforcementSnapshot,
}

/// Versioned, validated snapshot of one compute node.
#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
#[serde(deny_unknown_fields)]
pub struct ComputeNodeSnapshot {
    /// Snapshot schema version.
    pub schema_version: String,
    /// Stable node identity.
    pub node_id: String,
    /// Operating-system boot identity.
    pub boot_id: String,
    /// V1 stable host-ledger identity, never a PID or operational token.
    pub runtime_owner_id: String,
    /// V1 configured host-policy epoch; not a process or producer epoch.
    pub owner_epoch: u64,
    /// Stable identity of the exclusive shared-host inventory owner (v2).
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub host_owner_id: Option<String>,
    /// Monotonic shared-host inventory owner lease epoch (v2).
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub host_owner_epoch: Option<u64>,
    /// Monotonic revision of durable CPU/GPU inventory for this node/boot.
    pub inventory_revision: u64,
    /// SHA-256 of canonical CPU topology/constraints and GPU identity bindings.
    pub inventory_sha256: String,
    /// Independent revision of runtime capabilities.
    pub capabilities_revision: u64,
    /// CPU topology, OS constraints, and effective capacity.
    pub cpu: CpuSnapshot,
    /// Current memory measurements.
    pub memory: MemorySnapshot,
    /// GPU inventory, sorted by full UUID when available.
    pub gpus: Reported<Vec<GpuDeviceSnapshot>>,
    /// Runtime capability identifiers.
    pub capabilities: RuntimeCapabilities,
    /// Sample source, collection time, and freshness.
    pub sample: ComputeNodeSample,
    /// Enforcement capabilities reported by the runtime.
    pub enforcement: EnforcementSnapshot,
}

impl ComputeNodeSnapshot {
    /// Constructs a snapshot, computes its inventory digest, and derives freshness.
    pub fn new(mut data: ComputeNodeSnapshotData, now: DateTime<Utc>) -> Result<Self> {
        let schema_version = match (&data.host_owner_id, data.host_owner_epoch) {
            (None, None) => COMPUTE_NODE_SNAPSHOT_SCHEMA_V1,
            (Some(_), Some(_)) => COMPUTE_NODE_SNAPSHOT_SCHEMA_V2,
            _ => bail!("host_owner_id and host_owner_epoch must be provided together"),
        };
        data.sample.refresh_freshness_at(now.clone());
        let mut snapshot = Self {
            schema_version: schema_version.into(),
            node_id: data.node_id,
            boot_id: data.boot_id,
            runtime_owner_id: data.runtime_owner_id,
            owner_epoch: data.owner_epoch,
            host_owner_id: data.host_owner_id,
            host_owner_epoch: data.host_owner_epoch,
            inventory_revision: data.inventory_revision,
            inventory_sha256: String::new(),
            capabilities_revision: data.capabilities_revision,
            cpu: data.cpu,
            memory: data.memory,
            gpus: data.gpus,
            capabilities: data.capabilities,
            sample: data.sample,
            enforcement: data.enforcement,
        };
        snapshot.inventory_sha256 = snapshot.computed_inventory_sha256()?;
        snapshot.validate_at(now)?;
        Ok(snapshot)
    }

    /// Builds the next durable observation while preserving independent
    /// inventory and capability revisions for the same node and boot.
    pub fn successor(
        mut data: ComputeNodeSnapshotData,
        previous: Option<&Self>,
        now: DateTime<Utc>,
    ) -> Result<Self> {
        let same_node_boot = previous.is_some_and(|snapshot| {
            snapshot.node_id == data.node_id && snapshot.boot_id == data.boot_id
        });
        if let Some(previous) = previous.filter(|_| same_node_boot) {
            data.inventory_revision = previous.inventory_revision;
            data.capabilities_revision = previous.capabilities_revision;
            let candidate = Self::new(data.clone(), now.clone())?;
            if candidate.inventory_sha256 != previous.inventory_sha256 {
                data.inventory_revision = previous
                    .inventory_revision
                    .checked_add(1)
                    .context("compute-node inventory revision overflow")?;
            }
            if candidate.computed_capabilities_sha256()?
                != previous.computed_capabilities_sha256()?
            {
                data.capabilities_revision = previous
                    .capabilities_revision
                    .checked_add(1)
                    .context("compute-node capabilities revision overflow")?;
            }
        } else {
            data.inventory_revision = 1;
            data.capabilities_revision = 1;
        }

        let snapshot = Self::new(data, now)?;
        if let Some(previous) = previous {
            snapshot.validate_successor_of(previous)?;
        }
        Ok(snapshot)
    }

    /// Validates the schema, identity, data, and canonical inventory digest.
    pub fn validate(&self) -> Result<()> {
        match self.schema_version.as_str() {
            COMPUTE_NODE_SNAPSHOT_SCHEMA_V1 => {
                if self.host_owner_id.is_some() || self.host_owner_epoch.is_some() {
                    bail!("v1 compute-node snapshots cannot carry host-owner fencing fields");
                }
            }
            COMPUTE_NODE_SNAPSHOT_SCHEMA_V2 => {
                let host_owner_id = self
                    .host_owner_id
                    .as_deref()
                    .context("v2 compute-node snapshot is missing host_owner_id")?;
                validate_identifier(host_owner_id, "host_owner_id")?;
                if self.host_owner_epoch.unwrap_or_default() == 0 {
                    bail!("host_owner_epoch must be positive");
                }
            }
            _ => bail!("unsupported compute node snapshot schema `{}`", self.schema_version),
        }
        validate_identifier(&self.node_id, "node_id")?;
        validate_identifier(&self.boot_id, "boot_id")?;
        validate_identifier(&self.runtime_owner_id, "runtime_owner_id")?;
        if self.owner_epoch == 0
            || self.inventory_revision == 0
            || self.capabilities_revision == 0
        {
            bail!("owner_epoch and snapshot revisions must be positive");
        }
        validate_sha256(&self.inventory_sha256, "inventory_sha256")?;
        self.cpu.validate()?;
        self.memory.validate()?;
        validate_gpu_list(self.gpus.known_value())?;
        validate_capabilities(self.capabilities.known_value())?;
        self.sample.validate()?;
        let expected = self.computed_inventory_sha256()?;
        if self.inventory_sha256 != expected {
            bail!("compute node inventory digest mismatch");
        }
        Ok(())
    }

    /// Validates the freshness claim against the supplied UTC clock.
    pub fn validate_at(&self, now: DateTime<Utc>) -> Result<()> {
        self.validate()?;
        self.sample.validate_at(now)
    }

    /// Whether this observation is safe to use as a current admission input.
    /// Freshness is recomputed from the sample timestamp instead of trusting
    /// the serialized value, which may have aged since it was published.
    pub fn is_current_at(&self, now: DateTime<Utc>) -> Result<bool> {
        self.validate()?;
        Ok(self.sample.freshness_at(now) == SampleFreshness::Current)
    }

    /// Computes the digest of the canonical durable CPU/GPU inventory.
    ///
    /// Sampled memory, effective capacity, local GPU ordinal, name, VRAM,
    /// utilization, temperature, runtime compatibility, enforcement status,
    /// and error reasons are intentionally excluded. CPU topology/OS
    /// constraints and GPU UUID, partition, PCI, and topology bindings are
    /// included.
    pub fn computed_inventory_sha256(&self) -> Result<String> {
        let gpus = self.gpus.known_value().map(|devices| {
            devices
                .iter()
                .map(|gpu| CanonicalGpuInventory {
                    uuid: &gpu.uuid,
                    pci_id: gpu.pci_id.known_value(),
                    partition: gpu.partition.known_value(),
                    topology: gpu.topology.known_value(),
                })
                .collect::<Vec<_>>()
        });
        let canonical = CanonicalInventory {
            schema_version: "compute_node_inventory.v1",
            cpu_topology: self.cpu.topology.known_value(),
            allowed_logical_cpu_ids: self
                .cpu
                .os_constraints
                .allowed_logical_cpu_ids
                .known_value(),
            cpu_quota: self.cpu.os_constraints.quota.known_value(),
            gpus,
        };
        canonical_sha256(&canonical)
    }

    /// Computes a stable digest for the runtime capabilities and enforcement report.
    pub fn computed_capabilities_sha256(&self) -> Result<String> {
        let gpu_compatibility = self.gpus.known_value().map(|devices| {
            devices
                .iter()
                .map(|gpu| CanonicalGpuCompatibility {
                    uuid: &gpu.uuid,
                    runtime_compatibility: gpu.runtime_compatibility.known_value(),
                })
                .collect::<Vec<_>>()
        });
        let canonical = CanonicalCapabilities {
            schema_version: "compute_node_capabilities.v1",
            capabilities: self.capabilities.known_value(),
            gpu_compatibility,
            enforcement: self.enforcement,
        };
        canonical_sha256(&canonical)
    }

    /// Validates revision movement from the previous snapshot for the same node/boot.
    ///
    /// Inventory and capability revisions must remain unchanged when their own
    /// canonical data is unchanged, and must increase when that data changes.
    /// A new node or boot starts a separate revision sequence.
    pub fn validate_successor_of(&self, previous: &Self) -> Result<()> {
        self.validate()?;
        previous.validate()?;
        if previous.schema_version == COMPUTE_NODE_SNAPSHOT_SCHEMA_V2
            && self.schema_version == COMPUTE_NODE_SNAPSHOT_SCHEMA_V1
        {
            bail!("compute-node snapshot schema cannot downgrade from v2 to v1");
        }
        if self.node_id == previous.node_id && self.owner_epoch < previous.owner_epoch {
            bail!("owner_epoch must not decrease for the same node");
        }
        if self.node_id == previous.node_id
            && self.boot_id == previous.boot_id
            && self.runtime_owner_id != previous.runtime_owner_id
            && self.owner_epoch <= previous.owner_epoch
        {
            bail!("runtime owner changes require a higher owner_epoch");
        }
        if self.node_id == previous.node_id {
            if let (Some(current_id), Some(previous_id)) =
                (&self.host_owner_id, &previous.host_owner_id)
            {
                if current_id != previous_id {
                    bail!("host_owner_id must remain stable for the same node");
                }
            }
            if let (Some(current_epoch), Some(previous_epoch)) =
                (self.host_owner_epoch, previous.host_owner_epoch)
            {
                if current_epoch < previous_epoch {
                    bail!("host_owner_epoch must not decrease for the same node");
                }
            }
        }
        if self.node_id != previous.node_id || self.boot_id != previous.boot_id {
            if self.inventory_revision != 1 || self.capabilities_revision != 1 {
                bail!("a new node or boot must start snapshot revisions at one");
            }
            return Ok(());
        }

        let inventory_changed =
            self.computed_inventory_sha256()? != previous.computed_inventory_sha256()?;
        if inventory_changed && self.inventory_revision <= previous.inventory_revision {
            bail!("inventory_revision must increase when durable inventory changes");
        }
        if !inventory_changed && self.inventory_revision != previous.inventory_revision {
            bail!("inventory_revision must remain stable when durable inventory is unchanged");
        }

        let capabilities_changed = self.computed_capabilities_sha256()?
            != previous.computed_capabilities_sha256()?;
        if capabilities_changed && self.capabilities_revision <= previous.capabilities_revision {
            bail!("capabilities_revision must increase when runtime capabilities change");
        }
        if !capabilities_changed && self.capabilities_revision != previous.capabilities_revision {
            bail!("capabilities_revision must remain stable when runtime capabilities are unchanged");
        }
        Ok(())
    }
}

#[derive(Serialize)]
struct CanonicalInventory<'a> {
    schema_version: &'static str,
    cpu_topology: Option<&'a CpuTopology>,
    allowed_logical_cpu_ids: Option<&'a BTreeSet<u32>>,
    cpu_quota: Option<&'a CpuQuota>,
    gpus: Option<Vec<CanonicalGpuInventory<'a>>>,
}

#[derive(Serialize)]
struct CanonicalGpuInventory<'a> {
    uuid: &'a str,
    pci_id: Option<&'a String>,
    partition: Option<&'a GpuPartition>,
    topology: Option<&'a GpuTopology>,
}

#[derive(Serialize)]
struct CanonicalCapabilities<'a> {
    schema_version: &'static str,
    capabilities: Option<&'a Vec<String>>,
    gpu_compatibility: Option<Vec<CanonicalGpuCompatibility<'a>>>,
    enforcement: EnforcementSnapshot,
}

#[derive(Serialize)]
struct CanonicalGpuCompatibility<'a> {
    uuid: &'a str,
    runtime_compatibility: Option<&'a Vec<String>>,
}

fn canonical_sha256<T: Serialize>(value: &T) -> Result<String> {
    let bytes = serde_json::to_vec(value)?;
    Ok(crate::cas::hex_sha256(&bytes))
}

fn validate_gpu_list(gpus: Option<&Vec<GpuDeviceSnapshot>>) -> Result<()> {
    let Some(gpus) = gpus else {
        return Ok(());
    };
    if gpus.windows(2).any(|pair| pair[0].uuid >= pair[1].uuid) {
        bail!("GPU inventory must be sorted and unique by full UUID");
    }
    for gpu in gpus {
        gpu.validate()?;
    }
    Ok(())
}

fn validate_capabilities(capabilities: Option<&Vec<String>>) -> Result<()> {
    if let Some(capabilities) = capabilities {
        validate_sorted_identifiers(capabilities, "runtime capabilities")?;
    }
    Ok(())
}

fn validate_sorted_identifiers(values: &[String], field: &str) -> Result<()> {
    for value in values {
        validate_identifier(value, field)?;
    }
    if values.windows(2).any(|pair| pair[0] >= pair[1]) {
        bail!("{field} must be sorted and unique");
    }
    Ok(())
}

fn validate_identifier(value: &str, field: &str) -> Result<()> {
    if value.is_empty()
        || value.len() > 128
        || !value
            .bytes()
            .all(|byte| byte.is_ascii_alphanumeric() || matches!(byte, b'.' | b'_' | b'-'))
    {
        bail!("{field} must be a non-empty identifier without paths or control characters");
    }
    Ok(())
}

fn validate_public_text(value: &str, field: &str) -> Result<()> {
    if value.trim().is_empty()
        || value.len() > 256
        || value
            .chars()
            .any(|ch| ch.is_control() || ch == '/' || ch == '\\')
    {
        bail!("{field} must be non-empty public text without paths or control characters");
    }
    Ok(())
}

fn validate_sha256(value: &str, field: &str) -> Result<()> {
    if value.len() != 64
        || !value
            .bytes()
            .all(|byte| byte.is_ascii_digit() || (b'a'..=b'f').contains(&byte))
    {
        bail!("{field} must be a lowercase SHA-256 digest");
    }
    Ok(())
}

#[cfg(test)]
mod tests {
    use super::*;
    use chrono::TimeZone;

    #[test]
    fn reported_deserializes_non_default_values_without_fabricating_measurements() {
        #[derive(Debug, PartialEq, Deserialize)]
        struct NoDefault {
            id: String,
        }

        let available: Reported<NoDefault> = serde_json::from_value(serde_json::json!({
            "status": "available", "value": {"id": "reported"}
        })).unwrap();
        assert_eq!(available.known_value().unwrap().id, "reported");
        assert!(available.is_available());

        let missing: Reported<NoDefault> = serde_json::from_value(serde_json::json!({
            "status": "unavailable", "reason": "not_reported"
        })).unwrap();
        assert!(missing.known_value().is_none());
        assert!(!missing.is_available());

        let retained: Reported<NoDefault> = serde_json::from_value(serde_json::json!({
            "status": "unavailable", "reason": "not_reported",
            "last_known": {"id": "previous"}
        })).unwrap();
        assert_eq!(retained.known_value().unwrap().id, "previous");
        assert!(!retained.is_available());

        assert!(serde_json::from_value::<Reported<NoDefault>>(serde_json::json!({
            "status": "available"
        })).is_err());
    }

    fn now() -> DateTime<Utc> {
        Utc.with_ymd_and_hms(2026, 10, 13, 12, 0, 0).unwrap()
    }

    fn available<T>(value: T) -> Reported<T> {
        Reported::Available { value }
    }

    fn measured<T>(value: T) -> Observation<T> {
        Observation::Available { value }
    }

    fn valid_data(at: DateTime<Utc>) -> ComputeNodeSnapshotData {
        ComputeNodeSnapshotData {
            node_id: "node-local-1".into(),
            boot_id: "boot-20261013".into(),
            runtime_owner_id: "owner-7d905b".into(),
            owner_epoch: 3,
            host_owner_id: None,
            host_owner_epoch: None,
            inventory_revision: 4,
            capabilities_revision: 8,
            cpu: CpuSnapshot {
                topology: available(CpuTopology {
                    logical_cpus: vec![
                        CpuLogicalProcessor {
                            id: 0,
                            socket_id: Some(0),
                            numa_node_id: Some(0),
                            core_id: Some(0),
                            smt_sibling_ids: vec![0, 1],
                            processor_group: None,
                            group_logical_cpu_id: None,
                        },
                        CpuLogicalProcessor {
                            id: 1,
                            socket_id: Some(0),
                            numa_node_id: Some(0),
                            core_id: Some(0),
                            smt_sibling_ids: vec![0, 1],
                            processor_group: None,
                            group_logical_cpu_id: None,
                        },
                    ],
                }),
                os_constraints: CpuOsConstraints {
                    allowed_logical_cpu_ids: available(BTreeSet::from([0, 1])),
                    quota: available(CpuQuota::Unlimited),
                },
                effective_capacity_millis: measured(2_000),
                load_percent: measured(12),
            },
            memory: MemorySnapshot {
                total_bytes: measured(16 * 1024),
                available_bytes: measured(8 * 1024),
            },
            gpus: available(vec![GpuDeviceSnapshot {
                uuid: "GPU-001122".into(),
                pci_id: available("0000:01:00.0".into()),
                name: available("Example GPU".into()),
                local_ordinal: measured(0),
                vram_bytes: available(8 * 1024 * 1024),
                utilization_percent: measured(35),
                temperature_millicelsius: measured(52_000),
                partition: available(GpuPartition::FullDevice),
                topology: available(GpuTopology {
                    numa_node_id: Some(0),
                    pci_root_id: Some("0000:00".into()),
                }),
                runtime_compatibility: available(vec!["fdm.gpu".into()]),
            }]),
            capabilities: available(vec!["fdm.cpu".into(), "fem.cpu".into()]),
            sample: ComputeNodeSample::new(SampleSource::HostOs, at, None, at),
            enforcement: EnforcementSnapshot {
                cpu_affinity: EnforcementStatus::Supported,
                cpu_quota: EnforcementStatus::Supported,
                memory_cap: EnforcementStatus::Supported,
                gpu_visibility: EnforcementStatus::Supported,
                storage_quota: EnforcementStatus::Advisory,
            },
        }
    }

    #[test]
    fn sample_freshness_has_a_30_second_boundary_and_rejects_future_time() {
        let collected_at = now();
        let sample = ComputeNodeSample::new(
            SampleSource::HostOs,
            collected_at,
            None,
            collected_at,
        );
        assert_eq!(sample.freshness_at(collected_at), SampleFreshness::Current);
        assert_eq!(
            sample.freshness_at(collected_at + Duration::seconds(30)),
            SampleFreshness::Current
        );
        assert_eq!(
            sample.freshness_at(collected_at + Duration::seconds(30) + Duration::milliseconds(1)),
            SampleFreshness::Stale
        );

        let future = ComputeNodeSample::new(
            SampleSource::HostOs,
            collected_at + Duration::seconds(1),
            None,
            collected_at,
        );
        assert_eq!(
            future.freshness,
            SampleFreshness::Unavailable(UnavailableReason::FutureTimestamp)
        );
    }

    #[test]
    fn admission_freshness_is_recomputed_at_the_observation_time() {
        let collected_at = now();
        let snapshot = ComputeNodeSnapshot::new(valid_data(collected_at), collected_at).unwrap();

        assert!(snapshot
            .is_current_at(collected_at + Duration::seconds(30))
            .unwrap());
        assert!(!snapshot
            .is_current_at(collected_at + Duration::seconds(30) + Duration::milliseconds(1))
            .unwrap());
        assert!(!snapshot
            .is_current_at(collected_at - Duration::milliseconds(1))
            .unwrap());
    }

    #[test]
    fn v2_snapshot_pins_host_owner_without_reinterpreting_v1_fields() {
        let at = now();
        let mut data = valid_data(at);
        data.host_owner_id = Some("host-owner-stable".into());
        data.host_owner_epoch = Some(7);
        let snapshot = ComputeNodeSnapshot::new(data.clone(), at).unwrap();

        assert_eq!(snapshot.schema_version, COMPUTE_NODE_SNAPSHOT_SCHEMA_V2);
        assert_eq!(snapshot.runtime_owner_id, "owner-7d905b");
        assert_eq!(snapshot.owner_epoch, 3);
        assert_eq!(snapshot.host_owner_id.as_deref(), Some("host-owner-stable"));
        assert_eq!(snapshot.host_owner_epoch, Some(7));

        let encoded = serde_json::to_vec(&snapshot).unwrap();
        let decoded: ComputeNodeSnapshot = serde_json::from_slice(&encoded).unwrap();
        assert_eq!(decoded, snapshot);

        data.host_owner_epoch = None;
        assert!(ComputeNodeSnapshot::new(data, at).is_err());
    }

    #[test]
    fn host_owner_epoch_is_monotonic_and_v2_cannot_downgrade() {
        let at = now();
        let mut first_data = valid_data(at);
        first_data.host_owner_id = Some("host-owner-stable".into());
        first_data.host_owner_epoch = Some(4);
        let first = ComputeNodeSnapshot::new(first_data.clone(), at).unwrap();

        first_data.sample.collected_at = at + Duration::seconds(1);
        first_data.host_owner_epoch = Some(5);
        let next = ComputeNodeSnapshot::successor(
            first_data.clone(),
            Some(&first),
            at + Duration::seconds(1),
        )
        .unwrap();
        assert_eq!(next.host_owner_epoch, Some(5));

        first_data.sample.collected_at = at + Duration::seconds(2);
        first_data.host_owner_epoch = Some(3);
        assert!(ComputeNodeSnapshot::successor(
            first_data,
            Some(&next),
            at + Duration::seconds(2),
        )
        .is_err());

        let legacy = ComputeNodeSnapshot::new(valid_data(at + Duration::seconds(2)), at).unwrap();
        assert!(legacy.validate_successor_of(&next).is_err());
    }

    #[test]
    fn unavailable_sample_reason_must_match_a_probe_error_or_future_time() {
        let at = now();
        let mut unexplained = ComputeNodeSample::new(SampleSource::HostOs, at, None, at);
        unexplained.freshness = SampleFreshness::Unavailable(UnavailableReason::ProbeFailed);
        assert!(unexplained.validate().is_err());

        let invalid_error = ComputeNodeSample::new(
            SampleSource::HostOs,
            at,
            Some(UnavailableReason::FutureTimestamp),
            at,
        );
        assert!(invalid_error.validate().is_err());
    }

    #[test]
    fn unavailable_measurements_and_topology_do_not_become_zero() {
        let at = now();
        let mut data = valid_data(at);
        data.cpu.topology = Reported::Unavailable {
            reason: UnavailableReason::NotReported,
            last_known: None,
        };
        data.gpus = Reported::Unavailable {
            reason: UnavailableReason::NotReported,
            last_known: None,
        };
        data.memory.total_bytes = Observation::Unavailable {
            reason: UnavailableReason::NotReported,
        };
        data.memory.available_bytes = Observation::Unavailable {
            reason: UnavailableReason::ProbeFailed,
        };

        let snapshot = ComputeNodeSnapshot::new(data, at).unwrap();
        snapshot.validate_at(at).unwrap();
        let json = serde_json::to_value(snapshot).unwrap();
        assert_eq!(json["cpu"]["topology"]["status"], "unavailable");
        assert!(json["cpu"]["topology"].get("value").is_none());
        assert_eq!(json["memory"]["total_bytes"]["status"], "unavailable");
        assert!(json["memory"]["total_bytes"].get("value").is_none());
        assert!(json.get("pid").is_none());
        assert!(json.get("token").is_none());
        assert!(json.get("path").is_none());
    }

    #[test]
    fn telemetry_and_error_reason_changes_do_not_advance_inventory_revision() {
        let at = now();
        let previous = ComputeNodeSnapshot::new(valid_data(at), at).unwrap();

        let mut next_data = valid_data(at + Duration::seconds(1));
        next_data.memory.available_bytes = measured(4 * 1024);
        next_data.cpu.effective_capacity_millis = measured(1_750);
        next_data.cpu.load_percent = measured(72);
        if let Reported::Available { value } = &mut next_data.gpus {
            value[0].local_ordinal = measured(2);
            value[0].utilization_percent = measured(91);
            value[0].temperature_millicelsius = measured(66_000);
        }
        let next = ComputeNodeSnapshot::new(next_data, at + Duration::seconds(1)).unwrap();
        next.validate_successor_of(&previous).unwrap();
        assert_eq!(
            next.computed_inventory_sha256().unwrap(),
            previous.computed_inventory_sha256().unwrap()
        );

        let mut unavailable = valid_data(at + Duration::seconds(1));
        unavailable.cpu.topology = Reported::Unavailable {
            reason: UnavailableReason::ProbeFailed,
            last_known: Some(match &unavailable.cpu.topology {
                Reported::Available { value } => value.clone(),
                Reported::Unavailable { .. } => unreachable!(),
            }),
        };
        let first_unavailable = ComputeNodeSnapshot::new(unavailable, at + Duration::seconds(1))
            .unwrap();
        let mut same_unavailable = valid_data(at + Duration::seconds(2));
        same_unavailable.cpu.topology = Reported::Unavailable {
            reason: UnavailableReason::PermissionDenied,
            last_known: Some(match &same_unavailable.cpu.topology {
                Reported::Available { value } => value.clone(),
                Reported::Unavailable { .. } => unreachable!(),
            }),
        };
        let second_unavailable =
            ComputeNodeSnapshot::new(same_unavailable, at + Duration::seconds(2)).unwrap();
        second_unavailable
            .validate_successor_of(&first_unavailable)
            .unwrap();
        assert_eq!(
            first_unavailable.computed_inventory_sha256().unwrap(),
            second_unavailable.computed_inventory_sha256().unwrap()
        );
    }

    #[test]
    fn inventory_and_capability_revisions_advance_independently() {
        let at = now();
        let previous = ComputeNodeSnapshot::new(valid_data(at), at).unwrap();

        let mut inventory_change = valid_data(at + Duration::seconds(1));
        inventory_change.inventory_revision += 1;
        inventory_change.cpu.os_constraints.allowed_logical_cpu_ids =
            available(BTreeSet::from([0]));
        let inventory_next =
            ComputeNodeSnapshot::new(inventory_change, at + Duration::seconds(1)).unwrap();
        inventory_next.validate_successor_of(&previous).unwrap();
        assert_eq!(
            inventory_next.capabilities_revision,
            previous.capabilities_revision
        );

        let mut capability_change = valid_data(at + Duration::seconds(1));
        capability_change.capabilities_revision += 1;
        capability_change.capabilities = available(vec!["fdm.cpu".into()]);
        let capability_next =
            ComputeNodeSnapshot::new(capability_change, at + Duration::seconds(1)).unwrap();
        capability_next.validate_successor_of(&previous).unwrap();
        assert_eq!(
            capability_next.inventory_revision,
            previous.inventory_revision
        );

        let mut gpu_description_change = valid_data(at + Duration::seconds(1));
        if let Reported::Available { value } = &mut gpu_description_change.gpus {
            value[0].name = available("Renamed GPU".into());
            value[0].vram_bytes = available(6 * 1024 * 1024);
        }
        let gpu_description_next =
            ComputeNodeSnapshot::new(gpu_description_change, at + Duration::seconds(1)).unwrap();
        gpu_description_next
            .validate_successor_of(&previous)
            .unwrap();
        assert_eq!(
            gpu_description_next.inventory_revision,
            previous.inventory_revision
        );
        assert_eq!(
            gpu_description_next.inventory_sha256,
            previous.inventory_sha256
        );

        let mut gpu_binding_change = valid_data(at + Duration::seconds(1));
        gpu_binding_change.inventory_revision += 1;
        if let Reported::Available { value } = &mut gpu_binding_change.gpus {
            value[0].pci_id = available("0000:02:00.0".into());
        }
        let gpu_binding_next =
            ComputeNodeSnapshot::new(gpu_binding_change, at + Duration::seconds(1)).unwrap();
        gpu_binding_next.validate_successor_of(&previous).unwrap();
        assert_eq!(
            gpu_binding_next.capabilities_revision,
            previous.capabilities_revision
        );

        let mut invalid = valid_data(at + Duration::seconds(1));
        invalid.inventory_revision += 1;
        let invalid_next = ComputeNodeSnapshot::new(invalid, at + Duration::seconds(1)).unwrap();
        assert!(invalid_next.validate_successor_of(&previous).is_err());
    }

    #[test]
    fn successor_assigns_revisions_from_durable_digests_and_fences_owner_changes() {
        let at = now();
        let previous = ComputeNodeSnapshot::new(valid_data(at), at).unwrap();

        let same = ComputeNodeSnapshot::successor(
            valid_data(at + Duration::seconds(1)),
            Some(&previous),
            at + Duration::seconds(1),
        )
        .unwrap();
        assert_eq!(same.inventory_revision, previous.inventory_revision);
        assert_eq!(same.capabilities_revision, previous.capabilities_revision);

        let mut inventory_change = valid_data(at + Duration::seconds(2));
        inventory_change.cpu.os_constraints.allowed_logical_cpu_ids =
            available(BTreeSet::from([0]));
        let inventory_next = ComputeNodeSnapshot::successor(
            inventory_change,
            Some(&same),
            at + Duration::seconds(2),
        )
        .unwrap();
        assert_eq!(inventory_next.inventory_revision, same.inventory_revision + 1);
        assert_eq!(inventory_next.capabilities_revision, same.capabilities_revision);

        let mut capability_change = valid_data(at + Duration::seconds(3));
        capability_change.capabilities = available(vec!["fdm.cpu".into()]);
        let capability_next = ComputeNodeSnapshot::successor(
            capability_change,
            Some(&inventory_next),
            at + Duration::seconds(3),
        )
        .unwrap();
        assert_eq!(capability_next.inventory_revision, inventory_next.inventory_revision);
        assert_eq!(
            capability_next.capabilities_revision,
            inventory_next.capabilities_revision + 1
        );

        let mut owner_change = valid_data(at + Duration::seconds(4));
        owner_change.runtime_owner_id = "owner-next".into();
        assert!(ComputeNodeSnapshot::successor(
            owner_change.clone(),
            Some(&capability_next),
            at + Duration::seconds(4),
        )
        .is_err());
        owner_change.owner_epoch += 1;
        let owner_next = ComputeNodeSnapshot::successor(
            owner_change,
            Some(&capability_next),
            at + Duration::seconds(4),
        )
        .unwrap();
        assert_eq!(owner_next.owner_epoch, capability_next.owner_epoch + 1);

        let mut rebooted = valid_data(at + Duration::seconds(5));
        rebooted.boot_id = "boot-next".into();
        rebooted.inventory_revision = u64::MAX;
        rebooted.capabilities_revision = u64::MAX;
        let reboot_snapshot = ComputeNodeSnapshot::successor(
            rebooted,
            Some(&owner_next),
            at + Duration::seconds(5),
        )
        .unwrap();
        assert_eq!(reboot_snapshot.inventory_revision, 1);
        assert_eq!(reboot_snapshot.capabilities_revision, 1);
    }

    #[test]
    fn future_timestamp_cannot_validate_as_current() {
        let at = now();
        let snapshot = ComputeNodeSnapshot::new(valid_data(at + Duration::seconds(1)), at).unwrap();
        assert_eq!(
            snapshot.sample.freshness,
            SampleFreshness::Unavailable(UnavailableReason::FutureTimestamp)
        );
        assert!(snapshot.validate_at(at).is_ok());

        let mut spoofed = snapshot;
        spoofed.sample.freshness = SampleFreshness::Current;
        assert!(spoofed.validate_at(at).is_err());
    }

    #[test]
    fn rejects_noncanonical_inventory_and_zero_revisions() {
        let at = now();
        let mut data = valid_data(at);
        data.owner_epoch = 0;
        assert!(ComputeNodeSnapshot::new(data, at).is_err());

        let mut zero_memory = valid_data(at);
        zero_memory.memory.total_bytes = measured(0);
        assert!(ComputeNodeSnapshot::new(zero_memory, at).is_err());

        let snapshot = ComputeNodeSnapshot::new(valid_data(at), at).unwrap();
        let mut tampered = snapshot.clone();
        tampered.inventory_sha256.replace_range(0..1, "f");
        assert!(tampered.validate().is_err());
    }
}
