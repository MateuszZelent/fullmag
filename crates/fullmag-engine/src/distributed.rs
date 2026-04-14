//! Distributed HPC types for multi-rank FDM/FEM domain decomposition (B9/D1).
//!
//! Provides the foundational data structures for distributing a single
//! large simulation across multiple MPI ranks:
//!
//! - [`DistributedGridShape`] — global grid with decomposition metadata
//! - [`RankLocalSubdomain`] — per-rank local slab with halo regions
//! - [`HaloBuffers`] — send/recv buffers for neighbour exchange
//! - [`GlobalReductionService`] — trait for all-reduce operations
//! - [`DistributedCheckpointMetadata`] — per-rank checkpoint descriptor
//!
//! # Decomposition Strategy
//!
//! The default decomposition is a 1D slab along the Z axis (the slowest
//! varying index in row-major layout).  This maximises contiguity of local
//! data and minimises the halo surface area relative to volume.
//!
//! Future extensions may add pencil (2D) decomposition for very large grids.

use crate::{GridShape, Vector3};

// ── DistributedGridShape ───────────────────────────────────────────────

/// Global grid shape annotated with decomposition into ranks.
#[derive(Debug, Clone, PartialEq)]
pub struct DistributedGridShape {
    /// Full (global) grid dimensions.
    pub global: GridShape,
    /// Number of ranks participating in the simulation.
    pub world_size: usize,
    /// Decomposition axis (0 = X, 1 = Y, 2 = Z).  Default: 2 (Z-slab).
    pub decomp_axis: usize,
}

impl DistributedGridShape {
    /// Create a Z-slab decomposition for `world_size` ranks.
    pub fn z_slab(global: GridShape, world_size: usize) -> Self {
        assert!(world_size > 0, "world_size must be >= 1");
        Self {
            global,
            world_size,
            decomp_axis: 2,
        }
    }

    /// Compute the local extent along the decomposition axis for a given rank.
    ///
    /// Distributes cells as evenly as possible; lower ranks get the remainder.
    pub fn local_extent(&self, rank: usize) -> usize {
        let dim = self.axis_size();
        let base = dim / self.world_size;
        let remainder = dim % self.world_size;
        if rank < remainder {
            base + 1
        } else {
            base
        }
    }

    /// Starting global index along decomp axis for a given rank.
    pub fn local_offset(&self, rank: usize) -> usize {
        let dim = self.axis_size();
        let base = dim / self.world_size;
        let remainder = dim % self.world_size;
        // Ranks 0..remainder get (base+1) each, then the rest get base.
        if rank < remainder {
            rank * (base + 1)
        } else {
            remainder * (base + 1) + (rank - remainder) * base
        }
    }

    /// Build a [`RankLocalSubdomain`] for the given rank with `halo_width` ghost layers.
    pub fn subdomain(&self, rank: usize, halo_width: usize) -> RankLocalSubdomain {
        let extent = self.local_extent(rank);
        let offset = self.local_offset(rank);
        let has_lower_neighbor = rank > 0;
        let has_upper_neighbor = rank + 1 < self.world_size;
        let lower_halo = if has_lower_neighbor { halo_width } else { 0 };
        let upper_halo = if has_upper_neighbor { halo_width } else { 0 };

        // Local grid: owned + halos
        let local_dim = extent + lower_halo + upper_halo;
        let mut dims = [self.global.nx, self.global.ny, self.global.nz];
        dims[self.decomp_axis] = local_dim;

        RankLocalSubdomain {
            rank,
            world_size: self.world_size,
            global_offset: offset,
            owned_extent: extent,
            lower_halo,
            upper_halo,
            decomp_axis: self.decomp_axis,
            local_grid: GridShape {
                nx: dims[0],
                ny: dims[1],
                nz: dims[2],
            },
        }
    }

    fn axis_size(&self) -> usize {
        match self.decomp_axis {
            0 => self.global.nx,
            1 => self.global.ny,
            2 => self.global.nz,
            _ => unreachable!("decomp_axis must be 0, 1, or 2"),
        }
    }
}

// ── RankLocalSubdomain ─────────────────────────────────────────────────

