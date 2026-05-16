# FEM CPU PBC Demag Benchmark Fixture Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Add a deterministic CPU-only Rust FEM PBC demag benchmark fixture with periodic metadata and machine-readable metrics.

**Architecture:** A new `fullmag-engine::fem_pbc_benchmark` module builds a small structured x-periodic/open-yz FEM problem and times repeated public `observe()` calls. Integration tests validate fixture topology and metrics without relying on timing thresholds.

**Tech Stack:** Rust, `fullmag-engine`, existing FEM reference path.

---

### Task 1: Add RED Integration Test

**Files:**
- Create: `crates/fullmag-engine/tests/fem_pbc_demag_benchmark.rs`

- [ ] **Step 1: Write the failing API test**

Create a test that imports:

```rust
use fullmag_engine::fem_pbc_benchmark::{
    build_reference_pbc_demag_benchmark_problem,
    run_reference_pbc_demag_benchmark,
};
```

The test must assert:

```rust
let fixture = build_reference_pbc_demag_benchmark_problem(2).expect("fixture");
assert!(fixture.problem.topology.n_nodes > 0);
assert!(fixture.problem.topology.periodic_node_pairs.len() > 0);
assert_eq!(fixture.open_axis_count, 2);

let metrics = run_reference_pbc_demag_benchmark(2, 1, 2).expect("metrics");
assert_eq!(metrics.periodic_node_pairs, fixture.problem.topology.periodic_node_pairs.len());
assert!(metrics.elapsed_ns > 0);
assert!(metrics.demag_energy_joules >= 0.0);
assert!(metrics.max_demag_field_amplitude > 0.0);
```

- [ ] **Step 2: Run RED**

Run:

```bash
cargo test -p fullmag-engine fem_pbc_demag_benchmark
```

Expected: compile failure because `fem_pbc_benchmark` does not exist.

### Task 2: Implement Fixture Module

**Files:**
- Create: `crates/fullmag-engine/src/fem_pbc_benchmark.rs`
- Modify: `crates/fullmag-engine/src/lib.rs`

- [ ] **Step 1: Add public metrics types**

Create:

```rust
pub struct ReferencePbcDemagBenchmarkFixture {
    pub problem: FemLlgProblem,
    pub magnetization: Vec<Vector3>,
    pub open_axis_count: usize,
}

pub struct ReferencePbcDemagBenchmarkMetrics {
    pub nodes: usize,
    pub elements: usize,
    pub periodic_node_pairs: usize,
    pub warmup_repeats: usize,
    pub measured_repeats: usize,
    pub elapsed_ns: u128,
    pub demag_energy_joules: f64,
    pub max_demag_field_amplitude: f64,
}
```

- [ ] **Step 2: Build x-periodic/open-yz mesh**

Use `studies::build_structured_box_tet_mesh`, retain only pairs whose
`pair_id == "x_faces"`, and construct a `FemLlgProblem` with `demag=true`,
`exchange=false`.

- [ ] **Step 3: Add timing runner**

Run `warmup_repeats` untimed `observe()` calls, then time `measured_repeats`
calls with `std::time::Instant`. Return the final observables in metrics.

- [ ] **Step 4: Export module**

Add `pub mod fem_pbc_benchmark;` to `crates/fullmag-engine/src/lib.rs`.

### Task 3: Verify and Update Audit

**Files:**
- Modify: `docs/physics/0800-fem-static-pbc-demag.md`
- Modify: `docs/reports/15.05.2026/fem-solver-physics-performance-audit.md`

- [ ] **Step 1: Mark benchmark fixture in physics note**

Mark the CPU reference fixture as implemented while leaving the golden
repeated-supercell benchmark open.

- [ ] **Step 2: Mark audit item as partially closed**

State that the repository now has a CPU reference PBC demag benchmark fixture,
but full MFEM/CUDA benchmark execution remains blocked by environment/preflight.

- [ ] **Step 3: Run verification**

```bash
cargo test -p fullmag-engine fem_pbc_demag_benchmark
cargo test -p fullmag-engine periodic_demag
cargo fmt --check -p fullmag-engine
git diff --check
```
