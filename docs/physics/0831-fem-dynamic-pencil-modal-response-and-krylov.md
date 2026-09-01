# FEM dynamic pencil, modal response, and Krylov solvers

- Status: FEM CPU and FEM GPU `source_visible / unvalidated`; the public
  stage-first modal and driven-response authoring, native operator boundaries,
  CPU Schur solver and GPU PETSc/SLEPc adapter are visible in source, but this
  page records no current-snapshot managed runtime or production qualification
- Owners: Fullmag FEM frequency-domain backend
- Last updated: 2026-07-12
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
bounded by the capability matrix and fresh managed artifacts. Every source
claim below is identified by repository-relative `path + symbol`; source
visibility is not runtime evidence.

(problem-statement)=
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

### Backend and device qualification boundary

| Solver | Device | Current state | Evidence boundary |
|---|---|---|---|
| FEM | CPU | `source_visible / unvalidated` | `backends/fem/cpu/frequency_domain/poisson_airbox_schur_matshell.hpp` + `solve_poisson_airbox_modal_eigen_cpu_schur` and `crates/fullmag-runner/src/frequency_response.rs` + `try_execute_fem_frequency_response_native_production_cpu` are source-visible. This page carries no fresh managed numerical or physical qualification. |
| FEM | GPU | `source_visible / unvalidated` | `backends/fem/include/frequency_domain/modal_gpu_krylov.hpp` + `solve_poisson_airbox_modal_eigen_gpu_petsc_slepc` is source-visible. No current device-identity, residency, convergence, parity or scaling artifact is attached here. |
| FDM | CPU | not applicable | This page introduces no FDM frequency-domain realization; an FDM solver must receive a separate numerical owner while preserving the shared physical convention. |
| FDM | GPU | not applicable | This page introduces no FDM frequency-domain realization; an FDM solver must receive a separate numerical owner while preserving the shared physical convention. |

## 2. Physical model

### 2.1 Governing equations and phasor convention

(governing-equations)=

Fullmag uses the following physical ansatz:

```{math}
:label: eq-fem-dynamic-ansatz
\mathbf m(\mathbf r,t)=\mathbf m_0(\mathbf r)
+\operatorname{Re}\!\left[\delta\mathbf m(\mathbf r)
\exp(\mathrm{i}\omega t)\right],
\qquad
\delta\mathbf m=Tq,
\qquad
\mathbf m_0\cdot\delta\mathbf m=0,
\qquad
\gamma_0=\mu_0|\gamma|.
```

The following ASCII contract remains a regression token consumed by
`scripts/test_frequency_domain_math_contract_docs.py` +
`test_canonical_fem_dynamic_solver_contract_freezes_algebra_units_and_claims`:

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

```{math}
:label: eq-fem-dynamic-pencil
Lq=\lambda B_\alpha q,
\qquad
\lambda=\mathrm{i}\omega,
\qquad
A_\omega=\mathrm{i}\omega B_\alpha-L,
\qquad
A_\omega q=b,
\qquad
b=T^{\mathsf T}\!\left[-\gamma_0
(\mathbf m_0\times\delta\mathbf h)\right].
```

```text
L q = lambda B_alpha q
lambda = i omega
A_omega = +i omega B_alpha - L
A_omega q = b
b = T^T[-gamma0 * (m0 x delta_h)]
```

For the energy-Hessian gyrotropic form, `L=K` and `B_alpha=-G` when
`alpha=0`, so the same pencil reads:

```{math}
:label: eq-fem-gyrotropic-pencil
K\phi=-\mathrm{i}\omega G\phi,
\qquad \alpha=0.
```

```text
K phi = -i omega G phi.
```

No modal, driven, reduced, CPU, or GPU adapter may own a different `L`,
`B_alpha`, `A_omega`, or drive sign. The real-split representation is an
algebraic realization of this complex contract, not another convention.

(symbols-and-si-units)=
### 2.2 Typed symbols and SI units

| Field or symbol | Meaning | SI unit / allowed representation |
|---|---|---|
| $\mathbf r$ | spatial position | $\mathrm{m}$ |
| $t$ | time | $\mathrm{s}$ |
| $\mathbf m$, $\mathbf m_0$, $\delta\mathbf m$ | normalized magnetization, accepted equilibrium and tangent perturbation | $1$ |
| $T$, $T_{\mathrm{src}}$, $T_{\mathrm{dst}}$ | tangent-frame maps from local coefficients to physical perturbations | $1$ |
| $q$, $q_{\mathrm{src}}$, $q_{\mathrm{dst}}$ | tangent-plane coefficient vectors | $1$ |
| $\mathbf H_{\mathrm{eff},0}$, $\delta\mathbf h$ | static effective field and RF field phasor | $\mathrm{A\,m^{-1}}$ |
| $M_s$ | saturation magnetization | $\mathrm{A\,m^{-1}}$ |
| $\mu_0$ | vacuum permeability | $\mathrm{N\,A^{-2}}$ |
| $\gamma$, $\gamma_0$ | gyromagnetic ratio and $\mu_0|\gamma|$ in the A/m convention | $\mathrm{rad\,s^{-1}\,T^{-1}}$, $\mathrm{rad\,s^{-1}\,(A\,m^{-1})^{-1}}$ |
| $\omega$, $\omega_r$, $\Gamma$, $\omega_{\mathrm{target}}$, $\tau$ | complex angular frequency, oscillation part, decay rate, requested angular target and rotated target | $\mathrm{rad\,s^{-1}}$ |
| $f$ | cyclic frequency, $f=\operatorname{Re}(\omega)/(2\pi)$ | $\mathrm{Hz}$ |
| $\lambda$, $\sigma$ | generalized eigenvalue and complex spectral shift | $\mathrm{s^{-1}}$ |
| $\sigma_{\mathrm{R}}$, $\sigma_{\mathrm{I}}$ | real and imaginary parts of the spectral shift | $\mathrm{s^{-1}}$, $\mathrm{rad\,s^{-1}}$ |
| $L$, $K$, $A_{qq}$ | dynamic, energy-Hessian and magnetic restoring operators | $\mathrm{m^3\,s^{-1}}$ |
| $B_\alpha$, $B_{qq}$, $G$ | damped gyrotropic/mass operators | $\mathrm{m^3}$ |
| $A_\omega$ | driven harmonic operator $\mathrm{i}\omega B_\alpha-L$ | $\mathrm{m^3\,s^{-1}}$ |
| $b$ | projected tangent RF drive | $\mathrm{m^3\,s^{-1}}$ |
| $\phi$, $\delta\phi$ | scalar-potential coefficient vector and perturbation | $\mathrm{A}$ |
| $A_{q\phi}$ | potential-to-magnetic coupling block | $\mathrm{m^3\,A^{-1}\,s^{-1}}$ |
| $A_{\phi q}$ | magnetic-to-potential coupling block | $\mathrm{A\,m}$ |
| $P$ | scalar Poisson block | $\mathrm{m}$ |
| $c$, $\eta$ | mean-zero gauge vector and Lagrange multiplier | $\mathrm{m^3}$, $\mathrm{A\,m^{-2}}$ |
| $r_q$, $r_\phi$, $r_g$ | magnetic, scalar and gauge residuals | $\mathrm{m^3\,s^{-1}}$, $\mathrm{A\,m}$, $\mathrm{A\,m^3}$ |
| $\epsilon_q$, $\epsilon_\phi$, $\epsilon_g$, $\epsilon_{\mathrm{full}}$ | normalized block and full original-operator residuals | $1$ |
| $V$, $W$, $y$ | trial basis, test basis and reduced coordinates | $1$ |
| $Q$ | physical vector transformation across a periodic map | $1$ |
| $\mathbf k$ | Bloch wave vector | $\mathrm{rad\,m^{-1}}$ |
| $\Delta\mathbf r$ | periodic lattice translation | $\mathrm{m}$ |
| $p=\exp(-\mathrm{i}\mathbf k\cdot\Delta\mathbf r)$ | Floquet phase | $1$ |
| $\beta$ | Robin boundary coefficient | $\mathrm{m^{-1}}$ |
| $\operatorname{Re}$, $\exp$, $\mathrm{i}$, $\pi$, $(\cdot)^{\mathsf T}$, $(\cdot)^{\mathsf H}$, $\times$, $\cdot$ | real-part map, exponential, imaginary unit, circle constant, transpose, Hermitian transpose, cross product and contraction | $1$ |
| $\lVert\cdot\rVert_2$, $|\cdot|$, $\max$ | norm, absolute-value and maximum operators | $1$ |

