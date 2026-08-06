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

use crate::fem_spatial_index::FemNormalAxisIndex;
use crate::planar_sampling::PlanarSampleResult;
use serde_json::Value;
use std::collections::HashMap;
use std::sync::Arc;
use std::sync::Mutex as StdMutex;
use tokio::sync::Mutex;

/// Maximum number of cached projection entries (configurable at construction time).
const DEFAULT_MAX_PROJECTION_ENTRIES: usize = 64;
/// Maximum number of cached slice entries.
const DEFAULT_MAX_SLICE_ENTRIES: usize = 128;
/// Maximum number of cached analysis resource entries.
const DEFAULT_MAX_ANALYSIS_RESOURCE_ENTRIES: usize = 128;
const DEFAULT_MAX_PLANAR_SAMPLE_ENTRIES: usize = 8;
const DEFAULT_MAX_TOPOLOGY_ENTRIES: usize = 2;
const DEFAULT_MAX_TOPOLOGY_BYTES: usize = 512 * 1024 * 1024;
/// Default memory budget for each sub-cache in bytes (128 MiB).
const DEFAULT_MAX_BYTES: usize = 128 * 1024 * 1024;

/// A single cached binary buffer with its ETag and provenance information.
#[derive(Clone)]
pub(crate) struct CachedBinary {
    /// Versioned FMVP-encoded binary.
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

pub(crate) struct SharedBinaryCache {
    entries: HashMap<String, CachedSharedBinary>,
    total_bytes: usize,
    generation: u64,
    max_entries: usize,
    max_bytes: usize,
}

struct CachedSharedBinary {
    bytes: Arc<[u8]>,
    generation: u64,
}

impl SharedBinaryCache {
    pub fn new(max_entries: usize, max_bytes: usize) -> Self {
        Self {
            entries: HashMap::with_capacity(max_entries.min(16)),
            total_bytes: 0,
            generation: 0,
            max_entries,
            max_bytes,
        }
    }

    pub fn get(&mut self, key: &str) -> Option<Arc<[u8]>> {
        let entry = self.entries.get_mut(key)?;
        self.generation += 1;
        entry.generation = self.generation;
        Some(Arc::clone(&entry.bytes))
    }

    pub fn insert(&mut self, key: String, bytes: Vec<u8>) -> Arc<[u8]> {
        let bytes: Arc<[u8]> = bytes.into();
        if bytes.len() > self.max_bytes || self.max_entries == 0 {
            return bytes;
        }
        if let Some(previous) = self.entries.remove(&key) {
            self.total_bytes = self.total_bytes.saturating_sub(previous.bytes.len());
        }
        while self.entries.len() >= self.max_entries
            || self.total_bytes + bytes.len() > self.max_bytes
        {
            let Some(oldest_key) = self
                .entries
                .iter()
                .min_by_key(|(_, entry)| entry.generation)
                .map(|(key, _)| key.clone())
            else {
                break;
            };
            if let Some(previous) = self.entries.remove(&oldest_key) {
                self.total_bytes = self.total_bytes.saturating_sub(previous.bytes.len());
            }
        }
        self.generation += 1;
        self.total_bytes += bytes.len();
        self.entries.insert(
            key,
            CachedSharedBinary {
                bytes: Arc::clone(&bytes),
                generation: self.generation,
            },
        );
        bytes
    }

    pub fn get_or_try_insert_with<E>(
        &mut self,
        key: &str,
        build: impl FnOnce() -> Result<Vec<u8>, E>,
    ) -> Result<Arc<[u8]>, E> {
        if let Some(bytes) = self.get(key) {
            return Ok(bytes);
        }
        Ok(self.insert(key.to_string(), build()?))
    }

