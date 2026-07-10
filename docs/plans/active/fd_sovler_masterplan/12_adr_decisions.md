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

## ADR-014 - Gyromagnetic coefficient and field units

```text
effective fields and drive phasors = A/m
gamma = abs(gyromagnetic ratio) only when explicitly typed in rad/(s T)
gamma0 = mu0 * abs(gamma), in rad s^-1 per (A/m)
all A/m-field LLG and drive equations use gamma0
```

Authority: [`FrequencyOperatorDictionary.v1` in physics note 0831](../../../physics/0831-fem-dynamic-pencil-modal-response-and-krylov.md).

## ADR-015 - Canonical sign and eigenvalue dictionary

```text
phasor = exp(+i omega t)
L q = lambda B q
lambda = i omega
driven operator = i omega B - L
drive = T^T[-gamma0 (m0 x delta_h_drive)]
energy-Hessian mapping at alpha=0: L=K, B=-G, K phi=-i omega G phi
```

These operator and sign definitions are the current
[`FrequencyOperatorDictionary.v1` in physics note 0831](../../../physics/0831-fem-dynamic-pencil-modal-response-and-krylov.md).
Modal, driven, reduced, CPU, GPU, and real-split adapters consume this
dictionary. They may not define local sign conventions.

The absorbed-power contract remains separately authoritative in
[physics note 0700](../../../physics/0700-frequency-domain-linearized-llg.md):

```text
absorbed-power observable = absorbed_by_magnetization
p_abs = -0.5*mu0*Ms*omega*Im(conj(h_drive) dot delta_m)
```

The parallel plan may consolidate this observable and formula into note 0831
later, at which point note 0831 becomes the target sole dictionary authority.

## ADR-016 - Poisson boundary and gauge tuple

```text
poisson_robin with beta>0 -> gauge_policy=none,
                               gauge_reason=coercive_outer_boundary
poisson_dirichlet -> gauge_policy=none,
                     gauge_reason=coercive_outer_boundary
pure_neumann -> gauge_policy=mean_zero_augmented,
                gauge_reason=pure_neumann_nullspace
```

The tuple includes `outer_boundary_kind`, `gauge_policy`, and `gauge_reason`.
Mean-zero weights come from the active scalar FE quadrature. Periodic lateral
constraints do not imply a constant nullspace when the open boundary is
coercive. Authority:
[physics note 0830](../../../physics/0830-fem-poisson-airbox-modal-eigen.md).

## ADR-017 - Spectral target in real PETSc/SLEPc

```text
lambda = lambda_r + i lambda_i
omega = -i lambda
positive undamped branch: lambda_i > 0
frequency_hz = lambda_i/(2*pi)
sigma = i*omega_target
```

A real PETSc/SLEPc build must use the explicit real-split transformed pencil to
represent `sigma`. A real `EPSSetTarget(omega_target)` on the original
`lambda=i omega` spectrum is forbidden unless a separately named
real-frequency pencil and its mapping are derived and documented.

## ADR-018 - Original-operator blockwise residual

Modal Poisson-airbox acceptance uses the reconstructed descriptor residuals:

```text
r_q     = A_qq q + A_qphi phi - lambda B_qq q
r_phi   = A_phiq q + P phi + c eta
r_gauge = c^T phi
eps_q = ||r_q|| / (||A_qq q|| + ||A_qphi phi|| + |lambda| ||B_qq q|| + eps)
eps_phi = ||r_phi|| / (||A_phiq q|| + ||P phi|| + ||c eta|| + eps)
eps_gauge = |r_gauge| / (||c|| ||phi|| + eps)
eps_full = max(eps_q, eps_phi, eps_gauge)
```

The accepted residual is dimensionless and blockwise scaled as specified by
notes 0830 and 0831. A transformed-, reduced-, preconditioned-, or
backend-reported residual is diagnostic only and cannot replace or cap it.

## ADR-019 - Damping and non-Hermitian modal policy

```text
omega_complex = omega_r + i Gamma
Gamma > 0 means decay for exp(+i omega t)
damping_rate_hz = Gamma/(2*pi)
linewidth_fwhm_hz = Gamma/pi
```

Gilbert damping or nonconservative torque makes the pencil non-Hermitian.
Hermitian-only eigensolvers are then forbidden. Direct modal response requires
left and right eigenvectors, declared normalization, biorthogonality and
conditioning diagnostics. A Petrov-Galerkin or rational Krylov alternative
must report the original-operator residual and retain a full-solver fallback.