The public field spellings are `gamma_rad_s_T`,
`gamma0_rad_s_per_A_m`, `omega_rad_s`, `frequency_hz`,
`sigma_real_per_s`, `sigma_imag_rad_per_s` and `delta_phi`. Their typed
spellings prevent a unit-free `gamma`, `frequency`, `omega` or `shift` from
crossing an API or artifact boundary.

Requests and artifacts must not use an untyped `gamma`, `frequency`, `omega`,
or `shift`. If both `gamma_rad_s_T` and `gamma0_rad_s_per_A_m` are supplied,
their `mu0` relation is validated. A target expressed as `frequency_hz` is
converted once to `omega_rad_s`; for the canonical modal convention the complex
target is `sigma = i omega_target`, represented by `sigma_real_per_s=0` and
`sigma_imag_rad_per_s=omega_target`.

The managed runtime is `libpetsc-real-dev` plus `libslepc-real-dev`. For the
undamped qualified lane it therefore uses ADR-017's explicit real split,
never a complex-runtime assumption:

```text
real_frequency_rotated: R(L)y = omega R(i B_alpha)y
tau = omega_target
```

`EPSSetTarget(tau)` is valid only for `real_frequency_rotated`. Supplying
`omega_target` as a real target to the original `lambda=i omega` pencil is a
wrong-axis request and must fail closed.

### 2.3 Eigenvalue, damping, and alternate-phasor mapping

For `exp(+i omega t)`:

```{math}
:label: eq-fem-eigen-frequency-mapping
\lambda=\mathrm{i}\omega,
\qquad
\omega=-\mathrm{i}\lambda,
\qquad
f=\frac{\operatorname{Re}(\omega)}{2\pi},
\qquad
\omega=\omega_r+\mathrm{i}\Gamma,
\qquad
\exp(\mathrm{i}\omega t)=\exp(\mathrm{i}\omega_rt-\Gamma t).
```

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

(assumptions-and-validity)=
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

(discrete-realization)=
## 3. Discrete realization and numerical interpretation

### 3.1 Canonical full descriptor and finite pencil

With a scalar-potential airbox, the physical descriptor system is

```{math}
:label: eq-fem-dynamic-descriptor
\begin{bmatrix}
A_{qq} & A_{q\phi}\\
A_{\phi q} & P
\end{bmatrix}
\begin{bmatrix}q\\\phi\end{bmatrix}
=\lambda
\begin{bmatrix}
B_{qq} & 0\\
0 & 0
\end{bmatrix}
\begin{bmatrix}q\\\phi\end{bmatrix},
\qquad
c^{\mathsf T}\phi=0\ \text{only for pure Neumann.}
```

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

```{math}
:label: eq-fem-dynamic-original-residual
\begin{aligned}
r_q&=A_{qq}q+A_{q\phi}\phi-\lambda B_{qq}q,\\
r_\phi&=A_{\phi q}q+P\phi+c\eta,\\
r_g&=c^{\mathsf T}\phi,\\
\epsilon_{\mathrm{full}}&=\max(\epsilon_q,\epsilon_\phi,\epsilon_g).
\end{aligned}
```

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
case, not an assumed synonym for modal expansion:

```{math}
:label: eq-fem-dynamic-petrov-galerkin
q\approx Vy,
\qquad
W^{\mathsf H}A_\omega Vy=W^{\mathsf H}b,
\qquad
r_{\mathrm{full}}=A_\omega Vy-b.
```

The source-visible public `modal_reduced` policy is not proof that a production
Petrov-Galerkin engine is available. Current method legality is checked by
`crates/fullmag-runner/src/frequency_response.rs` +
`frequency_response_solver_method_rejection_reason`; unsupported engines fail
before fallback.

### 3.4 Periodic and Floquet constraints

For a periodic equivalence, let `Delta r` be the lattice translation and `Q`
the physical vector transformation associated with the periodic map. Both the
magnetic and scalar-potential fields use one phase, and the magnetic tangent
constraint transports the physical vector frame:

