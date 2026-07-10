# FEM dynamic pencil, modal response, and Krylov solvers

- Status: canonical physics and numerical contract; implementation remains
  capability-gated
- Owners: Fullmag FEM frequency-domain backend
- Last updated: 2026-07-10
- Related architecture:
  - `docs/architecture/backend-golden-masterplan.md`
- Related physics notes:
  - `0600-fem-eigenmodes-linearized-llg.md`
  - `0700-frequency-domain-linearized-llg.md`
  - `0828-fem-frequency-domain-floquet-demag.md`
  - `0830-fem-poisson-airbox-modal-eigen.md`
- Related design and implementation status:
  - `docs/superpowers/specs/2026-07-10-fem-frequency-domain-masterplan-hardening-design.md`
  - `docs/plans/active/fd_sovler_masterplan/20_dynamic_solver_audit_revalidation_and_remediation.md`

This note freezes the backend-neutral FEM dynamic-solver contract. It does not
promote an executable capability. Runtime availability and qualification remain
bounded by the capability matrix and fresh managed artifacts.

## 1. Problem statement

Fullmag needs one linearized FEM operator contract for natural modes, forced
harmonic response, modal or rational reduced-order response, and CPU/GPU Krylov
realizations. Those solvers may differ in storage and algorithm, but they must
not redefine signs, units, tangent frames, boundary conditions, residuals, or
the eigenvalue-to-frequency map.

The input is an accepted equilibrium artifact. It produces one immutable
linearization state and one dynamic pencil. Backends consume that pencil; they
do not infer a second physical model from dense matrices, callbacks, device
buffers, or solver-library conventions.

## 2. Physical model

### 2.1 Governing equations and phasor convention

Fullmag uses

```text
m(r,t) = m0(r) + Re(delta_m(r) exp(+i omega t))
delta_m = T q
m0 dot delta_m = 0
gamma0 = mu0 * abs(gamma)
```

All effective fields are in `A/m`. The projected linearized LLG and the forced
system use the following single operator dictionary:

| Name | Canonical definition | Role |
|---|---|---|
| `L` | projected linearized effective-field and torque action | frequency-independent dynamic operator |
| `B_alpha` | tangent mass/gyrotropic operator with the declared Gilbert convention | generalized-pencil and frequency term |
| `A_omega` | `+i omega B_alpha - L` | driven harmonic operator |
| `b` | `T^T[-gamma0 * (m0 x delta_h)]` | projected RF drive |

Thus:

```text
L q = lambda B_alpha q
lambda = i omega
A_omega = +i omega B_alpha - L
A_omega q = b
b = T^T[-gamma0 * (m0 x delta_h)]
```

For the energy-Hessian gyrotropic form, `L=K` and `B_alpha=-G` when
`alpha=0`, so the same pencil reads:

```text
K phi = -i omega G phi.
```

No modal, driven, reduced, CPU, or GPU adapter may own a different `L`,
`B_alpha`, `A_omega`, or drive sign. The real-split representation is an
algebraic realization of this complex contract, not another convention.

### 2.2 Typed symbols and SI units

| Field or symbol | Meaning | SI unit / allowed representation |
|---|---|---|
| `m0`, `delta_m`, `q` | normalized equilibrium, perturbation, tangent coordinates | 1 |
| `H_eff0`, `delta_h` | static effective field and RF field phasor | A/m |
| `Ms` | saturation magnetization | A/m |
| `mu0` | vacuum permeability | N/A^2 |
| `gamma_rad_s_T` | magnitude of the gyromagnetic ratio `abs(gamma)` | rad/(s T) |
| `gamma0_rad_s_per_A_m` | `mu0 * gamma_rad_s_T` | rad s^-1 per (A/m), equivalently m/(A s) |
| `omega_rad_s` | complex angular frequency | rad/s |
| `frequency_hz` | cyclic frequency, `frequency_hz = Re(omega_rad_s) / (2 pi)` | Hz |
| `lambda` | generalized eigenvalue, `lambda = i omega` | s^-1 |
| `sigma_real` | real part of a spectral shift | rad/s |
| `sigma_imag_rad_per_s` | imaginary part of a spectral shift | rad/s |
| `delta_phi` | magnetic scalar-potential perturbation | A |
| `beta` | Robin boundary coefficient | 1/m |