/// Per-rank view of the decomposed grid.
#[derive(Debug, Clone, PartialEq)]
pub struct RankLocalSubdomain {
    pub rank: usize,
    pub world_size: usize,
    /// Starting index of owned cells in the global decomp-axis.
    pub global_offset: usize,
    /// Number of owned (non-halo) cells along the decomp axis.
    pub owned_extent: usize,
    /// Number of ghost layers on the lower side (from rank − 1).
    pub lower_halo: usize,
    /// Number of ghost layers on the upper side (from rank + 1).
    pub upper_halo: usize,
    pub decomp_axis: usize,
    /// Local grid including halo cells.
    pub local_grid: GridShape,
}

impl RankLocalSubdomain {
    /// Total number of local cells (owned + halo).
    pub fn total_cells(&self) -> usize {
        self.local_grid.cell_count()
    }

    /// Number of owned (non-halo) cells.
    pub fn owned_cells(&self) -> usize {
        let factor = match self.decomp_axis {
            0 => self.local_grid.ny * self.local_grid.nz,
            1 => self.local_grid.nx * self.local_grid.nz,
            2 => self.local_grid.nx * self.local_grid.ny,
            _ => unreachable!(),
        };
        self.owned_extent * factor
    }

    /// Whether this rank has a lower neighbour.
    pub fn has_lower_neighbor(&self) -> bool {
        self.rank > 0
    }

    /// Whether this rank has an upper neighbour.
    pub fn has_upper_neighbor(&self) -> bool {
        self.rank + 1 < self.world_size
    }
}

// ── HaloBuffers ────────────────────────────────────────────────────────

/// Pre-allocated send/receive buffers for halo exchange between neighbours.
///
/// For a Z-slab decomposition the halo is a contiguous xy-plane, so each
/// buffer holds `halo_width × (nx × ny)` vectors.
#[derive(Debug, Clone)]
pub struct HaloBuffers {
    /// Data to send to the lower neighbour (last `halo_width` owned layers).
    pub send_lower: Vec<Vector3>,
    /// Data received from the lower neighbour.
    pub recv_lower: Vec<Vector3>,
    /// Data to send to the upper neighbour (first `halo_width` owned layers).
    pub send_upper: Vec<Vector3>,
    /// Data received from the upper neighbour.
    pub recv_upper: Vec<Vector3>,
}

impl HaloBuffers {
    /// Allocate halo buffers for a given subdomain.
    pub fn new(sub: &RankLocalSubdomain) -> Self {
        let plane_size = match sub.decomp_axis {
            0 => sub.local_grid.ny * sub.local_grid.nz,
            1 => sub.local_grid.nx * sub.local_grid.nz,
            2 => sub.local_grid.nx * sub.local_grid.ny,
            _ => unreachable!(),
        };
        let lower_count = sub.lower_halo * plane_size;
        let upper_count = sub.upper_halo * plane_size;

        Self {
            send_lower: vec![[0.0; 3]; lower_count],
            recv_lower: vec![[0.0; 3]; lower_count],
            send_upper: vec![[0.0; 3]; upper_count],
            recv_upper: vec![[0.0; 3]; upper_count],
        }
    }

    /// Pack the lower halo send buffer from owned magnetization data.
    ///
    /// For Z-slab: copies the first `halo_width` owned layers
    /// (at indices `lower_halo .. lower_halo + halo_width` in local array).
    pub fn pack_send_lower(&mut self, local_mag: &[Vector3], sub: &RankLocalSubdomain) {
        if sub.lower_halo == 0 {
            return;
        }
        let plane = Self::plane_size(sub);
        let start = sub.lower_halo * plane;
        let count = sub.lower_halo * plane;
        self.send_lower[..count].copy_from_slice(&local_mag[start..start + count]);
    }

    /// Pack the upper halo send buffer from owned magnetization data.
    ///
    /// For Z-slab: copies the last `halo_width` owned layers.
    pub fn pack_send_upper(&mut self, local_mag: &[Vector3], sub: &RankLocalSubdomain) {
        if sub.upper_halo == 0 {
            return;
        }
        let plane = Self::plane_size(sub);
        let end_owned = (sub.lower_halo + sub.owned_extent) * plane;
        let count = sub.upper_halo * plane;
        let start = end_owned - count;
        self.send_upper[..count].copy_from_slice(&local_mag[start..start + count]);
    }

    /// Unpack received lower halo into the local magnetization array.
    pub fn unpack_recv_lower(&self, local_mag: &mut [Vector3], sub: &RankLocalSubdomain) {
        if sub.lower_halo == 0 {
            return;
        }
        let count = sub.lower_halo * Self::plane_size(sub);
        local_mag[..count].copy_from_slice(&self.recv_lower[..count]);
    }