```{math}
:label: eq-fem-dynamic-floquet-constraint
p=\exp(-\mathrm{i}\mathbf k\cdot\Delta\mathbf r),
\qquad
T_{\mathrm{dst}}q_{\mathrm{dst}}
=pQT_{\mathrm{src}}q_{\mathrm{src}},
\qquad
q_{\mathrm{dst}}
=p\left(T_{\mathrm{dst}}^{\mathsf T}QT_{\mathrm{src}}\right)q_{\mathrm{src}},
\qquad
\phi_{\mathrm{dst}}=p\phi_{\mathrm{src}}.
```

```text
phase = exp(-i k dot Delta r)
T_dst q_dst = phase Q T_src q_src
q_dst = phase (T_dst^T Q T_src) q_src
phi_dst = phase phi_src
Q = I for a pure translation
```

Constraint construction operates on complete corner/edge equivalence classes
and checks cycle consistency. A phase-only tangent constraint is invalid for
varying frames.

### 3.5 FEM CPU ownership

Production numerical ownership remains under `backends/fem`. The CPU lane may
realize the same pencil through dense validation, sparse direct diagnostics,
SLEPc selected spectrum, full-coupled field split, certified Schur reduction,
or reduced response. The managed real PETSc/SLEPc target representation is
fixed as `real_frequency_rotated` with `tau=omega_target`. The rotation,
shared-domain assembly and Schur solver are source-visible through
`backends/fem/src/frequency_domain/real_frequency_rotated_pencil.cpp` +
`assemble_real_frequency_rotated_pencil` and
`backends/fem/cpu/frequency_domain/poisson_airbox_schur_matshell.hpp` +
`solve_poisson_airbox_modal_eigen_cpu_schur`; managed qualification remains
open and blocks production Poisson-airbox modal qualification.

### 3.6 FEM GPU ownership and truthful lane names

GPU status is split by actual residency and algorithm:

- `gpu_operator_host_krylov`: operator/preconditioner work may execute on GPU,
  while the Krylov basis and hot loop remain host-owned.
- `gpu_device_krylov`: vectors, Krylov basis, operator, preconditioner, and hot
  loop are intended to be device-resident; source is visible, but the lane
  remains unqualified until dedicated residency, transfer, convergence and
  parity evidence passes.
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

(python-api)=
### 4.1 Python API and UI round-trip

This documentation task adds no public Python field and changes no script
export. Existing `Eigenmodes` and `FrequencyResponse` authoring remains the
physics-first surface. The current stage-first boundary is implemented by
`packages/fullmag-py/src/fullmag/world.py` + `eigenmodes_stage` and
`frequency_response_stage`; lowering is owned by
`packages/fullmag-py/src/fullmag/model/study.py` + `class Eigenmodes`,
`class FrequencyResponse` and `class FrequencyResponseSolverPolicy`.

The following script is complete and copyable. Executing it against the Python
package verifies only construction, validation, stage capture and lowering. It
does not execute a native solver and does not promote either FEM lane beyond
`source_visible / unvalidated`.

```python
# %% Imports and execution intent
import fullmag as fm

study = fm.study("fem_dynamic_pencil_authoring_contract")
study.engine("fem")
study.device("cpu", precision="double")
study.mode("strict")

# %% Geometry, material, state and interactions
study.universe(
    mode="auto",
    size=(180e-9, 180e-9, 90e-9),
    center=(0.0, 0.0, 0.0),
    padding=(0.0, 0.0, 0.0),
)
study.universe.mesh(maximum_element_size=60e-9)
film = study.geometry(
    fm.Box(size=(60e-9, 60e-9, 10e-9), name="film"),
    name="film",
)
film.Ms = 800e3
film.Aex = 13e-12
film.alpha = 0.02
film.m = fm.init.UniformMagnetization((1.0, 0.0, 0.0))
film.mesh(maximum_element_size=30e-9, order=1)
study.b_ext(0.05, 0.0, 0.0)
study.exchange()
study.demag(realization="poisson_robin")
study.build_domain_mesh()

# %% Requested observables
study.save("spectrum")
study.save("mode", indices=(0, 1, 2, 3))
study.save_response("susceptibility_tensor")

# %% Ordered stages
study.stages.add_relax(
    algorithm="projected_gradient_bb",
    max_steps=1000,
    tolA=1e-3,
)
study.stages.add_eigenmodes(
    count=4,
    target="frequency_window",
    frequency_min=1.0e9,
    frequency_max=8.0e9,
    operator="full_2x2",
    include_demag=True,
    equilibrium_source="relax",
    normalization="unit_l2",
    damping_policy="ignore",
    k_vector=(0.0, 0.0, 0.0),
    bc="free",
    magnetostatic_bc="open",
)
study.stages.add_frequency_response(
    frequencies_hz=(2.0e9, 4.0e9, 6.0e9),
    excitation_field_au_per_m=(0.0, 0.0, 1.0),
    excitation_phase_rad=0.0,
    observable="susceptibility_tensor",
    include_demag=True,
    equilibrium_source="relax",
    normalization="unit_l2",
    damping_policy="include",
    k_vector=(0.0, 0.0, 0.0),
    bc="free",
    magnetostatic_bc="open",
    solver_method="auto",
    solver_preconditioner="auto",
    solver_rtol=1e-8,
    solver_max_iterations=500,
    solver_restart_iterations=50,
)
```

#### `study.stages.add_eigenmodes` parameters

