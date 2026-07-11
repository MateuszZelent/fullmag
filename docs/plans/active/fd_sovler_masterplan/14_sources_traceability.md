---
title: Frequency-driven solver - sources and traceability
version: COMSOL-aligned v5.1 deterministic static contract
date: 2026-07-10
status: canonical
source_policy: external manuals and parity references are evidence inputs; Fullmag physics notes, specs, readiness matrix, and validation gates are the normative contract
supersedes:
  - fd_solver_plan_FULL_PACK_COMSOL_ALIGNED.md
  - fd_solver_plan_FULL_PACK_COMSOL_ALIGNED_V3.md
  - fd_solver_plan_00_index.md through fd_solver_plan_11_decision_closures_adr.md old copies
---

# Sources and Traceability

This document records source lineage for the active frequency-domain masterplan.
It is a static documentation contract, not runtime proof. Source-visible code
vocabulary and existing artifacts must not be promoted to validated production
unless the validation gate listed here is satisfied.

## 1. Source Classes

| Class | Role | Current authority boundary |
|---|---|---|
| External manual | Parity reference for product behavior and user-facing study vocabulary. | The Micromagnetics Module User's Guide V2.13 informs the COMSOL-aligned contract but is not a Fullmag normative source. |
| Fullmag physics notes | Normative equations, signs, gauges, units, and validity limits. | `docs/physics/0700-frequency-domain-linearized-llg.md`, `docs/physics/0828-fem-frequency-domain-floquet-demag.md`, `docs/physics/0830-fem-poisson-airbox-modal-eigen.md`, and `docs/physics/0831-fem-dynamic-pencil-modal-response-and-krylov.md`. |
| Fullmag specs | Normative artifact, API, capability, and provenance contracts. | `docs/specs/frequency-domain-artifacts-v2.md` and `docs/specs/capability-matrix-v0.md`. |
| Active masterplan | Implementation sequencing and status governance. | This directory, with read order and full-pack inclusion defined by `documentation_manifest.json`. |
| Readiness matrix/catalog | Current static status projection. | `25_frequency_domain_readiness_matrix.json` plus the consume-only scope catalog `25_frequency_domain_readiness_scope_catalog.json`. |
| Runtime gates | Only accepted route for executable and validation claims. | Managed `just` recipes and artifact verifiers named by the relevant plan chapter; this update did not rerun them. |

## 2. Physics Claim Traceability

| Claim | External parity reference | Fullmag normative source | Required validation gate |
|---|---|---|---|
| Frequency-domain response linearizes LLG around an accepted equilibrium using `exp(+i omega t)`. | Micromagnetics Module User's Guide V2.13 Frequency Domain study description. | `0700-frequency-domain-linearized-llg.md`; `02_physics_contract.md`; `03_relaxed_texture_linearization.md`. | Damped macrospin response and artifact sign checks in `09_validation_certification_benchmarks.md`. |
| Dynamic magnetization is tangent to `m0`; Cartesian payloads are adapters, not independent semantics. | Manual dependent-variable and small-signal description. | `0700-frequency-domain-linearized-llg.md`; `0831-fem-dynamic-pencil-modal-response-and-krylov.md`; `05_algebra_and_operator_representations.md`. | Tangent leakage, tangent/Cartesian parity, and fused/apply parity gates in `09_validation_certification_benchmarks.md`. |
| Static demag belongs to equilibrium provenance; dynamic demag belongs to the linearized operator. | Manual dynamic magnetostatic coupling workflow. | `0830-fem-poisson-airbox-modal-eigen.md`; `0831-fem-dynamic-pencil-modal-response-and-krylov.md`; `03_relaxed_texture_linearization.md`. | Operator digest, Schur certificate, and static/dynamic demag provenance gates in `09_validation_certification_benchmarks.md`. |
| K0 Poisson-airbox Robin/Dirichlet scalar blocks are coercive and do not use mean-zero augmentation; pure Neumann uses the mean-zero gauge. | External FEM magnetostatics practice and COMSOL parity expectation. | `0830-fem-poisson-airbox-modal-eigen.md`; `04_mesh_periodic_floquet_airbox.md`; `12_adr_decisions.md`. | BC/gauge tuple validation plus reconstructed residual certification in `09_validation_certification_benchmarks.md`. |
| Nonzero-k Floquet magnetic and scalar constraints use one Bloch phase and must fail closed when dynamic demag-k is unavailable. | Manual Floquet periodicity concept. | `0828-fem-frequency-domain-floquet-demag.md`; `04_mesh_periodic_floquet_airbox.md`; `23_floquet_airbox_nonzero_k_cpu_gpu_implementation.md`. | Nonzero-k no-demag gates, seam-transfer tests, and explicit `missing_numeric_fem_demag_k` failure checks. |
| Modal eigensolve targeting must publish the selected spectral transform and certify residuals in the original descriptor contract. | External selected-spectrum eigensolver practice. | `0831-fem-dynamic-pencil-modal-response-and-krylov.md`; `18_poisson_airbox_eigensolve_cpu_gpu_implementation.md`; `19_eigensolve_frequency_driven_physics_numerics_audit.md`. | Findings F-03 and F-04 closure plus SLEPc/PETSc residual artifact gates. |
| GPU macrospin K0 no-demag modal validation is a narrow double-precision scope, not broad GPU modal production. | External CPU/GPU parity expectation. | `17_eigen_k0_gpu_readiness_audit.md`; `24_production_definition_of_done.md`; `25_frequency_domain_readiness_matrix.json`. | Scope binding `modal_gpu_k0_none_macrospin_larmor.validation`; broader GPU modal gates remain open. |

## 3. Current Source Evidence, Not Runtime Validation

The active source tree exposes vocabulary and partial implementation surfaces
for planner lanes, ABI fields, artifact diagnostics, GPU callback probes,
Poisson-airbox modal payloads, and Floquet failure reasons. These names are
source evidence only:

```text
FrequencySolvePlanner
FrequencySolvePlan
dense_reference
cpu_sparse_direct
full_coupled_field_split
schur_reduced
modal_reduced
gpu_operator_host_krylov
gpu_device_krylov
gpu_dense_k0_macrospin_modal_eigen
gpu_dense_contract_eigensolver
gpu_modal_device_krylov
production_cpu_modal_dynamic_demag_k_operator_missing
missing_numeric_fem_demag_k
```

Runtime validation requires the managed gates and artifact verifiers named by
the relevant chapters. This Task 10 update did not run scripts, tests, builds,
examples, managed runtimes, or solvers.

## 4. Traceability Outputs

| Artifact | Traceability role |
|---|---|
| `documentation_manifest.json` | Declares active document classification, full-pack order, readiness matrix, and readiness scope catalog. |
| `fd_solver_plan_FULL_PACK_COMSOL_ALIGNED_V5.md` | Deterministic manifest-ordered pack of active Markdown bodies only. It excludes historical snapshots, PDF input, JSON readiness bodies, and itself. |
| `25_frequency_domain_readiness_matrix.json` | Static status projection with object/null readiness bindings. |
| `25_frequency_domain_readiness_scope_catalog.json` | Consume-only scope catalog whose exact-byte SHA-256 is bound by the matrix and checked by tooling. |
| `scripts/check_fd_solver_masterplan_contract.py` | Static contract checker for classification, normative placeholders/sign/gauge guards, audit finding coverage, readiness scope bindings, catalog digest, and full-pack drift. |
