---
title: Frequency-driven solver - sources and traceability
version: COMSOL-aligned v5.0 full-read canonical
date: 2026-07-07
status: canonical
source_policy: derived only after full read of all uploaded planning documents and the Micromagnetics Module User's Guide V2.13 PDF
supersedes:
  - fd_solver_plan_FULL_PACK_COMSOL_ALIGNED.md
  - fd_solver_plan_FULL_PACK_COMSOL_ALIGNED_V3.md
  - fd_solver_plan_00_index.md through fd_solver_plan_11_decision_closures_adr.md old copies
---

# Sources and traceability

## 1. Manual facts used

The Micromagnetics Module User's Guide V2.13 states that since version 2.0 the module has both Time Domain and Frequency Domain parts; the Frequency Domain part solves the linearized LLG and supports Frequency Domain and Eigenfrequency studies.

The Frequency Domain chapter defines:

```text
m = m0 + delta_m exp(i omega t)
exp(+i omega t), not exp(-i omega t)
delta_m << m0
m0 · delta_m = 0
H_eff = h_eff0 + delta_h_eff exp(i omega t)
linearized LLG equation with damping term i omega alpha m0 x delta_m
```

It also defines complex frequency-domain dependent variables `dmX`, `dmY`, `dmZ`, dynamic external field as a harmonic phasor amplitude, zero response when no external perturbation is applied, DMI caveats, Floquet condition, and dynamic magnetostatic coupling workflow.

## 2. Documentation sources fully read

See `01_full_read_inventory_and_resolution.md` for exact filenames, hashes and line counts.

## 3. Code/runtime facts carried from attached docs

```text
MFEM tangent layout: full DOF = 3 per node, tangent DOF = 2 per node.
Current driven GMRES is host-side in production_cpu_driven_response.cpp.
Dense validation uses real split [K,+omegaM;-omegaM,K].
Modal infrastructure uses SLEPc/shift-invert/contour/window/dedup pieces.
Logs show periodic_airbox_k0 GMRES residual stagnation.
```

## 4. What needs verification against actual branch

The patch queue includes implementation evidence, but before changing code based on it, verify actual current branch contains:

```text
FrequencyDriveKind and require_nonzero_rhs through C ABI/Rust/native
project_dynamic_field_drive_to_tangent_rhs
Cartesian/tangent complex adapters
Dense full-coupled oracle
CPU sparse/direct engine
full-coupled field-split prototype
SchurCertificationState
modal response helper/completeness gate
GPU device skeleton and callback probe
```

This v5 documentation records the plan and reported patch status. It does not replace compiling and running the native contract gate.
