//! Requested process-level scheduling policy; this never changes physics or precision.
use serde::{
    Deserialize, Deserializer, Serialize,
    de::{MapAccess, Visitor},
};
use std::fmt;

#[derive(Debug, Clone, Copy, Serialize, Deserialize, PartialEq, Eq, Default)]
#[serde(rename_all = "snake_case")]
pub enum ParallelExecutionModeIR {
    #[default]
    Serial,
    Adaptive,
}

/// CPU percent is a soft admission target within the effective allocation.
/// OS/cgroup/scheduler limits are separate, authoritative hard limits.
#[derive(Debug, Clone, Serialize, PartialEq)]
pub struct ParallelExecutionPolicyIR {
    pub mode: ParallelExecutionModeIR,
    pub max_cpu_percent: f64,
    pub max_memory_percent: f64,
    pub memory_reserve_bytes: u64,
    pub max_workers: Option<u32>,
    pub threads_per_worker: u32,
}

impl<'de> Deserialize<'de> for ParallelExecutionPolicyIR {
    fn deserialize<D: Deserializer<'de>>(deserializer: D) -> Result<Self, D::Error> {
        struct PolicyObjectVisitor;
        impl<'de> Visitor<'de> for PolicyObjectVisitor {
            type Value = ParallelExecutionPolicyIR;
            fn expecting(&self, formatter: &mut fmt::Formatter) -> fmt::Result {
                formatter.write_str("a parallel_execution policy object")
            }
            fn visit_map<A: MapAccess<'de>>(self, mut map: A) -> Result<Self::Value, A::Error> {
                const FIELDS: &[&str] = &[
                    "mode",
                    "max_cpu_percent",
                    "max_memory_percent",
                    "memory_reserve_bytes",
                    "max_workers",
                    "threads_per_worker",
                ];
                let mut policy = ParallelExecutionPolicyIR::default();
                let mut seen = [false; 6];
                while let Some(key) = map.next_key::<String>()? {
                    let index = FIELDS
                        .iter()
                        .position(|field| *field == key)
                        .ok_or_else(|| {
                            <A::Error as serde::de::Error>::unknown_field(&key, FIELDS)
                        })?;
                    if seen[index] {
                        return Err(<A::Error as serde::de::Error>::duplicate_field(
                            FIELDS[index],
                        ));
                    }
                    seen[index] = true;
                    match index {
                        0 => policy.mode = map.next_value()?,
                        1 => policy.max_cpu_percent = map.next_value()?,
                        2 => policy.max_memory_percent = map.next_value()?,
                        3 => policy.memory_reserve_bytes = map.next_value()?,
                        4 => policy.max_workers = map.next_value()?,
                        5 => policy.threads_per_worker = map.next_value()?,
                        _ => unreachable!("validated parallel policy field index"),
                    }
                }
                Ok(policy)
            }
        }
        // Derived struct deserialization also accepts positional sequences.
        // Scheduling policy is a map contract, including at nested boundaries.
        deserializer.deserialize_map(PolicyObjectVisitor)
    }
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

#[cfg(test)]
mod tests {
    use super::*;
    #[test]
    fn parallel_policy_requires_map_and_preserves_defaults_and_roundtrip() {
        let policy: ParallelExecutionPolicyIR = serde_json::from_str("{}").unwrap();
        assert_eq!(policy, ParallelExecutionPolicyIR::default());
        let policy = ParallelExecutionPolicyIR {
            mode: ParallelExecutionModeIR::Adaptive,
            max_cpu_percent: 85.0,
            max_memory_percent: 70.0,
            memory_reserve_bytes: 4_096,
            max_workers: Some(3),
            threads_per_worker: 2,
        };
        let encoded = serde_json::to_value(&policy).unwrap();
        assert_eq!(
            serde_json::from_value::<ParallelExecutionPolicyIR>(encoded).unwrap(),
            policy
        );
        for value in [
            serde_json::json!([]),
            serde_json::json!(["adaptive"]),
            serde_json::json!(false),
            serde_json::json!(1),
            serde_json::json!("serial"),
            serde_json::Value::Null,
            serde_json::json!({"unknown": 1}),
            serde_json::json!({"threads_per_worker": false}),
        ] {
            assert!(
                serde_json::from_value::<ParallelExecutionPolicyIR>(value.clone()).is_err(),
                "{value}"
            );
        }
        let reset: ParallelExecutionPolicyIR =
            deserialize_parallel_execution_policy(serde_json::Value::Null).unwrap();
        assert_eq!(reset, ParallelExecutionPolicyIR::default());
        let metadata = std::collections::BTreeMap::from([(
            "runtime_selection".into(),
            serde_json::json!({"parallel_execution": []}),
        )]);
        assert!(ParallelExecutionPolicyIR::from_runtime_metadata(&metadata).is_err());
    }
    #[test]
    fn parallel_policy_rejects_duplicate_fields_in_raw_json() {
        let error = serde_json::from_str::<ParallelExecutionPolicyIR>(
            r#"{"mode":"serial","mode":"adaptive"}"#,
        )
        .expect_err("custom map parser must preserve duplicate-field rejection");
        assert!(error.to_string().contains("duplicate field"));
    }
}