Requests and artifacts must not use an untyped `gamma`, `frequency`, `omega`,
or `shift`. If both `gamma_rad_s_T` and `gamma0_rad_s_per_A_m` are supplied,
their `mu0` relation is validated. A target expressed as `frequency_hz` is
converted once to `omega_rad_s`; for the canonical modal convention the complex
target is `sigma = i omega_target`, represented by `sigma_real=0` and
`sigma_imag_rad_per_s=omega_target`.

### 2.3 Eigenvalue, damping, and alternate-phasor mapping

For `exp(+i omega t)`:

```text
lambda = i omega
omega = -i lambda
frequency_hz = Re(omega_rad_s) / (2 pi)
```

If `omega = omega_r + i Gamma`, then `Gamma > 0` means decay because
`exp(+i omega t)=exp(+i omega_r t-Gamma t)`. Artifacts therefore record the
phasor convention, complex `lambda`, complex `omega_rad_s`, cyclic frequency,
damping rate, and linewidth mapping together.

An importer using `exp(-i omega t)` maps into this convention by complex
conjugating the phasor representation and reversing the eigenvalue/frequency
signs consistently. It is not a second implementation path.

### 2.4 Assumptions and validity limits

- The equilibrium artifact is accepted and its mesh, material, physics,
  boundary, and field signatures match the linearization request.
- Static demag belongs to `H_eff0`; dynamic demag is the Frechet derivative
  applied to `delta_m`. One cannot substitute for the other.
- The first self-adjoint qualification lane uses `alpha=0`. Damping or other
  nonconservative torques make the pencil non-Hermitian.
- The first Poisson-airbox modal qualification is P1, `k=0`, and an x/y
  periodic, open-z shared magnetic-plus-air domain. Fully 3D periodic `k=0`
  demag remains unavailable pending a macroscopic-field convention.
- Nonzero-k demag and nonzero-k DMI remain unavailable until the full complex
  FE constraint or equivalent `grad_k/div_k` operator is implemented and
  validated.

## 3. Numerical interpretation

### 3.1 Canonical full descriptor and finite pencil

With a scalar-potential airbox, the physical descriptor system is

```text
[A_qq   A_qphi] [q  ] = lambda [B_qq  0] [q  ]
[A_phiq P     ] [phi]          [0     0] [phi].
```

Pure Neumann adds the multiplier `eta`, the column `c eta`, and the gauge row
`c^T phi=0`. Robin and Dirichlet do not. A production modal solve selects only
finite dynamic modes, normally through a certified Schur reduction, then
reconstructs `phi` and `eta` in the full descriptor for acceptance.

The boundary/gauge tuple is closed:

```text
poisson_robin, beta > 0 -> gauge_policy=none
poisson_dirichlet -> gauge_policy=none
pure_neumann -> gauge_policy=mean_zero_augmented
```

Gauge weights are assembled from the active scalar FE space and quadrature.
They need not be strictly positive at eliminated or inactive DOFs. A periodic
lateral constraint does not by itself create a constant nullspace when the
open boundary is coercive.

### 3.2 Residual and scaling contract

The backend-library residual is diagnostic. Acceptance uses the reconstructed
original operator:

```text
r_q     = A_qq q + A_qphi phi - lambda B_qq q
r_phi   = A_phiq q + P phi + c eta
r_gauge = c^T phi
eps_full = max(eps_q, eps_phi, eps_gauge)
```

Every reported mode carries an `original_operator_residual` derived from these
blockwise scaled residuals. It may not be capped by or reconstructed from the
solver-reported residual. Driven solves similarly report tracked Krylov
residuals and recomputed true unpreconditioned residuals against `A_omega`.

### 3.3 Direct modal expansion and projection ROMs

A diagonal modal expansion of a nonnormal pencil requires left and right
eigenvectors, a declared normalization, biorthogonality diagnostics, and
conditioning guards. Right eigenvectors alone are insufficient for forcing
projection or response amplitudes.

