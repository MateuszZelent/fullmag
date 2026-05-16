# FEM Explicit-RK Performance Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Make native FEM explicit-RK telemetry and benchmarks cover Heun, RK4, RK23, and RK45 with physically honest final-field cost reporting.

**Architecture:** Keep the existing unified C++ RK stepper. Fix reported cost accounting so final `H_eff` refresh is counted, and extend the Python benchmark harness with an explicit integrator axis.

**Tech Stack:** C++ native FEM bridge, Rust `fullmag-runner` wrapper/tests, Python benchmark scripts, Markdown physics docs.

---

### Task 1: Physics And Design Contract

**Files:**
- Modify: `docs/physics/0490-fem-higher-order-and-adaptive-time-integrators-mfem-gpu.md`
- Create: `docs/superpowers/specs/2026-05-15-fem-explicit-rk-performance-design.md`

- [x] **Step 1: State the approved design**

Record that the performance gate covers all native FEM explicit-RK integrators, not only Heun.

- [x] **Step 2: Update physics note**

Add a section defining final `H_eff` freshness, FSAL reuse, and expected RHS/demag counts for Heun, RK4, RK23, and RK45.

### Task 2: Benchmark Integrator Axis

**Files:**
- Modify: `examples/bench_fem_gpu_long.py`
- Modify: `scripts/analysis/fem_gpu_benchmark.py`
- Test: `packages/fullmag-py/tests/test_fem_benchmark_config.py`

- [x] **Step 1: Write failing benchmark config test**

The test asserts that `FULLMAG_BENCH_INTEGRATOR=rk4` is accepted and appears in the benchmark config and summary payload.

- [x] **Step 2: Implement integrator parsing**

Add supported integrators `heun`, `rk4`, `rk23`, and `rk45`; pass the selected value into `fm.LLG(integrator=..., fixed_timestep=dt)`.

- [x] **Step 3: Sweep integrators in benchmark script**

Add `--integrators`, loop over integrators for each mesh/scenario/backend, and write the integrator column to CSV.

### Task 3: Native RK Cost Telemetry

**Files:**
- Modify: `native/backends/fem/src/mfem_bridge.cpp`
- Modify: `crates/fullmag-runner/src/native_fem.rs`

- [x] **Step 1: Add or update native FEM regression assertions**

When MFEM is available, assert expected first-step RHS counts: Heun `3`, RK4 `5`, RK23 `4`, RK45 `7`. For FSAL methods, assert second-step counts: RK23 `3`, RK45 `6`.

- [x] **Step 2: Count final refresh work**

In `context_step_explicit_rk_mfem`, increment `rhs_evaluations` for the final post-step RHS/effective-field refresh when no FSAL final-stage cache is reused.

### Task 4: Verification

**Files:**
- Verify: `packages/fullmag-py/tests/test_fem_benchmark_config.py`
- Verify: `crates/fullmag-runner/src/native_fem.rs`
- Verify: benchmark scripts

- [x] **Step 1: Run Python benchmark config test**

Run: `python3 -m pytest packages/fullmag-py/tests/test_fem_benchmark_config.py`

- [x] **Step 2: Run Python compile checks**

Run: `python3 -m py_compile examples/bench_fem_gpu_long.py scripts/analysis/fem_gpu_benchmark.py`

- [x] **Step 3: Run targeted Rust check/test**

Run the narrowest available `cargo test -p fullmag-runner native_fem --features fem-gpu` gate. If this host lacks MFEM/CUDA prerequisites, report the exact blocker and keep the source-level test in place for MFEM hosts.
