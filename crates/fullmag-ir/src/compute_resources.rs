//! Requested compute resources. These describe intent, never an allocation.
//!
//! `compute_resources.v1` lives in ProblemIR runtime metadata so old documents
//! retain their legacy selection. Admission and worker evidence are separate.

use crate::ProblemIR;
use serde::{Deserialize, Serialize};
use std::collections::BTreeSet;

#[cfg(test)]
#[path = "compute_resources_tests.rs"]
mod tests;

pub const COMPUTE_RESOURCES_SCHEMA: &str = "compute_resources.v1";

#[derive(Debug, Clone, Copy, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "snake_case")]
pub enum AutoThreads {
    Auto,
}

#[derive(Debug, Clone, Copy, PartialEq, Eq, Serialize, Deserialize)]
#[serde(untagged)]
pub enum RequestedThreads {
    Count(u32),
    Auto(AutoThreads),
}

impl Default for RequestedThreads {
    fn default() -> Self {
        Self::Auto(AutoThreads::Auto)
    }
}

impl RequestedThreads {
    pub fn count(self) -> Option<u32> {
        match self {
            Self::Count(value) => Some(value),
            Self::Auto(_) => None,
        }
    }
}

#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize, Default)]
#[serde(tag = "kind", rename_all = "snake_case", deny_unknown_fields)]
pub enum ComputeTargetIR {
    #[default]
    Local,
    Node {
        id: String,
    },
    Pool {
        id: String,
    },
}

#[derive(Debug, Clone, Copy, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "snake_case")]
pub enum CpuCorePolicyIR {
    PhysicalFirst,
    Logical,
}

#[derive(Debug, Clone, Copy, PartialEq, Eq, Serialize, Deserialize, Default)]
#[serde(rename_all = "snake_case")]
pub enum CpuAffinityIR {
    #[default]
    Auto,
    Compact,
    Spread,
    Numa,
}

#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize, Default)]
#[serde(deny_unknown_fields)]
pub struct CpuResourcesIR {
    #[serde(default)]
    pub threads: RequestedThreads,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub core_policy: Option<CpuCorePolicyIR>,
    #[serde(default)]
    pub affinity: CpuAffinityIR,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub numa_node: Option<u32>,
    #[serde(default)]
    pub native_threads: RequestedThreads,
    #[serde(default)]
    pub blas_threads: RequestedThreads,
}

#[derive(Debug, Clone, Copy, PartialEq, Eq, Serialize, Deserialize, Default)]
#[serde(rename_all = "snake_case")]
pub enum GpuSelectorIR {
    #[default]
    AnyCompatible,
    AllowList,
    Required,
}

#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
#[serde(deny_unknown_fields)]
pub struct GpuResourcesIR {
    #[serde(default)]
    pub selector: GpuSelectorIR,
    #[serde(default)]
    pub device_uuids: Vec<String>,
    #[serde(default = "one")]
    pub devices_per_task: u32,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub vram_per_device_bytes: Option<u64>,
}

fn one() -> u32 {
    1
}

#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize, Default)]
#[serde(deny_unknown_fields)]
pub struct MemoryReservationIR {
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub reservation_bytes: Option<u64>,
}

#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize, Default)]
#[serde(tag = "kind", rename_all = "snake_case", deny_unknown_fields)]
pub enum ComputeParallelismIR {
    #[default]
    SingleProcess,
    Distributed {
        ranks: u32,
        threads_per_rank: u32,
        ranks_per_node: u32,
        gpus_per_rank: u32,
    },
}

#[derive(Debug, Clone, Copy, PartialEq, Eq, Serialize, Deserialize, Default)]
#[serde(rename_all = "snake_case")]
pub enum ComputePlacementIR {
    #[default]
    Balanced,
    Throughput,
    Pinned,
}

#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
#[serde(deny_unknown_fields)]
pub struct ComputeResourcesIR {
    pub schema_version: String,
    #[serde(default)]
    pub target: ComputeTargetIR,
    #[serde(default)]
    pub cpu: CpuResourcesIR,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub gpu: Option<GpuResourcesIR>,
    #[serde(default)]
    pub ram: MemoryReservationIR,
    #[serde(default)]
    pub scratch: MemoryReservationIR,
    #[serde(default)]
    pub parallelism: ComputeParallelismIR,
    #[serde(default)]
    pub placement: ComputePlacementIR,
}

impl Default for ComputeResourcesIR {
    fn default() -> Self {
        Self {
            schema_version: COMPUTE_RESOURCES_SCHEMA.into(),
            target: ComputeTargetIR::default(),
            cpu: CpuResourcesIR::default(),
            gpu: None,
            ram: MemoryReservationIR::default(),
            scratch: MemoryReservationIR::default(),
            parallelism: ComputeParallelismIR::default(),
            placement: ComputePlacementIR::default(),
        }
    }
}

fn valid_identity(value: &str) -> bool {
    !value.is_empty() && value.len() <= 256 && !value.chars().any(char::is_whitespace)
}

impl ComputeResourcesIR {
    pub fn from_problem(problem: &ProblemIR) -> Result<Option<Self>, String> {
        problem
            .problem_meta
            .runtime_metadata
            .get("compute_resources")
            .map(|value| {
                serde_json::from_value(value.clone())
                    .map_err(|error| format!("compute_resources is invalid: {error}"))
            })
            .transpose()
    }

