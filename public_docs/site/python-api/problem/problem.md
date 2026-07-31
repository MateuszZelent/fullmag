---
title: Problem
status: partial
doc_kind: reference
audience: user
owner: fullmag-public-docs
---

(public-docs-python-api-problem-problem)=
# Problem

(python-api-problem-problem-problem-statement)=
<!-- (problem-statement)= -->
## Contract
This page records the current public Python authoring contract and canonical lowering; it does not redefine solver physics.

(python-api-problem-problem-governing-equations)=
<!-- (governing-equations)= -->
## Governing equations
This API page introduces no independent governing equation. Physical equations belong to interaction and solver-lane pages.

(python-api-problem-problem-symbols-and-si-units)=
<!-- (symbols-and-si-units)= -->
## Symbols and SI units
Every owned input has its SI unit below; $1$ denotes dimensionless data.

(python-api-problem-problem-assumptions-and-validity)=
<!-- (assumptions-and-validity)= -->
## Assumptions and validity
Constructor checks run immediately. Lowering and planning additionally check mesh cardinality, capability, and backend legality.

(python-api-problem-problem-python-api)=
<!-- (python-api)= -->
## Python API
| Python | Type | Default | SI unit | Validation | Meaning | Backend support | ProblemIR |
|---|---|---|---|---|---|---|---|
| `Problem.name` | `str` | `required` | $1$ | Non-empty problem identity; `problem_meta.name`. | Non-empty problem identity; `problem_meta.name`. | FEM/FDM CPU/GPU; planner checks combinations | `problem_meta.name` |
| `Problem.magnets` | `sequence of `Ferromagnet`` | `required` | $1$ | Non-empty magnetic objects; lowers geometry, regions, materials, and `magnets`. | Non-empty magnetic objects; lowers geometry, regions, materials, and `magnets`. | FEM/FDM CPU/GPU; planner checks combinations | `magnets` |
| `Problem.energy` | `sequence of energy terms` | `required` | $1$ | Authored interactions; `energy_terms`. Duplicate legality is checked by planners. | Authored interactions; `energy_terms`. Duplicate legality is checked by planners. | FEM/FDM CPU/GPU; planner checks combinations | `energy_terms` |
| `Problem.study` | `study or `None`` | `None` | $1$ | Canonical study. One of `study` or legacy `dynamics` must be supplied; `study`. | Canonical study. One of `study` or legacy `dynamics` must be supplied; `study`. | FEM/FDM CPU/GPU; planner checks combinations | `study` |
| `Problem.dynamics` | `LLG \| None` | `None` | $1$ | Legacy time-evolution input; conflicts with explicit `study`; normalized into `study.dynamics`. | Legacy time-evolution input; conflicts with explicit `study`; normalized into `study.dynamics`. | FEM/FDM CPU/GPU; planner checks combinations | `study.dynamics` |
| `Problem.outputs` | `sequence or `None`` | `None` | $1$ | Legacy output list requiring legacy `dynamics`; normalized into `study.sampling.outputs`. | Legacy output list requiring legacy `dynamics`; normalized into `study.sampling.outputs`. | FEM/FDM CPU/GPU; planner checks combinations | `study.sampling.outputs` |
| `Problem.discretization` | `hints or `None`` | `None` | $1$ | FDM/FEM/hybrid authoring hints; `backend_policy.discretization_hints`. | FDM/FEM/hybrid authoring hints; `backend_policy.discretization_hints`. | FEM/FDM CPU/GPU; planner checks combinations | `backend_policy.discretization_hints` |
| `Problem.description` | `str \| None` | `None` | $1$ | Optional human description; `problem_meta.description`. | Optional human description; `problem_meta.description`. | FEM/FDM CPU/GPU; planner checks combinations | `problem_meta.description` |
| `Problem.runtime` | `RuntimeSelection` | `factory default` | $1$ | Requested backend, device, and precision intent; `backend_policy` and runtime metadata. | Requested backend, device, and precision intent; `backend_policy` and runtime metadata. | FEM/FDM CPU/GPU; planner checks combinations | `backend_policy` |
| `Problem.runtime_metadata` | `mapping` | `{}` | $1$ | User/runtime provenance metadata; `problem_meta.runtime_metadata`. | User/runtime provenance metadata; `problem_meta.runtime_metadata`. | FEM/FDM CPU/GPU; planner checks combinations | `problem_meta.runtime_metadata` |
| `Problem.auxiliary_geometries` | `sequence` | `()` | $1$ | Nonmagnetic/helper geometry entries; `geometry.entries`. | Nonmagnetic/helper geometry entries; `geometry.entries`. | FEM/FDM CPU/GPU; planner checks combinations | `geometry.entries` |
| `Problem.current_modules` | `sequence` | `()` | $1$ | Current/Oersted modules; `current_modules`. | Current/Oersted modules; `current_modules`. | FEM/FDM CPU/GPU; planner checks combinations | `current_modules` |
| `Problem.field_drives` | `sequence` | `()` | $1$ | Regional and time-dependent field drives; `field_drives`. | Regional and time-dependent field drives; `field_drives`. | FEM/FDM CPU/GPU; planner checks combinations | `field_drives` |
| `Problem.couplings` | `sequence` | `()` | $1$ | Explicit inter-object or multiphysics couplings; `couplings`. | Explicit inter-object or multiphysics couplings; `couplings`. | FEM/FDM CPU/GPU; planner checks combinations | `couplings` |
| `Problem.monitors` | `sequence` | `()` | $1$ | Planar monitor definitions; `planar_monitors`. | Planar monitor definitions; `planar_monitors`. | FEM/FDM CPU/GPU; planner checks combinations | `planar_monitors` |
| `Problem.excitation_analysis` | `analysis or None` | `None` | $1$ | Optional spin-wave excitation analysis; `excitation_analysis`. | Optional spin-wave excitation analysis; `excitation_analysis`. | FEM/FDM CPU/GPU; planner checks combinations | `excitation_analysis` |
| `Problem.geometry_asset_cache` | `mapping` | `{}` | $1$ | Internal deterministic geometry-asset cache used during lowering; `geometry_assets`. | Internal deterministic geometry-asset cache used during lowering; `geometry_assets`. | FEM/FDM CPU/GPU; planner checks combinations | `geometry_assets` |
| `Problem.spin_torque` | `legacy torque or None` | `None` | $1$ | Legacy single-torque compatibility input; normalized into torque modules. | Legacy single-torque compatibility input; normalized into torque modules. | FEM/FDM CPU/GPU; planner checks combinations | `study.spin_torques` |
| `Problem.spin_torques` | `sequence` | `()` | $1$ | Canonical spin-torque modules; serialized into study/runtime contracts. | Canonical spin-torque modules; serialized into study/runtime contracts. | FEM/FDM CPU/GPU; planner checks combinations | `study.spin_torques` |
| `Problem.temperature` | `float \| None` | `None` | $\mathrm{K}$ | Optional non-negative thermal temperature; thermal metadata and term consistency are validated. | Optional non-negative thermal temperature; thermal metadata and term consistency are validated. | FEM/FDM CPU/GPU; planner checks combinations | `temperature` |
| `Problem.elastic_materials` | `sequence` | `()` | $1$ | Elastic constitutive materials; `elastic_materials`. | Elastic constitutive materials; `elastic_materials`. | FEM/FDM CPU/GPU; planner checks combinations | `elastic_materials` |
| `Problem.elastic_bodies` | `sequence` | `()` | $1$ | Elastic body assignments; `elastic_bodies`. | Elastic body assignments; `elastic_bodies`. | FEM/FDM CPU/GPU; planner checks combinations | `elastic_bodies` |
| `Problem.magnetostriction_laws` | `sequence` | `()` | $1$ | Magnetostriction constitutive laws; `magnetostriction_laws`. | Magnetostriction constitutive laws; `magnetostriction_laws`. | FEM/FDM CPU/GPU; planner checks combinations | `magnetostriction_laws` |
| `Problem.mechanical_bcs` | `sequence` | `()` | $1$ | Mechanical boundary conditions; `mechanical_bcs`. | Mechanical boundary conditions; `mechanical_bcs`. | FEM/FDM CPU/GPU; planner checks combinations | `mechanical_bcs` |
| `Problem.mechanical_loads` | `sequence` | `()` | $1$ | Mechanical loads; `mechanical_loads`. | Mechanical loads; `mechanical_loads`. | FEM/FDM CPU/GPU; planner checks combinations | `mechanical_loads` |
| `Problem.pbc` | FdmPbc, three booleans, or None | `None` | $1$ | Requested periodic axes; canonical PBC section and backend capability checks. | Requested periodic axes; canonical PBC section and backend capability checks. | FEM/FDM CPU/GPU; planner checks combinations | `backend_policy.pbc` |


