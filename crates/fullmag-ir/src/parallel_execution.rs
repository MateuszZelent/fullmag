//! Requested process-level scheduling policy; this never changes physics or precision.
use serde::{Deserialize, Deserializer, Serialize};

#[derive(Debug, Clone, Copy, Serialize, Deserialize, PartialEq, Eq, Default)]
#[serde(rename_all = "snake_case")]
pub enum ParallelExecutionModeIR {
    #[default]
    Serial,
    Adaptive,
}

/// CPU percent is a soft admission target within the effective allocation.
/// OS/cgroup/scheduler limits are separate, authoritative hard limits.
#[derive(Debug, Clone, Serialize, Deserialize, PartialEq)]
#[serde(default, deny_unknown_fields)]
pub struct ParallelExecutionPolicyIR {
    pub mode: ParallelExecutionModeIR,
    pub max_cpu_percent: f64,
    pub max_memory_percent: f64,
    pub memory_reserve_bytes: u64,
    pub max_workers: Option<u32>,
    pub threads_per_worker: u32,
}

impl Default for ParallelExecutionPolicyIR {
    fn default() -> Self {
        Self {
            mode: ParallelExecutionModeIR::Serial,
            max_cpu_percent: 90.0,
            max_memory_percent: 80.0,
            memory_reserve_bytes: 1_073_741_824,
            max_workers: None,
            threads_per_worker: 1,
        }
    }
}

impl ParallelExecutionPolicyIR {
    pub fn validate(&self) -> Result<(), String> {
        for (name, value) in [
            ("max_cpu_percent", self.max_cpu_percent),
            ("max_memory_percent", self.max_memory_percent),
        ] {
            if !value.is_finite() || value <= 0.0 || value > 100.0 {
                return Err(format!(
                    "parallel_execution.{name} must be finite and in (0, 100]"
                ));
            }
        }
        if self.threads_per_worker == 0 || self.max_workers == Some(0) {
            return Err("parallel_execution worker and thread limits must be positive".into());
        }
        Ok(())
    }

    pub fn from_runtime_metadata(
        metadata: &std::collections::BTreeMap<String, serde_json::Value>,
    ) -> Result<Self, String> {
        let Some(selection) = metadata.get("runtime_selection") else {
            return Ok(Self::default());
        };
        let selection = selection
            .as_object()
            .ok_or("runtime_selection must be an object")?;
        let Some(value) = selection
            .get("parallel_execution")
            .filter(|value| !value.is_null())
        else {
            return Ok(Self::default());
        };
        let policy: Self = serde_json::from_value(value.clone())
            .map_err(|error| format!("invalid parallel_execution: {error}"))?;
        policy.validate()?;
        Ok(policy)
    }
}

/// Scene authoring uses explicit null to restore the canonical serial policy.
/// Validation remains at the enclosing authoring or runtime boundary.
pub fn deserialize_parallel_execution_policy<'de, D>(
    deserializer: D,
) -> Result<ParallelExecutionPolicyIR, D::Error>
where
    D: Deserializer<'de>,
{
    Option::<ParallelExecutionPolicyIR>::deserialize(deserializer)
        .map(|policy| policy.unwrap_or_default())
}