| Python parameter | Type | Default | SI unit | Validation domain and validation errors | Physical meaning | Backend support | ProblemIR destination and normalization |
|---|---|---|---|---|---|---|---|
| `add_eigenmodes.count` | `int` | `10` | $1$ | Positive; non-positive values raise `ValueError`. | Maximum requested mode count. | FEM CPU/GPU authoring; runtime capability-gated | `study.count` as an integer. |
| `add_eigenmodes.target` | `str` | `"lowest"` | $1$ | One of `lowest`, `nearest`, `frequency_window`; other values raise `ValueError`. | Spectral selection policy. | FEM CPU/GPU authoring; runtime capability-gated | `study.target.kind`. |
| `add_eigenmodes.target_frequency` | `float \| None` | `None` | $\mathrm{Hz}$ | Required and positive for `nearest`; positive if supplied. With `frequency_window` it is currently accepted but not serialized and therefore must not be relied on. | Nearest-frequency target. | FEM CPU/GPU authoring; runtime capability-gated | `study.target.frequency_hz` only for `target="nearest"`; absent for `frequency_window`. |
| `add_eigenmodes.frequency_min` | `float \| None` | `None` | $\mathrm{Hz}$ | Required, finite-positive through `require_positive`, and less than `frequency_max` for `frequency_window`; rejected for other targets. | Lower frequency-window bound. | FEM CPU/GPU authoring; runtime capability-gated | `study.target.frequency_min_hz`. |
| `add_eigenmodes.frequency_max` | `float \| None` | `None` | $\mathrm{Hz}$ | Required, finite-positive through `require_positive`, and greater than `frequency_min` for `frequency_window`; rejected for other targets. | Upper frequency-window bound. | FEM CPU/GPU authoring; runtime capability-gated | `study.target.frequency_max_hz`. |
| `add_eigenmodes.operator` | `str` | `"linearized_llg"` | $1$ | One of `linearized_llg`, `full_2x2`; other values raise `ValueError`. | Physical linearized operator family. | FEM CPU/GPU authoring; runtime capability-gated | `study.operator.kind`. |
| `add_eigenmodes.include_demag` | `bool` | `True` | $1$ | Boolean authoring value; `periodic_airbox_k0` requires `True`. | Include the dynamic-demag derivative. | FEM CPU/GPU authoring; runtime capability-gated | `study.operator.include_demag`. |
| `add_eigenmodes.equilibrium_source` | `str` | `"relax"` | $1$ | One of `provided`, `relax`, `artifact`; other values raise `ValueError`. | Accepted equilibrium source. | FEM CPU/GPU authoring; runtime capability-gated | `study.equilibrium.kind`; `relax` normalizes to `relaxed_initial_state`. |
| `add_eigenmodes.equilibrium_artifact` | `str \| None` | `None` | $1$ | Required and non-empty for `equilibrium_source="artifact"`; a supplied value is always normalized as non-empty. | Immutable equilibrium artifact path. | FEM CPU/GPU authoring; runtime capability-gated | `study.equilibrium.path` for the artifact variant. |
| `add_eigenmodes.normalization` | `str` | `"unit_l2"` | $1$ | One of `unit_l2`, `unit_max_amplitude`; other values raise `ValueError`. | Mode normalization request. | FEM CPU/GPU authoring; runtime capability-gated | `study.normalization`. |
| `add_eigenmodes.damping_policy` | `str` | `"ignore"` | $1$ | One of `ignore`, `include`; `periodic_airbox_k0` requires `ignore`. | Whether Gilbert damping participates in the modal pencil. | FEM CPU/GPU authoring; runtime capability-gated | `study.damping_policy`. |
| `add_eigenmodes.k_vector` | `tuple[float, float, float] \| None` | `None` | $\mathrm{rad\,m^{-1}}$ | Legacy single-$\mathbf k$ alias; finite three-vector; conflicts with a non-equivalent `k_sampling`; `periodic_airbox_k0` requires exact zero. | Single Bloch wave vector. | FEM CPU/GPU authoring; nonzero-k demag remains unsupported | `study.k_sampling={"kind":"single","k_vector":[...]}`. |
| `add_eigenmodes.k_sampling` | `object \| None` | `None` | $1$ | Must lower through `coerce_k_sampling`; a simultaneous non-equivalent `k_vector` is rejected. | Single point, path or declared wave-vector sampling. | FEM CPU/GPU authoring; runtime capability-gated | `study.k_sampling`. |
| `add_eigenmodes.bias_field_sweep` | `BiasFieldSweep \| None` | `None` | $1$ | Must be `BiasFieldSweep`; requires single Gamma, demag, `periodic_airbox_k0`, periodic spin-wave BC and ignored damping. | Ordered physical bias-field sweep. | FEM CPU/GPU authoring; runtime capability-gated | `study.bias_field_sweep`. |
| `add_eigenmodes.bc` | `str \| PeriodicBC \| FloquetBC \| dict` | `"free"` | $1$ | Must serialize as a supported spin-wave BC; periodic/floquet objects require non-empty pair IDs. | Dynamic magnetic boundary condition. | FEM CPU/GPU authoring; runtime capability-gated | `study.spin_wave_bc`. |
| `add_eigenmodes.magnetostatic_bc` | `str` | `"open"` | $1$ | One of `open`, `periodic_airbox_k0`, `floquet_airbox`; `periodic_airbox_k0` additionally requires demag, periodic BC, zero $\mathbf k$ and ignored damping. | Dynamic magnetostatic boundary model. | FEM CPU/GPU authoring; runtime capability-gated | `study.magnetostatic_bc`. |

#### `study.stages.add_frequency_response` parameters

