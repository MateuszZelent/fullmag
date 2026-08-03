# FEM Demag P2 Provenance and Qualification Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Carry the resolved FEM demagnetization potential order, potential true-DOF count, variational energy, and recovered-field energy from the native solver into run provenance, then qualify P2 against the fixed-mesh FDM oracle and full SP4 outputs.

**Architecture:** Keep numerical ownership in `backends/fem` and append diagnostics to the existing C step-statistics ABI. Mirror those fields in `fullmag-fem-sys`, map them into runner `StepStats`, and publish optional resolved fields in `FemPoissonDemagProvenance`; no public Python or ProblemIR parameter is added. Managed/container `just` recipes provide authoritative build and runtime evidence.

**Tech Stack:** C++/MFEM/hypre, C ABI, Rust FFI/serde, Python SP4 qualification, managed FEM runtime.

## Global Constraints

- Magnetization, material state, LLG fields, and exported nodal fields remain P1; only the auxiliary non-periodic scalar potential is P2.
- Static periodic Poisson remains P1 and must publish `potential_order=1`.
- The primary energy is `mu0 * b^T u / 2` in joules; recovered-field energy is an independent joule-valued reciprocity diagnostic.
- ABI changes are append-only and preserve every existing field offset.
- Missing or disabled demag diagnostics serialize as absent optional provenance, not fabricated P1/P2 claims. Availability is established by a positive resolved order and true-DOF count; finite energy diagnostics preserve zero and negative values rather than hiding them.
- FEM builds and runtime proof use repository container-backed `just` recipes first.
- Do not merge, commit, or claim FEM/FDM agreement from source tests or the initial-state energy gate alone.

---

### Task 1: Append native demag diagnostics to the step-statistics ABI

**Files:**
- Modify: `backends/fem/tests/demag_poisson_contract.cpp`
- Modify: `native/include/fullmag_fem.h`
- Modify: `backends/fem/cpu/mfem/interactions/demag_poisson_telemetry.cpp`
- Modify: `crates/fullmag-fem-sys/src/lib.rs`

**Interfaces:**
- Consumes: `DemagPoissonRuntime::{potential_order,potential_true_dof_count,last_variational_energy_joules,last_recovered_field_energy_joules}`.
- Produces: append-only `fullmag_fem_step_stats::{demag_potential_order,demag_potential_true_dof_count,demag_variational_energy_joules,demag_recovered_field_energy_joules}`.

- [ ] Add a native RED test that initializes sentinel values, verifies zero publication when Poisson demag is unavailable, and verifies the four exact runtime values when it is enabled.
- [ ] Run `just verify-fem-demag-poisson-contract-focused` and retain the expected compile/assertion failure caused by missing ABI fields.
- [ ] Append the four fields to the C and Rust layouts and populate them in `fill_demag_poisson_solver_stats`.
- [ ] Extend the ABI layout test so the former tail offset is unchanged and all new fields occur after it.
- [ ] Re-run `just verify-fem-demag-poisson-contract-focused` and require exit 0.

### Task 2: Publish optional resolved diagnostics in runner provenance

**Files:**
- Modify: `crates/fullmag-runner/src/types.rs`
- Modify: `crates/fullmag-runner/src/native_fem.rs`
- Modify: `crates/fullmag-runner/src/dispatch.rs`
- Modify: `crates/fullmag-runner/src/fem/runtime_contract.rs`
- Modify: runner provenance/artifact tests that construct `FemPoissonDemagProvenance`.

**Interfaces:**
- Consumes: the four appended FFI fields.
- Produces: `StepStats` transport fields and optional `FemPoissonDemagProvenance::{potential_order,potential_true_dof_count,variational_energy_joules,recovered_field_energy_joules}`.

- [ ] Add RED provenance tests for a P2 sample, a periodic P1 sample, and unavailable zero diagnostics.
- [ ] Run focused `fullmag-runner` tests and retain the expected missing-field failure.
- [ ] Map all three native step/snapshot constructors and both provenance builders.
- [ ] Serialize only positive order/count and finite energies when the resolved potential diagnostics are available; preserve zero or negative finite energy values and keep unavailable values absent.
- [ ] Run focused runner tests, Rust FFI ABI tests, formatter checks, and `git diff --check`.

### Task 3: Independent review and managed runtime qualification

**Files:**
- Modify only files required by Critical or Important review findings.
- Update: `docs/physics/0431-fem-demag-mixed-order-potential.md` and its source map to match executed evidence without promoting unsupported lanes.

**Interfaces:**
- Consumes: reviewed source diff and exact managed runtime source identity.
- Produces: runtime `metadata.json` that identifies P1/P2 order, true DOFs, and both energies.

- [ ] Run an independent task review for ABI compatibility, units, optional-value semantics, periodic P1 truth, and all native mapping paths.
- [ ] Resolve all Critical and Important findings and re-review.
- [ ] Run `just rebuild-fem-runtime` followed by `just ensure-managed-fem-runtime` and record exact bundle/source identity.
- [ ] Re-run fixed-mesh P1/P2 and refined P2 initial-state gates; require same-state energy reciprocity and at most 1% refined P2 error against the FDM/Newell oracle.
- [ ] Validate the scientific source map and changed scientific documentation.

### Task 4: Full SP4 FEM/FDM agreement gate

**Files:**
- Modify qualification scripts/tests only when an executed failure demonstrates a contract defect.
- Produce runtime reports under a temporary or audit artifact directory without changing user-owned scenarios.

**Interfaces:**
- Consumes: qualified P2 managed runtime, fixed scenario inputs, FDM/MuMax3 reference outputs.
- Produces: trajectory, field, table, telemetry, mesh/airbox, and provenance comparison evidence.

- [ ] Run the complete FEM relaxation and both NIST reversal cases without reinitializing dynamic solver history.
- [ ] Run the matching FDM/MuMax3 cases with the same material, fields, durations, and sample cadence.
- [ ] Independently recompute volume/Ms-weighted global `m_avg` from saved fields and compare it with table and telemetry.
- [ ] Compare `m_avg(t)`, endpoint magnetization, first `mx=0` crossing, component maps, energies, torque stop, and mesh/airbox refinement.
- [ ] Claim FEM/FDM agreement only if all declared numerical and artifact/provenance gates pass with current managed-runtime evidence.
