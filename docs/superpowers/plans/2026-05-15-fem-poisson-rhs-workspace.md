# FEM Poisson RHS Workspace Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Remove per-solve `mfem::LinearForm` and `DomainLFGradIntegrator` allocation from native FEM Poisson demag RHS assembly while preserving the same weak form and telemetry.

**Architecture:** Add a persistent Poisson RHS workspace owned by the native MFEM context. The workspace keeps a reusable `LinearForm`, reusable true-DOF RHS vector, and a coefficient whose magnetization source is updated before each assemble.

**Tech Stack:** C++ native FEM bridge, Rust source-level/native FEM tests, Markdown physics docs.

---

### Task 1: Physics Contract

**Files:**
- Modify: `docs/physics/0430-fem-dipolar-demag-mfem-gpu-foundations.md`
- Create: `docs/superpowers/specs/2026-05-15-fem-poisson-rhs-workspace-design.md`

- [x] **Step 1: Record the approved design**

Capture that B3 is a workspace/lifetime optimization only and does not change
the Poisson demag weak form.

- [x] **Step 2: Update the physics note**

Add a subsection defining reusable RHS assembly, coefficient lifetime, and
observable invariance for `H_demag` and `E_demag`.

### Task 2: Regression Before Code

**Files:**
- Modify: `crates/fullmag-runner/src/native_fem.rs`
- Inspect: `native/backends/fem/src/mfem_bridge.cpp`

- [x] **Step 1: Add a source-level regression test**

Add a Rust test that reads `native/backends/fem/src/mfem_bridge.cpp`, extracts
the `assemble_poisson_rhs` body, and fails if the hot path still contains
`mfem::LinearForm b(fes)` or `AddDomainIntegrator(`.

- [x] **Step 2: Run the test and verify RED**

Run:

```bash
cargo test -p fullmag-runner native_fem_poisson_rhs_hot_path_reuses_workspace --features fem-gpu
```

Expected before implementation: FAIL because the current hot path still
allocates the local `LinearForm` and integrator.

### Task 3: Native Workspace Implementation

**Files:**
- Modify: `native/backends/fem/include/context.hpp`
- Modify: `native/backends/fem/src/mfem_bridge.cpp`

- [x] **Step 1: Add context ownership field**

Add one opaque context field for the RHS coefficient/workspace owner if the
existing `mfem_poisson_rhs` and `mfem_poisson_rhs_vec` pointers are not enough
to safely own all objects.

- [x] **Step 2: Implement persistent magnetization coefficient**

Replace the stack-only `MagnetizationCoefficient` lifetime with a coefficient
that can update its `m_xyz` source before each assemble and rejects assembly
when no source is set.

- [x] **Step 3: Allocate RHS workspace during Poisson initialization**

Create the reusable `LinearForm`, add its single `DomainLFGradIntegrator` once,
and create the reusable true-DOF RHS vector after the potential finite element
space is initialized.

- [x] **Step 4: Reuse workspace in `assemble_poisson_rhs`**

Update the current magnetization source, zero the reusable linear form, call
`Assemble()`, and write the restricted RHS into the reusable vector.

- [x] **Step 5: Destroy workspace in reverse ownership order**

Delete the workspace before deleting the potential finite element space and set
all related context pointers back to `nullptr`.

### Task 4: Verification And Audit Refresh

**Files:**
- Verify: `crates/fullmag-runner/src/native_fem.rs`
- Verify: `native/backends/fem/src/mfem_bridge.cpp`
- Modify: `docs/reports/15.05.2026/fem-solver-physics-performance-audit.md`

- [x] **Step 1: Run targeted source-level regression**

Run:

```bash
cargo test -p fullmag-runner native_fem_poisson_rhs_hot_path_reuses_workspace --features fem-gpu
```

Expected after implementation: PASS.

- [x] **Step 2: Run native FEM demag tests**

Run the narrowest available native FEM tests that exercise demag when MFEM is
available:

```bash
cargo test -p fullmag-runner native_fem --features fem-gpu
```

Expected: PASS on this MFEM-enabled host, or a clearly reported environment
skip if MFEM is unavailable.

- [x] **Step 3: Run formatting and whitespace checks**

Run:

```bash
cargo fmt --check -p fullmag-runner
git diff --check
```

- [x] **Step 4: Update the dated audit**

Mark B3 as partially closed for reusable RHS `LinearForm`/integrator
allocation. Keep B4/B5 open because hypre host copies and host recovery are not
part of this slice.