(python-api-problem-problem-problem-ir)=
<!-- (problem-ir)= -->
## ProblemIR
The final column gives the serialized destination owned by the current lowering implementation.

(python-api-problem-problem-round-trip-and-failure-semantics)=
<!-- (round-trip-and-failure-semantics)= -->
## Round-trip and failure semantics
Requested intent is preserved in Python and IR. Resolved execution is selected by the planner. Validation errors reject malformed values; unsupported combinations fail capability checks without silent fallback.

(python-api-problem-problem-discrete-realization)=
<!-- (discrete-realization)= -->
## Discrete realization
This page owns authoring and lowering only; numerical realization belongs to solver-lane documentation.

(python-api-problem-problem-implementation-mapping)=
<!-- (implementation-mapping)= -->
## Implementation mapping
The adjacent map anchors claims to `packages/fullmag-py/src/fullmag/model/problem.py` and `class Problem`.

(python-api-problem-problem-validation)=
<!-- (validation)= -->
## Validation
Tests compare this inventory with live signatures and validate its source map.

(python-api-problem-problem-limitations)=
<!-- (limitations)= -->
## Limitations
Representability does not prove every backend combination executable; planner capabilities are authoritative.

(python-api-problem-problem-scientific-bibliography)=
<!-- (scientific-bibliography)= -->
## Scientific bibliography
No physical model is introduced. Primary references belong to consuming interaction pages.

(python-api-problem-problem-source-code-index)=
<!-- (source-code-index)= -->
## Source-code index
| Claim | Path | Stable symbol | Responsibility | Evidence |
|---|---|---|---|---|
| Constructor, validation, lowering | `packages/fullmag-py/src/fullmag/model/problem.py` | `class Problem` | Canonical Python API behavior | Ownership test and source-map validator |