| Python parameter | Type | Default | SI unit | Validation domain and validation errors | Physical meaning | Backend support | ProblemIR destination and normalization |
|---|---|---|---|---|---|---|---|
| `add_frequency_response.frequencies_hz` | `Sequence[float]` | required | $\mathrm{Hz}$ | Non-empty sequence of finite positive values; otherwise `ValueError`. | Requested driven-frequency samples. | FEM CPU/GPU authoring; runtime capability-gated | `study.frequencies_hz.values_hz` as floats. |
| `add_frequency_response.excitation_field_au_per_m` | `tuple[float, float, float]` | `(0.0, 0.0, 1.0)` | $\mathrm{A\,m^{-1}}$ | Exactly three finite components; otherwise `ValueError`. | Complex-drive amplitude before the separate phase. | FEM CPU/GPU authoring; runtime capability-gated | `study.excitation.field_au_per_m`. |
| `add_frequency_response.excitation_phase_rad` | `float` | `0.0` | $\mathrm{rad}$ | Finite after float conversion; non-finite values raise `ValueError`. | Global RF-drive phase. | FEM CPU/GPU authoring; runtime capability-gated | `study.excitation.phase_rad`. |
| `add_frequency_response.observable` | `str` | `"susceptibility_tensor"` | $1$ | Must be accepted by `SaveResponse` when it supplies the implicit response output. Explicit `study.save_response` owns the output instead. | Default driven-response observable. | FEM CPU/GPU authoring; runtime capability-gated | `study.sampling.outputs[].observable` only for the implicit response output. |
| `add_frequency_response.include_demag` | `bool` | `True` | $1$ | Boolean authoring value; unsupported physical combinations fail in planning/runtime. | Include the dynamic-demag derivative. | FEM CPU/GPU authoring; runtime capability-gated | `study.operator.include_demag`; operator kind is `linearized_llg`. |
| `add_frequency_response.equilibrium_source` | `str` | `"provided"` | $1$ | One of `provided`, `relax`, `artifact`; other values raise `ValueError`. | Accepted equilibrium source. | FEM CPU/GPU authoring; runtime capability-gated | `study.equilibrium.kind`; `relax` normalizes to `relaxed_initial_state`. |
| `add_frequency_response.equilibrium_artifact` | `str \| None` | `None` | $1$ | Required and non-empty for `equilibrium_source="artifact"`; a supplied value is always normalized as non-empty. | Immutable equilibrium artifact path. | FEM CPU/GPU authoring; runtime capability-gated | `study.equilibrium.path` for the artifact variant. |
| `add_frequency_response.normalization` | `str` | `"unit_l2"` | $1$ | One of `unit_l2`, `unit_max_amplitude`; other values raise `ValueError`. | Response-state normalization convention. | FEM CPU/GPU authoring; runtime capability-gated | `study.normalization`. |
| `add_frequency_response.damping_policy` | `str` | `"ignore"` | $1$ | One of `ignore`, `include`; other values raise `ValueError`. | Whether Gilbert damping participates in $B_\alpha$. | FEM CPU/GPU authoring; runtime capability-gated | `study.damping_policy`. |
| `add_frequency_response.k_vector` | `tuple[float, float, float] \| None` | `None` | $\mathrm{rad\,m^{-1}}$ | Legacy single-$\mathbf k$ alias; finite three-vector; conflicts with a non-equivalent `k_sampling`. | Single Bloch wave vector. | FEM CPU/GPU authoring; nonzero-k demag remains unsupported | `study.k_sampling={"kind":"single","k_vector":[...]}`. |
| `add_frequency_response.k_sampling` | `object \| None` | `None` | $1$ | Must lower through `coerce_k_sampling`; a simultaneous non-equivalent `k_vector` is rejected. | Single point or wave-vector sampling request. | FEM CPU/GPU authoring; runtime capability-gated | `study.k_sampling`. |
| `add_frequency_response.bc` | `str \| PeriodicBC \| FloquetBC \| dict` | `"free"` | $1$ | Must serialize as a supported spin-wave BC; periodic/floquet objects require non-empty pair IDs. | Dynamic magnetic boundary condition. | FEM CPU/GPU authoring; runtime capability-gated | `study.spin_wave_bc`. |
| `add_frequency_response.magnetostatic_bc` | `str` | `"open"` | $1$ | One of `open`, `periodic_airbox_k0`, `floquet_airbox`; unsupported combinations fail closed later. | Dynamic magnetostatic boundary model. | FEM CPU/GPU authoring; runtime capability-gated | `study.magnetostatic_bc`. |
| `add_frequency_response.solver_method` | `str \| None` | `None` | $1$ | One of `auto`, `dense_reference`, `cpu_sparse_direct`, `full_coupled_field_split`, `schur_reduced`, `modal_reduced`, `gpu_operator_host_krylov`, `gpu_device_krylov`; invalid names raise `ValueError`. | Requested numerical method, not resolved execution. | FEM CPU/GPU authoring; runtime rejects unavailable engines | `study.solver_policy.method`; omitted when `None`. |
| `add_frequency_response.solver_preconditioner` | `str \| None` | `None` | $1$ | One of `auto`, `graph_demag_coarse`, `demag_coarse`, `block_jacobi`, `none`; invalid names raise `ValueError`. | Requested preconditioner. | FEM CPU/GPU authoring; runtime capability-gated | `study.solver_policy.preconditioner`; omitted when `None`. |
| `add_frequency_response.solver_rtol` | `float \| None` | `None` | $1$ | Finite and positive; otherwise `ValueError`. | Requested relative Krylov tolerance. | FEM CPU/GPU authoring; runtime capability-gated | `study.solver_policy.rtol`; omitted when `None`. |
| `add_frequency_response.solver_max_iterations` | `int \| None` | `None` | $1$ | Positive non-boolean integer; otherwise `TypeError` or `ValueError`. | Requested iteration limit. | FEM CPU/GPU authoring; runtime capability-gated | `study.solver_policy.max_iterations`; omitted when `None`. |
| `add_frequency_response.solver_restart_iterations` | `int \| None` | `None` | $1$ | Positive non-boolean integer and not greater than `solver_max_iterations`; otherwise `TypeError` or `ValueError`. | Requested Krylov restart length. | FEM CPU/GPU authoring; runtime capability-gated | `study.solver_policy.restart_iterations`; omitted when `None`. |
| `add_frequency_response.MAX_ITERATIONS` | `int \| None` | `None` | $1$ | Compatibility alias; conflicts with a different `solver_max_iterations` and then raises `ValueError`. | Legacy spelling of the iteration limit. | FEM CPU/GPU authoring; runtime capability-gated | Normalized to `study.solver_policy.max_iterations`; never retained as a separate field. |

A future typed request may extend this surface, but it must continue to
round-trip frequency windows in Hz, complex shifts in rad/s, phase convention,
solver intent and explicit fallback policy without exposing PETSc, SLEPc or
CUDA implementation names as common physics.

(problem-ir)=
### 4.2 ProblemIR and normalization

This task changes no `ProblemIR` schema. Future lowering must canonicalize
gamma, frequency/shift, k-vector, magnetic and magnetostatic BCs, equilibrium
source, damping policy, and operator source before backend selection. Duplicate
or conflicting sources reject rather than route by precedence.

The current example above was executed through the source Python builder and
its two dynamic stages produced the following canonical `study` fragments. The
serialization is owned by `packages/fullmag-py/src/fullmag/model/study.py` +
`Eigenmodes.to_ir` and `FrequencyResponse.to_ir`; Rust deserialization and
round-trip are covered by `crates/fullmag-ir/tests/ir_tests.rs` +
`eigenmodes_with_spectrum_and_mode_outputs_validate` and
`frequency_response_round_trips_as_first_class_study`.