    #[cfg(test)]
    pub fn len(&self) -> usize {
        self.entries.len()
    }
}

#[derive(Clone)]
pub(crate) struct CachedJsonResource {
    pub value: Value,
    pub generation: u64,
}

pub(crate) struct JsonResourceCache {
    entries: HashMap<String, CachedJsonResource>,
    generation: u64,
    max_entries: usize,
}

#[derive(Clone)]
struct CachedPlanarSample {
    result: Arc<PlanarSampleResult>,
    estimated_bytes: usize,
    generation: u64,
}

pub(crate) struct PlanarSampleCache {
    entries: HashMap<String, CachedPlanarSample>,
    total_bytes: usize,
    generation: u64,
    max_entries: usize,
    max_bytes: usize,
}

impl PlanarSampleCache {
    pub fn new(max_entries: usize, max_bytes: usize) -> Self {
        Self {
            entries: HashMap::with_capacity(max_entries),
            total_bytes: 0,
            generation: 0,
            max_entries,
            max_bytes,
        }
    }

    pub fn get(&mut self, key: &str) -> Option<Arc<PlanarSampleResult>> {
        let entry = self.entries.get_mut(key)?;
        self.generation += 1;
        entry.generation = self.generation;
        Some(Arc::clone(&entry.result))
    }

    pub fn insert(&mut self, key: String, result: Arc<PlanarSampleResult>) {
        let estimated_bytes = estimate_planar_sample_bytes(&result);
        if estimated_bytes > self.max_bytes || self.max_entries == 0 {
            return;
        }
        if let Some(previous) = self.entries.remove(&key) {
            self.total_bytes = self.total_bytes.saturating_sub(previous.estimated_bytes);
        }
        while self.entries.len() >= self.max_entries
            || self.total_bytes + estimated_bytes > self.max_bytes
        {
            let Some(oldest_key) = self
                .entries
                .iter()
                .min_by_key(|(_, entry)| entry.generation)
                .map(|(key, _)| key.clone())
            else {
                break;
            };
            if let Some(previous) = self.entries.remove(&oldest_key) {
                self.total_bytes = self.total_bytes.saturating_sub(previous.estimated_bytes);
            }
        }
        self.generation += 1;
        self.entries.insert(
            key,
            CachedPlanarSample {
                result,
                estimated_bytes,
                generation: self.generation,
            },
        );
        self.total_bytes += estimated_bytes;
    }
}

fn estimate_planar_sample_bytes(result: &PlanarSampleResult) -> usize {
    let scalar = result.scalar_values.len() * std::mem::size_of::<f64>();
    let vectors = result
        .vector_values
        .as_ref()
        .map_or(0, |values| values.len() * std::mem::size_of::<[f64; 3]>());
    let occupancy =
        result.occupancy.len() * std::mem::size_of::<crate::planar_sampling::Occupancy>();
    let source_ids = result.source_entity_ids.len() * std::mem::size_of::<Option<u32>>();
    let overlay = result.overlay.as_ref().map_or(0, |overlay| {
        overlay
            .polygons
            .iter()
            .map(|polygon| {
                std::mem::size_of_val(polygon)
                    + polygon.vertices_uv_m.len() * std::mem::size_of::<[f64; 2]>()
            })
            .sum::<usize>()
            + overlay.segments.len()
                * std::mem::size_of::<crate::planar_sampling::PlanarOverlaySegment>()
    });
    scalar + vectors + occupancy + source_ids + overlay
}

impl JsonResourceCache {
    pub fn new(max_entries: usize) -> Self {
        Self {
            entries: HashMap::with_capacity(max_entries.min(256)),
            generation: 0,
            max_entries,
        }
    }

    pub fn get(&mut self, key: &str) -> Option<Value> {
        let entry = self.entries.get_mut(key)?;
        self.generation += 1;
        entry.generation = self.generation;
        Some(entry.value.clone())
    }

    pub fn insert(&mut self, key: String, value: Value) {
        if self.max_entries == 0 {
            return;
        }
        self.entries.remove(&key);
        while self.entries.len() >= self.max_entries {
            if !self.evict_one() {
                break;
            }
        }
        self.generation += 1;
        self.entries.insert(
            key,
            CachedJsonResource {
                value,
                generation: self.generation,
            },
        );
    }