    /// Validate request shape without pretending the host can execute it.
    pub fn validate(&self) -> Result<(), Vec<String>> {
        let mut errors = Vec::new();
        if self.schema_version != COMPUTE_RESOURCES_SCHEMA {
            errors.push(format!(
                "compute_resources.schema_version must be {COMPUTE_RESOURCES_SCHEMA}"
            ));
        }
        if let ComputeTargetIR::Node { id } | ComputeTargetIR::Pool { id } = &self.target {
            if !valid_identity(id) {
                errors.push("compute_resources.target.id must be a nonempty identifier without whitespace (max 256 bytes)".into());
            }
        }
        for (name, threads) in [
            ("threads", self.cpu.threads),
            ("native_threads", self.cpu.native_threads),
            ("blas_threads", self.cpu.blas_threads),
        ] {
            if threads.count() == Some(0) {
                errors.push(format!(
                    "compute_resources.cpu.{name} must be auto or a positive u32"
                ));
            }
            if name != "threads" {
                if let (Some(limit), Some(requested)) = (self.cpu.threads.count(), threads.count())
                {
                    if requested > limit {
                        errors.push(format!("compute_resources.cpu.{name} exceeds cpu.threads"));
                    }
                }
            }
        }
        if (self.cpu.affinity == CpuAffinityIR::Numa) != self.cpu.numa_node.is_some() {
            errors.push(
                "compute_resources.cpu.numa_node is required exactly when affinity is numa".into(),
            );
        }
        for (name, bytes) in [
            ("ram", self.ram.reservation_bytes),
            ("scratch", self.scratch.reservation_bytes),
        ] {
            if bytes == Some(0) {
                errors.push(format!(
                    "compute_resources.{name}.reservation_bytes must be positive"
                ));
            }
        }
        if let Some(gpu) = &self.gpu {
            if gpu.devices_per_task == 0 || gpu.vram_per_device_bytes == Some(0) {
                errors.push("compute_resources.gpu requires positive devices_per_task and positive VRAM when specified".into());
            }
            let mut seen = BTreeSet::new();
            if gpu
                .device_uuids
                .iter()
                .any(|id| !valid_identity(id) || !seen.insert(id))
            {
                errors.push("compute_resources.gpu.device_uuids must be distinct nonempty identifiers without whitespace (max 256 bytes)".into());
            }
            let count = gpu.device_uuids.len();
            let valid = match gpu.selector {
                GpuSelectorIR::AnyCompatible => count == 0,
                GpuSelectorIR::Required => count == 1 && gpu.devices_per_task == 1,
                GpuSelectorIR::AllowList => count > 0 && count >= gpu.devices_per_task as usize,
            };
            if !valid {
                errors.push("compute_resources.gpu.selector conflicts with device_uuids or devices_per_task".into());
            }
        }
        match self.parallelism {
            ComputeParallelismIR::SingleProcess => {
                if self
                    .gpu
                    .as_ref()
                    .is_some_and(|gpu| gpu.devices_per_task != 1)
                {
                    errors.push("compute_resources: multiple GPUs per task requires distributed parallelism".into());
                }
            }
            ComputeParallelismIR::Distributed {
                ranks,
                threads_per_rank,
                ranks_per_node,
                gpus_per_rank,
            } => {
                if ranks == 0
                    || threads_per_rank == 0
                    || ranks_per_node == 0
                    || ranks_per_node > ranks
                {
                    errors.push("compute_resources.distributed requires positive ranks/threads and ranks_per_node <= ranks".into());
                }
                if ranks.checked_mul(gpus_per_rank)
                    != Some(self.gpu.as_ref().map_or(0, |gpu| gpu.devices_per_task))
                {
                    errors.push("compute_resources.distributed GPU rank budget conflicts with devices_per_task".into());
                }
                if let Some(limit) = self.cpu.threads.count() {
                    if limit != threads_per_rank {
                        errors.push(
                            "compute_resources.cpu.threads must equal distributed.threads_per_rank"
                                .into(),
                        );
                    }
                }
            }
        }
        if errors.is_empty() {
            Ok(())
        } else {
            Err(errors)
        }
    }

    /// Existing runtime_selection remains readable, but cannot contradict the
    /// typed request. In particular, explicit Auto is not an absent value.
    pub fn validate_legacy_selection(&self, problem: &ProblemIR) -> Result<(), Vec<String>> {
        let mut errors = Vec::new();
        if let Some(selection) = problem
            .problem_meta
            .runtime_metadata
            .get("runtime_selection")
        {
            if let Some(threads) = selection.get("cpu_threads").filter(|v| !v.is_null()) {
                if threads.as_u64() != self.cpu.threads.count().map(u64::from) {
                    errors.push("execution_intent_conflict: runtime_selection.cpu_threads differs from compute_resources.cpu.threads".into());
                }
            }
            if let Some(gpu) = &self.gpu {
                if selection.get("device").and_then(|v| v.as_str()) == Some("cpu") {
                    errors.push("execution_intent_conflict: GPU resources contradict runtime_selection.device=cpu".into());
                }
                if let Some(count) = selection
                    .get("gpu_count")
                    .and_then(|v| v.as_u64())
                    .filter(|count| *count > 0)
                {
                    if count != u64::from(gpu.devices_per_task) {
                        errors.push("execution_intent_conflict: runtime_selection.gpu_count differs from compute_resources.gpu.devices_per_task".into());
                    }
                }
                if !gpu.device_uuids.is_empty()
                    && selection.get("device_index").is_some_and(|v| !v.is_null())
                {
                    errors.push("execution_intent_conflict: GPU UUID selector and legacy ordinal require explicit inventory resolution".into());
                }
            }
        }
        if errors.is_empty() {
            Ok(())
        } else {
            Err(errors)
        }
    }
}