```json
{
  "kind": "eigenmodes",
  "count": 4,
  "dynamics": {
    "fixed_timestep": null,
    "gyromagnetic_ratio": 221100.0,
    "integrator": "auto",
    "kind": "llg"
  },
  "operator": {"include_demag": true, "kind": "full_2x2"},
  "target": {
    "frequency_max_hz": 8000000000.0,
    "frequency_min_hz": 1000000000.0,
    "kind": "frequency_window"
  },
  "equilibrium": {"kind": "relaxed_initial_state"},
  "k_sampling": {"k_vector": [0.0, 0.0, 0.0], "kind": "single"},
  "normalization": "unit_l2",
  "damping_policy": "ignore",
  "spin_wave_bc": "free",
  "magnetostatic_bc": "open",
  "sampling": {
    "outputs": [
      {"kind": "eigen_spectrum", "quantity": "eigenfrequency", "scope": "per_sample"},
      {"field": "mode", "indices": [0, 1, 2, 3], "kind": "eigen_mode"}
    ]
  }
}
```

```json
{
  "kind": "frequency_response",
  "dynamics": {
    "fixed_timestep": null,
    "gyromagnetic_ratio": 221100.0,
    "integrator": "auto",
    "kind": "llg"
  },
  "operator": {"include_demag": true, "kind": "linearized_llg"},
  "equilibrium": {"kind": "relaxed_initial_state"},
  "k_sampling": {"k_vector": [0.0, 0.0, 0.0], "kind": "single"},
  "normalization": "unit_l2",
  "damping_policy": "include",
  "spin_wave_bc": "free",
  "magnetostatic_bc": "open",
  "excitation": {"field_au_per_m": [0.0, 0.0, 1.0], "phase_rad": 0.0},
  "frequencies_hz": {"values_hz": [2000000000.0, 4000000000.0, 6000000000.0]},
  "solver_policy": {
    "max_iterations": 500,
    "method": "auto",
    "preconditioner": "auto",
    "restart_iterations": 50,
    "rtol": 1e-08
  },
  "sampling": {
    "outputs": [
      {"kind": "frequency_response_output", "observable": "susceptibility_tensor"},
      {"kind": "eigen_spectrum", "quantity": "eigenfrequency", "scope": "per_sample"},
      {"field": "mode", "indices": [0, 1, 2, 3], "kind": "eigen_mode"}
    ]
  }
}
```

`target_frequency` has a verified object-level boundary: it lowers to
`target.frequency_hz` for `target="nearest"`, but the current
`target="frequency_window"` branch accepts a positive value and omits it from
`to_ir()`. Until the public validator rejects that redundant combination or IR
gains an explicit window hint, scripts must not rely on it. This loss is
documented rather than hidden as a successful round-trip.

(round-trip-and-failure-semantics)=
### 4.3 Planner and capability matrix

#### Round-trip and failure semantics

The Python and UI surfaces preserve **requested intent** in `ProblemIR`; the
planner records **resolved execution** separately. Script export must reproduce
physical frequency samples, equilibrium source, operator/demag intent,
boundary conditions, normalization, damping policy and requested solver
policy. It must not rewrite a forced GPU request into CPU or replace a physical
boundary model with a backend convenience.

Constructor **validation errors** reject malformed or contradictory authoring
before planning: empty/negative frequencies, invalid target windows, missing
artifact paths, unsupported enum spellings, non-finite drives, invalid Krylov
limits and incompatible periodic-airbox K0 settings. Runtime policy rejection
is owned by `crates/fullmag-runner/src/frequency_response.rs` +
`frequency_response_solver_method_rejection_reason`; it rejects declared but
unavailable methods before any fallback.

**Unsupported combinations** retain the request and fail closed with a
capability diagnostic. Examples include strict GPU without the requested lane,
nonzero-k dynamic demag without a valid coupled operator, unqualified
device-resident Krylov, a missing equilibrium certificate and a wrong-axis
real target applied to the original $\lambda=\mathrm{i}\omega$ pencil. Partial
artifacts retain requested/resolved plan, phase, units, solver phase, latest
true residual and stop reason.

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

(implementation-mapping)=
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

### 4.6 Implementation mapping and evidence class

| Claim | Lane | Repository path + stable symbol | Responsibility | Evidence status |
|---|---|---|---|---|
| Stage-first modal authoring | common | `packages/fullmag-py/src/fullmag/world.py` + `eigenmodes_stage` | Capture the modal stage specification without executing it. | source tested; runtime unvalidated |
| Stage-first driven authoring | common | `packages/fullmag-py/src/fullmag/world.py` + `frequency_response_stage` | Capture frequency samples, drive and solver policy. | source tested; runtime unvalidated |
| Modal Python validation/lowering | common | `packages/fullmag-py/src/fullmag/model/study.py` + `class Eigenmodes` | Validate modal inputs and serialize canonical study IR. | source tested |
| Driven Python validation/lowering | common | `packages/fullmag-py/src/fullmag/model/study.py` + `class FrequencyResponse` | Validate driven inputs and serialize canonical study IR. | source tested |
| Krylov policy validation/lowering | common | `packages/fullmag-py/src/fullmag/model/study.py` + `class FrequencyResponseSolverPolicy` | Validate method, preconditioner and iteration controls. | source tested |
| Canonical harmonic action | common native | `backends/fem/include/frequency_domain/linearized_dynamic_pencil.hpp` + `apply_Aomega` | Apply $A_\omega=\mathrm{i}\omega B_\alpha-L$ to a state. | source visible; managed physics unvalidated |
| Real-frequency rotation | FEM CPU/GPU algebra | `backends/fem/src/frequency_domain/real_frequency_rotated_pencil.cpp` + `assemble_real_frequency_rotated_pencil` | Assemble the real-split target on the physical frequency axis. | source tested; managed physics unvalidated |
| CPU Schur selected spectrum | FEM CPU | `backends/fem/cpu/frequency_domain/poisson_airbox_schur_matshell.hpp` + `solve_poisson_airbox_modal_eigen_cpu_schur` | Solve and certify the source-visible descriptor reduction. | source tested; managed qualification absent |
| GPU PETSc/SLEPc selected spectrum | FEM GPU | `backends/fem/include/frequency_domain/modal_gpu_krylov.hpp` + `solve_poisson_airbox_modal_eigen_gpu_petsc_slepc` | Declare the GPU modal adapter. | source tested; device qualification absent |
| Modal payload ownership | common native | `crates/fullmag-runner/src/native_fem/frequency_domain.rs` + `validate_native_modal_request_payload_ownership` | Reject ambiguous or missing operator payload ownership. | source tested; runtime unvalidated |
| Driven method fail-closed policy | common runner | `crates/fullmag-runner/src/frequency_response.rs` + `frequency_response_solver_method_rejection_reason` | Reject unavailable method/device combinations before fallback. | source tested |
| Native CPU driven boundary | FEM CPU | `crates/fullmag-runner/src/frequency_response.rs` + `try_execute_fem_frequency_response_native_production_cpu` | Build the native CPU response request and preserve explicit failure. | source tested; managed physics unvalidated |
| Floquet phase/frame checks | FEM response | `backends/fem/src/frequency_domain/driven_response_solver.cpp` + `validate_driven_response_floquet_phase_constraints` | Validate phase loops, tangent-frame matching and drive consistency. | source tested; nonzero-k demag unavailable |
| Contract regression | documentation | `scripts/test_frequency_domain_math_contract_docs.py` + `test_canonical_fem_dynamic_solver_contract_freezes_algebra_units_and_claims` | Freeze algebra, units, lane names and honest claim vocabulary. | source tested; not numerical evidence |

