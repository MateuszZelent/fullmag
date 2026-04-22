//! P4: Quantity data-plane store.
//!
//! Provides a bounded binary cache for field projection and slice results, decoupling the
//! HTTP data-plane from the solver state under `current_live_state`.
//!
//! # Architecture note
//!
//! The goal is:
//!
//! ```text
//! Solver  ->  current_live_state (RwLock)  ->  QuantityDataPlaneStore (cache)
//!                                                       |
//!                                              HTTP handlers (read only)
//! ```
//!
//! Handlers read raw field values under a short-lived lock, drop the lock, then check/populate
//! this cache before serialising to binary.  The solver is never blocked by HTTP serialisation.
//!
//! # Eviction policy
//!
//! Simple LRU by access generation with a configurable memory budget.  Entries are evicted when
//! the total cached byte count exceeds `max_bytes` or entry count exceeds `max_entries`.

use std::collections::HashMap;
use tokio::sync::Mutex;

/// Maximum number of cached projection entries (configurable at construction time).
const DEFAULT_MAX_PROJECTION_ENTRIES: usize = 64;
/// Maximum number of cached slice entries.
const DEFAULT_MAX_SLICE_ENTRIES: usize = 128;
/// Default memory budget for each sub-cache in bytes (128 MiB).
const DEFAULT_MAX_BYTES: usize = 128 * 1024 * 1024;

/// A single cached binary buffer with its ETag and provenance information.
#[derive(Clone)]
pub(crate) struct CachedBinary {
    /// FMVP v2 encoded binary.
    pub bytes: Vec<u8>,
    /// HTTP ETag (strong, quoted).
    pub etag: String,
    /// LRU generation counter — higher means more recently used.
    pub generation: u64,
}

/// A bounded LRU binary cache keyed by an arbitrary string.
///
/// Access order is tracked via a monotonic generation counter; eviction removes the entry
/// with the smallest generation when memory/entry limits are exceeded.
pub(crate) struct BinaryCache {
    entries: HashMap<String, CachedBinary>,
    total_bytes: usize,
    generation: u64,
    max_entries: usize,
    max_bytes: usize,
}

impl BinaryCache {
    pub fn new(max_entries: usize, max_bytes: usize) -> Self {
        Self {
            entries: HashMap::with_capacity(max_entries.min(256)),
            total_bytes: 0,
            generation: 0,
            max_entries,
            max_bytes,
        }
    }

    /// Look up a cached binary by key.  Updates the access generation on hit.
    pub fn get(&mut self, key: &str) -> Option<&CachedBinary> {
        if let Some(entry) = self.entries.get_mut(key) {
            self.generation += 1;
            entry.generation = self.generation;
            Some(entry)
        } else {
            None
        }
    }

    /// Insert a new binary into the cache.  Evicts the LRU entry if limits are exceeded.
    pub fn insert(&mut self, key: String, bytes: Vec<u8>, etag: String) {
        // If the single entry is already over the byte budget, don't cache it.
        if bytes.len() > self.max_bytes {
            return;
        }
        // Remove existing entry with the same key first.
        if let Some(old) = self.entries.remove(&key) {
            self.total_bytes = self.total_bytes.saturating_sub(old.bytes.len());
        }
        // Evict until there is room.
        while self.total_bytes + bytes.len() > self.max_bytes
            || self.entries.len() >= self.max_entries
        {
            if !self.evict_one() {
                break;
            }
        }
        self.generation += 1;
        let len = bytes.len();
        self.entries.insert(
            key,
            CachedBinary {
                bytes,
                etag,
                generation: self.generation,
            },
        );
        self.total_bytes += len;
    }

    /// Invalidate all entries whose key starts with `prefix`.
    ///
    /// Call this after a field revision or domain generation id changes to ensure stale
    /// projections are not served.
    pub fn invalidate_prefix(&mut self, prefix: &str) {
        let to_remove: Vec<String> = self
            .entries
            .keys()
            .filter(|k| k.starts_with(prefix))
            .cloned()
            .collect();
        for key in to_remove {
            if let Some(entry) = self.entries.remove(&key) {
                self.total_bytes = self.total_bytes.saturating_sub(entry.bytes.len());
            }
        }
    }