    /// Unpack received upper halo into the local magnetization array.
    pub fn unpack_recv_upper(&self, local_mag: &mut [Vector3], sub: &RankLocalSubdomain) {
        if sub.upper_halo == 0 {
            return;
        }
        let plane = Self::plane_size(sub);
        let count = sub.upper_halo * plane;
        let start = (sub.lower_halo + sub.owned_extent) * plane;
        local_mag[start..start + count].copy_from_slice(&self.recv_upper[..count]);
    }

    fn plane_size(sub: &RankLocalSubdomain) -> usize {
        match sub.decomp_axis {
            0 => sub.local_grid.ny * sub.local_grid.nz,
            1 => sub.local_grid.nx * sub.local_grid.nz,
            2 => sub.local_grid.nx * sub.local_grid.ny,
            _ => unreachable!(),
        }
    }
}

// ── GlobalReductionService ─────────────────────────────────────────────

/// Trait abstracting global collective operations (all-reduce, barrier).
///
/// The default implementation is a no-op single-rank stub.
/// An MPI-backed implementation will be added when the `mpi` feature is enabled.
pub trait GlobalReductionService {
    /// All-reduce sum of a scalar value across all ranks.
    fn all_reduce_sum_f64(&self, local: f64) -> f64;

    /// All-reduce max of a scalar value across all ranks.
    fn all_reduce_max_f64(&self, local: f64) -> f64;

    /// Barrier: block until all ranks have arrived.
    fn barrier(&self);

    /// Current rank index.
    fn rank(&self) -> usize;

    /// Total number of ranks.
    fn world_size(&self) -> usize;
}

/// Single-rank (non-distributed) stub — passes through values unchanged.
#[derive(Debug, Clone, Copy)]
pub struct SingleRankReduction;

impl GlobalReductionService for SingleRankReduction {
    fn all_reduce_sum_f64(&self, local: f64) -> f64 {
        local
    }
    fn all_reduce_max_f64(&self, local: f64) -> f64 {
        local
    }
    fn barrier(&self) {}
    fn rank(&self) -> usize {
        0
    }
    fn world_size(&self) -> usize {
        1
    }
}

// ── DistributedCheckpointMetadata ──────────────────────────────────────

/// Per-rank metadata written alongside partial checkpoint data.
#[derive(Debug, Clone, PartialEq)]
pub struct DistributedCheckpointMetadata {
    /// MPI rank that owns this shard.
    pub rank: usize,
    /// Total ranks in the checkpoint.
    pub world_size: usize,
    /// Global offset along the decomposition axis.
    pub global_offset: usize,
    /// Number of owned cells along the decomposition axis.
    pub owned_extent: usize,
    /// Simulation time at checkpoint.
    pub time_seconds: f64,
    /// Step counter at checkpoint.
    pub step_count: u64,
}

impl DistributedCheckpointMetadata {
    pub fn from_subdomain(sub: &RankLocalSubdomain, time: f64, step: u64) -> Self {
        Self {
            rank: sub.rank,
            world_size: sub.world_size,
            global_offset: sub.global_offset,
            owned_extent: sub.owned_extent,
            time_seconds: time,
            step_count: step,
        }
    }
}

// ── D1: Distributed session runtime ────────────────────────────────────

/// Full distributed simulation session descriptor (D1).
///
/// Bundles the rank identity, subdomain assignment, and references to the
/// collective communications handle.  Created once at startup and threaded
/// through the solve loop.
#[derive(Debug, Clone)]
pub struct DistributedSession {
    pub rank: usize,
    pub world_size: usize,
    pub subdomain: RankLocalSubdomain,
    pub halo_width: usize,
}

impl DistributedSession {
    pub fn new(dist: &DistributedGridShape, rank: usize, halo_width: usize) -> Self {
        let subdomain = dist.subdomain(rank, halo_width);
        Self {
            rank,
            world_size: dist.world_size,
            subdomain,
            halo_width,
        }
    }
}

// ── D2: Distributed FDM solve step ordering ────────────────────────────

/// Stages of a distributed FDM LLG step (D2).
///
/// Used to tag telemetry and orchestrate the MPI pipeline.
#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub enum DistributedFdmStage {
    /// Halo exchange for exchange stencil.
    HaloExchange,
    /// Local field computation (exchange, anisotropy, external, thermal).
    LocalFields,
    /// Distributed demag (MPI FFT).
    DistributedDemag,
    /// Global scalar reductions (energy, max |dm/dt|).
    GlobalReduction,
    /// Time integration (purely local).
    Integration,
}

