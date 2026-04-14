//! Fullmag CPU / HPC Benchmark Harness (Etap A0)
//!
//! Provides systematic benchmarks for FDM and FEM solvers with:
//! - Multiple grid sizes (64³, 128³, 256³)
//! - Isolated term benchmarks (exchange-only, demag-only, full LLG)
//! - Per-step timing breakdown
//! - Allocation counting (via global allocator wrapper)
//! - JSON output for regression tracking

use std::time::Instant;

use fullmag_engine::{
    AdaptiveStepConfig, CellSize, EffectiveFieldTerms, ExchangeLlgProblem, GridShape, LlgConfig,
    MaterialParameters, TimeIntegrator, Vector3,
};
use serde::Serialize;

// ── Allocation counting ────────────────────────────────────────────────

mod alloc_counter {
    use std::alloc::{GlobalAlloc, Layout, System};
    use std::sync::atomic::{AtomicU64, Ordering};

    pub static ALLOC_COUNT: AtomicU64 = AtomicU64::new(0);
    pub static ALLOC_BYTES: AtomicU64 = AtomicU64::new(0);

    pub struct CountingAllocator;

    unsafe impl GlobalAlloc for CountingAllocator {
        unsafe fn alloc(&self, layout: Layout) -> *mut u8 {
            ALLOC_COUNT.fetch_add(1, Ordering::Relaxed);
            ALLOC_BYTES.fetch_add(layout.size() as u64, Ordering::Relaxed);
            unsafe { System.alloc(layout) }
        }

        unsafe fn dealloc(&self, ptr: *mut u8, layout: Layout) {
            unsafe { System.dealloc(ptr, layout) }
        }
    }

    pub fn reset() {
        ALLOC_COUNT.store(0, Ordering::Relaxed);
        ALLOC_BYTES.store(0, Ordering::Relaxed);
    }

    pub fn snapshot() -> (u64, u64) {
        (
            ALLOC_COUNT.load(Ordering::Relaxed),
            ALLOC_BYTES.load(Ordering::Relaxed),
        )
    }
}

#[global_allocator]
static GLOBAL: alloc_counter::CountingAllocator = alloc_counter::CountingAllocator;

// ── Benchmark result types ─────────────────────────────────────────────

#[derive(Debug, Serialize)]
struct BenchmarkResult {
    name: String,
    grid: [usize; 3],
    cell_count: usize,
    integrator: String,
    terms: String,
    steps: usize,
    total_wall_ns: u64,
    wall_per_step_ns: u64,
    allocs_per_step: f64,
    alloc_bytes_per_step: f64,
    /// Time breakdown for the first step (warm cache)
    setup_ns: u64,
}

#[derive(Debug, Serialize)]
struct BenchmarkSuite {
    timestamp: String,
    hostname: String,
    num_threads: usize,
    results: Vec<BenchmarkResult>,
}

// ── Standard material parameters ───────────────────────────────────────

fn permalloy() -> MaterialParameters {
    MaterialParameters {
        saturation_magnetisation: 8e5,
        exchange_stiffness: 1.3e-11,
        damping: 0.01,
    }
}

fn default_dynamics(integrator: TimeIntegrator) -> LlgConfig {
    LlgConfig {
        gyromagnetic_ratio: fullmag_engine::DEFAULT_GYROMAGNETIC_RATIO,
        integrator,
        adaptive: AdaptiveStepConfig::default(),
        precession_enabled: true,
    }
}

// ── Random initial magnetization ───────────────────────────────────────

fn random_magnetization(n: usize, seed: u64) -> Vec<Vector3> {
    // Simple xorshift64* for reproducibility without external deps
    let mut state = seed;
    let mut mag = Vec::with_capacity(n);
    for _ in 0..n {
        let mut v = [0.0f64; 3];
        for c in &mut v {
            state ^= state << 13;
            state ^= state >> 7;
            state ^= state << 17;
            *c = (state as f64 / u64::MAX as f64) * 2.0 - 1.0;
        }
        let norm = (v[0] * v[0] + v[1] * v[1] + v[2] * v[2]).sqrt();
        if norm > 1e-12 {
            v[0] /= norm;
            v[1] /= norm;
            v[2] /= norm;
        } else {
            v = [0.0, 0.0, 1.0];
        }
        mag.push(v);
    }
    mag
}

// ── Benchmark execution ────────────────────────────────────────────────

fn run_benchmark(
    name: &str,
    grid_dims: [usize; 3],
    cell_nm: f64,
    terms: EffectiveFieldTerms,
    integrator: TimeIntegrator,
    steps: usize,
    dt: f64,
) -> BenchmarkResult {
    let [nx, ny, nz] = grid_dims;
    let cell_m = cell_nm * 1e-9;

    let grid = GridShape::new(nx, ny, nz).unwrap();
    let cell_size = CellSize::new(cell_m, cell_m, cell_m).unwrap();
    let dynamics = default_dynamics(integrator);

    let terms_desc = describe_terms(&terms);
    let integrator_name = format!("{:?}", integrator);

    let problem = ExchangeLlgProblem::with_terms(grid, cell_size, permalloy(), dynamics, terms);

    let mag = random_magnetization(grid.cell_count(), 12345);
    let mut state = problem.new_state(mag).unwrap();

    // Pre-allocate workspace and buffers
    let setup_start = Instant::now();
    let mut ws = problem.create_workspace();
    let mut bufs = problem.create_integrator_buffers();
    let setup_ns = setup_start.elapsed().as_nanos() as u64;

    // Warmup: 2 steps (not counted)
    for _ in 0..2 {
        let _ = problem.step_with_buffers(&mut state, dt, &mut ws, &mut bufs);
    }

    // Benchmark
    alloc_counter::reset();
    let bench_start = Instant::now();
    for _ in 0..steps {
        let _ = problem.step_with_buffers(&mut state, dt, &mut ws, &mut bufs);
    }
    let total_wall = bench_start.elapsed();
    let (alloc_count, alloc_bytes) = alloc_counter::snapshot();

    let total_ns = total_wall.as_nanos() as u64;

    BenchmarkResult {
        name: name.to_string(),
        grid: grid_dims,
        cell_count: grid.cell_count(),
        integrator: integrator_name,
        terms: terms_desc,
        steps,
        total_wall_ns: total_ns,
        wall_per_step_ns: total_ns / steps as u64,
        allocs_per_step: alloc_count as f64 / steps as f64,
        alloc_bytes_per_step: alloc_bytes as f64 / steps as f64,
        setup_ns,
    }
}

