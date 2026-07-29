---
title: Problem
status: partial
doc_kind: reference
audience: user
owner: fullmag-public-docs
---

(public-docs-python-api-problem-problem)=
# Problem

`Problem(...)` is the enclosing canonical model. Required authoring inputs identify the problem,
magnetic objects, interactions, and study; discretization supplies backend hints. Optional
mechanics, current, coupling, monitor, thermal, PBC, and legacy compatibility parameters are
serialized independently rather than interpreted as hidden interaction settings.

| Python | Type | Default | SI unit | Validation, meaning, and ProblemIR destination |
|---|---|---|---|---|
| `Problem.name` | `str` | `required` | $1$ | Non-empty problem identity; `problem_meta.name`. |
| `Problem.magnets` | sequence of `Ferromagnet` | `required` | — | Non-empty magnetic objects; lowers geometry, regions, materials, and `magnets`. |
| `Problem.energy` | sequence of energy terms | `required` | — | Authored interactions; `energy_terms`. Duplicate legality is checked by planners. |
| `Problem.study` | study or `None` | `None` | — | Canonical study. One of `study` or legacy `dynamics` must be supplied; `study`. |
| `Problem.dynamics` | `LLG \| None` | `None` | — | Legacy time-evolution input; conflicts with explicit `study`; normalized into `study.dynamics`. |
| `Problem.outputs` | sequence or `None` | `None` | — | Legacy output list requiring legacy `dynamics`; normalized into `study.sampling.outputs`. |
| `Problem.discretization` | hints or `None` | `None` | — | FDM/FEM/hybrid authoring hints; `backend_policy.discretization_hints`. |
| `Problem.description` | `str \| None` | `None` | $1$ | Optional human description; `problem_meta.description`. |
| `Problem.runtime` | `RuntimeSelection` | factory default | — | Requested backend, device, and precision intent; `backend_policy` and runtime metadata. |
| `Problem.runtime_metadata` | mapping | `{}` | — | User/runtime provenance metadata; `problem_meta.runtime_metadata`. |
| `Problem.auxiliary_geometries` | sequence | `()` | — | Nonmagnetic/helper geometry entries; `geometry.entries`. |
| `Problem.current_modules` | sequence | `()` | — | Current/Oersted modules; `current_modules`. |
| `Problem.field_drives` | sequence | `()` | — | Regional and time-dependent field drives; `field_drives`. |
| `Problem.couplings` | sequence | `()` | — | Explicit inter-object or multiphysics couplings; `couplings`. |
| `Problem.monitors` | sequence | `()` | — | Planar monitor definitions; `planar_monitors`. |
| `Problem.excitation_analysis` | analysis or `None` | `None` | — | Optional spin-wave excitation analysis; `excitation_analysis`. |
| `Problem.geometry_asset_cache` | mapping | `{}` | — | Internal deterministic geometry-asset cache used during lowering; `geometry_assets`. |
| `Problem.spin_torque` | legacy torque or `None` | `None` | — | Legacy single-torque compatibility input; normalized into torque modules. |
| `Problem.spin_torques` | sequence | `()` | — | Canonical spin-torque modules; serialized into study/runtime contracts. |
| `Problem.temperature` | `float \| None` | `None` | $\mathrm{K}$ | Optional non-negative thermal temperature; thermal metadata and term consistency are validated. |
| `Problem.elastic_materials` | sequence | `()` | — | Elastic constitutive materials; `elastic_materials`. |
| `Problem.elastic_bodies` | sequence | `()` | — | Elastic body assignments; `elastic_bodies`. |
| `Problem.magnetostriction_laws` | sequence | `()` | — | Magnetostriction constitutive laws; `magnetostriction_laws`. |
| `Problem.mechanical_bcs` | sequence | `()` | — | Mechanical boundary conditions; `mechanical_bcs`. |
| `Problem.mechanical_loads` | sequence | `()` | — | Mechanical loads; `mechanical_loads`. |
| `Problem.pbc` | `FdmPbc`, three booleans, or `None` | `None` | $1$ | Requested periodic axes; canonical PBC section and backend capability checks. |

See {doc}`problem-ir` for lowering, requested intent, and resolved execution.