// ── D3: Distributed FEM types ──────────────────────────────────────────

/// Parallel mesh partition descriptor for distributed FEM (D3).
///
/// In the MFEM-native path this maps to `ParMesh` ownership; in the Rust
/// reference path it describes which elements / dofs are local.
#[derive(Debug, Clone)]
pub struct FemPartitionDescriptor {
    /// MPI rank owning this partition.
    pub rank: usize,
    pub world_size: usize,
    /// Global element indices owned by this rank.
    pub owned_elements: Vec<usize>,
    /// Global DOF indices owned by this rank.
    pub owned_dofs: Vec<usize>,
    /// Shared (interface) DOF indices that require communication.
    pub shared_dofs: Vec<usize>,
}

/// Which distributed FEM operator backend to use (D3).
#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub enum DistributedFemBackend {
    /// MFEM ParBilinearForm + HypreParMatrix (production).
    MfemNative,
    /// Rust reference with explicit DOF scatter/gather (testing only).
    RustReference,
}

// ── D4: Distributed I/O ────────────────────────────────────────────────

/// Policy for writing checkpoint data in a distributed run (D4).
#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub enum CheckpointIoPolicy {
    /// Each rank writes its own shard file.
    RankLocal,
    /// A single parallel file (e.g., HDF5-MPI) written collectively.
    CollectiveParallel,
}

/// Describes a single checkpoint shard written by one rank (D4).
#[derive(Debug, Clone, PartialEq)]
pub struct CheckpointShard {
    pub metadata: DistributedCheckpointMetadata,
    /// Byte offset within the collective file (if CollectiveParallel), or 0.
    pub file_offset: u64,
    /// Size in bytes of the owned data payload.
    pub payload_bytes: u64,
}

/// Global checkpoint manifest — written by rank 0, read by all on restart.
#[derive(Debug, Clone, PartialEq)]
pub struct CheckpointManifest {
    pub world_size: usize,
    pub time_seconds: f64,
    pub step_count: u64,
    pub io_policy: CheckpointIoPolicy,
    pub shards: Vec<CheckpointShard>,
}

impl CheckpointManifest {
    /// Validate that the manifest covers all ranks exactly once.
    pub fn validate(&self) -> std::result::Result<(), String> {
        if self.shards.len() != self.world_size {
            return Err(format!(
                "manifest has {} shards but world_size is {}",
                self.shards.len(),
                self.world_size,
            ));
        }
        for (i, shard) in self.shards.iter().enumerate() {
            if shard.metadata.rank != i {
                return Err(format!(
                    "shard {} has rank {}, expected {}",
                    i, shard.metadata.rank, i,
                ));
            }
        }
        Ok(())
    }
}

