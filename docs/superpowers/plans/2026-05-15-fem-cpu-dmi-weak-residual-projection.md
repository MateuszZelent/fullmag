# FEM CPU DMI Weak-Residual Projection Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Replace Rust FEM CPU DMI strong-form nodal averaging with weak-residual assembly plus lumped mass projection.

**Architecture:** Keep `FemLlgProblem::dmi_fields_compute_into` as the single DMI element loop. Accumulate interfacial and bulk DMI residuals into existing field buffers, then convert residuals to fields with `H = -g / (mu0 M_s V_lumped)` before the existing periodic class projection.

**Tech Stack:** Rust, `fullmag-engine`, existing FEM P1 tetra topology helpers, cargo tests.

---

### Task 1: Physics And Planning Artifacts

**Files:**
- Modify: `docs/physics/0812-fem-dmi-weak-residual-proof-fixture.md`
- Create: `docs/superpowers/specs/2026-05-15-fem-cpu-dmi-weak-residual-projection-design.md`
- Create: `docs/superpowers/plans/2026-05-15-fem-cpu-dmi-weak-residual-projection.md`

- [x] **Step 1: Record the approved CPU-only design**

Expected: design states residual formulas, lumped projection, CPU-only scope, and native/GPU exclusion.

- [x] **Step 2: Update the physics note**

Expected: note says the CPU reference path now implements weak-residual lumped projection rather than only proving the strong-form gap.

### Task 2: RED Tests

**Files:**
- Modify: `crates/fullmag-engine/src/fem.rs`

- [x] **Step 1: Replace gap tests with equality tests**

Expected tests:
- `interfacial_dmi_lumped_projection_matches_weak_residual_on_free_tet`
- `bulk_dmi_lumped_projection_matches_weak_residual_on_free_tet`

- [x] **Step 2: Run the focused tests**

Run:

```bash
cargo test -p fullmag-engine dmi_lumped_projection_matches_weak_residual -- --nocapture
```

Expected before implementation: FAIL because the current field action still comes from strong-form nodal averaging and does not match the weak residual.

### Task 3: CPU Weak-Residual Projection

**Files:**
- Modify: `crates/fullmag-engine/src/fem.rs`

- [x] **Step 1: Change interfacial DMI accumulation**

Implement residual accumulation:

```text
dw/dm = D [n div(m) - grad(m · n)]
dw/dG_ab = D [(m · n) delta_ab - n_a m_b]
g_i,a += volume * (dw/dm_a / 4 + sum_b dw/dG_a,b grad_phi_i,b)
```

- [x] **Step 2: Change bulk DMI accumulation**

Implement residual accumulation:

```text
g_i,a += D volume * (curl(m)_a / 4 + m_centroid · curl(phi_i e_a))
```

- [x] **Step 3: Convert residuals to fields**

Use:

```text
H_i = -g_i / (mu0 M_s V_i)
```

### Task 4: Verification And Audit Status

**Files:**
- Modify: `docs/reports/15.05.2026/fem-solver-physics-performance-audit.md`
- Modify: `docs/superpowers/plans/2026-05-15-fem-cpu-dmi-weak-residual-projection.md`

- [x] **Step 1: Run focused RED/GREEN command**

Run:

```bash
cargo test -p fullmag-engine dmi_lumped_projection_matches_weak_residual -- --nocapture
```

Expected after implementation: PASS.

- [x] **Step 2: Run DMI regression suite**

Run:

```bash
cargo test -p fullmag-engine dmi
```

Expected: PASS.

- [x] **Step 3: Run formatting and diff hygiene**

Run:

```bash
cargo fmt --check -p fullmag-engine
git diff --check
```

Expected: both commands exit 0.

- [x] **Step 4: Update the audit**

Expected: audit records CPU Rust reference DMI weak-residual lumped projection as closed for CPU reference and keeps native/GPU production work open.
