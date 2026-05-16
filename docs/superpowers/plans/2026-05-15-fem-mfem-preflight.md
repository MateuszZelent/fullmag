# FEM MFEM Preflight Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Add a strict, deterministic MFEM/prebuilt-native-library readiness gate to the FEM benchmark harness.

**Architecture:** Keep environment detection in `scripts/analysis/fem_gpu_benchmark.py` as pure, unit-testable helpers. The gate prints a JSON preflight summary and only blocks execution when the user explicitly requests a required MFEM stack.

**Tech Stack:** Python benchmark script, pytest, Markdown physics/spec/audit docs.

---

### Task 1: Physics And Design Contract

**Files:**
- Create: `docs/physics/0533-fem-mfem-runtime-preflight-and-benchmark-gate.md`
- Create: `docs/superpowers/specs/2026-05-15-fem-mfem-preflight-design.md`

- [x] **Step 1: Record the physics boundary**

State that this slice changes no FEM governing equations, Python DSL, ProblemIR,
planner legality, or runtime provenance.

- [x] **Step 2: Record the preflight search contract**

Define `FULLMAG_FEM_LIB_DIR`, `MFEM_PREFIX`, `MFEM_DIR`, and
`CMAKE_PREFIX_PATH` handling plus the expected CMake config filenames.

### Task 2: Regression Before Code

**Files:**
- Modify: `packages/fullmag-py/tests/test_fem_benchmark_config.py`
- Inspect: `scripts/analysis/fem_gpu_benchmark.py`

- [x] **Step 1: Add failing preflight tests**

Add pytest coverage for:

- discovery through `MFEM_DIR`,
- discovery through `CMAKE_PREFIX_PATH`,
- validation through `FULLMAG_FEM_LIB_DIR`,
- required-stack failure with remediation when the host is missing MFEM.

- [x] **Step 2: Run the test and verify RED**

Run:

```bash
PYTHONPATH=packages/fullmag-py/src python3 -m pytest packages/fullmag-py/tests/test_fem_benchmark_config.py
```

Expected before implementation: FAIL because `scripts/analysis/fem_gpu_benchmark.py`
does not yet expose the preflight helpers.

### Task 3: Benchmark Preflight Implementation

**Files:**
- Modify: `scripts/analysis/fem_gpu_benchmark.py`

- [x] **Step 1: Add pure environment discovery helpers**

Add helpers to find native FEM prebuilt libraries and MFEM package configs from
an explicit environment mapping.

- [x] **Step 2: Add CLI flags**

Add:

- `--preflight-only`
- `--require-mfem-stack`
- `--skip-preflight`

- [x] **Step 3: Wire the gate into `main()`**

Print `FEM_PREFLIGHT=<json>` unless skipped. Exit with code `2` when the stack
is required and the preflight status is not build/run eligible.

### Task 4: Verification And Audit Refresh

**Files:**
- Verify: `packages/fullmag-py/tests/test_fem_benchmark_config.py`
- Verify: `scripts/analysis/fem_gpu_benchmark.py`
- Modify: `docs/reports/15.05.2026/fem-solver-physics-performance-audit.md`

- [x] **Step 1: Run pytest**

Run:

```bash
PYTHONPATH=packages/fullmag-py/src python3 -m pytest packages/fullmag-py/tests/test_fem_benchmark_config.py
```

- [x] **Step 2: Run Python compile check**

Run:

```bash
python3 -m py_compile scripts/analysis/fem_gpu_benchmark.py examples/bench_fem_gpu_long.py
```

- [x] **Step 3: Run informational and strict preflight commands**

Run:

```bash
python3 scripts/analysis/fem_gpu_benchmark.py --preflight-only
python3 scripts/analysis/fem_gpu_benchmark.py --preflight-only --require-mfem-stack
```

Expected on the current host: the first command exits `0`; the second exits `2`
and reports missing MFEM/prebuilt setup.

- [x] **Step 4: Run whitespace check**

Run:

```bash
git diff --check
```

- [x] **Step 5: Update the dated audit**

Record that Etap 3 now has a preflight gate, but full MFEM/CUDA benchmarks are
still blocked until an eligible host provides MFEM or a prebuilt native FEM
library.