    fn evict_one(&mut self) -> bool {
        let oldest_key = self
            .entries
            .iter()
            .min_by_key(|(_, value)| value.generation)
            .map(|(key, _)| key.clone());
        let Some(key) = oldest_key else {
            return false;
        };
        self.entries.remove(&key);
        true
    }
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
    #[cfg(test)]
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
    #[cfg(test)]
    pub fn total_bytes(&self) -> usize {
        self.total_bytes
    }

    /// Number of cached entries.
    #[cfg(test)]
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
/// Format: `fmvp-proj:{quantity_id}:{session_id}:{field_revision}:{domain_generation_id}:{component}:v3`
pub(crate) fn projection_cache_key(
    quantity_id: &str,
    session_id: &str,
    field_revision: u64,
    domain_generation_id: u64,
    component: &str,
) -> String {
    format!(
        "fmvp-proj:{quantity_id}:{session_id}:{field_revision}:{domain_generation_id}:{component}:v3"
    )
}

#[allow(clippy::too_many_arguments)]
pub(crate) fn scalar_projection_cache_key(
    quantity_id: &str,
    session_id: &str,
    field_revision: u64,
    domain_generation_id: &str,
    plane: &str,
    x_size: u32,
    y_size: u32,
    component: &str,
    reduction: &str,
    include_air_as_zero: bool,
    samples: u32,
    tile_x: Option<u32>,
    tile_y: Option<u32>,
    tile_size: Option<u32>,
) -> String {
    format!(
        "fmvp-proj-scalar:{quantity_id}:{session_id}:{field_revision}:{domain_generation_id}:{plane}:{x_size}:{y_size}:{component}:{reduction}:{air}:{samples}:tile={tx},{ty},{ts}:v2",
        air = u8::from(include_air_as_zero),
        tx = tile_x.map_or_else(|| "full".to_string(), |value| value.to_string()),
        ty = tile_y.map_or_else(|| "full".to_string(), |value| value.to_string()),
        ts = tile_size.map_or_else(|| "full".to_string(), |value| value.to_string()),
    )
}

#[allow(clippy::too_many_arguments)]
pub(crate) fn projection_empty_mask_cache_key(
    quantity_id: &str,
    session_id: &str,
    field_revision: u64,
    domain_generation_id: &str,
    plane: &str,
    x_size: u32,
    y_size: u32,
    component: &str,
    reduction: &str,
    include_air_as_zero: bool,
    samples: u32,
    tile_x: Option<u32>,
    tile_y: Option<u32>,
    tile_size: Option<u32>,
) -> String {
    format!(
        "fmvp-proj-empty-mask:{quantity_id}:{session_id}:{field_revision}:{domain_generation_id}:{plane}:{x_size}:{y_size}:{component}:{reduction}:{air}:{samples}:tile={tx},{ty},{ts}:v2",
        air = u8::from(include_air_as_zero),
        tx = tile_x.map_or_else(|| "full".to_string(), |value| value.to_string()),
        ty = tile_y.map_or_else(|| "full".to_string(), |value| value.to_string()),
        ts = tile_size.map_or_else(|| "full".to_string(), |value| value.to_string()),
    )
}

/// Slice cache key.
///
/// Format: `fmvp-slice:{quantity_id}:{session_id}:{field_revision}:{domain_gen}:{plane}:{cut_key}:{x_size}:{y_size}:{component}:{arrows}:{arrow_every}:{max_arrows}:v3`
#[allow(clippy::too_many_arguments)]
pub(crate) fn slice_cache_key(
    quantity_id: &str,
    session_id: &str,
    field_revision: u64,
    domain_generation_id: &str,
    plane: &str,
    cut_key: &str,
    x_size: u32,
    y_size: u32,
    component: &str,
    include_arrows: bool,
    arrow_every: u32,
    max_arrows: u32,
) -> String {
    format!(
        "fmvp-slice:{quantity_id}:{session_id}:{field_revision}:{domain_generation_id}:{plane}:{cut_key}:{x_size}:{y_size}:{component}:{arrows}:{arrow_every}:{max_arrows}:v3",
        arrows = u8::from(include_arrows),
    )
}

#[allow(clippy::too_many_arguments)]
pub(crate) fn topological_charge_cache_key(
    object_id: &str,
    quantity_id: &str,
    field_revision: u64,
    mesh_revision: u64,
    mesh_generation_id: Option<&str>,
    scene_revision: u64,
    plane: &str,
    request_scope: &str,
    method: &str,
) -> String {
    format!(
        "analysis:topological-charge:{object_id}:{quantity_id}:field={field_revision}:mesh={mesh_revision}:mesh-gen={mesh_generation_id}:scene={scene_revision}:plane={plane}:scope={request_scope}:method={method}:v2",
        mesh_generation_id = mesh_generation_id.unwrap_or("none"),
    )
}

/// Data-plane store holding the binary projection cache and the binary slice cache.
///
/// Held in `AppState` as `Arc<QuantityDataPlaneStore>`. Independent locks keep unrelated
/// topology, projection, slice, and analysis resources from blocking one another.
pub(crate) struct QuantityDataPlaneStore {
    /// Bounded shared FMMT buffers keyed by exact route-specific topology ETag.
    pub topology_cache: StdMutex<SharedBinaryCache>,
    /// Cache for projected (component-selected or magnitude) field vector binaries.
    pub projection_cache: Mutex<BinaryCache>,
    /// Cache for 2-D scalar slice binaries.
    pub scalar_slice_cache: Mutex<BinaryCache>,
    /// Cache for 2-D arrow glyph slice binaries.
    pub arrow_slice_cache: Mutex<BinaryCache>,
    /// Cache for mesh-revision keyed FEM normal-axis indexes.
    pub fem_spatial_index_cache: Mutex<HashMap<String, Arc<FemNormalAxisIndex>>>,
    /// Cache for small JSON analysis resources keyed by source revisions.
    pub topological_charge_cache: Mutex<JsonResourceCache>,
    /// Bounded revision-keyed results shared by planar meta/binary resources.
    pub planar_sample_cache: Mutex<PlanarSampleCache>,
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
            DEFAULT_MAX_ANALYSIS_RESOURCE_ENTRIES,
            DEFAULT_MAX_BYTES,
        )
    }