    /// Total resident bytes across all entries.
    pub fn total_bytes(&self) -> usize {
        self.total_bytes
    }

    /// Number of cached entries.
    pub fn len(&self) -> usize {
        self.entries.len()
    }

    /// Remove the entry with the lowest (oldest) generation.
    fn evict_one(&mut self) -> bool {
        if self.entries.is_empty() {
            return false;
        }
        let oldest_key = self
            .entries
            .iter()
            .min_by_key(|(_, v)| v.generation)
            .map(|(k, _)| k.clone());
        if let Some(key) = oldest_key {
            if let Some(entry) = self.entries.remove(&key) {
                self.total_bytes = self.total_bytes.saturating_sub(entry.bytes.len());
            }
            true
        } else {
            false
        }
    }
}

/// Projection cache key.
///
/// Format: `fmvp-proj:{quantity_id}:{field_revision}:{domain_generation_id}:{component}:v2`
pub(crate) fn projection_cache_key(
    quantity_id: &str,
    field_revision: u64,
    domain_generation_id: u64,
    component: &str,
) -> String {
    format!("fmvp-proj:{quantity_id}:{field_revision}:{domain_generation_id}:{component}:v2")
}

/// Slice cache key.
///
/// Format: `fmvp-slice:{quantity_id}:{field_revision}:{domain_gen}:{plane}:{cut_norm_x1e6}:{x_size}:{y_size}:{component}:{arrows}:{arrow_every}:{max_arrows}:v2`
#[allow(clippy::too_many_arguments)]
pub(crate) fn slice_cache_key(
    quantity_id: &str,
    field_revision: u64,
    domain_generation_id: u64,
    plane: &str,
    cut_norm: f64,
    x_size: u32,
    y_size: u32,
    component: &str,
    include_arrows: bool,
    arrow_every: u32,
    max_arrows: u32,
) -> String {
    let cut_i = (cut_norm * 1_000_000.0).round() as i64;
    format!(
        "fmvp-slice:{quantity_id}:{field_revision}:{domain_generation_id}:{plane}:{cut_i}:{x_size}:{y_size}:{component}:{arrows}:{arrow_every}:{max_arrows}:v2",
        arrows = u8::from(include_arrows),
    )
}

/// Data-plane store holding the binary projection cache and the binary slice cache.
///
/// Held in `AppState` as `Arc<QuantityDataPlaneStore>`.  Both sub-caches are protected by their
/// own `Mutex` so projection and slice requests never block each other.
pub(crate) struct QuantityDataPlaneStore {
    /// Cache for projected (component-selected or magnitude) field vector binaries.
    pub projection_cache: Mutex<BinaryCache>,
    /// Cache for 2-D scalar slice binaries.
    pub scalar_slice_cache: Mutex<BinaryCache>,
    /// Cache for 2-D arrow glyph slice binaries.
    pub arrow_slice_cache: Mutex<BinaryCache>,
}

impl std::fmt::Debug for QuantityDataPlaneStore {
    fn fmt(&self, f: &mut std::fmt::Formatter<'_>) -> std::fmt::Result {
        f.debug_struct("QuantityDataPlaneStore")
            .finish_non_exhaustive()
    }
}

impl QuantityDataPlaneStore {
    /// Construct a store with default budgets.
    pub fn new() -> Self {
        Self::with_budgets(
            DEFAULT_MAX_PROJECTION_ENTRIES,
            DEFAULT_MAX_SLICE_ENTRIES,
            DEFAULT_MAX_SLICE_ENTRIES,
            DEFAULT_MAX_BYTES,
        )
    }

