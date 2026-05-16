# FEM CPU Integrator Allocation Hygiene Design

## Scope

This slice closes one remaining Rust FEM CPU-reference hot-path issue from
`docs/reports/15.05.2026/fem-solver-physics-performance-audit.md`: ABM/RK
history buffers must not allocate once per accepted step when the caller uses
`FemLlgProblem::step_with_workspace`.

The change is CPU-reference only. It does not touch native MFEM, CUDA, GPU
state, device ownership, `FemGpuState`, or backend provenance.

## Recommended Approach

Use variant A: keep the existing equations and integrator control flow, but
make persistent cache/history buffers reusable.

For ABM3, add an `AbmHistory::push_copy_from_slice` path that rotates the three
history slots and copies the latest RHS into an existing slot. The first three
startup pushes may allocate slots because the state is being initialized. Once
the history is ready, accepted steps should reuse the same three allocations.

For RK45 FSAL, keep the existing `store_fsal_cache` helper because it already
uses `get_or_insert_with(Vec::new)`, `clear`, and `extend_from_slice`; after the
first accepted step it reuses capacity instead of allocating a fresh vector.

## Physics And Numerics

The semi-discrete LLG RHS, Heun startup, ABM3 predictor-corrector coefficients,
RK coefficients, normalization, timestep acceptance, and observables remain
unchanged. This is a storage-lifetime refactor only.

The physical invariant is that the RHS samples used by ABM3 remain:

- `f_n`: most recent accepted RHS,
- `f_n_minus_1`: previous accepted RHS,
- `f_n_minus_2`: two accepted RHS samples back.

Changing buffer ownership must not alter their order, values, or `dt` restart
semantics.

## Verification

Add a unit test in `crates/fullmag-engine/src/fem.rs` that drives ABM3 through
startup, records the three history buffer pointers after readiness, takes
additional accepted workspace steps, and asserts that the pointers are stable.

Run:

- `cargo test -p fullmag-engine abm`
- `cargo test -p fullmag-engine fem_integrator`
- `cargo fmt --check -p fullmag-engine`
- `git diff --check`