A rational Krylov or other Petrov-Galerkin reduced model need not materialize
global eigenvectors. It must instead declare trial and test bases, form the
reduced operator with that dual pairing, compute a per-frequency
`original_operator_residual`, enrich or reject when the residual is too large,
and retain a full-solver fallback. A Galerkin basis is a documented special
case, not an assumed synonym for modal expansion.

### 3.4 Periodic and Floquet constraints

For a periodic equivalence with lattice translation `R`, both the magnetic and
scalar-potential fields use `exp(-i k dot R)`. The magnetic tangent constraint
also transports the physical vector frame:

```text
q_dst = exp(-i k dot R) (T_dst^T R T_src) q_src
phi_dst = exp(-i k dot R) phi_src.
```

Here the middle `R` denotes the physical vector transformation associated with
the periodic map and is the identity for a pure translation. Constraint
construction operates on complete corner/edge equivalence classes and checks
cycle consistency. A phase-only tangent constraint is invalid for varying
frames.

### 3.5 FEM CPU ownership

Production numerical ownership remains under `backends/fem`. The CPU lane may
realize the same pencil through dense validation, sparse direct diagnostics,
SLEPc selected spectrum, full-coupled field split, certified Schur reduction,
or reduced response. The native SLEPc adapter exists; real-scalar
imaginary-axis targeting and real shared-domain Poisson weak-form assembly are
still open and block production Poisson-airbox modal qualification.

### 3.6 FEM GPU ownership and truthful lane names

GPU status is split by actual residency and algorithm:

- `gpu_operator_host_krylov`: operator/preconditioner work may execute on GPU,
  while the Krylov basis and hot loop remain host-owned.
- `gpu_device_krylov`: vectors, Krylov basis, operator, preconditioner, and hot
  loop are device-resident; this lane remains unavailable until its dedicated
  qualification passes.
- `gpu_dense_modal_validation`: bounded, one-shot dense algebra oracle. It may
  report device matrix storage and device iteration, but it is validation-only,
  non-persistent, and non-scalable.
- `gpu_dense_k0_macrospin_modal_eigen`: separate narrow cuSolverDN K0 no-demag
  macrospin/Kittel exception. It does not qualify Poisson-airbox or Floquet GPU
  modal support.

The old broad `gpu_device_resident_modal_eigensolver=true` claim is forbidden
for the dense G5a validation adapter. Strict GPU requests never fall back
silently to CPU.

### 3.7 FDM and hybrid interpretation

This contract does not introduce an FDM frequency-domain implementation.
Future FDM and hybrid solvers must define their own numerical realization while
preserving the public phasor, units, operator, and artifact semantics. No FEM
airbox capability name is reused for an FDM convolution model.

## 4. API, IR, planner, runtime, and artifacts

### 4.1 Python API and UI round-trip

This documentation task adds no public Python field and changes no script
export. Existing `Eigenmodes` and `FrequencyResponse` authoring remains the
physics-first surface. A future typed request must round-trip frequency windows
in Hz, complex shifts in rad/s, phase convention, solver intent, and explicit
fallback policy without exposing PETSc, SLEPc, or CUDA implementation names as
common physics.

### 4.2 ProblemIR and normalization

This task changes no `ProblemIR` schema. Future lowering must canonicalize
gamma, frequency/shift, k-vector, magnetic and magnetostatic BCs, equilibrium
source, damping policy, and operator source before backend selection. Duplicate
or conflicting sources reject rather than route by precedence.

### 4.3 Planner and capability matrix

Requested device and method are evaluated before heuristic preferences. CPU
intent remains CPU; forced GPU cannot fall back; non-strict fallback is
explicit in the plan and provenance. A solver is selectable only when the
equilibrium, mesh, topology, operator, residual, and preconditioner
certificates required by that lane match the current signatures.

Capability truth uses independent axes:

```text
implementation_state = absent | contract_only | source_visible | executable
validation_state = unvalidated | algebra_validated | physics_validated | production_qualified
validated_scope = bounded workload description
```