    pub fn with_budgets(
        max_projection: usize,
        max_scalar_slices: usize,
        max_arrow_slices: usize,
        max_bytes_each: usize,
    ) -> Self {
        Self {
            projection_cache: Mutex::new(BinaryCache::new(max_projection, max_bytes_each)),
            scalar_slice_cache: Mutex::new(BinaryCache::new(max_scalar_slices, max_bytes_each)),
            arrow_slice_cache: Mutex::new(BinaryCache::new(max_arrow_slices, max_bytes_each)),
        }
    }
}

impl Default for QuantityDataPlaneStore {
    fn default() -> Self {
        Self::new()
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn cache_insert_and_hit() {
        let mut cache = BinaryCache::new(4, 1024 * 1024);
        cache.insert("k1".into(), vec![1u8; 100], "\"etag-1\"".into());
        let hit = cache.get("k1");
        assert!(hit.is_some());
        assert_eq!(hit.unwrap().bytes.len(), 100);
        assert_eq!(cache.total_bytes(), 100);
        assert_eq!(cache.len(), 1);
    }

    #[test]
    fn cache_evicts_lru_on_entry_limit() {
        let mut cache = BinaryCache::new(2, 1024 * 1024);
        cache.insert("k1".into(), vec![0u8; 10], "\"e1\"".into());
        cache.insert("k2".into(), vec![0u8; 10], "\"e2\"".into());
        // Access k1 so it becomes the newest
        let _ = cache.get("k1");
        // Inserting k3 should evict k2 (oldest generation)
        cache.insert("k3".into(), vec![0u8; 10], "\"e3\"".into());
        assert_eq!(cache.len(), 2);
        assert!(cache.get("k1").is_some(), "k1 should survive eviction");
        assert!(cache.get("k2").is_none(), "k2 should have been evicted");
        assert!(cache.get("k3").is_some(), "k3 should be present");
    }

    #[test]
    fn cache_evicts_lru_on_byte_limit() {
        let max_bytes = 25usize;
        let mut cache = BinaryCache::new(100, max_bytes);
        cache.insert("k1".into(), vec![0u8; 10], "\"e1\"".into());
        cache.insert("k2".into(), vec![0u8; 10], "\"e2\"".into());
        // Access k1 to make it newer
        let _ = cache.get("k1");
        // k3 = 10 bytes; total would be 30 > max_bytes=25, so k2 must be evicted
        cache.insert("k3".into(), vec![0u8; 10], "\"e3\"".into());
        assert!(cache.get("k2").is_none(), "k2 evicted by byte budget");
        assert!(cache.get("k1").is_some());
        assert!(cache.get("k3").is_some());
    }

    #[test]
    fn cache_oversize_entry_not_inserted() {
        let max_bytes = 5usize;
        let mut cache = BinaryCache::new(10, max_bytes);
        cache.insert("big".into(), vec![0u8; 10], "\"e\"".into());
        assert_eq!(cache.len(), 0, "oversized entry must not be cached");
    }

    #[test]
    fn cache_invalidate_prefix() {
        let mut cache = BinaryCache::new(10, 1024 * 1024);
        cache.insert("fmvp-proj:m:1:0:x:v2".into(), vec![1u8; 10], "\"e\"".into());
        cache.insert("fmvp-proj:m:2:0:x:v2".into(), vec![1u8; 10], "\"e\"".into());
        cache.insert(
            "fmvp-proj:b_mag:1:0:full:v2".into(),
            vec![1u8; 10],
            "\"e\"".into(),
        );
        cache.invalidate_prefix("fmvp-proj:m:");
        assert_eq!(cache.len(), 1, "only b_mag entry should remain");
        assert!(cache.get("fmvp-proj:b_mag:1:0:full:v2").is_some());
    }

    #[test]
    fn projection_cache_key_format() {
        let key = projection_cache_key("m", 7, 42, "x");
        assert_eq!(key, "fmvp-proj:m:7:42:x:v2");
    }

    #[test]
    fn slice_cache_key_format() {
        let key = slice_cache_key("m", 7, 42, "xy", 0.5, 128, 128, "x", false, 4, 20_000);
        assert!(key.starts_with("fmvp-slice:m:7:42:xy:"));
    }
}