(validation)=
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
- [x] Typed public/IR/native request visible in source
- [x] Real PETSc/SLEPc `real_frequency_rotated` target with
  `tau=omega_target` visible in source
- [x] Real shared-domain Poisson modal assembly visible in source
- [x] Persistent GPU solver-state and modal-adapter boundaries visible in source
- [ ] Fresh managed CPU runtime and physical qualification
- [ ] Fresh managed GPU residency, parity, convergence and scaling qualification
- [ ] Production Petrov-Galerkin or biorthogonal reduced response qualified
- [ ] Nonzero-k dynamic demag and DMI implemented and qualified

(limitations)=
## 7. Known limits and deferred work

This note is a contract and claim freeze, not solver promotion. The real-axis
rotation, Poisson-airbox weak-form assembly, CPU Schur boundary, GPU adapter and
public requests are source-visible, but current-snapshot managed qualification
of finite descriptor handling, production reduced response, device-resident
Krylov, general GPU modal eigensolve, damping/nonuniform textures and physical
K0 demag remains absent. Nonzero-k dynamic demag, nonzero-k DMI and fully 3D
periodic demag remain unavailable and fail closed.

The `target_frequency` plus `frequency_window` serialization loss documented
in section 4.2 is an authoring/round-trip limitation. The policy vocabulary
`modal_reduced` and `gpu_device_krylov` is also broader than currently
qualified runtime scope; accepting an enum in Python or IR is not executable
or production evidence.

(scientific-bibliography)=
## 8. Scientific bibliography

