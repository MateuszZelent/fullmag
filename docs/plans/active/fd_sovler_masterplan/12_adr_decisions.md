---
title: Frequency-driven solver - accepted ADR decisions
version: COMSOL-aligned v5.0 full-read canonical
date: 2026-07-07
status: canonical
source_policy: derived only after full read of all uploaded planning documents and the Micromagnetics Module User's Guide V2.13 PDF
supersedes:
  - fd_solver_plan_FULL_PACK_COMSOL_ALIGNED.md
  - fd_solver_plan_FULL_PACK_COMSOL_ALIGNED_V3.md
  - fd_solver_plan_00_index.md through fd_solver_plan_11_decision_closures_adr.md old copies
---

# ADR decisions

## ADR-001 - GPU lane names

```text
gpu_operator_host_krylov: public transitional/provenance lane.
gpu_device_krylov: true device-resident Krylov only.
production_gpu: legacy alias.
```

## ADR-002 - Drive/RHS

```text
default drive_kind = dynamic_field_phasor_a_per_m
raw tangent_rhs = expert/debug/benchmark mode
```

## ADR-003 - Zero drive

```text
physical zero drive -> zero response + warning
required nonzero tangent RHS -> validation error
```

## ADR-004 - Phase token

```text
canonical output token = exp_plus_i_omega_t
input aliases may include exp_i_omega_t
```

## ADR-005 - Public field representation

```text
public = Cartesian dmX/dmY/dmZ
internal = tangent u/v
```

## ADR-006 - Schur certificate scope

Certificate key includes:

```text
mesh, FE space, material, m0, h_eff0, static demag, physics terms, boundary conditions, periodic/Floquet pairs, k-vector, demag operator, tangent frame policy, phase convention, backend version, frequency/frequency window.
```

## ADR-007 - Schur gates

```text
tiny/dense: 1e-10
CPU matrix-free: 1e-8
GPU/HYPRE: 1e-6
runtime eta gates as in validation doc
```

## ADR-008 - Direct sparse backend

```text
first backend = PETSc Mat AIJ + KSPPREONLY + PCLU.
```

## ADR-009 - Modal reduced basis policy

```text
use_existing_required
use_existing_or_compute
force_recompute
```

## ADR-010 - GPU device Krylov entry gate

```text
no runtime device FGMRES before phase, drive, equilibrium, sparse/direct, Schur/preconditioner, residual and transfer gates pass.
```

## ADR-011 - Relaxed texture handoff

```text
frequency-domain must consume accepted EquilibriumArtifact.
```

## ADR-012 - Symmetric mesh v1

```text
strict matched mesh for periodic/Floquet FEM v1.
```

## ADR-013 - DMI boundary status

```text
volume DMI after tests; frequency-domain DMI boundary terms experimental unless certified.
```
