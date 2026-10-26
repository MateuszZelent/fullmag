//! Stable wire order for metadata maps embedded in exact plan snapshots.
use serde::{Serialize, Serializer};
use std::collections::{BTreeMap, HashMap};

pub(crate) fn serialize<K, V, S>(map: &HashMap<K, V>, serializer: S) -> Result<S::Ok, S::Error>
where
    K: Ord + Serialize,
    V: Serialize,
    S: Serializer,
{
    map.iter().collect::<BTreeMap<_, _>>().serialize(serializer)
}