- T. L. Gilbert, “A phenomenological theory of damping in ferromagnetic
  materials,” *IEEE Transactions on Magnetics* 40(6), 3443–3449 (2004),
  [doi:10.1109/TMAG.2004.836740](https://doi.org/10.1109/TMAG.2004.836740).
- V. Hernandez, J. E. Roman and V. Vidal, “SLEPc: A Scalable and Flexible
  Toolkit for the Solution of Eigenvalue Problems,” *ACM Transactions on
  Mathematical Software* 31(3), 351–362 (2005),
  [doi:10.1145/1089014.1089019](https://doi.org/10.1145/1089014.1089019).
- Y. Saad, *Numerical Methods for Large Eigenvalue Problems*, revised edition,
  SIAM, 2011,
  [doi:10.1137/1.9781611970739](https://doi.org/10.1137/1.9781611970739).
- R. W. Freund, “Krylov-subspace methods for reduced-order modeling in
  circuit simulation,” *Journal of Computational and Applied Mathematics*
  123(1–2), 395–421 (2000),
  [doi:10.1016/S0377-0427(00)00396-4](https://doi.org/10.1016/S0377-0427(00)00396-4).

Repository-owned related contracts:

- `docs/physics/0700-frequency-domain-linearized-llg.md`
- `docs/physics/0828-fem-frequency-domain-floquet-demag.md`
- `docs/physics/0830-fem-poisson-airbox-modal-eigen.md`
- `docs/specs/capability-matrix-v0.md`
- `docs/architecture/backend-golden-masterplan.md`

(source-code-index)=
## 9. Source-code index

Stable repository-relative `path + symbol` is the primary source identity.
The links below resolve the committed source baseline
`70636fa61fcdf32b6f61b7544f347172ef36a219`; they do not convert source
visibility into runtime qualification.

| Equation/claim | Lane | Repository path + stable symbol | Responsibility | Tests/evidence | Evidence status | Immutable link |
|---|---|---|---|---|---|---|
| Stage-first modal capture | common | `packages/fullmag-py/src/fullmag/world.py` + `eigenmodes_stage` | Build the public modal stage specification. | Python API round-trip tests | source tested | [blob](https://github.com/MateuszZelent/fullmag/blob/70636fa61fcdf32b6f61b7544f347172ef36a219/packages/fullmag-py/src/fullmag/world.py) |
| Stage-first driven capture | common | `packages/fullmag-py/src/fullmag/world.py` + `frequency_response_stage` | Build the public driven stage and normalized solver policy. | Python API round-trip tests | source tested | [blob](https://github.com/MateuszZelent/fullmag/blob/70636fa61fcdf32b6f61b7544f347172ef36a219/packages/fullmag-py/src/fullmag/world.py) |
| Modal validation and lowering | common | `packages/fullmag-py/src/fullmag/model/study.py` + `class Eigenmodes` | Validate and serialize the modal request. | `test_study_stage_builder_eigenmodes_operator_roundtrips` | source tested | [blob](https://github.com/MateuszZelent/fullmag/blob/70636fa61fcdf32b6f61b7544f347172ef36a219/packages/fullmag-py/src/fullmag/model/study.py) |
| Driven validation and lowering | common | `packages/fullmag-py/src/fullmag/model/study.py` + `class FrequencyResponse` | Validate and serialize frequency, drive and outputs. | `frequency_response_round_trips_as_first_class_study` | source tested | [blob](https://github.com/MateuszZelent/fullmag/blob/70636fa61fcdf32b6f61b7544f347172ef36a219/packages/fullmag-py/src/fullmag/model/study.py) |
| Krylov policy validation and lowering | common | `packages/fullmag-py/src/fullmag/model/study.py` + `class FrequencyResponseSolverPolicy` | Validate method, preconditioner, tolerance and iteration limits. | `test_frequency_response_solver_policy_round_trips_from_python_stage` | source tested | [blob](https://github.com/MateuszZelent/fullmag/blob/70636fa61fcdf32b6f61b7544f347172ef36a219/packages/fullmag-py/src/fullmag/model/study.py) |
| Modal IR validation | common | `crates/fullmag-ir/tests/ir_tests.rs` + `eigenmodes_with_spectrum_and_mode_outputs_validate` | Prove current Rust modal IR deserialization and output validation. | same symbol | source tested; not runtime evidence | [blob](https://github.com/MateuszZelent/fullmag/blob/70636fa61fcdf32b6f61b7544f347172ef36a219/crates/fullmag-ir/tests/ir_tests.rs) |
| Driven IR round-trip | common | `crates/fullmag-ir/tests/ir_tests.rs` + `frequency_response_round_trips_as_first_class_study` | Prove current Rust driven-response IR round-trip. | same symbol | source tested; not runtime evidence | [blob](https://github.com/MateuszZelent/fullmag/blob/70636fa61fcdf32b6f61b7544f347172ef36a219/crates/fullmag-ir/tests/ir_tests.rs) |
| {eq}`eq-fem-dynamic-pencil` harmonic action | common native | `backends/fem/include/frequency_domain/linearized_dynamic_pencil.hpp` + `apply_Aomega` | Apply the canonical $\mathrm{i}\omega B_\alpha-L$ action. | native dynamic-pencil contract tests | source tested; managed physics unvalidated | [blob](https://github.com/MateuszZelent/fullmag/blob/70636fa61fcdf32b6f61b7544f347172ef36a219/backends/fem/include/frequency_domain/linearized_dynamic_pencil.hpp) |
| {eq}`eq-fem-gyrotropic-pencil` real rotation | FEM algebra | `backends/fem/src/frequency_domain/real_frequency_rotated_pencil.cpp` + `assemble_real_frequency_rotated_pencil` | Assemble the real-frequency rotated generalized pencil. | `fem_real_frequency_rotated_pencil_contract` | source tested; managed physics unvalidated | [blob](https://github.com/MateuszZelent/fullmag/blob/70636fa61fcdf32b6f61b7544f347172ef36a219/backends/fem/src/frequency_domain/real_frequency_rotated_pencil.cpp) |
| {eq}`eq-fem-dynamic-descriptor` and original residual | FEM CPU | `backends/fem/cpu/frequency_domain/poisson_airbox_schur_matshell.hpp` + `solve_poisson_airbox_modal_eigen_cpu_schur` | Solve and certify the CPU Schur descriptor path. | focused CPU Schur tests | source tested; managed qualification absent | [blob](https://github.com/MateuszZelent/fullmag/blob/70636fa61fcdf32b6f61b7544f347172ef36a219/backends/fem/cpu/frequency_domain/poisson_airbox_schur_matshell.hpp) |
| GPU selected spectrum | FEM GPU | `backends/fem/include/frequency_domain/modal_gpu_krylov.hpp` + `solve_poisson_airbox_modal_eigen_gpu_petsc_slepc` | Declare the PETSc/SLEPc GPU adapter. | focused synthetic GPU adapter tests | source tested; device unvalidated | [blob](https://github.com/MateuszZelent/fullmag/blob/70636fa61fcdf32b6f61b7544f347172ef36a219/backends/fem/include/frequency_domain/modal_gpu_krylov.hpp) |
| Modal operator ownership | common native | `crates/fullmag-runner/src/native_fem/frequency_domain.rs` + `validate_native_modal_request_payload_ownership` | Reject an ambiguous or missing shared-domain operator payload. | focused Rust ownership tests | source tested; runtime unvalidated | [blob](https://github.com/MateuszZelent/fullmag/blob/70636fa61fcdf32b6f61b7544f347172ef36a219/crates/fullmag-runner/src/native_fem/frequency_domain.rs) |
| Method/device rejection | common runner | `crates/fullmag-runner/src/frequency_response.rs` + `frequency_response_solver_method_rejection_reason` | Fail unsupported response methods before fallback. | policy rejection tests | source tested | [blob](https://github.com/MateuszZelent/fullmag/blob/70636fa61fcdf32b6f61b7544f347172ef36a219/crates/fullmag-runner/src/frequency_response.rs) |
| Native CPU response boundary | FEM CPU | `crates/fullmag-runner/src/frequency_response.rs` + `try_execute_fem_frequency_response_native_production_cpu` | Build the native request and preserve native failure/provenance. | focused runner/native tests | source tested; managed physics unvalidated | [blob](https://github.com/MateuszZelent/fullmag/blob/70636fa61fcdf32b6f61b7544f347172ef36a219/crates/fullmag-runner/src/frequency_response.rs) |
| {eq}`eq-fem-dynamic-floquet-constraint` validation | FEM response | `backends/fem/src/frequency_domain/driven_response_solver.cpp` + `validate_driven_response_floquet_phase_constraints` | Validate phase cycles, tangent-frame equality and drive consistency. | focused Floquet response tests | source tested; nonzero-k demag unavailable | [blob](https://github.com/MateuszZelent/fullmag/blob/70636fa61fcdf32b6f61b7544f347172ef36a219/backends/fem/src/frequency_domain/driven_response_solver.cpp) |
| Contract text regression | documentation | `scripts/test_frequency_domain_math_contract_docs.py` + `test_canonical_fem_dynamic_solver_contract_freezes_algebra_units_and_claims` | Freeze canonical algebra, units, lane names and claim status. | same symbol | source tested; not numerical evidence | [blob](https://github.com/MateuszZelent/fullmag/blob/70636fa61fcdf32b6f61b7544f347172ef36a219/scripts/test_frequency_domain_math_contract_docs.py) |
