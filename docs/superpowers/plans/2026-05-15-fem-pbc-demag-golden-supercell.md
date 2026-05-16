# FEM PBC Demag Golden Supercell Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Add a CPU reference golden test that compares x-periodic FEM demag against the central cell of a 15x non-periodic repeated supercell.

**Architecture:** Keep all code in the existing Rust CPU reference benchmark fixture. Build primitive and repeated structured boxes with matching local coordinates, evaluate the same deterministic magnetization function, keep the repeated problem's Robin beta fixed to the primitive-cell beta, map primitive nodes to central-cell repeated nodes, and compare `H_demag` fields with relative L2 and max metrics.

**Tech Stack:** Rust, `fullmag-engine`, existing FEM structured tetra mesh builder, cargo integration tests.

---

### Task 1: Planning Artifacts

**Files:**
- Create: `docs/superpowers/specs/2026-05-15-fem-pbc-demag-golden-supercell-design.md`
- Create: `docs/superpowers/plans/2026-05-15-fem-pbc-demag-golden-supercell.md`

- [x] **Step 1: Record approved CPU-only design**

Expected: spec states primitive PBC vs repeated supercell comparison and excludes native/GPU code.

Result: approved CPU-only design recorded. RED/GREEN later refined the fixture from 3x to 15x and from raw repeated Robin beta to fixed primitive Robin beta.

### Task 2: RED Test

**Files:**
- Modify: `crates/fullmag-engine/tests/fem_pbc_demag_benchmark.rs`

- [x] **Step 1: Add failing golden test**

Test name:

```text
fem_pbc_demag_golden_supercell_matches_central_repeated_cell
```

Expected assertions:

```text
mapped_nodes == primitive_nodes
relative_l2_error <= 5e-3
max_relative_error is finite
```

- [x] **Step 2: Run RED**

Run:

```bash
cargo test -p fullmag-engine --test fem_pbc_demag_benchmark fem_pbc_demag_golden_supercell -- --nocapture
```

Expected before implementation: FAIL because `run_reference_pbc_demag_golden_supercell` does not exist.

Result: failed as expected with unresolved import for `run_reference_pbc_demag_golden_supercell`.

### Task 3: Golden Fixture Implementation

**Files:**
- Modify: `crates/fullmag-engine/src/fem_pbc_benchmark.rs`

- [x] **Step 1: Add metrics struct**

Add:

```text
ReferencePbcDemagGoldenSupercellMetrics
```

with primitive/repeated node counts, mapped node count, relative L2 error, max relative error, primitive energy, and repeated energy.

- [x] **Step 2: Build repeated-supercell problem**

Use a 15x box length in x and no periodic pairs. Evaluate the same local magnetization function using the coordinate folded into the primitive cell. Keep the repeated problem's Robin beta fixed to the primitive-cell beta.

- [x] **Step 3: Compare central-cell fields**

Map each primitive coordinate `[x,y,z]` to central supercell coordinate `[x,y,z]`, using nearest-coordinate lookup with tight tolerance. Compute relative L2 and max relative errors over mapped nodes.

Result: `divisions=3` and 15x repeated supercell pass `relative_l2_error <= 5e-3` with full primitive-node mapping.

### Task 4: Docs And Verification

**Files:**
- Modify: `docs/physics/0800-fem-static-pbc-demag.md`
- Modify: `docs/reports/15.05.2026/fem-solver-physics-performance-audit.md`
- Modify: `docs/superpowers/plans/2026-05-15-fem-pbc-demag-golden-supercell.md`

- [x] **Step 1: Update physics note and audit**

Expected: checklist marks golden repeated-supercell test as closed only if the test passes.

- [x] **Step 2: Run verification**

Run:

```bash
cargo test -p fullmag-engine --test fem_pbc_demag_benchmark -- --nocapture
cargo test -p fullmag-engine pbc_demag
rustfmt --check crates/fullmag-engine/src/fem_pbc_benchmark.rs crates/fullmag-engine/tests/fem_pbc_demag_benchmark.rs
git diff --check
```

Expected: all commands exit 0, except unrelated pre-existing repository drift must be reported explicitly.

Result so far:

```text
cargo test -p fullmag-engine --test fem_pbc_demag_benchmark fem_pbc_demag_golden_supercell -- --nocapture
PASS: 1 passed

cargo test -p fullmag-engine --test fem_pbc_demag_benchmark -- --nocapture
PASS: 2 passed

cargo test -p fullmag-engine pbc_demag
PASS: 2 passed in fem_pbc_demag_benchmark; other pbc_demag-filtered targets had 0 selected tests

rustfmt --check crates/fullmag-engine/src/fem_pbc_benchmark.rs crates/fullmag-engine/tests/fem_pbc_demag_benchmark.rs
PASS

git diff --check
PASS
```
