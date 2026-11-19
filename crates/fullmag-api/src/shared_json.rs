//! Copy-on-write JSON for large values held in the live session snapshot.
//!
//! Read handlers clone `SessionStateResponse` to work outside its lock. Its
//! `metadata` carries the execution plan, whose FEM mesh is millions of JSON
//! nodes; a deep clone of that tree cost seconds per request and starved the
//! API's async workers. `SharedJson` makes such a clone one reference-count
//! bump, while writers still mutate through `DerefMut` (copy on write).
//!
//! Decoding that plan into `ExecutionPlanIR` costs as much as the clone did,
//! and quantity rebuilds, coupling reads and scalar fallbacks all need it.
//! The decoded plan is therefore memoized next to the value and shared by
//! every clone of the same version; any mutable access drops the memo.
//!
//! Each content version also carries a process-unique `version` id, so a
//! value derived from several shared values (e.g. a latest field checked
//! against the plan's material arrays) can be memoized on one of them and
//! keyed by the others' versions.

use std::ops::{Deref, DerefMut};
use std::sync::atomic::{AtomicU64, Ordering};
use std::sync::{Arc, Mutex, OnceLock};

use fullmag_ir::ExecutionPlanIR;
use serde::{Deserialize, Deserializer, Serialize, Serializer};
use serde_json::Value;

static NEXT_VERSION: AtomicU64 = AtomicU64::new(1);

fn next_version() -> u64 {
    NEXT_VERSION.fetch_add(1, Ordering::Relaxed)
}

#[derive(Debug, Clone)]
pub(crate) struct SharedJson {
    value: Arc<Value>,
    version: u64,
    execution_plan: Arc<OnceLock<Option<Arc<ExecutionPlanIR>>>>,
    dependent_flag: Arc<Mutex<Option<(u64, bool)>>>,
    count: Arc<OnceLock<usize>>,
}

impl Default for SharedJson {
    fn default() -> Self {
        Value::default().into()
    }
}

impl SharedJson {
    /// The owned value, cloned only when another snapshot still shares it.
    pub(crate) fn into_value(self) -> Value {
        Arc::try_unwrap(self.value).unwrap_or_else(|shared| (*shared).clone())
    }

    /// Process-unique id of this content version; clones share it.
    pub(crate) fn version(&self) -> u64 {
        self.version
    }

    /// A flag derived from this value and another shared value identified by
    /// `dependency_version`, computed once per pair of versions.
    pub(crate) fn dependent_flag(&self, dependency_version: u64, compute: impl FnOnce() -> bool) -> bool {
        let mut memo = self
            .dependent_flag
            .lock()
            .unwrap_or_else(|poisoned| poisoned.into_inner());
        match *memo {
            Some((version, flag)) if version == dependency_version => flag,
            _ => {
                let flag = compute();
                *memo = Some((dependency_version, flag));
                flag
            }
        }
    }

    /// A count derived from this value alone (e.g. its field value count),
    /// computed once per value version.
    pub(crate) fn memoized_count(&self, compute: impl FnOnce(&Value) -> usize) -> usize {
        *self.count.get_or_init(|| compute(&self.value))
    }

    /// The decoded `execution_plan` member, decoded once per value version.
    pub(crate) fn execution_plan(&self) -> Option<Arc<ExecutionPlanIR>> {
        self.execution_plan
            .get_or_init(|| {
                let plan = self.value.get("execution_plan")?;
                serde_json::from_value::<ExecutionPlanIR>(plan.clone())
                    .ok()
                    .map(Arc::new)
            })
            .clone()
    }
}

impl From<Value> for SharedJson {
    fn from(value: Value) -> Self {
        Self {
            value: Arc::new(value),
            version: next_version(),
            execution_plan: Arc::default(),
            dependent_flag: Arc::default(),
            count: Arc::default(),
        }
    }
}

impl Deref for SharedJson {
    type Target = Value;

    fn deref(&self) -> &Value {
        &self.value
    }
}

impl DerefMut for SharedJson {
    fn deref_mut(&mut self) -> &mut Value {
        // The caller may change `execution_plan`; other clones keep the memo
        // that still matches their unchanged value.
        self.version = next_version();
        self.execution_plan = Arc::default();
        self.dependent_flag = Arc::default();
        self.count = Arc::default();
        Arc::make_mut(&mut self.value)
    }
}

impl PartialEq for SharedJson {
    fn eq(&self, other: &Self) -> bool {
        self.value == other.value
    }
}

impl PartialEq<Value> for SharedJson {
    fn eq(&self, other: &Value) -> bool {
        *self.value == *other
    }
}

impl Serialize for SharedJson {
    fn serialize<S: Serializer>(&self, serializer: S) -> Result<S::Ok, S::Error> {
        self.value.serialize(serializer)
    }
}

impl<'de> Deserialize<'de> for SharedJson {
    fn deserialize<D: Deserializer<'de>>(deserializer: D) -> Result<Self, D::Error> {
        Value::deserialize(deserializer).map(Self::from)
    }
}

#[cfg(test)]
mod tests {
    use super::*;
    use serde_json::json;

    #[test]
    fn clones_share_until_one_side_writes() {
        let original = SharedJson::from(json!({"plan": [1, 2, 3]}));
        let mut copy = original.clone();
        assert!(Arc::ptr_eq(&original.value, &copy.value));
        copy["plan"] = json!([4]);
        assert!(!Arc::ptr_eq(&original.value, &copy.value));
        assert_eq!(original["plan"], json!([1, 2, 3]));
        assert_eq!(copy["plan"], json!([4]));
    }

    #[test]
    fn serializes_and_unwraps_as_the_plain_value() {
        let shared = SharedJson::from(json!({"a": 1}));
        assert_eq!(serde_json::to_value(&shared).unwrap(), json!({"a": 1}));
        let kept = shared.clone();
        assert_eq!(shared.into_value(), json!({"a": 1}));
        assert_eq!(kept.into_value(), json!({"a": 1}));
    }

    #[test]
    fn versions_follow_content_and_key_dependent_flags() {
        let mut shared = SharedJson::from(json!({"a": 1}));
        let copy = shared.clone();
        assert_eq!(shared.version(), copy.version());
        let mut computed = 0;
        assert!(shared.dependent_flag(7, || { computed += 1; true }));
        assert!(copy.dependent_flag(7, || { computed += 1; false }));
        assert!(!copy.dependent_flag(8, || { computed += 1; false }));
        assert_eq!(computed, 2);
        shared["a"] = json!(2);
        assert_ne!(shared.version(), copy.version());
        assert!(!shared.dependent_flag(8, || false));
    }

    #[test]
    fn execution_plan_memo_is_shared_and_dropped_on_write() {
        let mut shared = SharedJson::from(json!({"execution_plan": {"malformed": true}}));
        assert!(shared.execution_plan().is_none());
        let copy = shared.clone();
        assert!(Arc::ptr_eq(&shared.execution_plan, &copy.execution_plan));
        shared["note"] = json!("edited");
        assert!(!Arc::ptr_eq(&shared.execution_plan, &copy.execution_plan));
        assert!(shared.execution_plan.get().is_none());
        assert!(copy.execution_plan.get().is_some());
    }
}
