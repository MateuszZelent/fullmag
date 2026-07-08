---
title: Frequency-driven solver - backend algorithms and status
version: COMSOL-aligned v5.0 full-read canonical
date: 2026-07-07
status: canonical
source_policy: derived only after full read of all uploaded planning documents and the Micromagnetics Module User's Guide V2.13 PDF
supersedes:
  - fd_solver_plan_FULL_PACK_COMSOL_ALIGNED.md
  - fd_solver_plan_FULL_PACK_COMSOL_ALIGNED_V3.md
  - fd_solver_plan_00_index.md through fd_solver_plan_11_decision_closures_adr.md old copies
---

# Backend algorithms and status

## 1. Dense Cartesian reference

Purpose:

```text
highest-confidence tiny oracle for phase, drive, constraints.
```

Status:

```text
design required; implementation status should be verified per branch.
```

## 2. Dense tangent reference

Purpose:

```text
existing tiny validation path for [K,+omegaM;-omegaM,K].
```

Status:

```text
existing dense driven-response validation path is present.
```

## 3. CPU sparse/direct baseline

Algorithm:

```text
assemble real-split CSR
PETSc Mat AIJ
KSPPREONLY + PCLU
true residual
```

Status after full read:

```text
Patch F reports an MVP module under engines/sparse_direct with PETSc KSPPREONLY/PCLU and explicit unavailable fallback for non-PETSc builds.
Treat as diagnostic baseline, not final scalable direct backend.
```

## 4. Full-coupled field-split backend

Algorithm:

```text
[A_qq A_qphi; A_phiq A_phiphi] [q; phi] = [b_q; b_phi]
FGMRES + block/field-split preconditioner
```

Status after full read:

```text
Patch G reports a dense/oracle-scale prototype with cached A_phiphi inverse, block-triangular preconditioner, phi-block residual telemetry and unpreconditioned reference telemetry.
Production large FEM integration remains open.
```

## 5. Schur-reduced backend

Algorithm:

```text
S(q) = A_qq q - A_qphi solve(A_phiphi, A_phiq q)
```

Status after full read:

```text
Patch H reports SchurCertificationState, certificate checks, planner fallback when uncertified, and mesh/material/physics signature invalidation.
Production Schur selection still requires real per-problem certificate and quality diagnostics.
```

## 6. Modal-reduced backend

Algorithm:

```text
use modal basis V
project drive
solve reduced response
validate sparse/direct sample points
```

Status after full read:

```text
Patch I reports a modal response validation helper, modal basis policy/cache key, completeness gate, and sparse/direct sample validation.
The production CPU Gamma/k0 modal adapter bridge is runtime-verified through
just verify-fem-frequency-domain-eigen-production-gamma-k-path-runtime. This
proves SLEPc shift-invert selected-spectrum provenance, zero-k multi-sample
orchestration, mode-field artifacts, and verifier acceptance for the current
small Gamma-equivalent case.
Full production sweep engine integration remains open.
Nonzero-k dynamic demag-k, periodic-airbox modal production, modal GPU, and
modal-reduced driven sweep integration remain gated.
```

## 7. GPU device FGMRES backend

Algorithm target:

```text
device-resident FGMRES(m)
fused apply_Aomega_gpu
GPU right preconditioner
device orthogonalization
no per-iteration D2H/H2D
```

Status after full read:

```text
Patch J reports planner gate, device vector/callback API skeleton, transfer diagnostics, prerequisite validation, callback probe, and fused Aomega diagnostics contract wiring into FGMRESDeviceEngineConfig.
Runtime device FGMRES loop is explicitly not implemented.
```

## 8. Production optimization

Patch K remains future work:

```text
performance tuning, CUDA Graphs, batched operators, layout optimization, production GPU profiling.
```

Do not start Patch K before numerical contraction and residency gates pass.

## 9. Current managed runtime evidence, 2026-07-08

K0 eigenproblem validation:

```text
target: just verify-fem-frequency-domain-eigen-k0-kittel-runtime
status: passed
model: macrospin_larmor
boundary_condition: periodic_k0
sweep_point_count: 5
max_relative_frequency_error: 1.936968179482632e-14
median_relative_frequency_error: 1.5325462518983463e-15
max_eigen_residual_relative: 1.5940707124199782e-16
```

Frequency-driven periodic-antidot example:

```text
target: just run-fem-periodic-antidot-frequency-driven-managed-headless
status: passed in hybrid compatibility mode
solver_method: gpu_operator_host_krylov
solver_preconditioner: auto
demag_operator_mode: hybrid_cpu_poisson
hypre_execution_policy: host
demag_provider_residency: cpu
uses_gpu_poisson: false
total_iteration_count: 2006
relative_residual_l2_norm: 0.0009994399206910052
```

This is the fastest currently verified path for the full antidot script: GPU
operator plus host Krylov with a host Poisson demag provider. It is not proof
of the future `gpu_device_krylov` backend, strict `device_hypre_poisson`
dynamic demag, or full-coupled field-split production readiness.