A synthetic algebra oracle or a narrow K0 macrospin result cannot promote a
Poisson-airbox, nonzero-k, or general GPU capability.

### 4.4 Runtime lifecycle and provenance

The accepted equilibrium artifact produces one `LinearizationState`; modal and
driven requests consume it without hidden recomputation. Failed or interrupted
runs retain the requested/resolved plan, solver phase, latest true residual,
stop reason, partial progress, and available diagnostics.

### 4.5 Artifact requirements

Artifacts bind git/build/run identity and the equilibrium, mesh/topology,
material/physics, boundary/gauge, operator, precision, device, phase,
frequency/window, tolerance, solver, and fallback signatures. They separately
record requested and resolved execution, `assembly_kind`, solver lane,
preconditioner, residency, validation scope, and full residual certification.

`assembly_kind=synthetic_algebraic_oracle` is always validation-only and cannot
carry a production periodic-airbox claim. A production Poisson-airbox modal
artifact requires `assembly_kind=mfem_weak_form_shared_domain` plus the matching
managed physics evidence.

## 5. Validation strategy

| Gate | Minimum evidence | Promotion prevented when absent |
|---|---|---|
| Algebra dictionary | dense random-vector parity of modal `L/B` and driven `A_omega` | all modal/driven lanes |
| Units and mapping | gamma equivalence/conflict, Hz-to-rad/s, `lambda=i omega`, damping sign | all published frequency results |
| Poisson BC/gauge | manufactured Robin, Dirichlet, and pure-Neumann P1 cases | Poisson-airbox modal/response |
| Demag physics | sphere/ellipsoid sign and energy plus airbox-padding convergence | production demag claims |
| Modal/response parity | modal frequency matches driven resonance and original residual | modal/reduced response |
| Nonnormal response | left/right modal and Petrov-Galerkin reduced oracles | damped/nonconservative ROM |
| Floquet | phase-plus-frame cycle, k=0 periodic parity, supercell, exchange `k^2` | nonzero-k claims |
| Spectrum | selected-window completeness, finite-mode filtering, conjugate pairing | interior-window eigensolve |
| CPU/GPU | identical assembled input, result parity, residency and transfer audit | GPU qualification |
| Product truth | no hidden fallback; complete artifacts and bounded `validated_scope` | capability promotion |

Analytical expected values are verifier inputs only. They never construct the
operator under test. Native FEM runtime qualification must use repository
container-backed `just` recipes; host-only checks cannot promote capability.

## 6. Completeness checklist

- [x] Canonical phasor, operator dictionary, units, and eigenvalue mapping
- [x] Modal, driven, direct-modal, and Petrov-Galerkin residual contract
- [x] BC-dependent gauge and phase-plus-frame Floquet contract
- [x] FEM CPU/GPU ownership and truthful lane vocabulary
- [x] Python, ProblemIR, planner, runtime, artifact, and UI impact reviewed
- [x] Validation matrix and status axes defined
- [ ] Typed public/IR/native request implemented
- [ ] Real-split imaginary-axis SLEPc target implemented and qualified
- [ ] Real shared-domain Poisson modal assembly implemented and qualified
- [ ] Persistent device Krylov and GPU modal solver implemented and qualified
- [ ] Nonzero-k dynamic demag and DMI implemented and qualified

## 7. Known limits and deferred work

This note is a contract and claim freeze, not solver promotion. Real-axis SLEPc
targeting for an imaginary-axis spectrum, real Poisson-airbox weak-form modal
assembly, finite descriptor handling, production reduced response,
device-resident Krylov, general GPU modal eigensolve, nonzero-k dynamic demag,
nonzero-k DMI, damping/nonuniform-texture qualification, and fully 3D periodic
demag remain deferred and fail closed.

## 8. References

- `docs/physics/0700-frequency-domain-linearized-llg.md`
- `docs/physics/0828-fem-frequency-domain-floquet-demag.md`
- `docs/physics/0830-fem-poisson-airbox-modal-eigen.md`
- `docs/specs/capability-matrix-v0.md`
- `docs/architecture/backend-golden-masterplan.md`