fn describe_terms(terms: &EffectiveFieldTerms) -> String {
    let mut parts = Vec::new();
    if terms.exchange {
        parts.push("exchange");
    }
    if terms.demag {
        parts.push("demag");
    }
    if terms.external_field.is_some() {
        parts.push("zeeman");
    }
    if terms.uniaxial_anisotropy.is_some() {
        parts.push("uniaxial");
    }
    if terms.cubic_anisotropy.is_some() {
        parts.push("cubic");
    }
    if terms.interfacial_dmi.is_some() {
        parts.push("idmi");
    }
    if terms.bulk_dmi.is_some() {
        parts.push("bulk_dmi");
    }
    if parts.is_empty() {
        "none".to_string()
    } else {
        parts.join("+")
    }
}

// ── Term presets ───────────────────────────────────────────────────────

fn exchange_only() -> EffectiveFieldTerms {
    EffectiveFieldTerms {
        exchange: true,
        demag: false,
        ..Default::default()
    }
}

fn demag_only() -> EffectiveFieldTerms {
    EffectiveFieldTerms {
        exchange: false,
        demag: true,
        ..Default::default()
    }
}

fn exchange_demag() -> EffectiveFieldTerms {
    EffectiveFieldTerms {
        exchange: true,
        demag: true,
        ..Default::default()
    }
}

fn exchange_demag_zeeman() -> EffectiveFieldTerms {
    EffectiveFieldTerms {
        exchange: true,
        demag: true,
        external_field: Some([0.0, 0.0, 0.1]), // 0.1 T along z
        ..Default::default()
    }
}

// ── Main ───────────────────────────────────────────────────────────────

fn main() {
    let num_threads = rayon::current_num_threads();
    eprintln!("fullmag-bench: {} Rayon threads", num_threads);

    let mut results = Vec::new();

    // Grid sizes to benchmark
    let grids: &[([usize; 3], usize)] = &[
        ([64, 64, 1], 50),    // thin film 2D-ish — fast
        ([64, 64, 64], 20),   // 3D cube small
        ([128, 128, 1], 30),  // thin film medium
        ([128, 128, 128], 5), // 3D cube medium (2M cells)
    ];

    // Integrators to test
    let integrators = [TimeIntegrator::Heun, TimeIntegrator::RK45];

    // Term configurations
    let term_configs: Vec<(&str, EffectiveFieldTerms)> = vec![
        ("exchange_only", exchange_only()),
        ("demag_only", demag_only()),
        ("exchange+demag", exchange_demag()),
        ("exchange+demag+zeeman", exchange_demag_zeeman()),
    ];

    let dt = 1e-13;
    let cell_nm = 5.0;

    let total_benchmarks = grids.len() * integrators.len() * term_configs.len();
    let mut done = 0;

    for &(grid_dims, steps) in grids {
        for &integrator in &integrators {
            for (term_name, ref terms) in &term_configs {
                done += 1;
                let name = format!(
                    "fdm_{}_{}x{}x{}_{}",
                    term_name,
                    grid_dims[0],
                    grid_dims[1],
                    grid_dims[2],
                    format!("{:?}", integrator).to_lowercase(),
                );
                eprintln!("[{}/{}] {}", done, total_benchmarks, name);

                let result = run_benchmark(
                    &name,
                    grid_dims,
                    cell_nm,
                    terms.clone(),
                    integrator,
                    steps,
                    dt,
                );

                eprintln!(
                    "  {:.2} ms/step | {:.0} allocs/step | {:.1} KB/step",
                    result.wall_per_step_ns as f64 / 1e6,
                    result.allocs_per_step,
                    result.alloc_bytes_per_step / 1024.0,
                );

                results.push(result);
            }
        }
    }

    let hostname = std::env::var("HOSTNAME")
        .or_else(|_| std::env::var("HOST"))
        .unwrap_or_else(|_| "unknown".to_string());

    let suite = BenchmarkSuite {
        timestamp: chrono_like_now(),
        hostname,
        num_threads,
        results,
    };

    let json = serde_json::to_string_pretty(&suite).unwrap();
    println!("{}", json);
}

/// Simple ISO 8601 timestamp without chrono dependency.
fn chrono_like_now() -> String {
    use std::time::SystemTime;
    let d = SystemTime::now()
        .duration_since(SystemTime::UNIX_EPOCH)
        .unwrap();
    format!("unix_{}", d.as_secs())
}
