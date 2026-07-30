# Mixed-mesh volume evidence tolerance Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Prevent valid mixed FEM meshes from failing materialized Rust validation solely because NumPy/LAPACK and direct Rust arithmetic produce slightly different near-zero relative-volume errors.

**Architecture:** Preserve all dimensional volume and physical acceptance checks. Introduce one Rust-only comparison helper for the two derived relative-volume evidence fields, with relative tolerance `1e-12` and absolute tolerance `4e-12`; keep the generic dimensionless comparator unchanged.

**Tech Stack:** Rust `fullmag-ir`, Python/NumPy mixed-mesh certificate producer, container-backed repository `just` verification, managed FEM SP4 runtime.

## Global Constraints

- Do not change Python DSL, serialized `ProblemIR`, planner, OpenAPI, or UI schemas.
- Do not change the physical mixed-certificate acceptance limit of `1e-8`.
- Do not relax dimensional volume, bounds, topology, conformity, marker, or quality checks.
- Native FEM runtime proof uses repository container-backed `just` recipes.

---

### Task 1: Document the numerical comparison boundary

**Files:**
- Modify: `docs/physics/0100-mesh-and-region-discretization.md`
- Modify: `docs/physics/0100-mesh-and-region-discretization.source-map.json`

**Interfaces:**
- Consumes: mixed-layer certificate evidence produced by Python and recomputed by Rust.
- Produces: documented `4e-12` cross-language comparison tolerance and unchanged `1e-8` physical acceptance limit.

- [x] Add the determinant/reduction-order explanation, the separate comparison and physical limits, all four backend implications, and unchanged failure semantics.
- [x] Map the claim to `validate_mixed_certificate_evidence_against_mesh` and its Rust regression test.
- [x] Run the scientific documentation validator and its unit tests; expect zero errors.

### Task 2: Add RED regression coverage

**Files:**
- Modify: `crates/fullmag-ir/src/mesh_assets.rs`

**Interfaces:**
- Consumes: existing private `dimensionless_float_close(left, right)`.
- Produces: regression expectations for `mixed_relative_volume_error_close(left, right)`.

- [x] Add a test before the helper exists:

```rust
#[test]
fn mixed_relative_volume_evidence_allows_cross_language_rounding_only() {
    assert!(!dimensionless_float_close(0.0, 1.0e-12));
    assert!(mixed_relative_volume_error_close(0.0, 1.0e-12));
    assert!(!mixed_relative_volume_error_close(0.0, 1.0e-9));
}
```

- [x] Run the focused host `cargo test -p fullmag-ir ...` diagnostic and confirm RED because `mixed_relative_volume_error_close` is undefined. The `justfile` has no single-crate Rust-test recipe; final proof remains the container-backed managed runtime rebuild and SP4 run.

### Task 3: Implement the dedicated comparison

**Files:**
- Modify: `crates/fullmag-ir/src/mesh_assets.rs`

**Interfaces:**
- Produces: `mixed_relative_volume_error_close(left: f64, right: f64) -> bool`.

- [x] Add the dedicated constant and helper without changing the generic comparator:

```rust
const MIXED_RELATIVE_VOLUME_ERROR_ABSOLUTE_TOLERANCE: f64 = 4.0e-12;

fn mixed_relative_volume_error_close(left: f64, right: f64) -> bool {
    float_close(
        left,
        right,
        1.0e-12,
        MIXED_RELATIVE_VOLUME_ERROR_ABSOLUTE_TOLERANCE,
    )
}
```

- [x] Use the helper only for `magnetic_relative_volume_error` and `shared_domain_relative_volume_error` inside `validate_mixed_certificate_evidence_against_mesh`.
- [x] Re-run the focused host diagnostic and the complete `fullmag-ir` test suite; expect PASS. Do not treat host Cargo as final native FEM proof.

### Task 4: Managed reproduction and regression verification

**Files:**
- Verify: `tests/standard_problems/mumag/sp4/fem/scenarios/relax_projected_gradient_bb.py`
- Verify: repository `justfile`

**Interfaces:**
- Consumes: sequential `projected_gradient_bb` and `llg_overdamped` stages on the mixed shared-domain SP4 mesh.
- Produces: runtime evidence that solver initialization no longer reports stale `shared_domain_relative_volume_error`.

- [x] Build or refresh the managed FEM runtime through the matching container-backed `just` recipe.
- [x] Run the SP4 scenario through `just fem-managed-headless cpu ...` with a bounded verification copy whose two relax stages use `max_steps=1`, preserving the failing mesh settings and both algorithms.
- [x] Confirm materialized validation and solver initialization pass, both stages execute in order, and the old stale-evidence message is absent.
- [x] Run formatting, focused Rust tests, scientific-documentation validation, and `git diff --check`.
