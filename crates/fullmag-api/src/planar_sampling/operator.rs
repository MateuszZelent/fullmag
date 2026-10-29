//! Geometry-only planar sampling operators reused across field revisions.
//!
//! Plane sampling is linear in the carrier degrees of freedom
//! (`eq-planar-sampling-operator` in docs/physics/0970): the element, local
//! nodes and shape-function weights of every occupied pixel depend only on
//! geometry. They are computed once per geometry key and a new field revision
//! is evaluated by a gather of at most six weights per pixel.

use std::collections::hash_map::DefaultHasher;
use std::collections::HashMap;
use std::hash::{Hash, Hasher};
use std::sync::{Arc, Mutex};

use crate::error::ApiError;

use super::{FemPlanarField, FemSectionExtent, Occupancy, PlanarMeshOverlay};

/// Maximum number of local nodes of a supported plane-sampling element.
pub(crate) const MAX_PLANE_OPERATOR_NODES: usize = 8;

#[derive(Debug, Clone)]
pub(crate) struct FemPlanePixel {
    pub index: u32,
    pub element: u32,
    pub node_count: u8,
    pub nodes: [u32; MAX_PLANE_OPERATOR_NODES],
    pub weights: [f64; MAX_PLANE_OPERATOR_NODES],
}

#[derive(Debug, Clone)]
pub(crate) struct FemPlaneOperator {
    pub resolution: [u32; 2],
    pub topology_fingerprint: u64,
    pub pixels: Vec<FemPlanePixel>,
    pub overlay: PlanarMeshOverlay,
    pub section_extent: Option<FemSectionExtent>,
}

impl FemPlaneOperator {
    fn approximate_bytes(&self) -> usize {
        self.pixels.len() * std::mem::size_of::<FemPlanePixel>()
            + self.overlay.polygons.iter().map(|polygon| polygon.vertices_uv_m.len() * 16 + 32).sum::<usize>()
            + self.overlay.segments.len() * 40
    }

    pub(crate) fn occupancy(&self) -> Vec<Occupancy> {
        let mut occupancy =
            vec![Occupancy::Empty; self.resolution[0] as usize * self.resolution[1] as usize];
        for pixel in &self.pixels {
            occupancy[pixel.index as usize] = Occupancy::Occupied;
        }
        occupancy
    }
}

/// Fingerprint of the carrier topology the operator was built for. A cached
/// operator is reused only when the carrier still has the same nodes,
/// connectivity and target markers.
pub(crate) fn fem_topology_fingerprint(field: &FemPlanarField) -> u64 {
    let mut hasher = DefaultHasher::new();
    field.nodes().len().hash(&mut hasher);
    for node in field.nodes() {
        for coordinate in node {
            coordinate.to_bits().hash(&mut hasher);
        }
    }
    field.elements().len().hash(&mut hasher);
    for element in field.elements() {
        element.nodes().hash(&mut hasher);
    }
    field.markers().hash(&mut hasher);
    hasher.finish()
}

struct CachedOperator {
    operator: Arc<FemPlaneOperator>,
    bytes: usize,
    generation: u64,
}

/// Bounded LRU of plane operators keyed by geometry identity.
pub(crate) struct PlanarOperatorCache {
    inner: Mutex<OperatorEntries>,
    max_entries: usize,
    max_bytes: usize,
}

#[derive(Default)]
struct OperatorEntries {
    entries: HashMap<String, CachedOperator>,
    generation: u64,
    bytes: usize,
    builds: u64,
}

impl PlanarOperatorCache {
    pub(crate) fn new(max_entries: usize, max_bytes: usize) -> Self {
        Self {
            inner: Mutex::new(OperatorEntries::default()),
            max_entries: max_entries.max(1),
            max_bytes,
        }
    }

    /// Number of operators built so far.
    #[cfg(test)]
    pub(crate) fn build_count(&self) -> u64 {
        self.inner.lock().map(|entries| entries.builds).unwrap_or(0)
    }

    pub(crate) fn get_or_build(
        &self,
        key: &str,
        topology_fingerprint: u64,
        build: impl FnOnce() -> Result<FemPlaneOperator, ApiError>,
    ) -> Result<Arc<FemPlaneOperator>, ApiError> {
        {
            let mut entries = self
                .inner
                .lock()
                .map_err(|_| ApiError::internal("planar operator cache lock poisoned"))?;
            entries.generation += 1;
            let generation = entries.generation;
            if let Some(cached) = entries.entries.get_mut(key) {
                if cached.operator.topology_fingerprint == topology_fingerprint {
                    cached.generation = generation;
                    return Ok(Arc::clone(&cached.operator));
                }
            }
        }
        let operator = Arc::new(build()?);
        let bytes = operator.approximate_bytes();
        let mut entries = self
            .inner
            .lock()
            .map_err(|_| ApiError::internal("planar operator cache lock poisoned"))?;
        entries.builds += 1;
        if bytes > self.max_bytes {
            return Ok(operator);
        }
        entries.generation += 1;
        let generation = entries.generation;
        if let Some(previous) = entries.entries.insert(
            key.to_string(),
            CachedOperator {
                operator: Arc::clone(&operator),
                bytes,
                generation,
            },
        ) {
            entries.bytes -= previous.bytes;
        }
        entries.bytes += bytes;
        while entries.entries.len() > self.max_entries || entries.bytes > self.max_bytes {
            let Some(oldest) = entries
                .entries
                .iter()
                .min_by_key(|(_, cached)| cached.generation)
                .map(|(key, _)| key.clone())
            else {
                break;
            };
            if let Some(removed) = entries.entries.remove(&oldest) {
                entries.bytes -= removed.bytes;
            }
        }
        Ok(operator)
    }
}
