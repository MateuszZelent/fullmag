//! NUMA-aware runtime configuration for HPC workloads (B5).
//!
//! Provides:
//! - aligned buffer allocation (cache-line / page-aligned),
//! - thread-pool sizing and optional pinning,
//! - runtime config struct for multi-socket awareness.
//!
//! This module does NOT modify the global Rayon pool automatically;
//! callers use [`HpcRuntimeConfig::apply`] to set thread counts and
//! optionally configure affinity.

/// Cache line size in bytes (x86-64 / ARM Neoverse).
pub const CACHE_LINE_BYTES: usize = 64;

/// Runtime configuration for CPU HPC workloads.
#[derive(Debug, Clone)]
pub struct HpcRuntimeConfig {
    /// Number of worker threads for compute (0 = auto-detect).
    pub num_threads: usize,
    /// Whether to set Rayon's global thread pool size on [`apply`].
    pub configure_rayon: bool,
    /// Optional NUMA node index for memory binding hints.
    pub numa_node: Option<usize>,
    /// Prefer huge pages for large allocations (Linux only).
    pub prefer_huge_pages: bool,
}

impl Default for HpcRuntimeConfig {
    fn default() -> Self {
        Self {
            num_threads: 0,
            configure_rayon: false,
            numa_node: None,
            prefer_huge_pages: false,
        }
    }
}

impl HpcRuntimeConfig {
    /// Apply this configuration to the process.
    ///
    /// Currently configures only the Rayon global thread pool.
    /// NUMA pinning is advisory — reported but not enforced
    /// (requires OS-specific APIs or `libnuma`).
    #[cfg(feature = "parallel")]
    pub fn apply(&self) -> Result<(), String> {
        if self.configure_rayon {
            let n = if self.num_threads == 0 {
                num_cpus()
            } else {
                self.num_threads
            };
            rayon::ThreadPoolBuilder::new()
                .num_threads(n)
                .build_global()
                .map_err(|e| format!("Rayon pool init failed: {e}"))?;
        }
        Ok(())
    }

    #[cfg(not(feature = "parallel"))]
    pub fn apply(&self) -> Result<(), String> {
        Ok(())
    }
}

/// Detect the number of online CPUs.
#[cfg(feature = "parallel")]
fn num_cpus() -> usize {
    std::thread::available_parallelism()
        .map(|n| n.get())
        .unwrap_or(1)
}

// ── Aligned allocation helpers ─────────────────────────────────────────

/// Allocate a `Vec<f64>` of length `n` whose pointer is aligned to
/// `align` bytes (must be a power of two ≥ 8).
///
/// The returned vector is zero-initialised.
pub fn aligned_f64_vec(n: usize, align: usize) -> Vec<f64> {
    assert!(align.is_power_of_two() && align >= 8);
    if n == 0 {
        return Vec::new();
    }
    // Use Layout to get aligned memory, then wrap in Vec.
    let layout = std::alloc::Layout::from_size_align(n * 8, align).expect("invalid layout");
    unsafe {
        let ptr = std::alloc::alloc_zeroed(layout) as *mut f64;
        if ptr.is_null() {
            std::alloc::handle_alloc_error(layout);
        }
        Vec::from_raw_parts(ptr, n, n)
    }
}

/// Allocate a cache-line-aligned `Vec<f64>` of length `n`.
pub fn cacheline_aligned_f64_vec(n: usize) -> Vec<f64> {
    aligned_f64_vec(n, CACHE_LINE_BYTES)
}

// ── B8: Thread scaling analysis ────────────────────────────────────────

/// Result of a single thread-count scaling measurement.
#[derive(Debug, Clone)]
pub struct ScalingPoint {
    pub num_threads: usize,
    pub wall_seconds: f64,
    pub steps: u64,
    pub steps_per_second: f64,
}

/// Summary of a thread-scaling sweep (B8).
#[derive(Debug, Clone)]
pub struct ScalingReport {
    pub problem_size: usize,
    pub points: Vec<ScalingPoint>,
}

impl ScalingReport {
    /// Compute parallel speedup relative to the first (smallest thread count) measurement.
    pub fn speedups(&self) -> Vec<(usize, f64)> {
        if self.points.is_empty() {
            return Vec::new();
        }
        let baseline = self.points[0].steps_per_second;
        self.points
            .iter()
            .map(|p| (p.num_threads, p.steps_per_second / baseline))
            .collect()
    }

    /// Compute parallel efficiency (speedup / num_threads) for each measurement.
    pub fn efficiencies(&self) -> Vec<(usize, f64)> {
        self.speedups()
            .into_iter()
            .map(|(n, s)| (n, s / n as f64))
            .collect()
    }

    /// Format a human-readable scaling report.
    pub fn format_table(&self) -> String {
        let mut out = format!(
            "Thread-scaling report (N = {} cells)\n{}\n{:<8} {:>12} {:>10} {:>10}\n{}\n",
            self.problem_size,
            "-".repeat(48),
            "Threads",
            "Steps/sec",
            "Speedup",
            "Effic.",
            "-".repeat(48),
        );
        let speedups = self.speedups();
        let effs = self.efficiencies();
        for (i, p) in self.points.iter().enumerate() {
            out.push_str(&format!(
                "{:<8} {:>12.1} {:>10.2}x {:>9.1}%\n",
                p.num_threads,
                p.steps_per_second,
                speedups[i].1,
                effs[i].1 * 100.0,
            ));
        }
        out
    }
}
