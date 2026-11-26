---
title: Canonical semantic model
status: implemented
doc_kind: reference
audience: user
owner: fullmag-public-docs
source_of_truth: docs/specs/problem-ir-v0.md
---

(public-docs-architecture-semantic-model)=
# Canonical semantic model

FullMag enforces one canonical semantic pipeline across Python scripts, live REPL sessions, and the
browser Control Room:

```text
Python or browser authoring
  -> ProblemIR (canonical physical & study intent)
  -> validation, normalization & certificate checks
  -> capability planning -> ExecutionPlanIR (FdmPlanIR / FemPlanIR)
  -> runtime execution (session -> run -> ordered stages)
  -> fields, observables, Zarr artifacts & provenance
```

The semantic contract keeps **requested intent** strictly separate from **resolved execution**.
Automatic selection or fallback, where permitted by policy, must be visible in provenance; an
explicitly requested backend, device, or direct solver in `strict` mode fails closed when its
requirements are unavailable.

## Core semantic entities

| Concept | Public meaning | Canonical IR owner |
|---|---|---|
| `ProblemIR` | Lowered physical problem: universe, geometry/CSG/Array 3D bodies, regions, materials, spatial parameter fields, textures, interactions, antennas, transport, constraints, discretization hints, and study stages | `crates/fullmag-ir/src/lib.rs` |
| `Study` & `Stage` | Ordered execution and analysis workflow (`relax`, `run`, `hysteresis`, `eigenmodes`, `frequency_response`, `fft_response`, `antenna_field_solve`, `add_field_drive`, `mask_field_drive`, `autosave`, `table_autosave`, `save_state`, `change_device`) | `crates/fullmag-ir/src/study.rs` |
| `ExecutionPlanIR` | Planner-resolved execution plan carrying `CommonPlanMeta`, `ProvenancePlanIR`, and backend-specific `FdmPlanIR` or `FemPlanIR` (plus `AntennaFieldSolvePlanIR`, `ResolvedFrozenSpinsPlanIR`, `FemEigenPlanIR`, `FemFrequencyResponsePlanIR`) | `crates/fullmag-ir/src/plan.rs` |
| Topology & mesh certificates | Immutable structural certificates tying a realized mesh to solver capabilities (for example `pure_prism` topology verification via `validate_pure_prism_topology_certificate_against_mesh` and `FdmGridCertificateIR`) | `crates/fullmag-ir/src/mixed_certificate.rs`, `plan.rs` |
| `Session` & `Run` | User-visible execution context and individual revision-fenced execution attempt | `crates/fullmag-session/`, `crates/fullmag-api/` |
| `Field` & `Observable` | Spatial vector/scalar quantities (`m`, `H_eff`, `H_demag`, `V_electric`, `J_charge`, `spin_potential`, mode profiles) and scalar/spectral observables exposed via binary codecs and Zarr | `crates/fullmag-quantities/` |
| `Artifact` | Reproducible output bundle (Zarr group, tables, snapshots, checkpoints, streaming attestation manifest) carrying full provenance | `crates/fullmag-runner/`, `crates/fullmag-workspace-inspect/` |

## Separation of physics, discretization, and solver policy

1. **Physical definitions are engine-neutral**: Saturation magnetization $M_{\mathrm{s}}$, exchange
   stiffness $A_{\mathrm{ex}}$, anisotropy constants, DMI constants, spatial absorbing damping
   layers, frozen spins, and drive waveforms carry SI units in `ProblemIR` regardless of whether
   FDM or FEM executes them.
2. **Discretization hints are explicit requests**: FDM cell sizes (`default_cell`, per-magnet grids,
   `FdmFftPlanIR`) and FEM mesh/airbox/swept-prism policies (`FemPlanIR`, `AirBoxPolicyIR`) declare
   authored intent; realized grid shapes, element counts, and quality reports belong to backend
   evidence.
3. **Solver policies live in typed IR**: `FemLinearSolverPolicy` (`gpu_strategy`: `"auto"`,
   `"cg_amg"`, `"cudss"`), `FemGpuBbPreconditionerIR` (`"auto"`, `"none"`, `"exchange_mass"`), and
   `FrequencyResponseSolverPolicyIR` (`"auto"`, `"gpu_sparse_direct"`, `"gpu_operator_host_krylov"`)
   flow verbatim from Python/UI into `ProblemIR` and `ExecutionPlanIR`.

Detailed authoring constructors and validation contracts are documented under
{doc}`../python-api/problem/index`.

## Source-code index

| Repository path | Stable symbol | Responsibility |
|---|---|---|
| `packages/fullmag-py/src/fullmag/model/problem.py` | `Problem.to_ir` | Python-to-IR lowering and validation |
| `crates/fullmag-ir/src/lib.rs` | `ProblemIR` | canonical problem data contract |
| `crates/fullmag-ir/src/plan.rs` | `ExecutionPlanIR`, `FdmPlanIR`, `FemPlanIR` | resolved backend plans, certificates, and provenance |
| `crates/fullmag-ir/src/study.rs` | `FrequencyResponseSolverPolicyIR` | typed study and frequency-response solver policy IR |
| `crates/fullmag-ir/src/mixed_certificate.rs` | `validate_pure_prism_topology_certificate_against_mesh` | pure-prism topology certificate validation |
| `crates/fullmag-plan/src/lib.rs` | `plan` | validation and capability planning |
