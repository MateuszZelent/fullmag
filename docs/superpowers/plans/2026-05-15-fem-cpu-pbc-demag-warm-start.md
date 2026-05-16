# FEM CPU PBC Demag Warm-Start Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Reuse the previous reduced scalar potential as the initial CG guess for Rust FEM CPU PBC demag solves.

**Architecture:** The shared CG core gains an internal cold/warm-start switch. Only the PBC demag reduced solve uses warm-start; non-PBC demag keeps the existing zero-start behavior.

**Tech Stack:** Rust, `fullmag-engine`, existing FEM reference tests.

---

### Task 1: Document Physics Contract

**Files:**
- Modify: `docs/physics/0800-fem-static-pbc-demag.md`
- Create: `docs/superpowers/specs/2026-05-15-fem-cpu-pbc-demag-warm-start-design.md`
- Create: `docs/superpowers/plans/2026-05-15-fem-cpu-pbc-demag-warm-start.md`

- [ ] **Step 1: Add warm-start semantics**

Document that warm-start changes only the iterative initial guess and leaves
`A_red`, `b_red`, `H_demag = -grad(phi)`, class projection, and
`E = 0.5 mu0 q^T b_red` unchanged.

- [ ] **Step 2: Keep scope CPU-only**

State that this plan does not touch native MFEM, CUDA, GPU state, or device
source-of-truth paths.

### Task 2: Write RED Tests

**Files:**
- Modify: `crates/fullmag-engine/src/fem.rs`

- [ ] **Step 1: Add PBC demag warm-start test**

Add a unit test that:

1. builds `unit_tet_problem_with_static_periodic(true, true)`,
2. performs one direct `periodic_robin_demag_observables_from_vectors` solve,
3. sets `sparse_cg_max_iter = Some(0)`,
4. performs a second direct solve with the same magnetization,
5. asserts the second field has nonzero norm and matches the first field.

- [ ] **Step 2: Update stale validation test**

Replace the old rejection assertion with an acceptance assertion for
`validate_reference_semantics()`.

- [ ] **Step 3: Run RED**

Run:

```bash
cargo test -p fullmag-engine periodic_demag
```

Expected before implementation: the warm-start test fails because the CG core
zeros the initial potential on every solve.

### Task 3: Implement Warm-Start

**Files:**
- Modify: `crates/fullmag-engine/src/fem.rs`

- [ ] **Step 1: Add internal CG initializer switch**

Make the shared CG core support cold start and warm start. Cold start sets
`x = 0`, `r = b`; warm start computes `r = b - A x`.

- [ ] **Step 2: Use warm-start only for PBC demag**

Call the warm-start path from
`periodic_robin_demag_observables_from_vectors`. Keep
`robin_demag_observables_from_vectors` on cold start.

- [ ] **Step 3: Remove stale validation rejection**

Delete the `static_periodic_dof_map && demag` rejection from
`validate_reference_semantics`.

### Task 4: Verify

**Files:**
- Test: `crates/fullmag-engine/src/fem.rs`

- [ ] **Step 1: Run targeted tests**

```bash
cargo test -p fullmag-engine periodic_demag
```

- [ ] **Step 2: Run broader demag tests**

```bash
cargo test -p fullmag-engine demag
```

- [ ] **Step 3: Run formatting and diff checks**

```bash
cargo fmt --check -p fullmag-engine
git diff --check
```