    pub fn with_budgets(
        max_projection: usize,
        max_scalar_slices: usize,
        max_arrow_slices: usize,
        max_analysis_resources: usize,
        max_bytes_each: usize,
    ) -> Self {
        Self {
            topology_cache: StdMutex::new(SharedBinaryCache::new(
                DEFAULT_MAX_TOPOLOGY_ENTRIES,
                DEFAULT_MAX_TOPOLOGY_BYTES,
            )),
            projection_cache: Mutex::new(BinaryCache::new(max_projection, max_bytes_each)),
            scalar_slice_cache: Mutex::new(BinaryCache::new(max_scalar_slices, max_bytes_each)),
            arrow_slice_cache: Mutex::new(BinaryCache::new(max_arrow_slices, max_bytes_each)),
            fem_spatial_index_cache: Mutex::new(HashMap::new()),
            topological_charge_cache: Mutex::new(JsonResourceCache::new(max_analysis_resources)),
            planar_sample_cache: Mutex::new(PlanarSampleCache::new(
                DEFAULT_MAX_PLANAR_SAMPLE_ENTRIES,
                DEFAULT_MAX_BYTES,
            )),
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
    use crate::planar_sampling::{Occupancy, PlanarSampleMeta};

    fn planar_sample(value_count: usize) -> Arc<PlanarSampleResult> {
        Arc::new(PlanarSampleResult {
            meta: PlanarSampleMeta {
                sampler_version: "test",
                sampling_method: "test",
                monitor_id: "monitor".to_string(),
                monitor_hash: "hash".to_string(),
                bounds_uv_m: [0.0, 1.0, 0.0, 1.0],
                resolution: [value_count as u32, 1],
                occupied_count: value_count as u32,
                partial_count: 0,
                empty_count: 0,
                occupied_measure: value_count as f64,
                overlap_count: 0,
                fold_count: 0,
                non_injective: false,
                basis_order: 0,
                integration_order: 0,
            },
            scalar_values: vec![1.0; value_count],
            vector_values: None,
            occupancy: vec![Occupancy::Occupied; value_count],
            source_entity_ids: vec![Some(0); value_count],
            overlay: None,
        })
    }

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
    fn shared_binary_cache_builds_each_exact_identity_once() {
        let mut cache = SharedBinaryCache::new(2, 1024);
        let mut build_count = 0;

        let first = cache
            .get_or_try_insert_with("topology-etag", || {
                build_count += 1;
                Ok::<_, ()>(vec![1u8; 64])
            })
            .expect("first topology build");
        let second = cache
            .get_or_try_insert_with("topology-etag", || {
                build_count += 1;
                Ok::<_, ()>(vec![2u8; 64])
            })
            .expect("cached topology build");

        assert_eq!(build_count, 1);
        assert!(Arc::ptr_eq(&first, &second));
    }

    #[test]
    fn planar_sample_cache_reuses_results_and_evicts_to_its_byte_budget() {
        let small = planar_sample(4);
        let estimated = estimate_planar_sample_bytes(&small);
        let mut cache = PlanarSampleCache::new(2, estimated * 2);
        cache.insert("first".to_string(), Arc::clone(&small));

        let hit = cache.get("first").expect("cached planar sample");
        assert!(Arc::ptr_eq(&hit, &small));

        cache.insert("second".to_string(), planar_sample(4));
        let _ = cache.get("second");
        cache.insert("third".to_string(), planar_sample(4));
        assert!(
            cache.get("first").is_none(),
            "least-recent sample is evicted"
        );
        assert!(cache.get("second").is_some());
        assert!(cache.get("third").is_some());
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
        let key = projection_cache_key("m", "session-17", 7, 42, "x");
        assert_eq!(key, "fmvp-proj:m:session-17:7:42:x:v3");
    }

    #[test]
    fn slice_cache_key_format() {
        let key = slice_cache_key(
            "m",
            "session-17",
            7,
            "42",
            "xy",
            "norm:4602678819172646912",
            128,
            128,
            "x",
            false,
            4,
            20_000,
        );
        assert!(key.starts_with("fmvp-slice:m:session-17:7:42:xy:norm:"));
    }

    #[test]
    fn every_session_scoped_projection_and_slice_key_binds_session_identity() {
        let scalar = scalar_projection_cache_key(
            "m",
            "session-17",
            7,
            "42",
            "xy",
            16,
            16,
            "magnitude",
            "mean",
            false,
            4,
            None,
            None,
            None,
        );
        let empty = projection_empty_mask_cache_key(
            "m",
            "session-17",
            7,
            "42",
            "xy",
            16,
            16,
            "magnitude",
            "mean",
            false,
            4,
            None,
            None,
            None,
        );
        let slice = slice_cache_key(
            "m",
            "session-17",
            7,
            "42",
            "xy",
            "norm:0",
            16,
            16,
            "magnitude",
            true,
            4,
            100,
        );

        for key in [scalar, empty, slice] {
            assert!(
                key.contains("session-17"),
                "session-scoped cache key is missing session identity: {key}"
            );
            assert!(!key.ends_with("v1") && !key.ends_with("v2") || key.contains("proj-"));
        }
    }

    #[test]
    fn topological_charge_cache_key_distinguishes_analysis_scope() {
        let common = |scope| {
            topological_charge_cache_key(
                "magnet",
                "m",
                7,
                0,
                None,
                4,
                "xy",
                scope,
                "berg_luescher_oriented_triangles_v2",
            )
        };
        assert_ne!(
            common("resolution=auto:support=midplane:profile=None:snapshot=None:stage=None"),
            common(
                "resolution=auto:support=layer_profile:profile=Some(33):snapshot=None:stage=None"
            ),
        );
    }
}