// ── Tests ──────────────────────────────────────────────────────────────

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn z_slab_decomposition_covers_all_cells() {
        let g = GridShape::new(4, 4, 16).unwrap();
        let dist = DistributedGridShape::z_slab(g, 4);

        let total: usize = (0..4).map(|r| dist.local_extent(r)).sum();
        assert_eq!(total, 16, "all Z layers must be covered");

        // Offsets should be contiguous
        for r in 0..4 {
            let off = dist.local_offset(r);
            let ext = dist.local_extent(r);
            if r + 1 < 4 {
                assert_eq!(off + ext, dist.local_offset(r + 1));
            }
        }
    }

    #[test]
    fn z_slab_uneven_distribution() {
        let g = GridShape::new(2, 2, 7).unwrap();
        let dist = DistributedGridShape::z_slab(g, 3);
        // 7 / 3 = 2 remainder 1 → ranks 0 gets 3, ranks 1-2 get 2
        assert_eq!(dist.local_extent(0), 3);
        assert_eq!(dist.local_extent(1), 2);
        assert_eq!(dist.local_extent(2), 2);
    }

    #[test]
    fn subdomain_halo_sizes() {
        let g = GridShape::new(4, 4, 8).unwrap();
        let dist = DistributedGridShape::z_slab(g, 2);
        let sub0 = dist.subdomain(0, 1);
        let sub1 = dist.subdomain(1, 1);

        // Rank 0: no lower halo, 1 upper halo
        assert_eq!(sub0.lower_halo, 0);
        assert_eq!(sub0.upper_halo, 1);
        assert_eq!(sub0.owned_extent, 4);

        // Rank 1: 1 lower halo, no upper halo
        assert_eq!(sub1.lower_halo, 1);
        assert_eq!(sub1.upper_halo, 0);
        assert_eq!(sub1.owned_extent, 4);
    }

    #[test]
    fn halo_pack_unpack_round_trip() {
        let g = GridShape::new(2, 2, 8).unwrap();
        let dist = DistributedGridShape::z_slab(g, 2);
        let sub = dist.subdomain(0, 1);

        // Local mag: owned_extent=4, upper_halo=1, total layers=5, each plane=4
        let total = sub.total_cells();
        let mut local_mag: Vec<Vector3> = (0..total).map(|i| [i as f64, 0.0, 0.0]).collect();

        let mut halo = HaloBuffers::new(&sub);
        halo.pack_send_upper(&local_mag, &sub);

        // The upper send buffer should contain the last halo_width layers of owned
        let plane = 2 * 2; // nx * ny
        let expected_start = (sub.lower_halo + sub.owned_extent - sub.upper_halo) * plane;
        for (i, v) in halo.send_upper.iter().enumerate() {
            assert_eq!(v[0], (expected_start + i) as f64);
        }

        // Simulate receiving — copy send_upper → recv_upper
        // (in real MPI this goes to the neighbor)
        let fake_recv: Vec<Vector3> = (0..plane).map(|i| [100.0 + i as f64, 0.0, 0.0]).collect();
        local_mag.truncate(total);

        // Construct sub1 to test recv_lower
        let sub1 = dist.subdomain(1, 1);
        let total1 = sub1.total_cells();
        let mut local_mag1: Vec<Vector3> = vec![[0.0; 3]; total1];
        let mut halo1 = HaloBuffers::new(&sub1);
        halo1.recv_lower[..plane].copy_from_slice(&fake_recv);
        halo1.unpack_recv_lower(&mut local_mag1, &sub1);

        for (i, v) in local_mag1[..plane].iter().enumerate() {
            assert_eq!(v[0], 100.0 + i as f64);
        }
    }

    #[test]
    fn single_rank_reduction_passthrough() {
        let r = SingleRankReduction;
        assert_eq!(r.all_reduce_sum_f64(42.0), 42.0);
        assert_eq!(r.all_reduce_max_f64(3.14), 3.14);
        assert_eq!(r.rank(), 0);
        assert_eq!(r.world_size(), 1);
    }

    #[test]
    fn checkpoint_metadata_from_subdomain() {
        let g = GridShape::new(4, 4, 8).unwrap();
        let dist = DistributedGridShape::z_slab(g, 2);
        let sub = dist.subdomain(1, 1);
        let meta = DistributedCheckpointMetadata::from_subdomain(&sub, 1.5e-9, 100);
        assert_eq!(meta.rank, 1);
        assert_eq!(meta.world_size, 2);
        assert_eq!(meta.global_offset, 4);
        assert_eq!(meta.owned_extent, 4);
        assert_eq!(meta.time_seconds, 1.5e-9);
        assert_eq!(meta.step_count, 100);
    }

    #[test]
    fn distributed_session_construction() {
        let g = GridShape::new(4, 4, 8).unwrap();
        let dist = DistributedGridShape::z_slab(g, 4);
        let session = DistributedSession::new(&dist, 2, 1);
        assert_eq!(session.rank, 2);
        assert_eq!(session.world_size, 4);
        assert_eq!(session.subdomain.owned_extent, 2);
        assert_eq!(session.halo_width, 1);
    }

    #[test]
    fn checkpoint_manifest_validation() {
        let g = GridShape::new(2, 2, 4).unwrap();
        let dist = DistributedGridShape::z_slab(g, 2);
        let shards: Vec<CheckpointShard> = (0..2)
            .map(|r| {
                let sub = dist.subdomain(r, 1);
                CheckpointShard {
                    metadata: DistributedCheckpointMetadata::from_subdomain(&sub, 1e-9, 50),
                    file_offset: 0,
                    payload_bytes: (sub.owned_cells() * 24) as u64,
                }
            })
            .collect();

        let manifest = CheckpointManifest {
            world_size: 2,
            time_seconds: 1e-9,
            step_count: 50,
            io_policy: CheckpointIoPolicy::RankLocal,
            shards,
        };
        assert!(manifest.validate().is_ok());

        // Bad manifest: wrong world_size
        let bad = CheckpointManifest {
            world_size: 3,
            ..manifest.clone()
        };
        assert!(bad.validate().is_err());
    }
}
